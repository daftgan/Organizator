using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Windows;
using Microsoft.Web.WebView2.Core;
using Organizator.Bridge;
using Organizator.Services;

namespace Organizator;

public partial class MainWindow : Window
{
    private const string VirtualHost = "app.organizator";
    private static readonly TimeSpan FlushTimeout = TimeSpan.FromSeconds(1);

    private readonly AppOptions _options;
    private readonly HostLog _log;
    private readonly DataStore _store;
    private readonly ClaudeSessions _sessions;
    private readonly CopilotSessions _copilot;
    private readonly AgentLauncher _launcher;

    private BridgeHost? _bridge;
    private SessionsWatcher? _claudeWatcher;
    private SessionsWatcher? _copilotWatcher;
    private AgentProcessScanner? _scanner;
    private PerfMonitor? _perf;
    private bool _closingHandled;
    private bool _sessionEnding;

    // Fenetre Conversations (sessions hebergees) : creee au premier besoin, dans le meme environnement WebView2.
    private CoreWebView2Environment? _environment;
    private string? _wwwFolder;
    private ConversationsWindow? _conversations;

    public MainWindow(
        AppOptions options,
        HostLog log,
        DataStore store,
        ClaudeSessions sessions,
        CopilotSessions copilot,
        AgentLauncher launcher)
    {
        _options = options;
        _log = log;
        _store = store;
        _sessions = sessions;
        _copilot = copilot;
        _launcher = launcher;

        InitializeComponent();

        // Evite le flash blanc pendant le chargement de la page.
        Web.DefaultBackgroundColor = System.Drawing.Color.FromArgb(0xFF, 0xF5, 0xEA, 0xD8);

        RestorePlacement(_store.LoadSettings().Window);

        Loaded += OnLoaded;
        Closing += OnClosing;
        Activated += OnActivated;
        // Fermeture de session Windows : pas de question, elle bloquerait l'arret du poste.
        Application.Current.SessionEnding += (_, _) => _sessionEnding = true;
    }

    // ------------------------------------------------------------------ fenetre

    private void RestorePlacement(WindowPlacement? placement) => ApplyPlacement(this, placement, _log);

    /// <summary>Remet une fenetre (principale ou Conversations) a la place enregistree, si elle tombe a l'ecran.</summary>
    internal static void ApplyPlacement(Window window, WindowPlacement? placement, HostLog log)
    {
        if (placement is null || placement.Width < 200 || placement.Height < 150)
        {
            return;
        }

        var width = Math.Max(window.MinWidth, placement.Width);
        var height = Math.Max(window.MinHeight, placement.Height);

        if (!IsVisibleOnAnyScreen(placement.X, placement.Y, width, height))
        {
            log.Warn("Position de fenetre enregistree hors ecran, retour au centrage.");
            window.Width = width;
            window.Height = height;
            return;
        }

        window.WindowStartupLocation = WindowStartupLocation.Manual;
        window.Left = placement.X;
        window.Top = placement.Y;
        window.Width = width;
        window.Height = height;

        if (placement.Maximized)
        {
            window.WindowState = WindowState.Maximized;
        }
    }

    /// <summary>
    /// Verifie qu'une part suffisante de la fenetre tombe dans le bureau virtuel
    /// (union des ecrans branches). Evite de restaurer une fenetre invisible apres
    /// le debranchement d'un ecran.
    /// </summary>
    private static bool IsVisibleOnAnyScreen(double x, double y, double width, double height)
    {
        var desktop = new Rect(
            SystemParameters.VirtualScreenLeft,
            SystemParameters.VirtualScreenTop,
            SystemParameters.VirtualScreenWidth,
            SystemParameters.VirtualScreenHeight);

        if (desktop.Width <= 0 || desktop.Height <= 0)
        {
            return false;
        }

        var window = new Rect(x, y, width, height);
        var overlap = Rect.Intersect(desktop, window);
        return !overlap.IsEmpty && overlap.Width >= 120 && overlap.Height >= 60;
    }

    private void SavePlacement()
    {
        try
        {
            if (CapturePlacement(this) is { } placement)
            {
                _store.SaveWindowPlacement(placement);
            }
        }
        catch (Exception ex)
        {
            _log.Error("Enregistrement de l'etat de la fenetre impossible", ex);
        }
    }

