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

    /// <summary>Conversation vocale : modele Claude de l'interlocuteur (un modele rapide garde la conversation fluide).</summary>
    [JsonPropertyName("voiceModel")] public string VoiceModel { get; set; } = "sonnet";

    /// <summary>Conversation vocale : effort de Claude (vide = reglage propre de l'outil) ; bas pour repondre vite.</summary>
    [JsonPropertyName("voiceEffort")] public string VoiceEffort { get; set; } = "low";

    /// <summary>Conversation vocale : id de la voix de synthese (jeton SAPI) ; vide = premiere voix francaise trouvee.</summary>
    [JsonPropertyName("voiceVoice")] public string VoiceVoice { get; set; } = "";

    /// <summary>Conversation vocale : debit de la voix, de -10 a 10.</summary>
    [JsonPropertyName("voiceRate")] public int VoiceRate { get; set; } = 1;

    /// <summary>Conversation vocale : prenom de l'interlocuteur.</summary>
    [JsonPropertyName("voicePersona")] public string VoicePersona { get; set; } = "Alma";

    /// <summary>Conversation vocale : sujet (voir <see cref="VoiceChat.Topics"/>).</summary>
    [JsonPropertyName("voiceTopic")] public string VoiceTopic { get; set; } = "libre";

    /// <summary>Conversation vocale : consignes libres ajoutees au prompt systeme.</summary>
    [JsonPropertyName("voiceInstructions")] public string VoiceInstructions { get; set; } = "";

    /// <summary>Conversation vocale : l'interlocuteur peut chercher sur le web (WebSearch, WebFetch).</summary>
    [JsonPropertyName("voiceWeb")] public bool VoiceWeb { get; set; } = true;

    /// <summary>Conversation vocale : modele Whisper (base = le plus rapide).</summary>
    [JsonPropertyName("voiceWhisperModel")] public string VoiceWhisperModel { get; set; } = "base";

    /// <summary>Conversation vocale : sensibilite de la detection de parole, de 0 a 100.</summary>
    [JsonPropertyName("voiceSensitivity")] public int VoiceSensitivity { get; set; } = 40;

    /// <summary>Conversation vocale : quand couper la parole a l'avatar (words = quand on dit quelques mots, voice = des qu'on parle, off = jamais).</summary>
    [JsonPropertyName("voiceBargeIn")] public string VoiceBargeIn { get; set; } = "words";

    /// <summary>Serveur Revizator (https://revizator.exemple.fr) : l'onglet Revizator y lit et y ecrit ses donnees ; vide = tout reste sur ce PC.</summary>
    [JsonPropertyName("revizatorServerUrl")] public string RevizatorServerUrl { get; set; } = "";

    /// <summary>Jeton d'appareil du serveur Revizator (revizator-server token new), transmis dans l'adresse du WebSocket et des medias.</summary>
    [JsonPropertyName("revizatorServerToken")] public string RevizatorServerToken { get; set; } = "";

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
        VoiceModel = VoiceModel,
        VoiceEffort = VoiceEffort,
        VoiceVoice = VoiceVoice,
        VoiceRate = VoiceRate,
        VoicePersona = VoicePersona,
        VoiceTopic = VoiceTopic,
        VoiceInstructions = VoiceInstructions,
        VoiceWeb = VoiceWeb,
        VoiceWhisperModel = VoiceWhisperModel,
        VoiceSensitivity = VoiceSensitivity,
        VoiceBargeIn = VoiceBargeIn,
        RevizatorServerUrl = RevizatorServerUrl,
        RevizatorServerToken = RevizatorServerToken,
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

        VoiceModel = AgentProvider.SanitizeModel(VoiceModel);
        VoiceEffort = AgentProvider.SanitizeEffort(AgentProvider.Claude, VoiceEffort);
        VoiceVoice = (VoiceVoice ?? "").Trim();
        if (VoiceVoice.Length > 300)
        {
            VoiceVoice = "";
        }

        VoiceRate = Math.Clamp(VoiceRate, -10, 10);
        VoicePersona = VoiceChat.SanitizePersona(VoicePersona);
        VoiceTopic = VoiceChat.SanitizeTopic(VoiceTopic);
        VoiceInstructions = (VoiceInstructions ?? "").Trim();
        if (VoiceInstructions.Length > 2000)
        {
            VoiceInstructions = VoiceInstructions[..2000];
        }

        // Modele inconnu : celui de la conversation (base), pas celui de la dictee.
        VoiceWhisperModel = WhisperTranscriber.Models.Any(m => string.Equals(m.Id, VoiceWhisperModel?.Trim(), StringComparison.OrdinalIgnoreCase))
            ? WhisperTranscriber.SanitizeModel(VoiceWhisperModel)
            : "base";
        VoiceSensitivity = Math.Clamp(VoiceSensitivity, 0, 100);
        VoiceBargeIn = VoiceBargeIn is "voice" or "off" ? VoiceBargeIn : "words";

        RevizatorServerUrl = SanitizeServerUrl(RevizatorServerUrl);
        RevizatorServerToken = (RevizatorServerToken ?? "").Trim();
        // Jeton du serveur : base64url (43 caracteres) ; autre chose ne passerait pas dans une URL.
        if (RevizatorServerToken.Length > 200 || RevizatorServerToken.Any(c => !(char.IsAsciiLetterOrDigit(c) || c is '-' or '_')))
        {
            RevizatorServerToken = "";
        }
    }

    /// <summary>
    /// Adresse du serveur Revizator : http(s) seulement, sans chemin, requete ni barre finale ;
    /// sans schema, https est suppose. Illisible : vide (Revizator reste local).
    /// </summary>
    public static string SanitizeServerUrl(string? url)
    {
        var raw = (url ?? "").Trim().TrimEnd('/');
        if (raw.Length == 0 || raw.Length > 300)
        {
            return "";
        }

        if (!raw.Contains("://", StringComparison.Ordinal))
        {
            raw = "https://" + raw;
        }

        if (!Uri.TryCreate(raw, UriKind.Absolute, out var uri)
            || (uri.Scheme != Uri.UriSchemeHttps && uri.Scheme != Uri.UriSchemeHttp)
            || string.IsNullOrEmpty(uri.Host) || !string.IsNullOrEmpty(uri.UserInfo))
        {
            return "";
        }

        return uri.GetLeftPart(UriPartial.Authority);
    }
}
