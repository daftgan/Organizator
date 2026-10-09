using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization.Metadata;
using System.Text.RegularExpressions;
using System.Xml;
using System.Xml.Linq;

namespace Organizator.Services;

/// <summary>
/// Menu du jour du cours d'anglais : l'hote lit lui-meme, en parallele, une douzaine de flux RSS
/// de presse anglophone et trois flux audio de BBC Learning English, et en fait un menu d'environ
/// 30 a 40 titres recents passe au prompt du cours (<see cref="LearningAgent"/>), plus 2 a 4
/// episodes audio authentiques. La fraicheur vient de la : l'index de WebSearch a un a deux jours
/// de retard, les flux sont a jour a l'heure pres.
///
/// Filtrage : doublons, live blogs, videos, revues de presse et lettres d'information, items de
/// plus de 48 h ; les titres « lourds » (guerre, mort, attentat...) sont marques <c>heavy</c>, pas
/// retires. <c>readable</c> dit si WebFetch peut ouvrir la page (beaucoup de grands titres lui sont
/// fermes : BBC, Guardian, Reuters...) ; les liens NPR sont reecrits vers <c>text.npr.org</c>,
/// seule version que WebFetch lit. Les mp3 de la BBC sont pris en https (la page est servie en
/// https et refuserait un audio en http).
///
/// Cache de 30 minutes dans <c>learning\news.json</c> ; une lecture en cours est partagee.
/// </summary>
public sealed class NewsMenu
{
    private static readonly TimeSpan CacheFor = TimeSpan.FromMinutes(30);
    private static readonly TimeSpan FeedTimeout = TimeSpan.FromSeconds(5);
    private static readonly TimeSpan MaxAge = TimeSpan.FromHours(48);
    private static readonly TimeSpan MaxAudioAge = TimeSpan.FromDays(21);
    private const int MenuMax = 40;
    private const int AudioMax = 4;

    private const string BrowserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0";

    /// <summary>Un flux de presse : nom affiche, adresse, nombre de titres retenus au plus.</summary>
    private sealed record Feed(string Source, string Url, int Take);

    /// <summary>Un flux audio de BBC Learning English : serie, adresse, niveau, episodes retenus.</summary>
    private sealed record AudioFeed(string Series, string Url, string Level, int Take);

    // Ordre = ordre du menu. Les plafonds font un menu varie (France, Royaume-Uni, monde, tech,
    // science, sport) d'environ 40 titres avant filtrage.
    private static readonly Feed[] Feeds =
    {
        new("BBC News", "https://feeds.bbci.co.uk/news/rss.xml", 5),
        new("BBC Technology", "https://feeds.bbci.co.uk/news/technology/rss.xml", 2),
        new("The Guardian UK", "https://www.theguardian.com/uk-news/rss", 3),
        new("France 24", "https://www.france24.com/en/rss", 5),
        new("Euronews", "https://www.euronews.com/rss", 5),
        new("Al Jazeera", "https://www.aljazeera.com/xml/rss/all.xml", 3),
        new("NPR", "https://feeds.npr.org/1001/rss.xml", 3),
        new("The Conversation", "https://theconversation.com/uk/articles.atom", 4),
        new("The Local France", "https://feeds.thelocal.com/rss/fr", 3),
        new("RTÉ", "https://www.rte.ie/feeds/rss/?index=/news/", 2),
        new("The Register", "https://www.theregister.com/headlines.atom", 2),
        new("Phys.org", "https://phys.org/rss-feed/", 2),
        new("ESPN", "https://www.espn.com/espn/rss/news", 2),
    };

    private static readonly AudioFeed[] AudioFeeds =
    {
        new("BBC 6 Minute English", "https://podcasts.files.bbci.co.uk/p02pc9tn.rss", "B1-B2", 2),
        new("BBC Learning English from the News", "https://podcasts.files.bbci.co.uk/p05hw4bq.rss", "B2", 1),
        new("BBC Learning Easy English", "https://podcasts.files.bbci.co.uk/p0hsrwv5.rss", "A2-B1", 1),
    };

