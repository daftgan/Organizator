using System.IO;
using Microsoft.Data.Sqlite;

namespace Organizator.Services;

/// <summary>
/// Suppression d'une session que la CLI Copilot a creee pour le compte d'Organizator (sonde de
/// modeles, redaction assistee). La CLI ne purge jamais ces sessions : sans ce nettoyage, elles
/// s'accumuleraient dans le selecteur <c>copilot --resume</c>. Sont retires le dossier de
/// <c>session-state</c> et la ligne correspondante de <c>session-store.db</c>.
/// </summary>
internal static class CopilotSessionCleanup
{
    /// <param name="keepIfUsed">
    /// Vrai pour epargner une session qui a produit des evenements (sonde de modeles : elle ne
    /// devrait rien avoir ecrit, et mieux vaut garder une trace inattendue que la perdre).
    /// Faux pour une session dont on sait qu'elle a parle (redaction) : elle est a jeter.
    /// </param>
    public static void Remove(CopilotSessions sessions, string sessionId, bool keepIfUsed, HostLog log, string what)
    {
        try
        {
            var dir = sessions.GetSessionDir(sessionId);
            if (Directory.Exists(dir))
            {
                if (keepIfUsed && File.Exists(Path.Combine(dir, "events.jsonl")))
                {
                    log.Warn($"Session {what} {sessionId} conservee : elle contient des evenements.");
                }
                else
                {
                    Directory.Delete(dir, recursive: true);
                }
            }
        }
        catch (Exception ex)
        {
            log.Warn($"Suppression du dossier de la session {what} {sessionId} impossible : {ex.Message}");
        }

        var db = Path.Combine(sessions.CopilotRoot, "session-store.db");
        if (!File.Exists(db))
        {
            return;
        }

        try
        {
            var deleted = DeleteRow(db, sessionId);
            log.Info($"Session {what} {sessionId} retiree de session-store.db ({deleted} ligne(s)).");
        }
        catch (Exception ex)
        {
            // Inclut l'absence de la bibliotheque SQLite : le dossier est deja supprime, seule la ligne reste.
            log.Warn($"Suppression de la session {what} {sessionId} dans session-store.db impossible : {ex.Message}");
        }
    }

    /// <summary>
    /// Isolee dans sa propre methode : si Microsoft.Data.Sqlite ne se charge pas, seul cet appel
    /// echoue, et le nettoyage du dossier (fait avant) reste acquis.
    /// </summary>
    private static int DeleteRow(string db, string sessionId)
    {
        var builder = new SqliteConnectionStringBuilder
        {
            DataSource = db,
            Mode = SqliteOpenMode.ReadWrite,
            DefaultTimeout = 5,
        };

        using var connection = new SqliteConnection(builder.ConnectionString);
        connection.Open();
        using var command = connection.CreateCommand();
        command.CommandText = "DELETE FROM sessions WHERE id = $id";
        command.Parameters.AddWithValue("$id", sessionId);
        return command.ExecuteNonQuery();
    }
}
