using System.ComponentModel;
using System.Text.Json.Nodes;
using System.Windows;
using Microsoft.Web.WebView2.Core;
using Organizator.Bridge;
using Organizator.Services;

namespace Organizator;

/// <summary>
/// Fenetre Conversations : les sessions d'agent hebergees par Organizator (reglage « Terminal » = app),
/// a la maniere de Claude Code Desktop — les sessions par tache a gauche, la conversation au centre, et
/// a droite un panneau (document montre par l'agent, resume de la conversation).
/// Une seconde WebView2 du meme environnement que la fenetre principale, branchee sur le meme pont
/// (<see cref="BridgeHost.AttachView"/>), qui sert <c>conversations.html</c>. La fermer la masque : les
/// sessions continuent de tourner ; elle ne se ferme vraiment qu'avec Organizator.
/// </summary>
public partial class ConversationsWindow : Window
{
    private const string VirtualHost = "app.organizator";

    private readonly CoreWebView2Environment _environment;
    private readonly string _wwwFolder;
    private readonly BridgeHost _bridge;
    private readonly DataStore _store;
    private readonly HostLog _log;
    private readonly bool _dev;
    private CoreWebView2? _core;
    private string? _pendingFocus;

    public ConversationsWindow(CoreWebView2Environment environment, string wwwFolder, BridgeHost bridge, DataStore store, HostLog log, bool dev)
    {
        _environment = environment;
        _wwwFolder = wwwFolder;
        _bridge = bridge;
        _store = store;
        _log = log;
        _dev = dev;

        InitializeComponent();
        Web.DefaultBackgroundColor = System.Drawing.Color.FromArgb(0xFF, 0xF5, 0xEA, 0xD8);
        MainWindow.ApplyPlacement(this, _store.LoadSettings().ConversationsWindow, _log);

        Loaded += OnLoaded;
        Closing += OnClosing;
    }

    /// <summary>Vrai quand Organizator se ferme : la fenetre se ferme pour de bon au lieu de se masquer.</summary>
    public bool AllowClose { get; set; }

    /// <summary>Montre la fenetre au premier plan et, s'il y en a une, la session demandee.</summary>
    public void ShowSession(string? sessionId)
    {
        if (!IsVisible)
        {
            Show();
        }

        if (WindowState == WindowState.Minimized)
        {
            WindowState = WindowState.Normal;
        }

        Activate();
        if (string.IsNullOrWhiteSpace(sessionId))
        {
            return;
        }

        if (_core is null)
        {
            _pendingFocus = sessionId;
            return;
        }

        _bridge.PostEventTo(_core, "liveFocus", new JsonObject { ["sessionId"] = sessionId });
    }

    private async void OnLoaded(object sender, RoutedEventArgs e)
    {
        try
        {
            await Web.EnsureCoreWebView2Async(_environment);
            var core = Web.CoreWebView2;
            var settings = core.Settings;
            settings.AreDefaultContextMenusEnabled = false;
            settings.IsStatusBarEnabled = false;
            settings.IsZoomControlEnabled = false;
            settings.IsSwipeNavigationEnabled = false;
            settings.IsGeneralAutofillEnabled = false;
            settings.IsPasswordAutosaveEnabled = false;
            settings.AreBrowserAcceleratorKeysEnabled = _dev;
            settings.AreDevToolsEnabled = _dev;
            Web.ZoomFactor = 1.0;

            core.NewWindowRequested += (_, args) =>
            {
                args.Handled = true;
                MainWindow.OpenExternally(args.Uri, _log);
            };
            core.NavigationStarting += (_, args) =>
            {
                if (Uri.TryCreate(args.Uri, UriKind.Absolute, out var uri)
                    && !string.Equals(uri.Host, VirtualHost, StringComparison.OrdinalIgnoreCase)
                    && uri.Scheme is not ("about" or "data"))
                {
                    args.Cancel = true;
                    MainWindow.OpenExternally(args.Uri, _log);
                }
            };
            // Le panneau de droite affiche les documents dans des cadres (page HTML, PDF) : un lien externe
            // qui y est clique part dans le navigateur, comme dans le lecteur de la fenetre principale.
            core.FrameNavigationStarting += (_, args) =>
            {
                if (Uri.TryCreate(args.Uri, UriKind.Absolute, out var uri)
                    && uri.Scheme is ("http" or "https")
                    && !string.Equals(uri.Host, VirtualHost, StringComparison.OrdinalIgnoreCase)
                    && !string.Equals(uri.Host, ArtifactReader.Host, StringComparison.OrdinalIgnoreCase))
                {
                    args.Cancel = true;
                    MainWindow.OpenExternally(args.Uri, _log);
                }
            };
            // La dictee enregistre le micro depuis la page : accorde a la page de l'application, et a elle seule.
            core.PermissionRequested += (_, args) =>
            {
                if (args.PermissionKind == CoreWebView2PermissionKind.Microphone
                    && Uri.TryCreate(args.Uri, UriKind.Absolute, out var uri)
                    && string.Equals(uri.Host, VirtualHost, StringComparison.OrdinalIgnoreCase))
                {
                    args.State = CoreWebView2PermissionState.Allow;
                }
            };
            core.ProcessFailed += (_, args) => _log.Error($"Fenetre Conversations : processus WebView2 en echec : {args.ProcessFailedKind} / {args.Reason}");

            core.SetVirtualHostNameToFolderMapping(VirtualHost, _wwwFolder, CoreWebView2HostResourceAccessKind.Allow);
            // Images jointes aux messages : la zone de saisie et le fil en montrent les vignettes.
            core.SetVirtualHostNameToFolderMapping(TaskAttachments.Host, _bridge.AttachmentsRoot, CoreWebView2HostResourceAccessKind.Allow);
            _bridge.AttachView(core, this);
            _core = core;

            var url = $"https://{VirtualHost}/conversations.html";
            if (_pendingFocus is { } focus)
            {
                url += "?session=" + Uri.EscapeDataString(focus);
                _pendingFocus = null;
            }

            _log.Info("Fenetre Conversations : navigation vers " + url);
            core.Navigate(url);
        }
        catch (Exception ex)
        {
            _log.Error("Fenetre Conversations : initialisation de la WebView2 impossible", ex);
        }
    }

    private void OnClosing(object? sender, CancelEventArgs e)
    {
        try
        {
            if (MainWindow.CapturePlacement(this) is { } placement)
            {
                _store.SaveConversationsPlacement(placement);
            }
        }
        catch (Exception ex)
        {
            _log.Warn("Fenetre Conversations : position non enregistree (" + ex.Message + ").");
        }

        if (AllowClose)
        {
            if (_core is not null)
            {
                _bridge.DetachView(_core);
            }

            return;
        }

        // Les sessions continuent : la fenetre se masque, et revient telle quelle.
        e.Cancel = true;
        Hide();
    }
}