    /// <summary>Domaines que WebFetch lit en entier (teste le 8 octobre 2026, voir sources.md §2).</summary>
    public static readonly string[] ReadableDomains =
    {
        "france24.com", "euronews.com", "aljazeera.com", "text.npr.org", "theconversation.com", "rte.ie",
        "abc.net.au", "connexionfrance.com", "thelocal.fr", "thelocal.com", "adn.com", "wunc.org", "techcrunch.com",
        "theregister.com", "technologyreview.com", "restofworld.org", "phys.org", "sciencedaily.com", "snexplores.org",
        "nasa.gov", "espn.com", "positive.news", "britishcouncil.org",
    };

    /// <summary>Domaines qui refusent WebFetch : un titre qui en vient se lit sur une autre redaction.</summary>
    public static readonly string[] BlockedDomains =
    {
        "bbc.co.uk", "bbc.com", "bbci.co.uk", "theguardian.com", "guardianapis.com", "reuters.com", "apnews.com",
        "economist.com", "independent.co.uk", "sky.com", "rfi.fr", "dw.com", "lemonde.fr", "theverge.com", "wired.com",
        "arstechnica.com", "www.npr.org", "cbc.ca", "cnn.com",
    };

    private static readonly HttpClient Http = CreateClient();

    private static readonly JsonSerializerOptions FileJson = new()
    {
        WriteIndented = true,
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        TypeInfoResolver = new DefaultJsonTypeInfoResolver(),
    };

    private static readonly Regex Tags = new("<[^>]+>", RegexOptions.CultureInvariant);
    private static readonly Regex Spaces = new(@"\s+", RegexOptions.CultureInvariant);
    private static readonly Regex NprStory = new(@"^https?://(?:www\.)?npr\.org/(?:sections/[^/]+/)?\d{4}/\d{2}/\d{2}/([A-Za-z0-9-]+)", RegexOptions.CultureInvariant | RegexOptions.IgnoreCase);
    private static readonly Regex LearningPage = new(@"https://www\.bbc\.co\.uk/learningenglish/[^\s""'<>]+", RegexOptions.CultureInvariant);

    private static readonly Regex LiveTitle = new(@"(^\s*(🔴|live\b)|\blive( updates| blog|:)|[-–—]\s*live\s*$|as it happened|\blive\s*$)", RegexOptions.CultureInvariant | RegexOptions.IgnoreCase);
    private static readonly Regex LiveUrl = new(@"(/live/|/live-|liveblog|live-blog|live-updates|/newsletter|newsletter-|sponsored|/partner-content|/advertorial)", RegexOptions.CultureInvariant | RegexOptions.IgnoreCase);
    private static readonly Regex VideoUrl = new(@"(/video/|/videos/|/av/|/tv-shows/|/programmes/|/sounds/|/podcasts?/|/watch/|/gallery/|/in-pictures)", RegexOptions.CultureInvariant | RegexOptions.IgnoreCase);
    private static readonly Regex VideoTitle = new(@"^\s*(watch|video|listen|in pictures|in photos|pictures of the|podcast)\b", RegexOptions.CultureInvariant | RegexOptions.IgnoreCase);
    private static readonly Regex DigestTitle = new(@"(press review|the papers\b|newspaper headlines|front pages|what the papers|morning briefing|evening briefing|news ?quiz|quiz of the week|crossword|weather forecast|^\s*weather\b|^\s*letters?\b|newsletter|^\s*the latest\s*:|up first)", RegexOptions.CultureInvariant | RegexOptions.IgnoreCase);

    /// <summary>Titres « lourds » : marques dans le menu, le cours les evite ou les aborde sous un angle constructif.</summary>
    private static readonly Regex HeavyTitle = new(
        @"\b(kill(s|ed|ing|er|ers)?|dead|deaths?|dies|died|dying|murder(s|ed|er)?|shoot(ing|ings)?|shot|stabb(ed|ing)|attacks?|attacked|strikes? on|air ?strikes?|drone strikes?|drones hit|bomb(s|ed|ing|ings)?|explosions?|massacres?|terror(ism|ist|ists)?|hostages?|rap(e|ed|ist)|abuse[ds]?|suicide|own lives|drown(ed|ing|s)?|fatal|war|wars|genocide|missiles?|victims?|injured|wounded|execut(ed|ion|ions)|famine|ebola|outbreak|funeral|massacre|casualt(y|ies)|corpses?|bodies)\b",
        RegexOptions.CultureInvariant | RegexOptions.IgnoreCase);

