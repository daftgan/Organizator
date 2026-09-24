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
/// <c>SelectionItem</c> — <c>Select()</c> l'amene devant.
///
/// Reste a savoir lequel est le notre. Le titre d'un onglet est celui de la console qu'il heberge,
/// que l'agent reecrit a sa guise (glyphe d'activite devant, troncature) : le comparer au titre de
/// la session echouerait. On lit donc le titre de la console elle-meme, en s'y attachant le temps
/// d'un <c>GetConsoleTitle</c> ; il donne mot pour mot ce que l'onglet affiche.
///
/// Deux sessions peuvent porter le meme titre : l'onglet n'est alors pas designable — mieux vaut
/// laisser l'utilisateur choisir que l'emmener sur la jumelle.
/// </summary>
public sealed class TerminalTabs
{
    /// <summary>UI Automation repond en quelques centaines de millisecondes : jamais sur le fil de l'interface.</summary>
    private static readonly Condition TabItems =
        new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.TabItem);

    // AttachConsole vaut pour tout le processus, pas pour le thread : une lecture a la fois.
    private static readonly object ConsoleLock = new();

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AttachConsole(uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool FreeConsole();

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetConsoleTitleW(StringBuilder buffer, int size);

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

            tabTitle = ConsoleTitle(agentProcessId);

            if (Match(tabs, tabTitle) is not { } tab
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
    public string ConsoleTitle(int processId)
    {
        if (processId <= 4)
        {
            return "";
        }

        lock (ConsoleLock)
        {
            // Organizator n'a pas de console : celle qu'il emprunte le temps d'une lecture pourrait
            // lui adresser son Ctrl+C. On demande a l'ignorer avant de s'y attacher.
            SetConsoleCtrlHandler(IntPtr.Zero, true);

            if (!AttachConsole((uint)processId))
            {
                return "";
            }

            try
            {
                var buffer = new StringBuilder(1024);
                return GetConsoleTitleW(buffer, buffer.Capacity) <= 0 ? "" : buffer.ToString();
            }
            finally
            {
                FreeConsole();
            }
        }
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

    /// <summary>Le titre sans le glyphe d'activite dont l'agent le prefixe (« ✳ », « ◑ »...).</summary>
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
