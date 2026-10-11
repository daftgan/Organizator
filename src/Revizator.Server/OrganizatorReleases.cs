using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using Organizator.Services;

namespace Revizator.Server;

/// <summary>Installateur d'Organizator servi par le serveur : version, nom de fichier, empreinte SHA-256 (hex), taille.</summary>
public sealed record OrganizatorRelease(string Version, string File, string Sha256, long Size, string Published);

/// <summary>
/// L'installateur Windows d'Organizator, a telecharger depuis la page de connexion et la page Revizator, et
/// que chaque Organizator verifie pour se mettre a jour (<c>GET /api/organizator</c>). Toutes les heures, le
/// serveur lit la derniere Release GitHub du depot (<c>REVIZATOR_RELEASES_REPO</c>, jeton
/// <c>REVIZATOR_GITHUB_TOKEN</c> pour un depot prive), telecharge son <c>Organizator-Setup-*.exe</c> dans
/// <c>releases/</c> du dossier de donnees et ne garde que le dernier. Sans GitHub, un installateur depose a
/// la main dans <c>releases/</c> est servi tel quel (le plus recent).
/// </summary>
public sealed class OrganizatorReleases : IDisposable
{
    private const string Prefix = "Organizator-Setup-";
    private static readonly TimeSpan Every = TimeSpan.FromHours(1);
    private static readonly JsonSerializerOptions Json = new() { WriteIndented = true };

    private readonly string _dir;
    private readonly string _repo;
    private readonly string _token;
    private readonly HostLog _log;
    private readonly HttpClient _http;
    private readonly CancellationTokenSource _stop = new();
    private volatile OrganizatorRelease? _current;
    private string _lastError = "";

    public OrganizatorReleases(string dataDir, string repo, string token, HostLog log)
    {
        _dir = Path.Combine(dataDir, "releases");
        _repo = repo;
        _token = token;
        _log = log;
        _http = new HttpClient { Timeout = TimeSpan.FromMinutes(10) };
        _http.DefaultRequestHeaders.UserAgent.Add(new ProductInfoHeaderValue("revizator-server", ServerConfig.Version));
    }

    /// <summary>La version servie, ou null s'il n'y en a aucune.</summary>
    public OrganizatorRelease? Current => _current;

    public string FilePath(OrganizatorRelease release) => Path.Combine(_dir, release.File);

    /// <summary>Premiere lecture tout de suite, puis toutes les heures, jusqu'a l'arret du serveur.</summary>
    public void Start()
    {
        _ = Task.Run(async () =>
        {
            while (!_stop.IsCancellationRequested)
            {
                try
                {
                    await RefreshAsync(_stop.Token).ConfigureAwait(false);
                }
                catch (OperationCanceledException) when (_stop.IsCancellationRequested)
                {
                    return;
                }
                catch (Exception ex)
                {
                    Report("Mise a jour de l'installateur d'Organizator impossible : " + ex.Message);
                }

                try
                {
                    await Task.Delay(Every, _stop.Token).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    return;
                }
            }
        });
    }

    private async Task RefreshAsync(CancellationToken cancel)
    {
        Directory.CreateDirectory(_dir);
        if (_repo.Length > 0)
        {
            await FromGitHubAsync(cancel).ConfigureAwait(false);
        }

        // Sans GitHub, ou GitHub injoignable : le plus recent des installateurs du dossier.
        if (_current is null || !File.Exists(FilePath(_current)))
        {
            _current = Local();
        }
    }

