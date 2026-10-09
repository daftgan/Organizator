using System.Collections.Concurrent;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Revizator.Server;

/// <summary>Un appareil appaire : son nom, l'empreinte SHA-256 (hex) de son jeton, sa date de creation.</summary>
public sealed record DeviceToken(string Device, string Hash, string Created);

/// <summary>
/// Jetons d'appairage, dans <c>tokens.json</c> du dossier de donnees. Un jeton = 32 octets aleatoires en
/// base64url ; seule son empreinte est gardee. Le fichier est relu des qu'il change : un jeton cree ou
/// revoque en ligne de commande vaut aussitot pour le serveur qui tourne.
/// </summary>
public sealed class TokenStore
{
    private static readonly JsonSerializerOptions Json = new() { WriteIndented = true };

    private readonly string _path;
    private readonly object _gate = new();
    private IReadOnlyList<DeviceToken> _tokens = [];
    private DateTime _stamp = DateTime.MinValue;
    private long _size = -1;

    public TokenStore(string dataDir)
    {
        _path = Path.Combine(dataDir, "tokens.json");
    }

    public string FilePath => _path;

    public IReadOnlyList<DeviceToken> List()
    {
        lock (_gate)
        {
            Refresh();
            return _tokens;
        }
    }

    /// <summary>Cree le jeton d'un appareil (remplace celui du meme nom) ; rend le jeton en clair, jamais garde.</summary>
    public string Create(string device)
    {
        var name = CleanDevice(device);
        var token = Base64Url(RandomNumberGenerator.GetBytes(32));
        lock (_gate)
        {
            Refresh();
            var kept = _tokens.Where(t => !string.Equals(t.Device, name, StringComparison.OrdinalIgnoreCase)).ToList();
            kept.Add(new DeviceToken(name, HashOf(token), DateTimeOffset.UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ")));
            Write(kept);
        }

        return token;
    }

    /// <summary>Revoque le jeton d'un appareil ; faux s'il n'y en avait pas.</summary>
    public bool Revoke(string device)
    {
        var name = (device ?? "").Trim();
        lock (_gate)
        {
            Refresh();
            var kept = _tokens.Where(t => !string.Equals(t.Device, name, StringComparison.OrdinalIgnoreCase)).ToList();
            if (kept.Count == _tokens.Count)
            {
                return false;
            }

            Write(kept);
            return true;
        }
    }

    /// <summary>L'appareil dont c'est le jeton, sinon null. Toutes les empreintes sont comparees, a temps constant.</summary>
    public string? Validate(string? token)
    {
        if (string.IsNullOrEmpty(token) || token.Length > 200)
        {
            return null;
        }

        var hash = Convert.FromHexString(HashOf(token));
        string? found = null;
        foreach (var entry in List())
        {
            byte[] stored;
            try
            {
                stored = Convert.FromHexString(entry.Hash);
            }
            catch (FormatException)
            {
                continue;
            }

            if (CryptographicOperations.FixedTimeEquals(hash, stored))
            {
                found ??= entry.Device;
            }
        }

        return found;
    }

    public static string HashOf(string token)
        => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token))).ToLowerInvariant();

    private static string Base64Url(byte[] bytes)
        => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private static string CleanDevice(string? device)
    {
        var name = new string((device ?? "").Trim().Where(c => !char.IsControl(c)).ToArray());
        if (name.Length == 0 || name.Length > 60)
        {
            throw new InvalidOperationException("Nom d'appareil attendu (1 a 60 caracteres), par exemple « telephone » ou « pc ».");
        }

        return name;
    }

    /// <summary>Relit le fichier s'il a change (sous <see cref="_gate"/>).</summary>
    private void Refresh()
    {
        var info = new FileInfo(_path);
        if (!info.Exists)
        {
            _tokens = [];
            _stamp = DateTime.MinValue;
            _size = -1;
            return;
        }

        if (info.LastWriteTimeUtc == _stamp && info.Length == _size)
        {
            return;
        }

        var list = new List<DeviceToken>();
        try
        {
            if (JsonNode.Parse(File.ReadAllText(_path))?["tokens"] is JsonArray array)
            {
                foreach (var item in array.OfType<JsonObject>())
                {
                    var device = item["device"]?.GetValue<string>() ?? "";
                    var hash = item["hash"]?.GetValue<string>() ?? "";
                    var created = item["created"]?.GetValue<string>() ?? "";
                    if (device.Length > 0 && hash.Length == 64)
                    {
                        list.Add(new DeviceToken(device, hash.ToLowerInvariant(), created));
                    }
                }
            }
        }
        catch (Exception ex) when (ex is JsonException or IOException or InvalidOperationException)
        {
            // Fichier illisible : aucun appareil n'est reconnu plutot que n'importe lequel.
            Console.Error.WriteLine("tokens.json illisible : " + ex.Message);
        }

        _tokens = list;
        _stamp = info.LastWriteTimeUtc;
        _size = info.Length;
    }

    private void Write(List<DeviceToken> tokens)
    {
        var array = new JsonArray();
        foreach (var t in tokens)
        {
            array.Add(new JsonObject { ["device"] = t.Device, ["hash"] = t.Hash, ["created"] = t.Created });
        }

        Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
        var tmp = _path + ".tmp";
        File.WriteAllText(tmp, new JsonObject { ["tokens"] = array }.ToJsonString(Json));
        if (!OperatingSystem.IsWindows())
        {
            File.SetUnixFileMode(tmp, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        }

        File.Move(tmp, _path, overwrite: true);
        _stamp = DateTime.MinValue;
        Refresh();
    }
}

