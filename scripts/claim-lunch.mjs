import { chromium } from 'playwright';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME_URL = 'https://www.oiioii.ai/';
const STATE_B64 = process.env.OII_STORAGE_STATE_B64;
const COOKIE_HEADER = process.env.OII_COOKIE;
function fail(message) {
  console.error(`::error::${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

function parseCookieHeader(header) {
  return header.split(';').map((part) => {
    const separator = part.indexOf('=');
    if (separator < 1) throw new Error('OII_COOKIE contains an invalid cookie segment.');
    return {
      name: part.slice(0, separator).trim(),
      value: part.slice(separator + 1).trim(),
      url: HOME_URL,
      sameSite: 'Lax',
    };
  }).filter(({ name, value }) => name && value);
}

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

async function main() {
  if (!STATE_B64 && !COOKIE_HEADER) {
    fail('Set OII_STORAGE_STATE_B64 (preferred) or OII_COOKIE in GitHub Actions secrets.');
  }

  const state = await storageStateFile();
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext(state ? { storageState: state.file } : {});
    if (COOKIE_HEADER) await context.addCookies(parseCookieHeader(COOKIE_HEADER));
    const page = await context.newPage();
    await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForTimeout(1_500);

    // The login button is visible to unauthenticated visitors on the current site.
    const loginVisible = await page.getByRole('button', { name: 'Sign up / Log in', exact: true }).isVisible().catch(() => false);
    if (loginVisible) {
      fail('The stored OiiOii login has expired. Refresh the secret; this workflow never bypasses OTP, Google, or CAPTCHA verification.');
    }

    // Claim only a button whose accessible label explicitly indicates a daily reward.
    // This deliberately excludes purchase, subscription, and project-creation buttons.
    const claimButton = page.locator(
      'button:visible, [role="button"]:visible'
    ).filter({ hasText: /(?:daily\s*(?:check.?in|claim|reward)|check.?in|claim\s*(?:daily|reward)|簽到|签到|領取.*(?:盒飯|盒饭)|领取.*(?:盒飯|盒饭))/i });
    const claimCount = await claimButton.count();

    if (claimCount === 0) {
      const text = await page.locator('body').innerText();
      if (/(?:already\s*(?:claimed|checked.?in)|已(?:領取|领取|簽到|签到))/i.test(text)) {
        console.log('Daily lunch was already claimed.');
        return;
      }
      fail('No daily-lunch claim button was found. The site UI may have changed; update the selector in scripts/claim-lunch.mjs.');
    }
    if (claimCount > 1) {
      fail(`Found ${claimCount} possible daily-claim buttons; refusing to guess.`);
    }

    await claimButton.click();
    await page.waitForTimeout(1_000);
    const resultText = await page.locator('body').innerText();
    if (!/(?:success|claimed|received|已(?:領取|领取|簽到|签到)|成功)/i.test(resultText)) {
      fail('The claim click did not produce a recognised confirmation. Review the saved screenshot and logs before retrying.');
    }
    console.log('Daily OiiOii lunch claim succeeded.');
  } finally {
    await browser.close();
    if (state) await rm(state.directory, { recursive: true, force: true });
  }
}

main().catch(async (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
