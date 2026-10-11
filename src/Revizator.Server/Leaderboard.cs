using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using Organizator.Services;

namespace Revizator.Server;

/// <summary>
/// Le classement entre les comptes du serveur (<c>learnBoard</c>). Lu dans le <c>learning.json</c> de chaque
/// espace, il n'en sort que des agregats par semaine — minutes, jours actifs, seances, cartes revisees,
/// points, niveau estime — et les scores des bilans express : jamais une carte, un texte, une erreur ou un
/// enregistrement. Un compte qui s'est retire du classement (<c>profile.boardHidden</c>) n'apparait pas aux
/// autres. Les points se calculent ici, de la meme facon pour tous :
/// <list type="bullet">
/// <item><description>1 point par minute de travail, 90 au plus par jour ;</description></item>
/// <item><description>10 points par jour actif (5 minutes ou plus ce jour-la) ;</description></item>
/// <item><description>5 points par seance de l'objectif hebdomadaire, quand il est atteint (seances de 5 minutes ou plus).</description></item>
/// </list>
/// Les semaines commencent le lundi a 0 h, heure du serveur (<c>TZ</c>).
/// </summary>
public sealed class Leaderboard
{
    public const int MaxWeeks = 26;
    public const int DailyCap = 90;
    public const int DayPoints = 10;
    public const int GoalPoints = 5;
    public const int MaxName = 24;

    private static readonly string[] Skills = ["read", "listen", "write", "speak", "lang"];

    private static readonly JsonDocumentOptions ReadOptions = new()
    {
        AllowTrailingCommas = true,
        CommentHandling = JsonCommentHandling.Skip,
    };

    private readonly string _dataDir;
    private readonly Func<IReadOnlyList<UserAccount>> _accounts;
    private readonly HostLog _log;
    private readonly object _gate = new();
    private readonly Dictionary<string, (DateTime Stamp, long Size, Extract? Data)> _cache = new(StringComparer.Ordinal);

    public Leaderboard(string dataDir, Func<IReadOnlyList<UserAccount>> accounts, HostLog log)
    {
        _dataDir = dataDir;
        _accounts = accounts;
        _log = log;
    }

    /// <summary>Ce qui sert au classement dans un <c>learning.json</c>.</summary>
    private sealed record Extract(
        long CreatedAt,
        string Name,
        bool Hidden,
        int WeeklyGoal,
        double StartTheta,
        IReadOnlyList<(long At, double Minutes)> Sessions,
        IReadOnlyList<long> Reviews,
        IReadOnlyDictionary<string, (double Theta, IReadOnlyList<(string Day, double Theta)> Hist)> Levels,
        IReadOnlyList<(long At, int Score)> Toeic);

    /// <summary>
    /// <c>{ now, me, weeks: [debut de semaine, ms…], players: [{ name, me, hidden, since, theta, totalMinutes,
    /// weeks: [{ points, minutes, days, sessions, goal, cards, theta }], toeic: [{ at, score }] }] }</c>, les
    /// semaines de la plus ancienne a la courante.
    /// </summary>
    public JsonObject Build(string me, int weeks)
    {
        weeks = Math.Clamp(weeks, 1, MaxWeeks);
        var now = DateTimeOffset.Now;
        var starts = new long[weeks];
        var current = WeekStart(now);
        for (var i = 0; i < weeks; i++)
        {
            starts[i] = current.AddDays(-7 * (weeks - 1 - i)).ToUnixTimeMilliseconds();
        }

        var players = new JsonArray();
        foreach (var account in _accounts().OrderBy(a => a.Login, StringComparer.Ordinal))
        {
            var data = Read(account.Login);
            var isMe = account.Login == me;
            if (data is null || (data.Hidden && !isMe))
            {
                continue;
            }

            players.Add(Player(data, isMe, account.Login, starts, now.ToUnixTimeMilliseconds()));
        }

        return new JsonObject
        {
            ["now"] = now.ToUnixTimeMilliseconds(),
            ["me"] = me,
            ["weeks"] = new JsonArray(starts.Select(s => (JsonNode?)JsonValue.Create(s)).ToArray()),
            ["rules"] = new JsonObject
            {
                ["dailyCap"] = DailyCap,
                ["dayPoints"] = DayPoints,
                ["goalPoints"] = GoalPoints,
            },
            ["players"] = players,
        };
    }

