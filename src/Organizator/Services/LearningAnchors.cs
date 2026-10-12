using System.Globalization;
using System.IO;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization.Metadata;

namespace Organizator.Services;

/// <summary>
/// Exemples de reference du correcteur de Revizator (« etalons ») : des productions reelles d'apprenants,
/// notees par des correcteurs humains, montrees au correcteur avant la reponse a noter. C'est le levier le
/// mieux etabli pour qu'un modele de langue note comme un humain (Yancey et al., BEA 2023 : un exemple par
/// niveau CECRL suffit, l'accord avec les correcteurs passe d'environ 0,3 a 0,8).
/// <para>
/// Fichier <c>anchors.json</c> du dossier de donnees (le dossier racine sur le serveur, commun a tous les
/// comptes) : <c>{ "samples": [ { id, mode: write|speak, kind, level: A1…C1, swScore?, scale?, prompt?,
/// text, source } ] }</c>. Il se remplit par <c>revizator-server anchors import</c> (jeu note au format
/// JSONL, ou corpus Write &amp; Improve) ; il n'est jamais ecrit par un modele : un exemple invente par un
/// modele ne serait pas un etalon. Relu quand il change.
/// </para>
/// </summary>
public static class LearningAnchors
{
    public const string FileName = "anchors.json";

    public static readonly string[] Levels = { "A1", "A2", "B1", "B2", "C1", "C2" };

    private static readonly object Gate = new();
    private static string _path = "";
    private static DateTime _stamp;
    private static List<Sample> _samples = new();

    private static readonly JsonSerializerOptions Pretty = new()
    {
        WriteIndented = true,
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        TypeInfoResolver = new DefaultJsonTypeInfoResolver(),
    };

    public sealed record Sample(string Id, string Mode, string Kind, string Level, double SwScore, int Scale, string Prompt, string Text, string Source);

    /// <summary>Le fichier lu (une fois au demarrage de l'hote ou du serveur).</summary>
    public static void Configure(string dataDir)
    {
        lock (Gate)
        {
            _path = Path.Combine(dataDir, FileName);
            _stamp = default;
            _samples = new List<Sample>();
        }
    }

    public static string PathOf(string dataDir) => Path.Combine(dataDir, FileName);

