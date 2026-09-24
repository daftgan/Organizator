using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Organizator.Services;

/// <summary>
/// Catalogue des modeles GitHub Copilot. La CLI ne l'expose que par son mode ACP (Agent Client
/// Protocol, JSON-RPC sur stdio) : <c>initialize</c> puis <c>session/new</c> renvoient
/// <c>models.availableModels</c> avec nom, multiplicateur d'usage et niveau de prix. La sonde
/// cree une session vide que la CLI ne purge jamais : elle est supprimee ici (dossier de
/// <c>session-state</c> et ligne de <c>session-store.db</c>). Le resultat est mis en cache dans
/// le dossier de donnees et rafraichi au plus une fois par jour, ou a la demande.
/// </summary>
public sealed class CopilotModelCatalog
{
    private const string CacheFileName = "copilot-models.json";
    private const string ProbeDirName = "probe";
    private static readonly TimeSpan MaxAge = TimeSpan.FromHours(24);
    private static readonly TimeSpan InitializeTimeout = TimeSpan.FromSeconds(20);
    private static readonly TimeSpan SessionTimeout = TimeSpan.FromSeconds(40);
    private static readonly TimeSpan CloseTimeout = TimeSpan.FromSeconds(5);

    private static readonly JsonDocumentOptions LenientJson = new()
    {
        AllowTrailingCommas = true,
        CommentHandling = JsonCommentHandling.Skip,
    };

    private static readonly JsonSerializerOptions CacheJson = new() { WriteIndented = true };

    private sealed record CopilotModel(string Id, string Name, string Usage, string Price, bool Enabled);

    private sealed record CachedCatalog(long FetchedAt, IReadOnlyList<CopilotModel> Models);

    private readonly HostLog _log;
    private readonly string _dataDir;
    private readonly CopilotSessions _sessions;
    private readonly Func<CommandLine?> _command;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly object _cacheLock = new();
    private CachedCatalog? _cache;
    private bool _cacheLoaded;

    /// <param name="command">Ligne de commande de la CLI, ou <c>null</c> si elle est introuvable.</param>
    public CopilotModelCatalog(string dataDir, CopilotSessions sessions, Func<CommandLine?> command, HostLog log)
    {
        _dataDir = dataDir;
        _sessions = sessions;
        _command = command;
        _log = log;
    }

    private string CachePath => Path.Combine(_dataDir, CacheFileName);

    /// <summary>Vrai si aucune detection n'a eu lieu, ou si la derniere date de plus de 24 h.</summary>
    public bool IsStale
    {
        get
        {
            var cache = LoadCache();
            return cache is null
                || DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - cache.FetchedAt > (long)MaxAge.TotalMilliseconds;
        }
    }

    /// <summary>
    /// Catalogue courant : le cache s'il existe, sinon <c>auto</c> et les modeles deja vus dans
    /// <c>~/.copilot</c>. Les valeurs par defaut viennent de <c>~/.copilot/settings.json</c>.
    /// </summary>
    public ModelCatalogInfo Current()
    {
        var (defaultModel, defaultEffort) = ReadDefaults();
        var cache = LoadCache();

        if (cache is null || cache.Models.Count == 0)
        {
            var groups = new List<ModelGroup>
            {
                new("auto", new[] { new ModelOption("auto", "Auto") }),
            };

            var used = _sessions.DiscoverModels().Where(m => m != "auto").Select(id => new ModelOption(id)).ToArray();
            if (used.Length > 0)
            {
                groups.Add(new ModelGroup("used", used));
            }

            return new ModelCatalogInfo(defaultModel, defaultEffort, 0, groups);
        }

        var byFamily = new SortedDictionary<int, (string Key, List<ModelOption> Items)>();
        foreach (var model in cache.Models)
        {
            var (order, key) = Family(model.Id);
            if (!byFamily.TryGetValue(order, out var bucket))
            {
                bucket = (key, new List<ModelOption>());
                byFamily[order] = bucket;
            }

            bucket.Items.Add(new ModelOption(model.Id, model.Name, model.Usage, model.Price, model.Enabled));
        }

        return new ModelCatalogInfo(
            defaultModel,
            defaultEffort,
            cache.FetchedAt,
            byFamily.Values.Select(b => new ModelGroup(b.Key, b.Items)).ToArray());
    }

