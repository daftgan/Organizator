using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using SherpaOnnx;

namespace Organizator.Services;

/// <summary>Reponse HTTP en erreur : le code reste lisible (un 404 n'appelle pas le meme message qu'une panne).</summary>
public sealed class SherpaHttpException(HttpStatusCode status, string message) : InvalidOperationException(message)
{
    public HttpStatusCode Status { get; } = status;
}

/// <summary>
/// Runtime natif de sherpa-onnx 1.13.8, partage par la synthese vocale (<see cref="TextToSpeech"/>, Kokoro)
/// et la transcription en direct (<see cref="LiveAsr"/>).
///
/// <list type="bullet">
/// <item><description>Les deux DLL natives (onnxruntime 1.28.2 et sherpa-onnx-c-api, 21 Mo) sont extraites
/// du paquet NuGet du runtime win-x64 sous <c>&lt;donnees&gt;\tts\runtime-1.13.8\</c> (dossier d'origine de
/// Kokoro, garde pour les installations existantes), chacune controlee (taille et SHA-256).
/// Un seul telechargement a la fois, partage par tous ceux qui l'attendent ; il s'arrete si plus
/// personne ne l'attend.</description></item>
/// <item><description>Les DLL ne se chargent qu'une fois par processus, et le resolveur de DllImport de
/// l'assembly sherpa-onnx ne se pose qu'une fois : une DLL liberee laisserait des appels lies a une
/// adresse morte.</description></item>
/// <item><description>Chaque usage declare quand il a besoin du runtime (<see cref="RegisterUser"/>) : le
/// runtime n'est supprime qu'une fois plus personne n'en a besoin (DLL chargees : au prochain
/// demarrage, marque <c>runtime-&lt;version&gt;.remove</c>).</description></item>
/// </list>
/// </summary>
public sealed class SherpaRuntime
{
    public const string Version = "1.13.8";

    // Le paquet NuGet du runtime win-x64, dont on n'extrait que les deux DLL ; son SHA-512 est celui
    // que NuGet verifie (org.k2fsa.sherpa.onnx.runtime.win-x64.1.13.8.nupkg.sha512).
    private const string PackageUrl = "https://api.nuget.org/v3-flatcontainer/org.k2fsa.sherpa.onnx.runtime.win-x64/1.13.8/org.k2fsa.sherpa.onnx.runtime.win-x64.1.13.8.nupkg";
    public const long DownloadSize = 8_535_869;
    private const string PackageSha512 = "7ZpIieyGnrhTBTPDeQsq5S36Qe3wxGHFAB/Hl3Q7zrhJ7ayb4co0oCI+ZY6MDC1p519T3DqUIPRUO6g47GSKkw==";
    private const string PackageEntry = "runtimes/win-x64/native/";

    private sealed record Asset(string Path, long Size, string Sha256);

    private static readonly Asset[] Files =
    [
        new("onnxruntime.dll", 17_799_168, "7f66f939a881baf4f46a2216496798edf4a1429878b646d12674aa62f27d8a25"),
        new("sherpa-onnx-c-api.dll", 4_605_952, "2729a0da3fbd20fb4e14e157f7cc0e00af848b55f04121319d445c138aeba214"),
    ];

    /// <summary>Le code natif borne ses chemins : on garde de la marge sous MAX_PATH.</summary>
    public const int NativePathLimit = 240;

    private static readonly TimeSpan StallTimeout = TimeSpan.FromSeconds(60);

    private static readonly HttpClient Http = new(new SocketsHttpHandler { ConnectTimeout = TimeSpan.FromSeconds(20) })
    {
        Timeout = Timeout.InfiniteTimeSpan,
    };

    // Etat natif du processus : une seule pose du resolveur, quel que soit le nombre d'instances.
    private static readonly object NativeLock = new();
    private static IntPtr _nativeApi;
    private static string? _nativeDir;

    private readonly HostLog _log;
    private readonly string _dir;
    private readonly string _removeMarker;
    private readonly string _version;
    private readonly object _lock = new();
    private readonly List<(string Name, Func<bool> Needs)> _users = [];
    private RuntimeDownload? _download;

    public SherpaRuntime(string dataDir, HostLog log, string version)
    {
        _log = log;
        _dir = Path.Combine(dataDir, "tts", "runtime-" + Version);
        _removeMarker = _dir + ".remove";
        _version = version;
        DropRemoved();
    }

    public string Directory => _dir;

    /// <summary>Les deux DLL sont la, entieres, et le runtime n'est pas en attente d'effacement.</summary>
    public bool Present => !File.Exists(_removeMarker) && FilesPresent;