    /// <summary>Position et taille d'une fenetre (celles d'avant l'agrandissement), ou null si elle n'en a pas encore.</summary>
    internal static WindowPlacement? CapturePlacement(Window window)
    {
        var bounds = window.WindowState == WindowState.Normal
            ? new Rect(window.Left, window.Top, window.Width, window.Height)
            : window.RestoreBounds;

        if (bounds.IsEmpty || double.IsNaN(bounds.Width) || bounds.Width <= 0)
        {
            return null;
        }

        return new WindowPlacement
        {
            X = bounds.X,
            Y = bounds.Y,
            Width = bounds.Width,
            Height = bounds.Height,
            Maximized = window.WindowState == WindowState.Maximized,
        };
    }

    // ------------------------------------------------------------------ WebView2

    private async void OnLoaded(object sender, RoutedEventArgs e)
    {
        try
        {
            var wwwFolder = WwwRoot.Prepare(_options, _log);

            var environment = await CoreWebView2Environment.CreateAsync(
                browserExecutableFolder: null,
                userDataFolder: Path.Combine(_options.DataDir, "webview2"),
                options: new CoreWebView2EnvironmentOptions { Language = "fr-FR" });

            await Web.EnsureCoreWebView2Async(environment);
            _environment = environment;
            _wwwFolder = wwwFolder;

            var core = Web.CoreWebView2;
            var settings = core.Settings;
            settings.AreDefaultContextMenusEnabled = false;
            settings.IsStatusBarEnabled = false;
            settings.IsZoomControlEnabled = false;
            settings.IsSwipeNavigationEnabled = false;
            settings.IsGeneralAutofillEnabled = false;
            settings.IsPasswordAutosaveEnabled = false;
            settings.AreBrowserAcceleratorKeysEnabled = _options.IsDev; // F5 / Ctrl+R / F12 en mode dev
            settings.AreDevToolsEnabled = _options.IsDev;
            settings.IsBuiltInErrorPageEnabled = true;
            Web.ZoomFactor = 1.0;

            core.NewWindowRequested += OnNewWindowRequested;
            core.NavigationStarting += OnNavigationStarting;
            core.FrameNavigationStarting += OnFrameNavigationStarting;
            core.ProcessFailed += OnProcessFailed;
            core.PermissionRequested += OnPermissionRequested;

            core.SetVirtualHostNameToFolderMapping(
                VirtualHost,
                wwwFolder,
                CoreWebView2HostResourceAccessKind.Allow);

            _scanner = new AgentProcessScanner(_log, Dispatcher);
            _perf = new PerfMonitor(_log, Dispatcher);
            _bridge = new BridgeHost(core, this, _log, _store, _sessions, _copilot, _launcher, _scanner, _perf);
            _bridge.ConversationsRequested += ShowConversations;

            // Pieces jointes des taches : la page en affiche les images en vignette.
            core.SetVirtualHostNameToFolderMapping(
                TaskAttachments.Host,
                _bridge.AttachmentsRoot,
                CoreWebView2HostResourceAccessKind.Allow);

            // Revizator : documents generes et enregistrements de l'apprenant (learning\), lus par la page.
            core.SetVirtualHostNameToFolderMapping(
                LearningStore.Host,
                _bridge.LearningRoot,
                CoreWebView2HostResourceAccessKind.Allow);

            // Phrases synthetisees (Revizator) : la page les lit par <audio>, fetch ou decodeAudioData.
            core.SetVirtualHostNameToFolderMapping(
                TextToSpeech.Host,
                _bridge.TtsCacheRoot,
                CoreWebView2HostResourceAccessKind.Allow);

            _claudeWatcher = new SessionsWatcher(_sessions.ProjectsRoot, "*.jsonl", "Claude Code", Dispatcher, _log);
            _claudeWatcher.Changed += (_, _) => _bridge?.PostEvent("sessionsChanged");

            _copilotWatcher = new SessionsWatcher(_copilot.SessionsRoot, "events.jsonl", "Copilot", Dispatcher, _log);
            _copilotWatcher.Changed += (_, _) => _bridge?.PostEvent("sessionsChanged");

            // Une fenetre d'agent qui s'ouvre ou se ferme change l'etat affiche, sans ecrire dans le transcript.
            _scanner.Changed += (_, _) => _bridge?.PostEvent("sessionsChanged");
            _scanner.Start();

            var url = $"https://{VirtualHost}/{_options.Page}";
            _log.Info("Navigation vers " + url);
            core.Navigate(url);
        }
        catch (WebView2RuntimeNotFoundException ex)
        {
            _log.Error("Runtime WebView2 absent", ex);
            MessageBox.Show(
                "Le runtime Microsoft Edge WebView2 est requis pour lancer Organizator.\n\n"
                + "Installez-le depuis :\nhttps://developer.microsoft.com/microsoft-edge/webview2/",
                "Organizator",
                MessageBoxButton.OK,
                MessageBoxImage.Error);
            Close();
        }
        catch (Exception ex)
        {
            _log.Error("Initialisation de la WebView2 impossible", ex);
            MessageBox.Show(
                "Impossible d'initialiser la vue web.\n\n" + ex.Message + "\n\nDetail : " + _log.FilePath,
                "Organizator",
                MessageBoxButton.OK,
                MessageBoxImage.Error);
            Close();
        }
    }

