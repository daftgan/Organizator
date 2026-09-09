using System.IO;
using System.Windows.Threading;

namespace Organizator.Services;

/// <summary>
/// Surveille un dossier de sessions (sous-dossiers compris, fichiers repondant au filtre) et leve
/// <see cref="Changed"/> sur le thread UI. Les evenements sont regroupes sur un court delai, mais
/// jamais repousses au-dela de <see cref="MaxDelay"/> : un agent qui ecrit sans arret ne doit pas
/// retarder indefiniment la notification. Si le dossier n'existe pas encore ou si la surveillance
/// tombe (debordement du tampon), une reprise est tentee periodiquement.
/// </summary>
public sealed class SessionsWatcher : IDisposable
{
    private static readonly TimeSpan Debounce = TimeSpan.FromMilliseconds(250);
    private static readonly TimeSpan MaxDelay = TimeSpan.FromSeconds(1);
    private static readonly TimeSpan RetryInterval = TimeSpan.FromSeconds(15);

    private readonly HostLog _log;
    private readonly Dispatcher _dispatcher;
    private readonly DispatcherTimer _timer;
    private readonly DispatcherTimer _retry;
    private readonly string _root;
    private readonly string _filter;
    private readonly string _label;
    private FileSystemWatcher? _watcher;
    private DateTime _pendingSince;
    private bool _missingLogged;
    private bool _disposed;

    public SessionsWatcher(string root, string filter, string label, Dispatcher dispatcher, HostLog log)
    {
        _log = log;
        _dispatcher = dispatcher;
        _root = root;
        _filter = filter;
        _label = label;

        _timer = new DispatcherTimer(DispatcherPriority.Background, dispatcher) { Interval = Debounce };
        _timer.Tick += OnTick;
        _retry = new DispatcherTimer(DispatcherPriority.Background, dispatcher) { Interval = RetryInterval };
        _retry.Tick += OnRetry;

        if (!Attach())
        {
            _retry.Start();
        }
    }

    /// <summary>Leve sur le thread UI apres le regroupement des evenements.</summary>
    public event EventHandler? Changed;

    /// <summary>Vrai tant que la surveillance du dossier tient.</summary>
    public bool IsWatching => _watcher is not null;

    private bool Attach()
    {
        if (_disposed || _watcher is not null)
        {
            return true;
        }

        try
        {
            if (!Directory.Exists(_root))
            {
                if (!_missingLogged)
                {
                    _missingLogged = true;
                    _log.Warn($"Dossier des sessions {_label} absent, surveillance en attente : {_root}");
                }

                return false;
            }

            var watcher = new FileSystemWatcher(_root, _filter)
            {
                IncludeSubdirectories = true,
                NotifyFilter = NotifyFilters.LastWrite | NotifyFilters.FileName | NotifyFilters.Size | NotifyFilters.CreationTime,
                InternalBufferSize = 256 * 1024,
            };

            watcher.Changed += OnFileEvent;
            watcher.Created += OnFileEvent;
            watcher.Deleted += OnFileEvent;
            watcher.Renamed += OnFileEvent;
            watcher.Error += OnWatcherError;
            watcher.EnableRaisingEvents = true;
            _watcher = watcher;
            _missingLogged = false;

            _log.Info($"Surveillance des sessions {_label} active : {_root}");
            return true;
        }
        catch (Exception ex)
        {
            _log.Error($"Surveillance des sessions {_label} impossible", ex);
            _watcher = null;
            return false;
        }
    }

    private void Detach()
    {
        var watcher = _watcher;
        _watcher = null;
        if (watcher is null)
        {
            return;
        }

        try
        {
            watcher.EnableRaisingEvents = false;
            watcher.Changed -= OnFileEvent;
            watcher.Created -= OnFileEvent;
            watcher.Deleted -= OnFileEvent;
            watcher.Renamed -= OnFileEvent;
            watcher.Error -= OnWatcherError;
            watcher.Dispose();
        }
        catch
        {
            // Rien a faire de plus.
        }
    }

    private void OnFileEvent(object sender, FileSystemEventArgs e) => Schedule();

    /// <summary>
    /// Tampon deborde ou dossier disparu : la surveillance est perdue. On la reconstruit et on
    /// previent tout de suite, des evenements ayant ete manques.
    /// </summary>
    private void OnWatcherError(object sender, ErrorEventArgs e)
    {
        _log.Warn($"Surveillance des sessions {_label} interrompue : {e.GetException().Message}");
        _dispatcher.BeginInvoke(DispatcherPriority.Background, () =>
        {
            if (_disposed)
            {
                return;
            }

            Detach();
            if (Attach())
            {
                Fire();
            }
            else
            {
                _retry.Start();
            }
        });
    }

    private void OnRetry(object? sender, EventArgs e)
    {
        if (_disposed)
        {
            return;
        }

        if (Attach())
        {
            _retry.Stop();
            Fire();
        }
    }

    private void Schedule()
    {
        if (_disposed)
        {
            return;
        }

        // Les evenements arrivent sur un thread du pool : on repasse par le Dispatcher.
        _dispatcher.BeginInvoke(DispatcherPriority.Background, () =>
        {
            if (_disposed)
            {
                return;
            }

            var now = DateTime.UtcNow;
            if (!_timer.IsEnabled)
            {
                _pendingSince = now;
            }
            else if (now - _pendingSince >= MaxDelay)
            {
                // L'agent ecrit en continu : on notifie sans attendre qu'il s'arrete.
                _timer.Stop();
                Fire();
                return;
            }

            _timer.Stop();
            _timer.Start();
        });
    }

    private void OnTick(object? sender, EventArgs e)
    {
        _timer.Stop();
        Fire();
    }

    private void Fire()
    {
        if (_disposed)
        {
            return;
        }

        try
        {
            Changed?.Invoke(this, EventArgs.Empty);
        }
        catch (Exception ex)
        {
            _log.Error("Notification sessionsChanged en echec", ex);
        }
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        _timer.Stop();
        _timer.Tick -= OnTick;
        _retry.Stop();
        _retry.Tick -= OnRetry;
        Detach();
    }
}
