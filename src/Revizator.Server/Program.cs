using Organizator.Services;
using Revizator.Server;

// revizator-server : sans argument, lance le serveur ; sinon ligne de commande (comptes, sessions, import).
// Voir docs/REVIZATOR-SERVER.md, § 3.
try
{
    var config = ServerConfig.FromEnvironment();
    return args.Length == 0 ? await ServeAsync(config) : Command(config, args);
}
catch (InvalidOperationException ex)
{
    Console.Error.WriteLine("Erreur : " + ex.Message);
    return 1;
}

static int Command(ServerConfig config, string[] args)
{
    Directory.CreateDirectory(config.DataDir);
    var tokens = new TokenStore(config.DataDir);
    var users = new UserStore(config.DataDir);
    switch (args[0])
    {
        case "user" when args.Length >= 3 && args[1] == "set":
        {
            var login = UserStore.CleanLogin(args[2]);
            var fromStdin = args.Length >= 4 && args[3] == "--password-stdin";
            string password;
            if (fromStdin || Console.IsInputRedirected)
            {
                password = (Console.In.ReadLine() ?? "").TrimEnd('\r', '\n');
            }
            else
            {
                password = ReadSecret($"Mot de passe pour « {login} » ({UserStore.MinPassword} caracteres au moins) : ");
                if (ReadSecret("Encore une fois : ") != password)
                {
                    Console.Error.WriteLine("Les deux saisies different : rien n'est change.");
                    return 1;
                }
            }

            var existed = users.Set(login, password);
            var closed = existed ? tokens.RevokeUser(login) : 0;
            Console.WriteLine(existed
                ? $"Mot de passe de « {login} » change ; {closed} session(s) fermee(s), reconnectez vos appareils."
                : $"Compte « {login} » cree. Connectez-vous sur {config.PublicUrl}/login");
            return 0;
        }

        case "user" when args.Length == 2 && args[1] == "list":
        {
            var list = users.List();
            if (list.Count == 0)
            {
                Console.WriteLine("Aucun compte. Creez-le : revizator-server user set <identifiant>");
                return 0;
            }

            foreach (var u in list)
            {
                var sessions = tokens.List().Count(t => t.User == u.Login);
                Console.WriteLine($"{u.Login,-24} cree le {u.Created}, mot de passe change le {u.Changed}, {sessions} session(s)");
            }

            return 0;
        }

        case "user" when args.Length == 3 && args[1] == "remove":
        {
            var login = args[2].Trim().ToLowerInvariant();
            if (!users.Remove(login))
            {
                Console.Error.WriteLine($"Aucun compte « {login} ».");
                return 1;
            }

            Console.WriteLine($"Compte « {login} » supprime ; {tokens.RevokeUser(login)} session(s) fermee(s).");
            return 0;
        }

        case "session" when args.Length == 2 && args[1] == "list":
        {
            var list = tokens.List();
            if (list.Count == 0)
            {
                Console.WriteLine("Aucune session ouverte.");
                return 0;
            }

            foreach (var t in list)
            {
                Console.WriteLine($"{t.Device}   (ouverte le {t.Created})");
            }

            return 0;
        }

        case "session" when args.Length >= 3 && args[1] == "revoke":
        {
            var name = string.Join(' ', args.Skip(2));
            if (name == "--all")
            {
                var all = tokens.List().Select(t => t.Device).ToList();
                foreach (var d in all)
                {
                    tokens.Revoke(d);
                }

                Console.WriteLine($"{all.Count} session(s) fermee(s).");
                return 0;
            }

            if (!tokens.Revoke(name))
            {
                Console.Error.WriteLine($"Aucune session (ou plusieurs) ne commence par « {name} » : voir revizator-server session list.");
                return 1;
            }

            Console.WriteLine("Session fermee : l'appareil devra se reconnecter.");
            return 0;
        }

        case "import" when args.Length == 2:
            Importer.Run(args[1], config.DataDir, Console.Out);
            return 0;

        default:
            Console.Error.WriteLine("""
                Usage :
                  revizator-server                          lance le serveur
                  revizator-server user set <identifiant>   cree le compte ou change son mot de passe (demande deux fois ;
                                                            --password-stdin pour le lire sur l'entree standard) ;
                                                            un changement ferme les sessions de ce compte
                  revizator-server user list                liste les comptes
                  revizator-server user remove <identif.>   supprime un compte et ferme ses sessions
                  revizator-server session list             liste les sessions ouvertes (compte, appareil, date)
                  revizator-server session revoke <nom>     ferme une session (son nom, ou son debut) ; --all : toutes
                  revizator-server import <dossier>         importe learning.json et learning/ depuis une copie
                                                            du dossier %LOCALAPPDATA%\Organizator\ du PC
                Variables : REVIZATOR_DATA, REVIZATOR_PORT, REVIZATOR_PUBLIC_URL, REVIZATOR_ALLOWED_ORIGINS,
                            REVIZATOR_TRUSTED_PROXIES, REVIZATOR_CLAUDE, CLAUDE_CODE_OAUTH_TOKEN
                            (voir docs/REVIZATOR-SERVER.md).
                """);
            return 2;
    }
}

