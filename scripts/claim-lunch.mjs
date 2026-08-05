import { chromium } from 'playwright';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ─── Configuration ──────────────────────────────────────────────────────────────
const HOME_URL = 'https://www.oiioii.ai/';
const ACCOUNT_NAME = process.env.OII_ACCOUNT_NAME ?? 'default';
const STATE_B64 = process.env.OII_STORAGE_STATE_B64;
const COOKIE_HEADER = process.env.OII_COOKIE;
const MAX_RETRIES = Number(process.env.OII_MAX_RETRIES) || 3;
const SCREENSHOT_DIR = process.env.OII_SCREENSHOT_DIR || './screenshots';

// ─── Helpers ────────────────────────────────────────────────────────────────────

function fail(message) {
  console.error(`::error::[account ${ACCOUNT_NAME}] ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

function warn(message) {
  console.warn(`::warning::${message}`);
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
    const path = join(SCREENSHOT_DIR, `${label}_${ts}.png`);
    await page.screenshot({ path, fullPage: true });
    console.log(`Screenshot saved: ${path}`);
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
];

// Daily claim button text patterns (Chinese + English).
const CLAIM_TEXT_RE =
  /(?:daily\s*(?:check.?in|claim|reward|bonus|sign.?in)|check.?in|sign.?in|claim\s*(?:daily|reward|bonus)|簽到|签到|領取.*(?:盒飯|盒饭|獎勵|奖励)|领取.*(?:盒飯|盒饭|獎勵|奖励)|每日.*(?:獎勵|奖励|盒飯|盒饭|簽到|签到)|打卡|領盒飯|领盒饭)/i;

// Confirmation after clicking: success indicators.
const SUCCESS_RE =
  /(?:success|claimed|received|已(?:領取|领取|簽到|签到)|成功|(?:reward|bonus)\s*(?:claimed|received)|獲得|获得|恭喜|congratulat)/i;

// Already claimed: no need to click.
const ALREADY_CLAIMED_RE =
  /(?:already\s*(?:claimed|checked.?in|signed.?in)|已(?:領取|领取|簽到|签到)|(?:today|今[天日]).*(?:已|done)|明[天日].*(?:再來|再来|come\s*back))/i;

// ─── Core Logic ─────────────────────────────────────────────────────────────────

async function tryClaimOnce(browser, state) {
  const context = await browser.newContext(state ? { storageState: state.file } : {});
  if (COOKIE_HEADER) await context.addCookies(parseCookieHeader(COOKIE_HEADER));

  const page = await context.newPage();

  // 1. Navigate to homepage
  console.log('Navigating to OiiOii…');
  await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await waitForStable(page);

  // 2. Check login state
  for (const pattern of LOGIN_PATTERNS) {
    const loginBtn = page.getByRole('button', { name: pattern, exact: true });
    const visible = await loginBtn.isVisible().catch(() => false);
    if (visible) {
      await saveScreenshot(page, 'login-expired');
      fail(
        'The stored OiiOii login has expired. ' +
          'Refresh the OII_STORAGE_STATE_B64 or OII_COOKIE secret. ' +
          'This workflow never bypasses OTP, Google, or CAPTCHA verification.',
      );
    }
  }
  // Also detect login page redirect
  if (page.url().includes('/login') || page.url().includes('/logon') || page.url().includes('/h5-login')) {
    await saveScreenshot(page, 'login-redirect');
    fail('Redirected to login page — session has expired. Update the secret.');
  }

  console.log('Logged in successfully. Looking for daily claim…');

  // 3. Check for popup / modal daily-claim dialog
  //    Some sites show a reward popup automatically after login.
  const dialogClaim = page.locator(
    '[class*="modal"] :is(button, [role="button"]):visible, ' +
      '[class*="dialog"] :is(button, [role="button"]):visible, ' +
      '[class*="popup"] :is(button, [role="button"]):visible, ' +
      '[class*="drawer"] :is(button, [role="button"]):visible',
  ).filter({ hasText: CLAIM_TEXT_RE });

  const dialogCount = await dialogClaim.count();
  if (dialogCount === 1) {
    console.log('Found daily claim in a popup/dialog. Clicking…');
    await dialogClaim.click();
    await waitForStable(page, 1500);
    const body = await page.locator('body').innerText();
    if (SUCCESS_RE.test(body) || ALREADY_CLAIMED_RE.test(body)) {
      console.log('✅ Daily OiiOii lunch claim succeeded (popup).');
      await saveScreenshot(page, 'claim-success-popup');
      await context.close();
      return true;
    }
  }

  // 4. Look for claim button on the page
  const claimButton = page
    .locator('button:visible, [role="button"]:visible, a:visible')
    .filter({ hasText: CLAIM_TEXT_RE });
  const claimCount = await claimButton.count();

  if (claimCount === 0) {
    // Maybe already claimed today?
    const body = await page.locator('body').innerText();
    if (ALREADY_CLAIMED_RE.test(body)) {
      console.log('✅ Daily lunch was already claimed today.');
      await saveScreenshot(page, 'already-claimed');
      await context.close();
      return true;
    }

    // Try navigating to profile / reward page where claim might live.
    const rewardPaths = ['/profile', '/lucky-draw'];
    for (const path of rewardPaths) {
      console.log(`Trying ${path}…`);
      await page.goto(`https://www.oiioii.ai${path}`, {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      });
      await waitForStable(page);

      const btn = page
        .locator('button:visible, [role="button"]:visible, a:visible')
        .filter({ hasText: CLAIM_TEXT_RE });
      const count = await btn.count();
      if (count === 1) {
        console.log(`Found claim button on ${path}. Clicking…`);
        await btn.click();
        await waitForStable(page, 1500);
        const resultText = await page.locator('body').innerText();
        if (SUCCESS_RE.test(resultText) || ALREADY_CLAIMED_RE.test(resultText)) {
          console.log(`✅ Daily OiiOii lunch claim succeeded (${path}).`);
          await saveScreenshot(page, 'claim-success');
          await context.close();
          return true;
        }
      }

      const bodyText = await page.locator('body').innerText();
      if (ALREADY_CLAIMED_RE.test(bodyText)) {
        console.log('✅ Daily lunch was already claimed today.');
        await saveScreenshot(page, 'already-claimed');
        await context.close();
        return true;
      }
    }

    await saveScreenshot(page, 'no-claim-button');
    await context.close();
    return false; // Will retry
  }

  if (claimCount > 1) {
    await saveScreenshot(page, 'multiple-claim-buttons');
    warn(`Found ${claimCount} possible daily-claim buttons.`);
    // Try clicking the first one as best guess
    console.log('Attempting to click the first matching button…');
    await claimButton.first().click();
  } else {
    console.log('Found exactly one claim button. Clicking…');
    await claimButton.click();
  }

  await waitForStable(page, 1500);

  const resultText = await page.locator('body').innerText();
  if (SUCCESS_RE.test(resultText)) {
    console.log('✅ Daily OiiOii lunch claim succeeded.');
    await saveScreenshot(page, 'claim-success');
    await context.close();
    return true;
  }

  if (ALREADY_CLAIMED_RE.test(resultText)) {
    console.log('✅ Daily lunch was already claimed today.');
    await saveScreenshot(page, 'already-claimed');
    await context.close();
    return true;
  }

  await saveScreenshot(page, 'claim-unconfirmed');
  warn('Claim click did not produce a recognised confirmation.');
  await context.close();
  return false;
}

// ─── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  if (!STATE_B64 && !COOKIE_HEADER) {
    fail('Set OII_STORAGE_STATE_B64 (preferred) or OII_COOKIE in GitHub Actions secrets.');
  }

  const state = await storageStateFile();
  const browser = await chromium.launch({ headless: true });

  try {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      console.log(`\n── Attempt ${attempt}/${MAX_RETRIES} ──`);
      try {
        const ok = await tryClaimOnce(browser, state);
        if (ok) return;
      } catch (err) {
        // Login failures are fatal — don't retry
        if (err.message.includes('expired') || err.message.includes('login')) throw err;
        warn(`Attempt ${attempt} failed: ${err.message}`);
      }

      if (attempt < MAX_RETRIES) {
        const delay = attempt * 5_000;
        console.log(`Waiting ${delay / 1000}s before retry…`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    fail(
      'No daily-lunch claim button was found after all retries. ' +
        'The site UI may have changed; update the selectors in scripts/claim-lunch.mjs. ' +
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