    /// <summary>
    /// Rafraichit le catalogue par une sonde ACP si le cache est perime ou si <paramref name="force"/>.
    /// Les appels concurrents attendent la sonde en cours plutot que d'en lancer une seconde.
    /// </summary>
    public async Task<ModelCatalogInfo> RefreshAsync(bool force, CancellationToken ct)
    {
        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            if (!force && !IsStale)
            {
                return Current();
            }

            var command = _command() ?? throw new InvalidOperationException("copilot (CLI GitHub Copilot) est introuvable sur ce poste.");
            var models = await ProbeAsync(command, ct).ConfigureAwait(false);
            if (models.Count == 0)
            {
                throw new InvalidOperationException("La CLI Copilot n'a renvoye aucun modele.");
            }

            var cache = new CachedCatalog(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), models);
            SaveCache(cache);
            _log.Info($"Catalogue Copilot detecte : {models.Count} modele(s)");
            return Current();
        }
        finally
        {
            _gate.Release();
        }
    }

    // ------------------------------------------------------------------- familles

    private static (int Order, string Key) Family(string id)
    {
        if (id == "auto") return (0, "auto");
        if (id.StartsWith("claude", StringComparison.OrdinalIgnoreCase)) return (1, "claude");
        if (id.StartsWith("gpt", StringComparison.OrdinalIgnoreCase)
            || id.StartsWith("o1", StringComparison.OrdinalIgnoreCase)
            || id.StartsWith("o3", StringComparison.OrdinalIgnoreCase)
            || id.StartsWith("o4", StringComparison.OrdinalIgnoreCase)) return (2, "gpt");
        if (id.StartsWith("gemini", StringComparison.OrdinalIgnoreCase)) return (3, "gemini");
        if (id.StartsWith("grok", StringComparison.OrdinalIgnoreCase)) return (4, "grok");
        return (5, "other");
    }

    // ------------------------------------------------------------------- reglages

    private (string Model, string Effort) ReadDefaults()
    {
        try
        {
            var path = Path.Combine(_sessions.CopilotRoot, "settings.json");
            if (!File.Exists(path))
            {
                return ("", "");
            }

            using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            using var reader = new StreamReader(stream, Encoding.UTF8, detectEncodingFromByteOrderMarks: true);
            var text = reader.ReadToEnd();
            if (string.IsNullOrWhiteSpace(text))
            {
                return ("", "");
            }

            using var doc = JsonDocument.Parse(text, LenientJson);
            return (
                AgentProvider.SanitizeModel(GetString(doc.RootElement, "model")),
                AgentProvider.SanitizeEffort(AgentProvider.Copilot, GetString(doc.RootElement, "effortLevel")));
        }
        catch (Exception ex)
        {
            _log.Warn("settings.json de Copilot illisible : " + ex.Message);
            return ("", "");
        }
    }

    // ---------------------------------------------------------------------- cache

    private CachedCatalog? LoadCache()
    {
        lock (_cacheLock)
        {
            if (_cacheLoaded)
            {
                return _cache;
            }

            _cacheLoaded = true;
            try
            {
                if (!File.Exists(CachePath))
                {
                    return null;
                }

                using var doc = JsonDocument.Parse(File.ReadAllText(CachePath, Encoding.UTF8), LenientJson);
                var root = doc.RootElement;
                var fetchedAt = root.TryGetProperty("fetchedAt", out var at) && at.ValueKind == JsonValueKind.Number ? at.GetInt64() : 0;
                var models = new List<CopilotModel>();
                if (root.TryGetProperty("models", out var array) && array.ValueKind == JsonValueKind.Array)
                {
                    foreach (var item in array.EnumerateArray())
                    {
                        var id = AgentProvider.SanitizeModel(GetString(item, "id"));
                        if (id.Length == 0)
                        {
                            continue;
                        }

                        models.Add(new CopilotModel(
                            id,
                            GetString(item, "name") ?? id,
                            GetString(item, "usage") ?? "",
                            GetString(item, "price") ?? "",
                            !(item.TryGetProperty("enabled", out var enabled) && enabled.ValueKind == JsonValueKind.False)));
                    }
                }

                _cache = fetchedAt > 0 && models.Count > 0 ? new CachedCatalog(fetchedAt, models) : null;
            }
            catch (Exception ex)
            {
                _log.Warn("Cache des modeles Copilot illisible : " + ex.Message);
                _cache = null;
            }

            return _cache;
        }
    }

    private void SaveCache(CachedCatalog cache)
    {
        lock (_cacheLock)
        {
            _cache = cache;
            _cacheLoaded = true;
        }

        try
        {
            var models = new JsonArray();
            foreach (var model in cache.Models)
            {
                models.Add(new JsonObject
                {
                    ["id"] = model.Id,
                    ["name"] = model.Name,
                    ["usage"] = model.Usage,
                    ["price"] = model.Price,
                    ["enabled"] = model.Enabled,
                });
            }

            var root = new JsonObject { ["fetchedAt"] = cache.FetchedAt, ["models"] = models };
            Directory.CreateDirectory(_dataDir);
            var tmp = CachePath + ".tmp";
            File.WriteAllText(tmp, root.ToJsonString(CacheJson), new UTF8Encoding(false));
            File.Move(tmp, CachePath, overwrite: true);
        }
        catch (Exception ex)
        {
            _log.Warn("Ecriture du cache des modeles Copilot impossible : " + ex.Message);
        }
    }

    // ---------------------------------------------------------------------- sonde

    private async Task<IReadOnlyList<CopilotModel>> ProbeAsync(CommandLine command, CancellationToken ct)
    {
        var probeDir = Path.Combine(_dataDir, ProbeDirName);
        Directory.CreateDirectory(probeDir);

        var psi = new ProcessStartInfo(command.FileName)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            WorkingDirectory = probeDir,
            StandardOutputEncoding = new UTF8Encoding(false),
            StandardInputEncoding = new UTF8Encoding(false),
        };

        foreach (var argument in command.Arguments)
        {
            psi.ArgumentList.Add(argument);
        }

        psi.ArgumentList.Add("--acp");
        psi.ArgumentList.Add("--no-auto-update");

        _log.Info($"Sonde ACP Copilot : {command.FileName} {string.Join(' ', psi.ArgumentList)}");

        using var process = Process.Start(psi) ?? throw new InvalidOperationException("Impossible de lancer la CLI Copilot.");
        _ = process.StandardError.ReadToEndAsync(); // la sortie d'erreur n'est pas exploitee, mais ne doit pas bloquer

        string? sessionId = null;
        try
        {
            await SendAsync(process, 1, "initialize", new JsonObject
            {
                ["protocolVersion"] = 1,
                ["clientCapabilities"] = new JsonObject
                {
                    ["fs"] = new JsonObject { ["readTextFile"] = false, ["writeTextFile"] = false },
                },
            }, ct).ConfigureAwait(false);

            using (var init = await ReadResponseAsync(process, 1, InitializeTimeout, ct).ConfigureAwait(false))
            {
                ThrowIfError(init, "initialize");
            }

            await SendAsync(process, 2, "session/new", new JsonObject
            {
                ["cwd"] = probeDir,
                ["mcpServers"] = new JsonArray(),
            }, ct).ConfigureAwait(false);

            List<CopilotModel> models;
            using (var created = await ReadResponseAsync(process, 2, SessionTimeout, ct).ConfigureAwait(false))
            {
                ThrowIfError(created, "session/new");
                var result = created.RootElement.GetProperty("result");
                sessionId = GetString(result, "sessionId");
                models = ParseModels(result);
            }

            if (sessionId is not null)
            {
                await SendAsync(process, 3, "session/close", new JsonObject { ["sessionId"] = sessionId }, ct).ConfigureAwait(false);
                try
                {
                    using var closed = await ReadResponseAsync(process, 3, CloseTimeout, ct).ConfigureAwait(false);
                }
                catch (Exception ex)
                {
                    _log.Warn("session/close sans reponse : " + ex.Message);
                }
            }

            return models;
        }
        finally
        {
            try
            {
                process.StandardInput.Close();
            }
            catch
            {
                // Le processus est peut-etre deja parti.
            }

            if (!process.WaitForExit(5000))
            {
                try
                {
                    process.Kill(entireProcessTree: true);
                }
                catch (Exception ex)
                {
                    _log.Warn("Arret de la sonde Copilot impossible : " + ex.Message);
                }
            }

            if (sessionId is not null)
            {
                CleanupProbeSession(sessionId);
            }
        }
    }

    private static List<CopilotModel> ParseModels(JsonElement result)
    {
        var models = new List<CopilotModel>();
        if (!result.TryGetProperty("models", out var modelsNode)
            || !modelsNode.TryGetProperty("availableModels", out var available)
            || available.ValueKind != JsonValueKind.Array)
        {
            return models;
        }

        foreach (var item in available.EnumerateArray())
        {
            var id = AgentProvider.SanitizeModel(GetString(item, "modelId"));
            if (id.Length == 0)
            {
                continue;
            }

            var usage = "";
            var price = "";
            var enabled = true;
            if (item.TryGetProperty("_meta", out var meta) && meta.ValueKind == JsonValueKind.Object)
            {
                usage = GetString(meta, "copilotUsage") ?? "";
                price = GetString(meta, "copilotPriceCategory") ?? "";
                var enablement = GetString(meta, "copilotEnablement");
                enabled = string.IsNullOrEmpty(enablement) || enablement == "enabled";
            }

            models.Add(new CopilotModel(id, GetString(item, "name") ?? id, usage, price, enabled));
        }

        return models;
    }

    private static async Task SendAsync(Process process, int id, string method, JsonObject parameters, CancellationToken ct)
    {
        var message = new JsonObject
        {
            ["jsonrpc"] = "2.0",
            ["id"] = id,
            ["method"] = method,
            ["params"] = parameters,
        };

        await process.StandardInput.WriteAsync((message.ToJsonString() + "\n").AsMemory(), ct).ConfigureAwait(false);
        await process.StandardInput.FlushAsync().ConfigureAwait(false);
    }

    /// <summary>
    /// Lit les lignes JSON jusqu'a la reponse portant <paramref name="id"/> ; les notifications
    /// (<c>session/update</c>...) sont ignorees. Au-dela du delai, la sonde est consideree perdue.
    /// </summary>
    private async Task<JsonDocument> ReadResponseAsync(Process process, int id, TimeSpan timeout, CancellationToken ct)
    {
        var deadline = DateTime.UtcNow + timeout;
        while (true)
        {
            var remaining = deadline - DateTime.UtcNow;
            if (remaining <= TimeSpan.Zero)
            {
                throw new InvalidOperationException($"La CLI Copilot n'a pas repondu (id {id}) en {timeout.TotalSeconds:0} s.");
            }

            var readTask = process.StandardOutput.ReadLineAsync(ct).AsTask();
            var finished = await Task.WhenAny(readTask, Task.Delay(remaining, ct)).ConfigureAwait(false);
            if (finished != readTask)
            {
                throw new InvalidOperationException($"La CLI Copilot n'a pas repondu (id {id}) en {timeout.TotalSeconds:0} s.");
            }

            var line = await readTask.ConfigureAwait(false);
            if (line is null)
            {
                throw new InvalidOperationException("La CLI Copilot s'est arretee avant de repondre.");
            }

            if (line.Trim().Length == 0)
            {
                continue;
            }

            JsonDocument doc;
            try
            {
                doc = JsonDocument.Parse(line);
            }
            catch (JsonException)
            {
                continue;
            }

            if (doc.RootElement.ValueKind == JsonValueKind.Object
                && doc.RootElement.TryGetProperty("id", out var idNode)
                && idNode.ValueKind == JsonValueKind.Number
                && idNode.GetInt32() == id)
            {
                return doc;
            }

            doc.Dispose();
        }
    }

    private static void ThrowIfError(JsonDocument response, string method)
    {
        if (response.RootElement.TryGetProperty("error", out var error))
        {
            var message = error.ValueKind == JsonValueKind.Object ? GetString(error, "message") : error.ToString();
            throw new InvalidOperationException($"La CLI Copilot a refuse {method} : {message ?? "erreur inconnue"}");
        }

        if (!response.RootElement.TryGetProperty("result", out _))
        {
            throw new InvalidOperationException($"Reponse inattendue de la CLI Copilot a {method}.");
        }
    }

    // ------------------------------------------------------------------- nettoyage

    /// <summary>Supprime la session vide creee par la sonde (dossier et ligne de <c>session-store.db</c>).</summary>
    private void CleanupProbeSession(string sessionId)
        => CopilotSessionCleanup.Remove(_sessions, sessionId, keepIfUsed: true, _log, "de sonde");

    private static string? GetString(JsonElement element, string property)
        => element.ValueKind == JsonValueKind.Object
           && element.TryGetProperty(property, out var value)
           && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;
}
