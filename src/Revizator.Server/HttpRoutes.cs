using System.Text;
using Microsoft.AspNetCore.StaticFiles;
using Microsoft.Net.Http.Headers;
using Organizator.Services;

namespace Revizator.Server;

/// <summary>
/// Routes HTTP du serveur (§ 3 du contrat) : sante, connexion (identifiant et mot de passe, ou code
/// d'appairage donne par Organizator), page avec ses
/// deux injections, fichiers statiques de la page, dossiers <c>learning/</c> et cache TTS (cookie ou jeton
/// de session dans le chemin), WebSocket.
/// Aucun chemin ne sort de son dossier racine.
/// </summary>
public sealed class HttpRoutes
{
    public const string CookieName = "rz_token";

    private static readonly TimeSpan CookieLifetime = TimeSpan.FromDays(400);

    private static readonly FileExtensionContentTypeProvider ContentTypes = CreateContentTypes();

    private readonly ServerConfig _config;
    private readonly TokenStore _tokens;
    private readonly UserStore _users;
    private readonly LoginLockout _lockout = new();
    private readonly FailureLimiter _limiter;
    private readonly PairingCodes _pairing;
    private readonly OrganizatorReleases _releases;
    private readonly ServerBridge _bridge;
    private readonly WsHub _hub;
    private readonly HostLog _log;

