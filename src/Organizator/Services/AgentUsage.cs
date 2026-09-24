using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Organizator.Services;

/// <summary>Une jauge de quota : part consommee, en pourcentage, d'une limite d'un agent.</summary>
/// <param name="Key">session, weekly, extra (Claude) ; premium, chat, completions (Copilot). L'UI porte les libelles.</param>
/// <param name="Scope">Precision d'une limite par modele (« Fable »), sinon null.</param>
/// <param name="Percent">Part consommee, 0 a 100.</param>
/// <param name="Used">Compte consomme quand l'API le donne (requetes Copilot), sinon null.</param>
/// <param name="Limit">Plafond correspondant, sinon null.</param>
/// <param name="Overage">Le depassement est autorise (facture) au-dela du plafond.</param>
/// <param name="ResetsAt">Remise a zero (ms Unix), 0 si inconnue.</param>
public sealed record UsageBar(string Key, string? Scope, double Percent, double? Used, double? Limit, bool Overage, long ResetsAt);

public static class UsageStatus
{
    public const string Ok = "ok";

    /// <summary>Pas de client ou pas de compte connecte sur ce poste.</summary>
    public const string Missing = "missing";

    /// <summary>Jeton perime ou refuse : relancer le client pour le renouveler.</summary>
    public const string Expired = "expired";

    /// <summary>Reseau, delai, reponse illisible.</summary>
    public const string Error = "error";
}

/// <param name="Message">Detail technique (ASCII), pour le journal et l'infobulle.</param>
/// <param name="Plan">Abonnement : « Max 5x », « Business »...</param>
/// <param name="Account">Identifiant de compte (Copilot : login), sinon null.</param>
/// <param name="Host">Hote GitHub (Copilot), sinon null.</param>
public sealed record UsageReport(
    string Provider,
    string Status,
    string? Message,
    string? Plan,
    string? Account,
    string? Host,
    IReadOnlyList<UsageBar> Bars,
    long FetchedAt)
{
    /// <summary>Jauges d'une lecture precedente, gardees parce que la derniere lecture a echoue.</summary>
    public bool Stale { get; init; }

    public static UsageReport Fail(string provider, string status, string message)
        => new(provider, status, message, null, null, null, Array.Empty<UsageBar>(), Now());

    public static long Now() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    public JsonObject ToJson()
    {
        var bars = new JsonArray();
        foreach (var bar in Bars)
        {
            bars.Add(new JsonObject
            {
                ["key"] = bar.Key,
                ["scope"] = bar.Scope,
                ["percent"] = bar.Percent,
                ["used"] = bar.Used,
                ["limit"] = bar.Limit,
                ["overage"] = bar.Overage,
                ["resetsAt"] = bar.ResetsAt,
            });
        }

        return new JsonObject
        {
            ["provider"] = Provider,
            ["status"] = Status,
            ["message"] = Message,
            ["plan"] = Plan,
            ["account"] = Account,
            ["host"] = Host,
            ["stale"] = Stale,
            ["fetchedAt"] = FetchedAt,
            ["bars"] = bars,
        };
    }
}

/// <summary>Lecture JSON tolerante : une propriete absente ou d'un autre type vaut null, jamais une exception.</summary>
internal static class UsageJson
{
    public static string? GetString(JsonElement element, string name)
        => element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    public static double? GetDouble(JsonElement element, string name)
        => element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Number && value.TryGetDouble(out var number)
            ? number
            : null;

    public static bool GetBool(JsonElement element, string name)
        => element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.True;

    public static JsonElement GetObject(JsonElement element, string name)
        => element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Object
            ? value
            : default;

    public static double Clamp(double percent)
        => double.IsNaN(percent) ? 0 : Math.Max(0, Math.Min(100, Math.Round(percent, 2)));

    /// <summary>Horodatage ISO 8601 en ms Unix ; 0 si absent ou illisible.</summary>
    public static long ParseInstant(string? value)
        => !string.IsNullOrWhiteSpace(value)
           && DateTimeOffset.TryParse(value, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var instant)
            ? instant.ToUnixTimeMilliseconds()
            : 0;

