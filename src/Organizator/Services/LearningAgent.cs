using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Organizator.Services;

/// <summary>
/// Generation des contenus de Revizator par Claude Code en mode non interactif : cours du jour
/// (<c>lesson</c>), series d'exercices (<c>exercise</c>), modules du bilan express (<c>toeic</c>),
/// bilan oral et ecrit (<c>sw</c>), correction d'une production (<c>grade</c>), tour du tuteur
/// (<c>tutor</c>), et le correcteur des cartes : une reponse refusee relue (<c>cardcheck</c>), des
/// cartes floues reecrites (<c>cardfix</c>).
///
/// Chaque appel est un <c>claude -p</c> dont le prompt est ecrit sur l'entree standard (en argument,
/// le cours depasserait la limite de <c>CreateProcess</c>), avec <c>--no-session-persistence</c> (rien
/// dans <c>~/.claude/projects</c>), <c>--strict-mcp-config</c> (aucun serveur MCP : demarrage rapide),
/// <c>--json-schema</c> (fiche structuree, validee par la CLI), <c>--append-system-prompt</c> (les
/// consignes du genre, ici en dur comme pour l'article du jour), <c>--tools</c> et
/// <c>--allowedTools</c> identiques (le web pour le cours, rien pour le reste), et jamais
/// <c>--bare</c> (qui saute le trousseau : « Not logged in »).
///
/// L'avancement vient de <c>--output-format stream-json --verbose --include-partial-messages</c> :
/// outils appeles, caracteres de la fiche en cours d'ecriture, fiche refusee par le schema puis
/// reecrite. Verifie le 8 octobre 2026 (Claude Code 2.1.294) : l'evenement <c>result</c> du flux
/// porte bien <c>structured_output</c>. Si ce n'etait plus le cas, les appels suivants repassent
/// en <c>--output-format json</c>, sans avancement fin.
///
/// La sortie du modele n'est jamais prise telle quelle : chaque genre a son <c>Sanitize</c>
/// tolerant, qui borne les longueurs, recalcule ce qui se calcule (cle des QCM apres melange,
/// somme du plan, mots de la lecture, mots manquants d'une dictee a trous), ecarte un item fautif
/// plutot que de tout refuser, et rend exactement la forme attendue par l'UI. Les documents des
/// genres <c>lesson</c>, <c>exercise</c>, <c>toeic</c> et <c>sw</c> sont enregistres par
/// <see cref="LearningStore"/> avant la reponse ; <c>grade</c> et <c>tutor</c> ne le sont pas.
///
/// Concurrence : trois generations au plus, un seul cours a la fois. Les travaux termines restent
/// consultables quinze minutes (<c>learnJobs</c>, <c>learnWait</c>).
/// </summary>
public sealed class LearningAgent
{
    private const int MaxRunning = 3;
    private const int ContextMax = 8000;
    private const long WriteEveryMs = 2000;
    private const string StructuredTool = "StructuredOutput";
    private static readonly TimeSpan RecentFor = TimeSpan.FromMinutes(15);
    private static readonly Regex JobPattern = new("^[A-Za-z0-9_-]{4,40}$", RegexOptions.CultureInvariant);
    private static readonly CultureInfo French = CultureInfo.GetCultureInfo("fr-FR");

    /// <summary>Ce qui distingue un genre pour le lanceur : modele et effort par defaut, limite, enregistrement.</summary>
    private sealed record KindSpec(string Kind, string Label, string Model, string Effort, TimeSpan Limit, bool Saved);

    private static readonly Dictionary<string, KindSpec> Kinds = new(StringComparer.Ordinal)
    {
        ["lesson"] = new("lesson", "Cours du jour", "sonnet", "medium", TimeSpan.FromSeconds(300), true),
        ["exercise"] = new("exercise", "Exercices", "sonnet", "low", TimeSpan.FromSeconds(150), true),
        ["toeic"] = new("toeic", "Bilan express", "sonnet", "low", TimeSpan.FromSeconds(240), true),
        ["sw"] = new("sw", "Bilan oral et écrit", "sonnet", "low", TimeSpan.FromSeconds(150), true),
        ["grade"] = new("grade", "Correction", "sonnet", "low", TimeSpan.FromSeconds(120), false),
        ["tutor"] = new("tutor", "Tuteur", "haiku", "", TimeSpan.FromSeconds(60), false),
        ["cardcheck"] = new("cardcheck", "Correcteur des cartes", "haiku", "", TimeSpan.FromSeconds(50), false),
        ["cardfix"] = new("cardfix", "Cartes clarifiées", "haiku", "", TimeSpan.FromSeconds(120), false),
    };

    // Vrai si un flux stream-json a rendu un resultat sans fiche structuree : on repasse alors en json.
    private static volatile bool _streamBroken;

    private readonly AgentLauncher _launcher;
    private readonly LearningStore _store;
    private readonly NewsMenu _news;
    private readonly HostLog _log;
    private readonly string _dataDir;
    private readonly object _gate = new();
    private readonly Dictionary<string, Job> _running = new(StringComparer.Ordinal);
    private readonly List<Job> _recent = new();

    public LearningAgent(AgentLauncher launcher, LearningStore store, NewsMenu news, HostLog log, string dataDir)
    {
        _launcher = launcher;
        _store = store;
        _news = news;
        _log = log;
        _dataDir = dataDir;
    }

    /// <summary>
    /// Avancement d'un travail : <c>{ job, kind, phase, text, at }</c>, <c>phase</c> valant <c>start</c>,
    /// <c>menu</c>, <c>tool</c>, <c>write</c>, <c>retry</c>, <c>done</c> ou <c>error</c>. Leve hors du fil
    /// de l'interface.
    /// </summary>
    public event Action<JsonObject>? Progress;

    // ------------------------------------------------------------------- travaux

    /// <summary>
    /// <c>learnGenerate</c> : <c>{ job, kind, model, effort, params, context }</c> -> <c>{ job, kind, id, doc,
    /// ms, turns, cost, model }</c>. Un travail deja en cours sous le meme <c>job</c> rend la meme tache ;
    /// un travail reussi depuis moins de quinze minutes rend son resultat sans relancer.
    /// </summary>
    public Task<JsonObject> GenerateAsync(JsonObject payload)
    {
        var job = LJ.Str(payload, "job", 100).Trim();
        if (!JobPattern.IsMatch(job))
        {
            throw new InvalidOperationException("Identifiant de travail invalide : 4 à 40 lettres, chiffres, tirets ou soulignés.");
        }

        var kind = LJ.Str(payload, "kind", 40).Trim();
        if (!Kinds.TryGetValue(kind, out var spec))
        {
            throw new InvalidOperationException("Genre de génération inconnu : " + (kind.Length == 0 ? "(vide)" : kind) + ".");
        }

        var model = AgentProvider.RequireModel(LJ.Str(payload, "model", 80));
        var effort = AgentProvider.RequireEffort(AgentProvider.Claude, LJ.Str(payload, "effort", 20));
        if (model.Length == 0)
        {
            model = spec.Model;
        }

        if (effort.Length == 0)
        {
            effort = spec.Effort;
        }

        var parameters = payload["params"] is JsonObject given ? (JsonObject)given.DeepClone() : new JsonObject();
        var context = LJ.Str(payload, "context", ContextMax).Trim();
        var request = new LearnRequest(job, kind, model, effort, parameters, context);

        lock (_gate)
        {
            Prune();
            if (_running.TryGetValue(job, out var existing))
            {
                return CloneAsync(existing.Task);
            }

            var done = _recent.FindLast(j => j.Id == job);
            if (done is not null)
            {
                if (done.Ok && done.Result is not null)
                {
                    return Task.FromResult((JsonObject)done.Result.DeepClone());
                }

                _recent.Remove(done);
            }

            if (_launcher.CommandFor(AgentProvider.Claude) is null)
            {
                throw new InvalidOperationException("Claude Code est introuvable sur ce poste : Révizator a besoin de lui pour préparer ses contenus.");
            }

            if (kind == "lesson" && _running.Values.Any(j => j.Kind == "lesson"))
            {
                throw new InvalidOperationException("Un cours est déjà en préparation.");
            }

            if (_running.Count >= MaxRunning)
            {
                throw new InvalidOperationException("Trois préparations sont déjà en cours : attendez que l’une d’elles se termine.");
            }

            var entry = new Job(job, kind);
            _running[job] = entry;
            // Hors du fil de l'interface : Process.Start l'occuperait plusieurs centaines de millisecondes.
            entry.Task = Task.Run(() => RunAsync(entry, request, spec));
            return CloneAsync(entry.Task);
        }
    }

    /// <summary><c>learnCancel</c> : arrete le travail (et son agent) ; faux s'il ne tourne pas.</summary>
    public bool Cancel(string? job)
    {
        Job? entry;
        lock (_gate)
        {
            _running.TryGetValue((job ?? "").Trim(), out entry);
        }

        if (entry is null)
        {
            return false;
        }

        entry.Cancelled = true;
        Kill(entry.Process);
        return true;
    }

    /// <summary><c>learnJobs</c> : travaux en cours, et ceux des quinze dernieres minutes.</summary>
    public JsonObject Jobs()
    {
        var running = new JsonArray();
        var recent = new JsonArray();
        lock (_gate)
        {
            Prune();
            foreach (var job in _running.Values.OrderBy(j => j.StartedAt))
            {
                running.Add(new JsonObject
                {
                    ["job"] = job.Id,
                    ["kind"] = job.Kind,
                    ["startedAt"] = job.StartedAt,
                    ["phase"] = job.Phase,
                    ["text"] = job.Text,
                });
            }

            foreach (var job in _recent.OrderByDescending(j => j.EndedAt))
            {
                recent.Add(new JsonObject
                {
                    ["job"] = job.Id,
                    ["kind"] = job.Kind,
                    ["id"] = job.DocId,
                    ["ok"] = job.Ok,
                    ["error"] = job.Error,
                    ["endedAt"] = job.EndedAt,
                });
            }
        }

        return new JsonObject { ["running"] = running, ["recent"] = recent };
    }

    /// <summary>
    /// <c>learnWait</c> : la reponse de <c>learnGenerate</c> pour un travail en cours (attend sa fin) ou
    /// recent (aussitot) ; l'erreur du travail s'il a echoue ; une erreur s'il est inconnu.
    /// </summary>
    public Task<JsonObject> WaitAsync(string? job)
    {
        var id = (job ?? "").Trim();
        lock (_gate)
        {
            Prune();
            if (_running.TryGetValue(id, out var running))
            {
                return CloneAsync(running.Task);
            }

            var done = _recent.FindLast(j => j.Id == id);
            if (done is null)
            {
                throw new InvalidOperationException("Travail inconnu : " + (id.Length == 0 ? "(vide)" : id) + ".");
            }

            if (!done.Ok || done.Result is null)
            {
                throw new InvalidOperationException(done.Error.Length > 0 ? done.Error : "Le travail a échoué.");
            }

            return Task.FromResult((JsonObject)done.Result.DeepClone());
        }
    }

    // Chaque appelant recoit sa copie : un noeud JSON n'a qu'un parent, et la reponse d'un travail
    // peut partir vers plusieurs messages (learnGenerate repete, learnWait).
    private static async Task<JsonObject> CloneAsync(Task<JsonObject> task)
        => (JsonObject)(await task.ConfigureAwait(false)).DeepClone();

    private void Prune()
    {
        var limit = DateTimeOffset.Now.ToUnixTimeMilliseconds() - (long)RecentFor.TotalMilliseconds;
        _recent.RemoveAll(j => j.EndedAt < limit);
    }

    private async Task<JsonObject> RunAsync(Job entry, LearnRequest request, KindSpec spec)
    {
        var started = Stopwatch.StartNew();
        try
        {
            Emit(entry, "start", spec.Label);

            JsonObject? menu = null;
            if (request.Kind == "lesson" && !LJ.Bool(request.Params, "timeless"))
            {
                try
                {
                    menu = await _news.GetAsync(false).ConfigureAwait(false);
                    var count = (menu["items"] as JsonArray)?.Count ?? 0;
                    Emit(entry, "menu", count.ToString(French) + " titres");
                }
                catch (InvalidOperationException ex)
                {
                    _log.Warn("Revizator lesson : menu RSS indisponible, cours sans menu : " + Ascii(ex.Message));
                    Emit(entry, "menu", "Menu du jour indisponible");
                }
            }

            if (entry.Cancelled)
            {
                throw new InvalidOperationException("Préparation annulée.");
            }

            var call = Compose(request, menu);
            var outcome = await CallAsync(entry, request, spec, call).ConfigureAwait(false);
            var content = Sanitize(request, outcome.Output, menu);

            var id = "";
            JsonObject doc;
            if (spec.Saved)
            {
                id = LearningStore.NewId(request.Kind);
                doc = WithHostFields(content, id, request.Kind, outcome, started.ElapsedMilliseconds);
                _store.WriteDoc(request.Kind, id, doc);
            }
            else
            {
                doc = content;
            }

            started.Stop();
            var size = doc.ToJsonString().Length;
            _log.Info($"Revizator {request.Kind} : {request.Model}{(request.Effort.Length > 0 ? "/" + request.Effort : "")} en {started.ElapsedMilliseconds} ms"
                + $" ({outcome.Turns} tours, {outcome.Cost.ToString("0.000", CultureInfo.InvariantCulture)} $ au tarif public, fiche de {size} caracteres"
                + (id.Length > 0 ? ", " + id : "") + (outcome.Retries > 0 ? $", {outcome.Retries} reecriture(s)" : "") + ").");

            var result = new JsonObject
            {
                ["job"] = entry.Id,
                ["kind"] = request.Kind,
                ["id"] = id,
                ["doc"] = doc,
                ["ms"] = started.ElapsedMilliseconds,
                ["turns"] = outcome.Turns,
                ["cost"] = Math.Round(outcome.Cost, 4),
                ["model"] = outcome.Model,
            };

            lock (_gate)
            {
                entry.Ok = true;
                entry.DocId = id;
                entry.Result = result;
            }

            Emit(entry, "done", id);
            return result;
        }
        catch (Exception ex)
        {
            var message = ex is InvalidOperationException ? ex.Message : "Préparation impossible : " + ex.Message;
            _log.Warn($"Revizator {request.Kind} : echec apres {started.ElapsedMilliseconds} ms (job {entry.Id}) : {Ascii(message)}");
            lock (_gate)
            {
                entry.Error = message;
            }

            Emit(entry, "error", message);
            throw new InvalidOperationException(message, ex);
        }
        finally
        {
            lock (_gate)
            {
                _running.Remove(entry.Id);
                entry.Process = null;
                entry.EndedAt = DateTimeOffset.Now.ToUnixTimeMilliseconds();
                _recent.Add(entry);
            }
        }
    }

    /// <summary>Champs de l'hote en tete du document : <c>id, kind, createdAt, day, model, ms, cost, turns</c>.</summary>
    private static JsonObject WithHostFields(JsonObject content, string id, string kind, Outcome outcome, long ms)
    {
        var doc = new JsonObject
        {
            ["id"] = id,
            ["kind"] = kind,
            ["createdAt"] = DateTimeOffset.Now.ToUnixTimeMilliseconds(),
            ["day"] = DateTime.Now.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
            ["model"] = outcome.Model,
            ["ms"] = ms,
            ["cost"] = Math.Round(outcome.Cost, 4),
            ["turns"] = outcome.Turns,
        };

        foreach (var name in content.Select(p => p.Key).ToList())
        {
            var value = content[name];
            content.Remove(name);
            doc[name] = value;
        }

        return doc;
    }

    private void Emit(Job entry, string phase, string text)
    {
        entry.Phase = phase;
        entry.Text = text;
        try
        {
            Progress?.Invoke(new JsonObject
            {
                ["job"] = entry.Id,
                ["kind"] = entry.Kind,
                ["phase"] = phase,
                ["text"] = text,
                ["at"] = DateTimeOffset.Now.ToUnixTimeMilliseconds(),
            });
        }
        catch (Exception ex)
        {
            _log.Warn("Avancement Revizator non transmis : " + ex.Message);
        }
    }

    // ------------------------------------------------------------------ genres

    private static AgentCall Compose(LearnRequest r, JsonObject? menu) => r.Kind switch
    {
        "lesson" => LessonGenre.Compose(r, menu),
        "exercise" => ExerciseGenre.Compose(r),
        "toeic" => ToeicGenre.Compose(r),
        "sw" => SwGenre.Compose(r),
        "grade" => GradeGenre.Compose(r),
        "tutor" => TutorGenre.Compose(r),
        "cardcheck" => CardGenre.ComposeCheck(r),
        "cardfix" => CardGenre.ComposeFix(r),
        _ => throw new InvalidOperationException("Genre inconnu : " + r.Kind),
    };

    private JsonObject Sanitize(LearnRequest r, JsonObject output, JsonObject? menu) => r.Kind switch
    {
        "cardcheck" => CardGenre.SanitizeCheck(output),
        "cardfix" => CardGenre.SanitizeFix(output, r),
        "lesson" => LessonGenre.Sanitize(output, r, menu, _log),
        "exercise" => ExerciseGenre.Sanitize(output, r),
        "toeic" => ToeicGenre.Sanitize(output, r, _log),
        "sw" => SwGenre.Sanitize(output, r),
        "grade" => GradeGenre.Sanitize(output, r),
        "tutor" => TutorGenre.Sanitize(output, r),
        _ => throw new InvalidOperationException("Genre inconnu : " + r.Kind),
    };

    // ---------------------------------------------------------------- lanceur

    private sealed record Outcome(JsonObject Output, int Turns, double Cost, string Model, int Retries);

    /// <summary>Lance <c>claude -p</c>, ecrit le prompt sur son entree, suit le flux et rend la fiche brute.</summary>
    private async Task<Outcome> CallAsync(Job entry, LearnRequest r, KindSpec spec, AgentCall call)
    {
        var command = _launcher.CommandFor(AgentProvider.Claude)
            ?? throw new InvalidOperationException("Claude Code est introuvable sur ce poste : Révizator a besoin de lui pour préparer ses contenus.");
        var stream = !_streamBroken;

        var info = new ProcessStartInfo
        {
            FileName = command.FileName,
            WorkingDirectory = _dataDir,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardInputEncoding = new UTF8Encoding(false),
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };

        foreach (var argument in command.Arguments)
        {
            info.ArgumentList.Add(argument);
        }

        info.ArgumentList.Add("-p");
        info.ArgumentList.Add("--no-session-persistence");
        info.ArgumentList.Add("--strict-mcp-config");
        info.ArgumentList.Add("--tools");
        info.ArgumentList.Add(call.Tools);
        info.ArgumentList.Add("--allowedTools");
        info.ArgumentList.Add(call.Tools);
        info.ArgumentList.Add("--output-format");
        if (stream)
        {
            info.ArgumentList.Add("stream-json");
            info.ArgumentList.Add("--verbose");
            info.ArgumentList.Add("--include-partial-messages");
        }
        else
        {
            info.ArgumentList.Add("json");
        }

        info.ArgumentList.Add("--json-schema");
        info.ArgumentList.Add(call.Schema);
        info.ArgumentList.Add("--append-system-prompt");
        info.ArgumentList.Add(call.System);
        if (r.Model.Length > 0)
        {
            info.ArgumentList.Add("--model");
            info.ArgumentList.Add(r.Model);
        }

        if (r.Effort.Length > 0)
        {
            info.ArgumentList.Add("--effort");
            info.ArgumentList.Add(r.Effort);
        }

        // Un claude.cmd passe par cmd.exe, limite a 8 191 caracteres : le schema et les consignes
        // du cours n'y tiennent pas. Le binaire natif (claude.exe) monte a 32 767.
        var length = info.ArgumentList.Sum(a => a.Length + 3);
        if (length > 8000 && (command.FileName.EndsWith(".cmd", StringComparison.OrdinalIgnoreCase) || command.FileName.EndsWith(".bat", StringComparison.OrdinalIgnoreCase)))
        {
            throw new InvalidOperationException("Claude Code est installé en script (claude.cmd), dont la ligne de commande est trop courte pour Révizator : installez la version native (claude.exe).");
        }

        using var process = new Process { StartInfo = info };
        try
        {
            process.Start();
        }
        catch (Exception ex)
        {
            throw new InvalidOperationException("Lancement de Claude Code impossible : " + ex.Message);
        }

        entry.Process = process;
        if (entry.Cancelled)
        {
            Kill(process);
        }

        var state = new StreamState();
        var raw = new StringBuilder();
        var stderr = process.StandardError.ReadToEndAsync();
        // La lecture de la sortie part avant l'ecriture du prompt : l'agent peut ecrire avant
        // d'avoir tout lu, et deux tubes pleins s'attendraient l'un l'autre.
        var reading = Task.Run(async () =>
        {
            string? line;
            while ((line = await process.StandardOutput.ReadLineAsync().ConfigureAwait(false)) is not null)
            {
                if (stream)
                {
                    Feed(entry, state, line);
                }
                else
                {
                    raw.Append(line).Append('\n');
                }
            }
        });

        using var limit = new CancellationTokenSource(spec.Limit);
        using var expire = limit.Token.Register(() =>
        {
            entry.TimedOut = true;
            Kill(process);
        });

        try
        {
            await process.StandardInput.WriteAsync(call.Prompt).ConfigureAwait(false);
            await process.StandardInput.FlushAsync().ConfigureAwait(false);
            process.StandardInput.Close();
        }
        catch (IOException)
        {
            // L'agent s'est arrete avant d'avoir tout lu : sa sortie d'erreur dira pourquoi.
        }

        await reading.ConfigureAwait(false);
        await process.WaitForExitAsync().ConfigureAwait(false);
        var error = AgentDraft.Clean(await stderr.ConfigureAwait(false));

        if (entry.Cancelled)
        {
            throw new InvalidOperationException("Préparation annulée.");
        }

        if (entry.TimedOut)
        {
            throw new InvalidOperationException($"La préparation a dépassé {spec.Limit.TotalSeconds:0} secondes : l’agent a été arrêté.");
        }

        var envelope = stream ? state.Result : ParseObject(AgentDraft.Clean(raw.ToString()));
        if (envelope is null)
        {
            throw new InvalidOperationException(Explain(process.ExitCode, (error + "\n" + (stream ? state.Tail() : raw.ToString())).Trim()));
        }

        var turns = LJ.Int(envelope, "num_turns");
        var cost = LJ.Num(envelope, "total_cost_usd");
        var result = LJ.Str(envelope, "result", 20000);
        if (LJ.Bool(envelope, "is_error"))
        {
            var subtype = LJ.Str(envelope, "subtype", 80);
            if (subtype.Contains("structured", StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException("L’agent n’a pas réussi à rendre une fiche conforme au schéma.");
            }

            throw new InvalidOperationException(Explain(process.ExitCode, result.Length > 0 ? result : error));
        }

        var output = envelope["structured_output"] as JsonObject ?? ParseObject(AgentDraft.Clean(result));
        if (output is null)
        {
            if (stream)
            {
                _streamBroken = true;
                _log.Warn("Revizator : stream-json sans structured_output, les generations suivantes passent en json.");
            }

            throw new InvalidOperationException("L’agent n’a pas rendu de fiche lisible.");
        }

        var model = state.Model.Length > 0 ? state.Model : r.Model;
        return new Outcome((JsonObject)output.DeepClone(), turns, cost, model, state.Retries);
    }

    /// <summary>
    /// Une ligne du flux : modele (init), outils appeles, caracteres de la fiche en cours (deltas de
    /// <c>StructuredOutput</c>), fiche refusee par le schema, resultat final. Les evenements d'un
    /// sous-agent sont ignores.
    /// </summary>
    private void Feed(Job entry, StreamState state, string line)
    {
        if (line.Length == 0 || line[0] != '{')
        {
            state.Remember(line);
            return;
        }

        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(line);
        }
        catch (JsonException)
        {
            state.Remember(line);
            return;
        }

        using (document)
        {
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object
                || (root.TryGetProperty("parent_tool_use_id", out var parent) && parent.ValueKind == JsonValueKind.String))
            {
                return;
            }

            switch (Text(root, "type"))
            {
                case "system":
                    if (Text(root, "subtype") == "init")
                    {
                        state.Model = Text(root, "model");
                    }

                    break;

                case "stream_event":
                    if (!root.TryGetProperty("event", out var ev) || ev.ValueKind != JsonValueKind.Object)
                    {
                        break;
                    }

                    switch (Text(ev, "type"))
                    {
                        case "message_start":
                            state.Blocks.Clear();
                            break;
                        case "content_block_start":
                            if (ev.TryGetProperty("content_block", out var block) && block.ValueKind == JsonValueKind.Object)
                            {
                                state.Blocks[Index(ev)] = Text(block, "type") == "tool_use" ? Text(block, "name") : Text(block, "type");
                            }

                            break;
                        case "content_block_delta":
                            if (ev.TryGetProperty("delta", out var delta)
                                && Text(delta, "type") == "input_json_delta"
                                && state.Blocks.TryGetValue(Index(ev), out var name)
                                && name == StructuredTool)
                            {
                                state.Chars += Text(delta, "partial_json").Length;
                                var now = Environment.TickCount64;
                                if (state.Chars > 0 && now - state.WriteAt >= WriteEveryMs)
                                {
                                    state.WriteAt = now;
                                    Emit(entry, "write", state.Chars.ToString("N0", French) + " caractères");
                                }
                            }

                            break;
                    }

                    break;

                case "assistant":
                    foreach (var item in Content(root))
                    {
                        if (Text(item, "type") != "tool_use")
                        {
                            continue;
                        }

                        var tool = Text(item, "name");
                        state.Tools[Text(item, "id")] = tool;
                        var input = item.TryGetProperty("input", out var i) ? i : default;
                        if (tool == "WebSearch")
                        {
                            Emit(entry, "tool", "Recherche : " + LJ.Clip(Text(input, "query"), 120));
                        }
                        else if (tool == "WebFetch")
                        {
                            var url = Text(input, "url");
                            var host = Uri.TryCreate(url, UriKind.Absolute, out var uri) ? uri.Host : url;
                            Emit(entry, "tool", "Lecture : " + (host.StartsWith("www.", StringComparison.OrdinalIgnoreCase) ? host[4..] : host));
                        }
                    }

                    break;

                case "user":
                    foreach (var item in Content(root))
                    {
                        if (Text(item, "type") == "tool_result"
                            && item.TryGetProperty("is_error", out var failed) && failed.ValueKind == JsonValueKind.True
                            && state.Tools.TryGetValue(Text(item, "tool_use_id"), out var tool) && tool == StructuredTool)
                        {
                            state.Retries++;
                            state.Chars = 0;
                            var reason = item.TryGetProperty("content", out var content)
                                ? content.ValueKind == JsonValueKind.String ? content.GetString() ?? "" : content.GetRawText()
                                : "";
                            _log.Warn($"Revizator {entry.Kind} : fiche refusee par le schema, reecrite ({Ascii(LJ.Clip(reason, 400))}).");
                            Emit(entry, "retry", "Fiche refusée par le schéma : nouvelle rédaction");
                        }
                    }

                    break;

                case "result":
                    state.Result = ParseObject(line);
                    break;
            }
        }
    }

    private static IEnumerable<JsonElement> Content(JsonElement root)
    {
        if (root.TryGetProperty("message", out var message)
            && message.ValueKind == JsonValueKind.Object
            && message.TryGetProperty("content", out var content)
            && content.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in content.EnumerateArray())
            {
                if (item.ValueKind == JsonValueKind.Object)
                {
                    yield return item;
                }
            }
        }
    }

    private static int Index(JsonElement ev)
        => ev.TryGetProperty("index", out var index) && index.TryGetInt32(out var n) ? n : -1;

    private static string Text(JsonElement element, string name)
        => element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString() ?? ""
            : "";

    private static JsonObject? ParseObject(string text)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return null;
        }

        try
        {
            return JsonNode.Parse(text) as JsonObject;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static string Explain(int code, string text)
    {
        if (text.Contains("usage limit", StringComparison.OrdinalIgnoreCase)
            || text.Contains("rate limit", StringComparison.OrdinalIgnoreCase)
            || text.Contains("limit reached", StringComparison.OrdinalIgnoreCase))
        {
            return "Limite d’usage de Claude Code atteinte : réessayez quand elle sera levée.";
        }

        return AgentDraft.Explain(AgentProvider.Claude, code, text);
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
            _log.Warn("Arret d'un agent Revizator impossible : " + ex.Message);
        }
    }

    /// <summary>Le journal est en ASCII : accents et apostrophes typographiques retires.</summary>
    internal static string Ascii(string text)
    {
        var decomposed = (text ?? "").Replace('’', '\'').Replace('«', '"').Replace('»', '"').Normalize(NormalizationForm.FormD);
        var sb = new StringBuilder(decomposed.Length);
        foreach (var c in decomposed)
        {
            if (CharUnicodeInfo.GetUnicodeCategory(c) != UnicodeCategory.NonSpacingMark)
            {
                sb.Append(c < 128 ? c : c == ' ' || c == ' ' ? ' ' : c == '…' ? '.' : '?');
            }
        }

        return sb.ToString();
    }

    /// <summary>Un travail : son agent, son avancement, son resultat une fois termine.</summary>
    private sealed class Job
    {
        public Job(string id, string kind)
        {
            Id = id;
            Kind = kind;
            StartedAt = DateTimeOffset.Now.ToUnixTimeMilliseconds();
        }

        public string Id { get; }
        public string Kind { get; }
        public long StartedAt { get; }
        public Task<JsonObject> Task { get; set; } = null!;
        public Process? Process { get; set; }
        public volatile bool Cancelled;
        public volatile bool TimedOut;
        public string Phase { get; set; } = "start";
        public string Text { get; set; } = "";
        public long EndedAt { get; set; }
        public bool Ok { get; set; }
        public string Error { get; set; } = "";
        public string DocId { get; set; } = "";
        public JsonObject? Result { get; set; }
    }

    /// <summary>Ce que le flux a appris : blocs en cours, outils appeles, caracteres ecrits, resultat.</summary>
    private sealed class StreamState
    {
        private readonly Queue<string> _tail = new();

        public Dictionary<int, string> Blocks { get; } = new();
        public Dictionary<string, string> Tools { get; } = new(StringComparer.Ordinal);
        public string Model { get; set; } = "";
        public int Chars { get; set; }
        public long WriteAt { get; set; }
        public int Retries { get; set; }
        public JsonObject? Result { get; set; }

        public void Remember(string line)
        {
            if (line.Trim().Length == 0)
            {
                return;
            }

            _tail.Enqueue(line.Length > 400 ? line[..400] : line);
            while (_tail.Count > 8)
            {
                _tail.Dequeue();
            }
        }

        public string Tail() => string.Join("\n", _tail);
    }
}

