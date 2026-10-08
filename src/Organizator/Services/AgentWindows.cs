using System.Runtime.InteropServices;
using System.Text;

namespace Organizator.Services;

/// <summary>Ce qu'a donne la remise au premier plan d'une session deja ouverte.</summary>
/// <param name="Focused">Faux quand la fenetre de la session n'a pas ete trouvee.</param>
/// <param name="WindowTitle">Titre de la fenetre ; sous un terminal a onglets, celui de l'onglet actif.</param>
/// <param name="Tab">Sort de l'onglet de la session.</param>
/// <param name="TabTitle">Nom de cet onglet, quand il a pu etre lu.</param>
/// <param name="Raised">Faux quand Windows a refuse de la passer devant : son bouton clignote alors dans la barre des taches.</param>
/// <param name="Window">La fenetre retenue, pour le journal : classe, titre et processus.</param>
public sealed record FocusResult(bool Focused, string WindowTitle, TabOutcome Tab, string TabTitle, bool Raised, string Window)
{
    public static readonly FocusResult Missed = new(false, "", TabOutcome.None, "", false, "");
}

/// <summary>
/// Ramene au premier plan la fenetre de terminal qui heberge deja une session, plutot que d'en
/// ouvrir une seconde sur la meme session.
///
/// Le chemin n'est pas direct : la fenetre n'appartient jamais au processus de l'agent. On la
/// demande a la console de l'agent elle-meme (<see cref="TerminalTabs.ConsoleWindow"/>) : une
/// <c>ConsoleWindowClass</c> visible pour une console classique, une <c>PseudoConsoleWindow</c>
/// invisible quand Windows Terminal heberge la session. Dans ce dernier cas la vraie fenetre est le
/// proprietaire racine de la pseudo-console (<c>GA_ROOTOWNER</c>), c'est-a-dire la fenetre Windows
/// Terminal qui porte l'onglet.
///
/// Remonter les parents ne suffit pas : Windows attribue la pseudo-console tantot au PowerShell,
/// tantot a l'<c>OpenConsole.exe</c> qui la sert — lance par COM, hors de la lignee. La remontee
/// tombait alors sur la fenetre d'Organizator, deja devant : rien ne bougeait, ou, Organizator
/// redemarre entre-temps, rien n'etait trouve et un second agent etait lance sur la session.
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
    private const string ClassicConsole = "ConsoleWindowClass";

    private static readonly string[] ConsoleClasses = { "PseudoConsoleWindow", ClassicConsole };

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

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

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
    /// faux quand aucune fenetre n'a ete trouvee.
    /// </summary>
    public async Task<FocusResult> TryFocusAsync(int agentProcessId)
    {
        // S'attacher a la console d'un autre processus n'est pas l'affaire du fil de l'interface.
        var window = await Task.Run(() => Find(agentProcessId)).ConfigureAwait(true);
        return await FocusAsync(window, agentProcessId).ConfigureAwait(true);
    }

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
            // Rien tant que Windows Terminal n'a pas rattache la pseudo-console a sa fenetre, 350 a
            // 700 ms apres le lancement (mesure). Jusque-la, la seule fenetre visible de la lignee
            // etait celle d'Organizator, que l'ancienne recherche ramenait devant aussitot.
            var window = await Task.Run(() => Find(processId)).ConfigureAwait(true);
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
        if (window == IntPtr.Zero)
        {
            return FocusResult.Missed;
        }

        // Trouvee mais refusee (l'utilisateur a clique ailleurs entre-temps) : Windows la fait
        // clignoter dans la barre des taches. Pas de quoi ouvrir un second terminal sur la session.
        var raised = Focus(window);
        if (!raised)
        {
            _log.Warn($"Premier plan refuse pour {Describe(window)} ; devant : {Describe(GetForegroundWindow())}");
        }

        // Lus avant l'onglet : sa marque invisible passe un instant dans le titre de la fenetre.
        var windowTitle = TitleOf(window);
        var description = Describe(window);

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

        return new FocusResult(true, windowTitle, outcome, tabTitle, raised, description);
    }

    private static string TitleOf(IntPtr window)
    {
        var buffer = new StringBuilder(320);
        GetWindowTextW(window, buffer, buffer.Capacity);
        return buffer.ToString();
    }

    private static string ClassOf(IntPtr window)
    {
        var buffer = new StringBuilder(128);
        GetClassNameW(window, buffer, buffer.Capacity);
        return buffer.ToString();
    }

    /// <summary>Pour le journal : classe, titre et processus d'une fenetre.</summary>
    private static string Describe(IntPtr window)
    {
        if (window == IntPtr.Zero)
        {
            return "aucune fenetre";
        }

        GetWindowThreadProcessId(window, out var processId);
        return $"{ClassOf(window)} '{TitleOf(window)}' (pid {processId})";
    }

    /// <summary>
    /// Fenetre visible qui heberge la console de ce processus, <c>IntPtr.Zero</c> si on ne la trouve
    /// pas, ou pas encore. Jamais une autre que la console elle-meme ou le terminal qui la porte :
    /// ni Organizator, ni l'explorateur, ni une fenetre Windows Terminal prise au hasard.
    /// </summary>
    public IntPtr Find(int agentProcessId)
    {
        if (agentProcessId <= 4)
        {
            return IntPtr.Zero;
        }

        try
        {
            // La console elle-meme dit quelle est sa fenetre, quel que soit le processus a qui Windows
            // l'attribue : seule reponse exacte quand c'est a OpenConsole.exe (une session sur deux).
            var console = TerminalTabs.ConsoleWindow(agentProcessId);

            // Attache refusee (agent lance en administrateur, console en cours de remise a Windows
            // Terminal) : les fenetres de console de la lignee, et elles seules.
            if (console == IntPtr.Zero)
            {
                console = LineageConsole(agentProcessId);
            }

            return Host(console);
        }
        catch (Exception ex)
        {
            _log.Warn("Fenetre de la session introuvable : " + ex.Message);
            return IntPtr.Zero;
        }
    }

    /// <summary>
    /// La fenetre que l'utilisateur voit pour cette console : elle-meme si c'est une console
    /// classique, son proprietaire racine (la fenetre Windows Terminal de l'onglet) si c'est une
    /// pseudo-console. Zero tant que le terminal ne l'a pas rattachee : elle nait sans proprietaire.
    /// </summary>
    private static IntPtr Host(IntPtr console)
    {
        if (console == IntPtr.Zero)
        {
            return IntPtr.Zero;
        }

        var target = ClassOf(console) == ClassicConsole ? console : Root(console);
        return target != IntPtr.Zero && IsWindowVisible(target) && !IsOwn(target) ? target : IntPtr.Zero;
    }

    private static IntPtr Root(IntPtr window)
    {
        // Sans proprietaire, GetAncestor rend la pseudo-console elle-meme : il n'y a rien a montrer.
        var root = GetAncestor(window, GaRootOwner);
        return root == window ? IntPtr.Zero : root;
    }

    private static bool IsOwn(IntPtr window)
    {
        GetWindowThreadProcessId(window, out var processId);
        return processId == (uint)Environment.ProcessId;
    }

    /// <summary>
    /// Repli quand on ne peut s'attacher a la console : une fenetre de console de la lignee, le
    /// processus d'abord. On s'arrete a Organizator : au-dessus, plus rien n'est a la session.
    /// </summary>
    private static IntPtr LineageConsole(int processId)
    {
        var windows = TopLevelWindows();
        foreach (var id in Lineage(processId))
        {
            if (id == Environment.ProcessId)
            {
                break;
            }

            foreach (var window in windows)
            {
                if (window.ProcessId == id && ConsoleClasses.Contains(window.ClassName, StringComparer.Ordinal))
                {
                    return window.Handle;
                }
            }
        }

        return IntPtr.Zero;
    }

    /// <summary>Vrai si la fenetre est bien devant : SetForegroundWindow ne suffit pas a l'affirmer.</summary>
    private static bool Focus(IntPtr window)
    {
        if (IsIconic(window))
        {
            ShowWindow(window, SwRestore);
        }

        // Windows Terminal passe de lui-meme devant quand il recoit une nouvelle console.
        if (GetForegroundWindow() == window)
        {
            return true;
        }

        return SetForegroundWindow(window) && GetForegroundWindow() == window;
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
