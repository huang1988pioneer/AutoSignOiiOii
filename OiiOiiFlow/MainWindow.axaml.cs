using System.Diagnostics;
using System.Text;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Interactivity;

namespace OiiOiiFlow;

public partial class MainWindow : Window
{
    private const string OiiOiiUrl = "https://www.oiioii.ai/";
    private readonly string _workspace = FindWorkspace();

    public MainWindow()
    {
        InitializeComponent();
        AccountComboBox.ItemsSource = Enumerable.Range(1, 33).Select(number => $"帳號 {number:00}").ToArray();
        AccountComboBox.SelectionChanged += (_, _) => UpdateSecretName();
    }

    private int AccountNumber => AccountComboBox.SelectedIndex + 1;
    private string StateFile => Path.Combine(_workspace, $"auth-{AccountNumber}.json");
    private string SecretName => $"OII_STORAGE_STATE_B64_{AccountNumber}";

    private void UpdateSecretName()
    {
        SecretNameText.Text = SecretName;
        ResultText.Text = "完成後會自動將 Base64 複製到剪貼簿；請貼到對應的 GitHub Repository Secret。";
        CopySecretNameButton.IsEnabled = false;
    }

    private async void RunFlowButton_OnClick(object? sender, RoutedEventArgs e)
    {
        RunFlowButton.IsEnabled = false;
        CopySecretNameButton.IsEnabled = false;
        try
        {
            StatusText.Text = "正在確認 Node.js 相依套件…";
            await RunProcessAsync("npm.cmd", "install", _workspace);

            StatusText.Text = "正在確認 Chromium…";
            await RunProcessAsync("npx.cmd", "playwright install chromium", _workspace);

            if (File.Exists(StateFile)) File.Delete(StateFile);
            StatusText.Text = "瀏覽器已開啟。請完成 OiiOii 登入，確認成功後關閉瀏覽器視窗。";
            await RunProcessAsync("npx.cmd", $"playwright codegen --save-storage=\"auth-{AccountNumber}.json\" {OiiOiiUrl}", _workspace);

            if (!File.Exists(StateFile))
                throw new InvalidOperationException("找不到登入狀態檔。請確認是在瀏覽器中登入完成後才關閉。\n");

            var encoded = Convert.ToBase64String(await File.ReadAllBytesAsync(StateFile));
            if (Clipboard is { } clipboard) await clipboard.SetTextAsync(encoded);
            ResultText.Text = $"已將登入狀態複製到剪貼簿（{encoded.Length:N0} 個字元）。到 GitHub 新增或更新 Secret：{SecretName}";
            StatusText.Text = "完成。登入狀態已複製；請勿將其貼入聊天訊息或提交到 Git。";
            CopySecretNameButton.IsEnabled = true;
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
            },
        };
        if (!process.Start()) throw new InvalidOperationException($"無法啟動 {fileName}。");
        await process.WaitForExitAsync();
        if (process.ExitCode != 0) throw new InvalidOperationException($"{fileName} 執行失敗（結束碼 {process.ExitCode}）。");
    }

    private static string FindWorkspace()
    {
        for (var directory = new DirectoryInfo(Environment.CurrentDirectory); directory is not null; directory = directory.Parent)
            if (File.Exists(Path.Combine(directory.FullName, "package.json"))) return directory.FullName;
        return Environment.CurrentDirectory;
    }
}
