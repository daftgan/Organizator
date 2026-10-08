using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Automation;

namespace Organizator.Services;

/// <summary>Sort de l'onglet d'une session dont la fenetre vient d'etre ramenee au premier plan.</summary>
public enum TabOutcome
{
    /// <summary>La fenetre ne groupe pas ses sessions : il n'y a aucun onglet a activer.</summary>
    None,

    /// <summary>L'onglet de la session est desormais celui que la fenetre montre.</summary>
    Activated,

    /// <summary>La fenetre a des onglets, mais celui de la session n'a pas pu etre designe.</summary>
    Unresolved,
}

/// <summary>
/// Activation de l'onglet qui heberge une session, dans un terminal qui les groupe (Windows Terminal).
///
/// Le terminal n'offre aucune commande pour cela, mais il expose ses onglets en UI Automation :
/// chacun est un <c>TabItem</c> dont le nom est le titre affiche et qui porte le motif
/// <c>SelectionItem</c> — <c>Select()</c> l'amene devant, fenetre reduite ou en arriere-plan comprise.
///
/// Reste a savoir lequel est le notre. Le nom d'un onglet est le titre de la console qu'il heberge,
/// et plusieurs sessions portent souvent le meme : conversations d'une meme tache (meme
/// <c>--name</c>), sessions de remarques d'un meme jour, reprise d'une session dont l'agent
/// precedent vit encore. On marque donc la console : quelques caracteres invisibles ajoutes a son
/// titre (<c>AttachConsole</c> le temps d'un <c>SetConsoleTitle</c>), que le terminal reporte sur
/// l'onglet en quelques millisecondes — 200 au plus, il regroupe les changements de titre trop
/// rapproches. L'onglet qui porte la marque est le notre ; elle est retiree aussitot.
///
/// La marque n'atteint pas l'onglet quand la session tourne dans un volet inactif (l'onglet montre
/// le titre du volet actif) ou que l'utilisateur a renomme l'onglet. On se rabat alors sur le titre,
/// s'il ne designe qu'un onglet ; sinon mieux vaut laisser l'utilisateur choisir que l'emmener sur
/// la jumelle.
/// </summary>
public sealed class TerminalTabs
{
    /// <summary>UI Automation repond en quelques centaines de millisecondes : jamais sur le fil de l'interface.</summary>
    private static readonly Condition TabItems =
        new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.TabItem);

    /// <summary>Le terminal applique un titre aussitot, ou dans les 200 ms s'il vient d'en changer.</summary>
    private static readonly TimeSpan MarkWait = TimeSpan.FromMilliseconds(600);

    /// <summary>L'agent peut reecrire son titre par-dessus la marque avant que l'onglet ne la montre.</summary>
    private const int MarkAttempts = 2;

    // La marque : un separateur invisible (U+2063), puis son numero en seize espaces sans chasse
    // (U+200C pour 1, U+200B pour 0). Rien ne bouge a l'ecran, ni la largeur de l'onglet.
    private const char MarkLead = (char)0x2063;
    private const char MarkOne = (char)0x200C;
    private const char MarkZero = (char)0x200B;

    private static int _marks = Environment.TickCount;

    // AttachConsole vaut pour tout le processus, pas pour le thread : une console a la fois.
    private static readonly object ConsoleLock = new();

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AttachConsole(uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool FreeConsole();

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetConsoleTitleW(StringBuilder buffer, int size);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetConsoleTitleW(string title);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetConsoleWindow();

    [DllImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetConsoleCtrlHandler(IntPtr handler, [MarshalAs(UnmanagedType.Bool)] bool add);

    private readonly HostLog _log;

    public TerminalTabs(HostLog log) => _log = log;

    /// <summary>
    /// Amene devant l'onglet de la session hebergee par <paramref name="agentProcessId"/>.
    /// </summary>
    /// <param name="tabTitle">Titre de cet onglet, quand il a pu etre lu ; a dire a l'utilisateur si rien n'a pu etre active.</param>
    public TabOutcome Activate(IntPtr window, int agentProcessId, out string tabTitle)
    {
        tabTitle = "";
        if (window == IntPtr.Zero)
        {
            return TabOutcome.None;
        }

        try
        {
            var root = AutomationElement.FromHandle(window);
            if (root is null)
            {
                return TabOutcome.None;
            }

            var tabs = root.FindAll(TreeScope.Descendants, TabItems);

            // Une console classique n'a pas d'onglets, une fenetre qui n'en a qu'un le montre deja.
            if (tabs.Count <= 1)
            {
                return TabOutcome.None;
            }

            // Lu avant de marquer : c'est le titre que l'utilisateur voit.
            tabTitle = ConsoleTitle(agentProcessId);

            var how = "marque";
            var tab = Marked(tabs, agentProcessId);
            if (tab is null)
            {
                // Volet inactif, onglet renomme : le titre, s'il ne designe qu'un onglet.
                tab = Match(tabs, tabTitle);
                how = tab is null ? $"aucun ({Count(tabs, tabTitle)} onglet(s) de ce nom)" : "titre";
            }

            _log.Info($"Onglet de la session : {tabs.Count} onglets, titre '{tabTitle}', designe par : {how}");

            if (tab is null
                || !tab.TryGetCurrentPattern(SelectionItemPattern.Pattern, out var pattern)
                || pattern is not SelectionItemPattern selection)
            {
                return TabOutcome.Unresolved;
            }

            selection.Select();
            return TabOutcome.Activated;
        }
        catch (Exception ex) when (ex is ElementNotAvailableException or COMException or InvalidOperationException or TimeoutException)
        {
            _log.Warn("Activation de l'onglet impossible : " + ex.Message);
            return TabOutcome.Unresolved;
        }
    }

    /// <summary>
    /// Titre de la console de ce processus, tel que l'onglet l'affiche. Vide si elle n'est plus la.
    /// </summary>
    public string ConsoleTitle(int processId) => Borrow(processId, ReadTitle, "");

    /// <summary>
    /// Fenetre de la console de ce processus : <c>ConsoleWindowClass</c> pour une console classique,
    /// <c>PseudoConsoleWindow</c> sous Windows Terminal, quel que soit le processus a qui Windows
    /// l'attribue. Zero si on ne peut s'y attacher — dans les 300 premieres millisecondes d'une
    /// console remise a Windows Terminal, notamment.
    /// </summary>
    public static IntPtr ConsoleWindow(int processId) => Borrow(processId, GetConsoleWindow, IntPtr.Zero);

    /// <summary>
    /// L'onglet qui heberge la console de ce processus, designe par une marque posee sur son titre ;
    /// null si aucun onglet ne l'a montree.
    /// </summary>
    private static AutomationElement? Marked(AutomationElementCollection tabs, int processId)
    {
        for (var attempt = 0; attempt < MarkAttempts; attempt++)
        {
            var mark = NewMark();
            if (!Borrow(processId, () => ReadTitle() is { Length: > 0 } title && SetConsoleTitleW(title + mark), false))
            {
                return null;
            }

            try
            {
                var clock = Stopwatch.StartNew();
                do
                {
                    foreach (AutomationElement tab in tabs)
                    {
                        // Comparaison ordinale : une comparaison culturelle ignore les caracteres sans
                        // chasse, et trouverait la marque dans tous les noms.
                        if (NameOf(tab).Contains(mark, StringComparison.Ordinal))
                        {
                            return tab;
                        }
                    }

                    Thread.Sleep(15);
                }
                while (clock.Elapsed < MarkWait);
            }
            finally
            {
                Unmark(processId, mark);
            }
        }

        return null;
    }

    /// <summary>Retire la marque, sauf si l'agent a deja reecrit son titre par-dessus.</summary>
    private static void Unmark(int processId, string mark) => Borrow(
        processId,
        () =>
        {
            var title = ReadTitle();
            var at = title.IndexOf(mark, StringComparison.Ordinal);
            return at >= 0 && SetConsoleTitleW(title.Remove(at, mark.Length));
        },
        false);

    private static string NewMark()
    {
        var number = Interlocked.Increment(ref _marks) & 0xFFFF;
        var mark = new StringBuilder(17).Append(MarkLead);
        for (var bit = 15; bit >= 0; bit--)
        {
            mark.Append(((number >> bit) & 1) == 1 ? MarkOne : MarkZero);
        }

        return mark.ToString();
    }

    /// <summary>S'attache a la console de ce processus le temps d'une lecture (ou d'une marque).</summary>
    private static T Borrow<T>(int processId, Func<T> read, T missing)
    {
        if (processId <= 4)
        {
            return missing;
        }

        lock (ConsoleLock)
        {
            // Organizator n'a pas de console : celle qu'il emprunte le temps d'une lecture pourrait
            // lui adresser son Ctrl+C. On demande a l'ignorer avant de s'y attacher.
            SetConsoleCtrlHandler(IntPtr.Zero, true);

            if (!AttachConsole((uint)processId))
            {
                return missing;
            }

            try
            {
                return read();
            }
            finally
            {
                FreeConsole();
            }
        }
    }

    private static string ReadTitle()
    {
        var buffer = new StringBuilder(1024);
        return GetConsoleTitleW(buffer, buffer.Capacity) <= 0 ? "" : buffer.ToString();
    }

    /// <summary>
    /// L'onglet qui porte ce titre, s'il n'y en a qu'un. Comparaison exacte d'abord, puis sans le
    /// glyphe d'activite pose devant : l'agent peut l'avoir change entre la lecture et maintenant.
    /// </summary>
    private static AutomationElement? Match(AutomationElementCollection tabs, string title)
        => string.IsNullOrWhiteSpace(title) ? null : Single(tabs, title, exact: true) ?? Single(tabs, title, exact: false);

    private static AutomationElement? Single(AutomationElementCollection tabs, string title, bool exact)
    {
        var wanted = exact ? title : Bare(title);
        if (wanted.Length == 0)
        {
            return null;
        }

        AutomationElement? found = null;
        foreach (AutomationElement tab in tabs)
        {
            var name = exact ? NameOf(tab) : Bare(NameOf(tab));
            if (name.Length == 0 || !string.Equals(name, wanted, StringComparison.Ordinal))
            {
                continue;
            }

            // Deux onglets du meme nom : aucun ne peut etre designe comme celui de la session.
            if (found is not null)
            {
                return null;
            }

            found = tab;
        }

        return found;
    }

    /// <summary>Onglets qui portent ce titre, glyphe d'activite mis a part : pour le journal.</summary>
    private static int Count(AutomationElementCollection tabs, string title)
    {
        var wanted = Bare(title);
        var count = 0;
        foreach (AutomationElement tab in tabs)
        {
            if (wanted.Length > 0 && string.Equals(Bare(NameOf(tab)), wanted, StringComparison.Ordinal))
            {
                count++;
            }
        }

        return count;
    }

    /// <summary>Le titre sans le glyphe d'activite dont l'agent le prefixe (« ✳ », « ◐ »...).</summary>
    private static string Bare(string title)
    {
        var start = 0;
        while (start < title.Length && !char.IsLetterOrDigit(title[start]))
        {
            start++;
        }

        return title[start..].Trim();
    }

    private static string NameOf(AutomationElement tab)
    {
        try
        {
            return tab.Current.Name ?? "";
        }
        catch (Exception ex) when (ex is ElementNotAvailableException or COMException)
        {
            return "";
        }
    }
}
