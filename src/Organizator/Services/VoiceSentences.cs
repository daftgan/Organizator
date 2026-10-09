using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace Organizator.Services;

/// <summary>
/// Decoupe en phrases, au fil de l'eau, le texte que Claude ecrit pour la conversation vocale, et
/// nettoie chaque phrase pour la voix (ni Markdown, ni emoji, ni URL). Chaque phrase part a la
/// synthese des qu'elle est complete : la premiere se dit pendant que la suite s'ecrit encore.
///
/// Une phrase finit sur <c>. ! ? …</c> suivis d'un blanc, sur un saut de ligne, ou sur <c>:</c> et
/// <c>;</c> quand elle est deja longue. On attend la premiere lettre du mot suivant avant de couper :
/// une minuscule veut dire que la phrase continue (« etc. et », « M. Dupont » apres une abreviation).
/// Les nombres (« 3.5 »), les abreviations courantes et les points de suspension « ... » ne coupent
/// pas au milieu. Une phrase trop courte est collee a la suivante, sauf la premiere : elle part
/// tout de suite, pour que la voix commence au plus vite.
/// </summary>
public sealed class VoiceSentences
{
    /// <summary>En dessous, une phrase (sauf la premiere) attend la suivante.</summary>
    public const int MinLength = 12;

    /// <summary>Au-dela, <c>:</c> et <c>;</c> coupent aussi.</summary>
    public const int LongLength = 120;

    // Abreviations apres lesquelles un point ne finit jamais la phrase (comparees sans casse).
    private static readonly HashSet<string> Abbreviations = new(StringComparer.OrdinalIgnoreCase)
    {
        "M", "MM", "Mme", "Mmes", "Mlle", "Mlles", "Dr", "Pr", "Me", "Mgr", "St", "Ste", "Sts",
        "cf", "p", "pp", "ex", "env", "av", "apr", "vol", "chap", "fig", "éd", "ed", "n", "no", "nº",
        "Mr", "Mrs", "Ms", "Jr", "Sr", "vs", "approx", "dept", "réf", "ref", "art", "al", "J.-C",
        "i.e", "e.g", "c.-à-d", "c.à.d", "p.ex", "tél", "tel",
    };

    private readonly StringBuilder _buffer = new();
    private string _carry = "";
    private bool _first = true;

    // Filet : la ligne « §META {json} » du tuteur oral (normalement retiree en amont par VoiceMetaFilter)
    // et tout ce qui la suit ne sont jamais dits.
    private bool _muted;

    /// <summary>Ajoute un morceau de texte ; rend les phrases completes, deja nettoyees.</summary>
    public IReadOnlyList<string> Push(string? delta)
    {
        var done = new List<string>();
        if (string.IsNullOrEmpty(delta))
        {
            return done;
        }

        if (_muted)
        {
            return done;
        }

        _buffer.Append(delta);
        var meta = _buffer.ToString().IndexOf(VoiceMetaFilter.Marker, StringComparison.Ordinal);
        if (meta >= 0)
        {
            _buffer.Remove(meta, _buffer.Length - meta);
            _muted = true;
        }

        while (TryCut(out var raw))
        {
            Accept(raw, done, final: false);
        }

        return done;
    }

    /// <summary>Fin du message : le reste, meme sans ponctuation finale, devient la derniere phrase.</summary>
    public IReadOnlyList<string> Flush()
    {
        var done = new List<string>();
        while (TryCut(out var raw))
        {
            Accept(raw, done, final: false);
        }

        var rest = _buffer.ToString();
        _buffer.Clear();
        Accept(rest, done, final: true);
        return done;
    }

    /// <summary>Repart de zero (nouveau tour), en gardant la regle de la premiere phrase.</summary>
    public void Reset()
    {
        _buffer.Clear();
        _carry = "";
        _first = true;
        _muted = false;
    }

    private void Accept(string raw, List<string> done, bool final)
    {
        var clean = Clean(raw);
        if (_carry.Length > 0 && clean.Length > 0)
        {
            clean = _carry + " " + clean;
            _carry = "";
        }
        else if (clean.Length == 0)
        {
            clean = final ? _carry : "";
            if (final)
            {
                _carry = "";
            }
        }

        if (clean.Length == 0)
        {
            return;
        }

        if (!final && !_first && clean.Length < MinLength)
        {
            // Un titre ou une ligne sans ponctuation, colle a la suite, garde sa pause.
            _carry = char.IsLetterOrDigit(clean[^1]) ? clean + "." : clean;
            return;
        }

        _first = false;
        done.Add(clean);
    }