    private void OnNavigationStarting(object? sender, CoreWebView2NavigationStartingEventArgs e)
    {
        if (Uri.TryCreate(e.Uri, UriKind.Absolute, out var uri)
            && !string.Equals(uri.Host, VirtualHost, StringComparison.OrdinalIgnoreCase)
            && !string.Equals(uri.Scheme, "about", StringComparison.OrdinalIgnoreCase)
            && !string.Equals(uri.Scheme, "data", StringComparison.OrdinalIgnoreCase))
        {
            e.Cancel = true;
            OpenExternally(e.Uri);
        }
    }

    /// <summary>
    /// Les cadres du lecteur d'artefacts affichent un rapport (page HTML, PDF) servi par l'hote
    /// virtuel des rapports ; un lien externe qui y serait clique ne doit pas charger un site dans
    /// le cadre, mais s'ouvrir dans le navigateur. Les autres schemas (about:srcdoc du cadre isole,
    /// extension du lecteur PDF...) sont laisses tranquilles.
    /// </summary>
    private void OnFrameNavigationStarting(object? sender, CoreWebView2NavigationStartingEventArgs e)
    {
        if (!Uri.TryCreate(e.Uri, UriKind.Absolute, out var uri)
            || uri.Scheme is not ("http" or "https")
            || string.Equals(uri.Host, VirtualHost, StringComparison.OrdinalIgnoreCase)
            || string.Equals(uri.Host, ArtifactReader.Host, StringComparison.OrdinalIgnoreCase))
        {
            return;
        }

        e.Cancel = true;
        OpenExternally(e.Uri);
    }

    private void OnNewWindowRequested(object? sender, CoreWebView2NewWindowRequestedEventArgs e)
    {
        e.Handled = true;
        OpenExternally(e.Uri);
    }

    /// <summary>
    /// La dictee enregistre le micro depuis la page : accorde d'office a la page de l'application, et
    /// a elle seule (un rapport affiche dans un cadre n'y a pas droit). Le reste suit le comportement
    /// par defaut de WebView2.
    /// </summary>
    private void OnPermissionRequested(object? sender, CoreWebView2PermissionRequestedEventArgs e)
    {
        if (e.PermissionKind == CoreWebView2PermissionKind.Microphone
            && Uri.TryCreate(e.Uri, UriKind.Absolute, out var uri)
            && string.Equals(uri.Host, VirtualHost, StringComparison.OrdinalIgnoreCase))
        {
            e.State = CoreWebView2PermissionState.Allow;
        }
    }

    private void OnProcessFailed(object? sender, CoreWebView2ProcessFailedEventArgs e)
    {
        _log.Error($"Processus WebView2 en echec : {e.ProcessFailedKind} / {e.Reason}");
    }

    private void OpenExternally(string uri) => OpenExternally(uri, _log);

    /// <summary>Un lien http(s) ou mailto s'ouvre dans le navigateur ou la messagerie, jamais dans la page.</summary>
    internal static void OpenExternally(string uri, HostLog log)
    {
        if (!Uri.TryCreate(uri, UriKind.Absolute, out var parsed))
        {
            return;
        }

        if (parsed.Scheme is not ("http" or "https" or "mailto"))
        {
            return;
        }

        try
        {
            Process.Start(new ProcessStartInfo(parsed.AbsoluteUri) { UseShellExecute = true });
        }
        catch (Exception ex)
        {
            log.Warn($"Ouverture externe impossible ({uri}) : {ex.Message}");
        }
    }

