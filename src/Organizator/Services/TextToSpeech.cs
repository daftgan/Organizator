using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Net.Http;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using SherpaOnnx;

namespace Organizator.Services;

/// <param name="Id">Identifiant Kokoro (<c>af_heart</c>...), valeur des reglages de la page.</param>
/// <param name="Sid">Rang du locuteur dans <c>voices.bin</c> de kokoro-multi-lang-v1_0.</param>
/// <param name="Gender"><c>F</c> ou <c>M</c>.</param>
/// <param name="Grade">Note de qualite donnee par hexgrad/Kokoro-82M (VOICES.md).</param>
public sealed record TtsVoice(string Id, int Sid, string Accent, string Gender, string Grade, string Label);

/// <summary>Une replique d'un script : identifiant rendu tel quel a la page, voix, texte.</summary>
public sealed record TtsLine(string Id, string Voice, string Text);

/// <summary>
/// Synthese vocale anglaise neuronale, en local, sur le processeur : sherpa-onnx 1.13.8 et le modele
/// Kokoro v1.0 (fp32), voix americaines et britanniques. Rien ne sort du poste.
///
/// <list type="bullet">
/// <item><description>Rien n'est embarque dans l'exe : les deux DLL natives (onnxruntime 1.28.2 et
/// sherpa-onnx-c-api, 21 Mo) sont extraites du paquet NuGet du runtime win-x64, le modele est pris
/// fichier par fichier sur le miroir Hugging Face de l'auteur de sherpa-onnx, a une revision epinglee.
/// Chaque fichier est controle (taille et SHA-256 en dur), ecrit en <c>.part</c> puis renomme : un
/// fichier present est entier. Un seul telechargement, partage par tous ceux qui l'attendent.</description></item>
/// <item><description>Le code natif ne sait lire que des chemins ASCII de moins de 260 caracteres, et un
/// reglage invalide ne leve rien a la construction : le premier appel tue alors le processus
/// (<see cref="AccessViolationException"/>). Chaque fichier est donc verifie avant
/// <c>new OfflineTts</c>, et les chemins passent par leur nom court 8.3.</description></item>
/// <item><description>Une instance par accent (lexique US ou GB, choisi a la creation), chargee a la
/// demande, liberee apres cinq minutes sans usage (pres de 1 Go chacune). Une synthese a la fois.</description></item>
/// <item><description>Le texte est decoupe en phrases ; chacune est synthetisee, ecrite dans le cache
/// (<c>cache\ab\&lt;cle&gt;.wav</c>, servi sous <see cref="Host"/>) et annoncee aussitot : la page commence
/// la lecture a la premiere. Une phrase deja dite ne coute plus rien.</description></item>
/// <item><description>L'avancement part par <see cref="Progress"/> (fil quelconque) :
/// <c>{ job?, model?, phase: download | downloaded | download-failed | queue | load | synthesize | sentence | done | error, ... }</c>.</description></item>
/// </list>
/// </summary>
public sealed class TextToSpeech
{
    /// <summary>Hote virtuel de la WebView sur le cache des phrases synthetisees.</summary>
    public const string Host = "tts.organizator";

    public const string RuntimeVersion = "1.13.8";
    public const string ModelId = "kokoro-v1_0";
    public const string ModelLabel = "Kokoro v1.0";

    public const long CacheMax = 500L * 1024 * 1024;
    public const int MaxSpeakChars = 4000;
    public const int MaxScriptLines = 60;
    public const int MaxScriptChars = 12000;
    public const float MinSpeed = 0.7f;
    public const float MaxSpeed = 1.3f;

    public const string AccentUs = "en-US";
    public const string AccentGb = "en-GB";

    /// <summary>Voix proposees : les mieux notees de chaque accent et de chaque sexe.</summary>
    public static readonly IReadOnlyList<TtsVoice> Voices =
    [
        new("af_heart", 3, AccentUs, "F", "A", "Heart"),
        new("af_bella", 2, AccentUs, "F", "A-", "Bella"),
        new("af_nicole", 6, AccentUs, "F", "B-", "Nicole"),
        new("am_michael", 16, AccentUs, "M", "C+", "Michael"),
        new("am_puck", 18, AccentUs, "M", "C+", "Puck"),
        new("am_fenrir", 14, AccentUs, "M", "C+", "Fenrir"),
        new("bf_emma", 21, AccentGb, "F", "B-", "Emma"),
        new("bf_isabella", 22, AccentGb, "F", "C", "Isabella"),
        new("bm_george", 26, AccentGb, "M", "C", "George"),
        new("bm_fable", 25, AccentGb, "M", "C", "Fable"),
    ];

    // Revision du depot csukuangfj/kokoro-multi-lang-v1_0 (2026-09-08) : un depot personnel, les
    // empreintes ci-dessous protegent d'un fichier change sous le meme nom.
    private const string ModelRevision = "f7b96bb6bef5c5da4d3aa4f4e0498fbbf62dc78b";
    private const string ModelBase = "https://huggingface.co/csukuangfj/kokoro-multi-lang-v1_0/resolve/" + ModelRevision + "/";

    // Le paquet NuGet du runtime win-x64, dont on n'extrait que les deux DLL ; son SHA-512 est celui
    // que NuGet verifie (org.k2fsa.sherpa.onnx.runtime.win-x64.1.13.8.nupkg.sha512).
    private const string RuntimeUrl = "https://api.nuget.org/v3-flatcontainer/org.k2fsa.sherpa.onnx.runtime.win-x64/1.13.8/org.k2fsa.sherpa.onnx.runtime.win-x64.1.13.8.nupkg";
    private const long RuntimeSize = 8_535_869;
    private const string RuntimeSha512 = "7ZpIieyGnrhTBTPDeQsq5S36Qe3wxGHFAB/Hl3Q7zrhJ7ayb4co0oCI+ZY6MDC1p519T3DqUIPRUO6g47GSKkw==";
    private const string RuntimeEntry = "runtimes/win-x64/native/";

    private sealed record Asset(string Path, long Size, string Sha256);

    private static readonly Asset[] RuntimeFiles =
    [
        new("onnxruntime.dll", 17_799_168, "7f66f939a881baf4f46a2216496798edf4a1429878b646d12674aa62f27d8a25"),
        new("sherpa-onnx-c-api.dll", 4_605_952, "2729a0da3fbd20fb4e14e157f7cc0e00af848b55f04121319d445c138aeba214"),
    ];

    // Petits fichiers d'abord : un echec reseau se voit avant les 325 Mo du modele. espeak-ng-data est
    // reduit aux 9 fichiers de l'anglais (0,8 Mo au lieu de 18) : meme transcription Whisper, US et GB.
    private static readonly Asset[] ModelFiles =
    [
        new("tokens.txt", 687, "6ebb6bb288f20f3ae8d004d3c2ca27697da27c037d75e81a60e2a6a663f95425"),
        new("espeak-ng-data/phontab", 55_796, "886f3fa402cb0ba73d483aa8ad000af47a6b7cc06293c75a97913fba68a530f6"),
        new("espeak-ng-data/phonindex", 39_074, "3ca7b8fa3b42624e4b0f152707e7a39245fce569aa99ea47c055d9e622fcf0c4"),
        new("espeak-ng-data/phondata", 550_424, "4e0288957874029a8c3c9f41a8f517ad4bf18127046decbdd4b9d1d6807ce3a3"),
        new("espeak-ng-data/phondata-manifest", 21_821, "7b387af0702c7cf0b61f0bead68feded0bd8e1620729b0b252e76acbc30d3813"),
        new("espeak-ng-data/intonations", 2_040, "3f8af65fd3eda9759a10f021d61361c120871f463515229c925995c7f90918cc"),
        new("espeak-ng-data/en_dict", 166_944, "71bd330ba8a2e3e8076e631508208ef49449d6147c17b7bd2b4b1e1468292e35"),
        new("espeak-ng-data/lang/gmw/en", 140, "4605d5330801de3641c6e366d15f129ea1f5ffbce8722642aba01ace07ab9c83"),
        new("espeak-ng-data/lang/gmw/en-US", 257, "41534c2a22df5dd4f1052ff9e1a33a3ea7bff5a26b5c02bdad5ba8ddb7524704"),
        new("espeak-ng-data/lang/gmw/en-GB-x-rp", 249, "d0625af7f58561b1b8cf96fd7f93eee6553bcb3eadb9020ae0757bf96e5115e5"),
        new("lexicon-us-en.txt", 5_956_885, "7daaab53a181be9885b853a8582bf1838186317e5dadacbcef9c426d6fa0da14"),
        new("lexicon-gb-en.txt", 6_366_635, "c4cbb37316f62210dff52718a7afcaae24f50c032cc75ab47ae67b831d1049e7"),
        new("voices.bin", 28_200_960, "1c5a5b983d3d50d8586d437a51f3faa2da7919ce76a013c081e65671a3447c29"),
        new("model.onnx", 325_560_556, "b40f62b166ac8164b0627ef48a0b358eda0985e272fb03ef5252e7206305da11"),
    ];

