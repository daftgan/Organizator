using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace Organizator.Services;

/// <summary>Jeton de Whisper reduit a ce qu'il faut pour refaire les mots (temps en secondes).</summary>
public readonly record struct SpokenToken(string Text, double Start, double End, double P);

/// <summary>Mot reconnu : texte tel que Whisper l'ecrit, debut et fin (s), probabilite moyenne et minimale de ses jetons.</summary>
public sealed record SpokenWord(string Text, double Start, double End, double P, double PMin);

/// <summary>Jeton normalise et les mots d'origine qu'il couvre (indices du premier et du dernier).</summary>
public readonly record struct NormToken(string Text, int First, int Last);

/// <summary>Silence detecte sur l'energie du signal (secondes).</summary>
public readonly record struct SilenceSpan(double Start, double End)
{
    public double Seconds => End - Start;
}

/// <summary>Profil d'energie d'un enregistrement : parole entre <c>SpeechStart</c> et <c>SpeechEnd</c>, silences interieurs.</summary>
public sealed record EnergyProfile(bool HasSpeech, double SpeechStart, double SpeechEnd, IReadOnlyList<SilenceSpan> Silences, double FloorDb, double SpeechDb, double ThresholdDb);

/// <summary>Pause rattachee au mot <c>After</c> (indice dans les mots), commencee a <c>At</c> secondes.</summary>
public sealed record SpeechPause(int After, double At, double Seconds);

public sealed record SpeechFluency(double Wpm, double ArticulationWpm, double SpeechSeconds, IReadOnlyList<SpeechPause> Pauses);

/// <summary>
/// Une operation de l'alignement : <c>ok</c>, <c>sub</c> (substitution), <c>del</c> (mot attendu omis),
/// <c>ins</c> (mot ajoute). <c>Ref</c> et <c>Hyp</c> sont les jetons normalises ; <c>RefIndex</c> pointe le mot
/// du texte attendu (decoupe aux blancs), <c>WordIndex</c> le mot reconnu ; -1 quand il n'y en a pas.
/// Pour un <c>del</c>, <c>Start</c>/<c>End</c> encadrent l'endroit de l'omission et <c>P</c> est nul.
/// </summary>
public sealed record AlignmentOp(string Op, string Ref, string Hyp, double Start, double End, double? P, int RefIndex, int WordIndex);

public sealed record SpeechAlignment(double Accuracy, double Wer, int RefTokens, int Ok, int Sub, int Del, int Ins, IReadOnlyList<AlignmentOp> Ops);

/// <summary>
/// Evaluation d'une lecture a voix haute ou d'une prise de parole en anglais, a partir des mots de Whisper
/// et des echantillons (16 kHz) : fonctions pures, sans etat.
///
/// <list type="bullet">
/// <item><description><see cref="WordsFromTokens"/> : un jeton qui commence par une espace ouvre un mot ; jetons
/// speciaux ecartes ; probabilite du mot = moyenne de ses jetons (ceux qui portent une lettre ou un chiffre), minimum a cote.</description></item>
/// <item><description><see cref="Normalize"/> : casse, ponctuation, apostrophes, contractions, nombres ecrits en chiffres
/// (« two forty-seven », « two hundred and forty-seven » et « 247 » donnent « 247 » ; annees, heures, prix, ordinaux),
/// orthographes britanniques ramenees a l'americaine, mots composes.</description></item>
/// <item><description><see cref="Align"/> : Levenshtein par mot entre le texte attendu et la transcription.</description></item>
/// <item><description><see cref="Energy"/> et <see cref="Fluency"/> : pauses (silences de 300 ms ou plus, RMS par 20 ms,
/// seuil relatif au bruit de fond), debit et debit d'articulation.</description></item>
/// </list>
/// </summary>
public static class SpeechAssessment
{
    public const double MinPauseSeconds = 0.3;
    public const double FrameSeconds = 0.02;

    // ------------------------------------------------------------------ mots

    /// <summary>Refait les mots d'un segment a partir de ses jetons.</summary>
    public static List<SpokenWord> WordsFromTokens(IEnumerable<SpokenToken> tokens)
    {
        var words = new List<SpokenWord>();
        var text = new StringBuilder();
        var probabilities = new List<double>();
        var others = new List<double>();
        double start = 0, end = 0;
        var open = false;

        void Flush()
        {
            var value = text.ToString().Trim();
            if (value.Any(char.IsLetterOrDigit))
            {
                var source = probabilities.Count > 0 ? probabilities : others;
                var p = source.Count > 0 ? source.Average() : 0;
                var min = source.Count > 0 ? source.Min() : 0;
                words.Add(new SpokenWord(value, Math.Round(start, 2), Math.Round(Math.Max(start, end), 2), Math.Round(p, 3), Math.Round(min, 3)));
            }

            text.Clear();
            probabilities.Clear();
            others.Clear();
            open = false;
        }

        foreach (var token in tokens)
        {
            var piece = (token.Text ?? "").Replace("�", "");
            if (piece.Length == 0 || IsSpecialToken(piece))
            {
                continue;
            }

            if (open && char.IsWhiteSpace(piece[0]))
            {
                Flush();
            }

            if (!open)
            {
                start = token.Start;
                open = true;
            }

            text.Append(piece);
            end = token.End;
            var p = Math.Clamp(token.P, 0, 1);
            if (piece.Any(char.IsLetterOrDigit))
            {
                probabilities.Add(p);
            }
            else
            {
                others.Add(p);
            }
        }

        Flush();
        return words;
    }

    /// <summary>Jetons de controle de whisper.cpp : <c>[_BEG_]</c>, <c>[_TT_150]</c>, <c>&lt;|endoftext|&gt;</c>...</summary>
    public static bool IsSpecialToken(string text)
    {
        var value = text.TrimStart();
        return value.StartsWith("[_", StringComparison.Ordinal) || value.StartsWith("<|", StringComparison.Ordinal);
    }

