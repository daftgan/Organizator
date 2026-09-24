using System.Globalization;
using System.IO;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Organizator.Services;

/// <summary>
/// Fichier touche par une session. <paramref name="Agent"/> : nom du sous-agent qui l'a ecrit,
/// vide quand c'est la session elle-meme.
/// </summary>
public sealed record AgentArtifact(string Path, string Action, string Tool, string Agent);

/// <summary>
/// Extrait les fichiers produits par les sessions Claude et Copilot, de trois sources :
/// <list type="bullet">
/// <item>les outils d'ecriture du transcript principal (Write, Edit, patch…), sidechains comprises ;</item>
/// <item>les transcripts des sous-agents (<c>&lt;session&gt;\subagents\</c>), ou Claude Code range le
/// travail des equipes : un rapport ecrit par un coequipier est un rapport de la tache, et il
/// n'apparaissait nulle part ;</item>
/// <item>les commandes shell qui ecrivent un fichier sans outil d'ecriture — redirection, <c>tee</c>,
/// <c>cp</c>, <c>Out-File</c>, <c>open(…, 'w')</c>… —, lues avec prudence (voir <see cref="ShellWrites"/>).</item>
/// </list>
/// Les formats de session evoluent : seuls les champs de chemin explicites sont retenus, afin
/// d'eviter de presenter chaque chemin simplement cite dans une reponse comme un fichier produit.
/// Les evenements sont appliques dans l'ordre de leur horodatage, toutes sources confondues : le
/// dernier a toucher un fichier dit son action et son auteur.
/// </summary>
public sealed class AgentArtifacts
{
    private static readonly HashSet<string> PathProperties = new(StringComparer.OrdinalIgnoreCase)
    {
        "file_path",
        "filepath",
        "filePath",
        "target_file",
        "targetFile",
        "filename",
        "fileName",
        "notebook_path",
        "notebookPath",
        "relative_path",
        "relativePath",
        "path",
    };

    private static readonly HashSet<string> CommandProperties = new(StringComparer.OrdinalIgnoreCase)
    {
        "command",
        "cmd",
        "script",
    };

    private static readonly Regex PatchPath = new(
        @"(?:\*\*\*\s+(?<action>Add|Update|Delete)\s+File:\s*|\r?\n\+\+\+\s+(?:[ab]/)?)(?<path>[^\r\n]+)",
        RegexOptions.CultureInvariant | RegexOptions.Multiline);

    private readonly ClaudeSessions _claude;
    private readonly CopilotSessions _copilot;
    private readonly HostLog _log;
    private readonly object _cacheLock = new();
    private readonly Dictionary<string, SessionState> _sessions = new(StringComparer.Ordinal);

    public AgentArtifacts(ClaudeSessions claude, CopilotSessions copilot, HostLog log)
    {
        _claude = claude;
        _copilot = copilot;
        _log = log;
    }

    /// <summary>
    /// Releve d'une session, tenu a jour au fil des ecritures : l'empreinte vue au dernier passage,
    /// son resultat, et pour chaque transcript l'octet atteint et les fichiers trouves jusque-la.
    /// Une equipe cumule des dizaines de mega-octets de transcripts ; les reparser en entier a
    /// chaque ligne ecrite par un coequipier occupait plusieurs coeurs.
    /// </summary>
    private sealed class SessionState
    {
        public string Stamp = "";
        public IReadOnlyList<AgentArtifact> Artifacts = Array.Empty<AgentArtifact>();
        public readonly Dictionary<string, FileState> Files = new(StringComparer.OrdinalIgnoreCase);
    }

    private sealed class FileState
    {
        public readonly JsonlTail Tail = new();
        public readonly List<(long Ts, AgentArtifact Artifact)> Touches = new();
    }

    public IReadOnlyList<AgentArtifact> Get(string provider, string sessionId, string cwd)
        => GetWithStamp(provider, sessionId, cwd).Artifacts;

