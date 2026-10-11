using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Revizator.Server;

/// <summary>
/// Un compte : identifiant, mot de passe hache (<c>pbkdf2-sha256$iterations$sel$empreinte</c>), dates, et s'il
/// administre le serveur (voir <see cref="UserStore.IsAdmin"/>).
/// </summary>
public sealed record UserAccount(string Login, string Hash, string Created, string Changed, bool Admin = false);

/// <summary>
/// Comptes du serveur, dans <c>users.json</c> du dossier de donnees (fichier en 0600). Les mots de passe
/// sont haches par PBKDF2-SHA256 (600 000 iterations, sel de 16 octets) ; la verification d'un compte
/// inconnu coute autant que celle d'un vrai (rien ne dit qu'un identifiant existe). Deux verifications
/// au plus en meme temps : une rafale d'essais ne monopolise pas le processeur. Le fichier est relu des
/// qu'il change (un compte cree en ligne de commande vaut aussitot pour le serveur qui tourne).
/// </summary>
public sealed class UserStore
{
    public const int Iterations = 600_000;
    /// <summary>Aucune regle de longueur : le mot de passe ne doit qu'etre non vide (200 caracteres au plus).</summary>
    public const int MinPassword = 1;

    private static readonly JsonSerializerOptions Json = new() { WriteIndented = true };
    private static readonly SemaphoreSlim Hashing = new(2, 2);

    private readonly string _path;
    private readonly object _gate = new();
    private readonly string _dummy = HashPassword(Convert.ToBase64String(RandomNumberGenerator.GetBytes(18)));
    private IReadOnlyList<UserAccount> _users = [];
    private DateTime _stamp = DateTime.MinValue;
    private long _size = -1;

    public UserStore(string dataDir)
    {
        _path = Path.Combine(dataDir, "users.json");
    }

    public IReadOnlyList<UserAccount> List()
    {
        lock (_gate)
        {
            Refresh();
            return _users;
        }
    }

    /// <summary>Identifiant normalise (minuscules), ou exception : 1 a 40 caracteres, lettres, chiffres, <c>. _ -</c>.</summary>
    public static string CleanLogin(string? login)
    {
        var value = (login ?? "").Trim().ToLowerInvariant();
        if (value.Length is 0 or > 40 || value.Any(c => !(char.IsAsciiLetterOrDigit(c) || c is '.' or '_' or '-')))
        {
            throw new InvalidOperationException("Identifiant attendu : 1 a 40 caracteres, lettres, chiffres, point, tiret ou souligne.");
        }

        return value;
    }

    /// <summary>Cree le compte ou change son mot de passe ; vrai si le compte existait.</summary>
    public bool Set(string login, string password)
    {
        var name = CleanLogin(login);
        if ((password ?? "").Length < MinPassword || password!.Length > 200)
        {
            throw new InvalidOperationException("Mot de passe attendu : non vide, 200 caracteres au plus.");
        }

        var now = DateTimeOffset.UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ");
        lock (_gate)
        {
            Refresh();
            var old = _users.FirstOrDefault(u => u.Login == name);
            var kept = _users.Where(u => u.Login != name).ToList();
            kept.Add(new UserAccount(name, HashPassword(password), old?.Created ?? now, now, old?.Admin ?? false));
            Write(kept);
            return old is not null;
        }
    }

    /// <summary>Donne ou retire le droit d'administrer ; faux si le compte n'existe pas.</summary>
    public bool SetAdmin(string login, bool admin)
    {
        var name = (login ?? "").Trim().ToLowerInvariant();
        lock (_gate)
        {
            Refresh();
            var old = _users.FirstOrDefault(u => u.Login == name);
            if (old is null)
            {
                return false;
            }

            // Retirer le dernier administrateur designe rendrait la main au premier compte : c'est voulu,
            // le serveur n'est jamais sans administrateur.
            Write(_users.Select(u => u.Login == name ? u with { Admin = admin } : u).ToList());
            return true;
        }
    }

    /// <summary>
    /// Vrai si le compte administre le serveur : marque comme tel (<c>admin: true</c>), ou, tant qu'aucun ne
    /// l'est, le premier compte cree (le proprietaire du serveur).
    /// </summary>
    public bool IsAdmin(string? login) => Admins(List()).Contains(login ?? "");

    /// <summary>Les administrateurs effectifs (voir <see cref="IsAdmin"/>).</summary>
    public static IReadOnlySet<string> Admins(IReadOnlyList<UserAccount> accounts)
    {
        var flagged = accounts.Where(a => a.Admin).Select(a => a.Login).ToHashSet(StringComparer.Ordinal);
        if (flagged.Count == 0 && UserSpaces.Owner(accounts) is { } owner)
        {
            flagged.Add(owner);
        }

        return flagged;
    }

    /// <summary>Supprime un compte ; faux s'il n'existait pas.</summary>
    public bool Remove(string login)
    {
        var name = (login ?? "").Trim().ToLowerInvariant();
        lock (_gate)
        {
            Refresh();
            var kept = _users.Where(u => u.Login != name).ToList();
            if (kept.Count == _users.Count)
            {
                return false;
            }

            Write(kept);
            return true;
        }
    }