    // ---------------------------------------------------------- normalisation

    private sealed class Raw
    {
        public required string Text;
        public int First;
        public int Last;
        public bool Break;   // ponctuation entre ce jeton et le precedent
        public bool FromS;   // « is » tire d'un « 's » (it's, he's...)
    }

    private static readonly Regex Piece = new(
        @"'?[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*'?|[%&]|[.,;:!?…""()\[\]{}«»—–/\\]",
        RegexOptions.CultureInvariant);

    private static readonly Regex Currency = new(@"([$£€])(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?", RegexOptions.CultureInvariant);
    private static readonly Regex Thousands = new(@"\b\d{1,3}(?:,\d{3})+\b", RegexOptions.CultureInvariant);
    private static readonly Regex AmPmGlued = new(@"(\d)([ap])\.?m\b\.?", RegexOptions.CultureInvariant);
    private static readonly Regex Dotted = new(@"\b(?:[a-z]\.){2,}|\b[a-z]\.[a-z]\b", RegexOptions.CultureInvariant);
    private static readonly Regex Clock = new(@"\b(\d{1,2})([:.])(\d{2})\b(?![.:]\d)", RegexOptions.CultureInvariant);
    private static readonly Regex Decimal = new(@"\b(\d+)\.(\d+)\b", RegexOptions.CultureInvariant);
    private static readonly Regex Digits = new(@"^\d+$", RegexOptions.CultureInvariant);
    private static readonly Regex DigitOrdinal = new(@"^(\d+)(st|nd|rd|th)$", RegexOptions.CultureInvariant);

    /// <summary>
    /// Normalise une suite de mots (le texte attendu decoupe aux blancs, ou les mots de Whisper) en jetons
    /// comparables, chacun avec les indices des mots d'origine qu'il couvre.
    /// </summary>
    public static List<NormToken> Normalize(IReadOnlyList<string> words)
    {
        var raw = new List<Raw>();
        var pendingBreak = false;
        for (var i = 0; i < words.Count; i++)
        {
            var prepared = Prepare(words[i] ?? "");
            foreach (Match match in Piece.Matches(prepared))
            {
                var value = match.Value;
                if (value.Length == 1 && ".,;:!?…\"()[]{}«»—–/\\".Contains(value[0]))
                {
                    pendingBreak = true;
                    continue;
                }

                foreach (var (text, fromS) in Expand(value))
                {
                    raw.Add(new Raw { Text = text, First = i, Last = i, Break = pendingBreak, FromS = fromS });
                    pendingBreak = false;
                }
            }
        }

        return Finish(Numbers(raw));
    }

    /// <summary>Normalise un texte libre (decoupe aux blancs, comme la page).</summary>
    public static List<NormToken> Normalize(string text) => Normalize(SplitWords(text));

    /// <summary>Decoupe aux blancs, comme <c>words()</c> de la page : c'est a ces mots que renvoie <c>refIndex</c>.</summary>
    public static string[] SplitWords(string? text)
    {
        var value = (text ?? "").Trim();
        return value.Length == 0 ? [] : Regex.Split(value, @"\s+");
    }

