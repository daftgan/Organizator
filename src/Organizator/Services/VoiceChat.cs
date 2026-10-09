using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Organizator.Services;

/// <summary>
/// Reglages d'une conversation vocale, deja verifies. <paramref name="Mode"/> : <c>free</c> (conversation
/// libre, <see cref="VoiceChat.SystemPrompt"/>) ou <c>tutor</c> (tuteur d'anglais de Revizator,
/// <paramref name="Tutor"/> = <c>{ scenario, level, lang, explain, lesson, context, history }</c>).
/// <paramref name="Name"/> : nom lisible de la session de Claude Code (vide : « Conversation vocale · persona »).
/// </summary>
public sealed record VoiceOptions(string Model, string Effort, string Persona, string Topic, string Instructions, bool Web,
    string Mode = VoiceChat.FreeMode, JsonObject? Tutor = null, string Name = "")
{
    public bool IsTutor => Mode == VoiceChat.TutorMode;
}

/// <summary>
/// Conversation a voix haute avec Claude. Un processus <c>claude -p</c> persistant par conversation,
/// en <c>--input-format stream-json</c> : chaque phrase de l'utilisateur est ecrite sur son entree
/// standard, sans relancer l'outil, et la reponse revient au fil de l'eau
/// (<c>--output-format stream-json --include-partial-messages</c>), decoupee en phrases par
/// <see cref="VoiceSentences"/> et poussee par <see cref="Progress"/> : la page synthetise la
/// premiere pendant que la suite s'ecrit.
///
/// Le processus demarre des <see cref="Start"/> (prechauffage) ; il tourne dans un dossier
/// <c>voice</c> du dossier de donnees, sans aucun outil sinon <c>WebSearch</c> et <c>WebFetch</c>,
/// sans serveur MCP (<c>--strict-mcp-config</c>), en mode <c>dontAsk</c>.
///
/// Interruption : la requete de controle <c>interrupt</c> de Claude Code (celle du SDK) arrete la
/// generation en quelques millisecondes et clot le tour par un <c>result</c>. Si ce <c>result</c>
/// n'arrive pas a temps, le processus est tue et relance aussitot avec <c>--resume</c>, ce qui garde
/// l'historique. Dans les deux cas, plus aucun evenement du tour interrompu ne part, et le message
/// suivant commence par une note disant ce que l'utilisateur a entendu de la reponse coupee.
///
/// Un seul message est ecrit a la fois : le suivant attend le <c>result</c> du precedent, si bien que
/// chaque sortie se rattache sans ambiguite a son tour. Rien n'est garde sur le disque en dehors de
/// la session de Claude Code elle-meme.
/// </summary>
public sealed class VoiceChat : IDisposable
{
    /// <summary>Delai laisse a l'interruption douce avant de tuer et relancer le processus.</summary>
    private static readonly TimeSpan InterruptGrace = TimeSpan.FromSeconds(2.5);

    /// <summary>Un tour sans fin au-dela est abandonne (recherche web bloquee, API muette).</summary>
    private static readonly TimeSpan TurnLimit = TimeSpan.FromMinutes(3);

    public const string FreeMode = "free";
    public const string TutorMode = "tutor";

    private const int MaxText = 4000;
    private const int MaxName = 120;
    private const int MaxHeard = 1500;
    private const int MaxStderr = 4000;
    private const string WebTools = "WebSearch,WebFetch";

