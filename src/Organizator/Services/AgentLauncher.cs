using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;

namespace Organizator.Services;

public sealed record StartedSession(string SessionId, string Cwd, long Created);

/// <summary>Executable et arguments fixes d'une CLI, par exemple <c>gh.exe copilot --</c>.</summary>
public sealed record CommandLine(string FileName, IReadOnlyList<string> Arguments);

/// <summary>
/// Generation du script <c>.ps1</c> de lancement et demarrage de l'agent choisi (Claude Code ou
/// GitHub Copilot CLI) dans une nouvelle console (PowerShell, ou Windows Terminal si
/// <c>settings.terminal == "wt"</c>).
/// </summary>
public sealed class AgentLauncher
{
    private const string PowerShellArgs = "-NoExit -NoLogo -ExecutionPolicy Bypass -File";

    // Windows PowerShell 5.1 ne protege pas les guillemets doubles quand il transmet un argument
    // a un executable natif : « a "b" c » arriverait decoupe en trois mots, sans guillemets.
    // Le script applique donc lui-meme les regles de CommandLineToArgvW au contexte : doubler les
    // antislashs qui precedent un guillemet, echapper le guillemet, et doubler les antislashs
    // finaux d'un argument que PowerShell entourera de guillemets (il le fait des qu'il y a un blanc).
    private const string ProtectQuotesLine = @"$ctx = [regex]::Replace($ctx, '(\\*)""', '$1$1\""')";
    private const string ProtectTrailingLine = @"if ($ctx -match '\s') { $ctx = [regex]::Replace($ctx, '(\\+)$', '$1$1') }";

    private static readonly Regex QuoteRun = new(@"(\\*)""", RegexOptions.CultureInvariant);
    private static readonly Regex TrailingBackslashes = new(@"(\\+)$", RegexOptions.CultureInvariant);
    private static readonly Regex AnyWhitespace = new(@"\s", RegexOptions.CultureInvariant);

    private readonly DataStore _store;
    private readonly HostLog _log;
    private readonly Lazy<string?> _claudeInvocation;
    private readonly Lazy<CommandLine?> _copilotCommand;
    private readonly Lazy<string?> _wtPath;

    public AgentLauncher(DataStore store, HostLog log)
    {
        _store = store;
        _log = log;
        _claudeInvocation = new Lazy<string?>(FindClaudeInvocation);
        _copilotCommand = new Lazy<CommandLine?>(FindCopilotCommand);
        _wtPath = new Lazy<string?>(FindWindowsTerminal);
    }

    public bool HasClaude => _claudeInvocation.Value is not null;

    public bool HasCopilot => _copilotCommand.Value is not null;

    public bool HasWt => _wtPath.Value is not null;

    /// <summary>Ligne de commande de la CLI Copilot, pour la lancer directement (sonde ACP) ; <c>null</c> si introuvable.</summary>
    public CommandLine? CopilotCommand => _copilotCommand.Value;

    public bool Has(string provider)
        => AgentProvider.Normalize(provider) == AgentProvider.Copilot ? HasCopilot : HasClaude;

    /// <summary>
    /// Appel a ecrire dans le script pour l'agent demande : <c>&amp; claude</c> quand l'executable
    /// est joignable par le PATH, sinon son chemin complet entre apostrophes. Erreur lisible s'il
    /// est introuvable.
    /// </summary>
    public string Invocation(string provider)
    {
        provider = AgentProvider.Normalize(provider);
        if (provider == AgentProvider.Copilot)
        {
            var command = _copilotCommand.Value
                ?? throw new InvalidOperationException("copilot (CLI GitHub Copilot) est introuvable sur ce poste.");

            var sb = new StringBuilder("& ").Append(Quote(command.FileName));
            foreach (var argument in command.Arguments)
            {
                sb.Append(' ').Append(argument);
            }

            return sb.ToString();
        }

        return _claudeInvocation.Value ?? throw new InvalidOperationException("claude est introuvable dans le PATH.");
    }

    // ------------------------------------------------------------------ lancement

