using System.Runtime.InteropServices;
using System.Text;

namespace Organizator.Services;

/// <summary>Ce qu'a donne la remise au premier plan d'une session deja ouverte.</summary>
/// <param name="Focused">Faux quand la fenetre de la session n'a pas ete trouvee.</param>
/// <param name="WindowTitle">Titre de la fenetre ; sous un terminal a onglets, celui de l'onglet actif.</param>
/// <param name="Tab">Sort de l'onglet de la session.</param>
/// <param name="TabTitle">Nom de cet onglet, quand il a pu etre lu.</param>
public sealed record FocusResult(bool Focused, string WindowTitle, TabOutcome Tab, string TabTitle)
{
    public static readonly FocusResult Missed = new(false, "", TabOutcome.None, "");
}

/// <summary>
/// Ramene au premier plan la fenetre de terminal qui heberge deja une session, plutot que d'en
/// ouvrir une seconde sur la meme session.
///
/// Le chemin n'est pas direct : la fenetre n'appartient jamais au processus de l'agent.
/// <c>claude.exe</c> est un enfant du <c>powershell.exe</c> lance par Organizator, et c'est ce
/// dernier qui possede la fenetre de console — soit une <c>ConsoleWindowClass</c> visible
/// (console classique), soit une <c>PseudoConsoleWindow</c> invisible quand Windows Terminal
/// heberge la session. Dans ce dernier cas la vraie fenetre est le proprietaire racine de la
/// pseudo-console (<c>GA_ROOTOWNER</c>), c'est-a-dire la fenetre Windows Terminal.
///
/// Cette fenetre-la groupe souvent une dizaine de sessions en onglets : la ramener devant sans
/// plus ne montrerait pas la bonne. L'onglet est donc active a son tour, par <see cref="TerminalTabs"/>.
/// </summary>
public sealed class AgentWindows
{
    private const uint Th32SnapProcess = 0x2;
    private const uint GaRootOwner = 3;
    private const int SwRestore = 9;
    private const int MaxDepth = 6;

    private static readonly string[] ConsoleClasses = { "PseudoConsoleWindow", "ConsoleWindowClass" };

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct ProcessEntry
    {
        public uint Size;
        public uint Usage;
        public uint ProcessId;
        public IntPtr DefaultHeapId;
        public uint ModuleId;
        public uint Threads;
        public uint ParentProcessId;
        public int PriorityBase;
        public uint Flags;

        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string ExeFile;
    }

