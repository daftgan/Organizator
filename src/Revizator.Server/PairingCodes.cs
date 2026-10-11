using System.Security.Cryptography;

namespace Revizator.Server;

/// <summary>
/// Codes d'appairage : Organizator sur le PC, deja connecte, en demande un (<c>POST /api/pair</c>) et
/// l'affiche en QR code ; le telephone qui l'ouvre (<c>/pair?c=…</c>) ou le tape recoit une session du
/// meme compte, sans identifiant ni mot de passe. Un code fait 8 caracteres (alphabet sans 0/O ni 1/I/L,
/// ~39 bits), sert une seule fois et vit 10 minutes ; il n'est garde qu'en memoire (un redemarrage les
/// oublie tous). Un code faux compte comme un echec de connexion pour l'adresse (voir FailureLimiter).
/// </summary>
public sealed class PairingCodes
{
    public static readonly TimeSpan Lifetime = TimeSpan.FromMinutes(10);

    private const string Alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    private const int Length = 8;
    private const int MaxPerUser = 5;

    private readonly object _gate = new();
    private readonly Dictionary<string, (string User, DateTime Expires)> _codes = new(StringComparer.Ordinal);

    /// <summary>Un nouveau code pour <paramref name="user"/> (normalise : 8 caracteres, sans tiret).</summary>
    public string Create(string user)
    {
        lock (_gate)
        {
            Prune();
            // Au plus 5 codes vivants par compte : le plus ancien part (bouton presse plusieurs fois).
            var mine = _codes.Where(c => c.Value.User == user).OrderBy(c => c.Value.Expires).ToList();
            foreach (var old in mine.Take(Math.Max(0, mine.Count - (MaxPerUser - 1))))
            {
                _codes.Remove(old.Key);
            }

            string code;
            do
            {
                code = new string(RandomNumberGenerator.GetItems<char>(Alphabet, Length));
            }
            while (_codes.ContainsKey(code));

            _codes[code] = (user, DateTime.UtcNow + Lifetime);
            return code;
        }
    }

    /// <summary>Le compte du code, qui est aussitot retire ; null s'il est inconnu ou perime.</summary>
    public string? Consume(string? code)
    {
        var key = Normalize(code);
        if (key is null)
        {
            return null;
        }

        lock (_gate)
        {
            Prune();
            if (!_codes.Remove(key, out var entry))
            {
                return null;
            }

            return entry.User;
        }
    }

    /// <summary>Le code tel qu'on l'affiche : <c>K7QF-2MXP</c>.</summary>
    public static string Display(string code) => code.Length == Length ? code[..4] + "-" + code[4..] : code;

    /// <summary>Majuscules, sans espace ni tiret ; null si ce n'est pas un code possible.</summary>
    public static string? Normalize(string? code)
    {
        if (string.IsNullOrEmpty(code) || code.Length > 32)
        {
            return null;
        }

        var key = new string(code.Where(c => c is not ('-' or ' ')).Select(char.ToUpperInvariant).ToArray());
        return key.Length == Length && key.All(c => Alphabet.Contains(c)) ? key : null;
    }

    private void Prune()
    {
        var now = DateTime.UtcNow;
        foreach (var key in _codes.Where(c => c.Value.Expires <= now).Select(c => c.Key).ToList())
        {
            _codes.Remove(key);
        }
    }
}
