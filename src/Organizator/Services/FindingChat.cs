using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Organizator.Services;

/// <summary>Une question posee sur un constat de revue, et de quoi la situer.</summary>
public sealed record FindingQuestion(
    string Report,
    string Finding,
    string FindingId,
    int Order,
    string Title,
    string Severity,
    string Where,
    string Category,
    string SourceSessionId,
    string Cwd,
    string Model,
    string Effort,
    string Context,
    string Question);

/// <summary>
/// Discussion sur un constat d'une revue de code. La premiere question part dans une copie de la
/// session qui a ecrit le rapport (<c>claude -p --resume &lt;relecteur&gt; --fork-session</c>) : l'agent
/// a deja lu le ticket, le diff et le code, et la session d'origine n'est pas touchee. Les questions
/// suivantes reprennent cette copie (<c>--resume &lt;copie&gt;</c>). Sans session Claude a copier
/// (rapport ecrit par Copilot, session disparue), un agent neuf lit le rapport et le code.
///
/// L'agent est en lecture seule : outils <c>Read</c>, <c>Grep</c>, <c>Glob</c> et <c>Bash</c>, mode
/// <c>dontAsk</c> (seules les lectures et les commandes que Claude Code sait inoffensives passent,
/// une ecriture est refusee), aucun serveur MCP (<c>--strict-mcp-config</c> : demarrage rapide, rien
/// a poster). Le constat et les regles de la discussion vont dans le premier message, pas dans le
/// prompt systeme : celui d'une session reprise est fige, et toutes les copies d'une meme revue
/// partagent ainsi le meme prefixe, que le cache de l'API ne facture qu'une fois.
///
/// La reponse arrive au fil de l'eau (<c>--output-format stream-json --include-partial-messages</c>) :
/// <see cref="Progress"/> pousse le texte en cours et les lectures de l'agent. Les discussions sont
/// gardees dans <c>finding-chats.json</c>, une par constat (rapport + cle du constat).
/// </summary>
public sealed class FindingChat
{
    // Une copie d'une grosse revue, a l'effort maximal, met une a trois minutes ; au-dela, on abandonne.
    private static readonly TimeSpan Limit = TimeSpan.FromMinutes(10);
    private static readonly long ProgressEveryMs = 300;
    private const int MaxRunning = 3;
    private const int MaxChats = 300;
    private const int MaxTurns = 60;
    private const int MaxQuestion = 4000;
    private const int MaxAnswer = 40000;
    private const int MaxSource = 8000;
    private const int MaxContext = 3000;
    private const int MaxSteps = 14;

    // Lecture seule : les lectures sont autorisees d'office, une commande shell passe si Claude Code
    // la juge inoffensive (git log, git diff…), tout le reste est refuse sans question (dontAsk).
    private const string Tools = "Read,Grep,Glob,Bash";
    private const string Allowed = "Read,Grep,Glob";

    private static readonly JsonSerializerOptions FileJson = new() { WriteIndented = true };

    private readonly AgentLauncher _launcher;
    private readonly ClaudeSessions _claude;
    private readonly HostLog _log;
    private readonly string _path;
    private readonly object _gate = new();
    private readonly Dictionary<string, Run> _running = new(StringComparer.OrdinalIgnoreCase);
    private JsonObject? _store;

    public FindingChat(AgentLauncher launcher, ClaudeSessions claude, HostLog log, string dataDir)
    {
        _launcher = launcher;
        _claude = claude;
        _log = log;
        _path = Path.Combine(dataDir, "finding-chats.json");
    }

    /// <summary>
    /// Une reponse avance, ou vient d'arriver : <c>{ report, finding, phase, q, text, html, steps, startedAt }</c>,
    /// <c>phase</c> valant <c>thinking</c>, <c>tool</c>, <c>writing</c> ou <c>done</c>. Leve hors du fil de l'interface.
    /// </summary>
    public event Action<JsonObject>? Progress;