    private delegate bool EnumWindowsProc(IntPtr window, IntPtr param);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool Process32FirstW(IntPtr snapshot, ref ProcessEntry entry);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool Process32NextW(IntPtr snapshot, ref ProcessEntry entry);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr param);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassNameW(IntPtr window, StringBuilder buffer, int size);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowTextW(IntPtr window, StringBuilder buffer, int size);

    [DllImport("user32.dll")]
    private static extern IntPtr GetAncestor(IntPtr window, uint flags);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindowVisible(IntPtr window);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsIconic(IntPtr window);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ShowWindow(IntPtr window, int command);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetForegroundWindow(IntPtr window);

    private readonly HostLog _log;
    private readonly TerminalTabs _tabs;

    public AgentWindows(HostLog log)
    {
        _log = log;
        _tabs = new TerminalTabs(log);
    }

    /// <summary>
    /// Cherche la fenetre du terminal qui heberge <paramref name="agentProcessId"/>, la ramene au
    /// premier plan, puis y active l'onglet de la session. <see cref="FocusResult.Focused"/> est
    /// faux quand aucune fenetre n'a ete trouvee : l'appelant ouvre alors un terminal.
    /// </summary>
    public Task<FocusResult> TryFocusAsync(int agentProcessId) => FocusAsync(Find(agentProcessId), agentProcessId);

    /// <summary>
    /// Pour un terminal qu'on vient d'ouvrir : attend que sa fenetre paraisse, puis la ramene au
    /// premier plan. Windows Terminal, terminal par defaut de Windows 11, range volontiers la
    /// nouvelle console en onglet d'une fenetre deja ouverte, restee derriere Organizator : sans
    /// cela, l'utilisateur ne voyait rien venir et cliquait une seconde fois.
    /// </summary>
    public async Task<FocusResult> FocusWhenShownAsync(int processId, TimeSpan timeout)
    {
        var deadline = DateTime.UtcNow + timeout;
        while (true)
        {
            var window = Find(processId);
            if (window != IntPtr.Zero)
            {
                return await FocusAsync(window, processId).ConfigureAwait(true);
            }

            if (DateTime.UtcNow >= deadline || !IsRunning(processId))
            {
                return FocusResult.Missed;
            }

            await Task.Delay(150).ConfigureAwait(true);
        }
    }

    public static bool IsRunning(int processId)
    {
        try
        {
            using var process = System.Diagnostics.Process.GetProcessById(processId);
            return !process.HasExited;
        }
        catch (Exception ex) when (ex is ArgumentException or InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            return false;
        }
    }

    private async Task<FocusResult> FocusAsync(IntPtr window, int agentProcessId)
    {
        if (window == IntPtr.Zero || !Focus(window))
        {
            return FocusResult.Missed;
        }

        // La fenetre est devant : l'onglet, lui, passe par UI Automation — trop lent pour le fil de
        // l'interface, et sans gravite s'il n'aboutit pas, l'utilisateur n'a qu'un clic a faire.
        var outcome = TabOutcome.Unresolved;
        var tabTitle = "";

        try
        {
            (outcome, tabTitle) = await Task.Run(() =>
                {
                    var result = _tabs.Activate(window, agentProcessId, out var title);
                    return (result, title);
                })
                .WaitAsync(TimeSpan.FromSeconds(6))
                .ConfigureAwait(true);
        }
        catch (TimeoutException)
        {
            _log.Warn("Activation de l'onglet abandonnee : le terminal n'a pas repondu.");
        }

        return new FocusResult(true, TitleOf(window), outcome, tabTitle);
    }

    private static string TitleOf(IntPtr window)
    {
        var buffer = new StringBuilder(320);
        GetWindowTextW(window, buffer, buffer.Capacity);
        return buffer.ToString();
    }

    /// <summary>Fenetre visible qui heberge ce processus, <c>IntPtr.Zero</c> si on ne la trouve pas.</summary>
    public IntPtr Find(int agentProcessId)
    {
        if (agentProcessId <= 4)
        {
            return IntPtr.Zero;
        }

        try
        {
            var lineage = Lineage(agentProcessId);
            var windows = TopLevelWindows();

            // Le processus de l'agent d'abord, puis ses ancetres : la console la plus proche gagne.
            foreach (var processId in lineage)
            {
                foreach (var window in windows.Where(w => w.ProcessId == processId))
                {
                    var target = ConsoleClasses.Contains(window.ClassName, StringComparer.Ordinal)
                        ? Root(window.Handle)
                        : window.Handle;

                    if (IsWindowVisible(target))
                    {
                        return target;
                    }
                }
            }
        }
        catch (Exception ex)
        {
            _log.Warn("Fenetre de la session introuvable : " + ex.Message);
        }

        return IntPtr.Zero;
    }

    private static IntPtr Root(IntPtr window)
    {
        var root = GetAncestor(window, GaRootOwner);
        return root == IntPtr.Zero ? window : root;
    }

    private static bool Focus(IntPtr window)
    {
        if (IsIconic(window))
        {
            ShowWindow(window, SwRestore);
        }

        return SetForegroundWindow(window);
    }

    /// <summary>Le processus, puis ses ancetres, du plus proche au plus lointain.</summary>
    private static List<int> Lineage(int processId)
    {
        var parents = ParentMap();
        var lineage = new List<int> { processId };
        var seen = new HashSet<int> { processId };
        var current = processId;

        while (lineage.Count < MaxDepth && parents.TryGetValue(current, out var parent) && parent > 4 && seen.Add(parent))
        {
            lineage.Add(parent);
            current = parent;
        }

        return lineage;
    }

    /// <summary>
    /// Table processus -> processus parent. L'instantane Toolhelp repond en quelques millisecondes,
    /// la ou une requete WMI couterait le tiers de seconde du balayage des sessions.
    /// </summary>
    private static Dictionary<int, int> ParentMap()
    {
        var map = new Dictionary<int, int>();
        var snapshot = CreateToolhelp32Snapshot(Th32SnapProcess, 0);
        if (snapshot == IntPtr.Zero || snapshot == new IntPtr(-1))
        {
            return map;
        }

        try
        {
            var entry = new ProcessEntry { Size = (uint)Marshal.SizeOf<ProcessEntry>() };
            if (!Process32FirstW(snapshot, ref entry))
            {
                return map;
            }

            do
            {
                map[(int)entry.ProcessId] = (int)entry.ParentProcessId;
            }
            while (Process32NextW(snapshot, ref entry));
        }
        finally
        {
            CloseHandle(snapshot);
        }

        return map;
    }

    private readonly record struct TopWindow(IntPtr Handle, int ProcessId, string ClassName);

    private static List<TopWindow> TopLevelWindows()
    {
        var windows = new List<TopWindow>();
        var buffer = new StringBuilder(128);

        EnumWindows(
            (window, _) =>
            {
                GetWindowThreadProcessId(window, out var processId);
                buffer.Clear();
                GetClassNameW(window, buffer, buffer.Capacity);
                windows.Add(new TopWindow(window, (int)processId, buffer.ToString()));
                return true;
            },
            IntPtr.Zero);

        return windows;
    }
}
