using System.Globalization;
using System.IO;
using System.Text;
using System.Text.Json;

namespace Organizator.Services;

/// <summary>
/// Lecture des sessions GitHub Copilot CLI : <c>%USERPROFILE%\.copilot\session-state\&lt;uuid&gt;\</c>
/// contient <c>workspace.yaml</c> (nom, dossier de travail) et <c>events.jsonl</c> (un evenement JSON
/// par ligne). Contrairement a Claude Code, les sessions ne sont pas rangees par dossier de travail.
/// Le fichier peut etre en cours d'ecriture : ouvert en <see cref="FileShare.ReadWrite"/>, lignes
/// invalides ignorees.
/// </summary>
public sealed class CopilotSessions
{
    /// <summary>Nombre de sessions recentes parcourues pour decouvrir les modeles deja utilises.</summary>
    private const int MaxDiscoveredSessions = 40;

    private static readonly JsonDocumentOptions LenientJson = new()
    {
        AllowTrailingCommas = true,
        CommentHandling = JsonCommentHandling.Skip,
    };

    private readonly HostLog _log;

    // Lecture incrementale : un scan par dossier de session pour les resumes, un seul pour la
    // transcription (l'interface n'en affiche qu'une a la fois).
    private readonly object _scansLock = new();
    private readonly Dictionary<string, SessionScan> _summaryScans = new(StringComparer.OrdinalIgnoreCase);
    private readonly SessionScan _transcriptScan = new();
    private string _transcriptDir = "";