    /// <summary>Dossier present et pas en attente d'effacement (meme incomplet) : il y a quelque chose a supprimer.</summary>
    public bool Installed => System.IO.Directory.Exists(_dir) && !File.Exists(_removeMarker);

    /// <summary>Les deux DLL sont la, entieres (marque d'effacement ou non) : un telechargement n'aurait rien a prendre.</summary>
    public bool FilesPresent => Files.All(f => new FileInfo(Path.Combine(_dir, f.Path)) is { Exists: true } info && info.Length == f.Size);

    /// <summary>DLL chargees par ce processus depuis ce dossier (elles ne peuvent plus etre effacees).</summary>
    public bool LoadedFromHere
    {
        get
        {
            lock (NativeLock)
            {
                return _nativeApi != IntPtr.Zero && string.Equals(_nativeDir, _dir, StringComparison.OrdinalIgnoreCase);
            }
        }
    }

    /// <summary>Un usage du runtime : <paramref name="needs"/> dit s'il en a encore besoin (modele installe).</summary>
    public void RegisterUser(string name, Func<bool> needs)
    {
        lock (_lock)
        {
            _users.Add((name, needs));
        }
    }

    // ------------------------------------------------------------ telechargement

    private sealed class RuntimeDownload
    {
        public required CancellationTokenSource Cancel { get; init; }
        public Task Task { get; set; } = Task.CompletedTask;
        public int Waiters;
        public readonly List<Action<long>> Listeners = [];
    }

    /// <summary>
    /// Rend le runtime disponible : rien a faire s'il est la (un runtime supprime dans cette session
    /// resert tel quel), sinon un seul telechargement partage. <paramref name="onBytes"/> recoit chaque
    /// lot d'octets recus ; annuler <paramref name="ct"/> cesse d'attendre, et arrete le telechargement
    /// si plus personne ne l'attend.
    /// </summary>
    public async Task EnsureAsync(Action<long>? onBytes, CancellationToken ct)
    {
        if (File.Exists(_removeMarker) && FilesPresent)
        {
            File.Delete(_removeMarker);
        }

        if (Present)
        {
            return;
        }

        RuntimeDownload download;
        lock (_lock)
        {
            if (_download is null || _download.Task.IsCompleted)
            {
                var started = new RuntimeDownload { Cancel = new CancellationTokenSource() };
                started.Task = Task.Run(() => DownloadAsync(started, started.Cancel.Token));
                _download = started;
            }

            download = _download;
            download.Waiters++;
            if (onBytes is not null)
            {
                download.Listeners.Add(onBytes);
            }
        }

        try
        {
            await download.Task.WaitAsync(ct).ConfigureAwait(false);
        }
        finally
        {
            lock (_lock)
            {
                download.Waiters--;
                if (onBytes is not null)
                {
                    download.Listeners.Remove(onBytes);
                }

                if (download.Waiters == 0 && !download.Task.IsCompleted)
                {
                    download.Cancel.Cancel();
                }
            }
        }
    }

    private async Task DownloadAsync(RuntimeDownload download, CancellationToken ct)
    {
        System.IO.Directory.CreateDirectory(_dir);
        if (File.Exists(_removeMarker))
        {
            File.Delete(_removeMarker);
        }

        var watch = Stopwatch.StartNew();
        var part = Path.Combine(_dir, "runtime.nupkg.part");
        try
        {
            await FetchAsync(PackageUrl, part, DownloadSize, DownloadSize, HashAlgorithmName.SHA512, PackageSha512, base64: true, "runtime", _version,
                read =>
                {
                    Action<long>[] listeners;
                    lock (_lock)
                    {
                        listeners = download.Listeners.ToArray();
                    }

                    foreach (var listener in listeners)
                    {
                        listener(read);
                    }
                }, ct).ConfigureAwait(false);
            Extract(part);
            File.Delete(part);
            _log.Info($"Sherpa : runtime {Version} telecharge en {watch.Elapsed.TotalSeconds:0} s");
        }
        catch
        {
            TryDelete(part);
            throw;
        }
    }