    private static readonly long ModelSize = ModelFiles.Sum(f => f.Size);

    // Le code natif (espeak-ng) borne ses chemins : on garde de la marge sous MAX_PATH.
    private const int NativePathLimit = 240;

    private static readonly TimeSpan IdleRelease = TimeSpan.FromMinutes(5);
    private static readonly TimeSpan ProgressEvery = TimeSpan.FromMilliseconds(250);
    private static readonly TimeSpan StallTimeout = TimeSpan.FromSeconds(60);

    // Le gain s'arrete vers 6 fils : au-dela, le calcul deborde sur les coeurs E et LP-E, plus lents.
    private static readonly int Threads = Math.Clamp(Environment.ProcessorCount / 2, 2, 6);

    private static readonly HttpClient Http = new(new SocketsHttpHandler { ConnectTimeout = TimeSpan.FromSeconds(20) })
    {
        Timeout = Timeout.InfiniteTimeSpan,
    };

    // Les DLL natives ne se chargent qu'une fois par processus : le resolveur de DllImport ne se pose
    // qu'une fois, et une DLL liberee laisserait des appels lies a une adresse morte.
    private static readonly object NativeLock = new();
    private static IntPtr _nativeApi;
    private static string? _nativeDir;

    private static readonly FieldInfo? TtsHandle = typeof(OfflineTts).GetField("_handle", BindingFlags.Instance | BindingFlags.NonPublic);

    private readonly HostLog _log;
    private readonly string _root;
    private readonly string _runtimeDir;
    private readonly string _modelDir;
    private readonly string _cacheDir;
    private readonly string _removeMarker;
    private readonly string _version;
    private readonly object _lock = new();
    private readonly object _cacheLock = new();
    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly Dictionary<string, Engine> _engines = new(StringComparer.Ordinal);
    private readonly Dictionary<string, CancellationTokenSource> _jobs = new(StringComparer.Ordinal);
    private readonly Timer _idle;

    private Download? _download;
    private int _busy;
    private long _cacheBytes = -1;
    private int _cacheFiles;

    public TextToSpeech(string dataDir, HostLog log, string version)
    {
        _log = log;
        _root = Path.Combine(dataDir, "tts");
        _runtimeDir = Path.Combine(_root, "runtime-" + RuntimeVersion);
        _modelDir = Path.Combine(_root, ModelId);
        _cacheDir = Path.Combine(_root, "cache");
        _removeMarker = _runtimeDir + ".remove";
        _version = version;
        _idle = new Timer(_ => ReleaseIfIdle(), null, Timeout.Infinite, Timeout.Infinite);

        try
        {
            // Le dossier est mappe sur l'hote virtuel des le demarrage : il doit exister.
            Directory.CreateDirectory(_cacheDir);
        }
        catch (Exception ex)
        {
            _log.Warn("TTS : dossier du cache impossible a creer : " + ex.Message);
        }

        DropRemovedRuntime();
        _ = Task.Run(() =>
        {
            try
            {
                lock (_cacheLock)
                {
                    EnsureCacheStats();
                    if (_cacheBytes > CacheMax)
                    {
                        TrimCache();
                    }
                }
            }
            catch (Exception ex)
            {
                _log.Warn("TTS : releve du cache impossible : " + ex.Message);
            }
        });
    }

    /// <summary>Avancement d'un telechargement ou d'une synthese (fil quelconque).</summary>
    public event Action<JsonObject>? Progress;

    /// <summary>Dossier des phrases synthetisees, servi a la page sous <see cref="Host"/>.</summary>
    public string CacheRoot => _cacheDir;

    public string Root => _root;

    public static TtsVoice FindVoice(string? id)
        => Voices.FirstOrDefault(v => string.Equals(v.Id, id?.Trim(), StringComparison.OrdinalIgnoreCase))
           ?? throw new InvalidOperationException($"Voix inconnue : {id}");

    public static string SanitizeAccent(string? accent)
    {
        var value = (accent ?? "").Trim();
        if (string.Equals(value, AccentUs, StringComparison.OrdinalIgnoreCase))
        {
            return AccentUs;
        }

        if (string.Equals(value, AccentGb, StringComparison.OrdinalIgnoreCase))
        {
            return AccentGb;
        }

        throw new InvalidOperationException($"Accent inconnu : {accent} (en-US ou en-GB attendu).");
    }

    /// <summary>Vitesse de synthese bornee, au centieme (elle entre dans la cle du cache).</summary>
    public static float SanitizeSpeed(float speed)
    {
        if (float.IsNaN(speed) || float.IsInfinity(speed) || speed <= 0)
        {
            speed = 1f;
        }

        return MathF.Round(Math.Clamp(speed, MinSpeed, MaxSpeed) * 100f) / 100f;
    }

    // ------------------------------------------------------------------ etat

    /// <summary>Ce que la page affiche : voix pretes ou non, telechargement en cours, cache.</summary>
    public JsonObject Status()
    {
        var runtime = RuntimePresent();
        var model = ModelPresent();
        Download? download;
        string[] loaded;
        lock (_lock)
        {
            download = _download;
            loaded = _engines.Keys.ToArray();
        }

        var downloading = download is not null && !download.Task.IsCompleted;
        int files;
        long bytes;
        lock (_cacheLock)
        {
            EnsureCacheStats();
            files = _cacheFiles;
            bytes = _cacheBytes;
        }

        var voices = new JsonArray();
        foreach (var voice in Voices)
        {
            voices.Add(new JsonObject
            {
                ["id"] = voice.Id,
                ["label"] = voice.Label,
                ["accent"] = voice.Accent,
                ["gender"] = voice.Gender,
                ["grade"] = voice.Grade,
            });
        }

        var loadedArray = new JsonArray();
        foreach (var accent in loaded)
        {
            loadedArray.Add(JsonValue.Create(accent));
        }

        return new JsonObject
        {
            ["ready"] = runtime && model,
            ["dir"] = _root,
            ["url"] = "https://" + Host + "/",
            ["threads"] = Threads,
            ["downloadSize"] = RuntimeSize + ModelSize,
            ["runtime"] = new JsonObject
            {
                ["version"] = RuntimeVersion,
                ["downloaded"] = runtime,
                ["size"] = RuntimeSize,
            },
            ["model"] = new JsonObject
            {
                ["id"] = ModelId,
                ["label"] = ModelLabel,
                ["revision"] = ModelRevision,
                ["size"] = ModelSize,
                ["downloaded"] = model,
                ["downloading"] = downloading,
                ["received"] = downloading ? Interlocked.Read(ref download!.Received) : 0,
                ["total"] = downloading ? download!.Total : 0,
            },
            ["voices"] = voices,
            ["loaded"] = loadedArray,
            ["cache"] = new JsonObject
            {
                ["files"] = files,
                ["bytes"] = bytes,
                ["max"] = CacheMax,
            },
        };
    }

    public bool IsReady => RuntimePresent() && ModelPresent();

    private bool RuntimePresent() => !File.Exists(_removeMarker) && AllPresent(RuntimeFiles, _runtimeDir);

    private bool ModelPresent() => AllPresent(ModelFiles, _modelDir);

    private static bool AllPresent(IEnumerable<Asset> assets, string dir)
        => assets.All(asset => Present(asset, dir));

