using System.IO;
using System.Runtime.InteropServices;
using System.Security;
using System.Text;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media.Imaging;
using Microsoft.Win32;

namespace Organizator.Services;

/// <summary>
/// Notifications Windows (toasts) : elles s'affichent en bas a droite meme quand Organizator est
/// derriere ou reduit, et restent dans le centre de notifications, sous le nom « Organizator ».
///
/// L'API est WinRT (Windows.UI.Notifications). Plutot que de passer le projet sur un framework
/// cible windows10.0.x -- ce qui embarquerait ~24 Mo de projection pour quatre appels --, elle est
/// appelee par son ABI COM : RoGetActivationFactory, chaines HSTRING, interfaces declarees ici
/// avec les trois emplacements d'IInspectable en tete.
///
/// Une application de bureau non empaquetee doit declarer son AUMID pour que Windows accepte ses
/// notifications : la cle HKCU\Software\Classes\AppUserModelId\Organizator (nom affiche, icone)
/// suffit, sans raccourci du menu Demarrer. L'AUMID du processus n'est pas change, pour que la
/// fenetre reste groupee avec un Organizator epingle a la barre des taches.
///
/// Un clic sur la notification, tant qu'Organizator tourne, leve <see cref="Activated"/> avec les
/// arguments de la notification (sur un fil quelconque). Organizator ferme, le clic l'efface sans
/// relancer l'application (il faudrait pour cela enregistrer un serveur COM d'activation).
/// </summary>
public sealed class WindowsToasts
{
    public const string AppId = "Organizator";

    // Notifications gardees vivantes : leur evenement Activated ne part que tant que l'objet vit.
    private const int KeepAlive = 100;

    private readonly HostLog _log;
    private readonly string _iconPath;
    private readonly object _gate = new();
    private readonly LinkedList<(object Toast, ActivatedHandler Handler)> _alive = new();
    private IToastNotifier? _notifier;
    private IToastNotificationFactory? _factory;
    private bool _failed;

    public WindowsToasts(HostLog log, string dataDir)
    {
        _log = log;
        _iconPath = Path.Combine(dataDir, "notification-icon.png");
    }

    /// <summary>Clic sur une notification : ses arguments (<c>launch</c>).</summary>
    public event Action<string>? Activated;

    /// <summary>
    /// Affiche une notification. <paramref name="tag"/> la remplace dans le centre de notifications
    /// si une autre porte deja le meme (une conversation n'y laisse que sa derniere). Faux si Windows
    /// l'a refusee ; l'echec est journalise une fois, puis les notifications sont abandonnees.
    /// </summary>
    public bool Show(string title, string body, string attribution, string launch, string tag)
    {
        lock (_gate)
        {
            if (_failed)
            {
                return false;
            }

            try
            {
                EnsureNotifier();
                var xml = ToastXml(title, body, attribution, launch);
                var document = LoadXml(xml);
                IntPtr toastPtr;
                try
                {
                    Check(_factory!.CreateToastNotification(document, out toastPtr), "CreateToastNotification");
                }
                finally
                {
                    Marshal.Release(document);
                }

                try
                {
                    var toast = (IToastNotification)Marshal.GetObjectForIUnknown(toastPtr);
                    if (toast is IToastNotification2 tagged)
                    {
                        WithHString(Clip(tag, 64), h => Check(tagged.PutTag(h), "put_Tag"));
                        WithHString(AppId, h => Check(tagged.PutGroup(h), "put_Group"));
                    }

                    var handler = new ActivatedHandler(this);
                    var handlerPtr = Marshal.GetComInterfaceForObject(handler, typeof(IToastActivatedHandler));
                    try
                    {
                        Check(toast.AddActivated(handlerPtr, out _), "add_Activated");
                    }
                    finally
                    {
                        Marshal.Release(handlerPtr);
                    }

                    Check(_notifier!.Show(toast), "Show");
                    _alive.AddLast((toast, handler));
                    while (_alive.Count > KeepAlive)
                    {
                        _alive.RemoveFirst();
                    }
                }
                finally
                {
                    Marshal.Release(toastPtr);
                }

                return true;
            }
            catch (Exception ex)
            {
                _failed = true;
                _log.Warn("Notifications Windows indisponibles : " + ex.Message);
                return false;
            }
        }
    }

