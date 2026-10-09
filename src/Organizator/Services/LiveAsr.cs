using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using SherpaOnnx;

namespace Organizator.Services;

/// <summary>
/// Le modele de transcription (transducteur NeMo, int8) sur Hugging Face. <paramref name="Langs"/> : langues
/// annoncees a la page (le modele detecte lui-meme la langue). <paramref name="Size"/> : taille approximative
/// (octets annonces avant le telechargement) ; la taille reelle est celle que le serveur annonce, retenue
/// dans <c>manifest.json</c>.
/// </summary>
public sealed record AsrModel(string Id, string Label, string[] Langs, string Repo, string Revision,
    string Encoder, string Decoder, string Joiner, string Tokens, long Size)
{
    public IEnumerable<string> FileNames => [Tokens, Decoder, Joiner, Encoder];
}

/// <summary>
/// Transcription en direct, en local, sur le processeur : sherpa-onnx 1.13.8 (<see cref="OfflineRecognizer"/>)
/// et NVIDIA Parakeet TDT 0.6B v3 (int8, anglais, francais et autres langues europeennes, ponctuation et
/// casse), en pseudo-flux. Rien ne sort du poste.
///
/// <list type="bullet">
/// <item><description>Le runtime natif est celui de la synthese vocale (<see cref="SherpaRuntime"/>,
/// telecharge seul si les voix Kokoro ne sont pas installees). Le modele est pris fichier par fichier sur
/// Hugging Face (<see cref="Models"/>, table a corriger si le depot change) sous
/// <c>&lt;donnees&gt;\asr\parakeet\</c> : <c>.part</c> puis renomme, taille annoncee par le serveur,
/// SHA-256 calcule et journalise (aucune empreinte connue a comparer), controle de forme, puis
/// <c>manifest.json</c> qui fait foi de l'installation. Les anciens modeles Zipformer
/// (<c>asr\en</c>, <c>asr\fr</c>) sont effaces au demarrage.</description></item>
/// <item><description>Une instance, chargee a la demande (<c>asrWarm</c>, <c>asrStart</c>), liberee apres
/// dix minutes sans usage ; une session dormante la recharge d'elle-meme (son audio est garde).</description></item>
/// <item><description>Pseudo-flux : chaque session garde l'audio de l'enonce en cours. Un partiel est le
/// texte complet de l'enonce, recalcule sur un flux hors ligne neuf au plus toutes les
/// <see cref="PartialEveryMs"/> ms, et seulement si au moins <see cref="MinNewAudioMs"/> ms d'audio neuf
/// sont arrives ; un paquet suivi d'autres deja en file ne declenche rien (pas de partiel perime). Au-dela
/// de <see cref="MaxUtteranceSeconds"/> s, la partie la plus ancienne (coupee au plus calme) est decodee une
/// fois et figee. <c>asrEnd</c> decode le tout une derniere fois, avec un peu de silence en fin.</description></item>
/// <item><description>Tout le calcul (chargement, decodage) passe par un seul fil dedie, dans l'ordre
/// d'arrivee : deux decodages ne se chevauchent jamais ; <c>asrFeed</c> rend la main aussitot,
/// <c>asrEnd</c> attend que les paquets deja recus soient pris. Evenements par <see cref="Progress"/> :
/// <c>{ session, phase: partial, text }</c> ; telechargement : <c>{ phase: download, lang: parakeet,
/// received, total }</c>, <c>downloaded</c>, <c>download-failed { error }</c> ; echec de decodage :
/// <c>{ session, phase: error, error }</c>.</description></item>
/// </list>
/// </summary>
public sealed class LiveAsr : IDisposable
{
    public const int SampleRate = 16000;

    /// <summary>
    /// Modele propose (un seul, toutes langues). Noms tires de la documentation de sherpa-onnx, NON verifies
    /// depuis la machine de developpement (pas d'acces a Hugging Face) : a corriger ici seulement si un
    /// fichier est introuvable. Taille approximative.
    /// </summary>
    public static readonly IReadOnlyList<AsrModel> Models =
    [
        new("parakeet", "Parakeet v3 (anglais, français…)", ["en", "fr"],
            "csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8", "main",
            Encoder: "encoder.int8.onnx",
            Decoder: "decoder.int8.onnx",
            Joiner: "joiner.int8.onnx",
            Tokens: "tokens.txt",
            Size: 650_000_000),
    ];

    /// <summary>Anciens dossiers (Zipformer en flux, un par langue), effaces au demarrage.</summary>
    public static readonly IReadOnlyList<string> ObsoleteDirs = ["en", "fr"];

    private const string ManifestName = "manifest.json";
    private const long MaxFileSize = 1200L * 1024 * 1024;

    private static readonly TimeSpan IdleRelease = TimeSpan.FromMinutes(10);
    private static readonly TimeSpan IdleCheck = TimeSpan.FromMinutes(1);
    private static readonly TimeSpan ProgressEvery = TimeSpan.FromMilliseconds(250);

    /// <summary>Intervalle minimal entre la fin d'un decodage partiel et le debut du suivant (par session).</summary>
    public const int PartialEveryMs = 600;

    /// <summary>Audio neuf requis pour recalculer un partiel.</summary>
    public const int MinNewAudioMs = 300;

    /// <summary>Audio decode d'un bloc au plus : au-dela, la partie la plus ancienne est figee.</summary>
    public const int MaxUtteranceSeconds = 30;

    /// <summary>Paquets en attente au-dela desquels la session est declaree en retard (~10 s d'audio).</summary>
    public const int MaxPending = 100;

    /// <summary>Paquet le plus long accepte (10 s d'Int16 mono a 16 kHz).</summary>
    public const int MaxPacketBytes = SampleRate * 2 * 10;

    public const int MaxSessions = 4;

    /// <summary>Silence ajoute avant le decodage final : evite que le dernier mot, colle a la fin, se perde.</summary>
    public const int TailPaddingSamples = SampleRate * 3 / 10;

