using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json.Nodes;
using System.Threading.Channels;
using Organizator.Services;

namespace Revizator.Server;

/// <summary>
/// Connexions WebSocket du pont (§ 4) : une file d'envoi par connexion (les evenements ne bloquent jamais
/// l'emetteur), <c>{ event: 'ping' }</c> toutes les 20 s, messages de 32 Mo au plus.
/// </summary>
public sealed class WsHub
{
    public const int MaxMessageBytes = 32 * 1024 * 1024;
    private static readonly TimeSpan PingEvery = TimeSpan.FromSeconds(20);

    private readonly ServerBridge _bridge;
    private readonly HostLog _log;
    private readonly ConcurrentDictionary<Connection, byte> _connections = new();
    private readonly Timer _ping;

    public WsHub(ServerBridge bridge, HostLog log)
    {
        _bridge = bridge;
        _log = log;
        _bridge.Broadcast = (message, except) => Send(message, except as Connection);
        _ping = new Timer(_ => Send(new JsonObject { ["event"] = "ping" }, null), null, PingEvery, PingEvery);
    }

    public int Count => _connections.Count;

    private sealed class Connection
    {
        public required WebSocket Socket { get; init; }
        public required string Device { get; init; }
        public Channel<string> Outbox { get; } = Channel.CreateUnbounded<string>(new UnboundedChannelOptions { SingleReader = true });
    }

    private void Send(JsonObject message, Connection? except)
    {
        var text = message.ToJsonString();
        foreach (var connection in _connections.Keys)
        {
            if (!ReferenceEquals(connection, except))
            {
                connection.Outbox.Writer.TryWrite(text);
            }
        }
    }

    /// <summary>Sert une connexion jusqu'a sa fermeture.</summary>
    public async Task RunAsync(WebSocket socket, string device, CancellationToken stopping)
    {
        var connection = new Connection { Socket = socket, Device = device };
        _connections[connection] = 0;
        _log.Info($"WebSocket ouvert ({device}, {_connections.Count} connexion(s))");
        using var closing = CancellationTokenSource.CreateLinkedTokenSource(stopping);
        var writer = WriteLoopAsync(connection, closing.Token);
        try
        {
            await ReadLoopAsync(connection, closing.Token).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is WebSocketException or OperationCanceledException or IOException)
        {
            // Coupure du reseau ou arret du serveur : rien a signaler de plus.
        }
        finally
        {
            _connections.TryRemove(connection, out _);
            connection.Outbox.Writer.TryComplete();
            closing.Cancel();
            try
            {
                await writer.ConfigureAwait(false);
            }
            catch (Exception)
            {
                // ecriture interrompue par la fermeture
            }

            _log.Info($"WebSocket ferme ({device}, {_connections.Count} connexion(s))");
        }
    }

    private async Task ReadLoopAsync(Connection connection, CancellationToken ct)
    {
        var socket = connection.Socket;
        var buffer = new byte[64 * 1024];
        using var message = new MemoryStream();
        while (socket.State == WebSocketState.Open)
        {
            var result = await socket.ReceiveAsync(buffer, ct).ConfigureAwait(false);
            if (result.MessageType == WebSocketMessageType.Close)
            {
                await CloseAsync(socket, WebSocketCloseStatus.NormalClosure, "").ConfigureAwait(false);
                return;
            }

            if (message.Length + result.Count > MaxMessageBytes)
            {
                _log.Warn($"WebSocket : message de plus de {MaxMessageBytes / (1024 * 1024)} Mo, connexion fermee ({connection.Device})");
                await CloseAsync(socket, WebSocketCloseStatus.MessageTooBig, "Message trop gros (32 Mo au plus).").ConfigureAwait(false);
                return;
            }

            message.Write(buffer, 0, result.Count);
            if (!result.EndOfMessage)
            {
                continue;
            }

            var binary = result.MessageType == WebSocketMessageType.Binary;
            var text = binary ? "" : Encoding.UTF8.GetString(message.GetBuffer(), 0, (int)message.Length);
            message.SetLength(0);
            if (binary)
            {
                continue;
            }

            // Appel sans attendre la reponse : la partie synchrone du gestionnaire passe dans l'ordre de
            // reception (asrFeed), le reste avance en parallele, comme sous WebView2.
            var pending = _bridge.HandleAsync(text, connection);
            _ = pending.ContinueWith(task =>
            {
                if (task.Status == TaskStatus.RanToCompletion && task.Result is JsonObject reply)
                {
                    connection.Outbox.Writer.TryWrite(reply.ToJsonString());
                }
            }, TaskScheduler.Default);
        }
    }

    private static async Task WriteLoopAsync(Connection connection, CancellationToken ct)
    {
        await foreach (var text in connection.Outbox.Reader.ReadAllAsync(ct).ConfigureAwait(false))
        {
            if (connection.Socket.State != WebSocketState.Open)
            {
                return;
            }

            await connection.Socket.SendAsync(Encoding.UTF8.GetBytes(text), WebSocketMessageType.Text, true, ct).ConfigureAwait(false);
        }
    }

    private static async Task CloseAsync(WebSocket socket, WebSocketCloseStatus status, string reason)
    {
        try
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            await socket.CloseOutputAsync(status, reason, timeout.Token).ConfigureAwait(false);
        }
        catch (Exception)
        {
            // pair deja parti
        }
    }
}
