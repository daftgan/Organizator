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
/// connexion vient d'un proxy de confiance (<c>REVIZATOR_TRUSTED_PROXIES</c>, par defaut le reseau
/// prive), l'adresse de la connexion sinon. Une adresse IPv6 compte pour son /64 entier (un client en a
/// des milliards). Le menage des adresses oubliees se fait au plus toutes les 10 s, et la table est videe
/// si elle deborde : elle ne peut ni grossir sans fin ni couter un parcours complet a chaque echec.
/// </summary>
public sealed class FailureLimiter
{
    private const int MaxFailures = 10;
    private const int MaxAddresses = 20000;
    private static readonly TimeSpan Window = TimeSpan.FromMinutes(1);
    private static readonly TimeSpan PruneEvery = TimeSpan.FromSeconds(10);

    private readonly ConcurrentDictionary<string, Queue<DateTime>> _failures = new();
    private readonly IReadOnlyList<IPNetwork> _trusted;
    private long _nextPrune;

    public FailureLimiter(IReadOnlyList<IPNetwork> trustedProxies)
    {
        _trusted = trustedProxies;
    }

    public bool Blocked(string ip)
    {
        if (!_failures.TryGetValue(Key(ip), out var queue))
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
        Prune();
        var queue = _failures.GetOrAdd(Key(ip), _ => new Queue<DateTime>());
        lock (queue)
        {
            Trim(queue);
            queue.Enqueue(DateTime.UtcNow);
        }
    }

    /// <summary>Menage des adresses sans echec recent, au plus toutes les 10 s ; table videe si elle deborde.</summary>
    private void Prune()
    {
        var now = DateTime.UtcNow.Ticks;
        var next = Interlocked.Read(ref _nextPrune);
        if (now < next || Interlocked.CompareExchange(ref _nextPrune, now + PruneEvery.Ticks, next) != next)
        {
            return;
        }

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

        // Des milliers d'adresses en echec dans la minute : une attaque repartie, que cette limite ne
        // freine de toute facon pas (les jetons de 256 bits s'en chargent). On repart de zero.
        if (_failures.Count > MaxAddresses)
        {
            _failures.Clear();
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

    /// <summary>Cle de la table : l'adresse IPv4, ou le /64 d'une adresse IPv6.</summary>
    private static string Key(string ip)
    {
        if (IPAddress.TryParse(ip, out var address) && address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetworkV6)
        {
            var bytes = address.GetAddressBytes();
            Array.Clear(bytes, 8, 8);
            return new IPAddress(bytes) + "/64";
        }

        return ip;
    }

    /// <summary>Vrai si la connexion vient d'un proxy de confiance : ses en-tetes X-Forwarded-* font foi.</summary>
    public bool FromTrustedProxy(HttpContext context)
    {
        var remote = Remote(context);
        return remote is not null && _trusted.Any(network => network.Contains(remote));
    }

    /// <summary>Adresse du client : voir la description de la classe.</summary>
    public string ClientIp(HttpContext context)
    {
        var remote = Remote(context);
        if (remote is not null && _trusted.Any(network => network.Contains(remote)))
        {
            // Derniere entree : celle qu'ajoute le proxy (les precedentes viennent du client, forgeables).
            var forwarded = context.Request.Headers["X-Forwarded-For"].ToString();
            var last = forwarded.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).LastOrDefault();
            if (last is not null && IPAddress.TryParse(last, out var parsed))
            {
                return (parsed.IsIPv4MappedToIPv6 ? parsed.MapToIPv4() : parsed).ToString();
            }
        }

        return remote?.ToString() ?? "?";
    }

    private static IPAddress? Remote(HttpContext context)
    {
        var remote = context.Connection.RemoteIpAddress;
        return remote is not null && remote.IsIPv4MappedToIPv6 ? remote.MapToIPv4() : remote;
    }
}