    /// <summary>Date « yyyy-MM-dd » comprise comme minuit local, en ms Unix ; 0 si absente.</summary>
    public static long ParseLocalDate(string? value)
        => !string.IsNullOrWhiteSpace(value)
           && DateTime.TryParseExact(value, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.AssumeLocal, out var date)
            ? new DateTimeOffset(date).ToUnixTimeMilliseconds()
            : 0;
}

/// <summary>Jeton OAuth de Claude Code, tel que <c>~/.claude/.credentials.json</c> le porte.</summary>
/// <param name="AccessToken">Jeton a passer en <c>Bearer</c>, jamais journalise.</param>
/// <param name="ExpiresAt">Peremption en ms Unix, 0 si inconnue.</param>
/// <param name="Plan">Abonnement lisible (« Max 5× »), sinon null.</param>
public sealed record ClaudeCredentials(string AccessToken, long ExpiresAt, string? Plan);

/// <summary>
/// Quota de l'abonnement Claude (session de 5 h, semaine, limites par modele) via l'API OAuth
/// que Claude Code interroge pour <c>/usage</c>, avec le jeton de <c>~/.claude/.credentials.json</c>.
/// Le jeton n'est jamais renouvele ici : c'est Claude Code qui s'en charge a son prochain appel.
/// </summary>
public sealed class ClaudeUsageReader
{
    public const string Endpoint = "https://api.anthropic.com/api/oauth/usage";
    /// <summary>En-tete beta qui accompagne le jeton OAuth de Claude Code, pour <c>/usage</c> comme pour <c>/v1/models</c>.</summary>
    public const string OAuthBeta = "oauth-2025-04-20";

    private readonly string _credentialsPath;

