import { chromium, devices } from 'playwright-core';

/** verify-search-mount.mjs — SubchatSearch ist in der Sub-Chat-Liste gemountet
 *  + interaktiv + ruft die member-gegate /api/subchats/search (iPhone 13). */

const BASE = 'http://127.0.0.1:4200';
const C = process.env.SESSION_COOKIE;
const eq = C.indexOf('=');
const browser = await chromium
  .launch({ channel: 'chrome' })
  .catch(() => chromium.launch());
const ctx = await browser.newContext({ ...devices['iPhone 13'] });
await ctx.addCookies([
  { name: C.slice(0, eq), value: C.slice(eq + 1), domain: '127.0.0.1', path: '/' },
]);
const errors = [];
const apiCalls = [];
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push('console.error: ' + m.text());
});
page.on('response', (r) => {
  if (r.url().includes('/api/subchats/search')) apiCalls.push(r.status());
});

await page.goto(`${BASE}/workspaces/intern/subchats`, {
  waitUntil: 'domcontentloaded',
});
await page.waitForTimeout(800);
const field = page.locator('input[aria-label="Sub-Chat-Wissen durchsuchen"]');
const fieldVisible = await field.isVisible().catch(() => false);
const box = await field.boundingBox().catch(() => null);
await field.fill('PV Auswertung Zaehler');
await page.keyboard.press('Enter');
await page.waitForTimeout(1500);
const state =
  (await page.evaluate(
    () =>
      document.body.innerText.match(
        /Suche läuft|Keine Treffer|Suche fehlgeschlagen/,
      )?.[0],
  )) || 'results-or-idle';
const overflow = await page.evaluate(
  () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
);
await page.screenshot({ path: '/tmp/search-mounted.png' });

console.log(
  JSON.stringify(
    {
      fieldVisible,
      fieldHeight: box ? Math.round(box.height) : null,
      apiCalls,
      searchState: state,
      overflow,
      errors: errors.slice(0, 6),
      VERDICT:
        fieldVisible &&
        box &&
        box.height >= 44 &&
        apiCalls.length > 0 &&
        apiCalls.every((s) => s === 200) &&
        !overflow &&
        errors.length === 0
          ? 'PASS'
          : 'FAIL',
    },
    null,
    2,
  ),
);
await browser.close();
