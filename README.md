# AutoSignOiiOii

## OiiOii 每日盒飯自動領取 — GitHub Action

每天 **08:10（台北時間 / UTC 00:10）** 自動執行，使用你已登入的 OiiOii 狀態嘗試領取每日盒飯。  
也可在 GitHub **Actions → Claim OiiOii daily lunch → Run workflow** 手動觸發。

倉庫：https://github.com/huang1988pioneer/AutoSignOiiOii

> OiiOii 每日簽到盒飯於 **UTC 00:00** 刷新。本 workflow 在刷新後約 10 分鐘執行。

---

## 設定步驟

### 1. 取得登入狀態

OiiOii 使用手機 OTP、Google 或企業帳戶登入。GitHub Action **不會也不能**繞過這些驗證流程。你需要手動取得 cookie 或 storage state。

#### 方法 A — Playwright Storage State（推薦）

```bash
npx playwright codegen --save-storage=auth.json https://www.oiioii.ai/zh-Hant/
```

在彈出的瀏覽器中完成登入，確認已進入主畫面後關閉瀏覽器，`auth.json` 會自動保存。

將 `auth.json` 轉為 Base64：

```bash
# macOS / Linux
base64 -w0 auth.json

# Windows PowerShell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("auth.json"))
```

#### 方法 B — Cookie Header

使用瀏覽器開發者工具（F12 → Network → 找到對 `oiioii.ai` 的請求 → 複製完整 Cookie header）。

### 2. 設定 GitHub Secrets

前往儲存庫 **Settings → Secrets and variables → Actions**，為每個帳號新增以下其中一個 Secret：

| Secret 名稱 | 說明 |
| --- | --- |
| `OII_STORAGE_STATE_B64_1` 至 `OII_STORAGE_STATE_B64_33` | 推薦。各帳號 Playwright `storageState` JSON 的 Base64 編碼 |
| `OII_COOKIE_1` 至 `OII_COOKIE_33` | 備選。各帳號完整的 `Cookie` header，例如 `session=...; other_cookie=...` |

Action 最多支援 33 個帳號。每個編號只需設定上述其中一種 Secret；未設定的帳號會自動略過。例如使用兩個帳號時，只要設定 `OII_STORAGE_STATE_B64_1` 與 `OII_STORAGE_STATE_B64_2`。

> ⚠️ **安全提醒**：不要把 cookie、storage state 或帳號密碼提交到 Git。

### 3. 啟用並測試

1. 確認 workflow 檔案已在 `main`：`.github/workflows/claim-oiioii-lunch.yml`
2. 到 **Actions → Claim OiiOii daily lunch → Run workflow** 手動跑一次
3. 成功後即可靠每日排程自動領取

---

## 重要行為

- ✅ 自動偵測登入狀態，若已過期會明確提示你更新 Secret
- ✅ 優先尋找可辨識為「每日簽到／領取盒飯」的控制項
- ✅ 支援繁中、簡中與英文介面
- ✅ 失敗時會自動重試（預設最多 3 次）
- ✅ 每次執行上傳截圖 Artifact 供除錯
- ❌ 不會嘗試破解 OTP、Google 驗證或 CAPTCHA
- ❌ 會避開訂閱／購買等付費按鈕

---

## 本機測試

```bash
npm install
npx playwright install chromium

# 方式一：使用 Cookie
export OII_COOKIE='session=...'

# 方式二：使用 Storage State
export OII_STORAGE_STATE_B64='...'

npm run claim
```

### PowerShell

```powershell
npm install
npx playwright install chromium
$env:OII_COOKIE = 'session=...'
# 或
# $env:OII_STORAGE_STATE_B64 = '...'
npm run claim
```

---

## 自訂設定

| 環境變數 | 預設值 | 說明 |
| --- | --- | --- |
| `OII_STORAGE_STATE_B64` | — | Playwright storage state 的 Base64 |
| `OII_COOKIE` | — | Cookie header 字串 |
| `OII_ACCOUNT_NAME` | `default` | 日誌／截圖用帳號標籤 |
| `OII_MAX_RETRIES` | `3` | 最大重試次數 |
| `OII_SCREENSHOT_DIR` | `./screenshots` | 截圖存放路徑 |

---

## Avalonia 登入流程工具

若不想在終端機手動執行 Playwright，可使用桌面工具建立登入狀態：

```powershell
dotnet run --project .\OiiOiiFlow\OiiOiiFlow.csproj
```

1. 在工具中選擇帳號 01–33；它會對應 `OII_STORAGE_STATE_B64_1` 至 `OII_STORAGE_STATE_B64_33`。
2. 點擊「開始登入並建立狀態」，並在開啟的瀏覽器自行完成 OiiOii 登入。
3. 確認進入 OiiOii 後關閉該瀏覽器。工具會將 Base64 登入狀態複製到剪貼簿，並顯示要建立的 GitHub Secret 名稱。

工具不會顯示或儲存帳密；請勿把 `auth-N.json` 或剪貼簿中的 Base64 提交至 Git。

---

## 疑難排解

1. **Workflow 失敗並顯示 "expired"**  
   → 登入狀態已過期，重新執行方法 A 或 B 取得新的 cookie/state 並更新 Secret。

2. **Workflow 失敗並顯示 "No daily 盒飯 claim control"**  
   → OiiOii 可能改版了 UI。下載 Artifacts 中的截圖查看，更新 `scripts/claim-lunch.mjs` 中的選擇器。

3. **Schedule 沒有自動執行**  
   → GitHub Actions 對 60 天內沒有活動的 repo 會暫停 cron，推送一個 commit 或手動跑一次即可恢復。

4. **Cookie 很快失效**  
   → 改用方法 A（storage state，通常含 localStorage／更多 session 資訊），並避免在瀏覽器中同時登出。