    // Hors ligne : chaque decodage est un calcul d'un bloc, autant de fils que raisonnable sans affamer l'avatar.
    public static readonly int Threads = Math.Clamp(Environment.ProcessorCount / 2, 2, 6);

    private static readonly FieldInfo? RecognizerHandle = typeof(OfflineRecognizer).GetField("_handle", BindingFlags.Instance | BindingFlags.NonPublic);
    private static readonly CultureInfo French = CultureInfo.GetCultureInfo("fr-FR");

    private readonly HostLog _log;
    private readonly SherpaRuntime _runtime;
    private readonly string _root;
    private readonly string _version;
    private readonly Func<AsrModel, string, IAsrRecognizer> _loader;
    private readonly object _lock = new();
    private readonly Dictionary<string, Download> _downloads = new(StringComparer.Ordinal);
    private readonly Dictionary<string, Session> _sessions = new(StringComparer.Ordinal);
    private readonly BlockingCollection<Action> _work = new();
    private readonly Thread _thread;
    private readonly Timer _idle;

    // Fil de decodage seulement.
    private readonly Dictionary<string, Engine> _engines = new(StringComparer.Ordinal);
    private bool _disposed;

    public LiveAsr(string dataDir, HostLog log, string version, SherpaRuntime runtime)
        : this(dataDir, log, version, runtime, null)
    {
    }

    /// <param name="loader">Chargeur d'instance (essais) ; par defaut, sherpa-onnx.</param>
    internal LiveAsr(string dataDir, HostLog log, string version, SherpaRuntime runtime,
        Func<AsrModel, string, IAsrRecognizer>? loader)
    {
        _log = log;
        _runtime = runtime;
        _root = Path.Combine(dataDir, "asr");
        _version = version;
        _loader = loader ?? LoadSherpa;
        _runtime.RegisterUser("transcription en direct", () => Models.Any(Installed));
        _thread = new Thread(WorkLoop) { IsBackground = true, Name = "Organizator ASR" };
        _thread.Start();
        Post(RemoveObsolete);
        _idle = new Timer(_ => Post(ReleaseIdle), null, IdleCheck, IdleCheck);
    }

    /// <summary>Texte partiel et telechargements (fil quelconque).</summary>
    public event Action<JsonObject>? Progress;

    public string Root => _root;

    /// <summary>
    /// Le modele : <paramref name="key"/> vide, l'id du modele ou une de ses langues (<c>en-US</c> → <c>en</c>).
    /// <paramref name="strict"/> : une autre valeur est refusee (asrStart) ; sinon ignoree (telechargement,
    /// suppression, prechargement : un seul modele).
    /// </summary>
    public static AsrModel FindModel(string? key, bool strict = true)
    {
        var id = (key ?? "").Trim().ToLowerInvariant();
        if (id.Length == 0)
        {
            return Models[0];
        }

        var lang = id.Length > 2 && (id[2] == '-' || id[2] == '_') ? id[..2] : id;
        var found = Models.FirstOrDefault(m => m.Id == id || m.Langs.Contains(lang));
        if (found is not null || !strict)
        {
            return found ?? Models[0];
        }

        throw new InvalidOperationException($"Langue de transcription en direct non prise en charge : {key} ({string.Join(" ou ", Models.SelectMany(m => m.Langs).Distinct())} attendu).");
    }

    private string DirOf(AsrModel model) => Path.Combine(_root, model.Id);

    /// <summary>Les anciens modeles Zipformer (un dossier par langue) ne servent plus : effaces, journalise.</summary>
    private void RemoveObsolete()
    {
        foreach (var name in ObsoleteDirs)
        {
            var dir = Path.Combine(_root, name);
            if (!Directory.Exists(dir))
            {
                continue;
            }

            try
            {
                Directory.Delete(dir, recursive: true);
                _log.Info($"ASR : ancien modele Zipformer {name} supprime ({dir})");
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                _log.Warn($"ASR : ancien modele Zipformer {name} non supprime : {ex.Message}");
            }
        }
    }

    // ------------------------------------------------------------------ etat

    /// <summary><c>{ runtime: { downloaded, version, size }, models: [{ id, label, langs, repo, size, downloaded, downloading, received, total }] }</c></summary>
    public JsonObject Status()
    {
        var models = new JsonArray();
        foreach (var model in Models)
        {
            Download? download;
            lock (_lock)
            {
                _downloads.TryGetValue(model.Id, out download);
            }

            var downloading = download is not null && !download.Task.IsCompleted;
            var manifest = ReadManifest(model);
            models.Add(new JsonObject
            {
                ["id"] = model.Id,
                ["label"] = model.Label,
                ["langs"] = new JsonArray(model.Langs.Select(l => (JsonNode?)JsonValue.Create(l)).ToArray()),
                ["repo"] = model.Repo,
                ["size"] = manifest?.Size ?? model.Size,
                ["downloaded"] = manifest is not null,
                ["downloading"] = downloading,
                ["received"] = downloading ? Interlocked.Read(ref download!.Received) : 0,
                ["total"] = downloading ? Interlocked.Read(ref download!.Total) : 0,
            });
        }

        return new JsonObject
        {
            ["runtime"] = new JsonObject
            {
                ["downloaded"] = _runtime.Present,
                ["version"] = SherpaRuntime.Version,
                ["size"] = SherpaRuntime.DownloadSize,
            },
            ["models"] = models,
        };
    }

    /// <summary>Modele installe (manifeste conforme a la table, fichiers entiers) et runtime present.</summary>
    public bool IsReady(string? lang = null) => _runtime.Present && Installed(FindModel(lang, strict: false));

    private bool Installed(AsrModel model) => ReadManifest(model) is not null;

    private sealed record Manifest(long Size);

