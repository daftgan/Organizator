using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Net.Http;
using System.Reflection;
using System.Runtime.InteropServices;
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
    // ou une didascalie. Un segment qui n'est que cela est ecarte. En anglais : fins de video et credits
    // de sous-titrage (« Thank you for watching », « Subtitles by... ») ; « Thank you. » seul reste, c'est
    // une vraie reponse dans un dialogue.
    private static readonly Regex Phantom = new(
        @"^\s*(\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|♪+|sous-titr\w*.*|.*amara\.org.*|merci d'avoir regardé.*|abonnez-vous.*"
        + @"|(thank\s+you|thanks)(\s+(so|very)\s+much)?(\s+(all|guys|everyone))?\s+for\s+(watching|viewing|listening\s+to\s+(this|the|my|our)\s+(video|channel|podcast)).*"
        + @"|(english\s+)?(subtitles?|subtitled|captions?|captioned|captioning|closed\s+captions?(ing)?|transcription|transcribed)\s+(made\s+|provided\s+|created\s+|done\s+)?by\b.*"
        + @"|please\s+(like\s+(and|&)\s+)?subscribe\b.*|(like\s+(and|&)\s+)?subscribe\s+to\s+(my|our|the)\s+channel.*|don['’]t\s+forget\s+to\s+(like|subscribe)\b.*)\s*$",
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
    public Task<JsonObject> TranscribeAsync(string job, Func<CancellationToken, float[]> load, string modelId, string language, bool paragraphs, string what)
        => TranscribeAsync(job, load, modelId, language, paragraphs, what, detail: false, reference: null);

    /// <summary>
    /// Transcription enrichie quand <paramref name="detail"/> : en plus du texte, les mots (horodatage des
    /// jetons, probabilites), P(en) a la detection libre de la langue (indice d'accent, meme si la langue est
    /// imposee), le debit et les pauses (energie du signal), et l'alignement sur <paramref name="reference"/>
    /// s'il est donne. Le texte attendu ne sert qu'a l'alignement : jamais de <c>prompt</c> a Whisper, qui le
    /// recopierait. <paramref name="accent"/> = false saute la detection libre (P(en) nul), qui coute un passage
    /// d'encodeur de plus. Sans <paramref name="detail"/>, la transcription est exactement celle de la dictee.
    /// </summary>
    public async Task<JsonObject> TranscribeAsync(string job, Func<CancellationToken, float[]> load, string modelId, string language, bool paragraphs, string what, bool detail, string? reference, bool accent = true)
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
                var run = await Task.Run(() => RunAsync(factory, samples, language, paragraphs, detail, detail && accent, job, ct), ct).ConfigureAwait(false);
                var (text, detected) = (run.Text, run.Language);
                var result = new JsonObject
                {
                    ["job"] = job,
                    ["text"] = text,
                    ["language"] = detected,
                    ["duration"] = Math.Round(seconds, 1),
                    ["ms"] = 0,
                    ["model"] = model.Id,
                };
                var summary = detail ? " ; detail : " + AddDetail(result, run, samples, reference) : "";
                watch.Stop();
                result["ms"] = watch.ElapsedMilliseconds;
                _log.Info($"Whisper : {what} de {seconds:0.0} s transcrit en {watch.ElapsedMilliseconds} ms ({model.Id}, {detected}, {text.Length} caracteres){summary}");
                return result;
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

    /// <summary>
    /// Resultat brut d'une transcription. Avec le detail : les mots, P(en) et la langue trouvee a la detection
    /// libre (<c>null</c> si elle a echoue), et sa duree.
    /// </summary>
    private sealed record RunResult(string Text, string Language, List<SpokenWord>? Words, double? English, string? FreeLanguage, long LanguageMs);

    private async Task<RunResult> RunAsync(WhisperFactory factory, float[] samples, string language, bool paragraphs, bool detail, bool accent, string job, CancellationToken ct)
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
        if (detail)
        {
            // Horodatage et probabilite de chaque jeton ; toujours sans prompt (voir TranscribeAsync).
            builder = builder.WithTokenTimestamps().WithProbabilities();
        }

        var text = new StringBuilder();
        var detected = language;
        TimeSpan? previousEnd = null;
        await using var processor = builder.Build();

        List<SpokenWord>? words = detail ? [] : null;
        double? english = null;
        string? freeLanguage = null;
        long languageMs = 0;
        if (accent)
        {
            // Un passage d'encodeur de plus, autant qu'une dictee courte : accent = false le saute.
            var watch = Stopwatch.StartNew();
            (english, freeLanguage) = EnglishProbability(processor, samples, threads);
            languageMs = watch.ElapsedMilliseconds;
            ct.ThrowIfCancellationRequested();
        }

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
            // Jetons en centisecondes ; les mots d'un segment fantome sont ecartes avec lui.
            words?.AddRange(SpeechAssessment.WordsFromTokens((segment.Tokens ?? [])
                .Select(t => new SpokenToken(t.Text ?? "", t.Start / 100.0, t.End / 100.0, t.Probability))));
        }

        return new RunResult(text.ToString().Trim(), detected, words, english, freeLanguage, languageMs);
    }

    /// <summary>
    /// P(en) a la detection libre, sur les 30 premieres secondes (Whisper n'en regarde pas plus). Whisper.net ne
    /// rend que la probabilite de la langue gagnante : on lit donc le tableau entier de whisper.cpp
    /// (<see cref="NativeLanguage"/>) ; a defaut, P(langue gagnante) si c'est l'anglais, sinon son complement,
    /// qui borne P(en) par le haut.
    /// </summary>
    private (double? English, string? Language) EnglishProbability(WhisperProcessor processor, float[] samples, int threads)
    {
        var limit = 30 * AudioDecoder.SampleRate;
        var head = samples.Length > limit ? samples[..limit] : samples;
        try
        {
            var native = NativeLanguage.Detect(processor, head, threads);
            if (native is not null)
            {
                return native.Value;
            }
        }
        catch (Exception ex)
        {
            _log.Warn("Whisper : detection de la langue (whisper.cpp) impossible : " + ex.Message);
        }

        try
        {
            var (found, probability) = processor.DetectLanguageWithProbability(head);
            if (string.IsNullOrEmpty(found))
            {
                return (null, null);
            }

            var english = found == "en" ? probability : Math.Max(0, 1 - probability);
            return (Math.Clamp(english, 0, 1), found);
        }
        catch (Exception ex)
        {
            _log.Warn("Whisper : detection de la langue impossible : " + ex.Message);
            return (null, null);
        }
    }

    /// <summary>
    /// Complete la reponse : mots, P(en), debit, pauses, alignement. Rend le resume pour le journal.
    /// </summary>
    private static string AddDetail(JsonObject result, RunResult run, float[] samples, string? reference)
    {
        var words = run.Words ?? [];
        var energy = SpeechAssessment.Energy(samples);
        var fluency = SpeechAssessment.Fluency(words, energy);
        var alignment = string.IsNullOrWhiteSpace(reference) ? null : SpeechAssessment.Align(reference, words);

        result["languageProbability"] = run.English is double english ? (JsonNode)Math.Round(english, 3) : null;
        result["detectedLanguage"] = run.FreeLanguage;
        result["words"] = new JsonArray(words.Select(w => (JsonNode)new JsonObject
        {
            ["text"] = w.Text,
            ["start"] = w.Start,
            ["end"] = w.End,
            ["p"] = w.P,
            ["pMin"] = w.PMin,
        }).ToArray());
        result["wpm"] = fluency.Wpm;
        result["articulationWpm"] = fluency.ArticulationWpm;
        result["speechSeconds"] = fluency.SpeechSeconds;
        result["pauses"] = new JsonArray(fluency.Pauses.Select(p => (JsonNode)new JsonObject
        {
            ["after"] = p.After,
            ["at"] = p.At,
            ["seconds"] = p.Seconds,
        }).ToArray());
        result["alignment"] = alignment is null ? null : new JsonObject
        {
            ["accuracy"] = alignment.Accuracy,
            ["wer"] = alignment.Wer,
            ["refWords"] = alignment.RefTokens,
            ["ok"] = alignment.Ok,
            ["sub"] = alignment.Sub,
            ["del"] = alignment.Del,
            ["ins"] = alignment.Ins,
            ["ops"] = new JsonArray(alignment.Ops.Select(o => (JsonNode)new JsonObject
            {
                ["op"] = o.Op,
                ["ref"] = o.Ref,
                ["hyp"] = o.Hyp,
                ["start"] = o.Start,
                ["end"] = o.End,
                ["p"] = o.P,
                ["refIndex"] = o.RefIndex,
                ["wordIndex"] = o.WordIndex,
            }).ToArray()),
        };

        var odds = run.English is double value ? value.ToString("0.00", CultureInfo.InvariantCulture) : "?";
        var aligned = alignment is null ? "" : $", exactitude {alignment.Accuracy.ToString("0.00", CultureInfo.InvariantCulture)}";
        return $"P(en) {odds} ({run.FreeLanguage ?? "?"}, {run.LanguageMs} ms), {words.Count} mots, {fluency.Wpm} mots/min, {fluency.Pauses.Count} pauses{aligned}";
    }

    /// <summary>
    /// Detection de la langue par l'API C de whisper.cpp, pour avoir la probabilite de l'anglais meme quand une
    /// autre langue l'emporte (Whisper.net ne rend que la gagnante). Meme suite d'appels que
    /// <c>WhisperProcessor.DetectLanguageWithProbability</c> (etat neuf, mel, detection, liberation), sur le
    /// contexte du processeur, lu par reflexion (Whisper.net 1.8.1) ; fonctions prises dans la whisper.dll
    /// deja chargee. Le moindre ecart (champ ou export absent) rend <c>null</c> : on se rabat sur Whisper.net.
    /// </summary>
    private static class NativeLanguage
    {
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        private delegate IntPtr InitState(IntPtr context);

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        private delegate void FreeState(IntPtr state);

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        private delegate int PcmToMel(IntPtr context, IntPtr state, [In] float[] samples, int count, int threads);

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        private delegate int AutoDetect(IntPtr context, IntPtr state, int offsetMs, int threads, [In, Out] float[] probabilities);

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        private delegate int MaxId();

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        private delegate IntPtr LangStr(int id);

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        private delegate int LangId([MarshalAs(UnmanagedType.LPStr)] string language);

        private sealed record Api(InitState Init, FreeState Free, PcmToMel Mel, AutoDetect Detect, int Size, int English, LangStr Name);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
        private static extern IntPtr GetModuleHandleW(string name);

        private static readonly FieldInfo? ContextField =
            typeof(WhisperProcessor).GetField("currentWhisperContext", BindingFlags.Instance | BindingFlags.NonPublic);

        private static readonly object Gate = new();
        private static Api? _api;
        private static bool _resolved;

        public static (double? English, string? Language)? Detect(WhisperProcessor processor, float[] samples, int threads)
        {
            var api = Resolve();
            if (api is null || ContextField?.GetValue(processor) is not IntPtr context || context == IntPtr.Zero)
            {
                return null;
            }

            var state = api.Init(context);
            if (state == IntPtr.Zero)
            {
                return null;
            }

            try
            {
                if (api.Mel(context, state, samples, samples.Length, threads) != 0)
                {
                    return null;
                }

                var probabilities = new float[api.Size];
                var best = api.Detect(context, state, 0, threads, probabilities);
                if (best < 0 || best >= probabilities.Length)
                {
                    return null;
                }

                var name = Marshal.PtrToStringAnsi(api.Name(best));
                return (Math.Clamp(probabilities[api.English], 0, 1), name);
            }
            finally
            {
                api.Free(state);
            }
        }

        private static Api? Resolve()
        {
            lock (Gate)
            {
                if (_resolved)
                {
                    return _api;
                }

                _resolved = true;
                var module = GetModuleHandleW("whisper.dll");
                if (module == IntPtr.Zero)
                {
                    return null;
                }

                T? Export<T>(string name) where T : Delegate
                    => NativeLibrary.TryGetExport(module, name, out var address) ? Marshal.GetDelegateForFunctionPointer<T>(address) : null;

                var init = Export<InitState>("whisper_init_state");
                var free = Export<FreeState>("whisper_free_state");
                var mel = Export<PcmToMel>("whisper_pcm_to_mel_with_state");
                var detect = Export<AutoDetect>("whisper_lang_auto_detect_with_state");
                var maxId = Export<MaxId>("whisper_lang_max_id");
                var langStr = Export<LangStr>("whisper_lang_str");
                var langId = Export<LangId>("whisper_lang_id");
                if (init is null || free is null || mel is null || detect is null || maxId is null || langStr is null || langId is null)
                {
                    return null;
                }

                var english = langId("en");
                // whisper.cpp ecrit lang_probs[0..max_id] inclus : une case de plus, et de la marge.
                var size = Math.Max(128, maxId() + 2);
                if (english < 0 || english >= size)
                {
                    return null;
                }

                _api = new Api(init, free, mel, detect, size, english, langStr);
                return _api;
            }
        }
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
