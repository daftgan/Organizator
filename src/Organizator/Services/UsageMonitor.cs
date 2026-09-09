using System.Net.Http;
using System.Text.Json.Nodes;

namespace Organizator.Services;

/// <summary>
/// Lit les quotas des deux agents a la demande de l'UI, les deux en parallele, et garde la
/// derniere lecture : une demande sans <c>force</c> dans les deux minutes rend le cache. Une
/// lecture qui echoue pour cause de reseau garde les jauges precedentes, marquees perimees.
/// </summary>
public sealed class UsageMonitor : IDisposable
{
    private static readonly TimeSpan MaxAge = TimeSpan.FromMinutes(2);
    private static readonly TimeSpan RequestTimeout = TimeSpan.FromSeconds(12);

    private readonly HostLog _log;
    private readonly HttpClient _http;
    private readonly ClaudeUsageReader _claude = new();
    private readonly CopilotUsageReader _copilot = new();
    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly Dictionary<string, string?> _lastMessages = new(StringComparer.Ordinal);
    private UsageReport? _claudeReport;
    private UsageReport? _copilotReport;
    private long _fetchedAt;

    public UsageMonitor(HostLog log, string version)
    {
        _log = log;
        _http = new HttpClient { Timeout = RequestTimeout };
        _http.DefaultRequestHeaders.UserAgent.ParseAdd("Organizator/" + version);
    }

    /// <summary><c>{ fetchedAt, claude: rapport, copilot: rapport }</c>, voir <see cref="UsageReport.ToJson"/>.</summary>
    public async Task<JsonObject> GetAsync(bool force, CancellationToken ct)
    {
        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            var fresh = _fetchedAt > 0 && UsageReport.Now() - _fetchedAt < MaxAge.TotalMilliseconds;
            if (force || !fresh || _claudeReport is null || _copilotReport is null)
            {
                var claudeTask = ReadAsync(AgentProvider.Claude, () => _claude.FetchAsync(_http, ct), _claudeReport);
                var copilotTask = ReadAsync(AgentProvider.Copilot, () => _copilot.FetchAsync(_http, ct), _copilotReport);
                await Task.WhenAll(claudeTask, copilotTask).ConfigureAwait(false);
                _claudeReport = claudeTask.Result;
                _copilotReport = copilotTask.Result;
                _fetchedAt = UsageReport.Now();
            }

            return new JsonObject
            {
                ["fetchedAt"] = _fetchedAt,
                ["claude"] = _claudeReport!.ToJson(),
                ["copilot"] = _copilotReport!.ToJson(),
            };
        }
        finally
        {
            _gate.Release();
        }
    }

    private async Task<UsageReport> ReadAsync(string provider, Func<Task<UsageReport>> fetch, UsageReport? previous)
    {
        UsageReport report;
        try
        {
            report = await fetch().ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            report = UsageReport.Fail(provider, UsageStatus.Error, "delai depasse");
        }
        catch (HttpRequestException ex)
        {
            report = UsageReport.Fail(provider, UsageStatus.Error, "reseau : " + ex.Message);
        }
        catch (Exception ex)
        {
            report = UsageReport.Fail(provider, UsageStatus.Error, ex.Message);
        }

        LogChange(provider, report);

        // Panne passagere : on garde les jauges connues plutot que d'afficher un trou.
        if (report.Status == UsageStatus.Error && previous is { Status: UsageStatus.Ok })
        {
            return previous with { Stale = true, Message = report.Message };
        }

        return report;
    }

    /// <summary>Journalise un echec la premiere fois, puis seulement s'il change : pas une ligne par minute.</summary>
    private void LogChange(string provider, UsageReport report)
    {
        var key = report.Status == UsageStatus.Ok ? null : report.Status + " : " + report.Message;
        lock (_lastMessages)
        {
            _lastMessages.TryGetValue(provider, out var last);
            if (string.Equals(last, key, StringComparison.Ordinal))
            {
                return;
            }

            _lastMessages[provider] = key;
        }

        if (key is null)
        {
            _log.Info("Quota " + provider + " : lecture OK");
        }
        else
        {
            _log.Warn("Quota " + provider + " : " + key);
        }
    }

    public void Dispose()
    {
        _http.Dispose();
        _gate.Dispose();
    }
}
