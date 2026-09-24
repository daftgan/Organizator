using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.Json.Nodes;
using System.Windows.Threading;

namespace Organizator.Services;

/// <summary>
/// Surveillance des performances : « l'application rame, la frappe traine » doit laisser une trace
/// dans host.log, avec sa cause probable. Quatre mesures :
/// <list type="bullet">
/// <item>le fil de l'interface : une sonde lui confie un travail vide toutes les 500 ms et mesure
/// le delai avant qu'il le prenne. Au-dela de 250 ms il etait occupe : la fenetre ne repondait
/// plus, et les touches non imprimables (retour arriere, fleches, Entree), que WebView2 soumet a
/// l'hote, attendaient avec lui ;</item>
/// <item>les messages du pont : nombre, duree moyenne et maximale par type ;</item>
/// <item>l'interface web (message <c>perf</c>) : taches longues du fil JS, saisies lentes, rendus ;</item>
/// <item>le processus : CPU en % d'un coeur, memoire, threads.</item>
/// </list>
/// Un bilan d'une ligne toutes les 10 minutes, en avertissement quand quelque chose cloche ; un
/// gel de plus d'une seconde est note sur le moment (une ligne par 30 s au plus).
/// </summary>
public sealed class PerfMonitor : IDisposable
{
    private const int ProbeMs = 500;
    private const double BlockMs = 250;
    private const double AlertMs = 1000;
    private const double SleepMs = 5 * 60 * 1000;
    private static readonly TimeSpan SummaryEvery = TimeSpan.FromMinutes(10);
    private static readonly TimeSpan AlertEvery = TimeSpan.FromSeconds(30);

    // Au-dela, les relectures de sessions s'emballent : le defaut corrige le 24/09/2026 en faisait
    // jusqu'a trente par seconde. En regime normal, une par seconde au plus pendant qu'un agent ecrit.
    private const double GetSessionsPerSecondMax = 2.5;

    private readonly HostLog _log;
    private readonly Dispatcher _dispatcher;
    private readonly System.Threading.Timer _probe;
    private readonly System.Threading.Timer _summary;
    private readonly object _gate = new();

    private long _probePostedAt;
    private int _probePending;
    private string _lastMessage = "";
    private DateTime _lastAlert = DateTime.MinValue;

    // Fenetre en cours (depuis le dernier bilan).
    private DateTime _windowStart = DateTime.UtcNow;
    private TimeSpan _cpuAtStart;
    private int _blocks;
    private double _blockMax;
    private double _blockTotal;
    private readonly Dictionary<string, (int Count, double Total, double Max)> _messages = new(StringComparer.Ordinal);
    private WebStats _web;

    private bool _disposed;

    public PerfMonitor(HostLog log, Dispatcher dispatcher)
    {
        _log = log;
        _dispatcher = dispatcher;
        _cpuAtStart = CpuTime();
        _probe = new System.Threading.Timer(_ => Probe(), null, ProbeMs, ProbeMs);
        _summary = new System.Threading.Timer(_ => Summarize(final: false), null, SummaryEvery, SummaryEvery);
    }

    /// <summary>Un message du pont traite, de sa reception a sa reponse.</summary>
    public void RecordMessage(string type, double ms)
    {
        lock (_gate)
        {
            _messages.TryGetValue(type, out var stats);
            _messages[type] = (stats.Count + 1, stats.Total + ms, Math.Max(stats.Max, ms));
        }
    }

    /// <summary>Dernier message recu sur le fil de l'interface : il accompagne l'alerte d'un gel.</summary>
    public void MessageStarted(string type)
    {
        Volatile.Write(ref _lastMessage, type);
    }

    /// <summary>
    /// Mesures de l'interface web depuis son envoi precedent : <c>{ longTasks: { n, total, max },
    /// inputs: { n, max, what }, renders: { n, total, max } }</c> (millisecondes).
    /// </summary>
    public void RecordWeb(JsonObject payload)
    {
        var longTasks = payload["longTasks"] as JsonObject;
        var inputs = payload["inputs"] as JsonObject;
        var renders = payload["renders"] as JsonObject;

        lock (_gate)
        {
            _web.LongCount += Int(longTasks, "n");
            _web.LongTotal += Num(longTasks, "total");
            _web.LongMax = Math.Max(_web.LongMax, Num(longTasks, "max"));

            _web.InputCount += Int(inputs, "n");
            var inputMax = Num(inputs, "max");
            if (inputMax > _web.InputMax)
            {
                _web.InputMax = inputMax;
                _web.InputWhat = Text(inputs, "what");
            }

            _web.RenderCount += Int(renders, "n");
            _web.RenderTotal += Num(renders, "total");
            _web.RenderMax = Math.Max(_web.RenderMax, Num(renders, "max"));
        }
    }

    // ------------------------------------------------------------------ sonde du fil de l'interface

    private void Probe()
    {
        // Une sonde encore en attente : le fil est occupe, son delai sera mesure quand il la prendra.
        if (_disposed || Interlocked.Exchange(ref _probePending, 1) == 1)
        {
            return;
        }

        Volatile.Write(ref _probePostedAt, Stopwatch.GetTimestamp());
        try
        {
            _dispatcher.BeginInvoke(DispatcherPriority.Send, new Action(ProbeReached));
        }
        catch (Exception)
        {
            // Dispatcher arrete (fermeture) : plus rien a mesurer.
            Volatile.Write(ref _probePending, 0);
        }
    }

