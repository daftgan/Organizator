using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Organizator.Services;

namespace Revizator.Server;

/// <summary>
/// Signalements de la vue « Signaler ». Tout compte en ecrit ; le serveur les garde dans <c>issues.json</c>
/// (300 au plus, le plus recent d'abord). Seul un administrateur les lance vers Claude Code (cloud) : les
/// siens partent des l'envoi, ceux des autres comptes attendent qu'il les lise et les lance (ou les ecarte).
/// Le lancement declenche une routine de Claude Code par son point d'entree API
/// (<c>POST …/routines/trig_…/fire</c>, jeton propre a la routine), qui ouvre une session sur le depot
/// d'Organizator. Reglage : <c>REVIZATOR_ISSUE_ROUTINE_URL</c> et <c>REVIZATOR_ISSUE_ROUTINE_TOKEN</c>
/// (secrets.env). Sans routine, les signalements s'accumulent en attente. Un membre voit les siens, un
/// administrateur tous. Voir docs/REVIZATOR-SERVER.md, § 6 quinquies.
/// </summary>
public sealed class IssueReports : IDisposable
{
    public const int MaxText = 8000;
    public const int MaxTitle = 120;
    private const int Keep = 300;
    private const int Listed = 100;
    // La routine accepte 30 declenchements par heure (Run now compris) : le serveur en garde une marge.
    private const int FiresPerHour = 20;
    // Ecrire ne coute rien a Claude, mais un compte ne remplit pas le fichier pour autant.
    private const int WritesPerHour = 10;

    private static readonly Regex RefPattern = new("^[A-Za-z0-9_-]{1,40}$", RegexOptions.CultureInvariant);
    private static readonly Regex ViewPattern = new("^[a-z0-9-]{1,32}$", RegexOptions.CultureInvariant);
    private static readonly Regex PagePattern = new("^[A-Za-z0-9.+_-]{1,64}$", RegexOptions.CultureInvariant);
    private static readonly Regex SessionIdPattern = new("^session_[A-Za-z0-9]{1,80}$", RegexOptions.CultureInvariant);
    private static readonly JsonSerializerOptions Json = new() { WriteIndented = true };

    private readonly ServerConfig _config;
    private readonly HostLog _log;
    private readonly string _path;
    private readonly HttpClient _http;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private int _last;

    public IssueReports(ServerConfig config, HostLog log)
    {
        _config = config;
        _log = log;
        _path = Path.Combine(config.DataDir, "issues.json");
        _http = new HttpClient { Timeout = TimeSpan.FromSeconds(40) };
        _http.DefaultRequestHeaders.UserAgent.Add(new ProductInfoHeaderValue("revizator-server", ServerConfig.Version));
    }

    /// <summary>Une routine est reglee : un administrateur peut lancer.</summary>
    public bool Enabled => _config.IssueRoutineUrl.Length > 0 && _config.IssueRoutineToken.Length > 0;

    public void Dispose()
    {
        _http.Dispose();
        _gate.Dispose();
    }

    /// <summary>
    /// <c>issueStatus</c> : <c>{ enabled, canLaunch, admin, max, issues: [issue…] }</c>, issue =
    /// <c>{ id, login, at, title, text, view, state ('pending'|'sent'), sentAt, sentBy, sessionUrl, mine }</c>.
    /// Un membre ne recoit que les siens ; un administrateur ceux de tous les comptes.
    /// </summary>
    public JsonObject Status(string login, bool admin)
    {
        var issues = Load();
        var list = new JsonArray();
        foreach (var issue in issues.Where(i => admin || i.Login == login).Take(Listed))
        {
            list.Add(ToJson(issue, login));
        }

        return new JsonObject
        {
            ["enabled"] = Enabled,
            ["canLaunch"] = admin && Enabled,
            ["admin"] = admin,
            ["max"] = MaxText,
            ["pending"] = admin ? issues.Count(i => i.SentAt == 0) : issues.Count(i => i.SentAt == 0 && i.Login == login),
            ["issues"] = list,
        };
    }

