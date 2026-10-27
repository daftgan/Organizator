using System.IO;
using System.Runtime.InteropServices;

namespace Organizator.Services;

/// <summary>
/// Supprime un fichier en l'envoyant a la Corbeille, comme l'Explorateur : il se recupere. Sur un
/// lecteur sans Corbeille (partage reseau), Windows demande avant de le supprimer pour de bon.
/// </summary>
public static class RecycleBin
{
    private const uint FoDelete = 0x0003;
    private const ushort FofSilent = 0x0004;
    private const ushort FofNoConfirmation = 0x0010;
    private const ushort FofAllowUndo = 0x0040;
    private const ushort FofWantNukeWarning = 0x4000;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct FileOperation
    {
        public IntPtr Window;
        public uint Function;
        public string From;
        public string? To;
        public ushort Flags;
        public int Aborted;
        public IntPtr NameMappings;
        public string? ProgressTitle;
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern int SHFileOperation(ref FileOperation operation);

    /// <summary>
    /// Envoie le fichier a la Corbeille ; <paramref name="owner"/> porte l'avertissement de Windows
    /// si la Corbeille n'est pas possible. Rend faux si l'utilisateur l'a refuse.
    /// </summary>
    public static bool Send(string path, IntPtr owner)
    {
        var full = Path.GetFullPath(path);
        if (!File.Exists(full))
        {
            throw new InvalidOperationException("Le fichier n'existe plus : " + full);
        }

        var operation = new FileOperation
        {
            Window = owner,
            Function = FoDelete,
            // Liste de chemins terminee par deux caracteres nuls (le marshaling en ajoute un).
            From = full + "\0",
            Flags = (ushort)(FofAllowUndo | FofNoConfirmation | FofSilent | FofWantNukeWarning),
        };

        var code = SHFileOperation(ref operation);
        if (operation.Aborted != 0)
        {
            return false;
        }

        if (code != 0 || File.Exists(full))
        {
            throw new InvalidOperationException($"Suppression impossible (code {code}) : le fichier est peut-être ouvert dans une autre application.");
        }

        return true;
    }
}
