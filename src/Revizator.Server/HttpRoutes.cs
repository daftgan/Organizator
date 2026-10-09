using System.Text;
using Microsoft.AspNetCore.StaticFiles;
using Microsoft.Net.Http.Headers;
using Organizator.Services;

namespace Revizator.Server;

/// <summary>
/// Routes HTTP du serveur (§ 3 du contrat) : sante, appairage, page avec ses deux injections, fichiers
/// statiques de la page, dossiers <c>learning/</c> et cache TTS (cookie ou jeton dans le chemin), WebSocket.
/// Aucun chemin ne sort de son dossier racine.
/// </summary>
public sealed class HttpRoutes
{
    public const string CookieName = "rz_token";

    private static readonly TimeSpan CookieLifetime = TimeSpan.FromDays(400);

    private static readonly FileExtensionContentTypeProvider ContentTypes = CreateContentTypes();

    private readonly ServerConfig _config;
    private readonly TokenStore _tokens;
    private readonly FailureLimiter _limiter;
    private readonly ServerBridge _bridge;
    private readonly WsHub _hub;
    private readonly HostLog _log;

    public HttpRoutes(ServerConfig config, TokenStore tokens, FailureLimiter limiter, ServerBridge bridge, WsHub hub, HostLog log)
    {
        _config = config;
        _tokens = tokens;
        _limiter = limiter;
        _bridge = bridge;
        _hub = hub;
        _log = log;
    }

    private static FileExtensionContentTypeProvider CreateContentTypes()
    {
        var provider = new FileExtensionContentTypeProvider();
        provider.Mappings[".webmanifest"] = "application/manifest+json";
        provider.Mappings[".wav"] = "audio/wav";
        provider.Mappings[".json"] = "application/json; charset=utf-8";
        provider.Mappings[".js"] = "text/javascript; charset=utf-8";
        provider.Mappings[".css"] = "text/css; charset=utf-8";
        provider.Mappings[".html"] = "text/html; charset=utf-8";
        return provider;
    }

    public async Task HandleAsync(HttpContext context)
    {
        var request = context.Request;
        var response = context.Response;
        var path = request.Path.Value ?? "/";
        response.Headers["X-Content-Type-Options"] = "nosniff";
        response.Headers["Referrer-Policy"] = "no-referrer";

        // CORS : seulement pour les origines autorisees, et seulement la ou la page d'Organizator lit.
        var corsPath = path == "/api/health" || path.StartsWith("/learn/", StringComparison.Ordinal)
            || path.StartsWith("/tts/", StringComparison.Ordinal) || path.StartsWith("/t/", StringComparison.Ordinal);
        if (corsPath)
        {
            var origin = request.Headers.Origin.ToString().TrimEnd('/');
            if (origin.Length > 0 && _config.AllowedOrigins.Contains(origin))
            {
                response.Headers.AccessControlAllowOrigin = origin;
                response.Headers.AccessControlExposeHeaders = "Content-Length, Content-Range, Accept-Ranges";
                response.Headers.Vary = "Origin";
            }

            if (HttpMethods.IsOptions(request.Method))
            {
                response.Headers.AccessControlAllowMethods = "GET, HEAD, OPTIONS";
                response.Headers.AccessControlAllowHeaders = "Range, Content-Type";
                response.Headers.AccessControlMaxAge = "600";
                response.StatusCode = StatusCodes.Status204NoContent;
                return;
            }
        }

        if (path == "/api/ws")
        {
            await WebSocketAsync(context).ConfigureAwait(false);
            return;
        }

        if (!HttpMethods.IsGet(request.Method) && !HttpMethods.IsHead(request.Method))
        {
            response.StatusCode = StatusCodes.Status405MethodNotAllowed;
            return;
        }

        if (path == "/api/health")
        {
            await response.WriteAsJsonAsync(new { ok = true, version = ServerConfig.Version }).ConfigureAwait(false);
            return;
        }

        if (path == "/pair")
        {
            await PairAsync(context).ConfigureAwait(false);
            return;
        }

        if (path is "/" or "/index.html")
        {
            await IndexAsync(context).ConfigureAwait(false);
            return;
        }

        if (path == "/revizator-server.js")
        {
            NoCache(response);
            response.ContentType = "text/javascript; charset=utf-8";
            var settings = "window.REVIZATOR_SERVER = { mode: 'revizator', version: '" + ServerConfig.Version + "', wsUrl: '/api/ws' };\n";
            await response.WriteAsync(settings).ConfigureAwait(false);
            return;
        }

        if (path.StartsWith("/learn/", StringComparison.Ordinal) || path.StartsWith("/tts/", StringComparison.Ordinal))
        {
            if (await CookieDeviceAsync(context).ConfigureAwait(false) is null)
            {
                return;
            }

            await PrivateFileAsync(context, path).ConfigureAwait(false);
            return;
        }

        if (path.StartsWith("/t/", StringComparison.Ordinal))
        {
            // /t/<jeton>/learn/... ou /t/<jeton>/tts/... : le jeton est dans le chemin (balises <audio> du PC).
            var rest = path[3..];
            var slash = rest.IndexOf('/');
            var token = slash < 0 ? rest : rest[..slash];
            if (!Authorize(context, token, out _))
            {
                await DenyAsync(context).ConfigureAwait(false);
                return;
            }

            await PrivateFileAsync(context, slash < 0 ? "/" : rest[slash..]).ConfigureAwait(false);
            return;
        }

        if (path.StartsWith("/api/", StringComparison.Ordinal) || path.StartsWith("/pair/", StringComparison.Ordinal))
        {
            response.StatusCode = StatusCodes.Status404NotFound;
            return;
        }

        // Fichiers de la page : aucune donnee personnelle, sans authentification.
        var file = SafeFile(_config.WwwRoot, path);
        if (file is null)
        {
            response.StatusCode = StatusCodes.Status404NotFound;
            return;
        }

        if (path == "/sw.js")
        {
            NoCache(response);
        }

        await SendFileAsync(context, file).ConfigureAwait(false);
    }