    private readonly LearningStore _store;
    private readonly HostLog _log;
    private readonly object _gate = new();
    private Task<JsonObject>? _running;

    public NewsMenu(LearningStore store, HostLog log)
    {
        _store = store;
        _log = log;
    }

    /// <summary>
    /// Le menu : <c>{ fetchedAt, items: [{ source, title, url, readable, published, heavy }], audio:
    /// [{ series, title, published, level, minutes, summary, mp3, page }] }</c>. Le cache de moins de
    /// 30 minutes est rendu tel quel, sauf <paramref name="force"/>. Si plus aucun flux ne repond, le
    /// dernier cache est rendu, meme ancien. Chaque appelant recoit sa copie : une meme lecture peut
    /// repondre a plusieurs messages, et un noeud JSON n'a qu'un parent.
    /// </summary>
    public async Task<JsonObject> GetAsync(bool force)
    {
        var menu = await SharedAsync(force).ConfigureAwait(false);
        return (JsonObject)menu.DeepClone();
    }

    private Task<JsonObject> SharedAsync(bool force)
    {
        lock (_gate)
        {
            if (_running is not null)
            {
                return _running;
            }

            if (!force && ReadCache() is { } cached && Age(cached) < CacheFor)
            {
                return Task.FromResult(cached);
            }

            var run = Task.Run(FetchAsync);
            _running = run;
            _ = run.ContinueWith(_ =>
            {
                lock (_gate)
                {
                    if (ReferenceEquals(_running, run))
                    {
                        _running = null;
                    }
                }
            }, TaskScheduler.Default);
            return run;
        }
    }

    /// <summary>Vrai si la page est lisible par WebFetch (domaine de <see cref="ReadableDomains"/>).</summary>
    public static bool IsReadable(string? url) => HostMatches(url, ReadableDomains);

    /// <summary>Vrai si la page vient d'un site ferme a WebFetch (<see cref="BlockedDomains"/>).</summary>
    public static bool IsBlocked(string? url) => HostMatches(url, BlockedDomains);