    /// <summary>Le manifeste, s'il decrit exactement les fichiers de la table et que chacun est la, a sa taille.</summary>
    private Manifest? ReadManifest(AsrModel model)
    {
        var dir = DirOf(model);
        var path = Path.Combine(dir, ManifestName);
        try
        {
            if (!File.Exists(path))
            {
                return null;
            }

            var node = JsonNode.Parse(File.ReadAllText(path)) as JsonObject;
            if (node is null
                || (string?)node["repo"] != model.Repo
                || (string?)node["revision"] != model.Revision
                || node["files"] is not JsonArray files)
            {
                return null;
            }

            long total = 0;
            var names = new HashSet<string>(StringComparer.Ordinal);
            foreach (var item in files.OfType<JsonObject>())
            {
                var name = (string?)item["name"] ?? "";
                var size = item["size"]?.GetValue<long>() ?? -1;
                var info = new FileInfo(Path.Combine(dir, name));
                if (!info.Exists || info.Length != size)
                {
                    return null;
                }

                names.Add(name);
                total += size;
            }

            return model.FileNames.All(names.Contains) ? new Manifest(total) : null;
        }
        catch (Exception ex) when (ex is IOException or JsonException or InvalidOperationException or FormatException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    // ------------------------------------------------------------ telechargement

    private sealed class Download
    {
        public required CancellationTokenSource Cancel { get; init; }
        public Task Task { get; set; } = Task.CompletedTask;
        public long Received;
        public long Total;
        public readonly Stopwatch Clock = Stopwatch.StartNew();
    }

    /// <summary>
    /// Telecharge le modele (et le runtime s'il manque) ; <paramref name="key"/> ignore (un seul modele).
    /// Un seul telechargement a la fois, partage. Rend <c>{ ok: true }</c>, ou <c>{ ok: false, error }</c>
    /// (deja annonce par <c>download-failed</c>) : la page retombe alors sur Whisper.
    /// </summary>
    public async Task<JsonObject> DownloadAsync(string? key)
    {
        var model = FindModel(key, strict: false);
        if (_runtime.Present && Installed(model))
        {
            return new JsonObject { ["ok"] = true };
        }

        Download download;
        lock (_lock)
        {
            if (!_downloads.TryGetValue(model.Id, out var current) || current.Task.IsCompleted)
            {
                var started = new Download { Cancel = new CancellationTokenSource() };
                started.Task = Task.Run(() => DownloadModelAsync(model, started, started.Cancel.Token));
                _downloads[model.Id] = started;
                current = started;
            }

            download = current;
        }

        try
        {
            await download.Task.ConfigureAwait(false);
            return new JsonObject { ["ok"] = true };
        }
        catch (Exception ex)
        {
            return new JsonObject { ["ok"] = false, ["error"] = ex.Message };
        }
    }

    private async Task DownloadModelAsync(AsrModel model, Download download, CancellationToken ct)
    {
        var watch = Stopwatch.StartNew();
        var dir = DirOf(model);
        string? part = null;
        try
        {
            Directory.CreateDirectory(dir);
            // Un manifeste ancien ne doit plus faire croire a une installation complete.
            TryDelete(Path.Combine(dir, ManifestName));

            var runtimeMissing = !_runtime.FilesPresent;
            Interlocked.Exchange(ref download.Total, (runtimeMissing ? SherpaRuntime.DownloadSize : 0) + model.Size);
            _log.Info($"ASR : telechargement du modele {model.Id} ({model.Repo}, ~{download.Total / 1_000_000} Mo"
                + (runtimeMissing ? ", runtime sherpa-onnx " + SherpaRuntime.Version : "") + ")");
            EmitDownload(model, download, force: true);

            await _runtime.EnsureAsync(read =>
            {
                Interlocked.Add(ref download.Received, read);
                EmitDownload(model, download, force: false);
            }, ct).ConfigureAwait(false);

            var files = new JsonArray();
            long total = 0;
            var names = model.FileNames.ToList();
            for (var i = 0; i < names.Count; i++)
            {
                var name = names[i];
                var target = Path.Combine(dir, name);
                part = target + ".part";
                var url = "https://huggingface.co/" + model.Repo + "/resolve/" + model.Revision + "/" + name;
                var before = Interlocked.Read(ref download.Received);
                (long Size, string Hash) fetched;
                try
                {
                    fetched = await SherpaRuntime.FetchAsync(url, part, null, MaxFileSize, HashAlgorithmName.SHA256, null, base64: false, name, _version,
                        read =>
                        {
                            Interlocked.Add(ref download.Received, read);
                            EmitDownload(model, download, force: false);
                        }, ct,
                        onLength: length =>
                        {
                            // Le total s'affine : octets deja recus + taille annoncee + estimation du reste.
                            var rest = i == names.Count - 1 ? 0 : Math.Max(0, model.Size - total - length);
                            Interlocked.Exchange(ref download.Total, before + length + rest);
                        }).ConfigureAwait(false);
                }
                catch (SherpaHttpException http) when (http.Status == HttpStatusCode.NotFound)
                {
                    throw new InvalidOperationException($"modèle introuvable sur Hugging Face : {model.Repo}/{name} (404). Le nom du fichier a pu changer.");
                }

                File.Move(part, target, overwrite: true);
                part = null;
                total += fetched.Size;
                files.Add(new JsonObject { ["name"] = name, ["size"] = fetched.Size, ["sha256"] = fetched.Hash });
                _log.Info($"ASR : {model.Id}/{name} : {fetched.Size} octets, SHA-256 {fetched.Hash}");
            }

            // Sans empreinte connue, au moins la forme : une page HTML a la place d'un modele tuerait le processus au chargement.
            if (CheckFiles(model, dir) is { } problem)
            {
                foreach (var name in names)
                {
                    TryDelete(Path.Combine(dir, name));
                }

                throw new InvalidOperationException("fichier reçu inattendu : " + problem);
            }

            var manifest = new JsonObject
            {
                ["repo"] = model.Repo,
                ["revision"] = model.Revision,
                ["downloaded"] = DateTimeOffset.Now.ToString("o", CultureInfo.InvariantCulture),
                ["files"] = files,
            };
            var manifestPath = Path.Combine(dir, ManifestName);
            File.WriteAllText(manifestPath + ".part", manifest.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
            File.Move(manifestPath + ".part", manifestPath, overwrite: true);

            _log.Info($"ASR : modele {model.Id} telecharge en {watch.Elapsed.TotalSeconds:0} s ({total / 1_000_000} Mo)");
            Emit(new JsonObject { ["phase"] = "downloaded", ["lang"] = model.Id });
        }
        catch (Exception ex)
        {
            if (part is not null)
            {
                TryDelete(part);
            }

            if (ex is OperationCanceledException && ct.IsCancellationRequested)
            {
                _log.Info($"ASR : telechargement du modele {model.Id} interrompu");
                Emit(new JsonObject { ["phase"] = "download-failed", ["lang"] = model.Id, ["error"] = "Téléchargement interrompu." });
                throw new InvalidOperationException("Téléchargement du modèle de transcription interrompu.");
            }

            _log.Warn($"ASR : telechargement du modele {model.Id} impossible : " + ex.Message);
            var message = "Téléchargement de la transcription en direct impossible : "
                + (ex is HttpRequestException ? "réseau indisponible (" + ex.Message + ")" : ex.Message);
            Emit(new JsonObject { ["phase"] = "download-failed", ["lang"] = model.Id, ["error"] = message });
            throw new InvalidOperationException(message);
        }
    }

    private void EmitDownload(AsrModel model, Download download, bool force)
    {
        lock (download.Clock)
        {
            if (!force && download.Clock.Elapsed < ProgressEvery)
            {
                return;
            }

            download.Clock.Restart();
        }

        var received = Interlocked.Read(ref download.Received);
        Emit(new JsonObject
        {
            ["phase"] = "download",
            ["lang"] = model.Id,
            ["received"] = received,
            ["total"] = Math.Max(received, Interlocked.Read(ref download.Total)),
        });
    }

    /// <summary>
    /// Interrompt le telechargement, ou supprime le modele (<paramref name="key"/> ignore ; sessions
    /// ouvertes : elles echoueront au prochain decodage) ; le runtime part aussi si plus personne n'en a besoin.
    /// </summary>
    public async Task<bool> RemoveAsync(string? key)
    {
        var model = FindModel(key, strict: false);
        Download? download;
        lock (_lock)
        {
            _downloads.TryGetValue(model.Id, out download);
        }

        if (download is not null && !download.Task.IsCompleted)
        {
            download.Cancel.Cancel();
            try
            {
                await download.Task.ConfigureAwait(false);
            }
            catch (Exception)
            {
                // interrompu : c'est ce qu'on voulait
            }

            return true;
        }

        var dir = DirOf(model);
        if (!Directory.Exists(dir))
        {
            return false;
        }

        // L'instance se libere sur le fil de decodage, avant l'effacement des fichiers.
        await RunAsync(() =>
        {
            ReleaseEngine(model.Id, "supprime");
            return 0;
        }).ConfigureAwait(false);

        var runtimeRemoved = await Task.Run(() =>
        {
            Directory.Delete(dir, recursive: true);
            return _runtime.RemoveIfUnused();
        }).ConfigureAwait(false);

        _log.Info($"ASR : modele {model.Id} supprime" + (runtimeRemoved ? " (et le runtime)" : ""));
        return true;
    }

    // ------------------------------------------------------------------ sessions

    private sealed class Session
    {
        public required string Id { get; init; }
        public required AsrModel Model { get; init; }
        public required string Lang { get; init; }

        // Fil de decodage seulement.
        public readonly UtteranceAudio Audio = new(MaxUtteranceSeconds * SampleRate);
        public readonly PartialCadence Cadence = new(PartialEveryMs, MinNewAudioMs * SampleRate / 1000);
        public readonly List<string> Frozen = [];
        public string Sent = "";
        public string? Error;
        public bool Closed;
        public int Generation;
        public int TickGeneration;
        public Timer? Tick;

        // Tout fil.
        public int Pending;
        public int Ending;
        public long LastUse = Environment.TickCount64;
    }

    private sealed class Engine
    {
        public required IAsrRecognizer Recognizer { get; init; }
        public long LastUse = Environment.TickCount64;
    }

    /// <summary>Charge l'instance en arriere-plan ; sans effet si le modele n'est pas installe.</summary>
    public void Warm(string? key)
    {
        var model = FindModel(key, strict: false);
        if (!_runtime.Present || !Installed(model))
        {
            return;
        }

        Post(() =>
        {
            try
            {
                EngineFor(model);
            }
            catch (Exception ex)
            {
                // L'echec sera redit par asrStart, avec son message.
                _log.Warn($"ASR : preparation du modele {model.Id} impossible : {ex.Message}");
            }
        });
    }

    /// <summary>Ouvre une session : modele charge, ou erreur lisible (la page retombe sur Whisper).</summary>
    public async Task<string> StartAsync(string? lang)
    {
        var model = FindModel(lang);
        if (!Installed(model))
        {
            throw new InvalidOperationException("Le modèle de transcription en direct (Parakeet) n'est pas téléchargé.");
        }

        if (!_runtime.Present)
        {
            throw new InvalidOperationException("Moteur de transcription absent : retéléchargez le modèle de transcription en direct.");
        }

        var session = new Session { Id = Guid.NewGuid().ToString("N")[..12], Model = model, Lang = (lang ?? "").Trim() };
        await RunAsync(() => EngineFor(model)).ConfigureAwait(false);

        Session? evicted = null;
        lock (_lock)
        {
            if (_sessions.Count >= MaxSessions)
            {
                // Une page rechargee sans asrStop laisse ses sessions : la plus ancienne part.
                evicted = _sessions.Values.MinBy(s => Volatile.Read(ref s.LastUse));
                _sessions.Remove(evicted!.Id);
            }

            _sessions[session.Id] = session;
        }

        if (evicted is not null)
        {
            _log.Info($"ASR : session {evicted.Id} fermee (trop de sessions ouvertes)");
            Post(() => Close(evicted));
        }

        return session.Id;
    }

    /// <summary>
    /// Un paquet de PCM (base64 d'Int16 LE mono 16 kHz), ajoute a l'enonce sur le fil dedie ; rend la main aussitot.
    /// </summary>
    public void Feed(string? sessionId, string? pcm)
    {
        var session = SessionOf(sessionId);
        var samples = DecodePcm(pcm);
        if (samples.Length == 0)
        {
            return;
        }

        if (Interlocked.Increment(ref session.Pending) > MaxPending)
        {
            Interlocked.Decrement(ref session.Pending);
            throw new InvalidOperationException("La transcription en direct prend trop de retard : le processeur est saturé.");
        }

        Volatile.Write(ref session.LastUse, Environment.TickCount64);
        Post(() => FeedOnThread(session, samples));
    }

    /// <summary>Fin d'enonce : decode le tout et rend le texte final ; la session repart a zero.</summary>
    public async Task<string> EndAsync(string? sessionId)
    {
        var session = SessionOf(sessionId);
        Volatile.Write(ref session.LastUse, Environment.TickCount64);
        // Les partiels encore en file n'ont plus lieu d'etre : le final arrive.
        Interlocked.Increment(ref session.Ending);
        try
        {
            return await RunAsync(() => EndOnThread(session)).ConfigureAwait(false);
        }
        finally
        {
            Interlocked.Decrement(ref session.Ending);
        }
    }

    /// <summary>Abandonne l'enonce en cours (bruit) : l'audio recu est oublie.</summary>
    public async Task ResetAsync(string? sessionId)
    {
        var session = SessionOf(sessionId);
        Interlocked.Increment(ref session.Ending);
        try
        {
            await RunAsync(() =>
            {
                Restart(session);
                return 0;
            }).ConfigureAwait(false);
        }
        finally
        {
            Interlocked.Decrement(ref session.Ending);
        }
    }

    /// <summary>Ferme la session (inconnue : sans effet).</summary>
    public void Stop(string? sessionId)
    {
        Session? session;
        lock (_lock)
        {
            if (sessionId is null || !_sessions.Remove(sessionId, out session))
            {
                return;
            }
        }

        Interlocked.Increment(ref session.Ending);
        Post(() => Close(session));
    }

    private Session SessionOf(string? id)
    {
        lock (_lock)
        {
            if (id is not null && _sessions.TryGetValue(id, out var session))
            {
                return session;
            }
        }

        throw new InvalidOperationException("Session de transcription inconnue ou fermée : rouvrez-la (asrStart).");
    }

    /// <summary>Essais : rend la main quand tout ce qui est en file est fait.</summary>
    internal Task Idle() => RunAsync(() => 0);

    // --------------------------------------------------------- fil de decodage

    private void FeedOnThread(Session session, float[] samples)
    {
        var more = Interlocked.Decrement(ref session.Pending) > 0;
        if (session.Closed || session.Error is not null)
        {
            return;
        }

        session.Audio.Append(samples);
        try
        {
            // Enonce trop long : la partie la plus ancienne est decodee une fois et figee.
            if (session.Audio.Count > session.Audio.Max)
            {
                FreezeOldest(session);
            }

            // Un paquet deja en file : il fera le partiel, celui-ci serait perime.
            if (!more)
            {
                Partial(session);
            }
        }
        catch (Exception ex)
        {
            Fail(session, ex);
        }
    }

    /// <summary>
    /// Recalcule le partiel s'il est du ; sinon, s'il y a assez d'audio neuf, le prevoit pour l'heure ou il le
    /// sera (l'audio peut cesser d'arriver avant : la page attend le silence pour conclure).
    /// </summary>
    private void Partial(Session session)
    {
        if (Volatile.Read(ref session.Ending) > 0)
        {
            return;
        }

        var now = Environment.TickCount64;
        if (!session.Cadence.Due(now, session.Audio.Count))
        {
            if (session.Cadence.HasNewAudio(session.Audio.Count))
            {
                session.TickGeneration = session.Generation;
                session.Tick ??= new Timer(_ => Post(() => TickOnThread(session)), null, Timeout.Infinite, Timeout.Infinite);
                session.Tick.Change(Math.Max(1, session.Cadence.DueIn(now)), Timeout.Infinite);
            }

            return;
        }

        var text = Join(session.Frozen, Transcribe(session, session.Audio.ToArray(), padding: 0));
        session.Cadence.Decoded(session.Audio.Count, Environment.TickCount64);
        if (text != session.Sent && Volatile.Read(ref session.Ending) == 0)
        {
            session.Sent = text;
            Emit(new JsonObject { ["session"] = session.Id, ["phase"] = "partial", ["text"] = text });
        }
    }

    private void TickOnThread(Session session)
    {
        // Enonce fini, abandonne ou session fermee depuis : plus rien a recalculer ; un paquet en file le fera.
        if (session.Closed || session.Error is not null || session.TickGeneration != session.Generation || Volatile.Read(ref session.Pending) > 0)
        {
            return;
        }

        try
        {
            Partial(session);
        }
        catch (Exception ex)
        {
            Fail(session, ex);
        }
    }

    private void Fail(Session session, Exception ex)
    {
        session.Error = Readable(ex, "Transcription en direct impossible");
        _log.Warn($"ASR : session {session.Id} : {session.Error}");
        Emit(new JsonObject { ["session"] = session.Id, ["phase"] = "error", ["error"] = session.Error });
    }

    private void FreezeOldest(Session session)
    {
        var cut = UtteranceAudio.QuietestCut(session.Audio, SampleRate);
        var head = session.Audio.Take(cut);
        var watch = Stopwatch.StartNew();
        var text = Transcribe(session, head, padding: TailPaddingSamples);
        session.Frozen.Add(text);
        session.Cadence.Rebase(cut);
        _log.Info(string.Create(French, $"ASR : enonce long, {cut / (double)SampleRate:0.0} s figees en {watch.ElapsedMilliseconds} ms"));
    }

    private string EndOnThread(Session session)
    {
        if (session.Closed)
        {
            throw new InvalidOperationException("Session de transcription fermée.");
        }

        if (session.Error is { } error)
        {
            Restart(session);
            throw new InvalidOperationException(error);
        }

        try
        {
            var audio = session.Audio.ToArray();
            var seconds = (audio.Length + session.Cadence.FrozenSamples) / (double)SampleRate;
            var watch = Stopwatch.StartNew();
            var tail = audio.Length > 0 ? Transcribe(session, audio, TailPaddingSamples) : "";
            var text = Join(session.Frozen, tail);
            if (seconds > 0)
            {
                var frozen = session.Frozen.Count > 0 ? $" (+{session.Frozen.Count} bloc(s) fige(s))" : "";
                _log.Info(string.Create(French, $"Parakeet : {seconds:0.0} s d'audio en {watch.ElapsedMilliseconds} ms{frozen}"));
            }

            Restart(session);
            return text;
        }
        catch (Exception ex)
        {
            Restart(session);
            var message = Readable(ex, "Transcription en direct impossible");
            _log.Warn($"ASR : fin d'enonce de la session {session.Id} : {message}");
            throw new InvalidOperationException(message);
        }
    }

    /// <summary>Enonce oublie : audio, partie figee, cadence, dernier partiel, erreur.</summary>
    private static void Restart(Session session)
    {
        session.Generation++;
        session.Tick?.Change(Timeout.Infinite, Timeout.Infinite);
        session.Audio.Clear();
        session.Frozen.Clear();
        session.Cadence.Reset();
        session.Sent = "";
        session.Error = null;
    }

    /// <summary>Un decodage complet sur un flux neuf (un flux hors ligne ne se decode qu'une fois).</summary>
    private string Transcribe(Session session, float[] audio, int padding)
    {
        var engine = EngineFor(session.Model);
        engine.LastUse = Environment.TickCount64;
        if (padding > 0)
        {
            Array.Resize(ref audio, audio.Length + padding);
        }

        return NormalizeText(engine.Recognizer.Transcribe(audio));
    }

    private void Close(Session session)
    {
        session.Closed = true;
        Restart(session);
        session.Tick?.Dispose();
        session.Tick = null;
    }

    private Engine EngineFor(AsrModel model)
    {
        if (_engines.TryGetValue(model.Id, out var existing))
        {
            existing.LastUse = Environment.TickCount64;
            return existing;
        }

        var dir = DirOf(model);
        if (!Installed(model))
        {
            throw new InvalidOperationException("Le modèle de transcription en direct (Parakeet) n'est pas téléchargé ou est incomplet : retéléchargez-le.");
        }

        var watch = Stopwatch.StartNew();
        var before = PrivateBytes();
        var recognizer = _loader(model, dir);
        var engine = new Engine { Recognizer = recognizer };
        _engines[model.Id] = engine;
        _log.Info($"ASR : modele {model.Id} charge en {watch.ElapsedMilliseconds} ms ({Threads} fils, +{(PrivateBytes() - before) / 1024 / 1024} Mo)");
        return engine;
    }

    private void ReleaseIdle()
    {
        var now = Environment.TickCount64;
        foreach (var (id, engine) in _engines.ToArray())
        {
            if (now - engine.LastUse >= (long)IdleRelease.TotalMilliseconds)
            {
                ReleaseEngine(id, "inutilise depuis 10 min");
            }
        }
    }

    /// <summary>Libere l'instance (rechargee au besoin ; les sessions gardent leur audio).</summary>
    private void ReleaseEngine(string id, string why)
    {
        if (!_engines.Remove(id, out var engine))
        {
            return;
        }

        try
        {
            engine.Recognizer.Dispose();
        }
        catch (Exception ex)
        {
            _log.Warn($"ASR : liberation du modele {id} : {ex.Message}");
        }

        _log.Info($"ASR : modele {id} libere ({why})");
    }

    private void Post(Action action)
    {
        try
        {
            _work.Add(action);
        }
        catch (InvalidOperationException)
        {
            // arrete : plus rien a faire
        }
    }

    private Task<T> RunAsync<T>(Func<T> work)
    {
        var done = new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);
        try
        {
            _work.Add(() =>
            {
                try
                {
                    done.SetResult(work());
                }
                catch (Exception ex)
                {
                    done.SetException(ex);
                }
            });
        }
        catch (InvalidOperationException)
        {
            done.SetException(new InvalidOperationException("Transcription en direct arrêtée."));
        }

        return done.Task;
    }

    private void WorkLoop()
    {
        foreach (var action in _work.GetConsumingEnumerable())
        {
            try
            {
                action();
            }
            catch (Exception ex)
            {
                _log.Error("ASR : fil de decodage", ex);
            }
        }
    }

    public void Dispose()
    {
        lock (_lock)
        {
            if (_disposed)
            {
                return;
            }

            _disposed = true;
        }

        _idle.Dispose();
        Session[] sessions;
        lock (_lock)
        {
            sessions = _sessions.Values.ToArray();
            _sessions.Clear();
        }

        foreach (var session in sessions)
        {
            Interlocked.Increment(ref session.Ending);
            Post(() => Close(session));
        }

        Post(() =>
        {
            foreach (var id in _engines.Keys.ToArray())
            {
                ReleaseEngine(id, "arret");
            }
        });
        _work.CompleteAdding();
        _thread.Join(TimeSpan.FromSeconds(2));
    }

    // ------------------------------------------------------------------ sherpa

    /// <summary>Instance sherpa-onnx : fichiers verifies, chemins lisibles par le code natif, puis chauffe a blanc.</summary>
    private IAsrRecognizer LoadSherpa(AsrModel model, string dir)
    {
        // onnxruntime arrete le processus sur un fichier qui n'est pas un modele : on le dit avant.
        var problem = CheckFiles(model, dir);
        if (problem is not null)
        {
            throw new InvalidOperationException($"Modèle de transcription inutilisable ({problem}) : supprimez puis retéléchargez-le.");
        }

        _runtime.PrepareNative("Moteur de transcription absent ou incomplet : supprimez puis retéléchargez le modèle de transcription en direct.", "ASR");
        var native = SherpaRuntime.NativePath(dir, "du modèle de transcription", "de transcription");
        return SherpaRecognizer.Create(model, native, Threads);
    }

    /// <summary>Le modele, avec des chemins deja verifies ; interne pour les essais hors Windows.</summary>
    internal sealed class SherpaRecognizer : IAsrRecognizer
    {
        private readonly OfflineRecognizer _recognizer;

        private SherpaRecognizer(OfflineRecognizer recognizer) => _recognizer = recognizer;

        public static SherpaRecognizer Create(AsrModel model, string dir, int threads)
        {
            var config = new OfflineRecognizerConfig();
            config.FeatConfig.SampleRate = SampleRate;
            config.FeatConfig.FeatureDim = 80;
            config.ModelConfig.Transducer.Encoder = Path.Combine(dir, model.Encoder);
            config.ModelConfig.Transducer.Decoder = Path.Combine(dir, model.Decoder);
            config.ModelConfig.Transducer.Joiner = Path.Combine(dir, model.Joiner);
            config.ModelConfig.Tokens = Path.Combine(dir, model.Tokens);
            config.ModelConfig.ModelType = "nemo_transducer";
            config.ModelConfig.NumThreads = threads;
            config.ModelConfig.Provider = "cpu";
            config.ModelConfig.Debug = 0;
            config.DecodingMethod = "greedy_search";

            var recognizer = new OfflineRecognizer(config);
            // Un reglage refuse laisse un objet sans pointeur natif : le moindre appel tuerait le processus.
            if (RecognizerHandle?.GetValue(recognizer) is HandleRef handle && handle.Handle == IntPtr.Zero)
            {
                GC.SuppressFinalize(recognizer);
                throw new InvalidOperationException("Chargement du modèle de transcription impossible (refusé par le moteur) : supprimez puis retéléchargez-le.");
            }

            var result = new SherpaRecognizer(recognizer);
            try
            {
                // Le tout premier decodage coute plus cher (chauffe) : on le fait a blanc.
                result.Transcribe(new float[SampleRate / 2]);
            }
            catch
            {
                recognizer.Dispose();
                throw;
            }

            return result;
        }

        public string Transcribe(float[] samples)
        {
            var created = _recognizer.CreateStream();
            if (created.Handle == IntPtr.Zero)
            {
                GC.SuppressFinalize(created);
                throw new InvalidOperationException("Flux de transcription impossible à créer.");
            }

            using var stream = created;
            stream.AcceptWaveform(SampleRate, samples);
            _recognizer.Decode(stream);
            return stream.Result.Text ?? "";
        }

        public void Dispose() => _recognizer.Dispose();
    }

    // ------------------------------------------------------------------ outils purs

    /// <summary>Base64 d'Int16 little-endian mono → echantillons dans [-1, 1).</summary>
    public static float[] DecodePcm(string? base64)
    {
        if (string.IsNullOrEmpty(base64))
        {
            return [];
        }

        if (base64.Length > (MaxPacketBytes + 2) / 3 * 4)
        {
            throw new InvalidOperationException("Paquet audio trop long (10 s au plus).");
        }

        byte[] bytes;
        try
        {
            bytes = Convert.FromBase64String(base64);
        }
        catch (FormatException)
        {
            throw new InvalidOperationException("Paquet audio illisible (base64 attendu).");
        }

        if (bytes.Length % 2 != 0)
        {
            throw new InvalidOperationException("Paquet audio tronqué (Int16 attendus).");
        }

        var samples = new float[bytes.Length / 2];
        for (var i = 0; i < samples.Length; i++)
        {
            samples[i] = (short)(bytes[2 * i] | (bytes[2 * i + 1] << 8)) / 32768f;
        }

        return samples;
    }

    /// <summary>
    /// Texte du modele → texte de l'enonce : espaces resserres, rien d'autre (Parakeet ponctue et met la
    /// casse lui-meme).
    /// </summary>
    public static string NormalizeText(string? raw)
        => string.Join(' ', (raw ?? "").Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));

    private static string Join(List<string> frozen, string tail)
        => string.Join(' ', frozen.Append(tail).Where(t => t.Length > 0));

    /// <summary>
    /// Forme des fichiers, a defaut d'empreinte connue : <c>tokens.txt</c> en lignes « symbole rang »,
    /// chaque <c>.onnx</c> un protobuf ModelProto (premier octet 0x08, ir_version) d'au moins 64 Ko.
    /// Rend le probleme, ou <c>null</c>.
    /// </summary>
    public static string? CheckFiles(AsrModel model, string dir)
    {
        try
        {
            var tokens = new FileInfo(Path.Combine(dir, model.Tokens));
            if (!tokens.Exists)
            {
                return model.Tokens + " manque";
            }

            using (var reader = new StreamReader(tokens.FullName))
            {
                var first = reader.ReadLine() ?? "";
                var space = first.LastIndexOf(' ');
                if (space <= 0 || !int.TryParse(first[(space + 1)..], NumberStyles.None, CultureInfo.InvariantCulture, out _))
                {
                    return model.Tokens + " n'est pas une liste de jetons";
                }
            }

            foreach (var name in new[] { model.Encoder, model.Decoder, model.Joiner })
            {
                var info = new FileInfo(Path.Combine(dir, name));
                if (!info.Exists)
                {
                    return name + " manque";
                }

                if (info.Length < 64 * 1024)
                {
                    return $"{name} trop petit ({info.Length} octets)";
                }

                using var stream = info.OpenRead();
                if (stream.ReadByte() != 0x08)
                {
                    return name + " n'est pas un modèle ONNX";
                }
            }

            return null;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return ex.Message;
        }
    }

    private static string Readable(Exception ex, string prefix)
    {
        if (ex is DllNotFoundException or BadImageFormatException or EntryPointNotFoundException)
        {
            return "Moteur de transcription introuvable : " + ex.Message + " Supprimez puis retéléchargez le modèle de transcription en direct.";
        }

        return ex is InvalidOperationException ? ex.Message : prefix + " : " + ex.Message;
    }

    private static long PrivateBytes()
    {
        using var process = Process.GetCurrentProcess();
        return process.PrivateMemorySize64;
    }

    private void Emit(JsonObject payload)
    {
        try
        {
            Progress?.Invoke(payload);
        }
        catch (Exception ex)
        {
            Debug.WriteLine("[Organizator] LiveAsr.Progress : " + ex.Message);
        }
    }

    private static void TryDelete(string path)
    {
        try
        {
            if (File.Exists(path))
            {
                File.Delete(path);
            }
        }
        catch (Exception)
        {
            // fichier verrouille : il sera ecrase au prochain essai
        }
    }
}

/// <summary>Le modele charge : un decodage complet d'un enonce (appels sur le fil de decodage seulement).</summary>
internal interface IAsrRecognizer : IDisposable
{
    /// <summary>Texte brut de l'audio (16 kHz mono, [-1, 1)), decode sur un flux neuf.</summary>
    string Transcribe(float[] samples);
}

/// <summary>
/// Cadence des partiels d'une session : un recalcul est du si au moins <c>minNewSamples</c> echantillons sont
/// arrives depuis le dernier et si <c>everyMs</c> se sont ecoules depuis la fin du dernier decodage (le
/// processeur reste libre entre deux).
/// </summary>
public sealed class PartialCadence(int everyMs, int minNewSamples)
{
    private long _lastEnd = long.MinValue / 2;
    private int _decoded;

