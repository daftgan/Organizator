using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Organizator.Services;

/// <summary>
/// Acces a un serveur Bitbucket Data Center : adresse, jeton HTTP et provenance des deux.
/// Le jeton n'est jamais ecrit par Organizator : il vient de la configuration d'un autre client
/// (le serveur MCP <c>bitbucket</c> de <c>~/.claude.json</c>) ou de l'environnement.
/// </summary>
/// <param name="Url">Adresse du serveur, sans barre finale (<c>https://git.exemple.com</c>).</param>
/// <param name="Token">Jeton HTTP (Bearer), ou null si aucun ne correspond a cette adresse.</param>
/// <param name="Source">D'ou vient l'adresse : <c>settings</c>, <c>claude.json</c> ou <c>env</c>.</param>
/// <param name="JiraUrl">Adresse de Jira si un client la connait (serveur MCP Atlassian, <c>JIRA_URL</c>), sinon null.</param>
public sealed record BitbucketAccess(string Url, string? Token, string Source, string? JiraUrl)
{
    public string Host => Uri.TryCreate(Url, UriKind.Absolute, out var uri) ? uri.Host : Url;
}

/// <summary>Une pull request ouverte qui attend l'avis de l'utilisateur, telle que rendue a l'UI.</summary>
/// <param name="Key">Cle Jira lue dans la branche, sinon dans le titre ; vide si aucune.</param>
public sealed record PendingPullRequest(
    long Id,
    string Title,
    string Project,
    string ProjectName,
    string Repo,
    string RepoName,
    string Branch,
    string Target,
    string Author,
    string Url,
    long Created,
    long Updated,
    int Comments,
    int OpenTasks,
    bool Draft,
    string Key)
{
    public JsonObject ToJson() => new()
    {
        ["id"] = Id,
        ["title"] = Title,
        ["project"] = Project,
        ["projectName"] = ProjectName,
        ["repo"] = Repo,
        ["repoName"] = RepoName,
        ["branch"] = Branch,
        ["target"] = Target,
        ["author"] = Author,
        ["url"] = Url,
        ["created"] = Created,
        ["updated"] = Updated,
        ["comments"] = Comments,
        ["openTasks"] = OpenTasks,
        ["draft"] = Draft,
        ["key"] = Key,
    };
}

/// <summary>
/// Pull requests en attente de l'utilisateur sur un Bitbucket Data Center : celles ou il est
/// relecteur, encore ouvertes, et sur lesquelles il n'a pas encore donne son avis (ni approuvees
/// ni marquees « needs work »). C'est le tableau de bord de Bitbucket lui-meme
/// (<c>/rest/api/1.0/dashboard/pull-requests</c>) qui filtre, avec le jeton de l'utilisateur.
/// </summary>
public sealed class BitbucketPullRequests : IDisposable
{
    public const string DashboardPath = "/rest/api/1.0/dashboard/pull-requests";
    private const string Query = "?role=REVIEWER&state=OPEN&participantStatus=UNAPPROVED&order=OLDEST";
    private const int PageSize = 50;
    private const int MaxPages = 10;
    private static readonly TimeSpan RequestTimeout = TimeSpan.FromSeconds(20);

    // Une cle Jira : projet en majuscules, tiret, numero — pas collee a d'autres lettres ou chiffres
    // (« UDM-1449 » dans « feature/UDM-1449-contact », mais pas le « 2-3 » d'un titre).
    private static readonly Regex JiraKey = new(@"(?<![A-Z0-9])([A-Z][A-Z0-9]+-\d+)(?!\d)", RegexOptions.Compiled | RegexOptions.CultureInvariant);

    private readonly HostLog _log;
    private readonly HttpClient _http;
    private readonly string _claudeConfigPath;
    private readonly SemaphoreSlim _gate = new(1, 1);

