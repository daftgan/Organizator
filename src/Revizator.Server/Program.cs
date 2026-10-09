using Organizator.Services;
using QRCoder;
using Revizator.Server;

// revizator-server : sans argument, lance le serveur ; sinon ligne de commande (jetons, import).
// Voir docs/REVIZATOR-SERVER.md, § 3.
var config = ServerConfig.FromEnvironment();

try
{
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
    switch (args[0])
    {
        case "token" when args.Length >= 3 && args[1] == "new":
        {
            var device = string.Join(' ', args.Skip(2));
            var replaced = tokens.List().Any(t => string.Equals(t.Device, device.Trim(), StringComparison.OrdinalIgnoreCase));
            var token = tokens.Create(device);
            var link = config.PublicUrl + "/pair?token=" + token;
            Console.WriteLine(replaced
                ? $"Nouveau jeton pour « {device.Trim()} » (l'ancien est revoque)."
                : $"Jeton cree pour « {device.Trim()} ».");
            Console.WriteLine();
            Console.WriteLine("Lien d'appairage (a ouvrir sur l'appareil) :");
            Console.WriteLine("  " + link);
            Console.WriteLine();
            using (var generator = new QRCodeGenerator())
            using (var data = generator.CreateQrCode(link, QRCodeGenerator.ECCLevel.L))
            {
                Console.WriteLine(new AsciiQRCode(data).GetGraphicSmall());
            }

            Console.WriteLine("Jeton seul (Organizator sur le PC : Reglages > Revizator > Serveur) :");
            Console.WriteLine("  " + token);
            Console.WriteLine();
            Console.WriteLine("Il n'est affiche qu'une fois : le serveur n'en garde que l'empreinte.");
            return 0;
        }

        case "token" when args.Length == 2 && args[1] == "list":
        {
            var list = tokens.List();
            if (list.Count == 0)
            {
                Console.WriteLine("Aucun appareil appaire.");
                return 0;
            }

            foreach (var t in list)
            {
                Console.WriteLine($"{t.Device,-30} cree le {t.Created}");
            }

            return 0;
        }

        case "token" when args.Length >= 3 && args[1] == "revoke":
        {
            var device = string.Join(' ', args.Skip(2));
            if (!tokens.Revoke(device))
            {
                Console.Error.WriteLine($"Aucun appareil « {device} ».");
                return 1;
            }

            Console.WriteLine($"Jeton de « {device} » revoque.");
            return 0;
        }

        case "import" when args.Length == 2:
            Importer.Run(args[1], config.DataDir, Console.Out);
            return 0;

        default:
            Console.Error.WriteLine("""
                Usage :
                  revizator-server                         lance le serveur
                  revizator-server token new <appareil>    cree un jeton (lien d'appairage, QR code, jeton seul)
                  revizator-server token list              liste les appareils appaires
                  revizator-server token revoke <appareil> revoque le jeton d'un appareil
                  revizator-server import <dossier>        importe learning.json et learning/ depuis une copie
                                                           du dossier %LOCALAPPDATA%\Organizator\ du PC
                Variables : REVIZATOR_DATA, REVIZATOR_PORT, REVIZATOR_PUBLIC_URL, REVIZATOR_ALLOWED_ORIGINS,
                            REVIZATOR_CLAUDE, CLAUDE_CODE_OAUTH_TOKEN (voir docs/REVIZATOR-SERVER.md).
                """);
            return 2;
    }
}

static async Task<int> ServeAsync(ServerConfig config)
{
    Directory.CreateDirectory(config.DataDir);
    var log = new HostLog(config.DataDir);
    log.Mirror = line => Console.WriteLine(line);
    log.Info($"Revizator serveur {ServerConfig.Version} : donnees {config.DataDir}, page {config.WwwRoot}, port {config.Port}");

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
    var hub = new WsHub(bridge, log);
    var routes = new HttpRoutes(config, new TokenStore(config.DataDir), new FailureLimiter(), bridge, hub, log);
    log.Info(bridge.HasClaude ? "Claude Code present" : "Claude Code introuvable : les generations de Revizator echoueront (REVIZATOR_CLAUDE ?)");

    app.UseWebSockets(new WebSocketOptions { KeepAliveInterval = TimeSpan.FromSeconds(30) });
    app.Run(routes.HandleAsync);
    await app.RunAsync();
    log.Info("Revizator serveur arrete");
    return 0;
}
