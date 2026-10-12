using System.Globalization;
using System.IO;
using System.Reflection;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Organizator.Services;

/// <summary>
/// Profil lexical d'un texte anglais : la part de ses mots a chaque niveau CECRL, d'apres la liste de
/// vocabulaire CEFR-J 1.5 (Tono, TUFS) et l'Octanove Vocabulary Profile C1/C2 (CC BY-SA 4.0), publiees par
/// Open Language Profiles (https://github.com/openlanguageprofiles/olp-en-cefrj), libres d'usage avec citation.
/// <para>
/// Sert a mesurer, plutot qu'a croire, le niveau des textes que Claude ecrit pour un niveau donne : un
/// modele de langue ecrit volontiers plus simple (ou plus riche) que le niveau annonce. <c>Level95</c> est
/// le plus bas niveau dont le vocabulaire couvre 95 % des mots du texte (seuil de comprehension autonome,
/// Nation 2006) ; les noms propres et les nombres sont ecartes, un mot absent de la liste compte comme
/// au-dela de C2. Les mots sont ramenes a leur forme de base par quelques regles (pluriels, temps, -er/-est)
/// et une table des formes irregulieres : approximation, qui ne voit pas la grammaire.
/// </para>
/// </summary>
public static class LexicalProfile
{
    public static readonly string[] Levels = { "A1", "A2", "B1", "B2", "C1", "C2" };

    private static readonly Lazy<Dictionary<string, int>> Words = new(Load);

    private static readonly Regex Token = new(@"[A-Za-z]+(?:['’][A-Za-z]+)*|\d[\d.,:]*|[.!?]", RegexOptions.CultureInvariant);

    public sealed record Profile(int Tokens, double[] Shares, double OffList, string Level95, IReadOnlyList<string> Above);

    /// <summary>Profil du texte, ou null s'il a moins de 20 mots comptes.</summary>
    public static Profile? Of(string? text, string? target = null)
    {
        var levels = new int[Levels.Length];
        var off = 0;
        var tokens = 0;
        var above = new List<string>();
        var targetIndex = Array.IndexOf(Levels, target ?? "");
        var sentenceStart = true;
        foreach (Match m in Token.Matches(text ?? ""))
        {
            var raw = m.Value;
            if (raw is "." or "!" or "?")
            {
                sentenceStart = true;
                continue;
            }

            if (char.IsDigit(raw[0]))
            {
                sentenceStart = false;
                continue;
            }

            // Un mot capitalise hors debut de phrase est un nom propre (personne, entreprise, ville).
            var proper = char.IsUpper(raw[0]) && !sentenceStart && raw != "I";
            sentenceStart = false;
            if (proper)
            {
                continue;
            }

            foreach (var word in Split(raw.ToLowerInvariant().Replace('’', '\'')))
            {
                var level = LevelOf(word);
                if (level < 0 && char.IsUpper(raw[0]))
                {
                    continue; // nom propre en debut de phrase
                }

                tokens++;
                if (level < 0)
                {
                    off++;
                    if (above.Count < 12 && !above.Contains(word))
                    {
                        above.Add(word);
                    }
                }
                else
                {
                    levels[level]++;
                    if (targetIndex >= 0 && level > targetIndex && above.Count < 12 && !above.Contains(word))
                    {
                        above.Add(word);
                    }
                }
            }
        }

        if (tokens < 20)
        {
            return null;
        }

        var shares = levels.Select(n => Math.Round((double)n / tokens, 3)).ToArray();
        var level95 = "C2+";
        var covered = 0;
        for (var i = 0; i < Levels.Length; i++)
        {
            covered += levels[i];
            if (covered >= 0.95 * tokens)
            {
                level95 = Levels[i];
                break;
            }
        }

        return new Profile(tokens, shares, Math.Round((double)off / tokens, 3), level95, above);
    }