    /// <summary>Echantillons figes (decodes une fois, retires du tampon) depuis le debut de l'enonce.</summary>
    public long FrozenSamples { get; private set; }

    public bool Due(long nowMs, int samples) => HasNewAudio(samples) && nowMs - _lastEnd >= everyMs;

    public bool HasNewAudio(int samples) => samples - _decoded >= minNewSamples;

    /// <summary>Delai avant que l'intervalle soit ecoule (0 : deja).</summary>
    public long DueIn(long nowMs) => Math.Max(0, _lastEnd + everyMs - nowMs);

    public void Decoded(int samples, long endMs)
    {
        _decoded = samples;
        _lastEnd = endMs;
    }

    /// <summary>Les <paramref name="removed"/> premiers echantillons ont ete figes et retires du tampon.</summary>
    public void Rebase(int removed)
    {
        _decoded = Math.Max(0, _decoded - removed);
        FrozenSamples += removed;
    }

    public void Reset()
    {
        _decoded = 0;
        _lastEnd = long.MinValue / 2;
        FrozenSamples = 0;
    }
}

/// <summary>Audio de l'enonce en cours (tampon qui grandit, retrait par la tete).</summary>
public sealed class UtteranceAudio(int max)
{
    private float[] _buffer = new float[16000];

    /// <summary>Au-dela, la tete est figee.</summary>
    public int Max { get; } = max;

