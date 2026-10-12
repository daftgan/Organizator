using System.Globalization;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization.Metadata;
using Organizator.Services;

namespace Revizator.Server;

/// <summary>
/// Mesurer et etalonner le correcteur de Revizator, en ligne de commande (docs/REVIZATOR-SERVER.md, § 3) :
/// <list type="bullet">
/// <item><description><c>anchors import|list|clear</c> : les etalons montres au correcteur
/// (<see cref="LearningAnchors"/>), tires d'un jeu note par des humains ;</description></item>
/// <item><description><c>eval</c> : le correcteur, tel qu'il tourne (memes consignes, meme modele), sur un
/// jeu note : accord avec les notes humaines (kappa pondere quadratique, accord exact et a un niveau pres),
/// biais (trop indulgent ou trop severe), et fidelite d'un passage a l'autre.</description></item>
/// </list>
/// Jeu note : un objet JSON par ligne, <c>{ id, mode: write|speak, kind, level: A1…C2, swScore?, scale?,
/// prompt?, text, source }</c> ; ou le corpus Write &amp; Improve (BEA-2019, <c>{ id, cefr: "B1.ii", text }</c>
/// par ligne), a telecharger soi-meme aupres de Cambridge (licence non commerciale).
/// </summary>
public static class Evaluation
{
    private static readonly JsonSerializerOptions Pretty = new()
    {
        WriteIndented = true,
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        TypeInfoResolver = new DefaultJsonTypeInfoResolver(),
    };

    // ------------------------------------------------------------------ jeu note

    /// <summary>Les echantillons d'un fichier, au format de Revizator ou de Write &amp; Improve.</summary>
    public static List<LearningAnchors.Sample> ReadGold(string path, out int skipped)
    {
        var list = new List<LearningAnchors.Sample>();
        skipped = 0;
        var text = File.ReadAllText(path, Encoding.UTF8).TrimStart('﻿');
        IEnumerable<JsonNode?> nodes;
        if (text.TrimStart().StartsWith('['))
        {
            nodes = JsonNode.Parse(text) as JsonArray ?? new JsonArray();
        }
        else if (Whole(text) is JsonObject single && single["samples"] is JsonArray samples)
        {
            nodes = samples;
        }
        else
        {
            nodes = text.Split('\n').Where(l => l.Trim().Length > 0).Select(l =>
            {
                try
                {
                    return JsonNode.Parse(l);
                }
                catch (JsonException)
                {
                    return null;
                }
            }).ToList();
        }

        var n = 0;
        foreach (var node in nodes)
        {
            n++;
            if (node is not JsonObject o)
            {
                skipped++;
                continue;
            }

            // Write & Improve : « cefr » (A2.i, B1.ii…), pas de mode ; LOCNESS (« N », natifs) est ecarte.
            if (o["level"] is null && o["cefr"] is JsonValue)
            {
                o = new JsonObject
                {
                    ["id"] = "wi-" + (o["id"]?.ToString() ?? n.ToString(CultureInfo.InvariantCulture)),
                    ["mode"] = "write",
                    ["kind"] = "free",
                    ["level"] = o["cefr"]?.ToString(),
                    ["text"] = o["text"]?.ToString(),
                    ["source"] = "Write & Improve (BEA-2019)",
                };
            }

            o["id"] ??= "g" + n.ToString(CultureInfo.InvariantCulture);
            if (LearningAnchors.Parse(o) is { } s)
            {
                list.Add(s);
            }
            else
            {
                skipped++;
            }
        }

        return list;
    }

