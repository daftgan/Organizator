using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Organizator.Services;

/// <summary>Ce qu'il faut pour lancer ou reprendre une session hebergee : les parametres d'Organizator.</summary>
public sealed record LiveLaunch(string Provider, string Cwd, string Title, string Context, string Model, string Effort);

/// <summary>
/// Sessions d'agent hebergees par Organizator, sans console (reglage « Terminal » = <c>app</c>) : la
/// fenetre Conversations les affiche et les pilote. Organizator reste le moteur, avec exactement les
/// parametres d'un lancement en console — modele, effort, contexte (consignes des mots-cles, equipe,
/// travail deja fait), sans confirmation, premier message envoye d'office — et les sessions restent
/// celles des outils : memes fichiers sous <c>~/.claude/projects</c> et <c>~/.copilot/session-state</c>,
/// que l'etat, les rapports et la consommation continuent de lire, et qui se reprennent aussi en console.
///
/// Claude Code : un processus <c>claude -p --input-format stream-json --output-format stream-json</c> par
/// session, avec <c>--dangerously-skip-permissions</c> et <c>--permission-prompt-tool stdio</c> — ce
/// dernier fait remonter les questions de l'agent (<c>AskUserQuestion</c>) et l'approbation d'un plan
/// (<c>ExitPlanMode</c>) par une requete de controle <c>can_use_tool</c>, sans quoi l'outil n'existe pas
/// hors terminal. Le contexte part en <c>--append-system-prompt</c> ; Claude Code l'enregistre a la
/// premiere requete et le reutilise a chaque reprise.
///
/// GitHub Copilot : un processus <c>copilot --acp --allow-all</c> par session (Agent Client Protocol,
/// JSON-RPC sur stdio) ; <c>session/new</c> donne l'identifiant (<c>--session-id</c> est refuse avec
/// <c>--acp</c>), <c>session/load</c> reprend une session existante, <c>session/prompt</c> porte chaque
/// message, <c>session/cancel</c> l'interrompt. Copilot n'ayant pas de prompt systeme, le contexte part
/// en tete du premier message, comme en console, precede du titre de la tache : en ACP, Copilot ignore
/// <c>--name</c> et nomme la session d'apres ce premier message.
///
/// Une session existante n'a de processus qu'a partir du premier message qu'on lui envoie (reprise
/// paresseuse) ; un processus vit jusqu'a ce qu'on ferme la session, ou qu'Organizator se ferme.
/// L'avancement part par <see cref="Progress"/> (evenement <c>live</c> de la page).
/// </summary>
public sealed class LiveSessions : IDisposable
{
    private static readonly TimeSpan TextEvery = TimeSpan.FromMilliseconds(120);
    private static readonly TimeSpan InterruptGrace = TimeSpan.FromSeconds(3);
    private static readonly TimeSpan CopilotStart = TimeSpan.FromSeconds(60);
    private const int MaxText = 100_000;
    private const int MaxSteps = 40;
    private const int MaxStderr = 4000;
    private static readonly JsonSerializerOptions LineJson = new() { Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    private readonly AgentLauncher _launcher;
    private readonly HostLog _log;
    private readonly object _gate = new();
    private readonly Dictionary<string, LiveSession> _sessions = new(StringComparer.OrdinalIgnoreCase);
    private bool _disposed;

    public LiveSessions(AgentLauncher launcher, HostLog log)
    {
        _launcher = launcher;
        _log = log;

        // Filet : des agents orphelins continueraient de tourner apres la fermeture de l'application.
        AppDomain.CurrentDomain.ProcessExit += (_, _) => Dispose();
    }

    /// <summary>
    /// Avancement d'une session : <c>{ sessionId, phase, … }</c>, leve hors du fil de l'interface. Phases :
    /// <c>state</c> (<c>running</c>, <c>busy</c>), <c>user</c> (<c>text</c> : message parti), <c>thinking</c>,
    /// <c>text</c> (<c>msg</c>, <c>text</c> complet du message jusque-la), <c>tool</c> (<c>id</c>, <c>name</c>,
    /// <c>detail</c>, <c>status</c> running | done | error), <c>question</c> (<c>request</c>, <c>kind</c> ask |
    /// plan, <c>questions</c> ou <c>plan</c>), <c>done</c> (<c>cost</c>, <c>ms</c>, <c>cancelled</c>),
    /// <c>error</c> (<c>error</c>), <c>notice</c> (<c>text</c>).
    /// </summary>
    public event Action<JsonObject>? Progress;

    // ------------------------------------------------------------------ commandes

    /// <summary>
    /// Nouvelle session hebergee : le processus demarre et recoit le premier message. Claude : identifiant
    /// tire ici ; Copilot : attribue par <c>session/new</c> (quelques secondes).
    /// </summary>
    public async Task<StartedSession> StartAsync(LiveLaunch launch, string prompt)
    {
        var directory = RequireDirectory(launch.Cwd);
        launch = launch with { Cwd = directory };
        if (_launcher.CommandFor(launch.Provider) is null)
        {
            throw new InvalidOperationException(AgentProvider.Label(launch.Provider) + " est introuvable sur ce poste.");
        }

        LiveSession session = launch.Provider == AgentProvider.Copilot
            ? new CopilotLive(this, "", launch, existing: false)
            : new ClaudeLive(this, Guid.NewGuid().ToString("D"), launch, existing: false);

        var id = await session.StartAsync(prompt).ConfigureAwait(false);
        lock (_gate)
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            _sessions[id] = session;
        }

        _log.Info($"Session {launch.Provider} hebergee demarree : {id} dans {directory}{Describe(launch, prompt)}");
        return new StartedSession(id, directory, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), null);
    }

    /// <summary>
    /// Enregistre une session existante (lancee en console, ou hebergee avant un redemarrage) : rien ne
    /// demarre ; le premier message la reprend. Une session deja hebergee garde son processus.
    /// </summary>
    public void Open(string sessionId, LiveLaunch launch)
    {
        var id = RequireId(sessionId);
        var directory = RequireDirectory(launch.Cwd);
        launch = launch with { Cwd = directory };
        lock (_gate)
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            if (_sessions.TryGetValue(id, out var known))
            {
                known.Update(launch);
                return;
            }

            _sessions[id] = launch.Provider == AgentProvider.Copilot
                ? new CopilotLive(this, id, launch, existing: true)
                : new ClaudeLive(this, id, launch, existing: true);
        }
    }

    /// <summary>
    /// Message de l'utilisateur : <c>{ sessionId, text, provider, cwd, title, model, effort }</c> — les
    /// parametres servent a reprendre une session que l'hote ne connaissait pas encore. Rend <c>{ sent }</c>.
    /// </summary>
    public JsonObject Send(JsonObject payload)
    {
        var text = (Str(payload, "text") ?? "").Trim();
        if (text.Length == 0)
        {
            throw new InvalidOperationException("Rien à envoyer : le message est vide.");
        }

        if (text.Length > MaxText)
        {
            throw new InvalidOperationException("Message trop long.");
        }

        var session = SessionFor(payload);
        session.Send(text);
        return new JsonObject { ["sent"] = true };
    }

    /// <summary>Interrompt la reponse en cours. Rend <c>{ stopped }</c>.</summary>
    public JsonObject Stop(string? sessionId)
        => new() { ["stopped"] = Find(sessionId)?.Interrupt() ?? false };

    /// <summary>
    /// Reponse a une question de l'agent : <c>{ sessionId, request, answers }</c> (AskUserQuestion :
    /// question → reponse) ou <c>{ sessionId, request, allow, message }</c> (approbation d'un plan).
    /// </summary>
    public JsonObject Answer(JsonObject payload)
    {
        var session = Find(Str(payload, "sessionId")) ?? throw new InvalidOperationException("Cette session n'est plus ouverte.");
        return new JsonObject { ["answered"] = session.Answer(payload) };
    }

    /// <summary>Ferme le processus de la session (la session reste, et se reprend). Rend <c>{ closed }</c>.</summary>
    public JsonObject Close(string? sessionId)
    {
        var session = Find(sessionId);
        if (session is null)
        {
            return new JsonObject { ["closed"] = false };
        }

        var closed = session.Kill("fermee depuis la fenetre Conversations");
        return new JsonObject { ["closed"] = closed };
    }

    /// <summary>Ce qui se passe dans chaque session hebergee, pour une fenetre qui s'ouvre en cours de route.</summary>
    public JsonObject State()
    {
        List<LiveSession> all;
        lock (_gate)
        {
            all = _sessions.Values.ToList();
        }

        return new JsonObject { ["sessions"] = new JsonArray(all.Select(s => (JsonNode)s.Snapshot()).ToArray()) };
    }

    /// <summary>Vrai si un processus d'Organizator porte cette session en ce moment.</summary>
    public bool IsRunning(string? sessionId) => Find(sessionId)?.Running == true;

    /// <summary>Sessions hebergees qui travaillent (reponse en cours) : avant de fermer ou de mettre a jour.</summary>
    public int BusyCount()
    {
        lock (_gate)
        {
            return _sessions.Values.Count(s => s.Busy);
        }
    }

    /// <summary>Parametres connus d'une session hebergee, pour la rouvrir en console.</summary>
    public LiveLaunch? LaunchOf(string? sessionId) => Find(sessionId)?.Launch;

    public void Dispose()
    {
        List<LiveSession> all;
        lock (_gate)
        {
            if (_disposed)
            {
                return;
            }

            _disposed = true;
            all = _sessions.Values.ToList();
            _sessions.Clear();
        }

        foreach (var session in all)
        {
            session.Kill("fermeture d'Organizator", quiet: true);
        }
    }

    // ------------------------------------------------------------------ outils

    private LiveSession SessionFor(JsonObject payload)
    {
        var id = RequireId(Str(payload, "sessionId"));
        var known = Find(id);
        if (known is not null)
        {
            return known;
        }

        Open(id, new LiveLaunch(
            AgentProvider.Normalize(Str(payload, "provider")),
            Str(payload, "cwd") ?? "",
            Str(payload, "title") ?? "",
            "",
            AgentProvider.RequireModel(Str(payload, "model")),
            AgentProvider.RequireEffort(AgentProvider.Normalize(Str(payload, "provider")), Str(payload, "effort"))));
        return Find(id) ?? throw new InvalidOperationException("Session introuvable.");
    }

    private LiveSession? Find(string? sessionId)
    {
        if (string.IsNullOrWhiteSpace(sessionId))
        {
            return null;
        }

        lock (_gate)
        {
            return _sessions.TryGetValue(sessionId.Trim(), out var session) ? session : null;
        }
    }

    private void Emit(JsonObject payload)
    {
        try
        {
            Progress?.Invoke(payload);
        }
        catch (Exception ex)
        {
            _log.Warn("Avancement d'une session hebergee non transmis : " + ex.Message);
        }
    }

    private static string RequireId(string? sessionId)
        => Guid.TryParse(sessionId, out var guid) ? guid.ToString("D") : throw new InvalidOperationException("Identifiant de session invalide.");

    private static string RequireDirectory(string? cwd)
    {
        if (string.IsNullOrWhiteSpace(cwd))
        {
            throw new InvalidOperationException("Le dossier de travail n'existe pas.");
        }

        string full;
        try
        {
            full = Path.GetFullPath(cwd.Trim());
        }
        catch (Exception)
        {
            throw new InvalidOperationException("Dossier de travail invalide : " + cwd);
        }

        return Directory.Exists(full) ? full : throw new InvalidOperationException("Le dossier de travail n'existe pas : " + full);
    }

    private static string Describe(LiveLaunch launch, string prompt)
    {
        var parts = new List<string>(3);
        if (launch.Model.Length > 0) parts.Add("modele " + launch.Model);
        if (launch.Effort.Length > 0) parts.Add("effort " + launch.Effort);
        if (!string.IsNullOrWhiteSpace(prompt)) parts.Add("message initial");
        return parts.Count == 0 ? "" : " (" + string.Join(", ", parts) + ")";
    }

    private static string? Str(JsonObject? node, string name)
        => node is not null && node[name] is JsonValue value && value.TryGetValue<string>(out var s) ? s : null;

    private static string Text(JsonElement element, string name)
        => element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString() ?? ""
            : "";

    private static string Short(string text, int max)
    {
        var line = string.Join(' ', (text ?? "").Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
        return line.Length <= max ? line : line[..max].TrimEnd() + "…";
    }

    /// <summary>Ce qu'un outil lit, ecrit ou lance : le fichier, la commande, le motif, la mission.</summary>
    private static string ToolDetail(JsonElement input)
    {
        if (input.ValueKind != JsonValueKind.Object)
        {
            return "";
        }

        foreach (var key in new[] { "file_path", "path", "notebook_path" })
        {
            var path = Text(input, key);
            if (path.Length > 0)
            {
                return Path.GetFileName(path.TrimEnd('\\', '/')) is { Length: > 0 } name ? name : path;
            }
        }

        foreach (var key in new[] { "command", "description", "pattern", "query", "url", "prompt", "skill" })
        {
            var value = Text(input, key);
            if (value.Length > 0)
            {
                return Short(value, 140);
            }
        }

        return "";
    }

    // ================================================================== session

    /// <summary>Une session hebergee : son processus, sa reponse en cours. Verrou : l'objet lui-meme.</summary>
    private abstract class LiveSession
    {
        protected LiveSession(LiveSessions owner, string id, LiveLaunch launch, bool existing)
        {
            Owner = owner;
            Id = id;
            Launch = launch;
            HasHistory = existing;
        }

        protected LiveSessions Owner { get; }
        public string Id { get; protected set; }
        public LiveLaunch Launch { get; private set; }

        /// <summary>La session existe sur le disque : un lancement la reprend.</summary>
        protected bool HasHistory { get; set; }

        protected Process? Process { get; set; }
        protected StreamWriter? Input { get; set; }
        protected StringBuilder Stderr { get; set; } = new();
        protected int Generation { get; set; }
        protected bool Launching { get; set; }

        /// <summary>Messages partis dont on attend la fin (Claude les met en file d'attente).</summary>
        protected int Pending { get; set; }

        public bool Running => Process is not null || Launching;
        public bool Busy => Pending > 0;

        // Reponse en cours, pour l'affichage d'une fenetre qui arrive en route.
        protected long TurnStarted { get; set; }
        protected string Phase { get; set; } = "";
        protected List<string> Order { get; } = new();
        protected Dictionary<string, StringBuilder> Texts { get; } = new(StringComparer.Ordinal);
        protected List<JsonObject> Steps { get; } = new();
        protected JsonObject? Question { get; set; }
        private string? _dirty;
        private DateTime _lastText;

        public void Update(LiveLaunch launch)
        {
            lock (this)
            {
                // Une session deja lancee garde ses parametres ; seuls ceux d'une session sans processus suivent.
                if (Process is null)
                {
                    Launch = launch;
                }
            }
        }

        public abstract Task<string> StartAsync(string prompt);
        public abstract void Send(string text);
        public abstract bool Interrupt();
        public abstract bool Answer(JsonObject payload);

        public bool Kill(string why, bool quiet = false)
        {
            Process? process;
            lock (this)
            {
                process = Process;
                Generation++;
                Process = null;
                Input = null;
                Launching = false;
                var wasBusy = Pending > 0;
                Pending = 0;
                Question = null;
                if (!quiet)
                {
                    if (wasBusy)
                    {
                        Emit("done", new JsonObject { ["cancelled"] = true });
                    }

                    EmitState();
                }
            }

            if (process is null)
            {
                return false;
            }

            Owner._log.Info($"Session {Launch.Provider} hebergee {Id} : processus arrete ({why}).");
            Discard(process);
            return true;
        }

        public JsonObject Snapshot()
        {
            lock (this)
            {
                return new JsonObject
                {
                    ["sessionId"] = Id,
                    ["provider"] = Launch.Provider,
                    ["running"] = Running,
                    ["busy"] = Busy,
                    ["startedAt"] = TurnStarted,
                    ["phase"] = Phase,
                    ["texts"] = new JsonArray(Order.Select(k => (JsonNode)new JsonObject { ["msg"] = k, ["text"] = Texts[k].ToString() }).ToArray()),
                    ["steps"] = new JsonArray(Steps.Select(s => (JsonNode)s.DeepClone()).ToArray()),
                    ["question"] = Question?.DeepClone(),
                };
            }
        }

        // ---------------------------------------------------------- reponse en cours

        /// <summary>Un message part : la reponse en cours repart de zero ; sous le verrou.</summary>
        protected void BeginTurn(string text)
        {
            if (Pending == 0)
            {
                TurnStarted = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                Order.Clear();
                Texts.Clear();
                Steps.Clear();
                Phase = "thinking";
            }

            Pending++;
            Emit("user", new JsonObject { ["text"] = text });
            EmitState();
        }

        /// <summary>La reponse est finie ; sous le verrou.</summary>
        protected void EndTurn(JsonObject done)
        {
            FlushText(force: true);
            Pending = Math.Max(0, Pending - 1);
            if (Pending == 0)
            {
                Phase = "";
                Question = null;
            }

            Emit("done", done);
            EmitState();
        }

        protected void AppendText(string msg, string delta)
        {
            if (!Texts.TryGetValue(msg, out var sb))
            {
                Texts[msg] = sb = new StringBuilder();
                Order.Add(msg);
            }

            sb.Append(delta);
            Phase = "text";
            _dirty = msg;
            FlushText(force: false);
        }

        protected void FlushText(bool force)
        {
            if (_dirty is not { } msg)
            {
                return;
            }

            var now = DateTime.UtcNow;
            if (!force && now - _lastText < TextEvery)
            {
                return;
            }

            _dirty = null;
            _lastText = now;
            Emit("text", new JsonObject { ["msg"] = msg, ["text"] = Texts[msg].ToString() });
        }

        protected void Step(string id, string name, string detail, string status)
        {
            FlushText(force: true);
            var existing = Steps.FirstOrDefault(s => (string?)s["id"] == id);
            if (existing is null)
            {
                existing = new JsonObject { ["id"] = id, ["name"] = name, ["detail"] = detail, ["status"] = status };
                Steps.Add(existing);
                if (Steps.Count > MaxSteps)
                {
                    Steps.RemoveAt(0);
                }
            }
            else
            {
                existing["status"] = status;
                if (name.Length > 0) existing["name"] = name;
                if (detail.Length > 0) existing["detail"] = detail;
            }

            Phase = status == "running" ? "tool" : Phase;
            Emit("tool", (JsonObject)existing.DeepClone());
        }

        protected void Emit(string phase, JsonObject? extra = null)
        {
            var payload = new JsonObject { ["sessionId"] = Id, ["phase"] = phase };
            if (extra is not null)
            {
                foreach (var (key, value) in extra.ToList())
                {
                    extra.Remove(key);
                    payload[key] = value;
                }
            }

            Owner.Emit(payload);
        }

        protected void EmitState()
            => Emit("state", new JsonObject { ["running"] = Running, ["busy"] = Busy, ["provider"] = Launch.Provider });

        protected void Fail(string error)
        {
            FlushText(force: true);
            Pending = 0;
            Phase = "";
            Question = null;
            Emit("error", new JsonObject { ["error"] = error });
            EmitState();
        }

        protected void Write(JsonObject message)
        {
            var input = Input ?? throw new IOException("processus absent");
            input.Write(message.ToJsonString(LineJson) + "\n");
            input.Flush();
        }

        protected ProcessStartInfo StartInfo(CommandLine command)
        {
            var info = new ProcessStartInfo
            {
                FileName = command.FileName,
                WorkingDirectory = Launch.Cwd,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                RedirectStandardInput = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8,
                StandardInputEncoding = new UTF8Encoding(false),
            };

            foreach (var argument in command.Arguments)
            {
                info.ArgumentList.Add(argument);
            }

            return info;
        }

        /// <summary>Demarre le processus et ses lecteurs ; rend la generation, ou leve.</summary>
        protected int Spawn(ProcessStartInfo info, Func<string, int, bool> onLine)
        {
            var process = new Process { StartInfo = info };
            process.Start();
            int generation;
            lock (this)
            {
                generation = ++Generation;
                Process = process;
                Input = process.StandardInput;
                Stderr = new StringBuilder();
                Launching = false;
            }

            _ = Task.Run(async () =>
            {
                try
                {
                    var buffer = new char[1024];
                    int read;
                    while ((read = await process.StandardError.ReadAsync(buffer, 0, buffer.Length).ConfigureAwait(false)) > 0)
                    {
                        lock (this)
                        {
                            if (Generation != generation) continue;
                            Stderr.Append(buffer, 0, read);
                            if (Stderr.Length > MaxStderr) Stderr.Remove(0, Stderr.Length - MaxStderr);
                        }
                    }
                }
                catch (Exception)
                {
                    // Flux ferme.
                }
            });

            _ = Task.Run(async () =>
            {
                try
                {
                    string? line;
                    while ((line = await process.StandardOutput.ReadLineAsync().ConfigureAwait(false)) is not null)
                    {
                        if (!onLine(line, generation))
                        {
                            return;
                        }
                    }
                }
                catch (Exception ex)
                {
                    Owner._log.Warn($"Session hebergee {Id} : lecture interrompue ({ex.Message}).");
                }

                try
                {
                    await process.WaitForExitAsync().ConfigureAwait(false);
                }
                catch (Exception)
                {
                    // Deja libere.
                }

                Exited(process, generation);
            });

            return generation;
        }

        /// <summary>Le processus est mort tout seul ; la reponse en cours est perdue, la session reste.</summary>
        protected virtual void Exited(Process process, int generation)
        {
            lock (this)
            {
                if (Generation != generation)
                {
                    return;
                }

                var code = SafeExitCode(process);
                var stderr = Stderr.ToString().Trim();
                Process = null;
                Input = null;
                Generation++;
                Owner._log.Warn($"Session {Launch.Provider} hebergee {Id} : processus arrete (code {code}) {LastLine(stderr)}");
                if (Pending > 0)
                {
                    Fail(VoiceChat.Explain(stderr, code));
                }
                else
                {
                    EmitState();
                }
            }

            process.Dispose();
        }

        protected void Discard(Process process)
        {
            try
            {
                if (!process.HasExited)
                {
                    process.Kill(entireProcessTree: true);
                }
            }
            catch (Exception ex)
            {
                Owner._log.Warn($"Session hebergee {Id} : arret du processus impossible ({ex.Message}).");
            }
            finally
            {
                process.Dispose();
            }
        }

        protected static string LastLine(string text)
        {
            var line = (text ?? "").Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).LastOrDefault() ?? "";
            return line.Length <= 300 ? line : line[..300] + "…";
        }

        private static int SafeExitCode(Process process)
        {
            try
            {
                return process.HasExited ? process.ExitCode : -1;
            }
            catch (Exception)
            {
                return -1;
            }
        }
    }

    // ================================================================== Claude Code

    private sealed class ClaudeLive : LiveSession
    {
        private double _costSeen;
        private string? _writing;
        private int _messages;
        private string? _startPrompt;

        /// <summary>Requetes <c>can_use_tool</c> en attente d'une reponse de l'utilisateur : id → saisie de l'outil.</summary>
        private readonly Dictionary<string, JsonObject> _asks = new(StringComparer.Ordinal);

        public ClaudeLive(LiveSessions owner, string id, LiveLaunch launch, bool existing)
            : base(owner, id, launch, existing)
        {
        }

        public override Task<string> StartAsync(string prompt)
        {
            lock (this)
            {
                _startPrompt = string.IsNullOrWhiteSpace(prompt) ? null : prompt.Trim();
                Launching = true;
                if (_startPrompt is not null)
                {
                    BeginTurn(_startPrompt);
                }
            }

            _ = Task.Run(StartProcess);
            return Task.FromResult(Id);
        }

        public override void Send(string text)
        {
            lock (this)
            {
                if (Question is not null)
                {
                    throw new InvalidOperationException("L'agent attend la réponse à sa question : répondez-y d'abord (ou arrêtez-le).");
                }

                BeginTurn(text);
                if (Process is null)
                {
                    if (!Launching)
                    {
                        Launching = true;
                        _startPrompt = text;
                        _ = Task.Run(StartProcess);
                    }
                    else
                    {
                        _startPrompt = _startPrompt is null ? text : _startPrompt + "\n\n" + text;
                    }

                    return;
                }

                WriteUser(text);
            }
        }

        public override bool Interrupt()
        {
            lock (this)
            {
                if (Process is null || Pending == 0)
                {
                    return false;
                }

                foreach (var request in _asks.Keys.ToList())
                {
                    Respond(request, new JsonObject { ["behavior"] = "deny", ["message"] = "Réponse interrompue par l'utilisateur." });
                }

                _asks.Clear();
                Question = null;
                try
                {
                    Write(new JsonObject
                    {
                        ["type"] = "control_request",
                        ["request_id"] = "interrupt-" + Generation.ToString(CultureInfo.InvariantCulture) + "-" + Environment.TickCount64.ToString(CultureInfo.InvariantCulture),
                        ["request"] = new JsonObject { ["subtype"] = "interrupt" },
                    });
                }
                catch (Exception)
                {
                    // Processus parti : il sera relance au message suivant.
                }

                var generation = Generation;
                _ = Task.Delay(InterruptGrace).ContinueWith(_ =>
                {
                    lock (this)
                    {
                        if (Generation == generation && Pending > 0)
                        {
                            // Pas de fin de tour : la reponse est abandonnee, la session reste.
                            Pending = 1;
                            EndTurn(new JsonObject { ["cancelled"] = true });
                        }
                    }
                }, TaskScheduler.Default);
                return true;
            }
        }

        public override bool Answer(JsonObject payload)
        {
            var request = Str(payload, "request") ?? "";
            lock (this)
            {
                if (!_asks.Remove(request, out var input))
                {
                    return false;
                }

                Question = null;
                if (payload["answers"] is JsonObject answers)
                {
                    var updated = (JsonObject)input.DeepClone();
                    updated["answers"] = answers.DeepClone();
                    Respond(request, new JsonObject { ["behavior"] = "allow", ["updatedInput"] = updated });
                }
                else
                {
                    var allow = payload["allow"] is JsonValue v && v.TryGetValue<bool>(out var yes) && yes;
                    Respond(request, allow
                        ? new JsonObject { ["behavior"] = "allow", ["updatedInput"] = input.DeepClone() }
                        : new JsonObject { ["behavior"] = "deny", ["message"] = Str(payload, "message") is { Length: > 0 } why ? why : "L'utilisateur a refusé." });
                }

                Phase = "thinking";
                Emit("question", new JsonObject { ["request"] = request, ["answered"] = true });
                return true;
            }
        }

        private void StartProcess()
        {
            ProcessStartInfo info;
            bool resume;
            lock (this)
            {
                var command = Owner._launcher.CommandFor(AgentProvider.Claude);
                if (command is null)
                {
                    Launching = false;
                    Fail("Claude Code est introuvable sur ce poste.");
                    return;
                }

                resume = HasHistory;
                info = StartInfo(command);
                foreach (var argument in new[]
                {
                    "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--include-partial-messages", "--verbose",
                    "--dangerously-skip-permissions", "--permission-prompt-tool", "stdio",
                })
                {
                    info.ArgumentList.Add(argument);
                }

                if (resume)
                {
                    info.ArgumentList.Add("--resume");
                    info.ArgumentList.Add(Id);
                }
                else
                {
                    info.ArgumentList.Add("--session-id");
                    info.ArgumentList.Add(Id);
                    info.ArgumentList.Add("--name");
                    info.ArgumentList.Add(AgentLauncher.FirstLine(Launch.Title).Trim() is { Length: > 0 } title ? title : "Session");
                }

                if (Launch.Model.Length > 0)
                {
                    info.ArgumentList.Add("--model");
                    info.ArgumentList.Add(Launch.Model);
                }

                if (Launch.Effort.Length > 0)
                {
                    info.ArgumentList.Add("--effort");
                    info.ArgumentList.Add(Launch.Effort);
                }

                if (!string.IsNullOrWhiteSpace(Launch.Context))
                {
                    info.ArgumentList.Add("--append-system-prompt");
                    info.ArgumentList.Add(Launch.Context);
                }
            }

            try
            {
                var generation = Spawn(info, (line, gen) => Feed(line, gen));
                lock (this)
                {
                    _costSeen = 0;
                    Owner._log.Info($"Session claude hebergee {Id} : processus lance (pid {Process?.Id}, {(resume ? "reprise" : "creation")}).");
                    EmitState();
                    if (_startPrompt is { } first)
                    {
                        _startPrompt = null;
                        WriteUser(first);
                    }
                }
            }
            catch (Exception ex)
            {
                Owner._log.Error($"Session claude hebergee {Id} : lancement impossible", ex);
                lock (this)
                {
                    Launching = false;
                    Fail("Lancement de Claude Code impossible : " + ex.Message);
                }
            }
        }

        /// <summary>Ecrit un message ; sous le verrou. Le premier fait exister la session sur le disque.</summary>
        private void WriteUser(string text)
        {
            try
            {
                Write(new JsonObject
                {
                    ["type"] = "user",
                    ["message"] = new JsonObject { ["role"] = "user", ["content"] = text },
                });
                HasHistory = true;
            }
            catch (Exception ex)
            {
                Fail("La session s'est interrompue : " + ex.Message);
            }
        }

        private void Respond(string request, JsonObject response)
        {
            try
            {
                Write(new JsonObject
                {
                    ["type"] = "control_response",
                    ["response"] = new JsonObject { ["subtype"] = "success", ["request_id"] = request, ["response"] = response },
                });
            }
            catch (Exception ex)
            {
                Owner._log.Warn($"Session hebergee {Id} : reponse a l'agent non transmise ({ex.Message}).");
            }
        }

        /// <summary>Une ligne du flux ; rend faux pour arreter la lecture (processus remplace).</summary>
        private bool Feed(string line, int generation)
        {
            if (line.Length == 0 || line[0] != '{')
            {
                return true;
            }

            JsonDocument document;
            try
            {
                document = JsonDocument.Parse(line);
            }
            catch (JsonException)
            {
                return true;
            }

            using (document)
            {
                lock (this)
                {
                    if (Generation != generation)
                    {
                        return false;
                    }

                    var root = document.RootElement;
                    var sub = root.TryGetProperty("parent_tool_use_id", out var parent) && parent.ValueKind == JsonValueKind.String;
                    switch (Text(root, "type"))
                    {
                        case "control_request":
                            OnControl(root);
                            break;

                        case "stream_event" when !sub && root.TryGetProperty("event", out var ev):
                            OnStream(ev);
                            break;

                        case "assistant" when root.TryGetProperty("message", out var message):
                            OnAssistant(message, sub);
                            break;

                        case "user" when root.TryGetProperty("message", out var userMessage):
                            OnToolResults(userMessage);
                            break;

                        case "result":
                            OnResult(root);
                            break;
                    }
                }
            }

            return true;
        }

        private void OnStream(JsonElement ev)
        {
            switch (Text(ev, "type"))
            {
                case "message_start":
                    _writing = ev.TryGetProperty("message", out var m) ? Text(m, "id") : "";
                    if (string.IsNullOrEmpty(_writing))
                    {
                        _writing = "m" + (++_messages).ToString(CultureInfo.InvariantCulture);
                    }

                    break;

                case "content_block_start":
                    if (ev.TryGetProperty("content_block", out var block) && Text(block, "type") == "thinking")
                    {
                        Phase = "thinking";
                        Emit("thinking");
                    }

                    FlushText(force: true);
                    break;

                case "content_block_delta":
                    if (ev.TryGetProperty("delta", out var delta) && Text(delta, "type") == "text_delta")
                    {
                        AppendText(_writing ?? "m", Text(delta, "text"));
                    }

                    break;

                case "message_stop":
                    FlushText(force: true);
                    break;
            }
        }

        private void OnAssistant(JsonElement message, bool sub)
        {
            if (!message.TryGetProperty("content", out var content) || content.ValueKind != JsonValueKind.Array)
            {
                return;
            }

            foreach (var block in content.EnumerateArray())
            {
                if (Text(block, "type") != "tool_use")
                {
                    continue;
                }

                var name = Text(block, "name");
                var detail = block.TryGetProperty("input", out var input) ? ToolDetail(input) : "";
                Step(Text(block, "id"), sub ? "· " + name : name, detail, "running");
            }
        }

        private void OnToolResults(JsonElement message)
        {
            if (!message.TryGetProperty("content", out var content) || content.ValueKind != JsonValueKind.Array)
            {
                return;
            }

            foreach (var block in content.EnumerateArray())
            {
                if (Text(block, "type") == "tool_result")
                {
                    var failed = block.TryGetProperty("is_error", out var error) && error.ValueKind == JsonValueKind.True;
                    var id = Text(block, "tool_use_id");
                    if (Steps.Any(s => (string?)s["id"] == id))
                    {
                        Step(id, "", "", failed ? "error" : "done");
                    }
                }
            }
        }

        private void OnControl(JsonElement root)
        {
            var request = Text(root, "request_id");
            if (!root.TryGetProperty("request", out var body) || request.Length == 0)
            {
                return;
            }

            if (Text(body, "subtype") != "can_use_tool")
            {
                Write(new JsonObject
                {
                    ["type"] = "control_response",
                    ["response"] = new JsonObject { ["subtype"] = "error", ["request_id"] = request, ["error"] = "Requête non prise en charge par Organizator." },
                });
                return;
            }

            var tool = Text(body, "tool_name");
            var input = body.TryGetProperty("input", out var raw) ? JsonNode.Parse(raw.GetRawText()) as JsonObject ?? new JsonObject() : new JsonObject();
            if (tool == "AskUserQuestion" || tool == "ExitPlanMode")
            {
                // Seules les questions et l'approbation d'un plan attendent l'utilisateur.
                _asks[request] = input;
                Phase = "question";
                Question = tool == "AskUserQuestion"
                    ? new JsonObject { ["request"] = request, ["kind"] = "ask", ["questions"] = input["questions"]?.DeepClone() ?? new JsonArray() }
                    : new JsonObject { ["request"] = request, ["kind"] = "plan", ["plan"] = (string?)input["plan"] ?? "" };
                FlushText(force: true);
                Emit("question", (JsonObject)Question.DeepClone());
                return;
            }

            // Sans confirmation, comme en console : tout le reste est accorde.
            Respond(request, new JsonObject { ["behavior"] = "allow", ["updatedInput"] = input });
        }

        private void OnResult(JsonElement root)
        {
            HasHistory = true;
            var total = root.TryGetProperty("total_cost_usd", out var t) && t.TryGetDouble(out var value) ? value : 0;
            var cost = Math.Max(0, total - _costSeen);
            _costSeen = Math.Max(_costSeen, total);
            _asks.Clear();
            if (Pending == 0)
            {
                return;
            }

            var isError = root.TryGetProperty("is_error", out var flag) && flag.ValueKind == JsonValueKind.True;
            var subtype = Text(root, "subtype");
            if (isError && subtype != "error_during_execution")
            {
                FlushText(force: true);
                Emit("error", new JsonObject { ["error"] = VoiceChat.Explain(Text(root, "result"), 0) });
            }

            EndTurn(new JsonObject
            {
                ["cost"] = cost,
                ["ms"] = root.TryGetProperty("duration_ms", out var ms) && ms.TryGetDouble(out var d) ? d : 0,
                ["cancelled"] = subtype == "error_during_execution",
            });
        }

        protected override void Exited(Process process, int generation)
        {
            // Reprise impossible (session effacee) : on recree la session sous le meme identifiant, une fois.
            lock (this)
            {
                if (Generation == generation && HasHistory && Stderr.ToString().Contains("No conversation found", StringComparison.OrdinalIgnoreCase))
                {
                    HasHistory = false;
                    Process = null;
                    Input = null;
                    Generation++;
                    Launching = true;
                    Emit("notice", new JsonObject { ["text"] = "La session est introuvable sur le disque : elle repart sans son historique." });
                    _ = Task.Run(StartProcess);
                    return;
                }
            }

            base.Exited(process, generation);
        }
    }

    // ================================================================== GitHub Copilot (ACP)

    private sealed class CopilotLive : LiveSession
    {
        private readonly Dictionary<int, TaskCompletionSource<JsonObject>> _waiting = new();
        private int _nextId;
        private bool _loading;
        private bool _ready;
        private int _segments;
        private string? _segment;
        private readonly List<string> _queue = new();

        public CopilotLive(LiveSessions owner, string id, LiveLaunch launch, bool existing)
            : base(owner, id, launch, existing)
        {
        }

        public override async Task<string> StartAsync(string prompt)
        {
            // En ACP, Copilot ignore --name et nomme la session d'apres son premier message : le titre
            // de la tache en tete en fait la premiere ligne, donc le titre affiche partout.
            var title = AgentLauncher.FirstLine(Launch.Title).Trim();
            var first = JoinBlocks(Launch.Context, prompt);
            if (first.Length > 0 && title.Length > 0)
            {
                first = title + "\n\n" + first;
            }

            lock (this)
            {
                Launching = true;
            }

            await LaunchAsync().ConfigureAwait(false);
            if (first.Length > 0)
            {
                lock (this)
                {
                    BeginTurn(string.IsNullOrWhiteSpace(prompt) ? first : prompt.Trim());
                }

                _ = Task.Run(() => PromptAsync(first));
            }

            return Id;
        }

        public override void Send(string text)
        {
            lock (this)
            {
                if (Pending > 0)
                {
                    throw new InvalidOperationException("Copilot répond encore : attendez sa réponse, ou arrêtez-la.");
                }

                BeginTurn(text);

                // Sans processus (session mise en pause, ou reprise apres un redemarrage) : Copilot repart d'abord.
                if (!_ready || Process is null)
                {
                    _ready = false;
                    _queue.Add(text);
                    if (!Launching)
                    {
                        Launching = true;
                        _ = Task.Run(async () =>
                        {
                            try
                            {
                                await LaunchAsync().ConfigureAwait(false);
                                string[] queued;
                                lock (this)
                                {
                                    queued = _queue.ToArray();
                                    _queue.Clear();
                                }

                                if (queued.Length > 0)
                                {
                                    await PromptAsync(string.Join("\n\n", queued)).ConfigureAwait(false);
                                }
                            }
                            catch (Exception ex)
                            {
                                lock (this)
                                {
                                    _queue.Clear();
                                    Fail(ex.Message);
                                }
                            }
                        });
                    }

                    return;
                }
            }

            _ = Task.Run(() => PromptAsync(text));
        }

        public override bool Interrupt()
        {
            lock (this)
            {
                if (Process is null || Pending == 0 || Id.Length == 0)
                {
                    return false;
                }

                try
                {
                    Write(new JsonObject { ["jsonrpc"] = "2.0", ["method"] = "session/cancel", ["params"] = new JsonObject { ["sessionId"] = Id } });
                }
                catch (Exception)
                {
                    // Processus parti.
                }

                return true;
            }
        }

        public override bool Answer(JsonObject payload) => false;

        /// <summary>Lance la CLI en ACP, puis cree (session/new) ou reprend (session/load) la session.</summary>
        private async Task LaunchAsync()
        {
            ProcessStartInfo info;
            bool resume;
            lock (this)
            {
                var command = Owner._launcher.CommandFor(AgentProvider.Copilot)
                    ?? throw new InvalidOperationException("La CLI GitHub Copilot est introuvable sur ce poste.");
                resume = HasHistory;
                info = StartInfo(command);
                foreach (var argument in new[] { "--acp", "--no-auto-update", "--allow-all" })
                {
                    info.ArgumentList.Add(argument);
                }

                if (Launch.Model.Length > 0)
                {
                    info.ArgumentList.Add("--model");
                    info.ArgumentList.Add(Launch.Model);
                }

                if (Launch.Effort.Length > 0)
                {
                    info.ArgumentList.Add("--effort");
                    info.ArgumentList.Add(Launch.Effort);
                }

                _ready = false;
            }

            try
            {
                Spawn(info, (line, gen) => Feed(line, gen));
                using var cts = new CancellationTokenSource(CopilotStart);
                await CallAsync("initialize", new JsonObject
                {
                    ["protocolVersion"] = 1,
                    ["clientCapabilities"] = new JsonObject { ["fs"] = new JsonObject { ["readTextFile"] = false, ["writeTextFile"] = false } },
                }, cts.Token).ConfigureAwait(false);

                if (resume)
                {
                    lock (this)
                    {
                        _loading = true;
                    }

                    try
                    {
                        await CallAsync("session/load", new JsonObject { ["sessionId"] = Id, ["cwd"] = Launch.Cwd, ["mcpServers"] = new JsonArray() }, cts.Token).ConfigureAwait(false);
                    }
                    finally
                    {
                        lock (this)
                        {
                            _loading = false;
                        }
                    }
                }
                else
                {
                    var created = await CallAsync("session/new", new JsonObject { ["cwd"] = Launch.Cwd, ["mcpServers"] = new JsonArray() }, cts.Token).ConfigureAwait(false);
                    var id = (string?)created["sessionId"];
                    if (!Guid.TryParse(id, out var guid))
                    {
                        throw new InvalidOperationException("Copilot n'a pas rendu d'identifiant de session.");
                    }

                    lock (this)
                    {
                        Id = guid.ToString("D");
                        HasHistory = true;
                    }
                }

                lock (this)
                {
                    _ready = true;
                    Owner._log.Info($"Session copilot hebergee {Id} : processus lance (pid {Process?.Id}, {(resume ? "reprise" : "creation")}).");
                    EmitState();
                }
            }
            catch (Exception ex)
            {
                string stderr;
                lock (this)
                {
                    stderr = Stderr.ToString();
                }

                Owner._log.Error($"Session copilot hebergee {Id} : lancement impossible ({LastLine(stderr)})", ex);
                Kill("lancement rate", quiet: true);
                throw new InvalidOperationException("Lancement de GitHub Copilot impossible : " + ex.Message);
            }
        }

        private async Task PromptAsync(string text)
        {
            try
            {
                var result = await CallAsync("session/prompt", new JsonObject
                {
                    ["sessionId"] = Id,
                    ["prompt"] = new JsonArray(new JsonObject { ["type"] = "text", ["text"] = text }),
                }, CancellationToken.None).ConfigureAwait(false);
                lock (this)
                {
                    if (Pending > 0)
                    {
                        EndTurn(new JsonObject { ["cancelled"] = (string?)result["stopReason"] == "cancelled" });
                    }
                }
            }
            catch (Exception ex)
            {
                lock (this)
                {
                    if (Pending > 0)
                    {
                        Fail("Copilot n'a pas pu répondre : " + ex.Message);
                    }
                }
            }
        }

        private Task<JsonObject> CallAsync(string method, JsonObject parameters, CancellationToken ct)
        {
            var tcs = new TaskCompletionSource<JsonObject>(TaskCreationOptions.RunContinuationsAsynchronously);
            lock (this)
            {
                var id = ++_nextId;
                _waiting[id] = tcs;
                Write(new JsonObject { ["jsonrpc"] = "2.0", ["id"] = id, ["method"] = method, ["params"] = parameters });
            }

            if (ct.CanBeCanceled)
            {
                ct.Register(() => tcs.TrySetException(new TimeoutException("pas de réponse à " + method)));
            }

            return tcs.Task;
        }

        private bool Feed(string line, int generation)
        {
            JsonObject? message;
            try
            {
                message = JsonNode.Parse(line) as JsonObject;
            }
            catch (JsonException)
            {
                return true;
            }

            if (message is null)
            {
                return true;
            }

            lock (this)
            {
                if (Generation != generation)
                {
                    return false;
                }

                var method = (string?)message["method"];
                if (method is null && message["id"] is JsonValue idValue && idValue.TryGetValue<int>(out var id) && _waiting.Remove(id, out var tcs))
                {
                    if (message["error"] is JsonObject error)
                    {
                        tcs.TrySetException(new InvalidOperationException((string?)error["message"] ?? "erreur"));
                    }
                    else
                    {
                        tcs.TrySetResult(message["result"] as JsonObject ?? new JsonObject());
                    }

                    return true;
                }

                if (method == "session/update" && !_loading && message["params"]?["update"] is JsonObject update)
                {
                    OnUpdate(update);
                }
                else if (method is not null && message["id"] is not null)
                {
                    OnRequest(method, message);
                }
            }

            return true;
        }

        private void OnUpdate(JsonObject update)
        {
            switch ((string?)update["sessionUpdate"])
            {
                case "agent_message_chunk":
                    if (_segment is null)
                    {
                        _segment = "c" + (++_segments).ToString(CultureInfo.InvariantCulture);
                    }

                    AppendText(_segment, (string?)update["content"]?["text"] ?? "");
                    break;

                case "agent_thought_chunk":
                    if (Phase != "thinking")
                    {
                        Phase = "thinking";
                        Emit("thinking");
                    }

                    break;

                case "tool_call":
                    _segment = null;
                    var detail = "";
                    if (update["rawInput"] is JsonObject raw)
                    {
                        using var input = JsonDocument.Parse(raw.ToJsonString());
                        detail = ToolDetail(input.RootElement);
                    }

                    Step((string?)update["toolCallId"] ?? "", (string?)update["kind"] is { Length: > 0 } kind ? KindName(kind) : "outil",
                        detail.Length > 0 ? detail : Short((string?)update["title"] ?? "", 140), "running");
                    break;

                case "tool_call_update":
                    var status = (string?)update["status"];
                    if (status is "completed" or "failed")
                    {
                        Step((string?)update["toolCallId"] ?? "", "", "", status == "failed" ? "error" : "done");
                    }

                    break;
            }
        }

        /// <summary>Requete de l'agent : une permission est accordee (--allow-all), le reste est refuse.</summary>
        private void OnRequest(string method, JsonObject message)
        {
            var id = message["id"]!.DeepClone();
            if (method == "session/request_permission" && message["params"]?["options"] is JsonArray options)
            {
                var chosen = options.OfType<JsonObject>().FirstOrDefault(o => ((string?)o["kind"] ?? "").StartsWith("allow", StringComparison.Ordinal))
                    ?? options.OfType<JsonObject>().FirstOrDefault();
                Write(new JsonObject
                {
                    ["jsonrpc"] = "2.0",
                    ["id"] = id,
                    ["result"] = new JsonObject
                    {
                        ["outcome"] = new JsonObject { ["outcome"] = "selected", ["optionId"] = chosen?["optionId"]?.DeepClone() },
                    },
                });
                return;
            }

            Write(new JsonObject
            {
                ["jsonrpc"] = "2.0",
                ["id"] = id,
                ["error"] = new JsonObject { ["code"] = -32601, ["message"] = "Non pris en charge par Organizator : " + method },
            });
        }

        protected override void Exited(Process process, int generation)
        {
            lock (this)
            {
                if (Generation == generation)
                {
                    foreach (var waiting in _waiting.Values)
                    {
                        waiting.TrySetException(new IOException("la CLI Copilot s'est arrêtée"));
                    }

                    _waiting.Clear();
                    _ready = false;
                }
            }

            base.Exited(process, generation);
        }

        private static string KindName(string kind) => kind switch
        {
            "read" => "Lecture",
            "edit" => "Modification",
            "delete" => "Suppression",
            "move" => "Déplacement",
            "search" => "Recherche",
            "execute" => "Commande",
            "fetch" => "Web",
            "think" => "Réflexion",
            _ => "Outil",
        };

        private static string JoinBlocks(string? first, string? second)
        {
            if (string.IsNullOrWhiteSpace(first)) return (second ?? "").Trim();
            if (string.IsNullOrWhiteSpace(second)) return first.Trim();
            return first.Trim() + "\n\n" + second.Trim();
        }
    }
}
