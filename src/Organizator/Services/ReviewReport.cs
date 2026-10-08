using System.Text;
using System.Text.RegularExpressions;
using Markdig.Syntax;
using Markdig.Syntax.Inlines;

namespace Organizator.Services;

/// <summary>
/// Un constat d'une revue de code, tel que l'inventaire de l'UI l'affiche : son identifiant dans le
/// rapport, sa gravite, son titre (le code garde ses accents graves), sa categorie et l'emplacement
/// cite, les renvois de fin de titre (PR, « hors diff »), et son corps rendu en HTML. <c>Source</c> :
/// son Markdown tel qu'il est ecrit, titre compris, quand le texte du document a ete fourni.
/// </summary>
public sealed record ReviewFinding(
    string Id,
    string Severity,
    string Title,
    string Category,
    string Where,
    IReadOnlyList<string> Tags,
    string Html,
    string Source = "");

/// <summary>Ce qu'un rapport de revue donne a l'inventaire : le verdict, sa gravite, et les constats.</summary>
public sealed record ReviewSummary(string Verdict, string Level, IReadOnlyList<ReviewFinding> Findings);

/// <summary>
/// Reconnait un rapport de revue de code dans un document Markdown et en extrait les constats.
/// Les rapports des agents n'ont pas tous la meme forme ; ce qui revient, c'est un titre par constat,
/// numerote (<c>C1</c>, <c>M2</c>, <c>3.</c>, <c>4 —</c>), dont la gravite est dite par une pastille
/// (🔴 🟠 🟡 🔵), par un mot (<c>BLOQUANT</c>, <c>[MAJEUR]</c>, <c>MINEUR ·</c>…), ou par la section qui
/// le contient (<c>## 🟠 Majeurs</c>, <c>## Problemes MINEURS</c>). Le corps d'un constat va jusqu'au
/// titre suivant de meme niveau ou plus haut. Un titre numerote sans gravite n'est pas un constat.
/// </summary>
public static class ReviewReport
{
    public const string Blocker = "blocker";
    public const string Major = "major";
    public const string Minor = "minor";
    public const string Info = "info";
    public const string Ok = "ok";

    private const int MaxVerdict = 160;
    private const int MaxTitle = 300;
    private const int MaxWhere = 1200;
    private const char VariationSelector = (char)0xFE0F;

    /// <summary>Pastilles de gravite, cherchees en tete de titre (ou juste apres l'identifiant).</summary>
    private static readonly (string Mark, string Level)[] Marks =
    {
        ("🔴", Blocker), ("⛔", Blocker), ("🛑", Blocker),
        ("🟠", Major),
        ("🟡", Minor),
        ("🔵", Info), ("ℹ", Info), ("⚪", Info), ("💡", Info), ("🟣", Info),
        ("🟢", Ok), ("✅", Ok),
    };

    /// <summary>Pictogrammes decoratifs d'un titre de section (📋 Revue…, 👍 Points positifs), sans gravite.</summary>
    private static readonly string[] Decorations = { "📋", "👍", "🔎", "❓", "🔧", "🧪", "⚠", "📌", "📝", "🚨" };

    private static readonly Regex LetterId = new(
        @"^(?<id>[A-Z]{1,3}-?\d{1,3}[a-z]?)(?<sep>\s*[.):—–·-]\s*|\s+)",
        RegexOptions.CultureInvariant);

    private static readonly Regex NumberId = new(
        @"^(?<id>\d{1,3})(?:\s*[.)]\s*(?:[—–·:-]\s*)?|\s*[—–·:-]\s*)",
        RegexOptions.CultureInvariant);

    /// <summary>
    /// Gravite ecrite en toutes lettres en tete de titre, entre crochets ou suivie d'un separateur
    /// (« BLOQUANT — », « [MAJEUR] », « MINEUR (latent) · ») : un mot suivi directement du texte
    /// (« Critique du design ») n'en est pas une.
    /// </summary>
    private static readonly Regex SeverityWord = new(
        @"^(?:\[\s*(?<w>[\p{L}]+)\s*\]\s*|(?<w>[\p{L}]+)\s*(?:\([^)]{0,40}\)\s*)?(?:[—–·:|-]\s*|$))",
        RegexOptions.CultureInvariant);

