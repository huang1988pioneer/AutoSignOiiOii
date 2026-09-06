// Read only the account points pill, never rewards, expiry notices or pricing.
export function parsePoints(text) {
  const match = String(text ?? '').trim().match(
    /^(?:(?:點數|点数|Credits|Points)\s*[:：]?\s*)?(\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\s*(?:FREE|BASE|PRO|PLUS|PREMIUM|盒飯|盒饭|點|点)?$/i,
  );
  if (!match) return null;
  const value = Number(match[0].match(/\d[\d,.]*/)[0].replaceAll(',', ''));
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export async function readCurrentPoints(page) {
  const pills = page.locator(
    'button[title="點數"], button[title="点数"], button[title="Credits"], ' +
    'button[class*="_pill_"], div[class*="_credit-container_"]',
  );
  const values = new Set();
  for (let index = 0; index < await pills.count(); index++) {
    const pill = pills.nth(index);
    if (!(await pill.isVisible())) continue;
    const value = parsePoints(await pill.innerText({ timeout: 2000 }));
    if (value !== null) values.add(value);
  }
  return values.size === 1 ? [...values][0] : null;
}
