using System.IO;
using NAudio.Wave;
using NAudio.Wave.SampleProviders;

namespace Organizator.Services;

/// <summary>
/// Ramene un enregistrement a ce que Whisper attend : 16 kHz, mono, echantillons flottants.
/// Les fichiers passent par Media Foundation (<see cref="MediaFoundationReader"/>) : mp3, m4a/aac,
/// wav, wma, et ogg/opus/flac/webm quand les extensions multimedias de Windows sont la (elles le
/// sont par defaut sous Windows 11). Le son d'une video (mp4, mov...) est lu de la meme facon.
/// La dictee arrive deja au bon format, en WAV, depuis la page.
/// </summary>
public static class AudioDecoder
{
    public const int SampleRate = 16000;

    /// <summary>Au-dela, la memoire (4 octets par echantillon) et la duree deviennent deraisonnables.</summary>
    public static readonly TimeSpan MaxDuration = TimeSpan.FromHours(3);

    /// <summary>Extensions proposees a la transcription ; la page tient la meme liste (AUDIO_EXT).</summary>
    public static readonly HashSet<string> Extensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".mp3", ".wav", ".m4a", ".aac", ".wma", ".ogg", ".oga", ".opus", ".flac", ".webm",
        ".mp4", ".m4v", ".mov", ".3gp", ".amr", ".mkv",
    };

    /// <summary>Decode un fichier ; message lisible si Windows ne sait pas le lire.</summary>
    public static float[] FromFile(string path, CancellationToken ct)
    {
        WaveStream reader;
        try
        {
            reader = new MediaFoundationReader(path);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            throw new InvalidOperationException(
                $"Windows ne sait pas lire « {Path.GetFileName(path)} » ({ex.Message.Trim()}). Convertissez-le en .mp3 ou .wav.");
        }

        using (reader)
        {
            return Read(reader, ct);
        }
    }

    /// <summary>WAV transmis par la page (dictee) : PCM 16 bits, en principe deja a 16 kHz mono.</summary>
    public static float[] FromWav(byte[] bytes, CancellationToken ct)
    {
        try
        {
            using var reader = new WaveFileReader(new MemoryStream(bytes, writable: false));
            return Read(reader, ct);
        }
        catch (Exception ex) when (ex is FormatException or InvalidDataException or EndOfStreamException)
        {
            throw new InvalidOperationException("Enregistrement illisible : " + ex.Message);
        }
    }

    private static float[] Read(WaveStream stream, CancellationToken ct)
    {
        if (stream.TotalTime > MaxDuration)
        {
            throw new InvalidOperationException(
                $"Enregistrement trop long ({stream.TotalTime:h\\:mm\\:ss}) : {MaxDuration.TotalHours:0} h au plus.");
        }

        ISampleProvider samples = stream.ToSampleProvider();
        if (samples.WaveFormat.Channels > 1)
        {
            samples = new DownMix(samples);
        }

        if (samples.WaveFormat.SampleRate != SampleRate)
        {
            samples = new WdlResamplingSampleProvider(samples, SampleRate);
        }

        var estimate = stream.TotalTime > TimeSpan.Zero ? (int)Math.Min(int.MaxValue / 2, stream.TotalTime.TotalSeconds * SampleRate) + SampleRate : 1 << 20;
        var output = new List<float>(estimate);
        var buffer = new float[SampleRate];
        var limit = (long)(MaxDuration.TotalSeconds * SampleRate);
        int read;
        while ((read = samples.Read(buffer, 0, buffer.Length)) > 0)
        {
            ct.ThrowIfCancellationRequested();
            output.AddRange(new ReadOnlySpan<float>(buffer, 0, read));
            if (output.Count > limit)
            {
                throw new InvalidOperationException($"Enregistrement trop long : {MaxDuration.TotalHours:0} h au plus.");
            }
        }

        return output.ToArray();
    }

    /// <summary>Moyenne des canaux : un enregistrement stereo, ou le 5.1 d'une video, devient mono.</summary>
    private sealed class DownMix : ISampleProvider
    {
        private readonly ISampleProvider _source;
        private readonly int _channels;
        private float[] _buffer = [];

        public DownMix(ISampleProvider source)
        {
            _source = source;
            _channels = source.WaveFormat.Channels;
            WaveFormat = WaveFormat.CreateIeeeFloatWaveFormat(source.WaveFormat.SampleRate, 1);
        }

        public WaveFormat WaveFormat { get; }

        public int Read(float[] buffer, int offset, int count)
        {
            var needed = count * _channels;
            if (_buffer.Length < needed)
            {
                _buffer = new float[needed];
            }

            var read = _source.Read(_buffer, 0, needed);
            var frames = read / _channels;
            for (var i = 0; i < frames; i++)
            {
                var sum = 0f;
                for (var c = 0; c < _channels; c++)
                {
                    sum += _buffer[i * _channels + c];
                }

                buffer[offset + i] = sum / _channels;
            }

            return frames;
        }
    }
}
