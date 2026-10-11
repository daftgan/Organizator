using System.Collections.Concurrent;
using Organizator.Services;

namespace Revizator.Server;

/// <summary>
/// L'espace de Revizator d'un compte : son <c>learning.json</c>, son dossier <c>learning/</c> (cours, series,
/// bilans, enregistrements, menu RSS), son agent de generation et son compteur d'ecritures (§ 6). Les
/// services lourds (voix, reconnaissance, Whisper) restent communs a tous les comptes.
/// </summary>
public sealed class UserSpace
{
    public required string Login { get; init; }

    /// <summary>Dossier <c>users/&lt;compte&gt;/</c> : meme disposition que le dossier de donnees d'avant les comptes.</summary>
    public required string Dir { get; init; }

    public required LearningStore Learning { get; init; }
    public required NewsMenu News { get; init; }
    public required LearningAgent Agent { get; init; }

    /// <summary>Lecture (avec son rev) et ecriture conditionnelle de <c>learning.json</c>, une a la fois.</summary>
    public SemaphoreSlim Lock { get; } = new(1, 1);

    // Compteur des ecritures de learning.json (learnChanged, § 6). Il part de l'heure du demarrage (ms) :
    // une page ouverte avant un redemarrage ne retrouve jamais par hasard son ancien numero.
    public long Rev = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
}

/// <summary>
/// Les espaces des comptes, sous <c>users/&lt;compte&gt;/</c> du dossier de donnees, crees a la premiere
/// connexion. Les donnees d'avant les comptes separes (<c>learning.json</c> et <c>learning/</c> a la racine)
/// reviennent au premier compte cree (le proprietaire du serveur) : elles sont deplacees dans son espace la
/// premiere fois qu'il l'ouvre, s'il est encore vide.
/// </summary>
public sealed class UserSpaces
{
    public const string Folder = "users";

    private readonly string _dataDir;
    private readonly Func<IReadOnlyList<UserAccount>> _accounts;
    private readonly Func<string, string, UserSpace> _create;
    private readonly HostLog _log;
    private readonly ConcurrentDictionary<string, UserSpace> _spaces = new(StringComparer.Ordinal);
    private readonly object _gate = new();

    public UserSpaces(string dataDir, Func<IReadOnlyList<UserAccount>> accounts, Func<string, string, UserSpace> create, HostLog log)
    {
        _dataDir = dataDir;
        _accounts = accounts;
        _create = create;
        _log = log;
    }

    /// <summary>Dossier de l'espace d'un compte (qu'il existe ou non).</summary>
    public static string DirOf(string dataDir, string login)
        => Path.Combine(dataDir, Folder, UserStore.CleanLogin(login));

    /// <summary>Le premier compte cree : celui a qui reviennent les donnees d'avant les comptes separes.</summary>
    public static string? Owner(IReadOnlyList<UserAccount> accounts)
        => accounts.OrderBy(a => a.Created, StringComparer.Ordinal).ThenBy(a => a.Login, StringComparer.Ordinal).FirstOrDefault()?.Login;

    /// <summary>L'espace d'un compte, cree (et au besoin migre) a la premiere demande.</summary>
    public UserSpace Get(string login)
    {
        var name = UserStore.CleanLogin(login);
        if (_spaces.TryGetValue(name, out var space))
        {
            return space;
        }

        lock (_gate)
        {
            if (_spaces.TryGetValue(name, out space))
            {
                return space;
            }

            var dir = DirOf(_dataDir, name);
            Directory.CreateDirectory(dir);
            if (Owner(_accounts()) == name)
            {
                AdoptLegacy(dir, name);
            }

            space = _create(name, dir);
            _spaces[name] = space;
            return space;
        }
    }

    /// <summary>Les espaces deja ouverts (pour arreter leurs travaux).</summary>
    public IEnumerable<UserSpace> Open => _spaces.Values;

    /// <summary>
    /// Deplace <c>learning.json</c> (et son <c>.bak</c>) et <c>learning/</c> de la racine dans l'espace du
    /// proprietaire, s'il n'a pas encore de <c>learning.json</c> a lui. Un deplacement, jamais une copie : il
    /// n'y a toujours qu'une source de verite.
    /// </summary>
    private void AdoptLegacy(string dir, string login)
    {
        var state = Path.Combine(_dataDir, "learning.json");
        var folder = Path.Combine(_dataDir, "learning");
        if (File.Exists(Path.Combine(dir, "learning.json")) || (!File.Exists(state) && !Directory.Exists(folder)))
        {
            return;
        }

        try
        {
            foreach (var name in new[] { "learning.json", "learning.json.bak" })
            {
                var from = Path.Combine(_dataDir, name);
                if (File.Exists(from))
                {
                    File.Move(from, Path.Combine(dir, name), overwrite: true);
                }
            }

            var target = Path.Combine(dir, "learning");
            if (Directory.Exists(folder))
            {
                // Un dossier vide a pu etre cree dans l'espace : il cede la place.
                if (Directory.Exists(target) && !Directory.EnumerateFileSystemEntries(target, "*", SearchOption.AllDirectories).Any(File.Exists))
                {
                    Directory.Delete(target, recursive: true);
                }

                if (!Directory.Exists(target))
                {
                    Directory.Move(folder, target);
                }
            }

            _log.Info($"Revizator : donnees d'avant les comptes separes rattachees a « {login} » ({dir})");
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            _log.Warn($"Revizator : donnees d'avant les comptes non rattachees a « {login} » : {ex.Message}");
        }
    }
}
