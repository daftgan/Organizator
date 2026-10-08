using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Organizator.Services;

/// <summary>
/// Un fil d'articles quotidiens. L'article du jour eclaire ce sur quoi l'utilisateur travaille ;
/// la veille IA raconte ce qui vient de se passer dans l'IA, vu par un developpeur qui travaille
/// avec des agents, sans regarder sa file. Meme agent, meme fiche, meme historique : changent les
/// consignes, ce que le prompt dit de l'utilisateur et le fichier ou la fiche est gardee.
/// </summary>
/// <param name="Id">Identifiant envoye par l'UI (<c>kind</c> de <c>getArticle</c>).</param>
/// <param name="Subject">Le fil dans une phrase : « l'article du jour », « la veille IA ».</param>
/// <param name="Brief">Ce que l'agent sait de l'utilisateur, a partir des centres d'interet recus de l'UI.</param>
/// <param name="Covered">Introduit les sujets des derniers articles, pour varier.</param>
/// <param name="Ask">La demande qui clot le prompt.</param>
public sealed record ArticleFeed(
    string Id,
    string FileName,
    string Name,
    string Subject,
    string Instructions,
    string Schema,
    Func<string, string> Brief,
    string Covered,
    int CoveredMax,
    string Ask)
{
    public static readonly ArticleFeed Daily = new(
        "daily",
        "article.json",
        "Article du jour",
        "l'article du jour",
        "Tu fais la veille d'Organizator, la file de tâches de l'utilisateur : chaque jour, tu lui proposes UN article publié sur le web qui peut l'intéresser au vu de ses sujets du moment, avec un résumé.\n"
        + "Méthode : cherche avec WebSearch, puis ouvre l'article retenu avec WebFetch et lis-le vraiment — ne résume jamais un article que tu n'as pas lu ; s'il est inaccessible (paywall, erreur), prends-en un autre.\n"
        + "Ce qu'on attend : un article de fond — blog technique reconnu, documentation ou blog d'éditeur, revue, presse spécialisée —, de préférence publié dans les douze derniers mois, en français ou en anglais. Pas de page d'accueil, de liste de liens, de page de produit, de communiqué commercial, de vidéo ni de fil de forum.\n"
        + "Il doit apprendre quelque chose d'utile pour ce que l'utilisateur fait, pas répéter ce qu'il sait déjà : vise l'éclairage, la méthode, le retour d'expérience. Les sujets que l'utilisateur a fixés lui-même passent avant ceux que l'on devine dans sa file.\n"
        + "Ne propose jamais un article déjà proposé (la liste est fournie) et varie les sujets d'un jour à l'autre.\n"
        + "Réponds uniquement par la fiche demandée, en français, en vouvoyant l'utilisateur — seul le titre reste dans la langue de l'article.",
        SchemaFor(
            "Le sujet de l'utilisateur que l'article éclaire, en quelques mots",
            "Pourquoi cet article pour l'utilisateur, une phrase qui le relie à ce qu'il fait",
            "\"title\",\"url\",\"source\",\"summary\",\"keyPoints\",\"why\",\"topic\""),
        interests => interests.Length > 0
            ? interests
            : "Aucun centre d'intérêt connu : choisis un article de fond sur le développement logiciel.",
        "Sujets des derniers jours, à varier : ",
        5,
        "Choisis un sujet porteur dans tout cela, trouve un article qui l'éclaire, lis-le, et rends la fiche.");

    // Pas de centres d'interet : l'actualite de l'IA, vue par un developpeur, quelle que soit sa file.
    // La fenetre de fraicheur est dans le prompt, en dates : l'agent n'a pas a deviner le jour.
    public static readonly ArticleFeed Ai = new(
        "ai",
        "article-ai.json",
        "Veille IA",
        "la veille IA",
        "Tu fais la veille IA d'Organizator, la file de tâches d'un développeur qui travaille au quotidien avec des agents de code (Claude Code, GitHub Copilot) : chaque jour, tu lui proposes UN article publié sur le web sur ce qui vient de se passer dans le monde de l'IA, avec un résumé.\n"
        + "Méthode : cherche avec WebSearch ce qui a marqué l'IA ces derniers jours, retiens le fait le plus utile à connaître pour lui, puis ouvre l'article retenu avec WebFetch et lis-le vraiment — ne résume jamais un article que tu n'as pas lu ; s'il est inaccessible (paywall, erreur), prends-en un autre.\n"
        + "Fraîcheur : l'article doit être récent — publié dans les sept derniers jours de préférence, quatorze au plus (les dates sont fournies). Vérifie sa date de publication ; un article plus ancien, même excellent, ne convient pas.\n"
        + "Ce qu'on attend : sorties et mises à jour de modèles, agents de code et outils pour développeurs, nouvelles pratiques, recherche marquante, mouvements importants du secteur — toujours sous l'angle de ce que cela change pour un développeur. Sources : annonce ou blog d'un laboratoire ou d'un éditeur, presse technique sérieuse, blog reconnu d'un praticien, en français ou en anglais. Pas de page d'accueil, de liste de liens, d'agrégateur, de vidéo, de fil de forum, de billet promotionnel ni de rumeur sans source.\n"
        + "Ne propose jamais un article déjà proposé, ni un autre article sur un fait déjà couvert (les listes sont fournies), et varie les thèmes d'un jour à l'autre : modèles, outils, recherche, pratiques, secteur.\n"
        + "Réponds uniquement par la fiche demandée, en français, en vouvoyant l'utilisateur — seul le titre reste dans la langue de l'article.",
        SchemaFor(
            "Le fait marquant de l'IA dont parle l'article, en quelques mots (ex. sortie d'un modèle, nouvel outil d'agent)",
            "Ce que cela change pour l'utilisateur, développeur qui travaille avec des agents de code, en une phrase",
            "\"title\",\"url\",\"source\",\"published\",\"summary\",\"keyPoints\",\"why\",\"topic\""),
        _ =>
        {
            var fr = CultureInfo.GetCultureInfo("fr-FR");
            var now = DateTime.Now;
            return "Fraîcheur : un article publié depuis le " + now.AddDays(-7).ToString("dddd d MMMM", fr)
                + " de préférence, et en aucun cas avant le " + now.AddDays(-14).ToString("dddd d MMMM yyyy", fr) + ".";
        },
        "Faits déjà couverts, à ne pas reprendre — et thèmes à varier : ",
        10,
        "Cherche ce qui a marqué l'IA ces derniers jours, retiens le fait le plus utile à connaître pour lui, lis un article récent qui le raconte, et rends la fiche.");

    public static IReadOnlyList<ArticleFeed> All { get; } = [Daily, Ai];

    // La fiche est la meme pour les deux fils : seuls le sens de « topic » et de « why », et
    // l'exigence d'une date de publication, changent.
    private static string SchemaFor(string topic, string why, string required) => """
        {"type":"object","properties":{
        "title":{"type":"string","description":"Titre de l'article, dans sa langue d'origine"},
        "url":{"type":"string","description":"Adresse de l'article lu (https)"},
        "source":{"type":"string","description":"Site ou publication, ex. martinfowler.com"},
        "author":{"type":"string","description":"Auteur, vide si inconnu"},
        "published":{"type":"string","description":"Date de publication AAAA-MM-JJ, vide si inconnue"},
        "language":{"type":"string","description":"Langue de l'article : fr, en..."},
        "readingMinutes":{"type":"integer","description":"Temps de lecture estimé, en minutes"},
        "topic":{"type":"string","description":"@topic"},
        "summary":{"type":"string","description":"Résumé en français, 4 à 6 phrases"},
        "keyPoints":{"type":"array","items":{"type":"string"},"description":"Trois idées à retenir, une phrase chacune"},
        "why":{"type":"string","description":"@why"}},
        "required":[@required]}
        """.Replace("@topic", topic).Replace("@why", why).Replace("@required", required).Replace("\r", "").Replace("\n", "");
}

