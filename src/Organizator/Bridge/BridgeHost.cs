using System.ComponentModel;
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
    private readonly AgentArtifacts _artifacts;
    private readonly AgentLauncher _launcher;
    private readonly ClaudeModelCatalog _claudeCatalog;
    private readonly CopilotModelCatalog _copilotCatalog;
    private readonly AgentProcessScanner? _scanner;
    private readonly AgentWindows _windows;
    private readonly UsageMonitor _usage;
    private readonly AgentDraft _draft;
    private readonly ArtifactReader _reader;
    private readonly BitbucketPullRequests _bitbucket;
    private readonly PerfMonitor? _perf;

    // Dossier actuellement servi sous https://report.organizator/ (voir ArtifactReader.Locate).
    private string? _reportRoot;

    // Un transcript n'est relu que si sa taille ou sa date a change : le rafraichissement de
    // toutes les conversations a chaque evenement reste bon marche.
    private readonly object _cacheLock = new();
    private readonly Dictionary<string, (string Stamp, SessionSummary Summary)> _summaryCache = new(StringComparer.Ordinal);

    // Reprise d'une session dont la fenetre etait fermee : les agents qu'elle avait lances sont
    // morts avec elle, mais le fichier de session, relu depuis son debut, les montre encore partis
    // au travail. On retient donc l'instant de la relance pour ne plus compter ceux d'avant.
    private readonly Dictionary<string, long> _relaunchedAt = new(StringComparer.OrdinalIgnoreCase);

    // Terminal ouvert par une reprise : le balayage des processus ne voit l'agent qu'apres
    // quelques secondes, et un second clic dans l'intervalle ouvrait un second terminal sur la
    // meme session. Le PowerShell lance est retenu le temps que le balayage prenne le relais.
    private readonly Dictionary<string, (int ProcessId, long At)> _launchedTerminal = new(StringComparer.OrdinalIgnoreCase);
    private const long LaunchedTerminalMs = 120_000;

    public BridgeHost(
        CoreWebView2 core,
        Window owner,
        HostLog log,
        DataStore store,
        ClaudeSessions claude,
        CopilotSessions copilot,
        AgentLauncher launcher,
        AgentProcessScanner? scanner,
        PerfMonitor? perf = null)
    {
        _core = core;
        _perf = perf;
        _owner = owner;
        _log = log;
        _store = store;
        _claude = claude;
        _copilot = copilot;
        _artifacts = new AgentArtifacts(claude, copilot, log);
        _launcher = launcher;
        _scanner = scanner;
        _windows = new AgentWindows(log);
        _claudeCatalog = new ClaudeModelCatalog(store.DataDir, log, HostVersion);
        _copilotCatalog = new CopilotModelCatalog(store.DataDir, copilot, () => launcher.CopilotCommand, log);
        _usage = new UsageMonitor(log, HostVersion);
        _draft = new AgentDraft(launcher, copilot, log, store.DataDir);
        _reader = new ArtifactReader(log);
        _bitbucket = new BitbucketPullRequests(log, HostVersion);
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
        string? type = null;
        var started = Stopwatch.GetTimestamp();
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
            type = envelope["type"]?.GetValue<string>();
            var payload = envelope["payload"] as JsonObject ?? new JsonObject();

            if (string.IsNullOrWhiteSpace(type))
            {
                Reply(id, false, null, "Message sans type.");
                return;
            }

            _perf?.MessageStarted(type!);
            var result = await DispatchAsync(type!, payload).ConfigureAwait(true);
            Reply(id, true, result, null);
        }
        catch (Exception ex)
        {
            _log.Error("Echec du traitement d'un message web", ex);
            Reply(id, false, null, Readable(ex));
        }
        finally
        {
            if (!string.IsNullOrWhiteSpace(type))
            {
                _perf?.RecordMessage(type!, Stopwatch.GetElapsedTime(started).TotalMilliseconds);
            }
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
        "resumeSession" => await ResumeSessionAsync(payload).ConfigureAwait(true),
        "getSessions" => await GetSessionsAsync(payload).ConfigureAwait(true),
        "getTranscript" => await GetTranscriptAsync(payload).ConfigureAwait(true),
        "getRecaps" => await GetRecapsAsync(payload).ConfigureAwait(true),
        "refreshModels" => await RefreshModelsAsync(payload).ConfigureAwait(true),
        "draftText" => await DraftTextAsync(payload).ConfigureAwait(true),
        "notify" => Notify(),
        "getUsage" => await GetUsageAsync(payload).ConfigureAwait(true),
        "getPullRequests" => await GetPullRequestsAsync().ConfigureAwait(true),
        "openPath" => OpenPath(payload),
        "openUrl" => OpenUrl(payload),
        "readArtifact" => await ReadArtifactAsync(payload).ConfigureAwait(true),
        "log" => LogFromWeb(payload),
        "perf" => RecordPerf(payload),
        _ => throw new InvalidOperationException($"Type de message inconnu : {type}"),
    };

    // ------------------------------------------------------------------- handlers

    private JsonNode GetState()
    {
        var settings = _store.LoadSettings();

        // Ce que l'hote sait de Bitbucket sans le reglage de l'utilisateur : les Reglages le disent
        // a cote du champ d'adresse (« detecte : ... »).
        var bitbucket = _bitbucket.Discover(null);

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
                ["bitbucketUrl"] = bitbucket?.Url ?? "",
                ["bitbucketSource"] = bitbucket?.Source ?? "",
                ["bitbucketToken"] = bitbucket?.Token is not null,
                ["jiraUrl"] = bitbucket?.JiraUrl ?? "",
                ["models"] = new JsonObject
                {
                    ["claude"] = _claudeCatalog.Current().ToJson(),
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

    /// <summary>PRs Bitbucket qui attendent l'avis de l'utilisateur ; voir <see cref="BitbucketPullRequests"/>.</summary>
    private async Task<JsonNode> GetPullRequestsAsync()
    {
        var settings = _store.LoadSettings();
        return await _bitbucket.FetchAsync(settings.BitbucketUrl, CancellationToken.None).ConfigureAwait(true);
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

    private async Task<JsonNode> ResumeSessionAsync(JsonObject payload)
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

        // Une session encore ouverte n'a pas besoin d'un second terminal : sa fenetre suffit.
        // Sauf s'il y a un message a lui remettre, que seule une reprise sait transmettre.
        // Tant que le balayage n'a pas vu l'agent, le PowerShell qu'on vient d'ouvrir en tient lieu.
        // Une fois vu, il est oublie : un PowerShell reste ouvert (-NoExit) apres un agent quitte.
        var scanned = _scanner?.PidFor(sessionId);
        if (scanned is not null)
        {
            lock (_cacheLock)
            {
                _launchedTerminal.Remove(sessionId);
            }
        }

        if (string.IsNullOrWhiteSpace(prompt) && (scanned ?? LaunchedTerminal(sessionId)) is int agentProcessId)
        {
            var focus = await _windows.TryFocusAsync(agentProcessId).ConfigureAwait(true);
            if (focus.Focused)
            {
                _log.Info($"Session {provider} deja ouverte : "
                    + (focus.Tab == TabOutcome.Activated ? "onglet active" : "fenetre ramenee au premier plan")
                    + $" ({sessionId})");

                return new JsonObject
                {
                    ["focused"] = true,
                    ["tabActivated"] = focus.Tab == TabOutcome.Activated,
                    // Vide quand la fenetre montre deja la session ; sinon l'onglet a activer soi-meme.
                    ["tab"] = TabToShow(focus, title),
                };
            }
        }

        // Session refermee qu'on rouvre : ses anciens agents ne travaillent plus (voir _relaunchedAt).
        // Une session encore vivante, elle, garde les siens : la reprise ne fait qu'y poser un message.
        if (_scanner?.IsAlive(sessionId) != true)
        {
            lock (_cacheLock)
            {
                _relaunchedAt[sessionId] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            }
        }

        var launched = _launcher.ResumeSession(provider, sessionId, cwd, title, context, prompt, model, effort, terminal);
        if (launched is int terminalProcessId)
        {
            lock (_cacheLock)
            {
                _launchedTerminal[sessionId] = (terminalProcessId, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            }

            _ = BringLaunchedForwardAsync(provider, sessionId, terminalProcessId);
        }

        return new JsonObject { ["focused"] = false };
    }

    /// <summary>Etat du balayage ; un agent vu vivant n'a plus besoin du terminal retenu a sa reprise.</summary>
    private bool? Alive(string sessionId)
    {
        var alive = _scanner?.IsAlive(sessionId);
        if (alive == true)
        {
            lock (_cacheLock)
            {
                _launchedTerminal.Remove(sessionId);
            }
        }

        return alive;
    }

    /// <summary>PowerShell ouvert il y a peu pour cette session et toujours la, sinon null.</summary>
    private int? LaunchedTerminal(string sessionId)
    {
        (int ProcessId, long At) launched;
        lock (_cacheLock)
        {
            if (!_launchedTerminal.TryGetValue(sessionId, out launched))
            {
                return null;
            }

            if (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - launched.At > LaunchedTerminalMs)
            {
                _launchedTerminal.Remove(sessionId);
                return null;
            }
        }

        return AgentWindows.IsRunning(launched.ProcessId) ? launched.ProcessId : null;
    }

    /// <summary>
    /// Le terminal qu'on vient d'ouvrir peut naitre derriere Organizator (nouvel onglet d'une
    /// fenetre Windows Terminal deja ouverte) : on attend sa fenetre et on la ramene devant.
    /// </summary>
    private async Task BringLaunchedForwardAsync(string provider, string sessionId, int processId)
    {
        try
        {
            var focus = await _windows.FocusWhenShownAsync(processId, TimeSpan.FromSeconds(8)).ConfigureAwait(true);
            if (focus.Focused)
            {
                _log.Info($"Session {provider} reprise : fenetre ramenee au premier plan ({sessionId})");
            }
            else
            {
                _log.Warn($"Session {provider} reprise : fenetre du terminal introuvable ({sessionId})");
            }
        }
        catch (Exception ex)
        {
            _log.Warn("Premier plan du terminal impossible : " + ex.Message);
        }
    }

    /// <summary>
    /// Nom de l'onglet que l'utilisateur doit activer lui-meme ; vide quand il n'y a rien a faire,
    /// parce que l'onglet de la session est deja devant ou que la fenetre n'en a pas.
    /// </summary>
    private static string TabToShow(FocusResult focus, string sessionTitle) => focus.Tab switch
    {
        TabOutcome.None or TabOutcome.Activated => "",

        // Le vrai nom de l'onglet quand il a ete lu ; sinon celui de la session, a defaut de mieux.
        _ when focus.TabTitle.Length > 0 => focus.TabTitle,
        _ => ShowsSession(focus.WindowTitle, sessionTitle) ? "" : sessionTitle,
    };

    /// <summary>
    /// Vrai si le titre de la fenetre porte celui de la session. Les agents reecrivent le titre du
    /// terminal a partir du nom de la session, en le prefixant et parfois en le tronquant : on
    /// compare donc sur un debut de titre, pas a l'identique.
    /// </summary>
    private static bool ShowsSession(string windowTitle, string sessionTitle)
    {
        var wanted = sessionTitle.Trim();
        if (wanted.Length == 0)
        {
            return true;
        }

        if (wanted.Length > 24)
        {
            wanted = wanted[..24];
        }

        return windowTitle.Contains(wanted, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// Redaction assistee : l'agent regle dans les Reglages ecrit le texte demande et le rend a
    /// l'interface, qui le propose a l'utilisateur. Rien n'est enregistre ici.
    /// </summary>
    private async Task<JsonNode> DraftTextAsync(JsonObject payload)
    {
        var settings = _store.LoadSettings();
        var provider = AgentProvider.Normalize(Str(payload, "provider") ?? settings.DraftProvider);
        var model = AgentProvider.RequireModel(Str(payload, "model") ?? settings.DraftModel);
        var effort = AgentProvider.RequireEffort(provider, Str(payload, "effort") ?? settings.DraftEffort);
        var system = Limit(Str(payload, "system"), 4000);
        var prompt = Limit(Str(payload, "prompt"), 4000);

        var result = await _draft.WriteAsync(provider, model, effort, system, prompt).ConfigureAwait(true);
        return new JsonObject
        {
            ["text"] = result.Text,
            ["ms"] = result.Ms,
            ["provider"] = provider,
            ["model"] = model,
        };
    }

    private static string Limit(string? value, int max)
    {
        var text = (value ?? "").Trim();
        return text.Length <= max ? text : text[..max];
    }

    /// <summary>
    /// Detection du catalogue d'un agent, en arriere-plan pour ne pas figer la fenetre : sonde ACP
    /// pour Copilot, <c>GET /v1/models</c> de l'API Anthropic pour Claude. <c>force: true</c> ignore
    /// le cache de 24 h. La reponse porte le catalogue sous le nom de l'agent.
    /// </summary>
    private async Task<JsonNode> RefreshModelsAsync(JsonObject payload)
    {
        var force = payload["force"] is JsonValue value && value.TryGetValue<bool>(out var flag) && flag;
        var provider = AgentProvider.Normalize(payload["provider"] is JsonValue name && name.TryGetValue<string>(out var text) ? text : null);
        var info = provider == AgentProvider.Copilot
            ? await Task.Run(() => _copilotCatalog.RefreshAsync(force, CancellationToken.None)).ConfigureAwait(true)
            : await Task.Run(() => _claudeCatalog.RefreshAsync(force, CancellationToken.None)).ConfigureAwait(true);
        return new JsonObject { [provider] = info.ToJson() };
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

    // Un agent qui vient de partir n'a pas encore forcement ecrit sa premiere ligne ; passe ce delai,
    // c'est son transcript qui dit s'il travaille toujours. Un agent silencieux depuis un quart
    // d'heure a fini sans le dire (fenetre fermee, coequipier arrete) : il ne compte plus.
    private const long AgentGraceMs = 3 * 60 * 1000;
    private const long AgentSilenceMs = 15 * 60 * 1000;

    /// <summary>
    /// Agents encore au travail. Le transcript de la session dit qui est parti et qui est revenu ;
    /// les transcripts des sous-agents disent qui ecrit encore. Sont ecartes ceux d'avant une relance
    /// de la session (elle a emporte son equipe) et ceux qui n'ecrivent plus depuis longtemps sans
    /// avoir annonce leur retour.
    /// </summary>
    private IReadOnlyList<AgentRun> ActiveAgents(string provider, string cwd, SessionSummary summary)
    {
        if (summary.Agents.Count == 0)
        {
            return summary.Agents;
        }

        long relaunched;
        lock (_cacheLock)
        {
            _relaunchedAt.TryGetValue(summary.SessionId, out relaunched);
        }

        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var subagents = provider == AgentProvider.Copilot
            ? null
            : _claude.ScanSubagents(summary.SessionId, cwd, now - AgentSilenceMs);

        var kept = new List<AgentRun>(summary.Agents.Count);
        foreach (var agent in summary.Agents)
        {
            if (agent.StartedAt < relaunched)
            {
                continue;
            }

            if (agent.StartedAt >= now - AgentGraceMs || subagents is null || WritesStill(subagents, agent))
            {
                kept.Add(agent);
            }
        }

        return kept;
    }

    /// <summary>
    /// L'agent ecrit-il encore ? Un coequipier est reconnu par son nom (celui de son
    /// <c>.meta.json</c>) ; une tache de fond, dont le transcript ne porte pas de nom, se contente
    /// de la vie du dossier.
    /// </summary>
    private static bool WritesStill(IReadOnlyList<SubagentActivity> subagents, AgentRun agent)
    {
        const string named = "agent:";
        if (!agent.Key.StartsWith(named, StringComparison.Ordinal))
        {
            return subagents.Count > 0;
        }

        var name = agent.Key[named.Length..];
        foreach (var subagent in subagents)
        {
            if (subagent.Name.Length == 0 || string.Equals(subagent.Name, name, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }

        return false;
    }

    private Transcript Transcribe(string provider, string sessionId, string cwd)
        => provider == AgentProvider.Copilot
            ? _copilot.GetTranscript(sessionId)
            : _claude.GetTranscript(sessionId, cwd);

    /// <summary>Sessions demandees par l'UI : <c>{ sessions: [{ sessionId, cwd, provider }] }</c>.</summary>
    private static List<(string Provider, string SessionId, string Cwd)> RequestedSessions(JsonObject payload)
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

        return requested;
    }

    /// <summary>
    /// Empreinte des artefacts que l'UI detient deja, par session (<c>artifactsStamp</c>) : tant
    /// qu'elle n'a pas change, la liste ne repart pas. Elle pesait l'essentiel de la reponse
    /// (plus d'un millier de fichiers pour une soixantaine de sessions), a chaque relecture.
    /// </summary>
    private static Dictionary<string, string> KnownArtifactStamps(JsonObject payload)
    {
        var known = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        if (payload["sessions"] is JsonArray array)
        {
            foreach (var item in array)
            {
                if (item is JsonObject entry
                    && Str(entry, "sessionId") is { Length: > 0 } sessionId
                    && Str(entry, "artifactsStamp") is { Length: > 0 } stamp)
                {
                    known[sessionId] = stamp;
                }
            }
        }

        return known;
    }

    private async Task<JsonNode> GetSessionsAsync(JsonObject payload)
    {
        var requested = RequestedSessions(payload);
        var known = KnownArtifactStamps(payload);

        // Tout ce qui touche au disque se fait hors du fil de l'interface, y compris le releve des
        // sous-agents : le fil de l'interface est aussi celui qui laisse passer la frappe.
        var snapshots = await Task.Run(() =>
        {
            var list = new List<(SessionSummary Summary, string ArtifactsStamp, IReadOnlyList<AgentArtifact>? Artifacts, IReadOnlyList<AgentRun> Agents)>(requested.Count);
            foreach (var (provider, sessionId, cwd) in requested)
            {
                var summary = Summarize(provider, sessionId, cwd);
                var (stamp, artifacts) = _artifacts.GetWithStamp(provider, sessionId, cwd);
                var unchanged = known.TryGetValue(sessionId, out var held) && held == stamp;
                list.Add((summary, stamp, unchanged ? null : artifacts, ActiveAgents(provider, cwd, summary)));
            }

            return list;
        }).ConfigureAwait(true);

        var result = new JsonArray();
        foreach (var snapshot in snapshots)
        {
            var summary = snapshot.Summary;
            var agents = new JsonArray();
            foreach (var agent in snapshot.Agents)
            {
                agents.Add(agent.Label);
            }

            var entry = new JsonObject
            {
                ["sessionId"] = summary.SessionId,
                ["exists"] = summary.Exists,
                ["messageCount"] = summary.MessageCount,
                ["updated"] = summary.Updated,
                ["title"] = summary.Title,
                ["state"] = summary.State,
                ["stateTs"] = summary.StateTs,
                ["detail"] = summary.Detail,
                // Derniere parole de l'agent : sa reponse, ou la question qu'il pose.
                ["said"] = summary.Said,
                ["artifactsStamp"] = snapshot.ArtifactsStamp,
                // Agents lances par la session et pas encore revenus, par leur nom.
                ["agents"] = agents,
                // true/false quand le balayage des processus a repondu, null sinon.
                ["alive"] = Alive(summary.SessionId),
            };

            // Absente quand l'UI detient deja la liste de cette empreinte.
            if (snapshot.Artifacts is not null)
            {
                var artifacts = new JsonArray();
                foreach (var artifact in snapshot.Artifacts)
                {
                    artifacts.Add(new JsonObject
                    {
                        ["path"] = artifact.Path,
                        ["action"] = artifact.Action,
                        ["tool"] = artifact.Tool,
                        // Sous-agent qui l'a ecrit ; vide pour la session elle-meme.
                        ["agent"] = artifact.Agent,
                    });
                }

                entry["artifacts"] = artifacts;
            }

            result.Add(entry);
        }

        return new JsonObject { ["sessions"] = result };
    }

    // Une reponse plus longue que cela n'est plus un recapitulatif ; l'UI raccourcit encore selon
    // la place dans le contexte (la ligne de commande qui le porte est bornee a 32 Ko).
    private const int RecapAnswerLength = 12000;

    /// <summary>
    /// Ce que chaque conversation a rendu, pour le resume du travail deja fait qu'une nouvelle
    /// conversation recoit : la derniere reponse complete de l'agent. Les rapports produits sont
    /// deja connus de l'UI (<c>convo.artifacts</c>).
    /// </summary>
    private async Task<JsonNode> GetRecapsAsync(JsonObject payload)
    {
        var requested = RequestedSessions(payload);

        var answers = await Task.Run(() =>
        {
            var list = new List<(string SessionId, string? Answer)>(requested.Count);
            foreach (var (provider, sessionId, cwd) in requested)
            {
                string? answer;
                try
                {
                    answer = provider == AgentProvider.Copilot
                        ? _copilot.GetLastAnswer(sessionId)
                        : _claude.GetLastAnswer(sessionId, cwd);
                }
                catch (Exception ex)
                {
                    _log.Warn($"Resume de la session {sessionId} impossible : {ex.Message}");
                    answer = null;
                }

                list.Add((sessionId, answer));
            }

            return list;
        }).ConfigureAwait(true);

        var result = new JsonArray();
        foreach (var (sessionId, answer) in answers)
        {
            var text = answer ?? "";
            if (text.Length > RecapAnswerLength)
            {
                text = text[..RecapAnswerLength].TrimEnd() + "\n[…]";
            }

            result.Add(new JsonObject
            {
                ["sessionId"] = sessionId,
                ["exists"] = answer is not null,
                ["answer"] = text,
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
            var rawPath = path!.Trim();
            var cwd = Str(payload, "cwd")?.Trim();
            full = Path.GetFullPath(
                Path.IsPathRooted(rawPath) || string.IsNullOrWhiteSpace(cwd)
                    ? rawPath
                    : Path.Combine(cwd!, rawPath));
        }
        catch
        {
            throw new InvalidOperationException("Chemin invalide : " + path);
        }

        if (!Directory.Exists(full) && !File.Exists(full))
        {
            throw new InvalidOperationException("Le chemin n'existe pas : " + full);
        }

        var editor = Str(payload, "editor");
        if (string.Equals(editor, "vscode", StringComparison.OrdinalIgnoreCase)
            && TryOpenInVisualStudioCode(full))
        {
            return new JsonObject { ["editor"] = "vscode" };
        }

        // Un fichier que le lecteur ne sait pas afficher (tableur, document Office...) part vers
        // l'application qui lui est associee ; sans association, l'Explorateur le montre.
        if (string.Equals(editor, "default", StringComparison.OrdinalIgnoreCase)
            && File.Exists(full)
            && TryOpenWithDefaultApp(full))
        {
            return new JsonObject { ["editor"] = "default" };
        }

        var arguments = Directory.Exists(full)
            ? $"\"{full}\""
            : $"/select,\"{full}\"";

        Process.Start(new ProcessStartInfo("explorer.exe", arguments) { UseShellExecute = true });
        return new JsonObject { ["editor"] = "explorer" };
    }

    private bool TryOpenWithDefaultApp(string path)
    {
        try
        {
            Process.Start(new ProcessStartInfo(path) { UseShellExecute = true });
            return true;
        }
        catch (Win32Exception ex)
        {
            _log.Warn("Aucune application associee a " + Path.GetFileName(path) + " : " + ex.Message);
            return false;
        }
        catch (InvalidOperationException ex)
        {
            _log.Warn("Ouverture de " + Path.GetFileName(path) + " impossible : " + ex.Message);
            return false;
        }
    }

    /// <summary>Un lien externe clique dans un rapport : navigateur ou client de messagerie par defaut.</summary>
    private JsonNode OpenUrl(JsonObject payload)
    {
        var url = Str(payload, "url")?.Trim();
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri)
            || uri.Scheme is not ("http" or "https" or "mailto"))
        {
            throw new InvalidOperationException("Adresse non ouvrable : " + url);
        }

        Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true });
        return new JsonObject { ["opened"] = true };
    }

    /// <summary>
    /// Lecture d'un artefact pour le lecteur de l'UI. Avec un <c>stamp</c> identique a l'empreinte
    /// courante du fichier, rien n'est relu ni renvoye : l'UI relit toutes les 2 s tant que le
    /// lecteur est ouvert, pour suivre un rapport encore en cours d'ecriture.
    /// </summary>
    private async Task<JsonNode> ReadArtifactAsync(JsonObject payload)
    {
        var path = Str(payload, "path");
        if (string.IsNullOrWhiteSpace(path))
        {
            throw new InvalidOperationException("Aucun chemin fourni.");
        }

        var cwd = Str(payload, "cwd");
        var known = Str(payload, "stamp") ?? "";
        var full = ArtifactReader.Resolve(path!, cwd);

        if (known.Length > 0 && TranscriptAccumulator.FileStamp(full) == known)
        {
            return new JsonObject { ["changed"] = false, ["stamp"] = known };
        }

        var view = await Task.Run(() => _reader.Read(full, cwd)).ConfigureAwait(true);

        if (view.Kind is ArtifactReader.KindMarkdown or ArtifactReader.KindHtml
            or ArtifactReader.KindPdf or ArtifactReader.KindImage)
        {
            ServeReportRoot(view.Root);
        }

        return new JsonObject
        {
            ["changed"] = true,
            ["kind"] = view.Kind,
            ["full"] = view.Full,
            ["root"] = view.Root,
            ["url"] = view.Url,
            ["title"] = view.Title,
            ["stamp"] = view.Stamp,
            ["size"] = view.Size,
            ["modified"] = view.Modified,
            ["html"] = view.Html,
        };
    }

    /// <summary>
    /// Sert le dossier du rapport courant sous <c>https://report.organizator/</c> : c'est ce qui
    /// permet au lecteur d'afficher un PDF, une page ou une image, et au Markdown de trouver ses
    /// images relatives. Un seul dossier a la fois ; il change avec le rapport ouvert. Sur le fil
    /// de l'interface, comme tout appel a la WebView.
    /// </summary>
    private void ServeReportRoot(string root)
    {
        if (string.Equals(_reportRoot, root, StringComparison.OrdinalIgnoreCase))
        {
            return;
        }

        if (_reportRoot is not null)
        {
            try
            {
                _core.ClearVirtualHostNameToFolderMapping(ArtifactReader.Host);
            }
            catch (Exception ex)
            {
                _log.Warn("Retrait de l'hote virtuel des rapports impossible : " + ex.Message);
            }
        }

        // DenyCors : images, cadres et PDF se chargent, mais aucun script ne peut lire ces fichiers par fetch.
        _core.SetVirtualHostNameToFolderMapping(ArtifactReader.Host, root, CoreWebView2HostResourceAccessKind.DenyCors);
        _reportRoot = root;
        _log.Info("Rapports servis depuis " + root);
    }

    private bool TryOpenInVisualStudioCode(string path)
    {
        var command = FindVisualStudioCode();
        if (command is null)
        {
            _log.Warn("Visual Studio Code introuvable, ouverture de l'artefact dans l'Explorateur.");
            return false;
        }

        var arguments = Directory.Exists(path)
            ? "--reuse-window " + QuoteProcessArgument(path)
            : "--reuse-window --goto " + QuoteProcessArgument(path);

        try
        {
            Process.Start(new ProcessStartInfo(command, arguments) { UseShellExecute = true });
            return true;
        }
        catch (Win32Exception ex)
        {
            _log.Warn("Ouverture dans Visual Studio Code impossible : " + ex.Message);
            return false;
        }
        catch (InvalidOperationException ex)
        {
            _log.Warn("Ouverture dans Visual Studio Code impossible : " + ex.Message);
            return false;
        }
    }

    private static string? FindVisualStudioCode()
    {
        var names = new[] { "code.cmd", "code.exe", "code-insiders.cmd", "code-insiders.exe" };
        var path = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (var part in path.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
        {
            var directory = part.Trim().Trim('"');
            foreach (var name in names)
            {
                var candidate = Path.Combine(directory, name);
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }
        }

        var roots = new[]
        {
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
        };
        foreach (var root in roots.Where(value => !string.IsNullOrWhiteSpace(value)))
        {
            foreach (var name in names)
            {
                var candidate = Path.Combine(root, "Programs", "Microsoft VS Code", "bin", name);
                if (File.Exists(candidate))
                {
                    return candidate;
                }

                candidate = Path.Combine(root, "Microsoft VS Code", "bin", name);
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }
        }

        return null;
    }

    private static string QuoteProcessArgument(string value)
        => "\"" + value.Replace("\"", "\\\"", StringComparison.Ordinal) + "\"";

    private JsonNode LogFromWeb(JsonObject payload)
    {
        _log.FromWeb(Str(payload, "level"), Str(payload, "message"));
        return new JsonObject();
    }

    /// <summary>Mesures de l'interface web (taches longues, saisies lentes, rendus) pour le bilan de <see cref="PerfMonitor"/>.</summary>
    private JsonNode RecordPerf(JsonObject payload)
    {
        _perf?.RecordWeb(payload);
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
