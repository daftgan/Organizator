using System.Text.RegularExpressions;

namespace Organizator.Services;

/// <summary>
/// Ce que les services partages de Revizator prennent a <c>AgentDraft</c> de l'hote WPF (nettoyage de la
/// sortie de l'agent, message d'erreur lisible). La classe d'origine tire la session Copilot (SQLite),
/// sans objet sur le serveur : ces deux fonctions en sont la copie conforme, a garder alignees.
/// </summary>
public static class AgentDraft
{
    private static readonly Regex AnsiCodes = new(@"\x1B\[[0-9;?]*[ -/]*[@-~]", RegexOptions.CultureInvariant);

    private static readonly Regex FencedBlock = new(@"^```[a-zA-Z]*\r?\n(.*)\r?\n```$", RegexOptions.Singleline | RegexOptions.CultureInvariant);

    /// <summary>Sortie utilisable : sans codes ANSI, sans bloc de code encadrant, sans blancs autour.</summary>
    internal static string Clean(string raw)
    {
        var text = AnsiCodes.Replace(raw ?? "", "").Replace("\r\n", "\n").Trim();
        var fenced = FencedBlock.Match(text);
        return fenced.Success ? fenced.Groups[1].Value.Trim() : text;
    }

    /// <summary>Message lisible quand l'agent n'a rien rendu : la cause est presque toujours dans sa sortie d'erreur.</summary>
    internal static string Explain(string provider, int code, string error)
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