/// <summary>
/// Limite des essais de jeton : 10 echecs par minute et par adresse au plus, au-dela 429. L'adresse est
/// celle du client vu par le reverse proxy (NPM) : derniere entree de <c>X-Forwarded-For</c> quand la
/// connexion vient d'une adresse privee (le proxy), l'adresse de la connexion sinon.
/// </summary>
public sealed class FailureLimiter
{
    private const int MaxFailures = 10;
    private static readonly TimeSpan Window = TimeSpan.FromMinutes(1);

    private readonly ConcurrentDictionary<string, Queue<DateTime>> _failures = new();

    public bool Blocked(string ip)
    {
        if (!_failures.TryGetValue(ip, out var queue))
        {
            return false;
        }

        lock (queue)
        {
            Trim(queue);
            return queue.Count >= MaxFailures;
        }
    }

    public void Fail(string ip)
    {
        var queue = _failures.GetOrAdd(ip, _ => new Queue<DateTime>());
        lock (queue)
        {
            Trim(queue);
            queue.Enqueue(DateTime.UtcNow);
        }

        // Menage des adresses oubliees, de temps en temps.
        if (_failures.Count > 1000)
        {
            foreach (var pair in _failures)
            {
                lock (pair.Value)
                {
                    Trim(pair.Value);
                    if (pair.Value.Count == 0)
                    {
                        _failures.TryRemove(pair.Key, out _);
                    }
                }
            }
        }
    }

    private static void Trim(Queue<DateTime> queue)
    {
        var limit = DateTime.UtcNow - Window;
        while (queue.Count > 0 && queue.Peek() < limit)
        {
            queue.Dequeue();
        }
    }

    /// <summary>Adresse du client : voir la description de la classe.</summary>
    public static string ClientIp(HttpContext context)
    {
        var remote = context.Connection.RemoteIpAddress;
        if (remote is not null && remote.IsIPv4MappedToIPv6)
        {
            remote = remote.MapToIPv4();
        }

        if (remote is null || IsPrivate(remote))
        {
            var forwarded = context.Request.Headers["X-Forwarded-For"].ToString();
            var last = forwarded.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).LastOrDefault();
            if (last is not null && IPAddress.TryParse(last, out var parsed))
            {
                return parsed.ToString();
            }
        }

        return remote?.ToString() ?? "?";
    }

    private static bool IsPrivate(IPAddress address)
    {
        if (IPAddress.IsLoopback(address))
        {
            return true;
        }

        if (address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetworkV6)
        {
            return address.IsIPv6LinkLocal || address.IsIPv6SiteLocal || address.IsIPv6UniqueLocal;
        }

        var b = address.GetAddressBytes();
        return b[0] == 10
            || (b[0] == 172 && b[1] >= 16 && b[1] <= 31)
            || (b[0] == 192 && b[1] == 168)
            || (b[0] == 169 && b[1] == 254);
    }
}