/// <summary>Une demande de generation, validee.</summary>
internal sealed record LearnRequest(string Job, string Kind, string Model, string Effort, JsonObject Params, string Context);

/// <summary>Ce qu'un genre passe a l'agent : outils, consignes, schema, prompt.</summary>
internal sealed record AgentCall(string Tools, string System, string Schema, string Prompt);

// ============================================================================ communs

/// <summary>Lecture tolerante de la sortie du modele et petites aides de mise en forme.</summary>
internal static class LJ
{
    private static readonly Regex Blanks = new(@"\s+", RegexOptions.CultureInvariant);

    // Par le genre JSON de la valeur, pas par son type .NET : une valeur lue (JsonElement) et une
    // valeur creee en memoire (JsonValue<int>, <long>...) se lisent de la meme facon.
    public static string Str(JsonNode? node, string key, int max = 4000)
    {
        if (node is not JsonObject obj || obj[key] is not JsonValue value)
        {
            return "";
        }

        var text = value.GetValueKind() switch
        {
            JsonValueKind.String => value.GetValue<string>(),
            JsonValueKind.Number => value.ToJsonString(),
            JsonValueKind.True => "true",
            JsonValueKind.False => "false",
            _ => "",
        };
        return Clip(text, max);
    }

    public static double Num(JsonNode? node, string key, double fallback = 0)
    {
        if (node is not JsonObject obj || obj[key] is not JsonValue value)
        {
            return fallback;
        }

        var text = value.GetValueKind() switch
        {
            JsonValueKind.Number => value.ToJsonString(),
            JsonValueKind.String => value.GetValue<string>().Trim(),
            _ => "",
        };
        return double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out var number) && double.IsFinite(number)
            ? number
            : fallback;
    }

    public static int Int(JsonNode? node, string key, int fallback = 0)
    {
        var value = Num(node, key, fallback);
        return (int)Math.Round(Math.Clamp(value, int.MinValue / 2.0, int.MaxValue / 2.0));
    }

    public static bool Bool(JsonNode? node, string key)
    {
        if (node is not JsonObject obj || obj[key] is not JsonValue value)
        {
            return false;
        }

        return value.GetValueKind() switch
        {
            JsonValueKind.True => true,
            JsonValueKind.String => value.GetValue<string>().Trim().Equals("true", StringComparison.OrdinalIgnoreCase),
            _ => false,
        };
    }

    public static JsonObject? Obj(JsonNode? node, string key)
        => node is JsonObject obj ? obj[key] as JsonObject : null;

    public static JsonArray? Arr(JsonNode? node, string key)
        => node is JsonObject obj ? obj[key] as JsonArray : null;

    /// <summary>Objets d'un tableau, avec leur indice d'origine (les autres valeurs sont sautees).</summary>
    public static IEnumerable<(int Index, JsonObject Item)> Indexed(JsonNode? node, string key)
    {
        if (Arr(node, key) is not { } array)
        {
            yield break;
        }

        for (var i = 0; i < array.Count; i++)
        {
            if (array[i] is JsonObject item)
            {
                yield return (i, item);
            }
        }
    }

    public static IEnumerable<JsonObject> Objects(JsonNode? node, string key)
        => Indexed(node, key).Select(p => p.Item);

    /// <summary>Chaines non vides d'un tableau, bornees en nombre et en longueur.</summary>
    public static List<string> Strings(JsonNode? node, string key, int maxItems, int maxLength)
        => StringsOf(Arr(node, key), maxItems, maxLength);

    public static List<string> StringsOf(JsonArray? array, int maxItems, int maxLength)
    {
        var list = new List<string>();
        if (array is null)
        {
            return list;
        }

        foreach (var item in array)
        {
            if (list.Count >= maxItems)
            {
                break;
            }

            var text = item is not JsonValue v ? "" : v.GetValueKind() switch
            {
                JsonValueKind.String => Clip(v.GetValue<string>(), maxLength),
                JsonValueKind.Number => v.ToJsonString(),
                _ => "",
            };
            if (text.Length > 0)
            {
                list.Add(text);
            }
        }

        return list;
    }

    public static JsonArray Array(IEnumerable<string> values)
    {
        var array = new JsonArray();
        foreach (var value in values)
        {
            array.Add(JsonValue.Create(value));
        }

        return array;
    }

    public static JsonArray Array(IEnumerable<JsonNode?> values)
    {
        var array = new JsonArray();
        foreach (var value in values)
        {
            array.Add(value);
        }

        return array;
    }

    public static string Clip(string? value, int max)
    {
        var text = (value ?? "").Trim();
        return text.Length <= max ? text : text[..max].TrimEnd() + "…";
    }

    /// <summary>La valeur canonique de <paramref name="allowed"/> qui correspond (casse ignoree), sinon <paramref name="fallback"/>.</summary>
    public static string Pick(string? value, IEnumerable<string> allowed, string fallback)
    {
        var text = (value ?? "").Trim();
        foreach (var candidate in allowed)
        {
            if (string.Equals(candidate, text, StringComparison.OrdinalIgnoreCase))
            {
                return candidate;
            }
        }

        return fallback;
    }

    /// <summary>
    /// Cle de comparaison tolerante : casse, apostrophes et guillemets typographiques, blancs,
    /// ponctuation finale. Sert a retrouver une reponse parmi les options, un extrait dans un texte.
    /// </summary>
    public static string Key(string? text)
    {
        var value = (text ?? "")
            .Replace('’', '\'').Replace('‘', '\'').Replace('`', '\'')
            .Replace('“', '"').Replace('”', '"')
            .Replace('–', '-').Replace('—', '-')
            .Replace(' ', ' ').Replace(' ', ' ');
        value = Blanks.Replace(value, " ").Trim().ToLowerInvariant();
        return value.Trim('.', ',', ';', ':', '!', '?', '"', ' ');
    }

    /// <summary>Mots d'un texte (sequences qui contiennent une lettre ou un chiffre).</summary>
    public static int Words(string? text)
        => Blanks.Split(text ?? "").Count(w => w.Any(char.IsLetterOrDigit));

    /// <summary>Melange de Fisher-Yates (generateur partage, sans graine fixe).</summary>
    public static void Shuffle<T>(IList<T> list)
    {
        for (var i = list.Count - 1; i > 0; i--)
        {
            var j = Random.Shared.Next(i + 1);
            (list[i], list[j]) = (list[j], list[i]);
        }
    }

    /// <summary>Adresse https (http est releve en https), vide si ce n'est pas une adresse web.</summary>
    public static string Https(string? url)
    {
        var text = (url ?? "").Trim();
        if (text.Length > 2000 || !Uri.TryCreate(text, UriKind.Absolute, out var uri) || uri.Scheme is not ("http" or "https"))
        {
            return "";
        }

        return uri.Scheme == "http" ? "https://" + text[7..] : text;
    }
}

/// <summary>Niveaux CECRL, descripteurs reinjectes a chaque appel, langue des explications.</summary>
internal static class Levels
{
    public static readonly string[] All = { "A2", "B1", "B1+", "B2", "B2+", "C1" };

    /// <summary>Niveaux des items de bilan.</summary>
    public static readonly string[] Items = { "A1", "A2", "B1", "B2", "C1" };

    public static readonly string[] Accents = { "en-US", "en-GB", "en-AU", "en-CA", "en-IE", "en-IN" };

    /// <summary>
    /// Ajoute a toutes les consignes : la plupart des fiches reecrites l'ont ete pour un JSON illisible
    /// (« StructuredOutput was called with input that could not be parsed as JSON »), le plus souvent un
    /// guillemet droit non echappe dans une citation.
    /// </summary>
    public const string Quotes = "\n\nDans les textes de la fiche, employez des guillemets typographiques (“ ” en anglais, « » en français) plutôt que des guillemets droits : la fiche est un JSON, et un guillemet droit mal échappé la rend illisible.";

    private static readonly Dictionary<string, (string Descriptor, string Example)> Descriptors = new(StringComparer.Ordinal)
    {
        ["A1"] = ("comprend et emploie des expressions familières et quotidiennes très simples ; se présente, pose des questions simples sur des sujets très concrets",
            "My name is Paul. I live in Lyon and I work in an office."),
        ["A2"] = ("comprend des phrases isolées et des expressions fréquentes sur des sujets familiers (soi, travail, achats, environnement proche) ; communique lors d'échanges simples et habituels",
            "Last summer I went to Brighton with my family. The weather was great and we ate fish and chips on the beach."),
        ["B1"] = ("comprend l'essentiel d'un texte clair en langue standard sur des sujets familiers ; raconte un événement ou une expérience et donne brièvement ses raisons",
            "I've been working from home since March, and I think it has made me more productive, although I miss my colleagues."),
        ["B1+"] = ("B1 solide : suit un article simple ou une émission sur l'actualité, donne et justifie son avis avec des connecteurs courants ; erreurs encore fréquentes sur les temps et les prépositions",
            "Although the plan sounds good on paper, I'm not sure it will work, because most families simply can't afford it."),
        ["B2"] = ("comprend l'essentiel d'un texte complexe et d'une discussion technique dans sa spécialité ; s'exprime de façon claire et détaillée et argumente avec une certaine aisance",
            "If the council had listened to residents earlier, the housing shortage wouldn't have become such a serious problem."),
        ["B2+"] = ("B2 solide : lit la presse sans grand effort, nuance et reformule, emploie quelques tournures idiomatiques ; erreurs rares et sans gêne",
            "It's not so much the cost that worries people as the lack of a clear long-term plan, which is hardly reassuring."),
        ["C1"] = ("comprend des textes longs et exigeants et saisit l'implicite ; s'exprime spontanément et couramment, de façon bien structurée, avec un registre adapté",
            "Critics argue that the reform, far from easing the pressure on hospitals, merely shifts the burden onto already overstretched local services."),
    };

    public static string Normalize(string? value, string fallback = "B1+")
        => LJ.Pick(value, All, fallback);

    /// <summary>« Niveau visé : B1+ — descripteur. Exemple de phrase à ce niveau : « … ». »</summary>
    public static string Line(string level, string label = "Niveau visé")
    {
        var (descriptor, example) = Descriptors.TryGetValue(level, out var d) ? d : Descriptors["B1+"];
        return $"{label} : {level} — {descriptor}. Exemple de phrase à ce niveau : « {example} »";
    }

    /// <summary>Explications en francais jusqu'a B1+, en anglais simple au-dela, sauf <c>explain</c> (fr, en) impose par l'UI.</summary>
    public static bool FrenchExplanations(string level, string? explain)
    {
        var forced = (explain ?? "").Trim().ToLowerInvariant();
        if (forced == "fr")
        {
            return true;
        }

        if (forced == "en")
        {
            return false;
        }

        return level is "A1" or "A2" or "B1" or "B1+";
    }

    public static string ExplainRule(string level, string? explain)
        => FrenchExplanations(level, explain)
            ? "Langue des explications : français (champs …Fr), en vouvoyant l'utilisateur ; les exemples restent en anglais."
            : "Langue des explications : à ce niveau, les explications et retours (explanationFr, feedbackFr, tipFr…) sont rédigés en anglais simple ; les faux amis et les contrastes avec le français s'expliquent en français. Les consignes (instructionsFr, promptFr, taskFr) restent en français, en vouvoyant l'utilisateur.";

    /// <summary>Accents des voix disponibles (<c>params.voices</c>), en-US et en-GB par defaut.</summary>
    public static List<string> Voices(JsonObject parameters)
    {
        var voices = LJ.Strings(parameters, "voices", 8, 10).Select(v => LJ.Pick(v, Accents, "")).Where(v => v.Length > 0).Distinct().ToList();
        return voices.Count > 0 ? voices : new List<string> { "en-US", "en-GB" };
    }

    /// <summary>Un accent disponible, le plus proche de celui demande.</summary>
    public static string Accent(string? wanted, IReadOnlyList<string> available)
    {
        var accent = LJ.Pick(wanted, Accents, "");
        if (accent.Length > 0 && available.Contains(accent))
        {
            return accent;
        }

        var near = accent is "en-CA" ? "en-US" : "en-GB";
        return available.Contains(near) ? near : available[0];
    }
}

/// <summary>Taxonomie fermee des erreurs (spec §5.1).</summary>
internal static class Taxonomy
{
    public static readonly string[] All =
    {
        "pron.stress.word", "pron.vowel.reduction", "pron.vowel.i_ii", "pron.vowel.ae_uh", "pron.h", "pron.ed", "pron.final_s",
        "pron.diphthong", "pron.th", "pron.sentence_stress", "gram.tense.pp_past", "gram.tense.duration", "gram.for_since_ago",
        "gram.future_after_when", "gram.question.aux", "gram.article.generic", "gram.article.job", "gram.countable", "gram.agreement",
        "gram.verb_pattern", "gram.preposition", "gram.word_order", "gram.possessive", "gram.modal", "gram.comparative", "gram.other",
        "lex.false_friend", "lex.collocation", "lex.phrasal_avoidance", "lex.register", "lex.franglais", "lex.word_choice",
        "disc.connector", "disc.coherence", "mech.capitalisation", "mech.punctuation_spacing", "mech.spelling",
    };

    /// <summary>Les valeurs, en liste JSON, pour une enumeration de schema.</summary>
    public static readonly string Enum = "[" + string.Join(",", All.Select(c => "\"" + c + "\"")) + "]";

    public static string Normalize(string? value)
    {
        var text = (value ?? "").Trim().ToLowerInvariant();
        var known = LJ.Pick(text, All, "");
        if (known.Length > 0)
        {
            return known;
        }

        return text.StartsWith("lex", StringComparison.Ordinal) ? "lex.word_choice" : "gram.other";
    }

    /// <summary>La liste, pour un prompt.</summary>
    public static string Listing() => string.Join(", ", All);
}

/// <summary>Nettoyage des repliques lues par la synthese vocale.</summary>
internal static class Speech
{
    private static readonly Regex Markup = new(@"\[[^\]]{0,80}\]|\{[^}]{0,80}\}|<[^>]{0,80}>|\*[^*]{1,60}\*", RegexOptions.CultureInvariant);
    private static readonly Regex StageDirection = new(@"\((?:laugh|sigh|pause|chuckl|smil|clears|cough|music|sound|beat|whisper|shout|excit|surpris|hesit|laughs|sighs|pauses)[^)]{0,40}\)", RegexOptions.CultureInvariant | RegexOptions.IgnoreCase);
    private static readonly Regex Emoji = new(@"[\p{Cs}☀-➿⬀-⯿️‍]", RegexOptions.CultureInvariant);
    private static readonly Regex Blanks = new(@"[ \t]+", RegexOptions.CultureInvariant);
    private static readonly Regex SpaceBeforePunct = new(@"\s+([,.;:!?])", RegexOptions.CultureInvariant);

    /// <summary>Sans didascalie, balise, emoticone ni nom de locuteur en tete.</summary>
    public static string Clean(string? text, IEnumerable<string>? names = null, int max = 1200)
    {
        var value = Markup.Replace(text ?? "", " ");
        value = StageDirection.Replace(value, " ");
        value = Emoji.Replace(value, "");
        value = value.Replace('\r', ' ').Replace('\n', ' ');
        value = Blanks.Replace(value, " ").Trim();
        if (names is not null)
        {
            foreach (var name in names.Where(n => n.Length > 0))
            {
                if (value.StartsWith(name + ":", StringComparison.OrdinalIgnoreCase))
                {
                    value = value[(name.Length + 1)..].TrimStart();
                }
            }
        }

        value = SpaceBeforePunct.Replace(value, "$1");
        return LJ.Clip(value, max);
    }
}

/// <summary>Nombres ecrits comme on les dit, pour l'audio des bilans (« two thirty », « fifteen dollars »).</summary>
internal static class NumberWords
{
    private static readonly string[] Ones =
    {
        "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
        "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen",
    };

    private static readonly string[] Tens = { "", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety" };

    private static readonly Regex Money = new(@"([$£€])\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?", RegexOptions.CultureInvariant);
    private static readonly Regex Clock = new(@"\b([01]?\d|2[0-3]):([0-5]\d)\b", RegexOptions.CultureInvariant);
    private static readonly Regex Percent = new(@"\b(\d+(?:\.\d+)?)\s?%", RegexOptions.CultureInvariant);
    private static readonly Regex Ordinal = new(@"\b(\d{1,4})(st|nd|rd|th)\b", RegexOptions.CultureInvariant | RegexOptions.IgnoreCase);
    private static readonly Regex Phone = new(@"\b\d{3}-\d{4}\b", RegexOptions.CultureInvariant);
    private static readonly Regex Year = new(@"\b(19\d{2}|20\d{2})\b", RegexOptions.CultureInvariant);
    private static readonly Regex Decimal = new(@"\b(\d+)\.(\d+)\b", RegexOptions.CultureInvariant);
    private static readonly Regex Grouped = new(@"\b\d{1,3}(?:,\d{3})+\b", RegexOptions.CultureInvariant);
    private static readonly Regex Integer = new(@"\b\d{1,9}\b", RegexOptions.CultureInvariant);

    public static string Spell(string text)
    {
        var value = text ?? "";
        value = Money.Replace(value, m =>
        {
            var amount = long.Parse(m.Groups[2].Value.Replace(",", ""), CultureInfo.InvariantCulture);
            var (unit, units, cent) = m.Groups[1].Value switch
            {
                "£" => ("pound", "pounds", "pence"),
                "€" => ("euro", "euros", "cents"),
                _ => ("dollar", "dollars", "cents"),
            };
            var words = Say(amount) + " " + (amount == 1 ? unit : units);
            if (m.Groups[3].Success)
            {
                var cents = int.Parse(m.Groups[3].Value.PadRight(2, '0'), CultureInfo.InvariantCulture);
                if (cents > 0)
                {
                    words += " and " + Say(cents) + " " + cent;
                }
            }

            return words;
        });
        value = Clock.Replace(value, m => Time(int.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture), int.Parse(m.Groups[2].Value, CultureInfo.InvariantCulture)));
        value = Percent.Replace(value, m => Number(m.Groups[1].Value) + " percent");
        value = Ordinal.Replace(value, m => Ordinals(long.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture)));
        value = Phone.Replace(value, m => string.Join(" ", m.Value.Where(char.IsDigit).Select(c => c == '0' ? "oh" : Ones[c - '0'])));
        value = Year.Replace(value, m => Years(int.Parse(m.Value, CultureInfo.InvariantCulture)));
        value = Decimal.Replace(value, m => Number(m.Value));
        value = Grouped.Replace(value, m => Say(long.Parse(m.Value.Replace(",", ""), CultureInfo.InvariantCulture)));
        value = Integer.Replace(value, m => Say(long.Parse(m.Value, CultureInfo.InvariantCulture)));
        return value;
    }

    private static string Number(string text)
    {
        var parts = text.Split('.');
        var whole = Say(long.Parse(parts[0], CultureInfo.InvariantCulture));
        return parts.Length < 2 ? whole : whole + " point " + string.Join(" ", parts[1].Select(c => Ones[c - '0']));
    }

    public static string Say(long n)
    {
        if (n < 0)
        {
            return "minus " + Say(-n);
        }

        if (n < 20)
        {
            return Ones[n];
        }

        if (n < 100)
        {
            return Tens[n / 10] + (n % 10 > 0 ? "-" + Ones[n % 10] : "");
        }

        if (n < 1000)
        {
            return Ones[n / 100] + " hundred" + (n % 100 > 0 ? " and " + Say(n % 100) : "");
        }

        if (n < 1_000_000)
        {
            var rest = n % 1000;
            return Say(n / 1000) + " thousand" + (rest == 0 ? "" : rest < 100 ? " and " + Say(rest) : " " + Say(rest));
        }

        if (n < 1_000_000_000)
        {
            var rest = n % 1_000_000;
            return Say(n / 1_000_000) + " million" + (rest == 0 ? "" : " " + Say(rest));
        }

        return string.Join(" ", n.ToString(CultureInfo.InvariantCulture).Select(c => Ones[c - '0']));
    }

    private static string Ordinals(long n)
    {
        var words = Say(n);
        var cut = Math.Max(words.LastIndexOf(' '), words.LastIndexOf('-')) + 1;
        var head = words[..cut];
        var last = words[cut..];
        var ordinal = last switch
        {
            "one" => "first",
            "two" => "second",
            "three" => "third",
            "five" => "fifth",
            "eight" => "eighth",
            "nine" => "ninth",
            "twelve" => "twelfth",
            _ when last.EndsWith('y') => last[..^1] + "ieth",
            _ => last + "th",
        };
        return head + ordinal;
    }

    private static string Years(int year)
    {
        if (year >= 2000 && year < 2010)
        {
            return "two thousand" + (year > 2000 ? " and " + Ones[year - 2000] : "");
        }

        var high = year / 100;
        var low = year % 100;
        return Say(high) + (low == 0 ? " hundred" : low < 10 ? " oh " + Ones[low] : " " + Say(low));
    }

    private static string Time(int hour, int minute)
    {
        var h = Say(hour);
        return minute == 0 ? h + " o'clock" : minute < 10 ? h + " oh " + Ones[minute] : h + " " + Say(minute);
    }
}

// ============================================================================ cours du jour

/// <summary>
/// Cours du jour (<c>lesson</c>) : consignes et schema de <c>sources.md</c> §9 et §11 (testes sur sept
/// generations reelles), prompt utilisateur du §10 (date, contexte de l'UI, seance, sujet impose,
/// voix, episodes audio et menu du jour), controles du §6.5.
/// </summary>
internal static class LessonGenre
{
    private const string Web = "WebSearch,WebFetch";

    private static readonly string[] Rubrics = { "france", "uk", "world", "europe", "usa", "tech", "science", "environment", "health", "economy", "culture", "sport", "society", "lifestyle" };
    private static readonly string[] Tones = { "light", "balanced", "serious" };
    private static readonly string[] Steps = { "warmup", "reading", "listening", "authenticAudio", "vocabulary", "grammar", "writing", "speaking", "review" };
    private static readonly string[] QuestionKinds = { "choice", "true_false", "open" };
    private static readonly string[] Skills = { "gist", "detail", "inference", "vocabulary" };
    private static readonly string[] Formats = { "dialogue", "interview", "report", "podcast", "phone_call", "debate", "vox_pop" };
    private static readonly string[] Pos = { "noun", "verb", "adjective", "adverb", "phrasal verb", "idiom", "collocation", "other" };
    private static readonly string[] VocabularyKinds = { "gap_fill", "matching", "collocations", "word_formation", "false_friends", "translation", "error_correction" };
    private static readonly string[] Genres = { "email", "message", "comment", "opinion", "summary", "letter", "review", "story" };
    private static readonly string[] CardKinds = { "word", "collocation", "phrase", "false_friend", "grammar", "pronunciation" };

