using System.IO;
using System.Net;
using System.Text;
using Markdig;
using Markdig.Extensions.AutoIdentifiers;
using Markdig.Renderers;
using Markdig.Syntax;
using Markdig.Syntax.Inlines;

namespace Organizator.Services;

/// <summary>
/// Ce que l'UI affiche d'un artefact : son genre, le HTML rendu (Markdown, texte, tableau) ou
/// l'URL a charger (page, PDF, image) sous l'hote virtuel <see cref="ArtifactReader.Host"/>,
/// et l'empreinte du fichier pour ne renvoyer que ce qui a change.
/// </summary>
public sealed record ArtifactView(
    string Kind,
    string Full,
    string Root,
    string Url,
    string Title,
    string Stamp,
    long Size,
    long Modified,
    string? Html);

/// <summary>
/// Lit un fichier produit par un agent pour le montrer dans la fenetre, sans passer par un editeur.
/// Le Markdown est rendu en HTML (Markdig), un CSV devient un tableau, un texte un bloc preformate ;
/// pages, PDF et images sont servis tels quels par l'hote virtuel, dont la racine est le dossier de
/// travail de la session (ou celui du fichier s'il en sort), pour que leurs liens relatifs tiennent.
/// </summary>
public sealed class ArtifactReader
{
    /// <summary>Hote virtuel WebView2 sous lequel le dossier du rapport courant est servi.</summary>
    public const string Host = "report.organizator";

    public const string KindMarkdown = "markdown";
    public const string KindText = "text";
    public const string KindTable = "table";
    public const string KindHtml = "html";
    public const string KindPdf = "pdf";
    public const string KindImage = "image";
    public const string KindBinary = "binary";
    public const string KindLarge = "large";
    public const string KindMissing = "missing";

    // Au-dela, le rendu et le transfert vers l'UI ne valent plus la lecture dans un editeur.
    private const long MaxRenderedBytes = 3 * 1024 * 1024;
    private const int MaxTableRows = 5000;
    private const int SniffBytes = 8192;

    private static readonly string BaseUrl = "https://" + Host + "/";

    private static readonly MarkdownPipeline Pipeline = new MarkdownPipelineBuilder()
        .UsePipeTables()
        .UseGridTables()
        .UseTaskLists()
        .UseAutoLinks()
        .UseAutoIdentifiers(AutoIdentifierOptions.GitHub)
        .UseFootnotes()
        .UseEmphasisExtras()
        .UseListExtras()
        .UseDefinitionLists()
        .UseAbbreviations()
        .UseFigures()
        .Build();

