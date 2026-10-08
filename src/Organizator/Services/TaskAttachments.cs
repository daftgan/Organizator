using System.IO;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Organizator.Services;

/// <summary>
/// Pieces jointes des taches : fichiers, images collees et blocs de texte que l'utilisateur
/// attache a une tache pour que l'agent les lise. Tout est copie sous
/// <c>&lt;donnees&gt;\attachments\&lt;tache&gt;\</c> : la tache reste complete meme si l'original
/// est deplace ou supprime, et l'agent recoit des chemins stables. Le dossier est servi a l'UI
/// sous <c>https://attach.organizator/</c> pour les vignettes des images.
/// Les raisons d'un refus sont des codes (<c>folder</c>, <c>missing</c>, <c>too-large</c>,
/// <c>error</c>) : l'UI porte les phrases.
/// </summary>
public sealed class TaskAttachments
{
    public const string Host = "attach.organizator";

    // Au-dela, on n'a vraisemblablement pas voulu copier le fichier (image disque, archive de logs).
    public const long MaxFileBytes = 200L * 1024 * 1024;

    // Image collee ou deposee sans chemin, transmise en base64 par la page.
    public const int MaxDataBytes = 40 * 1024 * 1024;

    // Bloc de texte : un log ou un mail colle, pas un livre.
    public const int MaxTextChars = 400_000;

    private static readonly Regex SafeId = new("^[A-Za-z0-9_-]{1,64}$", RegexOptions.CultureInvariant);