    // Consignes testees (sources.md §9, lesson-system.txt), en trois morceaux pour le mode intemporel.
    private const string NewsIntro = "Tu es le professeur d'anglais d'Organizator. À la demande, tu prépares « le cours d'anglais du jour » pour un adulte francophone, à partir de l'actualité réelle du jour, et tu rends uniquement la fiche demandée. Le contenu d'apprentissage est en anglais ; les consignes et explications (champs …Fr) sont en français, en vouvoyant l'utilisateur.\n\n";

    private const string NewsRules = "1. Le sujet\n- Un sujet imposé (choisi par l'utilisateur à la fin du cours précédent) passe avant tout.\n- Sinon, choisis dans le menu du jour fourni, en faisant tourner les rubriques : pas la rubrique des deux derniers cours, pas deux cours « serious » de suite. Guerre, attentat, catastrophe ou fait divers : au plus un par semaine, jamais sous l'angle du bilan humain, toujours sous un angle qui fait réfléchir ou agir. Préfère ce qui donne envie d'en parler : découvertes, société, culture, tech, sport, vie quotidienne en France, au Royaume-Uni et ailleurs, initiatives, débats d'idées. Tiens compte des centres d'intérêt.\n- Ne reprends ni un sujet déjà vu (liste fournie) ni un sujet qu'il faudrait trancher : sur un sujet politique, expose les positions en les attribuant.\n\n2. Les sources — budget serré : la fiche doit être rendue en moins de trois minutes\n- Ouvre avec WebFetch un ou deux articles récents qui racontent le fait, si possible de deux rédactions. Demande à WebFetch, en anglais, une fiche factuelle en anglais : titre, date de publication, qui, quoi, où, quand, chiffres, deux citations courtes attribuées (WebFetch ne rend pas le texte de la page et refuse les citations longues).\n- Lisibles par WebFetch : france24.com, euronews.com, aljazeera.com, text.npr.org (version texte de NPR : remplace www.npr.org/AAAA/MM/JJ/ID/... par text.npr.org/ID), theconversation.com, rte.ie, abc.net.au, connexionfrance.com, thelocal.fr (articles « members » tronqués), l'AP republiée par des journaux (adn.com…), NPR republiée par ses stations (wunc.org…), techcrunch.com, theregister.com, technologyreview.com, phys.org, sciencedaily.com, snexplores.org, nasa.gov, espn.com.\n- N'essaie pas WebFetch sur bbc.co.uk, bbc.com, theguardian.com, reuters.com, apnews.com, economist.com, independent.co.uk, sky.com, rfi.fr, dw.com, lemonde.fr, theverge.com, wired.com, arstechnica.com ni www.npr.org : ils refusent l'outil. Un titre du menu venu de ces sites se lit sur une autre rédaction.\n- Au plus deux WebSearch et trois WebFetch. Article inaccessible (paywall, erreur) : passe à un autre, sans réessayer. L'index de WebSearch a souvent un ou deux jours de retard : pour l'actualité du jour, fie-toi au menu et aux pages.\n- Vérifie la date sur la page : moins de trois jours de préférence, sept au plus.\n\n3. La fidélité\n- Aucun fait (nom, chiffre, date, lieu, citation) que tu n'as pas lu dans une source ouverte. Chaque fait repris figure dans facts, avec l'index de sa source. Chiffres divergents ou doute : attribue (« according to… ») ou omets.\n- Les personnages du script d'écoute sont fictifs ; ne fais jamais parler une personne réelle, sauf pour une citation lue et attribuée.\n\n";

    private const string CourseRules = "4. Le cours\n- Lecture : un texte original écrit pour l'apprenant, pas une paraphrase phrase à phrase : autre plan, autres phrases, aucun passage recopié. credit nomme les sources. Au niveau visé, l'utilisateur connaît environ 95 % des mots ; 8 à 12 mots ou expressions nouveaux, utiles au-delà du sujet (collocations fréquentes plutôt que jargon), vont au glossaire.\n- Écoute : un script original sous un autre angle que la lecture (deux collègues qui en parlent, l'interview d'un expert ou d'un témoin fictif, un flash radio, un micro-trottoir), qui réemploie 5 à 8 mots du glossaire. Anglais parlé naturel : contractions, marqueurs (well, actually, I mean), reformulations, questions entre interlocuteurs. N'emploie que les accents des voix disponibles, et varie-les. Ni didascalie, ni émoticône, ni balise : tout est lu tel quel. Compte 140 mots par minute.\n- Écoute authentique : si un épisode de la liste fournie s'accorde au sujet ou au niveau, propose-le en bonus, adresses recopiées exactement, questions tirées de son résumé seulement ; sinon laisse authenticAudio vide (chaînes vides, liste vide).\n- Questions : le sens général d'abord, puis le détail, puis l'inférence ; une seule bonne réponse, trouvable dans le texte ou le script ; explanationFr cite le passage, et ne désigne jamais une option par sa position (les options sont mélangées après coup).\n- Vocabulaire : réemploi des mots du glossaire dans des phrases nouvelles, collocations, et quand le sujet s'y prête faux amis et calques typiques d'un francophone (actually, eventually, sensible, library, assist, control…).\n- Grammaire : un point illustré par le texte, pris dans les points faibles connus mais différent de ceux des derniers cours ; champs vides pour 10 minutes.\n- Écrit et oral : tâches réalistes reliées au sujet et à la vie de l'utilisateur (donner son avis, comparer avec la France, raconter une expérience, répondre à un message), d'un genre différent des derniers cours, avec expressions utiles, critères et réponse modèle au niveau visé. Prononciation : 2 à 4 mots du cours difficiles pour un francophone (accent tonique, th, h, voyelles longues, -ed).\n- Cartes : absentes des cartes connues ; mots et collocations du glossaire, faux amis, une phrase clé ; front en anglais à trous ou en français, back court.\n- plan : la somme des minutes égale la durée demandée.\n- nextTopics : trois sujets d'actualité, de trois rubriques différentes, dont au moins un léger, aucun déjà vu.\n\nDosage selon la durée (lecture / écoute / questions lecture + écoute / exercices de vocabulaire × items / écrit / oral / cartes) :\n- 10 min : 150-200 mots / 120-160 mots / 3 + 3 / 1 × 5 / 30 mots / 45 s / 6 ; pas de grammaire.\n- 20 min : 250-330 / 200-260 / 4 + 4 / 2 × 5 / 60-90 mots / 60-90 s / 8-10.\n- 30 min : 350-430 / 280-360 / 5 + 5 / 3 × 5 / 100-140 mots / 90-120 s / 10-12.\n- 45 min : 450-550 / 380-460 / 6 + 6 / 4 × 6 / 150-200 mots / 2-3 min / 12-15.\nB1 : bas de fourchette, phrases de 12 à 15 mots, peu de subordonnées. B2 : haut de fourchette, phrases de 15 à 20 mots, quelques tournures idiomatiques. C1 : registre de presse.\n\nRéponds uniquement par la fiche demandée.\n";

    private const string TimelessIntro = "Tu es le professeur d'anglais d'Organizator. À la demande, tu prépares un cours d'anglais « hors actualité » pour un adulte francophone, sans aucun outil, et tu rends uniquement la fiche demandée. Le contenu d'apprentissage est en anglais ; les consignes et explications (champs …Fr) sont en français, en vouvoyant l'utilisateur.\n\n";

    private const string TimelessRules = "1. Le sujet\n"
        + "- Un sujet imposé passe avant tout : traite-le sous un angle intemporel (son histoire, son fonctionnement, ce qu'il change au quotidien), sans actualité.\n"
        + "- Sinon, un thème intemporel, concret et utile : voyager au Royaume-Uni ou ailleurs, la vie au travail (réunions, e-mails, entretiens, code), la cuisine, la santé, une invention, une habitude culturelle anglophone, une grande figure ou un lieu, une expression qui a une histoire. Pas la rubrique des deux derniers cours, rien de déjà vu ; tiens compte des centres d'intérêt.\n\n"
        + "2. Les sources : aucune\n"
        + "- Tu n'as pas d'outil web : sources et facts restent des listes vides. N'invente aucune actualité, aucun chiffre récent, aucune citation, aucune date précise douteuse ; reste sur des faits généraux et sûrs.\n"
        + "- credit vaut « Written for learners by Organizator ». authenticAudio reste vide (chaînes vides, liste vide).\n"
        + "- Les personnages du script d'écoute sont fictifs.\n"
        + "- nextTopics : trois sujets (d'actualité ou intemporels), de trois rubriques différentes, dont au moins un léger.\n\n"
        + "3. La fidélité\n"
        + "- En cas de doute sur un fait, omets-le ou présente-le comme une opinion de personnage.\n\n";

    private static readonly string Schema = "{\"type\":\"object\",\"additionalProperties\":false,\"required\":[\"title\",\"summaryFr\",\"level\",\"minutes\",\"rubric\",\"tone\",\"keywords\",\"plan\",\"sources\",\"facts\",\"warmup\",\"reading\",\"comprehension\",\"listening\",\"authenticAudio\",\"vocabulary\",\"grammar\",\"writing\",\"speaking\",\"cards\",\"nextTopics\"],\"definitions\":{\"question\":{\"type\":\"object\",\"additionalProperties\":false,\"required\":[\"kind\",\"skill\",\"question\",\"options\",\"answer\",\"explanationFr\"],\"properties\":{\"kind\":{\"type\":\"string\",\"enum\":[\"choice\",\"true_false\",\"open\"]},\"skill\":{\"type\":\"string\",\"enum\":[\"gist\",\"detail\",\"inference\",\"vocabulary\"]},\"question\":{\"type\":\"string\",\"description\":\"En anglais\"},\"options\":{\"type\":\"array\",\"items\":{\"type\":\"string\"},\"description\":\"choice : 3 ou 4 choix ; true_false : [\\\"True\\\",\\\"False\\\"] ; open : []\"},\"answer\":{\"type\":\"string\",\"description\":\"choice et true_false : le texte exact d'une option ; open : réponse attendue, courte\"},\"explanationFr\":{\"type\":\"string\",\"description\":\"Pourquoi, en français, en citant le passage du texte ou du script\"}}},\"language\":{\"type\":\"array\",\"items\":{\"type\":\"string\"},\"description\":\"Expressions utiles, en anglais, pour réaliser la tâche\"}},\"properties\":{\"title\":{\"type\":\"string\",\"description\":\"Titre du cours, en anglais\"},\"summaryFr\":{\"type\":\"string\",\"description\":\"Le cours en une phrase, en français\"},\"level\":{\"type\":\"string\",\"enum\":[\"A2\",\"B1\",\"B1+\",\"B2\",\"B2+\",\"C1\"]},\"minutes\":{\"type\":\"integer\",\"description\":\"Durée totale prévue, égale à la somme du plan\"},\"rubric\":{\"type\":\"string\",\"enum\":[\"france\",\"uk\",\"world\",\"europe\",\"usa\",\"tech\",\"science\",\"environment\",\"health\",\"economy\",\"culture\",\"sport\",\"society\",\"lifestyle\"]},\"tone\":{\"type\":\"string\",\"enum\":[\"light\",\"balanced\",\"serious\"]},\"keywords\":{\"type\":\"array\",\"items\":{\"type\":\"string\"},\"description\":\"3 à 6 mots-clés du sujet, pour l'historique\"},\"plan\":{\"type\":\"array\",\"description\":\"Déroulé de la séance, dans l'ordre\",\"items\":{\"type\":\"object\",\"additionalProperties\":false,\"required\":[\"step\",\"minutes\"],\"properties\":{\"step\":{\"type\":\"string\",\"enum\":[\"warmup\",\"reading\",\"listening\",\"authenticAudio\",\"vocabulary\",\"grammar\",\"writing\",\"speaking\",\"review\"]},\"minutes\":{\"type\":\"integer\"}}}},\"sources\":{\"type\":\"array\",\"description\":\"Articles réellement ouverts avec WebFetch et lus\",\"items\":{\"type\":\"object\",\"additionalProperties\":false,\"required\":[\"title\",\"url\",\"outlet\",\"published\"],\"properties\":{\"title\":{\"type\":\"string\",\"description\":\"Titre exact, dans sa langue\"},\"url\":{\"type\":\"string\",\"description\":\"Adresse https de la page lue\"},\"outlet\":{\"type\":\"string\",\"description\":\"Ex. France 24, AP via Anchorage Daily News\"},\"published\":{\"type\":\"string\",\"description\":\"AAAA-MM-JJ lu sur la page\"}}}},\"facts\":{\"type\":\"array\",\"description\":\"Chaque fait (nom, chiffre, date, citation) repris dans le texte ou le script\",\"items\":{\"type\":\"object\",\"additionalProperties\":false,\"required\":[\"fact\",\"source\"],\"properties\":{\"fact\":{\"type\":\"string\",\"description\":\"Le fait, en anglais simple, tel que lu\"},\"source\":{\"type\":\"integer\",\"description\":\"Index (à partir de 0) dans sources\"}}}},\"warmup\":{\"type\":\"array\",\"items\":{\"type\":\"string\"},\"description\":\"2 ou 3 questions d'échauffement, en anglais, sur l'expérience de l'utilisateur\"},\"reading\":{\"type\":\"object\",\"additionalProperties\":false,\"required\":[\"headline\",\"standfirst\",\"paragraphs\",\"credit\",\"glossary\"],\"properties\":{\"headline\":{\"type\":\"string\"},\"standfirst\":{\"type\":\"string\",\"description\":\"Chapô, une phrase\"},\"paragraphs\":{\"type\":\"array\",\"items\":{\"type\":\"string\"},\"description\":\"Texte original réécrit au niveau, sans copier les sources\"},\"credit\":{\"type\":\"string\",\"description\":\"Ex. Written for learners from reports by France 24 and AP, 8 October 2026\"},\"glossary\":{\"type\":\"array\",\"items\":{\"type\":\"object\",\"additionalProperties\":false,\"required\":[\"term\",\"pos\",\"ipa\",\"meaningEn\",\"meaningFr\",\"example\"],\"properties\":{\"term\":{\"type\":\"string\",\"description\":\"Tel qu'il apparaît dans le texte\"},\"pos\":{\"type\":\"string\",\"enum\":[\"noun\",\"verb\",\"adjective\",\"adverb\",\"phrasal verb\",\"idiom\",\"collocation\",\"other\"]},\"ipa\":{\"type\":\"string\",\"description\":\"Prononciation API britannique\"},\"meaningEn\":{\"type\":\"string\"},\"meaningFr\":{\"type\":\"string\"},\"example\":{\"type\":\"string\",\"description\":\"Nouvel exemple, hors du texte\"}}}}}},\"comprehension\":{\"type\":\"array\",\"items\":{\"$ref\":\"#/definitions/question\"},\"description\":\"Questions sur le texte de lecture\"},\"listening\":{\"type\":\"object\",\"additionalProperties\":false,\"required\":[\"format\",\"title\",\"contextFr\",\"speakers\",\"lines\",\"questions\"],\"properties\":{\"format\":{\"type\":\"string\",\"enum\":[\"dialogue\",\"interview\",\"report\",\"podcast\",\"phone_call\",\"debate\",\"vox_pop\"]},\"title\":{\"type\":\"string\"},\"contextFr\":{\"type\":\"string\",\"description\":\"Ce que l'utilisateur sait avant d'écouter, en français\"},\"speakers\":{\"type\":\"array\",\"items\":{\"type\":\"object\",\"additionalProperties\":false,\"required\":[\"id\",\"name\",\"role\",\"accent\",\"gender\"],\"properties\":{\"id\":{\"type\":\"string\",\"description\":\"A, B, C...\"},\"name\":{\"type\":\"string\"},\"role\":{\"type\":\"string\",\"description\":\"Ex. presenter, nurse in Lyon\"},\"accent\":{\"type\":\"string\",\"enum\":[\"en-GB\",\"en-US\",\"en-AU\",\"en-IE\",\"en-CA\",\"en-IN\"]},\"gender\":{\"type\":\"string\",\"enum\":[\"female\",\"male\"]}}}},\"lines\":{\"type\":\"array\",\"description\":\"Le script, réplique par réplique, tel que la synthèse vocale le lira\",\"items\":{\"type\":\"object\",\"additionalProperties\":false,\"required\":[\"speaker\",\"text\"],\"properties\":{\"speaker\":{\"type\":\"string\",\"description\":\"id d'un speaker\"},\"text\":{\"type\":\"string\",\"description\":\"Une à trois phrases, sans didascalie ni balise\"}}}},\"questions\":{\"type\":\"array\",\"items\":{\"$ref\":\"#/definitions/question\"}}}},\"authenticAudio\":{\"type\":\"object\",\"additionalProperties\":false,\"description\":\"Un épisode de la liste fournie, s'il s'accorde au cours ; sinon tous les champs vides\",\"required\":[\"title\",\"outlet\",\"audioUrl\",\"pageUrl\",\"published\",\"taskFr\",\"questions\"],\"properties\":{\"title\":{\"type\":\"string\"},\"outlet\":{\"type\":\"string\"},\"audioUrl\":{\"type\":\"string\",\"description\":\"mp3 exactement tel que fourni\"},\"pageUrl\":{\"type\":\"string\"},\"published\":{\"type\":\"string\",\"description\":\"AAAA-MM-JJ\"},\"taskFr\":{\"type\":\"string\",\"description\":\"Consigne d'écoute, en français\"},\"questions\":{\"type\":\"array\",\"items\":{\"type\":\"string\"},\"description\":\"Questions ouvertes, à partir du résumé fourni seulement\"}}},\"vocabulary\":{\"type\":\"array\",\"description\":\"Exercices sur les mots du cours\",\"items\":{\"type\":\"object\",\"additionalProperties\":false,\"required\":[\"kind\",\"instructionFr\",\"items\"],\"properties\":{\"kind\":{\"type\":\"string\",\"enum\":[\"gap_fill\",\"matching\",\"collocations\",\"word_formation\",\"false_friends\",\"translation\",\"error_correction\"]},\"instructionFr\":{\"type\":\"string\"},\"items\":{\"type\":\"array\",\"items\":{\"type\":\"object\",\"additionalProperties\":false,\"required\":[\"prompt\",\"options\",\"answer\",\"explanationFr\"],\"properties\":{\"prompt\":{\"type\":\"string\",\"description\":\"Phrase à trous (___), mot à associer, phrase à traduire ou à corriger\"},\"options\":{\"type\":\"array\",\"items\":{\"type\":\"string\"},\"description\":\"Choix proposés, [] si réponse libre\"},\"answer\":{\"type\":\"string\"},\"explanationFr\":{\"type\":\"string\"}}}}}}},\"grammar\":{\"type\":\"object\",\"additionalProperties\":false,\"description\":\"Un point de langue tiré du texte ; tous les champs vides si la séance est trop courte\",\"required\":[\"point\",\"explanationFr\",\"examples\",\"items\"],\"properties\":{\"point\":{\"type\":\"string\",\"description\":\"Ex. present perfect vs past simple\"},\"explanationFr\":{\"type\":\"string\",\"description\":\"Règle et piège pour un francophone, 3 à 5 phrases\"},\"examples\":{\"type\":\"array\",\"items\":{\"type\":\"string\"},\"description\":\"Phrases du texte qui l'illustrent\"},\"items\":{\"type\":\"array\",\"items\":{\"type\":\"object\",\"additionalProperties\":false,\"required\":[\"prompt\",\"answer\"],\"properties\":{\"prompt\":{\"type\":\"string\",\"description\":\"Phrase à compléter ou à transformer, avec la consigne entre crochets\"},\"answer\":{\"type\":\"string\"}}}}}},\"writing\":{\"type\":\"object\",\"additionalProperties\":false,\"required\":[\"taskFr\",\"genre\",\"words\",\"language\",\"criteria\",\"modelAnswer\"],\"properties\":{\"taskFr\":{\"type\":\"string\",\"description\":\"Consigne, en français, qui relie le sujet à la vie de l'utilisateur\"},\"genre\":{\"type\":\"string\",\"enum\":[\"email\",\"message\",\"comment\",\"opinion\",\"summary\",\"letter\",\"review\",\"story\"]},\"words\":{\"type\":\"integer\",\"description\":\"Longueur visée, en mots\"},\"language\":{\"$ref\":\"#/definitions/language\"},\"criteria\":{\"type\":\"array\",\"items\":{\"type\":\"string\"},\"description\":\"3 ou 4 critères de réussite, en français\"},\"modelAnswer\":{\"type\":\"string\",\"description\":\"Réponse modèle au niveau visé\"}}},\"speaking\":{\"type\":\"object\",\"additionalProperties\":false,\"required\":[\"taskFr\",\"prompts\",\"prepSeconds\",\"speakSeconds\",\"language\",\"pronunciation\",\"modelAnswer\"],\"properties\":{\"taskFr\":{\"type\":\"string\",\"description\":\"Consigne, en français : donner son avis, raconter, jouer un rôle\"},\"prompts\":{\"type\":\"array\",\"items\":{\"type\":\"string\"},\"description\":\"Questions ou relances, en anglais\"},\"prepSeconds\":{\"type\":\"integer\"},\"speakSeconds\":{\"type\":\"integer\"},\"language\":{\"$ref\":\"#/definitions/language\"},\"pronunciation\":{\"type\":\"array\",\"description\":\"2 à 4 mots du cours difficiles pour un francophone\",\"items\":{\"type\":\"object\",\"additionalProperties\":false,\"required\":[\"word\",\"ipa\",\"tipFr\"],\"properties\":{\"word\":{\"type\":\"string\"},\"ipa\":{\"type\":\"string\"},\"tipFr\":{\"type\":\"string\",\"description\":\"Accent tonique, son th, h aspiré, voyelle longue...\"}}}},\"modelAnswer\":{\"type\":\"string\",\"description\":\"Ce qu'une bonne réponse pourrait dire, au niveau visé\"}}},\"cards\":{\"type\":\"array\",\"description\":\"Cartes de répétition espacée, absentes de la liste des cartes connues\",\"items\":{\"type\":\"object\",\"additionalProperties\":false,\"required\":[\"kind\",\"front\",\"back\",\"example\"],\"properties\":{\"kind\":{\"type\":\"string\",\"enum\":[\"word\",\"collocation\",\"phrase\",\"false_friend\",\"grammar\",\"pronunciation\"]},\"front\":{\"type\":\"string\",\"description\":\"Côté question : mot ou phrase à trous en anglais, ou sens en français\"},\"back\":{\"type\":\"string\",\"description\":\"Côté réponse\"},\"example\":{\"type\":\"string\",\"description\":\"Phrase d'exemple en anglais, lue à voix haute au verso\"}}}},\"nextTopics\":{\"type\":\"array\",\"description\":\"Trois sujets pour le prochain cours, de rubriques différentes, dont un léger\",\"items\":{\"type\":\"object\",\"additionalProperties\":false,\"required\":[\"title\",\"pitchFr\",\"rubric\",\"tone\",\"query\"],\"properties\":{\"title\":{\"type\":\"string\",\"description\":\"En anglais, accrocheur\"},\"pitchFr\":{\"type\":\"string\",\"description\":\"Pourquoi c'est intéressant, une phrase en français\"},\"rubric\":{\"type\":\"string\",\"enum\":[\"france\",\"uk\",\"world\",\"europe\",\"usa\",\"tech\",\"science\",\"environment\",\"health\",\"economy\",\"culture\",\"sport\",\"society\",\"lifestyle\"]},\"tone\":{\"type\":\"string\",\"enum\":[\"light\",\"balanced\",\"serious\"]},\"query\":{\"type\":\"string\",\"description\":\"Mots-clés de recherche pour retrouver l'actualité du sujet\"}}}}}}";

    public static AgentCall Compose(LearnRequest r, JsonObject? menu)
    {
        var timeless = LJ.Bool(r.Params, "timeless");
        var system = (timeless ? TimelessIntro + TimelessRules + CourseRules : NewsIntro + NewsRules + CourseRules) + Levels.Quotes;
        return new AgentCall(timeless ? "" : Web, system, Schema, Prompt(r, menu, timeless));
    }

    private static int Minutes(LearnRequest r)
    {
        var wanted = LJ.Int(r.Params, "minutes", 20);
        return new[] { 10, 20, 30, 45 }.OrderBy(m => Math.Abs(m - wanted)).First();
    }

    private static string Prompt(LearnRequest r, JsonObject? menu, bool timeless)
    {
        var p = r.Params;
        var level = Levels.Normalize(LJ.Str(p, "level", 10));
        var minutes = Minutes(r);
        var sb = new StringBuilder();
        sb.Append("Date du jour : ").Append(DateTime.Now.ToString("dddd d MMMM yyyy", CultureInfo.GetCultureInfo("fr-FR"))).Append(".\n\n");
        if (r.Context.Length > 0)
        {
            sb.Append(r.Context.Trim()).Append("\n\n");
        }

        sb.Append("Séance : ").Append(minutes).Append(" minutes. ").Append(Levels.Line(level)).Append('\n');
        if (!Levels.FrenchExplanations(level, LJ.Str(p, "explain", 10)))
        {
            sb.Append(Levels.ExplainRule(level, LJ.Str(p, "explain", 10))).Append('\n');
        }

        var topic = LJ.Obj(p, "topic");
        var title = LJ.Str(topic, "title", 200);
        if (title.Length > 0)
        {
            sb.Append("Sujet imposé (choisi par l'utilisateur) : « ").Append(title).Append(" »");
            var rubric = LJ.Str(topic, "rubric", 30);
            var query = LJ.Str(topic, "query", 200);
            if (rubric.Length > 0)
            {
                sb.Append(" — rubrique ").Append(rubric);
            }

            if (query.Length > 0)
            {
                sb.Append(" ; mots-clés de recherche : ").Append(query);
            }

            sb.Append(timeless
                ? ".\n"
                : ". Cherchez son dernier développement (moins de 7 jours) ; s'il n'y a rien de neuf, partez de l'article le plus récent (14 jours au plus) et dites-le dans summaryFr.\n");
        }
        else
        {
            sb.Append("Sujet imposé : aucun.\n");
        }

        var avoid = LJ.Strings(p, "avoidRubrics", 6, 30).Select(a => LJ.Pick(a, Rubrics, "")).Where(a => a.Length > 0).Distinct().ToList();
        if (avoid.Count > 0)
        {
            sb.Append("Rubriques à éviter (derniers cours) : ").Append(string.Join(", ", avoid)).Append(".\n");
        }

        sb.Append("Voix disponibles pour le script : ").Append(string.Join(", ", Levels.Voices(p))).Append(" (voix féminines et masculines).\n");

        if (timeless)
        {
            sb.Append("\nCours intemporel (hors actualité) : pas d'outil web, ni menu, ni source ; sources et facts vides.\n");
            sb.Append("\nChoisissez un thème intemporel porteur et rendez la fiche du cours.");
            return sb.ToString();
        }

        var audio = LJ.Objects(menu, "audio").ToList();
        if (audio.Count > 0)
        {
            sb.Append("\nÉpisodes audio authentiques récents (bonus possible ; adresses à recopier exactement) :\n");
            foreach (var a in audio)
            {
                var published = NewsMenu.ParseDate(LJ.Str(a, "published", 40));
                sb.Append("- [").Append(LJ.Str(a, "series", 80)).Append(", ")
                  .Append(published?.ToLocalTime().ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) ?? "").Append(", ")
                  .Append(LJ.Str(a, "level", 10)).Append(", ").Append(LJ.Int(a, "minutes")).Append(" min] ")
                  .Append(LJ.Str(a, "title", 200)).Append(" — ").Append(LJ.Str(a, "summary", 300))
                  .Append(" — mp3 : ").Append(LJ.Str(a, "mp3", 400)).Append(" — page : ").Append(LJ.Str(a, "page", 400)).Append('\n');
            }
        }