/// <summary>
/// Article quotidien d'un fil (<see cref="ArticleFeed"/>) : une fois par jour, Claude Code -- en
/// mode non interactif, avec ses seuls outils web (WebSearch, WebFetch) -- cherche un article, le
/// lit et le resume. La fiche est gardee dans le fichier du fil (<c>article.json</c>,
/// <c>article-ai.json</c>) avec les precedentes, qui servent a ne jamais reproposer le meme
/// article et a varier les sujets.
///
/// Les centres d'interet viennent de l'UI (sujets fixes dans les Reglages, taches en file,
/// conversations recentes) ; les consignes, le schema de la fiche et l'historique sont ici.
/// Comme pour la redaction assistee, <c>--no-session-persistence</c> evite de laisser une
/// conversation dans <c>~/.claude/projects</c>, et <c>--bare</c> est a proscrire.
/// </summary>
public sealed class DailyArticle
{
    // La recherche, la lecture de l'article et la fiche prennent 30 a 90 s ; l'UI attend 270 s.
    private static readonly TimeSpan Limit = TimeSpan.FromSeconds(240);
    private const int HistoryMax = 30;
    private const int InterestsMax = 6000;

    private static readonly JsonSerializerOptions FileJson = new() { WriteIndented = true };

    private readonly ArticleFeed _feed;
    private readonly AgentLauncher _launcher;
    private readonly HostLog _log;
    private readonly string _dir;
    private readonly string _path;
    private readonly object _gate = new();
    private Task<JsonObject>? _running;