    /// <summary>Discussions d'un rapport, et les reponses en cours.</summary>
    public JsonObject List(string report)
    {
        var full = Normalize(report);
        var chats = new JsonArray();
        var running = new JsonArray();
        lock (_gate)
        {
            foreach (var chat in Chats().OfType<JsonObject>())
            {
                if (string.Equals(Str(chat, "report"), full, StringComparison.OrdinalIgnoreCase))
                {
                    chats.Add(ToView(chat));
                }
            }

            foreach (var run in _running.Values)
            {
                if (string.Equals(run.Report, full, StringComparison.OrdinalIgnoreCase))
                {
                    running.Add(run.Snapshot("running"));
                }
            }
        }

        return new JsonObject { ["report"] = full, ["chats"] = chats, ["running"] = running };
    }

    /// <summary>Arrete la reponse en cours sur ce constat ; faux s'il n'y en a pas.</summary>
    public bool Stop(string report, string finding)
    {
        Run? run;
        lock (_gate)
        {
            _running.TryGetValue(Key(Normalize(report), finding), out run);
        }

        if (run is null)
        {
            return false;
        }

        run.Stopped = true;
        Kill(run.Process);
        return true;
    }

    /// <summary>Oublie la discussion d'un constat (la session copiee reste sur le disque, comme toute session).</summary>
    public bool Forget(string report, string finding)
    {
        var full = Normalize(report);
        lock (_gate)
        {
            if (_running.ContainsKey(Key(full, finding)))
            {
                throw new InvalidOperationException("Une reponse est en cours sur ce constat : arretez-la d'abord.");
            }

            var chats = Chats();
            var chat = Find(chats, full, finding);
            if (chat is null)
            {
                return false;
            }

            chats.Remove(chat);
            Save();
            return true;
        }
    }

    /// <summary>
    /// Pose une question et attend la reponse. Une reponse en echec est gardee elle aussi, avec son
    /// erreur : la discussion rendue la montre, et la question peut repartir.
    /// </summary>
    public Task<JsonObject> AskAsync(FindingQuestion ask)
    {
        var report = Normalize(ask.Report);
        var question = Clip(ask.Question, MaxQuestion);
        if (question.Length == 0)
        {
            throw new InvalidOperationException("La question est vide.");
        }

        if (string.IsNullOrWhiteSpace(ask.Finding))
        {
            throw new InvalidOperationException("Constat inconnu.");
        }

        var command = _launcher.CommandFor(AgentProvider.Claude)
            ?? throw new InvalidOperationException("Claude Code est introuvable sur ce poste : la discussion sur un constat passe par lui.");

        var key = Key(report, ask.Finding);
        Run run;
        lock (_gate)
        {
            if (_running.ContainsKey(key))
            {
                throw new InvalidOperationException("L'agent repond deja sur ce constat : attendez sa reponse ou arretez-la.");
            }

            if (_running.Count >= MaxRunning)
            {
                throw new InvalidOperationException($"{MaxRunning} reponses sont deja en cours : attendez que l'une arrive.");
            }

            run = new Run(report, ask.Finding, question);
            _running[key] = run;
        }

        // Hors du fil de l'interface : Process.Start l'occuperait plusieurs centaines de millisecondes.
        return Task.Run(async () =>
        {
            try
            {
                return await AnswerAsync(command, ask with { Report = report, Question = question }, run).ConfigureAwait(false);
            }
            finally
            {
                lock (_gate)
                {
                    _running.Remove(key);
                }

                Emit(run.Snapshot("done"));
            }
        });
    }

