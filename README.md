# AutoSignOiiOii

使用 GitHub Actions 自動領取 OiiOii 每日盒飯。工作流程會在每日台北時間 **08:10** 執行，也可以手動觸發；支援最多三個帳號，並在失敗時保留截圖以利排查。

> OiiOii 的每日獎勵於 UTC 00:00（台北時間 08:00）重置，因此排程設在 10 分鐘後執行。

## 功能

- 每日自動執行，或從 GitHub Actions 手動執行
- 支援 1～3 個 OiiOii 帳號
- 優先使用 Playwright Storage State，也可使用 Cookie Header
- 找不到按鈕或暫時失敗時，最多重試 3 次
- 自動上傳執行截圖為 Artifact，保留 7 天
- 不會嘗試繞過 OTP、Google 登入或 CAPTCHA

## 設定 GitHub Actions

### 1. 取得登入狀態

建議使用 Playwright Storage State。登入 OiiOii 後執行：

```bash
npx playwright codegen --save-storage=auth.json https://www.oiioii.ai/zh-Hant/
```

完成登入後關閉瀏覽器，將 `auth.json` 轉為單行 Base64：

```bash
# macOS / Linux
base64 -w0 auth.json

# Windows PowerShell
[Convert]::ToBase64String([IO.File]::ReadAllBytes('auth.json'))
```

若無法使用 Storage State，也可在瀏覽器開發者工具的 Network 面板中，複製 `oiioii.ai` 請求的完整 `Cookie` header。

### 2. 新增 Repository Secrets

前往 GitHub 儲存庫的 **Settings → Secrets and variables → Actions**，建立下列 Secrets。

| Secret | 用途 |
| --- | --- |
| `OII_STORAGE_STATE_B64_1` | 帳號 1 的 Base64 Storage State（建議） |
| `OII_COOKIE_1` | 帳號 1 的 Cookie Header（可替代 Storage State） |
| `OII_STORAGE_STATE_B64_2`、`OII_COOKIE_2` | 帳號 2（選填） |
| `OII_STORAGE_STATE_B64_3`、`OII_COOKIE_3` | 帳號 3（選填） |

每個帳號只要設定其中一種登入方式即可，且 Storage State 優先。未設定 Secret 的帳號會自動略過。

請勿把 `auth.json`、Cookie 或任何登入憑證提交到儲存庫。

### 3. 手動驗證

開啟儲存庫的 **Actions** 分頁，選擇 **Claim OiiOii daily lunch**，再按 **Run workflow**。執行完成後，可在該次 workflow 的 Artifacts 下載截圖。

## 在本機執行

需求：Node.js 22（CI 使用版本）與可安裝 Chromium 的環境。

```bash
npm install
npx playwright install chromium

# 二選一：設定 Cookie 或 Storage State
export OII_COOKIE='session=...'
# export OII_STORAGE_STATE_B64='...'

npm run claim
```

PowerShell：

```powershell
npm install
npx playwright install chromium
$env:OII_COOKIE = 'session=...'
# 或：$env:OII_STORAGE_STATE_B64 = '...'

npm run claim
```

可先檢查腳本語法：

```bash
npm run check
```

## 環境變數

| 變數 | 預設值 | 說明 |
| --- | --- | --- |
| `OII_STORAGE_STATE_B64` | 無 | Base64 編碼的 Playwright Storage State JSON |
| `OII_COOKIE` | 無 | 完整 Cookie Header |
| `OII_ACCOUNT_NAME` | `default` | 用於日誌與截圖檔名的帳號識別 |
| `OII_MAX_RETRIES` | `3` | 最大嘗試次數 |
| `OII_SCREENSHOT_DIR` | `./screenshots` | 截圖輸出資料夾 |

## 桌面登入工具（Windows）

專案內含 Avalonia 桌面工具，可協助建立並複製 Storage State：

```powershell
dotnet run --project .\OiiOiiFlow\OiiOiiFlow.csproj
```

1. 選擇帳號編號，按下建立登入狀態。
2. 在開啟的瀏覽器完成 OiiOii 登入，然後關閉瀏覽器。
3. 在工具中讀取並複製 Base64，貼入相同編號的 GitHub Secret。

工具可建立 `01` 至 `33` 編號的登入狀態，但目前 workflow 僅會執行帳號 `1`、`2`、`3`；請使用這三個編號。

## 疑難排解

- **登入狀態過期**：重新取得 Storage State 或 Cookie，並更新對應的 GitHub Secret。
- **找不到每日領取按鈕**：到 workflow 的 Artifact 查看截圖；OiiOii 的 UI 若有變更，可能需要調整 `scripts/claim-lunch.mjs` 的選擇器。
- **排程沒有準時執行**：GitHub Actions 的排程可能延遲，尤其在整點附近；可先手動執行驗證設定。
- **需要 OTP、Google 登入或 CAPTCHA**：先在本機正常完成登入，再更新 Storage State／Cookie；此專案不會自動繞過驗證。

## 安全提醒

登入憑證等同帳號存取權。僅將它們放在 GitHub Secrets 或本機環境變數中，並在懷疑外洩時立即撤銷登入工作階段與更新憑證。
