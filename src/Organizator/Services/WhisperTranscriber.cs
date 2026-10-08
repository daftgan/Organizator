using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Reflection;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Whisper.net;
using Whisper.net.LibraryLoader;

namespace Organizator.Services;

/// <param name="Id">Nom du fichier ggml chez whisper.cpp (<c>ggml-&lt;id&gt;.bin</c>), et valeur du reglage.</param>
/// <param name="Size">Taille du fichier, pour annoncer le telechargement avant de le lancer.</param>
public sealed record WhisperModel(string Id, string Label, long Size, string Note);

/// <summary>
/// Dictee et transcription des enregistrements, par Whisper en local (whisper.cpp via Whisper.net),
/// sur le processeur : rien ne sort du poste. Le modele (fichier ggml de 150 a 575 Mo) est
/// telecharge une fois depuis le depot de whisper.cpp sur Hugging Face, sous
/// <c>&lt;donnees&gt;\whisper\</c>, au premier usage ou depuis les Reglages.
///
/// <list type="bullet">
/// <item><description>Les DLL natives sont embarquees dans l'exe et extraites sous
/// <c>whisper\runtime-&lt;version&gt;\runtimes\win-x64\</c> : la publication en fichier unique ne les
/// emporterait pas (voir Organizator.csproj). Seul le runtime CPU est livre : celui de la carte
/// graphique (Vulkan) pesait 58 Mo et s'est montre plus lent sur un iGPU Intel Arc.</description></item>
/// <item><description>Une transcription a la fois (le CPU est le goulot) ; les suivantes attendent.
/// Le modele charge reste en memoire dix minutes apres la derniere, puis il est libere.</description></item>
/// <item><description>L'avancement part par <see cref="Progress"/> (fil quelconque) :
/// <c>{ job?, model?, phase: download | decode | queue | load | transcribe, percent?, received?, total? }</c>.</description></item>
/// </list>
/// </summary>
public sealed class WhisperTranscriber
{
    /// <summary>Modeles proposes, du plus rapide au plus precis. Mesures sur un Core Ultra 7 (8 fils).</summary>
    public static readonly IReadOnlyList<WhisperModel> Models =
    [
        new("base", "Base", 147_951_465, "Le plus rapide (moins d'une seconde pour une dictée), mais approximatif en français."),
        new("small", "Small", 487_601_967, "Le bon compromis : quelques secondes pour une dictée, un enregistrement transcrit environ six fois plus vite que sa durée."),
        new("large-v3-turbo-q5_0", "Large v3 Turbo", 574_041_195, "Le plus précis (noms propres, termes techniques), mais cinq à six fois plus lent que Small sur le processeur."),
    ];

    public const string DefaultModel = "small";

    /// <summary>Langues du reglage ; <c>auto</c> laisse Whisper la deviner sur les premieres secondes.</summary>
    public static readonly IReadOnlyList<string> Languages = ["fr", "en", "auto"];

    private const string DownloadBase = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/";
    private static readonly TimeSpan IdleRelease = TimeSpan.FromMinutes(10);
    private static readonly TimeSpan ProgressEvery = TimeSpan.FromMilliseconds(250);