    public HttpRoutes(ServerConfig config, TokenStore tokens, UserStore users, FailureLimiter limiter, PairingCodes pairing, OrganizatorReleases releases, ServerBridge bridge, WsHub hub, HostLog log)
    {
        _config = config;
        _tokens = tokens;
        _users = users;
        _limiter = limiter;
        _pairing = pairing;
        _releases = releases;
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
        // Jamais de Referer : une page ou un media ouvert sous /t/<jeton>/ ne transmet pas son adresse.
        response.Headers["Referrer-Policy"] = "no-referrer";
        // Aucune page d'ici dans un cadre d'un autre site (le CSP des pages HTML le redit).
        response.Headers["X-Frame-Options"] = "DENY";

        // CORS : seulement pour les origines autorisees, et seulement la ou la page d'Organizator lit.
        var apiAuth = path is "/api/login" or "/api/logout" or "/api/me" or "/api/pair";
        var corsPath = path == "/api/health" || apiAuth || path.StartsWith("/learn/", StringComparison.Ordinal)
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
                response.Headers.AccessControlAllowMethods = apiAuth ? "GET, POST, OPTIONS" : "GET, HEAD, OPTIONS";
                response.Headers.AccessControlAllowHeaders = apiAuth ? "Content-Type, Authorization" : "Range, Content-Type";
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

        if (HttpMethods.IsPost(request.Method))
        {
            switch (path)
            {
                case "/login":
                    await LoginFormAsync(context).ConfigureAwait(false);
                    return;
                case "/logout":
                    await LogoutFormAsync(context).ConfigureAwait(false);
                    return;
                case "/api/login":
                    await LoginApiAsync(context).ConfigureAwait(false);
                    return;
                case "/api/logout":
                    await LogoutApiAsync(context).ConfigureAwait(false);
                    return;
                case "/pair":
                    await PairFormAsync(context).ConfigureAwait(false);
                    return;
                case "/api/pair":
                    await PairApiAsync(context).ConfigureAwait(false);
                    return;
            }
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

        if (path == "/login")
        {
            await LoginPageAsync(context).ConfigureAwait(false);
            return;
        }

        // Installateur d'Organizator : sans authentification (page de connexion, mises a jour des PC).
        if (path == "/api/organizator")
        {
            await OrganizatorInfoAsync(context).ConfigureAwait(false);
            return;
        }

        if (path == "/download/organizator")
        {
            await OrganizatorDownloadAsync(context).ConfigureAwait(false);
            return;
        }

        if (path == "/pair")
        {
            await PairPageAsync(context).ConfigureAwait(false);
            return;
        }

        if (path == "/api/me")
        {
            await MeAsync(context).ConfigureAwait(false);
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

            await PrivateFileAsync(context, path, context.Request.Cookies[CookieName]).ConfigureAwait(false);
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

            await PrivateFileAsync(context, slash < 0 ? "/" : rest[slash..], token).ConfigureAwait(false);
            return;
        }

        if (path.StartsWith("/api/", StringComparison.Ordinal) || path.StartsWith("/login/", StringComparison.Ordinal))
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
        var ip = _limiter.ClientIp(context);
        if (_limiter.Blocked(ip))
        {
            context.Items["rz-blocked"] = true;
            return false;
        }

        device = _tokens.Validate(token);
        if (device is null)
        {
            _limiter.Fail(ip);
            _log.Warn($"Jeton refuse ({ip}, {Redacted(context.Request.Path.Value)})");
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
            : message ?? "Connexion requise.").ConfigureAwait(false);
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

    /// <summary>Le chemin pour le journal, sans le jeton de <c>/t/&lt;jeton&gt;/</c> (meme faux : il peut differer d'un vrai d'un caractere).</summary>
    private static string Redacted(string? path)
    {
        path ??= "";
        if (!path.StartsWith("/t/", StringComparison.Ordinal))
        {
            return path;
        }

        var slash = path.IndexOf('/', 3);
        return "/t/…" + (slash < 0 ? "" : path[slash..]);
    }

    /// <summary>Requete en HTTPS : directe, ou annoncee par <c>X-Forwarded-Proto</c> d'un proxy de confiance.</summary>
    private bool IsHttps(HttpContext context)
        => context.Request.IsHttps || (_limiter.FromTrustedProxy(context)
            && string.Equals(context.Request.Headers["X-Forwarded-Proto"].ToString().Split(',')[0].Trim(), "https", StringComparison.OrdinalIgnoreCase));

    // ------------------------------------------------------------------ connexion

    private enum LoginResult { Ok, Bad, Blocked, Locked }

    /// <summary>
    /// Verifie un identifiant et un mot de passe. Refus sans calcul quand l'adresse a deja 10 echecs dans la
    /// minute ou que le compte est verrouille (5 echecs de suite) ; un echec compte pour l'adresse et pour le
    /// compte, et la reponse attend 400 ms (essais en serie plus lents, sans gener une faute de frappe).
    /// </summary>
    private async Task<(LoginResult Result, string? User, TimeSpan Wait)> CheckLoginAsync(HttpContext context, string login, string password)
    {
        var ip = _limiter.ClientIp(context);
        if (_limiter.Blocked(ip))
        {
            return (LoginResult.Blocked, null, TimeSpan.FromMinutes(1));
        }

        var locked = _lockout.Locked(login);
        if (locked > TimeSpan.Zero)
        {
            return (LoginResult.Locked, null, locked);
        }

        var user = await _users.VerifyAsync(login, password).ConfigureAwait(false);
        if (user is null)
        {
            _limiter.Fail(ip);
            _lockout.Fail(login);
            _log.Warn($"Connexion refusee ({ip}, identifiant de {Math.Min(login.Length, 40)} caracteres)");
            await Task.Delay(400).ConfigureAwait(false);
            return (LoginResult.Bad, null, TimeSpan.Zero);
        }

        _lockout.Succeed(login);
        return (LoginResult.Ok, user, TimeSpan.Zero);
    }

    private static string LoginError(LoginResult result, TimeSpan wait) => result switch
    {
        LoginResult.Blocked => "Trop d'essais depuis cette adresse : réessayez dans une minute.",
        LoginResult.Locked => $"Trop d'essais pour ce compte : réessayez dans {Math.Max(1, (int)Math.Ceiling(wait.TotalMinutes))} min.",
        _ => "Identifiant ou mot de passe incorrect.",
    };

    /// <summary>
    /// Un formulaire ou un appel de connexion vient-il d'une page autorisee ? Sans <c>Origin</c> (client hors
    /// navigateur, ancien navigateur pour un formulaire meme origine) : oui ; sinon le serveur lui-meme, ou
    /// une origine autorisee pour l'API (Organizator sur le PC).
    /// </summary>
    private bool OriginAllowed(HttpContext context, bool api)
    {
        var origin = context.Request.Headers.Origin.ToString().TrimEnd('/');
        return origin.Length == 0 || SameOrigin(context, origin) || (api && _config.AllowedOrigins.Contains(origin));
    }

    /// <summary>Nom court de l'appareil pour la liste des sessions : systeme et navigateur d'apres le User-Agent.</summary>
    private static string DeviceLabel(HttpRequest request)
    {
        var ua = request.Headers.UserAgent.ToString();
        var os = ua.Contains("iPhone") ? "iPhone" : ua.Contains("iPad") ? "iPad" : ua.Contains("Android") ? "Android"
            : ua.Contains("Windows") ? "Windows" : ua.Contains("Mac OS") ? "Mac" : ua.Contains("Linux") ? "Linux" : "navigateur";
        var browser = ua.Contains("Edg/") ? "Edge" : ua.Contains("Firefox/") ? "Firefox" : ua.Contains("Chrome/") ? "Chrome"
            : ua.Contains("Safari/") ? "Safari" : "";
        return browser.Length > 0 ? os + " " + browser : os;
    }

    private void SetSessionCookie(HttpContext context, string token)
        => context.Response.Cookies.Append(CookieName, token, new CookieOptions
        {
            HttpOnly = true,
            Secure = IsHttps(context),
            SameSite = Microsoft.AspNetCore.Http.SameSiteMode.Lax,
            MaxAge = CookieLifetime,
            Path = "/",
            IsEssential = true,
        });

    /// <summary>
    /// Pages sans secret dans leur adresse (<c>/</c>, <c>/login</c>) : Referer du meme site seulement. Avec
    /// <c>no-referrer</c>, les navigateurs envoient <c>Origin: null</c> pour leurs formulaires POST, et le
    /// controle d'origine de <c>/login</c> et <c>/logout</c> ne pourrait plus les reconnaitre.
    /// </summary>
    private static void SameOriginReferrer(HttpResponse response) => response.Headers["Referrer-Policy"] = "same-origin";

    /// <summary><c>GET /login</c> : le formulaire (sans script : le CSP n'en permet aucun en ligne).</summary>
    private async Task LoginPageAsync(HttpContext context)
    {
        var response = context.Response;
        SameOriginReferrer(response);
        var cookie = context.Request.Cookies[CookieName];
        if (!string.IsNullOrEmpty(cookie) && _tokens.Validate(cookie) is not null)
        {
            NoCache(response);
            response.Redirect("/", permanent: false);
            return;
        }

        var message = context.Request.Query["e"].ToString() switch
        {
            "bad" => "Identifiant ou mot de passe incorrect.",
            "blocked" => "Trop d'essais : réessayez dans une minute.",
            "locked" => "Trop d'essais pour ce compte : réessayez dans quelques minutes.",
            "out" => "Vous êtes déconnecté.",
            "origin" => "Requête refusée : rouvrez cette page et réessayez.",
            _ => "",
        };
        NoCache(response);
        response.ContentType = "text/html; charset=utf-8";
        response.Headers.ContentSecurityPolicy = PagePolicy(context.Request);
        var noAccount = _users.List().Count == 0
            ? "<p class=\"note\">Aucun compte n'existe encore : créez-le sur le serveur avec <code>revizator-server user set &lt;identifiant&gt;</code>.</p>"
            : "";
        await response.WriteAsync(LoginHtml(message, noAccount + DownloadHtml())).ConfigureAwait(false);
    }

    /// <summary>Styles des pages de connexion et d'appairage (sans script : le CSP n'en permet aucun en ligne).</summary>
    private const string FormStyle = "*{box-sizing:border-box}body{margin:0;min-height:100vh;min-height:100dvh;display:flex;align-items:center;justify-content:center;"
        + "background:#f5ead8;color:#2b2118;font-family:system-ui,-apple-system,sans-serif;padding:24px max(24px,env(safe-area-inset-right)) 24px max(24px,env(safe-area-inset-left))}"
        + "main{width:100%;max-width:360px}h1{font-size:1.6rem;margin:0 0 4px}p.lead{margin:0 0 24px;color:#6b5a48}"
        + "label{display:block;font-weight:600;margin:16px 0 6px}input{width:100%;font-size:16px;padding:12px 14px;border:1px solid #cdb99c;border-radius:10px;background:#fffaf2;color:inherit}"
        + "input:focus{outline:2px solid #b5651d;outline-offset:1px}button{margin-top:24px;width:100%;min-height:48px;font-size:16px;font-weight:600;border:0;border-radius:10px;background:#b5651d;color:#fff}"
        + ".msg{margin:0 0 8px;padding:10px 12px;border-radius:8px;background:#fde2d2;color:#7a2e0b}.note{color:#6b5a48;font-size:.9rem}"
        + "code{background:#fff6;padding:2px 4px;border-radius:4px}"
        + "p.alt{margin:20px 0 0;text-align:center}p.alt a{color:#b5651d;font-weight:600}"
        + ".code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:1.6rem;letter-spacing:.12em;text-align:center;margin:8px 0 0}"
        + "p.dl{margin:28px 0 0;padding-top:16px;border-top:1px solid #e3d3bb;text-align:center;font-size:.9rem;color:#6b5a48}p.dl a{color:#b5651d;font-weight:600}"
        + "input.code-in{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:20px;letter-spacing:.12em;text-transform:uppercase;text-align:center}";

    private static string LoginHtml(string message, string extra)
        => "<!DOCTYPE html><html lang=\"fr\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
            + "<title>Révizator — connexion</title><link rel=\"manifest\" href=\"manifest.webmanifest\"><meta name=\"theme-color\" content=\"#f5ead8\">"
            + "<link rel=\"apple-touch-icon\" href=\"icons/icon-192.png\"><link rel=\"icon\" type=\"image/png\" href=\"icons/icon-192.png\">"
            + "<style>" + FormStyle + "</style></head><body><main>"
            + "<h1>Révizator</h1><p class=\"lead\">Connectez-vous pour retrouver vos cours, vos cartes et vos progrès.</p>"
            + (message.Length > 0 ? "<p class=\"msg\" role=\"alert\">" + message + "</p>" : "")
            + "<form method=\"post\" action=\"/login\">"
            + "<label for=\"login\">Identifiant</label><input id=\"login\" name=\"login\" autocomplete=\"username\" autocapitalize=\"none\" spellcheck=\"false\" required maxlength=\"40\">"
            + "<label for=\"password\">Mot de passe</label><input id=\"password\" name=\"password\" type=\"password\" autocomplete=\"current-password\" required maxlength=\"200\">"
            + "<button type=\"submit\">Se connecter</button></form>"
            + "<p class=\"alt\"><a href=\"/pair\">J'ai un code d'appairage</a></p>" + extra + "</main></body></html>";

    /// <summary>Lit un formulaire court (4 Ko au plus) ; null s'il est trop gros ou illisible.</summary>
    private static async Task<IFormCollection?> SmallFormAsync(HttpContext context)
    {
        if (context.Request.ContentLength is > 4096 || !context.Request.HasFormContentType)
        {
            return null;
        }

        try
        {
            return await context.Request.ReadFormAsync(new Microsoft.AspNetCore.Http.Features.FormOptions
            {
                BufferBody = false,
                ValueLengthLimit = 1024,
                KeyLengthLimit = 64,
                ValueCountLimit = 8,
            }, context.RequestAborted).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is InvalidDataException or IOException)
        {
            return null;
        }
    }

    /// <summary><c>POST /login</c> (formulaire de la page) : cookie de session puis la page, ou retour au formulaire.</summary>
    private async Task LoginFormAsync(HttpContext context)
    {
        NoCache(context.Response);
        if (!OriginAllowed(context, api: false))
        {
            context.Response.Redirect("/login?e=origin", permanent: false);
            return;
        }

        var form = await SmallFormAsync(context).ConfigureAwait(false);
        var login = form?["login"].ToString() ?? "";
        var (result, user, _) = await CheckLoginAsync(context, login, form?["password"].ToString() ?? "").ConfigureAwait(false);
        if (result != LoginResult.Ok)
        {
            context.Response.Redirect("/login?e=" + result.ToString().ToLowerInvariant(), permanent: false);
            return;
        }

        var label = DeviceLabel(context.Request);
        SetSessionCookie(context, _tokens.CreateSession(user!, label));
        _log.Info($"Connexion : {user} ({label}, {_limiter.ClientIp(context)})");
        context.Response.Redirect("/", permanent: false);
    }

    /// <summary><c>POST /logout</c> (bouton des Reglages, page servie ici) : la session est revoquee, le cookie retire.</summary>
    private async Task LogoutFormAsync(HttpContext context)
    {
        NoCache(context.Response);
        if (!OriginAllowed(context, api: false))
        {
            context.Response.StatusCode = StatusCodes.Status403Forbidden;
            return;
        }

        var cookie = context.Request.Cookies[CookieName];
        if (_tokens.RevokeToken(cookie))
        {
            _log.Info($"Deconnexion ({_limiter.ClientIp(context)})");
        }

        context.Response.Cookies.Delete(CookieName, new CookieOptions { Path = "/", Secure = IsHttps(context), HttpOnly = true, SameSite = Microsoft.AspNetCore.Http.SameSiteMode.Lax });
        context.Response.Redirect("/login?e=out", permanent: false);
        await Task.CompletedTask.ConfigureAwait(false);
    }

    /// <summary>
    /// <c>POST /api/login</c> (Organizator sur le PC, scripts) : <c>{ login, password, device? }</c> en JSON →
    /// <c>{ token, login, session }</c>. Le mot de passe n'est jamais garde par le client : seulement le jeton.
    /// </summary>
    private async Task LoginApiAsync(HttpContext context)
    {
        NoCache(context.Response);
        if (!OriginAllowed(context, api: true))
        {
            context.Response.StatusCode = StatusCodes.Status403Forbidden;
            await context.Response.WriteAsJsonAsync(new { error = "Origine refusée." }).ConfigureAwait(false);
            return;
        }

        string login = "", password = "", device = "";
        if (context.Request.ContentLength is null or <= 4096 && context.Request.HasJsonContentType())
        {
            try
            {
                var body = await System.Text.Json.Nodes.JsonNode.ParseAsync(context.Request.Body, cancellationToken: context.RequestAborted).ConfigureAwait(false);
                login = body?["login"]?.GetValue<string>() ?? "";
                password = body?["password"]?.GetValue<string>() ?? "";
                device = body?["device"]?.GetValue<string>() ?? "";
            }
            catch (Exception ex) when (ex is System.Text.Json.JsonException or InvalidOperationException)
            {
                login = "";
            }
        }

        var (result, user, wait) = await CheckLoginAsync(context, login, password).ConfigureAwait(false);
        if (result != LoginResult.Ok)
        {
            context.Response.StatusCode = result == LoginResult.Bad ? StatusCodes.Status401Unauthorized : StatusCodes.Status429TooManyRequests;
            if (result != LoginResult.Bad)
            {
                context.Response.Headers.RetryAfter = ((int)Math.Ceiling(wait.TotalSeconds)).ToString(System.Globalization.CultureInfo.InvariantCulture);
            }

            await context.Response.WriteAsJsonAsync(new { error = LoginError(result, wait) }).ConfigureAwait(false);
            return;
        }

        var label = device.Trim().Length > 0 ? device : DeviceLabel(context.Request);
        var token = _tokens.CreateSession(user!, label);
        _log.Info($"Connexion : {user} ({label}, {_limiter.ClientIp(context)}, API)");
        await context.Response.WriteAsJsonAsync(new { token, login = user, session = _tokens.Validate(token) }).ConfigureAwait(false);
    }

    /// <summary><c>POST /api/logout</c> avec <c>Authorization: Bearer &lt;jeton&gt;</c> : revoque cette session.</summary>
    private async Task LogoutApiAsync(HttpContext context)
    {
        NoCache(context.Response);
        if (!OriginAllowed(context, api: true))
        {
            context.Response.StatusCode = StatusCodes.Status403Forbidden;
            return;
        }

        var revoked = _tokens.RevokeToken(BearerToken(context.Request));
        await context.Response.WriteAsJsonAsync(new { ok = revoked }).ConfigureAwait(false);
    }

    /// <summary><c>GET /api/me</c> : le compte de la session (cookie ou <c>Authorization: Bearer</c>), sinon 401.</summary>
    private async Task MeAsync(HttpContext context)
    {
        NoCache(context.Response);
        var token = BearerToken(context.Request) ?? context.Request.Cookies[CookieName];
        if (string.IsNullOrEmpty(token) || !Authorize(context, token, out _))
        {
            await DenyAsync(context).ConfigureAwait(false);
            return;
        }

        await context.Response.WriteAsJsonAsync(new { login = _tokens.UserOf(token) ?? "", version = ServerConfig.Version }).ConfigureAwait(false);
    }

    private static string? BearerToken(HttpRequest request)
    {
        var header = request.Headers.Authorization.ToString();
        return header.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase) ? header[7..].Trim() : null;
    }

    // ------------------------------------------------------------------ installateur d'Organizator

    /// <summary>Lien de telechargement de la page de connexion, ou rien si le serveur n'a pas d'installateur.</summary>
    private string DownloadHtml()
    {
        var release = _releases.Current;
        return release is null
            ? ""
            : "<p class=\"dl\">Sur un PC Windows : <a href=\"/download/organizator\">installer Organizator</a> (version "
                + System.Net.WebUtility.HtmlEncode(release.Version) + ", " + Math.Max(1, (int)Math.Round(release.Size / 1_048_576.0)) + " Mo)</p>";
    }

    /// <summary>
    /// <c>GET /api/organizator</c> : <c>{ version, size, sha256, url, published }</c> de l'installateur servi,
    /// sinon 404. Organizator le lit pour se mettre a jour ; la page, pour proposer le telechargement.
    /// </summary>
    private async Task OrganizatorInfoAsync(HttpContext context)
    {
        NoCache(context.Response);
        var release = _releases.Current;
        if (release is null)
        {
            context.Response.StatusCode = StatusCodes.Status404NotFound;
            await context.Response.WriteAsJsonAsync(new { error = "Aucun installateur d'Organizator sur ce serveur." }).ConfigureAwait(false);
            return;
        }

        await context.Response.WriteAsJsonAsync(new
        {
            version = release.Version,
            size = release.Size,
            sha256 = release.Sha256,
            url = "/download/organizator",
            published = release.Published,
        }).ConfigureAwait(false);
    }

    /// <summary><c>GET /download/organizator</c> : l'installateur, en piece jointe sous son nom versionne.</summary>
    private async Task OrganizatorDownloadAsync(HttpContext context)
    {
        var release = _releases.Current;
        var file = release is null ? null : _releases.FilePath(release);
        if (file is null || !File.Exists(file))
        {
            context.Response.StatusCode = StatusCodes.Status404NotFound;
            await context.Response.WriteAsync("Aucun installateur d'Organizator sur ce serveur.").ConfigureAwait(false);
            return;
        }

        NoCache(context.Response);
        var info = new FileInfo(file);
        await Results.File(file, "application/vnd.microsoft.portable-executable", fileDownloadName: release!.File,
                lastModified: info.LastWriteTimeUtc, enableRangeProcessing: true)
            .ExecuteAsync(context).ConfigureAwait(false);
    }

    // ------------------------------------------------------------------ appairage d'un telephone

    /// <summary>
    /// <c>POST /api/pair</c> avec <c>Authorization: Bearer &lt;jeton&gt;</c> (Organizator sur le PC) : un code
    /// d'appairage pour le compte de cette session → <c>{ code, link, svg, expiresIn }</c>. <c>svg</c> est le QR
    /// code de <c>link</c> ; le telephone qui l'ouvre est connecte au meme compte (voir PairingCodes).
    /// </summary>
    private async Task PairApiAsync(HttpContext context)
    {
        NoCache(context.Response);
        if (!OriginAllowed(context, api: true))
        {
            context.Response.StatusCode = StatusCodes.Status403Forbidden;
            await context.Response.WriteAsJsonAsync(new { error = "Origine refusée." }).ConfigureAwait(false);
            return;
        }

        var token = BearerToken(context.Request);
        if (string.IsNullOrEmpty(token) || !Authorize(context, token, out _) || _tokens.UserOf(token) is not { } user)
        {
            await DenyAsync(context, "Session refusée : reconnectez Organizator au serveur.").ConfigureAwait(false);
            return;
        }

        var code = _pairing.Create(user);
        var link = PairBaseUrl(context) + "/pair?c=" + code;
        string svg;
        using (var data = QRCoder.QRCodeGenerator.GenerateQrCode(link, QRCoder.QRCodeGenerator.ECCLevel.M))
        {
            svg = new QRCoder.SvgQRCode(data).GetGraphic(8, "#000000", "#ffffff", true, QRCoder.SvgQRCode.SizingMode.ViewBoxAttribute);
        }

        _log.Info($"Code d'appairage cree pour {user} ({_limiter.ClientIp(context)})");
        await context.Response.WriteAsJsonAsync(new
        {
            code = PairingCodes.Display(code),
            link,
            svg,
            expiresIn = (int)PairingCodes.Lifetime.TotalSeconds,
        }).ConfigureAwait(false);
    }

    /// <summary>
    /// Adresse a mettre dans le QR code : <c>REVIZATOR_PUBLIC_URL</c> quand il est regle, sinon celle par
    /// laquelle Organizator a joint le serveur (schema et <c>Host</c> de la requete).
    /// </summary>
    private string PairBaseUrl(HttpContext context)
    {
        if (!_config.PublicUrl.StartsWith("http://localhost", StringComparison.OrdinalIgnoreCase))
        {
            return _config.PublicUrl;
        }

        var host = context.Request.Host.Value ?? "";
        return host.Length > 0 ? (IsHttps(context) ? "https://" : "http://") + host : _config.PublicUrl;
    }

    /// <summary>
    /// <c>GET /pair</c> : avec <c>?c=</c> (QR code), un bouton qui connecte cet appareil ; sans, un champ pour
    /// taper le code. Rien n'est consomme ici : un apercu de lien (messagerie, lecteur de QR code) qui ouvre
    /// l'adresse ne grille pas le code, seul le bouton (POST) le fait.
    /// </summary>
    private async Task PairPageAsync(HttpContext context)
    {
        var response = context.Response;
        NoCache(response);
        SameOriginReferrer(response);
        response.ContentType = "text/html; charset=utf-8";
        response.Headers.ContentSecurityPolicy = PagePolicy(context.Request);
        var message = context.Request.Query["e"].ToString() switch
        {
            "bad" => "Ce code n'est pas valable : il a déjà servi, a expiré (10 minutes) ou est mal recopié. Affichez-en un nouveau dans Organizator.",
            "blocked" => "Trop d'essais : réessayez dans une minute.",
            "origin" => "Requête refusée : rouvrez cette page et réessayez.",
            _ => "",
        };
        var code = PairingCodes.Normalize(context.Request.Query["c"].ToString());
        await response.WriteAsync(PairHtml(message, code)).ConfigureAwait(false);
    }

    private static string PairHtml(string message, string? code)
        => "<!DOCTYPE html><html lang=\"fr\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
            + "<title>Révizator — appairage</title><link rel=\"manifest\" href=\"manifest.webmanifest\"><meta name=\"theme-color\" content=\"#f5ead8\">"
            + "<link rel=\"apple-touch-icon\" href=\"icons/icon-192.png\"><link rel=\"icon\" type=\"image/png\" href=\"icons/icon-192.png\">"
            + "<style>" + FormStyle + "</style></head><body><main>"
            + "<h1>Révizator</h1>"
            + (code is not null
                ? "<p class=\"lead\">Connecter cet appareil au compte qui a affiché ce code dans Organizator :</p>"
                : "<p class=\"lead\">Dans Organizator sur le PC : Réglages › Révizator › <strong>Ajouter un téléphone</strong>, puis tapez ici le code affiché sous le QR code.</p>")
            + (message.Length > 0 ? "<p class=\"msg\" role=\"alert\">" + message + "</p>" : "")
            + "<form method=\"post\" action=\"/pair\">"
            + (code is not null
                ? "<p class=\"code\">" + PairingCodes.Display(code) + "</p><input type=\"hidden\" name=\"code\" value=\"" + code + "\">"
                : "<label for=\"code\">Code d'appairage</label><input id=\"code\" name=\"code\" class=\"code-in\" autocomplete=\"one-time-code\" autocapitalize=\"characters\" spellcheck=\"false\" required maxlength=\"12\" placeholder=\"XXXX-XXXX\">")
            + "<button type=\"submit\">Connecter cet appareil</button></form>"
            + "<p class=\"alt\"><a href=\"/login\">Se connecter avec un mot de passe</a></p></main></body></html>";

    /// <summary>
    /// <c>POST /pair</c> (formulaire de la page) : le code contre un cookie de session du compte, puis la page.
    /// Un code faux compte comme un echec pour l'adresse (10 par minute, comme les mots de passe).
    /// </summary>
    private async Task PairFormAsync(HttpContext context)
    {
        NoCache(context.Response);
        if (!OriginAllowed(context, api: false))
        {
            context.Response.Redirect("/pair?e=origin", permanent: false);
            return;
        }

        var ip = _limiter.ClientIp(context);
        if (_limiter.Blocked(ip))
        {
            context.Response.Redirect("/pair?e=blocked", permanent: false);
            return;
        }

        var form = await SmallFormAsync(context).ConfigureAwait(false);
        var user = _pairing.Consume(form?["code"].ToString());
        if (user is null || !_users.List().Any(u => u.Login == user))
        {
            _limiter.Fail(ip);
            _log.Warn($"Code d'appairage refuse ({ip})");
            await Task.Delay(400).ConfigureAwait(false);
            context.Response.Redirect("/pair?e=bad", permanent: false);
            return;
        }

        var label = DeviceLabel(context.Request);
        SetSessionCookie(context, _tokens.CreateSession(user, label));
        _log.Info($"Connexion par code d'appairage : {user} ({label}, {ip})");
        context.Response.Redirect("/", permanent: false);
    }

    /// <summary>La page, avec ses deux injections ; sans session valide, renvoi vers la page de connexion.</summary>
    private async Task IndexAsync(HttpContext context)
    {
        var response = context.Response;
        NoCache(response);
        SameOriginReferrer(response);
        response.ContentType = "text/html; charset=utf-8";
        response.Headers.ContentSecurityPolicy = PagePolicy(context.Request);
        var cookie = context.Request.Cookies[CookieName];
        if (string.IsNullOrEmpty(cookie) || !Authorize(context, cookie, out _))
        {
            if (context.Items.ContainsKey("rz-blocked"))
            {
                response.StatusCode = StatusCodes.Status429TooManyRequests;
                await response.WriteAsync(Page("Trop d'essais", "Réessayez dans une minute.")).ConfigureAwait(false);
                return;
            }

            // Cookie perime (session revoquee, mot de passe change) : il est retire.
            if (!string.IsNullOrEmpty(cookie))
            {
                response.Cookies.Delete(CookieName, new CookieOptions { Path = "/", Secure = IsHttps(context), HttpOnly = true, SameSite = Microsoft.AspNetCore.Http.SameSiteMode.Lax });
            }

            response.Redirect("/login", permanent: false);
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

    /// <summary>
    /// CSP de la page : scripts, styles, polices et images d'ici seulement (aucun script en ligne : un texte
    /// genere ou un flux RSS injecte dans la page ne s'execute pas) ; <c>blob:</c> pour le module audio de
    /// la detection de voix et les enregistrements ; medias https (podcasts de la BBC lus directement) ;
    /// WebSocket du meme hote ecrit en toutes lettres (Safari ancien ne le deduit pas de <c>'self'</c>) ;
    /// jamais dans un cadre.
    /// </summary>
    private static string PagePolicy(HttpRequest request)
    {
        var host = request.Host.Value ?? "";
        var ws = host.Length > 0 && host.All(c => char.IsAsciiLetterOrDigit(c) || c is '.' or '-' or ':' or '[' or ']')
            ? " wss://" + host + " ws://" + host
            : "";
        return "default-src 'self'; script-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; "
            + "media-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self'" + ws + "; worker-src 'self' blob:; "
            + "frame-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
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
            if (origin.Length > 0 && !SameOrigin(context, origin) && !_config.AllowedOrigins.Contains(origin))
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

        // Jeton revoque (ou remplace) pendant que la connexion est ouverte : elle est fermee (voir WsHub).
        var token = query.Length > 0 ? query : context.Request.Cookies[CookieName];
        var login = _tokens.UserOf(token);
        if (string.IsNullOrEmpty(login))
        {
            await DenyAsync(context).ConfigureAwait(false);
            return;
        }

        using var socket = await context.WebSockets.AcceptWebSocketAsync().ConfigureAwait(false);
        await _hub.RunAsync(socket, device!, login, () => _tokens.Validate(token) is not null, context.RequestAborted).ConfigureAwait(false);
    }

    /// <summary>
    /// Vrai si <paramref name="origin"/> est ce serveur : l'adresse publique, ou le schema et l'hote de la
    /// requete (<c>Host</c>, que NPM transmet tel quel ; <c>X-Forwarded-Host</c>, que le client peut forger,
    /// n'est pas lu). Le schema compte : une page en http ne parle pas au WebSocket d'une page en https.
    /// </summary>
    private bool SameOrigin(HttpContext context, string origin)
    {
        if (string.Equals(origin, _config.PublicUrl, StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        var host = context.Request.Host.Value ?? "";
        var scheme = IsHttps(context) ? "https" : "http";
        return host.Length > 0 && string.Equals(origin, scheme + "://" + host, StringComparison.OrdinalIgnoreCase);
    }

    // ------------------------------------------------------------------ fichiers

    /// <summary>
    /// <c>/learn/…</c> sous le dossier <c>learning/</c> du compte de la session (jamais celui d'un autre),
    /// <c>/tts/…</c> sous le cache des phrases, commun.
    /// </summary>
    private async Task PrivateFileAsync(HttpContext context, string path, string? token)
    {
        string? file = null;
        if (path.StartsWith("/learn/", StringComparison.Ordinal))
        {
            var login = _tokens.UserOf(token);
            file = string.IsNullOrEmpty(login) ? null : SafeFile(_bridge.LearningRootOf(login), path["/learn".Length..]);
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

        // Donnees personnelles : aucun cache partage, et jamais interpretees comme un document actif.
        context.Response.Headers.CacheControl = "private, no-cache";
        context.Response.Headers.ContentSecurityPolicy = "default-src 'none'; sandbox";
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