    /// <summary>Le fichier entier comme un seul document JSON (anchors.json), ou null (JSONL : un objet par ligne).</summary>
    private static JsonNode? Whole(string text)
    {
        try
        {
            return JsonNode.Parse(text);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    // ------------------------------------------------------------------ etalons

    public static int Anchors(ServerConfig config, string[] args)
    {
        var path = LearningAnchors.PathOf(config.DataDir);
        var current = File.Exists(path) ? LearningAnchors.Read(path) : new List<LearningAnchors.Sample>();
        switch (args.Length >= 2 ? args[1] : "")
        {
            case "list":
                if (current.Count == 0)
                {
                    Console.WriteLine("Aucun etalon. Importez un jeu note : revizator-server anchors import <fichier>");
                    return 0;
                }

                foreach (var g in current.GroupBy(s => s.Mode + " / " + s.Kind).OrderBy(g => g.Key, StringComparer.Ordinal))
                {
                    Console.WriteLine($"{g.Key} : " + string.Join(", ", g.GroupBy(s => s.Level).OrderBy(x => Array.IndexOf(LearningAnchors.Levels, x.Key)).Select(x => $"{x.Key} x{x.Count()}")));
                }

                Console.WriteLine($"{current.Count} etalon(s) dans {path}.");
                return 0;

            case "clear":
                if (File.Exists(path))
                {
                    File.Delete(path);
                }

                Console.WriteLine("Etalons supprimes : le correcteur note sans exemple.");
                return 0;

            case "import" when args.Length >= 3:
            {
                var perLevel = IntOption(args, "--per-level", 2);
                var replace = args.Contains("--replace");
                var gold = ReadGold(args[2], out var skipped);
                // Par tache et par niveau : les textes de 80 a 300 mots, du plus proche de 160 mots au plus
                // loin (un etalon trop court ou trop long renseigne mal), puis l'ordre du fichier.
                var picked = gold
                    .GroupBy(s => (s.Mode, s.Kind, s.Level))
                    .SelectMany(g => g.Where(s => Words(s.Text) is >= 30 and <= 400)
                        .OrderBy(s => Words(s.Text) is >= 80 and <= 300 ? 0 : 1)
                        .ThenBy(s => Math.Abs(Words(s.Text) - 160))
                        .Take(perLevel))
                    .ToList();
                var kept = replace ? new List<LearningAnchors.Sample>() : current.Where(c => picked.All(p => p.Id != c.Id)).ToList();
                kept.AddRange(picked);
                LearningAnchors.Write(path, kept);
                Console.WriteLine($"{picked.Count} etalon(s) importe(s) ({gold.Count} lu(s), {skipped} ecarte(s)) ; {kept.Count} en tout dans {path}.");
                Console.WriteLine("Mesurez l'effet sur un autre jeu note (pas celui-ci) : revizator-server eval <fichier>");
                return 0;
            }

            default:
                Console.Error.WriteLine("Usage : revizator-server anchors import <fichier> [--per-level 2] [--replace] | anchors list | anchors clear");
                return 2;
        }
    }

    // ------------------------------------------------------------------ evaluation

    private sealed record Run(LearningAnchors.Sample Sample, int Pass, double Level, double SwScore, double Cost, string Error);

    public static async Task<int> RunAsync(ServerConfig config, string[] args)
    {
        if (args.Length < 2 || !File.Exists(args[1]))
        {
            Console.Error.WriteLine("Usage : revizator-server eval <jeu-note.jsonl> [--runs 2] [--limit 60] [--model sonnet] [--effort medium] [--no-anchors] [--out rapport.json]");
            return 2;
        }

        var runs = Math.Clamp(IntOption(args, "--runs", 2), 1, 5);
        var limit = Math.Max(1, IntOption(args, "--limit", 60));
        var model = StrOption(args, "--model", "sonnet");
        var effort = StrOption(args, "--effort", "medium");
        var noAnchors = args.Contains("--no-anchors");
        var output = StrOption(args, "--out", "");
        var gold = ReadGold(args[1], out var skipped);
        if (gold.Count == 0)
        {
            Console.Error.WriteLine($"Aucun echantillon lisible dans {args[1]} ({skipped} ligne(s) ecartee(s)).");
            return 1;
        }

        // Un echantillon par niveau a tour de role : un jeu limite reste equilibre entre les niveaux.
        var byLevel = gold.GroupBy(s => s.Level).OrderBy(g => Array.IndexOf(LearningAnchors.Levels, g.Key)).Select(g => new Queue<LearningAnchors.Sample>(g)).ToList();
        var samples = new List<LearningAnchors.Sample>();
        while (samples.Count < limit && byLevel.Any(q => q.Count > 0))
        {
            foreach (var q in byLevel.Where(q => q.Count > 0))
            {
                if (samples.Count < limit)
                {
                    samples.Add(q.Dequeue());
                }
            }
        }

        LearningAnchors.Configure(config.DataDir);
        var anchors = noAnchors ? 0 : LearningAnchors.All().Count;
        var dir = Path.Combine(config.DataDir, "eval-work");
        Directory.CreateDirectory(dir);
        var log = new HostLog(dir);
        var launcher = new AgentLauncher(new DataStore(dir, log), log);
        var learning = new LearningStore(dir, log);
        var agent = new LearningAgent(launcher, learning, new NewsMenu(learning, log), log, dir);
        Console.WriteLine($"Evaluation du correcteur : {samples.Count} echantillon(s) x {runs} passage(s), {model}/{effort}, "
            + (noAnchors ? "sans etalons" : $"{anchors} etalon(s) (l'echantillon note n'est jamais son propre etalon)") + ".");

        var results = new List<Run>();
        var gate = new SemaphoreSlim(3);
        var done = 0;
        var tasks = new List<Task>();
        foreach (var (sample, index) in samples.Select((s, i) => (s, i)))
        {
            for (var pass = 0; pass < runs; pass++)
            {
                var p = pass;
                tasks.Add(Task.Run(async () =>
                {
                    await gate.WaitAsync().ConfigureAwait(false);
                    try
                    {
                        var r = await GradeAsync(agent, sample, index, p, model, effort, noAnchors).ConfigureAwait(false);
                        lock (results)
                        {
                            results.Add(r);
                            done++;
                            Console.Write($"\r{done}/{samples.Count * runs} corrections{(r.Error.Length > 0 ? " (un echec : " + r.Error + ")" : "")}   ");
                        }
                    }
                    finally
                    {
                        gate.Release();
                    }
                }));
            }
        }

        await Task.WhenAll(tasks).ConfigureAwait(false);
        Console.WriteLine();
        var report = Report(results, runs);
        Console.WriteLine(report.Text);
        if (output.Length > 0)
        {
            var json = report.Json;
            json["model"] = model;
            json["effort"] = effort;
            json["anchors"] = anchors;
            json["file"] = Path.GetFileName(args[1]);
            json["at"] = DateTimeOffset.Now.ToString("O", CultureInfo.InvariantCulture);
            File.WriteAllText(output, json.ToJsonString(Pretty), new UTF8Encoding(false));
            Console.WriteLine("Rapport detaille : " + output);
        }

        return 0;
    }

    private static async Task<Run> GradeAsync(LearningAgent agent, LearningAnchors.Sample s, int index, int pass, string model, string effort, bool noAnchors)
    {
        var rubric = s.Scale > 0 ? "sw" : "lesson";
        var payload = new JsonObject
        {
            ["job"] = $"eval-{index}-{pass}-{Guid.NewGuid():N}"[..36],
            ["kind"] = "grade",
            ["model"] = model,
            ["effort"] = effort,
            ["context"] = "",
            ["params"] = new JsonObject
            {
                ["mode"] = s.Mode,
                ["rubric"] = rubric,
                ["task"] = new JsonObject
                {
                    ["id"] = s.Id,
                    ["kind"] = s.Kind,
                    ["promptFr"] = s.Prompt.Length > 0 ? "" : "Production libre (sujet non fourni).",
                    ["prompt"] = s.Prompt,
                    ["criteria"] = new JsonArray(),
                    ["scale"] = s.Scale,
                    ["words"] = new JsonArray(),
                    ["seconds"] = 0,
                },
                ["response"] = s.Text,
                ["metrics"] = null,
                ["level"] = "B1+",
                ["explain"] = "fr",
                ["targets"] = new JsonArray(),
                ["anchorExclude"] = s.Id,
                ["noAnchors"] = noAnchors,
            },
        };
        try
        {
            var result = await agent.GenerateAsync(payload).ConfigureAwait(false);
            var doc = result["doc"] as JsonObject;
            var scores = doc?["scores"] as JsonObject;
            var keys = s.Mode == "speak" ? new[] { "range", "accuracy", "coherence", "fluency" } : new[] { "range", "accuracy", "coherence" };
            if (scores is not null && s.Mode == "speak" && LJ.Num(scores, "fluency") <= 0)
            {
                keys = new[] { "range", "accuracy", "coherence" }; // comme LevelOfScores : sans mesure de fluence
            }

            var level = scores is null ? double.NaN : keys.Average(k => LJ.Num(scores, k)) - 1; // 1 ≈ A1 -> 0
            return new Run(s, pass, level, LJ.Num(doc, "swScore"), LJ.Num(result, "cost"), "");
        }
        catch (InvalidOperationException ex)
        {
            return new Run(s, pass, double.NaN, double.NaN, 0, ex.Message);
        }
    }

    private sealed record Summary(string Text, JsonObject Json);

    private static Summary Report(List<Run> results, int runs)
    {
        var sb = new StringBuilder();
        var ok = results.Where(r => !double.IsNaN(r.Level)).ToList();
        var first = ok.Where(r => r.Pass == 0).ToList();
        var json = new JsonObject();
        if (first.Count == 0)
        {
            sb.Append("Aucune correction n'a abouti : Claude Code est-il connecte (CLAUDE_CODE_OAUTH_TOKEN) ?");
            return new Summary(sb.ToString(), json);
        }

        int Gold(Run r) => Array.IndexOf(LearningAnchors.Levels, r.Sample.Level);
        static int Band(double level) => (int)Math.Clamp(Math.Floor(level + 0.5), 0, 5);

        var gold = first.Select(Gold).ToArray();
        var pred = first.Select(r => Band(r.Level)).ToArray();
        var qwk = Qwk(gold, pred, 6);
        var exact = gold.Zip(pred).Count(x => x.First == x.Second) / (double)gold.Length;
        var adjacent = gold.Zip(pred).Count(x => Math.Abs(x.First - x.Second) <= 1) / (double)gold.Length;
        var bias = first.Average(r => r.Level - Gold(r));
        var mae = first.Average(r => Math.Abs(r.Level - Gold(r)));
        var pearson = Pearson(first.Select(r => (double)Gold(r)).ToArray(), first.Select(r => r.Level).ToArray());
        var cost = results.Sum(r => r.Cost);

        sb.Append($"\nAccord avec les notes humaines ({first.Count} echantillons, premier passage) :\n");
        sb.Append($"  kappa pondere quadratique (QWK)  {qwk:0.00}   (reperes publies : 0,3 sans exemples, ~0,8 avec etalons)\n");
        sb.Append($"  accord exact sur le niveau       {exact:P0}\n");
        sb.Append($"  accord a un niveau pres          {adjacent:P0}\n");
        sb.Append($"  biais moyen                      {bias:+0.00;-0.00} niveau ({(bias > 0.25 ? "trop indulgent" : bias < -0.25 ? "trop severe" : "pas de biais net")})\n");
        sb.Append($"  ecart absolu moyen               {mae:0.00} niveau ; correlation {pearson:0.00}\n");

        sb.Append("\nMatrice (lignes : niveau humain ; colonnes : niveau du correcteur)\n       ");
        foreach (var l in LearningAnchors.Levels)
        {
            sb.Append(l.PadLeft(5));
        }

        sb.Append('\n');
        for (var g = 0; g < 6; g++)
        {
            if (!gold.Contains(g))
            {
                continue;
            }

            sb.Append("  ").Append(LearningAnchors.Levels[g].PadRight(5));
            for (var p = 0; p < 6; p++)
            {
                sb.Append(gold.Zip(pred).Count(x => x.First == g && x.Second == p).ToString(CultureInfo.InvariantCulture).PadLeft(5));
            }

            sb.Append('\n');
        }

        double? retestQwk = null;
        double? retestExact = null;
        if (runs >= 2)
        {
            var pairs = ok.Where(r => r.Pass == 0)
                .Select(a => (A: a, B: ok.FirstOrDefault(b => b.Pass == 1 && b.Sample.Id == a.Sample.Id)))
                .Where(x => x.B is not null)
                .ToList();
            if (pairs.Count > 0)
            {
                retestQwk = Qwk(pairs.Select(x => Band(x.A.Level)).ToArray(), pairs.Select(x => Band(x.B!.Level)).ToArray(), 6);
                retestExact = pairs.Count(x => Band(x.A.Level) == Band(x.B!.Level)) / (double)pairs.Count;
                var diff = pairs.Average(x => Math.Abs(x.A.Level - x.B!.Level));
                sb.Append($"\nFidelite d'un passage a l'autre ({pairs.Count} paires) : meme niveau {retestExact:P0}, QWK {retestQwk:0.00}, ecart moyen {diff:0.00} niveau.\n");
            }
        }

        var withSw = first.Where(r => r.Sample.Scale > 0 && !double.IsNaN(r.SwScore)).ToList();
        if (withSw.Count > 0)
        {
            var swBias = withSw.Average(r => r.SwScore - r.Sample.SwScore);
            var swExact = withSw.Count(r => Math.Abs(r.SwScore - r.Sample.SwScore) < 0.75) / (double)withSw.Count;
            sb.Append($"\nNotes de tache S&W ({withSw.Count}) : meme note {swExact:P0}, biais {swBias:+0.00;-0.00} point.\n");
            json["swExact"] = Math.Round(swExact, 3);
            json["swBias"] = Math.Round(swBias, 3);
        }

        var failed = results.Count(r => double.IsNaN(r.Level));
        sb.Append($"\nCout au tarif public : {cost:0.00} $ ; {failed} echec(s).");
        sb.Append("\nAjuster la grille sur les desaccords (les lignes ecartees de la diagonale), puis relancer : c'est ainsi que la grille s'ameliore (Harada et al. 2025).");

        json["samples"] = first.Count;
        json["qwk"] = Math.Round(qwk, 3);
        json["exact"] = Math.Round(exact, 3);
        json["adjacent"] = Math.Round(adjacent, 3);
        json["bias"] = Math.Round(bias, 3);
        json["mae"] = Math.Round(mae, 3);
        json["pearson"] = Math.Round(pearson, 3);
        json["retestQwk"] = retestQwk is null ? null : Math.Round(retestQwk.Value, 3);
        json["retestExact"] = retestExact is null ? null : Math.Round(retestExact.Value, 3);
        json["cost"] = Math.Round(cost, 3);
        json["results"] = new JsonArray(results.OrderBy(r => r.Sample.Id, StringComparer.Ordinal).ThenBy(r => r.Pass).Select(r => (JsonNode)new JsonObject
        {
            ["id"] = r.Sample.Id,
            ["pass"] = r.Pass,
            ["gold"] = r.Sample.Level,
            ["level"] = double.IsNaN(r.Level) ? null : Math.Round(r.Level, 2),
            ["band"] = double.IsNaN(r.Level) ? null : LearningAnchors.Levels[Band(r.Level)],
            ["swGold"] = r.Sample.Scale > 0 ? r.Sample.SwScore : null,
            ["sw"] = r.Sample.Scale > 0 && !double.IsNaN(r.SwScore) ? r.SwScore : null,
            ["error"] = r.Error.Length > 0 ? r.Error : null,
        }).ToArray());
        return new Summary(sb.ToString(), json);
    }

    /// <summary>Kappa pondere quadratique entre deux notations sur <paramref name="k"/> categories.</summary>
    public static double Qwk(int[] a, int[] b, int k)
    {
        var n = a.Length;
        if (n == 0)
        {
            return double.NaN;
        }

        var observed = new double[k, k];
        var ha = new double[k];
        var hb = new double[k];
        for (var i = 0; i < n; i++)
        {
            observed[a[i], b[i]]++;
            ha[a[i]]++;
            hb[b[i]]++;
        }

        double num = 0, den = 0;
        for (var i = 0; i < k; i++)
        {
            for (var j = 0; j < k; j++)
            {
                var w = (i - j) * (i - j) / (double)((k - 1) * (k - 1));
                num += w * observed[i, j];
                den += w * ha[i] * hb[j] / n;
            }
        }

        return den == 0 ? 1 : 1 - num / den;
    }

    private static double Pearson(double[] x, double[] y)
    {
        if (x.Length < 2)
        {
            return double.NaN;
        }

        double mx = x.Average(), my = y.Average(), sxy = 0, sxx = 0, syy = 0;
        for (var i = 0; i < x.Length; i++)
        {
            sxy += (x[i] - mx) * (y[i] - my);
            sxx += (x[i] - mx) * (x[i] - mx);
            syy += (y[i] - my) * (y[i] - my);
        }

        return sxx == 0 || syy == 0 ? double.NaN : sxy / Math.Sqrt(sxx * syy);
    }

    private static int Words(string text) => text.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries).Length;

    private static int IntOption(string[] args, string name, int fallback)
    {
        var i = Array.IndexOf(args, name);
        return i >= 0 && i + 1 < args.Length && int.TryParse(args[i + 1], NumberStyles.Integer, CultureInfo.InvariantCulture, out var v) ? v : fallback;
    }

    private static string StrOption(string[] args, string name, string fallback)
    {
        var i = Array.IndexOf(args, name);
        return i >= 0 && i + 1 < args.Length ? args[i + 1] : fallback;
    }
}
