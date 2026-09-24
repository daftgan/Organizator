using System.IO;
using System.Text;
using System.Text.RegularExpressions;

namespace Organizator.Services;

/// <summary>Etat d'une session tel que le transcript le raconte ; « fermee » se deduit a part, des processus vivants.</summary>
public static class SessionState
{
    /// <summary>Rien en cours : pas encore de prompt, tour interrompu, ou session refermee proprement.</summary>
    public const string Idle = "idle";

    /// <summary>L'agent traite un prompt (appel du modele ou outil en cours).</summary>
    public const string Working = "working";

    /// <summary>L'agent attend l'utilisateur : question posee, autorisation demandee.</summary>
    public const string Waiting = "waiting";

    /// <summary>La reponse au dernier prompt est complete.</summary>
    public const string Ready = "ready";

    /// <summary>Le tour s'est termine sur une erreur (API, authentification...).</summary>
    public const string Error = "error";
}

/// <summary>
/// Un agent lance par la session et pas encore revenu : coequipier d'une equipe d'agents,
/// sous-agent ou workflow parti en arriere-plan.
/// </summary>
/// <param name="Key">Identite interne : <c>tool:&lt;tool_use_id&gt;</c> tant qu'on ne sait rien de plus,
/// puis <c>agent:&lt;nom&gt;</c> pour un coequipier nomme ou <c>task:&lt;id&gt;</c> pour une tache de fond.</param>
/// <param name="Label">Ce que l'interface affiche : nom de l'agent, ou resume de la tache.</param>
/// <param name="StartedAt">Horodatage (ms Unix) du lancement.</param>
public sealed record AgentRun(string Key, string Label, long StartedAt);

/// <summary>
/// Un sous-agent dont le transcript propre a ete ecrit recemment : la preuve qu'il travaille encore.
/// </summary>
/// <param name="Name">Nom de l'agent d'apres son <c>.meta.json</c> ; vide pour un transcript anonyme (workflow).</param>
/// <param name="WrittenAt">Derniere ecriture (ms Unix).</param>
public sealed record SubagentActivity(string Name, long WrittenAt);

/// <param name="State">Une des constantes de <see cref="SessionState"/>.</param>
/// <param name="StateTs">Horodatage (ms Unix) de l'entree dans cet etat : debut du traitement, arrivee de la reponse...</param>
/// <param name="Detail">Precision facultative : outil en cours, motif d'interruption, message d'erreur.</param>
/// <param name="Agents">Agents lances par la session et encore au travail, du plus ancien au plus recent.</param>
/// <param name="Said">Derniere parole de l'agent — sa reponse, ou la question qu'il pose — raccourcie ; <c>null</c> s'il n'a rien dit.</param>
public sealed record SessionSummary(
    string SessionId,
    bool Exists,
    int MessageCount,
    long Updated,
    string Title,
    string State,
    long StateTs,
    string? Detail,
    IReadOnlyList<AgentRun> Agents,
    string? Said = null)
{
    public static SessionSummary Missing(string sessionId)
        => new(sessionId, false, 0, 0, TranscriptAccumulator.DefaultTitle, SessionState.Idle, 0, null, Array.Empty<AgentRun>());
}

public sealed record TranscriptMessage(string Role, string Text, long Ts);

public sealed record Transcript(bool Exists, string Title, IReadOnlyList<TranscriptMessage> Messages);

/// <summary>
/// Accumule ce que les lecteurs de session (Claude Code, Copilot) extraient d'un fichier :
/// compte de messages, candidats au titre, etat courant et, a la demande, la transcription elle-meme.
/// </summary>
internal sealed class TranscriptAccumulator
{
    public const int MaxMessages = 300;
    public const string DefaultTitle = "Nouvelle session";
    private const int TitleLength = 46;
    private const int DetailLength = 80;
    private const int SaidLength = 160;

    public int MessageCount;
    public string? CustomTitle;
    public string? AiTitle;
    public string? FirstUserLine;
    public readonly List<TranscriptMessage> Messages = new();

    public string State = SessionState.Idle;
    public long StateTs;
    public string? Detail;

    /// <summary>Derniere parole de l'agent : sa reponse, ou la question qu'il pose. Voir <see cref="NoteSaid"/>.</summary>
    public string? Said;

    /// <summary>Copilot : le tour en cours a demande au moins un outil, le modele sera donc rappele.</summary>
    public bool TurnHasTools;