    public DailyArticle(ArticleFeed feed, AgentLauncher launcher, HostLog log, string dataDir)
    {
        _feed = feed;
        _launcher = launcher;
        _log = log;
        _dir = dataDir;
        _path = Path.Combine(dataDir, feed.FileName);
    }

    /// <summary>Jour local de reference : un article par jour calendaire.</summary>
    public static string Today() => DateTime.Now.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

    /// <summary>Ce qui est garde, sans rien lancer ; <c>busy</c> dit si une recherche est en cours.</summary>
    public JsonObject Peek()
    {
        lock (_gate)
        {
            var store = Load();
            store["busy"] = _running is not null;
            return store;
        }
    }

    /// <summary>
    /// L'article du jour : celui qui est garde s'il date d'aujourd'hui, sauf <paramref name="another"/>,
    /// sinon un nouveau. Une seule recherche a la fois : une demande qui arrive pendant l'autre l'attend.
    /// </summary>
    public Task<JsonObject> GetAsync(bool another, string interests, string model, string effort)
    {
        lock (_gate)
        {
            if (_running is not null)
            {
                return _running;
            }

            if (!another)
            {
                var store = Load();
                if (store["current"] is JsonObject current && Str(current, "day") == Today())
                {
                    store["busy"] = false;
                    return Task.FromResult(store);
                }
            }

            var command = _launcher.CommandFor(AgentProvider.Claude)
                ?? throw new InvalidOperationException($"Claude Code est introuvable sur ce poste : {_feed.Subject} a besoin de sa recherche web.");

            var text = (interests ?? "").Trim();
            if (text.Length > InterestsMax)
            {
                text = text[..InterestsMax];
            }

            // Hors du fil de l'interface : Process.Start l'occuperait plusieurs centaines de millisecondes.
            var run = Task.Run(() => RunAsync(command, text, model, effort));
            _running = run;
            _ = run.ContinueWith(_ =>
            {
                lock (_gate)
                {
                    if (ReferenceEquals(_running, run))
                    {
                        _running = null;
                    }
                }
            }, TaskScheduler.Default);
            return run;
        }
    }

    /// <summary>L'utilisateur a ouvert l'article du jour : la carte de l'en-tete ne le signale plus comme neuf.</summary>
    public JsonObject MarkSeen(string? url)
    {
        lock (_gate)
        {
            var store = Load();
            if (store["current"] is JsonObject current && Str(current, "url") == (url ?? "") && Num(current, "seenAt") == 0)
            {
                current["seenAt"] = DateTimeOffset.Now.ToUnixTimeMilliseconds();
                Save(store);
            }

            store["busy"] = _running is not null;
            return store;
        }
    }