    // ------------------------------------------------------------------ authentification

    /// <summary>
    /// Verifie un jeton presente ; un echec compte pour l'adresse du client. Au-dela de 10 echecs par
    /// minute, refus (429) sans meme regarder le jeton.
    /// </summary>
    private bool Authorize(HttpContext context, string? token, out string? device)
    {
        device = null;
        var ip = FailureLimiter.ClientIp(context);
        if (_limiter.Blocked(ip))
        {
            context.Items["rz-blocked"] = true;
            return false;
        }

        device = _tokens.Validate(token);
        if (device is null)
        {
            _limiter.Fail(ip);
            _log.Warn($"Jeton refuse ({ip}, {context.Request.Path})");
            return false;
        }

        return true;
    }

    private static async Task DenyAsync(HttpContext context, string? message = null)
    {
        var blocked = context.Items.ContainsKey("rz-blocked");
        context.Response.StatusCode = blocked ? StatusCodes.Status429TooManyRequests : StatusCodes.Status401Unauthorized;
        context.Response.ContentType = "text/plain; charset=utf-8";
        await context.Response.WriteAsync(blocked
            ? "Trop d'essais : réessayez dans une minute."
            : message ?? "Appareil non appairé.").ConfigureAwait(false);
    }

    /// <summary>L'appareil du cookie, sinon reponse 401 (ou 429) deja ecrite et null.</summary>
    private async Task<string?> CookieDeviceAsync(HttpContext context)
    {
        var cookie = context.Request.Cookies[CookieName];
        if (string.IsNullOrEmpty(cookie))
        {
            await DenyAsync(context).ConfigureAwait(false);
            return null;
        }

        if (!Authorize(context, cookie, out var device))
        {
            await DenyAsync(context).ConfigureAwait(false);
            return null;
        }

        return device;
    }

    private static bool IsHttps(HttpRequest request)
        => request.IsHttps || string.Equals(request.Headers["X-Forwarded-Proto"].ToString().Split(',')[0].Trim(), "https", StringComparison.OrdinalIgnoreCase);

    /// <summary><c>/pair?token=…</c> : pose le cookie de l'appareil et renvoie vers la page.</summary>
    private async Task PairAsync(HttpContext context)
    {
        var token = context.Request.Query["token"].ToString();
        if (!Authorize(context, token, out var device))
        {
            context.Response.ContentType = "text/html; charset=utf-8";
            context.Response.StatusCode = context.Items.ContainsKey("rz-blocked") ? StatusCodes.Status429TooManyRequests : StatusCodes.Status401Unauthorized;
            await context.Response.WriteAsync(Page("Lien d'appairage invalide",
                "Ce lien n'est pas (ou plus) valable. Créez-en un nouveau sur le serveur : <code>revizator-server token new &lt;appareil&gt;</code>.")).ConfigureAwait(false);
            return;
        }

        context.Response.Cookies.Append(CookieName, token, new CookieOptions
        {
            HttpOnly = true,
            Secure = IsHttps(context.Request),
            SameSite = Microsoft.AspNetCore.Http.SameSiteMode.Lax,
            MaxAge = CookieLifetime,
            Path = "/",
            IsEssential = true,
        });
        _log.Info($"Appareil appaire : {device} ({FailureLimiter.ClientIp(context)})");
        NoCache(context.Response);
        context.Response.Redirect("/", permanent: false);
    }