    /// <summary>
    /// Fichiers touches par la session, avec l'empreinte des transcripts qui les donnent : l'UI la
    /// renvoie, et tant qu'elle n'a pas change la liste ne repart pas (voir <c>getSessions</c>).
    /// </summary>
    public (string Stamp, IReadOnlyList<AgentArtifact> Artifacts) GetWithStamp(string provider, string sessionId, string cwd)
    {
        provider = AgentProvider.Normalize(provider);
        var copilot = provider == AgentProvider.Copilot;
        var source = copilot
            ? _copilot.GetEventsPath(sessionId)
            : _claude.GetSessionFilePath(sessionId, cwd);
        var subagents = copilot ? null : _claude.GetSubagentsDir(sessionId, cwd);
        var key = provider + "|" + sessionId + "|" + cwd;
        var stamp = Stamp(source, subagents);

        SessionState? state;
        lock (_cacheLock)
        {
            if (!_sessions.TryGetValue(key, out state))
            {
                state = new SessionState();
                _sessions[key] = state;
            }
        }

        lock (state)
        {
            if (state.Stamp == stamp)
            {
                return (stamp, state.Artifacts);
            }

            if (stamp.Length == 0)
            {
                state.Files.Clear();
                state.Artifacts = Array.Empty<AgentArtifact>();
            }
            else
            {
                state.Artifacts = Scan(state, source, subagents, cwd);
            }

            state.Stamp = stamp;
            return (stamp, state.Artifacts);
        }
    }

    /// <summary>
    /// Empreinte du transcript principal et de ceux des sous-agents : un coequipier qui ecrit un
    /// rapport ne touche pas au fichier de la session, son dossier doit compter aussi.
    /// </summary>
    private static string Stamp(string source, string? subagents)
    {
        var main = TranscriptAccumulator.FileStamp(source);
        if (main.Length == 0 || subagents is null)
        {
            return main;
        }

        try
        {
            if (!Directory.Exists(subagents))
            {
                return main;
            }

            long count = 0, length = 0, latest = 0;
            foreach (var file in Directory.EnumerateFiles(subagents, "*.jsonl", SearchOption.AllDirectories))
            {
                var info = new FileInfo(file);
                count++;
                length += info.Length;
                latest = Math.Max(latest, info.LastWriteTimeUtc.Ticks);
            }

            return main + "|" + count + ":" + length + ":" + latest;
        }
        catch
        {
            return main;
        }
    }

    private IReadOnlyList<AgentArtifact> Scan(SessionState state, string path, string? subagents, string cwd)
    {
        var files = new List<FileState> { Advance(state, path, "", cwd) };
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { path };

        if (subagents is not null)
        {
            try
            {
                if (Directory.Exists(subagents))
                {
                    foreach (var file in Directory.EnumerateFiles(subagents, "*.jsonl", SearchOption.AllDirectories))
                    {
                        seen.Add(file);
                        files.Add(Advance(state, file, _claude.SubagentName(file), cwd));
                    }
                }
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                _log.Warn($"Lecture des sous-agents de {System.IO.Path.GetFileName(path)} impossible : {ex.Message}");
            }
        }

        // Un transcript disparu emporte son releve.
        foreach (var gone in state.Files.Keys.Where(file => !seen.Contains(file)).ToList())
        {
            state.Files.Remove(gone);
        }

        // Dans l'ordre du temps, toutes sources confondues : le dernier passage sur un fichier l'emporte.
        var byPath = new Dictionary<string, AgentArtifact>(StringComparer.OrdinalIgnoreCase);
        foreach (var touch in files.SelectMany(file => file.Touches).OrderBy(t => t.Ts))
        {
            byPath[touch.Artifact.Path] = touch.Artifact;
        }

        // Les fichiers du dossier de travail (chemins relatifs) avant ceux d'ailleurs.
        return byPath.Values
            .OrderBy(artifact => System.IO.Path.IsPathRooted(artifact.Path) ? 1 : 0)
            .ThenBy(artifact => artifact.Path, StringComparer.OrdinalIgnoreCase)
            .ToArray();
    }