    private static bool HostMatches(string? url, string[] domains)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri))
        {
            return false;
        }

        var host = uri.Host.ToLowerInvariant();
        foreach (var domain in domains)
        {
            if (host == domain || host.EndsWith("." + domain, StringComparison.Ordinal))
            {
                return true;
            }

            // « www.npr.org » est ferme, « text.npr.org » ouvert : un domaine prefixe par www. ne
            // vaut que pour lui-meme et le domaine nu.
            if (domain.StartsWith("www.", StringComparison.Ordinal) && host == domain[4..])
            {
                return true;
            }
        }

        return false;
    }

    // ------------------------------------------------------------------ lecture

    private async Task<JsonObject> FetchAsync()
    {
        var started = Stopwatch.StartNew();
        var news = Feeds.Select(f => ReadFeedAsync(f.Url)).ToArray();
        var audio = AudioFeeds.Select(f => ReadFeedAsync(f.Url)).ToArray();
        await Task.WhenAll(news.Concat(audio)).ConfigureAwait(false);

        var now = DateTimeOffset.Now;
        var items = new JsonArray();
        var seenTitles = new HashSet<string>(StringComparer.Ordinal);
        var seenUrls = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var failed = new List<string>();
        var answered = 0;

        for (var i = 0; i < Feeds.Length; i++)
        {
            var feed = Feeds[i];
            var entries = news[i].Result;
            if (entries is null)
            {
                failed.Add(feed.Source);
                continue;
            }

            answered++;
            var taken = 0;
            foreach (var entry in entries.Where(e => e.Published is not null).OrderByDescending(e => e.Published))
            {
                if (taken >= feed.Take || items.Count >= MenuMax)
                {
                    break;
                }

                var url = CleanUrl(entry.Link);
                var title = entry.Title;
                if (title.Length < 12 || url.Length == 0 || now - entry.Published!.Value > MaxAge || entry.Published > now.AddHours(2))
                {
                    continue;
                }

                if (LiveTitle.IsMatch(title) || LiveUrl.IsMatch(url) || VideoUrl.IsMatch(url) || VideoTitle.IsMatch(title) || DigestTitle.IsMatch(title))
                {
                    continue;
                }

                var key = TitleKey(title);
                if (!seenTitles.Add(key) || !seenUrls.Add(url))
                {
                    continue;
                }

                items.Add(new JsonObject
                {
                    ["source"] = feed.Source,
                    ["title"] = title,
                    ["url"] = url,
                    ["readable"] = IsReadable(url),
                    ["published"] = Iso(entry.Published.Value),
                    ["heavy"] = HeavyTitle.IsMatch(title),
                });
                taken++;
            }
        }

        var episodes = new JsonArray();
        for (var i = 0; i < AudioFeeds.Length; i++)
        {
            var feed = AudioFeeds[i];
            var entries = audio[i].Result;
            if (entries is null)
            {
                failed.Add(feed.Series);
                continue;
            }

            answered++;
            foreach (var entry in entries.Where(e => e.Published is not null && e.Mp3.Length > 0)
                         .OrderByDescending(e => e.Published).Take(feed.Take))
            {
                if (now - entry.Published!.Value > MaxAudioAge || episodes.Count >= AudioMax)
                {
                    continue;
                }

                episodes.Add(new JsonObject
                {
                    ["series"] = feed.Series,
                    ["title"] = entry.Title,
                    ["published"] = Iso(entry.Published.Value),
                    ["level"] = feed.Level,
                    ["minutes"] = entry.Seconds > 0 ? (int)Math.Max(1, Math.Round(entry.Seconds / 60.0)) : 0,
                    ["summary"] = Clip(entry.Summary, 420),
                    ["mp3"] = entry.Mp3,
                    ["page"] = entry.Page,
                });
            }
        }

        started.Stop();
        if (answered == 0)
        {
            var stale = ReadCache();
            _log.Warn($"Menu RSS : aucun flux n'a repondu en {started.ElapsedMilliseconds} ms" + (stale is null ? "." : ", ancien menu rendu."));
            if (stale is not null)
            {
                return stale;
            }

            throw new InvalidOperationException("Aucun flux d’actualité n’a répondu : vérifiez la connexion à Internet.");
        }

        var menu = new JsonObject
        {
            ["fetchedAt"] = DateTimeOffset.Now.ToUnixTimeMilliseconds(),
            ["items"] = items,
            ["audio"] = episodes,
        };

        _log.Info($"Menu RSS : {items.Count} titres, {episodes.Count} episodes audio en {started.ElapsedMilliseconds} ms"
            + (failed.Count > 0 ? " (sans reponse : " + string.Join(", ", failed) + ")." : "."));
        WriteCache(menu);
        return (JsonObject)menu.DeepClone();
    }

    /// <summary>Un item de flux, RSS 2.0 ou Atom, deja nettoye.</summary>
    private sealed record Entry(string Title, string Link, DateTimeOffset? Published, string Summary, string Mp3, string Page, int Seconds);

    /// <summary>Lit un flux ; <c>null</c> s'il ne repond pas en 5 s ou s'il est illisible.</summary>
    private async Task<List<Entry>?> ReadFeedAsync(string url)
    {
        try
        {
            using var cts = new CancellationTokenSource(FeedTimeout);
            using var response = await Http.GetAsync(url, HttpCompletionOption.ResponseContentRead, cts.Token).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
            {
                _log.Warn($"Flux {url} : HTTP {(int)response.StatusCode}");
                return null;
            }

            var bytes = await response.Content.ReadAsByteArrayAsync(cts.Token).ConfigureAwait(false);
            return Parse(bytes);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or OperationCanceledException or XmlException or IOException)
        {
            _log.Warn($"Flux {url} illisible : {ex.GetType().Name} {ex.Message}");
            return null;
        }
    }

    private static List<Entry> Parse(byte[] bytes)
    {
        var settings = new XmlReaderSettings { DtdProcessing = DtdProcessing.Ignore, XmlResolver = null, IgnoreComments = true };
        using var stream = new MemoryStream(bytes);
        using var reader = XmlReader.Create(stream, settings);
        var document = XDocument.Load(reader);
        var root = document.Root ?? throw new XmlException("Flux vide.");

        var entries = new List<Entry>();
        var nodes = root.Descendants().Where(e => e.Name.LocalName is "item" or "entry");
        foreach (var node in nodes)
        {
            var title = Text(Child(node, "title"));
            var link = LinkOf(node);
            var date = ParseDate(Child(node, "pubDate")?.Value ?? Child(node, "published")?.Value ?? Child(node, "updated")?.Value ?? Child(node, "date")?.Value);
            var rawSummary = Child(node, "summary")?.Value ?? Child(node, "description")?.Value ?? "";
            var summary = FirstParagraph(rawSummary);
            var mp3 = Mp3Of(node);
            var page = LearningPage.Match(rawSummary + " " + (Child(node, "description")?.Value ?? "")) is { Success: true } m
                ? m.Value.TrimEnd('.', ')', ',')
                : SecureUrl(link);
            var seconds = int.TryParse(Child(node, "duration")?.Value?.Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var s) ? s : 0;
            entries.Add(new Entry(title, link, date, summary, mp3, page, seconds));
        }

        return entries;
    }

    private static XElement? Child(XElement node, string localName)
        => node.Elements().FirstOrDefault(e => e.Name.LocalName == localName);

    private static string LinkOf(XElement node)
    {
        foreach (var link in node.Elements().Where(e => e.Name.LocalName == "link"))
        {
            var href = (string?)link.Attribute("href");
            var rel = (string?)link.Attribute("rel") ?? "alternate";
            if (!string.IsNullOrWhiteSpace(href) && rel == "alternate")
            {
                return href.Trim();
            }

            if (string.IsNullOrWhiteSpace(href) && link.Value.Trim().Length > 0)
            {
                return link.Value.Trim();
            }
        }

        var guid = Child(node, "guid")?.Value?.Trim() ?? "";
        return guid.StartsWith("http", StringComparison.OrdinalIgnoreCase) ? guid : "";
    }

    /// <summary>mp3 en https : <c>enclosureSecure</c> de la BBC, sinon l'enclosure reecrite en https.</summary>
    private static string Mp3Of(XElement node)
    {
        var secure = node.Elements().FirstOrDefault(e => e.Name.LocalName == "enclosureSecure");
        var url = (string?)secure?.Attribute("url");
        if (string.IsNullOrWhiteSpace(url))
        {
            url = (string?)node.Elements().FirstOrDefault(e => e.Name.LocalName == "enclosure")?.Attribute("url");
        }

        return string.IsNullOrWhiteSpace(url) ? "" : SecureUrl(url.Trim());
    }

    private static string SecureUrl(string url)
    {
        if (url.StartsWith("http://", StringComparison.OrdinalIgnoreCase))
        {
            url = "https://" + url[7..];
        }

        return url.Replace("/proto/http/", "/proto/https/", StringComparison.Ordinal);
    }

    /// <summary>Adresse sans requete ni ancre (traceurs RSS), NPR reecrite vers text.npr.org.</summary>
    private static string CleanUrl(string link)
    {
        if (!Uri.TryCreate(link, UriKind.Absolute, out var uri) || uri.Scheme is not ("http" or "https"))
        {
            return "";
        }

        var url = uri.GetLeftPart(UriPartial.Path);
        var npr = NprStory.Match(url);
        if (npr.Success)
        {
            return "https://text.npr.org/" + npr.Groups[1].Value;
        }

        return SecureUrl(url);
    }

    private static string TitleKey(string title)
    {
        var sb = new StringBuilder();
        foreach (var c in title.ToLowerInvariant())
        {
            if (char.IsLetterOrDigit(c))
            {
                sb.Append(c);
            }
        }

        var key = sb.ToString();
        return key.Length > 60 ? key[..60] : key;
    }

    private static string Text(XElement? element)
        => element is null ? "" : Clip(WebUtility.HtmlDecode(Spaces.Replace(Tags.Replace(element.Value, " "), " ")).Trim(), 240);

    private static string FirstParagraph(string html)
    {
        var text = html ?? "";
        var end = text.IndexOf("</p>", StringComparison.OrdinalIgnoreCase);
        if (end > 0)
        {
            text = text[..end];
        }

        return WebUtility.HtmlDecode(Spaces.Replace(Tags.Replace(text, " "), " ")).Trim();
    }

    private static readonly string[] DateFormats =
    {
        "ddd, d MMM yyyy HH:mm:ss zzz", "ddd, dd MMM yyyy HH:mm:ss zzz", "d MMM yyyy HH:mm:ss zzz",
        "ddd, d MMM yyyy HH:mm zzz", "ddd, dd MMM yyyy HH:mm zzz", "ddd, d MMM yyyy HH:mm:ss", "ddd, dd MMM yyyy HH:mm:ss",
    };

    private static readonly Regex NumericOffset = new(@"([+-])(\d{2})(\d{2})$", RegexOptions.CultureInvariant);

    /// <summary>Dates RFC 822 (RSS, avec GMT, UT, EST... ou +0100) et ISO 8601 (Atom).</summary>
    internal static DateTimeOffset? ParseDate(string? value)
    {
        var text = (value ?? "").Trim();
        if (text.Length == 0)
        {
            return null;
        }

        if (DateTimeOffset.TryParse(text, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var iso) && text.Contains('-') && !text.Contains(','))
        {
            return iso;
        }

        var normalized = text
            .Replace(" GMT", " +00:00", StringComparison.OrdinalIgnoreCase)
            .Replace(" UTC", " +00:00", StringComparison.OrdinalIgnoreCase)
            .Replace(" UT", " +00:00", StringComparison.Ordinal)
            .Replace(" Z", " +00:00", StringComparison.Ordinal)
            .Replace(" EDT", " -04:00", StringComparison.Ordinal)
            .Replace(" EST", " -05:00", StringComparison.Ordinal)
            .Replace(" CDT", " -05:00", StringComparison.Ordinal)
            .Replace(" CST", " -06:00", StringComparison.Ordinal)
            .Replace(" PDT", " -07:00", StringComparison.Ordinal)
            .Replace(" PST", " -08:00", StringComparison.Ordinal)
            .Replace(" BST", " +01:00", StringComparison.Ordinal)
            .Replace(" CEST", " +02:00", StringComparison.Ordinal)
            .Replace(" CET", " +01:00", StringComparison.Ordinal);
        normalized = NumericOffset.Replace(normalized, "$1$2:$3");

        if (DateTimeOffset.TryParseExact(normalized, DateFormats, CultureInfo.InvariantCulture, DateTimeStyles.AllowWhiteSpaces | DateTimeStyles.AssumeUniversal, out var rfc))
        {
            return rfc;
        }

        return DateTimeOffset.TryParse(normalized, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var any) ? any : null;
    }

    private static string Iso(DateTimeOffset value)
        => value.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture);

    private static TimeSpan Age(JsonObject menu)
        => menu["fetchedAt"] is JsonValue v && v.GetValueKind() == JsonValueKind.Number && long.TryParse(v.ToJsonString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var at)
            ? TimeSpan.FromMilliseconds(Math.Max(0, DateTimeOffset.Now.ToUnixTimeMilliseconds() - at))
            : TimeSpan.MaxValue;

    // ------------------------------------------------------------------- cache

    private JsonObject? ReadCache()
    {
        try
        {
            if (File.Exists(_store.NewsPath)
                && JsonNode.Parse(File.ReadAllText(_store.NewsPath, Encoding.UTF8)) is JsonObject menu
                && menu["items"] is JsonArray
                && menu["audio"] is JsonArray)
            {
                return menu;
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        {
            _log.Warn("news.json illisible, ignore : " + ex.Message);
        }

        return null;
    }

    private void WriteCache(JsonObject menu)
    {
        try
        {
            var path = _store.NewsPath;
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            var tmp = path + ".tmp";
            File.WriteAllText(tmp, menu.ToJsonString(FileJson), new UTF8Encoding(false));
            File.Move(tmp, path, overwrite: true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            _log.Warn("Ecriture de news.json impossible : " + ex.Message);
        }
    }

    private static HttpClient CreateClient()
    {
        var handler = new HttpClientHandler
        {
            AutomaticDecompression = DecompressionMethods.All,
            AllowAutoRedirect = true,
            MaxAutomaticRedirections = 5,
        };
        var client = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(15) };
        client.DefaultRequestHeaders.UserAgent.ParseAdd(BrowserAgent);
        client.DefaultRequestHeaders.Accept.ParseAdd("application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5");
        client.DefaultRequestHeaders.AcceptLanguage.ParseAdd("en-GB,en;q=0.9");
        return client;
    }

    private static string Clip(string? value, int max)
    {
        var text = (value ?? "").Trim();
        return text.Length <= max ? text : text[..max].TrimEnd() + "…";
    }
}
