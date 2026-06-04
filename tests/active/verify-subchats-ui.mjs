import { chromium, devices } from 'playwright-core';

/** verify-subchats-ui — UI/UX-Browsertest der Sub-Chat-Verwaltung (iPhone 13):
 *  Liste rendert, Action-Sheet (Umbenennen/Löschen/Link) öffnet, Lösch-Bestätigung
 *  erscheint, 0 Emojis, 0 Horizontal-Overflow, ≥44px-Targets. Räumt auf. */

const BASE = 'http://127.0.0.1:4200';
const C = process.env.SESSION_COOKIE;
const WS = process.env.TEST_WS || 'intern';
const eq = C.indexOf('=');
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{2705}\u{2728}\u{274C}]/u;
const out = {};

// throwaway subchat so the list + sheet have content
const created = await fetch(`${BASE}/api/workspaces/${encodeURIComponent(WS)}/subchats`, {
  method: 'POST',
  headers: { cookie: C, 'content-type': 'application/json' },
  body: JSON.stringify({ title: 'UI-Verify (Wegwerf)', kind: 'external' }),
}).then((r) => r.json());
const subchatId = created.subchat?.id || created.id;

const browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch());
const ctx = await browser.newContext({ ...devices['iPhone 13'] });
await ctx.addCookies([{ name: C.slice(0, eq), value: C.slice(eq + 1), domain: '127.0.0.1', path: '/' }]);
const errors = [];
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });

await page.goto(`${BASE}/workspaces/${encodeURIComponent(WS)}/subchats`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1200);

out.listRendered = await page.getByText('UI-Verify (Wegwerf)').first().isVisible().catch(() => false);
out.overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
out.emojiInDom = EMOJI.test(await page.evaluate(() => document.body.innerText));

// open the action sheet (the dots button on the throwaway row)
const dots = page.locator('button[aria-label="Aktionen"]').first();
out.dotsVisible = await dots.isVisible().catch(() => false);
let sheetOpened = false, deleteVisible = false, confirmVisible = false, minTap = 0;
if (out.dotsVisible) {
  await dots.click();
  await page.waitForTimeout(400);
  sheetOpened = await page.getByRole('dialog').isVisible().catch(() => false);
  deleteVisible = await page.getByRole('button', { name: /^Löschen$/ }).first().isVisible().catch(() => false);
  if (deleteVisible) {
    await page.getByRole('button', { name: /^Löschen$/ }).first().click();
    await page.waitForTimeout(300);
    confirmVisible = await page.getByText(/Wirklich löschen/).first().isVisible().catch(() => false);
  }
  minTap = await page.evaluate(() => {
    const b = [...document.querySelectorAll('[role="dialog"] button')];
    return b.length ? Math.round(Math.min(...b.map((x) => x.getBoundingClientRect().height))) : 0;
  });
}
out.sheetOpened = sheetOpened;
out.deleteActionVisible = deleteVisible;
out.deleteConfirmVisible = confirmVisible;
out.minSheetTapTarget = minTap;
await page.screenshot({ path: '/tmp/subchats-ui-sheet.png' });
out.errors = errors.slice(0, 5);
await browser.close();

// cleanup the throwaway (also exercises the erasure cascade)
if (subchatId) {
  out.cleanup = (await fetch(`${BASE}/api/subchats/${encodeURIComponent(subchatId)}`, { method: 'DELETE', headers: { cookie: C } })).status;
}

out.VERDICT =
  out.listRendered && !out.overflow && !out.emojiInDom &&
  out.sheetOpened && out.deleteActionVisible && out.deleteConfirmVisible &&
  out.minSheetTapTarget >= 44 && out.errors.length === 0
    ? 'PASS' : 'FAIL';
console.log(JSON.stringify(out, null, 2));
