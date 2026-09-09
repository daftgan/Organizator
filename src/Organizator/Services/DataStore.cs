using System.IO;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Organizator.Services;

/// <summary>
/// Persistance de <c>data.json</c> et <c>settings.json</c> dans le dossier de donnees.
/// Ecriture atomique (<c>.tmp</c> puis <see cref="File.Move(string, string, bool)"/>) avec
/// conservation d'un <c>.bak</c>. Lecture tolerante : fichier absent -> etat vide ;
/// fichier corrompu -> <c>.bak</c> ; sinon etat vide + trace.
/// </summary>
public sealed class DataStore
{
    private static readonly JsonSerializerOptions SettingsJson = new()
    {
        WriteIndented = true,
        PropertyNameCaseInsensitive = true,
    };

    private static readonly JsonDocumentOptions DocumentOptions = new()
    {
        AllowTrailingCommas = true,
        CommentHandling = JsonCommentHandling.Skip,
    };

    private static readonly JsonNodeOptions NodeOptions = new() { PropertyNameCaseInsensitive = true };

    private readonly object _gate = new();
    private readonly HostLog _log;

    public DataStore(string dataDir, HostLog log)
    {
        DataDir = dataDir;
        _log = log;
        Directory.CreateDirectory(DataDir);
        Directory.CreateDirectory(LaunchDir);
    }

    public string DataDir { get; }

    public string DataPath => Path.Combine(DataDir, "data.json");

    public string SettingsPath => Path.Combine(DataDir, "settings.json");

    public string LaunchDir => Path.Combine(DataDir, "launch");

    // ---------------------------------------------------------------- data.json

    /// <summary>
    /// Charge <c>data.json</c>. Les tableaux sont renvoyes tels quels (aucun champ inconnu n'est perdu).
    /// </summary>
    public JsonObject LoadData()
    {
        lock (_gate)
        {
            var node = ReadJsonObject(DataPath, "data.json");
            return NormalizeData(node);
        }
    }

    /// <summary>Enregistre <c>{ tasks, types, convos, lastType }</c> venant du JS.</summary>
    public void SaveData(JsonObject? payload)
    {
        lock (_gate)
        {
            var normalized = NormalizeData(payload);
            WriteAtomic(DataPath, normalized.ToJsonString(SettingsJson));
        }
    }

    private static JsonObject NormalizeData(JsonObject? source)
    {
        var result = new JsonObject
        {
            ["version"] = 1,
            ["tasks"] = CloneArray(source, "tasks"),
            ["types"] = CloneArray(source, "types"),
            ["convos"] = CloneArray(source, "convos"),
            ["remarks"] = CloneArray(source, "remarks"),
        };

        var lastType = source?["lastType"];
        result["lastType"] = lastType is null ? JsonValue.Create("") : lastType.DeepClone();
        return result;
    }

    private static JsonArray CloneArray(JsonObject? source, string name)
    {
        if (source is not null && source.TryGetPropertyValue(name, out var node) && node is JsonArray array)
        {
            return (JsonArray)array.DeepClone();
        }

        return new JsonArray();
    }

    // ------------------------------------------------------------ settings.json

    public AppSettings LoadSettings()
    {
        lock (_gate)
        {
            var raw = ReadText(SettingsPath, "settings.json");
            AppSettings settings;
            if (raw is null)
            {
                settings = new AppSettings();
            }
            else
            {
                try
                {
                    settings = JsonSerializer.Deserialize<AppSettings>(raw, SettingsJson) ?? new AppSettings();
                }
                catch (Exception ex)
                {
                    _log.Error("settings.json illisible, valeurs par defaut utilisees", ex);
                    settings = new AppSettings();
                }
            }

            settings.Sanitize();
            return settings;
        }
    }

    /// <summary>
    /// Enregistre les reglages de l'UI. <c>window</c> n'est jamais ecrase ici : il est
    /// relu depuis le fichier courant (l'hote en est le seul proprietaire).
    /// </summary>
    public AppSettings SaveSettings(AppSettings incoming)
    {
        lock (_gate)
        {
            var current = LoadSettingsNoLock();
            var merged = incoming.Clone();
            merged.Window = current.Window;
            merged.Sanitize();
            WriteAtomic(SettingsPath, JsonSerializer.Serialize(merged, SettingsJson));
            return merged;
        }
    }

    /// <summary>Enregistre uniquement l'etat de la fenetre, sans toucher au reste.</summary>
    public void SaveWindowPlacement(WindowPlacement? placement)
    {
        lock (_gate)
        {
            var current = LoadSettingsNoLock();
            current.Window = placement;
            current.Sanitize();
            WriteAtomic(SettingsPath, JsonSerializer.Serialize(current, SettingsJson));
        }
    }

    private AppSettings LoadSettingsNoLock()
    {
        var raw = ReadText(SettingsPath, "settings.json");
        if (raw is null)
        {
            return new AppSettings();
        }

        try
        {
            return JsonSerializer.Deserialize<AppSettings>(raw, SettingsJson) ?? new AppSettings();
        }
        catch
        {
            return new AppSettings();
        }
    }

    // --------------------------------------------------------------- primitives

    private JsonObject? ReadJsonObject(string path, string label)
    {
        var raw = ReadText(path, label);
        if (raw is null)
        {
            return null;
        }

        try
        {
            return JsonNode.Parse(raw, NodeOptions, DocumentOptions) as JsonObject;
        }
        catch (Exception ex)
        {
            _log.Error($"{label} illisible, etat vide utilise", ex);
            return null;
        }
    }

    /// <summary>
    /// Lit le fichier ; si son contenu n'est pas du JSON valide, retombe sur le <c>.bak</c>.
    /// Retourne <c>null</c> si rien d'exploitable n'existe.
    /// </summary>
    private string? ReadText(string path, string label)
    {
        var candidates = new[] { path, path + ".bak" };
        for (var i = 0; i < candidates.Length; i++)
        {
            var candidate = candidates[i];
            if (!File.Exists(candidate))
            {
                continue;
            }

            string text;
            try
            {
                text = File.ReadAllText(candidate, Encoding.UTF8);
            }
            catch (Exception ex)
            {
                _log.Error($"Lecture de {Path.GetFileName(candidate)} impossible", ex);
                continue;
            }

            if (IsValidJson(text))
            {
                if (i > 0)
                {
                    _log.Warn($"{label} corrompu, restauration depuis la sauvegarde .bak");
                }

                return text;
            }

            _log.Warn($"{Path.GetFileName(candidate)} n'est pas du JSON valide");
        }

        return null;
    }

    private static bool IsValidJson(string text)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return false;
        }

        try
        {
            using var _ = JsonDocument.Parse(text, DocumentOptions);
            return true;
        }
        catch (JsonException)
        {
            return false;
        }
    }

    /// <summary>Ecriture atomique : <c>.bak</c> de la version precedente, <c>.tmp</c>, puis remplacement.</summary>
    private void WriteAtomic(string path, string content)
    {
        var dir = Path.GetDirectoryName(path);
        if (!string.IsNullOrEmpty(dir))
        {
            Directory.CreateDirectory(dir);
        }

        if (File.Exists(path))
        {
            try
            {
                File.Copy(path, path + ".bak", overwrite: true);
            }
            catch (Exception ex)
            {
                _log.Warn($"Sauvegarde .bak impossible pour {Path.GetFileName(path)} : {ex.Message}");
            }
        }

        var tmp = path + ".tmp";
        File.WriteAllText(tmp, content, new UTF8Encoding(false));
        File.Move(tmp, path, overwrite: true);
    }
}
