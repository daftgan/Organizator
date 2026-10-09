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
        };
    }
}