    public static JsonObject ToJson(Profile p) => new()
    {
        ["tokens"] = p.Tokens,
        ["level95"] = p.Level95,
        ["shares"] = new JsonObject(Levels.Select((l, i) => new KeyValuePair<string, JsonNode?>(l, p.Shares[i]))),
        ["offList"] = p.OffList,
        ["above"] = new JsonArray(p.Above.Select(w => (JsonNode)w).ToArray()),
    };

    /// <summary>Indice du niveau (0 = A1 … 5 = C2), -1 si le mot n'est pas dans la liste.</summary>
    public static int LevelOf(string word)
    {
        var dict = Words.Value;
        foreach (var form in Forms(word))
        {
            if (dict.TryGetValue(form, out var level))
            {
                return level;
            }
        }

        return -1;
    }

    /// <summary>Contractions : « don't » -> do, not ; « we're » -> we, be ; « John's » -> john.</summary>
    private static IEnumerable<string> Split(string word)
    {
        var i = word.IndexOf('\'');
        if (i < 0)
        {
            yield return word;
            yield break;
        }

        var head = word[..i];
        var tail = word[(i + 1)..];
        if (tail == "t" && head.EndsWith('n'))
        {
            yield return head switch { "can" => "can", "won" => "will", "shan" => "shall", _ => head[..^1] };
            yield return "not";
            yield break;
        }

        if (head.Length > 0)
        {
            yield return head;
        }

        switch (tail)
        {
            case "re" or "m":
                yield return "be";
                break;
            case "ll":
                yield return "will";
                break;
            case "ve":
                yield return "have";
                break;
            case "d":
                yield return "would";
                break;
        }
    }

    /// <summary>La forme telle quelle, puis ses formes de base possibles.</summary>
    private static IEnumerable<string> Forms(string w)
    {
        yield return w;
        if (Irregular.TryGetValue(w, out var lemma))
        {
            yield return lemma;
        }

        if (w.Length <= 3)
        {
            yield break;
        }

        if (w.EndsWith("ies", StringComparison.Ordinal))
        {
            yield return w[..^3] + "y";
        }

        if (w.EndsWith("ves", StringComparison.Ordinal))
        {
            yield return w[..^3] + "f";
            yield return w[..^3] + "fe";
        }

        if (w.EndsWith("es", StringComparison.Ordinal))
        {
            yield return w[..^2];
        }

        if (w.EndsWith('s') && !w.EndsWith("ss", StringComparison.Ordinal))
        {
            yield return w[..^1];
        }

        if (w.EndsWith("ied", StringComparison.Ordinal))
        {
            yield return w[..^3] + "y";
        }

        if (w.EndsWith("ed", StringComparison.Ordinal))
        {
            var stem = w[..^2];
            yield return stem;
            yield return stem + "e";
            if (stem.Length > 2 && stem[^1] == stem[^2])
            {
                yield return stem[..^1];
            }
        }

        if (w.EndsWith("ing", StringComparison.Ordinal) && w.Length > 5)
        {
            var stem = w[..^3];
            yield return stem;
            yield return stem + "e";
            if (stem.Length > 2 && stem[^1] == stem[^2])
            {
                yield return stem[..^1];
            }

            if (stem.EndsWith('y'))
            {
                yield return stem[..^1] + "ie";
            }
        }

        foreach (var suffix in new[] { "est", "er" })
        {
            if (!w.EndsWith(suffix, StringComparison.Ordinal) || w.Length <= suffix.Length + 2)
            {
                continue;
            }

            var stem = w[..^suffix.Length];
            yield return stem;
            yield return stem + "e";
            if (stem.EndsWith('i'))
            {
                yield return stem[..^1] + "y";
            }

            if (stem.Length > 2 && stem[^1] == stem[^2])
            {
                yield return stem[..^1];
            }
        }

        if (w.EndsWith("ly", StringComparison.Ordinal) && w.Length > 5)
        {
            yield return w[..^2];
            if (w.EndsWith("ily", StringComparison.Ordinal))
            {
                yield return w[..^3] + "y";
            }

            if (w.EndsWith("ally", StringComparison.Ordinal))
            {
                yield return w[..^4];
            }
        }
    }

