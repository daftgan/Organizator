using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using System.Windows;
using Microsoft.Web.WebView2.Core;
using Organizator.Services;

namespace Organizator.Bridge;

/// <summary>
/// Pont JS -> hote. Recoit <c>{ id, type, payload }</c>, dispatche vers un handler,
/// et repond toujours au meme <c>id</c> par <c>{ id, ok, payload }</c> ou
/// <c>{ id, ok: false, error }</c>. Aucune exception d'un handler ne remonte.
/// </summary>
public sealed class BridgeHost
{
    private static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
    };

    private static readonly string HostVersion =
        typeof(BridgeHost).Assembly.GetName().Version?.ToString(3) ?? "1.0.0";

    private readonly CoreWebView2 _core;
    private readonly Window _owner;
    private readonly HostLog _log;
    private readonly DataStore _store;
    private readonly ClaudeSessions _claude;
    private readonly CopilotSessions _copilot;
    private readonly AgentArtifacts _artifacts;
    private readonly AgentLauncher _launcher;
    private readonly ClaudeModelCatalog _claudeCatalog;
    private readonly CopilotModelCatalog _copilotCatalog;
    private readonly AgentProcessScanner? _scanner;
    private readonly AgentWindows _windows;
    private readonly UsageMonitor _usage;
    private readonly AgentDraft _draft;
    private readonly ArtifactReader _reader;
    private readonly BitbucketPullRequests _bitbucket;
    private readonly TaskAttachments _attachments;
    private readonly Dictionary<string, DailyArticle> _articles;
    private readonly WindowsToasts _toasts;
    private readonly FindingChat _findings;
    private readonly WhisperTranscriber _whisper;
    private readonly VoiceChat _voice;
    private readonly AssistantChat _assistant;
    private readonly LiveSessions _live;

    // Vues branchees sur le pont : la fenetre principale, et la fenetre Conversations quand elle est ouverte.
    // Chaque reponse repart a la vue qui a ecrit ; les evenements partent a toutes. Une boite de dialogue
    // (choix de fichiers, telechargement) s'ouvre sur la fenetre de la vue qui l'a demandee.
    private readonly List<CoreWebView2> _views = new();
    private readonly Dictionary<CoreWebView2, Window> _viewOwners = new();
    private readonly SpeechVoice _speech;

    // Revizator (H2) : modele de l'apprenant et documents, menu RSS du cours, generations par Claude.
    private readonly LearningStore _learning;
    private readonly NewsMenu _learnNews;
    private readonly LearningAgent _learnAgent;
    private readonly TextToSpeech _tts;
    private readonly LiveAsr _asr;
    private readonly PerfMonitor? _perf;

    // Mises a jour d'Organizator, servies par le serveur Revizator regle (voir AppUpdater).
    private readonly AppUpdater _updater;

    // Dossier servi sous https://report.organizator/ par chaque vue (voir ArtifactReader.Locate) : la
    // fenetre Conversations montre un document a droite pendant que le lecteur de la principale en lit un autre.
    private readonly Dictionary<CoreWebView2, string> _reportRoots = new();

    // Un transcript n'est relu que si sa taille ou sa date a change : le rafraichissement de
    // toutes les conversations a chaque evenement reste bon marche.
    private readonly object _cacheLock = new();
    private readonly Dictionary<string, (string Stamp, SessionSummary Summary)> _summaryCache = new(StringComparer.Ordinal);

    // Reprise d'une session dont la fenetre etait fermee : les agents qu'elle avait lances sont
    // morts avec elle, mais le fichier de session, relu depuis son debut, les montre encore partis
    // au travail. On retient donc l'instant de la relance pour ne plus compter ceux d'avant.
    private readonly Dictionary<string, long> _relaunchedAt = new(StringComparer.OrdinalIgnoreCase);

    // Terminal ouvert par un lancement ou une reprise : le balayage des processus ne voit l'agent
    // qu'apres quelques secondes, et un second clic dans l'intervalle ouvrait un second terminal
    // sur la meme session. Le PowerShell lance est retenu le temps que le balayage prenne le relais.
    private readonly Dictionary<string, (int ProcessId, long At)> _launchedTerminal = new(StringComparer.OrdinalIgnoreCase);
    private const long LaunchedTerminalMs = 120_000;

    public BridgeHost(
        CoreWebView2 core,
        Window owner,
        HostLog log,
        DataStore store,
        ClaudeSessions claude,
        CopilotSessions copilot,
        AgentLauncher launcher,
        AgentProcessScanner? scanner,
        PerfMonitor? perf = null)
    {
        _core = core;
        _perf = perf;
        _owner = owner;
        _log = log;
        _store = store;
        _claude = claude;
        _copilot = copilot;
        _artifacts = new AgentArtifacts(claude, copilot, log);
        _launcher = launcher;
        _scanner = scanner;
        _windows = new AgentWindows(log);
        _claudeCatalog = new ClaudeModelCatalog(store.DataDir, log, HostVersion);
        _copilotCatalog = new CopilotModelCatalog(store.DataDir, copilot, () => launcher.CopilotCommand, log);
        _usage = new UsageMonitor(log, HostVersion);
        _draft = new AgentDraft(launcher, copilot, log, store.DataDir);
        _reader = new ArtifactReader(log);
        _bitbucket = new BitbucketPullRequests(log, HostVersion);
        _attachments = new TaskAttachments(store.DataDir, log);
        _articles = ArticleFeed.All.ToDictionary(f => f.Id, f => new DailyArticle(f, launcher, log, store.DataDir), StringComparer.Ordinal);
        _toasts = new WindowsToasts(log, store.DataDir);
        // Clic sur une notification Windows : la fenetre revient devant, la page ouvre la tache.
        _toasts.Activated += arguments => _owner.Dispatcher.BeginInvoke(() =>
        {
            BringOwnerToFront();
            PostEvent("notificationClicked", new JsonObject { ["args"] = arguments });
        });
        // Discussion sur un constat : la reponse s'ecrit au fil de l'eau, la page la suit.
        _findings = new FindingChat(launcher, claude, log, store.DataDir);
        _findings.Progress += payload => _owner.Dispatcher.BeginInvoke(() => PostEvent("findingChat", payload));
        // Dictee et transcription des enregistrements : telechargement du modele et calcul s'affichent au fil de l'eau.
        _whisper = new WhisperTranscriber(store.DataDir, log, HostVersion);
        _whisper.Progress += payload => _owner.Dispatcher.BeginInvoke(() => PostEvent("whisper", payload));
        // Conversation vocale : les phrases de la reponse arrivent une a une, la page les dit aussitot.
        _voice = new VoiceChat(launcher, log, store.DataDir);
        _voice.Progress += payload => _owner.Dispatcher.BeginInvoke(() => PostEvent("voice", payload));
        _speech = new SpeechVoice(log);
        // Assistant : la reponse s'ecrit au fil de l'eau, et ses appels d'outils sont executes par la page.
        _assistant = new AssistantChat(launcher, log, store.DataDir);
        _assistant.Progress += payload => _owner.Dispatcher.BeginInvoke(() => PostEvent("assistant", payload));
        // Sessions hebergees (fenetre Conversations) : leur avancement part a toutes les vues.
        _live = new LiveSessions(launcher, log);
        _live.Progress += payload => _owner.Dispatcher.BeginInvoke(() => PostEvent("live", payload));
        // Revizator : persistance, menu du jour et generations ; l'avancement repasse par le fil de l'interface.
        _learning = new LearningStore(store.DataDir, log);
        _learnNews = new NewsMenu(_learning, log);
        _learnAgent = new LearningAgent(launcher, _learning, _learnNews, log, store.DataDir);
        LearningAnchors.Configure(store.DataDir);
        _learnAgent.Progress += payload => _owner.Dispatcher.BeginInvoke(() => PostEvent("learn", payload));
        // Synthese vocale anglaise (Revizator) : telechargement des voix et phrases pretes arrivent au fil de l'eau.
        // Runtime sherpa-onnx partage par la synthese (Kokoro) et la transcription en direct.
        var sherpa = new SherpaRuntime(store.DataDir, log, HostVersion);
        _tts = new TextToSpeech(store.DataDir, log, HostVersion, sherpa);
        _tts.Progress += payload => _owner.Dispatcher.BeginInvoke(() => PostEvent("tts", payload));
        // Transcription en direct : texte partiel et telechargements des modeles arrivent au fil de l'eau.
        _asr = new LiveAsr(store.DataDir, log, HostVersion, sherpa);
        _asr.Progress += payload => _owner.Dispatcher.BeginInvoke(() => PostEvent("asr", payload));
        // Mises a jour : verification au demarrage puis toutes les six heures, telechargement en arriere-plan.
        _updater = new AppUpdater(store.DataDir, log, () => _store.LoadSettings().RevizatorServerUrl, enabled: true);
        _updater.Progress += payload => _owner.Dispatcher.BeginInvoke(() => PostEvent("update", payload));
        _updater.Start();
        _views.Add(_core);
        _core.WebMessageReceived += OnWebMessageReceived;
    }

    /// <summary>
    /// Demande d'afficher la fenetre Conversations, sur une session (son identifiant) ou telle qu'elle
    /// est (null). Levee sur le fil de l'interface ; c'est la fenetre principale qui la cree.
    /// </summary>
    public event Action<string?>? ConversationsRequested;

    /// <summary>Sessions de la fenetre Conversations en pleine reponse : fermer Organizator les couperait.</summary>
    public int LiveBusyCount() => _live.BusyCount();

    /// <summary>Vrai quand la fermeture vient de « Installer maintenant » (deja confirmee).</summary>
    public bool ClosingForUpdate => _updater.RelaunchWanted;

    /// <summary>Branche une seconde vue (fenetre Conversations) : elle parle au meme hote, recoit les memes evenements.</summary>
    public void AttachView(CoreWebView2 core, Window owner)
    {
        lock (_views)
        {
            if (!_views.Contains(core))
            {
                _views.Add(core);
            }

            _viewOwners[core] = owner;
        }

        core.WebMessageReceived += OnWebMessageReceived;
    }

    public void DetachView(CoreWebView2 core)
    {
        core.WebMessageReceived -= OnWebMessageReceived;
        lock (_views)
        {
            _views.Remove(core);
            _viewOwners.Remove(core);
        }

        _reportRoots.Remove(core);
    }

    /// <summary>La fenetre qui porte une vue : la principale, ou la fenetre Conversations.</summary>
    private Window WindowOf(CoreWebView2 view)
    {
        lock (_views)
        {
            return _viewOwners.TryGetValue(view, out var window) ? window : _owner;
        }
    }

    /// <summary>Evenement a une seule vue (la fenetre Conversations : la session a montrer).</summary>
    public void PostEventTo(CoreWebView2 core, string name, JsonObject? payload = null)
        => PostTo(core, new JsonObject { ["event"] = name, ["payload"] = payload ?? new JsonObject() });

    /// <summary>Dossier des pieces jointes, servi a l'UI sous <see cref="TaskAttachments.Host"/>.</summary>
    public string AttachmentsRoot => _attachments.Root;

    /// <summary>
    /// Fermeture de l'application : la conversation vocale et la synthese s'arretent (processus claude tue),
    /// puis une mise a jour prete s'installe (les donnees viennent d'etre enregistrees).
    /// </summary>
    public void Shutdown()
    {
        try
        {
            _voice.Dispose();
            _assistant.Dispose();
            _live.Dispose();
            _speech.Dispose();
            _asr.Dispose();
        }
        catch (Exception ex)
        {
            _log.Warn("Arret de la conversation vocale incomplet : " + ex.Message);
        }

        _updater.InstallOnExit();
        _updater.Dispose();
    }

    /// <summary>« Installer maintenant » : la fenetre se ferme (donnees enregistrees), l'installateur la relance.</summary>
    private JsonObject InstallUpdateNow(JsonObject payload)
    {
        if (!_updater.Ready)
        {
            return new JsonObject { ["ok"] = false };
        }

        // Fermer Organizator arreterait les agents de la fenetre Conversations en pleine reponse.
        var busy = _live.BusyCount();
        if (busy > 0 && !(payload["force"] is JsonValue force && force.TryGetValue<bool>(out var forced) && forced))
        {
            return new JsonObject { ["ok"] = false, ["busy"] = busy };
        }

        _updater.RelaunchWanted = true;
        _owner.Dispatcher.BeginInvoke(() => _owner.Close());
        return new JsonObject { ["ok"] = true };
    }
    /// <summary>Dossier <c>learning\</c> de Revizator, servi a l'UI sous <see cref="LearningStore.Host"/>.</summary>
    public string LearningRoot => _learning.Root;
    /// <summary>Cache des phrases synthetisees, servi a l'UI sous <see cref="TextToSpeech.Host"/>.</summary>
    public string TtsCacheRoot => _tts.CacheRoot;

    /// <summary>Envoie un evenement non sollicite : <c>{ event, payload }</c>.</summary>
    public void PostEvent(string name, JsonObject? payload = null)
    {
        var message = new JsonObject
        {
            ["event"] = name,
            ["payload"] = payload ?? new JsonObject(),
        };

        CoreWebView2[] views;
        lock (_views)
        {
            views = _views.ToArray();
        }

        foreach (var view in views)
        {
            PostTo(view, message);
        }
    }

    private static void PostTo(CoreWebView2 view, JsonObject message)
    {
        try
        {
            view.PostWebMessageAsJson(message.ToJsonString());
        }
        catch (Exception ex)
        {
            // La WebView peut avoir ete detruite entre-temps.
            Debug.WriteLine("[Organizator] PostWebMessageAsJson : " + ex.Message);
        }
    }

    // ------------------------------------------------------------------ reception

    private async void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        var view = sender as CoreWebView2 ?? _core;
        JsonNode? id = null;
        string? type = null;
        var started = Stopwatch.GetTimestamp();
        try
        {
            string raw;
            try
            {
                raw = e.WebMessageAsJson;
            }
            catch (Exception ex)
            {
                _log.Warn("Message web illisible : " + ex.Message);
                return;
            }

            if (JsonNode.Parse(raw) is not JsonObject envelope)
            {
                _log.Warn("Message web ignore (ce n'est pas un objet JSON).");
                return;
            }

            id = envelope["id"]?.DeepClone();
            type = envelope["type"]?.GetValue<string>();
            var payload = envelope["payload"] as JsonObject ?? new JsonObject();

            // Fichiers deposes ou colles, passes par postMessageWithAdditionalObjects : la page n'en
            // connait que le nom, WebView2 en donne le chemin. Lus avant tout await, l'argument de
            // l'evenement ne survit pas au gestionnaire.
            payload["files"] = AdditionalFiles(e);

            if (string.IsNullOrWhiteSpace(type))
            {
                Reply(view, id, false, null, "Message sans type.");
                return;
            }

            _perf?.MessageStarted(type!);
            var result = await DispatchAsync(type!, payload, view).ConfigureAwait(true);
            Reply(view, id, true, result, null);
        }
        catch (TranscriptionCancelledException ex)
        {
            // Annulation demandee par la page (transcription speculative) : WhisperTranscriber l'a deja notee.
            Reply(view, id, false, null, ex.Message);
        }
        catch (Exception ex)
        {
            _log.Error("Echec du traitement d'un message web", ex);
            Reply(view, id, false, null, Readable(ex));
        }
        finally
        {
            if (!string.IsNullOrWhiteSpace(type))
            {
                _perf?.RecordMessage(type!, Stopwatch.GetElapsedTime(started).TotalMilliseconds);
            }
        }
    }

    private static void Reply(CoreWebView2 view, JsonNode? id, bool ok, JsonNode? payload, string? error)
    {
        var message = new JsonObject { ["id"] = id, ["ok"] = ok };
        if (ok)
        {
            message["payload"] = payload ?? new JsonObject();
        }
        else
        {
            message["error"] = error ?? "Erreur inconnue.";
        }

        PostTo(view, message);
    }

    /// <summary>
    /// Chemins des fichiers joints au message, dans l'ordre ; <c>null</c> pour un objet sans chemin
    /// (image du presse-papiers, fichier virtuel) : la page le renvoie alors par son contenu.
    /// </summary>
    private JsonArray AdditionalFiles(CoreWebView2WebMessageReceivedEventArgs e)
    {
        var files = new JsonArray();
        try
        {
            var objects = e.AdditionalObjects;
            if (objects is null)
            {
                return files;
            }

            foreach (var item in objects)
            {
                var path = item is CoreWebView2File file ? file.Path : null;
                files.Add(string.IsNullOrWhiteSpace(path) ? null : JsonValue.Create(path));
            }
        }
        catch (Exception ex)
        {
            _log.Warn("Fichiers joints au message illisibles : " + ex.Message);
        }

        return files;
    }

    private static string Readable(Exception ex) => ex switch
    {
        InvalidOperationException => ex.Message,
        UnauthorizedAccessException => "Acces refuse : " + ex.Message,
        IOException => "Erreur d'acces au disque : " + ex.Message,
        JsonException => "Donnees JSON invalides : " + ex.Message,
        _ => ex.Message,
    };

    // ------------------------------------------------------------------- dispatch

    private async Task<JsonNode?> DispatchAsync(string type, JsonObject payload, CoreWebView2 view) => type switch
    {
        "getState" => GetState(),
        "saveData" => SaveData(payload),
        "getData" => new JsonObject { ["data"] = _store.LoadData() },
        "saveSettings" => SaveSettings(payload),
        "pickFolder" => PickFolder(payload),
        "startSession" => await StartSessionAsync(payload).ConfigureAwait(true),
        "resumeSession" => await ResumeSessionAsync(payload).ConfigureAwait(true),
        "getSessions" => await GetSessionsAsync(payload).ConfigureAwait(true),
        "getTranscript" => await GetTranscriptAsync(payload).ConfigureAwait(true),
        "getRecaps" => await GetRecapsAsync(payload).ConfigureAwait(true),
        "refreshModels" => await RefreshModelsAsync(payload).ConfigureAwait(true),
        "draftText" => await DraftTextAsync(payload).ConfigureAwait(true),
        "notify" => Notify(payload),
        "badge" => SetBadge(payload),
        "getUsage" => await GetUsageAsync(payload).ConfigureAwait(true),
        "getPullRequests" => await GetPullRequestsAsync().ConfigureAwait(true),
        "getArticle" => await GetArticleAsync(payload).ConfigureAwait(true),
        "articleSeen" => ArticleOf(payload).MarkSeen(Str(payload, "url")),
        "openPath" => OpenPath(payload),
        "openUrl" => OpenUrl(payload),
        "readArtifact" => await ReadArtifactAsync(payload, view).ConfigureAwait(true),
        // Panneau de droite de la fenetre Conversations : telecharger (copie) ou supprimer (Corbeille) un document.
        "saveFileAs" => await SaveFileAsAsync(payload, view).ConfigureAwait(true),
        "recycleFile" => RecycleFile(payload, view),
        "getFindingChats" => _findings.List(Str(payload, "report") ?? ""),
        "askFinding" => await AskFindingAsync(payload).ConfigureAwait(true),
        "stopFinding" => new JsonObject { ["stopped"] = _findings.Stop(Str(payload, "report") ?? "", Str(payload, "finding") ?? "") },
        "forgetFinding" => new JsonObject { ["removed"] = _findings.Forget(Str(payload, "report") ?? "", Str(payload, "finding") ?? "") },
        "addAttachments" => await AddAttachmentsAsync(payload, view).ConfigureAwait(true),
        "pasteAttachment" => await PasteAttachmentAsync(payload).ConfigureAwait(true),
        "writeAttachmentText" => _attachments.WriteText(Str(payload, "taskId"), Str(payload, "id"), Str(payload, "text")),
        "removeAttachment" => new JsonObject { ["removed"] = _attachments.Remove(Str(payload, "path")) },
        "removeAttachments" => new JsonObject { ["removed"] = _attachments.RemoveTask(Str(payload, "taskId")) },
        "whisperStatus" => _whisper.Status(),
        "whisperDownload" => await DownloadWhisperAsync(payload).ConfigureAwait(true),
        "whisperRemove" => new JsonObject { ["removed"] = await _whisper.RemoveAsync(Str(payload, "model") ?? "").ConfigureAwait(true) },
        "whisperWarm" => WarmWhisper(payload),
        "transcribe" => await TranscribeAsync(payload).ConfigureAwait(true),
        "cancelTranscribe" => new JsonObject { ["cancelled"] = _whisper.Cancel(Str(payload, "job")) },
        "voiceStart" => StartVoice(payload),
        "voiceSay" => new JsonObject { ["turn"] = _voice.Say(Str(payload, "conversationId"), Str(payload, "text"), Str(payload, "heard")) },
        "voiceInterrupt" => InterruptVoice(payload),
        "voiceStop" => StopVoice(payload),
        "voiceVoices" => await _speech.VoicesJsonAsync().ConfigureAwait(true),
        "voiceSpeak" => await SpeakAsync(payload).ConfigureAwait(true),
        // Sessions hebergees (fenetre Conversations) : messages, arret, questions de l'agent, fermeture, console.
        "liveSend" => _live.Send(WithImages(payload)),
        "liveStop" => _live.Stop(Str(payload, "sessionId")),
        "liveAnswer" => _live.Answer(payload),
        "liveClose" => _live.Close(Str(payload, "sessionId")),
        "liveState" => _live.State(),
        "liveOpen" => OpenConversations(payload),
        "liveTerminal" => LiveToTerminal(payload),
        "convoMark" => MarkConvo(payload),
        // L'assistant dans la fenetre Conversations : la page principale le tient, la fenetre le montre.
        "assistantRemote" => RelayAssistantRemote(payload),
        "assistantView" => RelayAssistantView(payload),
        // Assistant : discussion hors terminal qui agit sur la file par les outils que la page execute.
        "assistantSend" => SendAssistant(WithImages(payload)),
        "assistantStop" => _assistant.Stop(),
        "assistantReset" => _assistant.Reset(),
        "assistantToolResult" => _assistant.ToolResult(payload),
        "assistantStatus" => _assistant.Status(),
        "assistantLoad" => await Task.Run(_assistant.Load).ConfigureAwait(true),
        "assistantSave" => await Task.Run(() => _assistant.Save(payload)).ConfigureAwait(true),
        // Revizator (H2) : persistance, menu du jour, generations par Claude.
        "learnLoad" => await Task.Run(() => _learning.Load()).ConfigureAwait(true),
        "learnSave" => await Task.Run(() => _learning.Save(payload)).ConfigureAwait(true),
        "learnDoc" => await LearnDocAsync(payload).ConfigureAwait(true),
        "learnDocSave" => await LearnDocSaveAsync(payload).ConfigureAwait(true),
        "learnDocDelete" => await LearnDocDeleteAsync(payload).ConfigureAwait(true),
        "learnNews" => await LearnNewsAsync(payload).ConfigureAwait(true),
        "learnGenerate" => await _learnAgent.GenerateAsync(payload).ConfigureAwait(true),
        "learnCancel" => new JsonObject { ["cancelled"] = _learnAgent.Cancel(Str(payload, "job")) },
        "learnJobs" => _learnAgent.Jobs(),
        "learnWait" => await _learnAgent.WaitAsync(Str(payload, "job")).ConfigureAwait(true),
        "ttsStatus" => await Task.Run(_tts.Status).ConfigureAwait(true),
        "ttsDownload" => await DownloadTtsAsync().ConfigureAwait(true),
        "ttsRemove" => new JsonObject { ["removed"] = await _tts.RemoveAsync().ConfigureAwait(true) },
        "ttsWarm" => WarmTts(payload),
        "speak" => await SpeakTtsAsync(payload).ConfigureAwait(true),
        "speakScript" => await SpeakScriptTtsAsync(payload).ConfigureAwait(true),
        "cancelSpeak" => new JsonObject { ["cancelled"] = _tts.Cancel(Str(payload, "job")) },
        "ttsClearCache" => await Task.Run(_tts.ClearCache).ConfigureAwait(true),
        // Transcription en direct (sherpa-onnx, Parakeet en pseudo-flux) : modele, sessions, paquets de PCM.
        "asrStatus" => await Task.Run(_asr.Status).ConfigureAwait(true),
        "asrDownload" => await _asr.DownloadAsync(Str(payload, "lang")).ConfigureAwait(true),
        "asrRemove" => new JsonObject { ["removed"] = await _asr.RemoveAsync(Str(payload, "lang")).ConfigureAwait(true) },
        "asrWarm" => WarmAsr(payload),
        "asrStart" => new JsonObject { ["session"] = await _asr.StartAsync(Str(payload, "lang")).ConfigureAwait(true) },
        "asrFeed" => FeedAsr(payload),
        "asrEnd" => new JsonObject { ["text"] = await _asr.EndAsync(Str(payload, "session")).ConfigureAwait(true) },
        "asrReset" => await ResetAsrAsync(payload).ConfigureAwait(true),
        "asrStop" => StopAsr(payload),
        "updateStatus" => _updater.Status(),
        "updateCheck" => await _updater.CheckAsync().ConfigureAwait(true),
        "updateInstall" => InstallUpdateNow(payload),
        "log" => LogFromWeb(payload),
        "perf" => RecordPerf(payload),
        _ => throw new InvalidOperationException($"Type de message inconnu : {type}"),
    };

    // ------------------------------------------------------------------- handlers

    private JsonNode GetState()
    {
        var settings = _store.LoadSettings();

        // Ce que l'hote sait de Bitbucket sans le reglage de l'utilisateur : les Reglages le disent
        // a cote du champ d'adresse (« detecte : ... »).
        var bitbucket = _bitbucket.Discover(null);

        return new JsonObject
        {
            ["data"] = _store.LoadData(),
            ["settings"] = JsonSerializer.SerializeToNode(settings, Json),
            ["env"] = new JsonObject
            {
                ["version"] = HostVersion,
                ["update"] = _updater.Status(),
                ["hasClaude"] = _launcher.HasClaude,
                ["hasCopilot"] = _launcher.HasCopilot,
                ["hasWt"] = _launcher.HasWt,
                ["defaultCwd"] = ResolveDefaultCwd(settings),
                ["dataDir"] = _store.DataDir,
                ["userProfile"] = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                ["repoDir"] = RepoDir.Value ?? "",
                ["bitbucketUrl"] = bitbucket?.Url ?? "",
                ["bitbucketSource"] = bitbucket?.Source ?? "",
                ["bitbucketToken"] = bitbucket?.Token is not null,
                ["jiraUrl"] = bitbucket?.JiraUrl ?? "",
                ["attachmentsDir"] = _attachments.Root,
                ["attachmentsUrl"] = "https://" + TaskAttachments.Host + "/",
                ["learnUrl"] = LearningStore.BaseUrl,
                ["whisper"] = _whisper.Status(),
                ["ttsUrl"] = "https://" + TextToSpeech.Host + "/",
                ["models"] = new JsonObject
                {
                    ["claude"] = _claudeCatalog.Current().ToJson(),
                    ["copilot"] = _copilotCatalog.Current().ToJson(),
                },
                ["efforts"] = new JsonObject
                {
                    ["claude"] = ToJsonArray(AgentProvider.ClaudeEfforts),
                    ["copilot"] = ToJsonArray(AgentProvider.CopilotEfforts),
                },
            },
        };
    }

    /// <summary>Quotas des deux agents ; sans <c>force</c>, une lecture de moins de deux minutes est rendue telle quelle.</summary>
    private async Task<JsonNode> GetUsageAsync(JsonObject payload)
    {
        var force = payload["force"] is JsonValue value && value.TryGetValue<bool>(out var flag) && flag;
        return await _usage.GetAsync(force, CancellationToken.None).ConfigureAwait(true);
    }

    /// <summary>PRs Bitbucket qui attendent l'avis de l'utilisateur ; voir <see cref="BitbucketPullRequests"/>.</summary>
    private async Task<JsonNode> GetPullRequestsAsync()
    {
        var settings = _store.LoadSettings();
        return await _bitbucket.FetchAsync(settings.BitbucketUrl, CancellationToken.None).ConfigureAwait(true);
    }

    private static JsonArray ToJsonArray(IEnumerable<string> values)
    {
        var array = new JsonArray();
        foreach (var value in values)
        {
            array.Add(JsonValue.Create(value));
        }

        return array;
    }

    private static string ResolveDefaultCwd(AppSettings settings)
        => string.IsNullOrWhiteSpace(settings.DefaultCwd)
            ? Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments)
            : settings.DefaultCwd;

    /// <summary>
    /// Dossier des sources d'Organizator : le premier parent de l'executable qui contient
    /// <c>Organizator.sln</c> (<c>publish\</c> comme <c>bin\</c> sont dans le depot). Propose
    /// comme dossier de travail quand l'utilisateur envoie ses remarques a un agent.
    /// </summary>
    private static readonly Lazy<string?> RepoDir = new(FindRepoDir);

    private static string? FindRepoDir()
    {
        try
        {
            var dir = Path.GetDirectoryName(Environment.ProcessPath);
            for (var depth = 0; dir is not null && depth < 8; depth++)
            {
                if (File.Exists(Path.Combine(dir, "Organizator.sln")))
                {
                    return dir;
                }

                dir = Path.GetDirectoryName(dir);
            }
        }
        catch (Exception)
        {
            // chemin de processus illisible : pas de proposition
        }

        return null;
    }

    private JsonNode SaveData(JsonObject payload)
    {
        _store.SaveData(payload);
        // La fenetre Conversations ne tient pas les donnees : elle les relit quand la page principale enregistre.
        if (_views.Count > 1)
        {
            PostEvent("dataChanged");
        }

        return new JsonObject();
    }

    private JsonNode SaveSettings(JsonObject payload)
    {
        AppSettings incoming;
        try
        {
            incoming = payload.Deserialize<AppSettings>(Json) ?? new AppSettings();
        }
        catch (Exception ex)
        {
            throw new InvalidOperationException("Reglages invalides : " + ex.Message);
        }

        _store.SaveSettings(incoming);
        return new JsonObject();
    }

    private JsonNode PickFolder(JsonObject payload)
    {
        var initial = Str(payload, "initial");
        var dialog = new Microsoft.Win32.OpenFolderDialog
        {
            Title = "Choisir le dossier de travail",
            Multiselect = false,
        };

        if (!string.IsNullOrWhiteSpace(initial) && Directory.Exists(initial))
        {
            dialog.InitialDirectory = initial;
        }

        var picked = dialog.ShowDialog(_owner) == true ? dialog.FolderName : null;
        return new JsonObject { ["path"] = picked is null ? null : JsonValue.Create(picked) };
    }

    /// <summary>
    /// Pieces jointes d'une tache : fichiers choisis dans le selecteur (<c>pick</c>), ou deposes et
    /// colles dans la page (chemins donnes par WebView2, voir <see cref="AdditionalFiles"/>). La copie
    /// se fait hors du fil de l'interface. <c>unresolved</c> donne le rang des objets deposes sans
    /// chemin : la page les renvoie par leur contenu (<c>pasteAttachment</c>).
    /// </summary>
    private async Task<JsonNode> AddAttachmentsAsync(JsonObject payload, CoreWebView2 view)
    {
        var taskId = Str(payload, "taskId");
        var sources = new List<string>();
        var unresolved = new JsonArray();

        if (payload["files"] is JsonArray files)
        {
            for (var i = 0; i < files.Count; i++)
            {
                if (files[i] is JsonValue value && value.TryGetValue<string>(out var path) && !string.IsNullOrWhiteSpace(path))
                {
                    sources.Add(path);
                }
                else
                {
                    unresolved.Add(i);
                }
            }
        }

        if (payload["paths"] is JsonArray paths)
        {
            foreach (var node in paths)
            {
                if (node is JsonValue value && value.TryGetValue<string>(out var path) && !string.IsNullOrWhiteSpace(path))
                {
                    sources.Add(path);
                }
            }
        }

        if (payload["pick"] is JsonValue pick && pick.TryGetValue<bool>(out var wanted) && wanted)
        {
            var dialog = new Microsoft.Win32.OpenFileDialog
            {
                Title = "Joindre des fichiers à la tâche",
                Multiselect = true,
                CheckFileExists = true,
            };

            if (dialog.ShowDialog(WindowOf(view)) != true)
            {
                return new JsonObject
                {
                    ["attachments"] = new JsonArray(),
                    ["skipped"] = new JsonArray(),
                    ["unresolved"] = unresolved,
                    ["cancelled"] = true,
                };
            }

            sources.AddRange(dialog.FileNames);
        }

        var result = await Task.Run(() => _attachments.AddFiles(taskId, sources)).ConfigureAwait(true);
        result["unresolved"] = unresolved;
        return result;
    }

    /// <summary>
    /// Images jointes a un message (fenetre Conversations) : seules restent les copies sous le dossier des
    /// pieces jointes — l'hote les lit pour les envoyer a l'agent.
    /// </summary>
    private JsonObject WithImages(JsonObject payload)
    {
        var kept = new JsonArray();
        if (payload["images"] is JsonArray list)
        {
            foreach (var node in list)
            {
                if (node is JsonValue value && value.TryGetValue<string>(out var path) && _attachments.Owned(path) is { } full)
                {
                    kept.Add(full);
                }
            }
        }

        payload["images"] = kept;
        return payload;
    }

    /// <summary>Image collee (ou fichier depose sans chemin) : contenu en base64, ecrit hors du fil de l'interface.</summary>
    private async Task<JsonNode> PasteAttachmentAsync(JsonObject payload)
    {
        var taskId = Str(payload, "taskId");
        var name = Str(payload, "name");
        var data = Str(payload, "data");
        return await Task.Run(() => _attachments.AddData(taskId, name, data)).ConfigureAwait(true);
    }

    // ------------------------------------------------------- dictee et transcription

    // La dictee arrive en WAV 16 kHz mono 16 bits, soit 32 Ko par seconde : dix minutes tiennent sous 20 Mo.
    private const int MaxDictationBytes = 48 * 1024 * 1024;

    /// <summary>Telecharge un modele Whisper depuis les Reglages ; l'avancement part par l'evenement <c>whisper</c>.</summary>
    private async Task<JsonNode> DownloadWhisperAsync(JsonObject payload)
    {
        var model = WhisperTranscriber.Find(Str(payload, "model")).Id;
        await _whisper.EnsureModelAsync(model, CancellationToken.None).ConfigureAwait(true);
        return _whisper.Status();
    }

    /// <summary>La dictee commence : le modele se telecharge ou se charge pendant que l'utilisateur parle.</summary>
    private JsonNode WarmWhisper(JsonObject payload)
    {
        _whisper.Warm(WhisperTranscriber.SanitizeModel(Str(payload, "model")));
        return new JsonObject();
    }

    /// <summary>
    /// Transcrit une dictee (<c>data</c> : WAV en base64, enregistre par la page) ou un enregistrement
    /// joint a une tache (<c>path</c>, sous le dossier des pieces jointes seulement). <c>job</c>
    /// identifie l'appel pour l'avancement et pour <c>cancelTranscribe</c>.
    /// Revizator : <c>detail</c> enrichit la reponse (mots, P(en), debit, pauses), <c>reference</c> (texte
    /// attendu, 2 000 caracteres au plus, implique <c>detail</c>) ajoute l'alignement, <c>keep</c> garde le WAV
    /// de la dictee sous <c>learning\audio\&lt;id&gt;.wav</c> et rend <c>id</c> et <c>url</c>, <c>accent: false</c>
    /// saute P(en).
    /// </summary>
    private async Task<JsonNode> TranscribeAsync(JsonObject payload)
    {
        var job = Str(payload, "job") ?? "";
        var model = WhisperTranscriber.SanitizeModel(Str(payload, "model"));
        var language = WhisperTranscriber.SanitizeLanguage(Str(payload, "language"));
        var path = Str(payload, "path");
        static bool Flag(JsonObject source, string name) => source[name] is JsonValue value && value.TryGetValue<bool>(out var flag) && flag;
        var reference = Limit(Str(payload, "reference"), 2000);
        var detail = Flag(payload, "detail") || reference.Length > 0;
        var keep = Flag(payload, "keep");
        // P(en) coute un passage d'encodeur de plus : accent = false le saute (tuteur, ou l'attente compte).
        var accent = payload["accent"] is not JsonValue accentValue || !accentValue.TryGetValue<bool>(out var accentOn) || accentOn;
        // Conversation vocale : contexte audio reduit a la phrase (WhisperTranscriber.QuickContext).
        var quick = Flag(payload, "quick");

        if (!string.IsNullOrWhiteSpace(path))
        {
            var full = Path.GetFullPath(path);
            var root = _attachments.Root.TrimEnd('\\', '/') + Path.DirectorySeparatorChar;
            if (!full.StartsWith(root, StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException("Seuls les enregistrements joints à une tâche se transcrivent.");
            }

            if (!File.Exists(full))
            {
                throw new InvalidOperationException("Enregistrement introuvable : " + Path.GetFileName(full));
            }

            return await _whisper.TranscribeAsync(job, ct => AudioDecoder.FromFile(full, ct), model, language,
                paragraphs: true, what: "enregistrement " + Path.GetFileName(full), detail, reference, accent).ConfigureAwait(true);
        }

        byte[] bytes;
        try
        {
            bytes = Convert.FromBase64String(Str(payload, "data") ?? "");
        }
        catch (FormatException)
        {
            throw new InvalidOperationException("Enregistrement illisible (base64 attendu).");
        }

        if (bytes.Length == 0)
        {
            throw new InvalidOperationException("Enregistrement vide.");
        }

        if (bytes.Length > MaxDictationBytes)
        {
            throw new InvalidOperationException("Dictée trop longue : joignez plutôt l'enregistrement à la tâche.");
        }

        var result = await _whisper.TranscribeAsync(job, ct => AudioDecoder.FromWav(bytes, ct), model, language,
            paragraphs: false, what: detail ? "dictee (detail)" : "dictee", detail, reference, accent, quick).ConfigureAwait(true);
        if (!keep)
        {
            return result;
        }

        // Enregistrement garde : le WAV recu tel quel, sous learning\audio\ (LearningStore), lu par la page
        // sous https://learn.organizator/audio/<id>.wav.
        try
        {
            var saved = await Task.Run(() => _learning.SaveAudio(bytes)).ConfigureAwait(true);
            result["id"] = saved["id"]?.GetValue<string>();
            result["url"] = saved["url"]?.GetValue<string>();
            _log.Info($"Revizator : enregistrement garde ({result["id"]}, {bytes.Length} octets)");
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or InvalidOperationException)
        {
            // La transcription reste : seul l'enregistrement n'est pas garde.
            _log.Warn("Revizator : enregistrement non garde : " + ex.Message);
            result["id"] = null;
            result["url"] = null;
            result["keepError"] = "Enregistrement non gardé : " + ex.Message;
        }

        return result;
    }

    // ------------------------------------------------------------- synthese vocale

    /// <summary>Telecharge les voix (runtime et modele) ; l'avancement part par l'evenement <c>tts</c>.</summary>
    private async Task<JsonNode> DownloadTtsAsync()
    {
        await _tts.EnsureModelAsync(CancellationToken.None).ConfigureAwait(true);
        return await Task.Run(_tts.Status).ConfigureAwait(true);
    }

    /// <summary>L'instance d'un accent se charge en arriere-plan, avant la premiere phrase.</summary>
    private JsonNode WarmTts(JsonObject payload)
    {
        _tts.Warm(Str(payload, "accent") ?? TextToSpeech.AccentUs);
        return new JsonObject();
    }

    /// <summary>
    /// Un texte dit par une voix ; chaque phrase est annoncee par l'evenement <c>tts</c> (<c>sentence</c>)
    /// des qu'elle est lisible sous <see cref="TextToSpeech.Host"/>. <c>job</c> sert a <c>cancelSpeak</c>.
    /// </summary>
    private async Task<JsonNode> SpeakTtsAsync(JsonObject payload)
        => await _tts.SpeakAsync(Str(payload, "job") ?? "", Str(payload, "text") ?? "", Str(payload, "voice") ?? "",
            TtsSpeed(payload)).ConfigureAwait(true);

    /// <summary>Un dialogue : synthetise et annonce dans l'ordre du script (<c>line</c> = <c>id</c> de la ligne).</summary>
    private async Task<JsonNode> SpeakScriptTtsAsync(JsonObject payload)
    {
        var lines = new List<TtsLine>();
        if (payload["lines"] is JsonArray array)
        {
            foreach (var item in array)
            {
                var line = item as JsonObject ?? new JsonObject();
                lines.Add(new TtsLine(
                    Str(line, "id") ?? lines.Count.ToString(System.Globalization.CultureInfo.InvariantCulture),
                    Str(line, "voice") ?? "",
                    Str(line, "text") ?? ""));
            }
        }

        var gapMs = int.TryParse(Str(payload, "gapMs"), System.Globalization.NumberStyles.Integer,
            System.Globalization.CultureInfo.InvariantCulture, out var gap) ? gap : 450;
        return await _tts.SpeakScriptAsync(Str(payload, "job") ?? "", lines, TtsSpeed(payload), gapMs).ConfigureAwait(true);
    }

    // --------------------------------------------------------- transcription en direct

    /// <summary>Le modele (unique, <c>lang</c> ignore) se charge en arriere-plan (libere apres 10 min sans usage).</summary>
    private JsonNode WarmAsr(JsonObject payload)
    {
        _asr.Warm(Str(payload, "lang"));
        return new JsonObject();
    }

    /// <summary>Un paquet de ~100 ms (base64 d'Int16 LE mono 16 kHz) : ajoute a l'enonce ; partiel recalcule (~600 ms) par l'evenement <c>asr</c>.</summary>
    private JsonNode FeedAsr(JsonObject payload)
    {
        _asr.Feed(Str(payload, "session"), Str(payload, "pcm"));
        return new JsonObject();
    }

    /// <summary>Enonce abandonne (bruit) : l'audio recu est oublie, la session reste ouverte.</summary>
    private async Task<JsonNode> ResetAsrAsync(JsonObject payload)
    {
        await _asr.ResetAsync(Str(payload, "session")).ConfigureAwait(true);
        return new JsonObject();
    }

    private JsonNode StopAsr(JsonObject payload)
    {
        _asr.Stop(Str(payload, "session"));
        return new JsonObject();
    }

    private static float TtsSpeed(JsonObject payload)
        => double.TryParse(Str(payload, "speed"), System.Globalization.NumberStyles.Float,
            System.Globalization.CultureInfo.InvariantCulture, out var speed) ? (float)speed : 1f;

    private async Task<JsonNode> StartSessionAsync(JsonObject payload)
    {
        if (_store.LoadSettings().Terminal == "app")
        {
            return await StartLiveAsync(payload).ConfigureAwait(true);
        }

        return StartSession(payload);
    }

    /// <summary>
    /// Reglage « Terminal » = app : la session est hebergee par Organizator (<see cref="LiveSessions"/>) avec
    /// les memes parametres qu'en console, et la fenetre Conversations s'ouvre dessus.
    /// </summary>
    private async Task<JsonNode> StartLiveAsync(JsonObject payload)
    {
        var provider = AgentProvider.Normalize(Str(payload, "provider"));
        var launch = new LiveLaunch(
            provider,
            Str(payload, "cwd") ?? "",
            Str(payload, "title") ?? "",
            Str(payload, "context") ?? "",
            AgentProvider.RequireModel(Str(payload, "model")),
            AgentProvider.RequireEffort(provider, Str(payload, "effort")));
        var started = await _live.StartAsync(launch, Str(payload, "prompt") ?? "").ConfigureAwait(true);
        ConversationsRequested?.Invoke(started.SessionId);
        return new JsonObject
        {
            ["sessionId"] = started.SessionId,
            ["cwd"] = started.Cwd,
            ["created"] = started.Created,
            ["provider"] = provider,
            ["model"] = launch.Model,
            ["effort"] = launch.Effort,
            ["window"] = "app",
        };
    }

    /// <summary>Montre la fenetre Conversations, sur une session si elle en nomme une : <c>{ sessionId? }</c>.</summary>
    private JsonNode OpenConversations(JsonObject payload)
    {
        ConversationsRequested?.Invoke(Str(payload, "sessionId"));
        return new JsonObject { ["shown"] = true };
    }

    /// <summary>
    /// Epingler ou archiver des conversations depuis la fenetre Conversations : <c>{ sessionIds, pinned?, archived? }</c>.
    /// Seule la page principale ecrit data.json (elle en tient la copie de travail) : la demande lui est
    /// relayee, et son enregistrement previent ensuite la fenetre Conversations (<c>dataChanged</c>).
    /// </summary>
    private JsonNode MarkConvo(JsonObject payload)
    {
        var ids = new JsonArray();
        if (payload["sessionIds"] is JsonArray list)
        {
            foreach (var item in list)
            {
                if (item is JsonValue value && value.TryGetValue<string>(out var id) && !string.IsNullOrWhiteSpace(id))
                {
                    ids.Add(id);
                }
            }
        }

        if (ids.Count == 0)
        {
            throw new InvalidOperationException("Conversation inconnue.");
        }

        var mark = new JsonObject { ["sessionIds"] = ids };
        foreach (var key in new[] { "pinned", "archived" })
        {
            if (payload[key] is JsonValue value && value.TryGetValue<bool>(out var flag))
            {
                mark[key] = flag;
            }
        }

        PostEventTo(_core, "convoMark", mark);
        return new JsonObject();
    }

    /// <summary>
    /// La fenetre Conversations montre aussi l'assistant, que seule la page principale tient (journal,
    /// outils, cartes) : ses demandes — envoyer, arreter, appliquer une carte… — sont relayees a celle-ci
    /// (evenement <c>assistantRemote</c>), qui revient devant quand la demande s'y joue (<c>front</c> :
    /// formulaire de lancement, tache montree dans la file, panneau, reglages).
    /// </summary>
    private JsonNode RelayAssistantRemote(JsonObject payload)
    {
        var request = (JsonObject)payload.DeepClone();
        request.Remove("files");
        if (request["front"] is JsonValue front && front.TryGetValue<bool>(out var wanted) && wanted)
        {
            BringOwnerToFront();
        }

        PostEventTo(_core, "assistantRemote", request);
        return new JsonObject();
    }

    /// <summary>Ce que la fenetre Conversations affiche de l'assistant, envoye par la page principale : aux autres vues.</summary>
    private JsonNode RelayAssistantView(JsonObject payload)
    {
        var view = (JsonObject)payload.DeepClone();
        view.Remove("files");
        var message = new JsonObject { ["event"] = "assistantView", ["payload"] = view };
        CoreWebView2[] others;
        lock (_views)
        {
            others = _views.Where(v => !ReferenceEquals(v, _core)).ToArray();
        }

        foreach (var other in others)
        {
            PostTo(other, message);
        }

        return new JsonObject();
    }

    /// <summary>
    /// « Ouvrir dans un terminal » depuis la fenetre Conversations : le processus heberge s'arrete et la
    /// session reprend dans une console (Windows Terminal s'il est la). Refuse pendant une reponse.
    /// </summary>
    private JsonNode LiveToTerminal(JsonObject payload)
    {
        var sessionId = Str(payload, "sessionId") ?? "";
        if (_live.State()["sessions"] is JsonArray all
            && all.OfType<JsonObject>().Any(s => (string?)s["sessionId"] == sessionId && (bool?)s["busy"] == true))
        {
            throw new InvalidOperationException("L'agent répond encore : arrêtez-le, ou attendez la fin de sa réponse.");
        }

        var known = _live.LaunchOf(sessionId);
        var provider = AgentProvider.Normalize(known?.Provider ?? Str(payload, "provider"));
        var cwd = known?.Cwd ?? Str(payload, "cwd") ?? "";
        var title = known?.Title ?? Str(payload, "title") ?? "";
        var model = AgentProvider.RequireModel(known?.Model ?? Str(payload, "model"));
        var effort = AgentProvider.RequireEffort(provider, known?.Effort ?? Str(payload, "effort"));
        _live.Close(sessionId);
        lock (_cacheLock)
        {
            _relaunchedAt[sessionId] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        }

        // Le contexte de Claude est deja enregistre dans la session ; celui de Copilot est dans son historique.
        var launched = _launcher.ResumeSession(provider, sessionId, cwd, title, "", "", model, effort, _launcher.HasWt ? "wt" : "powershell");
        if (launched is int terminalProcessId)
        {
            RememberTerminal(sessionId, terminalProcessId);
            _ = BringLaunchedForwardAsync(provider, sessionId, terminalProcessId);
        }

        return new JsonObject { ["terminal"] = true };
    }

    private JsonNode StartSession(JsonObject payload)
    {
        var provider = AgentProvider.Normalize(Str(payload, "provider"));
        var model = AgentProvider.RequireModel(Str(payload, "model"));
        var effort = AgentProvider.RequireEffort(provider, Str(payload, "effort"));
        var cwd = Str(payload, "cwd");
        var title = Str(payload, "title") ?? "";
        var context = Str(payload, "context") ?? "";
        var prompt = Str(payload, "prompt") ?? "";
        var terminal = _store.LoadSettings().Terminal;

        var started = _launcher.StartSession(provider, cwd ?? "", title, context, prompt, model, effort, terminal);
        if (started.TerminalProcessId is int terminalProcessId)
        {
            RememberTerminal(started.SessionId, terminalProcessId);
        }

        return new JsonObject
        {
            ["sessionId"] = started.SessionId,
            ["cwd"] = started.Cwd,
            ["created"] = started.Created,
            ["provider"] = provider,
            ["model"] = model,
            ["effort"] = effort,
        };
    }

    private async Task<JsonNode> ResumeSessionAsync(JsonObject payload)
    {
        var provider = AgentProvider.Normalize(Str(payload, "provider"));
        var model = AgentProvider.RequireModel(Str(payload, "model"));
        var effort = AgentProvider.RequireEffort(provider, Str(payload, "effort"));
        var sessionId = Str(payload, "sessionId") ?? "";
        var cwd = Str(payload, "cwd") ?? "";
        var title = Str(payload, "title") ?? "";
        var context = Str(payload, "context") ?? "";
        var prompt = Str(payload, "prompt") ?? "";
        // Second terminal demande expressement (bouton du toast) : la fenetre de la session vivante
        // est restee introuvable, et c'est l'utilisateur qui accepte deux agents sur la session.
        var force = payload["force"] is JsonValue value && value.TryGetValue<bool>(out var flag) && flag;
        var terminal = _store.LoadSettings().Terminal;

        // Reglage « fenetre Conversations », ou session deja hebergee : elle s'y ouvre (et y recoit le
        // message a remettre), sauf si une console la porte encore — c'est alors sa fenetre qu'on ramene.
        if ((terminal == "app" || _live.IsRunning(sessionId)) && !force)
        {
            // Le balayage a quelques secondes de retard : un agent mort entre-temps n'est plus une console.
            var consoles = _live.IsRunning(sessionId)
                ? Array.Empty<int>()
                : (_scanner?.PidsFor(sessionId) ?? Array.Empty<int>()).Where(AgentWindows.IsRunning).ToArray();
            if (consoles.Length == 0)
            {
                if (!_live.IsRunning(sessionId))
                {
                    // Comme une reprise en console : les agents d'avant ne comptent plus.
                    lock (_cacheLock)
                    {
                        _relaunchedAt[sessionId] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                    }
                }

                _live.Open(sessionId, new LiveLaunch(provider, cwd, title, context, model, effort));
                if (!string.IsNullOrWhiteSpace(prompt))
                {
                    _live.Send(new JsonObject { ["sessionId"] = sessionId, ["text"] = prompt });
                }

                ConversationsRequested?.Invoke(sessionId);
                return new JsonObject { ["focused"] = true, ["window"] = "app" };
            }
        }

        // Une session encore ouverte n'a pas besoin d'un second terminal : sa fenetre suffit. Un
        // second --resume y mettrait un second agent sur le meme fichier, puis un second onglet du
        // meme nom. Sauf s'il y a un message a lui remettre, que seule une reprise sait transmettre.
        if (string.IsNullOrWhiteSpace(prompt) && !force)
        {
            var (agents, justLaunched) = LiveAgents(sessionId);
            if (agents.Count > 0)
            {
                var focus = await FocusSessionAsync(provider, sessionId, agents, justLaunched).ConfigureAwait(true);
                if (focus.Focused)
                {
                    _log.Info($"Session {provider} deja ouverte : "
                        + (focus.Tab == TabOutcome.Activated ? "onglet active" : "fenetre ramenee au premier plan")
                        + (focus.Raised ? "" : " (premier plan refuse par Windows)")
                        + $" ({sessionId})");

                    return new JsonObject
                    {
                        ["focused"] = true,
                        // Faux : Windows a refuse, le bouton du terminal clignote dans la barre des taches.
                        ["raised"] = focus.Raised,
                        ["tabActivated"] = focus.Tab == TabOutcome.Activated,
                        // Vide quand la fenetre montre deja la session ; sinon l'onglet a activer soi-meme.
                        ["tab"] = TabToShow(focus, title),
                    };
                }

                // Le balayage a quelques secondes de retard : des agents morts entre-temps, c'est une
                // session qu'on vient de fermer, a rouvrir. Vivants, on ne les double pas.
                if (agents.Any(AgentWindows.IsRunning))
                {
                    _log.Warn($"Session {provider} deja ouverte, mais sa fenetre est introuvable : pas de second terminal ({sessionId})");
                    return new JsonObject { ["focused"] = false, ["alive"] = true };
                }
            }
        }

        // Session refermee qu'on rouvre : ses anciens agents ne travaillent plus (voir _relaunchedAt).
        // Une session encore vivante, elle, garde les siens : la reprise ne fait qu'y poser un message.
        if (_scanner?.IsAlive(sessionId) != true)
        {
            lock (_cacheLock)
            {
                _relaunchedAt[sessionId] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            }
        }

        var launched = _launcher.ResumeSession(provider, sessionId, cwd, title, context, prompt, model, effort, terminal);
        if (launched is int terminalProcessId)
        {
            RememberTerminal(sessionId, terminalProcessId);
            _ = BringLaunchedForwardAsync(provider, sessionId, terminalProcessId);
        }

        return new JsonObject { ["focused"] = false };
    }

    /// <summary>
    /// Processus qui portent la session, le plus recent d'abord : ceux du balayage, a defaut le
    /// PowerShell qu'on vient d'ouvrir pour elle (<c>launched</c>), dont la fenetre n'existe peut-etre
    /// pas encore. Une fois l'agent vu, ce PowerShell est oublie : il reste ouvert (-NoExit) apres
    /// que l'agent a quitte, il ne faut pas le prendre pour la session.
    /// </summary>
    private (IReadOnlyList<int> Agents, bool Launched) LiveAgents(string sessionId)
    {
        var scanned = _scanner?.PidsFor(sessionId) ?? Array.Empty<int>();
        if (scanned.Count > 0)
        {
            lock (_cacheLock)
            {
                _launchedTerminal.Remove(sessionId);
            }

            return (scanned, false);
        }

        return LaunchedTerminal(sessionId) is int terminal ? (new[] { terminal }, true) : (Array.Empty<int>(), false);
    }

    /// <summary>
    /// Ramene la premiere fenetre trouvee parmi ces processus — il y en a plusieurs quand la session
    /// a ete reprise alors qu'elle tournait. Chaque essai laisse une ligne <c>[FOCUS]</c> au journal :
    /// quelle fenetre, premier plan accepte ou non, onglet.
    /// </summary>
    private async Task<FocusResult> FocusSessionAsync(string provider, string sessionId, IReadOnlyList<int> agents, bool launched)
    {
        var focus = FocusResult.Missed;
        foreach (var agent in agents)
        {
            var started = Stopwatch.GetTimestamp();

            // Un terminal ouvert a l'instant n'a sa fenetre qu'apres 350 a 700 ms : un second clic
            // aussitot doit l'attendre, pas en ouvrir un autre.
            focus = launched
                ? await _windows.FocusWhenShownAsync(agent, TimeSpan.FromSeconds(3)).ConfigureAwait(true)
                : await _windows.TryFocusAsync(agent).ConfigureAwait(true);

            _log.Info($"[FOCUS] {provider} {sessionId} {(launched ? "terminal lance" : "agent")} #{agent}"
                + $" ({agents.Count} processus) : {FocusTrace(focus)}"
                + $" ({Stopwatch.GetElapsedTime(started).TotalMilliseconds:0} ms)");

            if (focus.Focused)
            {
                break;
            }
        }

        return focus;
    }

    private static string FocusTrace(FocusResult focus) => focus.Focused
        ? $"{focus.Window}, premier plan {(focus.Raised ? "accepte" : "refuse")}, onglet {focus.Tab}"
        : "fenetre introuvable";

    private void RememberTerminal(string sessionId, int terminalProcessId)
    {
        lock (_cacheLock)
        {
            _launchedTerminal[sessionId] = (terminalProcessId, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        }
    }

    /// <summary>Etat du balayage ; un agent vu vivant n'a plus besoin du terminal retenu a sa reprise.</summary>
    private bool? Alive(string sessionId)
    {
        // Une session hebergee par Organizator est vivante, meme si le balayage ne la voit pas (Copilot en ACP).
        if (_live.IsRunning(sessionId))
        {
            return true;
        }

        var alive = _scanner?.IsAlive(sessionId);
        if (alive == true)
        {
            lock (_cacheLock)
            {
                _launchedTerminal.Remove(sessionId);
            }
        }

        return alive;
    }

    /// <summary>PowerShell ouvert il y a peu pour cette session et toujours la, sinon null.</summary>
    private int? LaunchedTerminal(string sessionId)
    {
        (int ProcessId, long At) launched;
        lock (_cacheLock)
        {
            if (!_launchedTerminal.TryGetValue(sessionId, out launched))
            {
                return null;
            }

            if (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - launched.At > LaunchedTerminalMs)
            {
                _launchedTerminal.Remove(sessionId);
                return null;
            }
        }

        return AgentWindows.IsRunning(launched.ProcessId) ? launched.ProcessId : null;
    }

    /// <summary>
    /// Le terminal qu'on vient d'ouvrir peut naitre derriere Organizator (nouvel onglet d'une
    /// fenetre Windows Terminal deja ouverte) : on attend sa fenetre et on la ramene devant.
    /// </summary>
    private async Task BringLaunchedForwardAsync(string provider, string sessionId, int processId)
    {
        var started = Stopwatch.GetTimestamp();
        try
        {
            var focus = await _windows.FocusWhenShownAsync(processId, TimeSpan.FromSeconds(8)).ConfigureAwait(true);
            var elapsed = Stopwatch.GetElapsedTime(started).TotalMilliseconds;
            if (focus.Focused)
            {
                _log.Info($"Session {provider} reprise : fenetre "
                    + (focus.Raised ? "ramenee au premier plan" : "trouvee, premier plan refuse par Windows")
                    + $" apres {elapsed:0} ms, {focus.Window}, onglet {focus.Tab} ({sessionId})");
            }
            else
            {
                _log.Warn($"Session {provider} reprise : fenetre du terminal introuvable apres {elapsed:0} ms ({sessionId})");
            }
        }
        catch (Exception ex)
        {
            _log.Warn("Premier plan du terminal impossible : " + ex.Message);
        }
    }

    /// <summary>
    /// Nom de l'onglet que l'utilisateur doit activer lui-meme ; vide quand il n'y a rien a faire,
    /// parce que l'onglet de la session est deja devant ou que la fenetre n'en a pas.
    /// </summary>
    private static string TabToShow(FocusResult focus, string sessionTitle) => focus.Tab switch
    {
        TabOutcome.None or TabOutcome.Activated => "",

        // Le vrai nom de l'onglet quand il a ete lu ; sinon celui de la session, a defaut de mieux.
        _ when focus.TabTitle.Length > 0 => focus.TabTitle,
        _ => ShowsSession(focus.WindowTitle, sessionTitle) ? "" : sessionTitle,
    };

    /// <summary>
    /// Vrai si le titre de la fenetre porte celui de la session. Les agents reecrivent le titre du
    /// terminal a partir du nom de la session, en le prefixant et parfois en le tronquant : on
    /// compare donc sur un debut de titre, pas a l'identique.
    /// </summary>
    private static bool ShowsSession(string windowTitle, string sessionTitle)
    {
        var wanted = sessionTitle.Trim();
        if (wanted.Length == 0)
        {
            return true;
        }

        if (wanted.Length > 24)
        {
            wanted = wanted[..24];
        }

        return windowTitle.Contains(wanted, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// Redaction assistee : l'agent regle dans les Reglages ecrit le texte demande et le rend a
    /// l'interface, qui le propose a l'utilisateur. Rien n'est enregistre ici.
    /// </summary>
    private async Task<JsonNode> DraftTextAsync(JsonObject payload)
    {
        var settings = _store.LoadSettings();
        var provider = AgentProvider.Normalize(Str(payload, "provider") ?? settings.DraftProvider);
        var model = AgentProvider.RequireModel(Str(payload, "model") ?? settings.DraftModel);
        var effort = AgentProvider.RequireEffort(provider, Str(payload, "effort") ?? settings.DraftEffort);
        var system = Limit(Str(payload, "system"), 4000);
        var prompt = Limit(Str(payload, "prompt"), 4000);

        var result = await _draft.WriteAsync(provider, model, effort, system, prompt).ConfigureAwait(true);
        return new JsonObject
        {
            ["text"] = result.Text,
            ["ms"] = result.Ms,
            ["provider"] = provider,
            ["model"] = model,
        };
    }

    /// <summary>
    /// Article du jour ou veille IA (<c>kind</c>, voir <see cref="ArticleFeed"/>) : <c>peek</c> rend ce
    /// qui est garde sans rien lancer, <c>today</c> cherche un article s'il n'y en a pas encore pour
    /// aujourd'hui, <c>another</c> en cherche un autre. Modele et effort : ceux des Reglages, communs
    /// aux deux fils, sauf s'ils sont donnes.
    /// </summary>
    private async Task<JsonNode> GetArticleAsync(JsonObject payload)
    {
        var article = ArticleOf(payload);
        var mode = Str(payload, "mode") ?? "peek";
        if (mode == "peek")
        {
            return article.Peek();
        }

        var settings = _store.LoadSettings();
        var model = AgentProvider.RequireModel(Str(payload, "model") ?? settings.ArticleModel);
        var effort = AgentProvider.RequireEffort(AgentProvider.Claude, Str(payload, "effort") ?? settings.ArticleEffort);
        var interests = Str(payload, "interests") ?? "";
        return await article.GetAsync(mode == "another", interests, model, effort).ConfigureAwait(true);
    }

    /// <summary>Le fil designe par <c>kind</c> ; sans <c>kind</c>, l'article du jour.</summary>
    private DailyArticle ArticleOf(JsonObject payload)
    {
        var kind = Str(payload, "kind");
        if (string.IsNullOrEmpty(kind))
        {
            kind = ArticleFeed.Daily.Id;
        }

        return _articles.TryGetValue(kind, out var article)
            ? article
            : throw new InvalidOperationException("Fil d'articles inconnu : " + kind);
    }

    private static string Limit(string? value, int max)
    {
        var text = (value ?? "").Trim();
        return text.Length <= max ? text : text[..max];
    }

    /// <summary>
    /// Detection du catalogue d'un agent, en arriere-plan pour ne pas figer la fenetre : sonde ACP
    /// pour Copilot, <c>GET /v1/models</c> de l'API Anthropic pour Claude. <c>force: true</c> ignore
    /// le cache de 24 h. La reponse porte le catalogue sous le nom de l'agent.
    /// </summary>
    private async Task<JsonNode> RefreshModelsAsync(JsonObject payload)
    {
        var force = payload["force"] is JsonValue value && value.TryGetValue<bool>(out var flag) && flag;
        var provider = AgentProvider.Normalize(payload["provider"] is JsonValue name && name.TryGetValue<string>(out var text) ? text : null);
        var info = provider == AgentProvider.Copilot
            ? await Task.Run(() => _copilotCatalog.RefreshAsync(force, CancellationToken.None)).ConfigureAwait(true)
            : await Task.Run(() => _claudeCatalog.RefreshAsync(force, CancellationToken.None)).ConfigureAwait(true);
        return new JsonObject { [provider] = info.ToJson() };
    }

    /// <summary>
    /// L'interface signale une reponse arrivee : clignotement du bouton dans la barre des taches
    /// si la fenetre n'est pas au premier plan (le toast, lui, est affiche cote web).
    /// </summary>
    /// <summary>
    /// Une reponse est prete, une question attend : le bouton de la barre des taches clignote et, si
    /// la fenetre n'est pas au premier plan, chaque element de <c>toasts</c> devient une notification
    /// Windows (voir <see cref="WindowsToasts"/>). Devant la fenetre, le toast de la page suffit.
    /// </summary>
    private JsonNode Notify(JsonObject payload)
    {
        // Organizator est devant si l'une de ses fenetres l'est : dans la fenetre Conversations, la
        // reponse se voit deja (pastille de la liste, fil) ; ni clignotement ni notification Windows.
        if (!_owner.IsActive && Application.Current?.Windows.OfType<Window>().Any(w => w.IsActive) == true)
        {
            return new JsonObject { ["flashed"] = false, ["shown"] = 0 };
        }

        var flashed = TaskbarFlash.Flash(_owner);
        var shown = 0;
        if (!_owner.IsActive && payload["toasts"] is JsonArray toasts)
        {
            foreach (var item in toasts.OfType<JsonObject>().Take(3))
            {
                if (_toasts.Show(Str(item, "title") ?? "Organizator", Str(item, "body") ?? "", Str(item, "attribution") ?? "",
                    Str(item, "args") ?? "", Str(item, "tag") ?? Guid.NewGuid().ToString("N")))
                {
                    shown++;
                }
            }
        }

        return new JsonObject { ["flashed"] = flashed, ["shown"] = shown };
    }

    /// <summary>Notifications non lues : une pastille chiffree sur le bouton de la barre des taches.</summary>
    private JsonNode SetBadge(JsonObject payload)
    {
        var count = payload["count"] is JsonValue value && value.TryGetValue<int>(out var n) ? Math.Max(0, n) : 0;
        TaskbarBadge.Set(_owner, count);
        return new JsonObject();
    }

    /// <summary>La fenetre revient devant, restauree si elle etait reduite (agrandie si elle l'etait).</summary>
    private void BringOwnerToFront()
    {
        try
        {
            var handle = new System.Windows.Interop.WindowInteropHelper(_owner).Handle;
            if (_owner.WindowState == WindowState.Minimized && handle != IntPtr.Zero)
            {
                ShowWindow(handle, 9); // SW_RESTORE : retrouve l'etat d'avant la reduction
            }

            _owner.Show();
            _owner.Activate();
            _owner.Topmost = true;
            _owner.Topmost = false;
            if (handle != IntPtr.Zero)
            {
                SetForegroundWindow(handle);
            }
        }
        catch (Exception ex)
        {
            _log.Warn("Fenetre non ramenee au premier plan : " + ex.Message);
        }
    }

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr window, int command);

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr window);

    private SessionSummary Summarize(string provider, string sessionId, string cwd)
    {
        var key = provider + "|" + sessionId + "|" + cwd;
        var stamp = provider == AgentProvider.Copilot
            ? _copilot.GetStamp(sessionId)
            : _claude.GetStamp(sessionId, cwd);

        if (stamp.Length > 0)
        {
            lock (_cacheLock)
            {
                if (_summaryCache.TryGetValue(key, out var hit) && hit.Stamp == stamp)
                {
                    return hit.Summary;
                }
            }
        }

        var summary = provider == AgentProvider.Copilot
            ? _copilot.GetSummary(sessionId)
            : _claude.GetSummary(sessionId, cwd);

        if (stamp.Length > 0)
        {
            lock (_cacheLock)
            {
                _summaryCache[key] = (stamp, summary);
            }
        }

        return summary;
    }

    // Un agent qui vient de partir n'a pas encore forcement ecrit sa premiere ligne ; passe ce delai,
    // c'est son transcript qui dit s'il travaille toujours. Un agent silencieux depuis un quart
    // d'heure a fini sans le dire (fenetre fermee, coequipier arrete) : il ne compte plus.
    private const long AgentGraceMs = 3 * 60 * 1000;
    private const long AgentSilenceMs = 15 * 60 * 1000;

    /// <summary>
    /// Agents encore au travail. Le transcript de la session dit qui est parti et qui est revenu ;
    /// les transcripts des sous-agents disent qui ecrit encore. Sont ecartes ceux d'avant une relance
    /// de la session (elle a emporte son equipe) et ceux qui n'ecrivent plus depuis longtemps sans
    /// avoir annonce leur retour.
    /// </summary>
    private IReadOnlyList<AgentRun> ActiveAgents(string provider, string cwd, SessionSummary summary)
    {
        if (summary.Agents.Count == 0)
        {
            return summary.Agents;
        }

        long relaunched;
        lock (_cacheLock)
        {
            _relaunchedAt.TryGetValue(summary.SessionId, out relaunched);
        }

        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var subagents = provider == AgentProvider.Copilot
            ? null
            : _claude.ScanSubagents(summary.SessionId, cwd, now - AgentSilenceMs);

        var kept = new List<AgentRun>(summary.Agents.Count);
        foreach (var agent in summary.Agents)
        {
            if (agent.StartedAt < relaunched)
            {
                continue;
            }

            if (agent.StartedAt >= now - AgentGraceMs || subagents is null || WritesStill(subagents, agent))
            {
                kept.Add(agent);
            }
        }

        return kept;
    }

    /// <summary>
    /// L'agent ecrit-il encore ? Un coequipier est reconnu par son nom (celui de son
    /// <c>.meta.json</c>) ; une tache de fond, dont le transcript ne porte pas de nom, se contente
    /// de la vie du dossier.
    /// </summary>
    private static bool WritesStill(IReadOnlyList<SubagentActivity> subagents, AgentRun agent)
    {
        const string named = "agent:";
        if (!agent.Key.StartsWith(named, StringComparison.Ordinal))
        {
            return subagents.Count > 0;
        }

        var name = agent.Key[named.Length..];
        foreach (var subagent in subagents)
        {
            if (subagent.Name.Length == 0 || string.Equals(subagent.Name, name, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }

        return false;
    }

    private Transcript Transcribe(string provider, string sessionId, string cwd)
        => provider == AgentProvider.Copilot
            ? _copilot.GetTranscript(sessionId)
            : _claude.GetTranscript(sessionId, cwd);

    /// <summary>Sessions demandees par l'UI : <c>{ sessions: [{ sessionId, cwd, provider }] }</c>.</summary>
    private static List<(string Provider, string SessionId, string Cwd)> RequestedSessions(JsonObject payload)
    {
        var requested = new List<(string Provider, string SessionId, string Cwd)>();
        if (payload["sessions"] is JsonArray array)
        {
            foreach (var item in array)
            {
                if (item is not JsonObject entry)
                {
                    continue;
                }

                var sessionId = Str(entry, "sessionId");
                if (string.IsNullOrWhiteSpace(sessionId))
                {
                    continue;
                }

                requested.Add((AgentProvider.Normalize(Str(entry, "provider")), sessionId!, Str(entry, "cwd") ?? ""));
            }
        }

        return requested;
    }

    /// <summary>
    /// Empreinte des artefacts que l'UI detient deja, par session (<c>artifactsStamp</c>) : tant
    /// qu'elle n'a pas change, la liste ne repart pas. Elle pesait l'essentiel de la reponse
    /// (plus d'un millier de fichiers pour une soixantaine de sessions), a chaque relecture.
    /// </summary>
    private static Dictionary<string, string> KnownArtifactStamps(JsonObject payload)
    {
        var known = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        if (payload["sessions"] is JsonArray array)
        {
            foreach (var item in array)
            {
                if (item is JsonObject entry
                    && Str(entry, "sessionId") is { Length: > 0 } sessionId
                    && Str(entry, "artifactsStamp") is { Length: > 0 } stamp)
                {
                    known[sessionId] = stamp;
                }
            }
        }

        return known;
    }

    private async Task<JsonNode> GetSessionsAsync(JsonObject payload)
    {
        var requested = RequestedSessions(payload);
        var known = KnownArtifactStamps(payload);

        // Tout ce qui touche au disque se fait hors du fil de l'interface, y compris le releve des
        // sous-agents : le fil de l'interface est aussi celui qui laisse passer la frappe.
        var snapshots = await Task.Run(() =>
        {
            var list = new List<(SessionSummary Summary, string ArtifactsStamp, IReadOnlyList<AgentArtifact>? Artifacts, SessionUsage Usage, IReadOnlyList<AgentRun> Agents)>(requested.Count);
            foreach (var (provider, sessionId, cwd) in requested)
            {
                var summary = Summarize(provider, sessionId, cwd);
                var (stamp, artifacts, usage) = _artifacts.GetWithStamp(provider, sessionId, cwd);
                var unchanged = known.TryGetValue(sessionId, out var held) && held == stamp;
                list.Add((summary, stamp, unchanged ? null : artifacts, usage, ActiveAgents(provider, cwd, summary)));
            }

            return list;
        }).ConfigureAwait(true);

        var result = new JsonArray();
        foreach (var snapshot in snapshots)
        {
            var summary = snapshot.Summary;
            var agents = new JsonArray();
            foreach (var agent in snapshot.Agents)
            {
                agents.Add(agent.Label);
            }

            // L'equipe de la demande en cours, revenue ou non. Un agent sans retour annonce qui n'est
            // plus compte au travail (silencieux depuis longtemps, ou d'avant une relance) est « silent ».
            var crew = new JsonArray();
            foreach (var member in summary.Crew ?? Array.Empty<AgentRun>())
            {
                var running = member.FinishedAt == 0
                    && snapshot.Agents.Any(a => string.Equals(a.Key, member.Key, StringComparison.OrdinalIgnoreCase));
                crew.Add(new JsonObject
                {
                    ["label"] = member.Label,
                    ["about"] = member.About,
                    ["startedAt"] = member.StartedAt,
                    ["finishedAt"] = member.FinishedAt,
                    ["outcome"] = member.FinishedAt > 0 ? member.Outcome : running ? "" : "silent",
                    ["running"] = running,
                });
            }

            var entry = new JsonObject
            {
                ["sessionId"] = summary.SessionId,
                ["exists"] = summary.Exists,
                ["messageCount"] = summary.MessageCount,
                ["updated"] = summary.Updated,
                ["title"] = summary.Title,
                ["state"] = summary.State,
                ["stateTs"] = summary.StateTs,
                ["detail"] = summary.Detail,
                // Derniere parole de l'agent : sa reponse, ou la question qu'il pose.
                ["said"] = summary.Said,
                ["artifactsStamp"] = snapshot.ArtifactsStamp,
                // Agents lances par la session et pas encore revenus, par leur nom.
                ["agents"] = agents,
                // Agents de la demande en cours : nom, mission, depart, retour, etat.
                ["crew"] = crew,
                // true/false quand le balayage des processus a repondu, null sinon.
                ["alive"] = Alive(summary.SessionId),
            };

            // Absente quand l'UI detient deja la liste de cette empreinte ; la consommation suit la
            // meme regle (elle vient des memes transcripts).
            if (snapshot.Artifacts is not null)
            {
                var artifacts = new JsonArray();
                foreach (var artifact in snapshot.Artifacts)
                {
                    artifacts.Add(new JsonObject
                    {
                        ["path"] = artifact.Path,
                        ["action"] = artifact.Action,
                        ["tool"] = artifact.Tool,
                        // Sous-agent qui l'a ecrit ; vide pour la session elle-meme.
                        ["agent"] = artifact.Agent,
                        // Derniere citation dans une reponse finale de l'agent (ms), 0 sinon.
                        ["cited"] = artifact.Cited,
                    });
                }

                entry["artifacts"] = artifacts;
                entry["usage"] = UsageJson(snapshot.Usage);
            }

            result.Add(entry);
        }

        return new JsonObject { ["sessions"] = result };
    }

    /// <summary>Consommation d'une session pour l'UI : jetons, cout estime ($, 4 decimales), requetes premium.</summary>
    private static JsonObject UsageJson(SessionUsage usage)
    {
        var models = new JsonArray();
        foreach (var model in usage.Models)
        {
            models.Add(new JsonObject
            {
                ["model"] = model.Model,
                ["tokens"] = model.Tokens,
                ["cost"] = Math.Round(model.Cost, 4),
            });
        }

        return new JsonObject
        {
            ["input"] = usage.Input,
            ["output"] = usage.Output,
            ["cacheRead"] = usage.CacheRead,
            ["cacheWrite"] = usage.CacheWrite,
            ["cost"] = Math.Round(usage.Cost, 4),
            ["unpriced"] = usage.Unpriced,
            ["premium"] = usage.PremiumRequests,
            ["models"] = models,
        };
    }

    // Une reponse plus longue que cela n'est plus un recapitulatif ; l'UI raccourcit encore selon
    // la place dans le contexte (la ligne de commande qui le porte est bornee a 32 Ko).
    private const int RecapAnswerLength = 12000;

    /// <summary>
    /// Ce que chaque conversation a rendu, pour le resume du travail deja fait qu'une nouvelle
    /// conversation recoit : la derniere reponse complete de l'agent. Les rapports produits sont
    /// deja connus de l'UI (<c>convo.artifacts</c>).
    /// </summary>
    private async Task<JsonNode> GetRecapsAsync(JsonObject payload)
    {
        var requested = RequestedSessions(payload);

        var answers = await Task.Run(() =>
        {
            var list = new List<(string SessionId, string? Answer)>(requested.Count);
            foreach (var (provider, sessionId, cwd) in requested)
            {
                string? answer;
                try
                {
                    answer = provider == AgentProvider.Copilot
                        ? _copilot.GetLastAnswer(sessionId)
                        : _claude.GetLastAnswer(sessionId, cwd);
                }
                catch (Exception ex)
                {
                    _log.Warn($"Resume de la session {sessionId} impossible : {ex.Message}");
                    answer = null;
                }

                list.Add((sessionId, answer));
            }

            return list;
        }).ConfigureAwait(true);

        var result = new JsonArray();
        foreach (var (sessionId, answer) in answers)
        {
            var text = answer ?? "";
            if (text.Length > RecapAnswerLength)
            {
                text = text[..RecapAnswerLength].TrimEnd() + "\n[…]";
            }

            result.Add(new JsonObject
            {
                ["sessionId"] = sessionId,
                ["exists"] = answer is not null,
                ["answer"] = text,
            });
        }

        return new JsonObject { ["sessions"] = result };
    }

    private async Task<JsonNode> GetTranscriptAsync(JsonObject payload)
    {
        var provider = AgentProvider.Normalize(Str(payload, "provider"));
        var sessionId = Str(payload, "sessionId") ?? "";
        var cwd = Str(payload, "cwd") ?? "";

        var transcript = await Task.Run(() => Transcribe(provider, sessionId, cwd)).ConfigureAwait(true);

        var messages = new JsonArray();
        foreach (var message in transcript.Messages)
        {
            messages.Add(new JsonObject
            {
                ["role"] = message.Role,
                ["text"] = message.Text,
                ["ts"] = message.Ts,
            });
        }

        return new JsonObject
        {
            ["exists"] = transcript.Exists,
            ["title"] = transcript.Title,
            ["messages"] = messages,
        };
    }

    private JsonNode OpenPath(JsonObject payload)
    {
        var path = Str(payload, "path");
        if (string.IsNullOrWhiteSpace(path))
        {
            throw new InvalidOperationException("Aucun chemin fourni.");
        }

        string full;
        try
        {
            var rawPath = path!.Trim();
            var cwd = Str(payload, "cwd")?.Trim();
            full = Path.GetFullPath(
                Path.IsPathRooted(rawPath) || string.IsNullOrWhiteSpace(cwd)
                    ? rawPath
                    : Path.Combine(cwd!, rawPath));
        }
        catch
        {
            throw new InvalidOperationException("Chemin invalide : " + path);
        }

        if (!Directory.Exists(full) && !File.Exists(full))
        {
            throw new InvalidOperationException("Le chemin n'existe pas : " + full);
        }

        var editor = Str(payload, "editor");
        if (string.Equals(editor, "vscode", StringComparison.OrdinalIgnoreCase)
            && TryOpenInVisualStudioCode(full))
        {
            return new JsonObject { ["editor"] = "vscode" };
        }

        // Un fichier que le lecteur ne sait pas afficher (tableur, document Office...) part vers
        // l'application qui lui est associee ; sans association, l'Explorateur le montre.
        if (string.Equals(editor, "default", StringComparison.OrdinalIgnoreCase)
            && File.Exists(full)
            && TryOpenWithDefaultApp(full))
        {
            return new JsonObject { ["editor"] = "default" };
        }

        var arguments = Directory.Exists(full)
            ? $"\"{full}\""
            : $"/select,\"{full}\"";

        Process.Start(new ProcessStartInfo("explorer.exe", arguments) { UseShellExecute = true });
        return new JsonObject { ["editor"] = "explorer" };
    }

    private bool TryOpenWithDefaultApp(string path)
    {
        try
        {
            Process.Start(new ProcessStartInfo(path) { UseShellExecute = true });
            return true;
        }
        catch (Win32Exception ex)
        {
            _log.Warn("Aucune application associee a " + Path.GetFileName(path) + " : " + ex.Message);
            return false;
        }
        catch (InvalidOperationException ex)
        {
            _log.Warn("Ouverture de " + Path.GetFileName(path) + " impossible : " + ex.Message);
            return false;
        }
    }

    /// <summary>Un lien externe clique dans un rapport : navigateur ou client de messagerie par defaut.</summary>
    private JsonNode OpenUrl(JsonObject payload)
    {
        var url = Str(payload, "url")?.Trim();
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri)
            || uri.Scheme is not ("http" or "https" or "mailto"))
        {
            throw new InvalidOperationException("Adresse non ouvrable : " + url);
        }

        Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true });
        return new JsonObject { ["opened"] = true };
    }

    /// <summary>
    /// Lecture d'un artefact pour le lecteur de l'UI. Avec un <c>stamp</c> identique a l'empreinte
    /// courante du fichier, rien n'est relu ni renvoye : l'UI relit toutes les 2 s tant que le
    /// lecteur est ouvert, pour suivre un rapport encore en cours d'ecriture.
    /// </summary>
    private async Task<JsonNode> ReadArtifactAsync(JsonObject payload, CoreWebView2 view)
    {
        var path = Str(payload, "path");
        if (string.IsNullOrWhiteSpace(path))
        {
            throw new InvalidOperationException("Aucun chemin fourni.");
        }

        var cwd = Str(payload, "cwd");
        var known = Str(payload, "stamp") ?? "";
        var full = ArtifactReader.Resolve(path!, cwd);

        if (known.Length > 0 && TranscriptAccumulator.FileStamp(full) == known)
        {
            return new JsonObject { ["changed"] = false, ["stamp"] = known };
        }

        var read = await Task.Run(() => _reader.Read(full, cwd)).ConfigureAwait(true);

        // `peek` : lire sans servir le dossier (l'assistant verifie qu'un fichier existe avant de le montrer
        // ailleurs) — le lecteur ouvert dans cette vue garde le sien.
        var peek = payload["peek"] is JsonValue p && p.TryGetValue<bool>(out var only) && only;
        if (!peek && read.Kind is ArtifactReader.KindMarkdown or ArtifactReader.KindHtml
            or ArtifactReader.KindPdf or ArtifactReader.KindImage)
        {
            ServeReportRoot(view, read.Root);
        }

        return new JsonObject
        {
            ["changed"] = true,
            ["kind"] = read.Kind,
            ["full"] = read.Full,
            ["root"] = read.Root,
            ["url"] = read.Url,
            ["title"] = read.Title,
            ["stamp"] = read.Stamp,
            ["size"] = read.Size,
            ["modified"] = read.Modified,
            ["html"] = read.Html,
            ["review"] = ReviewJson(read.Review),
        };
    }

    /// <summary>Un fichier existant, designe par la page (chemin complet, ou relatif au dossier de travail).</summary>
    private static string ExistingFile(JsonObject payload)
    {
        var path = Str(payload, "path");
        if (string.IsNullOrWhiteSpace(path))
        {
            throw new InvalidOperationException("Aucun chemin fourni.");
        }

        var full = ArtifactReader.Resolve(path!, Str(payload, "cwd"));
        if (!File.Exists(full))
        {
            throw new InvalidOperationException(Directory.Exists(full) ? "C'est un dossier, pas un fichier : " + full : "Le fichier n'existe plus : " + full);
        }

        return full;
    }

    /// <summary>
    /// « Télécharger » un document du panneau de droite : le dialogue Enregistrer sous de Windows, ouvert
    /// sur le dossier Téléchargements, puis une copie (hors du fil de l'interface). Rend <c>{ saved }</c>
    /// (chemin de la copie) ou <c>{ cancelled }</c>.
    /// </summary>
    private async Task<JsonNode> SaveFileAsAsync(JsonObject payload, CoreWebView2 view)
    {
        var full = ExistingFile(payload);
        var name = Path.GetFileName(full);
        var ext = Path.GetExtension(full);
        var dialog = new Microsoft.Win32.SaveFileDialog
        {
            Title = "Télécharger « " + name + " »",
            FileName = name,
            InitialDirectory = DownloadsFolder(),
            Filter = (ext.Length > 1 ? "Fichier " + ext.TrimStart('.').ToUpperInvariant() + "|*" + ext + "|" : "") + "Tous les fichiers|*.*",
            DefaultExt = ext,
            AddExtension = ext.Length > 1,
            OverwritePrompt = true,
        };

        if (dialog.ShowDialog(WindowOf(view)) != true)
        {
            return new JsonObject { ["cancelled"] = true };
        }

        var target = Path.GetFullPath(dialog.FileName);
        if (!string.Equals(target, full, StringComparison.OrdinalIgnoreCase))
        {
            await Task.Run(() => File.Copy(full, target, overwrite: true)).ConfigureAwait(true);
        }

        _log.Info($"Document telecharge : {full} -> {target}");
        return new JsonObject { ["saved"] = target };
    }

    /// <summary>
    /// « Supprimer » un document du panneau de droite : il part a la Corbeille (la page a demande
    /// confirmation). Rend <c>{ removed }</c> — faux si Windows, ne pouvant le mettre a la Corbeille,
    /// a demande et que l'utilisateur a refuse.
    /// </summary>
    private JsonNode RecycleFile(JsonObject payload, CoreWebView2 view)
    {
        var full = ExistingFile(payload);
        var removed = RecycleBin.Send(full, new System.Windows.Interop.WindowInteropHelper(WindowOf(view)).Handle);
        if (removed)
        {
            _log.Info("Document envoye a la Corbeille : " + full);
        }

        return new JsonObject { ["removed"] = removed };
    }

    [System.Runtime.InteropServices.DllImport("shell32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
    private static extern int SHGetKnownFolderPath(ref Guid folder, uint flags, IntPtr token, out IntPtr path);

    /// <summary>Le dossier Téléchargements de l'utilisateur (il peut avoir ete deplace), a defaut ses Documents.</summary>
    private static string DownloadsFolder()
    {
        var downloads = new Guid("374DE290-123F-4565-9164-39C4925E467B");
        try
        {
            if (SHGetKnownFolderPath(ref downloads, 0, IntPtr.Zero, out var raw) == 0)
            {
                try
                {
                    var path = System.Runtime.InteropServices.Marshal.PtrToStringUni(raw);
                    if (!string.IsNullOrEmpty(path) && Directory.Exists(path))
                    {
                        return path;
                    }
                }
                finally
                {
                    System.Runtime.InteropServices.Marshal.FreeCoTaskMem(raw);
                }
            }
        }
        catch (Exception)
        {
            // Rien de grave : les Documents font l'affaire.
        }

        return Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
    }

    /// <summary>
    /// Question sur un constat de revue (voir <see cref="FindingChat"/>) : la premiere part dans une
    /// copie de la session du relecteur (<c>source</c>), les suivantes la reprennent. Modele et effort :
    /// ceux de la session copiee, choisis par l'UI. Rend la discussion a jour ; l'avancement arrive
    /// entre-temps par l'evenement <c>findingChat</c>.
    /// </summary>
    private async Task<JsonNode> AskFindingAsync(JsonObject payload)
    {
        var finding = payload["finding"] as JsonObject ?? new JsonObject();
        var order = finding["order"] is JsonValue o && o.TryGetValue<int>(out var index) ? index : -1;
        var ask = new FindingQuestion(
            Report: Str(payload, "report") ?? "",
            Finding: Str(finding, "key") ?? "",
            FindingId: Limit(Str(finding, "id"), 40),
            Order: order,
            Title: Limit(Str(finding, "title"), 300),
            Severity: Limit(Str(finding, "severity"), 16),
            Where: Limit(Str(finding, "where"), 1200),
            Category: Limit(Str(finding, "category"), 60),
            SourceSessionId: Guid.TryParse(Str(payload, "source"), out var source) ? source.ToString("D") : "",
            Cwd: Str(payload, "cwd") ?? "",
            Model: AgentProvider.RequireModel(Str(payload, "model")),
            Effort: AgentProvider.RequireEffort(AgentProvider.Claude, Str(payload, "effort")),
            Context: Str(payload, "context") ?? "",
            Question: Str(payload, "question") ?? "");
        return await _findings.AskAsync(ask).ConfigureAwait(true);
    }

    /// <summary>Constats d'un rapport de revue, pour l'inventaire plein ecran de l'UI ; <c>null</c> sinon.</summary>
    private static JsonNode? ReviewJson(ReviewSummary? review)
    {
        if (review is null)
        {
            return null;
        }

        var findings = new JsonArray();
        foreach (var finding in review.Findings)
        {
            var tags = new JsonArray();
            foreach (var tag in finding.Tags)
            {
                tags.Add(tag);
            }

            findings.Add(new JsonObject
            {
                ["id"] = finding.Id,
                ["severity"] = finding.Severity,
                ["title"] = finding.Title,
                ["category"] = finding.Category,
                ["where"] = finding.Where,
                ["tags"] = tags,
                ["html"] = finding.Html,
            });
        }

        return new JsonObject
        {
            ["verdict"] = review.Verdict,
            ["level"] = review.Level,
            ["findings"] = findings,
        };
    }

    /// <summary>
    /// Sert le dossier du rapport courant sous <c>https://report.organizator/</c>, dans la vue qui le
    /// lit : c'est ce qui permet au lecteur d'afficher un PDF, une page ou une image, et au Markdown de
    /// trouver ses images relatives. Un seul dossier a la fois par vue ; il change avec le rapport
    /// ouvert. Sur le fil de l'interface, comme tout appel a la WebView.
    /// </summary>
    private void ServeReportRoot(CoreWebView2 view, string root)
    {
        if (_reportRoots.TryGetValue(view, out var served))
        {
            if (string.Equals(served, root, StringComparison.OrdinalIgnoreCase))
            {
                return;
            }

            try
            {
                view.ClearVirtualHostNameToFolderMapping(ArtifactReader.Host);
            }
            catch (Exception ex)
            {
                _log.Warn("Retrait de l'hote virtuel des rapports impossible : " + ex.Message);
            }
        }

        // DenyCors : images, cadres et PDF se chargent, mais aucun script ne peut lire ces fichiers par fetch.
        view.SetVirtualHostNameToFolderMapping(ArtifactReader.Host, root, CoreWebView2HostResourceAccessKind.DenyCors);
        _reportRoots[view] = root;
        _log.Info("Rapports servis depuis " + root + (ReferenceEquals(view, _core) ? "" : " (fenetre Conversations)"));
    }

    private bool TryOpenInVisualStudioCode(string path)
    {
        var command = FindVisualStudioCode();
        if (command is null)
        {
            _log.Warn("Visual Studio Code introuvable, ouverture de l'artefact dans l'Explorateur.");
            return false;
        }

        var arguments = Directory.Exists(path)
            ? "--reuse-window " + QuoteProcessArgument(path)
            : "--reuse-window --goto " + QuoteProcessArgument(path);

        try
        {
            Process.Start(new ProcessStartInfo(command, arguments) { UseShellExecute = true });
            return true;
        }
        catch (Win32Exception ex)
        {
            _log.Warn("Ouverture dans Visual Studio Code impossible : " + ex.Message);
            return false;
        }
        catch (InvalidOperationException ex)
        {
            _log.Warn("Ouverture dans Visual Studio Code impossible : " + ex.Message);
            return false;
        }
    }

    private static string? FindVisualStudioCode()
    {
        var names = new[] { "code.cmd", "code.exe", "code-insiders.cmd", "code-insiders.exe" };
        var path = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (var part in path.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
        {
            var directory = part.Trim().Trim('"');
            foreach (var name in names)
            {
                var candidate = Path.Combine(directory, name);
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }
        }

        var roots = new[]
        {
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
        };
        foreach (var root in roots.Where(value => !string.IsNullOrWhiteSpace(value)))
        {
            foreach (var name in names)
            {
                var candidate = Path.Combine(root, "Programs", "Microsoft VS Code", "bin", name);
                if (File.Exists(candidate))
                {
                    return candidate;
                }

                candidate = Path.Combine(root, "Microsoft VS Code", "bin", name);
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }
        }

        return null;
    }

    private static string QuoteProcessArgument(string value)
        => "\"" + value.Replace("\"", "\\\"", StringComparison.Ordinal) + "\"";

    // ------------------------------------------------------------- conversation vocale

    /// <summary>
    /// Ouvre une conversation vocale (voir <see cref="VoiceChat"/>) : chaque champ absent prend la valeur
    /// des reglages. <c>mode</c> : <c>free</c> (defaut) ou <c>tutor</c>, avec <c>tutor</c> =
    /// <c>{ scenario, level, lang, explain, lesson, context, history }</c> ; <c>name</c> : nom de la session.
    /// Le processus claude demarre en arriere-plan ; les reponses arrivent par l'evenement <c>voice</c>.
    /// </summary>
    private JsonNode StartVoice(JsonObject payload)
    {
        var settings = _store.LoadSettings();

        // Mode tutor (Revizator) : le prompt vient du tuteur (TutorGenre), sans consignes libres ; le web seulement
        // pour une seance au long cours (tutor.long) qui le demande (web: true).
        var mode = VoiceChat.SanitizeMode(Str(payload, "mode"));
        var tutor = mode == VoiceChat.TutorMode ? (payload["tutor"] as JsonObject)?.DeepClone() as JsonObject ?? new JsonObject() : null;
        var options = new VoiceOptions(
            Model: AgentProvider.RequireModel(Str(payload, "model") ?? settings.VoiceModel),
            Effort: AgentProvider.RequireEffort(AgentProvider.Claude, Str(payload, "effort") ?? settings.VoiceEffort),
            Persona: VoiceChat.SanitizePersona(Str(payload, "persona") ?? settings.VoicePersona),
            Topic: VoiceChat.SanitizeTopic(Str(payload, "topic") ?? settings.VoiceTopic),
            Instructions: tutor is null ? Limit(Str(payload, "instructions") ?? settings.VoiceInstructions, 2000) : "",
            Web: tutor is null
                ? payload["web"] is JsonValue web && web.TryGetValue<bool>(out var allowed) ? allowed : settings.VoiceWeb
                : TutorGenre.IsLong(tutor) && payload["web"] is JsonValue tutorWeb && tutorWeb.TryGetValue<bool>(out var tutorAllowed) && tutorAllowed,
            Mode: mode,
            Tutor: tutor,
            Name: VoiceChat.SanitizeName(Str(payload, "name")));
        return new JsonObject { ["conversationId"] = _voice.Start(options) };
    }

    /// <summary>
    /// Message a l'assistant (voir <see cref="AssistantChat"/>) : modele et effort absents = ceux des
    /// reglages. La reponse arrive par l'evenement <c>assistant</c>.
    /// </summary>
    private JsonNode SendAssistant(JsonObject payload)
    {
        var settings = _store.LoadSettings();
        payload["model"] ??= settings.AssistantModel;
        payload["effort"] ??= settings.AssistantEffort;
        return _assistant.Send(payload);
    }

    private JsonNode InterruptVoice(JsonObject payload)
    {
        _voice.Interrupt(Str(payload, "conversationId"), Str(payload, "heard"));
        return new JsonObject();
    }

    private JsonNode StopVoice(JsonObject payload)
    {
        _voice.Stop(Str(payload, "conversationId"));
        return new JsonObject();
    }

    /// <summary>Synthese d'une phrase en WAV, sur le fil STA de <see cref="SpeechVoice"/> : <c>{ audio, ms }</c>.</summary>
    private async Task<JsonNode> SpeakAsync(JsonObject payload)
    {
        var rate = payload["rate"] is JsonValue value
            ? value.TryGetValue<int>(out var whole) ? whole
            : value.TryGetValue<double>(out var real) && double.IsFinite(real) ? (int)Math.Round(Math.Clamp(real, -10, 10))
            : 0
            : _store.LoadSettings().VoiceRate;
        var voice = Str(payload, "voice");
        if (string.IsNullOrWhiteSpace(voice))
        {
            voice = _store.LoadSettings().VoiceVoice;
        }

        return await _speech.SpeakJsonAsync(Str(payload, "text"), voice, Math.Clamp(rate, -10, 10)).ConfigureAwait(true);
    }

    private JsonNode LogFromWeb(JsonObject payload)
    {
        _log.FromWeb(Str(payload, "level"), Str(payload, "message"));
        return new JsonObject();
    }

    /// <summary>Mesures de l'interface web (taches longues, saisies lentes, rendus) pour le bilan de <see cref="PerfMonitor"/>.</summary>
    private JsonNode RecordPerf(JsonObject payload)
    {
        _perf?.RecordWeb(payload);
        return new JsonObject();
    }

    // ------------------------------------------------------------- Revizator (H2)

    /// <summary><c>learnDoc</c> : <c>{ kind, id }</c> -> <c>{ doc }</c>, <c>null</c> si le document n'existe pas.</summary>
    private async Task<JsonNode> LearnDocAsync(JsonObject payload)
    {
        var kind = Str(payload, "kind");
        var id = Str(payload, "id");
        var doc = await Task.Run(() => _learning.ReadDoc(kind, id)).ConfigureAwait(true);
        return new JsonObject { ["doc"] = doc };
    }

    /// <summary><c>learnDocSave</c> : <c>{ kind, id, doc }</c> -> <c>{}</c> ; l'UI met a jour un document (reponses d'un bilan...).</summary>
    private async Task<JsonNode> LearnDocSaveAsync(JsonObject payload)
    {
        var kind = Str(payload, "kind");
        var id = Str(payload, "id");
        if (payload["doc"] is not JsonObject doc)
        {
            throw new InvalidOperationException("Document absent ou invalide : un objet JSON est attendu.");
        }

        await Task.Run(() => _learning.WriteDoc(kind, id, doc)).ConfigureAwait(true);
        return new JsonObject();
    }

    /// <summary><c>learnDocDelete</c> : <c>{ kind, id }</c> -> <c>{ removed }</c>.</summary>
    private async Task<JsonNode> LearnDocDeleteAsync(JsonObject payload)
    {
        var kind = Str(payload, "kind");
        var id = Str(payload, "id");
        var removed = await Task.Run(() => _learning.DeleteDoc(kind, id)).ConfigureAwait(true);
        return new JsonObject { ["removed"] = removed };
    }

    /// <summary><c>learnNews</c> : <c>{ force? }</c> -> menu RSS du jour (cache de 30 minutes, voir <see cref="NewsMenu"/>).</summary>
    private async Task<JsonNode> LearnNewsAsync(JsonObject payload)
    {
        var force = payload["force"] is JsonValue value && value.TryGetValue<bool>(out var flag) && flag;
        return await _learnNews.GetAsync(force).ConfigureAwait(true);
    }

    // -------------------------------------------------------------------- helpers

    private static string? Str(JsonObject payload, string name)
    {
        if (!payload.TryGetPropertyValue(name, out var node) || node is null)
        {
            return null;
        }

        return node is JsonValue value && value.TryGetValue<string>(out var text)
            ? text
            : node.ToString();
    }
}