    public ClaudeUsageReader(string? credentialsPath = null)
    {
        _credentialsPath = credentialsPath
            ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".claude", ".credentials.json");
    }

    public async Task<UsageReport> FetchAsync(HttpClient http, CancellationToken ct)
    {
        ClaudeCredentials? credentials;
        try
        {
            credentials = ReadCredentials();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        {
            return UsageReport.Fail(AgentProvider.Claude, UsageStatus.Error, "identifiants illisibles : " + ex.Message);
        }

        if (credentials is null)
        {
            return UsageReport.Fail(AgentProvider.Claude, UsageStatus.Missing, "pas de connexion Claude Code (claude puis /login)");
        }

        if (credentials.ExpiresAt > 0 && credentials.ExpiresAt < UsageReport.Now())
        {
            return UsageReport.Fail(AgentProvider.Claude, UsageStatus.Expired, "jeton expire, Claude Code le renouvellera a son prochain appel");
        }

        using var request = new HttpRequestMessage(HttpMethod.Get, Endpoint);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", credentials.AccessToken);
        request.Headers.TryAddWithoutValidation("anthropic-beta", OAuthBeta);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));

        using var response = await http.SendAsync(request, ct).ConfigureAwait(false);
        if (response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
        {
            return UsageReport.Fail(AgentProvider.Claude, UsageStatus.Expired, "jeton refuse (HTTP " + (int)response.StatusCode + ")");
        }

        if (!response.IsSuccessStatusCode)
        {
            return UsageReport.Fail(AgentProvider.Claude, UsageStatus.Error, "HTTP " + (int)response.StatusCode);
        }

        var body = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        return Parse(body, credentials.Plan);
    }

    /// <summary>
    /// Forme recente : un tableau <c>limits</c> (session, weekly_all, weekly_scoped par modele) ;
    /// sinon les champs historiques <c>five_hour</c>, <c>seven_day</c>, <c>seven_day_opus</c>, <c>seven_day_sonnet</c>.
    /// </summary>
    public static UsageReport Parse(string json, string? plan)
    {
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;
        var bars = new List<UsageBar>();

        if (root.TryGetProperty("limits", out var limits) && limits.ValueKind == JsonValueKind.Array)
        {
            foreach (var limit in limits.EnumerateArray())
            {
                if (UsageJson.GetDouble(limit, "percent") is not double percent)
                {
                    continue;
                }

                var kind = UsageJson.GetString(limit, "kind") ?? "";
                var scope = UsageJson.GetObject(limit, "scope");
                var model = UsageJson.GetObject(scope, "model");
                var scopeName = kind == "weekly_all"
                    ? null
                    : UsageJson.GetString(model, "display_name") ?? UsageJson.GetString(model, "id") ?? UsageJson.GetString(scope, "surface");
                var key = kind switch
                {
                    "session" => "session",
                    "weekly_all" or "weekly_scoped" => "weekly",
                    _ => kind,
                };

                bars.Add(new UsageBar(key, scopeName, UsageJson.Clamp(percent), null, null, false, UsageJson.ParseInstant(UsageJson.GetString(limit, "resets_at"))));
            }
        }

        if (bars.Count == 0)
        {
            AddLegacy(root, "five_hour", "session", null, bars);
            AddLegacy(root, "seven_day", "weekly", null, bars);
            AddLegacy(root, "seven_day_opus", "weekly", "Opus", bars);
            AddLegacy(root, "seven_day_sonnet", "weekly", "Sonnet", bars);
        }

        var extra = UsageJson.GetObject(root, "extra_usage");
        if (UsageJson.GetBool(extra, "is_enabled") && UsageJson.GetDouble(extra, "utilization") is double extraUsed)
        {
            bars.Add(new UsageBar("extra", null, UsageJson.Clamp(extraUsed), UsageJson.GetDouble(extra, "used_credits"), UsageJson.GetDouble(extra, "monthly_limit"), false, 0));
        }

        return new UsageReport(AgentProvider.Claude, UsageStatus.Ok, null, plan, null, null, bars, UsageReport.Now());
    }

    private static void AddLegacy(JsonElement root, string name, string key, string? scope, List<UsageBar> bars)
    {
        var item = UsageJson.GetObject(root, name);
        if (UsageJson.GetDouble(item, "utilization") is not double used)
        {
            return;
        }

        bars.Add(new UsageBar(key, scope, UsageJson.Clamp(used), null, null, false, UsageJson.ParseInstant(UsageJson.GetString(item, "resets_at"))));
    }

    /// <summary>« max » et « default_claude_max_5x » donnent « Max 5x ».</summary>
    public static string? DescribePlan(string? subscription, string? tier)
    {
        if (string.IsNullOrWhiteSpace(subscription))
        {
            return null;
        }

        var name = subscription.ToLowerInvariant() switch
        {
            "max" => "Max",
            "pro" => "Pro",
            "team" => "Team",
            "enterprise" => "Enterprise",
            "free" => "Free",
            _ => subscription,
        };

        var multiplier = Regex.Match(tier ?? "", @"(\d+)x", RegexOptions.CultureInvariant);
        return multiplier.Success ? name + " " + multiplier.Groups[1].Value + "×" : name;
    }

    /// <summary>Jeton OAuth de <c>~/.claude/.credentials.json</c> ; null si le fichier ou le jeton manque. Peut lever IOException / JsonException.</summary>
    public ClaudeCredentials? ReadCredentials()
    {
        if (!File.Exists(_credentialsPath))
        {
            return null;
        }

        using var doc = JsonDocument.Parse(File.ReadAllText(_credentialsPath));
        var oauth = UsageJson.GetObject(doc.RootElement, "claudeAiOauth");
        var token = UsageJson.GetString(oauth, "accessToken");
        if (string.IsNullOrWhiteSpace(token))
        {
            return null;
        }

        var expiresAt = oauth.TryGetProperty("expiresAt", out var expires) && expires.ValueKind == JsonValueKind.Number && expires.TryGetInt64(out var ms)
            ? ms
            : 0;

        return new ClaudeCredentials(token, expiresAt, DescribePlan(UsageJson.GetString(oauth, "subscriptionType"), UsageJson.GetString(oauth, "rateLimitTier")));
    }
}

