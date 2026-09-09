using System.Diagnostics;
using System.IO;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using System.Windows;
using Microsoft.Web.WebView2.Core;
using Organizator.Services;

namespace Organizator.Bridge;

/// <summary>
/// Pont JS -> hote. Recoit <c>{ id, type, payload }</c>, dispatche vers un handler,
/// et repond toujours au meme <c>id</c> par <c>{ id, ok, payload }</c> ou
/// <c>{ id, ok: false, error }</c>. Aucune exception d'un handler ne remonte.
/// </summary>
public sealed class BridgeHost
{
    private static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
    };

    private static readonly string HostVersion =
        typeof(BridgeHost).Assembly.GetName().Version?.ToString(3) ?? "1.0.0";

    private readonly CoreWebView2 _core;
    private readonly Window _owner;
    private readonly HostLog _log;
    private readonly DataStore _store;
    private readonly ClaudeSessions _claude;
    private readonly CopilotSessions _copilot;
    private readonly AgentLauncher _launcher;
    private readonly ClaudeModelCatalog _claudeCatalog;
    private readonly CopilotModelCatalog _copilotCatalog;
    private readonly AgentProcessScanner? _scanner;
    private readonly UsageMonitor _usage;

    // Un transcript n'est relu que si sa taille ou sa date a change : le rafraichissement de
    // toutes les conversations a chaque evenement reste bon marche.
    private readonly object _cacheLock = new();
    private readonly Dictionary<string, (string Stamp, SessionSummary Summary)> _summaryCache = new(StringComparer.Ordinal);

    public BridgeHost(
        CoreWebView2 core,
        Window owner,
        HostLog log,
        DataStore store,
        ClaudeSessions claude,
        CopilotSessions copilot,
        AgentLauncher launcher,
        AgentProcessScanner? scanner)
    {
        _core = core;
        _owner = owner;
        _log = log;
        _store = store;
        _claude = claude;
        _copilot = copilot;
        _launcher = launcher;
        _scanner = scanner;
        _claudeCatalog = new ClaudeModelCatalog(log);
        _copilotCatalog = new CopilotModelCatalog(store.DataDir, copilot, () => launcher.CopilotCommand, log);
        _usage = new UsageMonitor(log, HostVersion);
        _core.WebMessageReceived += OnWebMessageReceived;
    }

    /// <summary>Envoie un evenement non sollicite : <c>{ event, payload }</c>.</summary>
    public void PostEvent(string name, JsonObject? payload = null)
    {
        var message = new JsonObject
        {
            ["event"] = name,
            ["payload"] = payload ?? new JsonObject(),
        };

        Post(message);
    }

    private void Post(JsonObject message)
    {
        try
        {
            _core.PostWebMessageAsJson(message.ToJsonString());
        }
        catch (Exception ex)
        {
            // La WebView peut avoir ete detruite entre-temps.
            Debug.WriteLine("[Organizator] PostWebMessageAsJson : " + ex.Message);
        }
    }

    // ------------------------------------------------------------------ reception

    private async void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        JsonNode? id = null;
        try
        {
            string raw;
            try
            {
                raw = e.WebMessageAsJson;
            }
            catch (Exception ex)
            {
                _log.Warn("Message web illisible : " + ex.Message);
                return;
            }

            if (JsonNode.Parse(raw) is not JsonObject envelope)
            {
                _log.Warn("Message web ignore (ce n'est pas un objet JSON).");
                return;
            }

            id = envelope["id"]?.DeepClone();
            var type = envelope["type"]?.GetValue<string>();
            var payload = envelope["payload"] as JsonObject ?? new JsonObject();

            if (string.IsNullOrWhiteSpace(type))
            {
                Reply(id, false, null, "Message sans type.");
                return;
            }

            var result = await DispatchAsync(type!, payload).ConfigureAwait(true);
            Reply(id, true, result, null);
        }
        catch (Exception ex)
        {
            _log.Error("Echec du traitement d'un message web", ex);
            Reply(id, false, null, Readable(ex));
        }
    }

    private void Reply(JsonNode? id, bool ok, JsonNode? payload, string? error)
    {
        var message = new JsonObject { ["id"] = id, ["ok"] = ok };
        if (ok)
        {
            message["payload"] = payload ?? new JsonObject();
        }
        else
        {
            message["error"] = error ?? "Erreur inconnue.";
        }

        Post(message);
    }

    private static string Readable(Exception ex) => ex switch
    {
        InvalidOperationException => ex.Message,
        UnauthorizedAccessException => "Acces refuse : " + ex.Message,
        IOException => "Erreur d'acces au disque : " + ex.Message,
        JsonException => "Donnees JSON invalides : " + ex.Message,
        _ => ex.Message,
    };

    // ------------------------------------------------------------------- dispatch

    private async Task<JsonNode?> DispatchAsync(string type, JsonObject payload) => type switch
    {
        "getState" => GetState(),
        "saveData" => SaveData(payload),
        "saveSettings" => SaveSettings(payload),
        "pickFolder" => PickFolder(payload),
        "startSession" => StartSession(payload),
        "resumeSession" => ResumeSession(payload),
        "getSessions" => await GetSessionsAsync(payload).ConfigureAwait(true),
        "getTranscript" => await GetTranscriptAsync(payload).ConfigureAwait(true),
        "refreshModels" => await RefreshModelsAsync(payload).ConfigureAwait(true),
        "notify" => Notify(),
        "getUsage" => await GetUsageAsync(payload).ConfigureAwait(true),
        "openPath" => OpenPath(payload),
        "log" => LogFromWeb(payload),
        _ => throw new InvalidOperationException($"Type de message inconnu : {type}"),
    };

    // ------------------------------------------------------------------- handlers

    private JsonNode GetState()
    {
        var settings = _store.LoadSettings();

        return new JsonObject
        {
            ["data"] = _store.LoadData(),
            ["settings"] = JsonSerializer.SerializeToNode(settings, Json),
            ["env"] = new JsonObject
            {
                ["version"] = HostVersion,
                ["hasClaude"] = _launcher.HasClaude,
                ["hasCopilot"] = _launcher.HasCopilot,
                ["hasWt"] = _launcher.HasWt,
                ["defaultCwd"] = ResolveDefaultCwd(settings),
                ["dataDir"] = _store.DataDir,
                ["userProfile"] = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                ["repoDir"] = RepoDir.Value ?? "",
                ["models"] = new JsonObject
                {
                    ["claude"] = _claudeCatalog.Build().ToJson(),
                    ["copilot"] = _copilotCatalog.Current().ToJson(),
                },
                ["efforts"] = new JsonObject
                {
                    ["claude"] = ToJsonArray(AgentProvider.ClaudeEfforts),
                    ["copilot"] = ToJsonArray(AgentProvider.CopilotEfforts),
                },
            },
        };
    }

    /// <summary>Quotas des deux agents ; sans <c>force</c>, une lecture de moins de deux minutes est rendue telle quelle.</summary>
    private async Task<JsonNode> GetUsageAsync(JsonObject payload)
    {
        var force = payload["force"] is JsonValue value && value.TryGetValue<bool>(out var flag) && flag;
        return await _usage.GetAsync(force, CancellationToken.None).ConfigureAwait(true);
    }

    private static JsonArray ToJsonArray(IEnumerable<string> values)
    {
        var array = new JsonArray();
        foreach (var value in values)
        {
            array.Add(JsonValue.Create(value));
        }

        return array;
    }

    private static string ResolveDefaultCwd(AppSettings settings)
        => string.IsNullOrWhiteSpace(settings.DefaultCwd)
            ? Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments)
            : settings.DefaultCwd;

    /// <summary>
    /// Dossier des sources d'Organizator : le premier parent de l'executable qui contient
    /// <c>Organizator.sln</c> (<c>publish\</c> comme <c>bin\</c> sont dans le depot). Propose
    /// comme dossier de travail quand l'utilisateur envoie ses remarques a un agent.
    /// </summary>
    private static readonly Lazy<string?> RepoDir = new(FindRepoDir);

    private static string? FindRepoDir()
    {
        try
        {
            var dir = Path.GetDirectoryName(Environment.ProcessPath);
            for (var depth = 0; dir is not null && depth < 8; depth++)
            {
                if (File.Exists(Path.Combine(dir, "Organizator.sln")))
                {
                    return dir;
                }

                dir = Path.GetDirectoryName(dir);
            }
        }
        catch (Exception)
        {
            // chemin de processus illisible : pas de proposition
        }

        return null;
    }

    private JsonNode SaveData(JsonObject payload)
    {
        _store.SaveData(payload);
        return new JsonObject();
    }

    private JsonNode SaveSettings(JsonObject payload)
    {
        AppSettings incoming;
        try
        {
            incoming = payload.Deserialize<AppSettings>(Json) ?? new AppSettings();
        }
        catch (Exception ex)
        {
            throw new InvalidOperationException("Reglages invalides : " + ex.Message);
        }

        _store.SaveSettings(incoming);
        return new JsonObject();
    }

    private JsonNode PickFolder(JsonObject payload)
    {
        var initial = Str(payload, "initial");
        var dialog = new Microsoft.Win32.OpenFolderDialog
        {
            Title = "Choisir le dossier de travail",
            Multiselect = false,
        };

        if (!string.IsNullOrWhiteSpace(initial) && Directory.Exists(initial))
        {
            dialog.InitialDirectory = initial;
        }

        var picked = dialog.ShowDialog(_owner) == true ? dialog.FolderName : null;
        return new JsonObject { ["path"] = picked is null ? null : JsonValue.Create(picked) };
    }

    private JsonNode StartSession(JsonObject payload)
    {
        var provider = AgentProvider.Normalize(Str(payload, "provider"));
        var model = AgentProvider.RequireModel(Str(payload, "model"));
        var effort = AgentProvider.RequireEffort(provider, Str(payload, "effort"));
        var cwd = Str(payload, "cwd");
        var title = Str(payload, "title") ?? "";
        var context = Str(payload, "context") ?? "";
        var prompt = Str(payload, "prompt") ?? "";
        var terminal = _store.LoadSettings().Terminal;

        var started = _launcher.StartSession(provider, cwd ?? "", title, context, prompt, model, effort, terminal);

        return new JsonObject
        {
            ["sessionId"] = started.SessionId,
            ["cwd"] = started.Cwd,
            ["created"] = started.Created,
            ["provider"] = provider,
            ["model"] = model,
            ["effort"] = effort,
        };
    }

    private JsonNode ResumeSession(JsonObject payload)
    {
        var provider = AgentProvider.Normalize(Str(payload, "provider"));
        var model = AgentProvider.RequireModel(Str(payload, "model"));
        var effort = AgentProvider.RequireEffort(provider, Str(payload, "effort"));
        var sessionId = Str(payload, "sessionId") ?? "";
        var cwd = Str(payload, "cwd") ?? "";
        var title = Str(payload, "title") ?? "";
        var context = Str(payload, "context") ?? "";
        var prompt = Str(payload, "prompt") ?? "";
        var terminal = _store.LoadSettings().Terminal;

        _launcher.ResumeSession(provider, sessionId, cwd, title, context, prompt, model, effort, terminal);
        return new JsonObject();
    }

    /// <summary>
    /// Detection du catalogue Copilot (sonde ACP), en arriere-plan pour ne pas figer la fenetre.
    /// <c>force: true</c> ignore le cache de 24 h.
    /// </summary>
    private async Task<JsonNode> RefreshModelsAsync(JsonObject payload)
    {
        var force = payload["force"] is JsonValue value && value.TryGetValue<bool>(out var flag) && flag;
        var info = await Task.Run(() => _copilotCatalog.RefreshAsync(force, CancellationToken.None)).ConfigureAwait(true);
        return new JsonObject { ["copilot"] = info.ToJson() };
    }

    /// <summary>
    /// L'interface signale une reponse arrivee : clignotement du bouton dans la barre des taches
    /// si la fenetre n'est pas au premier plan (le toast, lui, est affiche cote web).
    /// </summary>
    private JsonNode Notify()
    {
        var flashed = TaskbarFlash.Flash(_owner);
        return new JsonObject { ["flashed"] = flashed };
    }

    private SessionSummary Summarize(string provider, string sessionId, string cwd)
    {
        var key = provider + "|" + sessionId + "|" + cwd;
        var stamp = provider == AgentProvider.Copilot
            ? _copilot.GetStamp(sessionId)
            : _claude.GetStamp(sessionId, cwd);

        if (stamp.Length > 0)
        {
            lock (_cacheLock)
            {
                if (_summaryCache.TryGetValue(key, out var hit) && hit.Stamp == stamp)
                {
                    return hit.Summary;
                }
            }
        }

        var summary = provider == AgentProvider.Copilot
            ? _copilot.GetSummary(sessionId)
            : _claude.GetSummary(sessionId, cwd);

        if (stamp.Length > 0)
        {
            lock (_cacheLock)
            {
                _summaryCache[key] = (stamp, summary);
            }
        }

        return summary;
    }

    private Transcript Transcribe(string provider, string sessionId, string cwd)
        => provider == AgentProvider.Copilot
            ? _copilot.GetTranscript(sessionId)
            : _claude.GetTranscript(sessionId, cwd);

    private async Task<JsonNode> GetSessionsAsync(JsonObject payload)
    {
        var requested = new List<(string Provider, string SessionId, string Cwd)>();
        if (payload["sessions"] is JsonArray array)
        {
            foreach (var item in array)
            {
                if (item is not JsonObject entry)
                {
                    continue;
                }

                var sessionId = Str(entry, "sessionId");
                if (string.IsNullOrWhiteSpace(sessionId))
                {
                    continue;
                }

                requested.Add((AgentProvider.Normalize(Str(entry, "provider")), sessionId!, Str(entry, "cwd") ?? ""));
            }
        }

        var summaries = await Task.Run(() =>
        {
            var list = new List<SessionSummary>(requested.Count);
            foreach (var (provider, sessionId, cwd) in requested)
            {
                list.Add(Summarize(provider, sessionId, cwd));
            }

            return list;
        }).ConfigureAwait(true);

        var result = new JsonArray();
        foreach (var summary in summaries)
        {
            result.Add(new JsonObject
            {
                ["sessionId"] = summary.SessionId,
                ["exists"] = summary.Exists,
                ["messageCount"] = summary.MessageCount,
                ["updated"] = summary.Updated,
                ["title"] = summary.Title,
                ["state"] = summary.State,
                ["stateTs"] = summary.StateTs,
                ["detail"] = summary.Detail,
                // true/false quand le balayage des processus a repondu, null sinon.
                ["alive"] = _scanner?.IsAlive(summary.SessionId),
            });
        }

        return new JsonObject { ["sessions"] = result };
    }

    private async Task<JsonNode> GetTranscriptAsync(JsonObject payload)
    {
        var provider = AgentProvider.Normalize(Str(payload, "provider"));
        var sessionId = Str(payload, "sessionId") ?? "";
        var cwd = Str(payload, "cwd") ?? "";

        var transcript = await Task.Run(() => Transcribe(provider, sessionId, cwd)).ConfigureAwait(true);

        var messages = new JsonArray();
        foreach (var message in transcript.Messages)
        {
            messages.Add(new JsonObject
            {
                ["role"] = message.Role,
                ["text"] = message.Text,
                ["ts"] = message.Ts,
            });
        }

        return new JsonObject
        {
            ["exists"] = transcript.Exists,
            ["title"] = transcript.Title,
            ["messages"] = messages,
        };
    }

    private JsonNode OpenPath(JsonObject payload)
    {
        var path = Str(payload, "path");
        if (string.IsNullOrWhiteSpace(path))
        {
            throw new InvalidOperationException("Aucun chemin fourni.");
        }

        string full;
        try
        {
            full = Path.GetFullPath(path!.Trim());
        }
        catch
        {
            throw new InvalidOperationException("Chemin invalide : " + path);
        }

        var arguments = Directory.Exists(full)
            ? $"\"{full}\""
            : File.Exists(full)
                ? $"/select,\"{full}\""
                : throw new InvalidOperationException("Le chemin n'existe pas : " + full);

        Process.Start(new ProcessStartInfo("explorer.exe", arguments) { UseShellExecute = true });
        return new JsonObject();
    }

    private JsonNode LogFromWeb(JsonObject payload)
    {
        _log.FromWeb(Str(payload, "level"), Str(payload, "message"));
        return new JsonObject();
    }

    // -------------------------------------------------------------------- helpers

    private static string? Str(JsonObject payload, string name)
    {
        if (!payload.TryGetPropertyValue(name, out var node) || node is null)
        {
            return null;
        }

        return node is JsonValue value && value.TryGetValue<string>(out var text)
            ? text
            : node.ToString();
    }
}
