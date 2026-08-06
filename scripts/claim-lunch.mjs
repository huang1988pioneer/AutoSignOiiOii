import { chromium, firefox } from 'playwright';
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
// chromium (default) | firefox | edge (fallbacks).
// Aliases: chrome → chromium, msedge → edge.
const BROWSER_NAME = (process.env.OII_BROWSER || 'chromium').toLowerCase().trim();

// Pages that often host daily 盒飯 check-in UI.
// Screenshot (2026-08): claim control lives in the top-right account/coin drawer on /home.
const REWARD_PATHS = [
  '/zh-Hant/home',
  '/home',
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
 * Resolve Playwright engine + launch/context options from OII_BROWSER.
 * Firefox / Edge are user-selectable fallbacks when Chromium is blocked or unstable.
 * Edge uses Chromium with channel "msedge" (system or Playwright-managed Edge).
 */
function resolveBrowserEngine() {
  if (BROWSER_NAME === 'firefox') {
    return {
      name: 'firefox',
      engine: firefox,
      launchOptions: {
        headless: true,
      },
      contextOptions: {
        locale: 'zh-TW',
        // Use Firefox's own UA; do not spoof Chrome on Gecko.
      },
    };
  }

  if (BROWSER_NAME === 'edge' || BROWSER_NAME === 'msedge') {
    return {
      name: 'edge',
      engine: chromium,
      launchOptions: {
        headless: true,
        channel: 'msedge',
        args: ['--disable-blink-features=AutomationControlled'],
      },
      contextOptions: {
        locale: 'zh-TW',
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0',
      },
    };
  }

  if (BROWSER_NAME === 'chromium' || BROWSER_NAME === 'chrome') {
    return {
      name: 'chromium',
      engine: chromium,
      launchOptions: {
        headless: true,
        args: ['--disable-blink-features=AutomationControlled'],
      },
      contextOptions: {
        locale: 'zh-TW',
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      },
    };
  }

  fail(
    `Unsupported OII_BROWSER="${BROWSER_NAME}". Use "chromium" (default), "firefox", or "edge".`,
  );
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

// Daily 盒飯 / check-in button or row text (Traditional + Simplified + English).
// Matches e.g. 「升級會員，每日簽到領額外盒飯」 from the account drawer.
const CLAIM_TEXT_RE =
  /(?:daily\s*(?:check.?in|claim|reward|bonus|sign.?in)|check.?in|sign.?in|claim\s*(?:daily|reward|bonus|bento|lunch)|立即(?:簽到|签到|領取|领取)|(?:每日|每天|今天|今日).*(?:簽到|签到|領取|领取)|(?:簽到|签到).*(?:盒飯|盒饭|飯盒|饭盒|獎勵|奖励|額外|额外)?|(?:領取|领取).*(?:盒飯|盒饭|飯盒|饭盒|獎勵|奖励|額外|额外)|(?:盒飯|盒饭|飯盒|饭盒).*(?:簽到|签到|領取|领取)|打卡|領盒飯|领盒饭|领饭盒|領飯盒|領額外盒飯|领额外盒饭)/i;

// Pure paid / subscribe CTAs — do NOT use alone (see isDangerousClaimText).
// Note: daily row copy may include「升級會員」as marketing text; that is still a free daily claim.
const DANGEROUS_TEXT_RE =
  /(?:訂閱|订阅|subscribe|購買|购买|buy|upgrade|升級|升级|充值|top.?up|payment|付款|邀請好友|邀请好友|invite)/i;

// True daily-check-in intent (overrides nearby "upgrade" marketing wording).
const DAILY_INTENT_RE =
  /(?:每日|每天|今天|今日).*(?:簽到|签到|領取|领取)|(?:簽到|签到).*(?:盒飯|盒饭|額外|额外)|daily\s*(?:check.?in|claim|sign.?in)|check.?in|sign.?in/i;

// The pink "+ 20" control next to the daily row in the account drawer.
// Button text may be plain "+ 20" or include a coin glyph / icon spacing.
const PLUS_REWARD_RE = /^\s*(?:[^\d\w]{0,4}\s*)?\+?\s*\d{1,4}\s*$/u;

// Confirmation after clicking: success indicators.
const SUCCESS_RE =
  /(?:success|claimed|received|已(?:領取|领取|簽到|签到)|簽到成功|签到成功|成功|(?:reward|bonus|bento|lunch)\s*(?:claimed|received)|獲得|获得|恭喜|congratulat|\+?\s*\d+\s*(?:盒飯|盒饭|飯盒|饭盒|點|点))/i;

// Already claimed: no need to click.
const ALREADY_CLAIMED_RE =
  /(?:already\s*(?:claimed|checked.?in|signed.?in)|已(?:領取|领取|簽到|签到)|(?:today|今[天日]).*(?:已|done|領過|领过)|明[天日].*(?:再來|再来|come\s*back)|come\s*back\s*tomorrow|明日再來|明天再来)/i;

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

/**
 * Daily check-in rows often include marketing words like「升級會員」.
 * Allow those when the row clearly has daily sign-in intent.
 */
function isDangerousClaimText(text) {
  if (!text) return true;
  if (DAILY_INTENT_RE.test(text)) return false;
  return DANGEROUS_TEXT_RE.test(text);
}

function claimLocators(page) {
  return page
    .locator('button:visible, [role="button"]:visible, a:visible, div[class*="btn"]:visible, span[class*="btn"]:visible')
    .filter({ hasText: CLAIM_TEXT_RE });
}

/**
 * Site CSS modules expose the daily claim control as e.g. `_credit-claim-btn_1dzjy_205`.
 * Prefer this over fragile text/DOM ancestry matching.
 */
function creditClaimButtons(page) {
  return page.locator(
    'button[class*="credit-claim-btn"], [class*="credit-claim-btn"][role="button"], a[class*="credit-claim-btn"]',
  );
}

async function isAccountDrawerOpen(page) {
  // Prefer the real claim control or compact balance breakdown over loose page text.
  if ((await creditClaimButtons(page).count().catch(() => 0)) >= 1) {
    const btn = creditClaimButtons(page).first();
    if (await btn.isVisible().catch(() => false)) return true;
  }
  const markers = page.getByText(/通用盒飯\s*[:：]|通用盒饭\s*[:：]|專屬盒飯\s*[:：]|专属盒饭\s*[:：]|每日簽到領額外|每日签到领额外/i);
  return markers.first().isVisible().catch(() => false);
}

/**
 * CI failure: `_overlay_*` intercepts pointer events over the claim button.
 * Disable pointer-events on full-screen / backdrop overlays without closing the drawer
 * (do not click the overlay — that dismisses the account panel).
 */
async function neutralizePointerBlockingOverlays(page) {
  const disabled = await page.evaluate(() => {
    let count = 0;
    for (const el of document.querySelectorAll('div[class*="overlay"], div[class*="Overlay"], div[class*="mask"], div[class*="backdrop"]')) {
      const style = window.getComputedStyle(el);
      if (style.pointerEvents === 'none' || style.display === 'none' || style.visibility === 'hidden') continue;
      // Only touch large/fixed layers that typically sit above content.
      const rect = el.getBoundingClientRect();
      const coversViewport =
        rect.width >= window.innerWidth * 0.5 && rect.height >= window.innerHeight * 0.5;
      const looksLikeModuleOverlay = /overlay|mask|backdrop/i.test(el.className || '');
      if (!coversViewport && !looksLikeModuleOverlay) continue;
      // Never disable the claim button itself or its ancestors with claim-btn class.
      if (/credit-claim/i.test(el.className || '')) continue;
      el.style.setProperty('pointer-events', 'none', 'important');
      count += 1;
    }
    return count;
  });
  if (disabled > 0) log(`Neutralized pointer-events on ${disabled} overlay layer(s).`);
  return disabled;
}

/**
 * Robust click: normal → force → DOM click. Overlays often block Playwright actionability.
 */
async function robustClick(page, locator, label) {
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  await neutralizePointerBlockingOverlays(page);

  try {
    await locator.click({ timeout: 5_000 });
    log(`Clicked ${label} (normal).`);
    return;
  } catch (err) {
    warn(`Normal click failed on ${label}: ${err.message.split('\n')[0]}`);
  }

  await neutralizePointerBlockingOverlays(page);
  try {
    await locator.click({ timeout: 5_000, force: true });
    log(`Clicked ${label} (force).`);
    return;
  } catch (err) {
    warn(`Force click failed on ${label}: ${err.message.split('\n')[0]}`);
  }

  // Last resort: native DOM click (bypasses hit-testing).
  await locator.evaluate((el) => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    if (typeof el.click === 'function') el.click();
  });
  log(`Clicked ${label} (DOM dispatch).`);
}

/**
 * Open the top-right account / 盒飯 drawer shown in the product UI.
 * The daily +N claim control is inside this panel, not on the bare homepage.
 */
async function openAccountDrawer(page) {
  if (await isAccountDrawerOpen(page)) {
    log('Account drawer already visible.');
    return true;
  }

  const openers = [
    // Coin / balance chip in chrome: "52 BASE" (preferred — matches product screenshot).
    page
      .locator('button:visible, [role="button"]:visible, a:visible, div:visible, span:visible')
      .filter({ hasText: /^\s*\d{1,6}\s*(?:BASE|盒飯|盒饭)\s*$/i }),
    page
      .locator('button:visible, [role="button"]:visible, a:visible')
      .filter({ hasText: /\d{1,6}\s*(?:BASE|盒飯|盒饭)/i }),
    // Avatar / profile area near the top right
    page
      .locator('[class*="avatar"]:visible, [class*="Avatar"]:visible, img[alt*="avatar" i]:visible, img[class*="avatar" i]:visible')
      .locator('xpath=ancestor-or-self::*[self::button or @role="button" or self::a or self::div][1]'),
    page.getByRole('button', { name: /BASE|帳戶|账户|profile|account/i }),
  ];

  for (const opener of openers) {
    const count = await opener.count().catch(() => 0);
    for (let i = 0; i < Math.min(count, 8); i++) {
      const el = opener.nth(i);
      if (!(await el.isVisible().catch(() => false))) continue;
      const text = ((await el.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
      // Skip pure navigation / paid CTAs and huge containers.
      if (text.length > 40) continue;
      if (/購買|购买|訂閱|订阅|活動|活动|通知|邀請|邀请/.test(text) && !/(?:盒飯|盒饭|BASE)/i.test(text)) continue;
      log(`Opening account drawer via control: "${text.slice(0, 40) || '(icon)'}"…`);
      await robustClick(page, el, `drawer-opener "${text.slice(0, 24) || 'icon'}"`).catch(() => {});
      await waitForStable(page, 1200);
      if (await isAccountDrawerOpen(page)) {
        log('Account drawer opened.');
        return true;
      }
    }
  }

  warn('Could not confirm account drawer is open; will still search the page.');
  return false;
}

/**
 * Find the daily "+ N" claim control.
 * Preferred: CSS-module class `credit-claim-btn` observed in CI.
 * Fallback: row with 每日簽到 + pink +N button.
 */
async function findDailyPlusButton(page) {
  const byClass = creditClaimButtons(page);
  const classCount = await byClass.count().catch(() => 0);
  for (let i = 0; i < Math.min(classCount, 5); i++) {
    const btn = byClass.nth(i);
    if (!(await btn.isVisible().catch(() => false))) continue;
    const label = ((await btn.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
    log(`Found credit-claim-btn control${label ? ` ("${label.slice(0, 40)}")` : ''}.`);
    return btn;
  }

  const rows = page.locator('div, li, section, article, tr').filter({ hasText: DAILY_INTENT_RE });
  const rowCount = await rows.count().catch(() => 0);
  for (let i = 0; i < Math.min(rowCount, 12); i++) {
    const row = rows.nth(i);
    if (!(await row.isVisible().catch(() => false))) continue;
    const rowText = ((await row.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
    if (!DAILY_INTENT_RE.test(rowText)) continue;
    // Prefer compact rows (the drawer item), not the whole page shell.
    if (rowText.length > 120) continue;

    const plusBtn = row
      .locator('button:visible, [role="button"]:visible, a:visible, div[class*="btn"]:visible, span[class*="btn"]:visible')
      .filter({ hasText: PLUS_REWARD_RE });
    if ((await plusBtn.count()) >= 1) {
      log(`Found daily +N control in row: "${rowText.slice(0, 60)}"`);
      return plusBtn.first();
    }

    // Fallback: any clickable in the row that is not pure upgrade/purchase without daily intent.
    const anyBtn = row.locator('button:visible, [role="button"]:visible, a:visible').last();
    if ((await anyBtn.count()) >= 1 && (await anyBtn.isVisible().catch(() => false))) {
      const btnText = ((await anyBtn.innerText().catch(() => '')) || '').trim();
      if (!/^(?:升級會員|升级会员|購買盒飯|购买盒饭|升級|升级)$/i.test(btnText)) {
        log(`Found daily row action "${btnText || '(empty)'}" for: "${rowText.slice(0, 60)}"`);
        return anyBtn;
      }
    }
  }

  // Global fallback: visible "+ N" near daily-sign-in text.
  const globalPlus = page
    .locator('button:visible, [role="button"]:visible, a:visible, div[class*="btn"]:visible')
    .filter({ hasText: /\+\s*(?:20|50|\d{1,3})\s*$/ });
  const plusCount = await globalPlus.count().catch(() => 0);
  for (let i = 0; i < Math.min(plusCount, 8); i++) {
    const btn = globalPlus.nth(i);
    if (!(await btn.isVisible().catch(() => false))) continue;
    const className = (await btn.getAttribute('class').catch(() => '')) || '';
    if (/credit-claim/i.test(className)) {
      log('Found global +N with credit-claim class.');
      return btn;
    }
    const nearby = await btn.evaluate((el) => {
      const parent = el.closest('div, li, section, article') || el.parentElement;
      return (parent?.innerText || el.innerText || '').replace(/\s+/g, ' ').trim();
    }).catch(() => '');
    if (DAILY_INTENT_RE.test(nearby) || /額外盒飯|额外盒饭|簽到|签到/.test(nearby)) {
      log(`Found global +N near daily text: "${nearby.slice(0, 60)}"`);
      return btn;
    }
  }

  return null;
}

async function bodyLooksClaimedOrSuccess(page) {
  const body = await page.locator('body').innerText();
  // Prefer "already" over generic "成功" which appears in marketing copy.
  if (ALREADY_CLAIMED_RE.test(body)) return 'already';
  if (SUCCESS_RE.test(body)) return 'success';
  return null;
}

async function claimButtonStillPresent(page) {
  const btn = await findDailyPlusButton(page);
  if (!btn) return false;
  // After a successful claim the pink +N often disables, renames, or vanishes.
  const disabled = await btn.isDisabled().catch(() => false);
  if (disabled) return false;
  const text = ((await btn.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
  if (/已領|已领|已簽|已签|claimed|done|完成/i.test(text)) return false;
  return true;
}

async function clickClaimAndConfirm(page, btn, source) {
  const label = ((await btn.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
  log(`Found claim control on ${source}${label ? ` ("${label.slice(0, 40)}")` : ''}. Clicking…`);
  try {
    await robustClick(page, btn, `claim (${source})`);
  } catch (err) {
    await saveScreenshot(page, 'claim-click-failed');
    throw err;
  }
  await waitForStable(page, 2000);

  // Some UIs need a second confirm ("確認" / "确定" / "OK").
  const confirm = page
    .locator('button:visible, [role="button"]:visible')
    .filter({ hasText: /^(?:確認|确定|確認領取|确定领取|OK|Confirm|Got it|知道了|好的)$/i });
  if ((await confirm.count()) === 1) {
    log('Clicking confirmation dialog…');
    await robustClick(page, confirm.first(), 'confirm dialog').catch(async () => {
      await confirm.first().click({ force: true }).catch(() => {});
    });
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

  // Soft success: daily +N control disappeared / disabled after click.
  if (!(await claimButtonStillPresent(page))) {
    log(`✅ Claim control gone or disabled after click (${source}); treating as success.`);
    await saveScreenshot(page, 'claim-button-gone');
    return true;
  }

  await saveScreenshot(page, 'claim-unconfirmed');
  warn(`Claim click on ${source} did not produce a recognised confirmation.`);
  return false;
}

async function tryClaimOnPage(page, source) {
  // Preferred path: account drawer → credit-claim-btn / pink "+ N" (current OiiOii UI).
  await openAccountDrawer(page);
  const plusBtn = await findDailyPlusButton(page);
  if (plusBtn) {
    return clickClaimAndConfirm(page, plusBtn, `${source} account-drawer`);
  }

  // Popup / modal claim controls.
  const dialogCandidates = page.locator(
    '[class*="modal"] :is(button, [role="button"], a, div):visible, ' +
      '[class*="dialog"] :is(button, [role="button"], a, div):visible, ' +
      '[class*="popup"] :is(button, [role="button"], a, div):visible, ' +
      '[class*="drawer"] :is(button, [role="button"], a, div):visible, ' +
      '[class*="toast"] :is(button, [role="button"], a, div):visible',
  );
  const dialogCount = await dialogCandidates.count().catch(() => 0);
  for (let i = 0; i < Math.min(dialogCount, 20); i++) {
    const el = dialogCandidates.nth(i);
    const text = ((await el.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
    const className = (await el.getAttribute('class').catch(() => '')) || '';
    if (/credit-claim/i.test(className)) {
      return clickClaimAndConfirm(page, el, `${source} popup-class`);
    }
    if (!CLAIM_TEXT_RE.test(text) && !DAILY_INTENT_RE.test(text) && !PLUS_REWARD_RE.test(text)) continue;
    if (isDangerousClaimText(text) && !PLUS_REWARD_RE.test(text)) continue;
    return clickClaimAndConfirm(page, el, `${source} popup`);
  }

  // Generic visible claim-like controls (filter dangerous marketing CTAs carefully).
  const claimButton = claimLocators(page);
  const claimCount = await claimButton.count();
  const safeButtons = [];
  for (let i = 0; i < Math.min(claimCount, 15); i++) {
    const el = claimButton.nth(i);
    const text = ((await el.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
    if (isDangerousClaimText(text)) continue;
    safeButtons.push(el);
  }

  if (safeButtons.length === 0) {
    const status = await bodyLooksClaimedOrSuccess(page);
    if (status === 'already' || status === 'success') {
      log(status === 'success' ? '✅ Daily OiiOii 盒飯 already reflected as claimed.' : '✅ Daily 盒飯 was already claimed today.');
      await saveScreenshot(page, 'already-claimed');
      return true;
    }
    return null; // nothing here
  }

  if (safeButtons.length > 1) {
    warn(`Found ${safeButtons.length} possible claim controls on ${source}; clicking the first safe match.`);
  }
  return clickClaimAndConfirm(page, safeButtons[0], source);
}

async function tryClaimOnce(browser, state, contextOptions = {}) {
  const context = await browser.newContext({
    ...(state ? { storageState: state.file } : {}),
    ...contextOptions,
  });
  if (COOKIE_HEADER) await context.addCookies(parseCookieHeader(COOKIE_HEADER));

  const page = await context.newPage();

  try {
    log('Navigating to OiiOii…');
    // Prefer /home — account chip + daily claim drawer live there (see product screenshot).
    await page.goto('https://www.oiioii.ai/zh-Hant/home', {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    await waitForStable(page);

    if (await isLoggedOut(page)) {
      // Fallback to locale root if /home redirects oddly while logged out check is noisy.
      await page.goto(LOCALE_HOME, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await waitForStable(page);
    }

    if (await isLoggedOut(page)) {
      await saveScreenshot(page, 'login-expired');
      fail(
        'The stored OiiOii login has expired. ' +
          'Refresh the OII_STORAGE_STATE_B64 or OII_COOKIE secret. ' +
          'This workflow never bypasses OTP, Google, or CAPTCHA verification.',
      );
    }

    log('Session looks valid. Searching for daily 盒飯 claim…');

    // Homepage / account drawer first
    const homeResult = await tryClaimOnPage(page, 'home');
    if (homeResult === true) return true;

    // Walk likely reward pages (skip the first few home paths we already covered).
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
  const { name: browserName, engine, launchOptions, contextOptions } = resolveBrowserEngine();
  log(`Using Playwright browser: ${browserName}`);
  const browser = await engine.launch(launchOptions);

  try {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      log(`\n── Attempt ${attempt}/${MAX_RETRIES} ──`);
      try {
        const ok = await tryClaimOnce(browser, state, contextOptions);
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
      'Daily 盒飯 claim did not succeed after all retries. ' +
        'Either the claim control was missing, clicks were blocked (e.g. overlay), or confirmation was not detected. ' +
        'Update selectors/click handling in scripts/claim-lunch.mjs if the site UI changed. ' +
        (browserName === 'chromium'
          ? 'If Chromium is blocked, retry with OII_BROWSER=firefox or OII_BROWSER=edge. '
          : '') +
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
