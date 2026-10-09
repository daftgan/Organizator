using System.Globalization;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization.Metadata;
using System.Text.RegularExpressions;

namespace Organizator.Services;

/// <summary>
/// Persistance de Revizator, la page d'apprentissage. Deux sortes de fichiers, dans le dossier de
/// donnees :
/// <list type="bullet">
/// <item><description><c>learning.json</c> : le modele de l'apprenant, ecrit tel quel par l'UI
/// (<c>learnSave</c>). L'hote ne l'interprete pas : il le lit, le rend et l'ecrit atomiquement
/// (<c>.bak</c> de la version precedente, <c>.tmp</c> puis remplacement), relit le <c>.bak</c> si
/// le fichier est illisible et refuse un contenu de plus de 20 Mo.</description></item>
/// <item><description><c>learning\</c> : les documents generes par Claude (<c>lessons\</c>,
/// <c>exercises\</c>, <c>toeic\</c>, <c>sw\</c>, un fichier <c>&lt;id&gt;.json</c> chacun), les
/// enregistrements gardes de l'apprenant (<c>audio\&lt;id&gt;.wav</c>) et le cache du menu RSS
/// (<c>news.json</c>). Le dossier est servi a la page sous <see cref="Host"/>.</description></item>
/// </list>
/// Les chemins ne viennent jamais de l'UI : elle donne un genre et un identifiant
/// (<c>[a-z0-9-]{4,40}</c>), l'hote en deduit le fichier.
/// </summary>
public sealed class LearningStore
{
    /// <summary>Hote virtuel qui sert <see cref="Root"/> a la page (enregistrements, documents).</summary>
    public const string Host = "learn.organizator";

    public const string BaseUrl = "https://" + Host + "/";

    private const long MaxStateBytes = 20L * 1024 * 1024;
    private const long MaxDocBytes = 8L * 1024 * 1024;
    private const long MaxAudioBytes = 64L * 1024 * 1024;

    /// <summary>Identifiant d'un document ou d'un enregistrement : jamais de chemin.</summary>
    private static readonly Regex IdPattern = new("^[a-z0-9-]{4,40}$", RegexOptions.CultureInvariant);

    /// <summary>Genre de document -> sous-dossier de <c>learning\</c>.</summary>
    private static readonly Dictionary<string, string> Folders = new(StringComparer.Ordinal)
    {
        ["lesson"] = "lessons",
        ["exercise"] = "exercises",
        ["toeic"] = "toeic",
        ["sw"] = "sw",
    };

    // Les documents restent lisibles a l'oeil (accents non echappes) ; learning.json, ecrit a
    // chaque changement par l'UI, reste compact. Le resolveur explicite permet d'ecrire une valeur
    // creee en memoire (JsonValue<T>) avec ces options, sinon refusee (« TypeInfoResolver »).
    private static readonly JsonSerializerOptions DocJson = new()
    {
        WriteIndented = true,
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        TypeInfoResolver = new DefaultJsonTypeInfoResolver(),
    };

    private static readonly JsonSerializerOptions StateJson = new()
    {
        WriteIndented = false,
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        TypeInfoResolver = new DefaultJsonTypeInfoResolver(),
    };

    private static readonly JsonDocumentOptions ReadOptions = new()
    {
        AllowTrailingCommas = true,
        CommentHandling = JsonCommentHandling.Skip,
    };

    private readonly object _gate = new();
    private readonly HostLog _log;