    /// <summary>Montre la fenetre Conversations (la cree au premier appel), sur une session si elle en nomme une.</summary>
    private void ShowConversations(string? sessionId)
    {
        if (_bridge is null || _environment is null || _wwwFolder is null || _closingHandled)
        {
            return;
        }

        try
        {
            _conversations ??= new ConversationsWindow(_environment, _wwwFolder, _bridge, _store, _log, _options.IsDev);
            _conversations.ShowSession(sessionId);
        }
        catch (Exception ex)
        {
            _log.Error("Fenetre Conversations impossible a ouvrir", ex);
        }
    }

    // ----------------------------------------------------------------- evenements

    private void OnActivated(object? sender, EventArgs e) => _bridge?.PostEvent("focus");

    private async void OnClosing(object? sender, CancelEventArgs e)
    {
        if (_closingHandled)
        {
            return;
        }

        // Les agents de la fenetre Conversations sont des processus d'Organizator : le fermer les arrete.
        var busy = _bridge?.LiveBusyCount() ?? 0;
        if (busy > 0 && _bridge?.ClosingForUpdate != true && !_sessionEnding)
        {
            var answer = MessageBox.Show(
                this,
                (busy == 1 ? "Une conversation travaille encore" : $"{busy} conversations travaillent encore")
                    + " dans la fenêtre Conversations. Fermer Organizator interromprait "
                    + (busy == 1 ? "sa réponse" : "leurs réponses")
                    + " ; ce qui est déjà écrit est gardé, et la session se reprend plus tard.\n\nFermer quand même ?",
                "Organizator",
                MessageBoxButton.YesNo,
                MessageBoxImage.Warning,
                MessageBoxResult.No);
            if (answer != MessageBoxResult.Yes)
            {
                e.Cancel = true;
                return;
            }
        }

        e.Cancel = true;
        _closingHandled = true;

        await FlushWebAsync();
        SavePlacement();

        if (_conversations is not null)
        {
            _conversations.AllowClose = true;
            _conversations.Close();
            _conversations = null;
        }

        _claudeWatcher?.Dispose();
        _claudeWatcher = null;
        _copilotWatcher?.Dispose();
        _copilotWatcher = null;
        _scanner?.Dispose();
        _scanner = null;
        _perf?.Dispose();
        _perf = null;
        _bridge?.Shutdown();

        Close();
    }

    // window.organizatorFlush() rend une promesse, et ExecuteScriptAsync n'attend pas les
    // promesses : on declenche l'appel puis on scrute un temoin, dans un budget d'une seconde.
    private const string FlushScript = """
        (function () {
          if (!window.organizatorFlush) { return "none"; }
          window.__organizatorFlushDone = false;
          try {
            Promise.resolve(window.organizatorFlush()).then(
              function () { window.__organizatorFlushDone = true; },
              function () { window.__organizatorFlushDone = true; });
          } catch (e) { window.__organizatorFlushDone = true; }
          return "started";
        })()
        """;

    /// <summary>Laisse a l'UI au plus une seconde pour vider ses ecritures en attente.</summary>
    private async Task FlushWebAsync()
    {
        try
        {
            if (Web.CoreWebView2 is null)
            {
                return;
            }

            var deadline = DateTime.UtcNow + FlushTimeout;

            var start = Web.CoreWebView2.ExecuteScriptAsync(FlushScript);
            if (await Task.WhenAny(start, Task.Delay(FlushTimeout)) != start)
            {
                _log.Warn("organizatorFlush n'a pas repondu en une seconde.");
                return;
            }

            // "none" : l'UI n'expose pas de flush, il n'y a rien a attendre.
            if (start.Result.Contains("none", StringComparison.Ordinal))
            {
                return;
            }

            while (true)
            {
                var remaining = deadline - DateTime.UtcNow;
                if (remaining <= TimeSpan.Zero)
                {
                    break;
                }

                var probe = Web.CoreWebView2.ExecuteScriptAsync("window.__organizatorFlushDone === true");
                if (await Task.WhenAny(probe, Task.Delay(remaining)) != probe)
                {
                    break;
                }

                if (probe.Result == "true")
                {
                    return;
                }

                await Task.Delay(50);
            }

            _log.Warn("organizatorFlush n'a pas termine en une seconde.");
        }
        catch (Exception ex)
        {
            _log.Warn("organizatorFlush en echec : " + ex.Message);
        }
    }
}
