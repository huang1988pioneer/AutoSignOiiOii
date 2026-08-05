import { chromium } from 'playwright';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ─── Configuration ──────────────────────────────────────────────────────────────
const HOME_URL = 'https://www.oiioii.ai/';
const LOCALE_HOME = 'https://www.oiioii.ai/zh-Hant/';
const ACCOUNT_NAME = process.env.OII_ACCOUNT_NAME ?? 'default';
const STATE_B64 = process.env.OII_STORAGE_STATE_B64;
const COOKIE_HEADER = process.env.OII_COOKIE;
const MAX_RETRIES = Number(process.env.OII_MAX_RETRIES) || 3;
const SCREENSHOT_DIR = process.env.OII_SCREENSHOT_DIR || './screenshots';

// Pages that often host daily 盒飯 check-in UI.
const REWARD_PATHS = [
  '/zh-Hant/',
  '/',
  '/zh-Hant/profile',
  '/profile',
  '/zh-Hant/lucky-draw',
  '/lucky-draw',
  '/zh-Hant/price',
  '/price',
];

// ─── Helpers ────────────────────────────────────────────────────────────────────

function fail(message) {
  console.error(`::error::[account ${ACCOUNT_NAME}] ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

function warn(message) {
  console.warn(`::warning::[account ${ACCOUNT_NAME}] ${message}`);
}

function log(message) {
  console.log(`[account ${ACCOUNT_NAME}] ${message}`);
}

/**
 * Parse a raw Cookie header string into Playwright-compatible cookie objects.
 */
function parseCookieHeader(header) {
  return header
    .split(';')
    .map((part) => {
      const separator = part.indexOf('=');
      if (separator < 1) throw new Error('OII_COOKIE contains an invalid cookie segment.');
      return {
        name: part.slice(0, separator).trim(),
        value: part.slice(separator + 1).trim(),
        url: HOME_URL,
        sameSite: 'Lax',
      };
    })
    .filter(({ name, value }) => name && value);
}

/**
 * Decode OII_STORAGE_STATE_B64 to a temp file Playwright can consume.
 * Returns { directory, file } or undefined.
 */
async function storageStateFile() {
  if (!STATE_B64) return undefined;
  const directory = await mkdtemp(join(tmpdir(), 'oiioii-state-'));
  const file = join(directory, 'storage-state.json');
  try {
    JSON.parse(Buffer.from(STATE_B64, 'base64').toString('utf8'));
  } catch {
    await rm(directory, { recursive: true, force: true });
    fail('OII_STORAGE_STATE_B64 is not valid base64-encoded Playwright storage state JSON.');
  }
  await writeFile(file, Buffer.from(STATE_B64, 'base64'));
  return { directory, file };
}

/**
 * Save a timestamped screenshot for debugging in CI.
 */
async function saveScreenshot(page, label) {
  try {
    await mkdir(SCREENSHOT_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const path = join(SCREENSHOT_DIR, `account${ACCOUNT_NAME}_${label}_${ts}.png`);
    await page.screenshot({ path, fullPage: true });
    log(`Screenshot saved: ${path}`);
  } catch (err) {
    warn(`Failed to save screenshot: ${err.message}`);
  }
}

/**
 * Wait for network to settle after page load / action.
 */
async function waitForStable(page, ms = 2000) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(ms);
}

// ─── Patterns ───────────────────────────────────────────────────────────────────

// Login-gate: if any of these are visible, the session has expired.
const LOGIN_PATTERNS = [
  'Sign up / Log in',
  '注册 / 登录',
  '註冊 / 登入',
  'Sign up',
  'Log in',
  '登入',
  '登录',
  '立即登录',
  '立即登入',
];

// Daily 盒飯 / check-in button text (Traditional + Simplified + English).
const CLAIM_TEXT_RE =
  /(?:daily\s*(?:check.?in|claim|reward|bonus|sign.?in)|check.?in|sign.?in|claim\s*(?:daily|reward|bonus|bento|lunch)|立即(?:簽到|签到|領取|领取)|(?:每日|今天|今日).*(?:簽到|签到|領取|领取)|(?:簽到|签到).*(?:盒飯|盒饭|飯盒|饭盒|獎勵|奖励)?|(?:領取|领取).*(?:盒飯|盒饭|飯盒|饭盒|獎勵|奖励)|(?:盒飯|盒饭|飯盒|饭盒).*(?:簽到|签到|領取|领取)|打卡|領盒飯|领盒饭|领饭盒|領飯盒)/i;

// Avoid paid / subscribe CTAs even if nearby text mentions 盒飯.
const DANGEROUS_TEXT_RE =
  /(?:訂閱|订阅|subscribe|購買|购买|buy|upgrade|升級|升级|充值|top.?up|payment|付款)/i;

// Confirmation after clicking: success indicators.
const SUCCESS_RE =
  /(?:success|claimed|received|已(?:領取|领取|簽到|签到)|簽到成功|签到成功|成功|(?:reward|bonus|bento|lunch)\s*(?:claimed|received)|獲得|获得|恭喜|congratulat|\+?\s*\d+\s*(?:盒飯|盒饭|飯盒|饭盒|點|点))/i;

// Already claimed: no need to click.
const ALREADY_CLAIMED_RE =
  /(?:already\s*(?:claimed|checked.?in|signed.?in)|已(?:領取|领取|簽到|签到)|(?:today|今[天日]).*(?:已|done|領過|领过)|明[天日].*(?:再來|再来|come\s*back)|come\s*back\s*tomorrow)/i;

// ─── Core Logic ─────────────────────────────────────────────────────────────────

async function isLoggedOut(page) {
  for (const pattern of LOGIN_PATTERNS) {
    const loginBtn = page.getByRole('button', { name: pattern, exact: false });
    const visible = await loginBtn.first().isVisible().catch(() => false);
    if (visible) return true;
  }
  const url = page.url();
  return /\/(login|logon|h5-login|sign-?in)/i.test(url);
}

function claimLocators(page) {
  return page
    .locator('button:visible, [role="button"]:visible, a:visible, div[class*="btn"]:visible, span[class*="btn"]:visible')
    .filter({ hasText: CLAIM_TEXT_RE })
    .filter({ hasNotText: DANGEROUS_TEXT_RE });
}

async function bodyLooksClaimedOrSuccess(page) {
  const body = await page.locator('body').innerText();
  if (SUCCESS_RE.test(body)) return 'success';
  if (ALREADY_CLAIMED_RE.test(body)) return 'already';
  return null;
}

async function clickClaimAndConfirm(page, btn, source) {
  log(`Found claim control on ${source}. Clicking…`);
  await btn.first().click({ timeout: 10_000 });
  await waitForStable(page, 2000);

  // Some UIs need a second confirm ("確認" / "确定" / "OK").
  const confirm = page
    .locator('button:visible, [role="button"]:visible')
    .filter({ hasText: /^(?:確認|确定|確認領取|确定领取|OK|Confirm|Got it|知道了|好的)$/i });
  if ((await confirm.count()) === 1) {
    log('Clicking confirmation dialog…');
    await confirm.click();
    await waitForStable(page, 1500);
  }

  const status = await bodyLooksClaimedOrSuccess(page);
  if (status === 'success') {
    log(`✅ Daily OiiOii 盒飯 claim succeeded (${source}).`);
    await saveScreenshot(page, 'claim-success');
    return true;
  }
  if (status === 'already') {
    log('✅ Daily 盒飯 was already claimed today.');
    await saveScreenshot(page, 'already-claimed');
    return true;
  }

  // Click without clear toast can still succeed; treat as soft success if button vanished.
  const remaining = await claimLocators(page).count();
  if (remaining === 0) {
    log(`✅ Claim button disappeared after click (${source}); treating as success.`);
    await saveScreenshot(page, 'claim-button-gone');
    return true;
  }

  await saveScreenshot(page, 'claim-unconfirmed');
  warn(`Claim click on ${source} did not produce a recognised confirmation.`);
  return false;
}

async function tryClaimOnPage(page, source) {
  // Popup / modal first (common after login).
  const dialogClaim = page
    .locator(
      '[class*="modal"] :is(button, [role="button"], a, div):visible, ' +
        '[class*="dialog"] :is(button, [role="button"], a, div):visible, ' +
        '[class*="popup"] :is(button, [role="button"], a, div):visible, ' +
        '[class*="drawer"] :is(button, [role="button"], a, div):visible, ' +
        '[class*="toast"] :is(button, [role="button"], a, div):visible',
    )
    .filter({ hasText: CLAIM_TEXT_RE })
    .filter({ hasNotText: DANGEROUS_TEXT_RE });

  if ((await dialogClaim.count()) >= 1) {
    return clickClaimAndConfirm(page, dialogClaim, `${source} popup`);
  }

  const claimButton = claimLocators(page);
  const claimCount = await claimButton.count();

  if (claimCount === 0) {
    const status = await bodyLooksClaimedOrSuccess(page);
    if (status === 'already' || status === 'success') {
      log(status === 'success' ? '✅ Daily OiiOii 盒飯 already reflected as claimed.' : '✅ Daily 盒飯 was already claimed today.');
      await saveScreenshot(page, 'already-claimed');
      return true;
    }
    return null; // nothing here
  }

  if (claimCount > 1) {
    warn(`Found ${claimCount} possible claim controls on ${source}; clicking the first safe match.`);
  }
  return clickClaimAndConfirm(page, claimButton, source);
}

async function tryClaimOnce(browser, state) {
  const context = await browser.newContext({
    ...(state ? { storageState: state.file } : {}),
    locale: 'zh-TW',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  });
  if (COOKIE_HEADER) await context.addCookies(parseCookieHeader(COOKIE_HEADER));

  const page = await context.newPage();

  try {
    log('Navigating to OiiOii…');
    await page.goto(LOCALE_HOME, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await waitForStable(page);

    if (await isLoggedOut(page)) {
      await saveScreenshot(page, 'login-expired');
      fail(
        'The stored OiiOii login has expired. ' +
          'Refresh the OII_STORAGE_STATE_B64 or OII_COOKIE secret. ' +
          'This workflow never bypasses OTP, Google, or CAPTCHA verification.',
      );
    }

    log('Session looks valid. Searching for daily 盒飯 claim…');

    // Homepage / popup first
    const homeResult = await tryClaimOnPage(page, 'home');
    if (homeResult === true) return true;

    // Walk likely reward pages
    for (const path of REWARD_PATHS.slice(2)) {
      const url = path.startsWith('http') ? path : `https://www.oiioii.ai${path}`;
      log(`Trying ${url}…`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await waitForStable(page);

      if (await isLoggedOut(page)) {
        await saveScreenshot(page, 'login-expired');
        fail('Session expired while navigating. Update the secret.');
      }

      const result = await tryClaimOnPage(page, path);
      if (result === true) return true;
    }

    await saveScreenshot(page, 'no-claim-button');
    return false;
  } finally {
    await context.close();
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  if (!STATE_B64 && !COOKIE_HEADER) {
    fail('Set OII_STORAGE_STATE_B64 (preferred) or OII_COOKIE in GitHub Actions secrets.');
  }

  const state = await storageStateFile();
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  try {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      log(`\n── Attempt ${attempt}/${MAX_RETRIES} ──`);
      try {
        const ok = await tryClaimOnce(browser, state);
        if (ok) {
          log('Done.');
          return;
        }
      } catch (err) {
        // Login failures are fatal — don't retry
        if (/expired|login|secret/i.test(err.message)) throw err;
        warn(`Attempt ${attempt} failed: ${err.message}`);
      }

      if (attempt < MAX_RETRIES) {
        const delay = attempt * 5_000;
        log(`Waiting ${delay / 1000}s before retry…`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    fail(
      'No daily 盒飯 claim control was found after all retries. ' +
        'The site UI may have changed; update selectors in scripts/claim-lunch.mjs. ' +
        'Check screenshots in the workflow artifacts for details.',
    );
  } finally {
    await browser.close();
    if (state) await rm(state.directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
