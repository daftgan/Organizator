using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Organizator.Services;

/// <summary>
/// Modeles proposes pour Claude Code. La CLI n'expose aucun listing, mais l'API Anthropic en a un
/// (<c>GET /v1/models</c>) qui repond au jeton OAuth de Claude Code, celui deja lu pour les quotas :
/// c'est la liste vivante, un modele qui vient de sortir y figure aussitot. Elle est mise en cache
/// un jour dans <c>claude-models.json</c> et rafraichie a la demande. S'y ajoutent les alias
/// officiels (<c>fable</c>, <c>opus</c>, <c>sonnet</c>, <c>haiku</c>) et les identifiants deja
/// utilises sur ce poste que l'API ne cite pas (variantes <c>[1m]</c>...), lus dans
/// <c>~/.claude/stats-cache.json</c> et <c>~/.claude.json</c>. Le modele et l'effort par defaut
/// viennent de <c>~/.claude/settings.json</c>. Tout est tolerant : sans jeton, sans reseau ou sans
/// cache, la liste est simplement plus courte.
/// </summary>
public sealed class ClaudeModelCatalog
{
    public const string Endpoint = "https://api.anthropic.com/v1/models";
    private const string CacheFileName = "claude-models.json";
    private const string ApiVersion = "2023-06-01";
    private const int PageSize = 100;
    private const int MaxPages = 5;
    private static readonly TimeSpan MaxAge = TimeSpan.FromHours(24);
    private static readonly TimeSpan RequestTimeout = TimeSpan.FromSeconds(15);

    private static readonly JsonDocumentOptions LenientJson = new()
    {
        AllowTrailingCommas = true,
        CommentHandling = JsonCommentHandling.Skip,
    };

    private static readonly JsonSerializerOptions CacheJson = new() { WriteIndented = true };

    private sealed record ClaudeModel(string Id, string Name, long CreatedAt);

    private sealed record CachedCatalog(long FetchedAt, IReadOnlyList<ClaudeModel> Models);

    private readonly HostLog _log;
    private readonly string _dataDir;
    private readonly string _userProfile;
    private readonly HttpClient _http;
    private readonly ClaudeUsageReader _credentials = new();
    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly object _cacheLock = new();
    private CachedCatalog? _cache;
    private bool _cacheLoaded;

    public ClaudeModelCatalog(string dataDir, HostLog log, string version)
    {
        _dataDir = dataDir;
        _log = log;
        _userProfile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        _http = new HttpClient { Timeout = RequestTimeout };
        _http.DefaultRequestHeaders.UserAgent.ParseAdd("Organizator/" + version);
    }

    private string CachePath => Path.Combine(_dataDir, CacheFileName);

    /// <summary>Vrai si l'API n'a jamais ete lue, ou si la derniere lecture date de plus de 24 h.</summary>
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
    /// Catalogue courant : les alias, puis les modeles de l'API (cache), puis les identifiants deja
    /// utilises que l'API ne cite pas. Sans cache, alias et deja utilises seulement, <c>fetchedAt</c> = 0.
    /// </summary>
    public ModelCatalogInfo Current()
    {
        var (defaultModel, defaultEffort) = ReadDefaults();
        var used = ReadUsed();
        var cache = LoadCache();

        var groups = new List<ModelGroup>
        {
            new("alias", AgentProvider.ClaudeModels.Select(alias => new ModelOption(alias)).ToArray()),
        };

        long fetchedAt = 0;
        if (cache is not null && cache.Models.Count > 0)
        {
            fetchedAt = cache.FetchedAt;
            // Du plus recent au plus ancien, comme l'API les rend : le dernier sorti en tete.
            var models = cache.Models.OrderByDescending(m => m.CreatedAt).ToArray();
            groups.Add(new ModelGroup("anthropic", models.Select(m => new ModelOption(m.Id, m.Name)).ToArray()));
            foreach (var model in models)
            {
                used.Remove(model.Id);
            }
        }

        if (used.Count > 0)
        {
            groups.Add(new ModelGroup("used", used.Select(id => new ModelOption(id)).ToArray()));
        }

        return new ModelCatalogInfo(defaultModel, defaultEffort, fetchedAt, groups);
    }