    private static readonly Regex Category = new(@"^\[(?<c>[^\[\]]{2,40})\]\s*", RegexOptions.CultureInvariant);

    private static readonly Regex SectionWords = new(
        @"\b(?<w>bloquant(?:e|s|es)?|critiques?|majeur(?:e|s|es)?|mineur(?:e|s|es)?|suggestions?|remarques?)\b",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    private static readonly Regex WhereSuffix = new(@"^`[^`]*[./\\][^`]*`", RegexOptions.CultureInvariant);

    private static readonly Regex Label = new(
        @"^(?<k>où|emplacement|localisation|fichiers?|catégorie|categorie)\s*:\s*(?<v>.+)$",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    private static readonly Regex VerdictLabel = new(
        @"^verdict[^:\n]{0,30}:\s*(?<v>.+)$",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.Singleline);

    /// <summary>
    /// Constats du document, ou <c>null</c> si ce n'est pas un rapport de revue : il en faut au moins
    /// deux, ou un seul si le nom du fichier le dit (review-…, revue-…). <paramref name="render"/>
    /// rend une suite de blocs en HTML, avec le meme rendu (et la meme reecriture des liens) que le lecteur.
    /// Avec <paramref name="markdown"/> (le Markdown d'ou vient le document), chaque constat porte aussi sa source.
    /// </summary>
    public static ReviewSummary? Parse(MarkdownDocument document, string fileName, Func<IReadOnlyList<Block>, string> render, string? markdown = null)
    {
        var findings = new List<ReviewFinding>();
        var context = new string?[7];
        var titleSeen = false;
        var verdict = new VerdictScan();

        Pending? current = null;
        foreach (var block in document)
        {
            if (block is HeadingBlock heading)
            {
                var level = Math.Clamp(heading.Level, 1, 6);
                if (current is not null && level > current.Level)
                {
                    current.Blocks.Add(block);
                    continue;
                }

                if (current is not null)
                {
                    findings.Add(current.Close(render, markdown));
                    current = null;
                }

                for (var l = level; l < context.Length; l++)
                {
                    context[l] = null;
                }

                var head = ReadHeading(heading);
                if (!titleSeen && level == 1)
                {
                    titleSeen = true;
                    continue;
                }

                verdict.Heading(head.Plain);
                var parsed = ParseFindingHeading(head.Plain);
                if (parsed is not null)
                {
                    var severity = parsed.Severity ?? Inherited(context, level);
                    if (severity is Blocker or Major or Minor or Info)
                    {
                        current = new Pending(heading, parsed with { Severity = severity }, head.Tags);
                        continue;
                    }
                }

                context[level] = SectionSeverity(head.Plain);
                continue;
            }

            if (current is not null)
            {
                current.Blocks.Add(block);
                continue;
            }

            verdict.Block(block);
        }

        if (current is not null)
        {
            findings.Add(current.Close(render, markdown));
        }

        var named = fileName.Contains("review", StringComparison.OrdinalIgnoreCase)
            || fileName.Contains("revue", StringComparison.OrdinalIgnoreCase);
        if (findings.Count < 2 && !(named && findings.Count == 1))
        {
            return null;
        }

        var text = verdict.Result;
        return new ReviewSummary(text, LevelOf(text), findings);
    }

    // ------------------------------------------------------------------ constats

    private sealed record FindingHead(string Id, string? Severity, string Title, string Category, string Where);

    private sealed class Pending
    {
        public Pending(HeadingBlock heading, FindingHead head, IReadOnlyList<string> tags)
        {
            Heading = heading;
            Level = Math.Clamp(heading.Level, 1, 6);
            Head = head;
            Tags = tags;
        }

        public HeadingBlock Heading { get; }
        public int Level { get; }
        public FindingHead Head { get; }
        public IReadOnlyList<string> Tags { get; }
        public List<Block> Blocks { get; } = new();

        public ReviewFinding Close(Func<IReadOnlyList<Block>, string> render, string? text)
        {
            // Le filet (---) qui separe deux constats n'appartient ni a l'un ni a l'autre.
            while (Blocks.Count > 0 && Blocks[^1] is ThematicBreakBlock)
            {
                Blocks.RemoveAt(Blocks.Count - 1);
            }

            // La source est prise avant que les etiquettes (« Ou : … ») ne quittent le corps.
            var source = SourceOf(text);

            // « **Ou** : … » et « **Categorie** : … » passent dans l'en-tete du constat. Un paragraphe
            // qui n'est fait que de ces etiquettes, toutes reprises, quitte le corps : il y ferait doublon.
            var category = Head.Category;
            var where = Head.Where;
            for (var i = 0; i < Math.Min(4, Blocks.Count); i++)
            {
                if (Blocks[i] is not ParagraphBlock paragraph)
                {
                    continue;
                }

                var taken = 0;
                var lines = InlineText(paragraph.Inline).Split('\n')
                    .Select(l => l.Trim())
                    .Where(l => l.Length > 0)
                    .ToList();
                foreach (var line in lines)
                {
                    var match = Label.Match(line);
                    if (!match.Success)
                    {
                        continue;
                    }

                    var value = match.Groups["v"].Value.Trim();
                    var key = match.Groups["k"].Value.ToLowerInvariant();
                    if (key.StartsWith("cat", StringComparison.Ordinal))
                    {
                        if (category.Length == 0)
                        {
                            category = Clip(value, 40);
                            taken++;
                        }
                    }
                    else if (where.Length == 0)
                    {
                        // Un emplacement tronque garde son paragraphe : rien ne doit se perdre.
                        where = Clip(value, MaxWhere);
                        taken += value.Length <= MaxWhere ? 1 : 0;
                    }
                }

                if (lines.Count > 0 && taken == lines.Count)
                {
                    Blocks.RemoveAt(i);
                    i--;
                }
            }

            return new ReviewFinding(Head.Id, Head.Severity!, Head.Title, category, where, Tags, render(Blocks), source);
        }

        /// <summary>Le Markdown du constat, de son titre a son dernier bloc ; vide sans le texte du document.</summary>
        private string SourceOf(string? text)
        {
            if (string.IsNullOrEmpty(text))
            {
                return "";
            }

            var start = Heading.Span.Start;
            var end = Blocks.Count > 0 ? Blocks[^1].Span.End : Heading.Span.End;
            if (start < 0 || end < start || end >= text.Length)
            {
                return "";
            }

            return text.Substring(start, end - start + 1).Trim();
        }
    }

    /// <summary>
    /// Lit un titre de constat : pastilles, identifiant, gravite en toutes lettres, categorie entre
    /// crochets, puis le titre lui-meme. <c>null</c> si le titre ne porte pas d'identifiant.
    /// </summary>
    private static FindingHead? ParseFindingHeading(string plain)
    {
        var rest = plain.Trim();
        var severity = TakeMarks(ref rest);

        string id;
        var letter = LetterId.Match(rest);
        if (letter.Success)
        {
            var after = rest[letter.Length..];
            // « A9 disable… » n'est pas un identifiant : sans separateur, il faut une pastille ou un crochet derriere.
            if (letter.Groups["sep"].Value.Trim().Length == 0 && !(StartsWithMark(after) || after.StartsWith('[')))
            {
                return null;
            }

            id = letter.Groups["id"].Value;
            rest = after;
        }
        else
        {
            var number = NumberId.Match(rest);
            if (!number.Success)
            {
                return null;
            }

            id = number.Groups["id"].Value;
            rest = rest[number.Length..];
        }

        severity = TakeMarks(ref rest) ?? severity;

        var word = SeverityWord.Match(rest);
        if (word.Success)
        {
            var level = WordLevel(word.Groups["w"].Value);
            if (level is not null)
            {
                severity ??= level;
                rest = rest[word.Length..];
            }
        }

        severity = TakeMarks(ref rest) ?? severity;

        var category = "";
        var cat = Category.Match(rest);
        if (cat.Success && WordLevel(cat.Groups["c"].Value) is null)
        {
            category = cat.Groups["c"].Value.Trim();
            rest = rest[cat.Length..];
        }

        var where = "";
        var cut = rest.LastIndexOf(" — ", StringComparison.Ordinal);
        if (cut > 0 && WhereSuffix.IsMatch(rest[(cut + 3)..].TrimStart()))
        {
            where = rest[(cut + 3)..].Trim();
            rest = rest[..cut];
        }

        var title = rest.Trim().TrimEnd('—', '–', '-', ':', '·').Trim();
        if (title.Length == 0)
        {
            return null;
        }

        return new FindingHead(id, severity, Clip(title, MaxTitle), category, where);
    }

    private static string? Inherited(string?[] context, int level)
    {
        for (var l = level - 1; l >= 1; l--)
        {
            if (context[l] is not null)
            {
                return context[l];
            }
        }

        return null;
    }

    /// <summary>
    /// Gravite portee par un titre de section (« 🟠 Majeurs », « Problemes MINEURS ») : sa pastille,
    /// sinon le seul niveau que ses mots nomment. Un verdict n'est pas une section de constats.
    /// </summary>
    private static string? SectionSeverity(string plain)
    {
        if (plain.Contains("verdict", StringComparison.OrdinalIgnoreCase) || plain.Length > 90)
        {
            return null;
        }

        var first = -1;
        string? found = null;
        foreach (var (mark, level) in Marks)
        {
            var at = plain.IndexOf(mark, StringComparison.Ordinal);
            if (at >= 0 && (first < 0 || at < first))
            {
                first = at;
                found = level;
            }
        }

        if (found is not null)
        {
            return found;
        }

        string? only = null;
        foreach (Match match in SectionWords.Matches(plain))
        {
            var level = WordLevel(match.Groups["w"].Value);
            if (only is not null && level != only)
            {
                return null;
            }

            only = level;
        }

        return only;
    }

    private static string? WordLevel(string word)
    {
        var w = word.ToLowerInvariant();
        if (w.StartsWith("bloquant", StringComparison.Ordinal) || w.StartsWith("critique", StringComparison.Ordinal)
            || w.StartsWith("blocker", StringComparison.Ordinal) || w == "critical")
        {
            return Blocker;
        }

        if (w.StartsWith("majeur", StringComparison.Ordinal) || w == "major")
        {
            return Major;
        }

        if (w.StartsWith("mineur", StringComparison.Ordinal) || w == "minor")
        {
            return Minor;
        }

        if (w.StartsWith("suggestion", StringComparison.Ordinal) || w.StartsWith("remarque", StringComparison.Ordinal)
            || w is "nit" or "nits" or "info")
        {
            return Info;
        }

        return null;
    }

    private static bool StartsWithMark(string text)
    {
        foreach (var (mark, _) in Marks)
        {
            if (text.StartsWith(mark, StringComparison.Ordinal))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>Retire les pastilles de tete (et leurs selecteurs de variante) ; rend la premiere gravite vue.</summary>
    private static string? TakeMarks(ref string text)
    {
        string? severity = null;
        var again = true;
        while (again)
        {
            again = false;
            text = text.TrimStart().TrimStart(VariationSelector).TrimStart();
            foreach (var (mark, level) in Marks)
            {
                if (text.StartsWith(mark, StringComparison.Ordinal))
                {
                    severity ??= level;
                    text = text[mark.Length..];
                    again = true;
                    break;
                }
            }

            foreach (var decoration in Decorations)
            {
                if (text.StartsWith(decoration, StringComparison.Ordinal))
                {
                    text = text[decoration.Length..];
                    again = true;
                    break;
                }
            }
        }

        return severity == Ok ? null : severity;
    }

    private static string LevelOf(string text)
    {
        var t = text.TrimStart();
        foreach (var (mark, level) in Marks)
        {
            if (t.StartsWith(mark, StringComparison.Ordinal))
            {
                return level;
            }
        }

        return "";
    }

    // -------------------------------------------------------------------- verdict

    /// <summary>
    /// Verdict du rapport, lu hors des constats : « Verdict : 🔴 … » (titre, paragraphe ou puce), ou le
    /// premier bloc sous un titre « Verdict ». Un verdict qui s'ouvre sur une pastille l'emporte ; a
    /// defaut, le premier « Verdict : … » ecrit en clair.
    /// </summary>
    private sealed class VerdictScan
    {
        private bool _afterHeading;
        private string? _marked;
        private string? _plain;

        public string Result => _marked ?? _plain ?? "";

        public void Heading(string plain)
        {
            if (_afterHeading)
            {
                Offer(plain, labelled: false);
            }

            _afterHeading = false;
            if (!plain.Contains("verdict", StringComparison.OrdinalIgnoreCase))
            {
                return;
            }

            var labelled = VerdictLabel.Match(plain.Trim());
            if (labelled.Success)
            {
                Offer(labelled.Groups["v"].Value, labelled: true);
            }
            else
            {
                _afterHeading = true;
            }
        }

        public void Block(Block block)
        {
            if (_afterHeading)
            {
                _afterHeading = false;
                if (block is ParagraphBlock first)
                {
                    Offer(InlineText(first.Inline), labelled: false);
                    return;
                }
            }

            if (block is ParagraphBlock paragraph)
            {
                Labelled(InlineText(paragraph.Inline));
            }
            else if (block is ListBlock list)
            {
                foreach (var item in list.OfType<ListItemBlock>())
                {
                    if (item.FirstOrDefault() is ParagraphBlock inner)
                    {
                        Labelled(InlineText(inner.Inline));
                    }
                }
            }
        }

        private void Labelled(string text)
        {
            var match = VerdictLabel.Match(text.Trim());
            if (match.Success)
            {
                Offer(match.Groups["v"].Value, labelled: true);
            }
        }

        private void Offer(string text, bool labelled)
        {
            var sentence = FirstSentence(text);
            if (sentence.Length == 0)
            {
                return;
            }

            if (_marked is null && LevelOf(sentence).Length > 0)
            {
                _marked = sentence;
            }
            else if (labelled && _plain is null)
            {
                _plain = sentence;
            }
        }

        private static string FirstSentence(string text)
        {
            var t = text.Replace("`", "").Trim();
            var line = t.IndexOf('\n');
            if (line >= 0)
            {
                t = t[..line].Trim();
            }

            for (var i = 8; i < t.Length - 1; i++)
            {
                if (t[i] == '.' && t[i + 1] == ' ')
                {
                    t = t[..(i + 1)];
                    break;
                }
            }

            return Clip(t, MaxVerdict);
        }
    }

    // ----------------------------------------------------------------------- texte

    private sealed record HeadingText(string Plain, IReadOnlyList<string> Tags);

    /// <summary>
    /// Texte d'un titre, sans ses renvois de fin (« **[#755]** », « **[hors diff — #743]** ») qui
    /// deviennent des etiquettes.
    /// </summary>
    private static HeadingText ReadHeading(HeadingBlock heading)
    {
        var parts = new List<Inline>();
        if (heading.Inline is not null)
        {
            parts.AddRange(heading.Inline);
        }

        var tags = new List<string>();
        while (parts.Count > 0)
        {
            var last = parts[^1];
            if (last is LiteralInline blank && blank.Content.ToString().Trim().Length == 0)
            {
                parts.RemoveAt(parts.Count - 1);
                continue;
            }

            if (last is EmphasisInline strong)
            {
                var text = InlineText(strong).Trim();
                if (text.Length > 2 && text.StartsWith('[') && text.EndsWith(']'))
                {
                    tags.Insert(0, Clip(text.Replace("[", "").Replace("]", "").Trim(), 80));
                    parts.RemoveAt(parts.Count - 1);
                    continue;
                }
            }

            break;
        }

        var plain = new StringBuilder();
        foreach (var inline in parts)
        {
            AppendInline(plain, inline);
        }

        return new HeadingText(plain.ToString().Replace('\n', ' ').Trim(), tags);
    }

    /// <summary>Texte d'une suite d'inlines : le code garde ses accents graves, l'emphase disparait.</summary>
    private static string InlineText(ContainerInline? container)
    {
        var text = new StringBuilder();
        if (container is not null)
        {
            foreach (var inline in container)
            {
                AppendInline(text, inline);
            }
        }

        return text.ToString();
    }

    private static void AppendInline(StringBuilder text, Inline inline)
    {
        switch (inline)
        {
            case LiteralInline literal:
                text.Append(literal.Content.ToString());
                break;
            case CodeInline code:
                text.Append('`').Append(code.Content).Append('`');
                break;
            case LineBreakInline:
                text.Append('\n');
                break;
            case HtmlEntityInline entity:
                text.Append(entity.Transcoded.ToString());
                break;
            case AutolinkInline autolink:
                text.Append(autolink.Url);
                break;
            case HtmlInline:
                break;
            case ContainerInline container:
                foreach (var child in container)
                {
                    AppendInline(text, child);
                }

                break;
        }
    }

    private static string Clip(string text, int max)
    {
        var t = text.Trim();
        return t.Length <= max ? t : t[..(max - 1)].TrimEnd() + "…";
    }
}
