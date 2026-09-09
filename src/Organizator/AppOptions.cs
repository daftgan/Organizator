using System.IO;

namespace Organizator;

/// <summary>
/// Options de ligne de commande.
/// <list type="bullet">
///   <item><c>--data &lt;dossier&gt;</c> remplace <c>%LOCALAPPDATA%\Organizator</c>.</item>
///   <item><c>--wwwroot &lt;dossier&gt;</c> sert l'UI depuis ce dossier au lieu des ressources embarquees (mode dev).</item>
///   <item><c>--page &lt;nom.html&gt;</c> choisit la page de demarrage (par defaut <c>index.html</c>).</item>
/// </list>
/// </summary>
public sealed class AppOptions
{
    public const string DefaultPage = "index.html";

    public string DataDir { get; private set; } = "";

    /// <summary>Dossier passe via <c>--wwwroot</c>, ou <c>null</c> si on utilise les ressources embarquees.</summary>
    public string? WwwRootOverride { get; private set; }

    public string Page { get; private set; } = DefaultPage;

    /// <summary>Vrai en mode developpement : F5 / Ctrl+R / F12 sont autorises.</summary>
    public bool IsDev => WwwRootOverride is not null;

    public static AppOptions Parse(string[] args)
    {
        var options = new AppOptions();
        string? data = null;

        for (var i = 0; i < args.Length; i++)
        {
            var arg = args[i];
            switch (arg)
            {
                case "--data" when i + 1 < args.Length:
                    data = args[++i];
                    break;
                case "--wwwroot" when i + 1 < args.Length:
                    options.WwwRootOverride = args[++i];
                    break;
                case "--page" when i + 1 < args.Length:
                    options.Page = args[++i];
                    break;
            }
        }

        options.DataDir = NormalizeDir(data) ?? Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Organizator");

        if (options.WwwRootOverride is not null)
        {
            options.WwwRootOverride = NormalizeDir(options.WwwRootOverride);
        }

        if (string.IsNullOrWhiteSpace(options.Page))
        {
            options.Page = DefaultPage;
        }

        return options;
    }

    private static string? NormalizeDir(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        try
        {
            return Path.GetFullPath(Environment.ExpandEnvironmentVariables(value.Trim()));
        }
        catch
        {
            return null;
        }
    }
}
