namespace Organizator.Services;

/// <summary>
/// Retire de l'environnement du processus ce qu'une session Claude Code pose dans ses processus
/// enfants. Lance depuis une telle session (par exemple par l'agent lui-meme apres une
/// publication), Organizator le transmettrait a chaque <c>claude</c> qu'il ouvre :
/// <list type="bullet">
/// <item>les marqueurs de session : l'agent se croirait « session enfant » et n'enregistrerait
/// pas sa transcription (« Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION
/// marker »), si bien que la conversation serait illisible dans le panneau et impossible a
/// reprendre ;</item>
/// <item><c>NO_COLOR</c> : l'agent s'afficherait sans aucune couleur, terminal entierement gris.</item>
/// </list>
/// </summary>
public static class InheritedEnvironment
{
    /// <summary>
    /// Variables que Claude Code injecte dans ses enfants pour decrire la session parente.
    /// Aucune n'a de sens pour une session lancee par Organizator, qui est une session a part
    /// entiere ; un <c>claude</c> ouvert depuis un terminal ordinaire n'en voit aucune.
    /// </summary>
    private static readonly string[] ClaudeSessionMarkers =
    {
        "CLAUDECODE",
        "CLAUDE_CODE_CHILD_SESSION",
        "CLAUDE_CODE_ENTRYPOINT",
        "CLAUDE_CODE_SESSION_ID",
        "CLAUDE_CODE_MESSAGING_SOCKET",
        "CLAUDE_CODE_MESSAGING_TOKEN",
        "CLAUDE_CODE_EXECPATH",
        "CLAUDE_CODE_SSE_PORT",
        "CLAUDE_PID",
        "CLAUDE_EFFORT",
        "AI_AGENT",
    };

    /// <summary>
    /// Variables qui coupent la couleur des CLI ecrites en Node (regle de <c>supports-color</c>,
    /// suivie par <c>claude</c> comme par <c>copilot</c>). Claude Code pose <c>NO_COLOR=1</c> dans
    /// ses enfants pour lire leur sortie sans codes ANSI : herite par Organizator, il rendait
    /// entierement gris chaque terminal ouvert depuis l'application.
    /// </summary>
    private static readonly string[] ColorSuppressors =
    {
        "NO_COLOR",
        "FORCE_COLOR",
        "CLICOLOR",
        "CLICOLOR_FORCE",
    };

    /// <summary>
    /// Supprime de l'environnement du processus courant, dont heritent tous les processus lances
    /// ensuite (PowerShell, agents, sonde ACP), les marqueurs de session et les variables de
    /// couleur qui viennent d'un parent. Renvoie les noms retires, vide si l'environnement etait
    /// sain.
    /// </summary>
    public static IReadOnlyList<string> Scrub()
    {
        var removed = new List<string>();
        foreach (var name in ClaudeSessionMarkers)
        {
            if (Remove(name))
            {
                removed.Add(name);
            }
        }

        // Une variable de couleur peut aussi etre un reglage voulu par l'utilisateur : on ne
        // retire que celles qui ne sont pas ecrites dans son environnement persistant.
        foreach (var name in ColorSuppressors)
        {
            if (!IsPersisted(name) && Remove(name))
            {
                removed.Add(name);
            }
        }

        return removed;
    }

    private static bool Remove(string name)
    {
        if (Environment.GetEnvironmentVariable(name) is null)
        {
            return false;
        }

        Environment.SetEnvironmentVariable(name, null);
        return true;
    }

    /// <summary>
    /// Variable ecrite dans l'environnement de l'utilisateur ou de la machine (registre), donc
    /// voulue, par opposition a une variable posee par le processus parent. Registre illisible :
    /// on prefere ne rien retirer.
    /// </summary>
    private static bool IsPersisted(string name)
    {
        try
        {
            return Environment.GetEnvironmentVariable(name, EnvironmentVariableTarget.User) is not null
                || Environment.GetEnvironmentVariable(name, EnvironmentVariableTarget.Machine) is not null;
        }
        catch
        {
            return true;
        }
    }
}
