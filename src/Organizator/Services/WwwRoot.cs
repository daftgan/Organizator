using System.IO;
using System.Reflection;

namespace Organizator.Services;

/// <summary>
/// Extraction des ressources web embarquees vers <c>&lt;dataDir&gt;\www\</c>.
/// Le dossier est reecrit a chaque demarrage ; les fichiers devenus orphelins sont supprimes.
/// </summary>
public static class WwwRoot
{
    private const string Prefix = "wwwroot/";

    /// <summary>
    /// Prepare le dossier a servir a la WebView2 et renvoie son chemin.
    /// En mode dev (<c>--wwwroot</c>) le dossier fourni est utilise tel quel, sans extraction.
    /// </summary>
    public static string Prepare(AppOptions options, HostLog log)
    {
        if (options.WwwRootOverride is { Length: > 0 } dev)
        {
            if (!Directory.Exists(dev))
            {
                log.Warn($"Dossier --wwwroot introuvable : {dev}");
            }
            else
            {
                log.Info($"Mode developpement : UI servie depuis {dev}");
            }

            return dev;
        }

        var target = Path.Combine(options.DataDir, "www");
        Extract(target, log);
        return target;
    }

    private static void Extract(string target, HostLog log)
    {
        Directory.CreateDirectory(target);

        var assembly = Assembly.GetExecutingAssembly();
        var written = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var count = 0;

        foreach (var name in assembly.GetManifestResourceNames())
        {
            var normalized = name.Replace('\\', '/');
            if (!normalized.StartsWith(Prefix, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            var relative = normalized[Prefix.Length..];
            if (relative.Length == 0)
            {
                continue;
            }

            var destination = Path.GetFullPath(Path.Combine(target, relative.Replace('/', Path.DirectorySeparatorChar)));

            // Garde-fou : une ressource ne doit jamais ecrire hors du dossier cible.
            if (!destination.StartsWith(Path.GetFullPath(target) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
            {
                log.Warn($"Ressource ignoree (chemin hors du dossier www) : {name}");
                continue;
            }

            try
            {
                var dir = Path.GetDirectoryName(destination);
                if (!string.IsNullOrEmpty(dir))
                {
                    Directory.CreateDirectory(dir);
                }

                using var source = assembly.GetManifestResourceStream(name);
                if (source is null)
                {
                    continue;
                }

                using var file = new FileStream(destination, FileMode.Create, FileAccess.Write, FileShare.None);
                source.CopyTo(file);
                written.Add(destination);
                count++;
            }
            catch (Exception ex)
            {
                log.Error($"Extraction impossible de {name}", ex);
            }
        }

        RemoveStaleFiles(target, written, log);
        log.Info($"Ressources web extraites vers {target} ({count} fichier(s))");
    }

    private static void RemoveStaleFiles(string target, HashSet<string> keep, HostLog log)
    {
        try
        {
            foreach (var existing in Directory.EnumerateFiles(target, "*", SearchOption.AllDirectories))
            {
                if (keep.Contains(Path.GetFullPath(existing)))
                {
                    continue;
                }

                try
                {
                    File.Delete(existing);
                }
                catch (Exception ex)
                {
                    log.Warn($"Fichier obsolete non supprime : {existing} ({ex.Message})");
                }
            }
        }
        catch (Exception ex)
        {
            log.Warn($"Nettoyage du dossier www impossible : {ex.Message}");
        }
    }
}
