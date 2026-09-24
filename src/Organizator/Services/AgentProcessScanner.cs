using System.Management;
using System.Text.RegularExpressions;
using System.Windows.Threading;

namespace Organizator.Services;

/// <summary>
/// Repere, toutes les quelques secondes, les processus <c>claude</c> et <c>copilot</c> encore vivants
/// et les identifiants de session qu'ils portent sur leur ligne de commande (<c>--session-id</c> ou
/// <c>--resume</c>). Un transcript ne dit pas si la fenetre a ete fermee : c'est ce balayage qui
/// distingue « reponse prete » de « session fermee ». Passe par WMI (<c>Win32_Process</c>), seul
/// moyen sans droits particuliers de lire la ligne de commande d'un autre processus.
/// </summary>
public sealed class AgentProcessScanner : IDisposable
{
    private static readonly TimeSpan Interval = TimeSpan.FromSeconds(4);
    private const int MaxFailures = 3;

    // Les installations npm lancent node.exe (ou bun.exe) avec le script de la CLI en premier argument.
    private const string Query =
        "SELECT ProcessId, Name, CommandLine FROM Win32_Process "
        + "WHERE Name = 'claude.exe' OR Name = 'copilot.exe' OR Name = 'node.exe' OR Name = 'bun.exe'";

    private static readonly Regex SessionArg = new(
        @"--(?:session-id|resume)(?:=|\s+)""?([0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12})",
        RegexOptions.CultureInvariant);

    private readonly HostLog _log;
    private readonly Dispatcher? _dispatcher;
    private readonly Timer _timer;
    private Dictionary<string, int> _alive = new(StringComparer.OrdinalIgnoreCase);
    private volatile bool _ready;
    private int _failures;
    private int _scanning;
    private bool _disposed;

    public AgentProcessScanner(HostLog log, Dispatcher? dispatcher)
    {
        _log = log;
        _dispatcher = dispatcher;
        _timer = new Timer(_ => Scan(), null, Timeout.InfiniteTimeSpan, Timeout.InfiniteTimeSpan);
    }

    /// <summary>Leve (sur le Dispatcher s'il y en a un) quand l'ensemble des sessions vivantes change.</summary>
    public event EventHandler? Changed;

    /// <summary>Vrai des qu'un balayage a abouti ; faux tant que WMI n'a pas repondu ou s'il est indisponible.</summary>
    public bool IsReady => _ready;

    public void Start() => _timer.Change(TimeSpan.Zero, Interval);

    /// <summary><c>true</c>/<c>false</c> si un balayage a abouti, <c>null</c> quand on ne sait pas.</summary>
    public bool? IsAlive(string sessionId)
    {
        if (!_ready || !Guid.TryParse(sessionId, out var guid))
        {
            return _ready ? false : null;
        }

        return Volatile.Read(ref _alive).ContainsKey(guid.ToString("D"));
    }

    /// <summary>
    /// Processus d'agent qui porte cette session, <c>null</c> tant qu'aucun balayage ne l'a vu.
    /// Sert a retrouver la fenetre de console deja ouverte au lieu d'en ouvrir une seconde.
    /// </summary>
    public int? PidFor(string sessionId)
    {
        if (!_ready || !Guid.TryParse(sessionId, out var guid))
        {
            return null;
        }

        return Volatile.Read(ref _alive).TryGetValue(guid.ToString("D"), out var pid) && pid > 0 ? pid : null;
    }

    /// <summary>
    /// Sessions portees par les processus d'agent vivants, chacune avec le processus qui la porte.
    /// Peut lever si WMI est indisponible.
    /// </summary>
    public static Dictionary<string, int> ScanNow()
    {
        var found = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        using var searcher = new ManagementObjectSearcher(Query);
        using var results = searcher.Get();
        foreach (var item in results)
        {
            using (item)
            {
                if (item["CommandLine"] is not string commandLine || commandLine.Length == 0)
                {
                    continue;
                }

                var pid = item["ProcessId"] is { } value ? Convert.ToInt32(value) : 0;
                foreach (Match match in SessionArg.Matches(commandLine))
                {
                    if (Guid.TryParse(match.Groups[1].Value, out var guid))
                    {
                        found[guid.ToString("D")] = pid;
                    }
                }
            }
        }

        return found;
    }

    private void Scan()
    {
        if (_disposed || Interlocked.Exchange(ref _scanning, 1) == 1)
        {
            return;
        }

        try
        {
            var found = ScanNow();
            var previous = Volatile.Read(ref _alive);
            var changed = !_ready || found.Count != previous.Count
                || found.Keys.Any(id => !previous.ContainsKey(id));
            Volatile.Write(ref _alive, found);
            _ready = true;
            _failures = 0;

            if (changed)
            {
                Notify();
            }
        }
        catch (Exception ex)
        {
            _failures++;
            if (_failures == 1)
            {
                _log.Warn("Balayage des processus d'agent impossible : " + ex.Message);
            }

            if (_failures >= MaxFailures)
            {
                _log.Warn("Balayage des processus d'agent abandonne : l'etat des sessions viendra des transcripts seuls.");
                _ready = false;
                _timer.Change(Timeout.InfiniteTimeSpan, Timeout.InfiniteTimeSpan);
            }
        }
        finally
        {
            Interlocked.Exchange(ref _scanning, 0);
        }
    }

    private void Notify()
    {
        if (_disposed)
        {
            return;
        }

        if (_dispatcher is null)
        {
            Changed?.Invoke(this, EventArgs.Empty);
            return;
        }

        _dispatcher.BeginInvoke(DispatcherPriority.Background, () =>
        {
            if (!_disposed)
            {
                Changed?.Invoke(this, EventArgs.Empty);
            }
        });
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        _timer.Dispose();
    }
}