    public CopilotSessions(HostLog log)
    {
        _log = log;
        CopilotRoot = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".copilot");
        SessionsRoot = Path.Combine(CopilotRoot, "session-state");
    }

    public string CopilotRoot { get; }

    public string SessionsRoot { get; }

    public string GetSessionDir(string sessionId) => Path.Combine(SessionsRoot, NormalizeId(sessionId));

    public string GetEventsPath(string sessionId) => Path.Combine(GetSessionDir(sessionId), "events.jsonl");

    /// <summary>Les identifiants viennent de data.json : seul un GUID est accepte comme nom de dossier.</summary>
    private static string NormalizeId(string? sessionId)
        => Guid.TryParse(sessionId, out var guid) ? guid.ToString("D") : "";

    public SessionSummary GetSummary(string sessionId)
    {
        return NormalizeId(sessionId).Length == 0
            ? SessionSummary.Missing(sessionId)
            : SummarizeDirectory(sessionId, GetSessionDir(sessionId));
    }

    /// <summary>Resume d'un dossier de session precis (expose pour les tests).</summary>
    public SessionSummary SummarizeDirectory(string sessionId, string dir)
    {
        if (!Directory.Exists(dir))
        {
            lock (_scansLock)
            {
                _summaryScans.Remove(dir);
            }

            return SessionSummary.Missing(sessionId);
        }

        SessionScan scan;
        lock (_scansLock)
        {
            if (!_summaryScans.TryGetValue(dir, out scan!))
            {
                scan = new SessionScan();
                _summaryScans[dir] = scan;
            }
        }

        lock (scan)
        {
            var parsed = Parse(scan, dir, collectMessages: false);
            return new SessionSummary(
                sessionId, true, parsed.MessageCount, GetUpdated(dir), parsed.Title,
                parsed.State, parsed.StateTs, parsed.Detail);
        }
    }

    /// <summary>Empreinte des deux fichiers de la session, pour ne les relire que s'ils ont change.</summary>
    public string GetStamp(string sessionId)
    {
        if (NormalizeId(sessionId).Length == 0)
        {
            return "";
        }

        var dir = GetSessionDir(sessionId);
        var events = TranscriptAccumulator.FileStamp(Path.Combine(dir, "events.jsonl"));
        return events.Length == 0
            ? ""
            : events + "|" + TranscriptAccumulator.FileStamp(Path.Combine(dir, "workspace.yaml"));
    }

    public Transcript GetTranscript(string sessionId)
    {
        var dir = GetSessionDir(sessionId);
        if (NormalizeId(sessionId).Length == 0 || !Directory.Exists(dir))
        {
            return new Transcript(false, TranscriptAccumulator.DefaultTitle, Array.Empty<TranscriptMessage>());
        }

        lock (_transcriptScan)
        {
            // Une autre session que la precedente : la lecture repart de son debut.
            if (!string.Equals(_transcriptDir, dir, StringComparison.OrdinalIgnoreCase))
            {
                _transcriptScan.Reset();
                _transcriptDir = dir;
            }

            var parsed = Parse(_transcriptScan, dir, collectMessages: true);
            return new Transcript(true, parsed.Title, parsed.Messages.ToArray());
        }
    }

    /// <summary>
    /// Modeles deja utilises sur ce poste, du plus sur au plus ancien : modele par defaut de
    /// <c>settings.json</c>, <c>recentModelIds</c> de <c>config.json</c>, puis <c>selectedModel</c>
    /// de l'evenement <c>session.start</c> des sessions les plus recentes. Toujours sans exception.
    /// </summary>
    public IReadOnlyList<string> DiscoverModels()
    {
        var found = new List<string>();

        void Add(string? candidate)
        {
            var model = AgentProvider.SanitizeModel(candidate);
            if (model.Length > 0 && !found.Contains(model, StringComparer.Ordinal))
            {
                found.Add(model);
            }
        }

        try
        {
            using var settings = ReadJsonFile(Path.Combine(CopilotRoot, "settings.json"));
            if (settings is not null)
            {
                Add(GetString(settings.RootElement, "model"));
            }
        }
        catch (Exception ex)
        {
            _log.Warn("settings.json de Copilot illisible : " + ex.Message);
        }

        try
        {
            using var config = ReadJsonFile(Path.Combine(CopilotRoot, "config.json"));
            if (config is not null
                && config.RootElement.TryGetProperty("recentModelIds", out var recent)
                && recent.ValueKind == JsonValueKind.Array)
            {
                foreach (var item in recent.EnumerateArray())
                {
                    if (item.ValueKind == JsonValueKind.String)
                    {
                        Add(item.GetString());
                    }
                }
            }
        }
        catch (Exception ex)
        {
            _log.Warn("config.json de Copilot illisible : " + ex.Message);
        }

        try
        {
            if (Directory.Exists(SessionsRoot))
            {
                var dirs = new DirectoryInfo(SessionsRoot).GetDirectories()
                    .OrderByDescending(d => d.LastWriteTimeUtc)
                    .Take(MaxDiscoveredSessions);

                foreach (var dir in dirs)
                {
                    var events = Path.Combine(dir.FullName, "events.jsonl");
                    if (!File.Exists(events))
                    {
                        continue;
                    }

                    var first = ReadFirstLine(events);
                    if (string.IsNullOrWhiteSpace(first))
                    {
                        continue;
                    }

                    try
                    {
                        using var doc = JsonDocument.Parse(first);
                        if (GetString(doc.RootElement, "type") == "session.start"
                            && doc.RootElement.TryGetProperty("data", out var data)
                            && data.ValueKind == JsonValueKind.Object)
                        {
                            Add(GetString(data, "selectedModel"));
                        }
                    }
                    catch (JsonException)
                    {
                        // Premiere ligne tronquee ou d'un autre format : sans importance.
                    }
                }
            }
        }
        catch (Exception ex)
        {
            _log.Warn("Parcours des sessions Copilot impossible : " + ex.Message);
        }

        return found;
    }

    // ------------------------------------------------------------------- lecture

    private static long GetUpdated(string dir)
    {
        long best = 0;
        foreach (var name in new[] { "events.jsonl", "workspace.yaml" })
        {
            try
            {
                var path = Path.Combine(dir, name);
                if (!File.Exists(path))
                {
                    continue;
                }

                var stamp = new DateTimeOffset(File.GetLastWriteTimeUtc(path), TimeSpan.Zero).ToUnixTimeMilliseconds();
                if (stamp > best)
                {
                    best = stamp;
                }
            }
            catch
            {
                // Fichier en cours de remplacement : on garde ce qu'on a.
            }
        }

        return best;
    }

    /// <summary>
    /// Met a jour le scan du dossier : le titre vient de <c>workspace.yaml</c>, relu a chaque
    /// passage (il change quand Copilot nomme la session), et seules les lignes ajoutees a
    /// <c>events.jsonl</c> depuis le passage precedent sont relues.
    /// </summary>
    private TranscriptAccumulator Parse(SessionScan scan, string dir, bool collectMessages)
    {
        var result = scan.Accumulator;

        try
        {
            ReadWorkspace(Path.Combine(dir, "workspace.yaml"), result);
        }
        catch (Exception ex)
        {
            _log.Warn($"workspace.yaml de {Path.GetFileName(dir)} illisible : {ex.Message}");
        }

        var events = Path.Combine(dir, "events.jsonl");
        if (!File.Exists(events))
        {
            return result;
        }

        scan.Read(events, (line, acc) => ReadLine(line, collectMessages, acc), ex =>
            _log.Error($"Lecture de la session Copilot {Path.GetFileName(dir)} impossible", ex));

        // Read() a pu repartir de zero (fichier reecrit) : l'accumulateur n'est plus le meme objet.
        var current = scan.Accumulator;
        if (!ReferenceEquals(current, result))
        {
            try
            {
                ReadWorkspace(Path.Combine(dir, "workspace.yaml"), current);
            }
            catch (Exception ex)
            {
                _log.Warn($"workspace.yaml de {Path.GetFileName(dir)} illisible : {ex.Message}");
            }
        }

        return current;
    }

    /// <summary>Un evenement du fichier de session ; les lignes illisibles sont ignorees.</summary>
    private void ReadLine(string line, bool collectMessages, TranscriptAccumulator result)
    {
        try
        {
            ReadEvent(line, collectMessages, result);
        }
        catch (JsonException)
        {
            // Ligne tronquee (fichier en cours d'ecriture) ou malformee : on l'ignore.
        }
        catch (Exception ex)
        {
            _log.Warn($"Evenement Copilot ignore : {ex.Message}");
        }
    }

    /// <summary>
    /// <c>workspace.yaml</c> est un YAML plat : <c>name: Titre</c> (donne par Copilot, ou par
    /// l'utilisateur quand <c>user_named: true</c>). Seules ces deux cles sont lues.
    /// </summary>
    private static void ReadWorkspace(string path, TranscriptAccumulator result)
    {
        if (!File.Exists(path))
        {
            return;
        }

        string? name = null;
        var userNamed = false;

        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        using var reader = new StreamReader(stream, Encoding.UTF8, detectEncodingFromByteOrderMarks: true);

        string? line;
        while ((line = reader.ReadLine()) is not null)
        {
            if (line.StartsWith("name:", StringComparison.Ordinal))
            {
                name = UnquoteYaml(line["name:".Length..]);
            }
            else if (line.StartsWith("user_named:", StringComparison.Ordinal))
            {
                userNamed = string.Equals(line["user_named:".Length..].Trim(), "true", StringComparison.OrdinalIgnoreCase);
            }
        }

        if (string.IsNullOrWhiteSpace(name))
        {
            return;
        }

        if (userNamed)
        {
            result.CustomTitle = name;
        }
        else
        {
            result.AiTitle = name;
        }
    }

    private static string UnquoteYaml(string raw)
    {
        var value = raw.Trim();
        if (value.Length >= 2 && value[0] == '"' && value[^1] == '"')
        {
            return value[1..^1].Replace("\\\"", "\"").Replace("\\\\", "\\");
        }

        if (value.Length >= 2 && value[0] == '\'' && value[^1] == '\'')
        {
            return value[1..^1].Replace("''", "'");
        }

        return value;
    }

    /// <summary>
    /// Ne retient que <c>user.message</c> et <c>assistant.message</c> du fil principal. Les evenements
    /// des sous-agents portent un <c>agentId</c> a la racine : ignores, comme <c>isSidechain</c> chez Claude.
    /// </summary>
    private static void ReadEvent(string line, bool collectMessages, TranscriptAccumulator result)
    {
        using var doc = JsonDocument.Parse(line);
        var root = doc.RootElement;
        if (root.ValueKind != JsonValueKind.Object)
        {
            return;
        }

        var type = GetString(root, "type");
        if (type is null)
        {
            return;
        }

        if (root.TryGetProperty("agentId", out var agent) && agent.ValueKind == JsonValueKind.String)
        {
            return;
        }

        var hasData = root.TryGetProperty("data", out var data) && data.ValueKind == JsonValueKind.Object;
        TrackState(type, hasData ? data : default, ReadTimestamp(root), result);

        if (type != "user.message" && type != "assistant.message")
        {
            return;
        }

        if (!hasData)
        {
            return;
        }

        var content = (GetString(data, "content") ?? "").Trim();

        if (type == "user.message")
        {
            if (content.Length == 0)
            {
                return;
            }

            result.FirstUserLine ??= content;
            result.MessageCount++;

            if (collectMessages)
            {
                result.AddMessage("user", content, ReadTimestamp(root));
            }

            return;
        }

        var sb = new StringBuilder(content);
        if (data.TryGetProperty("toolRequests", out var tools) && tools.ValueKind == JsonValueKind.Array)
        {
            foreach (var tool in tools.EnumerateArray())
            {
                if (tool.ValueKind != JsonValueKind.Object)
                {
                    continue;
                }

                var name = GetString(tool, "name");
                if (sb.Length > 0)
                {
                    sb.Append('\n');
                }

                sb.Append("[outil : ").Append(string.IsNullOrWhiteSpace(name) ? "?" : name).Append(']');
            }
        }

        var text = sb.ToString();
        if (text.Length == 0)
        {
            return;
        }

        // Une reponse qui ne porte que des appels d'outil apparait dans la transcription
        // mais ne compte pas comme un message (meme regle que pour Claude).
        if (content.Length > 0)
        {
            result.MessageCount++;
        }

        if (collectMessages)
        {
            result.AddMessage("assistant", text, ReadTimestamp(root));
        }
    }

    /// <summary>
    /// Machine d'etat du fil principal. Copilot ecrit <c>assistant.turn_end</c> apres chaque appel du
    /// modele, outils compris : la reponse n'est complete que si aucun <c>assistant.message</c> du
    /// tour ne demandait d'outil, sans quoi le modele est rappele aussitot.
    /// </summary>
    private static void TrackState(string type, JsonElement data, long ts, TranscriptAccumulator result)
    {
        switch (type)
        {
            case "user.message":
                if ((GetString(data, "content") ?? "").Trim().Length > 0)
                {
                    result.SetState(SessionState.Working, ts, null);
                }

                break;

            case "assistant.turn_start":
                result.TurnHasTools = false;
                result.SetState(SessionState.Working, ts, result.Detail);
                break;

            case "assistant.message":
                if (data.ValueKind == JsonValueKind.Object
                    && data.TryGetProperty("toolRequests", out var tools)
                    && tools.ValueKind == JsonValueKind.Array
                    && tools.GetArrayLength() > 0)
                {
                    result.TurnHasTools = true;
                }

                break;

            case "tool.execution_start":
                result.SetState(SessionState.Working, ts, GetString(data, "toolName") ?? result.Detail);
                break;

            case "tool.execution_complete":
                result.SetState(SessionState.Working, ts, result.Detail);
                break;

            case "assistant.turn_end":
                result.SetState(result.TurnHasTools ? SessionState.Working : SessionState.Ready, ts, null);
                break;

            case "permission.requested":
                result.SetState(SessionState.Waiting, ts, "autorisation demandee");
                break;

            case "permission.completed":
                result.SetState(SessionState.Working, ts, null);
                break;

            case "abort":
                result.SetState(SessionState.Idle, ts, "interrompue");
                break;

            case "session.error":
                result.SetState(SessionState.Error, ts, TranscriptAccumulator.Shorten(GetString(data, "message")) ?? "erreur");
                break;

            case "session.shutdown":
                result.SetState(SessionState.Idle, ts, "fermee");
                break;

            case "session.start":
            case "session.resume":
                result.SetState(SessionState.Idle, ts, null);
                break;
        }
    }

    // ------------------------------------------------------------------- helpers

    private static JsonDocument? ReadJsonFile(string path)
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

    private static string? ReadFirstLine(string path)
    {
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        using var reader = new StreamReader(stream, Encoding.UTF8, detectEncodingFromByteOrderMarks: true);
        return reader.ReadLine();
    }

    private static long ReadTimestamp(JsonElement root)
    {
        var raw = GetString(root, "timestamp");
        if (string.IsNullOrWhiteSpace(raw))
        {
            return 0;
        }

        return DateTimeOffset.TryParse(
            raw,
            CultureInfo.InvariantCulture,
            DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal,
            out var parsed)
            ? parsed.ToUnixTimeMilliseconds()
            : 0;
    }

    private static string? GetString(JsonElement element, string property)
        => element.ValueKind == JsonValueKind.Object
            && element.TryGetProperty(property, out var value)
            && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;
}
