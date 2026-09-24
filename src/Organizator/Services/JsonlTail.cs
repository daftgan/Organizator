using System.IO;
using System.Text;

namespace Organizator.Services;

/// <summary>
/// Lecture incrementale d'un fichier JSONL ecrit en continu : seules les lignes ajoutees depuis le
/// passage precedent sont lues. Une session d'agent atteint plusieurs mega-octets, une equipe en
/// cumule des dizaines ; les reparser en entier a chaque ecriture occupait l'hote. Le fichier
/// tronque, reecrit ou disparu fait repartir la lecture du debut : ce qui a ete tire des lignes
/// deja lues ne vaut plus (<c>onRestart</c>).
/// </summary>
internal sealed class JsonlTail
{
    private long _offset;
    private long _written;

    /// <summary>Vrai tant qu'aucune ligne n'a ete lue.</summary>
    public bool IsEmpty => _offset == 0;

    public void Reset()
    {
        _offset = 0;
        _written = 0;
    }

    /// <summary>
    /// Passe a <paramref name="onLine"/> les lignes completes ajoutees depuis le dernier appel. Une
    /// derniere ligne sans fin de ligne (ecriture en cours) est laissee au passage suivant. Les
    /// erreurs d'acces remontent a l'appelant.
    /// </summary>
    public void Read(string path, Action onRestart, Action<string> onLine)
    {
        var info = new FileInfo(path);
        if (!info.Exists)
        {
            Reset();
            onRestart();
            return;
        }

        var length = info.Length;
        var written = info.LastWriteTimeUtc.Ticks;

        // Fichier plus court, ou modifie sans grandir : il a ete reecrit, l'etat accumule ne vaut plus.
        if (length < _offset || (length == _offset && _offset > 0 && written != _written))
        {
            Reset();
            onRestart();
        }

        _written = written;
        if (length == _offset)
        {
            return;
        }

        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        length = Math.Min(length, stream.Length);
        if (length <= _offset)
        {
            return;
        }

        stream.Seek(_offset, SeekOrigin.Begin);
        var buffer = new byte[length - _offset];
        stream.ReadExactly(buffer);

        // La derniere ligne n'est prise en compte que si elle est terminee.
        var end = Array.LastIndexOf(buffer, (byte)'\n');
        if (end < 0)
        {
            return;
        }

        var consumed = end + 1;
        var start = 0;
        if (_offset == 0 && consumed >= 3 && buffer[0] == 0xEF && buffer[1] == 0xBB && buffer[2] == 0xBF)
        {
            start = 3; // BOM UTF-8
        }

        var text = Encoding.UTF8.GetString(buffer, start, consumed - start);
        _offset += consumed;

        foreach (var raw in text.Split('\n'))
        {
            var line = raw.Length > 0 && raw[^1] == '\r' ? raw[..^1] : raw;
            if (line.Length == 0)
            {
                continue;
            }

            onLine(line);
        }
    }
}