    private async Task<JsonObject> RunAsync(CommandLine command, string interests, string model, string effort)
    {
        JsonObject known;
        lock (_gate)
        {
            known = Load();
        }

        var info = new ProcessStartInfo
        {
            FileName = command.FileName,
            WorkingDirectory = _dir,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            RedirectStandardInput = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };

        foreach (var argument in command.Arguments)
        {
            info.ArgumentList.Add(argument);
        }

        info.ArgumentList.Add("-p");
        info.ArgumentList.Add(Prompt(_feed, known, interests));
        info.ArgumentList.Add("--no-session-persistence");
        // Le web, et rien d'autre : ni le disque, ni le shell.
        info.ArgumentList.Add("--tools");
        info.ArgumentList.Add("WebSearch,WebFetch");
        info.ArgumentList.Add("--allowedTools");
        info.ArgumentList.Add("WebSearch,WebFetch");
        info.ArgumentList.Add("--output-format");
        info.ArgumentList.Add("json");
        info.ArgumentList.Add("--json-schema");
        info.ArgumentList.Add(_feed.Schema);
        info.ArgumentList.Add("--append-system-prompt");
        info.ArgumentList.Add(_feed.Instructions);
        if (model.Length > 0)
        {
            info.ArgumentList.Add("--model");
            info.ArgumentList.Add(model);
        }

        if (effort.Length > 0)
        {
            info.ArgumentList.Add("--effort");
            info.ArgumentList.Add(effort);
        }

        var started = Stopwatch.StartNew();
        var (code, output, error) = await AgentDraft.RunAsync(info, Limit, _log, "de " + _feed.Subject).ConfigureAwait(false);
        started.Stop();

        JsonObject card;
        try
        {
            card = Parse(code, output, error, out var turns, out var cost);
            _log.Info($"{_feed.Name} : {Str(card, "source")} en {started.ElapsedMilliseconds} ms ({turns} tours, {cost.ToString("0.00", CultureInfo.InvariantCulture)} $ au tarif public).");
        }
        catch (InvalidOperationException ex)
        {
            _log.Warn($"{_feed.Name} : echec apres {started.ElapsedMilliseconds} ms : {ex.Message}");
            throw;
        }

        card["day"] = Today();
        card["fetchedAt"] = DateTimeOffset.Now.ToUnixTimeMilliseconds();
        card["model"] = model;
        card["ms"] = started.ElapsedMilliseconds;
        card["seenAt"] = 0;

        lock (_gate)
        {
            var store = Load();
            var history = store["history"] as JsonArray ?? new JsonArray();
            var list = new List<JsonNode>();
            if (store["current"] is JsonObject previous && Str(previous, "url").Length > 0)
            {
                list.Add(previous.DeepClone());
            }

            foreach (var item in history)
            {
                if (item is JsonObject old && Str(old, "url") != Str(card, "url"))
                {
                    list.Add(old.DeepClone());
                }
            }

            var trimmed = new JsonArray();
            foreach (var item in list.Where(i => Str((JsonObject)i, "url") != Str(card, "url")).Take(HistoryMax))
            {
                trimmed.Add(item);
            }

            store["current"] = card;
            store["history"] = trimmed;
            Save(store);

            var result = (JsonObject)store.DeepClone();
            result["busy"] = false;
            return result;
        }
    }

    /// <summary>
    /// Ce que l'agent recoit : la date, ce que le fil dit de l'utilisateur (ses centres d'interet,
    /// ou la fenetre de fraicheur de la veille IA), les articles deja proposes et les sujets des
    /// derniers jours, pour varier.
    /// </summary>
    private static string Prompt(ArticleFeed feed, JsonObject store, string interests)
    {
        var fr = CultureInfo.GetCultureInfo("fr-FR");
        var sb = new StringBuilder();
        sb.Append("Date du jour : ").Append(DateTime.Now.ToString("dddd d MMMM yyyy", fr)).Append(".\n\n");
        sb.Append(feed.Brief(interests));
        sb.Append("\n\n");

        var proposed = new List<JsonObject>();
        if (store["current"] is JsonObject current)
        {
            proposed.Add(current);
        }

        if (store["history"] is JsonArray history)
        {
            proposed.AddRange(history.OfType<JsonObject>());
        }

        if (proposed.Count == 0)
        {
            sb.Append("Articles déjà proposés : aucun.\n");
        }
        else
        {
            sb.Append("Articles déjà proposés (ne pas les reproposer) :\n");
            foreach (var item in proposed)
            {
                sb.Append("- ").Append(Str(item, "title")).Append(" — ").Append(Str(item, "url")).Append('\n');
            }

            var topics = proposed.Select(i => Str(i, "topic")).Where(t => t.Length > 0).Distinct().Take(feed.CoveredMax).ToList();
            if (topics.Count > 0)
            {
                sb.Append(feed.Covered).Append(string.Join(" ; ", topics)).Append('\n');
            }
        }

        sb.Append('\n').Append(feed.Ask);
        return sb.ToString();
    }

    /// <summary>
    /// Lit l'enveloppe de <c>--output-format json</c> : la fiche est dans <c>structured_output</c>
    /// (ou, a defaut, dans <c>result</c>) ; une erreur de l'agent devient un message lisible.
    /// </summary>
    private static JsonObject Parse(int code, string output, string error, out int turns, out double cost)
    {
        turns = 0;
        cost = 0;
        var text = AgentDraft.Clean(output);
        JsonObject? envelope = null;
        try
        {
            envelope = JsonNode.Parse(text) as JsonObject;
        }
        catch (JsonException)
        {
            // Sortie qui n'est pas l'enveloppe attendue : on explique avec ce qu'on a.
        }

        if (envelope is null)
        {
            throw new InvalidOperationException(AgentDraft.Explain(AgentProvider.Claude, code, (error + "\n" + text).Trim()));
        }

        turns = (int)Num(envelope, "num_turns");
        cost = envelope["total_cost_usd"] is JsonValue c && c.TryGetValue<double>(out var usd) ? usd : 0;

        var result = Str(envelope, "result");
        if (envelope["is_error"] is JsonValue flag && flag.TryGetValue<bool>(out var isError) && isError)
        {
            throw new InvalidOperationException(AgentDraft.Explain(AgentProvider.Claude, code, result.Length > 0 ? result : error));
        }

        var card = envelope["structured_output"] as JsonObject;
        if (card is null)
        {
            try
            {
                card = JsonNode.Parse(AgentDraft.Clean(result)) as JsonObject;
            }
            catch (JsonException)
            {
                card = null;
            }
        }

        if (card is null)
        {
            throw new InvalidOperationException("L'agent n'a pas rendu de fiche lisible.");
        }

        return Sanitize(card);
    }