    private static JsonObject Player(Extract data, bool me, string login, long[] starts, long now)
    {
        var weeks = new JsonArray();
        for (var i = 0; i < starts.Length; i++)
        {
            var from = starts[i];
            var to = i + 1 < starts.Length ? starts[i + 1] : DateTimeOffset.FromUnixTimeMilliseconds(from).AddDays(7).ToUnixTimeMilliseconds();
            weeks.Add(Week(data, from, to, now));
        }

        var since = data.CreatedAt;
        foreach (var (at, _) in data.Sessions)
        {
            since = Math.Min(since, at);
        }

        var player = new JsonObject
        {
            ["name"] = data.Name.Length > 0 ? data.Name : login,
            ["me"] = me,
            ["since"] = since,
            ["theta"] = Round(ThetaAt(data, DayKey(now), useCurrent: true)),
            ["totalMinutes"] = Math.Round(data.Sessions.Sum(s => s.Minutes)),
            ["weeks"] = weeks,
            ["toeic"] = new JsonArray(data.Toeic
                .Where(t => t.At >= starts[0] - 365L * 86_400_000)
                .Select(t => (JsonNode?)new JsonObject { ["at"] = t.At, ["score"] = t.Score }).ToArray()),
        };
        if (me)
        {
            player["hidden"] = data.Hidden;
        }

        return player;
    }

    private static JsonObject Week(Extract data, long from, long to, long now)
    {
        var byDay = new Dictionary<string, double>(StringComparer.Ordinal);
        var sessions = 0;
        var minutes = 0.0;
        foreach (var (at, min) in data.Sessions)
        {
            if (at < from || at >= to)
            {
                continue;
            }

            minutes += min;
            var day = DayKey(at);
            byDay[day] = byDay.GetValueOrDefault(day) + min;
            if (min >= 5)
            {
                sessions++;
            }
        }

        var days = byDay.Values.Count(m => m >= 5);
        var capped = byDay.Values.Sum(m => Math.Min(m, DailyCap));
        var reached = sessions >= data.WeeklyGoal;
        var points = (int)Math.Round(capped) + DayPoints * days + (reached ? GoalPoints * data.WeeklyGoal : 0);
        var end = Math.Min(to, now) - 1;
        return new JsonObject
        {
            ["points"] = points,
            ["minutes"] = Math.Round(minutes),
            ["days"] = days,
            ["sessions"] = sessions,
            ["goal"] = data.WeeklyGoal,
            ["cards"] = data.Reviews.Count(at => at >= from && at < to),
            // Une semaine a venir n'a pas de niveau ; une semaine passee, celui de son dernier jour.
            ["theta"] = from > now ? null : Round(ThetaAt(data, DayKey(end), useCurrent: to > now)),
        };
    }

    /// <summary>
    /// Niveau global estime a la fin du jour <paramref name="day"/> (<c>aaaa-mm-jj</c>), meme moyenne que
    /// <c>R.globalTheta</c> (langue comptee pour moitie) : par competence, la derniere valeur de son historique
    /// a cette date, sinon le niveau de depart.
    /// </summary>
    private static double ThetaAt(Extract data, string day, bool useCurrent)
    {
        double sum = 0, weight = 0;
        foreach (var id in Skills)
        {
            var w = id == "lang" ? 0.5 : 1;
            var theta = data.StartTheta;
            if (data.Levels.TryGetValue(id, out var level))
            {
                if (useCurrent)
                {
                    theta = level.Theta;
                }
                else
                {
                    foreach (var (d, t) in level.Hist)
                    {
                        if (string.CompareOrdinal(d, day) <= 0)
                        {
                            theta = t;
                        }
                    }
                }
            }

            sum += theta * w;
            weight += w;
        }

        return sum / weight;
    }

    private static double Round(double v) => Math.Round(v, 2);

    private static DateTimeOffset WeekStart(DateTimeOffset at)
    {
        var local = at.ToLocalTime();
        var monday = local.Date.AddDays(-(((int)local.DayOfWeek + 6) % 7));
        return new DateTimeOffset(monday, TimeZoneInfo.Local.GetUtcOffset(monday));
    }

    private static string DayKey(long ms)
        => DateTimeOffset.FromUnixTimeMilliseconds(ms).ToLocalTime().ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

    // --------------------------------------------------------------- lecture

    /// <summary>Extrait du <c>learning.json</c> d'un compte (relu seulement s'il a change), null sans donnees.</summary>
    private Extract? Read(string login)
    {
        var path = Path.Combine(UserSpaces.DirOf(_dataDir, login), "learning.json");
        FileInfo info;
        try
        {
            info = new FileInfo(path);
            if (!info.Exists)
            {
                return null;
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return null;
        }

        lock (_gate)
        {
            if (_cache.TryGetValue(path, out var hit) && hit.Stamp == info.LastWriteTimeUtc && hit.Size == info.Length)
            {
                return hit.Data;
            }
        }

        Extract? data;
        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllBytes(path), ReadOptions);
            data = Parse(doc.RootElement);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        {
            // Fichier en cours de remplacement ou abime : le classement se passe de ce compte cette fois.
            _log.Warn($"Classement : learning.json de « {login} » illisible : {ex.Message}");
            lock (_gate)
            {
                return _cache.TryGetValue(path, out var old) ? old.Data : null;
            }
        }

        lock (_gate)
        {
            _cache[path] = (info.LastWriteTimeUtc, info.Length, data);
        }

        return data;
    }

