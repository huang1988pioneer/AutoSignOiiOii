using System.Diagnostics;
using System.Text;
using System.Text.Json;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Input.Platform;
using Avalonia.Interactivity;

namespace OiiOiiFlow;

public partial class MainWindow : Window
{
    private const string OiiOiiUrl = "https://www.oiioii.ai/";
    private const int AccountCount = 33;
    private readonly string _workspace = FindWorkspace();
    private readonly GitHubActionsService _githubActions = new();
    private readonly Dictionary<int, TextBox> _aliasInputs = new();
    private readonly Dictionary<int, string> _accountAliases = LoadAccountAliases();

    public MainWindow()
    {
        InitializeComponent();
        AccountComboBox.ItemsSource = Enumerable.Range(1, AccountCount).Select(number => $"帳號 {number:00}").ToArray();
        AccountComboBox.SelectionChanged += (_, _) => UpdateSecretName();
        BuildAliasList();
        UpdateSecretName();
    }

    private int AccountNumber => AccountComboBox.SelectedIndex + 1;
    private string StateFile => Path.Combine(_workspace, $"auth-{AccountNumber:00}.json");
    private string LegacyStateFile => Path.Combine(_workspace, $"auth-{AccountNumber}.json");
    private string SecretName => $"OII_STORAGE_STATE_B64_{AccountNumber}";
    private string? AccountAlias => _accountAliases.GetValueOrDefault(AccountNumber);

    private void UpdateSecretName()
    {
        SecretNameText.Text = SecretName;
        AccountAliasText.Text = AccountAlias ?? string.Empty;
        AccountAliasText.IsVisible = AccountAlias is not null;
        var existingStateFile = ExistingStateFile();
        ResultText.Text = existingStateFile is null
            ? "登入完成並關閉瀏覽器後，讀取 auth-NN.json 並複製 Base64 至剪貼簿。"
            : $"已找到 {Path.GetFileName(existingStateFile)}。可直接讀取並複製 Base64 至剪貼簿。";
        CopyStateButton.IsEnabled = existingStateFile is not null;
        CopySecretNameButton.IsEnabled = false;
    }

    private async void RunFlowButton_OnClick(object? sender, RoutedEventArgs e)
    {
        RunFlowButton.IsEnabled = false;
        CopyStateButton.IsEnabled = false;
        CopySecretNameButton.IsEnabled = false;
        try
        {
            StatusText.Text = "正在確認 Node.js 相依套件…";
            await RunProcessAsync(NodeCommandPath("npm.cmd"), "install", _workspace);

            StatusText.Text = "正在確認 Chromium…";
            await RunProcessAsync(NodeCommandPath("npx.cmd"), "playwright install chromium", _workspace);

            if (File.Exists(StateFile)) File.Delete(StateFile);
            StatusText.Text = "瀏覽器已開啟。請完成 OiiOii 登入，確認成功後關閉瀏覽器視窗。";
            await RunProcessAsync(
                NodeCommandPath("npx.cmd"),
                $"playwright codegen --save-storage=\"auth-{AccountNumber:00}.json\" {OiiOiiUrl}",
                _workspace);

            if (!File.Exists(StateFile))
                throw new InvalidOperationException("找不到登入狀態檔。請確認是在瀏覽器中登入完成後才關閉。\n");

            ResultText.Text = $"已建立 {Path.GetFileName(StateFile)}。請按下「讀取並複製登入狀態」，再貼到 GitHub Secret：{SecretName}。";
            StatusText.Text = "登入狀態檔已建立，等待你確認複製。";
            CopyStateButton.IsEnabled = true;
        }
        catch (Exception exception)
        {
            StatusText.Text = $"流程未完成：{exception.Message}";
            ResultText.Text = "沒有複製任何登入狀態。請修正問題後重新執行。";
        }
        finally
        {
            RunFlowButton.IsEnabled = true;
        }
    }

