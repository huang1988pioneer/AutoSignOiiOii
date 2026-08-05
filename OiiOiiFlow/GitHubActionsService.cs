using System.Diagnostics;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace OiiOiiFlow;

internal sealed class GitHubActionsService
{
    public const string Repository = "huang1988pioneer/AutoSignOiiOii";
    private const string Workflow = "claim-oiioii-lunch.yml";
    private static readonly Regex ClaimJobName = new(@"^claim \((?<number>\d+)\) - (?<name>.+)$", RegexOptions.Compiled);

    public async Task TriggerClaimAsync(string browser = "chromium")
    {
        var engine = browser is "firefox" or "edge" or "chromium" ? browser : "chromium";
        await RunGhAsync(
            "workflow", "run", Workflow,
            "--repo", Repository,
            "--ref", "main",
            "-f", $"browser={engine}");
    }

    public async Task<DashboardSnapshot> GetSnapshotAsync(decimal pointsPerClaim)
    {
        var runsJson = await RunGhAsync(
            "run", "list", "--workflow", Workflow, "--repo", Repository, "--limit", "100",
            "--json", "databaseId,createdAt,conclusion,status,url,event");
        var runs = JsonSerializer.Deserialize<List<WorkflowRun>>(runsJson, JsonOptions) ?? [];
        var latest = runs.OrderByDescending(run => run.CreatedAt).FirstOrDefault();

        var timeZone = GetTaipeiTimeZone();
        var successfulDates = runs
            .Where(run => string.Equals(run.Conclusion, "success", StringComparison.OrdinalIgnoreCase))
            .Select(run => TimeZoneInfo.ConvertTime(run.CreatedAt, timeZone).Date)
            .ToHashSet();
        var today = TimeZoneInfo.ConvertTime(DateTimeOffset.UtcNow, timeZone).Date;
        var monthStart = new DateTime(today.Year, today.Month, 1);
        var monthlyRuns = runs
            .Where(run => TimeZoneInfo.ConvertTime(run.CreatedAt, timeZone).Date >= monthStart)
            .ToArray();
        var accountResultsByRun = new Dictionary<long, AccountResult[]>();
        foreach (var run in monthlyRuns)
            accountResultsByRun[run.DatabaseId] = await GetAccountResultsAsync(run.DatabaseId);
        if (latest is not null && !accountResultsByRun.ContainsKey(latest.DatabaseId))
            accountResultsByRun[latest.DatabaseId] = await GetAccountResultsAsync(latest.DatabaseId);
        var accounts = latest is null ? [] : accountResultsByRun[latest.DatabaseId];

        var consecutiveDays = 0;
        while (successfulDates.Contains(today.AddDays(-consecutiveDays))) consecutiveDays++;

        var successful = accounts.Where(account => account.IsConfigured && account.IsSuccessful).ToArray();
        var failed = accounts.Where(account => account.IsConfigured && account.IsCompleted && !account.IsSuccessful).ToArray();
        var monthlySuccessfulClaims = monthlyRuns
            .SelectMany(run => accountResultsByRun[run.DatabaseId]
                .Where(account => account.IsConfigured && account.IsSuccessful)
                .Select(account => (Date: TimeZoneInfo.ConvertTime(run.CreatedAt, timeZone).Date, account.Number)))
            .Distinct()
            .Count();
        var monthlyClaimedPoints = monthlySuccessfulClaims * pointsPerClaim;

        return new DashboardSnapshot(
            latest,
            accounts,
            successful,
            failed,
            consecutiveDays,
            pointsPerClaim,
            monthlyClaimedPoints);
    }

    private async Task<AccountResult[]> GetAccountResultsAsync(long runId)
    {
        var detailsJson = await RunGhAsync("run", "view", runId.ToString(), "--repo", Repository, "--json", "jobs");
        using var document = JsonDocument.Parse(detailsJson);
        if (!document.RootElement.TryGetProperty("jobs", out var jobs)) return [];

        var results = new List<AccountResult>();
        foreach (var job in jobs.EnumerateArray())
        {
            var name = GetString(job, "name");
            var match = ClaimJobName.Match(name);
            if (!match.Success) continue;

            var number = int.Parse(match.Groups["number"].Value);
            var alias = match.Groups["name"].Value;
            var status = GetString(job, "status");
            var conclusion = GetString(job, "conclusion");
            results.Add(new AccountResult(number, alias, status, conclusion));
        }

        return results.OrderBy(result => result.Number).ToArray();
    }

    private static async Task<string> RunGhAsync(params string[] arguments)
    {
        using var process = new Process
        {
            StartInfo = new ProcessStartInfo
            {
                FileName = "gh",
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
            },
        };
        foreach (var argument in arguments) process.StartInfo.ArgumentList.Add(argument);
        if (!process.Start()) throw new InvalidOperationException("無法啟動 GitHub CLI（gh）。");

        var outputTask = process.StandardOutput.ReadToEndAsync();
        var errorTask = process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync();
        var output = await outputTask;
        var error = await errorTask;
        if (process.ExitCode == 0) return output;

        var reason = string.IsNullOrWhiteSpace(error) ? output : error;
        reason = reason.Trim();
        if (reason.Length > 1_000) reason = reason[..1_000] + "…";
        throw new InvalidOperationException($"GitHub CLI 執行失敗：{reason}");
    }

    private static TimeZoneInfo GetTaipeiTimeZone()
    {
        try { return TimeZoneInfo.FindSystemTimeZoneById("Taipei Standard Time"); }
        catch (TimeZoneNotFoundException) { return TimeZoneInfo.FindSystemTimeZoneById("Asia/Taipei"); }
    }

    private static string GetString(JsonElement element, string propertyName) =>
        element.TryGetProperty(propertyName, out var property) && property.ValueKind != JsonValueKind.Null
            ? property.GetString() ?? string.Empty
            : string.Empty;

    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNameCaseInsensitive = true };
}

internal sealed record WorkflowRun(long DatabaseId, DateTimeOffset CreatedAt, string Conclusion, string Status, string Url, string Event);

internal sealed record AccountResult(int Number, string Alias, string Status, string Conclusion)
{
    public bool IsConfigured => !Regex.IsMatch(Alias, "^account-\\d+$", RegexOptions.IgnoreCase);
    public bool IsSuccessful => string.Equals(Conclusion, "success", StringComparison.OrdinalIgnoreCase);
    public bool IsCompleted => string.Equals(Status, "completed", StringComparison.OrdinalIgnoreCase);
}

internal sealed record DashboardSnapshot(
    WorkflowRun? LatestRun,
    AccountResult[] Accounts,
    AccountResult[] SuccessfulAccounts,
    AccountResult[] FailedAccounts,
    int ConsecutiveDays,
    decimal PointsPerClaim,
    decimal MonthlyClaimedPoints);
