using System.Diagnostics;
using System.IO;
using System.Text;

namespace Organizator.Services;

/// <summary>
/// Journal de l'hote : <c>&lt;dataDir&gt;\host.log</c> en ajout, horodate, plus
/// <see cref="Debug.WriteLine(string)"/>. Toutes les ecritures sont serialisees et
/// aucune erreur d'ecriture ne remonte a l'appelant.
/// </summary>
public sealed class HostLog
{
    private const long MaxBytes = 2 * 1024 * 1024;

    private readonly object _gate = new();
    private readonly string _path;

    public HostLog(string dataDir)
    {
        _path = Path.Combine(dataDir, "host.log");
    }

    public string FilePath => _path;

    public void Info(string message) => Write("INFO", message);

    public void Warn(string message) => Write("WARN", message);

    public void Error(string message) => Write("ERROR", message);

    public void Error(string message, Exception ex) => Write("ERROR", message + " : " + Describe(ex));

    /// <summary>Trace venant du JS (handler <c>log</c>).</summary>
    public void FromWeb(string? level, string? message)
    {
        var lvl = string.IsNullOrWhiteSpace(level) ? "info" : level.Trim().ToUpperInvariant();
        Write("JS/" + lvl, message ?? "");
    }

    public void Write(string level, string message)
    {
        var line = string.Format(
            System.Globalization.CultureInfo.InvariantCulture,
            "{0:yyyy-MM-dd HH:mm:ss.fff} [{1}] {2}",
            DateTime.Now,
            level,
            (message ?? "").Replace("\r\n", "\n").Replace('\n', '↵'));

        Debug.WriteLine("[Organizator] " + line);

        lock (_gate)
        {
            try
            {
                var dir = Path.GetDirectoryName(_path);
                if (!string.IsNullOrEmpty(dir))
                {
                    Directory.CreateDirectory(dir);
                }

                Roll();
                File.AppendAllText(_path, line + Environment.NewLine, new UTF8Encoding(false));
            }
            catch
            {
                // Le journal ne doit jamais faire echouer l'application.
            }
        }
    }

    private void Roll()
    {
        try
        {
            var info = new FileInfo(_path);
            if (!info.Exists || info.Length < MaxBytes)
            {
                return;
            }

            var previous = _path + ".1";
            if (File.Exists(previous))
            {
                File.Delete(previous);
            }

            File.Move(_path, previous);
        }
        catch
        {
            // Ignore : la rotation est un confort, pas une obligation.
        }
    }

    public static string Describe(Exception ex)
    {
        var sb = new StringBuilder();
        var current = ex;
        var depth = 0;
        while (current is not null && depth < 5)
        {
            if (depth > 0)
            {
                sb.Append(" <- ");
            }

            sb.Append(current.GetType().Name).Append(": ").Append(current.Message);
            current = current.InnerException;
            depth++;
        }

        if (ex.StackTrace is { Length: > 0 } stack)
        {
            sb.Append(" | ").Append(stack.Replace("\r\n", " / ").Replace("\n", " / "));
        }

        return sb.ToString();
    }
}