    /// <summary>Cherche la premiere fin de phrase sure dans le tampon et la retire.</summary>
    private bool TryCut(out string sentence)
    {
        sentence = "";
        var text = _buffer.ToString();
        for (var i = 0; i < text.Length; i++)
        {
            var c = text[i];
            if (c == '\n')
            {
                // Une ligne vide ou un trait ne fait pas une phrase : Clean les ecarte.
                sentence = text[..i];
                _buffer.Remove(0, i + 1);
                return true;
            }

            var strong = c is '.' or '!' or '?' or '…';
            var weak = c is ':' or ';';
            if (!strong && !weak)
            {
                continue;
            }

            // Suite de ponctuations (« ?! », « ... ») puis fermetures (guillemets, parentheses, gras).
            var end = i + 1;
            while (end < text.Length && text[end] is '.' or '!' or '?' or '…')
            {
                end++;
            }

            end = SkipClosers(text, end);

            if (end >= text.Length)
            {
                return false; // On ne sait pas encore ce qui suit.
            }

            if (!char.IsWhiteSpace(text[end]))
            {
                i = end - 1;
                continue; // « 3.5 », « www.site », « a.b »
            }

            if (weak && i < LongLength)
            {
                continue;
            }

            if (c == '.' && end == i + 1 && NoBreakBefore(text, i))
            {
                continue;
            }

            // Premiere lettre du mot suivant : une minuscule veut dire que la phrase continue.
            var next = end;
            while (next < text.Length && text[next] is ' ' or '\t' or '\r' or '\u00A0' or '\u202F')
            {
                next++;
            }

            if (next >= text.Length)
            {
                return false;
            }

            if (strong && text[next] != '\n' && char.IsLower(text[next]))
            {
                continue;
            }

            sentence = text[..end];
            _buffer.Remove(0, end);
            return true;
        }

        return false;
    }

    /// <summary>
    /// Saute ce qui ferme la phrase apres sa ponctuation : parentheses, guillemets (« … Bonjour. » avec
    /// son espace insecable), marques de gras ou d'italique.
    /// </summary>
    private static int SkipClosers(string text, int end)
    {
        while (true)
        {
            while (end < text.Length && text[end] is '*' or '_' or ')' or ']' or '»' or '"' or '\'' or '’' or '”' or '`')
            {
                end++;
            }

            var probe = end;
            while (probe < text.Length && text[probe] is ' ' or '\u00A0' or '\u202F')
            {
                probe++;
            }

            if (probe > end && probe < text.Length && text[probe] is '»' or '”')
            {
                end = probe;
                continue;
            }

            return end;
        }
    }

    /// <summary>Point d'abreviation, d'initiale ou de numero de liste, qui ne finit pas la phrase.</summary>
    private static bool NoBreakBefore(string text, int dot)
    {
        var start = dot;
        while (start > 0 && !char.IsWhiteSpace(text[start - 1]) && text[start - 1] is not '(' and not '«' and not '"')
        {
            start--;
        }

        var word = text[start..dot];
        if (word.Length == 0)
        {
            return false;
        }

        if (Abbreviations.Contains(word))
        {
            return true;
        }

        // Initiale : « J. K. Rowling ».
        if (word.Length == 1 && char.IsUpper(word[0]))
        {
            return true;
        }

        // « 1. » en tete de ligne : numero de liste, pas une phrase.
        if (word.All(char.IsDigit))
        {
            var lineStart = text.LastIndexOf('\n', Math.Max(0, start - 1)) + 1;
            return text[lineStart..start].Trim().Length == 0;
        }

        return false;
    }

    // ------------------------------------------------------------------ nettoyage

