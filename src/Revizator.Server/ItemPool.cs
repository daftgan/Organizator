using System.Text.Json;
using System.Text.Json.Nodes;
using Organizator.Services;

namespace Revizator.Server;

/// <summary>
/// Les reponses aux bilans express des autres comptes du serveur, sans nom (<c>learnItemPool</c>), pour
/// apprendre la difficulte reelle des questions generees (la page : <c>fitLearned</c> de test.js). Seuls
/// sortent, par bilan, des enregistrements compacts — niveau annonce de la question, ses caracteristiques,
/// l'ecart lexical, devinable ou non, nombre d'options, juste ou faux — sans identifiant de compte, sans
/// date, sans texte de question ni score. Un compte retire du classement (<c>profile.boardHidden</c>) n'y
/// contribue pas. Les 40 derniers bilans de chaque compte au plus ; lu dans les <c>learning.json</c>,
/// relu quand ils changent.
/// </summary>
public sealed class ItemPool
{
    private const int MaxBilansPerAccount = 40;
    private const int MaxItemsPerBilan = 60;
    private const int MinContributors = 2;

    private static readonly JsonDocumentOptions ReadOptions = new()
    {
        AllowTrailingCommas = true,
        CommentHandling = JsonCommentHandling.Skip,
    };

    private static readonly HashSet<string> Levels = new(StringComparer.Ordinal) { "A1", "A2", "B1", "B2", "C1" };

    private readonly string _dataDir;
    private readonly Func<IReadOnlyList<UserAccount>> _accounts;
    private readonly HostLog _log;
    private readonly object _gate = new();
    private readonly Dictionary<string, (DateTime Stamp, long Size, JsonArray Bilans)> _cache = new(StringComparer.Ordinal);

    public ItemPool(string dataDir, Func<IReadOnlyList<UserAccount>> accounts, HostLog log)
    {
        _dataDir = dataDir;
        _accounts = accounts;
        _log = log;
    }

    /// <summary>
    /// <c>{ bilans: [{ items: [{ s, c, f, g, u, o, x }] }] }</c>, ceux des autres comptes que <paramref name="me"/>,
    /// melanges. Rien tant que moins de deux autres comptes y contribuent : avec un seul, ses reponses — en
    /// somme ses scores — seraient les siennes a coup sur.
    /// </summary>
    public JsonObject Build(string me)
    {
        var all = new List<JsonNode?>();
        var contributors = 0;
        foreach (var account in _accounts())
        {
            if (account.Login == me)
            {
                continue;
            }

            var mine = Read(account.Login);
            if (mine.Count > 0)
            {
                contributors++;
            }

            all.AddRange(mine.Select(b => b?.DeepClone()));
        }

        if (contributors < MinContributors)
        {
            return new JsonObject { ["bilans"] = new JsonArray() };
        }

        Random.Shared.Shuffle(System.Runtime.InteropServices.CollectionsMarshal.AsSpan(all));
        return new JsonObject { ["bilans"] = new JsonArray(all.ToArray()) };
    }

    private JsonArray Read(string login)
    {
        var path = Path.Combine(UserSpaces.DirOf(_dataDir, login), "learning.json");
        FileInfo info;
        try
        {
            info = new FileInfo(path);
            if (!info.Exists)
            {
                return new JsonArray();
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return new JsonArray();
        }

        lock (_gate)
        {
            if (_cache.TryGetValue(path, out var hit) && hit.Stamp == info.LastWriteTimeUtc && hit.Size == info.Length)
            {
                return hit.Bilans;
            }
        }

        JsonArray bilans;
        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllBytes(path), ReadOptions);
            bilans = Parse(doc.RootElement);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        {
            _log.Warn($"Reponses partagees : learning.json de « {login} » illisible : {ex.Message}");
            lock (_gate)
            {
                return _cache.TryGetValue(path, out var old) ? old.Bilans : new JsonArray();
            }
        }

        lock (_gate)
        {
            _cache[path] = (info.LastWriteTimeUtc, info.Length, bilans);
        }

        return bilans;
    }

    private static JsonArray Parse(JsonElement root)
    {
        var bilans = new JsonArray();
        if (!Object(root, "subjects", out var subjects) || !Object(subjects, "en", out var en) || !Object(en, "toeic", out var toeic))
        {
            return bilans;
        }

        if (Object(en, "profile", out var profile) && profile.TryGetProperty("boardHidden", out var hidden) && hidden.ValueKind == JsonValueKind.True)
        {
            return bilans;
        }

        if (!toeic.TryGetProperty("history", out var history) || history.ValueKind != JsonValueKind.Array)
        {
            return bilans;
        }

        foreach (var entry in history.EnumerateArray().Reverse().Take(MaxBilansPerAccount * 3))
        {
            if (entry.ValueKind != JsonValueKind.Object || !entry.TryGetProperty("items", out var items) || items.ValueKind != JsonValueKind.Array)
            {
                continue;
            }

            var list = new JsonArray();
            foreach (var r in items.EnumerateArray().Take(MaxItemsPerBilan))
            {
                if (Record(r) is { } rec)
                {
                    list.Add(rec);
                }
            }

            if (list.Count > 0)
            {
                bilans.Add(new JsonObject { ["items"] = list });
            }

            if (bilans.Count >= MaxBilansPerAccount)
            {
                break;
            }
        }

        return bilans;
    }

    /// <summary>Un enregistrement recopie champ par champ, valeurs bornees : rien d'autre ne sort.</summary>
    private static JsonObject? Record(JsonElement r)
    {
        if (r.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        var s = Text(r, "s");
        var c = Text(r, "c");
        if (s is not ("L" or "R") || c is null || !Levels.Contains(c))
        {
            return null;
        }

        var features = new JsonArray();
        if (r.TryGetProperty("f", out var f) && f.ValueKind == JsonValueKind.Array)
        {
            foreach (var x in f.EnumerateArray().Take(6))
            {
                if (x.ValueKind == JsonValueKind.String && x.GetString() is { Length: > 0 and <= 30 } name && name.All(ch => ch is (>= 'a' and <= 'z') or '_'))
                {
                    features.Add(name);
                }
            }
        }

        return new JsonObject
        {
            ["s"] = s,
            ["c"] = c,
            ["f"] = features,
            ["g"] = (int)Math.Clamp(Number(r, "g"), -3, 3),
            ["u"] = Number(r, "u") > 0 ? 1 : 0,
            ["o"] = (int)Math.Clamp(Number(r, "o"), 3, 4),
            ["x"] = Number(r, "x") > 0 ? 1 : 0,
        };
    }

    private static bool Object(JsonElement element, string name, out JsonElement value)
    {
        value = default;
        return element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out value) && value.ValueKind == JsonValueKind.Object;
    }

    private static string? Text(JsonElement element, string name)
        => element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;

    private static double Number(JsonElement element, string name)
        => element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Number && value.TryGetDouble(out var n) && double.IsFinite(n) ? n : 0;
}