    // Sous-titres fantomes : sur un silence, Whisper « entend » volontiers une mention de sous-titrage
    // ou une didascalie. Un segment qui n'est que cela est ecarte.
    private static readonly Regex Phantom = new(
        @"^\s*(\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|♪+|sous-titr\w*.*|.*amara\.org.*|merci d'avoir regardé.*|abonnez-vous.*)\s*$",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    private static readonly HttpClient Http = new(new SocketsHttpHandler { ConnectTimeout = TimeSpan.FromSeconds(20) })
    {
        Timeout = Timeout.InfiniteTimeSpan,
    };

    private readonly HostLog _log;
    private readonly string _dir;
    private readonly string _version;
    private readonly object _lock = new();
    private readonly Dictionary<string, Download> _downloads = new(StringComparer.Ordinal);
    private readonly Dictionary<string, CancellationTokenSource> _jobs = new(StringComparer.Ordinal);
    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly Timer _idle;

    private WhisperFactory? _factory;
    private string? _factoryModel;
    private bool _nativeReady;

    public WhisperTranscriber(string dataDir, HostLog log, string version)
    {
        _log = log;
        _dir = Path.Combine(dataDir, "whisper");
        _version = version;
        _idle = new Timer(_ => ReleaseIfIdle(), null, Timeout.Infinite, Timeout.Infinite);
    }

    /// <summary>Avancement d'un telechargement ou d'une transcription (fil quelconque).</summary>
    public event Action<JsonObject>? Progress;

    public string ModelsDir => _dir;

    public static WhisperModel Find(string? id)
        => Models.FirstOrDefault(m => string.Equals(m.Id, id?.Trim(), StringComparison.OrdinalIgnoreCase))
           ?? throw new InvalidOperationException($"Modèle Whisper inconnu : {id}");

    public static string SanitizeModel(string? id)
        => Models.FirstOrDefault(m => string.Equals(m.Id, id?.Trim(), StringComparison.OrdinalIgnoreCase))?.Id ?? DefaultModel;

    public static string SanitizeLanguage(string? language)
    {
        var value = (language ?? "").Trim().ToLowerInvariant();
        return Languages.Contains(value) ? value : "fr";
    }

    private string ModelPath(WhisperModel model) => Path.Combine(_dir, "ggml-" + model.Id + ".bin");

    // ------------------------------------------------------------------ etat

    /// <summary>Ce que les Reglages affichent : modeles presents, telechargements en cours.</summary>
    public JsonObject Status()
    {
        var models = new JsonArray();
        lock (_lock)
        {
            foreach (var model in Models)
            {
                var file = new FileInfo(ModelPath(model));
                // Le fichier n'apparait qu'une fois complet : la, le telechargement est fini, meme si sa tache ne l'a pas encore dit.
                _downloads.TryGetValue(model.Id, out var download);
                if (file.Exists)
                {
                    download = null;
                }

                models.Add(new JsonObject
                {
                    ["id"] = model.Id,
                    ["label"] = model.Label,
                    ["size"] = file.Exists ? file.Length : model.Size,
                    ["note"] = model.Note,
                    ["downloaded"] = file.Exists,
                    ["downloading"] = download is not null,
                    ["received"] = download?.Received ?? 0,
                    ["total"] = download?.Total ?? 0,
                });
            }

            return new JsonObject
            {
                ["dir"] = _dir,
                ["models"] = models,
                ["loaded"] = _factoryModel,
                ["extensions"] = new JsonArray(AudioDecoder.Extensions.Select(e => (JsonNode?)JsonValue.Create(e.TrimStart('.'))).ToArray()),
            };
        }
    }

    // ------------------------------------------------------------ telechargement

    private sealed class Download
    {
        public required Task Task { get; init; }
        public required CancellationTokenSource Cancel { get; init; }
        public long Received;
        public long Total;
    }

    /// <summary>
    /// Rend le modele disponible sur le disque : rien a faire s'il y est, sinon un telechargement
    /// (un seul par modele, partage par tous ceux qui l'attendent). Annuler <paramref name="ct"/>
    /// cesse d'attendre sans interrompre le telechargement, qui sert aux suivants.
    /// </summary>
    public Task EnsureModelAsync(string id, CancellationToken ct)
    {
        var model = Find(id);
        if (File.Exists(ModelPath(model)))
        {
            return Task.CompletedTask;
        }

        Download? download;
        lock (_lock)
        {
            if (!_downloads.TryGetValue(model.Id, out download))
            {
                var cancel = new CancellationTokenSource();
                download = new Download { Cancel = cancel, Task = Task.Run(() => DownloadAsync(model, cancel.Token)) };
                _downloads[model.Id] = download;
                // La source d'annulation n'est pas liberee : RemoveAsync peut encore l'annuler apres coup.
                var started = download;
                started.Task.ContinueWith(_ =>
                {
                    lock (_lock)
                    {
                        if (_downloads.TryGetValue(model.Id, out var current) && ReferenceEquals(current, started))
                        {
                            _downloads.Remove(model.Id);
                        }
                    }
                }, TaskScheduler.Default);
            }
        }

        return download.Task.WaitAsync(ct);
    }

    private async Task DownloadAsync(WhisperModel model, CancellationToken ct)
    {
        Directory.CreateDirectory(_dir);
        var target = ModelPath(model);
        var part = target + ".part";
        var url = DownloadBase + "ggml-" + model.Id + ".bin";
        var watch = Stopwatch.StartNew();
        _log.Info($"Whisper : telechargement du modele {model.Id} ({url})");

        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, url);
            request.Headers.UserAgent.ParseAdd("Organizator/" + _version);
            using var response = await Http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
            {
                throw new InvalidOperationException($"le serveur a répondu {(int)response.StatusCode} {response.ReasonPhrase}");
            }

            var total = response.Content.Headers.ContentLength ?? model.Size;
            SetDownload(model.Id, 0, total);
            await using (var source = await response.Content.ReadAsStreamAsync(ct).ConfigureAwait(false))
            await using (var file = new FileStream(part, FileMode.Create, FileAccess.Write, FileShare.None, 1 << 16, useAsync: true))
            {
                var buffer = new byte[1 << 16];
                long received = 0;
                var last = Stopwatch.StartNew();
                int read;
                while ((read = await source.ReadAsync(buffer, ct).ConfigureAwait(false)) > 0)
                {
                    await file.WriteAsync(buffer.AsMemory(0, read), ct).ConfigureAwait(false);
                    received += read;
                    if (last.Elapsed >= ProgressEvery)
                    {
                        last.Restart();
                        SetDownload(model.Id, received, total);
                        Emit(new JsonObject { ["phase"] = "download", ["model"] = model.Id, ["received"] = received, ["total"] = total });
                    }
                }

                if (received != total)
                {
                    throw new InvalidOperationException($"téléchargement incomplet ({received} octets sur {total})");
                }
            }

            File.Move(part, target, overwrite: true);
            _log.Info($"Whisper : modele {model.Id} telecharge en {watch.Elapsed.TotalSeconds:0} s");
            Emit(new JsonObject { ["phase"] = "downloaded", ["model"] = model.Id });
        }
        catch (Exception ex)
        {
            TryDelete(part);
            if (ex is OperationCanceledException)
            {
                _log.Info($"Whisper : telechargement du modele {model.Id} interrompu");
                Emit(new JsonObject { ["phase"] = "download-failed", ["model"] = model.Id, ["error"] = "Téléchargement interrompu." });
                throw new InvalidOperationException("Téléchargement du modèle interrompu.");
            }

            _log.Warn($"Whisper : telechargement du modele {model.Id} impossible : {ex.Message}");
            var message = "Téléchargement du modèle Whisper impossible : " + (ex is HttpRequestException ? "réseau indisponible (" + ex.Message + ")" : ex.Message);
            Emit(new JsonObject { ["phase"] = "download-failed", ["model"] = model.Id, ["error"] = message });
            throw new InvalidOperationException(message);
        }
    }

    private void SetDownload(string id, long received, long total)
    {
        lock (_lock)
        {
            if (_downloads.TryGetValue(id, out var download))
            {
                download.Received = received;
                download.Total = total;
            }
        }
    }

    /// <summary>Supprime un modele du disque (ou interrompt son telechargement).</summary>
    public async Task<bool> RemoveAsync(string id)
    {
        var model = Find(id);
        Download? download;
        lock (_lock)
        {
            _downloads.TryGetValue(model.Id, out download);
        }

        if (download is not null)
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

        var path = ModelPath(model);
        if (!File.Exists(path))
        {
            return false;
        }

        if (!await _gate.WaitAsync(0).ConfigureAwait(false))
        {
            throw new InvalidOperationException("Une transcription est en cours : réessayez quand elle sera finie.");
        }

        try
        {
            if (string.Equals(_factoryModel, model.Id, StringComparison.Ordinal))
            {
                ReleaseFactory();
            }

            File.Delete(path);
            _log.Info($"Whisper : modele {model.Id} supprime");
            return true;
        }
        finally
        {
            _gate.Release();
        }
    }

    // ------------------------------------------------------------- transcription

    /// <summary>
    /// Prepare le modele sans rien transcrire — telechargement s'il manque, chargement en memoire —
    /// pendant que l'utilisateur parle : la transcription qui suit n'attend plus que le calcul.
    /// </summary>
    public void Warm(string id)
    {
        var model = Find(id);
        _ = Task.Run(async () =>
        {
            try
            {
                await EnsureModelAsync(model.Id, CancellationToken.None).ConfigureAwait(false);
                if (!await _gate.WaitAsync(0).ConfigureAwait(false))
                {
                    return; // une transcription tourne : elle chargera ce qu'il faut
                }

                try
                {
                    FactoryFor(model);
                }
                finally
                {
                    _gate.Release();
                    ScheduleRelease();
                }
            }
            catch (Exception ex)
            {
                // L'echec sera redit par la transcription elle-meme, avec son message.
                _log.Warn($"Whisper : preparation du modele {model.Id} impossible : {ex.Message}");
            }
        });
    }

    /// <summary>
    /// Transcrit un enregistrement. <paramref name="load"/> le decode (fichier, ou WAV de la dictee),
    /// hors du fil de l'interface. <paramref name="paragraphs"/> coupe le texte en paragraphes aux
    /// silences de plus de deux secondes (un enregistrement long) ; sinon tout tient sur une ligne
    /// (une dictee, inseree dans un champ).
    /// </summary>
    public async Task<JsonObject> TranscribeAsync(string job, Func<CancellationToken, float[]> load, string modelId, string language, bool paragraphs, string what)
    {
        if (string.IsNullOrWhiteSpace(job))
        {
            throw new InvalidOperationException("Transcription sans identifiant.");
        }

        var model = Find(modelId);
        language = SanitizeLanguage(language);
        using var cts = new CancellationTokenSource();
        lock (_lock)
        {
            _jobs[job] = cts;
        }

        var ct = cts.Token;
        var watch = Stopwatch.StartNew();
        try
        {
            if (!File.Exists(ModelPath(model)))
            {
                Emit(new JsonObject { ["job"] = job, ["phase"] = "download", ["model"] = model.Id, ["received"] = 0, ["total"] = model.Size });
                await EnsureModelAsync(model.Id, ct).ConfigureAwait(false);
            }

            Emit(new JsonObject { ["job"] = job, ["phase"] = "decode" });
            var samples = await Task.Run(() => load(ct), ct).ConfigureAwait(false);
            var seconds = samples.Length / (double)AudioDecoder.SampleRate;
            if (seconds < 0.3)
            {
                throw new InvalidOperationException("Enregistrement vide ou trop court.");
            }

            if (_gate.CurrentCount == 0)
            {
                Emit(new JsonObject { ["job"] = job, ["phase"] = "queue" });
            }

            await _gate.WaitAsync(ct).ConfigureAwait(false);
            try
            {
                Emit(new JsonObject { ["job"] = job, ["phase"] = "load" });
                var factory = await Task.Run(() => FactoryFor(model), ct).ConfigureAwait(false);
                Emit(new JsonObject { ["job"] = job, ["phase"] = "transcribe", ["percent"] = 0 });
                var (text, detected) = await Task.Run(() => RunAsync(factory, samples, language, paragraphs, job, ct), ct).ConfigureAwait(false);
                watch.Stop();
                _log.Info($"Whisper : {what} de {seconds:0.0} s transcrit en {watch.ElapsedMilliseconds} ms ({model.Id}, {detected}, {text.Length} caracteres)");
                return new JsonObject
                {
                    ["job"] = job,
                    ["text"] = text,
                    ["language"] = detected,
                    ["duration"] = Math.Round(seconds, 1),
                    ["ms"] = watch.ElapsedMilliseconds,
                    ["model"] = model.Id,
                };
            }
            finally
            {
                _gate.Release();
                ScheduleRelease();
            }
        }
        catch (OperationCanceledException)
        {
            _log.Info($"Whisper : {what} interrompu a la demande");
            throw new InvalidOperationException("Transcription interrompue.");
        }
        catch (DllNotFoundException ex)
        {
            _log.Error("Whisper : bibliotheque native introuvable", ex);
            throw new InvalidOperationException("Moteur Whisper introuvable : " + ex.Message);
        }
        catch (PlatformNotSupportedException ex)
        {
            _log.Error("Whisper : processeur non pris en charge", ex);
            throw new InvalidOperationException("Ce processeur ne peut pas faire tourner Whisper (AVX2 requis).");
        }
        finally
        {
            lock (_lock)
            {
                if (_jobs.TryGetValue(job, out var current) && ReferenceEquals(current, cts))
                {
                    _jobs.Remove(job);
                }
            }
        }
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

    private async Task<(string Text, string Language)> RunAsync(WhisperFactory factory, float[] samples, string language, bool paragraphs, string job, CancellationToken ct)
    {
        var last = Stopwatch.StartNew();
        var threads = Math.Clamp(Environment.ProcessorCount / 2, 2, 8);
        var builder = factory.CreateBuilder()
            .WithThreads(threads)
            .WithLanguage(language)
            .WithProgressHandler(percent =>
            {
                if (last.Elapsed < ProgressEvery && percent < 100)
                {
                    return;
                }

                last.Restart();
                Emit(new JsonObject { ["job"] = job, ["phase"] = "transcribe", ["percent"] = percent });
            });

        var text = new StringBuilder();
        var detected = language;
        TimeSpan? previousEnd = null;
        await using var processor = builder.Build();
        await foreach (var segment in processor.ProcessAsync(samples, ct).ConfigureAwait(false))
        {
            var piece = (segment.Text ?? "").Trim();
            if (piece.Length == 0 || Phantom.IsMatch(piece))
            {
                continue;
            }

            if (!string.IsNullOrEmpty(segment.Language))
            {
                detected = segment.Language;
            }

            if (text.Length > 0)
            {
                var pause = previousEnd is null ? TimeSpan.Zero : segment.Start - previousEnd.Value;
                text.Append(paragraphs && pause >= TimeSpan.FromSeconds(2) ? "\n\n" : " ");
            }

            text.Append(piece);
            previousEnd = segment.End;
        }

        return (text.ToString().Trim(), detected);
    }

    // ------------------------------------------------------------------ modele

    /// <summary>Modele charge (sous <see cref="_gate"/>) : celui qu'on demande, a la place du precedent.</summary>
    private WhisperFactory FactoryFor(WhisperModel model)
    {
        if (_factory is not null && string.Equals(_factoryModel, model.Id, StringComparison.Ordinal))
        {
            return _factory;
        }

        ReleaseFactory();
        PrepareNative();
        var watch = Stopwatch.StartNew();
        _factory = WhisperFactory.FromPath(ModelPath(model), new WhisperFactoryOptions { UseGpu = false });
        _factoryModel = model.Id;
        _log.Info($"Whisper : modele {model.Id} charge en {watch.ElapsedMilliseconds} ms (runtime {RuntimeOptions.LoadedLibrary})");
        return _factory;
    }

    private void ReleaseFactory()
    {
        if (_factory is null)
        {
            return;
        }

        try
        {
            _factory.Dispose();
        }
        catch (Exception ex)
        {
            _log.Warn("Whisper : liberation du modele : " + ex.Message);
        }

        _log.Info($"Whisper : modele {_factoryModel} libere");
        _factory = null;
        _factoryModel = null;
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
            ReleaseFactory();
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>
    /// Extrait les DLL natives embarquees (une fois par version) et dit a Whisper.net ou les prendre :
    /// il cherche <c>runtimes\win-x64\whisper.dll</c> a cote du chemin donne.
    /// </summary>
    private void PrepareNative()
    {
        if (_nativeReady)
        {
            return;
        }

        var assembly = typeof(WhisperTranscriber).Assembly;
        var runtimeVersion = typeof(WhisperFactory).Assembly.GetName().Version?.ToString(3) ?? "0";
        var root = Path.Combine(_dir, "runtime-" + runtimeVersion);
        var target = Path.Combine(root, "runtimes", "win-x64");
        Directory.CreateDirectory(target);
        const string prefix = "whisper/win-x64/";
        var found = 0;
        foreach (var name in assembly.GetManifestResourceNames().Where(n => n.StartsWith(prefix, StringComparison.Ordinal)))
        {
            using var resource = assembly.GetManifestResourceStream(name)!;
            var path = Path.Combine(target, name[prefix.Length..]);
            var existing = new FileInfo(path);
            if (!existing.Exists || existing.Length != resource.Length)
            {
                var tmp = path + ".tmp";
                using (var file = File.Create(tmp))
                {
                    resource.CopyTo(file);
                }

                File.Move(tmp, path, overwrite: true);
            }

            found++;
        }

        if (found == 0)
        {
            throw new DllNotFoundException("les DLL de whisper.cpp ne sont pas embarquées dans cet exécutable.");
        }

        RuntimeOptions.LibraryPath = Path.Combine(root, "whisper.dll");
        RuntimeOptions.RuntimeLibraryOrder = [RuntimeLibrary.Cpu];
        _nativeReady = true;
    }

    // ------------------------------------------------------------------ outils

    private void Emit(JsonObject payload)
    {
        try
        {
            Progress?.Invoke(payload);
        }
        catch (Exception ex)
        {
            Debug.WriteLine("[Organizator] Whisper.Progress : " + ex.Message);
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
            // fichier partiel verrouille : il sera ecrase au prochain essai
        }
    }
}