    private static bool Present(Asset asset, string dir)
    {
        var file = new FileInfo(Path.Combine(dir, asset.Path.Replace('/', Path.DirectorySeparatorChar)));
        return file.Exists && file.Length == asset.Size;
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
    /// Rend runtime et modele disponibles sur le disque : rien a faire s'ils y sont, sinon un seul
    /// telechargement, partage par tous ceux qui l'attendent. Annuler <paramref name="ct"/> cesse
    /// d'attendre sans l'interrompre (<see cref="RemoveAsync"/> l'interrompt).
    /// </summary>
    public Task EnsureModelAsync(CancellationToken ct)
    {
        if (IsReady)
        {
            return Task.CompletedTask;
        }

        Download download;
        lock (_lock)
        {
            if (_download is null || _download.Task.IsCompleted)
            {
                var started = new Download { Cancel = new CancellationTokenSource() };
                started.Task = Task.Run(() => DownloadAsync(started, started.Cancel.Token));
                _download = started;
                // La source d'annulation n'est pas liberee : RemoveAsync peut encore l'annuler apres coup.
                started.Task.ContinueWith(_ =>
                {
                    lock (_lock)
                    {
                        if (ReferenceEquals(_download, started))
                        {
                            _download = null;
                        }
                    }
                }, TaskScheduler.Default);
            }

            download = _download;
        }

        return download.Task.WaitAsync(ct);
    }

    private async Task DownloadAsync(Download download, CancellationToken ct)
    {
        var watch = Stopwatch.StartNew();
        string? part = null;
        try
        {
            Directory.CreateDirectory(_runtimeDir);
            Directory.CreateDirectory(_modelDir);

            // Runtime supprime dans cette session (DLL chargees, donc restees) : il resert tel quel.
            if (File.Exists(_removeMarker))
            {
                File.Delete(_removeMarker);
            }

            var runtimeMissing = !AllPresent(RuntimeFiles, _runtimeDir);
            var missing = ModelFiles.Where(f => !Present(f, _modelDir)).ToList();
            download.Total = (runtimeMissing ? RuntimeSize : 0) + missing.Sum(f => f.Size);
            _log.Info($"TTS : telechargement des voix ({download.Total / 1_000_000} Mo : "
                + (runtimeMissing ? "runtime sherpa-onnx " + RuntimeVersion + ", " : "")
                + $"{missing.Count} fichiers du modele {ModelId} a la revision {ModelRevision[..8]})");
            EmitDownload(download, "", force: true);

            if (runtimeMissing)
            {
                part = Path.Combine(_runtimeDir, "runtime.nupkg.part");
                await FetchAsync(download, RuntimeUrl, part, RuntimeSize, HashAlgorithmName.SHA512, RuntimeSha512, base64: true, "runtime", ct).ConfigureAwait(false);
                ExtractRuntime(part);
                File.Delete(part);
                part = null;
            }

            foreach (var asset in missing)
            {
                var target = Path.Combine(_modelDir, asset.Path.Replace('/', Path.DirectorySeparatorChar));
                Directory.CreateDirectory(Path.GetDirectoryName(target)!);
                part = target + ".part";
                await FetchAsync(download, ModelBase + asset.Path, part, asset.Size, HashAlgorithmName.SHA256, asset.Sha256, base64: false, asset.Path, ct).ConfigureAwait(false);
                File.Move(part, target, overwrite: true);
                part = null;
            }

            _log.Info($"TTS : voix telechargees en {watch.Elapsed.TotalSeconds:0} s");
            Emit(new JsonObject { ["phase"] = "downloaded", ["model"] = ModelId });
        }
        catch (Exception ex)
        {
            if (part is not null)
            {
                TryDelete(part);
            }

            if (ex is OperationCanceledException && ct.IsCancellationRequested)
            {
                _log.Info("TTS : telechargement des voix interrompu");
                Emit(new JsonObject { ["phase"] = "download-failed", ["model"] = ModelId, ["error"] = "Téléchargement interrompu." });
                throw new InvalidOperationException("Téléchargement des voix interrompu.");
            }

            _log.Warn("TTS : telechargement des voix impossible : " + ex.Message);
            var message = "Téléchargement des voix impossible : " + (ex is HttpRequestException ? "réseau indisponible (" + ex.Message + ")" : ex.Message);
            Emit(new JsonObject { ["phase"] = "download-failed", ["model"] = ModelId, ["error"] = message });
            throw new InvalidOperationException(message);
        }
    }

    /// <summary>Un fichier, en <c>.part</c>, empreinte calculee au fil de l'eau ; le renommage revient a l'appelant.</summary>
    private async Task FetchAsync(Download download, string url, string part, long size, HashAlgorithmName algorithm,
        string expected, bool base64, string name, CancellationToken ct)
    {
        // Un serveur qui ne repond plus ferait attendre indefiniment : 60 s sans octet, on abandonne.
        using var stall = CancellationTokenSource.CreateLinkedTokenSource(ct);
        try
        {
            stall.CancelAfter(StallTimeout);
            using var request = new HttpRequestMessage(HttpMethod.Get, url);
            request.Headers.UserAgent.ParseAdd("Organizator/" + _version);
            using var response = await Http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, stall.Token).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
            {
                throw new InvalidOperationException($"le serveur a répondu {(int)response.StatusCode} {response.ReasonPhrase} pour {name}");
            }

            if (response.Content.Headers.ContentLength is long length && length != size)
            {
                throw new InvalidOperationException($"{name} : taille inattendue ({length} octets au lieu de {size})");
            }

            using var hash = IncrementalHash.CreateHash(algorithm);
            long received = 0;
            await using (var source = await response.Content.ReadAsStreamAsync(stall.Token).ConfigureAwait(false))
            await using (var file = new FileStream(part, FileMode.Create, FileAccess.Write, FileShare.None, 1 << 16, useAsync: true))
            {
                var buffer = new byte[1 << 16];
                while (true)
                {
                    stall.CancelAfter(StallTimeout);
                    var read = await source.ReadAsync(buffer, stall.Token).ConfigureAwait(false);
                    if (read <= 0)
                    {
                        break;
                    }

                    if (received + read > size)
                    {
                        throw new InvalidOperationException($"{name} : plus long que prévu ({size} octets)");
                    }

                    hash.AppendData(buffer, 0, read);
                    await file.WriteAsync(buffer.AsMemory(0, read), ct).ConfigureAwait(false);
                    received += read;
                    Interlocked.Add(ref download.Received, read);
                    EmitDownload(download, name, force: false);
                }
            }

            if (received != size)
            {
                throw new InvalidOperationException($"{name} : téléchargement incomplet ({received} octets sur {size})");
            }

            var digest = hash.GetHashAndReset();
            var actual = base64 ? Convert.ToBase64String(digest) : Convert.ToHexString(digest).ToLowerInvariant();
            if (!string.Equals(actual, expected, StringComparison.Ordinal))
            {
                throw new InvalidOperationException($"{name} : empreinte inattendue (fichier altéré, ou changé sur le serveur)");
            }
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            throw new InvalidOperationException($"le serveur ne répond plus ({name})");
        }
    }

    /// <summary>Les deux DLL win-x64 du paquet NuGet, controlees une a une.</summary>
    private void ExtractRuntime(string nupkg)
    {
        using var zip = ZipFile.OpenRead(nupkg);
        foreach (var asset in RuntimeFiles)
        {
            var entry = zip.GetEntry(RuntimeEntry + asset.Path)
                ?? throw new InvalidOperationException($"{asset.Path} absent du paquet du runtime");
            var target = Path.Combine(_runtimeDir, asset.Path);
            var part = target + ".part";
            try
            {
                using (var source = entry.Open())
                using (var file = File.Create(part))
                {
                    source.CopyTo(file);
                }

                var info = new FileInfo(part);
                if (info.Length != asset.Size || !string.Equals(Sha256Of(part), asset.Sha256, StringComparison.Ordinal))
                {
                    throw new InvalidOperationException($"{asset.Path} : empreinte inattendue dans le paquet du runtime");
                }

                File.Move(part, target, overwrite: true);
            }
            catch
            {
                TryDelete(part);
                throw;
            }
        }
    }

