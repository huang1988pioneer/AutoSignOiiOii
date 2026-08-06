# AutoSignOiiOii

使用 GitHub Actions 自動領取 OiiOii 每日盒飯。工作流程每日會在三個台北時間時段內隨機執行，也可以手動觸發；支援最多 33 個帳號，並在失敗時保留截圖以利排查。

## 功能

- 每日自動執行，或從 GitHub Actions 手動執行
- 支援最多 **33** 個 OiiOii 帳號（matrix 並行、依序錯開啟動）
- 優先使用 Playwright Storage State，也可使用 Cookie Header
- 找不到按鈕或暫時失敗時，最多重試 3 次
- 自動上傳執行截圖為 Artifact，保留 7 天
- 不會嘗試繞過 OTP、Google 登入或 CAPTCHA

## 設定 GitHub Actions

### 1. 取得登入狀態

建議使用 Playwright Storage State。登入 OiiOii 後執行（預設 Chromium；備案可改 Firefox 或 Edge）：

```bash
npx playwright codegen --save-storage=auth.json https://www.oiioii.ai/zh-Hant/
# 備案 Firefox：npx playwright codegen --browser=firefox --save-storage=auth.json https://www.oiioii.ai/zh-Hant/
# 備案 Edge：npx playwright codegen --channel=msedge --save-storage=auth.json https://www.oiioii.ai/zh-Hant/
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
| `OII_STORAGE_STATE_B64_2` … `OII_STORAGE_STATE_B64_33` | 帳號 2～33 的 Storage State（選填） |
| `OII_COOKIE_2` … `OII_COOKIE_33` | 帳號 2～33 的 Cookie（選填，可替代 Storage State） |

每個帳號只要設定其中一種登入方式即可，且 Storage State 優先。未設定 Secret 的帳號會自動略過。

請勿把 `auth.json`、Cookie 或任何登入憑證提交到儲存庫。

### 3. 手動驗證

開啟儲存庫的 **Actions** 分頁，選擇 **Claim OiiOii daily lunch**，再按 **Run workflow**。執行完成後，可在該次 workflow 的 Artifacts 下載截圖。

## 每日自動執行時段

GitHub Actions 每天會在下列台北時間（UTC+8）各自執行一次：

| 時段 | 執行方式 |
| --- | --- |
| 05:00–06:00 | 整點觸發後，隨機等待 0–59 分鐘再開始 |
| 13:00–14:00 | 整點觸發後，隨機等待 0–59 分鐘再開始 |
| 21:00–22:00 | 整點觸發後，隨機等待 0–59 分鐘再開始 |

### 33 個帳號依序錯開啟動

同一次 workflow 會同時拉起最多 33 個帳號 job（matrix），但**啟動時間依序錯開**，避免全數同一秒操作：

1. 帳號 1 先開始（延遲 0 秒）
2. 帳號 2 比帳號 1 **隨機晚 5–15 秒**
3. 帳號 3 比帳號 2 **隨機晚 5–15 秒**
4. 依此類推，直到帳號 33

因此若帳號 1 在 `T` 開始，帳號 *n* 約在 `T + Σ(5…15)` 秒後開始；前後帳號可重疊執行（不需等前一個完全跑完），但不會同時點擊。GitHub 的排程本身也可能延遲，因此實際開始時間可能略晚於上述時段。

## 在本機執行

需求：Node.js 22（CI 使用版本）與可安裝 Playwright 瀏覽器的環境。預設使用 **Chromium**；若遇阻擋或失敗，可改用 **Firefox** 或 **Edge** 備案。

```bash
npm install
npx playwright install chromium
# 備案：npx playwright install firefox
# 備案：npx playwright install msedge

# 二選一：設定 Cookie 或 Storage State
export OII_COOKIE='session=...'
# export OII_STORAGE_STATE_B64='...'

npm run claim

