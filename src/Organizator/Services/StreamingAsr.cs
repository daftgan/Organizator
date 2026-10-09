using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using SherpaOnnx;

namespace Organizator.Services;

/// <summary>
/// Un modele de reconnaissance en flux (Zipformer transducteur, int8) sur Hugging Face.
/// <paramref name="Size"/> : taille approximative (Mo annonces avant le telechargement) ; la taille
/// reelle est celle que le serveur annonce, retenue dans <c>manifest.json</c>.
/// </summary>
public sealed record AsrModel(string Id, string Label, string Repo, string Revision,
    string Encoder, string Decoder, string Joiner, string Tokens, long Size)
{
    public IEnumerable<string> FileNames => [Tokens, Decoder, Joiner, Encoder];
}

/// <summary>
/// Transcription en direct, en local, sur le processeur : sherpa-onnx 1.13.8 (<see cref="OnlineRecognizer"/>)
/// et des modeles Zipformer transducteurs en flux (int8), anglais et francais. Rien ne sort du poste.
///
/// <list type="bullet">
/// <item><description>Le runtime natif est celui de la synthese vocale (<see cref="SherpaRuntime"/>,
/// telecharge seul si les voix Kokoro ne sont pas installees). Les modeles sont pris fichier par
/// fichier sur Hugging Face (<see cref="Models"/>, table a corriger si un depot change) sous
/// <c>&lt;donnees&gt;\asr\&lt;id&gt;\</c> : <c>.part</c> puis renomme, taille annoncee par le serveur,
/// SHA-256 calcule et journalise (aucune empreinte connue a comparer), puis <c>manifest.json</c>
/// qui fait foi de l'installation.</description></item>
/// <item><description>Une instance par langue, chargee a la demande (<c>asrWarm</c>, <c>asrStart</c>),
/// liberee apres dix minutes sans usage ; une session dormante la recharge d'elle-meme.</description></item>
/// <item><description>Tout le calcul (chargement, decodage, fin d'enonce) passe par un seul fil dedie,
/// dans l'ordre d'arrivee : <c>asrFeed</c> rend la main aussitot, <c>asrEnd</c> attend que les paquets
/// deja recus soient decodes.</description></item>
/// <item><description>Pas d'endpoint sherpa : la VAD de la page decide de la fin d'enonce. Le texte
/// partiel part par <see cref="Progress"/> des qu'il change, dix fois par seconde au plus :
/// <c>{ session, phase: partial, text }</c> ; les telechargements : <c>{ phase: download, lang, received,
/// total }</c>, <c>downloaded</c>, <c>download-failed { error }</c> ; un echec de decodage :
/// <c>{ session, phase: error, error }</c>.</description></item>
/// </list>
/// </summary>
public sealed class StreamingAsr : IDisposable
{
    public const int SampleRate = 16000;

    /// <summary>
    /// Modeles proposes. Noms tires de la documentation de sherpa-onnx, NON verifies depuis la machine de
    /// developpement (pas d'acces a Hugging Face) : a corriger ici seulement si un fichier est introuvable.
    /// Tailles approximatives.
    /// </summary>
    public static readonly IReadOnlyList<AsrModel> Models =
    [
        new("en", "Anglais (Zipformer en flux, 2023-06-26)", "csukuangfj/sherpa-onnx-streaming-zipformer-en-2023-06-26", "main",
            Encoder: "encoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx",
            Decoder: "decoder-epoch-99-avg-1-chunk-16-left-128.onnx",
            Joiner: "joiner-epoch-99-avg-1-chunk-16-left-128.int8.onnx",
            Tokens: "tokens.txt",
            Size: 71_000_000),
        new("fr", "Français (Zipformer en flux, 2023-04-14)", "shaojieli/sherpa-onnx-streaming-zipformer-fr-2023-04-14", "main",
            Encoder: "encoder-epoch-29-avg-9-with-averaged-model.int8.onnx",
            Decoder: "decoder-epoch-29-avg-9-with-averaged-model.onnx",
            Joiner: "joiner-epoch-29-avg-9-with-averaged-model.int8.onnx",
            Tokens: "tokens.txt",
            Size: 127_000_000),
    ];

    private const string ManifestName = "manifest.json";
    private const long MaxFileSize = 600L * 1024 * 1024;

