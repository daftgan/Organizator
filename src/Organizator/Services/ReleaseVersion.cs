using System.Reflection;

namespace Organizator.Services;

/// <summary>
/// Versions d'Organizator : <c>1.2.0</c>, ou <c>1.2.0-ci.7</c> pour une construction hors Release (voir
/// .github/workflows/organizator.yml). Une version sans suffixe passe devant la meme avec suffixe, comme
/// en SemVer. Partage avec le serveur Revizator, qui sert l'installateur de la derniere version.
/// </summary>
public static class ReleaseVersion
{
    /// <summary>Version de l'executable en cours : la version informative, sans le <c>+&lt;commit&gt;</c> ajoute par le SDK.</summary>
    public static string Current(Assembly? assembly = null)
    {
        assembly ??= Assembly.GetEntryAssembly() ?? typeof(ReleaseVersion).Assembly;
        var info = assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion;
        if (!string.IsNullOrWhiteSpace(info))
        {
            var plus = info.IndexOf('+');
            return (plus < 0 ? info : info[..plus]).Trim();
        }

        return assembly.GetName().Version?.ToString(3) ?? "0.0.0";
    }

    /// <summary>Vrai si <paramref name="value"/> se lit comme une version (<c>1.2.0</c>, <c>v1.2.0-beta.1</c>).</summary>
    public static bool IsValid(string? value) => TryParse(value, out _, out _);

    /// <summary>Negatif si <paramref name="a"/> precede <paramref name="b"/>, zero si egales, positif sinon ; une version illisible passe avant tout.</summary>
    public static int Compare(string? a, string? b)
    {
        var okA = TryParse(a, out var numA, out var preA);
        var okB = TryParse(b, out var numB, out var preB);
        if (!okA || !okB)
        {
            return okA.CompareTo(okB);
        }

        var byNumber = numA.CompareTo(numB);
        if (byNumber != 0)
        {
            return byNumber;
        }

        // Meme numero : la version sans suffixe (une Release) passe devant ses constructions intermediaires.
        if (preA.Length == 0 || preB.Length == 0)
        {
            return preA.Length == preB.Length ? 0 : (preA.Length == 0 ? 1 : -1);
        }

        var partsA = preA.Split('.');
        var partsB = preB.Split('.');
        for (var i = 0; i < Math.Min(partsA.Length, partsB.Length); i++)
        {
            var isNumA = int.TryParse(partsA[i], out var nA);
            var isNumB = int.TryParse(partsB[i], out var nB);
            var c = isNumA && isNumB ? nA.CompareTo(nB) : string.CompareOrdinal(partsA[i], partsB[i]);
            if (c != 0)
            {
                return c;
            }
        }

        return partsA.Length.CompareTo(partsB.Length);
    }

    private static bool TryParse(string? value, out Version number, out string prerelease)
    {
        number = new Version(0, 0, 0);
        prerelease = "";
        var text = (value ?? "").Trim();
        if (text.StartsWith('v') || text.StartsWith('V'))
        {
            text = text[1..];
        }

        var plus = text.IndexOf('+');
        if (plus >= 0)
        {
            text = text[..plus];
        }

        var dash = text.IndexOf('-');
        if (dash >= 0)
        {
            prerelease = text[(dash + 1)..];
            text = text[..dash];
            if (prerelease.Length == 0 || prerelease.Any(c => !(char.IsAsciiLetterOrDigit(c) || c is '.' or '-')))
            {
                return false;
            }
        }

        var parts = text.Split('.');
        if (parts.Length != 3 || !parts.All(p => p.Length is > 0 and <= 6 && p.All(char.IsAsciiDigit)))
        {
            return false;
        }

        number = new Version(int.Parse(parts[0]), int.Parse(parts[1]), int.Parse(parts[2]));
        return true;
    }
}