    public static IReadOnlyList<Sample> All()
    {
        lock (Gate)
        {
            if (_path.Length == 0)
            {
                return _samples;
            }

            try
            {
                var stamp = File.Exists(_path) ? File.GetLastWriteTimeUtc(_path) : default;
                if (stamp != _stamp)
                {
                    _samples = stamp == default ? new List<Sample>() : Read(_path);
                    _stamp = stamp;
                }
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
            {
                // Fichier en cours d'ecriture ou illisible : on garde ce qu'on avait.
            }

            return _samples;
        }
    }

    /// <summary>
    /// Les etalons a montrer pour une tache : ceux de la meme tache (<paramref name="kind"/>) s'ils couvrent
    /// au moins deux niveaux, sinon ceux du meme mode (ecrit ou oral) ; un par niveau, du plus bas au plus haut.
    /// </summary>
    public static List<Sample> Pick(string kind, string mode, IReadOnlyList<Sample>? from = null, int maxLevels = 5, string exclude = "")
    {
        var all = (from ?? All()).Where(s => s.Mode == mode && (exclude.Length == 0 || s.Id != exclude)).ToList();
        var same = all.Where(s => s.Kind == kind).ToList();
        var pool = same.Select(s => s.Level).Distinct().Count() >= 2 ? same : all;
        return pool
            .GroupBy(s => s.Level)
            .OrderBy(g => Array.IndexOf(Levels, g.Key))
            .Select(g => g.OrderByDescending(s => s.Kind == kind).ThenBy(s => Math.Abs(LJWords(s.Text) - 150)).ThenBy(s => s.Id, StringComparer.Ordinal).First())
            .Take(maxLevels)
            .ToList();
    }

    /// <summary>Bloc de consigne : les etalons de la tache, ou rien.</summary>
    public static string Block(string kind, string mode, string rubric, IReadOnlyList<Sample>? from = null, string exclude = "")
    {
        var picked = Pick(kind, mode, from, exclude: exclude);
        if (picked.Count < 2)
        {
            return "";
        }

        var sb = new StringBuilder();
        sb.Append("\nExemples notés par des correcteurs humains (étalons : des productions réelles d'apprenants, pas des modèles à imiter ; situe la réponse par rapport à eux) :\n");
        foreach (var s in picked)
        {
            sb.Append("- Niveau ").Append(s.Level);
            if (rubric == "sw" && s.Scale > 0 && s.Kind == kind)
            {
                sb.Append(", note de la tâche ").Append(s.SwScore.ToString("0.#", CultureInfo.InvariantCulture)).Append('/').Append(s.Scale);
            }

            if (s.Prompt.Length > 0)
            {
                sb.Append(" — consigne : ").Append(Clip(s.Prompt, 200));
            }

            sb.Append(" — réponse : « ").Append(Clip(s.Text, 900)).Append(" »\n");
        }

        return sb.ToString();
    }

    public static List<Sample> Read(string path)
    {
        var root = JsonNode.Parse(File.ReadAllText(path, Encoding.UTF8)) as JsonObject;
        var list = new List<Sample>();
        foreach (var node in (root?["samples"] as JsonArray) ?? new JsonArray())
        {
            if (node is JsonObject o && Parse(o) is { } s)
            {
                list.Add(s);
            }
        }

        return list;
    }

    /// <summary>Un etalon lisible, ou null : texte, mode et niveau CECRL obligatoires.</summary>
    public static Sample? Parse(JsonObject o)
    {
        var text = Str(o, "text", 6000).Trim();
        var mode = Str(o, "mode", 10).Trim().ToLowerInvariant();
        var level = NormalizeLevel(Str(o, "level", 10));
        if (text.Length == 0 || (mode != "write" && mode != "speak") || level.Length == 0)
        {
            return null;
        }

        var kind = Str(o, "kind", 30).Trim().ToLowerInvariant();
        var id = Str(o, "id", 80).Trim();
        // Sans id : une empreinte du texte, stable d'un lancement a l'autre (string.GetHashCode ne l'est pas).
        return new Sample(id.Length > 0 ? id : "s" + Convert.ToHexString(System.Security.Cryptography.SHA1.HashData(Encoding.UTF8.GetBytes(text)))[..12].ToLowerInvariant(),
            mode, kind.Length > 0 ? kind : "free", level, Num(o, "swScore"), (int)Num(o, "scale"), Str(o, "prompt", 600).Trim(), text, Str(o, "source", 200).Trim());
    }

    /// <summary>« B1 », « b1+ », « B1.ii », « A2.i » (Write &amp; Improve) -> « B1 », « A2 » ; vide sinon.</summary>
    public static string NormalizeLevel(string? value)
    {
        var v = (value ?? "").Trim().ToUpperInvariant();
        return v.Length >= 2 && Levels.Contains(v[..2]) ? v[..2] : "";
    }

    public static void Write(string path, IEnumerable<Sample> samples)
    {
        var array = new JsonArray();
        foreach (var s in samples)
        {
            var o = new JsonObject
            {
                ["id"] = s.Id,
                ["mode"] = s.Mode,
                ["kind"] = s.Kind,
                ["level"] = s.Level,
            };
            if (s.Scale > 0)
            {
                o["swScore"] = s.SwScore;
                o["scale"] = s.Scale;
            }

            if (s.Prompt.Length > 0)
            {
                o["prompt"] = s.Prompt;
            }

            o["text"] = s.Text;
            o["source"] = s.Source;
            array.Add(o);
        }

        var tmp = path + ".tmp";
        File.WriteAllText(tmp, new JsonObject { ["samples"] = array }.ToJsonString(Pretty), new UTF8Encoding(false));
        File.Move(tmp, path, true);
    }

    private static string Clip(string text, int max)
    {
        var t = string.Join(' ', text.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
        return t.Length <= max ? t : t[..max].TrimEnd() + "…";
    }

    private static int LJWords(string text) => text.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries).Length;

    private static string Str(JsonObject o, string key, int max)
    {
        var v = o[key] is JsonValue j && j.TryGetValue<string>(out var s) ? s : "";
        return v.Length > max ? v[..max] : v;
    }

    private static double Num(JsonObject o, string key)
    {
        if (o[key] is not JsonValue j)
        {
            return 0;
        }

        if (j.TryGetValue<double>(out var d))
        {
            return d;
        }

        return j.TryGetValue<string>(out var s) && double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out var p) ? p : 0;
    }
}