    private static readonly HashSet<string> ImageExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp",
    };

    private readonly HostLog _log;

    public TaskAttachments(string dataDir, HostLog log)
    {
        Root = Path.GetFullPath(Path.Combine(dataDir, "attachments"));
        _log = log;
        try
        {
            Directory.CreateDirectory(Root);
        }
        catch (Exception ex)
        {
            _log.Warn("Dossier des pieces jointes impossible a creer : " + ex.Message);
        }
    }

    public string Root { get; }

    /// <summary>Copie des fichiers existants dans le dossier de la tache.</summary>
    public JsonObject AddFiles(string? taskId, IEnumerable<string> sources)
    {
        var dir = TaskDir(taskId, create: true);
        var added = new JsonArray();
        var skipped = new JsonArray();

        foreach (var raw in sources)
        {
            var source = (raw ?? "").Trim();
            if (source.Length == 0)
            {
                continue;
            }

            var name = Path.GetFileName(source.TrimEnd('\\', '/'));
            try
            {
                source = Path.GetFullPath(source);
                if (Directory.Exists(source))
                {
                    skipped.Add(Skip(name, "folder"));
                    continue;
                }

                var info = new FileInfo(source);
                if (!info.Exists)
                {
                    skipped.Add(Skip(name, "missing"));
                    continue;
                }

                if (info.Length > MaxFileBytes)
                {
                    skipped.Add(Skip(name, "too-large"));
                    continue;
                }

                // Deja range sous cette tache (fichier redepose depuis son propre dossier) : rien a copier.
                var target = IsUnder(source, dir) ? source : UniquePath(dir, info.Name);
                if (!string.Equals(target, source, StringComparison.OrdinalIgnoreCase))
                {
                    File.Copy(source, target, overwrite: false);
                }

                added.Add(Describe(target));
            }
            catch (Exception ex)
            {
                _log.Warn($"Piece jointe non copiee ({source}) : {ex.Message}");
                skipped.Add(Skip(name, "error", ex.Message));
            }
        }

        return new JsonObject { ["attachments"] = added, ["skipped"] = skipped };
    }

    /// <summary>Ecrit un fichier transmis par la page (image collee depuis le presse-papiers).</summary>
    public JsonObject AddData(string? taskId, string? name, string? base64)
    {
        var dir = TaskDir(taskId, create: true);
        byte[] bytes;
        try
        {
            bytes = Convert.FromBase64String(base64 ?? "");
        }
        catch (FormatException)
        {
            throw new InvalidOperationException("Contenu illisible (base64 attendu).");
        }

        var skipped = new JsonArray();
        var added = new JsonArray();
        var fileName = SafeFileName(name, "image.png");
        if (bytes.Length == 0)
        {
            skipped.Add(Skip(fileName, "missing"));
        }
        else if (bytes.Length > MaxDataBytes)
        {
            skipped.Add(Skip(fileName, "too-large"));
        }
        else
        {
            var target = UniquePath(dir, fileName);
            File.WriteAllBytes(target, bytes);
            added.Add(Describe(target));
        }

        return new JsonObject { ["attachments"] = added, ["skipped"] = skipped };
    }

    /// <summary>
    /// Ecrit (ou reecrit) le fichier d'un bloc de texte : <c>texte-&lt;id&gt;.txt</c>. Le texte vit
    /// dans data.json pour l'affichage ; ce fichier est ce que l'agent lit quand le bloc est trop
    /// long pour partir dans son premier message.
    /// </summary>
    public JsonObject WriteText(string? taskId, string? id, string? text)
    {
        if (string.IsNullOrEmpty(id) || !SafeId.IsMatch(id))
        {
            throw new InvalidOperationException("Identifiant de bloc invalide.");
        }

        var content = text ?? "";
        if (content.Length > MaxTextChars)
        {
            throw new InvalidOperationException($"Texte trop long ({content.Length} caracteres, {MaxTextChars} au plus) : joignez-le plutot comme fichier.");
        }

        var dir = TaskDir(taskId, create: true);
        var target = Path.Combine(dir, "texte-" + id + ".txt");
        var tmp = target + ".tmp";
        // Lignes Windows : le bloc s'ouvre tel quel dans le Bloc-notes comme dans l'editeur de l'agent.
        File.WriteAllText(tmp, content.Replace("\r\n", "\n").Replace("\n", "\r\n"), new UTF8Encoding(false));
        File.Move(tmp, target, overwrite: true);
        return Describe(target);
    }

    /// <summary>Supprime le fichier d'une piece jointe (seulement sous le dossier des pieces jointes).</summary>
    public bool Remove(string? path)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            return false;
        }

        string full;
        try
        {
            full = Path.GetFullPath(path);
        }
        catch
        {
            return false;
        }

        if (!IsUnder(full, Root) || !File.Exists(full))
        {
            return false;
        }

        File.Delete(full);
        return true;
    }

    /// <summary>Supprime le dossier entier d'une tache (tache supprimee, creation abandonnee).</summary>
    public bool RemoveTask(string? taskId)
    {
        var dir = TaskDir(taskId, create: false);
        if (!Directory.Exists(dir))
        {
            return false;
        }

        Directory.Delete(dir, recursive: true);
        return true;
    }

    // ------------------------------------------------------------------ outils

    private string TaskDir(string? taskId, bool create)
    {
        if (string.IsNullOrEmpty(taskId) || !SafeId.IsMatch(taskId))
        {
            throw new InvalidOperationException("Identifiant de tache invalide.");
        }

        var dir = Path.Combine(Root, taskId);
        if (create)
        {
            Directory.CreateDirectory(dir);
        }

        return dir;
    }

    private static bool IsUnder(string path, string folder)
    {
        var root = folder.TrimEnd('\\', '/') + Path.DirectorySeparatorChar;
        return path.StartsWith(root, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>« capture.png », puis « capture (2).png », « capture (3).png »...</summary>
    private static string UniquePath(string dir, string fileName)
    {
        var safe = SafeFileName(fileName, "fichier");
        var target = Path.Combine(dir, safe);
        if (!File.Exists(target))
        {
            return target;
        }

        var stem = Path.GetFileNameWithoutExtension(safe);
        var ext = Path.GetExtension(safe);
        for (var i = 2; i < 10_000; i++)
        {
            target = Path.Combine(dir, $"{stem} ({i}){ext}");
            if (!File.Exists(target))
            {
                return target;
            }
        }

        return Path.Combine(dir, $"{stem}-{Guid.NewGuid():N}{ext}");
    }

    private static string SafeFileName(string? name, string fallback)
    {
        var raw = Path.GetFileName((name ?? "").Trim());
        var builder = new StringBuilder(raw.Length);
        var invalid = Path.GetInvalidFileNameChars();
        foreach (var c in raw)
        {
            builder.Append(Array.IndexOf(invalid, c) >= 0 || char.IsControl(c) ? '_' : c);
        }

        var safe = builder.ToString().Trim().TrimEnd('.');
        if (safe.Length == 0 || safe.Trim('_').Length == 0)
        {
            safe = fallback;
        }

        if (safe.Length > 120)
        {
            var ext = Path.GetExtension(safe);
            safe = safe[..(120 - Math.Min(ext.Length, 20))] + (ext.Length <= 20 ? ext : "");
        }

        return safe;
    }

    private static JsonObject Describe(string path)
    {
        var info = new FileInfo(path);
        return new JsonObject
        {
            ["name"] = info.Name,
            ["path"] = info.FullName,
            ["size"] = info.Exists ? info.Length : 0,
            ["kind"] = ImageExtensions.Contains(info.Extension) ? "image" : "file",
        };
    }

    private static JsonObject Skip(string? name, string reason, string? detail = null) => new()
    {
        ["name"] = name ?? "",
        ["reason"] = reason,
        ["detail"] = detail ?? "",
    };
}
