using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using Organizator.Services;

namespace Revizator.Server;

/// <summary>
/// Le pont de la page, cote serveur : meme protocole et memes gestionnaires que <c>BridgeHost</c> de
/// l'hote WPF (memes noms de champs, memes reponses), restreint aux types de Revizator (§ 4 du contrat).
/// Tout autre type est refuse : il n'existe ici aucun gestionnaire pour les taches, sessions, pieces
/// jointes, articles ou quotas. Chaque compte a son espace (<see cref="UserSpaces"/>) : ses donnees, ses
/// generations et leurs evenements ne vont qu'a ses propres connexions (<see cref="Broadcast"/>) ; les voix, la
/// reconnaissance et Whisper sont communs, leurs evenements vont au compte qui a lance le travail.
/// </summary>
public sealed class ServerBridge : IDisposable
{
    private static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
    };

    /// <summary>Types acceptes ; tout autre recoit <see cref="Unavailable"/>.</summary>
    public static readonly IReadOnlySet<string> AllowedTypes = new HashSet<string>(StringComparer.Ordinal)
    {
        // Revizator
        "learnLoad", "learnSave", "learnDoc", "learnDocSave", "learnDocDelete", "learnNews",
        "learnGenerate", "learnCancel", "learnJobs", "learnWait", "learnBoard",
        // voix anglaises
        "ttsStatus", "ttsDownload", "ttsRemove", "ttsWarm", "speak", "speakScript", "cancelSpeak", "ttsClearCache",
        // reconnaissance
        "whisperStatus", "whisperDownload", "whisperRemove", "whisperWarm", "transcribe", "cancelTranscribe",
        "asrStatus", "asrDownload", "asrRemove", "asrWarm", "asrStart", "asrFeed", "asrEnd", "asrReset", "asrStop",
        // conversation a voix haute
        "voiceStart", "voiceSay", "voiceInterrupt", "voiceStop", "voiceVoices", "voiceSpeak",
        // journal, notifications, etat de la page en mode serveur
        "log", "perf", "notify", "getState", "saveSettings",
    };

    public const string Unavailable = "Type de message non disponible sur le serveur Révizator";

    // La dictee arrive en WAV 16 kHz mono 16 bits, soit 32 Ko par seconde : dix minutes tiennent sous 20 Mo.
    private const int MaxDictationBytes = 48 * 1024 * 1024;

    private readonly ServerConfig _config;
    private readonly HostLog _log;
    private readonly DataStore _store;
    private readonly AgentLauncher _launcher;
    private readonly UserSpaces _spaces;
    private readonly Leaderboard _board;
    private readonly TextToSpeech _tts;
    private readonly LiveAsr _asr;
    private readonly WhisperTranscriber _whisper;
    private readonly VoiceChat _voice;

    // Compte qui a lance un travail des services communs (job de voix ou de transcription, session de
    // reconnaissance, conversation) : ses evenements ne vont qu'a lui. Purge des plus anciens au-dela de 4 000.
    private readonly System.Collections.Concurrent.ConcurrentDictionary<string, (string Login, long At)> _owners = new(StringComparer.Ordinal);

    /// <summary>
    /// Envoi d'un evenement aux connexions du compte <c>login</c> (toutes si null), sauf <c>except</c>
    /// (connexion d'origine).
    /// </summary>
    public Action<JsonObject, object?, string?>? Broadcast { get; set; }

    public ServerBridge(ServerConfig config, HostLog log, Func<IReadOnlyList<UserAccount>> accounts)
    {
        _config = config;
        _log = log;
        _store = new DataStore(config.DataDir, log);
        _launcher = new AgentLauncher(_store, log);
        // Memes services et memes evenements que BridgeHost (learn, tts, asr, voice, whisper).
        _whisper = new WhisperTranscriber(config.DataDir, log, ServerConfig.Version);
        _whisper.Progress += payload => PostOwned("whisper", payload, "job");
        _voice = new VoiceChat(_launcher, log, config.DataDir);
        _voice.Progress += payload => PostOwned("voice", payload, "conversationId");
        _spaces = new UserSpaces(config.DataDir, accounts, CreateSpace, log);
        _board = new Leaderboard(config.DataDir, accounts, log);
        var sherpa = new SherpaRuntime(config.DataDir, log, ServerConfig.Version);
        _tts = new TextToSpeech(config.DataDir, log, ServerConfig.Version, sherpa);
        _tts.Progress += payload => PostOwned("tts", payload, "job");
        _asr = new LiveAsr(config.DataDir, log, ServerConfig.Version, sherpa);
        _asr.Progress += payload => PostOwned("asr", payload, "session");
    }

    /// <summary>L'espace d'un compte : son <c>learning.json</c>, son dossier <c>learning/</c>, son agent.</summary>
    private UserSpace CreateSpace(string login, string dir)
    {
        var learning = new LearningStore(dir, _log);
        var news = new NewsMenu(learning, _log);
        var agent = new LearningAgent(_launcher, learning, news, _log, dir);
        agent.Progress += payload => PostEvent("learn", payload, login: login);
        return new UserSpace { Login = login, Dir = dir, Learning = learning, News = news, Agent = agent };
    }

    /// <summary>Dossier <c>learning/</c> d'un compte, servi sous <c>/learn/</c>.</summary>
    public string LearningRootOf(string login) => _spaces.Get(login).Learning.Root;

    /// <summary>Cache des phrases synthetisees, servi sous <c>/tts/</c>.</summary>
    public string TtsCacheRoot => _tts.CacheRoot;

    public bool HasClaude => _launcher.HasClaude;

    public void Dispose()
    {
        try
        {
            _voice.Dispose();
            _asr.Dispose();
        }
        catch (Exception ex)
        {
            _log.Warn("Arret de la conversation vocale incomplet : " + ex.Message);
        }
    }

    public void PostEvent(string name, JsonObject? payload = null, object? except = null, string? login = null)
    {
        var message = new JsonObject
        {
            ["event"] = name,
            ["payload"] = payload ?? new JsonObject(),
        };

        try
        {
            Broadcast?.Invoke(message, except, login);
        }
        catch (Exception ex)
        {
            Debug.WriteLine("[Revizator] evenement non diffuse : " + ex.Message);
        }
    }

    /// <summary>
    /// Evenement d'un service commun : au compte qui a lance le travail designe par <c>payload[key]</c>, a
    /// tous si le travail n'a pas de proprietaire connu (telechargement d'un modele, par exemple).
    /// </summary>
    private void PostOwned(string name, JsonObject payload, string key)
    {
        var id = payload[key] is JsonValue value && value.TryGetValue<string>(out var text) ? text : null;
        string? login = null;
        if (!string.IsNullOrEmpty(id) && _owners.TryGetValue(name + ":" + id, out var owner))
        {
            login = owner.Login;
        }

        PostEvent(name, payload, login: login);
    }

    /// <summary>Retient le compte qui lance le travail <paramref name="id"/> d'un service commun.</summary>
    private void Own(string service, string? id, string login)
    {
        if (string.IsNullOrEmpty(id))
        {
            return;
        }

        var now = Environment.TickCount64;
        _owners[service + ":" + id] = (login, now);
        if (_owners.Count > 4000)
        {
            foreach (var old in _owners.OrderBy(o => o.Value.At).Take(1000).Select(o => o.Key).ToList())
            {
                _owners.TryRemove(old, out _);
            }
        }
    }

    // ------------------------------------------------------------------ reception

    /// <summary>
    /// Traite un message texte <c>{ id, type, payload }</c> et rend la reponse a envoyer (null : rien a
    /// repondre). La partie synchrone d'un gestionnaire s'execute avant le premier <c>await</c> : appele
    /// dans l'ordre de reception, les paquets <c>asrFeed</c> arrivent dans l'ordre, comme sous WebView2.
    /// </summary>
    public async Task<JsonObject?> HandleAsync(string raw, object connection, string login)
    {
        JsonNode? id = null;
        string? type = null;
        try
        {
            JsonObject? envelope;
            try
            {
                envelope = JsonNode.Parse(raw) as JsonObject;
            }
            catch (JsonException)
            {
                envelope = null;
            }

            if (envelope is null)
            {
                _log.Warn("Message web ignore (ce n'est pas un objet JSON).");
                return null;
            }

            id = envelope["id"]?.DeepClone();
            type = envelope["type"] is JsonValue t && t.TryGetValue<string>(out var text) ? text : null;
            var payload = envelope["payload"] as JsonObject ?? new JsonObject();
            // Pas de fichiers joints par chemin hors de WebView2 : meme forme que BridgeHost, vide.
            payload["files"] = new JsonArray();

            if (string.IsNullOrWhiteSpace(type))
            {
                return Reply(id, false, null, "Message sans type.");
            }

            if (!AllowedTypes.Contains(type))
            {
                _log.Warn("Type refuse sur le serveur : " + Clip(type, 60));
                return Reply(id, false, null, Unavailable + " : " + Clip(type, 60));
            }

            var result = await DispatchAsync(type, payload, connection, login).ConfigureAwait(false);
            return Reply(id, true, result, null);
        }
        catch (Exception ex)
        {
            _log.Error("Echec du traitement d'un message web" + (type is null ? "" : " (" + type + ")"), ex);
            return Reply(id, false, null, Readable(ex));
        }
    }

    private static JsonObject Reply(JsonNode? id, bool ok, JsonNode? payload, string? error)
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

        return message;
    }

    private static string Readable(Exception ex) => ex switch
    {
        InvalidOperationException => ex.Message,
        UnauthorizedAccessException => "Acces refuse : " + ex.Message,
        IOException => "Erreur d'acces au disque : " + ex.Message,
        JsonException => "Donnees JSON invalides : " + ex.Message,
        _ => ex.Message,
    };

    private static string Clip(string text, int max) => text.Length <= max ? text : text[..max];

    // ------------------------------------------------------------------- dispatch

    private async Task<JsonNode?> DispatchAsync(string type, JsonObject payload, object connection, string login) => type switch
    {
        "getState" => GetState(),
        "saveSettings" => SaveSettings(payload),
        "notify" => new JsonObject(),
        "log" => LogFromWeb(payload),
        "perf" => new JsonObject(),
        "whisperStatus" => _whisper.Status(),
        "whisperDownload" => await DownloadWhisperAsync(payload).ConfigureAwait(false),
        "whisperRemove" => new JsonObject { ["removed"] = await _whisper.RemoveAsync(Str(payload, "model") ?? "").ConfigureAwait(false) },
        "whisperWarm" => WarmWhisper(payload),
        "transcribe" => await TranscribeAsync(payload, login).ConfigureAwait(false),
        "cancelTranscribe" => new JsonObject { ["cancelled"] = _whisper.Cancel(Str(payload, "job")) },
        "voiceStart" => StartVoice(payload, login),
        "voiceSay" => new JsonObject { ["turn"] = _voice.Say(Str(payload, "conversationId"), Str(payload, "text"), Str(payload, "heard")) },
        "voiceInterrupt" => InterruptVoice(payload),
        "voiceStop" => StopVoice(payload),
        // Voix SAPI absentes sous Linux : liste vide, la page retombe sur speechSynthesis.
        "voiceVoices" => new JsonObject { ["voices"] = new JsonArray(), ["default"] = "" },
        "voiceSpeak" => throw new InvalidOperationException("Voix Windows indisponibles sur le serveur Révizator : la voix du navigateur prend le relais."),
        "learnLoad" => await LearnLoadAsync(_spaces.Get(login)).ConfigureAwait(false),
        "learnSave" => await LearnSaveAsync(_spaces.Get(login), payload, connection).ConfigureAwait(false),
        "learnDoc" => await LearnDocAsync(_spaces.Get(login), payload).ConfigureAwait(false),
        "learnDocSave" => await LearnDocSaveAsync(_spaces.Get(login), payload).ConfigureAwait(false),
        "learnDocDelete" => await LearnDocDeleteAsync(_spaces.Get(login), payload).ConfigureAwait(false),
        "learnNews" => await LearnNewsAsync(_spaces.Get(login), payload).ConfigureAwait(false),
        "learnGenerate" => await _spaces.Get(login).Agent.GenerateAsync(payload).ConfigureAwait(false),
        "learnCancel" => new JsonObject { ["cancelled"] = _spaces.Get(login).Agent.Cancel(Str(payload, "job")) },
        "learnJobs" => _spaces.Get(login).Agent.Jobs(),
        "learnWait" => await _spaces.Get(login).Agent.WaitAsync(Str(payload, "job")).ConfigureAwait(false),
        "learnBoard" => await LearnBoardAsync(payload, login).ConfigureAwait(false),
        "ttsStatus" => await Task.Run(_tts.Status).ConfigureAwait(false),
        "ttsDownload" => await DownloadTtsAsync().ConfigureAwait(false),
        "ttsRemove" => new JsonObject { ["removed"] = await _tts.RemoveAsync().ConfigureAwait(false) },
        "ttsWarm" => WarmTts(payload),
        "speak" => await SpeakTtsAsync(payload, login).ConfigureAwait(false),
        "speakScript" => await SpeakScriptTtsAsync(payload, login).ConfigureAwait(false),
        "cancelSpeak" => new JsonObject { ["cancelled"] = _tts.Cancel(Str(payload, "job")) },
        "ttsClearCache" => await Task.Run(_tts.ClearCache).ConfigureAwait(false),
        "asrStatus" => await Task.Run(_asr.Status).ConfigureAwait(false),
        "asrDownload" => await _asr.DownloadAsync(Str(payload, "lang")).ConfigureAwait(false),
        "asrRemove" => new JsonObject { ["removed"] = await _asr.RemoveAsync(Str(payload, "lang")).ConfigureAwait(false) },
        "asrWarm" => WarmAsr(payload),
        "asrStart" => await StartAsrAsync(payload, login).ConfigureAwait(false),
        "asrFeed" => FeedAsr(payload),
        "asrEnd" => new JsonObject { ["text"] = await _asr.EndAsync(Str(payload, "session")).ConfigureAwait(false) },
        "asrReset" => await ResetAsrAsync(payload).ConfigureAwait(false),
        "asrStop" => StopAsr(payload),
        _ => throw new InvalidOperationException(Unavailable + " : " + type),
    };

    // ------------------------------------------------------------------- handlers

    /// <summary>
    /// Etat de la page en mode serveur : donnees d'Organizator vides (rien des taches ne vit ici), reglages du
    /// serveur (ceux du telephone), et l'environnement attendu par la page, avec <c>mode: 'revizator'</c>.
    /// </summary>
    private JsonNode GetState()
    {
        var settings = _store.LoadSettings();
        var claude = new ModelCatalogInfo("", "", 0,
            [new ModelGroup("alias", AgentProvider.ClaudeModels.Select(alias => new ModelOption(alias)).ToArray())]);
        var copilot = new ModelCatalogInfo("", "", 0, []);

        return new JsonObject
        {
            ["data"] = new JsonObject
            {
                ["version"] = 1,
                ["tasks"] = new JsonArray(),
                ["types"] = new JsonArray(),
                ["convos"] = new JsonArray(),
                ["remarks"] = new JsonArray(),
                ["notifications"] = new JsonArray(),
                ["lastType"] = "",
            },
            ["settings"] = JsonSerializer.SerializeToNode(settings, Json),
            ["env"] = new JsonObject
            {
                ["mode"] = "revizator",
                ["version"] = ServerConfig.Version,
                ["hasClaude"] = _launcher.HasClaude,
                ["hasCopilot"] = false,
                ["hasWt"] = false,
                ["defaultCwd"] = "",
                ["dataDir"] = "",
                ["userProfile"] = "",
                ["repoDir"] = "",
                ["bitbucketUrl"] = "",
                ["bitbucketSource"] = "",
                ["bitbucketToken"] = false,
                ["jiraUrl"] = "",
                ["attachmentsDir"] = "",
                ["attachmentsUrl"] = "",
                ["learnUrl"] = LearningStore.BaseUrl,
                ["whisper"] = _whisper.Status(),
                ["ttsUrl"] = "https://" + TextToSpeech.Host + "/",
                ["models"] = new JsonObject
                {
                    ["claude"] = claude.ToJson(),
                    ["copilot"] = copilot.ToJson(),
                },
                ["efforts"] = new JsonObject
                {
                    ["claude"] = new JsonArray(AgentProvider.ClaudeEfforts.Select(e => (JsonNode?)JsonValue.Create(e)).ToArray()),
                    ["copilot"] = new JsonArray(AgentProvider.CopilotEfforts.Select(e => (JsonNode?)JsonValue.Create(e)).ToArray()),
                },
            },
        };
    }

    /// <summary>Ecrit <c>settings.json</c> du serveur : les reglages du telephone, jamais ceux du PC.</summary>
    private JsonNode SaveSettings(JsonObject payload)
    {
        payload.Remove("files");
        AppSettings incoming;
        try
        {
            incoming = payload.Deserialize<AppSettings>(Json) ?? new AppSettings();
        }
        catch (Exception ex)
        {
            throw new InvalidOperationException("Reglages invalides : " + ex.Message);
        }

        // Le reglage « serveur Revizator » n'a de sens que sur le PC : aucun jeton ne se garde ici.
        incoming.RevizatorServerUrl = "";
        incoming.RevizatorServerToken = "";
        incoming.RevizatorServerLogin = "";
        _store.SaveSettings(incoming);
        return new JsonObject();
    }

    /// <summary>
    /// Trace de la page : niveau reduit a quelques lettres (un saut de ligne y forgerait une fausse ligne du
    /// journal) et message borne (un message de 32 Mo par appel remplirait le journal et la console).
    /// </summary>
    private JsonNode LogFromWeb(JsonObject payload)
    {
        var level = new string((Str(payload, "level") ?? "").Where(char.IsAsciiLetter).Take(12).ToArray());
        _log.FromWeb(level, Clip(Str(payload, "message") ?? "", 4000));
        return new JsonObject();
    }

    // ------------------------------------------------------------- Revizator (H2)

    /// <summary><c>learnLoad</c> : comme l'hote WPF, plus <c>rev</c> (compteur des ecritures, § 6).</summary>
    private static async Task<JsonNode> LearnLoadAsync(UserSpace space)
    {
        await space.Lock.WaitAsync().ConfigureAwait(false);
        try
        {
            var result = await Task.Run(() => space.Learning.Load()).ConfigureAwait(false);
            result["rev"] = Interlocked.Read(ref space.Rev);
            return result;
        }
        finally
        {
            space.Lock.Release();
        }
    }

    /// <summary>
    /// <c>learnSave</c> : comme l'hote WPF, plus <c>rev</c> ; les autres connexions recoivent
    /// <c>learnChanged { rev, at }</c> (§ 6) — celles du meme compte seulement. Avec <c>baseRev</c> (le rev que la page a lu ou ecrit en
    /// dernier) : si un autre appareil a ecrit depuis, rien n'est ecrit et la reponse est
    /// <c>{ conflict: true, rev }</c> ; la page fusionne alors avec la version du serveur et renvoie.
    /// </summary>
    private async Task<JsonNode> LearnSaveAsync(UserSpace space, JsonObject payload, object connection)
    {
        payload.Remove("files");
        long? baseRev = payload["baseRev"] is JsonValue b && b.TryGetValue<long>(out var v) ? v : null;
        payload.Remove("baseRev");
        long rev;
        JsonObject result;
        await space.Lock.WaitAsync().ConfigureAwait(false);
        try
        {
            var current = Interlocked.Read(ref space.Rev);
            if (baseRev is { } expected && expected != current)
            {
                return new JsonObject { ["conflict"] = true, ["rev"] = current };
            }

            result = await Task.Run(() => space.Learning.Save(payload)).ConfigureAwait(false);
            rev = Interlocked.Increment(ref space.Rev);
        }
        finally
        {
            space.Lock.Release();
        }

        result["rev"] = rev;
        PostEvent("learnChanged", new JsonObject
        {
            ["rev"] = rev,
            ["at"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
        }, except: connection, login: space.Login);
        return result;
    }

    /// <summary><c>learnDoc</c> : <c>{ kind, id }</c> -> <c>{ doc }</c>, <c>null</c> si le document n'existe pas.</summary>
    private static async Task<JsonNode> LearnDocAsync(UserSpace space, JsonObject payload)
    {
        var kind = Str(payload, "kind");
        var id = Str(payload, "id");
        var doc = await Task.Run(() => space.Learning.ReadDoc(kind, id)).ConfigureAwait(false);
        return new JsonObject { ["doc"] = doc };
    }

    /// <summary><c>learnDocSave</c> : <c>{ kind, id, doc }</c> -> <c>{}</c>.</summary>
    private static async Task<JsonNode> LearnDocSaveAsync(UserSpace space, JsonObject payload)
    {
        var kind = Str(payload, "kind");
        var id = Str(payload, "id");
        if (payload["doc"] is not JsonObject doc)
        {
            throw new InvalidOperationException("Document absent ou invalide : un objet JSON est attendu.");
        }

        await Task.Run(() => space.Learning.WriteDoc(kind, id, doc)).ConfigureAwait(false);
        return new JsonObject();
    }

    /// <summary><c>learnDocDelete</c> : <c>{ kind, id }</c> -> <c>{ removed }</c>.</summary>
    private static async Task<JsonNode> LearnDocDeleteAsync(UserSpace space, JsonObject payload)
    {
        var kind = Str(payload, "kind");
        var id = Str(payload, "id");
        var removed = await Task.Run(() => space.Learning.DeleteDoc(kind, id)).ConfigureAwait(false);
        return new JsonObject { ["removed"] = removed };
    }

    /// <summary><c>learnNews</c> : <c>{ force? }</c> -> menu RSS du jour.</summary>
    private static async Task<JsonNode> LearnNewsAsync(UserSpace space, JsonObject payload)
    {
        var force = payload["force"] is JsonValue value && value.TryGetValue<bool>(out var flag) && flag;
        return await space.News.GetAsync(force).ConfigureAwait(false);
    }

    /// <summary>
    /// <c>learnBoard</c> : <c>{ weeks? }</c> (12 par defaut, 26 au plus) -> le classement des comptes du serveur
    /// (<see cref="Leaderboard"/>), agregats seulement.
    /// </summary>
    private async Task<JsonNode> LearnBoardAsync(JsonObject payload, string login)
    {
        var weeks = int.TryParse(Str(payload, "weeks"), System.Globalization.NumberStyles.Integer,
            System.Globalization.CultureInfo.InvariantCulture, out var n) ? n : 12;
        // L'espace du compte est ouvert au passage : ses donnees d'avant les comptes separes y sont rattachees.
        _spaces.Get(login);
        return await Task.Run(() => _board.Build(login, weeks)).ConfigureAwait(false);
    }

    // ------------------------------------------------------- dictee et transcription

    private async Task<JsonNode> DownloadWhisperAsync(JsonObject payload)
    {
        var model = WhisperTranscriber.Find(Str(payload, "model")).Id;
        await _whisper.EnsureModelAsync(model, CancellationToken.None).ConfigureAwait(false);
        return _whisper.Status();
    }

    private JsonNode WarmWhisper(JsonObject payload)
    {
        _whisper.Warm(WhisperTranscriber.SanitizeModel(Str(payload, "model")));
        return new JsonObject();
    }

    /// <summary>
    /// Comme <c>BridgeHost.TranscribeAsync</c>, sans <c>path</c> : il n'y a pas de pieces jointes sur le
    /// serveur, seule la dictee envoyee par la page (WAV en base64) se transcrit.
    /// </summary>
    private async Task<JsonNode> TranscribeAsync(JsonObject payload, string login)
    {
        var job = Str(payload, "job") ?? "";
        Own("whisper", job, login);
        var model = WhisperTranscriber.SanitizeModel(Str(payload, "model"));
        var language = WhisperTranscriber.SanitizeLanguage(Str(payload, "language"));
        static bool Flag(JsonObject source, string name) => source[name] is JsonValue value && value.TryGetValue<bool>(out var flag) && flag;
        var reference = Limit(Str(payload, "reference"), 2000);
        var detail = Flag(payload, "detail") || reference.Length > 0;
        var keep = Flag(payload, "keep");
        var accent = payload["accent"] is not JsonValue accentValue || !accentValue.TryGetValue<bool>(out var accentOn) || accentOn;

        if (!string.IsNullOrWhiteSpace(Str(payload, "path")))
        {
            throw new InvalidOperationException("Seules les dictées envoyées par la page se transcrivent sur le serveur Révizator.");
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
            throw new InvalidOperationException("Dictée trop longue.");
        }

        var result = await _whisper.TranscribeAsync(job, ct => AudioDecoder.FromWav(bytes, ct), model, language,
            paragraphs: false, what: detail ? "dictee (detail)" : "dictee", detail, reference, accent).ConfigureAwait(false);
        if (!keep)
        {
            return result;
        }

        try
        {
            var learning = _spaces.Get(login).Learning;
            var saved = await Task.Run(() => learning.SaveAudio(bytes)).ConfigureAwait(false);
            result["id"] = saved["id"]?.GetValue<string>();
            result["url"] = saved["url"]?.GetValue<string>();
            _log.Info($"Revizator : enregistrement garde ({result["id"]}, {bytes.Length} octets)");
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or InvalidOperationException)
        {
            _log.Warn("Revizator : enregistrement non garde : " + ex.Message);
            result["id"] = null;
            result["url"] = null;
            result["keepError"] = "Enregistrement non gardé : " + ex.Message;
        }

        return result;
    }

    // ------------------------------------------------------------- synthese vocale

    private async Task<JsonNode> DownloadTtsAsync()
    {
        await _tts.EnsureModelAsync(CancellationToken.None).ConfigureAwait(false);
        return await Task.Run(_tts.Status).ConfigureAwait(false);
    }

    private JsonNode WarmTts(JsonObject payload)
    {
        _tts.Warm(Str(payload, "accent") ?? TextToSpeech.AccentUs);
        return new JsonObject();
    }

    private async Task<JsonNode> SpeakTtsAsync(JsonObject payload, string login)
    {
        Own("tts", Str(payload, "job"), login);
        return await _tts.SpeakAsync(Str(payload, "job") ?? "", Str(payload, "text") ?? "", Str(payload, "voice") ?? "",
            TtsSpeed(payload)).ConfigureAwait(false);
    }

    private async Task<JsonNode> SpeakScriptTtsAsync(JsonObject payload, string login)
    {
        Own("tts", Str(payload, "job"), login);
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
        return await _tts.SpeakScriptAsync(Str(payload, "job") ?? "", lines, TtsSpeed(payload), gapMs).ConfigureAwait(false);
    }

    private static float TtsSpeed(JsonObject payload)
        => double.TryParse(Str(payload, "speed"), System.Globalization.NumberStyles.Float,
            System.Globalization.CultureInfo.InvariantCulture, out var speed) ? (float)speed : 1f;

    // --------------------------------------------------------- transcription en direct

    private JsonNode WarmAsr(JsonObject payload)
    {
        _asr.Warm(Str(payload, "lang"));
        return new JsonObject();
    }

    private async Task<JsonNode> StartAsrAsync(JsonObject payload, string login)
    {
        var session = await _asr.StartAsync(Str(payload, "lang")).ConfigureAwait(false);
        Own("asr", session, login);
        return new JsonObject { ["session"] = session };
    }

    private JsonNode FeedAsr(JsonObject payload)
    {
        _asr.Feed(Str(payload, "session"), Str(payload, "pcm"));
        return new JsonObject();
    }

    private async Task<JsonNode> ResetAsrAsync(JsonObject payload)
    {
        await _asr.ResetAsync(Str(payload, "session")).ConfigureAwait(false);
        return new JsonObject();
    }

    private JsonNode StopAsr(JsonObject payload)
    {
        _asr.Stop(Str(payload, "session"));
        return new JsonObject();
    }

    // ------------------------------------------------------------- conversation vocale

    /// <summary>Comme <c>BridgeHost.StartVoice</c> : chaque champ absent prend la valeur des reglages du serveur.</summary>
    private JsonNode StartVoice(JsonObject payload, string login)
    {
        var settings = _store.LoadSettings();
        var mode = VoiceChat.SanitizeMode(Str(payload, "mode"));
        var tutor = mode == VoiceChat.TutorMode ? (payload["tutor"] as JsonObject)?.DeepClone() as JsonObject ?? new JsonObject() : null;
        var options = new VoiceOptions(
            Model: AgentProvider.RequireModel(Str(payload, "model") ?? settings.VoiceModel),
            Effort: AgentProvider.RequireEffort(AgentProvider.Claude, Str(payload, "effort") ?? settings.VoiceEffort),
            Persona: VoiceChat.SanitizePersona(Str(payload, "persona") ?? settings.VoicePersona),
            Topic: VoiceChat.SanitizeTopic(Str(payload, "topic") ?? settings.VoiceTopic),
            Instructions: tutor is null ? Limit(Str(payload, "instructions") ?? settings.VoiceInstructions, 2000) : "",
            Web: tutor is null && (payload["web"] is JsonValue web && web.TryGetValue<bool>(out var allowed) ? allowed : settings.VoiceWeb),
            Mode: mode,
            Tutor: tutor,
            Name: VoiceChat.SanitizeName(Str(payload, "name")));
        var conversation = _voice.Start(options);
        Own("voice", conversation, login);
        return new JsonObject { ["conversationId"] = conversation };
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

    // -------------------------------------------------------------------- helpers

    private static string Limit(string? value, int max)
    {
        var text = (value ?? "").Trim();
        return text.Length <= max ? text : text[..max];
    }

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
