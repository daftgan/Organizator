using System.IO;
using System.Text;
using System.Text.Json;

namespace Organizator.Services;

/// <summary>
/// Modeles proposes pour Claude Code. La CLI n'expose aucun listing : on combine les alias
/// officiels (<c>fable</c>, <c>opus</c>, <c>sonnet</c>, <c>haiku</c>) et les identifiants deja
/// utilises sur ce poste (<c>~/.claude/stats-cache.json</c>, <c>~/.claude.json</c>). Le modele et
/// l'effort par defaut viennent de <c>~/.claude/settings.json</c>. Tout est en lecture seule et
/// tolerant : un fichier absent ou illisible donne simplement moins de propositions.
/// </summary>
public sealed class ClaudeModelCatalog
{
    private static readonly JsonDocumentOptions LenientJson = new()
    {
        AllowTrailingCommas = true,
        CommentHandling = JsonCommentHandling.Skip,
    };

    private readonly HostLog _log;
    private readonly string _userProfile;

    public ClaudeModelCatalog(HostLog log)
    {
        _log = log;
        _userProfile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
    }

    public ModelCatalogInfo Build()
    {
        var defaultModel = "";
        var defaultEffort = "";

        try
        {
            using var settings = ReadJson(Path.Combine(_userProfile, ".claude", "settings.json"));
            if (settings is not null)
            {
                defaultModel = AgentProvider.SanitizeModel(GetString(settings.RootElement, "model"));
                defaultEffort = AgentProvider.SanitizeEffort(AgentProvider.Claude, GetString(settings.RootElement, "effortLevel"));
            }
        }
        catch (Exception ex)
        {
            _log.Warn("settings.json de Claude Code illisible : " + ex.Message);
        }

        var used = new SortedSet<string>(StringComparer.Ordinal);

        try
        {
            using var stats = ReadJson(Path.Combine(_userProfile, ".claude", "stats-cache.json"));
            if (stats is not null
                && stats.RootElement.TryGetProperty("modelUsage", out var usage)
                && usage.ValueKind == JsonValueKind.Object)
            {
                foreach (var entry in usage.EnumerateObject())
                {
                    AddUsed(used, entry.Name);
                }
            }
        }
        catch (Exception ex)
        {
            _log.Warn("stats-cache.json de Claude Code illisible : " + ex.Message);
        }

        try
        {
            // ~/.claude.json : projects.<dossier>.lastModelUsage.<modele>. Seuls les noms de
            // modeles sont lus ; le reste du fichier n'est ni conserve ni journalise.
            using var config = ReadJson(Path.Combine(_userProfile, ".claude.json"));
            if (config is not null
                && config.RootElement.TryGetProperty("projects", out var projects)
                && projects.ValueKind == JsonValueKind.Object)
            {
                foreach (var project in projects.EnumerateObject())
                {
                    if (project.Value.ValueKind == JsonValueKind.Object
                        && project.Value.TryGetProperty("lastModelUsage", out var last)
                        && last.ValueKind == JsonValueKind.Object)
                    {
                        foreach (var entry in last.EnumerateObject())
                        {
                            AddUsed(used, entry.Name);
                        }
                    }
                }
            }
        }
        catch (Exception ex)
        {
            _log.Warn(".claude.json illisible : " + ex.Message);
        }

        var groups = new List<ModelGroup>
        {
            new("alias", AgentProvider.ClaudeModels.Select(alias => new ModelOption(alias)).ToArray()),
        };

        if (used.Count > 0)
        {
            groups.Add(new ModelGroup("used", used.Select(id => new ModelOption(id)).ToArray()));
        }

        return new ModelCatalogInfo(defaultModel, defaultEffort, 0, groups);
    }

    private static void AddUsed(SortedSet<string> used, string? candidate)
    {
        var model = AgentProvider.SanitizeModel(candidate);
        if (model.Length > 0 && Array.IndexOf(AgentProvider.ClaudeModels, model) < 0)
        {
            used.Add(model);
        }
    }

    private static JsonDocument? ReadJson(string path)
    {
        if (!File.Exists(path))
        {
            return null;
        }

        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        using var reader = new StreamReader(stream, Encoding.UTF8, detectEncodingFromByteOrderMarks: true);
        var text = reader.ReadToEnd();
        return string.IsNullOrWhiteSpace(text) ? null : JsonDocument.Parse(text, LenientJson);
    }

    private static string? GetString(JsonElement element, string property)
        => element.TryGetProperty(property, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;
}