    private static Dictionary<string, int> Load()
    {
        var dict = new Dictionary<string, int>(StringComparer.Ordinal);
        using var stream = typeof(LexicalProfile).Assembly.GetManifestResourceStream("data/cefrj.tsv");
        if (stream is null)
        {
            return dict;
        }

        using var reader = new StreamReader(stream, Encoding.UTF8);
        string? line;
        while ((line = reader.ReadLine()) is not null)
        {
            if (line.Length == 0 || line[0] == '#')
            {
                continue;
            }

            var tab = line.IndexOf('\t');
            var level = tab > 0 ? Array.IndexOf(Levels, line[(tab + 1)..].Trim()) : -1;
            if (level >= 0)
            {
                dict[line[..tab]] = level;
            }
        }

        return dict;
    }

    private static readonly Dictionary<string, string> Irregular = BuildIrregular();

    private static Dictionary<string, string> BuildIrregular()
    {
        // forme -> base : verbes irreguliers courants, pluriels irreguliers, comparatifs irreguliers.
        const string table = """
            am be|is be|are be|was be|were be|been be|being be|has have|had have|having have|does do|did do|done do|
            went go|gone go|goes go|saw see|seen see|took take|taken take|made make|came come|got get|gotten get|
            gave give|given give|knew know|known know|thought think|told tell|said say|says say|found find|left leave|
            felt feel|kept keep|brought bring|bought buy|began begin|begun begin|ran run|wrote write|written write|
            spoke speak|spoken speak|stood stand|understood understand|heard hear|met meet|paid pay|sent send|
            spent spend|built build|lost lose|held hold|led lead|read read|sat sit|won win|taught teach|caught catch|
            fell fall|fallen fall|chose choose|chosen choose|drove drive|driven drive|ate eat|eaten eat|drank drink|
            drunk drink|forgot forget|forgotten forget|broke break|broken break|grew grow|grown grow|threw throw|
            thrown throw|flew fly|flown fly|wore wear|worn wear|sold sell|slept sleep|meant mean|lent lend|
            rose rise|risen rise|shook shake|shaken shake|hid hide|hidden hide|bit bite|bitten bite|fed feed|
            fought fight|sought seek|dealt deal|swam swim|sang sing|sung sing|rang ring|rung ring|drew draw|
            drawn draw|froze freeze|frozen freeze|stole steal|stolen steal|woke wake|woken wake|hung hang|
            laid lay|lain lie|lay lie|became become|overcame overcome|undertook undertake|withdrew withdraw|
            men man|women woman|children child|people person|feet foot|teeth tooth|mice mouse|geese goose|
            lives life|wives wife|knives knife|leaves leaf|halves half|shelves shelf|analyses analysis|crises crisis|
            criteria criterion|phenomena phenomenon|better good|best good|worse bad|worst bad|further far|
            furthest far|farther far|less little|least little|more many|most many|
            """;
        var map = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var pair in table.Split('|', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var parts = pair.Split(' ', StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length == 2)
            {
                map[parts[0]] = parts[1];
            }
        }

        return map;
    }

    /// <summary>Ecart (en niveaux) entre le niveau lexical mesure et un niveau annonce (A1…C1) : positif = plus difficile.</summary>
    public static int Gap(string level95, string announced)
    {
        var measured = level95 == "C2+" ? Levels.Length : Array.IndexOf(Levels, level95);
        var given = Array.IndexOf(Levels, announced);
        return measured < 0 || given < 0 ? 0 : Math.Clamp(measured - given, -3, 3);
    }

    internal static string Describe(Profile p)
        => string.Join(", ", Levels.Select((l, i) => l + " " + (p.Shares[i] * 100).ToString("0", CultureInfo.InvariantCulture) + " %"))
            + ", hors liste " + (p.OffList * 100).ToString("0", CultureInfo.InvariantCulture) + " % ; 95 % des mots au niveau " + p.Level95;
}