    private static string Prepare(string word)
    {
        var s = word.Normalize(NormalizationForm.FormKC).ToLowerInvariant()
            .Replace('’', '\'').Replace('‘', '\'').Replace('ʼ', '\'').Replace('`', '\'').Replace('´', '\'')
            .Replace('“', '"').Replace('”', '"').Replace('„', '"');
        s = RemoveDiacritics(s);
        s = Currency.Replace(s, m =>
        {
            var (unit, sub) = m.Groups[1].Value switch
            {
                "$" => ("dollars", "cents"),
                "£" => ("pounds", "pence"),
                _ => ("euros", "cents"),
            };
            var whole = m.Groups[2].Value.Replace(",", "");
            var cents = m.Groups[3].Success ? m.Groups[3].Value.PadRight(2, '0').TrimStart('0') : "";
            return cents.Length > 0 ? $" {whole} {unit} {cents} {sub} " : $" {whole} {unit} ";
        });
        s = Thousands.Replace(s, m => m.Value.Replace(",", ""));
        s = AmPmGlued.Replace(s, "$1 $2m ");
        s = Dotted.Replace(s, m => m.Value.Replace(".", ""));
        s = Clock.Replace(s, m =>
        {
            var hours = int.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture);
            var minutes = int.Parse(m.Groups[3].Value, CultureInfo.InvariantCulture);
            if (hours > 24 || minutes > 59)
            {
                return m.Value; // un decimal (39.99) : traite plus bas
            }

            return minutes == 0 ? hours.ToString(CultureInfo.InvariantCulture) : hours.ToString(CultureInfo.InvariantCulture) + m.Groups[3].Value;
        });
        s = Decimal.Replace(s, "$1 point $2");
        return s;
    }

    private static string RemoveDiacritics(string text)
    {
        var decomposed = text.Normalize(NormalizationForm.FormD);
        var builder = new StringBuilder(decomposed.Length);
        foreach (var c in decomposed)
        {
            if (CharUnicodeInfo.GetUnicodeCategory(c) != UnicodeCategory.NonSpacingMark)
            {
                builder.Append(c);
            }
        }

        return builder.ToString().Normalize(NormalizationForm.FormC);
    }

    private static readonly Dictionary<string, string[]> Whole = new(StringComparer.Ordinal)
    {
        ["won't"] = ["will", "not"],
        ["can't"] = ["can", "not"],
        ["cannot"] = ["can", "not"],
        ["shan't"] = ["shall", "not"],
        ["ain't"] = ["aint"],
        ["let's"] = ["let", "us"],
        ["o'clock"] = [],
        ["oclock"] = [],
        ["'em"] = ["them"],
        ["'cause"] = ["because"],
        ["'til"] = ["until"],
        ["'bout"] = ["about"],
        ["gonna"] = ["going", "to"],
        ["wanna"] = ["want", "to"],
        ["gotta"] = ["got", "to"],
        ["kinda"] = ["kind", "of"],
        ["sorta"] = ["sort", "of"],
        ["dunno"] = ["do", "not", "know"],
        ["lemme"] = ["let", "me"],
        ["gimme"] = ["give", "me"],
        ["outta"] = ["out", "of"],
        ["ok"] = ["okay"],
        ["alright"] = ["all", "right"],
        ["mr"] = ["mister"],
        ["dr"] = ["doctor"],
        ["vs"] = ["versus"],
        ["etc"] = ["etcetera"],
        ["&"] = ["and"],
        ["%"] = ["percent"],
    };

    private static readonly HashSet<string> SubjectsOfIs = new(StringComparer.Ordinal)
    {
        "it", "he", "she", "that", "there", "here", "what", "where", "who", "how", "when", "why", "this",
        "everyone", "everybody", "everything", "nothing", "nobody", "someone", "somebody", "something", "one",
    };

    /// <summary>Contractions et abreviations d'un mot (minuscule, apostrophes droites).</summary>
    private static IEnumerable<(string Text, bool FromS)> Expand(string word)
    {
        if (Whole.TryGetValue(word, out var whole) || Whole.TryGetValue(word.Trim('\''), out whole))
        {
            foreach (var part in whole)
            {
                yield return (part, false);
            }

            yield break;
        }

        var w = word.Trim('\'');
        if (w.Length == 0)
        {
            yield break;
        }

        string? stem = null;
        string? tail = null;
        var fromS = false;
        if (w.EndsWith("n't", StringComparison.Ordinal) && w.Length > 3)
        {
            stem = w[..^3];
            tail = "not";
        }
        else if (w.EndsWith("'re", StringComparison.Ordinal))
        {
            stem = w[..^3];
            tail = "are";
        }
        else if (w.EndsWith("'ve", StringComparison.Ordinal))
        {
            stem = w[..^3];
            tail = "have";
        }
        else if (w.EndsWith("'ll", StringComparison.Ordinal))
        {
            stem = w[..^3];
            tail = "will";
        }
        else if (w.EndsWith("'m", StringComparison.Ordinal))
        {
            stem = w[..^2];
            tail = "am";
        }
        else if (w.EndsWith("'d", StringComparison.Ordinal))
        {
            stem = w[..^2];
            tail = "would";
        }
        else if (w.EndsWith("'s", StringComparison.Ordinal) && SubjectsOfIs.Contains(w[..^2]))
        {
            stem = w[..^2];
            tail = "is";
            fromS = true;
        }

        if (stem is { Length: > 0 } && tail is not null)
        {
            yield return (stem, false);
            yield return (tail, fromS);
            yield break;
        }

        yield return (w, false);
    }

    // ---------------------------------------------------------------- nombres

    private enum NumKind
    {
        None,
        Unit,
        Teen,
        Tens,
        Big,
        Hundred,
        Scale,
    }

    private static readonly Dictionary<string, long> Small = new(StringComparer.Ordinal)
    {
        ["zero"] = 0, ["one"] = 1, ["two"] = 2, ["three"] = 3, ["four"] = 4, ["five"] = 5, ["six"] = 6, ["seven"] = 7,
        ["eight"] = 8, ["nine"] = 9, ["ten"] = 10, ["eleven"] = 11, ["twelve"] = 12, ["thirteen"] = 13, ["fourteen"] = 14,
        ["fifteen"] = 15, ["sixteen"] = 16, ["seventeen"] = 17, ["eighteen"] = 18, ["nineteen"] = 19, ["twenty"] = 20,
        ["thirty"] = 30, ["forty"] = 40, ["fourty"] = 40, ["fifty"] = 50, ["sixty"] = 60, ["seventy"] = 70, ["eighty"] = 80,
        ["ninety"] = 90,
    };

    private static readonly Dictionary<string, long> OrdinalWords = new(StringComparer.Ordinal)
    {
        ["first"] = 1, ["second"] = 2, ["third"] = 3, ["fourth"] = 4, ["fifth"] = 5, ["sixth"] = 6, ["seventh"] = 7,
        ["eighth"] = 8, ["ninth"] = 9, ["tenth"] = 10, ["eleventh"] = 11, ["twelfth"] = 12, ["thirteenth"] = 13,
        ["fourteenth"] = 14, ["fifteenth"] = 15, ["sixteenth"] = 16, ["seventeenth"] = 17, ["eighteenth"] = 18,
        ["nineteenth"] = 19, ["twentieth"] = 20, ["thirtieth"] = 30, ["fortieth"] = 40, ["fiftieth"] = 50,
        ["sixtieth"] = 60, ["seventieth"] = 70, ["eightieth"] = 80, ["ninetieth"] = 90, ["hundredth"] = 100,
        ["thousandth"] = 1000,
    };

    private static readonly Dictionary<string, long> Scales = new(StringComparer.Ordinal)
    {
        ["thousand"] = 1_000, ["million"] = 1_000_000, ["billion"] = 1_000_000_000,
    };

    private static readonly HashSet<string> Months = new(StringComparer.Ordinal)
    {
        "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december",
    };

    private static NumKind KindOf(long value) => value switch
    {
        < 10 => NumKind.Unit,
        < 20 => NumKind.Teen,
        < 100 when value % 10 == 0 => NumKind.Tens,
        _ => NumKind.Big,
    };

    /// <summary>
    /// Lit une suite de nombres (mots ou chiffres) sans ponctuation entre eux. Chaque groupe qui ne prolonge pas
    /// le precedent ouvre un morceau, et les morceaux se mettent bout a bout : « two forty-seven » = 2|47 = 247,
    /// « twenty twenty-seven » = 2027, « six fifteen » = 615 (comme « 6.15 »), « six oh five » = 605.
    /// </summary>
    private sealed class NumberParser
    {
        private readonly StringBuilder _out = new();
        private long _total;
        private long _cur;
        private bool _any;
        private NumKind _last = NumKind.None;
        private long _lastScale;
        private long _lastChunk;

        public bool Ordinal { get; private set; }

        public bool Ended { get; private set; }

        public bool AcceptsAnd => _last is NumKind.Hundred or NumKind.Scale;

        public bool AcceptsOrdinal => _last is NumKind.Tens or NumKind.Hundred or NumKind.Scale;

        public bool Feed(string t)
        {
            if (Digits.IsMatch(t))
            {
                if ((t.Length > 1 && t[0] == '0') || t.Length > 15)
                {
                    Flush();
                    _out.Append(t);
                    _lastChunk = 0;
                    return true;
                }

                var value = long.Parse(t, CultureInfo.InvariantCulture);
                return Value(value, KindOf(value));
            }

            var ordinal = DigitOrdinal.Match(t);
            if (ordinal.Success && ordinal.Groups[1].Value.Length <= 15)
            {
                var value = long.Parse(ordinal.Groups[1].Value, CultureInfo.InvariantCulture);
                Value(value, KindOf(value));
                Ordinal = true;
                Ended = true;
                return true;
            }

            if (Small.TryGetValue(t, out var small))
            {
                return Value(small, KindOf(small));
            }

            if (OrdinalWords.TryGetValue(t, out var nth))
            {
                if (nth == 100)
                {
                    Hundred();
                }
                else if (nth >= 1000)
                {
                    Scale(nth);
                }
                else
                {
                    Value(nth, KindOf(nth));
                }

                Ordinal = true;
                Ended = true;
                return true;
            }

            if (t == "hundred")
            {
                Hundred();
                return true;
            }

            if (Scales.TryGetValue(t, out var scale))
            {
                Scale(scale);
                return true;
            }

            if (t == "a" && !_any)
            {
                return Value(1, NumKind.Unit);
            }

            return false;
        }

        private bool Value(long value, NumKind kind)
        {
            var fits = _last switch
            {
                NumKind.None => true,
                NumKind.Hundred => value < 100,
                NumKind.Scale => value < _lastScale,
                NumKind.Tens => kind == NumKind.Unit && value > 0,
                _ => false,
            };
            if (!fits)
            {
                Flush();
            }

            _cur += value;
            _any = true;
            _last = kind;
            return true;
        }

        private void Hundred()
        {
            if (!_any || _last == NumKind.Hundred)
            {
                Flush();
                _cur = 100;
            }
            else
            {
                _cur = _cur == 0 ? 100 : _cur * 100;
            }

            _any = true;
            _last = NumKind.Hundred;
        }

        private void Scale(long scale)
        {
            if (_any && _last == NumKind.Scale && scale >= _lastScale)
            {
                _total = (_total + _cur) * scale;
            }
            else
            {
                _total += (_cur == 0 ? 1 : _cur) * scale;
            }

            _cur = 0;
            _any = true;
            _last = NumKind.Scale;
            _lastScale = scale;
        }

        private void Flush()
        {
            if (_any)
            {
                var value = _total + _cur;
                _out.Append(value.ToString(CultureInfo.InvariantCulture));
                _lastChunk = value;
            }

            _total = 0;
            _cur = 0;
            _any = false;
            _last = NumKind.None;
            _lastScale = 0;
        }

        public string Result()
        {
            Flush();
            var text = _out.ToString();
            return Ordinal ? text + Suffix(_lastChunk) : text;
        }
    }

    private static string Suffix(long value)
    {
        var tens = value % 100;
        if (tens is 11 or 12 or 13)
        {
            return "th";
        }

        return (value % 10) switch
        {
            1 => "st",
            2 => "nd",
            3 => "rd",
            _ => "th",
        };
    }

    private static bool IsUnitWord(string t) => (Small.TryGetValue(t, out var v) && v < 10) || (Digits.IsMatch(t) && t.Length == 1);

    private static bool StartsNumber(List<Raw> raw, int i)
    {
        var t = raw[i].Text;
        if (Digits.IsMatch(t) || DigitOrdinal.IsMatch(t) || Small.ContainsKey(t) || t == "hundred" || Scales.ContainsKey(t))
        {
            return true;
        }

        if (t == "a")
        {
            return i + 1 < raw.Count && !raw[i + 1].Break && (raw[i + 1].Text == "hundred" || Scales.ContainsKey(raw[i + 1].Text));
        }

        if (OrdinalWords.ContainsKey(t))
        {
            if (t is not ("first" or "second"))
            {
                return true;
            }

            // « first » / « second » : seulement dans une date (« March first », « the second of May »)
            var before = i > 0 && Months.Contains(raw[i - 1].Text);
            var after = i + 2 < raw.Count && raw[i + 1].Text == "of" && Months.Contains(raw[i + 2].Text);
            return before || after;
        }

        return false;
    }

    private static List<Raw> Numbers(List<Raw> raw)
    {
        var output = new List<Raw>(raw.Count);
        var i = 0;
        while (i < raw.Count)
        {
            if (!StartsNumber(raw, i))
            {
                output.Add(raw[i]);
                i++;
                continue;
            }

            var parser = new NumberParser();
            var j = i;
            while (j < raw.Count && (j == i || !raw[j].Break))
            {
                var t = raw[j].Text;
                if (j > i)
                {
                    var next = j + 1 < raw.Count && !raw[j + 1].Break ? raw[j + 1].Text : null;
                    if (t == "and" && parser.AcceptsAnd && next is not null && (Small.ContainsKey(next) || Digits.IsMatch(next) || OrdinalWords.ContainsKey(next)))
                    {
                        j++;
                        continue;
                    }

                    if (t is "oh" or "o" && next is not null && IsUnitWord(next))
                    {
                        t = "0";
                    }

                    if (OrdinalWords.ContainsKey(t) && !parser.AcceptsOrdinal)
                    {
                        break; // « two second delay » : le nombre s'arrete avant
                    }

                    if (t == "a")
                    {
                        break;
                    }
                }

                if (!parser.Feed(t))
                {
                    break;
                }

                j++;
                if (parser.Ended)
                {
                    break;
                }
            }

            if (j == i)
            {
                output.Add(raw[i]);
                i++;
                continue;
            }

            output.Add(new Raw { Text = parser.Result(), First = raw[i].First, Last = raw[j - 1].Last, Break = raw[i].Break });
            i = j;
        }

        return output;
    }

    // ----------------------------------------------------------- finitions

    private static readonly HashSet<string> Fillers = new(StringComparer.Ordinal)
    {
        "um", "umm", "uh", "uhh", "uhm", "erm", "er", "hmm", "hm", "mm", "mmm",
    };

    private static readonly HashSet<string> CurrencyWords = new(StringComparer.Ordinal) { "dollars", "pounds", "euros" };

    private static readonly Dictionary<string, string> Plurals = new(StringComparer.Ordinal)
    {
        ["dollar"] = "dollars", ["pound"] = "pounds", ["euro"] = "euros", ["cent"] = "cents",
    };

    private static List<NormToken> Finish(List<Raw> raw)
    {
        var tokens = new List<NormToken>(raw.Count);
        for (var i = 0; i < raw.Count; i++)
        {
            var t = raw[i].Text.Replace("'", "");
            if (t.Length == 0 || Fillers.Contains(t))
            {
                continue;
            }

            if (Spelling.TryGetValue(t, out var us))
            {
                t = us;
            }

            if (Plurals.TryGetValue(t, out var plural))
            {
                t = plural;
            }

            var first = raw[i].First;
            var last = raw[i].Last;
            var next = i + 1 < raw.Count ? raw[i + 1].Text : null;

            // « thirty-nine dollars and ninety-nine cents » = « $39.99 »
            if (t == "and" && tokens.Count > 0 && CurrencyWords.Contains(tokens[^1].Text) && next is { Length: > 0 } && char.IsDigit(next[0]))
            {
                continue;
            }

            // « per cent » = « percent »
            if (t == "per" && next == "cent")
            {
                tokens.Add(new NormToken("percent", first, raw[i + 1].Last));
                i++;
                continue;
            }

            // « he's been » = « he has been »
            if (raw[i].FromS && next is "been" or "got")
            {
                t = "has";
            }

            // « March 3 » = « March 3rd » = « March third »
            if (Digits.IsMatch(t) && tokens.Count > 0 && Months.Contains(tokens[^1].Text) && t.Length <= 2)
            {
                var day = int.Parse(t, CultureInfo.InvariantCulture);
                if (day is >= 1 and <= 31)
                {
                    t += Suffix(day);
                }
            }

            tokens.Add(new NormToken(t, first, last));
        }

        return tokens;
    }

    // ------------------------------------------------- orthographe UK -> US

    private static readonly Dictionary<string, string> Spelling = BuildSpelling();

    private static Dictionary<string, string> BuildSpelling()
    {
        var map = new Dictionary<string, string>(StringComparer.Ordinal);

        void Add(string uk, string us)
        {
            if (uk != us)
            {
                map.TryAdd(uk, us);
            }
        }

        void Endings(string uk, string us, params string[] endings)
        {
            foreach (var ending in endings)
            {
                Add(uk + ending, us + ending);
            }
        }

        // -our -> -or : colour, favourite, neighbourhood, behavioural...
        foreach (var stem in "colo favo hono labo neighbo behavio humo flavo harbo rumo vapo endeavo savo parlo armo odo splendo vigo clamo fervo rigo tumo".Split(' '))
        {
            Endings(stem + "ur", stem + "r", "", "s", "ed", "ing", "ful", "fully", "less", "able", "ably", "ite", "ites", "er", "ers", "hood", "hoods", "al", "ally", "y");
        }

        // -re -> -er : centre, theatre, metre, litre...
        foreach (var stem in "cent theat met lit fib calib somb spect lust meag sab mit kilomet centimet millimet".Split(' '))
        {
            Add(stem + "re", stem + "er");
            Add(stem + "res", stem + "ers");
            Add(stem + "red", stem + "ered");
            Add(stem + "ring", stem + "ering");
        }

        // -ise -> -ize (liste fermee : advertise, exercise, surprise... s'ecrivent -ise partout)
        const string ise = "organis realis recognis apologis prioritis criticis emphasis summaris minimis maximis specialis customis finalis "
            + "authoris optimis utilis standardis categoris memoris visualis normalis initialis synchronis globalis personalis socialis "
            + "modernis mobilis familiaris characteris civilis harmonis legalis localis neutralis patronis popularis privatis publicis "
            + "rationalis revolutionis sympathis symbolis terroris theoris urbanis vandalis capitalis centralis commercialis computeris "
            + "criminalis democratis energis equalis fertilis formalis generalis idealis immunis industrialis italicis jeopardis liberalis "
            + "marginalis materialis mesmeris monopolis nationalis oxidis penalis polaris pressuris randomis regularis sanitis scrutinis "
            + "sensitis serialis stabilis sterilis stigmatis subsidis tokenis trivialis victimis vocalis agonis antagonis brutalis colonis "
            + "crystallis decentralis digitis dramatis economis epitomis evangelis externalis fantasis fossilis hospitalis humanis hybridis "
            + "hypnotis idolis internalis itemis magnetis mechanis metabolis militaris miniaturis moisturis moralis naturalis "
            + "ostracis paralys analys catalys";
        foreach (var stem in ise.Split(' ', StringSplitOptions.RemoveEmptyEntries))
        {
            Endings(stem, stem[..^1] + "z", "e", "es", "ed", "ing", "er", "ers", "ation", "ations", "ational", "able");
        }

        // -lled / -lling -> -led / -ling : travelled, cancelling, modelling...
        foreach (var stem in "travel cancel label model level fuel signal total channel counsel dial duel equal jewel marvel quarrel rival shovel tunnel panel pedal spiral snorkel yodel gravel grovel libel initial funnel barrel bevel drivel marshal pencil refuel revel unravel".Split(' '))
        {
            Add(stem + "led", stem + "ed");
            Add(stem + "ling", stem + "ing");
            Add(stem + "ler", stem + "er");
            Add(stem + "lers", stem + "ers");
            Add(stem + "lous", stem + "ous");
        }

        Add("worshipped", "worshiped");
        Add("worshipping", "worshiping");

        var pairs = new[]
        {
            "programme program", "programmes programs", "catalogue catalog", "catalogues catalogs", "catalogued cataloged",
            "dialogue dialog", "dialogues dialogs", "analogue analog", "defence defense", "defences defenses", "offence offense",
            "offences offenses", "licence license", "licences licenses", "pretence pretense", "practise practice",
            "practises practices", "practised practiced", "practising practicing", "grey gray", "greys grays", "greyish grayish",
            "tyre tire", "tyres tires", "cheque check", "cheques checks", "ageing aging", "aluminium aluminum", "plough plow",
            "ploughs plows", "mould mold", "moulds molds", "mouldy moldy", "moustache mustache", "pyjamas pajamas",
            "sceptic skeptic", "sceptical skeptical", "scepticism skepticism", "cosy cozy", "doughnut donut", "doughnuts donuts",
            "draught draft", "draughts drafts", "kerb curb", "learnt learned", "spelt spelled", "burnt burned", "dreamt dreamed",
            "leapt leaped", "spoilt spoiled", "whilst while", "amongst among", "towards toward", "afterwards afterward",
            "upwards upward", "downwards downward", "backwards backward", "forwards forward", "maths math", "aeroplane airplane",
            "aeroplanes airplanes", "judgement judgment", "judgements judgments", "acknowledgement acknowledgment",
            "acknowledgements acknowledgments", "manoeuvre maneuver", "manoeuvres maneuvers", "manoeuvred maneuvered",
            "manoeuvring maneuvering", "mum mom", "mums moms", "mummy mommy", "jewellery jewelry", "woollen woolen",
            "skilful skillful", "skilfully skillfully", "wilful willful", "fulfil fulfill", "fulfils fulfills",
            "fulfilment fulfillment", "enrol enroll", "enrols enrolls", "enrolment enrollment", "instalment installment",
            "instalments installments", "distil distill", "instil instill", "encyclopaedia encyclopedia", "mediaeval medieval",
            "anaesthetic anesthetic", "foetus fetus", "artefact artifact", "artefacts artifacts", "sulphur sulfur",
            "yoghurt yogurt", "cosier cozier",
        };
        foreach (var pair in pairs)
        {
            var parts = pair.Split(' ');
            Add(parts[0], parts[1]);
        }

        return map;
    }

    // ---------------------------------------------------------- alignement

    /// <summary>
    /// Aligne la transcription sur le texte attendu (Levenshtein par mot, apres normalisation).
    /// Rend <c>null</c> si le texte attendu ne contient aucun mot.
    /// </summary>
    public static SpeechAlignment? Align(string? reference, IReadOnlyList<SpokenWord> words)
    {
        var refTokens = Normalize(SplitWords(reference));
        if (refTokens.Count == 0)
        {
            return null;
        }

        var hypTokens = Normalize(words.Select(w => w.Text).ToList());
        var refVocabulary = refTokens.Select(t => t.Text).ToHashSet(StringComparer.Ordinal);
        var hypVocabulary = hypTokens.Select(t => t.Text).ToHashSet(StringComparer.Ordinal);
        refTokens = MergeCompounds(refTokens, hypVocabulary, refVocabulary);
        hypTokens = MergeCompounds(hypTokens, refVocabulary, hypVocabulary);

        var r = refTokens.Select(t => t.Text).ToArray();
        var h = hypTokens.Select(t => t.Text).ToArray();
        var d = new int[r.Length + 1, h.Length + 1];
        for (var i = 0; i <= r.Length; i++)
        {
            d[i, 0] = i;
        }

        for (var j = 0; j <= h.Length; j++)
        {
            d[0, j] = j;
        }

        for (var i = 1; i <= r.Length; i++)
        {
            for (var j = 1; j <= h.Length; j++)
            {
                var same = string.Equals(r[i - 1], h[j - 1], StringComparison.Ordinal) ? 0 : 1;
                d[i, j] = Math.Min(Math.Min(d[i - 1, j] + 1, d[i, j - 1] + 1), d[i - 1, j - 1] + same);
            }
        }

        // Remontee : diagonale d'abord (ok / sub), puis omission, puis ajout.
        var path = new List<(string Op, int R, int H)>();
        int x = r.Length, y = h.Length;
        while (x > 0 || y > 0)
        {
            if (x > 0 && y > 0)
            {
                var same = string.Equals(r[x - 1], h[y - 1], StringComparison.Ordinal);
                if (d[x, y] == d[x - 1, y - 1] + (same ? 0 : 1))
                {
                    path.Add((same ? "ok" : "sub", x - 1, y - 1));
                    x--;
                    y--;
                    continue;
                }
            }

            if (x > 0 && d[x, y] == d[x - 1, y] + 1)
            {
                path.Add(("del", x - 1, -1));
                x--;
            }
            else
            {
                path.Add(("ins", -1, y - 1));
                y--;
            }
        }

        path.Reverse();

        // Temps et probabilite cote transcription ; une omission se place entre les mots qui l'encadrent.
        var ops = new List<AlignmentOp>(path.Count);
        var previousEnd = words.Count > 0 ? words[0].Start : 0;
        for (var k = 0; k < path.Count; k++)
        {
            var (op, ri, hi) = path[k];
            var refText = ri >= 0 ? r[ri] : "";
            var refIndex = ri >= 0 ? refTokens[ri].First : -1;
            if (hi >= 0)
            {
                var token = hypTokens[hi];
                var start = words[token.First].Start;
                var end = words[token.Last].End;
                var p = 0.0;
                for (var w = token.First; w <= token.Last; w++)
                {
                    p += words[w].P;
                }

                p /= token.Last - token.First + 1;
                ops.Add(new AlignmentOp(op, refText, h[hi], start, end, Math.Round(p, 3), refIndex, token.First));
                previousEnd = end;
            }
            else
            {
                var nextStart = previousEnd;
                for (var n = k + 1; n < path.Count; n++)
                {
                    if (path[n].H >= 0)
                    {
                        nextStart = words[hypTokens[path[n].H].First].Start;
                        break;
                    }
                }

                ops.Add(new AlignmentOp(op, refText, "", previousEnd, Math.Max(previousEnd, nextStart), null, refIndex, -1));
            }
        }

        var ok = ops.Count(o => o.Op == "ok");
        var sub = ops.Count(o => o.Op == "sub");
        var del = ops.Count(o => o.Op == "del");
        var ins = ops.Count(o => o.Op == "ins");
        var wer = (sub + del + ins) / (double)r.Length;
        return new SpeechAlignment(Math.Round(Math.Clamp(1 - wer, 0, 1), 3), Math.Round(wer, 3), r.Length, ok, sub, del, ins, ops);
    }

    /// <summary>
    /// Mots composes : deux jetons voisins dont la reunion est un mot de l'autre cote, et pas deja un mot de ce cote,
    /// n'en font plus qu'un (« e-mail » / « email », « every day » / « everyday », « well known » / « well-known »).
    /// </summary>
    private static List<NormToken> MergeCompounds(List<NormToken> tokens, HashSet<string> other, HashSet<string> own)
    {
        var output = new List<NormToken>(tokens.Count);
        for (var i = 0; i < tokens.Count; i++)
        {
            if (i + 1 < tokens.Count && IsWord(tokens[i].Text) && IsWord(tokens[i + 1].Text))
            {
                var joined = tokens[i].Text + tokens[i + 1].Text;
                if (other.Contains(joined) && !own.Contains(joined))
                {
                    output.Add(new NormToken(joined, tokens[i].First, tokens[i + 1].Last));
                    i++;
                    continue;
                }
            }

            output.Add(tokens[i]);
        }

        return output;

        static bool IsWord(string text) => text.Length > 0 && text.All(char.IsLetter);
    }

    // ------------------------------------------------------- energie, pauses

    /// <summary>
    /// Energie par fenetres de 20 ms : seuil = bruit de fond (5e centile, silence numerique exclu) + 35 % de l'ecart
    /// avec la parole (95e centile), entre 6 et 25 dB. Les silences de <paramref name="minSeconds"/> ou plus, entre
    /// la premiere et la derniere parole, sont rendus ; un claquement de 40 ms au plus ne coupe pas un silence.
    /// </summary>
    public static EnergyProfile Energy(ReadOnlySpan<float> samples, int sampleRate = AudioDecoder.SampleRate, double minSeconds = MinPauseSeconds)
    {
        var frame = Math.Max(1, (int)Math.Round(sampleRate * FrameSeconds));
        var n = samples.Length / frame;
        var duration = samples.Length / (double)sampleRate;
        if (n < 10)
        {
            return new EnergyProfile(false, 0, duration, [], 0, 0, 0);
        }

        var db = new double[n];
        var zero = new bool[n];
        for (var i = 0; i < n; i++)
        {
            double sum = 0;
            foreach (var x in samples.Slice(i * frame, frame))
            {
                sum += (double)x * x;
            }

            var rms = Math.Sqrt(sum / frame);
            zero[i] = rms < 1e-6;
            db[i] = 20 * Math.Log10(Math.Max(rms, 1e-6));
        }

        var levels = db.Where((_, i) => !zero[i]).ToArray();
        if (levels.Length < 20)
        {
            levels = (double[])db.Clone();
        }

        Array.Sort(levels);
        var floor = Percentile(levels, 0.05);
        var speech = Percentile(levels, 0.95);
        if (speech - floor < 10 && zero.Any(z => z))
        {
            floor = -120; // voix de synthese : les seuls silences sont numeriques
        }

        if (speech - floor < 10)
        {
            return new EnergyProfile(false, 0, duration, [], Math.Round(floor, 1), Math.Round(speech, 1), 0);
        }

        var threshold = floor + Math.Clamp(0.35 * (speech - floor), 6, 25);
        var silent = new bool[n];
        for (var i = 0; i < n; i++)
        {
            silent[i] = zero[i] || db[i] < threshold;
        }

        // Claquements : une parole de 40 ms au plus entre deux silences compte comme silence.
        for (var i = 0; i < n;)
        {
            if (silent[i])
            {
                i++;
                continue;
            }

            var j = i;
            while (j < n && !silent[j])
            {
                j++;
            }

            if (i > 0 && j < n && j - i <= 2)
            {
                for (var k = i; k < j; k++)
                {
                    silent[k] = true;
                }
            }

            i = j;
        }

        // Debut et fin de la parole : premiere et derniere suite d'au moins 60 ms.
        int first = -1, last = -1;
        for (var i = 0; i < n;)
        {
            if (silent[i])
            {
                i++;
                continue;
            }

            var j = i;
            while (j < n && !silent[j])
            {
                j++;
            }

            if (j - i >= 3)
            {
                if (first < 0)
                {
                    first = i;
                }

                last = j - 1;
            }

            i = j;
        }

        if (first < 0)
        {
            return new EnergyProfile(false, 0, duration, [], Math.Round(floor, 1), Math.Round(speech, 1), Math.Round(threshold, 1));
        }

        var minFrames = (int)Math.Ceiling(minSeconds / FrameSeconds - 1e-9);
        var silences = new List<SilenceSpan>();
        for (var i = first; i <= last;)
        {
            if (!silent[i])
            {
                i++;
                continue;
            }

            var j = i;
            while (j <= last && silent[j])
            {
                j++;
            }

            if (j - i >= minFrames)
            {
                silences.Add(new SilenceSpan(Math.Round(i * FrameSeconds, 2), Math.Round(j * FrameSeconds, 2)));
            }

            i = j;
        }

        return new EnergyProfile(true, Math.Round(first * FrameSeconds, 2), Math.Round((last + 1) * FrameSeconds, 2), silences,
            Math.Round(floor, 1), Math.Round(speech, 1), Math.Round(threshold, 1));
    }

    private static double Percentile(double[] sorted, double q)
    {
        if (sorted.Length == 0)
        {
            return 0;
        }

        var index = Math.Clamp((int)Math.Round(q * (sorted.Length - 1)), 0, sorted.Length - 1);
        return sorted[index];
    }

    /// <summary>
    /// Debit et pauses. Duree de parole = du debut du premier mot a la fin du dernier, resserree sur l'energie
    /// quand elle est connue ; chaque silence est rattache au mot dont la fin est la plus proche de son debut
    /// (au mot d'avant si celui-la a ete ecrase par Whisper contre lui, voir <see cref="Squeezed"/>), et ceux
    /// d'avant le premier mot ou d'apres le dernier sont ecartes.
    /// </summary>
    public static SpeechFluency Fluency(IReadOnlyList<SpokenWord> words, EnergyProfile? energy)
    {
        if (words.Count == 0)
        {
            return new SpeechFluency(0, 0, 0, []);
        }

        var start = words[0].Start;
        var end = Math.Max(words[^1].End, start);
        if (energy is { HasSpeech: true })
        {
            if (energy.SpeechStart > start && energy.SpeechStart < end)
            {
                start = energy.SpeechStart;
            }

            if (energy.SpeechEnd < end && energy.SpeechEnd > start)
            {
                end = energy.SpeechEnd;
            }
        }

        var span = Math.Max(0, end - start);
        var pauses = new List<SpeechPause>();
        if (energy is { HasSpeech: true })
        {
            foreach (var silence in energy.Silences)
            {
                if (silence.End <= start + 0.05 || silence.Start >= end - 0.05)
                {
                    continue;
                }

                var after = 0;
                var best = double.MaxValue;
                for (var i = 0; i < words.Count; i++)
                {
                    var gap = Math.Abs(words[i].End - silence.Start);
                    if (gap < best)
                    {
                        best = gap;
                        after = i;
                    }
                }

                // Whisper colle souvent le premier mot d'apres un long silence au mot d'avant, en l'ecrasant
                // (« Thursday » en 90 ms) : un mot de plusieurs syllabes trop court pour etre dit, colle au
                // precedent, passe apres la pause.
                if (after > 0 && Squeezed(words[after], words[after - 1]))
                {
                    after--;
                }

                if (after >= words.Count - 1)
                {
                    continue; // rien apres : c'est la fin
                }

                pauses.Add(new SpeechPause(after, Math.Round(silence.Start, 2), Math.Round(silence.Seconds, 2)));
            }
        }

        var paused = pauses.Sum(p => p.Seconds);
        var wpm = span > 0 ? words.Count / span * 60 : 0;
        var articulation = span - paused > 0.2 ? words.Count / (span - paused) * 60 : wpm;
        return new SpeechFluency(Math.Round(wpm), Math.Round(articulation), Math.Round(span, 2), pauses);
    }

    /// <summary>Mot de deux syllables ou plus, dure moins de 80 ms par syllabe, commence a la fin du precedent.</summary>
    private static bool Squeezed(SpokenWord word, SpokenWord previous)
    {
        var syllables = Syllables(word.Text);
        return syllables >= 2 && word.End - word.Start < 0.08 * syllables && word.Start - previous.End <= 0.05;
    }

    /// <summary>Syllabes approchees : groupes de voyelles, « e » final muet ; un nombre compte un par chiffre.</summary>
    public static int Syllables(string word)
    {
        var letters = new string(word.ToLowerInvariant().Where(char.IsLetter).ToArray());
        if (letters.Length == 0)
        {
            return Math.Max(1, word.Count(char.IsDigit));
        }

        var count = Regex.Matches(letters, "[aeiouy]+").Count;
        if (count > 1 && letters.EndsWith('e') && !letters.EndsWith("le", StringComparison.Ordinal))
        {
            count--;
        }

        return Math.Max(1, count);
    }
}