    private static readonly Regex Fence = new(@"```[\w+-]*", RegexOptions.CultureInvariant);
    private static readonly Regex Image = new(@"!\[([^\]]*)\]\([^)]*\)", RegexOptions.CultureInvariant);
    private static readonly Regex Link = new(@"\[([^\]]+)\]\([^)]*\)", RegexOptions.CultureInvariant);
    private static readonly Regex FootRef = new(@"\[\^?[\w-]{1,12}\]|【[^】]*】", RegexOptions.CultureInvariant);
    private static readonly Regex SourceParen = new(
        @"\s*\((?:\s*(?:source|sources|réf\.?|ref\.?|références?|cf\.?|voir|d'après|selon)\b[^)]*|[^)\s]*(?:https?://|www\.)[^)]*|\s*[\w-]+(?:\.[\w-]+)*\.(?:com|org|net|fr|io|gov|edu|info|eu|uk|de)(?:/[^)\s]*)?\s*|\s*\d{1,3}(?:\s*,\s*\d{1,3})*\s*)\)",
        RegexOptions.CultureInvariant | RegexOptions.IgnoreCase);
    private static readonly Regex Url = new(@"(?:https?://|www\.)[^\s)\]»""]+", RegexOptions.CultureInvariant | RegexOptions.IgnoreCase);
    private static readonly Regex Heading = new(@"^\s{0,3}#{1,6}\s*", RegexOptions.CultureInvariant);
    private static readonly Regex Quote = new(@"^\s*(?:>\s*)+", RegexOptions.CultureInvariant);
    private static readonly Regex Bullet = new(@"^\s*(?:[-*+•–—]|\d{1,3}[.)])\s+", RegexOptions.CultureInvariant);
    private static readonly Regex Rule = new(@"^\s*(?:[-*_=]\s*){3,}$", RegexOptions.CultureInvariant);
    private static readonly Regex Underscore = new(@"(?<![\p{L}\p{N}])_{1,3}([^_]+?)_{1,3}(?![\p{L}\p{N}])", RegexOptions.CultureInvariant);
    private static readonly Regex Spaces = new(@"\s+", RegexOptions.CultureInvariant);
    private static readonly Regex SpaceBeforeComma = new(@"\s+([,.])", RegexOptions.CultureInvariant);
    private static readonly Regex EmptyPairs = new(@"\(\s*\)|\[\s*\]|«\s*»|""\s*""", RegexOptions.CultureInvariant);

    /// <summary>Texte pret a dire : sans Markdown, emojis, URLs ni references ; vide s'il ne reste rien a dire.</summary>
    public static string Clean(string? raw)
    {
        var text = (raw ?? "").Replace('\r', ' ').Replace('\n', ' ').Trim();
        if (text.Length == 0)
        {
            return "";
        }

        if (Rule.IsMatch(text))
        {
            return "";
        }

        text = Fence.Replace(text, " ");
        text = Heading.Replace(text, "");
        text = Quote.Replace(text, "");
        text = Bullet.Replace(text, "");
        text = Image.Replace(text, "$1");
        text = Link.Replace(text, "$1");
        text = FootRef.Replace(text, "");
        text = SourceParen.Replace(text, "");
        text = Url.Replace(text, "");
        text = text.Replace("**", "").Replace("*", "").Replace("`", "").Replace("~~", "");
        text = Underscore.Replace(text, "$1");
        text = text.Replace("|", ", ");
        text = StripEmoji(text);
        text = EmptyPairs.Replace(text, "");
        text = Spaces.Replace(text, " ");
        text = SpaceBeforeComma.Replace(text, "$1");
        text = text.Trim().TrimStart(',', ';', ':', '.', '-', '–', '—').Trim();
        text = text.Replace(",,", ",").Replace(", .", ".").Replace(",.", ".");

        // Ne reste qu'une ponctuation : rien a dire.
        return text.Any(char.IsLetterOrDigit) ? text : "";
    }

    /// <summary>Retire emojis, pictogrammes, selecteurs de variante et liants (ZWJ).</summary>
    private static string StripEmoji(string text)
    {
        var sb = new StringBuilder(text.Length);
        foreach (var rune in text.EnumerateRunes())
        {
            var v = rune.Value;
            var emoji = (v >= 0x1F000 && v <= 0x1FAFF)   // emojis, drapeaux, pictogrammes
                || (v >= 0x2600 && v <= 0x27BF)          // symboles divers, dingbats
                || (v >= 0x2B00 && v <= 0x2BFF)          // fleches et etoiles
                || (v >= 0x2190 && v <= 0x21FF)          // fleches
                || (v >= 0x2300 && v <= 0x23FF)          // horloges, sabliers
                || (v >= 0x25A0 && v <= 0x25FF)          // formes geometriques
                || (v >= 0xFE00 && v <= 0xFE0F)          // selecteurs de variante
                || (v >= 0xE0000 && v <= 0xE007F)        // etiquettes (drapeaux regionaux)
                || v == 0x200D || v == 0x20E3            // liant, touche
                || Rune.GetUnicodeCategory(rune) == UnicodeCategory.OtherSymbol && v > 0xFF && v != 0x2122 && v != 0x00A9;
            if (!emoji)
            {
                sb.Append(rune.ToString());
            }
        }

        return sb.ToString();
    }
}