        var items = LJ.Objects(menu, "items").ToList();
        if (items.Count > 0)
        {
            sb.Append("\nMenu du jour (titres des dernières 48 heures ; l'adresse n'est donnée que si WebFetch peut lire la page ; « non lisible » : à lire sur une autre rédaction ; « lourd » : sujet grave, à n'aborder que sous un angle constructif) :\n");
            foreach (var item in items)
            {
                var readable = LJ.Bool(item, "readable");
                var published = NewsMenu.ParseDate(LJ.Str(item, "published", 40));
                sb.Append("- [").Append(LJ.Str(item, "source", 60));
                if (!readable)
                {
                    sb.Append(", non lisible");
                }

                if (LJ.Bool(item, "heavy"))
                {
                    sb.Append(", lourd");
                }

                sb.Append(", ").Append(published?.ToLocalTime().ToString("MM-dd HH:mm", CultureInfo.InvariantCulture) ?? "").Append("] ")
                  .Append(LJ.Str(item, "title", 240));
                if (readable)
                {
                    sb.Append(" — ").Append(LJ.Str(item, "url", 400));
                }

                sb.Append('\n');
            }
        }
        else
        {
            sb.Append("\nMenu du jour indisponible : trouvez l'actualité du jour avec WebSearch (deux recherches au plus), puis lisez une ou deux pages avec WebFetch.\n");
        }

