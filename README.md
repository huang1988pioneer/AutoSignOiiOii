# AutoSignOiiOii

## OiiOii 每日盒飯自動領取 — GitHub Action

每天 **08:10（台北時間）** 自動執行，使用你已登入的 OiiOii 狀態嘗試領取每日盒飯。也可在 GitHub **Actions → Claim OiiOii daily lunch → Run workflow** 手動觸發。

---

## 設定步驟

### 1. 取得登入狀態

OiiOii 使用手機 OTP、Google 或企業帳戶登入。GitHub Action **不會也不能**繞過這些驗證流程。你需要手動取得 cookie 或 storage state。

#### 方法 A — Playwright Storage State（推薦）

```bash
npx playwright codegen --save-storage=auth.json https://www.oiioii.ai/
```

在彈出的瀏覽器中完成登入，然後關閉瀏覽器，`auth.json` 會自動保存。

將 `auth.json` 轉為 Base64：

```bash
# macOS / Linux
base64 -w0 auth.json

# Windows PowerShell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("auth.json"))
```

#### 方法 B — Cookie Header

使用瀏覽器開發者工具（F12 → Network → 找到對 oiioii.ai 的請求 → 複製 Cookie header）。

### 2. 設定 GitHub Secrets

前往你的 GitHub 儲存庫 **Settings → Secrets and variables → Actions**，為每個帳號新增以下其中一個 Secret：

| Secret 名稱 | 說明 |
| --- | --- |
| `OII_STORAGE_STATE_B64_1`、`_2`、`_3` | 推薦。各帳號 Playwright `storageState` JSON 的 Base64 編碼 |
| `OII_COOKIE_1`、`_2`、`_3` | 備選。各帳號完整的 `Cookie` header，例如 `session=...; other_cookie=...` |

Action 最多支援三個帳號。每個編號只需設定上述其中一種 Secret；未設定的帳號會自動略過。例如使用兩個帳號時，只要設定 `OII_STORAGE_STATE_B64_1` 與 `OII_STORAGE_STATE_B64_2`。

> ⚠️ **安全提醒**：不要把 cookie、storage state 或帳號密碼提交到 Git。

---

## 重要行為

- ✅ 自動偵測登入狀態，若已過期會明確提示你更新 Secret
- ✅ 只點擊可辨識為「每日簽到／領取盒飯」的按鈕
- ✅ 支援中文與英文介面
- ✅ 失敗時會自動重試（預設最多 3 次）
- ✅ 失敗時上傳截圖到 Workflow Artifacts 供除錯
- ❌ 不會嘗試破解 OTP、Google 驗證或 CAPTCHA
- ❌ 遇到多個候選按鈕時會謹慎處理，避免誤點付費或訂閱按鈕

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
npm run claim
```

---

## 自訂設定

| 環境變數 | 預設值 | 說明 |
| --- | --- | --- |
| `OII_STORAGE_STATE_B64` | — | Playwright storage state 的 Base64 |
| `OII_COOKIE` | — | Cookie header 字串 |
| `OII_MAX_RETRIES` | `3` | 最大重試次數 |
| `OII_SCREENSHOT_DIR` | `./screenshots` | 截圖存放路徑 |

---

## 疑難排解

1. **Workflow 失敗並顯示 "expired"**
   → 登入狀態已過期，重新執行方法 A 或 B 取得新的 cookie/state 並更新 Secret。

2. **Workflow 失敗並顯示 "No daily-lunch claim button"**
   → OiiOii 可能改版了 UI。下載 Artifacts 中的截圖查看，更新 `scripts/claim-lunch.mjs` 中的選擇器。

3. **Schedule 沒有自動執行**
   → GitHub Actions 對 60 天內沒有活動的 repo 會暫停 cron，推送一個 commit 或手動跑一次即可恢復。