    // Agents lances par la session. `_agents` ne garde que ceux qui n'ont pas encore rendu leur
    // rapport ; `_knownAgents` retient tous les noms vus, pour savoir qu'un SendMessage remet au
    // travail un coequipier deja revenu (et non une session etrangere).
    private readonly List<AgentRun> _agents = new();
    private readonly HashSet<string> _knownAgents = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>Agents encore au travail, du plus ancien au plus recent.</summary>
    public IReadOnlyList<AgentRun> Agents => _agents;

    /// <summary>Un agent de ce nom a-t-il deja ete lance par cette session ?</summary>
    public bool KnowsAgent(string name) => name.Length > 0 && _knownAgents.Contains(name);

    /// <summary>Note un agent parti au travail ; un deuxieme depart sous la meme cle ne compte pas double.</summary>
    public void AgentStarted(string key, string label, long ts)
    {
        if (key.StartsWith("agent:", StringComparison.Ordinal))
        {
            _knownAgents.Add(key["agent:".Length..]);
        }

        var index = IndexOfAgent(key);
        if (index >= 0)
        {
            _agents[index] = _agents[index] with { Label = label.Length > 0 ? label : _agents[index].Label };
            return;
        }

        _agents.Add(new AgentRun(key, label, ts));
    }

    /// <summary>L'agent s'est fait connaitre : sa cle provisoire devient son identite durable.</summary>
    public void AgentIdentified(string key, string newKey, string label)
    {
        var index = IndexOfAgent(key);
        if (index < 0)
        {
            return;
        }

        var run = _agents[index];
        _agents.RemoveAt(index);
        if (newKey.StartsWith("agent:", StringComparison.Ordinal))
        {
            _knownAgents.Add(newKey["agent:".Length..]);
        }

        if (IndexOfAgent(newKey) < 0)
        {
            _agents.Add(run with { Key = newKey, Label = label.Length > 0 ? label : run.Label });
        }
    }

    /// <summary>L'agent a rendu son rapport : il ne travaille plus.</summary>
    public void AgentFinished(string key)
    {
        var index = IndexOfAgent(key);
        if (index >= 0)
        {
            _agents.RemoveAt(index);
        }
    }

    private int IndexOfAgent(string key)
    {
        for (var i = 0; i < _agents.Count; i++)
        {
            if (string.Equals(_agents[i].Key, key, StringComparison.OrdinalIgnoreCase))
            {
                return i;
            }
        }

        return -1;
    }

    /// <summary>
    /// Change d'etat. L'horodatage n'est pris qu'a l'entree dans un etat : une session qui enchaine
    /// dix outils reste « en cours depuis » le prompt, pas depuis le dernier outil. Le detail, lui,
    /// est toujours remplace.
    /// </summary>
    public void SetState(string state, long ts, string? detail)
    {
        if (!string.Equals(state, State, StringComparison.Ordinal))
        {
            State = state;
            StateTs = ts;
        }

        Detail = detail;
    }

    /// <summary>
    /// Retient ce que l'agent vient de dire, que la transcription soit collectee ou non : c'est ce
    /// que l'interface montre sous l'etat d'une conversation, pour savoir ou elle en est sans ouvrir
    /// le journal. Les lignes <c>[outil : …]</c> sont ecartees — elles disent ce qu'il fait, pas ce
    /// qu'il repond — et une parole sans rien d'autre ne remplace pas la precedente.
    /// </summary>
    public void NoteSaid(string? text)
    {
        var said = Spoken(text);
        if (said is not null)
        {
            Said = said;
        }
    }

    // Une ligne d'apercu se lit comme une phrase : les marques de markdown n'y ont pas de sens.
    private static readonly Regex LineMark = new(@"^(?:#{1,6}|>|[-*+]|\d+\.)\s+", RegexOptions.CultureInvariant);
    private static readonly Regex InlineMark = new(@"\*\*|__|\u0060+", RegexOptions.CultureInvariant);