        sb.Append("\nChoisissez un sujet porteur, lisez une ou deux sources, et rendez la fiche du cours.");
        return sb.ToString();
    }

    public static JsonObject Sanitize(JsonObject o, LearnRequest r, JsonObject? menu, HostLog log)
    {
        var p = r.Params;
        var minutes = Minutes(r);
        var level = Levels.Normalize(LJ.Str(o, "level", 10), Levels.Normalize(LJ.Str(p, "level", 10)));
        var voices = Levels.Voices(p);
        var timeless = LJ.Bool(p, "timeless");
        var imposed = LJ.Str(LJ.Obj(p, "topic"), "title", 200).Length > 0;

        // Sources : https, pas un site ferme a WebFetch (l'agent n'a pas pu le lire), date relevee.
        var sources = new JsonArray();
        var remap = new Dictionary<int, int>();
        if (!timeless)
        {
            foreach (var (index, s) in LJ.Indexed(o, "sources"))
            {
                var url = LJ.Https(LJ.Str(s, "url", 2000));
                if (url.Length == 0 || NewsMenu.IsBlocked(url))
                {
                    log.Warn("Revizator lesson : source ecartee (" + LearningAgent.Ascii(LJ.Str(s, "url", 200)) + ").");
                    continue;
                }

                var published = DateOnly(LJ.Str(s, "published", 40));
                if (published is { } day && (DateTime.Now.Date - day).TotalDays > (imposed ? 14 : 7))
                {
                    log.Warn($"Revizator lesson : source datee du {day:yyyy-MM-dd}, au-dela de {(imposed ? 14 : 7)} jours ({LearningAgent.Ascii(url)}).");
                }

                remap[index] = sources.Count;
                sources.Add(new JsonObject
                {
                    ["title"] = LJ.Str(s, "title", 300),
                    ["url"] = url,
                    ["outlet"] = LJ.Str(s, "outlet", 120),
                    ["published"] = published?.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) ?? LJ.Str(s, "published", 20),
                });
            }
        }

        var facts = new JsonArray();
        foreach (var f in LJ.Objects(o, "facts"))
        {
            var fact = LJ.Str(f, "fact", 400);
            if (fact.Length > 0 && remap.TryGetValue(LJ.Int(f, "source", -1), out var source) && facts.Count < 30)
            {
                facts.Add(new JsonObject { ["fact"] = fact, ["source"] = source });
            }
        }

        // Lecture.
        var reading = LJ.Obj(o, "reading");
        var paragraphs = LJ.Strings(reading, "paragraphs", 14, 2500);
        var glossary = new JsonArray();
        var seenTerms = new HashSet<string>(StringComparer.Ordinal);
        foreach (var g in LJ.Objects(reading, "glossary"))
        {
            var term = LJ.Str(g, "term", 80);
            if (term.Length == 0 || !seenTerms.Add(LJ.Key(term)) || glossary.Count >= 16)
            {
                continue;
            }

            glossary.Add(new JsonObject
            {
                ["term"] = term,
                ["pos"] = LJ.Pick(LJ.Str(g, "pos", 30), Pos, "other"),
                ["ipa"] = LJ.Str(g, "ipa", 80),
                ["meaningEn"] = LJ.Str(g, "meaningEn", 300),
                ["meaningFr"] = LJ.Str(g, "meaningFr", 300),
                ["example"] = LJ.Str(g, "example", 300),
            });
        }

        if (paragraphs.Count == 0)
        {
            throw new InvalidOperationException("Le cours généré n’a pas de texte de lecture.");
        }

        var readingText = string.Join(" ", paragraphs);

        // Ecoute : locuteurs connus, accents disponibles, repliques sans didascalies.
        var listening = LJ.Obj(o, "listening");
        var speakers = new JsonArray();
        var ids = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var names = new List<string>();
        foreach (var s in LJ.Objects(listening, "speakers"))
        {
            var id = LJ.Str(s, "id", 10);
            if (id.Length == 0 || ids.ContainsKey(id) || speakers.Count >= 6)
            {
                continue;
            }

            var name = LJ.Str(s, "name", 60);
            ids[id] = id;
            if (name.Length > 0)
            {
                ids.TryAdd(name, id);
                names.Add(name);
            }

            names.Add(id);
            speakers.Add(new JsonObject
            {
                ["id"] = id,
                ["name"] = name,
                ["role"] = LJ.Str(s, "role", 120),
                ["accent"] = Levels.Accent(LJ.Str(s, "accent", 10), voices),
                ["gender"] = LJ.Pick(LJ.Str(s, "gender", 10), new[] { "female", "male" }, speakers.Count % 2 == 0 ? "female" : "male"),
            });
        }

        var lines = new JsonArray();
        foreach (var l in LJ.Objects(listening, "lines"))
        {
            if (!ids.TryGetValue(LJ.Str(l, "speaker", 60), out var speaker))
            {
                continue;
            }

            var text = Speech.Clean(LJ.Str(l, "text", 2000), names);
            if (text.Length > 0 && lines.Count < 80)
            {
                lines.Add(new JsonObject { ["speaker"] = speaker, ["text"] = text });
            }
        }

        var listeningQuestions = Questions(listening, "questions");
        var hasListening = lines.Count > 0;

        // Ecoute authentique : seulement un episode de la liste fournie, adresses reprises du menu.
        var authentic = AuthenticAudio(LJ.Obj(o, "authenticAudio"), menu, timeless);
        var hasAudio = LJ.Str(authentic, "audioUrl").Length > 0;

        var vocabulary = new JsonArray();
        foreach (var v in LJ.Objects(o, "vocabulary"))
        {
            var items = new JsonArray();
            foreach (var item in LJ.Objects(v, "items"))
            {
                var prompt = LJ.Str(item, "prompt", 600);
                var answer = LJ.Str(item, "answer", 400);
                var options = LJ.Strings(item, "options", 8, 200).Distinct().ToList();
                if (prompt.Length == 0 || answer.Length == 0)
                {
                    continue;
                }

                if (options.Count > 0)
                {
                    var match = Match(options, answer);
                    if (match is null)
                    {
                        continue;
                    }

                    answer = match;
                }

                items.Add(new JsonObject
                {
                    ["prompt"] = prompt,
                    ["options"] = LJ.Array(options),
                    ["answer"] = answer,
                    ["explanationFr"] = LJ.Str(item, "explanationFr", 800),
                });
            }

            if (items.Count > 0 && vocabulary.Count < 6)
            {
                vocabulary.Add(new JsonObject
                {
                    ["kind"] = LJ.Pick(LJ.Str(v, "kind", 30), VocabularyKinds, "gap_fill"),
                    ["instructionFr"] = LJ.Str(v, "instructionFr", 400),
                    ["items"] = items,
                });
            }
        }

        var grammar = LJ.Obj(o, "grammar");
        var grammarItems = new JsonArray();
        foreach (var item in LJ.Objects(grammar, "items"))
        {
            var prompt = LJ.Str(item, "prompt", 500);
            var answer = LJ.Str(item, "answer", 300);
            if (prompt.Length > 0 && answer.Length > 0 && grammarItems.Count < 12)
            {
                grammarItems.Add(new JsonObject { ["prompt"] = prompt, ["answer"] = answer });
            }
        }

        var grammarPoint = LJ.Str(grammar, "point", 160);
        var hasGrammar = grammarPoint.Length > 0 && grammarItems.Count > 0;

        var writing = LJ.Obj(o, "writing");
        var words = LJ.Int(writing, "words");
        if (words < 20 || words > 600)
        {
            words = minutes switch { 10 => 30, 20 => 75, 30 => 120, _ => 175 };
        }

        var speaking = LJ.Obj(o, "speaking");
        var pronunciation = new JsonArray();
        foreach (var w in LJ.Objects(speaking, "pronunciation"))
        {
            var word = LJ.Str(w, "word", 60);
            if (word.Length > 0 && pronunciation.Count < 5)
            {
                pronunciation.Add(new JsonObject { ["word"] = word, ["ipa"] = LJ.Str(w, "ipa", 80), ["tipFr"] = LJ.Str(w, "tipFr", 300) });
            }
        }

        var cards = new JsonArray();
        var seenCards = new HashSet<string>(StringComparer.Ordinal);
        foreach (var c in LJ.Objects(o, "cards"))
        {
            var front = LJ.Str(c, "front", 300);
            var back = LJ.Str(c, "back", 300);
            if (front.Length == 0 || back.Length == 0 || !seenCards.Add(LJ.Key(front)) || cards.Count >= 20)
            {
                continue;
            }

            cards.Add(new JsonObject
            {
                ["kind"] = LJ.Pick(LJ.Str(c, "kind", 20), CardKinds, "word"),
                ["front"] = front,
                ["back"] = back,
                ["example"] = LJ.Str(c, "example", 300),
            });
        }

        var next = new JsonArray();
        foreach (var t in LJ.Objects(o, "nextTopics"))
        {
            var title = LJ.Str(t, "title", 160);
            if (title.Length > 0 && next.Count < 3)
            {
                next.Add(new JsonObject
                {
                    ["title"] = title,
                    ["pitchFr"] = LJ.Str(t, "pitchFr", 400),
                    ["rubric"] = LJ.Pick(LJ.Str(t, "rubric", 30), Rubrics, "society"),
                    ["tone"] = LJ.Pick(LJ.Str(t, "tone", 20), Tones, "light"),
                    ["query"] = LJ.Str(t, "query", 200),
                });
            }
        }

        // Plan : etapes connues dont le bloc existe, somme egale a la duree demandee.
        var present = new HashSet<string>(StringComparer.Ordinal) { "warmup", "reading", "vocabulary", "writing", "speaking", "review" };
        if (hasListening)
        {
            present.Add("listening");
        }

        if (hasAudio)
        {
            present.Add("authenticAudio");
        }

        if (hasGrammar)
        {
            present.Add("grammar");
        }

        var plan = Plan(LJ.Objects(o, "plan"), minutes, present);
        var rubric = LJ.Pick(LJ.Str(o, "rubric", 30), Rubrics, "society");
        var avoid = LJ.Strings(p, "avoidRubrics", 6, 30);
        if (!imposed && avoid.Any(a => string.Equals(a, rubric, StringComparison.OrdinalIgnoreCase)))
        {
            log.Warn($"Revizator lesson : rubrique {rubric} choisie alors qu'elle etait a eviter.");
        }

        return new JsonObject
        {
            ["title"] = LJ.Str(o, "title", 200),
            ["summaryFr"] = LJ.Str(o, "summaryFr", 600),
            ["level"] = level,
            ["minutes"] = minutes,
            ["rubric"] = rubric,
            ["tone"] = LJ.Pick(LJ.Str(o, "tone", 20), Tones, "balanced"),
            ["keywords"] = LJ.Array(LJ.Strings(o, "keywords", 8, 60)),
            ["plan"] = plan,
            ["sources"] = sources,
            ["facts"] = facts,
            ["warmup"] = LJ.Array(LJ.Strings(o, "warmup", 4, 300)),
            ["reading"] = new JsonObject
            {
                ["headline"] = LJ.Str(reading, "headline", 200),
                ["standfirst"] = LJ.Str(reading, "standfirst", 400),
                ["paragraphs"] = LJ.Array(paragraphs),
                ["credit"] = timeless ? "Written for learners by Organizator" : LJ.Str(reading, "credit", 300),
                ["glossary"] = glossary,
            },
            ["comprehension"] = Questions(o, "comprehension"),
            ["listening"] = new JsonObject
            {
                ["format"] = LJ.Pick(LJ.Str(listening, "format", 20), Formats, "dialogue"),
                ["title"] = LJ.Str(listening, "title", 200),
                ["contextFr"] = LJ.Str(listening, "contextFr", 600),
                ["speakers"] = speakers,
                ["lines"] = lines,
                ["questions"] = listeningQuestions,
            },
            ["authenticAudio"] = authentic,
            ["vocabulary"] = vocabulary,
            ["grammar"] = new JsonObject
            {
                ["point"] = hasGrammar ? grammarPoint : "",
                ["explanationFr"] = hasGrammar ? LJ.Str(grammar, "explanationFr", 1500) : "",
                ["examples"] = LJ.Array(hasGrammar ? LJ.Strings(grammar, "examples", 6, 300) : new List<string>()),
                ["items"] = hasGrammar ? grammarItems : new JsonArray(),
            },
            ["writing"] = new JsonObject
            {
                ["taskFr"] = LJ.Str(writing, "taskFr", 800),
                ["genre"] = LJ.Pick(LJ.Str(writing, "genre", 20), Genres, "message"),
                ["words"] = words,
                ["language"] = LJ.Array(LJ.Strings(writing, "language", 8, 200)),
                ["criteria"] = LJ.Array(LJ.Strings(writing, "criteria", 5, 300)),
                ["modelAnswer"] = LJ.Str(writing, "modelAnswer", 3000),
            },
            ["speaking"] = new JsonObject
            {
                ["taskFr"] = LJ.Str(speaking, "taskFr", 800),
                ["prompts"] = LJ.Array(LJ.Strings(speaking, "prompts", 6, 300)),
                ["prepSeconds"] = Math.Clamp(LJ.Int(speaking, "prepSeconds", 30), 0, 300),
                ["speakSeconds"] = Math.Clamp(LJ.Int(speaking, "speakSeconds", 60), 15, 300),
                ["language"] = LJ.Array(LJ.Strings(speaking, "language", 8, 200)),
                ["pronunciation"] = pronunciation,
                ["modelAnswer"] = LJ.Str(speaking, "modelAnswer", 3000),
            },
            ["cards"] = cards,
            ["nextTopics"] = next,
            ["readingWords"] = LJ.Words(readingText),
            ["menuAt"] = MenuAt(menu),
        };
    }

    private static long MenuAt(JsonObject? menu)
        => (long)LJ.Num(menu, "fetchedAt");

    /// <summary>Questions de comprehension : une seule bonne reponse, presente dans les options, options melangees.</summary>
    private static JsonArray Questions(JsonNode? node, string key)
    {
        var list = new JsonArray();
        foreach (var q in LJ.Objects(node, key))
        {
            var question = LJ.Str(q, "question", 600);
            var answer = LJ.Str(q, "answer", 400);
            var kind = LJ.Pick(LJ.Str(q, "kind", 20), QuestionKinds, "choice");
            var options = LJ.Strings(q, "options", 6, 300).Distinct().ToList();
            if (question.Length == 0 || list.Count >= 12)
            {
                continue;
            }

            if (kind == "true_false")
            {
                var truth = TrueFalse(answer);
                if (truth is null)
                {
                    continue;
                }

                options = new List<string> { "True", "False" };
                answer = truth;
            }
            else if (kind == "choice" && options.Count >= 2)
            {
                var match = Match(options, answer);
                if (match is null)
                {
                    continue;
                }

                LJ.Shuffle(options);
                answer = match;
            }
            else
            {
                kind = "open";
                options = new List<string>();
                if (answer.Length == 0)
                {
                    continue;
                }
            }

            list.Add(new JsonObject
            {
                ["kind"] = kind,
                ["skill"] = LJ.Pick(LJ.Str(q, "skill", 20), Skills, "detail"),
                ["question"] = question,
                ["options"] = LJ.Array(options),
                ["answer"] = answer,
                ["explanationFr"] = LJ.Str(q, "explanationFr", 800),
            });
        }

        return list;
    }

    /// <summary>L'option qui correspond a la reponse (texte tolerant, ou lettre A-F), sinon <c>null</c>.</summary>
    internal static string? Match(IReadOnlyList<string> options, string answer)
    {
        var key = LJ.Key(answer);
        var exact = options.FirstOrDefault(o => LJ.Key(o) == key);
        if (exact is not null)
        {
            return exact;
        }

        var letter = Regex.Match(answer.Trim(), @"^\(?([A-Fa-f])[\).:]?$");
        if (letter.Success)
        {
            var index = char.ToUpperInvariant(letter.Groups[1].Value[0]) - 'A';
            return index < options.Count ? options[index] : null;
        }

        // « B) to attend » ou « to attend. »
        var stripped = LJ.Key(Regex.Replace(answer, @"^\(?[A-Fa-f][\).:]\s*", ""));
        return options.FirstOrDefault(o => LJ.Key(Regex.Replace(o, @"^\(?[A-Fa-f][\).:]\s*", "")) == stripped);
    }

    private static string? TrueFalse(string answer) => LJ.Key(answer) switch
    {
        "true" or "vrai" or "yes" or "t" => "True",
        "false" or "faux" or "no" or "f" => "False",
        _ => null,
    };

    private static JsonObject AuthenticAudio(JsonObject? a, JsonObject? menu, bool timeless)
    {
        var empty = new JsonObject
        {
            ["title"] = "",
            ["outlet"] = "",
            ["audioUrl"] = "",
            ["pageUrl"] = "",
            ["published"] = "",
            ["taskFr"] = "",
            ["questions"] = new JsonArray(),
        };

        var url = LJ.Https(LJ.Str(a, "audioUrl", 2000));
        if (timeless || url.Length == 0)
        {
            return empty;
        }

        var episode = LJ.Objects(menu, "audio").FirstOrDefault(e => string.Equals(LJ.Str(e, "mp3", 2000), url, StringComparison.Ordinal));
        if (episode is null)
        {
            return empty;
        }

        var published = NewsMenu.ParseDate(LJ.Str(episode, "published", 40));
        return new JsonObject
        {
            ["title"] = LJ.Str(episode, "title", 200),
            ["outlet"] = LJ.Str(episode, "series", 120),
            ["audioUrl"] = url,
            ["pageUrl"] = LJ.Str(episode, "page", 2000),
            ["published"] = published?.ToLocalTime().ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) ?? "",
            ["taskFr"] = LJ.Str(a, "taskFr", 600),
            ["questions"] = LJ.Array(LJ.Strings(a, "questions", 6, 300)),
        };
    }

    /// <summary>Plan nettoye : etapes connues et presentes, minutes positives, somme egale a la duree.</summary>
    private static JsonArray Plan(IEnumerable<JsonObject> given, int minutes, HashSet<string> present)
    {
        var steps = new List<(string Step, int Minutes)>();
        foreach (var p in given)
        {
            var step = LJ.Pick(LJ.Str(p, "step", 30), Steps, "");
            var m = LJ.Int(p, "minutes");
            if (step.Length > 0 && present.Contains(step) && m > 0 && steps.Count < 12)
            {
                steps.Add((step, Math.Min(m, minutes)));
            }
        }

        if (steps.Count == 0)
        {
            steps = minutes switch
            {
                10 => new() { ("warmup", 1), ("reading", 3), ("listening", 3), ("vocabulary", 2), ("speaking", 1) },
                20 => new() { ("warmup", 2), ("reading", 4), ("listening", 4), ("vocabulary", 3), ("grammar", 3), ("writing", 2), ("speaking", 2) },
                30 => new() { ("warmup", 2), ("reading", 6), ("listening", 6), ("vocabulary", 4), ("grammar", 4), ("writing", 4), ("speaking", 3), ("review", 1) },
                _ => new() { ("warmup", 3), ("reading", 8), ("listening", 8), ("vocabulary", 6), ("grammar", 6), ("writing", 7), ("speaking", 5), ("review", 2) },
            };
            steps = steps.Where(s => present.Contains(s.Step)).ToList();
        }

        var sum = steps.Sum(s => s.Minutes);
        if (sum != minutes && steps.Count > 0)
        {
            // La plus longue etape absorbe l'ecart ; si elle ne le peut pas, tout est mis a l'echelle.
            var largest = steps.IndexOf(steps.OrderByDescending(s => s.Minutes).First());
            var adjusted = steps[largest].Minutes + (minutes - sum);
            if (adjusted >= 1)
            {
                steps[largest] = (steps[largest].Step, adjusted);
            }
            else
            {
                steps = steps.Select(s => (s.Step, Math.Max(1, (int)Math.Round(s.Minutes * (double)minutes / sum)))).ToList();
                var rest = minutes - steps.Sum(s => s.Minutes);
                var top = steps.IndexOf(steps.OrderByDescending(s => s.Minutes).First());
                steps[top] = (steps[top].Step, Math.Max(1, steps[top].Minutes + rest));
            }
        }

        var plan = new JsonArray();
        foreach (var (step, m) in steps)
        {
            plan.Add(new JsonObject { ["step"] = step, ["minutes"] = m });
        }

        return plan;
    }

    private static DateTime? DateOnly(string text)
    {
        if (DateTime.TryParseExact(text.Trim(), "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var day))
        {
            return day;
        }

        return NewsMenu.ParseDate(text)?.ToLocalTime().Date;
    }
}

// ============================================================================ exercices

/// <summary>
/// Serie d'exercices a la demande (<c>exercise</c>, spec §5.3) : un type (<c>read.article</c>,
/// <c>listen.dictation</c>...) ou libre, une competence, une duree de 5 a 15 minutes.
/// </summary>
internal static class ExerciseGenre
{
    public static readonly string[] Types =
    {
        "read.article", "read.speed", "read.errors", "listen.dialogue", "listen.partial_dictation", "listen.dictation",
        "listen.minimal_pairs", "write.translate", "write.pro_message", "write.free", "speak.shadowing", "speak.read_aloud",
        "speak.minute", "speak.tech", "lang.false_friends", "lang.tenses", "lang.prepositions", "lang.collocations",
        "lang.weak_points", "pron.stress", "pron.minimal_pairs",
    };

    private static readonly string[] SkillsList = { "read", "listen", "write", "speak", "lang", "pron" };

    private static readonly string[] ItemKinds =
    {
        "choice", "truefalse", "gap", "transform", "translate", "order", "error_spot", "dictation", "partial_dictation",
        "minimal_pair", "stress", "shadow", "read_aloud", "open_write", "open_speak",
    };

    private const string System = """
        Tu es le professeur d'anglais d'Organizator. Tu prépares une série d'exercices à la demande pour un adulte francophone, et tu rends uniquement la fiche demandée. Le contenu d'apprentissage est en anglais ; les consignes (instructionsFr, promptFr) sont en français, en vouvoyant l'utilisateur.

        Principes
        - Visez environ 80 % de réussite au niveau indiqué : ni trop facile, ni piégeux. Une seule bonne réponse par item, sans ambiguïté ; les distracteurs sont plausibles et de même nature (même catégorie grammaticale, même longueur).
        - Ciblez les difficultés typiques d'un francophone : present perfect et prétérit, for / since / ago, futur après when, questions avec auxiliaire, articles génériques, indénombrables (information, advice, feedback, software), prépositions calquées (depend on, listen to, arrive in), faux amis (actually, eventually, sensible, library, assist, control), ordre des mots, -s de la troisième personne, -ed, accent de mot, h, voyelles longues et brèves.
        - Des phrases naturelles et utiles dans la vie réelle et au travail (développement logiciel compris), jamais des phrases de manuel artificielles. Variez les situations, les personnes et les registres d'un item à l'autre.
        - explanationFr dit en une ou deux phrases pourquoi la réponse est juste ; pour un piège de francophone, ce qu'on dirait en français et pourquoi l'anglais diffère. Les options sont mélangées après coup : ne désigne jamais une option par sa position ni par une lettre, cite son texte.
        - Ce qui sera lu par la synthèse vocale (audioText, script.lines) : ni didascalie, ni émoticône, ni balise, ni nom de locuteur dans le texte.

        Champs d'un item selon kind (les champs sans objet : chaîne vide, liste vide, 0)
        - choice : prompt = la question ou la phrase, en anglais ; options = 3 ou 4 choix ; answer = le texte exact de la bonne option.
        - truefalse : prompt = une affirmation sur le texte ou l'écoute ; answer = true, false ou not_given ; options vide.
        - gap : prompt = la phrase avec ___ à la place du mot ou du groupe manquant ; answer ; accepted = les autres réponses justes ; promptFr = un indice éventuel (traduction, verbe à conjuguer entre parenthèses).
        - transform : promptFr = la consigne (« Réécrivez avec for ») ; prompt = la phrase de départ ; answer ; accepted.
        - translate : promptFr = la phrase française à traduire ; answer = la traduction de référence ; accepted = d'autres traductions justes.
        - order : options = les fragments de la phrase (3 à 7) ; answer = la phrase correcte.
        - error_spot : prompt = une phrase qui contient UNE erreur typique de francophone ; answer = la phrase corrigée ; explanationFr.
        - dictation : audioText = la phrase entendue ; answer = la même phrase.
        - partial_dictation : audioText = la phrase entendue ; prompt = la même phrase avec ___ à la place de un à trois mots ; answer = les mots manquants, dans l'ordre, séparés par « | ».
        - minimal_pair : words = [mot A, mot B] ; audioText = une phrase-cadre neutre qui contient le mot prononcé (« Now I say sheep again. ») ; answer = ce mot.
        - stress : prompt = le mot ; options = ses syllabes, dans l'ordre (« de », « vel », « op », « ment ») ; answer = l'indice, en chiffre, de la syllabe accentuée (0 = la première).
        - shadow : audioText = la phrase à répéter.
        - read_aloud : prompt = le texte à lire à voix haute.
        - open_write : promptFr = la tâche, avec la longueur attendue en mots ; criteria = 3 ou 4 critères de réussite, en français ; modelAnswer = une réponse modèle au niveau visé ; seconds = le temps conseillé (0 = libre).
        - open_speak : promptFr = la tâche ; seconds = le temps de parole ; criteria ; modelAnswer.

        Les types de séries (type)
        - read.article : passage (titre, 3 à 5 paragraphes, 150 à 350 mots selon la durée et le niveau, glossaire de 5 à 8 mots) et des questions choice et truefalse : sens général, détail, inférence, vocabulaire en contexte.
        - read.speed : passage facile (un niveau sous le niveau visé, 250 à 450 mots, glossaire vide) à lire vite, et 5 à 8 truefalse.
        - read.errors : des items error_spot, phrases d'un même message réaliste (e-mail, compte rendu) qui contiennent chacune une erreur typique.
        - listen.dialogue : script (dialogue naturel de deux ou trois personnes, 120 à 300 mots selon la durée, contractions et marqueurs de l'oral) et des questions choice et truefalse sur ce qu'on entend.
        - listen.partial_dictation : des items partial_dictation ; trous sur les mots grammaticaux, formes faibles et contractions (we've, there's, could have…).
        - listen.dictation : des items dictation, phrases naturelles de 8 à 16 mots.
        - listen.minimal_pairs et pron.minimal_pairs : des items minimal_pair sur les contrastes difficiles pour un francophone (ship / sheep, full / fool, hat / hut, hair / air, walked / wanted…) ; variez le mot entendu.
        - write.translate : des items translate : phrases françaises pièges (faux amis, durée et present perfect, articles génériques, indénombrables, prépositions).
        - write.pro_message : un item open_write : message professionnel réaliste (rôle, destinataire, situation, trois points à couvrir, longueur en mots).
        - write.free : un item open_write : écriture libre chronométrée (seconds de 300 à 600) sur un sujet personnel ou d'actualité.
        - speak.shadowing : des items shadow : phrases de parole naturelle de 6 à 14 mots, au rythme et aux liaisons typiques.
        - speak.read_aloud : un ou deux items read_aloud : courts paragraphes (40 à 90 mots) riches en mots difficiles pour un francophone.
        - speak.minute : un à trois items open_speak : parler 60 secondes sur une question personnelle ou d'actualité.
        - speak.tech : un ou deux items open_speak : expliquer en 90 secondes à un collègue anglophone un sujet technique (un bug, une décision d'architecture, un outil).
        - lang.false_friends : des items choice, gap ou translate sur les faux amis.
        - lang.tenses : des items gap, transform et choice sur les temps (present perfect et prétérit, durée avec for / since / ago, futur après when / as soon as, présent simple et continu).
        - lang.prepositions : des items gap et choice sur les prépositions calquées du français.
        - lang.collocations : des items choice et gap sur make / do / take / have et les associations fréquentes.
        - lang.weak_points : des items variés (gap, transform, error_spot, translate) sur les points faibles indiqués.
        - pron.stress : des items stress sur des mots (souvent des cognats) dont l'accent tonique piège un francophone (development, photograph, comfortable, event, hotel…).

        passage n'est rempli que pour read.article et read.speed ; script que pour listen.dialogue (sinon titre vide, listes vides).
        """;

    private const string Schema = """
        {"type":"object","additionalProperties":false,"required":["type","title","instructionsFr","topic","passage","script","items"],
        "properties":{
        "type":{"type":"string","enum":@TYPES@},
        "title":{"type":"string","description":"Titre court de la série, en anglais"},
        "instructionsFr":{"type":"string","description":"Consigne générale, en français"},
        "topic":{"type":"string","description":"Thème, en quelques mots"},
        "passage":{"type":"object","additionalProperties":false,"required":["title","paragraphs","glossary"],"properties":{
          "title":{"type":"string"},"paragraphs":{"type":"array","items":{"type":"string"}},
          "glossary":{"type":"array","items":{"type":"object","additionalProperties":false,"required":["term","meaningFr","meaningEn","example"],"properties":{"term":{"type":"string"},"meaningFr":{"type":"string"},"meaningEn":{"type":"string"},"example":{"type":"string"}}}}}},
        "script":{"type":"object","additionalProperties":false,"required":["title","contextFr","speakers","lines"],"properties":{
          "title":{"type":"string"},"contextFr":{"type":"string","description":"Ce que l'utilisateur sait avant d'écouter"},
          "speakers":{"type":"array","items":{"type":"object","additionalProperties":false,"required":["id","name","accent","gender"],"properties":{"id":{"type":"string","description":"A, B, C"},"name":{"type":"string"},"accent":{"type":"string","enum":["en-US","en-GB","en-AU","en-CA","en-IE","en-IN"]},"gender":{"type":"string","enum":["female","male"]}}}},
          "lines":{"type":"array","items":{"type":"object","additionalProperties":false,"required":["speaker","text"],"properties":{"speaker":{"type":"string","description":"id d'un speaker"},"text":{"type":"string"}}}}}},
        "items":{"type":"array","items":{"type":"object","additionalProperties":false,
          "required":["kind","prompt","promptFr","options","answer","accepted","explanationFr","audioText","words","seconds","criteria","modelAnswer"],
          "properties":{"kind":{"type":"string","enum":@KINDS@},"prompt":{"type":"string"},"promptFr":{"type":"string"},
          "options":{"type":"array","items":{"type":"string"}},"answer":{"type":"string"},"accepted":{"type":"array","items":{"type":"string"}},
          "explanationFr":{"type":"string"},"audioText":{"type":"string"},"words":{"type":"array","items":{"type":"string"}},
          "seconds":{"type":"integer"},"criteria":{"type":"array","items":{"type":"string"}},"modelAnswer":{"type":"string"}}}}}}
        """;

    private static readonly string CompactSchema = Compact(Schema
        .Replace("@TYPES@", "[" + string.Join(",", Types.Select(t => "\"" + t + "\"")) + "]")
        .Replace("@KINDS@", "[" + string.Join(",", ItemKinds.Select(t => "\"" + t + "\"")) + "]"));

    internal static string Compact(string json) => JsonNode.Parse(json)!.ToJsonString();

    private static int Minutes(LearnRequest r)
    {
        var wanted = LJ.Int(r.Params, "minutes", 10);
        return new[] { 5, 10, 15 }.OrderBy(m => Math.Abs(m - wanted)).First();
    }

    private static string Type(LearnRequest r) => LJ.Pick(LJ.Str(r.Params, "type", 40), Types, "");

    private static string Skill(LearnRequest r, string type)
    {
        var skill = LJ.Pick(LJ.Str(r.Params, "skill", 20), SkillsList, "");
        if (skill.Length > 0)
        {
            return skill;
        }

        return type.Length > 0 ? type[..type.IndexOf('.')] : "lang";
    }

    public static AgentCall Compose(LearnRequest r)
    {
        var p = r.Params;
        var type = Type(r);
        var skill = Skill(r, type);
        var minutes = Minutes(r);
        var level = Levels.Normalize(LJ.Str(p, "level", 10));
        var focus = LJ.Str(p, "focus", 400);
        var topic = LJ.Str(p, "topic", 200);
        var count = minutes switch { 5 => 6, 10 => 10, _ => 14 };

        var sb = new StringBuilder();
        sb.Append("Série demandée : ")
          .Append(type.Length > 0 ? "type " + type : $"type libre (choisissez celui de la compétence « {skill} » qui sert le mieux le point visé)")
          .Append(" ; compétence : ").Append(skill).Append(" ; durée : ").Append(minutes)
          .Append(" minutes (environ ").Append(count).Append(" items ; pour read.article et listen.dialogue, comptez le temps de lecture ou d'écoute : ")
          .Append(minutes switch { 5 => "4", 10 => "6", _ => "8" }).Append(" questions ; une tâche ouverte vaut cinq minutes environ).\n");
        sb.Append(Levels.Line(level)).Append('\n');
        sb.Append(Levels.ExplainRule(level, LJ.Str(p, "explain", 10))).Append('\n');
        sb.Append("Point visé : ").Append(focus.Length > 0 ? focus : "aucun en particulier").Append(".\n");
        sb.Append("Thème : ").Append(topic.Length > 0 ? topic : "libre (concret, varié, utile au quotidien ou au travail)").Append(".\n");
        sb.Append("Voix disponibles pour l'écoute : ").Append(string.Join(", ", Levels.Voices(p))).Append(" (variez les accents).\n");
        if (r.Context.Length > 0)
        {
            sb.Append("\nCe que l'on sait de l'apprenant :\n").Append(r.Context.Trim()).Append('\n');
        }

        sb.Append("\nRendez la fiche de la série.");
        return new AgentCall("", System + Levels.Quotes, CompactSchema, sb.ToString());
    }

    public static JsonObject Sanitize(JsonObject o, LearnRequest r)
    {
        var p = r.Params;
        var type = Type(r);
        if (type.Length == 0)
        {
            type = LJ.Pick(LJ.Str(o, "type", 40), Types, "");
        }

        var skill = Skill(r, type);
        var level = Levels.Normalize(LJ.Str(p, "level", 10));
        var voices = Levels.Voices(p);

        var passage = LJ.Obj(o, "passage");
        var glossary = new JsonArray();
        foreach (var g in LJ.Objects(passage, "glossary"))
        {
            var term = LJ.Str(g, "term", 80);
            if (term.Length > 0 && glossary.Count < 12)
            {
                glossary.Add(new JsonObject
                {
                    ["term"] = term,
                    ["meaningFr"] = LJ.Str(g, "meaningFr", 300),
                    ["meaningEn"] = LJ.Str(g, "meaningEn", 300),
                    ["example"] = LJ.Str(g, "example", 300),
                });
            }
        }

        var paragraphs = LJ.Strings(passage, "paragraphs", 12, 2500);

        var script = LJ.Obj(o, "script");
        var speakers = new JsonArray();
        var ids = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var names = new List<string>();
        foreach (var s in LJ.Objects(script, "speakers"))
        {
            var id = LJ.Str(s, "id", 10);
            if (id.Length == 0 || ids.ContainsKey(id) || speakers.Count >= 4)
            {
                continue;
            }

            var name = LJ.Str(s, "name", 60);
            ids[id] = id;
            if (name.Length > 0)
            {
                ids.TryAdd(name, id);
                names.Add(name);
            }

            names.Add(id);
            speakers.Add(new JsonObject
            {
                ["id"] = id,
                ["name"] = name,
                ["accent"] = Levels.Accent(LJ.Str(s, "accent", 10), voices),
                ["gender"] = LJ.Pick(LJ.Str(s, "gender", 10), new[] { "female", "male" }, speakers.Count % 2 == 0 ? "female" : "male"),
            });
        }

        var lines = new JsonArray();
        foreach (var l in LJ.Objects(script, "lines"))
        {
            if (ids.TryGetValue(LJ.Str(l, "speaker", 60), out var speaker))
            {
                var text = Speech.Clean(LJ.Str(l, "text", 2000), names);
                if (text.Length > 0 && lines.Count < 60)
                {
                    lines.Add(new JsonObject { ["speaker"] = speaker, ["text"] = text });
                }
            }
        }

        var items = new JsonArray();
        foreach (var item in LJ.Objects(o, "items"))
        {
            if (Item(item) is { } clean && items.Count < 30)
            {
                clean["id"] = "i" + (items.Count + 1).ToString(CultureInfo.InvariantCulture);
                items.Add(Ordered(clean));
            }
        }

        if (items.Count == 0)
        {
            throw new InvalidOperationException("La série générée ne contient aucun exercice utilisable.");
        }

        var topic = LJ.Str(o, "topic", 200);
        return new JsonObject
        {
            ["skill"] = skill,
            ["type"] = type,
            ["title"] = LJ.Str(o, "title", 200),
            ["level"] = level,
            ["minutes"] = Minutes(r),
            ["instructionsFr"] = LJ.Str(o, "instructionsFr", 800),
            ["topic"] = topic.Length > 0 ? topic : LJ.Str(p, "topic", 200),
            ["passage"] = new JsonObject
            {
                ["title"] = paragraphs.Count > 0 ? LJ.Str(passage, "title", 200) : "",
                ["paragraphs"] = LJ.Array(paragraphs),
                ["glossary"] = paragraphs.Count > 0 ? glossary : new JsonArray(),
            },
            ["script"] = new JsonObject
            {
                ["title"] = lines.Count > 0 ? LJ.Str(script, "title", 200) : "",
                ["contextFr"] = lines.Count > 0 ? LJ.Str(script, "contextFr", 600) : "",
                ["speakers"] = lines.Count > 0 ? speakers : new JsonArray(),
                ["lines"] = lines,
            },
            ["items"] = items,
        };
    }

    private static readonly string[] ItemFields = { "id", "kind", "prompt", "promptFr", "options", "answer", "accepted", "explanationFr", "audioText", "words", "seconds", "criteria", "modelAnswer" };

    private static JsonObject Ordered(JsonObject item)
    {
        var ordered = new JsonObject();
        foreach (var field in ItemFields)
        {
            var value = item[field];
            item.Remove(field);
            ordered[field] = value;
        }

        return ordered;
    }

    private static readonly Regex Gap = new(@"_{2,}", RegexOptions.CultureInvariant);

    /// <summary>Un item conforme a son genre, ou <c>null</c> s'il est inutilisable.</summary>
    private static JsonObject? Item(JsonObject i)
    {
        var kind = LJ.Pick(LJ.Str(i, "kind", 30), ItemKinds, "");
        if (kind.Length == 0)
        {
            return null;
        }

        var prompt = LJ.Str(i, "prompt", 1500);
        var promptFr = LJ.Str(i, "promptFr", 1500);
        var answer = LJ.Str(i, "answer", 1500);
        var options = LJ.Strings(i, "options", 8, 300).Distinct().ToList();
        var accepted = LJ.Strings(i, "accepted", 8, 400);
        var audio = Speech.Clean(LJ.Str(i, "audioText", 1500), null, 1500);
        var words = LJ.Strings(i, "words", 4, 60);
        var seconds = Math.Clamp(LJ.Int(i, "seconds"), 0, 1800);
        var criteria = LJ.Strings(i, "criteria", 6, 300);
        var model = LJ.Str(i, "modelAnswer", 3000);

        switch (kind)
        {
            case "choice":
            {
                var match = options.Count >= 2 ? LessonGenre.Match(options, answer) : null;
                if (prompt.Length == 0 || match is null)
                {
                    return null;
                }

                LJ.Shuffle(options);
                answer = match;
                break;
            }

            case "truefalse":
            {
                var truth = LJ.Key(answer).Replace(' ', '_') switch
                {
                    "true" or "t" or "vrai" => "true",
                    "false" or "f" or "faux" => "false",
                    "not_given" or "ng" or "notgiven" or "not_given_" or "non_dit" => "not_given",
                    _ => "",
                };
                if (prompt.Length == 0 || truth.Length == 0)
                {
                    return null;
                }

                answer = truth;
                options = new List<string> { "true", "false", "not_given" };
                break;
            }

            case "gap":
                prompt = Gap.Replace(prompt, "___");
                if (!prompt.Contains("___") || answer.Length == 0)
                {
                    return null;
                }

                options = new List<string>();
                break;

            case "transform":
            case "error_spot":
                if (prompt.Length == 0 || answer.Length == 0 || (kind == "error_spot" && LJ.Key(prompt) == LJ.Key(answer)))
                {
                    return null;
                }

                options = new List<string>();
                break;

            case "translate":
                if (promptFr.Length == 0 || answer.Length == 0)
                {
                    return null;
                }

                options = new List<string>();
                break;

            case "order":
                if (answer.Length == 0)
                {
                    return null;
                }

                options = Fragments(options, answer);
                break;

            case "dictation":
                if (audio.Length == 0)
                {
                    audio = Speech.Clean(answer, null, 1500);
                }

                if (audio.Length == 0)
                {
                    return null;
                }

                answer = answer.Length > 0 ? answer : audio;
                options = new List<string>();
                break;

            case "partial_dictation":
            {
                prompt = Gap.Replace(prompt, "___");
                if (audio.Length == 0 || !prompt.Contains("___"))
                {
                    return null;
                }

                var computed = GapAnswer(audio, prompt);
                var gaps = Regex.Matches(prompt, "___").Count;
                if (computed is not null)
                {
                    answer = computed;
                }
                else if (answer.Split('|').Length != gaps)
                {
                    return null;
                }

                options = new List<string>();
                break;
            }

            case "minimal_pair":
            {
                words = words.Distinct(StringComparer.OrdinalIgnoreCase).Take(2).ToList();
                var said = words.FirstOrDefault(w => string.Equals(w, answer.Trim(), StringComparison.OrdinalIgnoreCase));
                if (words.Count != 2 || said is null)
                {
                    return null;
                }

                answer = said;
                if (audio.Length == 0 || audio.IndexOf(said, StringComparison.OrdinalIgnoreCase) < 0)
                {
                    audio = said;
                }

                options = new List<string>();
                break;
            }

            case "stress":
            {
                if (prompt.Length == 0 || options.Count < 2)
                {
                    return null;
                }

                options = LJ.Strings(i, "options", 8, 30);
                var index = int.TryParse(answer.Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var n)
                    ? n
                    : options.FindIndex(s => string.Equals(s, answer.Trim(), StringComparison.OrdinalIgnoreCase));
                if (index < 0 || index >= options.Count)
                {
                    return null;
                }

                answer = index.ToString(CultureInfo.InvariantCulture);
                break;
            }

            case "shadow":
                if (audio.Length == 0)
                {
                    audio = Speech.Clean(prompt.Length > 0 ? prompt : answer, null, 1500);
                }

                if (audio.Length == 0)
                {
                    return null;
                }

                options = new List<string>();
                break;

            case "read_aloud":
                if (prompt.Length == 0)
                {
                    return null;
                }

                options = new List<string>();
                break;

            case "open_write":
            case "open_speak":
                if (promptFr.Length == 0 && prompt.Length == 0)
                {
                    return null;
                }

                if (kind == "open_speak" && seconds == 0)
                {
                    seconds = 60;
                }

                options = new List<string>();
                break;
        }

        return new JsonObject
        {
            ["kind"] = kind,
            ["prompt"] = prompt,
            ["promptFr"] = promptFr,
            ["options"] = LJ.Array(options),
            ["answer"] = answer,
            ["accepted"] = LJ.Array(accepted),
            ["explanationFr"] = LJ.Str(i, "explanationFr", 800),
            ["audioText"] = audio,
            ["words"] = LJ.Array(kind == "minimal_pair" ? words : new List<string>()),
            ["seconds"] = seconds,
            ["criteria"] = LJ.Array(criteria),
            ["modelAnswer"] = model,
        };
    }

    /// <summary>Fragments d'une phrase a remettre en ordre : ceux du modele s'ils la composent, sinon recoupes ; toujours melanges.</summary>
    private static List<string> Fragments(List<string> given, string answer)
    {
        static string Letters(string s) => new(s.ToLowerInvariant().Where(char.IsLetterOrDigit).OrderBy(c => c).ToArray());

        var fragments = given.Count >= 2 && Letters(string.Join("", given)) == Letters(answer) ? given.ToList() : new List<string>();
        if (fragments.Count == 0)
        {
            var words = answer.Trim().TrimEnd('.', '!', '?').Split(' ', StringSplitOptions.RemoveEmptyEntries);
            var size = words.Length <= 6 ? 1 : words.Length <= 12 ? 2 : 3;
            for (var k = 0; k < words.Length; k += size)
            {
                fragments.Add(string.Join(" ", words.Skip(k).Take(size)));
            }
        }

        if (fragments.Count < 2)
        {
            return fragments;
        }

        var original = fragments.ToList();
        for (var attempt = 0; attempt < 5 && fragments.SequenceEqual(original); attempt++)
        {
            LJ.Shuffle(fragments);
        }

        return fragments;
    }

    /// <summary>
    /// Mots manquants d'une dictee a trous, retrouves en alignant la phrase a trous sur la phrase
    /// entendue ; <c>null</c> si l'alignement echoue (le modele a alors sa propre reponse).
    /// </summary>
    internal static string? GapAnswer(string audio, string prompt)
    {
        static string Norm(string w) => new(w.ToLowerInvariant().Replace('’', '\'').Where(c => char.IsLetterOrDigit(c) || c == '\'').ToArray());

        var heard = audio.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        var tokens = Regex.Replace(prompt, "___", " ___ ").Split(' ', StringSplitOptions.RemoveEmptyEntries)
            .Where(t => t.Contains("___") || Norm(t).Length > 0).ToArray();
        var fills = new List<string>();
        var a = 0;
        for (var k = 0; k < tokens.Length; k++)
        {
            if (tokens[k].Contains("___"))
            {
                var anchor = k + 1 < tokens.Length && !tokens[k + 1].Contains("___") ? Norm(tokens[k + 1]) : null;
                var fill = new List<string>();
                while (a < heard.Length && (anchor is null || Norm(heard[a]) != anchor))
                {
                    if (Norm(heard[a]).Length > 0)
                    {
                        fill.Add(heard[a]);
                    }

                    a++;
                    if (anchor is null && k + 1 < tokens.Length)
                    {
                        break;
                    }
                }

                if (fill.Count == 0)
                {
                    return null;
                }

                fills.Add(string.Join(" ", fill).Trim().TrimEnd('.', ',', '!', '?', ';', ':'));
                continue;
            }

            while (a < heard.Length && Norm(heard[a]).Length == 0)
            {
                a++;
            }

            if (a >= heard.Length || Norm(heard[a]) != Norm(tokens[k]))
            {
                return null;
            }

            a++;
        }

        return fills.Count == 0 ? null : string.Join(" | ", fills);
    }
}

// ============================================================================ bilan express

/// <summary>
/// Module du bilan express (<c>toeic</c>, spec §5.4) : etape de routage (<c>stage1</c>) ou module
/// facile / difficile de l'etape 2. Le schema a des emplacements nommes par partie (la composition
/// est ainsi tenue) ; l'hote numerote, redige les introductions, melange les options et recalcule la
/// cle avec une repartition uniforme des positions.
/// </summary>
internal static class ToeicGenre
{
    private static readonly string[] Centers = { "A2", "B1", "B2", "C1" };
    private static readonly string[] Abilities = { "L_gist_short", "L_gist_ext", "L_detail_short", "L_detail_ext", "L_pragmatic", "R_locate", "R_connect", "R_infer", "R_vocab", "R_grammar" };
    private static readonly string[] Features = { "indirect_response", "negation", "paraphrase", "info_in_middle", "cross_text", "inference", "rare_vocabulary", "graphic", "lexical_match" };
    private static readonly string[] SpeakerIds = { "W1", "M1", "W2", "M2", "N" };
    private static readonly string[] Accents = { "en-US", "en-GB", "en-AU", "en-CA" };
    private static readonly string[] DocKinds = { "email", "memo", "article", "notice", "ad", "chat", "form", "letter", "webpage", "schedule", "text" };
    private static readonly string[] GraphicKinds = { "none", "table", "schedule", "price_list", "bar_chart", "floor_plan", "map", "coupon", "form" };
    private static readonly string[] TalkKinds = { "announcement", "telephone message", "meeting excerpt", "broadcast", "advertisement", "tour", "introduction", "talk" };

    private const string System = """
        Tu es l'auteur des bilans d'anglais d'Organizator : tu écris des items ORIGINAUX au format type TOEIC® Listening & Reading — le format seulement : n'imite, ne recopie ni ne paraphrase aucun item, consigne ou document officiel d'ETS. Tu rends uniquement la fiche demandée.

        Contexte : anglais international du travail et de la vie courante (bureau, réunions, voyages d'affaires, restaurants, achats, santé, logement, ressources humaines, informatique, fabrication, finance simple). Pas de sujet sensible (politique, religion, drame), pas de culture locale pointue, aucune marque réelle ; personnes et entreprises fictives. Varie les thèmes, les prénoms, les entreprises et les accents d'un ensemble à l'autre.

        Écoute — tout ce qui est dans prompt, lines et, en partie 2, les options, est lu par la synthèse vocale :
        - Écris les nombres en toutes lettres, comme on les dit : « two thirty », « fifteen dollars », « room four-oh-two », « the twenty-first of May ». Ni didascalie, ni émoticône, ni balise, ni nom de locuteur dans le texte.
        - Locuteurs : W1 et W2 sont des femmes, M1 et M2 des hommes, N un narrateur ; accents variés parmi en-US, en-GB, en-AU et en-CA.
        - Partie 2 (question-réponse) : asker dit une question ou une affirmation de 5 à 12 mots (prompt) ; responder dit trois réponses de 3 à 10 mots (les options, entendues et non affichées) ; une seule convient. Pièges typiques : mot répété ou de sonorité proche, réponse à une autre question (when / where), réponse indirecte mais juste (« I already placed the order. »). stem vide.
        - Partie 3 (conversation) : 80 à 120 mots en 4 à 8 répliques (100 à 140 avec trois locuteurs), naturelle ; trois questions dans l'ordre de la conversation (sujet ou lieu, détail, intention ou suite), quatre options courtes chacune, affichées.
        - Partie 4 (exposé) : 90 à 130 mots, un seul locuteur (talkKind : announcement, telephone message, meeting excerpt, broadcast, advertisement, tour, introduction, talk) ; trois questions, quatre options.
        - Graphique, quand il est demandé : un petit tableau (horaire, liste de prix, plan d'étages, programme…) de 3 à 5 lignes, et une question qui oblige à le croiser avec l'audio (« Look at the graphic. Which… ? ») ; sinon kind « none », titre vide, listes vides.
        - Question d'intention : « Why does the man say, "…"? » ou « What does the woman imply when she says, "…"? », sur une réplique citée exactement.

        Lecture :
        - Partie 5 : une phrase de 12 à 25 mots avec un trou noté « ------- » dans stem, et quatre options de même nature (mots d'une même famille, formes verbales, prépositions, connecteurs, vocabulaire proche).
        - Partie 6 : un texte de 100 à 150 mots (e-mail, note, annonce, article court) avec quatre trous marqués [1], [2], [3], [4] dans les paragraphes ; une question par trou, dans l'ordre, stem vide ; l'un des trous attend une phrase entière (quatre phrases en options, une seule s'insère logiquement).
        - Partie 7 : documents réalistes (e-mail, annonce, formulaire, article, page web, chaîne de messages), avec meta = en-têtes (From, To, Date, Subject…) quand il y en a. Document simple : 60 à 250 mots ; ensemble double : 300 à 400 mots en tout ; triple : 400 à 550. Chaîne de messages : kind « chat », quatre à huit messages « Nom (9:12 A.M.) : texte », un par paragraphe. Questions : idée principale, détail, inférence, vocabulaire en contexte (« The word "…" in paragraph 1 is closest in meaning to »), intention (« At 9:14 A.M., what does Mr. … mean when he writes, "…"? ») ; pour un ensemble double ou triple, au moins deux questions qui obligent à relier deux documents.

        Chaque question :
        - answer : le texte EXACT de l'une des options (jamais une lettre). L'hôte mélange les options lui-même : ne cherche pas à varier la place de la bonne réponse.
        - Une seule réponse défendable ; distracteurs plausibles (mots repris du texte avec un autre sens, information vraie qui ne répond pas, détail d'un autre passage), jamais absurdes, jamais piégés par une subtilité contestable.
        - evidence : la phrase exacte de l'audio ou du texte qui justifie la réponse.
        - explanationFr : en français, une ou deux phrases : pourquoi c'est la bonne réponse, pourquoi le piège principal est faux. Les options sont mélangées après coup : ne désigne jamais une option par sa position ni par une lettre (« la première », « B »…), cite son texte entre guillemets.
        - ability : L_gist_short ou L_detail_short (partie 2), L_gist_ext, L_detail_ext, L_pragmatic (intention, implicite) pour l'écoute ; R_grammar et R_vocab (parties 5 et 6), R_locate (repérer), R_connect (relier des phrases ou des documents), R_infer (déduire) pour la lecture.
        - cefr : le niveau de la question (A1 à C1). features : ce qui la rend difficile (indirect_response, negation, paraphrase, info_in_middle, cross_text, inference, rare_vocabulary, graphic ; lexical_match quand la réponse reprend les mots du texte).

        Difficulté selon le niveau :
        - A1-A2 : vocabulaire courant, réponse directe, information au début ou à la fin, reprise lexicale, grammaire de base, peu à lire.
        - B1 : paraphrase légère, information au milieu, quelques réponses indirectes, liens sur une ou deux phrases, inférences simples.
        - B2 : réponses indirectes ou imprévisibles, négations, syntaxe complexe, informations à relier dans tout le texte ou entre deux textes, sens inhabituels de mots courants, implicite.
        - C1 : idiomes, grammaire rare, implicite fin, information dense non répétée, nuances entre mots proches, documents triples.
        """;

    private const string Definitions = """
        "speaker":{"type":"object","additionalProperties":false,"required":["id","role","gender","accent"],"properties":{"id":{"type":"string","enum":["W1","M1","W2","M2","N"]},"role":{"type":"string"},"gender":{"type":"string","enum":["female","male"]},"accent":{"type":"string","enum":["en-US","en-GB","en-AU","en-CA"]}}},
        "line":{"type":"object","additionalProperties":false,"required":["speaker","text"],"properties":{"speaker":{"type":"string","description":"id d'un speaker"},"text":{"type":"string","description":"Ce qui est dit, nombres en toutes lettres"}}},
        "question":{"type":"object","additionalProperties":false,"required":["stem","options","answer","ability","cefr","features","evidence","explanationFr"],"properties":{"stem":{"type":"string"},"options":{"type":"array","items":{"type":"string"}},"answer":{"type":"string","description":"Texte exact de la bonne option"},"ability":{"type":"string","enum":@ABILITIES@},"cefr":{"type":"string","enum":["A1","A2","B1","B2","C1"]},"features":{"type":"array","items":{"type":"string","enum":@FEATURES@}},"evidence":{"type":"string"},"explanationFr":{"type":"string"}}},
        "graphic":{"type":"object","additionalProperties":false,"required":["kind","title","columns","rows"],"properties":{"kind":{"type":"string","enum":@GRAPHICS@},"title":{"type":"string"},"columns":{"type":"array","items":{"type":"string"}},"rows":{"type":"array","items":{"type":"array","items":{"type":"string"}}}}},
        "document":{"type":"object","additionalProperties":false,"required":["kind","title","meta","paragraphs"],"properties":{"kind":{"type":"string","enum":@DOCS@},"title":{"type":"string"},"meta":{"type":"array","items":{"type":"string"}},"paragraphs":{"type":"array","items":{"type":"string"}}}},
        "p2":{"type":"object","additionalProperties":false,"required":["topic","asker","responder","prompt","question"],"properties":{"topic":{"type":"string"},"asker":{"$ref":"#/definitions/speaker"},"responder":{"$ref":"#/definitions/speaker"},"prompt":{"type":"string","description":"La question ou l'affirmation entendue"},"question":{"$ref":"#/definitions/question"}}},
        "conversation":{"type":"object","additionalProperties":false,"required":["topic","speakers","lines","graphic","questions"],"properties":{"topic":{"type":"string"},"speakers":{"type":"array","items":{"$ref":"#/definitions/speaker"}},"lines":{"type":"array","items":{"$ref":"#/definitions/line"}},"graphic":{"$ref":"#/definitions/graphic"},"questions":{"type":"array","items":{"$ref":"#/definitions/question"}}}},
        "talk":{"type":"object","additionalProperties":false,"required":["topic","talkKind","speaker","lines","graphic","questions"],"properties":{"topic":{"type":"string"},"talkKind":{"type":"string","enum":@TALKS@},"speaker":{"$ref":"#/definitions/speaker"},"lines":{"type":"array","items":{"$ref":"#/definitions/line"}},"graphic":{"$ref":"#/definitions/graphic"},"questions":{"type":"array","items":{"$ref":"#/definitions/question"}}}},
        "p5":{"type":"object","additionalProperties":false,"required":["topic","question"],"properties":{"topic":{"type":"string"},"question":{"$ref":"#/definitions/question"}}},
        "p6":{"type":"object","additionalProperties":false,"required":["topic","document","questions"],"properties":{"topic":{"type":"string"},"document":{"$ref":"#/definitions/document"},"questions":{"type":"array","items":{"$ref":"#/definitions/question"}}}},
        "p7":{"type":"object","additionalProperties":false,"required":["topic","documents","questions"],"properties":{"topic":{"type":"string"},"documents":{"type":"array","items":{"$ref":"#/definitions/document"}},"questions":{"type":"array","items":{"$ref":"#/definitions/question"}}}}
        """;

    private static string Enum(IEnumerable<string> values) => "[" + string.Join(",", values.Select(v => "\"" + v + "\"")) + "]";

    private static string Build(string required, string properties)
        => ExerciseGenre.Compact(("{\"type\":\"object\",\"additionalProperties\":false,\"required\":[" + required + "],\"definitions\":{" + Definitions + "},\"properties\":{" + properties + "}}")
            .Replace("@ABILITIES@", Enum(Abilities)).Replace("@FEATURES@", Enum(Features)).Replace("@GRAPHICS@", Enum(GraphicKinds))
            .Replace("@DOCS@", Enum(DocKinds)).Replace("@TALKS@", Enum(TalkKinds)));

    private static readonly string Stage1Schema = Build(
        "\"part2\",\"part3\",\"part4\",\"part5\",\"part6\",\"part7\"",
        "\"part2\":{\"type\":\"array\",\"description\":\"Cinq items de partie 2\",\"items\":{\"$ref\":\"#/definitions/p2\"}},"
        + "\"part3\":{\"$ref\":\"#/definitions/conversation\"},\"part4\":{\"$ref\":\"#/definitions/talk\"},"
        + "\"part5\":{\"type\":\"array\",\"description\":\"Trois phrases de partie 5\",\"items\":{\"$ref\":\"#/definitions/p5\"}},"
        + "\"part6\":{\"$ref\":\"#/definitions/p6\"},\"part7\":{\"$ref\":\"#/definitions/p7\"}");

    private static readonly string Stage2Schema = Build(
        "\"part2\",\"part3a\",\"part3b\",\"part4\",\"part5\",\"part7single\",\"part7multi\"",
        "\"part2\":{\"type\":\"array\",\"description\":\"Trois items de partie 2\",\"items\":{\"$ref\":\"#/definitions/p2\"}},"
        + "\"part3a\":{\"$ref\":\"#/definitions/conversation\"},\"part3b\":{\"$ref\":\"#/definitions/conversation\"},\"part4\":{\"$ref\":\"#/definitions/talk\"},"
        + "\"part5\":{\"type\":\"array\",\"description\":\"Trois phrases de partie 5\",\"items\":{\"$ref\":\"#/definitions/p5\"}},"
        + "\"part7single\":{\"$ref\":\"#/definitions/p7\"},\"part7multi\":{\"$ref\":\"#/definitions/p7\"}");

    private static string Module(LearnRequest r) => LJ.Pick(LJ.Str(r.Params, "module", 10), new[] { "stage1", "easy", "hard" }, "stage1");

    private static string Center(LearnRequest r) => LJ.Pick(LJ.Str(r.Params, "center", 4), Centers, "B1");

    private static string Shift(string center, int delta)
    {
        var index = Array.IndexOf(Levels.Items, center);
        return Levels.Items[Math.Clamp(index + delta, 0, Levels.Items.Length - 1)];
    }

    public static AgentCall Compose(LearnRequest r)
    {
        var module = Module(r);
        var center = Center(r);
        var sb = new StringBuilder();
        if (module == "stage1")
        {
            sb.Append("Module demandé : étape 1 (routage), centrée sur le niveau ").Append(center)
              .Append(", avec un éventail d'un niveau de part et d'autre (").Append(Shift(center, -1)).Append(" à ").Append(Shift(center, 1)).Append(") : la moitié des questions au niveau ")
              .Append(center).Append(", un quart en dessous, un quart au-dessus.\n");
            sb.Append("Composition exacte (21 questions) :\n")
              .Append("- part2 : cinq items de partie 2.\n")
              .Append("- part3 : une conversation de deux locuteurs, trois questions, sans graphique (kind none).\n")
              .Append("- part4 : un exposé, trois questions, sans graphique (kind none).\n")
              .Append("- part5 : trois phrases à compléter.\n")
              .Append("- part6 : un texte à quatre trous, quatre questions dont une insertion de phrase.\n")
              .Append("- part7 : une chaîne de messages (kind chat, un seul document), trois questions dont une d'intention.\n");
        }
        else
        {
            var target = Shift(center, module == "easy" ? -1 : 1);
            sb.Append("Module demandé : étape 2, module ").Append(module == "easy" ? "facile" : "difficile")
              .Append(", centré sur le niveau ").Append(target).Append(" (l'étape 1 était centrée sur ").Append(center).Append(").\n");
            sb.Append("Composition exacte (22 questions) :\n")
              .Append("- part2 : trois items de partie 2.\n")
              .Append("- part3a : une conversation à TROIS locuteurs, trois questions, sans graphique (kind none).\n")
              .Append("- part3b : une conversation de deux locuteurs AVEC un graphique, trois questions dont une « Look at the graphic ».\n")
              .Append("- part4 : un exposé, trois questions, avec un graphique ou une question d'intention.\n")
              .Append("- part5 : trois phrases à compléter.\n")
              .Append("- part7single : un document simple, deux questions.\n")
              .Append("- part7multi : un ensemble double ou triple (deux ou trois documents liés), cinq questions dont au moins deux qui relient les documents.\n");
        }

        var avoid = LJ.Strings(r.Params, "avoid", 20, 80);
        if (avoid.Count > 0)
        {
            sb.Append("Thèmes déjà vus dans les bilans précédents (à éviter) : ").Append(string.Join(" ; ", avoid)).Append(".\n");
        }

        if (r.Context.Length > 0)
        {
            sb.Append("\n").Append(r.Context.Trim()).Append('\n');
        }

        sb.Append("\nRendez la fiche du module.");
        return new AgentCall("", System + Levels.Quotes, module == "stage1" ? Stage1Schema : Stage2Schema, sb.ToString());
    }

    public static JsonObject Sanitize(JsonObject o, LearnRequest r, HostLog log)
    {
        var module = Module(r);
        var center = Center(r);
        var b = new Builder(module == "stage1" ? center : Shift(center, module == "easy" ? -1 : 1));
        var listening = new JsonArray();
        var reading = new JsonArray();

        void Add(JsonArray list, JsonObject? set)
        {
            if (set is not null)
            {
                list.Add(set);
            }
        }

        if (module == "stage1")
        {
            foreach (var item in LJ.Objects(o, "part2").Take(5))
            {
                Add(listening, b.Part2(item));
            }

            Add(listening, b.Conversation(LJ.Obj(o, "part3"), 3));
            Add(listening, b.Talk(LJ.Obj(o, "part4"), 3));
            foreach (var item in LJ.Objects(o, "part5").Take(3))
            {
                Add(reading, b.Part5(item));
            }

            Add(reading, b.Part6(LJ.Obj(o, "part6")));
            Add(reading, b.Part7(LJ.Obj(o, "part7"), 3));
        }
        else
        {
            foreach (var item in LJ.Objects(o, "part2").Take(3))
            {
                Add(listening, b.Part2(item));
            }

            Add(listening, b.Conversation(LJ.Obj(o, "part3a"), 3));
            Add(listening, b.Conversation(LJ.Obj(o, "part3b"), 3));
            Add(listening, b.Talk(LJ.Obj(o, "part4"), 3));
            foreach (var item in LJ.Objects(o, "part5").Take(3))
            {
                Add(reading, b.Part5(item));
            }

            Add(reading, b.Part7(LJ.Obj(o, "part7single"), 2));
            Add(reading, b.Part7(LJ.Obj(o, "part7multi"), 5));
        }

        var counted = b.Questions;
        var expected = module == "stage1" ? 21 : 22;
        if (counted == 0)
        {
            throw new InvalidOperationException("Le module généré est inutilisable : aucune question valide.");
        }

        if (counted != expected)
        {
            log.Warn($"Revizator toeic {module} : {counted} questions valides sur {expected} attendues ({b.Dropped} ecartees).");
        }

        return new JsonObject
        {
            ["module"] = module,
            ["center"] = center,
            ["listening"] = listening,
            ["reading"] = reading,
        };
    }

    /// <summary>Construit les ensembles dans l'ordre : numerotation, introductions, melange equilibre des options.</summary>
    private sealed class Builder
    {
        private readonly string _level;
        private readonly Queue<int> _deck3 = new();
        private readonly Queue<int> _deck4 = new();
        private int _sets;

        public Builder(string level)
        {
            _level = level;
        }

        public int Questions { get; private set; }

        public int Dropped { get; private set; }

        public JsonObject? Part2(JsonObject p)
        {
            var asker = Speaker(LJ.Obj(p, "asker"), "W1");
            var responder = Speaker(LJ.Obj(p, "responder"), "M1");
            if (LJ.Str(responder, "id") == LJ.Str(asker, "id"))
            {
                responder["id"] = LJ.Str(asker, "id").StartsWith('W') ? "M1" : "W1";
                responder["gender"] = LJ.Str(asker, "id").StartsWith('W') ? "male" : "female";
            }

            var prompt = NumberWords.Spell(Speech.Clean(LJ.Str(p, "prompt", 400)));
            var q = LJ.Obj(p, "question");
            if (prompt.Length == 0 || q is null)
            {
                Dropped++;
                return null;
            }

            q = (JsonObject)q.DeepClone();
            q["stem"] = "";
            q["options"] = LJ.Array(LJ.Strings(q, "options", 6, 200).Select(s => NumberWords.Spell(Speech.Clean(s))));
            q["answer"] = NumberWords.Spell(Speech.Clean(LJ.Str(q, "answer", 200)));
            var questions = QuestionList(new[] { q }, 3, 1, "L", "L_gist_short");
            if (questions.Count == 0)
            {
                return null;
            }

            return Set("L", 2, LJ.Str(p, "topic", 120), "", new JsonArray { asker, responder },
                new JsonArray { new JsonObject { ["speaker"] = LJ.Str(asker, "id"), ["text"] = prompt } },
                new JsonArray(), null, questions);
        }

        public JsonObject? Conversation(JsonObject? p, int count)
        {
            if (p is null)
            {
                Dropped += count;
                return null;
            }

            var speakers = Speakers(LJ.Objects(p, "speakers"), 3);
            var lines = Lines(LJ.Objects(p, "lines"), speakers, null);
            var questions = QuestionList(LJ.Objects(p, "questions"), 4, count, "L", "L_detail_ext");
            if (speakers.Count < 2 || lines.Count < 2 || questions.Count == 0)
            {
                Dropped += questions.Count;
                Questions -= questions.Count;
                return null;
            }

            var graphic = Graphic(LJ.Obj(p, "graphic"));
            var intro = "following conversation" + (speakers.Count >= 3 ? " with three speakers" : "") + (graphic is not null ? " and " + GraphicNoun(LJ.Str(graphic, "kind")) : "");
            return Set("L", 3, LJ.Str(p, "topic", 120), intro, speakers, lines, new JsonArray(), graphic, questions);
        }

        public JsonObject? Talk(JsonObject? p, int count)
        {
            if (p is null)
            {
                Dropped += count;
                return null;
            }

            var speaker = Speaker(LJ.Obj(p, "speaker"), "N");
            var speakers = new JsonArray { speaker };
            var lines = Lines(LJ.Objects(p, "lines"), speakers, LJ.Str(speaker, "id"));
            var questions = QuestionList(LJ.Objects(p, "questions"), 4, count, "L", "L_detail_ext");
            if (lines.Count == 0 || questions.Count == 0)
            {
                Dropped += questions.Count;
                Questions -= questions.Count;
                return null;
            }

            var graphic = Graphic(LJ.Obj(p, "graphic"));
            var talk = LJ.Pick(LJ.Str(p, "talkKind", 30), TalkKinds, "talk");
            var intro = "following " + talk + (graphic is not null ? " and " + GraphicNoun(LJ.Str(graphic, "kind")) : "");
            return Set("L", 4, LJ.Str(p, "topic", 120), intro, speakers, lines, new JsonArray(), graphic, questions);
        }

        public JsonObject? Part5(JsonObject p)
        {
            var q = LJ.Obj(p, "question");
            if (q is null)
            {
                Dropped++;
                return null;
            }

            q = (JsonObject)q.DeepClone();
            var stem = Regex.Replace(LJ.Str(q, "stem", 400), @"_{3,}|-{3,}|…{1,}|\.{4,}", "-------");
            if (!stem.Contains("-------"))
            {
                Dropped++;
                return null;
            }

            q["stem"] = stem;
            var questions = QuestionList(new[] { q }, 4, 1, "R", "R_grammar");
            return questions.Count == 0 ? null : Set("R", 5, LJ.Str(p, "topic", 120), "", new JsonArray(), new JsonArray(), new JsonArray(), null, questions);
        }

        public JsonObject? Part6(JsonObject? p)
        {
            var document = Document(LJ.Obj(p, "document"));
            if (p is null || document is null)
            {
                Dropped += 4;
                return null;
            }

            // Trous notes (1), {{1}}, ___1___ : ramenes a [1].
            var paragraphs = LJ.StringsOf(document["paragraphs"] as JsonArray, 20, 2000)
                .Select(t => Regex.Replace(t, @"\(\s*([1-4])\s*\)|\{\{\s*([1-4])\s*\}\}|_{2,}\s*([1-4])\s*_{2,}|\[\s*([1-4])\s*\]", m => "[" + (m.Groups[1].Value + m.Groups[2].Value + m.Groups[3].Value + m.Groups[4].Value) + "]"))
                .ToList();
            document["paragraphs"] = LJ.Array(paragraphs);
            var text = string.Join("\n", paragraphs);
            var markers = Enumerable.Range(1, 4).Count(n => text.Contains("[" + n + "]"));
            if (markers == 0)
            {
                Dropped += 4;
                return null;
            }

            var given = LJ.Objects(p, "questions").Take(markers).Select(q =>
            {
                var copy = (JsonObject)q.DeepClone();
                copy["stem"] = "";
                return copy;
            }).ToList();
            var questions = QuestionList(given, 4, markers, "R", "R_grammar");
            if (questions.Count == 0)
            {
                return null;
            }

            return Set("R", 6, LJ.Str(p, "topic", 120), "following " + DocNoun(LJ.Str(document, "kind")), new JsonArray(), new JsonArray(), new JsonArray { document }, null, questions);
        }

        public JsonObject? Part7(JsonObject? p, int count)
        {
            var documents = new JsonArray();
            foreach (var d in LJ.Objects(p, "documents").Take(3))
            {
                if (Document(d) is { } doc)
                {
                    documents.Add(doc);
                }
            }

            if (documents.Count == 0)
            {
                Dropped += count;
                return null;
            }

            var questions = QuestionList(LJ.Objects(p, "questions"), 4, count, "R", "R_locate");
            if (questions.Count == 0)
            {
                return null;
            }

            var nouns = documents.Select(d => DocNoun(LJ.Str(d, "kind"))).ToList();
            var joined = nouns.Count switch
            {
                1 => nouns[0],
                2 => nouns[0] + " and " + nouns[1],
                _ => nouns[0] + ", " + nouns[1] + ", and " + nouns[2],
            };
            return Set("R", 7, LJ.Str(p, "topic", 120), "following " + joined, new JsonArray(), new JsonArray(), documents, null, questions);
        }

        private JsonObject Set(string section, int part, string topic, string intro, JsonArray speakers, JsonArray audio, JsonArray documents, JsonObject? graphic, JsonArray questions)
        {
            _sets++;
            var first = LJ.Str(questions[0], "id")[1..];
            var last = LJ.Str(questions[^1], "id")[1..];
            var heading = intro.Length == 0
                ? ""
                : questions.Count == 1 ? $"Question {first} refers to the {intro}." : $"Questions {first}-{last} refer to the {intro}.";
            return new JsonObject
            {
                ["id"] = "s" + _sets.ToString(CultureInfo.InvariantCulture),
                ["section"] = section,
                ["part"] = part,
                ["topic"] = topic,
                ["intro"] = heading,
                ["speakers"] = speakers,
                ["audio"] = audio,
                ["documents"] = documents,
                ["graphic"] = graphic,
                ["questions"] = questions,
            };
        }

        /// <summary>Questions valides, numerotees, options melangees avec une cle repartie uniformement.</summary>
        private JsonArray QuestionList(IEnumerable<JsonObject> given, int optionCount, int max, string section, string ability)
        {
            var list = new JsonArray();
            foreach (var q in given)
            {
                if (list.Count >= max)
                {
                    break;
                }

                var options = LJ.Strings(q, "options", 6, 400).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
                var correct = LessonGenre.Match(options, LJ.Str(q, "answer", 400));
                if (correct is null || options.Count < optionCount)
                {
                    Dropped++;
                    continue;
                }

                var distractors = options.Where(o => !ReferenceEquals(o, correct) && o != correct).ToList();
                var positional = options.All(o => Regex.IsMatch(o.Trim(), @"^\[\d\]$"));
                List<string> final;
                int answer;
                if (positional)
                {
                    final = options.Take(optionCount).ToList();
                    answer = final.IndexOf(correct);
                    if (answer < 0)
                    {
                        Dropped++;
                        continue;
                    }
                }
                else
                {
                    LJ.Shuffle(distractors);
                    final = distractors.Take(optionCount - 1).ToList();
                    answer = Next(optionCount);
                    final.Insert(answer, correct);
                }

                Questions++;
                var abilityValue = LJ.Pick(LJ.Str(q, "ability", 30), Abilities, ability);
                if (!abilityValue.StartsWith(section + "_", StringComparison.Ordinal))
                {
                    abilityValue = ability;
                }

                var features = LJ.Strings(q, "features", 9, 30).Select(f => LJ.Pick(f, Features, "")).Where(f => f.Length > 0).Distinct().ToList();
                list.Add(new JsonObject
                {
                    ["id"] = "q" + Questions.ToString(CultureInfo.InvariantCulture),
                    ["stem"] = LJ.Str(q, "stem", 600),
                    ["options"] = LJ.Array(final),
                    ["answer"] = answer,
                    ["ability"] = abilityValue,
                    ["cefr"] = LJ.Pick(LJ.Str(q, "cefr", 4), Levels.Items, _level),
                    ["features"] = LJ.Array(features),
                    ["evidence"] = LJ.Str(q, "evidence", 600),
                    ["explanationFr"] = LJ.Str(q, "explanationFr", 800),
                });
            }

            return list;
        }

        /// <summary>Place de la bonne reponse : paquets melanges de 0..n-1, pour une repartition uniforme.</summary>
        private int Next(int count)
        {
            var deck = count == 3 ? _deck3 : _deck4;
            if (deck.Count == 0)
            {
                var block = Enumerable.Range(0, count).ToList();
                LJ.Shuffle(block);
                foreach (var n in block)
                {
                    deck.Enqueue(n);
                }
            }

            return deck.Dequeue();
        }

        private static JsonObject Speaker(JsonObject? s, string fallbackId)
        {
            var id = LJ.Pick(LJ.Str(s, "id", 4), SpeakerIds, fallbackId);
            var gender = id.StartsWith('W') ? "female" : id.StartsWith('M') ? "male" : LJ.Pick(LJ.Str(s, "gender", 10), new[] { "female", "male" }, "female");
            return new JsonObject
            {
                ["id"] = id,
                ["role"] = LJ.Str(s, "role", 80),
                ["gender"] = gender,
                ["accent"] = LJ.Pick(LJ.Str(s, "accent", 10), Accents, "en-US"),
            };
        }

        private static JsonArray Speakers(IEnumerable<JsonObject> given, int max)
        {
            var list = new JsonArray();
            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (var s in given)
            {
                var speaker = Speaker(s, "");
                var id = LJ.Str(speaker, "id");
                if (id.Length > 0 && seen.Add(id) && list.Count < max)
                {
                    list.Add(speaker);
                }
            }

            return list;
        }

        private static JsonArray Lines(IEnumerable<JsonObject> given, JsonArray speakers, string? only)
        {
            var ids = speakers.Select(s => LJ.Str(s, "id")).ToHashSet(StringComparer.OrdinalIgnoreCase);
            var lines = new JsonArray();
            foreach (var l in given)
            {
                var speaker = only ?? LJ.Str(l, "speaker", 10).ToUpperInvariant();
                if (!ids.Contains(speaker))
                {
                    continue;
                }

                var text = NumberWords.Spell(Speech.Clean(LJ.Str(l, "text", 2000), ids));
                if (text.Length > 0 && lines.Count < 20)
                {
                    lines.Add(new JsonObject { ["speaker"] = speaker, ["text"] = text });
                }
            }

            return lines;
        }

        private static JsonObject? Graphic(JsonObject? g)
        {
            var kind = LJ.Pick(LJ.Str(g, "kind", 20), GraphicKinds, "none");
            var columns = LJ.Strings(g, "columns", 6, 60);
            var rows = new JsonArray();
            foreach (var row in LJ.Arr(g, "rows") ?? new JsonArray())
            {
                var cells = LJ.StringsOf(row as JsonArray, 6, 120);
                if (cells.Count > 0 && rows.Count < 10)
                {
                    rows.Add(LJ.Array(cells));
                }
            }

            if (kind == "none" || rows.Count == 0)
            {
                return null;
            }

            return new JsonObject
            {
                ["kind"] = kind,
                ["title"] = LJ.Str(g, "title", 120),
                ["columns"] = LJ.Array(columns),
                ["rows"] = rows,
            };
        }

        private static JsonObject? Document(JsonObject? d)
        {
            var paragraphs = LJ.Strings(d, "paragraphs", 20, 2000);
            if (paragraphs.Count == 0)
            {
                return null;
            }

            return new JsonObject
            {
                ["kind"] = LJ.Pick(LJ.Str(d, "kind", 20), DocKinds, "text"),
                ["title"] = LJ.Str(d, "title", 200),
                ["meta"] = LJ.Array(LJ.Strings(d, "meta", 8, 200)),
                ["paragraphs"] = LJ.Array(paragraphs),
            };
        }

        private static string DocNoun(string kind) => kind switch
        {
            "email" => "e-mail",
            "ad" => "advertisement",
            "chat" => "text-message chain",
            "webpage" => "Web page",
            "text" => "information",
            _ => kind,
        };

        private static string GraphicNoun(string kind) => kind switch
        {
            "price_list" => "price list",
            "bar_chart" => "chart",
            "floor_plan" => "floor plan",
            _ => kind,
        };
    }
}

// ============================================================================ bilan oral et ecrit

/// <summary>
/// Bilan oral et ecrit (<c>sw</c>, spec §5.5) : le modele ecrit le contenu des taches ; l'hote fixe la
/// composition, les consignes en francais, les minutages et les baremes du format.
/// </summary>
internal static class SwGenre
{
    private const string System = """
        Tu es l'auteur des bilans oral et écrit d'Organizator, au format type TOEIC® Speaking & Writing — le format seulement : contenus originaux, aucun item officiel d'ETS imité ou paraphrasé. Tu rends uniquement la fiche demandée : le contenu des tâches, en anglais sauf mention contraire ; l'hôte ajoute les consignes et les minutages.

        Contexte : vie professionnelle et quotidienne internationale (bureau, clients, voyages, services, loisirs) ; personnes et entreprises fictives ; aucun sujet sensible. Ajuste le vocabulaire et la complexité au niveau visé, sans sortir du format.

        Oral
        - readAloud.text : un texte de 60 à 90 mots fait pour être lu à voix haute (annonce, message enregistré, présentation, publicité), avec un ou deux noms propres simples, une énumération de trois éléments, une question, et des mots difficiles pour un francophone (accent tonique, th, h, -ed).
        - describe.text : EN FRANÇAIS, la description d'une photo imaginaire (lieu, personnes, actions, objets, premier et arrière-plan) en trois à cinq phrases ; l'utilisateur la décrira en anglais comme s'il la voyait.
        - respond : intro en anglais qui pose la situation (« Imagine that a British marketing firm is doing research in your area. You have agreed to participate in a telephone interview about … ») et trois questions de plus en plus ouvertes sur ce thème quotidien : les deux premières courtes et factuelles, la troisième demande un avis ou une explication.
        - respondInfo : un document (ordre du jour d'une réunion, programme d'une conférence, itinéraire, horaire) : title et 5 à 8 rows de 2 ou 3 cellules (heure, intitulé, intervenant ou lieu) ; intro = le message de la personne qui appelle (« Hi, this is …, I'm calling about … ») ; trois questions de l'appelant : une information simple ; une information qui oblige à corriger une idée fausse de l'appelant ; une demande de récapituler deux ou trois éléments liés.
        - opinion.prompt : une question d'opinion du travail ou de la vie courante, neutre, à laquelle on peut répondre des deux côtés (« Some people think … Others … What is your opinion? Give reasons and examples. »).

        Écrit
        - sentences : trois situations décrites EN FRANÇAIS (une scène en une ou deux phrases), chacune avec deux mots anglais imposés à employer dans une seule phrase (« woman / while », « because / closed »).
        - email : un e-mail reçu (from, subject, body de 50 à 90 mots, ton professionnel) ; taskEn = la tâche en anglais (« Respond to the e-mail as if you are … In your e-mail, give TWO pieces of information and make ONE request. ») ; taskFr = la même tâche en français, en vouvoyant.
        - essay.prompt : une question d'essai argumentatif (accord ou désaccord, préférence entre deux options, avantages et inconvénients) sur le travail, l'éducation ou la technologie ; chaîne vide si l'essai n'est pas demandé.
        """;

    private static readonly string Schema = ExerciseGenre.Compact("""
        {"type":"object","additionalProperties":false,"required":["readAloud","describe","respond","respondInfo","opinion","sentences","email","essay"],"properties":{
        "readAloud":{"type":"object","additionalProperties":false,"required":["text"],"properties":{"text":{"type":"string"}}},
        "describe":{"type":"object","additionalProperties":false,"required":["text"],"properties":{"text":{"type":"string","description":"La scène, en français"}}},
        "respond":{"type":"object","additionalProperties":false,"required":["intro","questions"],"properties":{"intro":{"type":"string"},"questions":{"type":"array","items":{"type":"string"}}}},
        "respondInfo":{"type":"object","additionalProperties":false,"required":["intro","title","rows","questions"],"properties":{"intro":{"type":"string"},"title":{"type":"string"},"rows":{"type":"array","items":{"type":"array","items":{"type":"string"}}},"questions":{"type":"array","items":{"type":"string"}}}},
        "opinion":{"type":"object","additionalProperties":false,"required":["prompt"],"properties":{"prompt":{"type":"string"}}},
        "sentences":{"type":"array","items":{"type":"object","additionalProperties":false,"required":["situation","words"],"properties":{"situation":{"type":"string","description":"En français"},"words":{"type":"array","items":{"type":"string"}}}}},
        "email":{"type":"object","additionalProperties":false,"required":["from","subject","body","taskEn","taskFr"],"properties":{"from":{"type":"string"},"subject":{"type":"string"},"body":{"type":"string"},"taskEn":{"type":"string"},"taskFr":{"type":"string"}}},
        "essay":{"type":"object","additionalProperties":false,"required":["prompt"],"properties":{"prompt":{"type":"string"}}}}}
        """);

    public static AgentCall Compose(LearnRequest r)
    {
        var level = Levels.Normalize(LJ.Str(r.Params, "level", 10));
        var essay = LJ.Bool(r.Params, "withEssay");
        var sb = new StringBuilder();
        sb.Append(Levels.Line(level)).Append('\n');
        sb.Append("Oral : readAloud, describe, respond (trois questions), respondInfo (trois questions), opinion.\n");
        sb.Append("Écrit : trois sentences, un email").Append(essay ? ", un essay." : " ; pas d'essai (essay.prompt vide).").Append('\n');
        if (r.Context.Length > 0)
        {
            sb.Append('\n').Append(r.Context.Trim()).Append('\n');
        }

        sb.Append("\nRendez la fiche du bilan.");
        return new AgentCall("", System + Levels.Quotes, Schema, sb.ToString());
    }

    public static JsonObject Sanitize(JsonObject o, LearnRequest r)
    {
        var level = Levels.Normalize(LJ.Str(r.Params, "level", 10));
        var essay = LJ.Bool(r.Params, "withEssay");
        var speaking = new JsonArray();
        var writing = new JsonArray();

        void Speak(string task, string promptFr, string prompt, string text, List<string> questions, JsonObject? info, int prep, int[] seconds, int scale)
        {
            speaking.Add(new JsonObject
            {
                ["id"] = "s" + (speaking.Count + 1).ToString(CultureInfo.InvariantCulture),
                ["task"] = task,
                ["promptFr"] = promptFr,
                ["prompt"] = prompt,
                ["text"] = text,
                ["questions"] = LJ.Array(questions),
                ["info"] = info,
                ["prepSeconds"] = prep,
                ["speakSeconds"] = LJ.Array(seconds.Select(s => (JsonNode?)JsonValue.Create(s))),
                ["scale"] = scale,
            });
        }

        void Write(string task, string promptFr, string prompt, List<string> words, string situation, JsonObject? email, int minutes, int scale)
        {
            writing.Add(new JsonObject
            {
                ["id"] = "w" + (writing.Count + 1).ToString(CultureInfo.InvariantCulture),
                ["task"] = task,
                ["promptFr"] = promptFr,
                ["prompt"] = prompt,
                ["words"] = LJ.Array(words),
                ["situation"] = situation,
                ["email"] = email,
                ["minutes"] = minutes,
                ["scale"] = scale,
            });
        }

        var read = Speech.Clean(LJ.Str(LJ.Obj(o, "readAloud"), "text", 1200), null, 1200);
        if (read.Length > 0)
        {
            Speak("read_aloud", "Lisez ce texte à voix haute, clairement et naturellement : 45 secondes de préparation, puis 45 secondes de lecture.",
                "Read the text aloud.", read, new List<string>(), null, 45, new[] { 45 }, 3);
        }

        var scene = LJ.Str(LJ.Obj(o, "describe"), "text", 1200);
        if (scene.Length > 0)
        {
            Speak("describe", "Imaginez la photo décrite ci-dessous et décrivez-la en anglais, avec le plus de détails possible : 45 secondes de préparation, 30 secondes de parole.",
                "Describe the picture in as much detail as you can.", scene, new List<string>(), null, 45, new[] { 30 }, 3);
        }

        var respond = LJ.Obj(o, "respond");
        var respondQuestions = LJ.Strings(respond, "questions", 3, 300).Select(q => Speech.Clean(q)).ToList();
        if (respondQuestions.Count == 3)
        {
            Speak("respond", "Répondez à trois questions sur un thème de la vie courante : 3 secondes de préparation après chaque question, 15 secondes pour les deux premières réponses, 30 secondes pour la troisième.",
                Speech.Clean(LJ.Str(respond, "intro", 600), null, 600), "", respondQuestions, null, 3, new[] { 15, 15, 30 }, 3);
        }

        var info = LJ.Obj(o, "respondInfo");
        var infoQuestions = LJ.Strings(info, "questions", 3, 300).Select(q => Speech.Clean(q)).ToList();
        var rows = new JsonArray();
        foreach (var row in LJ.Arr(info, "rows") ?? new JsonArray())
        {
            var cells = LJ.StringsOf(row as JsonArray, 4, 120);
            if (cells.Count > 0 && rows.Count < 10)
            {
                rows.Add(LJ.Array(cells));
            }
        }

        if (infoQuestions.Count == 3 && rows.Count > 0)
        {
            Speak("respond_info", "Lisez le document (45 secondes), puis répondez aux trois questions de la personne qui appelle, à partir de ses informations : 3 secondes de préparation, puis 15, 15 et 30 secondes. La troisième question est jouée deux fois.",
                Speech.Clean(LJ.Str(info, "intro", 600), null, 600), "", infoQuestions,
                new JsonObject { ["title"] = LJ.Str(info, "title", 160), ["rows"] = rows }, 45, new[] { 15, 15, 30 }, 3);
        }

        var opinion = Speech.Clean(LJ.Str(LJ.Obj(o, "opinion"), "prompt", 600), null, 600);
        if (opinion.Length > 0)
        {
            Speak("opinion", "Donnez votre avis sur la question et justifiez-le par des raisons et des exemples : 45 secondes de préparation, 60 secondes de parole.",
                opinion, "", new List<string>(), null, 45, new[] { 60 }, 5);
        }

        foreach (var s in LJ.Objects(o, "sentences").Take(3))
        {
            var words = LJ.Strings(s, "words", 2, 40);
            var situation = LJ.Str(s, "situation", 600);
            if (words.Count == 2 && situation.Length > 0)
            {
                Write("sentence", "Écrivez une seule phrase en anglais qui décrit la situation et emploie les deux mots imposés, sous la forme et dans l'ordre de votre choix.",
                    "Write ONE sentence based on the situation. Use the TWO words given.", words, situation, null, 2, 3);
            }
        }

        var email = LJ.Obj(o, "email");
        var body = LJ.Str(email, "body", 2000);
        if (body.Length > 0)
        {
            var taskFr = LJ.Str(email, "taskFr", 800);
            Write("email", (taskFr.Length > 0 ? taskFr.TrimEnd('.') + ". " : "Répondez à cet e-mail. ") + "Vous avez 10 minutes.",
                LJ.Str(email, "taskEn", 800), new List<string>(), "",
                new JsonObject { ["from"] = LJ.Str(email, "from", 160), ["subject"] = LJ.Str(email, "subject", 200), ["body"] = body }, 10, 4);
        }

        var question = LJ.Str(LJ.Obj(o, "essay"), "prompt", 1000);
        if (essay && question.Length > 0)
        {
            Write("essay", "Rédigez un essai argumenté d'au moins 300 mots en réponse à la question : donnez votre position et justifiez-la par des raisons et des exemples. Vous avez 30 minutes.",
                question, new List<string>(), "", null, 30, 5);
        }

        if (speaking.Count == 0 && writing.Count == 0)
        {
            throw new InvalidOperationException("Le bilan généré est inutilisable : aucune tâche complète.");
        }

        return new JsonObject
        {
            ["level"] = level,
            ["speaking"] = speaking,
            ["writing"] = writing,
        };
    }
}

// ============================================================================ correction

/// <summary>
/// Correction d'une production (<c>grade</c>, spec §5.6) : contrat de correction minimale
/// (<c>pedagogie.md</c> §9.1 regle 12), grilles du format S&amp;W pour un bilan. Un edit dont
/// l'<c>original</c> est introuvable dans la reponse est ecarte (hallucination).
/// </summary>
internal static class GradeGenre
{
    private static readonly string[] CardKinds = { "word", "collocation", "phrase", "false_friend", "grammar", "pronunciation" };

    private const string System = """
        Tu es le correcteur d'anglais d'Organizator : tu évalues une production écrite ou orale d'un adulte francophone et tu rends uniquement la fiche de correction demandée, bienveillante et exacte.

        Contrat de correction (strict)
        1. Corrections minimales : corrige ce qui est faux, au plus près de ce que l'apprenant a voulu dire ; ne réécris jamais tout le texte, ne touche à rien de correct, ne change ni son style ni ses idées.
        2. edits : une modification par objet. original = l'extrait EXACT, recopié caractère pour caractère depuis la réponse de l'apprenant (quelques mots, assez pour le retrouver ; jamais une reformulation) ; correction = le même extrait corrigé ; type « error » pour une faute, « improvement » pour une tournure correcte mais peu naturelle (facultative, trois au plus) ; category dans la taxonomie fournie ; priority 1 (gêne la compréhension, erreur fréquente de francophone ou cible active), 2 (faute nette), 3 (détail).
        3. Trois error de priorité 1 ou 2 au plus : celles qui comptent le plus (fréquence × gravité × cibles actives) ; les autres fautes réelles en priorité 3.
        4. explanationFr : 25 mots au plus, dans la langue d'explication indiquée ; pour un faux ami ou un calque, dis ce que le mot veut dire en anglais.
        5. corrected : la réponse entière, avec toutes les error corrigées et rien d'autre.
        6. redo : une phrase de la réponse, corrigée, que l'apprenant va redire ou réécrire (la plus utile).
        7. usefulPhrases : deux ou trois tournures naturelles, au niveau visé ou juste au-dessus, à réemployer pour cette tâche.
        8. cards : deux à quatre cartes de révision tirées des erreurs (front : la phrase à trous ou le sens en français ; back : la forme correcte ; example : une phrase complète en anglais).
        9. strengthsFr : deux réussites précises, citées ; priorityFr : LA priorité de travail, en une phrase ; feedbackFr : trois ou quatre phrases encourageantes et concrètes, en vouvoyant.

        Notes (scores, entiers de 0 à 5, critères analytiques du CECRL) : task (tâche accomplie : consignes, longueur, pertinence), coherence (organisation, connecteurs), range (étendue du vocabulaire et des structures), accuracy (correction grammaticale et lexicale), fluency (à l'oral seulement : débit, pauses, hésitations, d'après les mesures ; 0 à l'écrit). Repères : 1 ≈ A1, 2 ≈ A2, 3 ≈ B1, 4 ≈ B2, 5 ≈ C1. Note d'abord les critères, puis la tâche. levelEstimate : le niveau que montre cette production.
        swScore : la note de la tâche sur le barème indiqué, s'il y en a un ; sinon 0.

        À l'oral, la réponse est une transcription automatique (Whisper) qui a pu lisser des fautes (articles, terminaisons) et ne dit rien de l'accent : ne juge pas la prononciation, ne relève pas une « faute » qui peut venir de la transcription, appuie la fluence sur les mesures (repères de débit : A2 ≈ 50 mots par minute, B1 ≈ 95, B2 et au-delà ≈ 120 ; silences longs et fréquents = fluence basse).
        Une réponse vide, hors sujet ou dans une autre langue vaut 0 pour la tâche : dis-le simplement, sans edits.
        """;

    private static readonly string Schema = ExerciseGenre.Compact("""
        {"type":"object","additionalProperties":false,"required":["scores","swScore","corrected","edits","strengthsFr","priorityFr","feedbackFr","redo","usefulPhrases","cards","levelEstimate"],"properties":{
        "scores":{"type":"object","additionalProperties":false,"required":["task","coherence","range","accuracy","fluency"],"properties":{"task":{"type":"integer","description":"0 à 5"},"coherence":{"type":"integer"},"range":{"type":"integer"},"accuracy":{"type":"integer"},"fluency":{"type":"integer","description":"0 à l'écrit"}}},
        "swScore":{"type":"number","description":"Note sur le barème de la tâche s'il est donné, sinon 0"},
        "corrected":{"type":"string"},
        "edits":{"type":"array","items":{"type":"object","additionalProperties":false,"required":["type","category","original","correction","explanationFr","priority"],"properties":{"type":{"type":"string","enum":["error","improvement"]},"category":{"type":"string","enum":@TAX@},"original":{"type":"string","description":"Extrait exact de la réponse de l'apprenant"},"correction":{"type":"string"},"explanationFr":{"type":"string"},"priority":{"type":"integer","description":"1, 2 ou 3"}}}},
        "strengthsFr":{"type":"array","items":{"type":"string"}},
        "priorityFr":{"type":"string"},"feedbackFr":{"type":"string"},"redo":{"type":"string"},
        "usefulPhrases":{"type":"array","items":{"type":"string"}},
        "cards":{"type":"array","items":{"type":"object","additionalProperties":false,"required":["kind","front","back","example"],"properties":{"kind":{"type":"string","enum":["word","collocation","phrase","false_friend","grammar","pronunciation"]},"front":{"type":"string"},"back":{"type":"string"},"example":{"type":"string"}}}},
        "levelEstimate":{"type":"string","enum":["A2","B1","B1+","B2","B2+","C1"]}}}
        """.Replace("@TAX@", Taxonomy.Enum));

    /// <summary>Grilles du format S&amp;W, paraphrasees (toeic.md §6.2 et §6.3).</summary>
    private static string Rubric(string kind, int scale) => kind switch
    {
        "read_aloud" => "Lecture à voix haute : swScore = moyenne de deux notes de 0 à 3, prononciation (intelligibilité) et intonation-accentuation, estimées prudemment d'après la transcription et les mesures (3 : très intelligible, mots tous reconnus, pauses aux ponctuations ; 2 : globalement intelligible, quelques écarts ; 1 : intelligible par moments ; 0 : rien ou pas d'anglais).",
        "describe" or "respond" or "respond_info" => "Barème 0 à 3 : 3 = réponse complète, pertinente et adaptée (pour un document, informations exactes), vocabulaire et structures suffisants ; 2 = réponse partielle ou imprécise, vocabulaire limité mais sens clair ; 1 = ne répond pas efficacement, vocabulaire inexact ou répétition de la question ; 0 = rien, pas d'anglais ou hors sujet.",
        "opinion" => "Barème 0 à 5 : 5 = position claire, soutenue de façon cohérente (raisons, détails, exemples, liens explicites), débit fluide, bon contrôle des structures simples et complexes ; 4 = position claire, justification adéquate mais pas entièrement développée, gamme limitée ; 3 = position exprimée, au moins une raison, peu développée ou répétitive, surtout des structures de base ; 2 = position pertinente mais soutien absent ou confus, débit haché ; 1 = mots isolés, pas d'opinion intelligible ; 0 = rien, pas d'anglais, hors sujet.",
        "sentence" => "Barème 0 à 3 : 3 = une phrase sans faute, avec les deux mots bien employés, cohérente avec la situation ; 2 = erreurs qui ne gênent pas le sens, deux mots présents ; 1 = erreur qui gêne le sens, mot manquant ou phrase sans rapport ; 0 = vide ou autre langue.",
        "email" => "Barème 0 à 4 : 4 = toutes les consignes traitées en plusieurs phrases claires, liens logiques, ton adapté, quelques fautes isolées ; 3 = une consigne manquée ou incomplète, organisation partielle ; 2 = une seule consigne traitée, ou plusieurs de façon incomplète, liens absents ; 1 = aucune consigne, ton inadapté, fautes fréquentes ; 0 = copie de la consigne, hors sujet, autre langue ou vide.",
        "essay" => "Barème 0 à 5 : 5 = traite pleinement le sujet, bien organisé et développé (explications, exemples), syntaxe variée, mots justes, fautes mineures ; 4 = quelques points peu développés, redondances occasionnelles ; 3 = développement moyen, liens parfois obscurs, gamme exacte mais limitée ; 2 = développement limité, organisation insuffisante, fautes accumulées ; 1 = désorganisé, presque sans détail, fautes graves ; 0 = copie, hors sujet, autre langue ou vide.",
        _ => $"Barème de la tâche : 0 à {scale}, proportionnel à la réussite de la tâche (consignes, pertinence, langue).",
    };

    public static AgentCall Compose(LearnRequest r)
    {
        var p = r.Params;
        var mode = LJ.Pick(LJ.Str(p, "mode", 10), new[] { "write", "speak" }, "write");
        var rubric = LJ.Pick(LJ.Str(p, "rubric", 10), new[] { "lesson", "sw" }, "lesson");
        var level = Levels.Normalize(LJ.Str(p, "level", 10));
        var task = LJ.Obj(p, "task");
        var kind = LJ.Str(task, "kind", 30);
        var scale = LJ.Int(task, "scale");
        var response = LJ.Str(p, "response", 12000);

        var sb = new StringBuilder();
        sb.Append("Mode : ").Append(mode == "write" ? "écrit (texte tapé)" : "oral (transcription automatique)").Append(".\n");
        sb.Append(Levels.Line(level)).Append('\n');
        sb.Append(Levels.ExplainRule(level, LJ.Str(p, "explain", 10))).Append('\n');
        if (rubric == "sw" && scale > 0)
        {
            sb.Append("Bilan au format S&W, tâche « ").Append(kind).Append(" » : ").Append(Rubric(kind, scale)).Append('\n');
        }
        else
        {
            sb.Append("Tâche de cours : notes analytiques seulement, swScore = 0.\n");
        }

        var targets = LJ.Strings(p, "targets", 10, 40).Select(Taxonomy.Normalize).Distinct().ToList();
        sb.Append("Cibles actives (catégories d'erreurs à surveiller en priorité) : ").Append(targets.Count > 0 ? string.Join(", ", targets) : "aucune").Append(".\n");
        sb.Append("Taxonomie des catégories : ").Append(Taxonomy.Listing()).Append(".\n\n");

        sb.Append("La tâche :\n");
        var promptFr = LJ.Str(task, "promptFr", 1500);
        var prompt = LJ.Str(task, "prompt", 1500);
        if (promptFr.Length > 0)
        {
            sb.Append("- Consigne : ").Append(promptFr).Append('\n');
        }

        if (prompt.Length > 0)
        {
            sb.Append("- Consigne en anglais ou stimulus : ").Append(prompt).Append('\n');
        }

        var criteria = LJ.Strings(task, "criteria", 6, 300);
        if (criteria.Count > 0)
        {
            sb.Append("- Critères de réussite : ").Append(string.Join(" ; ", criteria)).Append('\n');
        }

        var range = LJ.Arr(task, "words");
        if (range is { Count: >= 2 })
        {
            sb.Append("- Longueur attendue : ").Append(LJ.Int(new JsonObject { ["v"] = range[0]?.DeepClone() }, "v")).Append(" à ")
              .Append(LJ.Int(new JsonObject { ["v"] = range[1]?.DeepClone() }, "v")).Append(" mots.\n");
        }

        var seconds = LJ.Int(task, "seconds");
        if (seconds > 0)
        {
            sb.Append("- Temps ").Append(mode == "speak" ? "de parole" : "conseillé").Append(" : ").Append(seconds).Append(" secondes.\n");
        }

        sb.Append("\nRéponse de l'apprenant (").Append(mode == "write" ? "texte tapé" : "transcription Whisper").Append(", ").Append(LJ.Words(response)).Append(" mots) :\n\"\"\"\n")
          .Append(response.Length > 0 ? response : "(vide)").Append("\n\"\"\"\n");

        var metrics = LJ.Obj(p, "metrics");
        if (mode == "speak" && metrics is not null)
        {
            sb.Append("\nMesures de l'oral : durée ").Append(LJ.Num(metrics, "seconds").ToString("0", CultureInfo.InvariantCulture)).Append(" s ; débit ")
              .Append(LJ.Num(metrics, "wpm").ToString("0", CultureInfo.InvariantCulture)).Append(" mots par minute");
            if (metrics["pauses"] is JsonArray pauses)
            {
                var total = pauses.OfType<JsonObject>().Sum(x => LJ.Num(x, "seconds"));
                var longOnes = pauses.OfType<JsonObject>().Count(x => LJ.Num(x, "seconds") >= 1);
                sb.Append(" ; ").Append(pauses.Count).Append(" silences d'au moins 0,3 s (").Append(longOnes).Append(" d'une seconde ou plus, ")
                  .Append(total.ToString("0.0", CultureInfo.InvariantCulture)).Append(" s en tout)");
            }
            else
            {
                sb.Append(" ; ").Append(LJ.Int(metrics, "pauses")).Append(" silences d'au moins 0,3 s");
            }

            var uncertain = LJ.Strings(metrics, "uncertain", 20, 40);
            sb.Append(uncertain.Count > 0 ? " ; mots peu sûrs dans la transcription : " + string.Join(", ", uncertain) : "").Append(".\n");
        }

        if (r.Context.Length > 0)
        {
            sb.Append('\n').Append(r.Context.Trim()).Append('\n');
        }

        sb.Append("\nRendez la fiche de correction.");
        return new AgentCall("", System + Levels.Quotes, Schema, sb.ToString());
    }

    public static JsonObject Sanitize(JsonObject o, LearnRequest r)
    {
        var p = r.Params;
        var mode = LJ.Pick(LJ.Str(p, "mode", 10), new[] { "write", "speak" }, "write");
        var rubric = LJ.Pick(LJ.Str(p, "rubric", 10), new[] { "lesson", "sw" }, "lesson");
        var scale = Math.Clamp(LJ.Int(LJ.Obj(p, "task"), "scale"), 0, 5);
        var response = LJ.Str(p, "response", 12000);
        var haystack = LJ.Key(response);

        var scores = LJ.Obj(o, "scores");
        int Score(string key) => Math.Clamp(LJ.Int(scores, key), 0, 5);

        // Edits : l'original doit figurer tel quel dans la reponse ; trois error prioritaires au plus.
        var kept = new List<(string Type, string Category, string Original, string Correction, string Explanation, int Priority)>();
        foreach (var e in LJ.Objects(o, "edits"))
        {
            var original = LJ.Str(e, "original", 400);
            var correction = LJ.Str(e, "correction", 400);
            var key = LJ.Key(original);
            if (key.Length == 0 || !haystack.Contains(key, StringComparison.Ordinal) || LJ.Key(correction) == key || kept.Count >= 15)
            {
                continue;
            }

            kept.Add((LJ.Pick(LJ.Str(e, "type", 20), new[] { "error", "improvement" }, "error"), Taxonomy.Normalize(LJ.Str(e, "category", 40)),
                original, correction, ExplanationClip(LJ.Str(e, "explanationFr", 600)), Math.Clamp(LJ.Int(e, "priority", 2), 1, 3)));
        }

        var errors = kept.Where(k => k.Type == "error").OrderBy(k => k.Priority).ToList();
        var improvements = kept.Where(k => k.Type == "improvement").Take(3).ToList();
        var edits = new JsonArray();
        var urgent = 0;
        foreach (var e in errors)
        {
            var priority = e.Priority;
            if (priority <= 2 && ++urgent > 3)
            {
                priority = 3;
            }

            edits.Add(Edit(e.Type, e.Category, e.Original, e.Correction, e.Explanation, priority));
        }

        foreach (var e in improvements)
        {
            edits.Add(Edit(e.Type, e.Category, e.Original, e.Correction, e.Explanation, Math.Max(2, e.Priority)));
        }

        var corrected = LJ.Str(o, "corrected", 12000);
        if (corrected.Length == 0)
        {
            corrected = response;
            foreach (var e in errors)
            {
                corrected = ReplaceLoose(corrected, e.Original, e.Correction);
            }
        }

        var cards = new JsonArray();
        foreach (var c in LJ.Objects(o, "cards"))
        {
            var front = LJ.Str(c, "front", 300);
            var back = LJ.Str(c, "back", 300);
            if (front.Length > 0 && back.Length > 0 && cards.Count < 6)
            {
                cards.Add(new JsonObject
                {
                    ["kind"] = LJ.Pick(LJ.Str(c, "kind", 20), CardKinds, "phrase"),
                    ["front"] = front,
                    ["back"] = back,
                    ["example"] = LJ.Str(c, "example", 300),
                });
            }
        }

        var sw = rubric == "sw" && scale > 0 ? Math.Clamp(Math.Round(LJ.Num(o, "swScore") * 2) / 2, 0, scale) : 0;
        return new JsonObject
        {
            ["scores"] = new JsonObject
            {
                ["task"] = Score("task"),
                ["coherence"] = Score("coherence"),
                ["range"] = Score("range"),
                ["accuracy"] = Score("accuracy"),
                ["fluency"] = mode == "speak" ? Score("fluency") : 0,
            },
            ["swScore"] = sw,
            ["corrected"] = corrected,
            ["edits"] = edits,
            ["strengthsFr"] = LJ.Array(LJ.Strings(o, "strengthsFr", 3, 400)),
            ["priorityFr"] = LJ.Str(o, "priorityFr", 400),
            ["feedbackFr"] = LJ.Str(o, "feedbackFr", 1500),
            ["redo"] = LJ.Str(o, "redo", 600),
            ["usefulPhrases"] = LJ.Array(LJ.Strings(o, "usefulPhrases", 4, 200)),
            ["cards"] = cards,
            ["levelEstimate"] = Levels.Normalize(LJ.Str(o, "levelEstimate", 10), Levels.Normalize(LJ.Str(p, "level", 10))),
        };
    }

    private static JsonObject Edit(string type, string category, string original, string correction, string explanation, int priority) => new()
    {
        ["type"] = type,
        ["category"] = category,
        ["original"] = original,
        ["correction"] = correction,
        ["explanationFr"] = explanation,
        ["priority"] = priority,
    };

    /// <summary>Remplace la premiere occurrence de <paramref name="original"/>, casse et blancs ignores.</summary>
    private static string ReplaceLoose(string text, string original, string correction)
    {
        var words = original.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
        if (words.Length == 0)
        {
            return text;
        }

        var match = Regex.Match(text, string.Join(@"\s+", words.Select(Regex.Escape)), RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        return match.Success ? text[..match.Index] + correction + text[(match.Index + match.Length)..] : text;
    }

    /// <summary>Explication courte : 25 mots demandes, 40 toleres.</summary>
    private static string ExplanationClip(string text)
    {
        var words = text.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        return words.Length <= 40 ? text : string.Join(" ", words.Take(40)) + "…";
    }
}

// ============================================================================ tuteur

/// <summary>
/// Tour du tuteur vocal (<c>tutor</c>, spec §5.7) : rapide (haiku, sans outil), une reponse courte qui
/// relance, une reformulation discrete, le bilan seulement a la fin.
/// </summary>
internal static class TutorGenre
{
    private const string System = """
        Tu es le tuteur d'anglais d'Organizator : un interlocuteur chaleureux, patient et curieux, qui parle avec un adulte francophone pour l'aider à parler anglais, tour par tour — ses répliques sont transcrites par reconnaissance vocale, les tiennes lues par une voix de synthèse. Ta personnalité reste la même d'une séance à l'autre : bienveillant, une pointe d'humour, sincèrement intéressé par ce que dit l'apprenant, jamais professoral. Quand un scénario te donne un rôle (réceptionniste, collègue, recruteur…), tu joues ce rôle avec naturel et tu aides l'apprenant à atteindre son objectif. Tu rends uniquement la fiche demandée.

        Ta réplique (reply)
        - En anglais, une à trois phrases courtes, comme à l'oral (contractions, mots simples). Adapte ton anglais au niveau indiqué : phrases courtes et vocabulaire courant en A2-B1, plus riche et idiomatique en B2-C1.
        - Réagis d'abord à ce que l'apprenant a dit (le sens avant la forme), puis termine le plus souvent par UNE question ouverte qui relance l'échange.
        - Elle est lue par la synthèse vocale : ni émoticône, ni didascalie, ni liste, ni mise en forme, ni nom de locuteur.
        - replyFr : la traduction française fidèle de reply.

        Pendant l'échange, pas de correction appuyée
        - recast : si la dernière phrase de l'apprenant contient une faute qui gêne ou une erreur typique de francophone, said = l'extrait exact de sa phrase, better = la même idée bien dite ; tu peux reprendre discrètement la bonne forme dans ta réplique (« Oh, you've lived there for ten years? ») sans dire qu'il s'est trompé. Sinon said et better restent vides. La transcription peut contenir des erreurs de reconnaissance : ne corrige pas ce qui peut en venir.
        - tipFr : le plus souvent vide ; une aide très courte (un mot qui lui manquait, une tournure utile), dans la langue d'aide indiquée, seulement s'il a cherché ses mots, répondu en français ou demandé de l'aide.
        - end : vrai si l'objectif du scénario est atteint, si l'échange a fait le tour du sujet, ou après une quinzaine d'échanges ; propose alors gentiment de conclure dans reply.

        Si la conversation n'a pas commencé, ouvre-la : une salutation et une première question simple, dans ton rôle.

        Quand la fin est demandée : reply = une conclusion chaleureuse d'une ou deux phrases, sans question ; end = vrai ; summary = errors (deux à quatre erreurs réelles de l'apprenant pendant l'échange : said = l'extrait exact, better, explanationFr de 25 mots au plus, category de la taxonomie), phrases (trois tournures utiles employées ou à retenir), feedbackFr (trois phrases encourageantes et concrètes, en français, en vouvoyant), levelEstimate (A2, B1, B1+, B2, B2+ ou C1). Sinon summary reste vide : listes vides, chaînes vides.
        """;

    private static readonly string Schema = ExerciseGenre.Compact("""
        {"type":"object","additionalProperties":false,"required":["reply","replyFr","recast","tipFr","end","summary"],"properties":{
        "reply":{"type":"string"},"replyFr":{"type":"string"},
        "recast":{"type":"object","additionalProperties":false,"required":["said","better"],"properties":{"said":{"type":"string"},"better":{"type":"string"}}},
        "tipFr":{"type":"string"},"end":{"type":"boolean"},
        "summary":{"type":"object","additionalProperties":false,"required":["errors","phrases","feedbackFr","levelEstimate"],"properties":{
          "errors":{"type":"array","items":{"type":"object","additionalProperties":false,"required":["said","better","explanationFr","category"],"properties":{"said":{"type":"string"},"better":{"type":"string"},"explanationFr":{"type":"string"},"category":{"type":"string","enum":@TAX@}}}},
          "phrases":{"type":"array","items":{"type":"string"}},"feedbackFr":{"type":"string"},
          "levelEstimate":{"type":"string","description":"A2, B1, B1+, B2, B2+ ou C1 ; vide si la fin n'est pas demandée"}}}}}
        """.Replace("@TAX@", Taxonomy.Enum));

    private static List<(string Role, string Text)> History(JsonObject p)
        => LJ.Objects(p, "history")
            .Select(h => (Role: LJ.Pick(LJ.Str(h, "role", 10), new[] { "user", "tutor" }, "user"), Text: LJ.Str(h, "text", 1200)))
            .Where(h => h.Text.Length > 0)
            .TakeLast(12)
            .ToList();

    public static AgentCall Compose(LearnRequest r)
    {
        var p = r.Params;
        var level = Levels.Normalize(LJ.Str(p, "level", 10));
        var end = LJ.Bool(p, "end");
        var help = LJ.Pick(LJ.Str(p, "lang", 4), new[] { "en", "fr" }, "fr");
        var scenario = LJ.Obj(p, "scenario");
        var lesson = LJ.Obj(p, "lesson");

        var sb = new StringBuilder();
        sb.Append(Levels.Line(level, "Niveau de l'apprenant")).Append('\n');
        sb.Append("Langue de l'aide (tipFr, explications) : ").Append(help == "fr" ? "français" : "anglais simple").Append(".\n");
        var title = LJ.Str(scenario, "title", 200);
        if (title.Length > 0)
        {
            sb.Append("Scénario : « ").Append(title).Append(" »");
            var role = LJ.Str(scenario, "tutorRole", 200);
            var goal = LJ.Str(scenario, "learnerGoal", 400);
            var setting = LJ.Str(scenario, "setting", 400);
            if (role.Length > 0)
            {
                sb.Append(" ; ton rôle : ").Append(role);
            }

            if (goal.Length > 0)
            {
                sb.Append(" ; objectif de l'apprenant : ").Append(goal);
            }

            if (setting.Length > 0)
            {
                sb.Append(" ; cadre : ").Append(setting);
            }

            sb.Append(".\n");
        }
        else
        {
            sb.Append("Scénario : conversation libre, sur ce qui intéresse l'apprenant.\n");
        }

        var lessonTitle = LJ.Str(lesson, "title", 200);
        if (lessonTitle.Length > 0)
        {
            sb.Append("Cours du jour (sujet possible si la conversation s'y prête) : « ").Append(lessonTitle).Append(" » — ").Append(LJ.Str(lesson, "summaryFr", 400)).Append('\n');
        }

        if (r.Context.Length > 0)
        {
            sb.Append('\n').Append(r.Context.Trim()).Append('\n');
        }

        if (end)
        {
            sb.Append("Taxonomie (summary.errors.category) : ").Append(Taxonomy.Listing()).Append(".\n");
        }

        var history = History(p);
        sb.Append("\nConversation jusqu'ici :\n");
        if (history.Count == 0)
        {
            sb.Append("(aucune : ouvrez la conversation)\n");
        }

        foreach (var (role, text) in history)
        {
            sb.Append(role == "tutor" ? "Tutor: " : "Learner: ").Append(text.Replace('\n', ' ')).Append('\n');
        }

        sb.Append(end
            ? "\nFin demandée par l'apprenant : rédigez la conclusion et le bilan (summary)."
            : "\nRédigez votre prochaine réplique.");
        return new AgentCall("", System + Levels.Quotes, Schema, sb.ToString());
    }

    public static JsonObject Sanitize(JsonObject o, LearnRequest r)
    {
        var p = r.Params;
        var end = LJ.Bool(p, "end");
        var history = History(p);
        var lastUser = history.LastOrDefault(h => h.Role == "user").Text ?? "";
        var allUser = LJ.Key(string.Join(" \n ", history.Where(h => h.Role == "user").Select(h => h.Text)));

        var reply = Speech.Clean(LJ.Str(o, "reply", 1200), new[] { "Tutor", "Tuteur" }, 1200);
        if (reply.Length == 0)
        {
            throw new InvalidOperationException("Le tuteur n’a rien répondu.");
        }

        var recast = LJ.Obj(o, "recast");
        var said = LJ.Str(recast, "said", 400);
        var better = LJ.Str(recast, "better", 400);
        if (said.Length == 0 || better.Length == 0 || LJ.Key(said) == LJ.Key(better) || !LJ.Key(lastUser).Contains(LJ.Key(said), StringComparison.Ordinal))
        {
            said = "";
            better = "";
        }

        var summary = LJ.Obj(o, "summary");
        var errors = new JsonArray();
        var phrases = new List<string>();
        var feedback = "";
        var estimate = "";
        if (end)
        {
            foreach (var e in LJ.Objects(summary, "errors"))
            {
                var s = LJ.Str(e, "said", 400);
                var b = LJ.Str(e, "better", 400);
                if (s.Length == 0 || b.Length == 0 || !allUser.Contains(LJ.Key(s), StringComparison.Ordinal) || errors.Count >= 5)
                {
                    continue;
                }

                errors.Add(new JsonObject
                {
                    ["said"] = s,
                    ["better"] = b,
                    ["explanationFr"] = LJ.Str(e, "explanationFr", 400),
                    ["category"] = Taxonomy.Normalize(LJ.Str(e, "category", 40)),
                });
            }

            phrases = LJ.Strings(summary, "phrases", 5, 200);
            feedback = LJ.Str(summary, "feedbackFr", 1200);
            estimate = LJ.Pick(LJ.Str(summary, "levelEstimate", 10), Levels.All, "");
        }

        return new JsonObject
        {
            ["reply"] = reply,
            ["replyFr"] = LJ.Str(o, "replyFr", 1200),
            ["recast"] = new JsonObject { ["said"] = said, ["better"] = better },
            ["tipFr"] = LJ.Str(o, "tipFr", 400),
            ["end"] = end || LJ.Bool(o, "end"),
            ["summary"] = new JsonObject
            {
                ["errors"] = errors,
                ["phrases"] = LJ.Array(phrases),
                ["feedbackFr"] = feedback,
                ["levelEstimate"] = estimate,
            },
        };
    }
}

// ============================================================================ cartes

/// <summary>
/// Le correcteur des cartes de revision, rapide (haiku, sans outil) : <c>cardcheck</c> relit une
/// reponse que la comparaison stricte a refusee — synonyme, variante, faute de frappe — et dit ce
/// qu'il fallait taper ; <c>cardfix</c> reecrit les cartes dont le verso melange la reponse et son
/// explication, pour qu'on sache quoi repondre. Ni l'un ni l'autre n'est enregistre : la page
/// applique le verdict ou la reecriture a ses cartes.
/// </summary>
internal static class CardGenre
{
    private static readonly string[] Verdicts = { "right", "close", "wrong" };
    private static readonly string[] Kinds = { "word", "collocation", "phrase", "false_friend", "grammar", "pronunciation", "error" };

    private const string CheckSystem = """
        Tu es le correcteur des cartes de révision de Révizator, l'espace où un adulte francophone apprend l'anglais. L'apprenant vient de taper sa réponse à une carte ; la vérification automatique, qui compare au caractère près, l'a refusée. Tu juges si elle est juste, avec le discernement d'un bon professeur : ni laxiste, ni pointilleux. Tu rends uniquement la fiche demandée.

        Le verdict
        - right : la réponse dit ce que la carte demande, en anglais correct. Une carte n'a pas une seule bonne réponse : un synonyme courant, une autre tournure naturelle, une contraction ou la forme pleine, un article ou un « to » en plus ou en moins quand c'est indifférent, l'orthographe britannique ou américaine, les majuscules et la ponctuation sont acceptés.
        - close : la bonne réponse avec une petite faute sans conséquence sur le sens (faute de frappe, lettre oubliée, accord manquant).
        - wrong : un autre sens, une vraie faute de grammaire, un faux ami, une réponse en français quand l'anglais est demandé, ou une réponse qui contourne ce que la carte fait travailler (le temps demandé, le mot ciblé, la préposition visée). Une carte « erreur à corriger » exige que l'erreur soit corrigée.
        - Si la carte est elle-même ambiguë (plusieurs réponses possibles sans indice pour choisir), toute réponse valable est juste : dis-le dans l'explication.

        Le retour
        - expected : ce qu'il fallait taper, court et exact, sans explication ni parenthèse — la réponse de l'apprenant si elle est juste, sinon la meilleure réponse.
        - explanationFr : une ou deux phrases en français, en vouvoyant : pourquoi c'est juste ou non, et ce que la carte fait travailler. Pas de formule de politesse.
        - accept : vrai seulement si le verdict est right et que la réponse de l'apprenant doit désormais être acceptée telle quelle pour cette carte.
        """;

    private const string FixSystem = """
        Tu es le correcteur des cartes de révision de Révizator, l'espace où un adulte francophone apprend l'anglais. Certaines cartes sont floues : le verso mélange la réponse et son explication (« actually = en fait / vraiment. Actuellement = currently. »), plusieurs réponses sont collées par des barres obliques, une phrase à trous ne dit pas quoi mettre, ou la question admet plusieurs réponses. L'apprenant tape sa réponse, comparée à la réponse attendue : il doit savoir exactement quoi écrire. Tu réécris chaque carte pour cela, sans changer ce qu'elle fait travailler. Tu rends uniquement la fiche demandée.

        Pour chaque carte (même id, même kind)
        - front : la question. Une phrase à compléter garde ses trous (___ pour chaque mot ou groupe attendu) et porte entre parenthèses l'indice qui lève l'ambiguïté (le sens en français, le verbe à conjuguer, « deux mots »). Un sens en français à traduire reste en français, précisé si besoin (« (verbe) », « (registre familier) »). Une erreur à corriger (kind error) reste la phrase fautive, telle quelle.
        - answer : la réponse à taper, seule, sans explication ni parenthèse ni barre oblique. C'est le mot ou la tournure que la carte fait travailler — celui que le recto ou le début du verso met en avant (« actually » pour une carte sur le faux ami « actually ») —, jamais un synonyme qui le contourne ; la question doit donc y mener sans ambiguïté. Pour plusieurs trous : les mots attendus dans l'ordre, séparés par une espace. Pour une erreur à corriger : la phrase corrigée entière. Pour un recto anglais à comprendre (reconnaissance) : la traduction française courte.
        - accepted : les autres réponses justes, complètes (0 à 5) : synonymes, formes contractées, variantes britanniques.
        - note : en français, une ou deux phrases : ce qui, dans l'ancien verso, n'était pas la réponse (la règle, le piège, la nuance). Vide s'il n'y a rien à dire.
        - example : une phrase naturelle en anglais qui emploie la réponse ; garde celle de la carte si elle convient.
        Une carte déjà claire est rendue telle quelle, avec ses variantes acceptées.
        """;

    private static readonly string CheckSchema = ExerciseGenre.Compact("""
        {"type":"object","additionalProperties":false,"required":["verdict","expected","explanationFr","accept"],"properties":{
        "verdict":{"type":"string","enum":["right","close","wrong"]},"expected":{"type":"string"},"explanationFr":{"type":"string"},"accept":{"type":"boolean"}}}
        """);

    private static readonly string FixSchema = ExerciseGenre.Compact("""
        {"type":"object","additionalProperties":false,"required":["cards"],"properties":{
        "cards":{"type":"array","items":{"type":"object","additionalProperties":false,"required":["id","front","answer","accepted","note","example"],"properties":{
          "id":{"type":"string"},"front":{"type":"string"},"answer":{"type":"string"},"accepted":{"type":"array","items":{"type":"string"}},
          "note":{"type":"string"},"example":{"type":"string"}}}}}}
        """);

    private static void AppendCard(StringBuilder sb, JsonObject? card)
    {
        sb.Append("Genre de la carte : ").Append(LJ.Pick(LJ.Str(card, "kind", 20), Kinds, "phrase")).Append('\n');
        sb.Append("Recto : ").Append(LJ.Str(card, "front", 300)).Append('\n');
        sb.Append("Verso : ").Append(LJ.Str(card, "back", 400)).Append('\n');
        var example = LJ.Str(card, "example", 300);
        if (example.Length > 0)
        {
            sb.Append("Exemple : ").Append(example).Append('\n');
        }

        var note = LJ.Str(card, "note", 300);
        if (note.Length > 0)
        {
            sb.Append("Note : ").Append(note).Append('\n');
        }

        var accepted = LJ.Strings(card, "accepted", 8, 200);
        if (accepted.Count > 0)
        {
            sb.Append("Déjà acceptées : ").Append(string.Join(" | ", accepted)).Append('\n');
        }
    }

    public static AgentCall ComposeCheck(LearnRequest r)
    {
        var p = r.Params;
        var sb = new StringBuilder();
        sb.Append(Levels.Line(Levels.Normalize(LJ.Str(p, "level", 10)), "Niveau de l'apprenant")).Append('\n');
        AppendCard(sb, LJ.Obj(p, "card"));
        var instruction = LJ.Str(p, "instruction", 120);
        sb.Append("\nCe que la révision demandait : ").Append(instruction.Length > 0 ? instruction : "répondre").Append('\n');
        sb.Append("Question affichée : ").Append(LJ.Str(p, "prompt", 400)).Append('\n');
        var expected = LJ.Strings(p, "expected", 6, 300);
        if (expected.Count > 0)
        {
            sb.Append("Réponses que la vérification automatique attendait : ").Append(string.Join(" | ", expected)).Append('\n');
        }

        sb.Append("\nRéponse tapée par l'apprenant : « ").Append(LJ.Str(p, "answer", 300)).Append(" »\n");
        sb.Append("\nJugez cette réponse.");
        return new AgentCall("", CheckSystem + Levels.Quotes, CheckSchema, sb.ToString());
    }

    public static JsonObject SanitizeCheck(JsonObject o)
    {
        var verdict = LJ.Pick(LJ.Str(o, "verdict", 10), Verdicts, "wrong");
        return new JsonObject
        {
            ["verdict"] = verdict,
            ["expected"] = LJ.Str(o, "expected", 300),
            ["explanationFr"] = LJ.Str(o, "explanationFr", 500),
            ["accept"] = verdict == "right" && LJ.Bool(o, "accept"),
        };
    }

    public static AgentCall ComposeFix(LearnRequest r)
    {
        var p = r.Params;
        var sb = new StringBuilder();
        sb.Append(Levels.Line(Levels.Normalize(LJ.Str(p, "level", 10)), "Niveau de l'apprenant")).Append('\n');
        sb.Append("\nCartes à rendre claires :\n");
        foreach (var card in LJ.Objects(p, "cards").Take(20))
        {
            sb.Append("\n[id ").Append(LJ.Str(card, "id", 40)).Append("]\n");
            AppendCard(sb, card);
        }

        sb.Append("\nRéécrivez chaque carte (même id).");
        return new AgentCall("", FixSystem + Levels.Quotes, FixSchema, sb.ToString());
    }

    /// <summary>
    /// Ne garde que les cartes demandees, completes ; une phrase a trous reste une phrase a trous, une
    /// erreur a corriger garde sa phrase fautive. Une carte ecartee reste telle quelle cote page.
    /// </summary>
    public static JsonObject SanitizeFix(JsonObject o, LearnRequest r)
    {
        var asked = LJ.Objects(r.Params, "cards").Take(20)
            .GroupBy(c => LJ.Str(c, "id", 40))
            .Where(g => g.Key.Length > 0)
            .ToDictionary(g => g.Key, g => g.First(), StringComparer.Ordinal);
        var cards = new JsonArray();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var c in LJ.Objects(o, "cards"))
        {
            var id = LJ.Str(c, "id", 40);
            if (!asked.TryGetValue(id, out var before) || !seen.Add(id))
            {
                continue;
            }

            var front = LJ.Str(c, "front", 300);
            var answer = LJ.Str(c, "answer", 300);
            var oldFront = LJ.Str(before, "front", 300);
            var kind = LJ.Str(before, "kind", 20);
            if (front.Length == 0 || answer.Length == 0)
            {
                continue;
            }

            if (kind == "error")
            {
                front = oldFront;
            }
            else if (oldFront.Contains("__", StringComparison.Ordinal) != front.Contains("__", StringComparison.Ordinal))
            {
                // Une phrase a trous devenue autre chose (ou l'inverse) ne travaille plus la meme chose.
                continue;
            }

            var accepted = LJ.Strings(c, "accepted", 5, 200)
                .Where(a => LJ.Key(a) != LJ.Key(answer))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToList();
            cards.Add(new JsonObject
            {
                ["id"] = id,
                ["front"] = front,
                ["answer"] = answer,
                ["accepted"] = LJ.Array(accepted),
                ["note"] = LJ.Str(c, "note", 300),
                ["example"] = LJ.Str(c, "example", 300),
            });
        }

        return new JsonObject { ["cards"] = cards };
    }
}