    private static readonly JsonSerializerOptions LineJson = new() { Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    /// <summary>Sujets de conversation : id stable (reglage <c>voiceTopic</c>) et consigne pour le prompt systeme.</summary>
    public static readonly IReadOnlyDictionary<string, string> Topics = new Dictionary<string, string>(StringComparer.Ordinal)
    {
        ["libre"] = "Discussion libre : suis les envies de ton interlocuteur, rebondis sur ce qu'il dit, et propose de temps en temps une piste nouvelle quand la conversation s'essouffle.",
        ["actu"] = "Actualité et technologie : vous parlez de l'actualité, du numérique, de l'intelligence artificielle et des innovations. Pour un fait récent, un chiffre ou une date, vérifie plutôt que de te fier à ta mémoire, et dis en quelques mots d'où vient l'information. Donne ton avis quand on te le demande, en distinguant les faits des opinions.",
        ["culture"] = "Histoire et culture : raconte comme un conteur, avec des anecdotes, des personnages et du contexte. Situe en quelques mots l'époque et le lieu, et distingue ce qui est établi de ce qui relève de la légende.",
        ["sciences"] = "Sciences : explique simplement, avec une image ou une comparaison tirée de la vie quotidienne, sans jargon ou en le définissant. Avance par petites étapes et vérifie de temps en temps que c'est clair.",
        ["philo"] = "Philosophie : aide ton interlocuteur à penser par lui-même. Reformule son idée, propose une distinction ou une objection, évoque un philosophe quand cela éclaire vraiment, et pose des questions qui font avancer. Ne fais pas la leçon.",
        ["debat"] = "Débat : tu prends le contre-pied de ce que soutient ton interlocuteur, avec des arguments solides et de bonne foi, sans agressivité. Reconnais franchement un bon argument, puis relance. S'il te le demande, change de camp.",
        ["anglais"] = "Pratique de l'anglais : tu parles anglais, toujours, dans un anglais simple et naturel, avec un vocabulaire courant. Si ton interlocuteur fait une faute, reprends-la avec douceur, en redisant brièvement la bonne formulation, puis continue la conversation sans en faire une leçon. S'il parle français ou cherche un mot, donne-lui le mot anglais et poursuis en anglais. Encourage-le à parler plus que toi.",
        ["coach"] = "Coaching et organisation : aide ton interlocuteur à clarifier ce qu'il veut, à prioriser et à se débloquer. Pose une question à la fois, écoute, reformule, et propose une petite action concrète plutôt qu'un grand plan. Sois bienveillant mais franc.",
        ["fiction"] = "Livres, films et séries : partage des avis personnels et argumentés, recommande en fonction des goûts de ton interlocuteur, et ne dévoile jamais une intrigue sans prévenir.",
        ["impro"] = "Jeu de rôle et improvisation : entre dans le jeu. Incarne les personnages et le décor que propose ton interlocuteur, ou propose un point de départ s'il n'en a pas. Reste dans ton rôle, fais avancer l'histoire avec des rebondissements, et laisse-lui toujours la main pour la suite. Ne sors du rôle que s'il le demande.",
    };

    private readonly AgentLauncher _launcher;
    private readonly HostLog _log;
    private readonly string _dir;
    private readonly object _gate = new();
    private readonly Dictionary<string, Conversation> _conversations = new(StringComparer.Ordinal);
    private bool _disposed;

    public VoiceChat(AgentLauncher launcher, HostLog log, string dataDir)
    {
        _launcher = launcher;
        _log = log;
        _dir = Path.Combine(dataDir, "voice");

        // Filet : un claude orphelin continuerait de tourner apres la fermeture de l'application.
        AppDomain.CurrentDomain.ProcessExit += (_, _) => StopAll();
    }

    /// <summary>
    /// Avancement d'une reponse : <c>{ conversationId, turn, phase, text, full, error }</c>, <c>phase</c>
    /// valant <c>thinking</c>, <c>sentence</c>, <c>tool</c>, <c>meta</c>, <c>done</c> ou <c>error</c>. Leve hors
    /// du fil de l'interface, dans l'ordre. En mode tutor, <c>meta</c> porte en plus
    /// <c>meta: { replyFr, recast: { said, better }, tipFr, end }</c> (la ligne <c>§META</c> de la reponse,
    /// jamais lue ni incluse dans <c>full</c>) : apres la derniere <c>sentence</c>, avant <c>done</c>, et
    /// seulement pour un tour non interrompu dont la ligne est lisible.
    /// </summary>
    public event Action<JsonObject>? Progress;

    public static string SanitizeTopic(string? topic)
    {
        var value = (topic ?? "").Trim().ToLowerInvariant();
        return Topics.ContainsKey(value) ? value : "libre";
    }

    public static string SanitizeMode(string? mode)
        => (mode ?? "").Trim().ToLowerInvariant() == TutorMode ? TutorMode : FreeMode;

    /// <summary>Nom de session lisible : une ligne, 120 caracteres au plus ; vide si rien.</summary>
    public static string SanitizeName(string? name)
    {
        var value = string.Join(' ', (name ?? "").Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
        return value.Length <= MaxName ? value : value[..MaxName].TrimEnd();
    }

    public static string SanitizePersona(string? persona)
    {
        var value = string.Join(' ', (persona ?? "").Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
        if (value.Length > 40)
        {
            value = value[..40].Trim();
        }

        return value.Length == 0 ? "Alma" : value;
    }

    // ------------------------------------------------------------------ commandes

    /// <summary>
    /// Ouvre une conversation (et ferme les precedentes) : le processus claude demarre en arriere-plan,
    /// pret pour la premiere phrase. Rend l'identifiant de la conversation.
    /// </summary>
    public string Start(VoiceOptions options)
    {
        if (_launcher.CommandFor(AgentProvider.Claude) is null)
        {
            throw new InvalidOperationException("Claude Code est introuvable sur ce poste : la conversation vocale passe par lui.");
        }

        Directory.CreateDirectory(_dir);
        var conversation = options.IsTutor
            ? new Conversation(Guid.NewGuid().ToString("N"), options, TutorGenre.VoicePrompt(options.Tutor)) { Preamble = TutorGenre.VoicePreamble(options.Tutor) }
            : new Conversation(Guid.NewGuid().ToString("N"), options, SystemPrompt(options, DateTime.Now));

        List<Conversation> previous;
        lock (_gate)
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            previous = _conversations.Values.ToList();
            _conversations.Clear();
            _conversations[conversation.Id] = conversation;
        }

        // Hors du fil de l'interface : tuer un arbre de processus et en lancer un autre prend du temps.
        _ = Task.Run(() =>
        {
            foreach (var old in previous)
            {
                Close(old);
            }

            Launch(conversation);
        });

        _log.Info($"Conversation vocale {conversation.Id} ouverte ({Describe(options)}).");
        return conversation.Id;
    }

    /// <summary>
    /// L'utilisateur a parle : son texte part a Claude (tout de suite si le processus est libre, sinon
    /// des que le tour precedent est clos). Un tour en cours est interrompu d'office. <paramref name="heard"/>
    /// : ce que l'utilisateur a entendu de la reponse precedente, si elle a ete coupee. Rend le numero du tour.
    /// </summary>
    public int Say(string? conversationId, string? text, string? heard)
    {
        var message = Clip(text, MaxText);
        if (message.Length == 0)
        {
            throw new InvalidOperationException("Rien à dire : la phrase est vide.");
        }

        var conversation = Find(conversationId);
        lock (conversation)
        {
            if (conversation.Closed)
            {
                throw new InvalidOperationException("Cette conversation est terminée.");
            }

            if (conversation.Active is { Cancelled: false } || conversation.Pending is not null)
            {
                Cancel(conversation, heard ?? "");
            }
            else if (heard is not null)
            {
                conversation.Heard = Clip(heard, MaxHeard);
            }

            var learner = string.IsNullOrWhiteSpace(conversation.CarryLearner) ? message : conversation.CarryLearner.Trim() + " " + message;
            var turn = new Turn(++conversation.LastTurn, Compose(conversation, message), learner);
            conversation.Heard = null;
            conversation.Carry = null;
            conversation.CarryLearner = null;
            Emit(conversation, turn, "thinking");

            conversation.Pending = turn;
            if (conversation.Process is null && !conversation.Launching)
            {
                // Processus mort depuis le dernier tour : relance (avec --resume s'il y a un historique).
                conversation.Launching = true;
                _ = Task.Run(() => Launch(conversation));
            }
            else
            {
                SendPending(conversation);
            }

            return turn.Number;
        }
    }

    /// <summary>
    /// Arrete la reponse en cours, s'il y en a une, et retient ce que l'utilisateur en a entendu pour
    /// le prochain message. Sans reponse en cours (la voix lisait une reponse deja complete), seule la
    /// note est retenue.
    /// </summary>
    public void Interrupt(string? conversationId, string? heard)
    {
        var conversation = TryFind(conversationId);
        if (conversation is null)
        {
            return;
        }

        lock (conversation)
        {
            if (conversation.Closed)
            {
                return;
            }

            if (conversation.Active is { Cancelled: false } || conversation.Pending is not null)
            {
                Cancel(conversation, heard ?? "");
            }
            else
            {
                conversation.Heard = Clip(heard, MaxHeard);
            }
        }
    }

    /// <summary>Fin de la conversation : le processus est tue. Identifiant inconnu : rien a faire.</summary>
    public void Stop(string? conversationId)
    {
        Conversation? conversation;
        lock (_gate)
        {
            if (conversationId is null || !_conversations.Remove(conversationId, out conversation))
            {
                return;
            }
        }

        _ = Task.Run(() => Close(conversation));
        _log.Info($"Conversation vocale {conversation.Id} fermee ({conversation.LastTurn} tours).");
    }

    /// <summary>Ferme toutes les conversations (fermeture de l'application).</summary>
    public void StopAll()
    {
        List<Conversation> all;
        lock (_gate)
        {
            all = _conversations.Values.ToList();
            _conversations.Clear();
        }

        foreach (var conversation in all)
        {
            Close(conversation);
        }
    }

    public void Dispose()
    {
        lock (_gate)
        {
            _disposed = true;
        }

        StopAll();
    }

    // ------------------------------------------------------------------ tours

    /// <summary>Annule le tour en cours et celui qui attendait ; appele sous le verrou de la conversation.</summary>
    private void Cancel(Conversation conversation, string heard)
    {
        if (conversation.Pending is { } pending)
        {
            // Jamais parti : Claude ne l'a pas vu, son texte rejoindra le prochain message.
            pending.Cancelled = true;
            conversation.Carry = pending.Message;
            conversation.CarryLearner = pending.Learner;
            conversation.Pending = null;
        }

        if (conversation.Active is { Cancelled: false } active)
        {
            active.Cancelled = true;
            conversation.Heard = Clip(heard, MaxHeard);
            active.Limit?.Dispose();
            SoftInterrupt(conversation, active);
        }
    }

    /// <summary>
    /// Interruption douce : requete de controle <c>interrupt</c> sur l'entree standard. Claude Code
    /// clot alors le tour par un <c>result</c> (sous-type <c>error_during_execution</c>). Faute de
    /// <c>result</c> dans le delai, ou si l'ecriture echoue, le processus est tue et relance.
    /// </summary>
    private void SoftInterrupt(Conversation conversation, Turn active)
    {
        var generation = conversation.Generation;
        try
        {
            var request = new JsonObject
            {
                ["type"] = "control_request",
                ["request_id"] = "interrupt-" + active.Number.ToString(CultureInfo.InvariantCulture),
                ["request"] = new JsonObject { ["subtype"] = "interrupt" },
            };
            WriteLine(conversation, request);
        }
        catch (Exception ex)
        {
            _log.Warn($"Conversation vocale {conversation.Id} : interruption impossible ({ex.Message}), relance du processus.");
            Restart(conversation);
            return;
        }

        active.Fallback = new Timer(_ =>
        {
            lock (conversation)
            {
                if (!conversation.Closed && conversation.Generation == generation && ReferenceEquals(conversation.Active, active))
                {
                    _log.Warn($"Conversation vocale {conversation.Id} : pas de fin de tour apres l'interruption, relance du processus.");
                    Restart(conversation);
                }
            }
        }, null, InterruptGrace, Timeout.InfiniteTimeSpan);
    }

    /// <summary>Tue le processus et le relance avec <c>--resume</c> ; le message en attente partira ensuite.</summary>
    private void Restart(Conversation conversation)
    {
        DropActive(conversation);
        Kill(conversation);
        if (conversation.Launching || conversation.Closed)
        {
            return; // Un lancement est deja en route : il prendra le message en attente.
        }

        conversation.Launching = true;
        _ = Task.Run(() => Launch(conversation));
    }

    /// <summary>Ecrit le message en attente si le processus est pret et libre ; sous le verrou.</summary>
    private void SendPending(Conversation conversation)
    {
        if (conversation.Pending is not { } turn || conversation.Active is not null
            || conversation.Process is null || conversation.Launching || conversation.Closed)
        {
            return;
        }

        conversation.Pending = null;
        conversation.Active = turn;
        try
        {
            WriteLine(conversation, new JsonObject
            {
                ["type"] = "user",
                ["message"] = new JsonObject { ["role"] = "user", ["content"] = turn.Message },
            });
        }
        catch (Exception ex)
        {
            // Processus mort entre deux tours : on relance et le message repart (une seule fois).
            conversation.Active = null;
            if (turn.Retried)
            {
                Fail(conversation, turn, "La conversation avec Claude s'est interrompue : " + ex.Message);
                return;
            }

            turn.Retried = true;
            conversation.Pending = turn;
            _log.Warn($"Conversation vocale {conversation.Id} : ecriture impossible ({ex.Message}), relance.");
            Restart(conversation);
            return;
        }

        var generation = conversation.Generation;
        turn.Limit = new Timer(_ =>
        {
            lock (conversation)
            {
                if (!conversation.Closed && conversation.Generation == generation && ReferenceEquals(conversation.Active, turn) && !turn.Cancelled)
                {
                    Fail(conversation, turn, $"Pas de réponse en {TurnLimit.TotalMinutes:0} minutes : la réponse a été abandonnée.");
                    turn.Cancelled = true;
                    SoftInterrupt(conversation, turn);
                }
            }
        }, null, TurnLimit, Timeout.InfiniteTimeSpan);
    }

    /// <summary>
    /// Le premier message apres une interruption dit a Claude ce que l'utilisateur a entendu (en anglais
    /// en mode tutor). En mode tutor, le tout premier message est precede, une fois, du contexte et de la
    /// conversation deja tenue (<see cref="TutorGenre.VoicePreamble"/>).
    /// </summary>
    private static string Compose(Conversation conversation, string message)
    {
        var sb = new StringBuilder();
        if (!string.IsNullOrEmpty(conversation.Preamble))
        {
            sb.Append(conversation.Preamble);
            conversation.Preamble = null;
        }

        if (conversation.Heard is { } heard)
        {
            if (conversation.Options.IsTutor)
            {
                sb.Append(heard.Length > 0
                    ? "(You were interrupted. The learner heard this much of your reply: “" + heard + "”. They did not hear the rest. Do not repeat what they already heard; answer what they say now.)\n\n"
                    : "(You were interrupted before the learner heard anything of your reply. Answer what they say now.)\n\n");
            }
            else if (heard.Length > 0)
            {
                sb.Append("(Tu as été interrompu. L'utilisateur avait entendu de ta réponse : « ").Append(heard)
                  .Append(" ». Il n'a pas entendu la suite. Ne répète pas ce qu'il a déjà entendu et réponds à ce qu'il dit maintenant.)\n\n");
            }
            else
            {
                sb.Append("(Tu as été interrompu avant que l'utilisateur n'entende ta réponse : il n'en a rien entendu. Réponds à ce qu'il dit maintenant.)\n\n");
            }
        }

        if (!string.IsNullOrWhiteSpace(conversation.Carry))
        {
            sb.Append(conversation.Carry.Trim()).Append("\n\n");
        }

        sb.Append(message);
        return sb.ToString();
    }

    // ------------------------------------------------------------------ processus

    /// <summary>
    /// Lance (ou relance) claude pour la conversation, puis envoie le message en attente. Hors verrou :
    /// <see cref="Process.Start()"/> prend plusieurs centaines de millisecondes, pendant lesquelles
    /// <see cref="Say"/> et <see cref="Interrupt"/> doivent rester instantanes.
    /// </summary>
    private void Launch(Conversation conversation)
    {
        ProcessStartInfo info;
        bool resume;
        lock (conversation)
        {
            if (conversation.Closed || conversation.Process is not null)
            {
                conversation.Launching = false;
                SendPending(conversation);
                return;
            }

            var command = _launcher.CommandFor(AgentProvider.Claude);
            if (command is null)
            {
                conversation.Launching = false;
                FailAll(conversation, "Claude Code est introuvable sur ce poste.");
                return;
            }

            conversation.Launching = true;
            resume = conversation.HasHistory;
            info = Build(command, conversation, resume);
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
            _log.Error($"Conversation vocale {conversation.Id} : lancement de claude impossible", ex);
            lock (conversation)
            {
                conversation.Launching = false;
                FailAll(conversation, "Lancement de Claude Code impossible : " + ex.Message);
            }

            return;
        }

        lock (conversation)
        {
            conversation.Launching = false;
            if (conversation.Closed || conversation.Process is not null)
            {
                // Conversation fermee (ou deja relancee) pendant le demarrage.
                Discard(process);
                return;
            }

            var generation = ++conversation.Generation;
            conversation.Process = process;
            conversation.Input = process.StandardInput;
            conversation.Initialized = false;
            conversation.Stderr = new StringBuilder();
            _log.Info($"Conversation vocale {conversation.Id} : claude lance (pid {process.Id}, {(resume ? "reprise " : "session ")}{conversation.SessionId}).");

            _ = Task.Run(() => ReadErrorsAsync(conversation, process, generation));
            _ = Task.Run(() => ReadOutputAsync(conversation, process, generation, resume));
            SendPending(conversation);
        }
    }

    private ProcessStartInfo Build(CommandLine command, Conversation conversation, bool resume)
    {
        var options = conversation.Options;
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

        info.ArgumentList.Add("-p");
        info.ArgumentList.Add("--input-format");
        info.ArgumentList.Add("stream-json");
        info.ArgumentList.Add("--output-format");
        info.ArgumentList.Add("stream-json");
        info.ArgumentList.Add("--include-partial-messages");
        info.ArgumentList.Add("--verbose");

        if (resume)
        {
            info.ArgumentList.Add("--resume");
            info.ArgumentList.Add(conversation.SessionId);
        }
        else
        {
            info.ArgumentList.Add("--session-id");
            info.ArgumentList.Add(conversation.SessionId);
            info.ArgumentList.Add("--name");
            info.ArgumentList.Add(options.Name.Length > 0 ? options.Name : "Conversation vocale · " + options.Persona);
        }

        info.ArgumentList.Add("--system-prompt");
        info.ArgumentList.Add(conversation.SystemPrompt);

        // Le web si l'utilisateur l'a permis, et rien d'autre : ni le disque, ni le shell.
        info.ArgumentList.Add("--tools");
        info.ArgumentList.Add(options.Web ? WebTools : "");
        if (options.Web)
        {
            info.ArgumentList.Add("--allowedTools");
            info.ArgumentList.Add(WebTools);
        }

        info.ArgumentList.Add("--permission-mode");
        info.ArgumentList.Add("dontAsk");
        info.ArgumentList.Add("--strict-mcp-config");

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

    private async Task ReadErrorsAsync(Conversation conversation, Process process, int generation)
    {
        try
        {
            var buffer = new char[1024];
            int read;
            while ((read = await process.StandardError.ReadAsync(buffer, 0, buffer.Length).ConfigureAwait(false)) > 0)
            {
                lock (conversation)
                {
                    if (conversation.Generation != generation)
                    {
                        continue;
                    }

                    var sb = conversation.Stderr;
                    sb.Append(buffer, 0, read);
                    if (sb.Length > MaxStderr)
                    {
                        sb.Remove(0, sb.Length - MaxStderr);
                    }
                }
            }
        }
        catch (Exception)
        {
            // Flux ferme : le processus est mort ou a ete tue.
        }
    }

    private async Task ReadOutputAsync(Conversation conversation, Process process, int generation, bool resumed)
    {
        try
        {
            string? line;
            while ((line = await process.StandardOutput.ReadLineAsync().ConfigureAwait(false)) is not null)
            {
                lock (conversation)
                {
                    if (conversation.Generation != generation || conversation.Closed)
                    {
                        return;
                    }

                    Feed(conversation, line);
                }
            }
        }
        catch (Exception ex)
        {
            if (conversation.Generation == generation)
            {
                _log.Warn($"Conversation vocale {conversation.Id} : lecture de la sortie interrompue ({ex.Message}).");
            }
        }

        // Fin du flux : le processus est mort (ou a ete tue par une relance, qui a change la generation).
        try
        {
            await process.WaitForExitAsync().ConfigureAwait(false);
        }
        catch (Exception)
        {
            // Deja libere.
        }

        lock (conversation)
        {
            if (conversation.Generation != generation || conversation.Closed)
            {
                return;
            }

            var code = SafeExitCode(process);
            var stderr = conversation.Stderr.ToString().Trim();
            _log.Warn($"Conversation vocale {conversation.Id} : claude s'est arrete (code {code}) {Shorten(stderr, 300)}");
            conversation.Process = null;
            conversation.Input = null;
            process.Dispose();

            // Reprise impossible (session effacee) : on repart d'une session neuve, une fois.
            if (resumed && !conversation.Initialized && stderr.Contains("No conversation found", StringComparison.OrdinalIgnoreCase))
            {
                conversation.HasHistory = false;
                conversation.SessionId = Guid.NewGuid().ToString("D");
                if (conversation.Active is { } lost)
                {
                    conversation.Active = null;
                    if (!lost.Cancelled && !lost.Retried)
                    {
                        lost.Retried = true;
                        conversation.Pending ??= lost;
                    }
                }

                conversation.Launching = true;
                _ = Task.Run(() => Launch(conversation));
                return;
            }

            var why = Explain(stderr, code);
            if (conversation.Active is { } active)
            {
                DropActive(conversation);
                if (!active.Cancelled)
                {
                    Fail(conversation, active, why);
                }
            }

            // Mort avant d'avoir pu prendre le message en attente (demarrage rate) : pas de boucle de relance.
            if (conversation.Pending is { } pending)
            {
                conversation.Pending = null;
                Fail(conversation, pending, why);
            }
        }
    }

    /// <summary>Une ligne du flux de claude ; sous le verrou de la conversation.</summary>
    private void Feed(Conversation conversation, string line)
    {
        if (line.Length == 0 || line[0] != '{')
        {
            return;
        }

        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(line);
        }
        catch (JsonException)
        {
            return;
        }

        using (document)
        {
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
            {
                return;
            }

            if (root.TryGetProperty("parent_tool_use_id", out var parent) && parent.ValueKind == JsonValueKind.String)
            {
                return;
            }

            var turn = conversation.Active;
            switch (Text(root, "type"))
            {
                case "system":
                    if (Text(root, "subtype") == "init")
                    {
                        conversation.Initialized = true;
                        var id = Text(root, "session_id");
                        if (id.Length > 0)
                        {
                            conversation.SessionId = id;
                        }
                    }

                    return;

                case "stream_event":
                    if (!root.TryGetProperty("event", out var ev) || ev.ValueKind != JsonValueKind.Object || turn is null)
                    {
                        return;
                    }

                    switch (Text(ev, "type"))
                    {
                        case "message_start":
                            // La question est dans la session : une relance pourra la reprendre.
                            conversation.HasHistory = true;
                            break;

                        case "content_block_start":
                            if (ev.TryGetProperty("content_block", out var block) && Text(block, "type") is "tool_use" or "server_tool_use")
                            {
                                FlushText(conversation, turn);
                                if (!turn.Cancelled)
                                {
                                    Emit(conversation, turn, "tool", Text(block, "name") == "WebFetch" ? "Je lis la page…" : "Je cherche sur le web…");
                                }
                            }

                            break;

                        case "content_block_delta":
                            if (ev.TryGetProperty("delta", out var delta) && Text(delta, "type") == "text_delta")
                            {
                                // La ligne §META est retiree avant le decoupeur : jamais lue, jamais dans `full`.
                                Speak(conversation, turn, turn.Splitter.Push(turn.Meta.Push(Text(delta, "text"))));
                            }

                            break;

                        case "message_stop":
                            // Fin d'un message (avant un outil, ou fin de la reponse) : le reste part tout de suite,
                            // sans attendre le `result`, qui peut suivre de quelques secondes.
                            FlushText(conversation, turn);
                            if (turn.Meta.Found)
                            {
                                // La ligne §META clot la reponse : la fiche part sans attendre le `result`.
                                EmitMeta(conversation, turn);
                            }

                            break;
                    }

                    return;

                case "result":
                    conversation.HasHistory = true;
                    var sessionId = Text(root, "session_id");
                    if (sessionId.Length > 0)
                    {
                        conversation.SessionId = sessionId;
                    }

                    if (turn is null)
                    {
                        return;
                    }

                    DropActive(conversation);
                    if (!turn.Cancelled)
                    {
                        FlushText(conversation, turn);
                        var isError = root.TryGetProperty("is_error", out var flag) && flag.ValueKind == JsonValueKind.True;
                        if (isError || Text(root, "subtype") is { Length: > 0 } subtype && subtype != "success")
                        {
                            Fail(conversation, turn, Explain(Text(root, "result"), 0));
                        }
                        else
                        {
                            EmitMeta(conversation, turn);
                            Emit(conversation, turn, "done");
                        }
                    }

                    SendPending(conversation);
                    return;
            }
        }
    }

    /// <summary>Pousse les phrases d'un tour, sauf s'il a ete interrompu.</summary>
    private void Speak(Conversation conversation, Turn turn, IReadOnlyList<string> sentences)
    {
        foreach (var sentence in sentences)
        {
            if (turn.Cancelled)
            {
                return;
            }

            turn.Full.Append(turn.Full.Length > 0 ? " " : "").Append(sentence);
            Emit(conversation, turn, "sentence", sentence);
        }
    }

    /// <summary>Fin d'un message : le texte retenu par le filtre de §META, puis le reste du decoupeur.</summary>
    private void FlushText(Conversation conversation, Turn turn)
    {
        Speak(conversation, turn, turn.Splitter.Push(turn.Meta.Flush()));
        Speak(conversation, turn, turn.Splitter.Flush());
    }

    /// <summary>
    /// Phase <c>meta</c> du mode tutor, une fois par tour : la ligne §META lue et nettoyee
    /// (<see cref="TutorGenre.VoiceMetaOf"/>), le recast verifie sur la phrase de l'apprenant.
    /// Illisible ou absente : rien (journalise), le reste du tour suit son cours.
    /// </summary>
    private void EmitMeta(Conversation conversation, Turn turn)
    {
        if (turn.MetaDone || turn.Cancelled)
        {
            return;
        }

        turn.MetaDone = true;
        if (!conversation.Options.IsTutor)
        {
            if (turn.Meta.Found)
            {
                _log.Info($"Conversation vocale {conversation.Id} : ligne §META ignoree (mode libre).");
            }

            return;
        }

        var meta = turn.Meta.Found ? TutorGenre.VoiceMetaOf(turn.Meta.Meta, turn.Learner) : null;
        if (meta is null)
        {
            _log.Warn($"Conversation vocale {conversation.Id} : tour {turn.Number} sans ligne §META lisible ({(turn.Meta.Found ? Shorten(turn.Meta.Meta ?? "", 200) : "absente")}).");
            return;
        }

        Emit(conversation, turn, "meta", meta: meta);
    }

    private void DropActive(Conversation conversation)
    {
        if (conversation.Active is { } active)
        {
            active.Limit?.Dispose();
            active.Fallback?.Dispose();
            conversation.Active = null;
        }
    }

    private void Fail(Conversation conversation, Turn turn, string error)
        => Emit(conversation, turn, "error", "", error);

    private void FailAll(Conversation conversation, string error)
    {
        if (conversation.Active is { } active)
        {
            DropActive(conversation);
            if (!active.Cancelled)
            {
                Fail(conversation, active, error);
            }
        }

        if (conversation.Pending is { } pending)
        {
            conversation.Pending = null;
            Fail(conversation, pending, error);
        }
    }

    private void Emit(Conversation conversation, Turn turn, string phase, string text = "", string error = "", JsonObject? meta = null)
    {
        var payload = new JsonObject
        {
            ["conversationId"] = conversation.Id,
            ["turn"] = turn.Number,
            ["phase"] = phase,
            ["text"] = text,
            ["full"] = turn.Full.ToString(),
            ["error"] = error,
        };
        if (meta is not null)
        {
            payload["meta"] = meta;
        }

        try
        {
            Progress?.Invoke(payload);
        }
        catch (Exception ex)
        {
            _log.Warn("Avancement de la conversation vocale non transmis : " + ex.Message);
        }
    }

    private static void WriteLine(Conversation conversation, JsonObject message)
    {
        var input = conversation.Input ?? throw new IOException("processus absent");
        input.Write(message.ToJsonString(LineJson) + "\n");
        input.Flush();
    }

    private void Close(Conversation conversation)
    {
        lock (conversation)
        {
            conversation.Closed = true;
            conversation.Pending = null;
            DropActive(conversation);
            Kill(conversation);
        }
    }

    /// <summary>Tue le processus courant ; la generation change, ses lecteurs se taisent.</summary>
    private void Kill(Conversation conversation)
    {
        conversation.Generation++;
        var process = conversation.Process;
        conversation.Process = null;
        conversation.Input = null;
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
            _log.Warn("Conversation vocale : arret de claude impossible (" + ex.Message + ").");
        }
        finally
        {
            process.Dispose();
        }
    }

    private Conversation Find(string? conversationId)
        => TryFind(conversationId) ?? throw new InvalidOperationException("Cette conversation est terminée : rouvrez-la pour continuer.");

    private Conversation? TryFind(string? conversationId)
    {
        lock (_gate)
        {
            return conversationId is not null && _conversations.TryGetValue(conversationId, out var conversation) ? conversation : null;
        }
    }

    // ------------------------------------------------------------------ prompt systeme

    /// <summary>
    /// Prompt systeme de l'interlocuteur : la persona, les regles d'une conversation parlee, la date,
    /// la consigne du sujet et les consignes libres de l'utilisateur.
    /// </summary>
    public static string SystemPrompt(VoiceOptions options, DateTime now)
    {
        var persona = SanitizePersona(options.Persona);
        var topic = SanitizeTopic(options.Topic);
        var english = topic == "anglais";
        var date = now.ToString("dddd d MMMM yyyy", CultureInfo.GetCultureInfo("fr-FR"));

        var sb = new StringBuilder();
        sb.Append("Tu es ").Append(persona).Append(", un interlocuteur oral chaleureux, curieux et cultivé. ")
          .Append("Tu as une vraie conversation, à voix haute, avec la personne qui te parle : ce que tu écris est lu par une synthèse vocale, ")
          .Append("et ce qu'elle dit t'arrive par une transcription automatique de sa voix.\n\n");

        sb.Append("Comment tu parles :\n")
          .Append("- Réponds court : une à trois phrases le plus souvent, comme dans une vraie conversation. Développe seulement si on te le demande, et même alors, par petits morceaux.\n")
          .Append("- Des phrases simples et naturelles, faciles à suivre à l'oreille. Commence directement par l'essentiel, sans formule d'introduction.\n")
          .Append("- Jamais de liste, de titre, de tableau, de Markdown, d'emoji, de lien ni de code : uniquement des phrases qui se disent. Pour plusieurs éléments, enchaîne-les dans une phrase (« d'abord… ensuite… »).\n")
          .Append("- Écris les nombres, les unités, les sigles et les symboles comme ils se prononcent quand c'est utile (« vingt-cinq pour cent », « trois heures et quart », « la SNCF »).\n")
          .Append("- Relance naturellement : rebondis sur ce qui vient d'être dit, donne ton avis, et pose de temps en temps une question, une seule à la fois, sans finir systématiquement par une question.\n")
          .Append("- Tutoie ou vouvoie comme ton interlocuteur ; par défaut, tutoie avec simplicité.\n\n");

        sb.Append("Ce que tu reçois :\n")
          .Append("- Le texte est une transcription automatique (Whisper) : il peut contenir des mots mal reconnus, une ponctuation fantaisiste ou des phrases coupées. Devine le sens le plus probable sans le faire remarquer. ")
          .Append("Si c'est vraiment incompréhensible, demande simplement de répéter.\n")
          .Append("- Une transcription de quelques mots sans rapport (« Merci. », « Sous-titres… ») peut venir d'un bruit : réponds brièvement ou demande si on te parlait.\n")
          .Append("- On peut te couper la parole. Quand un message commence par une note entre parenthèses qui le signale, adapte-toi sans t'excuser longuement : ne répète pas ce qui a déjà été entendu et réponds à ce qui vient d'être dit.\n\n");

        if (options.Web)
        {
            sb.Append("Tu peux chercher sur le web. Fais-le quand la question porte sur l'actualité, un fait précis ou récent, ou quelque chose que tu ne sais pas sûrement. ")
              .Append("Juste avant de chercher, dis une phrase très courte pour faire patienter (« Je regarde ça. »), puis donne la réponse en une ou deux phrases, sans lire d'adresse ni citer de liste de sources.\n\n");
        }
        else
        {
            sb.Append("Tu n'as pas accès au web : pour l'actualité récente, dis simplement que tes connaissances peuvent dater.\n\n");
        }

        sb.Append("Nous sommes le ").Append(date).Append(".\n\n");

        sb.Append("Sujet de la conversation. ").Append(Topics[topic]).Append('\n');
        if (!english)
        {
            sb.Append("Parle français, sauf si ton interlocuteur te demande une autre langue.\n");
        }
        else
        {
            sb.Append("The user may be a French speaker practising English: keep your English clear and at a moderate level, and never write phonetic transcriptions.\n");
        }

        var instructions = (options.Instructions ?? "").Trim();
        if (instructions.Length > 0)
        {
            sb.Append("\nConsignes de ton interlocuteur, à suivre en priorité tant qu'elles restent compatibles avec une conversation parlée :\n")
              .Append(instructions).Append('\n');
        }

        return sb.ToString();
    }

    // ------------------------------------------------------------------ outils

    private static string Describe(VoiceOptions options)
        => string.Join(", ", new[]
        {
            options.Model.Length > 0 ? "modele " + options.Model : "modele par defaut",
            options.Effort.Length > 0 ? "effort " + options.Effort : "",
            options.IsTutor ? "tuteur" : "sujet " + SanitizeTopic(options.Topic),
            options.Web ? "web" : "sans web",
        }.Where(s => s.Length > 0));

    /// <summary>Erreur lisible a partir de la sortie de claude.</summary>
    private static string Explain(string error, int code)
    {
        var text = (error ?? "").Trim();
        if (text.Contains("Not logged in", StringComparison.OrdinalIgnoreCase) || text.Contains("/login", StringComparison.OrdinalIgnoreCase)
            || text.Contains("Invalid API key", StringComparison.OrdinalIgnoreCase))
        {
            return "Claude Code n'est pas connecté : ouvrez un terminal, lancez claude et connectez-vous.";
        }

        if (text.Contains("usage limit", StringComparison.OrdinalIgnoreCase) || text.Contains("rate limit", StringComparison.OrdinalIgnoreCase)
            || text.Contains("limit reached", StringComparison.OrdinalIgnoreCase))
        {
            return "La limite d'utilisation de Claude est atteinte : réessayez plus tard.";
        }

        if (text.Contains("overloaded", StringComparison.OrdinalIgnoreCase))
        {
            return "Claude est surchargé pour le moment : réessayez dans un instant.";
        }

        if (text.Contains("model", StringComparison.OrdinalIgnoreCase) && text.Contains("not", StringComparison.OrdinalIgnoreCase)
            && (text.Contains("found", StringComparison.OrdinalIgnoreCase) || text.Contains("available", StringComparison.OrdinalIgnoreCase)))
        {
            return "Ce modèle de Claude n'est pas disponible : choisissez-en un autre dans les réglages de la conversation.";
        }

        var first = Shorten(text, 240);
        return first.Length == 0
            ? $"Claude n'a pas pu répondre (code {code})."
            : "Claude n'a pas pu répondre : " + first;
    }

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

    private static string Text(JsonElement element, string name)
        => element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString() ?? ""
            : "";

    private static string Clip(string? value, int max)
    {
        var text = (value ?? "").Trim();
        return text.Length <= max ? text : text[..max].TrimEnd() + "…";
    }

    /// <summary>Une conversation : son processus, le tour en cours et celui qui attend. Verrou : l'objet lui-meme.</summary>
    private sealed class Conversation
    {
        public Conversation(string id, VoiceOptions options, string systemPrompt)
        {
            Id = id;
            Options = options;
            SystemPrompt = systemPrompt;
            SessionId = Guid.NewGuid().ToString("D");
        }

        public string Id { get; }
        public VoiceOptions Options { get; }
        public string SystemPrompt { get; }
        public string SessionId { get; set; }

        /// <summary>La session existe sur le disque : une relance la reprend (<c>--resume</c>).</summary>
        public bool HasHistory { get; set; }

        public Process? Process { get; set; }
        public StreamWriter? Input { get; set; }
        public StringBuilder Stderr { get; set; } = new();
        public bool Initialized { get; set; }
        public bool Launching { get; set; } = true;
        public bool Closed { get; set; }

        /// <summary>Change a chaque lancement ou arret : les lecteurs d'un ancien processus se taisent.</summary>
        public int Generation { get; set; }

        public int LastTurn { get; set; }

        /// <summary>Message ecrit a claude, dont on attend le <c>result</c>.</summary>
        public Turn? Active { get; set; }

        /// <summary>Message pret, qui part des que le processus est pret et libre.</summary>
        public Turn? Pending { get; set; }

        /// <summary>Ce que l'utilisateur a entendu d'une reponse coupee ; null sans interruption.</summary>
        public string? Heard { get; set; }

        /// <summary>Texte d'un message annule avant d'etre parti, joint au suivant.</summary>
        public string? Carry { get; set; }

        /// <summary>Ce que l'apprenant avait dit dans ce message annule (sans les notes) : pour verifier le recast.</summary>
        public string? CarryLearner { get; set; }

        /// <summary>Mode tutor : contexte et conversation deja tenue, devant le premier message ; null une fois parti.</summary>
        public string? Preamble { get; set; }
    }

    private sealed class Turn
    {
        public Turn(int number, string message, string learner)
        {
            Number = number;
            Message = message;
            Learner = learner;
        }

        public int Number { get; }
        public string Message { get; }

        /// <summary>Les mots de l'utilisateur seuls (sans note ni preambule) : le recast doit en etre un extrait.</summary>
        public string Learner { get; }

        /// <summary>Retire la ligne §META du flux avant le decoupeur.</summary>
        public VoiceMetaFilter Meta { get; } = new();

        public bool MetaDone { get; set; }
        public bool Cancelled { get; set; }
        public bool Retried { get; set; }
        public VoiceSentences Splitter { get; } = new();
        public StringBuilder Full { get; } = new();
        public Timer? Limit { get; set; }
        public Timer? Fallback { get; set; }
    }
}