    /// <summary>La page, avec ses deux injections ; sans cookie valide, la petite page « appareil non appairé ».</summary>
    private async Task IndexAsync(HttpContext context)
    {
        var response = context.Response;
        NoCache(response);
        response.ContentType = "text/html; charset=utf-8";
        var cookie = context.Request.Cookies[CookieName];
        if (string.IsNullOrEmpty(cookie) || !Authorize(context, cookie, out _))
        {
            var blocked = context.Items.ContainsKey("rz-blocked");
            response.StatusCode = blocked ? StatusCodes.Status429TooManyRequests : StatusCodes.Status401Unauthorized;
            await response.WriteAsync(blocked
                ? Page("Trop d'essais", "Réessayez dans une minute.")
                : Page("Appareil non appairé",
                    "Pour utiliser Révizator ici, ouvrez le lien d'appairage (ou scannez son QR code) créé sur le serveur avec "
                    + "<code>revizator-server token new &lt;appareil&gt;</code>.")).ConfigureAwait(false);
            return;
        }

        var file = SafeFile(_config.WwwRoot, "/index.html");
        if (file is null)
        {
            response.StatusCode = StatusCodes.Status500InternalServerError;
            await response.WriteAsync("index.html introuvable.").ConfigureAwait(false);
            return;
        }

        var html = Inject(await File.ReadAllTextAsync(file, Encoding.UTF8).ConfigureAwait(false));
        if (!HttpMethods.IsHead(context.Request.Method))
        {
            await response.WriteAsync(html).ConfigureAwait(false);
        }
    }

    /// <summary>
    /// Les deux injections du § 3 : <c>revizator-server.js</c> avant <c>bridge.js</c>, manifeste, couleur,
    /// icone et <c>mobile.css</c> avant <c>&lt;/head&gt;</c>. L'hote WPF sert la page telle quelle.
    /// </summary>
    public static string Inject(string html)
    {
        const string bridge = "<script src=\"bridge.js\"></script>";
        var at = html.IndexOf(bridge, StringComparison.Ordinal);
        if (at >= 0)
        {
            html = html.Insert(at, "<script src=\"revizator-server.js\"></script>\n");
        }

        const string head = "</head>";
        var end = html.IndexOf(head, StringComparison.OrdinalIgnoreCase);
        if (end >= 0)
        {
            html = html.Insert(end, "<link rel=\"manifest\" href=\"manifest.webmanifest\">\n"
                + "<meta name=\"theme-color\" content=\"#f5ead8\">\n"
                + "<link rel=\"apple-touch-icon\" href=\"icons/icon-192.png\">\n"
                + "<link rel=\"icon\" type=\"image/png\" href=\"icons/icon-192.png\">\n"
                + "<link rel=\"stylesheet\" href=\"mobile.css\">\n");
        }

        return html;
    }

    private static string Page(string title, string body)
        => "<!DOCTYPE html><html lang=\"fr\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
            + "<title>Révizator</title><style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;"
            + "background:#f5ead8;color:#2b2118;font-family:system-ui,sans-serif;padding:24px;box-sizing:border-box}"
            + "main{max-width:420px}h1{font-size:1.4rem}code{background:#fff6;padding:2px 4px;border-radius:4px}</style></head>"
            + "<body><main><h1>" + title + "</h1><p>" + body + "</p></main></body></html>";

    // ------------------------------------------------------------------ WebSocket

    /// <summary>
    /// <c>/api/ws</c> : jeton par <c>?token=</c> (Organizator sur le PC) ou par le cookie (page servie ici).
    /// Avec le cookie, l'origine doit etre celle du serveur : une autre page du meme site ne s'en sert pas.
    /// </summary>
    private async Task WebSocketAsync(HttpContext context)
    {
        if (!context.WebSockets.IsWebSocketRequest)
        {
            context.Response.StatusCode = StatusCodes.Status400BadRequest;
            return;
        }

        var query = context.Request.Query["token"].ToString();
        string? device;
        if (query.Length > 0)
        {
            if (!Authorize(context, query, out device))
            {
                await DenyAsync(context).ConfigureAwait(false);
                return;
            }
        }
        else
        {
            var origin = context.Request.Headers.Origin.ToString().TrimEnd('/');
            if (origin.Length > 0 && !SameOrigin(context.Request, origin) && !_config.AllowedOrigins.Contains(origin))
            {
                _log.Warn($"WebSocket refuse : origine {origin}");
                context.Response.StatusCode = StatusCodes.Status403Forbidden;
                return;
            }

            device = await CookieDeviceAsync(context).ConfigureAwait(false);
            if (device is null)
            {
                return;
            }
        }

        using var socket = await context.WebSockets.AcceptWebSocketAsync().ConfigureAwait(false);
        await _hub.RunAsync(socket, device!, context.RequestAborted).ConfigureAwait(false);
    }

