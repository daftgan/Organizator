using System.Collections.Concurrent;
using System.Globalization;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text.Json.Nodes;

namespace Organizator.Services;

/// <summary>Une voix de synthese : <c>id</c> du jeton SAPI (stable), nom, langue (fr-FR), genre (female, male ou vide).</summary>
public sealed record SpeechVoiceInfo(string Id, string Name, string Lang, string Gender, bool OneCore);

/// <summary>
/// Synthese vocale en WAV, cote hote, pour la conversation vocale : la page joue le son par WebAudio,
/// ce qui le soumet a l'annulation d'echo de Chromium (l'avatar ne s'entend pas lui-meme).
///
/// SAPI 5 par COM, en liaison tardive (<see cref="Type.GetTypeFromProgID(string)"/> et
/// <see cref="Type.InvokeMember(string, BindingFlags, Binder, object, object[])"/>) : aucun paquet ni
/// framework cible windows10.0.x (voir l'en-tete de <see cref="WindowsToasts"/>). Les voix « OneCore »
/// de Windows 10/11 (Julie, Paul, Hortense, et les voix « Natural » qu'un adaptateur y declare) ne sont
/// pas listees par SAPI, mais leurs jetons, lus dans <c>Speech_OneCore\Voices</c> par une
/// <c>SpObjectTokenCategory</c>, sont acceptes par <c>SpVoice</c>.
///
/// SAPI est a thread unique (STA) : tout passe par un fil STA dedie, qui traite une file de travaux,
/// jamais par le fil de l'interface. La liste des voix est lue une fois et gardee.
/// </summary>
public sealed class SpeechVoice : IDisposable
{
    private const string OneCoreVoices = @"HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Speech_OneCore\Voices";

    // SpeechAudioFormatType : SAFT24kHz16BitMono, la frequence native des voix OneCore (pas de reechantillonnage).
    private const int AudioFormat = 26;
    private const int SampleRate = 24_000;

    // SpeechVoiceSpeakFlags : SVSFIsNotXML, le texte est dit tel quel (un « < » ne passe pas pour une balise).
    private const int SpeakFlags = 16;

    private const int MaxText = 3000;

    private readonly HostLog _log;
    private readonly BlockingCollection<Action> _work = new();
    private readonly Thread _thread;

    // Tout ce qui suit n'est touche que depuis le fil STA.
    private object? _voice;
    private List<(SpeechVoiceInfo Info, object Token)>? _voices;
    private string _current = "";
    private int _rate = int.MinValue;

    public SpeechVoice(HostLog log)
    {
        _log = log;
        _thread = new Thread(Loop) { IsBackground = true, Name = "Organizator SAPI" };
        if (OperatingSystem.IsWindows())
        {
            _thread.SetApartmentState(ApartmentState.STA);
        }

        _thread.Start();
    }

    /// <summary>Voix installees (SAPI et OneCore, sans doublon de nom) et voix par defaut.</summary>
    public Task<(IReadOnlyList<SpeechVoiceInfo> Voices, string Default)> VoicesAsync()
        => RunAsync(() =>
        {
            var voices = LoadVoices().Select(v => v.Info).ToList();
            return ((IReadOnlyList<SpeechVoiceInfo>)voices, DefaultVoice(voices));
        });

    /// <summary>Voix au format attendu par la page : <c>{ voices: [{ id, name, lang, gender }], default }</c>.</summary>
    public async Task<JsonObject> VoicesJsonAsync()
    {
        var (voices, fallback) = await VoicesAsync().ConfigureAwait(false);
        var list = new JsonArray();
        foreach (var voice in voices)
        {
            list.Add(new JsonObject
            {
                ["id"] = voice.Id,
                ["name"] = voice.Name,
                ["lang"] = voice.Lang,
                ["gender"] = voice.Gender,
            });
        }

        return new JsonObject { ["voices"] = list, ["default"] = fallback };
    }