    private async void CopySecretNameButton_OnClick(object? sender, RoutedEventArgs e)
    {
        if (Clipboard is { } clipboard) await clipboard.SetTextAsync(SecretName);
        StatusText.Text = $"已複製 {SecretName}。";
    }

    private async void TriggerClaimButton_OnClick(object? sender, RoutedEventArgs e)
    {
        TriggerClaimButton.IsEnabled = false;
        RefreshDashboardButton.IsEnabled = false;
        DashboardStatusText.Text = "正在送出 GitHub Actions 手動執行請求…";
        try
        {
            await _githubActions.TriggerClaimAsync();
            DashboardStatusText.Text = "已觸發每日領取 workflow。啟動後按「更新執行結果」即可查看帳號進度。";
        }
        catch (Exception exception)
        {
            DashboardStatusText.Text = $"無法觸發 workflow：{exception.Message}";
        }
        finally
        {
            TriggerClaimButton.IsEnabled = true;
            RefreshDashboardButton.IsEnabled = true;
        }
    }

    private void DashboardNavButton_OnClick(object? sender, RoutedEventArgs e) => ShowView(DashboardView);

    private void AccountNavButton_OnClick(object? sender, RoutedEventArgs e) => ShowView(AccountView);

    private void LoginNavButton_OnClick(object? sender, RoutedEventArgs e) => ShowView(LoginView);

    private void ShowView(Control view)
    {
        DashboardView.IsVisible = view == DashboardView;
        AccountView.IsVisible = view == AccountView;
        LoginView.IsVisible = view == LoginView;
        view.BringIntoView();
    }

    private async void RefreshDashboardButton_OnClick(object? sender, RoutedEventArgs e)
    {
        TriggerClaimButton.IsEnabled = false;
        RefreshDashboardButton.IsEnabled = false;
        DashboardStatusText.Text = "正在讀取 GitHub Actions 執行紀錄…";
        try
        {
            var pointsPerClaim = ParsePointsPerClaim();
            var snapshot = await _githubActions.GetSnapshotAsync(pointsPerClaim);
            RenderDashboard(snapshot);
        }
        catch (Exception exception)
        {
            DashboardStatusText.Text = $"無法讀取 GitHub Actions：{exception.Message}";
        }
        finally
        {
            TriggerClaimButton.IsEnabled = true;
            RefreshDashboardButton.IsEnabled = true;
        }
    }

    private decimal ParsePointsPerClaim()
    {
        if (decimal.TryParse(PointsPerClaimTextBox.Text, out var points) && points >= 0) return points;
        PointsPerClaimTextBox.Text = "20";
        return 20;
    }

    private void RenderDashboard(DashboardSnapshot snapshot)
    {
        SuccessfulAccountsMetric.Text = $"{snapshot.SuccessfulAccounts.Length} 個";
        ConsecutiveDaysMetric.Text = $"{snapshot.ConsecutiveDays} 天";
        MonthlyPointsMetric.Text = snapshot.MonthlyClaimedPoints.ToString("0.##");

        if (snapshot.LatestRun is null)
        {
            DashboardStatusText.Text = "找不到每日領取 workflow 的執行紀錄。";
            ActionAccountResultsPanel.Children.Clear();
            return;
        }

        var runStatus = string.IsNullOrWhiteSpace(snapshot.LatestRun.Conclusion)
            ? snapshot.LatestRun.Status
            : snapshot.LatestRun.Conclusion;
        var unconfiguredCount = snapshot.Accounts.Count(account => !account.IsConfigured);
        DashboardStatusText.Text =
            $"最近執行：{snapshot.LatestRun.CreatedAt.LocalDateTime:g} · {runStatus} · " +
            $"成功 {snapshot.SuccessfulAccounts.Length} 個、失敗 {snapshot.FailedAccounts.Length} 個、未設定 {unconfiguredCount} 個。";

        ActionAccountResultsPanel.Children.Clear();
        foreach (var account in snapshot.Accounts)
        {
            var alias = account.IsConfigured
                ? _accountAliases.GetValueOrDefault(account.Number) ?? account.Alias
                : "未設定帳號";
            var result = !account.IsConfigured
                ? "尚未設定登入狀態"
                : account.IsSuccessful
                ? "登入有效、領取流程成功"
                : account.IsCompleted ? "登入或領取流程失敗" : "尚在執行或未設定";
            var row = new Grid { ColumnDefinitions = new ColumnDefinitions("78,160,*") };
            row.Children.Add(new TextBlock { Text = $"帳號 {account.Number:00}", FontWeight = Avalonia.Media.FontWeight.SemiBold });
            var aliasText = new TextBlock { Text = alias, TextTrimming = Avalonia.Media.TextTrimming.CharacterEllipsis };
            Grid.SetColumn(aliasText, 1);
            row.Children.Add(aliasText);
            var stateText = new TextBlock { Text = result };
            Grid.SetColumn(stateText, 2);
            row.Children.Add(stateText);
            ActionAccountResultsPanel.Children.Add(row);
        }

        if (snapshot.Accounts.Length == 0)
            ActionAccountResultsPanel.Children.Add(new TextBlock { Text = "最新 run 尚未建立帳號 job；請稍後再更新。" });
    }