    private bool SameOrigin(HttpRequest request, string origin)
    {
        if (!Uri.TryCreate(origin, UriKind.Absolute, out var uri))
        {
            return false;
        }

        var host = request.Headers["X-Forwarded-Host"].ToString().Split(',')[0].Trim();
        if (host.Length == 0)
        {
            host = request.Host.Value ?? "";
        }

        var originHost = uri.IsDefaultPort ? uri.Host : uri.Host + ":" + uri.Port;
        return string.Equals(originHost, host, StringComparison.OrdinalIgnoreCase)
            || string.Equals(origin, _config.PublicUrl, StringComparison.OrdinalIgnoreCase);
    }

    // ------------------------------------------------------------------ fichiers

    /// <summary><c>/learn/…</c> sous <c>learning/</c>, <c>/tts/…</c> sous le cache des phrases.</summary>
    private async Task PrivateFileAsync(HttpContext context, string path)
    {
        string? file = null;
        if (path.StartsWith("/learn/", StringComparison.Ordinal))
        {
            file = SafeFile(_bridge.LearningRoot, path["/learn".Length..]);
        }
        else if (path.StartsWith("/tts/", StringComparison.Ordinal))
        {
            file = SafeFile(_bridge.TtsCacheRoot, path["/tts".Length..]);
        }

        if (file is null)
        {
            context.Response.StatusCode = StatusCodes.Status404NotFound;
            return;
        }

        NoCache(context.Response);
        await SendFileAsync(context, file).ConfigureAwait(false);
    }

    private static async Task SendFileAsync(HttpContext context, string file)
    {
        if (!ContentTypes.TryGetContentType(file, out var type))
        {
            type = "application/octet-stream";
        }

        if (file.EndsWith(".html", StringComparison.OrdinalIgnoreCase))
        {
            NoCache(context.Response);
        }

        var info = new FileInfo(file);
        var etag = new EntityTagHeaderValue("\"" + info.LastWriteTimeUtc.Ticks.ToString("x") + "-" + info.Length.ToString("x") + "\"");
        await Results.File(file, type, lastModified: info.LastWriteTimeUtc, entityTag: etag, enableRangeProcessing: true)
            .ExecuteAsync(context).ConfigureAwait(false);
    }

    private static void NoCache(HttpResponse response) => response.Headers.CacheControl = "no-cache";

    /// <summary>
    /// Le fichier designe par <paramref name="urlPath"/> sous <paramref name="root"/>, ou null : segments vides,
    /// <c>.</c> ou <c>..</c>, caches (commencant par un point), caracteres douteux (<c>\ : %</c>, controle),
    /// chemin qui sortirait du dossier, lien symbolique sur le chemin, dossier ou fichier absent.
    /// </summary>
    public static string? SafeFile(string root, string urlPath)
    {
        var relative = urlPath.TrimStart('/');
        if (relative.Length == 0 || relative.Length > 400)
        {
            return null;
        }

        var segments = relative.Split('/');
        foreach (var segment in segments)
        {
            if (segment.Length == 0 || segment[0] == '.' || segment.Any(c => c is '\\' or ':' or '%' or '\0' || char.IsControl(c)))
            {
                return null;
            }
        }

        var fullRoot = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar);
        var full = Path.GetFullPath(Path.Combine(fullRoot, Path.Combine(segments)));
        if (!full.StartsWith(fullRoot + Path.DirectorySeparatorChar, StringComparison.Ordinal))
        {
            return null;
        }

        try
        {
            var current = fullRoot;
            for (var i = 0; i < segments.Length; i++)
            {
                current = Path.Combine(current, segments[i]);
                FileSystemInfo entry = i == segments.Length - 1 ? new FileInfo(current) : new DirectoryInfo(current);
                if (!entry.Exists || entry.LinkTarget is not null)
                {
                    return null;
                }
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return null;
        }

        return full;
    }
}
