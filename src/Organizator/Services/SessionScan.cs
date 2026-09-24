namespace Organizator.Services;

/// <summary>
/// Lecture incrementale d'un fichier de session (voir <see cref="JsonlTail"/>) : seules les lignes
/// ajoutees depuis le passage precedent sont relues, l'accumulateur poursuit son etat. Le fichier
/// tronque ou reecrit fait repartir la lecture du debut, avec un accumulateur neuf.
/// </summary>
internal sealed class SessionScan
{
    private readonly JsonlTail _tail = new();

    /// <summary>Etat accumule depuis le debut du fichier ; remplace quand la lecture repart de zero.</summary>
    public TranscriptAccumulator Accumulator { get; private set; } = new();

    /// <summary>Vrai tant qu'aucune ligne n'a ete lue.</summary>
    public bool IsEmpty => _tail.IsEmpty;

    public void Reset()
    {
        Accumulator = new TranscriptAccumulator();
        _tail.Reset();
    }

    /// <summary>
    /// Consomme les lignes completes ajoutees au fichier depuis le dernier appel. Une derniere ligne
    /// sans fin de ligne (ecriture en cours) est laissee au passage suivant.
    /// </summary>
    public void Read(string path, Action<string, TranscriptAccumulator> onLine, Action<Exception> onError)
    {
        try
        {
            _tail.Read(path, () => Accumulator = new TranscriptAccumulator(), line => onLine(line, Accumulator));
        }
        catch (Exception ex)
        {
            onError(ex);
        }
    }
}