    /// <summary>
    /// Dit <paramref name="text"/> avec la voix <paramref name="voiceId"/> (vide ou inconnue : la voix par
    /// defaut) au debit <paramref name="rate"/> (−10..10). Rend un WAV PCM 16 bits mono et sa duree.
    /// </summary>
    public async Task<(byte[] Wav, int Ms)> SpeakAsync(string? text, string? voiceId, int rate)
    {
        var say = (text ?? "").Trim();
        if (say.Length > MaxText)
        {
            say = say[..MaxText];
        }

        if (say.Length == 0)
        {
            return (Wav(Array.Empty<byte>()), 0);
        }

        var pcm = await RunAsync(() => Synthesize(say, voiceId ?? "", Math.Clamp(rate, -10, 10))).ConfigureAwait(false);
        var ms = (int)(pcm.Length * 1000L / (SampleRate * 2));
        return (Wav(pcm), ms);
    }

    /// <summary>Comme <see cref="SpeakAsync"/>, au format de la page : <c>{ audio: WAV en base64, ms }</c>.</summary>
    public async Task<JsonObject> SpeakJsonAsync(string? text, string? voiceId, int rate)
    {
        var (wav, ms) = await SpeakAsync(text, voiceId, rate).ConfigureAwait(false);
        // Hors du fil de l'interface : quelques centaines de Ko a encoder.
        return new JsonObject { ["audio"] = Convert.ToBase64String(wav), ["ms"] = ms };
    }

    public void Dispose()
    {
        _work.CompleteAdding();
    }

    // ------------------------------------------------------------------ fil STA

    private void Loop()
    {
        foreach (var work in _work.GetConsumingEnumerable())
        {
            work();
        }

        // Fin : on relache les objets COM sur leur propre fil.
        try
        {
            if (_voices is not null)
            {
                foreach (var (_, token) in _voices)
                {
                    Release(token);
                }
            }

            Release(_voice);
        }
        catch (Exception)
        {
            // Fermeture de l'application : rien a sauver.
        }
    }

    private Task<T> RunAsync<T>(Func<T> work)
    {
        var done = new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);
        try
        {
            _work.Add(() =>
            {
                try
                {
                    done.SetResult(work());
                }
                catch (Exception ex)
                {
                    done.SetException(Readable(ex));
                }
            });
        }
        catch (InvalidOperationException)
        {
            done.SetException(new InvalidOperationException("La synthèse vocale est arrêtée."));
        }

