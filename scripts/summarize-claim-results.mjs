import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const inputDir = process.argv[2] || 'collected';
const outputDir = process.env.OII_SUMMARY_DIR || 'artifacts';
const expectedAccounts = Number(process.env.OII_EXPECTED_ACCOUNTS || 33);

function walkJsonFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walkJsonFiles(path) : entry.name.endsWith('.json') ? [path] : [];
  });
}

function escapeCell(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

function compact(value, length = 120) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > length ? `${text.slice(0, length - 1)}…` : text || '—';
}

const byAccount = new Map();
for (const file of walkJsonFiles(inputDir)) {
  try {
    const row = JSON.parse(readFileSync(file, 'utf8'));
    if (row && typeof row === 'object' && row.account != null) byAccount.set(Number(row.account), row);
  } catch (error) {
    console.warn(`Skipping invalid result ${file}: ${error.message}`);
  }
}

const rows = Array.from({ length: expectedAccounts }, (_, index) => {
  const account = index + 1;
  return byAccount.get(account) || {
    account,
    name: `account-${account}`,
    status: 'skipped',
    message: 'No login state or cookie secret configured.',
  };
});

const counts = {
  checked_in: rows.filter((row) => row.status === 'checked_in').length,
  failed: rows.filter((row) => row.status === 'failed').length,
  skipped: rows.filter((row) => row.status === 'skipped').length,
};
const configured = counts.checked_in + counts.failed;
const headline = counts.failed ? `⚠️ ${counts.failed} account(s) need attention` : configured ? '✅ All configured accounts OK' : '⚠️ No configured accounts';
const runUrl = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
  ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
  : null;

const lines = [
  '## OiiOii daily lunch',
  '',
  `**${headline}**`,
  '',
  '| Metric | Count |',
  '| --- | ---: |',
  `| Configured (ran) | ${configured} |`,
  `| Claim successful | ${counts.checked_in} |`,
  `| Failed | ${counts.failed} |`,
  `| Skipped (no secret) | ${counts.skipped} |`,
  '',
  ...(runUrl ? [`- Workflow run: ${runUrl}`, ''] : []),
];

const failures = rows.filter((row) => row.status === 'failed');
if (failures.length) {
  lines.push('### ⚠️ Needs attention', '', '| # | Account | Error |', '| ---: | --- | --- |');
  for (const row of failures) lines.push(`| ${row.account} | ${escapeCell(row.name)} | ${escapeCell(compact(row.message, 160))} |`);
  lines.push('');
}

const activeRows = rows.filter((row) => row.status !== 'skipped');
if (activeRows.length) {
  lines.push('### Account results', '', '| # | Account | Status | Note |', '| ---: | --- | --- | --- |');
  for (const row of activeRows) {
    const badge = row.status === 'checked_in' ? '✅ checked_in' : '❌ failed';
    lines.push(`| ${row.account} | ${escapeCell(row.name)} | ${badge} | ${escapeCell(compact(row.message))} |`);
  }
  lines.push('');
}

lines.push('---', '', '<sub>Status: `checked_in` = claimed this run or already claimed today · `failed` = session or claim issue · `skipped` = secret not configured</sub>', '');
const markdown = lines.join('\n');
mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'oiioii-daily-summary.md'), markdown);
writeFileSync(join(outputDir, 'oiioii-daily-summary.json'), `${JSON.stringify({ generatedAt: new Date().toISOString(), counts, rows }, null, 2)}\n`);
console.log(markdown);
if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, markdown, { flag: 'a' });
