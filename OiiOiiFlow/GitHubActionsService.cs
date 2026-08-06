using System.Collections.Concurrent;
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
        var today = TimeZoneInfo.ConvertTime(DateTimeOffset.UtcNow, timeZone).Date;
        var monthStart = new DateTime(today.Year, today.Month, 1);

        // Per-account job results for listed runs (success days + monthly points).
        var accountResultsByRun = await GetAccountResultsByRunAsync(runs.Select(run => run.DatabaseId));

        var accountSuccessDates = new Dictionary<int, HashSet<DateTime>>();
        var accountAttemptDates = new Dictionary<int, HashSet<DateTime>>();
        foreach (var run in runs)
        {
            if (!accountResultsByRun.TryGetValue(run.DatabaseId, out var results)) continue;
            var date = TimeZoneInfo.ConvertTime(run.CreatedAt, timeZone).Date;
            foreach (var account in results)
            {
                if (!account.DidAttemptClaim) continue;

                if (!accountAttemptDates.TryGetValue(account.Number, out var attempts))
                {
                    attempts = [];
                    accountAttemptDates[account.Number] = attempts;
                }
                attempts.Add(date);

                if (!account.IsSuccessful) continue;
                if (!accountSuccessDates.TryGetValue(account.Number, out var dates))
                {
                    dates = [];
                    accountSuccessDates[account.Number] = dates;
                }
                dates.Add(date);
            }
        }

        var rawAccounts = latest is null
            ? []
            : accountResultsByRun.GetValueOrDefault(latest.DatabaseId) ?? [];
        var accounts = rawAccounts
            .Select(account => account with
            {
                ConsecutiveDays = CountConsecutiveDays(
                    accountSuccessDates.GetValueOrDefault(account.Number),
                    accountAttemptDates.GetValueOrDefault(account.Number),
                    today),
            })
            .ToArray();

        var successful = accounts.Where(account => account.DidAttemptClaim && account.IsSuccessful).ToArray();
        var failed = accounts.Where(account => account.DidAttemptClaim && account.IsCompleted && !account.IsSuccessful).ToArray();
        var streakSummary = BuildStreakSummary(accounts);

        // One successful claim per account per Taipei day counts once for monthly points.
        var monthlySuccessfulClaims = runs
            .Where(run => TimeZoneInfo.ConvertTime(run.CreatedAt, timeZone).Date >= monthStart)
            .SelectMany(run => (accountResultsByRun.GetValueOrDefault(run.DatabaseId) ?? [])
                .Where(account => account.DidAttemptClaim && account.IsSuccessful)
                .Select(account => (Date: TimeZoneInfo.ConvertTime(run.CreatedAt, timeZone).Date, account.Number)))
            .Distinct()
            .Count();
        var monthlyClaimedPoints = monthlySuccessfulClaims * pointsPerClaim;

        return new DashboardSnapshot(
            latest,
            accounts,
            successful,
            failed,
            streakSummary,
            pointsPerClaim,
            monthlyClaimedPoints);
    }

    /// <summary>
    /// Aggregate consecutive-check-in stats across accounts that have attempted claims
    /// or already hold a positive streak from history.
    /// </summary>
    private static StreakSummary BuildStreakSummary(AccountResult[] accounts)
    {
        var tracked = accounts
            .Where(account => account.DidAttemptClaim || account.ConsecutiveDays > 0 || account.IsConfigured)
            .ToArray();
        if (tracked.Length == 0)
            return new StreakSummary(0, 0, 0, 0, 0);

        var streaks = tracked.Select(account => account.ConsecutiveDays).ToArray();
        return new StreakSummary(
            TrackedCount: tracked.Length,
            ActiveStreakCount: streaks.Count(days => days > 0),
            MaxDays: streaks.Max(),
            MinDays: streaks.Min(),
            AverageDays: Math.Round(streaks.Average(), 1));
    }

    /// <summary>
    /// Consecutive Taipei calendar days with a successful claim for one account.
    /// - Success today → streak ends at today.
    /// - Attempted but failed today → streak resets to 0.
    /// - No attempt today yet → streak may still continue from yesterday.
    /// </summary>
    private static int CountConsecutiveDays(
        HashSet<DateTime>? successDates,
        HashSet<DateTime>? attemptDates,
        DateTime today)
    {
        if (successDates is null || successDates.Count == 0) return 0;

        DateTime cursor;
        if (successDates.Contains(today))
        {
            cursor = today;
        }
        else if (attemptDates is not null && attemptDates.Contains(today))
        {
            // Claimed (or tried) today but no success → broken streak.
            return 0;
        }
        else
        {
            cursor = today.AddDays(-1);
            if (!successDates.Contains(cursor)) return 0;
        }

        var days = 0;
        while (successDates.Contains(cursor.AddDays(-days))) days++;
        return days;
    }

    private async Task<Dictionary<long, AccountResult[]>> GetAccountResultsByRunAsync(IEnumerable<long> runIds)
    {
        var ids = runIds.Distinct().ToArray();
        if (ids.Length == 0) return [];

        var results = new ConcurrentDictionary<long, AccountResult[]>();
        await Parallel.ForEachAsync(
            ids,
            new ParallelOptions { MaxDegreeOfParallelism = 6 },
            async (runId, _) => results[runId] = await GetAccountResultsAsync(runId));
        return results.ToDictionary(pair => pair.Key, pair => pair.Value);
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
            var claimStepConclusion = ReadClaimStepConclusion(job);
            results.Add(new AccountResult(number, alias, status, conclusion, claimStepConclusion));
        }

        return results.OrderBy(result => result.Number).ToArray();
    }

    /// <summary>
    /// Prefer the "Claim daily …" step: skipped = no secret; success/failure = real attempt.
    /// Falls back to job conclusion when steps are missing (older API payloads).
    /// </summary>
    private static string? ReadClaimStepConclusion(JsonElement job)
    {
        if (!job.TryGetProperty("steps", out var steps) || steps.ValueKind != JsonValueKind.Array)
            return null;

        foreach (var step in steps.EnumerateArray())
        {
            var stepName = GetString(step, "name");
            if (stepName.Length == 0) continue;
            // Step title is "Claim daily 盒飯" (encoding may vary in terminals).
            if (stepName.StartsWith("Claim daily", StringComparison.OrdinalIgnoreCase) ||
                stepName.Contains("Claim daily", StringComparison.OrdinalIgnoreCase))
            {
                var stepConclusion = GetString(step, "conclusion");
                return string.IsNullOrEmpty(stepConclusion) ? null : stepConclusion;
            }
        }

        return null;
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

/// <param name="ClaimStepConclusion">
/// Conclusion of the claim step: success / failure / skipped / null (in progress or unknown).
/// </param>
internal sealed record AccountResult(
    int Number,
    string Alias,
    string Status,
    string Conclusion,
    string? ClaimStepConclusion = null,
    int ConsecutiveDays = 0)
{
    /// <summary>Secret was present and the claim step actually ran (not skipped).</summary>
    public bool DidAttemptClaim =>
        ClaimStepConclusion is not null
            ? !string.Equals(ClaimStepConclusion, "skipped", StringComparison.OrdinalIgnoreCase)
            // Fallback when step list is missing: non-default job aliases are treated as configured.
            : !Regex.IsMatch(Alias, @"^account-\d+$", RegexOptions.IgnoreCase);

    /// <summary>
    /// Configured for display: real claim attempt, or non-default alias when steps are unavailable.
    /// Unconfigured matrix slots skip checkout/claim and only sleep.
    /// </summary>
    public bool IsConfigured => DidAttemptClaim;

    public bool IsSuccessful =>
        ClaimStepConclusion is not null
            ? string.Equals(ClaimStepConclusion, "success", StringComparison.OrdinalIgnoreCase)
            : DidAttemptClaim && string.Equals(Conclusion, "success", StringComparison.OrdinalIgnoreCase);

    public bool IsCompleted => string.Equals(Status, "completed", StringComparison.OrdinalIgnoreCase);
}

/// <summary>Aggregate consecutive-check-in stats across tracked accounts.</summary>
internal sealed record StreakSummary(
    int TrackedCount,
    int ActiveStreakCount,
    int MaxDays,
    int MinDays,
    double AverageDays);

internal sealed record DashboardSnapshot(
    WorkflowRun? LatestRun,
    AccountResult[] Accounts,
    AccountResult[] SuccessfulAccounts,
    AccountResult[] FailedAccounts,
    StreakSummary Streak,
    decimal PointsPerClaim,
    decimal MonthlyClaimedPoints);
