using System.Diagnostics;
using System.Text;
using System.Text.RegularExpressions;

namespace Organizator.Services;

/// <param name="Text">Texte rendu par l'agent, nettoye.</param>
/// <param name="Ms">Duree de l'appel, pour l'afficher a l'utilisateur.</param>
public sealed record DraftResult(string Text, long Ms);

/// <summary>
/// Redaction assistee : l'agent est appele en mode non interactif (<c>claude -p</c>,
/// <c>copilot -p</c>), hors terminal, et sa reponse revient dans l'interface. Rien n'est ecrit
/// dans les donnees : c'est l'utilisateur qui garde ou jette le texte propose.
///
/// Deux precautions valent d'etre notees :
/// <list type="bullet">
/// <item><description><c>claude --bare</c> est a proscrire ici : ce mode saute les lectures du
/// trousseau et l'appel repond « Not logged in » alors que la session l'est.</description></item>
/// <item><description>Claude recoit <c>--no-session-persistence</c> : une redaction ne doit pas
/// laisser de session dans <c>~/.claude/projects</c>. Copilot n'a pas d'equivalent, sa session
/// est donc creee sous un identifiant connu puis supprimee (<see cref="CopilotSessionCleanup"/>).
/// </description></item>
/// </list>
/// </summary>
public sealed class AgentDraft
{
    private static readonly TimeSpan Limit = TimeSpan.FromSeconds(120);

    /// <summary>Codes d'echappement ANSI : la CLI en met des que la sortie n'est pas un terminal muet.</summary>
    private static readonly Regex AnsiCodes = new(@"\x1B\[[0-9;?]*[ -/]*[@-~]", RegexOptions.CultureInvariant);

    private static readonly Regex FencedBlock = new(@"^```[a-zA-Z]*\r?\n(.*)\r?\n```$", RegexOptions.Singleline | RegexOptions.CultureInvariant);

    // Une redaction a la fois : le bouton est unique dans l'interface, et deux appels simultanes
    // ne feraient qu'attendre l'un derriere l'autre.
    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly AgentLauncher _launcher;
    private readonly CopilotSessions _copilot;
    private readonly HostLog _log;
    private readonly string _workingDir;

    public AgentDraft(AgentLauncher launcher, CopilotSessions copilot, HostLog log, string workingDir)
    {
        _launcher = launcher;
        _copilot = copilot;
        _log = log;
        _workingDir = workingDir;
    }

    /// <summary>
    /// Demande un texte a l'agent. <paramref name="system"/> dit comment ecrire (role, ton,
    /// longueur, pas de mise en forme), <paramref name="prompt"/> ce qu'il faut ecrire.
    /// </summary>
    public async Task<DraftResult> WriteAsync(string provider, string model, string effort, string system, string prompt)
    {
        provider = AgentProvider.Normalize(provider);
        if (string.IsNullOrWhiteSpace(prompt))
        {
            throw new InvalidOperationException("Rien a rediger : le texte de depart est vide.");
        }

        var command = _launcher.CommandFor(provider)
            ?? throw new InvalidOperationException($"{AgentProvider.Label(provider)} est introuvable sur ce poste.");

        await _gate.WaitAsync().ConfigureAwait(false);
        try
        {
            var started = Stopwatch.StartNew();
            var sessionId = provider == AgentProvider.Copilot ? Guid.NewGuid().ToString("d") : "";
            var info = Build(command, provider, model, effort, system, prompt, sessionId);

            var (code, output, error) = await RunAsync(info).ConfigureAwait(false);
            started.Stop();

            if (sessionId.Length > 0)
            {
                CopilotSessionCleanup.Remove(_copilot, sessionId, keepIfUsed: false, _log, "de redaction");
            }

            var text = Clean(output);
            if (text.Length == 0)
            {
                throw new InvalidOperationException(Explain(provider, code, Clean(error)));
            }

            _log.Info($"Redaction {provider} : {text.Length} caracteres en {started.ElapsedMilliseconds} ms.");
            return new DraftResult(text, started.ElapsedMilliseconds);
        }
        finally
        {
            _gate.Release();
        }
    }

