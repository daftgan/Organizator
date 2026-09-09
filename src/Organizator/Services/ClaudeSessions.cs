using System.Globalization;
using System.IO;
using System.Text;
using System.Text.Json;

namespace Organizator.Services;

/// <summary>
/// Lecture des fichiers de session Claude Code :
/// <c>%USERPROFILE%\.claude\projects\&lt;cwd encode&gt;\&lt;uuid&gt;.jsonl</c>.
/// Le fichier peut etre en cours d'ecriture : il est ouvert en <see cref="FileShare.ReadWrite"/>
/// et toute ligne invalide est ignoree.
/// </summary>
public sealed class ClaudeSessions
{
    public const int MaxMessages = TranscriptAccumulator.MaxMessages;

    private readonly HostLog _log;

    // Lecture incrementale : un scan par fichier de session pour les resumes, un seul pour la
    // transcription (l'interface n'en affiche qu'une a la fois).
    private readonly object _scansLock = new();
    private readonly Dictionary<string, SessionScan> _summaryScans = new(StringComparer.OrdinalIgnoreCase);
    private readonly SessionScan _transcriptScan = new();
    private string _transcriptPath = "";

    public ClaudeSessions(HostLog log)
    {
        _log = log;
        ProjectsRoot = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            ".claude",
            "projects");
    }

    public string ProjectsRoot { get; }

    /// <summary>
    /// Encodage du dossier de travail : tout caractere hors <c>[A-Za-z0-9]</c> devient <c>-</c>,
    /// la casse est conservee. <c>D:\02-side\Organizator</c> devient <c>D--02-side-Organizator</c>.
    /// </summary>
    public static string EncodeCwd(string cwd)
    {
        if (string.IsNullOrEmpty(cwd))
        {
            return "";
        }

        var sb = new StringBuilder(cwd.Length);
        foreach (var c in cwd)
        {
            sb.Append((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') ? c : '-');
        }

        return sb.ToString();
    }

    public string GetSessionFilePath(string sessionId, string cwd)
        => Path.Combine(ProjectsRoot, EncodeCwd(cwd ?? ""), (sessionId ?? "") + ".jsonl");

    public SessionSummary GetSummary(string sessionId, string cwd)
        => SummarizeFile(sessionId, GetSessionFilePath(sessionId, cwd));

    /// <summary>Resume d'un fichier de session precis (expose pour les tests).</summary>
    public SessionSummary SummarizeFile(string sessionId, string path)
    {
        if (!File.Exists(path))
        {
            lock (_scansLock)
            {
                _summaryScans.Remove(path);
            }

            return SessionSummary.Missing(sessionId);
        }

        SessionScan scan;
        lock (_scansLock)
        {
            if (!_summaryScans.TryGetValue(path, out scan!))
            {
                scan = new SessionScan();
                _summaryScans[path] = scan;
            }
        }

        lock (scan)
        {
            scan.Read(path, (line, acc) => ReadLine(line, collectMessages: false, acc), ex =>
                _log.Error($"Lecture de la session {Path.GetFileName(path)} impossible", ex));

            var parsed = scan.Accumulator;
            return new SessionSummary(
                sessionId, true, parsed.MessageCount, GetUpdated(path), parsed.Title,
                parsed.State, parsed.StateTs, parsed.Detail);
        }
    }

    /// <summary>Empreinte du fichier de session, pour ne le relire que s'il a change.</summary>
    public string GetStamp(string sessionId, string cwd)
        => TranscriptAccumulator.FileStamp(GetSessionFilePath(sessionId, cwd));

    public Transcript GetTranscript(string sessionId, string cwd)
    {
        var path = GetSessionFilePath(sessionId, cwd);
        if (!File.Exists(path))
        {
            return new Transcript(false, TranscriptAccumulator.DefaultTitle, Array.Empty<TranscriptMessage>());
        }

        lock (_transcriptScan)
        {
            // Une autre session que la precedente : la lecture repart de son debut.
            if (!string.Equals(_transcriptPath, path, StringComparison.OrdinalIgnoreCase))
            {
                _transcriptScan.Reset();
                _transcriptPath = path;
            }

            _transcriptScan.Read(path, (line, acc) => ReadLine(line, collectMessages: true, acc), ex =>
                _log.Error($"Lecture de la session {Path.GetFileName(path)} impossible", ex));

            var parsed = _transcriptScan.Accumulator;
            return new Transcript(true, parsed.Title, parsed.Messages.ToArray());
        }
    }

    private static long GetUpdated(string path)
    {
        try
        {
            return new DateTimeOffset(File.GetLastWriteTimeUtc(path), TimeSpan.Zero).ToUnixTimeMilliseconds();
        }
        catch
        {
            return 0;
        }
    }

    /// <summary>Une ligne du fichier de session ; les lignes illisibles sont ignorees.</summary>
    private void ReadLine(string line, bool collectMessages, TranscriptAccumulator result)
    {
        try
        {
            ReadEntry(line, collectMessages, result);
        }
        catch (JsonException)
        {
            // Ligne tronquee (fichier en cours d'ecriture) ou malformee : on l'ignore.
        }
        catch (Exception ex)
        {
            _log.Warn($"Entree de session ignoree : {ex.Message}");
        }
    }

    private static void ReadEntry(string line, bool collectMessages, TranscriptAccumulator result)
    {
        using var doc = JsonDocument.Parse(line);
        var root = doc.RootElement;
        if (root.ValueKind != JsonValueKind.Object)
        {
            return;
        }

        var type = GetString(root, "type");
        switch (type)
        {
            case "ai-title":
                if (GetString(root, "aiTitle") is { Length: > 0 } aiTitle)
                {
                    result.AiTitle = aiTitle;
                }

                return;

            case "custom-title":
                if (GetString(root, "customTitle") is { Length: > 0 } customTitle)
                {
                    result.CustomTitle = customTitle;
                }

                return;

            case "user":
            case "assistant":
                break;

            default:
                return;
        }

        if (root.TryGetProperty("isSidechain", out var sidechain)
            && sidechain.ValueKind == JsonValueKind.True)
        {
            return;
        }

        if (!root.TryGetProperty("message", out var message) || message.ValueKind != JsonValueKind.Object)
        {
            return;
        }

        var isUser = type == "user";
        var ts = ReadTimestamp(root);
        string text;
        bool countable;

        if (isUser)
        {
            text = ExtractUserText(message);
            TrackUserState(root, message, text, ts, result);

            // Vide, ou commande locale : <command-name>, <local-command-stdout>...
            if (text.Length == 0 || text[0] == '<')
            {
                return;
            }

            result.FirstUserLine ??= text;
            countable = true;
        }
        else
        {
            text = ExtractAssistantText(message, out var hasText);
            TrackAssistantState(root, message, text, ts, result);
            if (text.Length == 0)
            {
                return;
            }

            // Une entree qui ne porte qu'un tool_use apparait dans la transcription
            // mais ne compte pas comme un message (contrat : « au moins un bloc text non vide »).
            countable = hasText;
        }

        if (countable)
        {
            result.MessageCount++;
        }

        if (!collectMessages)
        {
            return;
        }

        result.AddMessage(isUser ? "user" : "assistant", text, ts);
    }

    /// <summary>
    /// Etat vu du cote utilisateur : un prompt ou un resultat d'outil (re)lance l'agent, une
    /// interruption (Echap) le laisse inactif. Le resume d'une compaction et les commandes locales
    /// (<c>&lt;command-name&gt;</c>...) ne sont pas des tours.
    /// </summary>
    private static void TrackUserState(JsonElement root, JsonElement message, string text, long ts, TranscriptAccumulator result)
    {
        if (IsTrue(root, "isCompactSummary"))
        {
            return;
        }

        if (HasBlock(message, "tool_result"))
        {
            result.SetState(SessionState.Working, ts, result.Detail);
            return;
        }

        if (text.StartsWith("[Request interrupted", StringComparison.Ordinal))
        {
            result.SetState(SessionState.Idle, ts, "interrompue");
            return;
        }

        if (text.Length > 0 && text[0] != '<')
        {
            result.SetState(SessionState.Working, ts, null);
        }
    }

    /// <summary>
    /// Etat vu du cote agent : chaque ligne d'un meme message porte son <c>stop_reason</c> final,
    /// <c>tool_use</c> tant qu'il enchaine des outils, <c>end_turn</c> quand la reponse est complete.
    /// Une question posee via AskUserQuestion attend l'utilisateur ; une erreur d'API ou un abandon
    /// en cours de flux terminent le tour.
    /// </summary>
    private static void TrackAssistantState(JsonElement root, JsonElement message, string text, long ts, TranscriptAccumulator result)
    {
        if (IsTrue(root, "isApiErrorMessage"))
        {
            result.SetState(SessionState.Error, ts, TranscriptAccumulator.Shorten(text) ?? "erreur d'API");
            return;
        }

        if (IsTrue(root, "isAbortedMidStream"))
        {
            result.SetState(SessionState.Idle, ts, "interrompue");
            return;
        }

        var stop = GetString(message, "stop_reason");
        if (stop is null || stop == "tool_use")
        {
            var tool = LastToolName(message);
            if (tool == "AskUserQuestion")
            {
                result.SetState(SessionState.Waiting, ts, "question posee");
            }
            else
            {
                result.SetState(SessionState.Working, ts, tool ?? result.Detail);
            }

            return;
        }

        // end_turn, stop_sequence, max_tokens : l'agent a rendu la main.
        result.SetState(SessionState.Ready, ts, null);
    }

    private static bool IsTrue(JsonElement element, string property)
        => element.TryGetProperty(property, out var value) && value.ValueKind == JsonValueKind.True;

    private static bool HasBlock(JsonElement message, string blockType)
    {
        if (!message.TryGetProperty("content", out var content) || content.ValueKind != JsonValueKind.Array)
        {
            return false;
        }

        foreach (var block in content.EnumerateArray())
        {
            if (block.ValueKind == JsonValueKind.Object && GetString(block, "type") == blockType)
            {
                return true;
            }
        }

        return false;
    }

    private static string? LastToolName(JsonElement message)
    {
        if (!message.TryGetProperty("content", out var content) || content.ValueKind != JsonValueKind.Array)
        {
            return null;
        }

        string? name = null;
        foreach (var block in content.EnumerateArray())
        {
            if (block.ValueKind == JsonValueKind.Object && GetString(block, "type") == "tool_use")
            {
                name = GetString(block, "name") ?? name;
            }
        }

        return name;
    }

    /// <summary>Texte utile d'une entree <c>user</c> : chaine brute, ou concatenation des blocs <c>text</c>.</summary>
    private static string ExtractUserText(JsonElement message)
    {
        if (!message.TryGetProperty("content", out var content))
        {
            return "";
        }

        if (content.ValueKind == JsonValueKind.String)
        {
            return (content.GetString() ?? "").Trim();
        }

        if (content.ValueKind != JsonValueKind.Array)
        {
            return "";
        }

        var sb = new StringBuilder();
        foreach (var block in content.EnumerateArray())
        {
            if (block.ValueKind != JsonValueKind.Object)
            {
                continue;
            }

            // Les tool_result ne sont pas de la parole de l'utilisateur.
            if (GetString(block, "type") != "text")
            {
                continue;
            }

            Append(sb, GetString(block, "text"));
        }

        return sb.ToString().Trim();
    }

    /// <summary>
    /// Texte d'une entree <c>assistant</c> : concatenation des blocs <c>text</c>, plus une ligne
    /// <c>[outil : &lt;name&gt;]</c> par bloc <c>tool_use</c>. Les blocs <c>thinking</c> sont ignores.
    /// </summary>
    private static string ExtractAssistantText(JsonElement message, out bool hasText)
    {
        hasText = false;
        if (!message.TryGetProperty("content", out var content))
        {
            return "";
        }

        if (content.ValueKind == JsonValueKind.String)
        {
            var raw = (content.GetString() ?? "").Trim();
            hasText = raw.Length > 0;
            return raw;
        }

        if (content.ValueKind != JsonValueKind.Array)
        {
            return "";
        }

        var sb = new StringBuilder();
        foreach (var block in content.EnumerateArray())
        {
            if (block.ValueKind != JsonValueKind.Object)
            {
                continue;
            }

            switch (GetString(block, "type"))
            {
                case "text":
                    var text = GetString(block, "text");
                    if (!string.IsNullOrWhiteSpace(text))
                    {
                        hasText = true;
                        Append(sb, text);
                    }

                    break;

                case "tool_use":
                    var name = GetString(block, "name");
                    Append(sb, "[outil : " + (string.IsNullOrWhiteSpace(name) ? "?" : name) + "]");
                    break;
            }
        }

        return sb.ToString().Trim();
    }

    private static void Append(StringBuilder sb, string? value)
    {
        if (string.IsNullOrEmpty(value))
        {
            return;
        }

        if (sb.Length > 0)
        {
            sb.Append('\n');
        }

        sb.Append(value);
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
