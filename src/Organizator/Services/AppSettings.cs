using System.Text.Json.Serialization;

namespace Organizator.Services;

/// <summary>Position et taille de la fenetre, telles que persistees dans <c>settings.json</c>.</summary>
public sealed class WindowPlacement
{
    [JsonPropertyName("x")] public double X { get; set; }
    [JsonPropertyName("y")] public double Y { get; set; }
    [JsonPropertyName("width")] public double Width { get; set; }
    [JsonPropertyName("height")] public double Height { get; set; }
    [JsonPropertyName("maximized")] public bool Maximized { get; set; }
}

/// <summary><c>settings.json</c>. Les valeurs par defaut sont celles du contrat.</summary>
public sealed class AppSettings
{
    [JsonPropertyName("topCount")] public int TopCount { get; set; } = 3;
    [JsonPropertyName("showBands")] public bool ShowBands { get; set; } = true;
    [JsonPropertyName("compact")] public bool Compact { get; set; }
    [JsonPropertyName("defaultCwd")] public string DefaultCwd { get; set; } = "";

    /// <summary>Dossier des sources d'Organizator, ou l'agent traite les remarques ; vide = detecte autour de l'executable.</summary>
    [JsonPropertyName("repoDir")] public string RepoDir { get; set; } = "";

    /// <summary>Serveur Bitbucket interroge pour les PRs en attente ; vide = celui detecte (serveur MCP de ~/.claude.json, ou BITBUCKET_URL).</summary>
    [JsonPropertyName("bitbucketUrl")] public string BitbucketUrl { get; set; } = "";

    [JsonPropertyName("terminal")] public string Terminal { get; set; } = "powershell";

    /// <summary>Agent par defaut, preselectionne dans le formulaire de nouvelle conversation.</summary>
    [JsonPropertyName("provider")] public string Provider { get; set; } = AgentProvider.Claude;

    /// <summary>Modele par defaut pour Claude Code (vide = reglage propre de l'outil).</summary>
    [JsonPropertyName("claudeModel")] public string ClaudeModel { get; set; } = "";

    /// <summary>Modele par defaut pour GitHub Copilot CLI (vide = reglage propre de l'outil).</summary>
    [JsonPropertyName("copilotModel")] public string CopilotModel { get; set; } = "";

    /// <summary>Effort par defaut pour Claude Code (vide = reglage propre de l'outil).</summary>
    [JsonPropertyName("claudeEffort")] public string ClaudeEffort { get; set; } = "";

    /// <summary>Effort par defaut pour GitHub Copilot CLI (vide = reglage propre de l'outil).</summary>
    [JsonPropertyName("copilotEffort")] public string CopilotEffort { get; set; } = "";

    /// <summary>Agent charge de la redaction assistee (titre -> contenu), regle a part des conversations.</summary>
    [JsonPropertyName("draftProvider")] public string DraftProvider { get; set; } = AgentProvider.Claude;

    /// <summary>Modele de la redaction assistee ; un modele rapide suffit pour quelques phrases.</summary>
    [JsonPropertyName("draftModel")] public string DraftModel { get; set; } = "haiku";

    /// <summary>Effort de la redaction assistee (vide = reglage propre de l'outil).</summary>
    [JsonPropertyName("draftEffort")] public string DraftEffort { get; set; } = "";

    [JsonPropertyName("window")] public WindowPlacement? Window { get; set; }

    public AppSettings Clone() => new()
    {
        TopCount = TopCount,
        ShowBands = ShowBands,
        Compact = Compact,
        DefaultCwd = DefaultCwd,
        RepoDir = RepoDir,
        BitbucketUrl = BitbucketUrl,
        Terminal = Terminal,
        Provider = Provider,
        ClaudeModel = ClaudeModel,
        CopilotModel = CopilotModel,
        ClaudeEffort = ClaudeEffort,
        CopilotEffort = CopilotEffort,
        DraftProvider = DraftProvider,
        DraftModel = DraftModel,
        DraftEffort = DraftEffort,
        Window = Window is null
            ? null
            : new WindowPlacement
            {
                X = Window.X,
                Y = Window.Y,
                Width = Window.Width,
                Height = Window.Height,
                Maximized = Window.Maximized,
            },
    };

    /// <summary>Ramene les valeurs hors bornes dans le domaine attendu par l'UI.</summary>
    public void Sanitize()
    {
        if (TopCount < 1 || TopCount > 8)
        {
            TopCount = 3;
        }

        DefaultCwd ??= "";
        RepoDir ??= "";
        BitbucketUrl = BitbucketPullRequests.NormalizeUrl(BitbucketUrl) ?? "";

        if (!string.Equals(Terminal, "wt", StringComparison.OrdinalIgnoreCase))
        {
            Terminal = "powershell";
        }
        else
        {
            Terminal = "wt";
        }

        Provider = AgentProvider.Normalize(Provider);
        ClaudeModel = AgentProvider.SanitizeModel(ClaudeModel);
        CopilotModel = AgentProvider.SanitizeModel(CopilotModel);
        ClaudeEffort = AgentProvider.SanitizeEffort(AgentProvider.Claude, ClaudeEffort);
        CopilotEffort = AgentProvider.SanitizeEffort(AgentProvider.Copilot, CopilotEffort);

        DraftProvider = AgentProvider.Normalize(DraftProvider);
        DraftModel = AgentProvider.SanitizeModel(DraftModel);
        DraftEffort = AgentProvider.SanitizeEffort(DraftProvider, DraftEffort);
    }
}
