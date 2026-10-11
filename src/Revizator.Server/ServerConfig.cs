namespace Revizator.Server;

/// <summary>
/// Reglages du serveur, lus dans l'environnement (voir docs/REVIZATOR-SERVER.md, § 3). Les variables
/// propres a Claude Code (<c>CLAUDE_CODE_OAUTH_TOKEN</c>) passent telles quelles aux processus <c>claude</c>.
/// </summary>
public sealed class ServerConfig
{
    public static readonly string Version =
        typeof(ServerConfig).Assembly.GetName().Version?.ToString(3) ?? "1.0.0";

    /// <summary>Dossier de donnees : meme disposition que <c>%LOCALAPPDATA%\Organizator\</c> pour Revizator.</summary>
    public required string DataDir { get; init; }

    public required int Port { get; init; }

    /// <summary>Adresse publique, sans barre finale, pour les liens d'appairage.</summary>
    public required string PublicUrl { get; init; }

    /// <summary>Origines autorisees en CORS (la page d'Organizator dans WebView2).</summary>
    public required IReadOnlySet<string> AllowedOrigins { get; init; }

    /// <summary>Dossier des fichiers de la page (copie de src/Organizator/wwwroot, a cote de l'executable).</summary>
    public required string WwwRoot { get; init; }

    /// <summary>
    /// Adresses du reverse proxy (NPM) : seules leurs connexions font foi pour <c>X-Forwarded-For</c> et
    /// <c>X-Forwarded-Proto</c>. Par defaut le reseau prive et local ; vide (<c>none</c>) : aucune.
    /// </summary>
    public required IReadOnlyList<System.Net.IPNetwork> TrustedProxies { get; init; }

    /// <summary>Reseaux prives et locaux : valeur par defaut de <c>REVIZATOR_TRUSTED_PROXIES</c>.</summary>
    public const string PrivateNetworks = "127.0.0.0/8,::1/128,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,169.254.0.0/16,fc00::/7,fe80::/10";

    /// <summary>
    /// Liste d'adresses ou de reseaux (<c>192.168.1.11</c>, <c>172.16.0.0/12</c>), separes par des virgules ;
    /// <c>private</c> pour le reseau prive, <c>none</c> pour aucun. Une entree illisible arrete le serveur
    /// plutot que d'etre ignoree en silence.
    /// </summary>
    public static IReadOnlyList<System.Net.IPNetwork> ParseNetworks(string value)
    {
        var list = new List<System.Net.IPNetwork>();
        foreach (var raw in value.Split(new[] { ',', ';', ' ' }, StringSplitOptions.RemoveEmptyEntries))
        {
            var entry = raw.Trim();
            if (entry.Equals("none", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            if (entry.Equals("private", StringComparison.OrdinalIgnoreCase))
            {
                list.AddRange(ParseNetworks(PrivateNetworks));
                continue;
            }

            if (!entry.Contains('/') && System.Net.IPAddress.TryParse(entry, out var single))
            {
                list.Add(new System.Net.IPNetwork(single, single.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork ? 32 : 128));
                continue;
            }

            if (!System.Net.IPNetwork.TryParse(entry, out var network))
            {
                throw new InvalidOperationException("REVIZATOR_TRUSTED_PROXIES : adresse ou reseau illisible : " + entry);
            }

            list.Add(network);
        }

        return list;
    }

    public static ServerConfig FromEnvironment()
    {
        static string Read(string name, string fallback)
        {
            var value = Environment.GetEnvironmentVariable(name)?.Trim();
            return string.IsNullOrEmpty(value) ? fallback : value;
        }

        var port = int.TryParse(Read("REVIZATOR_PORT", "8080"), out var p) && p is > 0 and < 65536 ? p : 8080;
        var origins = Read("REVIZATOR_ALLOWED_ORIGINS", "https://app.organizator")
            .Split(new[] { ',', ';', ' ' }, StringSplitOptions.RemoveEmptyEntries)
            .Select(o => o.TrimEnd('/'))
            .ToHashSet(StringComparer.OrdinalIgnoreCase);

        return new ServerConfig
        {
            DataDir = Path.GetFullPath(Read("REVIZATOR_DATA", "/data")),
            Port = port,
            PublicUrl = Read("REVIZATOR_PUBLIC_URL", "http://localhost:" + port).TrimEnd('/'),
            AllowedOrigins = origins,
            WwwRoot = Path.GetFullPath(Read("REVIZATOR_WWWROOT", Path.Combine(AppContext.BaseDirectory, "wwwroot"))),
            TrustedProxies = ParseNetworks(Read("REVIZATOR_TRUSTED_PROXIES", "private")),
        };
    }
}