    /// <summary>Lit ce qu'un transcript a gagne depuis le passage precedent ; un fichier reecrit est relu du debut.</summary>
    private FileState Advance(SessionState state, string path, string agent, string cwd)
    {
        if (!state.Files.TryGetValue(path, out var file))
        {
            file = new FileState();
            state.Files[path] = file;
        }

        var collector = new Collector(cwd, agent, file.Touches);
        try
        {
            file.Tail.Read(path, file.Touches.Clear, line =>
            {
                try
                {
                    using var document = JsonDocument.Parse(line);
                    ReadEntry(document.RootElement, collector);
                }
                catch (JsonException)
                {
                    // Ligne malformee : ignoree.
                }
            });
        }
        catch (IOException ex)
        {
            _log.Warn($"Lecture des artefacts de {System.IO.Path.GetFileName(path)} impossible : {ex.Message}");
        }
        catch (UnauthorizedAccessException ex)
        {
            _log.Warn($"Acces aux artefacts de {System.IO.Path.GetFileName(path)} refuse : {ex.Message}");
        }

        return file;
    }

    private static void ReadEntry(JsonElement root, Collector collector)
    {
        if (root.ValueKind != JsonValueKind.Object)
        {
            return;
        }

        collector.Ts = Timestamp(root);

        if (root.TryGetProperty("message", out var message)
            && message.ValueKind == JsonValueKind.Object
            && message.TryGetProperty("content", out var content)
            && content.ValueKind == JsonValueKind.Array)
        {
            foreach (var block in content.EnumerateArray())
            {
                if (block.ValueKind != JsonValueKind.Object
                    || !string.Equals(GetString(block, "type"), "tool_use", StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                var tool = GetString(block, "name") ?? "outil";
                if (block.TryGetProperty("input", out var input))
                {
                    ReadToolPayload(input, tool, collector);
                }
            }
        }

        if (!root.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Object)
        {
            return;
        }

        if (data.TryGetProperty("toolRequests", out var requests) && requests.ValueKind == JsonValueKind.Array)
        {
            foreach (var request in requests.EnumerateArray())
            {
                if (request.ValueKind != JsonValueKind.Object)
                {
                    continue;
                }

                ReadToolPayload(request, GetString(request, "name") ?? "outil", collector);
            }
        }

        var toolName = GetString(data, "toolName");
        if (!string.IsNullOrWhiteSpace(toolName))
        {
            ReadToolPayload(data, toolName!, collector);
        }
    }

    private static long Timestamp(JsonElement root)
    {
        var value = GetString(root, "timestamp");
        return value is not null
            && DateTimeOffset.TryParse(value, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var parsed)
            ? parsed.ToUnixTimeMilliseconds()
            : 0;
    }

    private static void ReadToolPayload(JsonElement payload, string tool, Collector collector)
    {
        if (IsShellTool(tool))
        {
            var command = FindCommand(payload);
            if (command is not null)
            {
                ShellWrites.Read(command, tool, collector);
            }

            return;
        }

        if (!IsMutatingTool(tool))
        {
            return;
        }

        Walk(payload, null, tool, collector);
    }

    private static void Walk(JsonElement element, string? property, string tool, Collector collector)
    {
        switch (element.ValueKind)
        {
            case JsonValueKind.Object:
                foreach (var child in element.EnumerateObject())
                {
                    Walk(child.Value, child.Name, tool, collector);
                }

                break;

            case JsonValueKind.Array:
                foreach (var child in element.EnumerateArray())
                {
                    Walk(child, property, tool, collector);
                }

                break;

            case JsonValueKind.String:
                var value = element.GetString();
                if (string.IsNullOrWhiteSpace(value))
                {
                    return;
                }

                if (property is "input" or "arguments" or "parameters"
                    && (value.TrimStart().StartsWith("{", StringComparison.Ordinal)
                        || value.TrimStart().StartsWith("[", StringComparison.Ordinal)))
                {
                    try
                    {
                        using var embedded = JsonDocument.Parse(value);
                        Walk(embedded.RootElement, property, tool, collector);
                    }
                    catch (JsonException)
                    {
                        // Certains outils gardent leurs arguments sous forme de texte libre.
                    }
                }

                if (property is not null && PathProperties.Contains(property))
                {
                    collector.Add(value, collector.Cwd, ActionFor(tool), tool);
                }

                if (string.Equals(property, "patch", StringComparison.OrdinalIgnoreCase)
                    || tool.Contains("patch", StringComparison.OrdinalIgnoreCase))
                {
                    AddPatchPaths(value, tool, collector);
                }

                break;
        }
    }

    private static void AddPatchPaths(string patch, string tool, Collector collector)
    {
        foreach (Match match in PatchPath.Matches(patch))
        {
            var path = match.Groups["path"].Value.Trim();
            if (path.Length == 0)
            {
                continue;
            }

            var action = match.Groups["action"].Success
                ? match.Groups["action"].Value.ToLowerInvariant() switch
                {
                    "add" => "created",
                    "delete" => "deleted",
                    _ => "modified",
                }
                : "modified";
            collector.Add(path, collector.Cwd, action, tool);
        }
    }

    /// <summary>La commande d'un outil shell : <c>command</c> (ou <c>cmd</c>, <c>script</c>), meme sous des arguments encodes en JSON.</summary>
    private static string? FindCommand(JsonElement payload)
    {
        switch (payload.ValueKind)
        {
            case JsonValueKind.Object:
                foreach (var child in payload.EnumerateObject())
                {
                    if (child.Value.ValueKind == JsonValueKind.String && CommandProperties.Contains(child.Name))
                    {
                        return child.Value.GetString();
                    }
                }

                foreach (var child in payload.EnumerateObject())
                {
                    if (child.Name is "input" or "arguments" or "parameters" or "args")
                    {
                        var found = FindCommand(child.Value);
                        if (found is not null)
                        {
                            return found;
                        }
                    }
                }

                return null;

            case JsonValueKind.String:
                var value = payload.GetString();
                if (value is not null && value.TrimStart().StartsWith("{", StringComparison.Ordinal))
                {
                    try
                    {
                        using var embedded = JsonDocument.Parse(value);
                        return FindCommand(embedded.RootElement);
                    }
                    catch (JsonException)
                    {
                        // Pas du JSON : rien a en tirer.
                    }
                }

                return null;

            default:
                return null;
        }
    }

    // ── Chemins ──────────────────────────────────────────────────────────────

    /// <summary>
    /// Chemin absolu d'un chemin lu dans un transcript, relatif a <paramref name="baseDir"/> s'il ne
    /// l'est pas ; <c>null</c> s'il n'est pas un chemin de fichier. Les formes Git Bash
    /// (<c>/d/dossier</c>) et <c>~/</c> sont ramenees a Windows.
    /// </summary>
    private static string? Absolute(string rawPath, string baseDir)
    {
        var value = rawPath.Trim().Trim('`', '"', '\'').Trim();
        value = value.TrimEnd('.', ',', ';', ':', ')', ']', '}');
        if (value.Length == 0 || value.Length > 512 || value.Contains('\r') || value.Contains('\n'))
        {
            return null;
        }

        if (value.StartsWith("file://", StringComparison.OrdinalIgnoreCase)
            || value.StartsWith("-", StringComparison.Ordinal)
            || value is "." or "..")
        {
            return null;
        }

        if (value.StartsWith("~/", StringComparison.Ordinal) || value.StartsWith("~\\", StringComparison.Ordinal))
        {
            value = System.IO.Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                value[2..]);
        }
        else if (value.Length >= 2 && value[0] == '/' && char.IsAsciiLetter(value[1]) && (value.Length == 2 || value[2] == '/'))
        {
            // Git Bash : /d/01-dm-umisoft → D:\01-dm-umisoft
            value = char.ToUpperInvariant(value[1]) + ":\\" + (value.Length > 3 ? value[3..] : "");
        }

        try
        {
            return System.IO.Path.GetFullPath(System.IO.Path.IsPathRooted(value) ? value : System.IO.Path.Combine(baseDir, value));
        }
        catch
        {
            return null;
        }
    }

    /// <summary>Relatif au dossier de travail quand le fichier est dessous, sinon tel quel.</summary>
    private static string? Relativize(string full, string cwd)
    {
        try
        {
            var basePath = System.IO.Path.GetFullPath(cwd).TrimEnd(System.IO.Path.DirectorySeparatorChar, System.IO.Path.AltDirectorySeparatorChar);
            var comparison = OperatingSystem.IsWindows()
                ? StringComparison.OrdinalIgnoreCase
                : StringComparison.Ordinal;
            if (full.Equals(basePath, comparison))
            {
                return null;
            }

            var relative = System.IO.Path.GetRelativePath(basePath, full);
            if (!relative.StartsWith(".." + System.IO.Path.DirectorySeparatorChar, comparison)
                && !string.Equals(relative, "..", comparison)
                && !System.IO.Path.IsPathRooted(relative))
            {
                return relative.Replace(System.IO.Path.DirectorySeparatorChar, '/');
            }
        }
        catch
        {
            // Un dossier de travail invalide ne doit pas empecher les autres artefacts d'apparaitre.
        }

        return full;
    }

    private static string ActionFor(string tool)
    {
        var name = tool.ToLowerInvariant();
        if (name.Contains("delete") || name.Contains("remove"))
        {
            return "deleted";
        }

        if (name.Contains("write") || name.Contains("create") || name.Contains("add"))
        {
            return "written";
        }

        return "modified";
    }

    private static bool IsMutatingTool(string tool)
    {
        var name = tool.ToLowerInvariant();
        return name.Contains("write")
            || name.Contains("create")
            || name.Contains("edit")
            || name.Contains("patch")
            || name.Contains("delete")
            || name.Contains("remove")
            || name.Contains("move")
            || name.Contains("rename")
            || name.Contains("replace")
            || name.Contains("save")
            || name.Contains("generate")
            || name.Contains("add");
    }

    private static bool IsShellTool(string tool)
    {
        var name = tool.ToLowerInvariant();
        return name is "bash" or "powershell" or "shell" or "terminal" or "cmd" or "exec"
            || name.Contains("shell")
            || name.Contains("terminal")
            || name.EndsWith("bash", StringComparison.Ordinal);
    }

    private static string? GetString(JsonElement element, string property)
        => element.TryGetProperty(property, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    /// <summary>Ce qu'un transcript ajoute : son dossier de travail, l'agent qui le tient, l'instant de l'entree en cours.</summary>
    private sealed class Collector
    {
        private readonly List<(long Ts, AgentArtifact Artifact)> _touches;

        public Collector(string cwd, string agent, List<(long Ts, AgentArtifact Artifact)> touches)
        {
            Cwd = cwd;
            Agent = agent;
            _touches = touches;
        }

        public string Cwd { get; }

        public string Agent { get; }

        public long Ts { get; set; }

        /// <summary>Retient un fichier ; <paramref name="baseDir"/> resout un chemin relatif (le dossier courant apres un <c>cd</c>).</summary>
        public void Add(string rawPath, string baseDir, string action, string tool)
        {
            var full = Absolute(rawPath, baseDir);
            var path = full is null ? null : Relativize(full, Cwd);
            if (path is null)
            {
                return;
            }

            _touches.Add((Ts, new AgentArtifact(path, action, tool, Agent)));
        }
    }

    /// <summary>
    /// Fichiers qu'une commande shell ecrit. Heuristique volontairement etroite : redirections
    /// (<c>&gt;</c>, <c>&gt;&gt;</c>), <c>tee</c>, copies et deplacements (<c>cp</c>, <c>mv</c>,
    /// <c>Copy-Item</c>…), cmdlets d'ecriture (<c>Out-File</c>, <c>Set-Content</c>, <c>Add-Content</c>,
    /// <c>New-Item</c>, <c>Export-Csv</c>) et ecritures des scripts en ligne (<c>open(…, 'w')</c>,
    /// <c>writeFileSync</c>, <c>File.WriteAllText</c>, <c>write_text</c>). Un chemin n'est retenu que
    /// litteral, avec une extension, sans joker ni variable ; les corps de here-documents sont sautes
    /// pour les redirections ; un <c>cd</c> deplace la base des chemins relatifs qui le suivent.
    /// </summary>
    private static class ShellWrites
    {
        private static readonly char[] Forbidden = { '*', '?', '$', '%', '{', '}', '`', '<', '>', '|', '\r', '\n' };

        private static readonly Regex Redirect = new(
            @"(?<![0-9&<>=\-])>{1,2}(?![&>])\s*(?:""(?<q>[^""\r\n]+)""|'(?<q>[^'\r\n]+)'|(?<q>[^\s;&|<>()`]+))",
            RegexOptions.CultureInvariant | RegexOptions.Compiled);

        private static readonly Regex HereDoc = new(
            @"<<-?\s*['""]?(?<tag>[A-Za-z_][A-Za-z0-9_]*)['""]?",
            RegexOptions.CultureInvariant | RegexOptions.Compiled);

        private static readonly Regex Splitter = new(
            @"\s*(?:&&|\|\||;|\|)\s*",
            RegexOptions.CultureInvariant | RegexOptions.Compiled);

        private static readonly Regex ScriptWrite = new(
            @"\bopen\(\s*r?(?<q>['""])(?<path>[^'""\r\n]+)\k<q>\s*,\s*['""][wa][^'""]*['""]"
            + @"|\bwriteFile(?:Sync)?\(\s*(?<q>['""])(?<path>[^'""\r\n]+)\k<q>"
            + @"|\[(?:System\.)?IO\.File\]::(?:WriteAll\w+|AppendAll\w+)\(\s*@?(?<q>['""])(?<path>[^'""\r\n]+)\k<q>"
            + @"|\bFile\.(?:WriteAll\w+|AppendAll\w+)\(\s*@?(?<q>['""])(?<path>[^'""\r\n]+)\k<q>"
            + @"|Path\(\s*r?(?<q>['""])(?<path>[^'""\r\n]+)\k<q>\s*\)\s*\.write_(?:text|bytes)\(",
            RegexOptions.CultureInvariant | RegexOptions.Compiled);

        public static void Read(string command, string tool, Collector collector)
        {
            var baseDir = collector.Cwd;
            string? hereTag = null;
            var hereString = false;

            foreach (var raw in command.Replace("\r\n", "\n").Split('\n'))
            {
                var line = raw.TrimEnd();

                // Corps d'un here-document (<<'EOF' … EOF) ou d'un here-string PowerShell (@' … '@).
                if (hereTag is not null)
                {
                    if (line.Trim() == hereTag)
                    {
                        hereTag = null;
                    }

                    continue;
                }

                if (hereString)
                {
                    if (line.StartsWith("'@", StringComparison.Ordinal) || line.StartsWith("\"@", StringComparison.Ordinal))
                    {
                        hereString = false;
                    }

                    continue;
                }

                var here = HereDoc.Match(line);
                if (here.Success)
                {
                    hereTag = here.Groups["tag"].Value;
                }
                else if (line.EndsWith("@'", StringComparison.Ordinal) || line.EndsWith("@\"", StringComparison.Ordinal))
                {
                    hereString = true;
                }

                foreach (var segment in Splitter.Split(line))
                {
                    if (segment.Trim().Length == 0)
                    {
                        continue;
                    }

                    baseDir = ReadSegment(segment.Trim(), baseDir, tool, collector);
                }
            }

            foreach (Match match in ScriptWrite.Matches(command))
            {
                Keep(match.Groups["path"].Value, baseDir, "written", tool, collector);
            }
        }

        /// <summary>Un segment de commande ; rend le dossier courant, deplace par un <c>cd</c>.</summary>
        private static string ReadSegment(string segment, string baseDir, string tool, Collector collector)
        {
            var tokens = Tokenize(segment);
            if (tokens.Count == 0)
            {
                return baseDir;
            }

            var word = tokens[0].TrimStart('&').Trim();
            var positional = tokens.Skip(1).Where(t => !t.StartsWith("-", StringComparison.Ordinal)).ToList();

            switch (word.ToLowerInvariant())
            {
                case "cd":
                case "chdir":
                case "pushd":
                case "sl":
                case "set-location":
                    if (positional.Count > 0)
                    {
                        var moved = Absolute(positional[^1], baseDir);
                        if (moved is not null)
                        {
                            return moved;
                        }
                    }

                    return baseDir;

                case "tee":
                case "tee-object":
                    foreach (var file in positional)
                    {
                        Keep(file, baseDir, tokens.Any(t => t is "-a" or "--append" or "-Append") ? "modified" : "written", tool, collector);
                    }

                    return baseDir;

                case "cp":
                case "copy":
                case "copy-item":
                case "cpi":
                case "mv":
                case "move":
                case "move-item":
                case "mi":
                case "rename-item":
                case "ren":
                    var destination = Named(tokens, "-Destination") ?? Named(tokens, "-NewName") ?? (positional.Count >= 2 ? positional[^1] : null);
                    if (destination is not null)
                    {
                        Keep(destination, baseDir, "written", tool, collector);
                    }

                    return baseDir;

                case "out-file":
                case "set-content":
                case "sc":
                case "add-content":
                case "ac":
                case "new-item":
                case "ni":
                case "export-csv":
                case "export-clixml":
                    if (IsDirectoryItem(tokens))
                    {
                        return baseDir;
                    }

                    var target = Named(tokens, "-Path") ?? Named(tokens, "-FilePath") ?? Named(tokens, "-LiteralPath")
                        ?? Named(tokens, "-PSPath") ?? (positional.Count > 0 ? positional[0] : null);
                    if (target is not null)
                    {
                        var appends = word.Equals("add-content", StringComparison.OrdinalIgnoreCase)
                            || word.Equals("ac", StringComparison.OrdinalIgnoreCase)
                            || tokens.Any(t => t.Equals("-Append", StringComparison.OrdinalIgnoreCase));
                        Keep(target, baseDir, appends ? "modified" : "written", tool, collector);
                    }

                    return baseDir;
            }

            foreach (Match match in Redirect.Matches(segment))
            {
                Keep(match.Groups["q"].Value, baseDir, match.Value.TrimStart().StartsWith(">>", StringComparison.Ordinal) ? "modified" : "written", tool, collector);
            }

            return baseDir;
        }

        private static void Keep(string candidate, string baseDir, string action, string tool, Collector collector)
        {
            if (Plausible(candidate))
            {
                collector.Add(candidate, baseDir, action, tool);
            }
        }

        /// <summary>Un chemin de fichier litteral : ni joker, ni variable, ni flux, et une extension.</summary>
        private static bool Plausible(string value)
        {
            value = value.Trim().Trim('"', '\'');
            if (value.Length < 3 || value.Length > 512 || value.IndexOfAny(Forbidden) >= 0)
            {
                return false;
            }

            if (value.StartsWith("-", StringComparison.Ordinal)
                || value.StartsWith("/dev/", StringComparison.Ordinal)
                || value.Equals("nul", StringComparison.OrdinalIgnoreCase)
                || value.StartsWith("&", StringComparison.Ordinal))
            {
                return false;
            }

            var name = value.TrimEnd('/', '\\');
            var slash = Math.Max(name.LastIndexOf('/'), name.LastIndexOf('\\'));
            var file = slash >= 0 ? name[(slash + 1)..] : name;
            var dot = file.LastIndexOf('.');
            if (dot <= 0 || dot == file.Length - 1 || file.Length - dot - 1 > 8)
            {
                return false;
            }

            return file[(dot + 1)..].All(char.IsLetterOrDigit);
        }

        private static string? Named(List<string> tokens, string flag)
        {
            for (var i = 1; i + 1 < tokens.Count; i++)
            {
                if (tokens[i].Equals(flag, StringComparison.OrdinalIgnoreCase))
                {
                    return tokens[i + 1];
                }
            }

            return null;
        }

        private static bool IsDirectoryItem(List<string> tokens)
        {
            for (var i = 1; i + 1 < tokens.Count; i++)
            {
                if ((tokens[i].Equals("-ItemType", StringComparison.OrdinalIgnoreCase) || tokens[i].Equals("-Type", StringComparison.OrdinalIgnoreCase))
                    && tokens[i + 1].StartsWith("Dir", StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }
            }

            return false;
        }

        /// <summary>Mots d'un segment, guillemets simples et doubles respectes puis retires.</summary>
        private static List<string> Tokenize(string segment)
        {
            var tokens = new List<string>();
            var current = new System.Text.StringBuilder();
            var quote = '\0';
            var any = false;

            foreach (var ch in segment)
            {
                if (quote != '\0')
                {
                    if (ch == quote)
                    {
                        quote = '\0';
                    }
                    else
                    {
                        current.Append(ch);
                    }

                    continue;
                }

                if (ch is '"' or '\'')
                {
                    quote = ch;
                    any = true;
                    continue;
                }

                if (char.IsWhiteSpace(ch))
                {
                    if (any || current.Length > 0)
                    {
                        tokens.Add(current.ToString());
                        current.Clear();
                        any = false;
                    }

                    continue;
                }

                current.Append(ch);
            }

            if (any || current.Length > 0)
            {
                tokens.Add(current.ToString());
            }

            return tokens;
        }
    }
}