    /// <summary>Le texte parle d'un message, en une ligne raccourcie ; <c>null</c> s'il n'y en a pas.</summary>
    private static string? Spoken(string? text)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return null;
        }

        var sb = new StringBuilder();
        foreach (var line in text!.Replace("\r\n", "\n").Split('\n'))
        {
            var trimmed = InlineMark.Replace(LineMark.Replace(line.Trim(), ""), "").Trim();
            if (trimmed.Length == 0 || trimmed.StartsWith("[outil :", StringComparison.Ordinal))
            {
                continue;
            }

            if (sb.Length > 0)
            {
                sb.Append(' ');
            }

            sb.Append(trimmed);
            if (sb.Length > SaidLength)
            {
                break;
            }
        }

        if (sb.Length == 0)
        {
            return null;
        }

        return sb.Length <= SaidLength ? sb.ToString() : sb.ToString(0, SaidLength).TrimEnd() + "…";
    }

    /// <summary>
    /// Derniere reponse complete de l'agent : le texte final de son dernier tour — ce qui suit sa
    /// derniere ligne <c>[outil : …]</c>, la ou il fait son recapitulatif —, ou tout le tour sans ses
    /// lignes d'outils s'il n'a rien dit apres. C'est ce qu'une nouvelle conversation recoit en resume
    /// du travail deja fait. <c>null</c> si l'agent n'a encore rien repondu.
    /// </summary>
    public static string? LastAnswer(IReadOnlyList<TranscriptMessage> messages)
    {
        for (var i = messages.Count - 1; i >= 0; i--)
        {
            if (messages[i].Role != "assistant")
            {
                continue;
            }

            var answer = FinalText(messages[i].Text);
            if (answer.Length > 0)
            {
                return answer;
            }
        }

        return null;
    }

    /// <summary>Texte d'un tour apres sa derniere ligne d'outil ; a defaut, le tour sans ces lignes.</summary>
    public static string FinalText(string text)
    {
        var lines = text.Replace("\r\n", "\n").Split('\n');
        var lastTool = -1;
        for (var i = 0; i < lines.Length; i++)
        {
            if (lines[i].TrimStart().StartsWith("[outil :", StringComparison.Ordinal))
            {
                lastTool = i;
            }
        }

        var tail = string.Join('\n', lines.Skip(lastTool + 1)).Trim();
        if (tail.Length > 0)
        {
            return tail;
        }

        return string.Join('\n', lines.Where(line => !line.TrimStart().StartsWith("[outil :", StringComparison.Ordinal))).Trim();
    }

    /// <summary>
    /// Ajoute un message a la transcription. Deux entrees consecutives de meme role
    /// sont fusionnees en un seul bloc : un tour de l'agent donne son texte suivi de
    /// ses lignes <c>[outil : …]</c>, et non une dizaine de blocs separes. L'horodatage
    /// conserve est celui de la premiere entree du bloc.
    /// </summary>
    public void AddMessage(string role, string text, long ts)
    {
        var last = Messages.Count > 0 ? Messages[^1] : null;
        if (last is not null && last.Role == role)
        {
            Messages[^1] = last with { Text = last.Text + "\n" + text };
            return;
        }

        Messages.Add(new TranscriptMessage(role, text, ts));

        while (Messages.Count > MaxMessages)
        {
            Messages.RemoveAt(0);
        }
    }

    /// <summary>Titre donne par l'utilisateur, sinon par l'outil, sinon premiere ligne du premier message.</summary>
    public string Title
    {
        get
        {
            if (!string.IsNullOrWhiteSpace(CustomTitle)) return Trim(CustomTitle!);
            if (!string.IsNullOrWhiteSpace(AiTitle)) return Trim(AiTitle!);
            if (!string.IsNullOrWhiteSpace(FirstUserLine)) return Trim(FirstUserLine!);
            return DefaultTitle;
        }
    }

    private static string Trim(string value)
    {
        var line = FirstLine(value);
        return line.Length <= TitleLength ? line : line[..TitleLength];
    }

    public static string FirstLine(string value)
    {
        var index = value.IndexOfAny(new[] { '\r', '\n' });
        return (index < 0 ? value : value[..index]).Trim();
    }

    /// <summary>Premiere ligne, raccourcie a une longueur d'infobulle ; <c>null</c> si vide.</summary>
    public static string? Shorten(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        var line = FirstLine(value);
        return line.Length <= DetailLength ? line : line[..DetailLength] + "…";
    }

    /// <summary>Empreinte taille + date d'un fichier, pour ne relire que ce qui a change ; vide s'il est absent.</summary>
    public static string FileStamp(string path)
    {
        try
        {
            var info = new FileInfo(path);
            return info.Exists ? info.Length + ":" + info.LastWriteTimeUtc.Ticks : "";
        }
        catch
        {
            return "";
        }
    }
}
