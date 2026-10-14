using System.Text.Json;
using System.Text.Json.Nodes;
using Organizator.Services;

namespace Revizator.Server;

/// <summary>
/// Reglages de l'administrateur pour tout le serveur, dans <c>admin.json</c> du dossier de donnees : les
/// modeles et efforts de Revizator (cours, exercices et bilans, correction, tuteur, discussion au long cours,
/// correcteur des cartes, professeur, cortex).
/// Deux modes :
/// <list type="bullet">
/// <item><description><c>imposed: false</c> (par defaut) : ce sont les reglages de depart d'un nouveau compte ;
/// chacun les change ensuite dans ses Reglages ;</description></item>
/// <item><description><c>imposed: true</c> : le serveur les applique a toutes les generations et au tuteur,
/// quoi que demande la page (<see cref="Apply"/>).</description></item>
/// </list>
/// </summary>
public sealed class AdminPolicy
{
    /// <summary>Champs de modele et d'effort, avec leur valeur par defaut (celle de la page, <c>DEFAULT_PREFS</c>).</summary>
    public static readonly IReadOnlyDictionary<string, string> Defaults = new Dictionary<string, string>(StringComparer.Ordinal)
    {
        ["lessonModel"] = "sonnet",
        ["lessonEffort"] = "medium",
        ["genModel"] = "sonnet",
        ["genEffort"] = "low",
        ["gradeModel"] = "sonnet",
        ["gradeEffort"] = "medium",
        ["tutorModel"] = "haiku",
        ["tutorEffort"] = "",
        ["longModel"] = "sonnet",
        ["longEffort"] = "low",
        ["cardModel"] = "haiku",
        ["cardEffort"] = "",
        ["profModel"] = "sonnet",
        ["profEffort"] = "low",
        ["cortexModel"] = "sonnet",
        ["cortexEffort"] = "medium",
    };

    /// <summary>Genre de generation -> (champ du modele, champ de l'effort), comme <c>GEN_MODEL</c> de la page.</summary>
    private static readonly Dictionary<string, (string Model, string? Effort)> Kinds = new(StringComparer.Ordinal)
    {
        ["lesson"] = ("lessonModel", "lessonEffort"),
        ["exercise"] = ("genModel", "genEffort"),
        ["toeic"] = ("genModel", "genEffort"),
        ["sw"] = ("genModel", "genEffort"),
        ["grade"] = ("gradeModel", "gradeEffort"),
        ["tutor"] = ("tutorModel", "tutorEffort"),
        ["cardcheck"] = ("cardModel", "cardEffort"),
        ["cardfix"] = ("cardModel", "cardEffort"),
        ["prof"] = ("profModel", "profEffort"),
        ["cortex"] = ("cortexModel", "cortexEffort"),
    };

    private static readonly JsonSerializerOptions Indented = new() { WriteIndented = true };

    private readonly string _path;
    private readonly HostLog _log;
    private readonly object _gate = new();
    private Dictionary<string, string> _values = new(Defaults, StringComparer.Ordinal);
    private bool _imposed;
    private string _changedBy = "";
    private string _changed = "";

    public AdminPolicy(string dataDir, HostLog log)
    {
        _path = Path.Combine(dataDir, "admin.json");
        _log = log;
        Load();
    }

    public bool Imposed
    {
        get { lock (_gate) { return _imposed; } }
    }

    /// <summary><c>{ models: { lessonModel… }, imposed, changed, changedBy, defaults }</c>.</summary>
    public JsonObject ToJson()
    {
        lock (_gate)
        {
            var models = new JsonObject();
            foreach (var (key, value) in _values)
            {
                models[key] = value;
            }

            var defaults = new JsonObject();
            foreach (var (key, value) in Defaults)
            {
                defaults[key] = value;
            }

            return new JsonObject
            {
                ["models"] = models,
                ["imposed"] = _imposed,
                ["changed"] = _changed,
                ["changedBy"] = _changedBy,
                ["defaults"] = defaults,
            };
        }
    }