        return done.Task;
    }

    private object Voice()
    {
        if (_voice is not null)
        {
            return _voice;
        }

        var type = OperatingSystem.IsWindows() ? Type.GetTypeFromProgID("SAPI.SpVoice") : null;
        if (type is null)
        {
            throw new InvalidOperationException("La synthèse vocale de Windows (SAPI) est introuvable sur ce poste.");
        }

        _voice = Activator.CreateInstance(type) ?? throw new InvalidOperationException("La synthèse vocale de Windows n'a pas pu démarrer.");
        return _voice;
    }

    private byte[] Synthesize(string text, string voiceId, int rate)
    {
        var voice = Voice();
        var voices = LoadVoices();
        var wanted = voiceId.Length > 0 ? voices.FirstOrDefault(v => string.Equals(v.Info.Id, voiceId, StringComparison.OrdinalIgnoreCase)) : default;
        if (wanted.Token is null)
        {
            if (voiceId.Length > 0)
            {
                _log.Warn("Voix de synthese introuvable, voix par defaut : " + voiceId);
            }

            var fallback = DefaultVoice(voices.Select(v => v.Info).ToList());
            wanted = voices.FirstOrDefault(v => v.Info.Id == fallback);
        }

        if (wanted.Token is not null && !string.Equals(_current, wanted.Info.Id, StringComparison.Ordinal))
        {
            Set(voice, "Voice", wanted.Token);
            _current = wanted.Info.Id;
        }

        if (rate != _rate)
        {
            Set(voice, "Rate", rate);
            _rate = rate;
        }

        var stream = Create("SAPI.SpMemoryStream");
        var format = Create("SAPI.SpAudioFormat");
        try
        {
            Set(format, "Type", AudioFormat);
            Set(stream, "Format", format);
            Set(voice, "AudioOutputStream", stream);
            Call(voice, "Speak", text, SpeakFlags);
            return Call(stream, "GetData") as byte[] ?? Array.Empty<byte>();
        }
        finally
        {
            try
            {
                // Rend la sortie par defaut : le flux memoire peut etre relache.
                Set(voice, "AudioOutputStream", null);
            }
            catch (Exception)
            {
                // Sans importance : le prochain appel pose son propre flux.
            }

            Release(stream);
            Release(format);
        }
    }

    /// <summary>Voix OneCore d'abord (meilleure qualite), puis SAPI ; un nom deja vu est ecarte.</summary>
    private List<(SpeechVoiceInfo Info, object Token)> LoadVoices()
    {
        if (_voices is not null)
        {
            return _voices;
        }

        var voice = Voice();
        var voices = new List<(SpeechVoiceInfo, object)>();
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        try
        {
            var category = Create("SAPI.SpObjectTokenCategory");
            Call(category, "SetId", OneCoreVoices, false);
            Collect(Call(category, "EnumerateTokens", "", ""), oneCore: true, voices, names);
        }
        catch (Exception ex)
        {
            _log.Info("Voix OneCore indisponibles : " + ex.Message);
        }

        try
        {
            Collect(Call(voice, "GetVoices", "", ""), oneCore: false, voices, names);
        }
        catch (Exception ex)
        {
            _log.Warn("Liste des voix SAPI illisible : " + ex.Message);
        }

        _voices = voices;
        _log.Info($"Synthese vocale : {voices.Count} voix ({string.Join(", ", voices.Select(v => v.Item1.Name + " " + v.Item1.Lang))}).");
        return voices;
    }

    private void Collect(object? tokens, bool oneCore, List<(SpeechVoiceInfo, object)> voices, HashSet<string> names)
    {
        if (tokens is null)
        {
            return;
        }

        var count = Convert.ToInt32(Get(tokens, "Count"), CultureInfo.InvariantCulture);
        for (var i = 0; i < count; i++)
        {
            try
            {
                var token = Call(tokens, "Item", i);
                if (token is null)
                {
                    continue;
                }

                var id = Get(token, "Id") as string ?? "";
                var name = Attribute(token, "Name");
                if (name.Length == 0)
                {
                    name = Call(token, "GetDescription", 0) as string ?? id;
                }

                if (id.Length == 0 || !names.Add(name))
                {
                    Release(token);
                    continue;
                }

                var gender = Attribute(token, "Gender").ToLowerInvariant();
                voices.Add((new SpeechVoiceInfo(id, name, Language(Attribute(token, "Language")),
                    gender is "female" or "male" ? gender : "", oneCore), token));
            }
            catch (Exception ex)
            {
                _log.Warn("Voix de synthese illisible : " + ex.Message);
            }
        }
    }

    /// <summary>Premiere voix francaise de France : OneCore, « Natural » de preference ; sinon toute voix francaise, sinon la premiere.</summary>
    public static string DefaultVoice(IReadOnlyList<SpeechVoiceInfo> voices)
    {
        static bool French(SpeechVoiceInfo v) => v.Lang.StartsWith("fr", StringComparison.OrdinalIgnoreCase);
        static bool France(SpeechVoiceInfo v) => string.Equals(v.Lang, "fr-FR", StringComparison.OrdinalIgnoreCase);
        static bool Natural(SpeechVoiceInfo v) => v.Name.Contains("Natural", StringComparison.OrdinalIgnoreCase);

        var best = voices.FirstOrDefault(v => France(v) && Natural(v))
            ?? voices.FirstOrDefault(v => France(v) && v.OneCore)
            ?? voices.FirstOrDefault(France)
            ?? voices.FirstOrDefault(v => French(v) && Natural(v))
            ?? voices.FirstOrDefault(French)
            ?? voices.FirstOrDefault();
        return best?.Id ?? "";
    }

    /// <summary>Attribut <c>Language</c> d'un jeton : LCID en hexadecimal (« 40C », parfois « 40C;C0C ») vers « fr-FR ».</summary>
    public static string Language(string attribute)
    {
        var first = (attribute ?? "").Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).FirstOrDefault() ?? "";
        if (!int.TryParse(first, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var lcid) || lcid <= 0)
        {
            return "";
        }

        try
        {
            return CultureInfo.GetCultureInfo(lcid).Name;
        }
        catch (CultureNotFoundException)
        {
            return "";
        }
    }

    private static string Attribute(object token, string name)
    {
        try
        {
            return Call(token, "GetAttribute", name) as string ?? "";
        }
        catch (Exception)
        {
            return "";
        }
    }

    /// <summary>Un WAV PCM 16 bits mono, en-tete de 44 octets.</summary>
    public static byte[] Wav(byte[] pcm)
    {
        using var output = new MemoryStream(44 + pcm.Length);
        using (var writer = new BinaryWriter(output, System.Text.Encoding.ASCII, leaveOpen: true))
        {
            writer.Write("RIFF"u8);
            writer.Write(36 + pcm.Length);
            writer.Write("WAVE"u8);
            writer.Write("fmt "u8);
            writer.Write(16);
            writer.Write((short)1);              // PCM
            writer.Write((short)1);              // mono
            writer.Write(SampleRate);
            writer.Write(SampleRate * 2);        // octets par seconde
            writer.Write((short)2);              // octets par echantillon
            writer.Write((short)16);             // bits par echantillon
            writer.Write("data"u8);
            writer.Write(pcm.Length);
            writer.Write(pcm);
        }

        return output.ToArray();
    }

    // ------------------------------------------------------------------ COM

    private static object Create(string progId)
    {
        var type = Type.GetTypeFromProgID(progId) ?? throw new InvalidOperationException("Composant de synthèse vocale absent : " + progId);
        return Activator.CreateInstance(type) ?? throw new InvalidOperationException("Composant de synthèse vocale inutilisable : " + progId);
    }

    private static object? Get(object target, string name)
        => target.GetType().InvokeMember(name, BindingFlags.GetProperty, null, target, null, CultureInfo.InvariantCulture);

    private static void Set(object target, string name, object? value)
    {
        // Les proprietes qui prennent un objet (Voice, AudioOutputStream, Format) se posent par « putref ».
        var flags = value is null || value.GetType().IsPrimitive || value is string ? BindingFlags.SetProperty : BindingFlags.PutRefDispProperty;
        target.GetType().InvokeMember(name, flags, null, target, new[] { value }, CultureInfo.InvariantCulture);
    }

    private static object? Call(object target, string name, params object?[] args)
        => target.GetType().InvokeMember(name, BindingFlags.InvokeMethod, null, target, args, CultureInfo.InvariantCulture);

    private static void Release(object? com)
    {
        if (com is not null && OperatingSystem.IsWindows() && Marshal.IsComObject(com))
        {
            Marshal.ReleaseComObject(com);
        }
    }

    private static Exception Readable(Exception ex)
    {
        var inner = ex is TargetInvocationException { InnerException: { } cause } ? cause : ex;
        return inner switch
        {
            InvalidOperationException => inner,
            COMException com => new InvalidOperationException($"La synthèse vocale a échoué (0x{com.HResult:X8}) : {com.Message}"),
            _ => new InvalidOperationException("La synthèse vocale a échoué : " + inner.Message),
        };
    }
}
