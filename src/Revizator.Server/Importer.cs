using System.Text.Json.Nodes;

namespace Revizator.Server;

/// <summary>
/// <c>revizator-server import &lt;dossier&gt;</c> : reprend <c>learning.json</c> et <c>learning/</c> d'une copie
/// du dossier <c>%LOCALAPPDATA%\Organizator\</c> du PC. L'existant est d'abord deplace sous
/// <c>import-backup-&lt;date&gt;/</c> ; rien d'autre du PC (taches, reglages, sessions) n'est lu.
/// A lancer serveur arrete (ou sans page ouverte) : une page ouverte reecrirait son ancien etat.
/// </summary>
public static class Importer
{
    public static void Run(string source, string dataDir, TextWriter output)
    {
        var from = Path.GetFullPath(source);
        var state = Path.Combine(from, "learning.json");
        var folder = Path.Combine(from, "learning");
        if (!File.Exists(state) && !Directory.Exists(folder))
        {
            throw new InvalidOperationException($"Ni learning.json ni learning/ dans {from}.");
        }

        if (File.Exists(state))
        {
            try
            {
                if (JsonNode.Parse(File.ReadAllText(state)) is not JsonObject)
                {
                    throw new InvalidOperationException("learning.json ne contient pas un objet JSON.");
                }
            }
            catch (System.Text.Json.JsonException ex)
            {
                throw new InvalidOperationException("learning.json illisible : " + ex.Message);
            }
        }

        Directory.CreateDirectory(dataDir);
        var targetState = Path.Combine(dataDir, "learning.json");
        var targetFolder = Path.Combine(dataDir, "learning");
        var backup = Path.Combine(dataDir, "import-backup-" + DateTime.Now.ToString("yyyyMMdd-HHmmss"));

        // Sauvegarde de l'existant, deplace tel quel.
        var saved = false;
        foreach (var name in new[] { "learning.json", "learning.json.bak" })
        {
            var existing = Path.Combine(dataDir, name);
            if (File.Exists(existing))
            {
                Directory.CreateDirectory(backup);
                File.Move(existing, Path.Combine(backup, name));
                saved = true;
            }
        }

        if (Directory.Exists(targetFolder))
        {
            Directory.CreateDirectory(backup);
            Directory.Move(targetFolder, Path.Combine(backup, "learning"));
            saved = true;
        }

        var files = 0;
        if (File.Exists(state))
        {
            File.Copy(state, targetState);
            files++;
        }

        if (Directory.Exists(folder))
        {
            files += CopyTree(folder, targetFolder);
        }

        output.WriteLine($"Import termine : {files} fichier(s) depuis {from}.");
        output.WriteLine(saved ? "Ancien contenu sauvegarde sous " + backup : "Rien a sauvegarder (dossier de donnees vide).");
    }

    /// <summary>Copie recursive ; les liens symboliques sont ignores.</summary>
    private static int CopyTree(string from, string to)
    {
        Directory.CreateDirectory(to);
        var count = 0;
        foreach (var entry in new DirectoryInfo(from).EnumerateFileSystemInfos())
        {
            if (entry.LinkTarget is not null)
            {
                continue;
            }

            var target = Path.Combine(to, entry.Name);
            if (entry is DirectoryInfo dir)
            {
                count += CopyTree(dir.FullName, target);
            }
            else
            {
                File.Copy(entry.FullName, target, overwrite: true);
                count++;
            }
        }

        return count;
    }
}