    private static readonly TimeSpan IdleRelease = TimeSpan.FromMinutes(10);
    private static readonly TimeSpan IdleCheck = TimeSpan.FromMinutes(1);
    private static readonly TimeSpan ProgressEvery = TimeSpan.FromMilliseconds(250);

    /// <summary>Au plus un partiel par 100 ms et par session.</summary>
    public const int PartialEveryMs = 100;

    /// <summary>Paquets en attente de decodage au-dela desquels la session est declaree en retard (~10 s d'audio).</summary>
    public const int MaxPending = 100;

    /// <summary>Paquet le plus long accepte (10 s d'Int16 mono a 16 kHz).</summary>
    public const int MaxPacketBytes = SampleRate * 2 * 10;

    public const int MaxSessions = 4;

    /// <summary>Silence ajoute avant <c>InputFinished</c> : le dernier bloc de l'encodeur (chunk 16, ~0,4 s) est vide.</summary>
    private const int TailPaddingSamples = SampleRate * 45 / 100;

    // Decodage en flux : deux fils suffisent (blocs de 0,3 s), le reste du CPU sert a l'avatar.
    private static readonly int Threads = Math.Clamp(Environment.ProcessorCount / 4, 1, 2);

    private static readonly FieldInfo? RecognizerHandle = typeof(OnlineRecognizer).GetField("_handle", BindingFlags.Instance | BindingFlags.NonPublic);

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

    public StreamingAsr(string dataDir, HostLog log, string version, SherpaRuntime runtime)
        : this(dataDir, log, version, runtime, null)
    {
    }

    /// <param name="loader">Chargeur d'instance (essais) ; par defaut, sherpa-onnx.</param>
    internal StreamingAsr(string dataDir, HostLog log, string version, SherpaRuntime runtime,
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
        _idle = new Timer(_ => Post(ReleaseIdle), null, IdleCheck, IdleCheck);
    }

    /// <summary>Texte partiel et telechargements (fil quelconque).</summary>
    public event Action<JsonObject>? Progress;

    public string Root => _root;

    public static AsrModel FindModel(string? lang)
    {
        var id = (lang ?? "").Trim().ToLowerInvariant();
        if (id.Length > 2 && (id[2] == '-' || id[2] == '_'))
        {
            id = id[..2];
        }

        return Models.FirstOrDefault(m => m.Id == id)
            ?? throw new InvalidOperationException($"Langue de transcription en direct inconnue : {lang} (en ou fr attendu).");
    }

    private string DirOf(AsrModel model) => Path.Combine(_root, model.Id);

    // ------------------------------------------------------------------ etat

    /// <summary><c>{ runtime: { downloaded, version, size }, models: [{ id, label, repo, size, downloaded, downloading, received, total }] }</c></summary>
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