    /// <summary>Enregistre <c>{ models, imposed }</c> (valeurs verifiees : modele et effort de Claude Code).</summary>
    public JsonObject Save(JsonObject payload, string by)
    {
        var values = new Dictionary<string, string>(Defaults, StringComparer.Ordinal);
        var models = payload["models"] as JsonObject ?? new JsonObject();
        foreach (var key in Defaults.Keys)
        {
            var raw = models[key] is JsonValue v && v.TryGetValue<string>(out var text) ? text : null;
            if (raw is null)
            {
                continue;
            }

            var clean = key.EndsWith("Effort", StringComparison.Ordinal)
                ? AgentProvider.RequireEffort(AgentProvider.Claude, raw)
                : AgentProvider.RequireModel(raw);
            // Un modele vide n'a pas de sens ici (la generation partirait sans --model) : valeur par defaut.
            values[key] = clean.Length == 0 && !key.EndsWith("Effort", StringComparison.Ordinal) ? Defaults[key] : clean;
        }

        var imposed = payload["imposed"] is JsonValue i && i.TryGetValue<bool>(out var flag) && flag;
        lock (_gate)
        {
            _values = values;
            _imposed = imposed;
            _changedBy = by;
            _changed = DateTimeOffset.UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ");
            Write();
        }

        _log.Info($"Administration : modeles de Revizator {(imposed ? "imposes" : "proposes")} par « {by} »");
        return ToJson();
    }

    /// <summary>En mode impose : remplace <c>model</c> et <c>effort</c> d'un <c>learnGenerate</c> selon son genre.</summary>
    public void Apply(JsonObject payload)
    {
        var kind = payload["kind"] is JsonValue k && k.TryGetValue<string>(out var text) ? text : "";
        lock (_gate)
        {
            if (!_imposed || !Kinds.TryGetValue(kind, out var fields))
            {
                return;
            }

            payload["model"] = _values[fields.Model];
            if (fields.Effort is not null)
            {
                payload["effort"] = _values[fields.Effort];
            }
        }
    }

    /// <summary>
    /// Modele et effort imposes au tuteur a voix haute (<c>voiceStart</c> en mode tuteur) : ceux de la discussion
    /// au long cours si <paramref name="longRun"/>, sinon ceux du tuteur ; null si rien n'est impose.
    /// </summary>
    public (string Model, string Effort)? TutorVoice(bool longRun)
    {
        lock (_gate)
        {
            return _imposed
                ? longRun ? (_values["longModel"], _values["longEffort"]) : (_values["tutorModel"], _values["tutorEffort"])
                : null;
        }
    }

    private void Load()
    {
        if (!File.Exists(_path))
        {
            return;
        }

        try
        {
            if (JsonNode.Parse(File.ReadAllText(_path)) is not JsonObject root)
            {
                return;
            }

            var models = root["models"] as JsonObject ?? new JsonObject();
            foreach (var key in Defaults.Keys)
            {
                if (models[key] is JsonValue v && v.TryGetValue<string>(out var text))
                {
                    try
                    {
                        var clean = key.EndsWith("Effort", StringComparison.Ordinal)
                            ? AgentProvider.RequireEffort(AgentProvider.Claude, text)
                            : AgentProvider.RequireModel(text);
                        if (clean.Length > 0 || key.EndsWith("Effort", StringComparison.Ordinal))
                        {
                            _values[key] = clean;
                        }
                    }
                    catch (InvalidOperationException)
                    {
                        // valeur abimee : la valeur par defaut reste
                    }
                }
            }

            _imposed = root["imposed"] is JsonValue i && i.TryGetValue<bool>(out var flag) && flag;
            _changed = root["changed"]?.GetValue<string>() ?? "";
            _changedBy = root["changedBy"]?.GetValue<string>() ?? "";
        }
        catch (Exception ex) when (ex is JsonException or IOException or InvalidOperationException)
        {
            _log.Warn("admin.json illisible, reglages par defaut : " + ex.Message);
        }
    }

    private void Write()
    {
        var models = new JsonObject();
        foreach (var (key, value) in _values)
        {
            models[key] = value;
        }

        var root = new JsonObject { ["models"] = models, ["imposed"] = _imposed, ["changed"] = _changed, ["changedBy"] = _changedBy };
        var tmp = _path + ".tmp";
        File.WriteAllText(tmp, root.ToJsonString(Indented));
        File.Move(tmp, _path, overwrite: true);
    }
}