    private async Task<JsonObject> AnswerAsync(CommandLine command, FindingQuestion ask, Run run)
    {
        string sessionId, cwd;
        bool fresh;
        lock (_gate)
        {
            var chat = Find(Chats(), ask.Report, ask.Finding);
            sessionId = chat is null ? "" : Str(chat, "sessionId");
            cwd = chat is null || sessionId.Length == 0 ? "" : Str(chat, "cwd");
            fresh = sessionId.Length == 0;
        }

        // Premiere question (ou premiere reussie) : copie de la session du relecteur, sinon agent neuf.
        var source = "";
        if (fresh)
        {
            cwd = (ask.Cwd ?? "").Trim();
            if (ask.SourceSessionId.Length > 0 && cwd.Length > 0
                && File.Exists(_claude.GetSessionFilePath(ask.SourceSessionId, cwd)))
            {
                source = ask.SourceSessionId;
            }
            else if (ask.SourceSessionId.Length > 0)
            {
                _log.Warn($"Discussion sur {ask.FindingId} : session du relecteur introuvable ({ask.SourceSessionId}), agent neuf.");
            }

            if (cwd.Length == 0 || !Directory.Exists(cwd))
            {
                cwd = Path.GetDirectoryName(ask.Report) ?? "";
            }
        }

        if (cwd.Length == 0 || !Directory.Exists(cwd))
        {
            throw new InvalidOperationException("Dossier de travail introuvable : " + cwd);
        }

        var newId = fresh ? Guid.NewGuid().ToString("D") : "";
        var prompt = fresh ? Opening(ask, source.Length > 0) : ask.Question;
        var info = Build(command, cwd, prompt, source, newId, sessionId, ask);
        run.Cwd = cwd;

        var started = Stopwatch.StartNew();
        var outcome = await RunAsync(info, run).ConfigureAwait(false);
        started.Stop();

        var answer = Clip(outcome.Answer, MaxAnswer);
        var turn = new JsonObject
        {
            ["q"] = ask.Question,
            ["a"] = answer.Length > 0 ? answer : Clip(run.Spoken(), MaxAnswer),
            ["at"] = DateTimeOffset.Now.ToUnixTimeMilliseconds(),
            ["ms"] = started.ElapsedMilliseconds,
            ["cost"] = Math.Round(outcome.Cost, 4),
            ["error"] = outcome.Error,
        };

        lock (_gate)
        {
            var chats = Chats();
            var chat = Find(chats, ask.Report, ask.Finding);
            if (chat is null)
            {
                chat = new JsonObject
                {
                    ["report"] = ask.Report,
                    ["finding"] = ask.Finding,
                    ["created"] = DateTimeOffset.Now.ToUnixTimeMilliseconds(),
                    ["turns"] = new JsonArray(),
                };
                chats.Add(chat);
            }

            chat["findingId"] = ask.FindingId;
            chat["title"] = Clip(ask.Title, 300);
            chat["severity"] = ask.Severity;
            chat["model"] = ask.Model;
            chat["effort"] = ask.Effort;
            chat["updated"] = DateTimeOffset.Now.ToUnixTimeMilliseconds();

            // La copie n'est retenue qu'une fois une reponse rendue : apres un echec, la question
            // suivante repart d'une copie neuve, avec le constat en tete.
            if (fresh && outcome.Error.Length == 0)
            {
                chat["sessionId"] = outcome.SessionId.Length > 0 ? outcome.SessionId : newId;
                chat["cwd"] = cwd;
                chat["source"] = source;
            }

            var turns = chat["turns"] as JsonArray ?? new JsonArray();
            chat["turns"] = turns;
            turns.Add(turn);
            while (turns.Count > MaxTurns)
            {
                turns.RemoveAt(0);
            }

            Trim(chats);
            Save();

            var mode = fresh ? (source.Length > 0 ? "copie du relecteur" : "agent neuf") : "reprise";
            _log.Info($"Discussion sur {ask.FindingId} ({mode}) : {(outcome.Error.Length > 0 ? "echec, " + outcome.Error : answer.Length + " caracteres")}"
                + $" en {started.ElapsedMilliseconds} ms ({outcome.Turns} tours, {outcome.Cost.ToString("0.00", CultureInfo.InvariantCulture)} $ au tarif public).");
            return ToView(chat);
        }
    }