    /// <summary>Les deux DLL win-x64 du paquet NuGet, controlees une a une.</summary>
    private void Extract(string nupkg)
    {
        using var zip = ZipFile.OpenRead(nupkg);
        foreach (var asset in Files)
        {
            var entry = zip.GetEntry(PackageEntry + asset.Path)
                ?? throw new InvalidOperationException($"{asset.Path} absent du paquet du runtime");
            var target = Path.Combine(_dir, asset.Path);
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

    /// <summary>
    /// Un fichier, en <c>.part</c>, empreinte calculee au fil de l'eau ; le renommage revient a l'appelant.
    /// <paramref name="size"/> connu : la reponse doit l'avoir exactement. Inconnu (<c>null</c>) : la
    /// taille annoncee par le serveur fait foi, bornee par <paramref name="maxSize"/>, et
    /// <paramref name="onLength"/> la recoit. <paramref name="expected"/> connu : l'empreinte doit
    /// l'egaler ; sinon elle est seulement rendue (a journaliser). Une reponse en erreur leve
    /// <see cref="SherpaHttpException"/>.
    /// </summary>
    public static async Task<(long Size, string Hash)> FetchAsync(string url, string part, long? size, long maxSize,
        HashAlgorithmName algorithm, string? expected, bool base64, string name, string version,
        Action<long>? onBytes, CancellationToken ct, Action<long>? onLength = null)
    {
        // Un serveur qui ne repond plus ferait attendre indefiniment : 60 s sans octet, on abandonne.
        using var stall = CancellationTokenSource.CreateLinkedTokenSource(ct);
        try
        {
            stall.CancelAfter(StallTimeout);
            using var request = new HttpRequestMessage(HttpMethod.Get, url);
            request.Headers.UserAgent.ParseAdd("Organizator/" + version);
            using var response = await Http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, stall.Token).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
            {
                throw new SherpaHttpException(response.StatusCode, $"le serveur a répondu {(int)response.StatusCode} {response.ReasonPhrase} pour {name}");
            }

            var announced = response.Content.Headers.ContentLength;
            if (size is long known)
            {
                if (announced is long length && length != known)
                {
                    throw new InvalidOperationException($"{name} : taille inattendue ({length} octets au lieu de {known})");
                }
            }
            else if (announced is long length)
            {
                if (length > maxSize)
                {
                    throw new InvalidOperationException($"{name} : fichier trop gros ({length} octets, {maxSize} au plus)");
                }

                onLength?.Invoke(length);
            }

            var limit = size ?? announced ?? maxSize;
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

                    if (received + read > limit)
                    {
                        throw new InvalidOperationException($"{name} : plus long que prévu ({limit} octets)");
                    }

                    hash.AppendData(buffer, 0, read);
                    await file.WriteAsync(buffer.AsMemory(0, read), ct).ConfigureAwait(false);
                    received += read;
                    onBytes?.Invoke(read);
                }
            }

            if ((size ?? announced) is long whole && received != whole)
            {
                throw new InvalidOperationException($"{name} : téléchargement incomplet ({received} octets sur {whole})");
            }

            if (received == 0)
            {
                throw new InvalidOperationException($"{name} : fichier vide");
            }

            var digest = hash.GetHashAndReset();
            var actual = base64 ? Convert.ToBase64String(digest) : Convert.ToHexString(digest).ToLowerInvariant();
            if (expected is not null && !string.Equals(actual, expected, StringComparison.Ordinal))
            {
                throw new InvalidOperationException($"{name} : empreinte inattendue (fichier altéré, ou changé sur le serveur)");
            }

            return (received, actual);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            throw new InvalidOperationException($"le serveur ne répond plus ({name})");
        }
    }

    // ------------------------------------------------------------ suppression

    /// <summary>
    /// Supprime le runtime si plus aucun usage n'en a besoin (a appeler apres avoir efface son propre
    /// modele). DLL deja chargees : effacees au prochain demarrage, et elles resservent d'ici la.
    /// Rend <c>true</c> si le runtime est supprime (ou le sera), <c>false</c> s'il est garde ou absent.
    /// </summary>
    public bool RemoveIfUnused()
    {
        string[] needing;
        lock (_lock)
        {
            needing = _users.Where(u => SafeNeeds(u.Needs)).Select(u => u.Name).ToArray();
            if (_download is not null && !_download.Task.IsCompleted)
            {
                needing = [.. needing, "telechargement en cours"];
            }
        }

        if (needing.Length > 0)
        {
            _log.Info("Sherpa : runtime garde (" + string.Join(", ", needing) + ")");
            return false;
        }

        if (!System.IO.Directory.Exists(_dir) || File.Exists(_removeMarker))
        {
            return false;
        }

        if (LoadedFromHere)
        {
            File.WriteAllText(_removeMarker, "DLL chargees par le processus : a effacer au prochain demarrage." + Environment.NewLine);
        }
        else
        {
            System.IO.Directory.Delete(_dir, recursive: true);
        }

        _log.Info("Sherpa : runtime supprime");
        return true;
    }

    private bool SafeNeeds(Func<bool> needs)
    {
        try
        {
            return needs();
        }
        catch (Exception ex)
        {
            _log.Warn("Sherpa : usage du runtime illisible : " + ex.Message);
            return true;
        }
    }

    /// <summary>Au demarrage, rien n'est encore charge : le runtime supprime la fois precedente s'efface.</summary>
    private void DropRemoved()
    {
        if (!File.Exists(_removeMarker) || LoadedFromHere)
        {
            return;
        }

        try
        {
            if (System.IO.Directory.Exists(_dir))
            {
                System.IO.Directory.Delete(_dir, recursive: true);
            }

            File.Delete(_removeMarker);
            _log.Info("Sherpa : runtime supprime a la session precedente efface");
        }
        catch (Exception ex)
        {
            _log.Warn("Sherpa : effacement du runtime supprime impossible : " + ex.Message);
        }
    }

    // ------------------------------------------------------------------ natif

    /// <summary>
    /// Charge les deux DLL par leur chemin complet — <c>System32\onnxruntime.dll</c> (Windows ML 1.17)
    /// n'est pas la bonne — et dit au runtime ou trouver <c>sherpa-onnx-c-api</c> ; une fois par processus.
    /// <paramref name="missing"/> : message si le runtime manque ; <paramref name="logPrefix"/> : <c>TTS</c>, <c>ASR</c>...
    /// </summary>
    public void PrepareNative(string missing, string logPrefix)
    {
        lock (NativeLock)
        {
            if (_nativeApi != IntPtr.Zero)
            {
                if (!string.Equals(_nativeDir, _dir, StringComparison.OrdinalIgnoreCase))
                {
                    _log.Info(logPrefix + " : DLL natives deja chargees depuis " + _nativeDir);
                }

                return;
            }

            if (!Present)
            {
                throw new InvalidOperationException(missing);
            }

            LoadNative(Path.Combine(_dir, "onnxruntime.dll"), Path.Combine(_dir, "sherpa-onnx-c-api.dll"), _dir);
            _log.Info(logPrefix + " : DLL natives chargees depuis " + _dir);
        }
    }

    /// <summary>
    /// Charge onnxruntime puis l'API C de sherpa-onnx et pose le resolveur (une fois par processus ;
    /// sans effet ensuite). Public pour les essais hors Windows (bibliotheques <c>.so</c>).
    /// </summary>
    public static void LoadNative(string onnxRuntimePath, string apiPath, string from)
    {
        lock (NativeLock)
        {
            if (_nativeApi != IntPtr.Zero)
            {
                return;
            }

            NativeLibrary.Load(onnxRuntimePath);
            var api = NativeLibrary.Load(apiPath);
            _nativeApi = api;
            _nativeDir = from;
            NativeLibrary.SetDllImportResolver(typeof(OfflineTts).Assembly, (name, _, _) =>
                name.StartsWith("sherpa-onnx-c-api", StringComparison.OrdinalIgnoreCase) ? _nativeApi : IntPtr.Zero);
        }
    }

    /// <summary>
    /// Le chemin tel quel s'il est ASCII et court, sinon son nom court 8.3 ; refus lisible si celui-ci
    /// n'y suffit pas. <paramref name="folder"/> : « des voix », « du modèle de transcription »... ;
    /// <paramref name="engine"/> : « de synthèse », « de transcription ».
    /// </summary>
    public static string NativePath(string path, string folder, string engine)
    {
        var full = Path.GetFullPath(path);
        if (IsAscii(full) && full.Length < NativePathLimit - 60)
        {
            return full;
        }

        var shortPath = "";
        if (OperatingSystem.IsWindows())
        {
            var buffer = new StringBuilder(1024);
            var length = GetShortPathNameW(full, buffer, (uint)buffer.Capacity);
            shortPath = length > 0 && length < buffer.Capacity ? buffer.ToString() : "";
        }

        if (shortPath.Length == 0 || !IsAscii(shortPath))
        {
            throw new InvalidOperationException($"Le dossier {folder} ({full}) contient des caractères que le moteur {engine} ne sait pas lire, et Windows n'en donne pas de nom court : "
                + @"lancez Organizator avec un dossier de données au nom simple (par exemple --data C:\OrganizatorData).");
        }

        return shortPath;
    }

    private static bool IsAscii(string value) => value.All(c => c >= 32 && c < 127);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetShortPathNameW(string longPath, StringBuilder shortPath, uint length);

    // ------------------------------------------------------------------ outils

    public static string Sha256Of(string path)
    {
        using var stream = File.OpenRead(path);
        return Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
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
