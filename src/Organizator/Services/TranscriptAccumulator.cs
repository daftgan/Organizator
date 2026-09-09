using System.IO;

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

/// <param name="State">Une des constantes de <see cref="SessionState"/>.</param>
/// <param name="StateTs">Horodatage (ms Unix) de l'entree dans cet etat : debut du traitement, arrivee de la reponse...</param>
/// <param name="Detail">Precision facultative : outil en cours, motif d'interruption, message d'erreur.</param>
public sealed record SessionSummary(
    string SessionId,
    bool Exists,
    int MessageCount,
    long Updated,
    string Title,
    string State,
    long StateTs,
    string? Detail)
{
    public static SessionSummary Missing(string sessionId)
        => new(sessionId, false, 0, 0, TranscriptAccumulator.DefaultTitle, SessionState.Idle, 0, null);
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

    public int MessageCount;
    public string? CustomTitle;
    public string? AiTitle;
    public string? FirstUserLine;
    public readonly List<TranscriptMessage> Messages = new();

    public string State = SessionState.Idle;
    public long StateTs;
    public string? Detail;

    /// <summary>Copilot : le tour en cours a demande au moins un outil, le modele sera donc rappele.</summary>
    public bool TurnHasTools;

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