    /// <summary>
    /// Premier message de la discussion : le constat, son texte dans le rapport, les regles, puis la
    /// question. Une copie du relecteur connait deja la revue ; un agent neuf doit la lire.
    /// </summary>
    private static string Opening(FindingQuestion ask, bool forked)
    {
        var sb = new StringBuilder();
        if (forked)
        {
            sb.Append("Je relis ta revue de code et j'aimerais discuter d'un de ses constats avec toi.\n\n");
        }
        else
        {
            sb.Append("Un agent de relecture a écrit un rapport de revue de code, et j'aimerais discuter d'un de ses constats avec toi. ")
              .Append("Tu n'as pas écrit ce rapport : lis-le (au moins ce constat, le verdict et ce qu'il dit du ticket et des PRs relues), ")
              .Append("puis le code concerné, avant de répondre.\n\n");
        }

        sb.Append("Rapport : ").Append(ask.Report).Append('\n');
        sb.Append("Constat ").Append(ask.FindingId.Length > 0 ? ask.FindingId + " " : "")
          .Append("— ").Append(SeverityLabel(ask.Severity)).Append(" : ").Append(ask.Title).Append('\n');
        if (ask.Category.Length > 0)
        {
            sb.Append("Catégorie : ").Append(ask.Category).Append('\n');
        }

        if (ask.Where.Length > 0)
        {
            sb.Append("Où : ").Append(ask.Where).Append('\n');
        }

        var source = Clip(ArtifactReader.FindingSource(ask.Report, ask.Order, ask.Title), MaxSource);
        if (source.Length > 0)
        {
            sb.Append("\nTexte du constat dans le rapport :\n\n").Append(source).Append('\n');
        }

        var context = Clip(ask.Context, MaxContext);
        if (!forked && context.Length > 0)
        {
            sb.Append("\nTâche d'où vient la revue :\n").Append(context).Append('\n');
        }

        sb.Append("\nPour cette discussion :\n")
          .Append("- Réponds à mes questions sur ce constat, en français, directement : quelques paragraphes au plus, une liste si elle aide, ")
          .Append("le code utile cité avec son fichier et sa ligne plutôt que recopié en entier.\n")
          .Append("- Tu es en lecture seule : relis le code, le diff ou l'historique git si une réponse le demande, mais ne modifie aucun fichier, ")
          .Append("ne réécris pas le rapport et ne poste rien sur les PRs ni dans Jira.\n")
          .Append("- Si mon objection est fondée, dis-le franchement : le constat peut être faux, surévalué ou sous-évalué. Dis aussi quand tu n'es pas sûr.\n")
          .Append("\nMa question :\n").Append(ask.Question);
        return sb.ToString();
    }

    private static string SeverityLabel(string severity) => severity switch
    {
        ReviewReport.Blocker => "bloquant",
        ReviewReport.Major => "majeur",
        ReviewReport.Minor => "mineur",
        ReviewReport.Info => "suggestion",
        _ => "constat",
    };