    private async void CopyStateButton_OnClick(object? sender, RoutedEventArgs e)
    {
        var stateFile = ExistingStateFile();
        if (stateFile is null)
        {
            StatusText.Text = $"找不到 {Path.GetFileName(StateFile)}。請重新執行登入流程。";
            CopyStateButton.IsEnabled = false;
            return;
        }

        var encoded = Convert.ToBase64String(await File.ReadAllBytesAsync(stateFile));
        var duplicateAccounts = await FindDuplicateStateFilesAsync(encoded);
        if (duplicateAccounts.Count > 0)
        {
            ResultText.Text = $"偵測到與帳號 {string.Join("、", duplicateAccounts.Select(number => number.ToString("00")))} 相同的登入狀態，未複製到剪貼簿。";
            StatusText.Text = "請使用不同的 OiiOii 帳號重新登入後再建立狀態，避免重複領取。";
            return;
        }
        if (Clipboard is { } clipboard) await clipboard.SetTextAsync(encoded);
        ResultText.Text = $"已複製 {Path.GetFileName(stateFile)} 的 Base64（{encoded.Length:N0} 個字元）。貼到 GitHub Repository Secret：{SecretName}。";
        StatusText.Text = "登入狀態已複製；請勿將其貼入聊天訊息或提交到 Git。";
        CopySecretNameButton.IsEnabled = true;
    }

    private void BuildAliasList()
    {
        AliasListPanel.Children.Clear();
        for (var number = 1; number <= AccountCount; number++)
        {
            var input = new TextBox
            {
                Width = 330,
                PlaceholderText = "帳號名稱（可留白）",
                Text = _accountAliases.GetValueOrDefault(number) ?? string.Empty,
            };
            var accountNumber = number;
            input.TextChanged += (_, _) =>
            {
                var alias = input.Text?.Trim() ?? string.Empty;
                if (string.IsNullOrEmpty(alias)) _accountAliases.Remove(accountNumber);
                else _accountAliases[accountNumber] = alias;
                if (accountNumber == AccountNumber) UpdateSecretName();
            };
            _aliasInputs[number] = input;

            var row = new StackPanel { Orientation = Avalonia.Layout.Orientation.Horizontal, Spacing = 10 };
            row.Children.Add(new TextBlock { Text = $"帳號 {number:00}", Width = 68, VerticalAlignment = Avalonia.Layout.VerticalAlignment.Center });
            row.Children.Add(input);
            AliasListPanel.Children.Add(row);
        }
    }

