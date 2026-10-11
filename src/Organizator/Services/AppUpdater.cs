using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text.Json.Nodes;

namespace Organizator.Services;

/// <summary>
/// Mises a jour automatiques d'Organizator. Le serveur Revizator regle dans Organizator sert le dernier
/// installateur (<c>GET /api/organizator</c>, <c>/download/organizator</c>) : au demarrage puis toutes les
/// six heures, une version plus recente est telechargee en arriere-plan dans <c>updates\</c> du dossier de
/// donnees et son empreinte SHA-256 verifiee. Elle s'installe en silence a la fermeture d'Organizator, ou
/// tout de suite (« Installer maintenant », Organizator relance a la fin). Seule une copie installee par
/// l'installateur (<c>%LOCALAPPDATA%\Programs\Organizator</c>) se met a jour d'elle-meme ; un exe portable
/// ou de developpement dit seulement qu'une version existe.
/// </summary>
public sealed class AppUpdater : IDisposable
{
    private static readonly TimeSpan Every = TimeSpan.FromHours(6);
    private static readonly TimeSpan FirstDelay = TimeSpan.FromSeconds(20);

    private readonly string _dir;
    private readonly HostLog _log;
    private readonly Func<string> _serverUrl;
    private readonly HttpClient _http;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly CancellationTokenSource _stop = new();
    private readonly object _lock = new();

    private string _state = "idle";
    private string _latest = "";
    private string _error = "";
    private string _installer = "";
    private int _percent;
    private DateTimeOffset? _checkedAt;

    public AppUpdater(string dataDir, HostLog log, Func<string> serverUrl, bool enabled)
    {
        _dir = Path.Combine(dataDir, "updates");
        _log = log;
        _serverUrl = serverUrl;
        Current = ReleaseVersion.Current();
        Installed = enabled && IsInstalledCopy();
        _http = new HttpClient { Timeout = TimeSpan.FromMinutes(15) };
        _http.DefaultRequestHeaders.UserAgent.Add(new ProductInfoHeaderValue("Organizator", ReleaseVersion.IsValid(Current) ? Current : "0.0.0"));
    }

    /// <summary>Etat change (verification, telechargement, pret) : charge utile de <see cref="Status"/>.</summary>
    public event Action<JsonObject>? Progress;

    public string Current { get; }

    /// <summary>Vrai pour la copie de l'installateur : elle seule s'installe d'elle-meme.</summary>
    public bool Installed { get; }

    /// <summary>Organizator a relancer apres l'installation (« Installer maintenant »).</summary>
    public bool RelaunchWanted { get; set; }

    /// <summary>Une version plus recente est telechargee et verifiee : elle s'installera a la fermeture.</summary>
    public bool Ready
    {
        get
        {
            lock (_lock)
            {
                return _state == "ready" && File.Exists(_installer);
            }
        }
    }

    /// <summary>
    /// <c>{ current, latest, state, percent, error, installed, checkedAt }</c> ; state : <c>idle</c>, <c>checking</c>,
    /// <c>uptodate</c>, <c>downloading</c>, <c>ready</c>, <c>available</c> (copie non installee), <c>noserver</c>, <c>error</c>.
    /// </summary>
    public JsonObject Status()
    {
        lock (_lock)
        {
            return new JsonObject
            {
                ["current"] = Current,
                ["latest"] = _latest,
                ["state"] = _state,
                ["percent"] = _percent,
                ["error"] = _error,
                ["installed"] = Installed,
                ["checkedAt"] = _checkedAt?.ToString("o") ?? "",
            };
        }
    }

    /// <summary>Premiere verification apres 20 s (le demarrage d'abord), puis toutes les six heures.</summary>
    public void Start()
    {
        _ = Task.Run(async () =>
        {
            try
            {
                await Task.Delay(FirstDelay, _stop.Token).ConfigureAwait(false);
                while (!_stop.IsCancellationRequested)
                {
                    await CheckAsync().ConfigureAwait(false);
                    await Task.Delay(Every, _stop.Token).ConfigureAwait(false);
                }
            }
            catch (OperationCanceledException)
            {
                // Fermeture d'Organizator.
            }
        });
    }

    /// <summary>Demande la version du serveur et, si elle est plus recente, la telecharge. Jamais d'exception.</summary>
    public async Task<JsonObject> CheckAsync()
    {
        if (!await _gate.WaitAsync(0).ConfigureAwait(false))
        {
            return Status();
        }

        try
        {
            if (Ready)
            {
                return Status();
            }

            var server = (_serverUrl() ?? "").Trim().TrimEnd('/');
            if (server.Length == 0)
            {
                Set("noserver", "", "");
                return Status();
            }

            Set("checking", _latest, "");
            using var response = await _http.GetAsync(server + "/api/organizator", _stop.Token).ConfigureAwait(false);
            if (response.StatusCode == System.Net.HttpStatusCode.NotFound)
            {
                Set("uptodate", "", "");
                return Status();
            }

            response.EnsureSuccessStatusCode();
            var info = JsonNode.Parse(await response.Content.ReadAsStringAsync(_stop.Token).ConfigureAwait(false)) as JsonObject;
            var latest = info?["version"]?.GetValue<string>() ?? "";
            var sha = (info?["sha256"]?.GetValue<string>() ?? "").ToLowerInvariant();
            var path = info?["url"]?.GetValue<string>() ?? "/download/organizator";
            if (!ReleaseVersion.IsValid(latest) || sha.Length != 64)
            {
                throw new InvalidDataException("reponse du serveur illisible");
            }

            if (ReleaseVersion.Compare(latest, Current) <= 0)
            {
                // L'installateur de la mise a jour deja faite n'a plus d'usage.
                if (Directory.Exists(_dir))
                {
                    foreach (var old in Directory.EnumerateFiles(_dir))
                    {
                        TryDelete(old);
                    }
                }

                Set("uptodate", latest, "");
                return Status();
            }

            if (!Installed)
            {
                Set("available", latest, "");
                return Status();
            }

            await DownloadAsync(server + (path.StartsWith('/') ? path : "/" + path), latest, sha).ConfigureAwait(false);
            return Status();
        }
        catch (OperationCanceledException) when (_stop.IsCancellationRequested)
        {
            return Status();
        }
        catch (Exception ex)
        {
            _log.Warn("Mise a jour d'Organizator : " + ex.Message);
            Set("error", _latest, ex is HttpRequestException or TaskCanceledException ? "Serveur Révizator injoignable." : ex.Message);
            return Status();
        }
        finally
        {
            _gate.Release();
        }
    }