    private ProcessStartInfo Build(CommandLine command, string cwd, string prompt, string source, string newId, string sessionId, FindingQuestion ask)
    {
        var info = new ProcessStartInfo
        {
            FileName = command.FileName,
            WorkingDirectory = cwd,
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
        info.ArgumentList.Add(prompt);

        if (newId.Length > 0)
        {
            if (source.Length > 0)
            {
                info.ArgumentList.Add("--resume");
                info.ArgumentList.Add(source);
                info.ArgumentList.Add("--fork-session");
            }

            info.ArgumentList.Add("--session-id");
            info.ArgumentList.Add(newId);
            info.ArgumentList.Add("--name");
            info.ArgumentList.Add(Clip("Discussion · " + (ask.FindingId.Length > 0 ? ask.FindingId + " · " : "") + ask.Title, 80));
        }
        else
        {
            info.ArgumentList.Add("--resume");
            info.ArgumentList.Add(sessionId);
        }

        info.ArgumentList.Add("--output-format");
        info.ArgumentList.Add("stream-json");
        info.ArgumentList.Add("--verbose");
        info.ArgumentList.Add("--include-partial-messages");
        info.ArgumentList.Add("--tools");
        info.ArgumentList.Add(Tools);
        info.ArgumentList.Add("--allowedTools");
        info.ArgumentList.Add(Allowed);
        info.ArgumentList.Add("--permission-mode");
        info.ArgumentList.Add("dontAsk");
        info.ArgumentList.Add("--strict-mcp-config");

        if (ask.Model.Length > 0)
        {
            info.ArgumentList.Add("--model");
            info.ArgumentList.Add(ask.Model);
        }

        if (ask.Effort.Length > 0)
        {
            info.ArgumentList.Add("--effort");
            info.ArgumentList.Add(ask.Effort);
        }

        return info;
    }

    private sealed record Outcome(string Answer, string Error, string SessionId, double Cost, int Turns);

    /// <summary>Lance l'agent, suit son flux ligne a ligne, et rend la reponse finale ou l'erreur.</summary>
    private async Task<Outcome> RunAsync(ProcessStartInfo info, Run run)
    {
        using var process = new Process { StartInfo = info };
        try
        {
            process.Start();
        }
        catch (Exception ex)
        {
            return new Outcome("", "Lancement de l'agent impossible : " + ex.Message, "", 0, 0);
        }

        run.Process = process;
        process.StandardInput.Close();
        var error = process.StandardError.ReadToEndAsync();

        using var limit = new CancellationTokenSource(Limit);
        using var expire = limit.Token.Register(() => Kill(process));
        if (run.Stopped)
        {
            Kill(process);
        }

        string? line;
        while ((line = await process.StandardOutput.ReadLineAsync().ConfigureAwait(false)) is not null)
        {
            if (Feed(run, line))
            {
                Emit(run.Snapshot(run.Phase));
            }
        }

        await process.WaitForExitAsync().ConfigureAwait(false);
        var stderr = AgentDraft.Clean(await error.ConfigureAwait(false));

        if (run.Stopped)
        {
            return new Outcome("", "Arrêtée à votre demande.", run.SessionId, run.Cost, run.Turns);
        }

        if (limit.IsCancellationRequested)
        {
            return new Outcome("", $"Pas de réponse en {Limit.TotalMinutes:0} minutes : l'agent a été arrêté.", run.SessionId, run.Cost, run.Turns);
        }

        // `result` ne porte que le dernier message : ce que l'agent a dit avant ses outils le precede.
        var final = AgentDraft.Clean(run.Result ?? "");
        if (run.IsError || final.Length == 0)
        {
            var why = run.IsError && final.Length > 0 ? final : stderr;
            if (why.Contains("No conversation found", StringComparison.OrdinalIgnoreCase))
            {
                return new Outcome("", "La session de cette discussion est introuvable : « Nouvelle discussion » repart d'une copie neuve.", "", run.Cost, run.Turns);
            }

            return new Outcome("", AgentDraft.Explain(AgentProvider.Claude, process.ExitCode, why), "", run.Cost, run.Turns);
        }

        return new Outcome(run.Spoken(final), "", run.SessionId, run.Cost, run.Turns);
    }

    /// <summary>
    /// Lit une ligne du flux : texte en cours (deltas), outils appeles, resultat final. Les evenements
    /// d'un sous-agent sont ignores. Vrai quand il est temps de pousser l'avancement a l'interface.
    /// </summary>
    private static bool Feed(Run run, string line)
    {
        if (line.Length == 0 || line[0] != '{')
        {
            return false;
        }

        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(line);
        }
        catch (JsonException)
        {
            return false;
        }

        using (document)
        {
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
            {
                return false;
            }

            if (root.TryGetProperty("parent_tool_use_id", out var parent) && parent.ValueKind == JsonValueKind.String)
            {
                return false;
            }

            var step = false;
            switch (Text(root, "type"))
            {
                case "system":
                    if (Text(root, "subtype") == "init")
                    {
                        run.SessionId = Text(root, "session_id");
                    }

                    return false;

                case "stream_event":
                    if (!root.TryGetProperty("event", out var ev) || ev.ValueKind != JsonValueKind.Object)
                    {
                        return false;
                    }

                    switch (Text(ev, "type"))
                    {
                        case "message_start":
                            // Ce que l'agent a dit avant d'appeler un outil reste affiche : la reponse grandit.
                            if (run.Text.Trim().Length > 0)
                            {
                                run.Said.Add(run.Text.Trim());
                            }

                            run.Text = "";
                            run.Phase = "thinking";
                            break;
                        case "content_block_start":
                            var block = ev.TryGetProperty("content_block", out var b) ? Text(b, "type") : "";
                            run.Phase = block switch { "tool_use" => "tool", "text" => "writing", _ => "thinking" };
                            break;
                        case "content_block_delta":
                            if (ev.TryGetProperty("delta", out var delta) && Text(delta, "type") == "text_delta")
                            {
                                run.Text += Text(delta, "text");
                                run.Phase = "writing";
                            }
                            else
                            {
                                return false;
                            }

                            break;
                        default:
                            return false;
                    }

                    break;

                case "assistant":
                    if (root.TryGetProperty("message", out var message)
                        && message.TryGetProperty("content", out var content)
                        && content.ValueKind == JsonValueKind.Array)
                    {
                        foreach (var item in content.EnumerateArray())
                        {
                            if (Text(item, "type") == "tool_use")
                            {
                                run.Steps.Add(Describe(Text(item, "name"), item.TryGetProperty("input", out var input) ? input : default, run.Cwd));
                                while (run.Steps.Count > MaxSteps)
                                {
                                    run.Steps.RemoveAt(0);
                                }

                                run.Phase = "tool";
                                step = true;
                            }
                        }
                    }

                    if (!step)
                    {
                        return false;
                    }

                    break;

                case "result":
                    run.Result = Text(root, "result");
                    run.IsError = root.TryGetProperty("is_error", out var flag) && flag.ValueKind == JsonValueKind.True;
                    run.Cost = root.TryGetProperty("total_cost_usd", out var cost) && cost.TryGetDouble(out var usd) ? usd : 0;
                    run.Turns = root.TryGetProperty("num_turns", out var turns) && turns.TryGetInt32(out var n) ? n : 0;
                    var id = Text(root, "session_id");
                    if (id.Length > 0)
                    {
                        run.SessionId = id;
                    }

                    return false;

                default:
                    return false;
            }

            var now = Environment.TickCount64;
            if (!step && now - run.EmittedAt < ProgressEveryMs)
            {
                return false;
            }

            run.EmittedAt = now;
            return true;
        }
    }