    /// <param name="prompt">Premier message envoye a l'agent des l'ouverture ; vide pour le laisser attendre.</param>
    public StartedSession StartSession(string provider, string cwd, string title, string context, string prompt, string model, string effort, string terminal)
    {
        provider = AgentProvider.Normalize(provider);
        var directory = RequireDirectory(cwd);
        var sessionId = Guid.NewGuid().ToString("D");
        var script = WriteScript(provider, sessionId, directory, title, context, prompt, model, effort, resume: false);
        Launch(script, directory, terminal);
        _log.Info($"Session {provider} demarree : {sessionId} dans {directory}{Describe(model, effort, prompt)}");
        return new StartedSession(sessionId, directory, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
    }

    public void ResumeSession(string provider, string sessionId, string cwd, string title, string context, string prompt, string model, string effort, string terminal)
    {
        if (!Guid.TryParse(sessionId, out var parsed))
        {
            throw new InvalidOperationException("Identifiant de session invalide.");
        }

        provider = AgentProvider.Normalize(provider);
        var normalized = parsed.ToString("D");
        var directory = RequireDirectory(cwd);
        var script = WriteScript(provider, normalized, directory, title, context, prompt, model, effort, resume: true);
        Launch(script, directory, terminal);
        _log.Info($"Session {provider} reprise : {normalized} dans {directory}{Describe(model, effort, prompt)}");
    }

    private static string Describe(string? model, string? effort, string? prompt)
    {
        var parts = new List<string>(3);
        if (!string.IsNullOrWhiteSpace(model)) parts.Add("modele " + model.Trim());
        if (!string.IsNullOrWhiteSpace(effort)) parts.Add("effort " + effort.Trim());
        if (!string.IsNullOrWhiteSpace(prompt)) parts.Add("message initial");
        return parts.Count == 0 ? "" : " (" + string.Join(", ", parts) + ")";
    }

    private static string RequireDirectory(string? cwd)
    {
        if (string.IsNullOrWhiteSpace(cwd))
        {
            throw new InvalidOperationException("Le dossier de travail n'existe pas.");
        }

        string full;
        try
        {
            full = Path.GetFullPath(cwd.Trim());
        }
        catch
        {
            throw new InvalidOperationException("Le dossier de travail n'existe pas.");
        }

        if (!Directory.Exists(full))
        {
            throw new InvalidOperationException("Le dossier de travail n'existe pas : " + full);
        }

        return full;
    }

    // -------------------------------------------------------------------- script

    /// <summary>
    /// Construit le contenu du script de lancement. Isole de tout etat pour rester verifiable.
    /// </summary>
    /// <param name="provider"><see cref="AgentProvider.Claude"/> ou <see cref="AgentProvider.Copilot"/>.</param>
    /// <param name="invocation">Ligne d'appel de l'outil, par exemple <c>&amp; claude</c>.</param>
    /// <param name="model">Alias ou identifiant de modele ; vide pour laisser l'outil choisir.</param>
    /// <param name="effort">Niveau d'effort ; vide pour laisser l'outil appliquer son reglage.</param>
    /// <param name="prompt">Premier message de l'utilisateur, envoye des l'ouverture ; vide pour laisser l'agent attendre.</param>
    public static string BuildScript(
        string provider,
        string invocation,
        string sessionId,
        string cwd,
        string? title,
        string? context,
        string? prompt,
        string? model,
        string? effort,
        bool resume)
    {
        provider = AgentProvider.Normalize(provider);
        var safeModel = AgentProvider.RequireModel(model);
        var safeEffort = AgentProvider.RequireEffort(provider, effort);
        var hasPrompt = !string.IsNullOrWhiteSpace(prompt);

        // Copilot n'a pas de prompt systeme : contexte et premier message ne font qu'un message
        // initial (-i). A la reprise, le contexte est deja dans l'historique ; seul le message part.
        // Claude recoit le contexte en prompt systeme ($ctx) et le message en argument positionnel ($msg).
        var ctx = provider == AgentProvider.Copilot
            ? (resume ? (hasPrompt ? prompt! : "") : JoinBlocks(context, prompt))
            : context ?? "";
        var hasCtx = !string.IsNullOrWhiteSpace(ctx);
        var hasMsg = provider != AgentProvider.Copilot && hasPrompt;

        var safeTitle = FirstLine(title ?? "").Trim();
        if (safeTitle.Length == 0)
        {
            safeTitle = "Session";
        }

        var sb = new StringBuilder();
        sb.Append("$Host.UI.RawUI.WindowTitle = ").Append(Quote("Organizator — " + safeTitle)).Append("\r\n");
        sb.Append("Set-Location -LiteralPath ").Append(Quote(cwd)).Append("\r\n");
        sb.Append("$ctx = @'\r\n");
        sb.Append(ProtectHereString(ctx)).Append("\r\n");
        sb.Append("'@\r\n");
        sb.Append(ProtectQuotesLine).Append("\r\n");
        sb.Append(ProtectTrailingLine).Append("\r\n");

        if (hasMsg)
        {
            sb.Append("$msg = @'\r\n");
            sb.Append(ProtectHereString(prompt!)).Append("\r\n");
            sb.Append("'@\r\n");
            sb.Append(ProtectQuotesLine.Replace("$ctx", "$msg")).Append("\r\n");
            sb.Append(ProtectTrailingLine.Replace("$ctx", "$msg")).Append("\r\n");
        }

        sb.Append(invocation);

        if (provider == AgentProvider.Copilot)
        {
            sb.Append(" --allow-all ");
            sb.Append(resume
                ? "--resume=" + sessionId
                : "--session-id=" + sessionId + " --name " + Quote(NativeArg(safeTitle)));

            if (safeModel.Length > 0)
            {
                sb.Append(" --model ").Append(Quote(safeModel));
            }

            if (safeEffort.Length > 0)
            {
                sb.Append(" --effort ").Append(Quote(safeEffort));
            }

            if (hasCtx)
            {
                sb.Append(" -i $ctx");
            }
        }
        else
        {
            sb.Append(" --dangerously-skip-permissions ");
            sb.Append(resume
                ? "--resume " + Quote(sessionId)
                : "--session-id " + Quote(sessionId) + " --name " + Quote(NativeArg(safeTitle)));

            if (safeModel.Length > 0)
            {
                sb.Append(" --model ").Append(Quote(safeModel));
            }

            if (safeEffort.Length > 0)
            {
                sb.Append(" --effort ").Append(Quote(safeEffort));
            }

            if (hasCtx)
            {
                sb.Append(" --append-system-prompt $ctx");
            }

            // Le premier message est l'argument positionnel de claude : la session demarre dessus.
            if (hasMsg)
            {
                sb.Append(" $msg");
            }
        }

        sb.Append("\r\n");
        return sb.ToString();
    }

    /// <summary>Deux blocs de texte separes par une ligne vide ; un bloc vide est omis, rien n'est retouche.</summary>
    private static string JoinBlocks(string? first, string? second)
    {
        if (string.IsNullOrWhiteSpace(first)) return second ?? "";
        if (string.IsNullOrWhiteSpace(second)) return first;
        return first + "\n\n" + second;
    }

    private string WriteScript(string provider, string sessionId, string cwd, string? title, string? context, string? prompt, string? model, string? effort, bool resume)
    {
        var content = BuildScript(provider, Invocation(provider), sessionId, cwd, title, context, prompt, model, effort, resume);

        Directory.CreateDirectory(_store.LaunchDir);
        var file = Path.Combine(_store.LaunchDir, sessionId + ".ps1");

        // BOM UTF-8 : Windows PowerShell 5.1 lit sinon le script en page de codes ANSI
        // et les accents du contexte seraient mutiles.
        File.WriteAllText(file, content, new UTF8Encoding(encoderShouldEmitUTF8Identifier: true));
        return file;
    }

    /// <summary>Chaine PowerShell entre apostrophes simples : les apostrophes internes sont doublees.</summary>
    private static string Quote(string value) => "'" + value.Replace("'", "''") + "'";

    /// <summary>
    /// Meme protection que <see cref="ProtectQuotesLine"/> et <see cref="ProtectTrailingLine"/>, appliquee
    /// cote hote aux arguments courts (titre) qui ne passent pas par le here-string.
    /// </summary>
    public static string NativeArg(string value)
    {
        var escaped = QuoteRun.Replace(value, m => m.Groups[1].Value + m.Groups[1].Value + "\\\"");
        if (AnyWhitespace.IsMatch(escaped))
        {
            escaped = TrailingBackslashes.Replace(escaped, m => m.Groups[1].Value + m.Groups[1].Value);
        }

        return escaped;
    }

    /// <summary>
    /// Le here-string <c>@'…'@</c> n'a pas d'echappement : une ligne du contexte qui commencerait
    /// par <c>'@</c> le terminerait prematurement. On la decale d'un espace.
    /// </summary>
    private static string ProtectHereString(string context)
    {
        var normalized = context.Replace("\r\n", "\n").Replace('\r', '\n');
        var lines = normalized.Split('\n');
        for (var i = 0; i < lines.Length; i++)
        {
            if (lines[i].StartsWith("'@", StringComparison.Ordinal))
            {
                lines[i] = " " + lines[i];
            }
        }

        return string.Join("\r\n", lines);
    }

    private static string FirstLine(string value)
    {
        var index = value.IndexOfAny(new[] { '\r', '\n' });
        return index < 0 ? value : value[..index];
    }

    // ------------------------------------------------------------------ processus

    private void Launch(string scriptPath, string cwd, string? terminal)
    {
        var useWt = string.Equals(terminal, "wt", StringComparison.OrdinalIgnoreCase) && HasWt;

        var psi = useWt
            ? new ProcessStartInfo(_wtPath.Value!, $"-d \"{cwd}\" powershell.exe {PowerShellArgs} \"{scriptPath}\"")
            : new ProcessStartInfo("powershell.exe", $"{PowerShellArgs} \"{scriptPath}\"");

        psi.WorkingDirectory = cwd;
        psi.UseShellExecute = true; // nouvelle console

        try
        {
            Process.Start(psi);
        }
        catch (Exception ex)
        {
            _log.Error("Lancement du terminal impossible", ex);
            throw new InvalidOperationException("Impossible d'ouvrir le terminal : " + ex.Message);
        }
    }

    // ------------------------------------------------------------------ detection

    private static IEnumerable<string> PathDirectories()
    {
        var raw = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (var part in raw.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
        {
            var trimmed = part.Trim().Trim('"');
            if (trimmed.Length == 0)
            {
                continue;
            }

            string full;
            try
            {
                full = Path.GetFullPath(Environment.ExpandEnvironmentVariables(trimmed));
            }
            catch
            {
                continue;
            }

            yield return full;
        }
    }

    private static bool IsOnPath(string executablePath)
    {
        var dir = Path.GetDirectoryName(executablePath);
        if (string.IsNullOrEmpty(dir))
        {
            return false;
        }

        foreach (var candidate in PathDirectories())
        {
            if (string.Equals(candidate.TrimEnd(Path.DirectorySeparatorChar), dir.TrimEnd(Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }

        return false;
    }

    private string? FindClaudeInvocation()
    {
        var path = FindClaude();
        if (path is null)
        {
            return null;
        }

        return IsOnPath(path) ? "& claude" : "& " + Quote(path);
    }

    private string? FindClaude()
    {
        string[] names = { "claude.exe", "claude.cmd", "claude.bat" };

        foreach (var dir in PathDirectories())
        {
            foreach (var name in names)
            {
                var candidate = SafeCombine(dir, name);
                if (candidate is not null && File.Exists(candidate))
                {
                    _log.Info($"claude detecte : {candidate}");
                    return candidate;
                }
            }
        }

        var local = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            ".local", "bin");

        foreach (var name in names)
        {
            var candidate = SafeCombine(local, name);
            if (candidate is not null && File.Exists(candidate))
            {
                _log.Info($"claude detecte : {candidate}");
                return candidate;
            }
        }

        _log.Warn("claude introuvable dans le PATH ni dans %USERPROFILE%\\.local\\bin");
        return null;
    }

    /// <summary>
    /// GitHub Copilot CLI : dans le PATH (installation npm ou winget), sinon la copie que
    /// <c>gh copilot</c> telecharge, sinon <c>gh copilot</c> lui-meme qui la telechargera.
    /// Le chemin complet est toujours ecrit : le « bootstrapper » que l'extension VS Code place
    /// dans le PATH de ses terminaux s'appelle aussi <c>copilot</c> et masquerait le vrai binaire.
    /// </summary>
    private CommandLine? FindCopilotCommand()
    {
        string[] names = { "copilot.exe", "copilot.cmd", "copilot.bat" };

        foreach (var dir in PathDirectories())
        {
            if (dir.Contains("github.copilot-chat", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            foreach (var name in names)
            {
                var candidate = SafeCombine(dir, name);
                if (candidate is not null && File.Exists(candidate))
                {
                    _log.Info($"copilot detecte : {candidate}");
                    return new CommandLine(candidate, Array.Empty<string>());
                }
            }
        }

        var fromGh = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "GitHub CLI", "copilot", "copilot.exe");

        if (File.Exists(fromGh))
        {
            _log.Info($"copilot detecte : {fromGh}");
            return new CommandLine(fromGh, Array.Empty<string>());
        }

        foreach (var dir in PathDirectories())
        {
            var gh = SafeCombine(dir, "gh.exe");
            if (gh is not null && File.Exists(gh))
            {
                _log.Info($"copilot lance via gh : {gh}");
                return new CommandLine(gh, new[] { "copilot", "--" });
            }
        }

        _log.Warn("copilot introuvable : ni dans le PATH, ni dans %LOCALAPPDATA%\\GitHub CLI\\copilot, et gh est absent");
        return null;
    }

    private string? FindWindowsTerminal()
    {
        foreach (var dir in PathDirectories())
        {
            var candidate = SafeCombine(dir, "wt.exe");
            if (candidate is not null && File.Exists(candidate))
            {
                return candidate;
            }
        }

        var alias = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Microsoft", "WindowsApps", "wt.exe");

        return File.Exists(alias) ? alias : null;
    }

    private static string? SafeCombine(string dir, string name)
    {
        try
        {
            return Path.Combine(dir, name);
        }
        catch
        {
            return null;
        }
    }
}