    public LearningStore(string dataDir, HostLog log)
    {
        _log = log;
        StatePath = Path.Combine(dataDir, "learning.json");
        Root = Path.Combine(dataDir, "learning");
        try
        {
            Directory.CreateDirectory(Root);
            foreach (var folder in Folders.Values.Append("audio"))
            {
                Directory.CreateDirectory(Path.Combine(Root, folder));
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            _log.Warn("Dossier learning impossible a creer : " + ex.Message);
        }
    }

    /// <summary>Dossier <c>learning\</c>, servi sous <see cref="Host"/>.</summary>
    public string Root { get; }

    /// <summary>Chemin de <c>learning.json</c>.</summary>
    public string StatePath { get; }

    /// <summary>Dossier des enregistrements gardes (<c>learning\audio\</c>).</summary>
    public string AudioDir => Path.Combine(Root, "audio");

    /// <summary>Cache du menu RSS (<see cref="NewsMenu"/>).</summary>
    public string NewsPath => Path.Combine(Root, "news.json");

    public static bool IsKind(string? kind) => kind is not null && Folders.ContainsKey(kind);

    /// <summary>Identifiant d'un document neuf : <c>&lt;genre&gt;-&lt;aaaammjj&gt;-&lt;6 hex&gt;</c>.</summary>
    public static string NewId(string kind)
        => kind + "-" + DateTime.Now.ToString("yyyyMMdd", CultureInfo.InvariantCulture) + "-" + Convert.ToHexString(RandomNumberGenerator.GetBytes(3)).ToLowerInvariant();

    // ------------------------------------------------------------ learning.json

    /// <summary>
    /// <c>{ data, dir, url }</c> : <c>data</c> est le contenu de <c>learning.json</c> (le <c>.bak</c>
    /// s'il est illisible), <c>null</c> s'il n'existe pas encore.
    /// </summary>
    public JsonObject Load()
    {
        JsonNode? data;
        lock (_gate)
        {
            data = ReadState();
        }

        return new JsonObject
        {
            ["data"] = data,
            ["dir"] = Root,
            ["url"] = BaseUrl,
        };
    }

    /// <summary>Ecrit <c>payload.data</c> dans <c>learning.json</c> ; rend <c>{ bytes }</c>.</summary>
    public JsonObject Save(JsonObject payload)
    {
        if (payload["data"] is not JsonObject data)
        {
            throw new InvalidOperationException("Données d’apprentissage absentes ou invalides : un objet JSON est attendu.");
        }

        var text = data.ToJsonString(StateJson);
        var bytes = Encoding.UTF8.GetByteCount(text);
        if (bytes > MaxStateBytes)
        {
            throw new InvalidOperationException(
                $"Données d’apprentissage trop volumineuses ({bytes / 1024.0 / 1024.0:0.0} Mo) : 20 Mo au plus.");
        }

        lock (_gate)
        {
            WriteAtomic(StatePath, text, keepBackup: true);
        }

        return new JsonObject { ["bytes"] = bytes };
    }

    private JsonNode? ReadState()
    {
        var candidates = new[] { StatePath, StatePath + ".bak" };
        for (var i = 0; i < candidates.Length; i++)
        {
            var path = candidates[i];
            if (!File.Exists(path))
            {
                continue;
            }

            try
            {
                var node = JsonNode.Parse(File.ReadAllText(path, Encoding.UTF8), documentOptions: ReadOptions);
                if (node is JsonObject)
                {
                    if (i > 0)
                    {
                        _log.Warn("learning.json illisible, restauration depuis learning.json.bak");
                    }

                    return node;
                }

                _log.Warn(Path.GetFileName(path) + " n'est pas un objet JSON, ignore");
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
            {
                _log.Warn(Path.GetFileName(path) + " illisible : " + ex.Message);
            }
        }

        return null;
    }

    // --------------------------------------------------------------- documents

    /// <summary>Document <c>learning\&lt;genre&gt;s\&lt;id&gt;.json</c>, <c>null</c> s'il n'existe pas.</summary>
    public JsonObject? ReadDoc(string? kind, string? id)
    {
        var path = DocPath(kind, id);
        lock (_gate)
        {
            if (!File.Exists(path))
            {
                return null;
            }

            try
            {
                return JsonNode.Parse(File.ReadAllText(path, Encoding.UTF8), documentOptions: ReadOptions) as JsonObject;
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
            {
                _log.Warn($"Document {kind}/{id} illisible : " + ex.Message);
                return null;
            }
        }
    }

    /// <summary>Ecrit (ou remplace) un document, tel quel.</summary>
    public void WriteDoc(string? kind, string? id, JsonObject doc)
    {
        var path = DocPath(kind, id);
        var text = doc.ToJsonString(DocJson);
        if (Encoding.UTF8.GetByteCount(text) > MaxDocBytes)
        {
            throw new InvalidOperationException("Document trop volumineux : 8 Mo au plus.");
        }

        lock (_gate)
        {
            WriteAtomic(path, text, keepBackup: false);
        }
    }

    /// <summary>Supprime un document ; faux s'il n'existait pas.</summary>
    public bool DeleteDoc(string? kind, string? id)
    {
        var path = DocPath(kind, id);
        lock (_gate)
        {
            if (!File.Exists(path))
            {
                return false;
            }

            File.Delete(path);
            return true;
        }
    }

    private string DocPath(string? kind, string? id)
    {
        if (kind is null || !Folders.TryGetValue(kind, out var folder))
        {
            throw new InvalidOperationException("Genre de document inconnu : " + (kind ?? "(vide)") + ".");
        }

        return Path.Combine(Root, folder, RequireId(id) + ".json");
    }

    private static string RequireId(string? id)
    {
        var value = (id ?? "").Trim();
        if (!IdPattern.IsMatch(value))
        {
            throw new InvalidOperationException("Identifiant invalide : " + (value.Length == 0 ? "(vide)" : value) + " (minuscules, chiffres et tirets, 4 à 40 caractères).");
        }

        return value;
    }

    // ---------------------------------------------------------- enregistrements

    /// <summary>
    /// Garde un enregistrement de l'apprenant (WAV deja encode) sous <c>learning\audio\&lt;id&gt;.wav</c>
    /// et rend <c>{ id, url, path }</c>, <c>url</c> etant lisible par la page tout de suite. Sans
    /// <paramref name="id"/>, un identifiant neuf est cree (<c>rec-aaaammjj-hhmmss-6 hex</c>).
    /// Utilise par la transcription enrichie (<c>transcribe</c> avec <c>keep: true</c>).
    /// </summary>
    public JsonObject SaveAudio(byte[] wav, string? id = null)
    {
        if (wav is null || wav.Length == 0)
        {
            throw new InvalidOperationException("Enregistrement vide.");
        }

        if (wav.Length > MaxAudioBytes)
        {
            throw new InvalidOperationException("Enregistrement trop long pour être gardé (64 Mo au plus).");
        }

        var name = string.IsNullOrWhiteSpace(id)
            ? "rec-" + DateTime.Now.ToString("yyyyMMdd-HHmmss", CultureInfo.InvariantCulture) + "-" + Convert.ToHexString(RandomNumberGenerator.GetBytes(3)).ToLowerInvariant()
            : RequireId(id);
        var path = Path.Combine(AudioDir, name + ".wav");

        lock (_gate)
        {
            Directory.CreateDirectory(AudioDir);
            var tmp = path + ".tmp";
            File.WriteAllBytes(tmp, wav);
            File.Move(tmp, path, overwrite: true);
        }

        return new JsonObject
        {
            ["id"] = name,
            ["url"] = BaseUrl + "audio/" + name + ".wav",
            ["path"] = path,
        };
    }

    /// <summary>Supprime un enregistrement garde ; faux s'il n'existait pas.</summary>
    public bool DeleteAudio(string? id)
    {
        var path = Path.Combine(AudioDir, RequireId(id) + ".wav");
        lock (_gate)
        {
            if (!File.Exists(path))
            {
                return false;
            }

            File.Delete(path);
            return true;
        }
    }

    // --------------------------------------------------------------- primitives

    /// <summary>Ecriture atomique : <c>.bak</c> eventuel de la version precedente, <c>.tmp</c>, puis remplacement.</summary>
    private void WriteAtomic(string path, string content, bool keepBackup)
    {
        var dir = Path.GetDirectoryName(path);
        if (!string.IsNullOrEmpty(dir))
        {
            Directory.CreateDirectory(dir);
        }

        // Le .bak n'est remplace que par une version lisible : un fichier abime ne doit pas
        // ecraser la derniere bonne copie.
        if (keepBackup && File.Exists(path))
        {
            try
            {
                if (IsValidJson(path))
                {
                    File.Copy(path, path + ".bak", overwrite: true);
                }
                else
                {
                    _log.Warn($"{Path.GetFileName(path)} illisible : le .bak precedent est garde");
                }
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                _log.Warn($"Sauvegarde .bak impossible pour {Path.GetFileName(path)} : {ex.Message}");
            }
        }

        var tmp = path + ".tmp";
        File.WriteAllText(tmp, content, new UTF8Encoding(false));
        File.Move(tmp, path, overwrite: true);
    }

    private static bool IsValidJson(string path)
    {
        try
        {
            using var document = JsonDocument.Parse(File.ReadAllBytes(path), ReadOptions);
            return document.RootElement.ValueKind == JsonValueKind.Object;
        }
        catch (JsonException)
        {
            return false;
        }
    }
}