    private async Task DownloadAsync(string url, string version, string sha)
    {
        Directory.CreateDirectory(_dir);
        var target = Path.Combine(_dir, "Organizator-Setup-" + version + ".exe");

        // Deja telecharge (session precedente) et intact : rien a refaire.
        if (!File.Exists(target) || !HashMatches(target, sha))
        {
            Set("downloading", version, "");
            var part = target + ".part";
            using (var response = await _http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, _stop.Token).ConfigureAwait(false))
            {
                response.EnsureSuccessStatusCode();
                var total = response.Content.Headers.ContentLength ?? 0;
                await using var input = await response.Content.ReadAsStreamAsync(_stop.Token).ConfigureAwait(false);
                await using var output = File.Create(part);
                var buffer = new byte[81920];
                long done = 0;
                int read, shown = -1;
                while ((read = await input.ReadAsync(buffer, _stop.Token).ConfigureAwait(false)) > 0)
                {
                    await output.WriteAsync(buffer.AsMemory(0, read), _stop.Token).ConfigureAwait(false);
                    done += read;
                    var percent = total > 0 ? (int)(done * 100 / total) : 0;
                    if (percent / 5 != shown / 5)
                    {
                        shown = percent;
                        lock (_lock)
                        {
                            _percent = percent;
                        }

                        Progress?.Invoke(Status());
                    }
                }
            }

            if (!HashMatches(part, sha))
            {
                TryDelete(part);
                throw new InvalidDataException("installateur telecharge corrompu (empreinte SHA-256 differente)");
            }

            File.Move(part, target, overwrite: true);
        }

        foreach (var old in Directory.EnumerateFiles(_dir).Where(p => !string.Equals(p, target, StringComparison.OrdinalIgnoreCase)))
        {
            TryDelete(old);
        }

        lock (_lock)
        {
            _installer = target;
        }

        _log.Info($"Mise a jour d'Organizator {version} prete : installation a la fermeture");
        Set("ready", version, "");
    }

    /// <summary>
    /// A la fermeture : lance l'installateur en silence si une version est prete (relance d'Organizator a
    /// la fin si <see cref="RelaunchWanted"/>). L'installateur attend la fin de ce processus.
    /// </summary>
    public bool InstallOnExit()
    {
        string installer;
        lock (_lock)
        {
            if (_state != "ready" || !File.Exists(_installer))
            {
                return false;
            }

            installer = _installer;
        }

        try
        {
            var start = new ProcessStartInfo(installer)
            {
                UseShellExecute = false,
                WorkingDirectory = Path.GetDirectoryName(installer)!,
            };
            foreach (var arg in new[] { "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/NOCANCEL" })
            {
                start.ArgumentList.Add(arg);
            }

            if (RelaunchWanted)
            {
                start.ArgumentList.Add("/relaunch=1");
            }

            Process.Start(start);
            _log.Info($"Installation de la mise a jour {_latest}" + (RelaunchWanted ? ", puis relance" : ""));
            return true;
        }
        catch (Exception ex)
        {
            _log.Warn("Installation de la mise a jour impossible : " + ex.Message);
            return false;
        }
    }

    /// <summary>Copie installee : l'executable est dans <c>%LOCALAPPDATA%\Programs\Organizator</c>.</summary>
    private static bool IsInstalledCopy()
    {
        var exe = Environment.ProcessPath;
        if (string.IsNullOrEmpty(exe))
        {
            return false;
        }

        var installDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Organizator");
        return string.Equals(Path.GetDirectoryName(Path.GetFullPath(exe))?.TrimEnd('\\'), installDir.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase);
    }

    private static bool HashMatches(string path, string sha)
    {
        using var stream = File.OpenRead(path);
        return Convert.ToHexString(SHA256.HashData(stream)).Equals(sha, StringComparison.OrdinalIgnoreCase);
    }

    private void Set(string state, string latest, string error)
    {
        lock (_lock)
        {
            _state = state;
            _latest = latest;
            _error = error;
            if (state != "downloading")
            {
                _percent = 0;
            }

            if (state is not ("checking" or "downloading"))
            {
                _checkedAt = DateTimeOffset.Now;
            }
        }

        Progress?.Invoke(Status());
    }

    private void TryDelete(string path)
    {
        try
        {
            File.Delete(path);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            _log.Warn("Fichier de mise a jour non supprime : " + ex.Message);
        }
    }

    public void Dispose()
    {
        _stop.Cancel();
        _http.Dispose();
    }
}