/// <summary>
/// Jeton de Claude Code (<c>claude setup-token</c>) : un jeton copie depuis un terminal etroit arrive souvent
/// coupe en deux lignes, avec des espaces, ou precede d'un « # » ; Claude Code repond alors « 401 Invalid
/// bearer token » a chaque generation. Les blancs sont retires (le jeton n'en contient jamais) ; le reste
/// est signale dans le journal, sans jamais ecrire le jeton.
/// </summary>
static void CheckClaudeToken(HostLog log)
{
    var raw = Environment.GetEnvironmentVariable("CLAUDE_CODE_OAUTH_TOKEN");
    if (string.IsNullOrWhiteSpace(raw))
    {
        log.Warn("CLAUDE_CODE_OAUTH_TOKEN absent : les generations de Revizator echoueront. Mettre le jeton de "
            + "« claude setup-token » dans /opt/revizator/secrets.env (voir deploy/README.md, § 4), puis redeployer.");
        return;
    }

    var token = new string(raw.Where(c => !char.IsWhiteSpace(c)).ToArray()).Trim('"', '\'');
    if (token != raw)
    {
        Environment.SetEnvironmentVariable("CLAUDE_CODE_OAUTH_TOKEN", token);
        log.Warn("CLAUDE_CODE_OAUTH_TOKEN contenait des blancs ou des guillemets (copie sur plusieurs lignes ?) : retires.");
    }

    if (!token.StartsWith("sk-ant-", StringComparison.Ordinal))
    {
        log.Warn($"CLAUDE_CODE_OAUTH_TOKEN ne commence pas par « sk-ant- » ({token.Length} caracteres, commence par « "
            + (token.Length > 0 && !char.IsAsciiLetterOrDigit(token[0]) ? token[0].ToString() : "?") + " ») : "
            + "probablement mal copie, Claude Code repondra 401. Recopier le jeton sur une seule ligne.");
    }
}

/// <summary>Saisie masquee au terminal (docker exec -it) : les caracteres ne s'affichent pas.</summary>
static string ReadSecret(string prompt)
{
    Console.Write(prompt);
    var text = new System.Text.StringBuilder();
    while (true)
    {
        var key = Console.ReadKey(intercept: true);
        if (key.Key == ConsoleKey.Enter)
        {
            break;
        }

        if (key.Key == ConsoleKey.Backspace)
        {
            if (text.Length > 0)
            {
                text.Length--;
            }

            continue;
        }

        if (!char.IsControl(key.KeyChar))
        {
            text.Append(key.KeyChar);
        }
    }

    Console.WriteLine();
    return text.ToString();
}

static async Task<int> ServeAsync(ServerConfig config)
{
    Directory.CreateDirectory(config.DataDir);
    var log = new HostLog(config.DataDir);
    log.Mirror = line => Console.WriteLine(line);
    log.Info($"Revizator serveur {ServerConfig.Version} : donnees {config.DataDir}, page {config.WwwRoot}, port {config.Port}");
    log.Info("Proxys de confiance (X-Forwarded-*) : "
        + (config.TrustedProxies.Count == 0 ? "aucun" : string.Join(", ", config.TrustedProxies)));

    CheckClaudeToken(log);

    // Lance depuis une session Claude Code, le serveur transmettrait ses marqueurs a chaque claude -p.
    var scrubbed = InheritedEnvironment.Scrub();
    if (scrubbed.Count > 0)
    {
        log.Info("Environnement herite nettoye : " + string.Join(", ", scrubbed));
    }

    if (!File.Exists(Path.Combine(config.WwwRoot, "index.html")))
    {
        log.Warn("index.html introuvable sous " + config.WwwRoot);
    }

    var builder = WebApplication.CreateSlimBuilder();
    builder.Logging.ClearProviders();
    builder.Logging.AddSimpleConsole(o => o.SingleLine = true);
    builder.Logging.SetMinimumLevel(LogLevel.Warning);
    builder.WebHost.ConfigureKestrel(kestrel =>
    {
        kestrel.AddServerHeader = false;
        kestrel.ListenAnyIP(config.Port);
    });

    var app = builder.Build();
    using var bridge = new ServerBridge(config, log);
    var hub = new WsHub(bridge, log, app.Lifetime.ApplicationStopping);
    var users = new UserStore(config.DataDir);
    var routes = new HttpRoutes(config, new TokenStore(config.DataDir), users, new FailureLimiter(config.TrustedProxies), new PairingCodes(), bridge, hub, log);
    if (users.List().Count == 0)
    {
        log.Warn("Aucun compte : creez-le avec « revizator-server user set <identifiant> » (docker exec -it revizator revizator-server user set ...)");
    }

    log.Info(bridge.HasClaude ? "Claude Code present" : "Claude Code introuvable : les generations de Revizator echoueront (REVIZATOR_CLAUDE ?)");

    app.UseWebSockets(new WebSocketOptions { KeepAliveInterval = TimeSpan.FromSeconds(30) });
    app.Run(routes.HandleAsync);
    await app.RunAsync();
    log.Info("Revizator serveur arrete");
    return 0;
}
