using System.IO;
using System.Windows;
using System.Windows.Threading;
using Organizator.Services;

namespace Organizator;

public partial class App : Application
{
    private HostLog? _log;

    public AppOptions Options { get; private set; } = null!;

    public HostLog Log => _log!;

    public DataStore Store { get; private set; } = null!;

    public ClaudeSessions Sessions { get; private set; } = null!;

    public CopilotSessions CopilotSessions { get; private set; } = null!;

    public AgentLauncher Launcher { get; private set; } = null!;

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);

        Options = AppOptions.Parse(e.Args);

        try
        {
            Directory.CreateDirectory(Options.DataDir);
        }
        catch (Exception ex)
        {
            MessageBox.Show(
                $"Impossible de creer le dossier de donnees :\n{Options.DataDir}\n\n{ex.Message}",
                "Organizator",
                MessageBoxButton.OK,
                MessageBoxImage.Error);
            Shutdown(1);
            return;
        }

        _log = new HostLog(Options.DataDir);
        _log.Info($"Demarrage — dataDir={Options.DataDir}, wwwroot={Options.WwwRootOverride ?? "(embarque)"}, page={Options.Page}");

        // Avant tout lancement de processus : les agents ouverts par Organizator sont des
        // sessions a part entiere, meme si Organizator a ete lance depuis une session Claude Code.
        var inherited = InheritedEnvironment.Scrub();
        if (inherited.Count > 0)
        {
            _log.Warn("Variables heritees d'une session Claude Code, retirees de l'environnement : " + string.Join(", ", inherited));
        }

        DispatcherUnhandledException += OnDispatcherUnhandledException;
        AppDomain.CurrentDomain.UnhandledException += OnDomainUnhandledException;
        TaskScheduler.UnobservedTaskException += OnUnobservedTaskException;

        Store = new DataStore(Options.DataDir, _log);
        Sessions = new ClaudeSessions(_log);
        CopilotSessions = new CopilotSessions(_log);
        Launcher = new AgentLauncher(Store, _log);

        var window = new MainWindow(Options, _log, Store, Sessions, CopilotSessions, Launcher);
        MainWindow = window;
        window.Show();
    }

    protected override void OnExit(ExitEventArgs e)
    {
        _log?.Info("Arret de l'application.");
        base.OnExit(e);
    }

    private void OnDispatcherUnhandledException(object sender, DispatcherUnhandledExceptionEventArgs e)
    {
        e.Handled = true;
        _log?.Error("Exception non geree (UI)", e.Exception);

        MessageBox.Show(
            "Une erreur inattendue est survenue.\n\n"
            + e.Exception.Message
            + "\n\nLe detail est dans :\n" + (_log?.FilePath ?? "host.log"),
            "Organizator",
            MessageBoxButton.OK,
            MessageBoxImage.Error);
    }

    private void OnDomainUnhandledException(object sender, UnhandledExceptionEventArgs e)
    {
        if (e.ExceptionObject is Exception ex)
        {
            _log?.Error("Exception non geree (domaine)", ex);
        }
        else
        {
            _log?.Error("Exception non geree (domaine) : " + e.ExceptionObject);
        }
    }

    private void OnUnobservedTaskException(object? sender, UnobservedTaskExceptionEventArgs e)
    {
        _log?.Error("Exception de tache non observee", e.Exception);
        e.SetObserved();
    }
}