    private async Task FromGitHubAsync(CancellationToken cancel)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, $"https://api.github.com/repos/{_repo}/releases/latest");
        Authorize(request, "application/vnd.github+json");
        using var response = await _http.SendAsync(request, cancel).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode)
        {
            Report(response.StatusCode == System.Net.HttpStatusCode.NotFound
                ? $"Aucune Release lisible sur {_repo} (depot prive sans REVIZATOR_GITHUB_TOKEN, ou aucune Release publiee)."
                : $"GitHub a repondu {(int)response.StatusCode} pour la derniere Release de {_repo}.");
            return;
        }

        var release = JsonNode.Parse(await response.Content.ReadAsStringAsync(cancel).ConfigureAwait(false));
        var version = (release?["tag_name"]?.GetValue<string>() ?? "").TrimStart('v', 'V');
        var asset = (release?["assets"] as JsonArray)?.OfType<JsonObject>().FirstOrDefault(a =>
        {
            var name = a["name"]?.GetValue<string>() ?? "";
            return name.StartsWith(Prefix, StringComparison.Ordinal) && name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase);
        });
        if (!ReleaseVersion.IsValid(version) || asset is null)
        {
            Report($"La derniere Release de {_repo} n'a pas d'installateur {Prefix}<version>.exe.");
            return;
        }

        var file = Prefix + version + ".exe";
        var current = _current ?? Local();
        if (current is not null && current.File == file && File.Exists(FilePath(current)))
        {
            _current = current;
            return;
        }

        // Telechargement par l'API (depot prive) : redirection vers le stockage de GitHub, sans le jeton.
        var part = Path.Combine(_dir, "download.part");
        using (var download = new HttpRequestMessage(HttpMethod.Get, asset["url"]!.GetValue<string>()))
        {
            Authorize(download, "application/octet-stream");
            using var body = await _http.SendAsync(download, HttpCompletionOption.ResponseHeadersRead, cancel).ConfigureAwait(false);
            body.EnsureSuccessStatusCode();
            await using var output = File.Create(part);
            await body.Content.CopyToAsync(output, cancel).ConfigureAwait(false);
        }

        File.Move(part, Path.Combine(_dir, file), overwrite: true);
        var published = release?["published_at"]?.GetValue<string>() ?? "";
        var fresh = Describe(file, version, published);
        File.WriteAllText(Path.Combine(_dir, "latest.json"), JsonSerializer.Serialize(fresh, Json));
        _current = fresh;
        _lastError = "";
        _log.Info($"Installateur d'Organizator {version} disponible ({fresh.Size / 1_048_576} Mo)");

        // Seul le dernier installateur reste.
        foreach (var old in Directory.EnumerateFiles(_dir, Prefix + "*.exe").Where(p => Path.GetFileName(p) != file))
        {
            TryDelete(old);
        }
    }

    /// <summary>Le plus recent des installateurs deposes dans <c>releases/</c> ; l'empreinte de <c>latest.json</c> est reprise si le fichier n'a pas change.</summary>
    private OrganizatorRelease? Local()
    {
        if (!Directory.Exists(_dir))
        {
            return null;
        }

        var best = Directory.EnumerateFiles(_dir, Prefix + "*.exe")
            .Select(p => (Path: p, Version: Path.GetFileNameWithoutExtension(p)[Prefix.Length..]))
            .Where(f => ReleaseVersion.IsValid(f.Version))
            .OrderByDescending(f => f.Version, Comparer<string>.Create(ReleaseVersion.Compare))
            .FirstOrDefault();
        if (best.Path is null)
        {
            return null;
        }

        var file = Path.GetFileName(best.Path);
        try
        {
            var saved = JsonSerializer.Deserialize<OrganizatorRelease>(File.ReadAllText(Path.Combine(_dir, "latest.json")));
            if (saved is not null && saved.File == file && saved.Size == new FileInfo(best.Path).Length)
            {
                return saved;
            }
        }
        catch (Exception ex) when (ex is IOException or JsonException or UnauthorizedAccessException)
        {
            // Pas de latest.json lisible : l'empreinte est recalculee.
        }

        var described = Describe(file, best.Version, "");
        TryWrite(Path.Combine(_dir, "latest.json"), JsonSerializer.Serialize(described, Json));
        return described;
    }

    private OrganizatorRelease Describe(string file, string version, string published)
    {
        var path = Path.Combine(_dir, file);
        using var stream = File.OpenRead(path);
        var hash = Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
        return new OrganizatorRelease(version, file, hash, stream.Length, published);
    }

    private void Authorize(HttpRequestMessage request, string accept)
    {
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue(accept));
        if (_token.Length > 0)
        {
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _token);
        }
    }

    /// <summary>Un meme echec n'est journalise qu'une fois (la lecture revient toutes les heures).</summary>
    private void Report(string message)
    {
        if (message != _lastError)
        {
            _lastError = message;
            _log.Warn(message);
        }
    }

    private void TryDelete(string path)
    {
        try
        {
            File.Delete(path);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            _log.Warn("Ancien installateur non supprime : " + ex.Message);
        }
    }

    private static void TryWrite(string path, string text)
    {
        try
        {
            File.WriteAllText(path, text);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // Dossier en lecture seule : l'empreinte sera recalculee au prochain demarrage.
        }
    }

    public void Dispose()
    {
        _stop.Cancel();
        _http.Dispose();
        _stop.Dispose();
    }
}