    private static JsonObject Sanitize(JsonObject card)
    {
        var url = Str(card, "url");
        if (url.Length > 2000
            || !Uri.TryCreate(url, UriKind.Absolute, out var uri)
            || (uri.Scheme != Uri.UriSchemeHttps && uri.Scheme != Uri.UriSchemeHttp))
        {
            throw new InvalidOperationException("L'agent a rendu une adresse d'article invalide.");
        }

        var title = Clip(Str(card, "title"), 300);
        var summary = Clip(Str(card, "summary"), 3000);
        if (title.Length == 0 || summary.Length == 0)
        {
            throw new InvalidOperationException("L'agent a rendu une fiche sans titre ou sans resume.");
        }

        var points = new JsonArray();
        if (card["keyPoints"] is JsonArray list)
        {
            foreach (var item in list)
            {
                var point = item is JsonValue v && v.TryGetValue<string>(out var s) ? Clip(s, 500) : "";
                if (point.Length > 0 && points.Count < 5)
                {
                    points.Add(point);
                }
            }
        }

        var source = Clip(Str(card, "source"), 120);
        if (source.Length == 0)
        {
            source = uri.Host.StartsWith("www.", StringComparison.OrdinalIgnoreCase) ? uri.Host[4..] : uri.Host;
        }

        var minutes = (int)Math.Clamp(Num(card, "readingMinutes"), 0, 300);
        return new JsonObject
        {
            ["title"] = title,
            ["url"] = url,
            ["source"] = source,
            ["author"] = Clip(Str(card, "author"), 120),
            ["published"] = Clip(Str(card, "published"), 40),
            ["language"] = Clip(Str(card, "language"), 12),
            ["readingMinutes"] = minutes,
            ["topic"] = Clip(Str(card, "topic"), 160),
            ["summary"] = summary,
            ["keyPoints"] = points,
            ["why"] = Clip(Str(card, "why"), 800),
        };
    }

    private JsonObject Load()
    {
        try
        {
            if (File.Exists(_path) && JsonNode.Parse(File.ReadAllText(_path, Encoding.UTF8)) is JsonObject store)
            {
                if (store["current"] is not JsonObject)
                {
                    store["current"] = null;
                }

                if (store["history"] is not JsonArray)
                {
                    store["history"] = new JsonArray();
                }

                store.Remove("busy");
                return store;
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        {
            _log.Warn($"{_feed.FileName} illisible, ignore : " + ex.Message);
        }

        return new JsonObject { ["version"] = 1, ["current"] = null, ["history"] = new JsonArray() };
    }

    private void Save(JsonObject store)
    {
        try
        {
            var copy = (JsonObject)store.DeepClone();
            copy.Remove("busy");
            Directory.CreateDirectory(_dir);
            var tmp = _path + ".tmp";
            File.WriteAllText(tmp, copy.ToJsonString(FileJson), new UTF8Encoding(false));
            File.Move(tmp, _path, overwrite: true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            _log.Warn($"Ecriture de {_feed.FileName} impossible : " + ex.Message);
        }
    }

    private static string Str(JsonObject obj, string key)
        => obj[key] is JsonValue v && v.TryGetValue<string>(out var s) ? s.Trim() : "";

    private static double Num(JsonObject obj, string key)
    {
        if (obj[key] is not JsonValue v)
        {
            return 0;
        }

        if (v.TryGetValue<double>(out var d))
        {
            return double.IsFinite(d) ? d : 0;
        }

        return v.TryGetValue<string>(out var s) && double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out var p) ? p : 0;
    }

    private static string Clip(string value, int max)
    {
        var text = (value ?? "").Trim();
        return text.Length <= max ? text : text[..max].TrimEnd() + "…";
    }
}