# 改用備案瀏覽器
# export OII_BROWSER=firefox   # 或 edge
# npm run claim
```

PowerShell：

```powershell
npm install
npx playwright install chromium
# 備案：npx playwright install firefox
# 備案：npx playwright install msedge
$env:OII_COOKIE = 'session=...'
# 或：$env:OII_STORAGE_STATE_B64 = '...'

npm run claim

# 改用備案瀏覽器
# $env:OII_BROWSER = 'firefox'   # 或 'edge'
# npm run claim
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
| `OII_BROWSER` | `chromium` | Playwright 引擎：`chromium`（預設）、`firefox` 或 `edge`（備案；`msedge` 視為 edge） |
| `OII_ACCOUNT_NAME` | `default` | 用於日誌與截圖檔名的帳號識別 |
| `OII_MAX_RETRIES` | `3` | 最大嘗試次數 |
| `OII_SCREENSHOT_DIR` | `./screenshots` | 截圖輸出資料夾 |

### 瀏覽器選擇（Chromium / Firefox / Edge 備案）

| 情境 | 如何選擇 |
| --- | --- |
| 本機 `npm run claim` | 環境變數 `OII_BROWSER=chromium`、`firefox` 或 `edge` |
| GitHub Actions 手動執行 | Run workflow 時選 **browser**（`chromium` / `firefox` / `edge`） |
| GitHub Actions 排程 | Repository **Variable** `OII_BROWSER`（未設定則用 `chromium`） |
| 桌面工具建立登入狀態 | 「建立登入狀態」頁的瀏覽器下拉選單 |
| 桌面工具手動觸發 | 儀表板的瀏覽器下拉選單 |

建議：**建立 Storage State 與實際領取使用同一瀏覽器**（例如皆用 Edge），可減少狀態不相容的機會。  
Edge 透過 Playwright 的 `channel=msedge` 啟動；本機需已安裝 Microsoft Edge，或先執行 `npx playwright install msedge`。

## 桌面登入工具（macOS、Linux、Windows）

專案內含 Avalonia 桌面工具，可協助建立並複製 Storage State：

```bash
dotnet run --project OiiOiiFlow/OiiOiiFlow.csproj
```

1. 選擇帳號編號，並選擇瀏覽器（**Chromium 預設**，或 **Firefox / Edge 備案**）。
2. 按下建立登入狀態，在開啟的瀏覽器完成 OiiOii 登入，然後關閉瀏覽器。
3. 在工具中讀取並複製 Base64，貼入相同編號的 GitHub Secret。

工具可建立 `01` 至 `33` 編號的登入狀態。若 Chromium 無法正常登入，改選 Firefox 或 Edge 後重試；之後手動或排程領取也請使用相同瀏覽器。

## 疑難排解

- **登入狀態過期**：重新取得 Storage State 或 Cookie，並更新對應的 GitHub Secret。
- **找不到每日領取按鈕**：到 workflow 的 Artifact 查看截圖。目前 UI 是右上角開啟帳戶／盒飯選單後，點「每日簽到領額外盒飯」旁的 **+20**（文案可能含「升級會員」，腳本會依「每日簽到」意圖辨識，不會誤點購買／訂閱）。若 OiiOii 改版，可能需要再調整 `scripts/claim-lunch.mjs`。
- **Chromium 無法領取或被擋**：改用 Firefox 或 Edge 備案——本機設 `OII_BROWSER=firefox` 或 `edge`、手動 workflow 選對應選項，或設定 Repository Variable `OII_BROWSER`；並以**同一瀏覽器**重新建立 Storage State。
- **排程沒有準時執行**：GitHub Actions 的排程可能延遲，尤其在整點附近；可先手動執行驗證設定。
- **需要 OTP、Google 登入或 CAPTCHA**：先在本機正常完成登入，再更新 Storage State／Cookie；此專案不會自動繞過驗證。

## 安全提醒

登入憑證等同帳號存取權。僅將它們放在 GitHub Secrets 或本機環境變數中，並在懷疑外洩時立即撤銷登入工作階段與更新憑證。
