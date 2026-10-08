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

    /// <summary>Clic sur l'icone de console d'une carte : "panel" ouvre le panneau, "terminal" va a la fenetre de la seule conversation.</summary>
    [JsonPropertyName("termClick")] public string TermClick { get; set; } = "panel";

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

    /// <summary>Article du jour : propose-t-on un article chaque jour (carte de l'en-tete) ?</summary>
    [JsonPropertyName("articleEnabled")] public bool ArticleEnabled { get; set; } = true;

    /// <summary>Sujets fixes par l'utilisateur pour l'article du jour, prioritaires sur ceux devines dans la file.</summary>
    [JsonPropertyName("articleTopics")] public string ArticleTopics { get; set; } = "";

    /// <summary>Veille IA : un second article par jour, sur l'actualite recente de l'IA (sa propre carte).</summary>
    [JsonPropertyName("articleAiEnabled")] public bool ArticleAiEnabled { get; set; } = true;

    /// <summary>Modele Claude de l'article du jour : chercher, lire et resumer demande mieux qu'un modele rapide.</summary>
    [JsonPropertyName("articleModel")] public string ArticleModel { get; set; } = "sonnet";

    /// <summary>Effort de l'article du jour : une recherche quotidienne n'a pas besoin du plus couteux (vide = reglage propre de l'outil).</summary>
    [JsonPropertyName("articleEffort")] public string ArticleEffort { get; set; } = "medium";

    /// <summary>Notifications Windows quand une reponse arrive alors qu'Organizator est en arriere-plan.</summary>
    [JsonPropertyName("windowsNotifications")] public bool WindowsNotifications { get; set; } = true;

    /// <summary>Dictee : un micro dans les zones de saisie, transcrit par Whisper en local.</summary>
    [JsonPropertyName("whisperEnabled")] public bool WhisperEnabled { get; set; } = true;

    /// <summary>Transcrire d'office un enregistrement joint a une tache (la transcription est jointe en texte).</summary>
    [JsonPropertyName("whisperAuto")] public bool WhisperAuto { get; set; } = true;

    /// <summary>Modele Whisper (voir <see cref="WhisperTranscriber.Models"/>).</summary>
    [JsonPropertyName("whisperModel")] public string WhisperModel { get; set; } = WhisperTranscriber.DefaultModel;

    /// <summary>Langue parlee : fr, en, ou auto (devinee par Whisper).</summary>
    [JsonPropertyName("whisperLanguage")] public string WhisperLanguage { get; set; } = "fr";

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
        TermClick = TermClick,
        Provider = Provider,
        ClaudeModel = ClaudeModel,
        CopilotModel = CopilotModel,
        ClaudeEffort = ClaudeEffort,
        CopilotEffort = CopilotEffort,
        DraftProvider = DraftProvider,
        DraftModel = DraftModel,
        DraftEffort = DraftEffort,
        ArticleEnabled = ArticleEnabled,
        ArticleTopics = ArticleTopics,
        ArticleAiEnabled = ArticleAiEnabled,
        ArticleModel = ArticleModel,
        ArticleEffort = ArticleEffort,
        WindowsNotifications = WindowsNotifications,
        WhisperEnabled = WhisperEnabled,
        WhisperAuto = WhisperAuto,
        WhisperModel = WhisperModel,
        WhisperLanguage = WhisperLanguage,
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

        TermClick = string.Equals(TermClick, "terminal", StringComparison.OrdinalIgnoreCase) ? "terminal" : "panel";

        Provider = AgentProvider.Normalize(Provider);
        ClaudeModel = AgentProvider.SanitizeModel(ClaudeModel);
        CopilotModel = AgentProvider.SanitizeModel(CopilotModel);
        ClaudeEffort = AgentProvider.SanitizeEffort(AgentProvider.Claude, ClaudeEffort);
        CopilotEffort = AgentProvider.SanitizeEffort(AgentProvider.Copilot, CopilotEffort);

        DraftProvider = AgentProvider.Normalize(DraftProvider);
        DraftModel = AgentProvider.SanitizeModel(DraftModel);
        DraftEffort = AgentProvider.SanitizeEffort(DraftProvider, DraftEffort);

        ArticleTopics = (ArticleTopics ?? "").Trim();
        if (ArticleTopics.Length > 2000)
        {
            ArticleTopics = ArticleTopics[..2000];
        }

        ArticleModel = AgentProvider.SanitizeModel(ArticleModel);
        ArticleEffort = AgentProvider.SanitizeEffort(AgentProvider.Claude, ArticleEffort);

        WhisperModel = WhisperTranscriber.SanitizeModel(WhisperModel);
        WhisperLanguage = WhisperTranscriber.SanitizeLanguage(WhisperLanguage);
    }
}