    private static readonly HashSet<string> MarkdownExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        "md", "markdown", "mdown", "mkd", "mkdn",
    };

    private static readonly HashSet<string> ImageExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif",
    };

    private static readonly HashSet<string> BinaryExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        "xlsx", "xls", "xlsm", "docx", "doc", "pptx", "ppt", "odt", "ods", "odp", "rtf",
        "zip", "7z", "rar", "gz", "tar", "iso", "msi", "exe", "dll", "pdb", "bin", "jar", "class", "nupkg",
        "woff", "woff2", "ttf", "otf", "eot", "mp3", "mp4", "wav", "mov", "avi", "mkv", "webm",
        "db", "sqlite", "sqlite3", "dat", "pyc", "o", "obj", "lib", "so",
    };

    private readonly HostLog _log;

    public ArtifactReader(HostLog log)
    {
        _log = log;
    }

    /// <summary>Chemin complet d'un artefact tel que l'UI le connait (relatif au dossier de travail, ou absolu).</summary>
    public static string Resolve(string rawPath, string? cwd)
    {
        var path = rawPath.Trim();
        if (path.Length == 0)
        {
            throw new InvalidOperationException("Aucun chemin fourni.");
        }

        try
        {
            var root = cwd?.Trim();
            return Path.GetFullPath(
                Path.IsPathRooted(path) || string.IsNullOrWhiteSpace(root)
                    ? path
                    : Path.Combine(root!, path));
        }
        catch (Exception)
        {
            throw new InvalidOperationException("Chemin invalide : " + rawPath);
        }
    }

    public ArtifactView Read(string full, string? cwd)
    {
        var (root, url) = Locate(full, cwd);
        var name = Path.GetFileName(full);
        var info = new FileInfo(full);
        if (!info.Exists)
        {
            return new ArtifactView(KindMissing, full, root, url, name, "", 0, 0, null);
        }

        var stamp = TranscriptAccumulator.FileStamp(full);
        var modified = new DateTimeOffset(info.LastWriteTimeUtc).ToUnixTimeMilliseconds();
        var kind = KindOf(full);
        string? html = null;
        var title = name;

        try
        {
            switch (kind)
            {
                case KindMarkdown:
                case KindText:
                case KindTable:
                    if (info.Length > MaxRenderedBytes)
                    {
                        kind = KindLarge;
                        break;
                    }

                    var text = ReadText(full);
                    if (kind == KindMarkdown)
                    {
                        html = RenderMarkdown(text, DirectoryUrl(url), out var heading);
                        if (!string.IsNullOrWhiteSpace(heading))
                        {
                            title = heading!;
                        }
                    }
                    else if (kind == KindTable)
                    {
                        html = RenderTable(text, Extension(full));
                    }
                    else
                    {
                        html = "<pre class=\"text\">" + WebUtility.HtmlEncode(text) + "</pre>";
                    }

                    break;

                case KindImage:
                    // L'image est affichee dans le cadre isole, comme le Markdown : sous DenyCors, la page de
                    // l'application ne peut pas charger elle-meme une ressource de l'hote des rapports, le
                    // cadre (origine opaque) le peut. L'empreinte dans l'URL force le rechargement au changement.
                    html = "<figure class=\"image\"><img src=\""
                        + WebUtility.HtmlEncode(url + "?t=" + Uri.EscapeDataString(stamp))
                        + "\" alt=\"" + WebUtility.HtmlEncode(name) + "\"></figure>";
                    break;
            }
        }
        catch (IOException ex)
        {
            throw new InvalidOperationException("Lecture impossible : " + ex.Message);
        }
        catch (UnauthorizedAccessException ex)
        {
            throw new InvalidOperationException("Acces refuse : " + ex.Message);
        }

        return new ArtifactView(kind, full, root, url, title, stamp, info.Length, modified, html);
    }

    // ------------------------------------------------------------------ emplacement

    /// <summary>
    /// Racine servie par l'hote virtuel et URL du fichier sous cette racine. Un fichier du dossier
    /// de travail est servi depuis ce dossier, pour que ses liens relatifs (images, autres rapports)
    /// restent valables ; un fichier ecrit ailleurs n'expose que son propre dossier.
    /// </summary>
    private static (string Root, string Url) Locate(string full, string? cwd)
    {
        string root;
        string relative;

        var workDir = TryFullPath(cwd);
        if (workDir is not null && IsUnder(full, workDir))
        {
            root = workDir;
            relative = Path.GetRelativePath(workDir, full);
        }
        else
        {
            root = Path.GetDirectoryName(full) ?? Path.GetPathRoot(full) ?? full;
            relative = Path.GetFileName(full);
        }

        var segments = relative
            .Split(new[] { Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar }, StringSplitOptions.RemoveEmptyEntries)
            .Select(Uri.EscapeDataString);
        return (root, BaseUrl + string.Join("/", segments));
    }

    private static string? TryFullPath(string? path)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            return null;
        }

        try
        {
            return Path.GetFullPath(path.Trim()).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        }
        catch (Exception)
        {
            return null;
        }
    }

    private static bool IsUnder(string full, string root)
    {
        var prefix = root.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar;
        return full.StartsWith(prefix, StringComparison.OrdinalIgnoreCase);
    }

    private static string DirectoryUrl(string url)
    {
        var slash = url.LastIndexOf('/');
        return slash >= 0 ? url[..(slash + 1)] : BaseUrl;
    }

    // ------------------------------------------------------------------------ genre

    private static string Extension(string path)
    {
        var ext = Path.GetExtension(path);
        return ext.Length > 1 ? ext[1..] : "";
    }

    private string KindOf(string full)
    {
        var ext = Extension(full);
        if (MarkdownExtensions.Contains(ext))
        {
            return KindMarkdown;
        }

        if (ImageExtensions.Contains(ext))
        {
            return KindImage;
        }

        if (BinaryExtensions.Contains(ext))
        {
            return KindBinary;
        }

        switch (ext.ToLowerInvariant())
        {
            case "csv":
            case "tsv":
                return KindTable;
            case "html":
            case "htm":
                return KindHtml;
            case "pdf":
                return KindPdf;
        }

        return LooksBinary(full) ? KindBinary : KindText;
    }

    /// <summary>Un octet nul dans les premiers kilo-octets : ce n'est pas du texte.</summary>
    private bool LooksBinary(string full)
    {
        try
        {
            using var stream = new FileStream(full, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            var buffer = new byte[SniffBytes];
            var read = stream.Read(buffer, 0, buffer.Length);
            return Array.IndexOf(buffer, (byte)0, 0, read) >= 0;
        }
        catch (Exception ex)
        {
            _log.Warn($"Sondage de {Path.GetFileName(full)} impossible : {ex.Message}");
            return false;
        }
    }

    private static string ReadText(string full)
    {
        // Le fichier peut etre en cours d'ecriture par l'agent : on partage la lecture.
        using var stream = new FileStream(full, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        using var reader = new StreamReader(stream, Encoding.UTF8, detectEncodingFromByteOrderMarks: true);
        return reader.ReadToEnd();
    }

    // --------------------------------------------------------------------- markdown

    /// <summary>
    /// Rend le Markdown en HTML. Les liens relatifs sont recrits en URL absolues sous l'hote virtuel,
    /// pour que les images s'affichent et que les autres rapports s'ouvrent ; les schemas qui
    /// executeraient quelque chose (javascript:, vbscript:, file:) sont neutralises.
    /// </summary>
    internal static string RenderMarkdown(string text, string baseUrl, out string? heading)
    {
        var document = Markdown.Parse(text, Pipeline);
        heading = FirstHeading(document);

        var writer = new StringWriter();
        var renderer = new HtmlRenderer(writer) { LinkRewriter = link => RewriteLink(link, baseUrl) };
        Pipeline.Setup(renderer);
        renderer.Render(document);
        writer.Flush();
        return writer.ToString();
    }

    private static string? FirstHeading(MarkdownDocument document)
    {
        var heading = document.Descendants<HeadingBlock>().FirstOrDefault(h => h.Level == 1);
        if (heading?.Inline is null)
        {
            return null;
        }

        var text = new StringBuilder();
        foreach (var inline in heading.Inline.Descendants())
        {
            switch (inline)
            {
                case LiteralInline literal:
                    text.Append(literal.Content.ToString());
                    break;
                case CodeInline code:
                    text.Append(code.Content);
                    break;
            }
        }

        var result = text.ToString().Trim();
        return result.Length == 0 ? null : (result.Length > 120 ? result[..120] : result);
    }

    internal static string RewriteLink(string link, string baseUrl)
    {
        if (string.IsNullOrWhiteSpace(link))
        {
            return link;
        }

        var value = link.Trim();
        if (value.StartsWith('#'))
        {
            return value;
        }

        if (value.StartsWith("//", StringComparison.Ordinal))
        {
            return "#";
        }

        if (Uri.TryCreate(value, UriKind.Absolute, out var absolute))
        {
            // Une lettre de lecteur (C:\...) passe pour un schema d'une lettre : chemin local, hors racine.
            var scheme = absolute.Scheme.ToLowerInvariant();
            return scheme is "http" or "https" or "mailto" or "data" ? value : "#";
        }

        try
        {
            return new Uri(new Uri(baseUrl), value).AbsoluteUri;
        }
        catch (UriFormatException)
        {
            return "#";
        }
    }

    // ---------------------------------------------------------------------- tableau

    internal static string RenderTable(string text, string extension)
    {
        var delimiter = string.Equals(extension, "tsv", StringComparison.OrdinalIgnoreCase)
            ? '\t'
            : DetectDelimiter(text);
        var rows = ParseDelimited(text, delimiter, MaxTableRows + 1);
        var truncated = rows.Count > MaxTableRows;
        if (truncated)
        {
            rows.RemoveRange(MaxTableRows, rows.Count - MaxTableRows);
        }

        var html = new StringBuilder("<table class=\"data\">");
        for (var i = 0; i < rows.Count; i++)
        {
            var cell = i == 0 ? "th" : "td";
            if (i == 0)
            {
                html.Append("<thead>");
            }
            else if (i == 1)
            {
                html.Append("<tbody>");
            }

            html.Append("<tr>");
            foreach (var value in rows[i])
            {
                html.Append('<').Append(cell).Append('>').Append(WebUtility.HtmlEncode(value)).Append("</").Append(cell).Append('>');
            }

            html.Append("</tr>");
            if (i == 0)
            {
                html.Append("</thead>");
            }
        }

        if (rows.Count > 1)
        {
            html.Append("</tbody>");
        }

        html.Append("</table>");
        if (rows.Count == 0)
        {
            html.Append("<p class=\"note\">Fichier vide.</p>");
        }

        if (truncated)
        {
            html.Append("<p class=\"note\">Affichage limit\u00e9 aux ").Append(MaxTableRows).Append(" premi\u00e8res lignes.</p>");
        }

        return html.ToString();
    }

    private static char DetectDelimiter(string text)
    {
        var firstLine = text.Split('\n', 2)[0];
        var candidates = new[] { ';', ',', '\t', '|' };
        var best = ',';
        var bestCount = -1;
        foreach (var candidate in candidates)
        {
            var count = firstLine.Count(ch => ch == candidate);
            if (count > bestCount)
            {
                best = candidate;
                bestCount = count;
            }
        }

        return best;
    }

    /// <summary>Lecture RFC 4180 : guillemets doubles, guillemets doubles doubles, sauts de ligne dans une cellule.</summary>
    private static List<List<string>> ParseDelimited(string text, char delimiter, int maxRows)
    {
        var rows = new List<List<string>>();
        var row = new List<string>();
        var cell = new StringBuilder();
        var quoted = false;

        for (var i = 0; i < text.Length; i++)
        {
            var ch = text[i];
            if (quoted)
            {
                if (ch == '"')
                {
                    if (i + 1 < text.Length && text[i + 1] == '"')
                    {
                        cell.Append('"');
                        i++;
                    }
                    else
                    {
                        quoted = false;
                    }
                }
                else
                {
                    cell.Append(ch);
                }

                continue;
            }

            if (ch == '"' && cell.Length == 0)
            {
                quoted = true;
            }
            else if (ch == delimiter)
            {
                row.Add(cell.ToString());
                cell.Clear();
            }
            else if (ch == '\n' || ch == '\r')
            {
                if (ch == '\r' && i + 1 < text.Length && text[i + 1] == '\n')
                {
                    i++;
                }

                row.Add(cell.ToString());
                cell.Clear();
                if (row.Count > 1 || row[0].Length > 0)
                {
                    rows.Add(row);
                    if (rows.Count >= maxRows)
                    {
                        return rows;
                    }
                }

                row = new List<string>();
            }
            else
            {
                cell.Append(ch);
            }
        }

        if (cell.Length > 0 || row.Count > 0)
        {
            row.Add(cell.ToString());
            rows.Add(row);
        }

        return rows;
    }
}