    private ProcessStartInfo Build(CommandLine command, string provider, string model, string effort, string system, string prompt, string sessionId)
    {
        var info = new ProcessStartInfo
        {
            FileName = command.FileName,
            WorkingDirectory = _workingDir,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            RedirectStandardInput = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };

        foreach (var argument in command.Arguments)
        {
            info.ArgumentList.Add(argument);
        }

        info.ArgumentList.Add("-p");

        if (provider == AgentProvider.Copilot)
        {
            // Copilot n'a pas de prompt systeme : les consignes ouvrent le message.
            info.ArgumentList.Add(Join(system, prompt));
            info.ArgumentList.Add("--session-id=" + sessionId);
        }
        else
        {
            info.ArgumentList.Add(prompt);
            info.ArgumentList.Add("--no-session-persistence");
            if (system.Length > 0)
            {
                info.ArgumentList.Add("--append-system-prompt");
                info.ArgumentList.Add(system);
            }
        }

        if (model.Length > 0)
        {
            info.ArgumentList.Add("--model");
            info.ArgumentList.Add(model);
        }

        if (effort.Length > 0)
        {
            info.ArgumentList.Add("--effort");
            info.ArgumentList.Add(effort);
        }

        return info;
    }

    private static string Join(string system, string prompt)
        => system.Length == 0 ? prompt : system + "\n\n" + prompt;

    /// <summary>Lance l'agent, lit ses deux flux et le tue s'il s'eternise.</summary>
    private async Task<(int Code, string Output, string Error)> RunAsync(ProcessStartInfo info)
    {
        using var process = new Process { StartInfo = info };
        try
        {
            process.Start();
        }
        catch (Exception ex)
        {
            throw new InvalidOperationException("Lancement de l'agent impossible : " + ex.Message);
        }

        // L'agent n'attend rien sur son entree, mais la laisser ouverte le ferait patienter.
        process.StandardInput.Close();

        var output = process.StandardOutput.ReadToEndAsync();
        var error = process.StandardError.ReadToEndAsync();

        using var cts = new CancellationTokenSource(Limit);
        try
        {
            await process.WaitForExitAsync(cts.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            Kill(process);
            throw new InvalidOperationException($"L'agent n'a pas repondu en {Limit.TotalSeconds:0} secondes.");
        }

        return (process.ExitCode, await output.ConfigureAwait(false), await error.ConfigureAwait(false));
    }

    private void Kill(Process process)
    {
        try
        {
            process.Kill(entireProcessTree: true);
        }
        catch (Exception ex)
        {
            _log.Warn("Arret de l'agent de redaction impossible : " + ex.Message);
        }
    }

    /// <summary>Sortie utilisable : sans codes ANSI, sans bloc de code encadrant, sans blancs autour.</summary>
    private static string Clean(string raw)
    {
        var text = AnsiCodes.Replace(raw ?? "", "").Replace("\r\n", "\n").Trim();
        var fenced = FencedBlock.Match(text);
        return fenced.Success ? fenced.Groups[1].Value.Trim() : text;
    }

    /// <summary>Message lisible quand l'agent n'a rien rendu : la cause est presque toujours dans sa sortie d'erreur.</summary>
    private static string Explain(string provider, int code, string error)
    {
        var label = AgentProvider.Label(provider);
        var first = TranscriptAccumulator.Shorten(error);

        if (error.Contains("Not logged in", StringComparison.OrdinalIgnoreCase)
            || error.Contains("/login", StringComparison.OrdinalIgnoreCase))
        {
            return $"{label} n'est pas connecte : ouvrez un terminal, lancez l'agent et connectez-vous.";
        }

        return first is null
            ? $"{label} n'a rien repondu (code {code})."
            : $"{label} n'a rien repondu (code {code}) : {first}";
    }
}