    /// <summary>Modele de la langue installe (manifeste conforme a la table, fichiers entiers) et runtime present.</summary>
    public bool IsReady(string lang) => _runtime.Present && Installed(FindModel(lang));

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
    /// Telecharge le modele d'une langue (et le runtime s'il manque) ; un seul telechargement par langue,
    /// partage. Rend <c>{ ok: true }</c>, ou <c>{ ok: false, error }</c> (deja annonce par
    /// <c>download-failed</c>) : la page retombe alors sur Whisper.
    /// </summary>
    public async Task<JsonObject> DownloadAsync(string? lang)
    {
        var model = FindModel(lang);
        if (IsReady(model.Id))
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
    /// Interrompt le telechargement de la langue, ou supprime son modele (sessions ouvertes : elles
    /// echoueront au prochain paquet) ; le runtime part aussi si plus personne n'en a besoin.
    /// </summary>
    public async Task<bool> RemoveAsync(string? lang)
    {
        var model = FindModel(lang);
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

        // L'instance et les flux se liberent sur le fil de decodage, avant l'effacement des fichiers.
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
        public IAsrStream? Stream;
        public readonly PartialThrottle Throttle = new(PartialEveryMs);
        public int Generation;
        public int Pending;
        public string? Error;
        public bool Closed;
        public long LastUse = Environment.TickCount64;
        public Timer? Flush;
        public int FlushGeneration;
    }

    private sealed class Engine
    {
        public required IAsrRecognizer Recognizer { get; init; }
        public long LastUse = Environment.TickCount64;
    }

    /// <summary>Charge l'instance de la langue en arriere-plan ; sans effet si le modele n'est pas installe.</summary>
    public void Warm(string? lang)
    {
        var model = FindModel(lang);
        if (!IsReady(model.Id))
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

    /// <summary>Ouvre une session : modele charge et flux pret, ou erreur lisible (la page retombe sur Whisper).</summary>
    public async Task<string> StartAsync(string? lang)
    {
        var model = FindModel(lang);
        if (!Installed(model))
        {
            throw new InvalidOperationException($"Le modèle de transcription en direct ({model.Id}) n'est pas téléchargé.");
        }

        if (!_runtime.Present)
        {
            throw new InvalidOperationException("Moteur de transcription absent : retéléchargez le modèle de transcription en direct.");
        }

        var session = new Session { Id = Guid.NewGuid().ToString("N")[..12], Model = model };
        await RunAsync(() =>
        {
            var engine = EngineFor(model);
            session.Stream = engine.Recognizer.CreateStream();
            return 0;
        }).ConfigureAwait(false);

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
    /// Un paquet de PCM (base64 d'Int16 LE mono 16 kHz), decode sur le fil dedie ; rend la main aussitot.
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

    /// <summary>Fin d'enonce : decode ce qui reste et rend le texte final ; la session repart a zero.</summary>
    public Task<string> EndAsync(string? sessionId)
    {
        var session = SessionOf(sessionId);
        Volatile.Write(ref session.LastUse, Environment.TickCount64);
        return RunAsync(() => EndOnThread(session));
    }

    /// <summary>Abandonne l'enonce en cours (bruit) : l'audio recu est oublie.</summary>
    public Task ResetAsync(string? sessionId)
    {
        var session = SessionOf(sessionId);
        return RunAsync(() =>
        {
            Restart(session);
            return 0;
        });
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

    // --------------------------------------------------------- fil de decodage

    private void FeedOnThread(Session session, float[] samples)
    {
        Interlocked.Decrement(ref session.Pending);
        if (session.Closed || session.Error is not null)
        {
            return;
        }

        try
        {
            var stream = StreamOf(session);
            stream.Accept(samples);
            var text = NormalizeText(stream.Decode(), session.Model.Id, final: false);
            var now = Environment.TickCount64;
            if (session.Throttle.Offer(text, now, out var emit))
            {
                EmitPartial(session, emit!);
            }
            else if (session.Throttle.HasPending)
            {
                ScheduleFlush(session, session.Throttle.DueIn(now));
            }
        }
        catch (Exception ex)
        {
            session.Error = Readable(ex, "Transcription en direct impossible");
            _log.Warn($"ASR : session {session.Id} : {session.Error}");
            Emit(new JsonObject { ["session"] = session.Id, ["phase"] = "error", ["error"] = session.Error });
            DropStream(session);
        }
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
            var raw = session.Stream?.Finish() ?? "";
            var text = NormalizeText(raw, session.Model.Id, final: true);
            Restart(session);
            return text;
        }
        catch (Exception ex)
        {
            DropStream(session);
            session.Generation++;
            session.Throttle.Reset();
            var message = Readable(ex, "Transcription en direct impossible");
            _log.Warn($"ASR : fin d'enonce de la session {session.Id} : {message}");
            throw new InvalidOperationException(message);
        }
    }

    /// <summary>Flux neuf (l'ancien, fini ou abandonne, est libere), compteur d'enonce avance.</summary>
    private void Restart(Session session)
    {
        DropStream(session);
        session.Generation++;
        session.Throttle.Reset();
        session.Error = null;
        if (session.Closed)
        {
            return;
        }

        try
        {
            StreamOf(session);
        }
        catch (Exception ex)
        {
            // Le prochain paquet redira l'erreur.
            _log.Warn($"ASR : session {session.Id} : flux non recree : {ex.Message}");
        }
    }

    private IAsrStream StreamOf(Session session)
    {
        if (session.Stream is { } stream)
        {
            if (_engines.TryGetValue(session.Model.Id, out var loaded))
            {
                loaded.LastUse = Environment.TickCount64;
            }

            return stream;
        }

        // Session dormante (instance liberee) : rechargee d'elle-meme.
        var engine = EngineFor(session.Model);
        session.Stream = engine.Recognizer.CreateStream();
        return session.Stream;
    }

    private void DropStream(Session session)
    {
        var stream = session.Stream;
        session.Stream = null;
        try
        {
            stream?.Dispose();
        }
        catch (Exception ex)
        {
            _log.Warn($"ASR : liberation du flux {session.Id} : {ex.Message}");
        }
    }

    private void Close(Session session)
    {
        session.Closed = true;
        session.Generation++;
        session.Flush?.Dispose();
        session.Flush = null;
        DropStream(session);
    }

    private void ScheduleFlush(Session session, long dueMs)
    {
        session.FlushGeneration = session.Generation;
        session.Flush ??= new Timer(_ => Post(() => FlushOnThread(session)), null, Timeout.Infinite, Timeout.Infinite);
        session.Flush.Change(Math.Max(1, dueMs), Timeout.Infinite);
    }

    private void FlushOnThread(Session session)
    {
        // Enonce fini ou abandonne depuis : le partiel en attente est perime.
        if (session.Closed || session.FlushGeneration != session.Generation)
        {
            return;
        }

        if (session.Throttle.Flush(Environment.TickCount64, out var text))
        {
            EmitPartial(session, text!);
        }
        else if (session.Throttle.HasPending)
        {
            ScheduleFlush(session, session.Throttle.DueIn(Environment.TickCount64));
        }
    }

    private void EmitPartial(Session session, string text)
        => Emit(new JsonObject { ["session"] = session.Id, ["phase"] = "partial", ["text"] = text });

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
            throw new InvalidOperationException($"Le modèle de transcription en direct ({model.Id}) n'est pas téléchargé ou est incomplet : retéléchargez-le.");
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

    /// <summary>Libere l'instance de la langue, et d'abord les flux des sessions qui s'en servent (rechargee au besoin).</summary>
    private void ReleaseEngine(string id, string why)
    {
        if (!_engines.Remove(id, out var engine))
        {
            return;
        }

        Session[] sessions;
        lock (_lock)
        {
            sessions = _sessions.Values.Where(s => s.Model.Id == id).ToArray();
        }

        foreach (var session in sessions)
        {
            DropStream(session);
            session.Generation++;
            session.Throttle.Reset();
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

    /// <summary>Le modele, avec des chemins deja verifies ; public pour les essais hors Windows.</summary>
    internal sealed class SherpaRecognizer : IAsrRecognizer
    {
        private readonly OnlineRecognizer _recognizer;

        private SherpaRecognizer(OnlineRecognizer recognizer) => _recognizer = recognizer;

        public static SherpaRecognizer Create(AsrModel model, string dir, int threads)
        {
            var config = new OnlineRecognizerConfig();
            config.FeatConfig.SampleRate = SampleRate;
            config.FeatConfig.FeatureDim = 80;
            config.ModelConfig.Transducer.Encoder = Path.Combine(dir, model.Encoder);
            config.ModelConfig.Transducer.Decoder = Path.Combine(dir, model.Decoder);
            config.ModelConfig.Transducer.Joiner = Path.Combine(dir, model.Joiner);
            config.ModelConfig.Tokens = Path.Combine(dir, model.Tokens);
            config.ModelConfig.NumThreads = threads;
            config.ModelConfig.Provider = "cpu";
            config.ModelConfig.Debug = 0;
            config.DecodingMethod = "greedy_search";
            // La VAD de la page decide de la fin d'enonce.
            config.EnableEndpoint = 0;

            var recognizer = new OnlineRecognizer(config);
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
                using var warm = result.CreateStream();
                warm.Accept(new float[SampleRate / 2]);
                warm.Finish();
            }
            catch
            {
                recognizer.Dispose();
                throw;
            }

            return result;
        }

        public IAsrStream CreateStream()
        {
            var stream = _recognizer.CreateStream();
            if (stream.Handle == IntPtr.Zero)
            {
                throw new InvalidOperationException("Flux de transcription impossible à créer.");
            }

            return new SherpaStream(_recognizer, stream);
        }

        public void Dispose() => _recognizer.Dispose();
    }

    private sealed class SherpaStream(OnlineRecognizer recognizer, OnlineStream stream) : IAsrStream
    {
        public void Accept(float[] samples) => stream.AcceptWaveform(SampleRate, samples);

        public string Decode()
        {
            while (recognizer.IsReady(stream))
            {
                recognizer.Decode(stream);
            }

            return recognizer.GetResult(stream).Text ?? "";
        }

        public string Finish()
        {
            stream.AcceptWaveform(SampleRate, new float[TailPaddingSamples]);
            stream.InputFinished();
            return Decode();
        }

        public void Dispose() => stream.Dispose();
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

    private static readonly Dictionary<string, string> EnglishI = new(StringComparer.Ordinal)
    {
        ["i"] = "I", ["i'm"] = "I'm", ["i've"] = "I've", ["i'll"] = "I'll", ["i'd"] = "I'd",
    };

    /// <summary>
    /// Texte du modele → texte lisible : espaces resserres ; tout en MAJUSCULES (modeles anglais) →
    /// minuscules ; en anglais, « i » → « I » ; premiere lettre en majuscule ; point final seulement
    /// pour le texte final, s'il ne finit pas deja par une ponctuation.
    /// </summary>
    public static string NormalizeText(string? raw, string lang, bool final)
    {
        var words = (raw ?? "").Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
        if (words.Length == 0)
        {
            return "";
        }

        var text = string.Join(' ', words);
        var letters = text.Where(char.IsLetter).ToArray();
        if (letters.Length > 0 && letters.All(char.IsUpper))
        {
            text = text.ToLowerInvariant();
        }

        if (lang == "en")
        {
            var parts = text.Split(' ');
            for (var i = 0; i < parts.Length; i++)
            {
                if (EnglishI.TryGetValue(parts[i], out var fixedWord))
                {
                    parts[i] = fixedWord;
                }
            }

            text = string.Join(' ', parts);
        }

        var first = 0;
        while (first < text.Length && !char.IsLetter(text[first]))
        {
            first++;
        }

        if (first < text.Length)
        {
            text = text[..first] + char.ToUpper(text[first], CultureInfo.InvariantCulture) + text[(first + 1)..];
        }

        if (final && !".!?…".Contains(text[^1]))
        {
            text += ".";
        }

        return text;
    }

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
            Debug.WriteLine("[Organizator] StreamingAsr.Progress : " + ex.Message);
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

/// <summary>Une instance de reconnaissance en flux (une langue).</summary>
internal interface IAsrRecognizer : IDisposable
{
    IAsrStream CreateStream();
}

/// <summary>Un enonce en cours : appels sur le fil de decodage seulement.</summary>
internal interface IAsrStream : IDisposable
{
    void Accept(float[] samples);

    /// <summary>Decode ce qui est pret ; rend le texte brut de l'enonce jusque-la.</summary>
    string Decode();

    /// <summary>Fin d'enonce : silence de fin, InputFinished, dernier decodage ; texte brut final.</summary>
    string Finish();
}

/// <summary>
/// Limite les partiels : un texte change part aussitot si le dernier envoi date d'au moins
/// <c>intervalMs</c>, sinon il attend (<see cref="HasPending"/>, <see cref="DueIn"/>, <see cref="Flush"/>) ;
/// seul le plus recent compte. Un texte identique au dernier envoye ne repart pas.
/// </summary>
public sealed class PartialThrottle(int intervalMs)
{
    private string _sent = "";
    private string? _pending;
    private long _lastAt = long.MinValue / 2;

    public bool HasPending => _pending is not null;

    public bool Offer(string text, long nowMs, out string? emit)
    {
        emit = null;
        if (text == _sent)
        {
            _pending = null;
            return false;
        }

        if (nowMs - _lastAt >= intervalMs)
        {
            return Send(text, nowMs, out emit);
        }

        _pending = text;
        return false;
    }

    public long DueIn(long nowMs) => Math.Max(0, _lastAt + intervalMs - nowMs);

    public bool Flush(long nowMs, out string? emit)
    {
        emit = null;
        if (_pending is null || nowMs - _lastAt < intervalMs)
        {
            return false;
        }

        var text = _pending;
        _pending = null;
        return text != _sent && Send(text, nowMs, out emit);
    }

    public void Reset()
    {
        _sent = "";
        _pending = null;
        _lastAt = long.MinValue / 2;
    }

    private bool Send(string text, long nowMs, out string? emit)
    {
        _sent = text;
        _pending = null;
        _lastAt = nowMs;
        emit = text;
        return true;
    }
}