    public int Count { get; private set; }

    public float this[int index] => _buffer[index];

    public void Append(float[] samples)
    {
        if (Count + samples.Length > _buffer.Length)
        {
            Array.Resize(ref _buffer, Math.Max(_buffer.Length * 2, Count + samples.Length));
        }

        samples.CopyTo(_buffer, Count);
        Count += samples.Length;
    }

    public float[] ToArray() => _buffer.AsSpan(0, Count).ToArray();

    /// <summary>Rend les <paramref name="count"/> premiers echantillons et les retire du tampon.</summary>
    public float[] Take(int count)
    {
        count = Math.Clamp(count, 0, Count);
        var head = _buffer.AsSpan(0, count).ToArray();
        _buffer.AsSpan(count, Count - count).CopyTo(_buffer);
        Count -= count;
        return head;
    }

    public void Clear()
    {
        Count = 0;
        if (_buffer.Length > 16000 * 8)
        {
            // Un long enonce ne garde pas son tampon.
            _buffer = new float[16000];
        }
    }

    /// <summary>
    /// Ou couper un enonce trop long : au milieu de la fenetre de 200 ms la plus calme (pas de 50 ms) entre la
    /// moitie de <see cref="Max"/> et <see cref="Max"/> moins 5 s, pour ne pas trancher un mot ; a egalite, la
    /// plus tardive.
    /// </summary>
    public static int QuietestCut(UtteranceAudio audio, int sampleRate)
    {
        var window = sampleRate / 5;
        var step = sampleRate / 20;
        var from = audio.Max / 2;
        var to = Math.Min(audio.Count, audio.Max) - 5 * sampleRate - window;
        if (to <= from)
        {
            return Math.Min(audio.Count, audio.Max / 2);
        }

        var best = from;
        var bestEnergy = double.MaxValue;
        for (var start = from; start <= to; start += step)
        {
            double energy = 0;
            for (var i = start; i < start + window; i++)
            {
                energy += audio[i] * audio[i];
            }

            if (energy <= bestEnergy)
            {
                bestEnergy = energy;
                best = start;
            }
        }

        return best + window / 2;
    }
}