    /// <summary>
    /// Relit la liste sur l'API Anthropic si le cache est perime ou si <paramref name="force"/>.
    /// Les appels concurrents attendent la lecture en cours plutot que d'en lancer une seconde.
    /// Sans jeton, jeton perime ou refuse : erreur lisible, le cache precedent reste en place.
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

            ClaudeCredentials? credentials;
            try
            {
                credentials = _credentials.ReadCredentials();
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
            {
                throw new InvalidOperationException("identifiants Claude Code illisibles : " + ex.Message);
            }

            if (credentials is null)
            {
                throw new InvalidOperationException("pas de connexion Claude Code (claude puis /login).");
            }

            if (credentials.ExpiresAt > 0 && credentials.ExpiresAt < DateTimeOffset.UtcNow.ToUnixTimeMilliseconds())
            {
                throw new InvalidOperationException("jeton Claude Code expire : relancer claude, il le renouvellera.");
            }

            var models = await FetchAsync(credentials.AccessToken, ct).ConfigureAwait(false);
            if (models.Count == 0)
            {
                throw new InvalidOperationException("L'API Anthropic n'a renvoye aucun modele.");
            }

            SaveCache(new CachedCatalog(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), models));
            _log.Info($"Catalogue Claude lu sur l'API Anthropic : {models.Count} modele(s), le plus recent {models[0].Id}");
            return Current();
        }
        finally
        {
            _gate.Release();
        }
    }

    // ------------------------------------------------------------------------ API

    /// <summary>
    /// <c>GET /v1/models</c>, pagine par <c>after_id</c> (une page suffit en pratique). Le jeton OAuth
    /// de Claude Code passe en <c>Bearer</c> avec l'en-tete beta <c>oauth-2025-04-20</c>, comme pour <c>/usage</c>.
    /// </summary>
    private async Task<List<ClaudeModel>> FetchAsync(string token, CancellationToken ct)
    {
        var models = new List<ClaudeModel>();
        string? afterId = null;

        for (var page = 0; page < MaxPages; page++)
        {
            var url = Endpoint + "?limit=" + PageSize + (afterId is null ? "" : "&after_id=" + Uri.EscapeDataString(afterId));
            using var request = new HttpRequestMessage(HttpMethod.Get, url);
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            request.Headers.TryAddWithoutValidation("anthropic-beta", ClaudeUsageReader.OAuthBeta);
            request.Headers.TryAddWithoutValidation("anthropic-version", ApiVersion);
            request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));

            using var response = await _http.SendAsync(request, ct).ConfigureAwait(false);
            if (response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
            {
                throw new InvalidOperationException("jeton Claude Code refuse (HTTP " + (int)response.StatusCode + ") : relancer claude pour le renouveler.");
            }

            if (!response.IsSuccessStatusCode)
            {
                throw new InvalidOperationException("L'API Anthropic a repondu HTTP " + (int)response.StatusCode + ".");
            }

            var body = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            var (pageModels, hasMore, lastId) = ParsePage(body);
            models.AddRange(pageModels);
            if (!hasMore || string.IsNullOrEmpty(lastId))
            {
                break;
            }

            afterId = lastId;
        }

        return models;
    }

    /// <summary>Reponse <c>{ data: [{ id, display_name, created_at }], has_more, last_id }</c>.</summary>
    private static (List<ClaudeModel> Models, bool HasMore, string? LastId) ParsePage(string json)
    {
        var models = new List<ClaudeModel>();
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        if (root.TryGetProperty("data", out var data) && data.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in data.EnumerateArray())
            {
                var id = AgentProvider.SanitizeModel(GetString(item, "id"));
                if (id.Length == 0)
                {
                    continue;
                }

                models.Add(new ClaudeModel(id, GetString(item, "display_name") ?? id, UsageJson.ParseInstant(GetString(item, "created_at"))));
            }
        }

        var hasMore = root.TryGetProperty("has_more", out var more) && more.ValueKind == JsonValueKind.True;
        return (models, hasMore, GetString(root, "last_id"));
    }

    // ------------------------------------------------------------------- reglages

    private (string Model, string Effort) ReadDefaults()
    {
        try
        {
            using var settings = ReadJson(Path.Combine(_userProfile, ".claude", "settings.json"));
            if (settings is not null)
            {
                return (
                    AgentProvider.SanitizeModel(GetString(settings.RootElement, "model")),
                    AgentProvider.SanitizeEffort(AgentProvider.Claude, GetString(settings.RootElement, "effortLevel")));
            }
        }
        catch (Exception ex)
        {
            _log.Warn("settings.json de Claude Code illisible : " + ex.Message);
        }

        return ("", "");
    }

    // ---------------------------------------------------------------- deja utilises

    /// <summary>
    /// Identifiants deja passes a Claude Code sur ce poste : <c>~/.claude/stats-cache.json</c>
    /// (<c>modelUsage</c>) et <c>~/.claude.json</c> (<c>projects.*.lastModelUsage</c>). Seuls les noms
    /// de modeles sont lus ; le reste des fichiers n'est ni conserve ni journalise.
    /// </summary>
    private SortedSet<string> ReadUsed()
    {
        var used = new SortedSet<string>(StringComparer.Ordinal);

        try
        {
            using var stats = ReadJson(Path.Combine(_userProfile, ".claude", "stats-cache.json"));
            if (stats is not null
                && stats.RootElement.TryGetProperty("modelUsage", out var usage)
                && usage.ValueKind == JsonValueKind.Object)
            {
                foreach (var entry in usage.EnumerateObject())
                {
                    AddUsed(used, entry.Name);
                }
            }
        }
        catch (Exception ex)
        {
            _log.Warn("stats-cache.json de Claude Code illisible : " + ex.Message);
        }

        try
        {
            using var config = ReadJson(Path.Combine(_userProfile, ".claude.json"));
            if (config is not null
                && config.RootElement.TryGetProperty("projects", out var projects)
                && projects.ValueKind == JsonValueKind.Object)
            {
                foreach (var project in projects.EnumerateObject())
                {
                    if (project.Value.ValueKind == JsonValueKind.Object
                        && project.Value.TryGetProperty("lastModelUsage", out var last)
                        && last.ValueKind == JsonValueKind.Object)
                    {
                        foreach (var entry in last.EnumerateObject())
                        {
                            AddUsed(used, entry.Name);
                        }
                    }
                }
            }
        }
        catch (Exception ex)
        {
            _log.Warn(".claude.json illisible : " + ex.Message);
        }

        return used;
    }

    private static void AddUsed(SortedSet<string> used, string? candidate)
    {
        var model = AgentProvider.SanitizeModel(candidate);
        if (model.Length > 0 && Array.IndexOf(AgentProvider.ClaudeModels, model) < 0)
        {
            used.Add(model);
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
                var models = new List<ClaudeModel>();
                if (root.TryGetProperty("models", out var array) && array.ValueKind == JsonValueKind.Array)
                {
                    foreach (var item in array.EnumerateArray())
                    {
                        var id = AgentProvider.SanitizeModel(GetString(item, "id"));
                        if (id.Length == 0)
                        {
                            continue;
                        }

                        var createdAt = item.TryGetProperty("createdAt", out var created) && created.ValueKind == JsonValueKind.Number ? created.GetInt64() : 0;
                        models.Add(new ClaudeModel(id, GetString(item, "name") ?? id, createdAt));
                    }
                }

                _cache = fetchedAt > 0 && models.Count > 0 ? new CachedCatalog(fetchedAt, models) : null;
            }
            catch (Exception ex)
            {
                _log.Warn("Cache des modeles Claude illisible : " + ex.Message);
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
                    ["createdAt"] = model.CreatedAt,
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
            _log.Warn("Ecriture du cache des modeles Claude impossible : " + ex.Message);
        }
    }

    // ------------------------------------------------------------------- lecture

    private static JsonDocument? ReadJson(string path)
    {
        if (!File.Exists(path))
        {
            return null;
        }

        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        using var reader = new StreamReader(stream, Encoding.UTF8, detectEncodingFromByteOrderMarks: true);
        var text = reader.ReadToEnd();
        return string.IsNullOrWhiteSpace(text) ? null : JsonDocument.Parse(text, LenientJson);
    }

    private static string? GetString(JsonElement element, string property)
        => element.ValueKind == JsonValueKind.Object
           && element.TryGetProperty(property, out var value)
           && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;
}
