using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Organizator.Services;

/// <summary>
/// Assistant d'Organizator : une discussion avec Claude, hors terminal, qui agit sur la file de
/// l'utilisateur. Un processus <c>claude -p</c> persistant, en <c>--input-format stream-json</c>
/// comme <see cref="VoiceChat"/> : chaque message de l'utilisateur est ecrit sur son entree
/// standard, la reponse revient au fil de l'eau (<c>--include-partial-messages</c>).
///
/// Les outils de l'assistant (lire la file, creer ou deplacer une tache, reecrire une consigne,
/// lancer une conversation…) sont ceux d'un serveur MCP « sdk » que l'hote sert lui-meme, par le
/// protocole de controle de Claude Code (celui des SDK officiels) : la CLI ecrit sur sa sortie une
/// requete <c>control_request</c> de sous-type <c>mcp_message</c> (JSON-RPC : <c>initialize</c>,
/// <c>tools/list</c>, <c>tools/call</c>), l'hote repond par un <c>control_response</c> sur l'entree.
/// Ni port, ni tube, ni processus de plus. La page fournit la liste des outils et leur
/// implementation : un appel lui est pousse (<see cref="Progress"/>, phase <c>call</c>), elle
/// l'execute sur ses donnees et rend le resultat (<see cref="ToolResult"/>). C'est elle qui tient
/// la file, l'hote ne fait que relayer.
///
/// En plus de ces outils, l'agent peut lire le disque (<c>Read</c>, <c>Grep</c>, <c>Glob</c>) — les
/// rapports des conversations, par exemple — et rien d'autre : ni ecriture, ni shell, ni web, ni
/// autre serveur MCP (<c>--strict-mcp-config</c>), en mode <c>dontAsk</c>. Dossier de travail :
/// <c>assistant</c> du dossier de donnees.
///
/// Une seule discussion a la fois ; la page en tient le journal (<c>assistant.json</c>, ecrit tel
/// quel par <see cref="Save"/>) et l'identifiant de session : apres un redemarrage, le message
/// suivant reprend la session (<c>--resume</c>). Le processus s'arrete apres
/// <see cref="IdleLimit"/> sans message, et repart avec <c>--resume</c> au suivant.
/// </summary>
public sealed class AssistantChat : IDisposable
{
    /// <summary>Nom du serveur MCP : les outils s'appellent <c>mcp__organizator__&lt;nom&gt;</c> cote Claude.</summary>
    public const string ServerName = "organizator";

    private const string ToolPrefix = "mcp__" + ServerName + "__";
    private const string ReadTools = "Read,Grep,Glob";
    private const string SessionName = "Assistant Organizator";

    private static readonly TimeSpan TurnLimit = TimeSpan.FromMinutes(15);
    private static readonly TimeSpan InterruptGrace = TimeSpan.FromSeconds(2.5);
    private static readonly TimeSpan IdleLimit = TimeSpan.FromMinutes(30);

    /// <summary>Un appel d'outil sans reponse de la page au-dela (page rechargee, fermee) echoue.</summary>
    private static readonly TimeSpan ToolWait = TimeSpan.FromSeconds(90);

    /// <summary>Le texte d'une reponse part a la page au plus a ce rythme ; le reste a la fin du message.</summary>
    private static readonly TimeSpan TextEvery = TimeSpan.FromMilliseconds(120);

    private const int MaxText = 20_000;
    private const int MaxSystem = 24_000;
    private const int MaxTools = 40;
    private const int MaxToolsJson = 96 * 1024;
    private const int MaxResult = 100_000;
    private const int MaxLog = 4 * 1024 * 1024;
    private const int MaxStderr = 4000;

    private static readonly Regex ToolNameRule = new("^[a-z][a-z0-9_]{0,47}$", RegexOptions.CultureInvariant);
    private static readonly JsonSerializerOptions LineJson = new() { Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    private readonly AgentLauncher _launcher;
    private readonly HostLog _log;
    private readonly string _dir;
    private readonly string _logFile;
    private readonly object _gate = new();
    private readonly object _fileGate = new();
    private readonly Dictionary<string, Call> _calls = new(StringComparer.Ordinal);

    private Process? _process;
    private StreamWriter? _input;
    private StringBuilder _stderr = new();
    private bool _launching;
    private bool _initialized;
    private bool _disposed;

    /// <summary>Change a chaque lancement ou arret : les lecteurs d'un ancien processus se taisent.</summary>
    private int _generation;

    private string _sessionId = "";

    /// <summary>La session existe sur le disque : un lancement la reprend (<c>--resume</c>).</summary>
    private bool _hasHistory;

    private Options? _options;
    private string _launchKey = "";

    /// <summary>Cout cumule annonce par le processus courant (<c>total_cost_usd</c> court depuis son lancement).</summary>
    private double _costSeen;
    private int _lastTurn;
    private Turn? _active;
    private Turn? _pending;
    private Timer? _idle;

    public AssistantChat(AgentLauncher launcher, HostLog log, string dataDir)
    {
        _launcher = launcher;
        _log = log;
        _dir = Path.Combine(dataDir, "assistant");
        _logFile = Path.Combine(dataDir, "assistant.json");

        // Filet : un claude orphelin continuerait de tourner apres la fermeture de l'application.
        AppDomain.CurrentDomain.ProcessExit += (_, _) => Dispose();
    }

    /// <summary>
    /// Avancement : <c>{ turn, phase, … }</c>, leve hors du fil de l'interface, dans l'ordre.
    /// <c>thinking</c> (message parti) ; <c>text</c> (<c>msg</c> = identifiant du message de l'agent,
    /// <c>text</c> = son texte complet jusque-la) ; <c>tool</c> (outil de lecture : <c>name</c>,
    /// <c>detail</c>) ; <c>call</c> (outil d'Organizator a executer par la page : <c>call</c>,
    /// <c>name</c>, <c>args</c> — reponse attendue par <see cref="ToolResult"/>) ; <c>notice</c>
    /// (<c>text</c>) ; <c>done</c> (<c>cost</c> en dollars au tarif public, <c>ms</c>, <c>cancelled</c>) ;
    /// <c>error</c> (<c>error</c>).
    /// </summary>
    public event Action<JsonObject>? Progress;

    // ------------------------------------------------------------------ commandes

    /// <summary>
    /// Un message de l'utilisateur : <c>{ sessionId, resume, text, system, tools, model, effort }</c>.
    /// Le processus demarre (ou redemarre, si la session, le modele, l'effort, le prompt systeme ou les
    /// outils ont change) puis recoit le message. Refuse tant qu'une reponse est en cours.
    /// Rend <c>{ turn }</c>.
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
            throw new InvalidOperationException($"Message trop long ({text.Length} caractères, {MaxText} au plus).");
        }