    /// <summary>
    /// Ce que fait l'agent, en quelques mots : « Lit Contact.cs », « Cherche « Dispose » », « $ git log -3 ».
    /// Le dossier de travail est retire des commandes, ou il noierait l'essentiel.
    /// </summary>
    private static string Describe(string tool, JsonElement input, string cwd)
    {
        string Arg(string name) => input.ValueKind == JsonValueKind.Object ? Text(input, name) : "";
        string Name(string path) => path.Length == 0 ? "" : Path.GetFileName(path.TrimEnd('/', '\\')) is { Length: > 0 } file ? file : path;
        string Short(string command)
        {
            var root = cwd.TrimEnd('\\', '/');
            return root.Length == 0 ? command : command
                .Replace(root + "\\", "", StringComparison.OrdinalIgnoreCase)
                .Replace(root.Replace('\\', '/') + "/", "", StringComparison.OrdinalIgnoreCase)
                .Replace(root, ".", StringComparison.OrdinalIgnoreCase)
                .Replace(root.Replace('\\', '/'), ".", StringComparison.OrdinalIgnoreCase);
        }

        var text = tool switch
        {
            "Read" => "Lit " + Name(Arg("file_path")),
            "Grep" => "Cherche « " + Arg("pattern") + " »" + (Arg("path").Length > 0 ? " dans " + Name(Arg("path")) : "")
                + (Arg("glob").Length > 0 ? " (" + Arg("glob") + ")" : ""),
            "Glob" => "Liste " + Arg("pattern"),
            "Bash" => "$ " + Short(Arg("command").Split('\n')[0]),
            _ => tool,
        };
        return Clip(text, 120);
    }

    private void Emit(JsonObject payload)
    {
        try
        {
            Progress?.Invoke(payload);
        }
        catch (Exception ex)
        {
            _log.Warn("Avancement d'une discussion non transmis : " + ex.Message);
        }
    }

    private void Kill(Process? process)
    {
        try
        {
            if (process is not null && !process.HasExited)
            {
                process.Kill(entireProcessTree: true);
            }
        }
        catch (Exception ex)
        {
            _log.Warn("Arret de l'agent d'une discussion impossible : " + ex.Message);
        }
    }

    /// <summary>Une reponse en cours : son processus, le texte qui s'ecrit, les outils deja appeles.</summary>
    private sealed class Run
    {
        public Run(string report, string finding, string question)
        {
            Report = report;
            Finding = finding;
            Question = question;
            StartedAt = DateTimeOffset.Now.ToUnixTimeMilliseconds();
        }

        public string Report { get; }
        public string Finding { get; }
        public string Question { get; }
        public long StartedAt { get; }
        public string Cwd { get; set; } = "";
        public Process? Process { get; set; }
        public volatile bool Stopped;
        public string Phase { get; set; } = "thinking";

        /// <summary>Texte du message en cours ; <see cref="Said"/> : ceux des messages precedents du meme tour.</summary>
        public string Text { get; set; } = "";
        public List<string> Said { get; } = new();
        public List<string> Steps { get; } = new();

