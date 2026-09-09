using System.Runtime.InteropServices;
using System.Text;

namespace Organizator.Services;

/// <summary>
/// Lecture des identifiants generiques du Gestionnaire d'identifiants Windows (advapi32),
/// la ou la CLI Copilot range son jeton OAuth. Lecture seule : rien n'est jamais ecrit ni supprime.
/// </summary>
public static class WindowsCredentials
{
    private const uint GenericType = 1;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct Credential
    {
        public uint Flags;
        public uint Type;
        public string TargetName;
        public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint CredentialBlobSize;
        public IntPtr CredentialBlob;
        public uint Persist;
        public uint AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias;
        public string UserName;
    }

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredReadW(string target, uint type, uint flags, out IntPtr credential);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredEnumerateW(string? filter, uint flags, out uint count, out IntPtr credentials);

    [DllImport("advapi32.dll")]
    private static extern void CredFree(IntPtr buffer);

    /// <summary>Secret d'un identifiant generique, ou <c>null</c> s'il n'existe pas.</summary>
    public static string? Read(string target)
    {
        if (string.IsNullOrWhiteSpace(target) || !CredReadW(target, GenericType, 0, out var handle))
        {
            return null;
        }

        try
        {
            var credential = Marshal.PtrToStructure<Credential>(handle);
            return Decode(credential);
        }
        finally
        {
            CredFree(handle);
        }
    }

    /// <summary>Noms des identifiants generiques correspondant au filtre (joker <c>*</c> en fin).</summary>
    public static IReadOnlyList<string> List(string filter)
    {
        var names = new List<string>();
        if (!CredEnumerateW(filter, 0, out var count, out var array))
        {
            return names;
        }

        try
        {
            for (var i = 0; i < count; i++)
            {
                var pointer = Marshal.ReadIntPtr(array, i * IntPtr.Size);
                var credential = Marshal.PtrToStructure<Credential>(pointer);
                if (credential.Type == GenericType && !string.IsNullOrEmpty(credential.TargetName))
                {
                    names.Add(credential.TargetName);
                }
            }
        }
        finally
        {
            CredFree(array);
        }

        return names;
    }

    // keytar ecrit le secret en UTF-8, la bibliotheque keyring de Rust en UTF-16 :
    // on reconnait l'UTF-16 a ses octets nuls.
    private static string? Decode(in Credential credential)
    {
        if (credential.CredentialBlobSize == 0 || credential.CredentialBlob == IntPtr.Zero)
        {
            return null;
        }

        var bytes = new byte[credential.CredentialBlobSize];
        Marshal.Copy(credential.CredentialBlob, bytes, 0, bytes.Length);

        var zeros = bytes.Count(b => b == 0);
        var text = zeros * 3 > bytes.Length ? Encoding.Unicode.GetString(bytes) : Encoding.UTF8.GetString(bytes);
        return text.Trim('\0', ' ', '\r', '\n');
    }
}
