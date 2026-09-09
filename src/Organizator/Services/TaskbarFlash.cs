using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Interop;

namespace Organizator.Services;

/// <summary>
/// Fait clignoter le bouton de la fenetre dans la barre des taches, comme un terminal qui signale
/// une commande terminee. Sans effet si la fenetre est deja au premier plan.
/// </summary>
public static class TaskbarFlash
{
    private const uint FlashTray = 0x2;
    private const uint FlashTimerNoForeground = 0xC;

    [StructLayout(LayoutKind.Sequential)]
    private struct FlashInfo
    {
        public uint Size;
        public IntPtr Handle;
        public uint Flags;
        public uint Count;
        public uint Timeout;
    }

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool FlashWindowEx(ref FlashInfo info);

    /// <summary>Retourne vrai si le clignotement a ete demande.</summary>
    public static bool Flash(Window window)
    {
        try
        {
            if (window.IsActive)
            {
                return false;
            }

            var handle = new WindowInteropHelper(window).Handle;
            if (handle == IntPtr.Zero)
            {
                return false;
            }

            var info = new FlashInfo
            {
                Size = (uint)Marshal.SizeOf<FlashInfo>(),
                Handle = handle,
                Flags = FlashTray | FlashTimerNoForeground,
                Count = 6,
                Timeout = 0,
            };

            return FlashWindowEx(ref info);
        }
        catch
        {
            return false;
        }
    }
}