        if (!Guid.TryParse(Str(payload, "sessionId"), out var guid))
        {
            throw new InvalidOperationException("Identifiant de discussion invalide.");
        }

        var system = (Str(payload, "system") ?? "").Trim();
        if (system.Length == 0 || system.Length > MaxSystem)
        {
            throw new InvalidOperationException("Consignes de l'assistant absentes ou trop longues.");
        }

        var tools = ParseTools(payload["tools"]);
        var options = new Options(
            AgentProvider.RequireModel(Str(payload, "model")),
            AgentProvider.RequireEffort(AgentProvider.Claude, Str(payload, "effort")),
            system,
            tools);
        var resume = payload["resume"] is JsonValue r && r.TryGetValue<bool>(out var flag) && flag;
        var sessionId = guid.ToString("D");

        if (_launcher.CommandFor(AgentProvider.Claude) is null)
        {
            throw new InvalidOperationException("Claude Code est introuvable sur ce poste : l'assistant passe par lui.");
        }

        lock (_gate)
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            // Une reponse arretee peut encore se clore (son result arrive) : le message attend derriere.
            if (_pending is not null || _active is { Cancelled: false })
            {
                throw new InvalidOperationException("L'assistant répond encore : attendez sa réponse, ou arrêtez-la.");
            }

            if (sessionId != _sessionId)
            {
                _sessionId = sessionId;
                _hasHistory = resume;
            }
            else if (resume)
            {
                _hasHistory = true;
            }

            _options = options;
            if (_process is not null && options.Key(_sessionId) != _launchKey)
            {
                // Autre discussion, autre modele, autres outils : le processus repart, la session suit.
                DropActive();
                Kill();
            }

            StopIdle();
            var turn = new Turn(++_lastTurn, text);
            _pending = turn;
            Emit(turn, "thinking");
            if (_process is null && !_launching)
            {
                _launching = true;
                _ = Task.Run(Launch);
            }
            else
            {
                SendPending();
            }