/// <summary>
/// Retire du flux de deltas la ligne finale <c>§META {json}</c> du tuteur oral, avant le decoupeur
/// de phrases : elle n'est jamais lue a voix haute. Le marqueur peut arriver coupe entre deux deltas
/// (« …? §ME » puis « TA {… ») : la fin du texte qui pourrait en etre le debut est retenue jusqu'au
/// delta suivant. Reconnu : <c>§META</c> n'importe ou, et <c>META {</c> ou <c>META: {</c> en debut
/// de ligne (marqueur sans son signe). Tout ce qui suit le marqueur est garde a part (<see cref="Meta"/>).
/// </summary>
public sealed class VoiceMetaFilter
{
    public const string Marker = "§META";
    private const string Bare = "META";

    private readonly StringBuilder _held = new();
    private readonly StringBuilder _meta = new();
    private bool _found;

    // Debut de ligne au debut du texte retenu (le texte deja rendu finissait par un saut de ligne, ou rien n'est sorti).
    private bool _lineStart = true;

    /// <summary>Vrai des que le marqueur est passe.</summary>
    public bool Found => _found;

    /// <summary>Le texte apres le marqueur (l'objet JSON attendu) ; null sans marqueur.</summary>
    public string? Meta => _found ? _meta.ToString() : null;

    /// <summary>Ajoute un delta ; rend le texte sur a dire (sans marqueur ni ce qui le suit).</summary>
    public string Push(string? delta)
    {
        if (string.IsNullOrEmpty(delta))
        {
            return "";
        }

        if (_found)
        {
            _meta.Append(delta);
            return "";
        }

        _held.Append(delta);
        var text = _held.ToString();
        var (start, after) = Find(text);
        if (start >= 0)
        {
            _found = true;
            _meta.Append(text[after..]);
            _held.Clear();
            return Release(text[..start]);
        }

        var keep = Partial(text);
        _held.Clear();
        _held.Append(text[keep..]);
        return Release(text[..keep]);
    }

    /// <summary>Fin du message : le texte retenu n'etait pas un marqueur, il part.</summary>
    public string Flush()
    {
        if (_found)
        {
            return "";
        }

        var text = _held.ToString();
        _held.Clear();
        return Release(text);
    }

    private string Release(string text)
    {
        // Debut de ligne si le texte rendu finit par un saut de ligne suivi seulement de blancs.
        var tail = text.TrimEnd(' ', '\t');
        if (tail.Length > 0)
        {
            _lineStart = tail[^1] == '\n';
        }

        return text;
    }

    /// <summary>Position du marqueur complet et debut de ce qui le suit ; (-1, -1) sinon.</summary>
    private (int Start, int After) Find(string text)
    {
        var at = text.IndexOf(Marker, StringComparison.Ordinal);
        var bare = BareAt(text, out var bareAfter);
        if (at >= 0 && (bare < 0 || at <= bare))
        {
            return (at, at + Marker.Length);
        }

        return bare >= 0 ? (bare, bareAfter) : (-1, -1);
    }

    /// <summary><c>META</c> en debut de ligne, suivi de blancs ou de deux-points puis d'une accolade.</summary>
    private int BareAt(string text, out int after)
    {
        after = -1;
        for (var i = 0; i < text.Length; i++)
        {
            if (!LineStart(text, i) || string.CompareOrdinal(text, i, Bare, 0, Bare.Length) != 0)
            {
                continue;
            }

            var j = i + Bare.Length;
            while (j < text.Length && text[j] is ' ' or '\t' or ':')
            {
                j++;
            }

            if (j < text.Length && text[j] == '{')
            {
                after = j;
                return i;
            }
        }

        return -1;
    }

    private bool LineStart(string text, int i)
    {
        var k = i - 1;
        while (k >= 0 && text[k] is ' ' or '\t')
        {
            k--;
        }

        return k < 0 ? _lineStart : text[k] == '\n';
    }

    /// <summary>Debut de la fin du texte qui pourrait encore devenir un marqueur (longueur du texte si aucune).</summary>
    private int Partial(string text)
    {
        for (var i = Math.Max(0, text.Length - Marker.Length); i < text.Length; i++)
        {
            if (Marker.StartsWith(text[i..], StringComparison.Ordinal))
            {
                return i;
            }
        }

        // « META » en debut de ligne, suivi peut-etre de blancs ou de deux-points : on attend l'accolade.
        var line = text.LastIndexOf('\n') + 1;
        var lead = line;
        while (lead < text.Length && text[lead] is ' ' or '\t')
        {
            lead++;
        }

        if (lead < text.Length && (line > 0 || _lineStart))
        {
            var rest = text[lead..];
            if (Bare.StartsWith(rest, StringComparison.Ordinal)
                || (rest.StartsWith(Bare, StringComparison.Ordinal) && rest[Bare.Length..].All(c => c is ' ' or '\t' or ':')))
            {
                return line;
            }
        }

        return text.Length;
    }
}
