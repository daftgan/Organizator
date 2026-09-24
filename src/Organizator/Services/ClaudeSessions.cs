using System.Globalization;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

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

    // Nom de chaque transcript de sous-agent, lu une fois dans son .meta.json.
    private readonly Dictionary<string, string> _subagentNames = new(StringComparer.OrdinalIgnoreCase);
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
                parsed.State, parsed.StateTs, parsed.Detail, parsed.Agents.ToArray(), parsed.Said);
        }
    }

    /// <summary>Empreinte du fichier de session, pour ne le relire que s'il a change.</summary>
    public string GetStamp(string sessionId, string cwd)
        => TranscriptAccumulator.FileStamp(GetSessionFilePath(sessionId, cwd));

    /// <summary>Dossier des transcripts des sous-agents d'une session (peut ne pas exister).</summary>
    public string GetSubagentsDir(string sessionId, string cwd)
        => Path.Combine(ProjectsRoot, EncodeCwd(cwd ?? ""), sessionId ?? "", "subagents");

    /// <summary>
    /// Derniere reponse complete de l'agent, pour le resume transmis a une nouvelle conversation.
    /// Lecture a part, d'un seul tenant : elle ne touche pas au journal affiche dans le panneau.
    /// <c>null</c> si la session n'existe pas ou n'a pas encore de reponse.
    /// </summary>
    public string? GetLastAnswer(string sessionId, string cwd)
    {
        var path = GetSessionFilePath(sessionId, cwd);
        if (!File.Exists(path))
        {
            return null;
        }

        var scan = new SessionScan();
        scan.Read(path, (line, acc) => ReadLine(line, collectMessages: true, acc), ex =>
            _log.Error($"Lecture de la session {Path.GetFileName(path)} impossible", ex));
        return TranscriptAccumulator.LastAnswer(scan.Accumulator.Messages);
    }

    /// <summary>
    /// Sous-agents de la session qui ont ecrit dans leur propre transcript depuis <paramref name="since"/>.
    /// Claude Code range ces transcripts dans <c>&lt;session&gt;\subagents\</c> : un agent au travail y
    /// ajoute une ligne a chaque outil et a chaque reponse, un agent revenu n'y touche plus. C'est ce
    /// qui distingue une equipe encore en route d'une equipe dont le retour n'a laisse aucune trace.
    /// <c>null</c> quand le dossier n'existe pas : la session n'a rien a en dire.
    /// </summary>
    public IReadOnlyList<SubagentActivity>? ScanSubagents(string sessionId, string cwd, long since)
    {
        var dir = Path.Combine(ProjectsRoot, EncodeCwd(cwd ?? ""), sessionId ?? "", "subagents");
        if (!Directory.Exists(dir))
        {
            return null;
        }

        var active = new List<SubagentActivity>();
        try
        {
            foreach (var path in Directory.EnumerateFiles(dir, "*.jsonl", SearchOption.AllDirectories))
            {
                var written = GetUpdated(path);
                if (written >= since)
                {
                    active.Add(new SubagentActivity(SubagentName(path), written));
                }
            }
        }
        catch (Exception ex)
        {
            _log.Error($"Lecture des sous-agents de {sessionId} impossible", ex);
            return null;
        }

        return active;
    }

    /// <summary>
    /// Nom de l'agent, tel que son <c>.meta.json</c> le donne ; vide pour un transcript sans
    /// metadonnees. Ce nom ne change jamais : il est retenu, le balayage revenant toutes les
    /// secondes et demie tant qu'une equipe travaille.
    /// </summary>
    internal string SubagentName(string transcriptPath)
    {
        lock (_subagentNames)
        {
            if (_subagentNames.TryGetValue(transcriptPath, out var known))
            {
                return known;
            }
        }

        var name = "";
        var meta = Path.ChangeExtension(transcriptPath, null) + ".meta.json";
        if (File.Exists(meta))
        {
            try
            {
                using var document = JsonDocument.Parse(File.ReadAllText(meta));
                name = GetString(document.RootElement, "name") ?? "";
            }
            catch
            {
                name = "";
            }
        }

        lock (_subagentNames)
        {
            _subagentNames[transcriptPath] = name;
        }

        return name;
    }

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
            TrackAgents(message, true, text, ts, result);

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
            // Avant l'etat : une question posee remplace ensuite cette parole-la (TrackAssistantState).
            if (hasText)
            {
                result.NoteSaid(text);
            }

            TrackAssistantState(root, message, text, ts, result);
            TrackAgents(message, false, text, ts, result);
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
                result.NoteSaid(LastQuestion(message));
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

    // ── Agents lances par la session ────────────────────────────────────────
    // Un agent part par l'outil `Agent` (ou `Task`, `Workflow`), et son resultat revient aussitot :
    // « Spawned successfully … name: <nom> » pour un coequipier, « launched in background. Task ID:
    // <id> » pour une tache de fond. L'agent, lui, travaille encore. La session principale peut donc
    // terminer son tour (`end_turn`) avec toute son equipe au travail : sans ce suivi, l'interface
    // annoncerait « reponse prete » alors que rien n'est fini. Le retour se lit plus loin dans le
    // meme fichier : `<task-notification>` pour une tache, `idle_notification` pour un coequipier.
    private const int LabelLength = 60;
    private static readonly Regex SpawnedName = new(@"^\s*name:[ \t]*(\S.*?)\s*$", RegexOptions.Multiline | RegexOptions.Compiled);
    private static readonly Regex BackgroundTaskId = new(@"Task ID:[ \t]*(\S+)", RegexOptions.Compiled);
    private static readonly Regex BackgroundSummary = new(@"^\s*Summary:[ \t]*(\S.*?)\s*$", RegexOptions.Multiline | RegexOptions.Compiled);
    private static readonly Regex TaskNotificationId = new(@"<task-id>\s*([^<\s]+)\s*</task-id>", RegexOptions.Compiled);
    private static readonly Regex TeammateId = new(@"teammate_id=""([^""]+)""", RegexOptions.Compiled);
    private static readonly Regex NotificationFrom = new(@"""from""\s*:\s*""([^""]+)""", RegexOptions.Compiled);

    private static void TrackAgents(JsonElement message, bool isUser, string text, long ts, TranscriptAccumulator result)
    {
        if (message.TryGetProperty("content", out var content) && content.ValueKind == JsonValueKind.Array)
        {
            foreach (var block in content.EnumerateArray())
            {
                if (block.ValueKind != JsonValueKind.Object)
                {
                    continue;
                }

                switch (GetString(block, "type"))
                {
                    case "tool_use":
                        TrackAgentStart(block, ts, result);
                        break;

                    case "tool_result":
                        TrackAgentSpawn(block, result);
                        break;
                }
            }
        }

        if (isUser)
        {
            TrackAgentReturn(text, result);
        }
    }

    /// <summary>Depart d'un agent, ou message envoye a un coequipier deja revenu (qui s'y remet).</summary>
    private static void TrackAgentStart(JsonElement block, long ts, TranscriptAccumulator result)
    {
        var tool = GetString(block, "name") ?? "";
        var hasInput = block.TryGetProperty("input", out var input) && input.ValueKind == JsonValueKind.Object;

        if (tool is "Agent" or "Task" or "Workflow")
        {
            var id = GetString(block, "id") ?? "";
            if (id.Length > 0)
            {
                result.AgentStarted("tool:" + id, AgentLabel(hasInput ? input : default, tool), ts);
            }

            return;
        }

        if (tool == "SendMessage" && hasInput)
        {
            var to = GetString(input, "to") ?? "";
            if (result.KnowsAgent(to))
            {
                result.AgentStarted("agent:" + to, to, ts);
            }
        }
    }

    /// <summary>
    /// Resultat de l'outil qui a lance l'agent : il donne son identite durable s'il part en fond,
    /// et vaut retour s'il a travaille sur place (le rapport est deja la).
    /// </summary>
    private static void TrackAgentSpawn(JsonElement block, TranscriptAccumulator result)
    {
        var id = GetString(block, "tool_use_id") ?? "";
        if (id.Length == 0)
        {
            return;
        }

        var key = "tool:" + id;
        var body = ResultText(block);

        if (body.Contains("Spawned successfully", StringComparison.Ordinal))
        {
            var name = SpawnedName.Match(body);
            if (name.Success)
            {
                result.AgentIdentified(key, "agent:" + name.Groups[1].Value, name.Groups[1].Value);
                return;
            }
        }

        var task = BackgroundTaskId.Match(body);
        if (task.Success)
        {
            var summary = BackgroundSummary.Match(body);
            result.AgentIdentified(key, "task:" + task.Groups[1].Value, summary.Success ? Shorten(summary.Groups[1].Value) : "");
            return;
        }

        result.AgentFinished(key);
    }

    /// <summary>Retour d'un agent : notification de tache terminee, ou coequipier redevenu disponible.</summary>
    private static void TrackAgentReturn(string text, TranscriptAccumulator result)
    {
        if (text.Contains("<task-notification", StringComparison.Ordinal))
        {
            foreach (Match match in TaskNotificationId.Matches(text))
            {
                result.AgentFinished("task:" + match.Groups[1].Value);
            }

            return;
        }

        if (!text.Contains("idle_notification", StringComparison.Ordinal))
        {
            return;
        }

        var teammate = TeammateId.Match(text);
        var from = NotificationFrom.Match(text);
        if (teammate.Success)
        {
            result.AgentFinished("agent:" + teammate.Groups[1].Value);
        }
        else if (from.Success)
        {
            result.AgentFinished("agent:" + from.Groups[1].Value);
        }
    }

    /// <summary>Nom donne a l'agent, sinon ce qu'on lui a demande, sinon le nom de l'outil.</summary>
    private static string AgentLabel(JsonElement input, string tool)
    {
        if (input.ValueKind == JsonValueKind.Object)
        {
            foreach (var property in new[] { "name", "description", "subagent_type" })
            {
                var value = GetString(input, property);
                if (!string.IsNullOrWhiteSpace(value))
                {
                    return Shorten(value);
                }
            }
        }

        return tool;
    }

    /// <summary>Texte d'un bloc <c>tool_result</c> : chaine brute, ou concatenation de ses blocs <c>text</c>.</summary>
    private static string ResultText(JsonElement block)
    {
        if (!block.TryGetProperty("content", out var content))
        {
            return "";
        }

        if (content.ValueKind == JsonValueKind.String)
        {
            return content.GetString() ?? "";
        }

        if (content.ValueKind != JsonValueKind.Array)
        {
            return "";
        }

        var sb = new StringBuilder();
        foreach (var item in content.EnumerateArray())
        {
            if (item.ValueKind == JsonValueKind.Object && GetString(item, "type") == "text")
            {
                Append(sb, GetString(item, "text"));
            }
        }

        return sb.ToString();
    }

    private static string Shorten(string value)
    {
        var line = TranscriptAccumulator.FirstLine(value);
        return line.Length <= LabelLength ? line : line[..LabelLength] + "…";
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

    /// <summary>
    /// Ce que demande le dernier <c>AskUserQuestion</c> du message : ses questions, separees par un
    /// point median. C'est cela que l'interface montre sous « Attend votre reponse », plutot que la
    /// phrase qui precedait. <c>null</c> si l'outil ne porte aucune question lisible.
    /// </summary>
    private static string? LastQuestion(JsonElement message)
    {
        if (!message.TryGetProperty("content", out var content) || content.ValueKind != JsonValueKind.Array)
        {
            return null;
        }

        string? asked = null;
        foreach (var block in content.EnumerateArray())
        {
            if (block.ValueKind != JsonValueKind.Object
                || GetString(block, "type") != "tool_use"
                || GetString(block, "name") != "AskUserQuestion"
                || !block.TryGetProperty("input", out var input)
                || input.ValueKind != JsonValueKind.Object
                || !input.TryGetProperty("questions", out var questions)
                || questions.ValueKind != JsonValueKind.Array)
            {
                continue;
            }

            var sb = new StringBuilder();
            foreach (var item in questions.EnumerateArray())
            {
                if (item.ValueKind != JsonValueKind.Object)
                {
                    continue;
                }

                var question = GetString(item, "question");
                if (string.IsNullOrWhiteSpace(question))
                {
                    continue;
                }

                if (sb.Length > 0)
                {
                    sb.Append(" · ");
                }

                sb.Append(question!.Trim());
            }

            if (sb.Length > 0)
            {
                asked = sb.ToString();
            }
        }

        return asked;
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
