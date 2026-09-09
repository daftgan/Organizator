using System.Text.RegularExpressions;

namespace Organizator.Services;

/// <summary>
/// Agents en ligne de commande pris en charge. L'identifiant est celui qui circule dans
/// <c>data.json</c> (<c>convo.provider</c>), <c>settings.json</c> et le pont JS.
/// </summary>
public static class AgentProvider
{
    public const string Claude = "claude";
    public const string Copilot = "copilot";

    /// <summary>Alias acceptes par <c>claude --model</c> : toujours le dernier modele de chaque famille.</summary>
    public static readonly string[] ClaudeModels = { "fable", "opus", "sonnet", "haiku" };

    /// <summary>Valeurs toujours proposees pour <c>copilot --model</c> ; les autres sont decouvertes.</summary>
    public static readonly string[] CopilotModels = { "auto" };

    /// <summary>Niveaux acceptes par <c>claude --effort</c>.</summary>
    public static readonly string[] ClaudeEfforts = { "low", "medium", "high", "xhigh", "max" };

    /// <summary>Niveaux acceptes par <c>copilot --effort</c>.</summary>
    public static readonly string[] CopilotEfforts = { "none", "minimal", "low", "medium", "high", "xhigh", "max" };

    // Alias (opus, sonnet[1m]) ou identifiant complet (claude-opus-5, gpt-5.4) : la valeur est
    // ecrite telle quelle dans un script, tout autre caractere est refuse.
    private static readonly Regex ModelPattern = new(@"^[A-Za-z0-9][A-Za-z0-9._:\[\]/-]{0,63}$", RegexOptions.CultureInvariant);

    /// <summary>Ramene une valeur quelconque a l'un des deux identifiants connus ; Claude par defaut.</summary>
    public static string Normalize(string? value)
        => string.Equals(value?.Trim(), Copilot, StringComparison.OrdinalIgnoreCase) ? Copilot : Claude;

    public static string Label(string? provider)
        => Normalize(provider) == Copilot ? "GitHub Copilot" : "Claude Code";

    public static string[] Efforts(string? provider)
        => Normalize(provider) == Copilot ? CopilotEfforts : ClaudeEfforts;

    /// <summary>Vrai si <paramref name="value"/> peut etre ecrit tel quel apres <c>--model</c>.</summary>
    public static bool IsValidModel(string? value) => value is not null && ModelPattern.IsMatch(value);

    /// <summary>Modele nettoye pour les reglages : vide si absent ou invalide, jamais d'exception.</summary>
    public static string SanitizeModel(string? value)
    {
        var trimmed = (value ?? "").Trim();
        return trimmed.Length == 0 || IsValidModel(trimmed) ? trimmed : "";
    }

    /// <summary>Modele exige par un lancement : vide (modele par defaut de l'outil) ou valide, sinon erreur lisible.</summary>
    public static string RequireModel(string? value)
    {
        var trimmed = (value ?? "").Trim();
        if (trimmed.Length == 0 || IsValidModel(trimmed))
        {
            return trimmed;
        }

        throw new InvalidOperationException("Nom de modele invalide : " + trimmed);
    }

    /// <summary>Niveau d'effort nettoye pour les reglages : vide si absent ou inconnu de l'outil.</summary>
    public static string SanitizeEffort(string? provider, string? value)
    {
        var trimmed = (value ?? "").Trim().ToLowerInvariant();
        return Array.IndexOf(Efforts(provider), trimmed) >= 0 ? trimmed : "";
    }

    /// <summary>Niveau d'effort exige par un lancement : vide (reglage de l'outil) ou connu, sinon erreur lisible.</summary>
    public static string RequireEffort(string? provider, string? value)
    {
        var trimmed = (value ?? "").Trim().ToLowerInvariant();
        if (trimmed.Length == 0 || Array.IndexOf(Efforts(provider), trimmed) >= 0)
        {
            return trimmed;
        }

        throw new InvalidOperationException("Niveau d'effort invalide pour " + Label(provider) + " : " + trimmed);
    }
}