    private async void SaveAliasesButton_OnClick(object? sender, RoutedEventArgs e)
    {
        foreach (var (number, input) in _aliasInputs)
        {
            var alias = input.Text?.Trim() ?? string.Empty;
            if (string.IsNullOrEmpty(alias)) _accountAliases.Remove(number);
            else _accountAliases[number] = alias;
        }

        var directory = Path.GetDirectoryName(AliasFile);
        if (directory is not null) Directory.CreateDirectory(directory);
        await File.WriteAllTextAsync(AliasFile, JsonSerializer.Serialize(_accountAliases));
        UpdateSecretName();
        StatusText.Text = "帳號別名已儲存在這台電腦。";
    }

    private string? ExistingStateFile()
    {
        if (File.Exists(StateFile)) return StateFile;
        return File.Exists(LegacyStateFile) ? LegacyStateFile : null;
    }

    private async Task<IReadOnlyList<int>> FindDuplicateStateFilesAsync(string currentState)
    {
        var duplicates = new List<int>();
        foreach (var file in Directory.EnumerateFiles(_workspace, "auth-*.json"))
        {
            if (string.Equals(file, StateFile, StringComparison.OrdinalIgnoreCase) ||
                string.Equals(file, LegacyStateFile, StringComparison.OrdinalIgnoreCase))
                continue;

            var suffix = Path.GetFileNameWithoutExtension(file)["auth-".Length..];
            if (!int.TryParse(suffix, out var accountNumber)) continue;
            if (Convert.ToBase64String(await File.ReadAllBytesAsync(file)) == currentState)
                duplicates.Add(accountNumber);
        }
        return duplicates;
    }

    private static string AliasFile => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        "OiiOiiFlow",
        "account-aliases.json");

    private static Dictionary<int, string> LoadAccountAliases()
    {
        var defaults = new Dictionary<int, string>
        {
            [1] = "huang1988pioneer",
            [2] = "abuhg17",
            [3] = "goldshoot0720",
        };
        if (!File.Exists(AliasFile)) return defaults;

        try
        {
            return JsonSerializer.Deserialize<Dictionary<int, string>>(File.ReadAllText(AliasFile)) ?? defaults;
        }
        catch (JsonException)
        {
            return defaults;
        }
    }

    private static async Task RunProcessAsync(string fileName, string arguments, string workingDirectory)
    {
        using var process = new Process
        {
            StartInfo = new ProcessStartInfo
            {
                FileName = fileName,
                Arguments = arguments,
                WorkingDirectory = workingDirectory,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            },
        };
        if (!process.Start()) throw new InvalidOperationException($"無法啟動 {fileName}。");
        var standardOutput = process.StandardOutput.ReadToEndAsync();
        var standardError = process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync();
        var output = await standardOutput;
        var error = await standardError;
        if (process.ExitCode != 0)
        {
            var details = SummarizeProcessFailure(error, output);
            throw new InvalidOperationException(
                $"{fileName} 執行失敗（結束碼 {process.ExitCode}）。{details}");
        }
    }

    private static string SummarizeProcessFailure(string standardError, string standardOutput)
    {
        var details = string.IsNullOrWhiteSpace(standardError) ? standardOutput : standardError;
        var lines = details
            .Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Take(12);
        var summary = string.Join(Environment.NewLine, lines);
        if (summary.Length > 1_500) summary = summary[..1_500] + "…";
        return string.IsNullOrWhiteSpace(summary) ? string.Empty : $"{Environment.NewLine}{summary}";
    }

    private static string NodeCommandPath(string commandName)
    {
        var nodeDirectory = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
            "nodejs");
        var commandPath = Path.Combine(nodeDirectory, commandName);
        return File.Exists(commandPath) ? commandPath : commandName;
    }

    private static string FindWorkspace()
    {
        foreach (var startPath in new[] { AppContext.BaseDirectory, Environment.CurrentDirectory }.Distinct())
        {
            for (var directory = new DirectoryInfo(startPath); directory is not null; directory = directory.Parent)
                if (File.Exists(Path.Combine(directory.FullName, "package.json"))) return directory.FullName;
        }
        return Environment.CurrentDirectory;
    }
}
