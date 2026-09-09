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
    private bool _closingHandled;

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
    }

    // ------------------------------------------------------------------ fenetre

    private void RestorePlacement(WindowPlacement? placement)
    {
        if (placement is null || placement.Width < 200 || placement.Height < 150)
        {
            return;
        }

        var width = Math.Max(MinWidth, placement.Width);
        var height = Math.Max(MinHeight, placement.Height);

        if (!IsVisibleOnAnyScreen(placement.X, placement.Y, width, height))
        {
            _log.Warn("Position de fenetre enregistree hors ecran, retour au centrage.");
            Width = width;
            Height = height;
            return;
        }

        WindowStartupLocation = WindowStartupLocation.Manual;
        Left = placement.X;
        Top = placement.Y;
        Width = width;
        Height = height;

        if (placement.Maximized)
        {
            WindowState = WindowState.Maximized;
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
            var bounds = WindowState == WindowState.Normal
                ? new Rect(Left, Top, Width, Height)
                : RestoreBounds;

            if (bounds.IsEmpty || double.IsNaN(bounds.Width) || bounds.Width <= 0)
            {
                return;
            }

            _store.SaveWindowPlacement(new WindowPlacement
            {
                X = bounds.X,
                Y = bounds.Y,
                Width = bounds.Width,
                Height = bounds.Height,
                Maximized = WindowState == WindowState.Maximized,
            });
        }
        catch (Exception ex)
        {
            _log.Error("Enregistrement de l'etat de la fenetre impossible", ex);
        }
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
            core.ProcessFailed += OnProcessFailed;

            core.SetVirtualHostNameToFolderMapping(
                VirtualHost,
                wwwFolder,
                CoreWebView2HostResourceAccessKind.Allow);

            _scanner = new AgentProcessScanner(_log, Dispatcher);
            _bridge = new BridgeHost(core, this, _log, _store, _sessions, _copilot, _launcher, _scanner);

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

    private void OnNewWindowRequested(object? sender, CoreWebView2NewWindowRequestedEventArgs e)
    {
        e.Handled = true;
        OpenExternally(e.Uri);
    }

    private void OnProcessFailed(object? sender, CoreWebView2ProcessFailedEventArgs e)
    {
        _log.Error($"Processus WebView2 en echec : {e.ProcessFailedKind} / {e.Reason}");
    }

    private void OpenExternally(string uri)
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
            _log.Warn($"Ouverture externe impossible ({uri}) : {ex.Message}");
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

        e.Cancel = true;
        _closingHandled = true;

        await FlushWebAsync();
        SavePlacement();

        _claudeWatcher?.Dispose();
        _claudeWatcher = null;
        _copilotWatcher?.Dispose();
        _copilotWatcher = null;
        _scanner?.Dispose();
        _scanner = null;

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