    public BitbucketPullRequests(HostLog log, string version, string? claudeConfigPath = null)
    {
        _log = log;
        _http = new HttpClient { Timeout = RequestTimeout };
        _http.DefaultRequestHeaders.UserAgent.ParseAdd("Organizator/" + version);
        _claudeConfigPath = claudeConfigPath
            ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".claude.json");
    }

    /// <summary>
    /// Ou aller et avec quoi. L'adresse est celle du reglage si l'utilisateur en a fixe une, sinon
    /// celle d'un serveur MCP de <c>~/.claude.json</c> (<c>BITBUCKET_URL</c>), sinon la variable
    /// d'environnement. Le jeton est celui qui accompagne cette adresse-la (meme hote) : le jeton
    /// d'un autre serveur n'ouvrirait rien. Null si aucune adresse n'est connue.
    /// </summary>
    public BitbucketAccess? Discover(string? settingsUrl)
    {
        var candidates = new List<(string Url, string? Token, string Source)>();
        string? jira = null;

        foreach (var entry in ReadClaudeConfig())
        {
            if (entry.Url is not null)
            {
                candidates.Add((entry.Url, entry.Token, "claude.json"));
            }

            jira ??= entry.Jira;
        }

        var envUrl = NormalizeUrl(Environment.GetEnvironmentVariable("BITBUCKET_URL"));
        var envToken = Clean(Environment.GetEnvironmentVariable("BITBUCKET_TOKEN"));
        if (envUrl is not null)
        {
            candidates.Add((envUrl, envToken, "env"));
        }

        jira ??= NormalizeUrl(Environment.GetEnvironmentVariable("JIRA_URL"));

        var chosen = NormalizeUrl(settingsUrl);
        string source;
        if (chosen is not null)
        {
            source = "settings";
        }
        else if (candidates.Count > 0)
        {
            chosen = candidates[0].Url;
            source = candidates[0].Source;
        }
        else
        {
            return null;
        }

        var host = HostOf(chosen);
        string? token = null;
        foreach (var candidate in candidates)
        {
            if (candidate.Token is not null && string.Equals(HostOf(candidate.Url), host, StringComparison.OrdinalIgnoreCase))
            {
                token = candidate.Token;
                break;
            }
        }

        // Un jeton d'environnement sans adresse vaut pour l'adresse choisie, quelle qu'elle soit.
        token ??= envUrl is null ? envToken : null;

        return new BitbucketAccess(chosen, token, source, jira);
    }

    /// <summary>
    /// <c>{ status, message, host, account, jiraUrl, fetchedAt, prs: [...] }</c>. <c>status</c> vaut
    /// <c>ok</c>, <c>missing</c> (pas d'adresse ou pas de jeton), <c>expired</c> (jeton refuse) ou
    /// <c>error</c> (reseau, delai, reponse illisible) ; <c>message</c> est le detail technique.
    /// </summary>
    public async Task<JsonObject> FetchAsync(string? settingsUrl, CancellationToken ct)
    {
        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            var access = Discover(settingsUrl);
            if (access is null)
            {
                return Fail(null, UsageStatus.Missing, "aucune adresse Bitbucket : BITBUCKET_URL d'un serveur MCP de ~/.claude.json, ou en variable d'environnement");
            }

            if (access.Token is null)
            {
                return Fail(access, UsageStatus.Missing, "aucun jeton pour " + access.Host + " : BITBUCKET_TOKEN du meme serveur MCP, ou en variable d'environnement");
            }

            try
            {
                var result = await ReadAllAsync(access, ct).ConfigureAwait(false);
                _log.Info("Bitbucket " + access.Host + " : " + (result["prs"] as JsonArray)?.Count + " PR en attente" + (result["status"]?.GetValue<string>() == UsageStatus.Ok ? "" : " (" + result["message"] + ")"));
                return result;
            }
            catch (OperationCanceledException)
            {
                return Fail(access, UsageStatus.Error, "delai depasse");
            }
            catch (HttpRequestException ex)
            {
                return Fail(access, UsageStatus.Error, "reseau : " + ex.Message);
            }
            catch (JsonException ex)
            {
                return Fail(access, UsageStatus.Error, "reponse illisible : " + ex.Message);
            }
        }
        finally
        {
            _gate.Release();
        }
    }

    private async Task<JsonObject> ReadAllAsync(BitbucketAccess access, CancellationToken ct)
    {
        var prs = new JsonArray();
        string? account = null;
        var start = 0;

        for (var page = 0; page < MaxPages; page++)
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, access.Url + DashboardPath + Query + "&limit=" + PageSize + "&start=" + start);
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", access.Token);
            request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));

            using var response = await _http.SendAsync(request, ct).ConfigureAwait(false);
            if (response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
            {
                return Fail(access, UsageStatus.Expired, "jeton refuse (HTTP " + (int)response.StatusCode + ")");
            }

            if (!response.IsSuccessStatusCode)
            {
                return Fail(access, UsageStatus.Error, "HTTP " + (int)response.StatusCode);
            }

            // Bitbucket signe chaque reponse authentifiee du nom de l'utilisateur, encode en URL.
            if (account is null && response.Headers.TryGetValues("X-AUSERNAME", out var names))
            {
                account = Uri.UnescapeDataString(names.FirstOrDefault() ?? "");
            }

            var body = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            using var doc = JsonDocument.Parse(body);
            var root = doc.RootElement;

            if (root.TryGetProperty("values", out var values) && values.ValueKind == JsonValueKind.Array)
            {
                foreach (var value in values.EnumerateArray())
                {
                    var pr = Parse(value, access.Url);
                    if (pr is not null)
                    {
                        prs.Add(pr.ToJson());
                    }
                }
            }

            var last = !root.TryGetProperty("isLastPage", out var lastPage) || lastPage.ValueKind != JsonValueKind.False;
            if (last || !root.TryGetProperty("nextPageStart", out var next) || !next.TryGetInt32(out start))
            {
                break;
            }
        }

        return new JsonObject
        {
            ["status"] = UsageStatus.Ok,
            ["message"] = null,
            ["host"] = access.Host,
            ["account"] = string.IsNullOrWhiteSpace(account) ? null : account,
            ["jiraUrl"] = access.JiraUrl,
            ["fetchedAt"] = UsageReport.Now(),
            ["prs"] = prs,
        };
    }

    /// <summary>Une entree de <c>values[]</c> du tableau de bord ; null si elle n'a pas la forme attendue.</summary>
    public static PendingPullRequest? Parse(JsonElement pr, string baseUrl)
    {
        if (pr.ValueKind != JsonValueKind.Object || !pr.TryGetProperty("id", out var idNode) || !idNode.TryGetInt64(out var id))
        {
            return null;
        }

        var from = UsageJson.GetObject(pr, "fromRef");
        var to = UsageJson.GetObject(pr, "toRef");
        var repository = UsageJson.GetObject(from, "repository");
        var project = UsageJson.GetObject(repository, "project");
        var author = UsageJson.GetObject(UsageJson.GetObject(pr, "author"), "user");
        var properties = UsageJson.GetObject(pr, "properties");

        var title = (UsageJson.GetString(pr, "title") ?? "").Trim();
        var branch = UsageJson.GetString(from, "displayId") ?? "";
        var projectKey = UsageJson.GetString(project, "key") ?? "";
        var repoSlug = UsageJson.GetString(repository, "slug") ?? "";

        var url = SelfLink(pr)
            ?? baseUrl + "/projects/" + projectKey + "/repos/" + repoSlug + "/pull-requests/" + id;

        var key = JiraKey.Match(branch) is { Success: true } inBranch
            ? inBranch.Groups[1].Value
            : JiraKey.Match(title) is { Success: true } inTitle ? inTitle.Groups[1].Value : "";

        return new PendingPullRequest(
            id,
            title,
            projectKey,
            UsageJson.GetString(project, "name") ?? projectKey,
            repoSlug,
            UsageJson.GetString(repository, "name") ?? repoSlug,
            branch,
            UsageJson.GetString(to, "displayId") ?? "",
            UsageJson.GetString(author, "displayName") ?? UsageJson.GetString(author, "name") ?? "",
            url,
            (long)(UsageJson.GetDouble(pr, "createdDate") ?? 0),
            (long)(UsageJson.GetDouble(pr, "updatedDate") ?? 0),
            (int)(UsageJson.GetDouble(properties, "commentCount") ?? 0),
            (int)(UsageJson.GetDouble(properties, "openTaskCount") ?? 0),
            UsageJson.GetBool(pr, "draft"),
            key);
    }

    private static string? SelfLink(JsonElement pr)
    {
        var links = UsageJson.GetObject(pr, "links");
        if (links.ValueKind == JsonValueKind.Object && links.TryGetProperty("self", out var self) && self.ValueKind == JsonValueKind.Array)
        {
            foreach (var link in self.EnumerateArray())
            {
                var href = UsageJson.GetString(link, "href");
                if (!string.IsNullOrWhiteSpace(href))
                {
                    return href;
                }
            }
        }

        return null;
    }

    private static JsonObject Fail(BitbucketAccess? access, string status, string message) => new()
    {
        ["status"] = status,
        ["message"] = message,
        ["host"] = access?.Host,
        ["account"] = null,
        ["jiraUrl"] = access?.JiraUrl,
        ["fetchedAt"] = UsageReport.Now(),
        ["prs"] = new JsonArray(),
    };

    // ------------------------------------------------------------ ~/.claude.json

    private readonly record struct ConfigEntry(string? Url, string? Token, string? Jira);

    /// <summary>
    /// Les serveurs MCP declares dans <c>~/.claude.json</c> — a la racine (<c>mcpServers</c>) puis par
    /// projet (<c>projects.*.mcpServers</c>) — et ce que leur <c>env</c> dit de Bitbucket et de Jira.
    /// Fichier absent ou illisible : liste vide, sans exception.
    /// </summary>
    private IEnumerable<ConfigEntry> ReadClaudeConfig()
    {
        var entries = new List<ConfigEntry>();
        try
        {
            if (!File.Exists(_claudeConfigPath))
            {
                return entries;
            }

            using var doc = JsonDocument.Parse(File.ReadAllText(_claudeConfigPath));
            var root = doc.RootElement;
            CollectServers(UsageJson.GetObject(root, "mcpServers"), entries);

            var projects = UsageJson.GetObject(root, "projects");
            if (projects.ValueKind == JsonValueKind.Object)
            {
                foreach (var project in projects.EnumerateObject())
                {
                    CollectServers(UsageJson.GetObject(project.Value, "mcpServers"), entries);
                }
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        {
            _log.Warn("~/.claude.json illisible pour la configuration Bitbucket : " + ex.Message);
        }

        return entries;
    }

    private static void CollectServers(JsonElement servers, List<ConfigEntry> entries)
    {
        if (servers.ValueKind != JsonValueKind.Object)
        {
            return;
        }

        foreach (var server in servers.EnumerateObject())
        {
            var env = UsageJson.GetObject(server.Value, "env");
            if (env.ValueKind != JsonValueKind.Object)
            {
                continue;
            }

            var url = NormalizeUrl(UsageJson.GetString(env, "BITBUCKET_URL"));
            var token = Clean(UsageJson.GetString(env, "BITBUCKET_TOKEN"));
            var jira = NormalizeUrl(UsageJson.GetString(env, "JIRA_URL"));
            if (url is not null || jira is not null)
            {
                entries.Add(new ConfigEntry(url, url is null ? null : token, jira));
            }
        }
    }

    /// <summary>Adresse absolue http(s), sans barre finale ; null pour tout le reste.</summary>
    public static string? NormalizeUrl(string? value)
    {
        var text = Clean(value);
        if (text is null || !Uri.TryCreate(text, UriKind.Absolute, out var uri) || (uri.Scheme != Uri.UriSchemeHttps && uri.Scheme != Uri.UriSchemeHttp))
        {
            return null;
        }

        return text.TrimEnd('/');
    }

    private static string? Clean(string? value)
    {
        var text = value?.Trim();
        return string.IsNullOrEmpty(text) ? null : text;
    }

    private static string HostOf(string url) => Uri.TryCreate(url, UriKind.Absolute, out var uri) ? uri.Host : url;

    public void Dispose()
    {
        _http.Dispose();
        _gate.Dispose();
    }
}