    private void Raise(string arguments)
    {
        try
        {
            Activated?.Invoke(arguments);
        }
        catch (Exception ex)
        {
            _log.Warn("Clic sur une notification : " + ex.Message);
        }
    }

    // ---------------------------------------------------------------- preparation

    private void EnsureNotifier()
    {
        if (_notifier is not null)
        {
            return;
        }

        Register();
        var statics = Factory<IToastNotificationManagerStatics>("Windows.UI.Notifications.ToastNotificationManager");
        IntPtr notifierPtr = IntPtr.Zero;
        WithHString(AppId, h => Check(statics.CreateToastNotifierWithId(h, out notifierPtr), "CreateToastNotifierWithId"));
        try
        {
            _notifier = (IToastNotifier)Marshal.GetObjectForIUnknown(notifierPtr);
        }
        finally
        {
            Marshal.Release(notifierPtr);
        }

        _factory = Factory<IToastNotificationFactory>("Windows.UI.Notifications.ToastNotification");
    }

    /// <summary>Declare l'AUMID (nom et icone affiches par Windows) ; reecrit a chaque lancement, l'executable a pu bouger.</summary>
    private void Register()
    {
        WriteIcon();
        using var key = Registry.CurrentUser.CreateSubKey(@"Software\Classes\AppUserModelId\" + AppId);
        key.SetValue("DisplayName", "Organizator");
        if (File.Exists(_iconPath))
        {
            key.SetValue("IconUri", _iconPath);
        }

        key.SetValue("IconBackgroundColor", "FFF3EDE4");
    }

    /// <summary>L'icone de l'executable, en PNG 256 px : c'est ce que Windows montre dans la notification.</summary>
    private void WriteIcon()
    {
        try
        {
            var exe = Environment.ProcessPath;
            if (string.IsNullOrEmpty(exe))
            {
                return;
            }

            var icons = new IntPtr[1];
            var ids = new uint[1];
            if (PrivateExtractIcons(exe, 0, 256, 256, icons, ids, 1, 0) < 1 || icons[0] == IntPtr.Zero)
            {
                return;
            }

            try
            {
                var source = Imaging.CreateBitmapSourceFromHIcon(icons[0], Int32Rect.Empty, BitmapSizeOptions.FromEmptyOptions());
                var encoder = new PngBitmapEncoder();
                encoder.Frames.Add(BitmapFrame.Create(source));
                Directory.CreateDirectory(Path.GetDirectoryName(_iconPath)!);
                using var stream = File.Create(_iconPath);
                encoder.Save(stream);
            }
            finally
            {
                DestroyIcon(icons[0]);
            }
        }
        catch (Exception ex)
        {
            _log.Warn("Icone des notifications non ecrite : " + ex.Message);
        }
    }

    private static string ToastXml(string title, string body, string attribution, string launch)
    {
        var sb = new StringBuilder();
        sb.Append("<toast launch=\"").Append(SecurityElement.Escape(launch)).Append("\" activationType=\"foreground\">");
        sb.Append("<visual><binding template=\"ToastGeneric\">");
        sb.Append("<text hint-maxLines=\"2\">").Append(SecurityElement.Escape(Clip(title, 200))).Append("</text>");
        if (body.Length > 0)
        {
            sb.Append("<text>").Append(SecurityElement.Escape(Clip(body, 400))).Append("</text>");
        }

        if (attribution.Length > 0)
        {
            sb.Append("<text placement=\"attribution\">").Append(SecurityElement.Escape(Clip(attribution, 80))).Append("</text>");
        }

        sb.Append("</binding></visual></toast>");
        return sb.ToString();
    }

    private static IntPtr LoadXml(string xml)
    {
        IntPtr instance = IntPtr.Zero;
        WithHString("Windows.Data.Xml.Dom.XmlDocument", h => Check(RoActivateInstance(h, out instance), "RoActivateInstance(XmlDocument)"));
        try
        {
            var io = (IXmlDocumentIO)Marshal.GetObjectForIUnknown(instance);
            WithHString(xml, h => Check(io.LoadXml(h), "LoadXml"));
            var iid = typeof(IXmlDocument).GUID;
            Check(Marshal.QueryInterface(instance, ref iid, out var document), "QueryInterface(IXmlDocument)");
            return document;
        }
        finally
        {
            Marshal.Release(instance);
        }
    }

    private static T Factory<T>(string className) where T : class
    {
        var iid = typeof(T).GUID;
        IntPtr factory = IntPtr.Zero;
        WithHString(className, h => Check(RoGetActivationFactory(h, ref iid, out factory), "RoGetActivationFactory(" + className + ")"));
        try
        {
            return (T)Marshal.GetObjectForIUnknown(factory);
        }
        finally
        {
            Marshal.Release(factory);
        }
    }

    private static void WithHString(string value, Action<IntPtr> use)
    {
        Check(WindowsCreateString(value, value.Length, out var handle), "WindowsCreateString");
        try
        {
            use(handle);
        }
        finally
        {
            WindowsDeleteString(handle);
        }
    }

    private static string FromHString(IntPtr handle)
    {
        if (handle == IntPtr.Zero)
        {
            return "";
        }

        var buffer = WindowsGetStringRawBuffer(handle, out var length);
        return buffer == IntPtr.Zero ? "" : Marshal.PtrToStringUni(buffer, (int)length);
    }

    private static void Check(int hr, string what)
    {
        if (hr < 0)
        {
            throw new InvalidOperationException($"{what} : 0x{hr:X8}");
        }
    }

    private static string Clip(string value, int max)
    {
        var text = (value ?? "").Trim();
        return text.Length <= max ? text : text[..(max - 1)].TrimEnd() + "…";
    }

    // ------------------------------------------------------------------ clic

    /// <summary>
    /// TypedEventHandler&lt;ToastNotification, Object&gt; vu par Windows : un delegue WinRT est une
    /// interface IUnknown a une methode. Son IID est celui de l'instanciation parametree
    /// (signature pinterface, UUID v5), verifie par le calcul.
    /// </summary>
    // Public : Windows appelle cet objet par COM, ce qui suppose un type visible de COM.
    [ComVisible(true)]
    [ClassInterface(ClassInterfaceType.None)]
    public sealed class ActivatedHandler : IToastActivatedHandler
    {
        private readonly WindowsToasts _owner;

        internal ActivatedHandler(WindowsToasts owner) => _owner = owner;

        public int Invoke(IntPtr sender, IntPtr args)
        {
            var arguments = "";
            try
            {
                if (args != IntPtr.Zero)
                {
                    var iid = typeof(IToastActivatedEventArgs).GUID;
                    if (Marshal.QueryInterface(args, ref iid, out var ptr) >= 0)
                    {
                        try
                        {
                            var activated = (IToastActivatedEventArgs)Marshal.GetObjectForIUnknown(ptr);
                            if (activated.GetArguments(out var handle) >= 0)
                            {
                                arguments = FromHString(handle);
                                WindowsDeleteString(handle);
                            }
                        }
                        finally
                        {
                            Marshal.Release(ptr);
                        }
                    }
                }
            }
            catch
            {
                // Arguments illisibles : le clic ramene quand meme la fenetre.
            }

            _owner.Raise(arguments);
            return 0;
        }
    }

    // ------------------------------------------------------------- ABI WinRT

    [DllImport("combase.dll", PreserveSig = true)]
    private static extern int RoGetActivationFactory(IntPtr activatableClassId, [In] ref Guid iid, out IntPtr factory);

    [DllImport("combase.dll", PreserveSig = true)]
    private static extern int RoActivateInstance(IntPtr activatableClassId, out IntPtr instance);

    [DllImport("combase.dll", PreserveSig = true, CharSet = CharSet.Unicode)]
    private static extern int WindowsCreateString(string sourceString, int length, out IntPtr hstring);

    [DllImport("combase.dll", PreserveSig = true)]
    private static extern int WindowsDeleteString(IntPtr hstring);

    [DllImport("combase.dll", PreserveSig = true)]
    private static extern IntPtr WindowsGetStringRawBuffer(IntPtr hstring, out uint length);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern uint PrivateExtractIcons(string file, int index, int cx, int cy, IntPtr[] icons, uint[] ids, uint count, uint flags);

    [DllImport("user32.dll")]
    private static extern bool DestroyIcon(IntPtr icon);

    // Chaque interface WinRT commence par les trois methodes d'IInspectable (jamais appelees ici).

    [ComImport, Guid("50AC103F-D235-4598-BBEF-98FE4D1A3AD4"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IToastNotificationManagerStatics
    {
        [PreserveSig] int GetIids(out int count, out IntPtr iids);
        [PreserveSig] int GetRuntimeClassName(out IntPtr name);
        [PreserveSig] int GetTrustLevel(out int level);
        [PreserveSig] int CreateToastNotifier(out IntPtr notifier);
        [PreserveSig] int CreateToastNotifierWithId(IntPtr applicationId, out IntPtr notifier);
        [PreserveSig] int GetTemplateContent(int type, out IntPtr content);
    }

    [ComImport, Guid("75927B93-03F3-41EC-91D3-6E5BAC1B38E7"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IToastNotifier
    {
        [PreserveSig] int GetIids(out int count, out IntPtr iids);
        [PreserveSig] int GetRuntimeClassName(out IntPtr name);
        [PreserveSig] int GetTrustLevel(out int level);
        [PreserveSig] int Show(IToastNotification notification);
        [PreserveSig] int Hide(IToastNotification notification);
        [PreserveSig] int GetSetting(out int value);
    }

    [ComImport, Guid("04124B20-82C6-4229-B109-FD9ED4662B53"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IToastNotificationFactory
    {
        [PreserveSig] int GetIids(out int count, out IntPtr iids);
        [PreserveSig] int GetRuntimeClassName(out IntPtr name);
        [PreserveSig] int GetTrustLevel(out int level);
        [PreserveSig] int CreateToastNotification(IntPtr content, out IntPtr notification);
    }

    [ComImport, Guid("997E2675-059E-4E60-8B06-1760917C8B80"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IToastNotification
    {
        [PreserveSig] int GetIids(out int count, out IntPtr iids);
        [PreserveSig] int GetRuntimeClassName(out IntPtr name);
        [PreserveSig] int GetTrustLevel(out int level);
        [PreserveSig] int GetContent(out IntPtr content);
        [PreserveSig] int PutExpirationTime(IntPtr value);
        [PreserveSig] int GetExpirationTime(out IntPtr value);
        [PreserveSig] int AddDismissed(IntPtr handler, out long token);
        [PreserveSig] int RemoveDismissed(long token);
        [PreserveSig] int AddActivated(IntPtr handler, out long token);
        [PreserveSig] int RemoveActivated(long token);
    }

    [ComImport, Guid("9DFB9FD1-143A-490E-90BF-B9FBA7132DE7"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IToastNotification2
    {
        [PreserveSig] int GetIids(out int count, out IntPtr iids);
        [PreserveSig] int GetRuntimeClassName(out IntPtr name);
        [PreserveSig] int GetTrustLevel(out int level);
        [PreserveSig] int PutTag(IntPtr value);
        [PreserveSig] int GetTag(out IntPtr value);
        [PreserveSig] int PutGroup(IntPtr value);
        [PreserveSig] int GetGroup(out IntPtr value);
    }

    [ComImport, Guid("6CD0E74E-EE65-4489-9EBF-CA43E87BA637"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IXmlDocumentIO
    {
        [PreserveSig] int GetIids(out int count, out IntPtr iids);
        [PreserveSig] int GetRuntimeClassName(out IntPtr name);
        [PreserveSig] int GetTrustLevel(out int level);
        [PreserveSig] int LoadXml(IntPtr xml);
    }

    [ComImport, Guid("F7F3A506-1E87-42D6-BCFB-B8C809FA5494"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IXmlDocument
    {
        [PreserveSig] int GetIids(out int count, out IntPtr iids);
    }

    [ComImport, Guid("E3BF92F3-C197-436F-8265-0625824F8DAC"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IToastActivatedEventArgs
    {
        [PreserveSig] int GetIids(out int count, out IntPtr iids);
        [PreserveSig] int GetRuntimeClassName(out IntPtr name);
        [PreserveSig] int GetTrustLevel(out int level);
        [PreserveSig] int GetArguments(out IntPtr arguments);
    }

    [ComVisible(true)]
    [ComImport, Guid("AB54DE2D-97D9-5528-B6AD-105AFE156530"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IToastActivatedHandler
    {
        [PreserveSig] int Invoke(IntPtr sender, IntPtr args);
    }
}
