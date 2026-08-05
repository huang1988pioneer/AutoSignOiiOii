# OiiOii 每日盒飯 GitHub Action

每天 08:10（台北時間）執行一次，使用你已登入的 OiiOii 狀態嘗試領取每日盒飯；也可在 GitHub 的 **Actions → Claim OiiOii daily lunch → Run workflow** 手動執行。

## 設定

OiiOii 目前使用手機 OTP、Google 或企業帳戶登入，GitHub Action 不能也不會略過這些驗證。請在 GitHub 儲存庫 **Settings → Secrets and variables → Actions** 建立下列其中一個 secret：

1. 建議：`OII_STORAGE_STATE_B64` — Playwright `storageState` JSON 的 Base64 編碼，能保留 cookie 與 localStorage。
2. 替代：`OII_COOKIE` — 已登入狀態的完整 `Cookie` header，例如 `session=...; other_cookie=...`。

不要把 cookie、storage state 或帳號密碼提交到 Git。

## 重要行為

- 若登入狀態失效，工作流程會失敗並要求你更新 Secret；不會嘗試破解 OTP、Google 驗證或 CAPTCHA。
- 只有可辨識為「每日簽到／領取盒飯」的按鈕會被點擊；遇到多個候選按鈕時會停止，避免誤點付費或訂閱按鈕。
- 網站介面文字改動時，更新 `scripts/claim-lunch.mjs` 裡的 `claimButton` 選擇器即可。

## 本機檢查

```powershell
npm install
npx playwright install chromium
$env:OII_COOKIE = 'session=...'
npm run claim
```