            return new JsonObject { ["turn"] = turn.Number };
        }
    }

    /// <summary>Arrete la reponse en cours (ou le message qui attendait). Rend <c>{ stopped }</c>.</summary>
    public JsonObject Stop()
    {
        lock (_gate)
        {
            var stopped = false;
            if (_pending is { } pending)
            {
                _pending = null;
                Emit(pending, "done", extra: new JsonObject { ["cancelled"] = true });
                stopped = true;
            }

            if (_active is { Cancelled: false } active)
            {
                active.Cancelled = true;
                active.Limit?.Dispose();
                AnswerCalls(active, "Réponse interrompue par l'utilisateur.");
                FlushText(active, force: true);
                Emit(active, "done", extra: new JsonObject { ["cancelled"] = true });
                SoftInterrupt(active);
                stopped = true;
            }

            return new JsonObject { ["stopped"] = stopped };
        }
    }

    /// <summary>Nouvelle discussion : le processus s'arrete ; le prochain message ouvrira une session neuve.</summary>
    public JsonObject Reset()
    {
        lock (_gate)
        {
            if (_pending is { } pending)
            {
                _pending = null;
                Emit(pending, "done", extra: new JsonObject { ["cancelled"] = true });
            }

            if (_active is { } active)
            {
                active.Cancelled = true;
                AnswerCalls(active, "Discussion terminée.");
                Emit(active, "done", extra: new JsonObject { ["cancelled"] = true });
                DropActive();
            }

            StopIdle();
            Kill();
            _sessionId = "";
            _hasHistory = false;
            _log.Info("Assistant : nouvelle discussion.");
            return new JsonObject();
        }
    }

    /// <summary>
    /// Resultat d'un outil execute par la page : <c>{ call, ok, text }</c>. Un appel inconnu (deja
    /// echu, tour interrompu) est ignore. Rend <c>{ answered }</c>.
    /// </summary>
    public JsonObject ToolResult(JsonObject payload)
    {
        var id = Str(payload, "call") ?? "";
        var ok = payload["ok"] is JsonValue v && v.TryGetValue<bool>(out var good) && good;
        var text = Str(payload, "text") ?? "";
        if (text.Length > MaxResult)
        {
            text = text[..MaxResult] + "\n[…] (résultat tronqué)";
        }

        lock (_gate)
        {
            if (!_calls.Remove(id, out var call))
            {
                return new JsonObject { ["answered"] = false };
            }

            call.Timer?.Dispose();
            Answer(call, ok, text.Length > 0 ? text : (ok ? "Fait." : "Échec."));
            return new JsonObject { ["answered"] = true };
        }
    }

    /// <summary>Ce qui tourne : <c>{ busy, turn, sessionId, alive }</c> (page rechargee pendant une reponse).</summary>
    public JsonObject Status()
    {
        lock (_gate)
        {
            var turn = _active ?? _pending;
            return new JsonObject
            {
                ["busy"] = turn is { Cancelled: false },
                ["turn"] = turn?.Number ?? 0,
                ["sessionId"] = _sessionId,
                ["alive"] = _process is not null,
            };
        }
    }

    /// <summary>Journal de la discussion tel que la page l'a ecrit : <c>{ log }</c>, <c>null</c> s'il n'y en a pas.</summary>
    public JsonObject Load()
    {
        lock (_fileGate)
        {
            foreach (var path in new[] { _logFile, _logFile + ".bak" })
            {
                try
                {
                    if (File.Exists(path) && JsonNode.Parse(File.ReadAllText(path, Encoding.UTF8)) is JsonObject root)
                    {
                        return new JsonObject { ["log"] = root["log"]?.DeepClone() };
                    }
                }
                catch (Exception ex) when (ex is IOException or JsonException or UnauthorizedAccessException)
                {
                    _log.Warn($"Assistant : journal illisible ({Path.GetFileName(path)}) : {ex.Message}");
                }
            }

            return new JsonObject { ["log"] = null };
        }
    }

    /// <summary>Ecrit le journal <c>{ log }</c> tel quel (ecriture atomique, copie .bak, 4 Mo au plus).</summary>
    public JsonObject Save(JsonObject payload)
    {
        var root = new JsonObject { ["version"] = 1, ["log"] = payload["log"]?.DeepClone() };
        var json = root.ToJsonString(LineJson);
        if (json.Length > MaxLog)
        {
            throw new InvalidOperationException("Journal de l'assistant trop volumineux.");
        }

        lock (_fileGate)
        {
            var tmp = _logFile + ".tmp";
            File.WriteAllText(tmp, json, new UTF8Encoding(false));
            if (File.Exists(_logFile))
            {
                File.Copy(_logFile, _logFile + ".bak", overwrite: true);
            }

            File.Move(tmp, _logFile, overwrite: true);
        }

        return new JsonObject { ["bytes"] = json.Length };
    }

    public void Dispose()
    {
        lock (_gate)
        {
            if (_disposed)
            {
                return;
            }

            _disposed = true;
            _pending = null;
            if (_active is { } active)
            {
                AnswerCalls(active, "Organizator se ferme.");
            }

            DropActive();
            StopIdle();
            Kill();
        }
    }

    // ------------------------------------------------------------------ outils

    /// <summary>
    /// Outils fournis par la page : <c>[{ name, description, inputSchema }]</c>, 40 au plus, noms en
    /// <c>snake_case</c>. Ils sont servis tels quels a Claude (<c>tools/list</c>).
    /// </summary>
    private static JsonArray ParseTools(JsonNode? node)
    {
        if (node is not JsonArray list || list.Count == 0 || list.Count > MaxTools)
        {
            throw new InvalidOperationException("Outils de l'assistant absents ou trop nombreux.");
        }

        if (list.ToJsonString().Length > MaxToolsJson)
        {
            throw new InvalidOperationException("Description des outils de l'assistant trop volumineuse.");
        }

        var tools = new JsonArray();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var item in list)
        {
            if (item is not JsonObject tool || Str(tool, "name") is not { } name || !ToolNameRule.IsMatch(name) || !seen.Add(name))
            {
                throw new InvalidOperationException("Outil de l'assistant mal décrit.");
            }

            tools.Add(new JsonObject
            {
                ["name"] = name,
                ["description"] = Str(tool, "description") ?? "",
                ["inputSchema"] = tool["inputSchema"] is JsonObject schema ? schema.DeepClone() : new JsonObject { ["type"] = "object" },
            });
        }

        return tools;
    }

    /// <summary>Une requete JSON-RPC du client MCP de Claude Code ; sous le verrou.</summary>
    private JsonObject? HandleMcp(string requestId, JsonObject message)
    {
        var method = Str(message, "method") ?? "";
        var rpcId = message["id"]?.DeepClone();
        switch (method)
        {
            case "initialize":
                // Le serveur ne sert que des outils : il accepte la version que propose le client.
                var version = (message["params"] as JsonObject) is { } p && Str(p, "protocolVersion") is { Length: > 0 } asked ? asked : "2024-11-05";
                return Rpc(rpcId, new JsonObject
                {
                    ["protocolVersion"] = version,
                    ["capabilities"] = new JsonObject { ["tools"] = new JsonObject() },
                    ["serverInfo"] = new JsonObject { ["name"] = ServerName, ["version"] = "1.0.0" },
                });

            case "notifications/initialized":
                return new JsonObject { ["jsonrpc"] = "2.0", ["result"] = new JsonObject() };

            case "ping":
                return Rpc(rpcId, new JsonObject());

            case "tools/list":
                return Rpc(rpcId, new JsonObject { ["tools"] = _options?.Tools.DeepClone() ?? new JsonArray() });

            case "tools/call":
                var call = message["params"] as JsonObject;
                var name = call is null ? "" : Str(call, "name") ?? "";
                var turn = _active;
                if (turn is null || turn.Cancelled || _options is null || !_options.Has(name))
                {
                    return RpcResult(rpcId, false, turn is null || turn.Cancelled ? "Réponse interrompue par l'utilisateur." : "Outil inconnu : " + name);
                }

                // Appel a executer par la page : la reponse partira de ToolResult (ou de l'echeance).
                FlushText(turn, force: true);
                var pending = new Call(requestId, rpcId, turn, _generation);
                _calls[requestId] = pending;
                pending.Timer = new Timer(_ =>
                {
                    lock (_gate)
                    {
                        if (_calls.Remove(requestId, out var late))
                        {
                            _log.Warn($"Assistant : l'outil {name} est reste sans reponse de la page.");
                            Answer(late, false, "L'interface d'Organizator n'a pas répondu : l'action n'a pas été faite.");
                        }
                    }
                }, null, ToolWait, Timeout.InfiniteTimeSpan);
                Emit(turn, "call", extra: new JsonObject
                {
                    ["call"] = requestId,
                    ["name"] = name,
                    ["args"] = call?["arguments"]?.DeepClone() ?? new JsonObject(),
                });
                return null;

            default:
                return new JsonObject
                {
                    ["jsonrpc"] = "2.0",
                    ["id"] = rpcId,
                    ["error"] = new JsonObject { ["code"] = -32601, ["message"] = "Méthode inconnue : " + method },
                };
        }
    }

    private static JsonObject Rpc(JsonNode? id, JsonObject result)
        => new() { ["jsonrpc"] = "2.0", ["id"] = id, ["result"] = result };

    private static JsonObject RpcResult(JsonNode? id, bool ok, string text)
    {
        var result = new JsonObject
        {
            ["content"] = new JsonArray(new JsonObject { ["type"] = "text", ["text"] = text }),
        };
        if (!ok)
        {
            result["isError"] = true;
        }

        return Rpc(id, result);
    }

    /// <summary>Repond a un appel d'outil ; sous le verrou. Un processus relance depuis l'appel ne recoit rien.</summary>
    private void Answer(Call call, bool ok, string text)
    {
        if (call.Generation != _generation || _input is null)
        {
            return;
        }

        try
        {
            WriteControlResponse(call.RequestId, RpcResult(call.RpcId?.DeepClone(), ok, text));
        }
        catch (Exception ex)
        {
            _log.Warn("Assistant : resultat d'outil non transmis : " + ex.Message);
        }
    }

    /// <summary>Les appels encore sans reponse d'un tour qui s'arrete echouent tous ; sous le verrou.</summary>
    private void AnswerCalls(Turn turn, string why)
    {
        foreach (var call in _calls.Values.Where(c => ReferenceEquals(c.Turn, turn)).ToList())
        {
            _calls.Remove(call.RequestId);
            call.Timer?.Dispose();
            Answer(call, false, why);
        }
    }

    private void WriteControlResponse(string requestId, JsonObject mcpResponse)
        => WriteLine(new JsonObject
        {
            ["type"] = "control_response",
            ["response"] = new JsonObject
            {
                ["subtype"] = "success",
                ["request_id"] = requestId,
                ["response"] = new JsonObject { ["mcp_response"] = mcpResponse },
            },
        });

    // ------------------------------------------------------------------ tours

    /// <summary>Ecrit le message en attente si le processus est pret et libre ; sous le verrou.</summary>
    private void SendPending()
    {
        if (_pending is not { } turn || _active is not null || _process is null || _launching || _disposed)
        {
            return;
        }

        _pending = null;
        _active = turn;
        try
        {
            WriteLine(new JsonObject
            {
                ["type"] = "user",
                ["message"] = new JsonObject { ["role"] = "user", ["content"] = turn.Message },
            });
        }
        catch (Exception ex)
        {
            // Processus mort entre deux messages : on relance et le message repart (une seule fois).
            _active = null;
            if (turn.Retried)
            {
                Fail(turn, "La discussion avec Claude s'est interrompue : " + ex.Message);
                return;
            }

            turn.Retried = true;
            _pending = turn;
            _log.Warn($"Assistant : ecriture impossible ({ex.Message}), relance.");
            Restart();
            return;
        }

        var generation = _generation;
        turn.Limit = new Timer(_ =>
        {
            lock (_gate)
            {
                if (!_disposed && _generation == generation && ReferenceEquals(_active, turn) && !turn.Cancelled)
                {
                    turn.Cancelled = true;
                    AnswerCalls(turn, "Réponse abandonnée : trop longue.");
                    Fail(turn, $"Pas de fin de réponse en {TurnLimit.TotalMinutes:0} minutes : elle a été abandonnée.");
                    SoftInterrupt(turn);
                }
            }
        }, null, TurnLimit, Timeout.InfiniteTimeSpan);
    }

    /// <summary>
    /// Interruption douce : requete de controle <c>interrupt</c>. Claude Code clot alors le tour par un
    /// <c>result</c> ; faute de quoi le processus est tue (la session reste, le message suivant la reprend).
    /// </summary>
    private void SoftInterrupt(Turn active)
    {
        var generation = _generation;
        try
        {
            WriteLine(new JsonObject
            {
                ["type"] = "control_request",
                ["request_id"] = "interrupt-" + active.Number.ToString(CultureInfo.InvariantCulture),
                ["request"] = new JsonObject { ["subtype"] = "interrupt" },
            });
        }
        catch (Exception ex)
        {
            _log.Warn($"Assistant : interruption impossible ({ex.Message}), arret du processus.");
            DropActive();
            Kill();
            return;
        }

        active.Fallback = new Timer(_ =>
        {
            lock (_gate)
            {
                if (!_disposed && _generation == generation && ReferenceEquals(_active, active))
                {
                    _log.Warn("Assistant : pas de fin de tour apres l'interruption, arret du processus.");
                    if (_pending is not null)
                    {
                        Restart(); // un message attendait derriere la reponse arretee
                    }
                    else
                    {
                        DropActive();
                        Kill();
                    }
                }
            }
        }, null, InterruptGrace, Timeout.InfiniteTimeSpan);
    }

    /// <summary>Tue le processus et le relance avec <c>--resume</c> ; le message en attente partira ensuite.</summary>
    private void Restart()
    {
        DropActive();
        Kill();
        if (_launching || _disposed)
        {
            return;
        }

        _launching = true;
        _ = Task.Run(Launch);
    }

    private void DropActive()
    {
        if (_active is { } active)
        {
            active.Limit?.Dispose();
            active.Fallback?.Dispose();
            _active = null;
        }
    }

    private void StopIdle()
    {
        _idle?.Dispose();
        _idle = null;
    }

    /// <summary>Apres une reponse, le processus attend le message suivant ; trop longtemps, il s'arrete.</summary>
    private void ArmIdle()
    {
        StopIdle();
        var generation = _generation;
        _idle = new Timer(_ =>
        {
            lock (_gate)
            {
                if (!_disposed && _generation == generation && _active is null && _pending is null && _process is not null)
                {
                    _log.Info("Assistant : processus arrete apres une longue inactivite (la session reste).");
                    Kill();
                }
            }
        }, null, IdleLimit, Timeout.InfiniteTimeSpan);
    }

    // ------------------------------------------------------------------ processus

    /// <summary>
    /// Lance claude, puis envoie le message en attente. Hors verrou : <see cref="Process.Start()"/>
    /// prend plusieurs centaines de millisecondes.
    /// </summary>
    private void Launch()
    {
        ProcessStartInfo info;
        bool resume;
        string key;
        lock (_gate)
        {
            if (_disposed || _process is not null || _options is null)
            {
                _launching = false;
                SendPending();
                return;
            }

            var command = _launcher.CommandFor(AgentProvider.Claude);
            if (command is null)
            {
                _launching = false;
                FailAll("Claude Code est introuvable sur ce poste.");
                return;
            }

            resume = _hasHistory;
            key = _options.Key(_sessionId);
            info = Build(command, _options, _sessionId, resume);
        }

        var process = new Process { StartInfo = info };
        try
        {
            Directory.CreateDirectory(_dir);
            process.Start();
        }
        catch (Exception ex)
        {
            process.Dispose();
            _log.Error("Assistant : lancement de claude impossible", ex);
            lock (_gate)
            {
                _launching = false;
                FailAll("Lancement de Claude Code impossible : " + ex.Message);
            }

            return;
        }

        lock (_gate)
        {
            _launching = false;
            if (_disposed || _process is not null)
            {
                Discard(process);
                return;
            }

            var generation = ++_generation;
            _process = process;
            _input = process.StandardInput;
            _initialized = false;
            _stderr = new StringBuilder();
            _launchKey = key;
            _costSeen = 0;
            _log.Info($"Assistant : claude lance (pid {process.Id}, {(resume ? "reprise " : "session ")}{_sessionId}, {Describe(_options!)}).");

            _ = Task.Run(() => ReadErrorsAsync(process, generation));
            _ = Task.Run(() => ReadOutputAsync(process, generation, resume));
            SendPending();
        }
    }

    private ProcessStartInfo Build(CommandLine command, Options options, string sessionId, bool resume)
    {
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
            StandardInputEncoding = new UTF8Encoding(false),
        };

        foreach (var argument in command.Arguments)
        {
            info.ArgumentList.Add(argument);
        }

        foreach (var argument in new[]
        {
            "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--include-partial-messages", "--verbose",
        })
        {
            info.ArgumentList.Add(argument);
        }

        if (resume)
        {
            info.ArgumentList.Add("--resume");
            info.ArgumentList.Add(sessionId);
        }
        else
        {
            info.ArgumentList.Add("--session-id");
            info.ArgumentList.Add(sessionId);
            info.ArgumentList.Add("--name");
            info.ArgumentList.Add(SessionName);
        }

        info.ArgumentList.Add("--system-prompt");
        info.ArgumentList.Add(options.System);

        // Le serveur d'outils d'Organizator, servi par l'hote sur le protocole de controle ; aucun autre.
        info.ArgumentList.Add("--mcp-config");
        info.ArgumentList.Add(new JsonObject
        {
            ["mcpServers"] = new JsonObject
            {
                [ServerName] = new JsonObject { ["type"] = "sdk", ["name"] = ServerName },
            },
        }.ToJsonString());
        info.ArgumentList.Add("--strict-mcp-config");

        // Lire le disque, et agir sur Organizator par ses outils : rien d'autre (ni ecriture, ni shell, ni web).
        info.ArgumentList.Add("--tools");
        info.ArgumentList.Add(ReadTools);
        info.ArgumentList.Add("--allowedTools");
        info.ArgumentList.Add(ReadTools + "," + string.Join(",", options.Names.Select(n => ToolPrefix + n)));
        info.ArgumentList.Add("--permission-mode");
        info.ArgumentList.Add("dontAsk");

        if (options.Model.Length > 0)
        {
            info.ArgumentList.Add("--model");
            info.ArgumentList.Add(options.Model);
        }

        if (options.Effort.Length > 0)
        {
            info.ArgumentList.Add("--effort");
            info.ArgumentList.Add(options.Effort);
        }

        return info;
    }

    private async Task ReadErrorsAsync(Process process, int generation)
    {
        try
        {
            var buffer = new char[1024];
            int read;
            while ((read = await process.StandardError.ReadAsync(buffer, 0, buffer.Length).ConfigureAwait(false)) > 0)
            {
                lock (_gate)
                {
                    if (_generation != generation)
                    {
                        continue;
                    }

                    _stderr.Append(buffer, 0, read);
                    if (_stderr.Length > MaxStderr)
                    {
                        _stderr.Remove(0, _stderr.Length - MaxStderr);
                    }
                }
            }
        }
        catch (Exception)
        {
            // Flux ferme : le processus est mort ou a ete tue.
        }
    }

    private async Task ReadOutputAsync(Process process, int generation, bool resumed)
    {
        try
        {
            string? line;
            while ((line = await process.StandardOutput.ReadLineAsync().ConfigureAwait(false)) is not null)
            {
                lock (_gate)
                {
                    if (_generation != generation || _disposed)
                    {
                        return;
                    }

                    Feed(line);
                }
            }
        }
        catch (Exception ex)
        {
            if (_generation == generation)
            {
                _log.Warn($"Assistant : lecture de la sortie interrompue ({ex.Message}).");
            }
        }

        try
        {
            await process.WaitForExitAsync().ConfigureAwait(false);
        }
        catch (Exception)
        {
            // Deja libere.
        }

        lock (_gate)
        {
            if (_generation != generation || _disposed)
            {
                return;
            }

            var code = SafeExitCode(process);
            var stderr = _stderr.ToString().Trim();
            _log.Warn($"Assistant : claude s'est arrete (code {code}) {Shorten(stderr, 300)}");
            _process = null;
            _input = null;
            process.Dispose();
            foreach (var call in _calls.Values.ToList())
            {
                call.Timer?.Dispose();
            }

            _calls.Clear();

            // Session introuvable (effacee, ou d'un autre poste) : la discussion repart sans son historique.
            if (resumed && !_initialized && stderr.Contains("No conversation found", StringComparison.OrdinalIgnoreCase))
            {
                _hasHistory = false;
                var lost = _active;
                DropActive();
                if (lost is { Cancelled: false, Retried: false })
                {
                    lost.Retried = true;
                    _pending ??= lost;
                }

                if (_pending is { } next)
                {
                    Emit(next, "notice", "La discussion précédente est introuvable : l'assistant repart sans son historique.");
                }

                _launching = true;
                _ = Task.Run(Launch);
                return;
            }

            var why = VoiceChat.Explain(stderr, code);
            if (_active is { } active)
            {
                DropActive();
                if (!active.Cancelled)
                {
                    Fail(active, why);
                }
            }

            // Mort avant d'avoir pu prendre le message en attente (demarrage rate) : pas de boucle de relance.
            if (_pending is { } pending)
            {
                _pending = null;
                Fail(pending, why);
            }
        }
    }

    /// <summary>Une ligne du flux de claude ; sous le verrou.</summary>
    private void Feed(string line)
    {
        if (line.Length == 0 || line[0] != '{')
        {
            return;
        }

        JsonNode? node;
        try
        {
            node = JsonNode.Parse(line);
        }
        catch (JsonException)
        {
            return;
        }

        if (node is not JsonObject root || root["parent_tool_use_id"] is JsonValue)
        {
            return;
        }

        var turn = _active;
        switch (Str(root, "type"))
        {
            case "control_request":
                OnControlRequest(root);
                return;

            case "system":
                if (Str(root, "subtype") == "init")
                {
                    _initialized = true;
                }

                return;

            case "stream_event":
                if (turn is null || turn.Cancelled || root["event"] is not JsonObject ev)
                {
                    return;
                }

                switch (Str(ev, "type"))
                {
                    case "message_start":
                        // Le message est dans la session : une relance la reprendra.
                        _hasHistory = true;
                        turn.Writing = Str(ev["message"] as JsonObject, "id") ?? ("m" + turn.Number + "-" + (++turn.Messages));
                        break;

                    case "content_block_delta":
                        if (ev["delta"] is JsonObject delta && Str(delta, "type") == "text_delta")
                        {
                            var id = turn.Writing ?? ("m" + turn.Number);
                            turn.Streamed.Add(id);
                            if (!turn.Texts.TryGetValue(id, out var sb))
                            {
                                turn.Texts[id] = sb = new StringBuilder();
                            }

                            sb.Append(Str(delta, "text"));
                            turn.Dirty = id;
                            FlushText(turn, force: false);
                        }

                        break;

                    case "content_block_start":
                    case "message_stop":
                        FlushText(turn, force: true);
                        break;
                }

                return;

            case "assistant":
                if (turn is null || turn.Cancelled || root["message"] is not JsonObject message || message["content"] is not JsonArray blocks)
                {
                    return;
                }

                var messageId = Str(message, "id") ?? turn.Writing ?? ("m" + turn.Number);
                foreach (var block in blocks.OfType<JsonObject>())
                {
                    switch (Str(block, "type"))
                    {
                        case "text" when !turn.Streamed.Contains(messageId):
                            // Sans flux partiel (ou flux manque) : le texte du message complet.
                            if (!turn.Texts.TryGetValue(messageId, out var full))
                            {
                                turn.Texts[messageId] = full = new StringBuilder();
                            }

                            full.Append(Str(block, "text"));
                            turn.Dirty = messageId;
                            FlushText(turn, force: true);
                            break;

                        case "tool_use":
                            var name = Str(block, "name") ?? "";
                            if (!name.StartsWith(ToolPrefix, StringComparison.Ordinal))
                            {
                                Emit(turn, "tool", extra: new JsonObject { ["name"] = name, ["detail"] = ToolDetail(block["input"] as JsonObject) });
                            }

                            break;
                    }
                }

                return;

            case "result":
                _hasHistory = true;
                // Le cout du tour : l'ecart avec le total deja annonce par ce processus.
                var total = Number(root, "total_cost_usd");
                var cost = Math.Max(0, total - _costSeen);
                _costSeen = Math.Max(_costSeen, total);
                if (turn is null)
                {
                    return;
                }

                DropActive();
                AnswerCalls(turn, "Réponse terminée.");
                if (!turn.Cancelled)
                {
                    FlushText(turn, force: true);
                    var isError = root["is_error"] is JsonValue e && e.TryGetValue<bool>(out var err) && err;
                    if (isError || Str(root, "subtype") is { Length: > 0 } subtype && subtype != "success")
                    {
                        Fail(turn, VoiceChat.Explain(Str(root, "result") ?? "", 0));
                    }
                    else
                    {
                        Emit(turn, "done", extra: new JsonObject
                        {
                            ["cost"] = cost,
                            ["ms"] = Number(root, "duration_ms"),
                        });
                    }
                }

                SendPending();
                if (_active is null && _pending is null)
                {
                    ArmIdle();
                }

                return;
        }
    }

    /// <summary>Requete de controle de la CLI : seul le serveur MCP d'Organizator est servi.</summary>
    private void OnControlRequest(JsonObject root)
    {
        var requestId = Str(root, "request_id") ?? "";
        var request = root["request"] as JsonObject;
        if (requestId.Length == 0 || request is null)
        {
            return;
        }

        try
        {
            if (Str(request, "subtype") == "mcp_message" && Str(request, "server_name") == ServerName && request["message"] is JsonObject message)
            {
                if (HandleMcp(requestId, message) is { } response)
                {
                    WriteControlResponse(requestId, response);
                }

                return;
            }

            WriteLine(new JsonObject
            {
                ["type"] = "control_response",
                ["response"] = new JsonObject
                {
                    ["subtype"] = "error",
                    ["request_id"] = requestId,
                    ["error"] = "Requête non prise en charge par Organizator : " + (Str(request, "subtype") ?? "?"),
                },
            });
        }
        catch (Exception ex)
        {
            _log.Warn("Assistant : requete de controle sans reponse : " + ex.Message);
        }
    }

    /// <summary>Ce que lit un outil de lecture : le fichier, ou le motif cherche.</summary>
    private static string ToolDetail(JsonObject? input)
    {
        if (input is null)
        {
            return "";
        }

        var path = Str(input, "file_path") ?? Str(input, "path") ?? "";
        var pattern = Str(input, "pattern") ?? "";
        var detail = pattern.Length > 0 ? pattern + (path.Length > 0 ? " · " + Path.GetFileName(path.TrimEnd('\\', '/')) : "") : path;
        return detail.Length <= 160 ? detail : detail[..160] + "…";
    }

    /// <summary>Pousse le texte du message en cours, au plus toutes les <see cref="TextEvery"/> ; sous le verrou.</summary>
    private void FlushText(Turn turn, bool force)
    {
        if (turn.Dirty is not { } id || turn.Cancelled)
        {
            return;
        }

        var now = DateTime.UtcNow;
        if (!force && now - turn.LastText < TextEvery)
        {
            return;
        }

        turn.Dirty = null;
        turn.LastText = now;
        Emit(turn, "text", extra: new JsonObject { ["msg"] = id, ["text"] = turn.Texts[id].ToString() });
    }

    private void Fail(Turn turn, string error)
        => Emit(turn, "error", extra: new JsonObject { ["error"] = error });

    private void FailAll(string error)
    {
        if (_active is { } active)
        {
            DropActive();
            AnswerCalls(active, error);
            if (!active.Cancelled)
            {
                Fail(active, error);
            }
        }

        if (_pending is { } pending)
        {
            _pending = null;
            Fail(pending, error);
        }
    }

    private void Emit(Turn turn, string phase, string text = "", JsonObject? extra = null)
    {
        var payload = new JsonObject { ["turn"] = turn.Number, ["phase"] = phase };
        if (text.Length > 0)
        {
            payload["text"] = text;
        }

        if (extra is not null)
        {
            foreach (var (key, value) in extra.ToList())
            {
                extra.Remove(key);
                payload[key] = value;
            }
        }

        try
        {
            Progress?.Invoke(payload);
        }
        catch (Exception ex)
        {
            _log.Warn("Avancement de l'assistant non transmis : " + ex.Message);
        }
    }

    private void WriteLine(JsonObject message)
    {
        var input = _input ?? throw new IOException("processus absent");
        input.Write(message.ToJsonString(LineJson) + "\n");
        input.Flush();
    }

    /// <summary>Tue le processus courant ; la generation change, ses lecteurs se taisent.</summary>
    private void Kill()
    {
        _generation++;
        foreach (var call in _calls.Values)
        {
            call.Timer?.Dispose();
        }

        _calls.Clear();
        var process = _process;
        _process = null;
        _input = null;
        _launchKey = "";
        if (process is not null)
        {
            Discard(process);
        }
    }

    private void Discard(Process process)
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
            _log.Warn("Assistant : arret de claude impossible (" + ex.Message + ").");
        }
        finally
        {
            process.Dispose();
        }
    }

    // ------------------------------------------------------------------ utilitaires

    private static string Describe(Options options)
        => string.Join(", ", new[]
        {
            options.Model.Length > 0 ? "modele " + options.Model : "modele par defaut",
            options.Effort.Length > 0 ? "effort " + options.Effort : "",
            options.Names.Count + " outils",
        }.Where(s => s.Length > 0));

    private static string Shorten(string text, int max)
    {
        var line = (text ?? "").Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).LastOrDefault() ?? "";
        return line.Length <= max ? line : line[..max].TrimEnd() + "…";
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

    private static string? Str(JsonObject? node, string name)
        => node is not null && node[name] is JsonValue value && value.TryGetValue<string>(out var s) ? s : null;

    private static double Number(JsonObject node, string name)
        => node[name] is JsonValue value && value.TryGetValue<double>(out var n) ? n : 0;

    /// <summary>Reglages d'un lancement : le processus repart quand l'un d'eux change.</summary>
    private sealed class Options
    {
        public Options(string model, string effort, string system, JsonArray tools)
        {
            Model = model;
            Effort = effort;
            System = system;
            Tools = tools;
            Names = tools.OfType<JsonObject>().Select(t => Str(t, "name") ?? "").ToList();
            _toolsJson = tools.ToJsonString();
        }

        private readonly string _toolsJson;

        public string Model { get; }
        public string Effort { get; }
        public string System { get; }
        public JsonArray Tools { get; }
        public IReadOnlyList<string> Names { get; }

        public bool Has(string name) => Names.Contains(name, StringComparer.Ordinal);

        public string Key(string sessionId)
            => string.Join("\u001f", sessionId, Model, Effort, System.GetHashCode(StringComparison.Ordinal), _toolsJson.GetHashCode(StringComparison.Ordinal));
    }

    /// <summary>Un appel d'outil pousse a la page, en attente de son resultat.</summary>
    private sealed class Call
    {
        public Call(string requestId, JsonNode? rpcId, Turn turn, int generation)
        {
            RequestId = requestId;
            RpcId = rpcId;
            Turn = turn;
            Generation = generation;
        }

        public string RequestId { get; }
        public JsonNode? RpcId { get; }
        public Turn Turn { get; }
        public int Generation { get; }
        public Timer? Timer { get; set; }
    }

    private sealed class Turn
    {
        public Turn(int number, string message)
        {
            Number = number;
            Message = message;
        }

        public int Number { get; }
        public string Message { get; }
        public bool Cancelled { get; set; }
        public bool Retried { get; set; }
        public Timer? Limit { get; set; }
        public Timer? Fallback { get; set; }

        /// <summary>Message de l'agent en cours d'ecriture (identifiant de l'API) et nombre de messages du tour.</summary>
        public string? Writing { get; set; }
        public int Messages { get; set; }

        /// <summary>Texte de chaque message de l'agent ; ceux dont le flux partiel est arrive.</summary>
        public Dictionary<string, StringBuilder> Texts { get; } = new(StringComparer.Ordinal);
        public HashSet<string> Streamed { get; } = new(StringComparer.Ordinal);

        /// <summary>Message dont le texte a change depuis le dernier envoi a la page.</summary>
        public string? Dirty { get; set; }
        public DateTime LastText { get; set; }
    }
}