        /// <summary>Tout ce que l'agent a dit pendant ce tour, le message en cours compris.</summary>
        public string Spoken(string? last = null)
        {
            var parts = Said.ToList();
            var tail = (last ?? Text).Trim();
            if (tail.Length > 0)
            {
                parts.Add(tail);
            }

            return string.Join("\n\n", parts);
        }
        public string SessionId { get; set; } = "";
        public string? Result { get; set; }
        public bool IsError { get; set; }
        public double Cost { get; set; }
        public int Turns { get; set; }
        public long EmittedAt { get; set; }

        public JsonObject Snapshot(string phase)
        {
            var steps = new JsonArray();
            foreach (var step in Steps.ToArray())
            {
                steps.Add(step);
            }

            var text = Spoken();
            return new JsonObject
            {
                ["report"] = Report,
                ["finding"] = Finding,
                ["phase"] = phase,
                ["q"] = Question,
                ["text"] = text,
                ["html"] = phase == "done" || text.Length == 0 ? "" : ArtifactReader.RenderFragment(text),
                ["steps"] = steps,
                ["startedAt"] = StartedAt,
            };
        }
    }

    // --------------------------------------------------------------- stockage

    /// <summary>La discussion telle que l'interface l'affiche : chaque reponse rendue en HTML.</summary>
    private static JsonObject ToView(JsonObject chat)
    {
        var view = (JsonObject)chat.DeepClone();
        if (view["turns"] is JsonArray turns)
        {
            foreach (var turn in turns.OfType<JsonObject>())
            {
                var answer = Str(turn, "a");
                turn["html"] = answer.Length > 0 ? ArtifactReader.RenderFragment(answer) : "";
            }
        }

        return view;
    }

    private JsonArray Chats()
    {
        _store ??= Load();
        if (_store["chats"] is not JsonArray chats)
        {
            chats = new JsonArray();
            _store["chats"] = chats;
        }

        return chats;
    }

    private static JsonObject? Find(JsonArray chats, string report, string finding)
        => chats.OfType<JsonObject>().FirstOrDefault(c =>
            string.Equals(Str(c, "report"), report, StringComparison.OrdinalIgnoreCase)
            && string.Equals(Str(c, "finding"), finding, StringComparison.Ordinal));

    /// <summary>Au-dela de <see cref="MaxChats"/>, les discussions les plus anciennes s'en vont.</summary>
    private static void Trim(JsonArray chats)
    {
        while (chats.Count > MaxChats)
        {
            var oldest = chats.OfType<JsonObject>().OrderBy(c => c["updated"] is JsonValue v && v.TryGetValue<long>(out var t) ? t : 0).First();
            chats.Remove(oldest);
        }
    }

    private JsonObject Load()
    {
        try
        {
            if (File.Exists(_path) && JsonNode.Parse(File.ReadAllText(_path, Encoding.UTF8)) is JsonObject store)
            {
                return store;
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        {
            _log.Warn("finding-chats.json illisible, ignore : " + ex.Message);
        }

        return new JsonObject { ["version"] = 1, ["chats"] = new JsonArray() };
    }

    private void Save()
    {
        if (_store is null)
        {
            return;
        }

        try
        {
            var tmp = _path + ".tmp";
            File.WriteAllText(tmp, _store.ToJsonString(FileJson), new UTF8Encoding(false));
            File.Move(tmp, _path, overwrite: true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            _log.Warn("Ecriture de finding-chats.json impossible : " + ex.Message);
        }
    }

    // ---------------------------------------------------------------- outils

    private static string Key(string report, string finding) => report + "|" + finding;

    private static string Normalize(string? report)
    {
        var path = (report ?? "").Trim();
        if (path.Length == 0)
        {
            throw new InvalidOperationException("Rapport inconnu.");
        }

        try
        {
            return Path.GetFullPath(path);
        }
        catch (Exception)
        {
            throw new InvalidOperationException("Chemin de rapport invalide : " + path);
        }
    }

    private static string Text(JsonElement element, string name)
        => element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString() ?? ""
            : "";

    private static string Str(JsonObject obj, string key)
        => obj[key] is JsonValue v && v.TryGetValue<string>(out var s) ? s : "";

    private static string Clip(string? value, int max)
    {
        var text = (value ?? "").Trim();
        return text.Length <= max ? text : text[..max].TrimEnd() + "…";
    }
}