    /// <summary>L'identifiant normalise si le mot de passe est le bon, sinon null (meme cout dans les deux cas).</summary>
    public async Task<string?> VerifyAsync(string? login, string? password)
    {
        var name = (login ?? "").Trim().ToLowerInvariant();
        var account = name.Length is > 0 and <= 40 ? List().FirstOrDefault(u => u.Login == name) : null;
        var secret = (password ?? "").Length <= 200 ? password ?? "" : "";
        await Hashing.WaitAsync().ConfigureAwait(false);
        try
        {
            var ok = await Task.Run(() => Check(account?.Hash ?? _dummy, secret)).ConfigureAwait(false);
            return ok && account is not null && secret.Length > 0 ? account.Login : null;
        }
        finally
        {
            Hashing.Release();
        }
    }

    public static string HashPassword(string password)
    {
        var salt = RandomNumberGenerator.GetBytes(16);
        var hash = Rfc2898DeriveBytes.Pbkdf2(Encoding.UTF8.GetBytes(password), salt, Iterations, HashAlgorithmName.SHA256, 32);
        return $"pbkdf2-sha256${Iterations}${Convert.ToBase64String(salt)}${Convert.ToBase64String(hash)}";
    }

    private static bool Check(string stored, string password)
    {
        var parts = stored.Split('$');
        if (parts.Length != 4 || parts[0] != "pbkdf2-sha256" || !int.TryParse(parts[1], out var iterations)
            || iterations is < 100_000 or > 10_000_000)
        {
            return false;
        }

        try
        {
            var salt = Convert.FromBase64String(parts[2]);
            var expected = Convert.FromBase64String(parts[3]);
            var actual = Rfc2898DeriveBytes.Pbkdf2(Encoding.UTF8.GetBytes(password), salt, iterations, HashAlgorithmName.SHA256, expected.Length);
            return CryptographicOperations.FixedTimeEquals(actual, expected);
        }
        catch (FormatException)
        {
            return false;
        }
    }

    /// <summary>Relit le fichier s'il a change (sous <see cref="_gate"/>).</summary>
    private void Refresh()
    {
        var info = new FileInfo(_path);
        if (!info.Exists)
        {
            _users = [];
            _stamp = DateTime.MinValue;
            _size = -1;
            return;
        }

        if (info.LastWriteTimeUtc == _stamp && info.Length == _size)
        {
            return;
        }

        var list = new List<UserAccount>();
        try
        {
            if (JsonNode.Parse(File.ReadAllText(_path))?["users"] is JsonArray array)
            {
                foreach (var item in array.OfType<JsonObject>())
                {
                    var login = item["login"]?.GetValue<string>() ?? "";
                    var hash = item["hash"]?.GetValue<string>() ?? "";
                    if (login.Length > 0 && hash.StartsWith("pbkdf2-sha256$", StringComparison.Ordinal))
                    {
                        list.Add(new UserAccount(login, hash, item["created"]?.GetValue<string>() ?? "", item["changed"]?.GetValue<string>() ?? "",
                            item["admin"] is JsonValue admin && admin.TryGetValue<bool>(out var isAdmin) && isAdmin));
                    }
                }
            }
        }
        catch (Exception ex) when (ex is JsonException or IOException or InvalidOperationException)
        {
            // Fichier illisible : aucun compte n'est reconnu plutot que n'importe lequel.
            Console.Error.WriteLine("users.json illisible : " + ex.Message);
        }

        _users = list;
        _stamp = info.LastWriteTimeUtc;
        _size = info.Length;
    }

    private void Write(List<UserAccount> users)
    {
        var array = new JsonArray();
        foreach (var u in users)
        {
            var entry = new JsonObject { ["login"] = u.Login, ["hash"] = u.Hash, ["created"] = u.Created, ["changed"] = u.Changed };
            if (u.Admin)
            {
                entry["admin"] = true;
            }

            array.Add(entry);
        }

        Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
        var tmp = _path + ".tmp";
        File.WriteAllText(tmp, new JsonObject { ["users"] = array }.ToJsonString(Json));
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
/// Verrou par compte, en plus de la limite par adresse : apres 5 echecs de suite sur un identifiant, il est
/// bloque 1 minute, puis 2, 4… jusqu'a 15 minutes ; une connexion reussie remet le compteur a zero. Un
/// attaquant qui change d'adresse a chaque essai ne devine donc pas plus vite. Table bornee (identifiants
/// inconnus compris).
/// </summary>
public sealed class LoginLockout
{
    private readonly object _gate = new();
    private readonly Dictionary<string, (int Failures, DateTime Until)> _state = new(StringComparer.Ordinal);

    /// <summary>Temps restant avant de pouvoir reessayer cet identifiant, ou zero.</summary>
    public TimeSpan Locked(string login)
    {
        lock (_gate)
        {
            return _state.TryGetValue(Key(login), out var s) && s.Until > DateTime.UtcNow ? s.Until - DateTime.UtcNow : TimeSpan.Zero;
        }
    }

    public void Fail(string login)
    {
        lock (_gate)
        {
            if (_state.Count > 10_000)
            {
                _state.Clear();
            }

            var key = Key(login);
            _state.TryGetValue(key, out var s);
            var failures = s.Failures + 1;
            var until = failures >= 5
                ? DateTime.UtcNow + TimeSpan.FromMinutes(Math.Min(15, Math.Pow(2, failures - 5)))
                : s.Until;
            _state[key] = (failures, until);
        }
    }

    public void Succeed(string login)
    {
        lock (_gate)
        {
            _state.Remove(Key(login));
        }
    }

    private static string Key(string login) => (login ?? "").Trim().ToLowerInvariant() is { Length: <= 40 } k ? k : "";
}