    private static Extract? Parse(JsonElement root)
    {
        if (!TryObject(root, "subjects", out var subjects) || !TryObject(subjects, "en", out var en))
        {
            return null;
        }

        TryObject(en, "profile", out var profile);
        var name = Clean(Text(profile, "boardName"));
        var hidden = profile.ValueKind == JsonValueKind.Object && profile.TryGetProperty("boardHidden", out var h) && h.ValueKind == JsonValueKind.True;
        var goal = (int)Math.Clamp(Math.Round(Number(profile, "weeklyGoal") ?? 4), 1, 7);
        var start = ThetaOf(Text(profile, "startLevel")) ?? 0;

        var sessions = new List<(long, double)>();
        foreach (var s in Items(en, "sessions"))
        {
            if (Number(s, "startedAt") is { } at && Number(s, "minutes") is { } min && min > 0)
            {
                sessions.Add(((long)at, Math.Min(min, 600)));
            }
        }

        var reviews = new List<long>();
        foreach (var r in Items(en, "reviewLog"))
        {
            if (Number(r, "at") is { } at)
            {
                reviews.Add((long)at);
            }
        }

        var levels = new Dictionary<string, (double, IReadOnlyList<(string, double)>)>(StringComparer.Ordinal);
        if (TryObject(en, "skills", out var skills))
        {
            foreach (var id in Skills)
            {
                if (!TryObject(skills, id, out var skill) || Number(skill, "theta") is not { } theta)
                {
                    continue;
                }

                var hist = new List<(string, double)>();
                foreach (var point in Items(skill, "hist"))
                {
                    if (point.ValueKind == JsonValueKind.Array && point.GetArrayLength() >= 2
                        && point[0].ValueKind == JsonValueKind.String && point[1].ValueKind == JsonValueKind.Number)
                    {
                        hist.Add((point[0].GetString()!, point[1].GetDouble()));
                    }
                }

                hist.Sort((a, b) => string.CompareOrdinal(a.Item1, b.Item1));
                levels[id] = (Math.Clamp(theta, -3, 3.5), hist);
            }
        }

        var toeic = new List<(long, int)>();
        if (TryObject(en, "toeic", out var t))
        {
            foreach (var entry in Items(t, "history"))
            {
                if (Text(entry, "kind") != "express" || Number(entry, "at") is not { } at || !TryObject(entry, "total", out var total)
                    || Number(total, "score") is not { } score)
                {
                    continue;
                }

                // La tendance (plusieurs bilans lisses) plutot que le bilan seul, quand elle existe.
                if (TryObject(entry, "trend", out var trend) && TryObject(trend, "T", out var tt) && Number(tt, "mean") is { } mean)
                {
                    score = mean;
                }

                toeic.Add(((long)at, (int)Math.Clamp(Math.Round(score), 0, 990)));
            }
        }

        toeic.Sort((a, b) => a.Item1.CompareTo(b.Item1));
        return new Extract((long)(Number(en, "createdAt") ?? 0), name, hidden, goal, start, sessions, reviews, levels, toeic);
    }

    /// <summary>Pseudo du classement : une ligne, sans caracteres de controle, 24 caracteres au plus.</summary>
    public static string Clean(string? name)
    {
        var text = new string((name ?? "").Where(c => !char.IsControl(c)).ToArray()).Trim();
        return text.Length <= MaxName ? text : text[..MaxName].TrimEnd();
    }

    private static double? ThetaOf(string? level)
    {
        var text = (level ?? "").Trim().ToUpperInvariant();
        string[] levels = ["A1", "A2", "B1", "B2", "C1", "C2"];
        var i = Array.FindIndex(levels, l => text.StartsWith(l, StringComparison.Ordinal));
        return i < 0 ? null : i - 2 + (text.Length > 2 && text[2..].TrimStart().StartsWith('+') ? 0.35 : 0);
    }

    private static bool TryObject(JsonElement element, string name, out JsonElement value)
    {
        value = default;
        return element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out value) && value.ValueKind == JsonValueKind.Object;
    }

    private static IEnumerable<JsonElement> Items(JsonElement element, string name)
        => element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Array
            ? value.EnumerateArray()
            : [];

    private static double? Number(JsonElement element, string name)
        => element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Number
            && value.TryGetDouble(out var number) && double.IsFinite(number) ? number : null;

    private static string? Text(JsonElement element, string name)
        => element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;
}