/// <summary>
/// Quota Copilot (requetes premium du mois) via <c>copilot_internal/user</c>, l'appel que VS Code
/// fait pour sa propre jauge, avec le compte connecte dans la CLI Copilot : hote et login dans
/// <c>~/.copilot/config.json</c>, jeton OAuth dans le Gestionnaire d'identifiants Windows
/// (<c>copilot-cli/&lt;hote&gt;:&lt;login&gt;</c>). Les variables COPILOT_GITHUB_TOKEN, GH_TOKEN
/// et GITHUB_TOKEN servent de repli, comme pour la CLI.
/// </summary>
public sealed class CopilotUsageReader
{
    private static readonly JsonDocumentOptions Jsonc = new() { CommentHandling = JsonCommentHandling.Skip, AllowTrailingCommas = true };
    private static readonly string[] TokenVariables = { "COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN" };

    private static readonly (string Name, string Key)[] Quotas =
    {
        ("premium_interactions", "premium"),
        ("chat", "chat"),
        ("completions", "completions"),
    };

    private readonly string _configPath;

    public CopilotUsageReader(string? configPath = null)
    {
        _configPath = configPath
            ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".copilot", "config.json");
    }

    public async Task<UsageReport> FetchAsync(HttpClient http, CancellationToken ct)
    {
        string? host;
        string? login;
        try
        {
            (host, login) = ReadAccount();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        {
            return UsageReport.Fail(AgentProvider.Copilot, UsageStatus.Error, "config.json illisible : " + ex.Message);
        }

        var token = FindToken(host, login);
        if (token is null)
        {
            return UsageReport.Fail(
                AgentProvider.Copilot,
                UsageStatus.Missing,
                host is null ? "aucun compte connecte (copilot puis /login)" : "jeton introuvable dans le Gestionnaire d'identifiants (copilot puis /login)");
        }

        host ??= "https://github.com";

        using var request = new HttpRequestMessage(HttpMethod.Get, ApiBase(host) + "/copilot_internal/user");
        request.Headers.Authorization = new AuthenticationHeaderValue("token", token);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));

        using var response = await http.SendAsync(request, ct).ConfigureAwait(false);
        if (response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
        {
            return UsageReport.Fail(AgentProvider.Copilot, UsageStatus.Expired, "jeton refuse (HTTP " + (int)response.StatusCode + ")");
        }

        if (!response.IsSuccessStatusCode)
        {
            return UsageReport.Fail(AgentProvider.Copilot, UsageStatus.Error, "HTTP " + (int)response.StatusCode);
        }

        var body = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        return Parse(body, host, login);
    }

    /// <summary>Les quotas illimites (chat, completions en general) ne donnent pas de jauge.</summary>
    public static UsageReport Parse(string json, string host, string? login)
    {
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;
        var bars = new List<UsageBar>();
        var reset = UsageJson.ParseLocalDate(UsageJson.GetString(root, "quota_reset_date"));
        var snapshots = UsageJson.GetObject(root, "quota_snapshots");

        foreach (var (name, key) in Quotas)
        {
            var quota = UsageJson.GetObject(snapshots, name);
            if (quota.ValueKind != JsonValueKind.Object || UsageJson.GetBool(quota, "unlimited"))
            {
                continue;
            }

            var entitlement = UsageJson.GetDouble(quota, "entitlement");
            var remaining = UsageJson.GetDouble(quota, "remaining") ?? UsageJson.GetDouble(quota, "quota_remaining");
            double? used = entitlement is double total && remaining is double left ? Math.Max(0, total - left) : null;
            var percent = UsageJson.GetDouble(quota, "percent_remaining") is double percentLeft
                ? 100 - percentLeft
                : used is double count && entitlement is > 0 ? 100.0 * count / entitlement.Value : 0;

            bars.Add(new UsageBar(key, null, UsageJson.Clamp(percent), used, entitlement, UsageJson.GetBool(quota, "overage_permitted"), reset));
        }

        return new UsageReport(
            AgentProvider.Copilot,
            UsageStatus.Ok,
            null,
            DescribePlan(UsageJson.GetString(root, "copilot_plan")),
            UsageJson.GetString(root, "login") ?? login,
            HostLabel(host),
            bars,
            UsageReport.Now());
    }

    public static string? DescribePlan(string? plan) => plan?.ToLowerInvariant() switch
    {
        null or "" => null,
        "business" => "Business",
        "enterprise" => "Enterprise",
        "individual" => "Pro",
        "individual_pro" or "pro_plus" => "Pro+",
        "free" or "free_limited_copilot" => "Free",
        _ => plan,
    };

    /// <summary>github.com -> api.github.com ; *.ghe.com (residence des donnees) -> api.*.ghe.com ; GHES -> /api/v3.</summary>
    public static string ApiBase(string host)
    {
        var uri = new Uri(NormalizeHost(host));
        if (uri.Host.Equals("github.com", StringComparison.OrdinalIgnoreCase))
        {
            return "https://api.github.com";
        }

        if (uri.Host.EndsWith(".ghe.com", StringComparison.OrdinalIgnoreCase))
        {
            return "https://api." + uri.Host;
        }

        return uri.GetLeftPart(UriPartial.Authority) + "/api/v3";
    }

    public static string HostLabel(string host)
        => Uri.TryCreate(NormalizeHost(host), UriKind.Absolute, out var uri) ? uri.Host : host;

    private static string NormalizeHost(string host)
    {
        var value = host.Trim().TrimEnd('/');
        return value.Contains("://", StringComparison.Ordinal) ? value : "https://" + value;
    }

    /// <summary>Hote et login du dernier compte connecte dans la CLI ; (null, null) sans connexion.</summary>
    private (string? Host, string? Login) ReadAccount()
    {
        if (!File.Exists(_configPath))
        {
            return (null, null);
        }

        using var doc = JsonDocument.Parse(File.ReadAllText(_configPath), Jsonc);
        var root = doc.RootElement;
        var last = UsageJson.GetObject(root, "lastLoggedInUser");
        var host = UsageJson.GetString(last, "host");
        var login = UsageJson.GetString(last, "login");

        if (string.IsNullOrWhiteSpace(host) && root.TryGetProperty("loggedInUsers", out var users) && users.ValueKind == JsonValueKind.Array)
        {
            foreach (var user in users.EnumerateArray())
            {
                host = UsageJson.GetString(user, "host");
                login = UsageJson.GetString(user, "login");
                if (!string.IsNullOrWhiteSpace(host))
                {
                    break;
                }
            }
        }

        return string.IsNullOrWhiteSpace(host) ? (null, null) : (NormalizeHost(host), login);
    }

    /// <summary>Jeton de la CLI dans le Gestionnaire d'identifiants, sinon les variables d'environnement habituelles.</summary>
    private static string? FindToken(string? host, string? login)
    {
        if (host is not null)
        {
            var bare = host.TrimEnd('/');
            string[] targets =
            {
                "copilot-cli/" + bare + ":" + login,
                "copilot-cli/" + bare + "/:" + login,
                bare + "/:" + login + ".copilot-cli",
                bare + ":" + login + ".copilot-cli",
            };

            foreach (var target in targets)
            {
                var secret = WindowsCredentials.Read(target);
                if (!string.IsNullOrWhiteSpace(secret))
                {
                    return secret;
                }
            }

            foreach (var target in WindowsCredentials.List("copilot-cli/*"))
            {
                if (!target.Contains(bare, StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                var secret = WindowsCredentials.Read(target);
                if (!string.IsNullOrWhiteSpace(secret))
                {
                    return secret;
                }
            }
        }

        foreach (var variable in TokenVariables)
        {
            var value = Environment.GetEnvironmentVariable(variable);
            if (!string.IsNullOrWhiteSpace(value))
            {
                return value.Trim();
            }
        }

        return null;
    }
}