    private void ProbeReached()
    {
        var delay = Stopwatch.GetElapsedTime(Volatile.Read(ref _probePostedAt)).TotalMilliseconds;
        Volatile.Write(ref _probePending, 0);

        // Plusieurs minutes : la machine sortait de veille, le fil n'etait pas bloque.
        if (delay < BlockMs || delay > SleepMs)
        {
            return;
        }

        lock (_gate)
        {
            _blocks++;
            _blockTotal += delay;
            _blockMax = Math.Max(_blockMax, delay);
        }

        if (delay >= AlertMs && DateTime.UtcNow - _lastAlert >= AlertEvery)
        {
            _lastAlert = DateTime.UtcNow;
            var last = Volatile.Read(ref _lastMessage);
            _log.Write("PERF", string.Format(
                CultureInfo.InvariantCulture,
                "Fil de l'interface bloque {0:0} ms (dernier message recu : {1})",
                delay,
                last.Length > 0 ? last : "aucun"));
        }
    }

    // ------------------------------------------------------------------ bilan

    private void Summarize(bool final)
    {
        string line;
        bool warn;

        lock (_gate)
        {
            var now = DateTime.UtcNow;
            var seconds = Math.Max(1, (now - _windowStart).TotalSeconds);
            var cpu = CpuTime();
            var cpuPercent = 100 * (cpu - _cpuAtStart).TotalSeconds / seconds;

            if (final && _messages.Count == 0 && _blocks == 0 && seconds < 60)
            {
                return;
            }

            _messages.TryGetValue("getSessions", out var sessions);
            var sessionsPerSecond = sessions.Count / seconds;

            warn = _blockMax >= AlertMs
                || cpuPercent >= 50
                || sessionsPerSecond > GetSessionsPerSecondMax
                || _web.InputMax >= 500
                || _web.LongMax >= 500;

            var sb = new StringBuilder();
            sb.Append(final ? "Bilan de fin (" : "Bilan (")
                .Append(FormattableString.Invariant($"{seconds / 60:0} min) : CPU {cpuPercent:0} % d'un coeur"));

            using (var process = Process.GetCurrentProcess())
            {
                sb.Append(FormattableString.Invariant($", {process.WorkingSet64 / (1024 * 1024)} Mo, {process.Threads.Count} threads"));
            }

            sb.Append(" | fil UI : ");
            sb.Append(_blocks == 0
                ? "fluide"
                : FormattableString.Invariant($"{_blocks} blocage(s) > {BlockMs:0} ms, max {_blockMax:0} ms, cumul {_blockTotal / 1000:0.0} s"));

            sb.Append(" | pont : ");
            sb.Append(_messages.Count == 0
                ? "aucun message"
                : string.Join(", ", _messages
                    .OrderByDescending(pair => pair.Value.Total)
                    .Take(6)
                    .Select(pair => FormattableString.Invariant(
                        $"{pair.Key} {pair.Value.Count} x (moy {pair.Value.Total / pair.Value.Count:0} ms, max {pair.Value.Max:0} ms)"))));

            if (sessionsPerSecond > GetSessionsPerSecondMax)
            {
                sb.Append(FormattableString.Invariant($" [getSessions : {sessionsPerSecond:0.0}/s, emballement]"));
            }

            sb.Append(" | UI web : ");
            sb.Append(FormattableString.Invariant($"{_web.LongCount} tache(s) longue(s)"));
            if (_web.LongCount > 0)
            {
                sb.Append(FormattableString.Invariant($" (max {_web.LongMax:0} ms, cumul {_web.LongTotal / 1000:0.0} s)"));
            }

            sb.Append(FormattableString.Invariant($", {_web.InputCount} saisie(s) lente(s)"));
            if (_web.InputCount > 0)
            {
                sb.Append(FormattableString.Invariant($" (max {_web.InputMax:0} ms sur {_web.InputWhat})"));
            }

            if (_web.RenderCount > 0)
            {
                sb.Append(FormattableString.Invariant(
                    $", {_web.RenderCount} rendu(s) (moy {_web.RenderTotal / _web.RenderCount:0} ms, max {_web.RenderMax:0} ms)"));
            }

            line = sb.ToString();

            _windowStart = now;
            _cpuAtStart = cpu;
            _blocks = 0;
            _blockMax = 0;
            _blockTotal = 0;
            _messages.Clear();
            _web = default;
        }

        _log.Write(warn ? "PERF/WARN" : "PERF", line);
    }

    private static TimeSpan CpuTime()
    {
        try
        {
            using var process = Process.GetCurrentProcess();
            return process.TotalProcessorTime;
        }
        catch
        {
            return TimeSpan.Zero;
        }
    }

    private static double Num(JsonObject? obj, string name)
        => obj?[name] is JsonValue value && value.TryGetValue<double>(out var number) && double.IsFinite(number) && number > 0
            ? number
            : 0;

    private static int Int(JsonObject? obj, string name) => (int)Math.Min(int.MaxValue, Num(obj, name));

    private static string Text(JsonObject? obj, string name)
    {
        var value = obj?[name] is JsonValue node && node.TryGetValue<string>(out var text) ? text : "";
        return value.Length > 40 ? value[..40] : value;
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        _probe.Dispose();
        _summary.Dispose();
        Summarize(final: true);
    }

    private struct WebStats
    {
        public int LongCount;
        public double LongTotal;
        public double LongMax;
        public int InputCount;
        public double InputMax;
        public string? InputWhat;
        public int RenderCount;
        public double RenderTotal;
        public double RenderMax;
    }
}