    private void EmitDownload(Download download, string file, bool force)
    {
        lock (download.Clock)
        {
            if (!force && download.Clock.Elapsed < ProgressEvery)
            {
                return;
            }

            download.Clock.Restart();
        }

        Emit(new JsonObject
        {
            ["phase"] = "download",
            ["model"] = ModelId,
            ["file"] = file,
            ["received"] = Interlocked.Read(ref download.Received),
            ["total"] = download.Total,
        });
    }

    /// <summary>
    /// Interrompt le telechargement, ou supprime modele et runtime (refuse pendant une synthese).
    /// Les DLL deja chargees par le processus ne peuvent pas etre effacees : elles le sont au
    /// prochain demarrage (marque <c>runtime-&lt;version&gt;.remove</c>), et resservent d'ici la.
    /// </summary>
    public async Task<bool> RemoveAsync()
    {
        Download? download;
        lock (_lock)
        {
            download = _download;
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

        var anything = Directory.Exists(_modelDir) || (Directory.Exists(_runtimeDir) && !File.Exists(_removeMarker));
        if (!anything)
        {
            return false;
        }

        if (Volatile.Read(ref _busy) > 0 || !await _gate.WaitAsync(0).ConfigureAwait(false))
        {
            throw new InvalidOperationException("Une synthèse est en cours : réessayez quand elle sera finie.");
        }

        try
        {
            ReleaseEngines(always: true);
            await Task.Run(() =>
            {
                if (Directory.Exists(_modelDir))
                {
                    Directory.Delete(_modelDir, recursive: true);
                }

                bool loaded;
                lock (NativeLock)
                {
                    loaded = _nativeApi != IntPtr.Zero && string.Equals(_nativeDir, _runtimeDir, StringComparison.OrdinalIgnoreCase);
                }

                if (loaded)
                {
                    File.WriteAllText(_removeMarker, "DLL chargees par le processus : a effacer au prochain demarrage." + Environment.NewLine);
                }
                else if (Directory.Exists(_runtimeDir))
                {
                    Directory.Delete(_runtimeDir, recursive: true);
                }
            }).ConfigureAwait(false);

            _log.Info("TTS : voix supprimees (modele et runtime)");
            return true;
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>Au demarrage, rien n'est encore charge : le runtime supprime la fois precedente s'efface.</summary>
    private void DropRemovedRuntime()
    {
        if (!File.Exists(_removeMarker))
        {
            return;
        }

        lock (NativeLock)
        {
            if (_nativeApi != IntPtr.Zero && string.Equals(_nativeDir, _runtimeDir, StringComparison.OrdinalIgnoreCase))
            {
                return;
            }
        }

        try
        {
            if (Directory.Exists(_runtimeDir))
            {
                Directory.Delete(_runtimeDir, recursive: true);
            }

            File.Delete(_removeMarker);
            _log.Info("TTS : runtime supprime a la session precedente efface");
        }
        catch (Exception ex)
        {
            _log.Warn("TTS : effacement du runtime supprime impossible : " + ex.Message);
        }
    }

    // ------------------------------------------------------------------ synthese

    /// <summary>
    /// Charge en arriere-plan l'instance d'un accent (pendant que l'utilisateur lit ou parle) : la
    /// synthese qui suit n'attend plus que le calcul. Sans effet si les voix ne sont pas installees.
    /// </summary>
    public void Warm(string accent)
    {
        accent = SanitizeAccent(accent);
        if (!IsReady)
        {
            return;
        }

        Interlocked.Increment(ref _busy);
        _ = Task.Run(async () =>
        {
            try
            {
                await _gate.WaitAsync().ConfigureAwait(false);
                try
                {
                    EngineFor(accent, null);
                }
                finally
                {
                    _gate.Release();
                    ScheduleRelease();
                }
            }
            catch (Exception ex)
            {
                // L'echec sera redit par la synthese elle-meme, avec son message.
                _log.Warn($"TTS : preparation de la voix {accent} impossible : {ex.Message}");
            }
            finally
            {
                Interlocked.Decrement(ref _busy);
            }
        });
    }

    /// <summary>
    /// Synthetise un texte (<see cref="MaxSpeakChars"/> caracteres au plus), phrase par phrase :
    /// l'evenement <c>sentence</c> annonce chacune des qu'elle est dans le cache.
    /// </summary>
    public Task<JsonObject> SpeakAsync(string job, string text, string voice, float speed)
    {
        if ((text ?? "").Length > MaxSpeakChars)
        {
            throw new InvalidOperationException($"Texte trop long pour la synthèse ({text!.Length} caractères, {MaxSpeakChars} au plus).");
        }

        var lines = new[] { new TtsLine("0", voice, text ?? "") };
        return Task.Run(() => RunAsync(job, lines, speed, 0, script: false));
    }

    /// <summary>
    /// Synthetise un dialogue dans l'ordre du script, ligne apres ligne et phrase apres phrase, et
    /// annonce les phrases dans cet ordre (<c>line</c> = identifiant de la ligne, <c>index</c> = rang
    /// de la phrase dans la ligne) : la page lit au fil de l'eau et sait qu'une ligne est finie des
    /// qu'arrive la suivante. <paramref name="gapMs"/> n'est qu'une information pour la page.
    /// </summary>
    public Task<JsonObject> SpeakScriptAsync(string job, IReadOnlyList<TtsLine> lines, float speed, int gapMs)
    {
        if (lines.Count == 0)
        {
            throw new InvalidOperationException("Script vide.");
        }

        if (lines.Count > MaxScriptLines)
        {
            throw new InvalidOperationException($"Script trop long ({lines.Count} répliques, {MaxScriptLines} au plus).");
        }

        var chars = lines.Sum(l => (l.Text ?? "").Length);
        if (chars > MaxScriptChars)
        {
            throw new InvalidOperationException($"Script trop long ({chars} caractères, {MaxScriptChars} au plus).");
        }

        return Task.Run(() => RunAsync(job, lines, speed, Math.Clamp(gapMs, 0, 10_000), script: true));
    }

    public bool Cancel(string? job)
    {
        if (string.IsNullOrEmpty(job))
        {
            return false;
        }

        lock (_lock)
        {
            if (!_jobs.TryGetValue(job, out var cts))
            {
                return false;
            }

            cts.Cancel();
            return true;
        }
    }

    private sealed class Piece
    {
        public required int Line { get; init; }
        public required string LineId { get; init; }
        public required int Index { get; init; }
        public required string Text { get; init; }
        public required TtsVoice Voice { get; init; }
        public required string Key { get; init; }
        public double Start;
        public double Duration;
        public bool Cached;
        public bool Done;
    }

    private async Task<JsonObject> RunAsync(string job, IReadOnlyList<TtsLine> lines, float speed, int gapMs, bool script)
    {
        job = (job ?? "").Trim();
        if (job.Length == 0 || job.Length > 80)
        {
            throw new InvalidOperationException("Synthèse sans identifiant.");
        }

        speed = SanitizeSpeed(speed);
        var pieces = new List<Piece>();
        var voices = new TtsVoice[lines.Count];
        for (var l = 0; l < lines.Count; l++)
        {
            voices[l] = FindVoice(lines[l].Voice);
            var sentences = SplitSentences(lines[l].Text);
            for (var i = 0; i < sentences.Count; i++)
            {
                pieces.Add(new Piece
                {
                    Line = l,
                    LineId = lines[l].Id ?? l.ToString(System.Globalization.CultureInfo.InvariantCulture),
                    Index = i,
                    Text = sentences[i],
                    Voice = voices[l],
                    Key = CacheKey(voices[l].Id, speed, sentences[i]),
                });
            }
        }

        using var cts = new CancellationTokenSource();
        lock (_lock)
        {
            _jobs[job] = cts;
        }

        var ct = cts.Token;
        var watch = Stopwatch.StartNew();
        var gateHeld = false;
        var synthesized = 0;
        var cached = 0;
        var used = new HashSet<string>(StringComparer.Ordinal);
        var lineStart = new double[lines.Count];
        Interlocked.Increment(ref _busy);
        try
        {
            for (var p = 0; p < pieces.Count; p++)
            {
                ct.ThrowIfCancellationRequested();
                var piece = pieces[p];
                if (!TryCached(piece))
                {
                    if (!gateHeld)
                    {
                        if (!IsReady)
                        {
                            throw new InvalidOperationException("Les voix naturelles ne sont pas installées : téléchargez-les dans Réglages › Révizator.");
                        }

                        if (_gate.CurrentCount == 0)
                        {
                            Emit(new JsonObject { ["job"] = job, ["phase"] = "queue" });
                        }

                        await _gate.WaitAsync(ct).ConfigureAwait(false);
                        gateHeld = true;
                    }

                    // Une autre synthese a pu dire la meme phrase pendant l'attente.
                    if (!TryCached(piece))
                    {
                        var engine = EngineFor(piece.Voice.Accent, job);
                        used.Add(piece.Voice.Accent);
                        Emit(Event(job, "synthesize", piece, script));
                        var samples = Generate(engine, piece.Text, piece.Voice.Sid, speed, ct);
                        piece.Duration = samples.Length / (double)engine.SampleRate;
                        WriteToCache(piece.Key, samples, engine.SampleRate);
                        synthesized++;
                    }
                }

                if (piece.Cached)
                {
                    cached++;
                }

                piece.Start = lineStart[piece.Line];
                lineStart[piece.Line] += piece.Duration;
                piece.Done = true;
                var sentence = Event(job, "sentence", piece, script);
                sentence["url"] = UrlOf(piece.Key);
                sentence["text"] = piece.Text;
                sentence["start"] = Math.Round(piece.Start, 3);
                sentence["duration"] = Math.Round(piece.Duration, 3);
                sentence["cached"] = piece.Cached;
                Emit(sentence);

                // La premiere phrase est partie : les autres accents du script se chargent d'emblee,
                // pendant qu'elle se lit, plutot qu'au milieu du dialogue.
                if (synthesized == 1 && !piece.Cached)
                {
                    foreach (var accent in pieces.Skip(p + 1).Select(x => x.Voice.Accent).Distinct())
                    {
                        ct.ThrowIfCancellationRequested();
                        if (pieces.Skip(p + 1).Any(x => x.Voice.Accent == accent && !File.Exists(CachePath(x.Key))))
                        {
                            EngineFor(accent, job);
                            used.Add(accent);
                        }
                    }
                }
            }
        }
        catch (OperationCanceledException)
        {
            _log.Info($"TTS : synthese interrompue a la demande ({synthesized} phrases dites sur {pieces.Count})");
            Emit(new JsonObject { ["job"] = job, ["phase"] = "done", ["cancelled"] = true });
            throw new InvalidOperationException("Synthèse interrompue.");
        }
        catch (Exception ex)
        {
            var message = ex is InvalidOperationException ? ex.Message : "Synthèse impossible : " + ex.Message;
            if (ex is DllNotFoundException or BadImageFormatException or EntryPointNotFoundException)
            {
                message = "Moteur de synthèse introuvable : " + ex.Message + " Supprimez puis retéléchargez les voix.";
            }

            if (ex is InvalidOperationException)
            {
                _log.Warn("TTS : synthese impossible : " + ex.Message);
            }
            else
            {
                _log.Error("TTS : synthese impossible", ex);
            }

            Emit(new JsonObject { ["job"] = job, ["phase"] = "error", ["error"] = message });
            throw new InvalidOperationException(message);
        }
        finally
        {
            if (gateHeld)
            {
                Touch(used);
                _gate.Release();
                ScheduleRelease();
            }

            Interlocked.Decrement(ref _busy);
            lock (_lock)
            {
                if (_jobs.TryGetValue(job, out var current) && ReferenceEquals(current, cts))
                {
                    _jobs.Remove(job);
                }
            }
        }

        watch.Stop();
        var speech = pieces.Sum(x => x.Duration);
        var speakers = string.Join(", ", voices.Select(v => v.Id).Distinct());
        _log.Info((script ? $"TTS : script de {lines.Count} repliques, " : "TTS : ")
            + $"{pieces.Count} phrase{(pieces.Count > 1 ? "s" : "")} ({speech:0.0} s) synthetisee{(pieces.Count > 1 ? "s" : "")} en {watch.ElapsedMilliseconds} ms ({speakers}, {speed:0.00}, {cached} en cache)");
        Emit(new JsonObject { ["job"] = job, ["phase"] = "done", ["duration"] = Math.Round(speech, 3), ["ms"] = watch.ElapsedMilliseconds, ["cached"] = cached });

        if (!script)
        {
            return new JsonObject
            {
                ["job"] = job,
                ["voice"] = voices[0].Id,
                ["speed"] = speed,
                ["duration"] = Math.Round(speech, 3),
                ["ms"] = watch.ElapsedMilliseconds,
                ["cached"] = cached,
                ["sentences"] = SentencesOf(pieces, 0),
            };
        }

        var linesJson = new JsonArray();
        for (var l = 0; l < lines.Count; l++)
        {
            linesJson.Add(new JsonObject
            {
                ["id"] = lines[l].Id,
                ["voice"] = voices[l].Id,
                ["duration"] = Math.Round(lineStart[l], 3),
                ["sentences"] = SentencesOf(pieces, l),
            });
        }

        // Duree de lecture a vitesse normale : la parole, plus les blancs que la page laisse entre deux repliques.
        var spoken = lineStart.Count(d => d > 0);
        return new JsonObject
        {
            ["job"] = job,
            ["speed"] = speed,
            ["gapMs"] = gapMs,
            ["duration"] = Math.Round(speech + Math.Max(0, spoken - 1) * gapMs / 1000.0, 3),
            ["speech"] = Math.Round(speech, 3),
            ["ms"] = watch.ElapsedMilliseconds,
            ["cached"] = cached,
            ["lines"] = linesJson,
        };
    }

    private static JsonObject Event(string job, string phase, Piece piece, bool script)
    {
        var payload = new JsonObject { ["job"] = job, ["phase"] = phase };
        if (script)
        {
            payload["line"] = piece.LineId;
        }

        payload["index"] = piece.Index;
        return payload;
    }

    private static JsonArray SentencesOf(List<Piece> pieces, int line)
    {
        var array = new JsonArray();
        foreach (var piece in pieces.Where(x => x.Line == line && x.Done))
        {
            array.Add(new JsonObject
            {
                ["index"] = piece.Index,
                ["text"] = piece.Text,
                ["url"] = UrlOf(piece.Key),
                ["start"] = Math.Round(piece.Start, 3),
                ["duration"] = Math.Round(piece.Duration, 3),
            });
        }

        return array;
    }

    /// <summary>Une phrase, sous <see cref="_gate"/> ; le rappel arrete la generation quand le travail est annule.</summary>
    private static float[] Generate(Engine engine, string text, int sid, float speed, CancellationToken ct)
    {
        var config = new OfflineTtsGenerationConfig { Sid = sid, Speed = speed, SilenceScale = 0.2f };
        OfflineTtsCallbackProgressWithArg callback = (_, _, _, _) => ct.IsCancellationRequested ? 0 : 1;
        OfflineTtsGeneratedAudio? audio = null;
        try
        {
            audio = engine.Tts.GenerateWithConfig(text, config, callback);
            ct.ThrowIfCancellationRequested();
            if (audio is null || audio.Handle == IntPtr.Zero)
            {
                throw new InvalidOperationException("Synthèse impossible : le moteur n'a rendu aucun son.");
            }

            var samples = audio.Samples;
            if (samples is null || samples.Length == 0)
            {
                throw new InvalidOperationException("Synthèse impossible : le moteur n'a rendu aucun son.");
            }

            return samples;
        }
        finally
        {
            GC.KeepAlive(callback);
            audio?.Dispose();
        }
    }

    // ------------------------------------------------------------------ instances

    private sealed class Engine
    {
        public required OfflineTts Tts { get; init; }
        public required int SampleRate { get; init; }
        public long LastUse;
    }

    /// <summary>Instance de l'accent (sous <see cref="_gate"/>), chargee si besoin.</summary>
    private Engine EngineFor(string accent, string? job)
    {
        lock (_lock)
        {
            if (_engines.TryGetValue(accent, out var existing))
            {
                existing.LastUse = Environment.TickCount64;
                return existing;
            }
        }

        if (job is not null)
        {
            Emit(new JsonObject { ["job"] = job, ["phase"] = "load", ["accent"] = accent });
        }

        var engine = LoadEngine(accent);
        lock (_lock)
        {
            _engines[accent] = engine;
        }

        return engine;
    }

    private Engine LoadEngine(string accent)
    {
        var paths = NativeModelPaths();
        PrepareNative();
        var before = PrivateBytes();
        var watch = Stopwatch.StartNew();
        var us = accent == AccentUs;

        var config = new OfflineTtsConfig();
        config.Model.Kokoro.Model = paths.Model;
        config.Model.Kokoro.Voices = paths.Voices;
        config.Model.Kokoro.Tokens = paths.Tokens;
        config.Model.Kokoro.DataDir = paths.Espeak;
        // Lexique choisi a la creation ; « en-gb » est refuse par espeak-ng (son nul) : l'anglais britannique est « en ».
        config.Model.Kokoro.Lexicon = us ? paths.LexiconUs : paths.LexiconGb;
        config.Model.Kokoro.Lang = us ? "en-us" : "en";
        config.Model.NumThreads = Threads;
        config.Model.Provider = "cpu";
        config.Model.Debug = 0;
        config.MaxNumSentences = 1;

        var tts = new OfflineTts(config);
        // Un reglage refuse laisse un objet sans pointeur natif : le moindre appel tuerait le processus.
        if (TtsHandle?.GetValue(tts) is HandleRef handle && handle.Handle == IntPtr.Zero)
        {
            GC.SuppressFinalize(tts);
            throw new InvalidOperationException("Chargement des voix impossible (modèle refusé par le moteur) : supprimez puis retéléchargez les voix.");
        }

        Engine engine;
        try
        {
            if (tts.NumSpeakers < 28)
            {
                throw new InvalidOperationException($"Modèle de voix inattendu ({tts.NumSpeakers} voix) : supprimez puis retéléchargez les voix.");
            }

            engine = new Engine { Tts = tts, SampleRate = tts.SampleRate, LastUse = Environment.TickCount64 };
            var loadMs = watch.ElapsedMilliseconds;
            // Le tout premier appel coute 0,3 a 2 s de plus (chauffe) : on le fait a blanc.
            Generate(engine, "Hello.", us ? 3 : 21, 1f, CancellationToken.None);
            _log.Info($"TTS : {accent} charge en {loadMs} ms, pret en {watch.ElapsedMilliseconds} ms ({Threads} fils, +{(PrivateBytes() - before) / 1024 / 1024} Mo)");
        }
        catch
        {
            tts.Dispose();
            throw;
        }

        return engine;
    }

    private void Touch(IEnumerable<string> accents)
    {
        lock (_lock)
        {
            foreach (var accent in accents)
            {
                if (_engines.TryGetValue(accent, out var engine))
                {
                    engine.LastUse = Environment.TickCount64;
                }
            }
        }
    }

    private void ScheduleRelease() => _idle.Change(IdleRelease, Timeout.InfiniteTimeSpan);

    private void ReleaseIfIdle()
    {
        if (!_gate.Wait(0))
        {
            ScheduleRelease();
            return;
        }

        try
        {
            ReleaseEngines(always: false);
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>Libere les instances (sous <see cref="_gate"/>) : toutes, ou celles qui n'ont pas servi depuis cinq minutes.</summary>
    private void ReleaseEngines(bool always)
    {
        var now = Environment.TickCount64;
        long? next = null;
        List<(string Accent, Engine Engine)> released = [];
        lock (_lock)
        {
            foreach (var (accent, engine) in _engines.ToArray())
            {
                var idle = now - engine.LastUse;
                if (always || idle >= (long)IdleRelease.TotalMilliseconds)
                {
                    _engines.Remove(accent);
                    released.Add((accent, engine));
                }
                else
                {
                    var left = (long)IdleRelease.TotalMilliseconds - idle;
                    next = next is null ? left : Math.Min(next.Value, left);
                }
            }
        }

        foreach (var (accent, engine) in released)
        {
            try
            {
                engine.Tts.Dispose();
            }
            catch (Exception ex)
            {
                _log.Warn($"TTS : liberation de {accent} : {ex.Message}");
            }

            _log.Info($"TTS : {accent} libere");
        }

        if (next is long wait)
        {
            _idle.Change(TimeSpan.FromMilliseconds(wait + 1000), Timeout.InfiniteTimeSpan);
        }
    }

    private static long PrivateBytes()
    {
        using var process = Process.GetCurrentProcess();
        return process.PrivateMemorySize64;
    }

    // ------------------------------------------------------------------ natif

    private sealed record ModelPaths(string Model, string Voices, string Tokens, string Espeak, string LexiconUs, string LexiconGb);

    /// <summary>
    /// Chemins remis au code natif : chaque fichier present et entier, chemins ASCII et courts (nom
    /// court 8.3 au besoin). Tout manquement est dit ici, en clair, au lieu de tuer le processus.
    /// </summary>
    private ModelPaths NativeModelPaths()
    {
        foreach (var asset in ModelFiles)
        {
            if (!Present(asset, _modelDir))
            {
                throw new InvalidOperationException($"Voix naturelles incomplètes ({asset.Path} manque ou est tronqué) : supprimez puis retéléchargez-les dans Réglages › Révizator.");
            }
        }

        var dir = NativePath(_modelDir);
        var espeak = Path.Combine(dir, "espeak-ng-data");
        var paths = new ModelPaths(
            Path.Combine(dir, "model.onnx"),
            Path.Combine(dir, "voices.bin"),
            Path.Combine(dir, "tokens.txt"),
            espeak,
            Path.Combine(dir, "lexicon-us-en.txt"),
            Path.Combine(dir, "lexicon-gb-en.txt"));

        // Le plus long chemin que le moteur composera lui-meme.
        var deepest = Path.Combine(espeak, "lang", "gmw", "en-GB-x-rp");
        if (deepest.Length >= NativePathLimit)
        {
            throw new InvalidOperationException($"Le chemin du dossier des voix est trop long pour le moteur de synthèse ({deepest.Length} caractères, {NativePathLimit} au plus) : "
                + @"lancez Organizator avec un dossier de données plus court (par exemple --data C:\OrganizatorData).");
        }

        foreach (var asset in ModelFiles)
        {
            if (!File.Exists(Path.Combine(dir, asset.Path.Replace('/', Path.DirectorySeparatorChar))))
            {
                throw new InvalidOperationException($"Voix naturelles illisibles par le moteur ({asset.Path}) : supprimez puis retéléchargez-les.");
            }
        }

        return paths;
    }

    /// <summary>Le chemin tel quel s'il est ASCII et court, sinon son nom court 8.3 ; refus lisible si celui-ci n'y suffit pas.</summary>
    private static string NativePath(string path)
    {
        var full = Path.GetFullPath(path);
        if (IsAscii(full) && full.Length < NativePathLimit - 60)
        {
            return full;
        }

        var buffer = new StringBuilder(1024);
        var length = GetShortPathNameW(full, buffer, (uint)buffer.Capacity);
        var shortPath = length > 0 && length < buffer.Capacity ? buffer.ToString() : "";
        if (shortPath.Length == 0 || !IsAscii(shortPath))
        {
            throw new InvalidOperationException($"Le dossier des voix ({full}) contient des caractères que le moteur de synthèse ne sait pas lire, et Windows n'en donne pas de nom court : "
                + @"lancez Organizator avec un dossier de données au nom simple (par exemple --data C:\OrganizatorData).");
        }

        return shortPath;
    }

    private static bool IsAscii(string value) => value.All(c => c >= 32 && c < 127);

    /// <summary>
    /// Charge les deux DLL par leur chemin complet — <c>System32\onnxruntime.dll</c> (Windows ML 1.17)
    /// n'est pas la bonne — et dit au runtime ou trouver <c>sherpa-onnx-c-api</c> ; une fois par processus.
    /// </summary>
    private void PrepareNative()
    {
        lock (NativeLock)
        {
            if (_nativeApi != IntPtr.Zero)
            {
                if (!string.Equals(_nativeDir, _runtimeDir, StringComparison.OrdinalIgnoreCase))
                {
                    _log.Info("TTS : DLL natives deja chargees depuis " + _nativeDir);
                }

                return;
            }

            if (!AllPresent(RuntimeFiles, _runtimeDir) || File.Exists(_removeMarker))
            {
                throw new InvalidOperationException("Moteur de synthèse absent ou incomplet : supprimez puis retéléchargez les voix.");
            }

            NativeLibrary.Load(Path.Combine(_runtimeDir, "onnxruntime.dll"));
            var api = NativeLibrary.Load(Path.Combine(_runtimeDir, "sherpa-onnx-c-api.dll"));
            _nativeApi = api;
            _nativeDir = _runtimeDir;
            NativeLibrary.SetDllImportResolver(typeof(OfflineTts).Assembly, (name, _, _) =>
                name.StartsWith("sherpa-onnx-c-api", StringComparison.OrdinalIgnoreCase) ? _nativeApi : IntPtr.Zero);
            _log.Info("TTS : DLL natives chargees depuis " + _runtimeDir);
        }
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetShortPathNameW(string longPath, StringBuilder shortPath, uint length);

    // ------------------------------------------------------------------ cache

    /// <summary>Cle d'une phrase : moteur, modele, voix, vitesse et texte normalise.</summary>
    public static string CacheKey(string voice, float speed, string sentence)
    {
        var material = "sherpa-" + RuntimeVersion + "|" + ModelId + "|" + voice + "|"
            + speed.ToString("0.00", System.Globalization.CultureInfo.InvariantCulture) + "|" + sentence;
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(material)))[..20].ToLowerInvariant();
    }

    private string CachePath(string key) => Path.Combine(_cacheDir, key[..2], key + ".wav");

    private static string UrlOf(string key) => "https://" + Host + "/" + key[..2] + "/" + key + ".wav";

    /// <summary>Phrase deja dite : sa duree se lit dans l'en-tete du WAV, et sa date rafraichie la garde du menage.</summary>
    private bool TryCached(Piece piece)
    {
        var path = CachePath(piece.Key);
        if (!File.Exists(path))
        {
            return false;
        }

        try
        {
            double duration;
            using (var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            {
                var header = new byte[44];
                if (file.Read(header, 0, 44) != 44
                    || Encoding.ASCII.GetString(header, 0, 4) != "RIFF"
                    || Encoding.ASCII.GetString(header, 8, 4) != "WAVE")
                {
                    throw new InvalidDataException("en-tete WAV illisible");
                }

                var rate = BitConverter.ToInt32(header, 24);
                var data = BitConverter.ToInt32(header, 40);
                if (rate <= 0 || data <= 0 || data > file.Length - 44)
                {
                    throw new InvalidDataException("WAV tronque");
                }

                duration = data / 2.0 / rate;
            }

            try
            {
                File.SetLastWriteTimeUtc(path, DateTime.UtcNow);
            }
            catch (IOException)
            {
                // lu en ce moment par la page : la date attendra
            }

            if (!piece.Cached && piece.Duration == 0)
            {
                piece.Duration = duration;
            }

            piece.Cached = true;
            return true;
        }
        catch (Exception ex) when (ex is IOException or InvalidDataException or UnauthorizedAccessException)
        {
            _log.Warn($"TTS : phrase du cache illisible, resynthetisee ({Path.GetFileName(path)} : {ex.Message})");
            TryDelete(path);
            return false;
        }
    }

    /// <summary>WAV 16 bits mono, ecrit en <c>.tmp</c> puis renomme : la page ne lit jamais un fichier a moitie ecrit.</summary>
    private void WriteToCache(string key, float[] samples, int rate)
    {
        var path = CachePath(key);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var tmp = path + "." + Guid.NewGuid().ToString("N")[..8] + ".tmp";
        var dataBytes = samples.Length * 2;
        var buffer = new byte[44 + dataBytes];
        Encoding.ASCII.GetBytes("RIFF").CopyTo(buffer, 0);
        BitConverter.GetBytes(36 + dataBytes).CopyTo(buffer, 4);
        Encoding.ASCII.GetBytes("WAVEfmt ").CopyTo(buffer, 8);
        BitConverter.GetBytes(16).CopyTo(buffer, 16);
        BitConverter.GetBytes((short)1).CopyTo(buffer, 20);   // PCM
        BitConverter.GetBytes((short)1).CopyTo(buffer, 22);   // mono
        BitConverter.GetBytes(rate).CopyTo(buffer, 24);
        BitConverter.GetBytes(rate * 2).CopyTo(buffer, 28);
        BitConverter.GetBytes((short)2).CopyTo(buffer, 32);
        BitConverter.GetBytes((short)16).CopyTo(buffer, 34);
        Encoding.ASCII.GetBytes("data").CopyTo(buffer, 36);
        BitConverter.GetBytes(dataBytes).CopyTo(buffer, 40);
        for (var i = 0; i < samples.Length; i++)
        {
            var value = (short)Math.Clamp((int)MathF.Round(samples[i] * 32767f), short.MinValue, short.MaxValue);
            buffer[44 + 2 * i] = (byte)value;
            buffer[45 + 2 * i] = (byte)(value >> 8);
        }

        try
        {
            File.WriteAllBytes(tmp, buffer);
            File.Move(tmp, path, overwrite: true);
        }
        catch
        {
            TryDelete(tmp);
            throw;
        }

        lock (_cacheLock)
        {
            if (_cacheBytes >= 0)
            {
                _cacheBytes += buffer.Length;
                _cacheFiles++;
            }

            EnsureCacheStats();
            if (_cacheBytes > CacheMax)
            {
                TrimCache();
            }
        }
    }

    /// <summary>Vide le cache des phrases ; celles qu'on redemandera seront resynthetisees.</summary>
    public JsonObject ClearCache()
    {
        var removed = 0;
        long bytes = 0;
        lock (_cacheLock)
        {
            foreach (var file in CacheFiles("*"))
            {
                try
                {
                    var length = file.Length;
                    file.Delete();
                    removed++;
                    bytes += length;
                }
                catch (Exception)
                {
                    // lu en ce moment : il partira au prochain menage
                }
            }

            foreach (var dir in SafeDirectories())
            {
                try
                {
                    if (!Directory.EnumerateFileSystemEntries(dir).Any())
                    {
                        Directory.Delete(dir);
                    }
                }
                catch (Exception)
                {
                    // sans importance
                }
            }

            _cacheBytes = -1;
        }

        _log.Info($"TTS : cache vide ({removed} fichiers, {bytes / 1024 / 1024} Mo)");
        return new JsonObject { ["removed"] = removed, ["bytes"] = bytes };
    }

    /// <summary>Taille du cache (sous <see cref="_cacheLock"/>), relevee une fois puis tenue a jour.</summary>
    private void EnsureCacheStats()
    {
        if (_cacheBytes >= 0)
        {
            return;
        }

        long bytes = 0;
        var files = 0;
        foreach (var file in CacheFiles("*.wav"))
        {
            bytes += file.Length;
            files++;
        }

        _cacheBytes = bytes;
        _cacheFiles = files;
    }

    /// <summary>
    /// Plafond depasse (sous <see cref="_cacheLock"/>) : les phrases les moins recemment dites s'en vont
    /// jusqu'a 90 % du plafond. Celles des dix dernieres minutes restent : la page peut les lire encore.
    /// </summary>
    private void TrimCache()
    {
        var recent = DateTime.UtcNow - TimeSpan.FromMinutes(10);
        var files = CacheFiles("*").ToList();
        foreach (var stale in files.Where(f => f.Name.EndsWith(".tmp", StringComparison.OrdinalIgnoreCase) && f.LastWriteTimeUtc < recent))
        {
            TryDelete(stale.FullName);
        }

        var wavs = files.Where(f => f.Name.EndsWith(".wav", StringComparison.OrdinalIgnoreCase)).OrderBy(f => f.LastWriteTimeUtc).ToList();
        var bytes = wavs.Sum(f => f.Length);
        var count = wavs.Count;
        var target = CacheMax / 10 * 9;
        var removed = 0;
        long freed = 0;
        foreach (var file in wavs)
        {
            if (bytes <= target || file.LastWriteTimeUtc >= recent)
            {
                break;
            }

            try
            {
                var length = file.Length;
                file.Delete();
                bytes -= length;
                freed += length;
                count--;
                removed++;
            }
            catch (Exception)
            {
                // lu en ce moment : il partira au prochain menage
            }
        }

        _cacheBytes = bytes;
        _cacheFiles = count;
        if (removed > 0)
        {
            _log.Info($"TTS : cache reduit ({removed} phrases retirees, {freed / 1024 / 1024} Mo liberes, {bytes / 1024 / 1024} Mo gardes)");
        }
    }

    private IEnumerable<FileInfo> CacheFiles(string pattern)
    {
        var root = new DirectoryInfo(_cacheDir);
        if (!root.Exists)
        {
            return [];
        }

        try
        {
            return root.EnumerateFiles(pattern, SearchOption.AllDirectories).ToList();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            _log.Warn("TTS : cache illisible : " + ex.Message);
            return [];
        }
    }

    private IEnumerable<string> SafeDirectories()
    {
        try
        {
            return Directory.Exists(_cacheDir) ? Directory.GetDirectories(_cacheDir) : [];
        }
        catch (Exception)
        {
            return [];
        }
    }

    // ------------------------------------------------------------------ phrases

    // Abreviations dont le point ne finit pas la phrase. Les titres et les mois s'ecrivent avec une
    // majuscule (« Dr. », « Jan. ») : compares a la casse pres, pour ne pas confondre « Sun. » et « sun. ».
    private static readonly HashSet<string> TitleAbbreviations = new(StringComparer.Ordinal)
    {
        "Mr", "Mrs", "Ms", "Mx", "Dr", "Prof", "Sr", "Jr", "St", "Mt", "Ft", "Rev", "Hon", "Gen", "Gov", "Sen", "Rep",
        "Capt", "Lt", "Col", "Sgt", "Cpl", "Inc", "Ltd", "Co", "Corp", "Dept", "Univ", "Ave", "Blvd", "Rd",
        "Jan", "Feb", "Mar", "Apr", "Jun", "Jul", "Aug", "Sep", "Sept", "Oct", "Nov", "Dec", "Fig", "Vol", "Ch",
    };

    private static readonly HashSet<string> PlainAbbreviations = new(StringComparer.OrdinalIgnoreCase)
    {
        "a.m", "p.m", "e.g", "i.e", "etc", "vs", "cf", "approx", "est", "u.s", "u.k", "u.n", "e.u", "a.k.a", "ph.d", "d.c", "l.a", "n.y",
    };

    private const int LongSentence = 280;

    /// <summary>
    /// Decoupe un texte en phrases a dire : a chaque retour a la ligne, et apres <c>. ! ? …</c> suivis
    /// d'une espace puis d'une majuscule, d'un chiffre ou d'un guillemet — sauf apres une abreviation
    /// (Mr., Dr., p.m., e.g., No. 5) ou une initiale (J. K. Rowling). Les nombres decimaux (3.5) ne
    /// coupent jamais (pas d'espace apres le point). Texte normalise : apostrophes et guillemets
    /// droits, espaces simples. Une phrase de plus de 280 caracteres est coupee a une virgule.
    /// </summary>
    public static IReadOnlyList<string> SplitSentences(string? text)
    {
        var result = new List<string>();
        if (string.IsNullOrWhiteSpace(text))
        {
            return result;
        }

        var normalized = text.Normalize(NormalizationForm.FormC)
            .Replace('\u2019', '\'').Replace('\u2018', '\'').Replace('\u201C', '"').Replace('\u201D', '"')
            .Replace('\u00A0', ' ').Replace('\u202F', ' ').Replace('\t', ' ');

        foreach (var rawLine in normalized.Split('\n'))
        {
            var line = CollapseSpaces(rawLine.Replace('\r', ' '));
            var start = 0;
            for (var i = 0; i < line.Length; i++)
            {
                var c = line[i];
                if (c is not ('.' or '!' or '?' or '\u2026'))
                {
                    continue;
                }

                // Ponctuation repetee (« ?! », « ... ») et guillemet ou parenthese fermants.
                var end = i;
                while (end + 1 < line.Length && line[end + 1] is '.' or '!' or '?' or '\u2026')
                {
                    end++;
                }

                while (end + 1 < line.Length && line[end + 1] is '"' or '\'' or ')' or ']')
                {
                    end++;
                }

                if (end + 2 >= line.Length || line[end + 1] != ' ' || !OpensSentence(line[end + 2]))
                {
                    i = end;
                    continue;
                }

                if (c == '.' && end == i && !EndsSentence(line, start, i, line[end + 2]))
                {
                    continue;
                }

                AddSentence(result, line[start..(end + 1)]);
                start = end + 2;
                i = end + 1;
            }

            if (start < line.Length)
            {
                AddSentence(result, line[start..]);
            }
        }

        return result;
    }

    private static bool OpensSentence(char c) => char.IsUpper(c) || char.IsDigit(c) || c is '"' or '\'' or '(' or '[';

    /// <summary>Le point en <paramref name="dot"/> finit-il la phrase ? Non apres une abreviation ou une initiale.</summary>
    private static bool EndsSentence(string line, int start, int dot, char next)
    {
        var from = dot;
        while (from > start && line[from - 1] != ' ')
        {
            from--;
        }

        var word = line[from..dot].TrimStart('(', '[', '"', '\'');
        if (word.Length == 0)
        {
            return true;
        }

        if (word.Length == 1 && char.IsUpper(word[0]))
        {
            // Initiale (« J. K. Rowling », « John F. Kennedy ») en debut de phrase ou apres un nom propre ;
            // apres un mot ordinaire, la lettre finit la phrase (« in room B. Please... »).
            var previous = PreviousWord(line, start, from);
            return previous.Length > 0 && !char.IsUpper(previous[0]);
        }

        if (TitleAbbreviations.Contains(word) || PlainAbbreviations.Contains(word))
        {
            return false;
        }

        // « No. 5 », « Nos. 3 and 4 » ; mais « No. I don't. » finit bien la phrase.
        if (word is "No" or "no" or "Nos" or "nos" && char.IsDigit(next))
        {
            return false;
        }

        return true;
    }

    /// <summary>Le mot qui precede la position <paramref name="before"/> dans la phrase commencee en <paramref name="start"/>.</summary>
    private static string PreviousWord(string line, int start, int before)
    {
        var end = before;
        while (end > start && line[end - 1] == ' ')
        {
            end--;
        }

        var from = end;
        while (from > start && line[from - 1] != ' ')
        {
            from--;
        }

        return line[from..end].TrimStart('(', '[', '"', '\'');
    }

    private static void AddSentence(List<string> result, string sentence)
    {
        var text = sentence.Trim();
        if (!text.Any(char.IsLetterOrDigit))
        {
            return;
        }

        while (text.Length > LongSentence)
        {
            var cut = LastBreak(text, LongSentence);
            result.Add(text[..cut].Trim());
            text = text[cut..].Trim();
        }

        if (text.Any(char.IsLetterOrDigit))
        {
            result.Add(text);
        }
    }

    /// <summary>Ou couper une phrase trop longue : apres la derniere virgule (ou point-virgule, deux-points), a defaut a la derniere espace.</summary>
    private static int LastBreak(string text, int max)
    {
        for (var i = max - 1; i > max / 3; i--)
        {
            if (text[i] is ',' or ';' or ':' && i + 1 < text.Length && text[i + 1] == ' ')
            {
                return i + 1;
            }
        }

        var space = text.LastIndexOf(' ', max - 1);
        return space > max / 3 ? space : max;
    }

    private static string CollapseSpaces(string value)
    {
        var builder = new StringBuilder(value.Length);
        var space = false;
        foreach (var c in value)
        {
            if (c == ' ' || char.IsControl(c))
            {
                space = builder.Length > 0;
                continue;
            }

            if (space)
            {
                builder.Append(' ');
                space = false;
            }

            builder.Append(c);
        }

        return builder.ToString();
    }

    // ------------------------------------------------------------------ outils

    private static string Sha256Of(string path)
    {
        using var stream = File.OpenRead(path);
        return Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
    }

    private void Emit(JsonObject payload)
    {
        try
        {
            Progress?.Invoke(payload);
        }
        catch (Exception ex)
        {
            Debug.WriteLine("[Organizator] TextToSpeech.Progress : " + ex.Message);
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