    /// <summary>
    /// <c>issueSend { ref, title, text, view, page, device }</c> -> <c>{ issue, status, repeated }</c>. Le
    /// signalement est garde ; celui d'un administrateur part aussitot a Claude Code si une routine est
    /// reglee (s'il echoue, il reste en attente et l'erreur est rendue dans <c>error</c>). <c>ref</c> est
    /// choisi par la page : un second envoi du meme <c>ref</c> (reponse perdue, double clic) rend le premier
    /// sans en creer un autre — le point d'entree de la routine n'a pas de cle d'idempotence.
    /// </summary>
    public async Task<JsonObject> SendAsync(JsonObject payload, string login, bool admin)
    {
        var reference = Str(payload, "ref");
        if (reference is null || !RefPattern.IsMatch(reference))
        {
            throw new InvalidOperationException("Signalement sans référence valide.");
        }

        var title = OneLine(Str(payload, "title"), MaxTitle);
        var text = Clean(Str(payload, "text"));
        if (text.Length == 0)
        {
            throw new InvalidOperationException("Décrivez le problème ou l’idée avant d’envoyer.");
        }

        if (text.Length > MaxText)
        {
            throw new InvalidOperationException($"Texte trop long : {MaxText} caractères au plus.");
        }

        var view = Str(payload, "view") is { } v && ViewPattern.IsMatch(v) ? v : "";
        var page = Str(payload, "page") is { } pg && PagePattern.IsMatch(pg) ? pg : "";
        var device = OneLine(Str(payload, "device"), 160);

        await _gate.WaitAsync().ConfigureAwait(false);
        try
        {
            var issues = Load();
            var same = issues.FirstOrDefault(i => i.Login == login && i.Ref == reference);
            if (same is not null)
            {
                return new JsonObject { ["issue"] = ToJson(same, login), ["status"] = Status(login, admin), ["repeated"] = true };
            }

            var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            if (!admin && issues.Count(i => i.Login == login && i.At > now - 3_600_000) >= WritesPerHour)
            {
                throw new InvalidOperationException("Trop de signalements dans l’heure : réessayez un peu plus tard.");
            }

            var issue = new IssueEntry(NextId(issues), reference, login, now, title.Length > 0 ? title : FirstLine(text), text, view, page, device, 0, "", "", "");
            issues.Insert(0, issue);
            Save(issues);
            _log.Info($"Signalement {issue.Id} ecrit par « {login} »");

            string? error = null;
            if (admin && Enabled)
            {
                try
                {
                    issue = await LaunchLockedAsync(issues, issue, login).ConfigureAwait(false);
                }
                catch (InvalidOperationException ex)
                {
                    error = ex.Message;
                }
            }

            var result = new JsonObject { ["issue"] = ToJson(issue, login), ["status"] = Status(login, admin), ["repeated"] = false };
            if (error is not null)
            {
                result["error"] = error;
            }

            return result;
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>
    /// <c>issueLaunch { id }</c> (administrateur) : lance vers Claude Code un signalement en attente, le sien
    /// ou celui d'un autre compte -> <c>{ issue, status }</c>. Deja lance : rendu tel quel.
    /// </summary>
    public async Task<JsonObject> LaunchAsync(JsonObject payload, string login, bool admin)
    {
        RequireAdmin(login, admin);
        if (!Enabled)
        {
            throw new InvalidOperationException("Aucune routine Claude Code n’est réglée sur ce serveur (REVIZATOR_ISSUE_ROUTINE_URL et REVIZATOR_ISSUE_ROUTINE_TOKEN).");
        }

        var id = Str(payload, "id") ?? "";
        await _gate.WaitAsync().ConfigureAwait(false);
        try
        {
            var issues = Load();
            var issue = issues.FirstOrDefault(i => i.Id == id) ?? throw new InvalidOperationException($"Aucun signalement « {Clip(id, 20)} ».");
            if (issue.SentAt == 0)
            {
                issue = await LaunchLockedAsync(issues, issue, login).ConfigureAwait(false);
            }

            return new JsonObject { ["issue"] = ToJson(issue, login), ["status"] = Status(login, admin) };
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>
    /// <c>issueRemove { id }</c> : retire un signalement — un administrateur n'importe lequel, un membre
    /// seulement les siens encore en attente -> <c>{ status }</c>.
    /// </summary>
    public async Task<JsonObject> RemoveAsync(JsonObject payload, string login, bool admin)
    {
        var id = Str(payload, "id") ?? "";
        await _gate.WaitAsync().ConfigureAwait(false);
        try
        {
            var issues = Load();
            var issue = issues.FirstOrDefault(i => i.Id == id && (admin || i.Login == login));
            if (issue is null)
            {
                throw new InvalidOperationException($"Aucun signalement « {Clip(id, 20)} ».");
            }

            if (!admin && issue.SentAt != 0)
            {
                throw new InvalidOperationException("Ce signalement est déjà parti à Claude Code.");
            }

            issues.Remove(issue);
            Save(issues);
            _log.Info($"Signalement {issue.Id} de « {issue.Login} » retire par « {login} »");
            return new JsonObject { ["status"] = Status(login, admin) };
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>Declenche la routine pour <paramref name="issue"/> et l'enregistre lance (verrou tenu).</summary>
    private async Task<IssueEntry> LaunchLockedAsync(List<IssueEntry> issues, IssueEntry issue, string by)
    {
        var hourAgo = DateTimeOffset.UtcNow.AddHours(-1).ToUnixTimeMilliseconds();
        if (issues.Count(i => i.SentAt > hourAgo) >= FiresPerHour)
        {
            throw new InvalidOperationException("Trop de lancements dans l’heure : réessayez un peu plus tard.");
        }

        var (sessionId, sessionUrl) = await FireAsync(Compose(issue, by)).ConfigureAwait(false);
        var sent = issue with { SentAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), SentBy = by, SessionId = sessionId, SessionUrl = sessionUrl };
        var index = issues.FindIndex(i => i.Id == issue.Id);
        if (index >= 0)
        {
            issues[index] = sent;
        }

        Save(issues);
        _log.Info($"Signalement {issue.Id} de « {issue.Login} » lance vers Claude Code par « {by} »" + (sessionId.Length > 0 ? " (" + sessionId + ")" : ""));
        return sent;
    }

    private void RequireAdmin(string login, bool admin)
    {
        if (!admin)
        {
            _log.Warn($"Lancement d'un signalement refuse a « {login} »");
            throw new InvalidOperationException("Seul l’administrateur du serveur Révizator lance les signalements vers Claude Code.");
        }
    }

    /// <summary>
    /// Le texte remis a la routine (bloc <c>routine-fire-payload</c> de la session) : qui signale, qui lance,
    /// depuis quelle version, puis le signalement tel qu'il a ete ecrit.
    /// </summary>
    private string Compose(IssueEntry issue, string by)
    {
        var local = TimeZoneInfo.ConvertTime(DateTimeOffset.FromUnixTimeMilliseconds(issue.At), Paris());
        var commit = ServerConfig.Build.Commit;
        var b = new StringBuilder();
        b.Append("Signalement Révizator ").Append(issue.Id).Append('\n');
        b.Append("Écrit par : ").Append(issue.Login).Append(", le ")
            .Append(local.ToString("yyyy-MM-dd HH:mm", System.Globalization.CultureInfo.InvariantCulture)).Append(" (heure de Paris)\n");
        if (by != issue.Login)
        {
            b.Append("Lu et lancé par l’administrateur : ").Append(by).Append('\n');
        }

        b.Append("Serveur : ").Append(_config.PublicUrl).Append(" — Révizator ").Append(ServerConfig.Version)
            .Append(commit.Length > 0 ? ", commit " + commit : ", commit inconnu").Append('\n');
        if (issue.Page.Length > 0)
        {
            b.Append("Version de la page : ").Append(issue.Page).Append('\n');
        }

        if (issue.View.Length > 0)
        {
            b.Append("Vue ouverte avant le signalement : ").Append(issue.View).Append('\n');
        }

        if (issue.Device.Length > 0)
        {
            b.Append("Appareil : ").Append(issue.Device).Append('\n');
        }

        b.Append("Titre : ").Append(issue.Title.Length > 0 ? issue.Title : "(sans titre)").Append("\n\n");
        b.Append(issue.Text).Append('\n');
        return b.ToString();
    }

    /// <summary>Heure de Paris ; celle du conteneur (TZ) si sa base de fuseaux manque.</summary>
    private static TimeZoneInfo Paris()
    {
        try
        {
            return TimeZoneInfo.FindSystemTimeZoneById("Europe/Paris");
        }
        catch (Exception ex) when (ex is TimeZoneNotFoundException or InvalidTimeZoneException)
        {
            return TimeZoneInfo.Local;
        }
    }

    private async Task<(string SessionId, string SessionUrl)> FireAsync(string text)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, _config.IssueRoutineUrl);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _config.IssueRoutineToken);
        request.Headers.TryAddWithoutValidation("anthropic-version", "2023-06-01");
        // Contrat date du point d'entree (encore experimental) : le figer plutot que suivre ses changements.
        request.Headers.TryAddWithoutValidation("anthropic-beta", "experimental-cc-routine-2026-04-01");
        request.Content = new StringContent(new JsonObject { ["text"] = text }.ToJsonString(), Encoding.UTF8, "application/json");

        HttpResponseMessage response;
        try
        {
            response = await _http.SendAsync(request).ConfigureAwait(false);
        }
        catch (TaskCanceledException)
        {
            _log.Warn("Signalement : pas de reponse de la routine en 40 s");
            throw new InvalidOperationException("Claude Code n’a pas répondu à temps. La session a peut-être été créée : regardez sur claude.ai/code avant de renvoyer.");
        }
        catch (HttpRequestException ex)
        {
            _log.Warn("Signalement : routine injoignable : " + ex.Message);
            throw new InvalidOperationException("Claude Code est injoignable depuis le serveur : réessayez plus tard.");
        }

        using (response)
        {
            var body = await response.Content.ReadAsStringAsync().ConfigureAwait(false);
            JsonNode? node = null;
            try
            {
                node = JsonNode.Parse(body);
            }
            catch (JsonException)
            {
                // Corps illisible : le code HTTP dit l'essentiel.
            }

            if (response.IsSuccessStatusCode)
            {
                var sessionId = node?["claude_code_session_id"] is JsonValue s && s.TryGetValue<string>(out var sid) && SessionIdPattern.IsMatch(sid) ? sid : "";
                var sessionUrl = node?["claude_code_session_url"] is JsonValue u && u.TryGetValue<string>(out var url)
                    && url.StartsWith("https://claude.ai/", StringComparison.Ordinal) && url.Length <= 200 ? url : "";
                if (sessionUrl.Length == 0 && sessionId.Length > 0)
                {
                    sessionUrl = "https://claude.ai/code/" + sessionId;
                }

                return (sessionId, sessionUrl);
            }

            var detail = node?["error"]?["message"] is JsonValue m && m.TryGetValue<string>(out var message) ? OneLine(message, 300) : "";
            _log.Warn($"Signalement refuse par la routine : HTTP {(int)response.StatusCode}" + (detail.Length > 0 ? " — " + detail : ""));
            throw new InvalidOperationException(response.StatusCode switch
            {
                HttpStatusCode.Unauthorized => "Le jeton de la routine est refusé : régénérez-le sur claude.ai/code/routines et mettez à jour REVIZATOR_ISSUE_ROUTINE_TOKEN.",
                HttpStatusCode.Forbidden => "Ce compte Claude n’a pas accès aux routines de Claude Code.",
                HttpStatusCode.NotFound => "Routine introuvable : vérifiez REVIZATOR_ISSUE_ROUTINE_URL.",
                HttpStatusCode.TooManyRequests => "Limite de Claude Code atteinte : réessayez " + RetryText(response) + ".",
                HttpStatusCode.BadRequest => "Claude Code a refusé le signalement" + (detail.Length > 0 ? " : " + detail : " (routine en pause ?)."),
                _ when (int)response.StatusCode >= 500 => "Claude Code est momentanément indisponible : réessayez dans quelques minutes.",
                _ => $"Claude Code a répondu HTTP {(int)response.StatusCode}" + (detail.Length > 0 ? " : " + detail : "."),
            });
        }
    }

    private static string RetryText(HttpResponseMessage response)
    {
        var delta = response.Headers.RetryAfter?.Delta;
        if (delta is null && response.Headers.RetryAfter?.Date is { } date)
        {
            delta = date - DateTimeOffset.UtcNow;
        }

        if (delta is null || delta.Value <= TimeSpan.Zero)
        {
            return "un peu plus tard";
        }

        var minutes = (int)Math.Ceiling(delta.Value.TotalMinutes);
        return minutes <= 1 ? "dans une minute" : "dans " + minutes + " minutes";
    }

    // ------------------------------------------------------------------ fichier

    private sealed record IssueEntry(string Id, string Ref, string Login, long At, string Title, string Text, string View, string Page, string Device,
        long SentAt, string SentBy, string SessionId, string SessionUrl);

    private static JsonObject ToJson(IssueEntry issue, string login) => new()
    {
        ["id"] = issue.Id,
        ["login"] = issue.Login,
        ["at"] = issue.At,
        ["title"] = issue.Title,
        ["text"] = issue.Text,
        ["view"] = issue.View,
        ["state"] = issue.SentAt == 0 ? "pending" : "sent",
        ["sentAt"] = issue.SentAt,
        ["sentBy"] = issue.SentBy,
        ["sessionUrl"] = issue.SessionUrl,
        ["mine"] = issue.Login == login,
    };

    /// <summary>
    /// Numero suivant : jamais celui d'un signalement retire (la session de Claude Code qui le porte le
    /// cite encore) ; le dernier donne est garde dans le fichier (<c>last</c>).
    /// </summary>
    private string NextId(List<IssueEntry> issues)
    {
        var seen = issues.Select(i => i.Id.StartsWith("RZ-", StringComparison.Ordinal) && int.TryParse(i.Id[3..], out var n) ? n : 0).DefaultIfEmpty(0).Max();
        _last = Math.Max(_last, seen) + 1;
        return "RZ-" + _last;
    }

    private List<IssueEntry> Load()
    {
        try
        {
            if (!File.Exists(_path))
            {
                return new List<IssueEntry>();
            }

            var root = JsonNode.Parse(File.ReadAllText(_path));
            if (root?["last"] is JsonValue last && last.TryGetValue<int>(out var number) && number > _last)
            {
                _last = number;
            }

            return (root?["issues"] as JsonArray ?? new JsonArray())
                .Select(n => n.Deserialize<IssueEntry>(Json))
                .Where(i => i is not null && i.Id is not null && i.Login is not null)
                .Select(i => i! with
                {
                    Ref = i.Ref ?? "", Title = i.Title ?? "", Text = i.Text ?? "", View = i.View ?? "", Page = i.Page ?? "", Device = i.Device ?? "",
                    SentBy = i.SentBy ?? "", SessionId = i.SessionId ?? "", SessionUrl = i.SessionUrl ?? "",
                })
                .ToList();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException or InvalidOperationException)
        {
            _log.Warn("issues.json illisible : " + ex.Message);
            return new List<IssueEntry>();
        }
    }

    /// <summary>Ecriture atomique ; au-dela de <see cref="Keep"/>, les plus anciens s'en vont.</summary>
    private void Save(List<IssueEntry> issues)
    {
        if (issues.Count > Keep)
        {
            issues.RemoveRange(Keep, issues.Count - Keep);
        }

        var root = new JsonObject { ["version"] = 1, ["last"] = _last, ["issues"] = JsonSerializer.SerializeToNode(issues, Json) };
        var tmp = _path + ".tmp";
        File.WriteAllText(tmp, root.ToJsonString(Json));
        File.Move(tmp, _path, overwrite: true);
    }

    private static string Clip(string text, int max) => text.Length <= max ? text : text[..max];

    // ------------------------------------------------------------------ texte

    private static string? Str(JsonObject payload, string name) =>
        payload[name] is JsonValue value && value.TryGetValue<string>(out var text) ? text : null;

    /// <summary>Retours a la ligne normalises, caracteres de controle retires (tabulation et saut de ligne gardes).</summary>
    private static string Clean(string? text)
    {
        if (string.IsNullOrEmpty(text))
        {
            return "";
        }

        var normalized = text.Replace("\r\n", "\n").Replace('\r', '\n');
        return new string(normalized.Where(c => c == '\n' || c == '\t' || !char.IsControl(c)).ToArray()).Trim();
    }

    private static string OneLine(string? text, int max)
    {
        var line = string.Join(' ', Clean(text).Split(new[] { '\n', '\t' }, StringSplitOptions.RemoveEmptyEntries)).Trim();
        return line.Length <= max ? line : line[..max].TrimEnd();
    }

    private static string FirstLine(string text) => OneLine(text.Split('\n', 2)[0], MaxTitle);
}
