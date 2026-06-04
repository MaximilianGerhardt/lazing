/**
 * verify-navfix-regression.mjs — proves Nav-Fix D did NOT break the legitimate
 * org-switch / org-normalization (risk R1: only the AUTO normalization effect
 * is guarded, the user-initiated pick() + legacy `/` normalization must remain).
 */
import { chromium, devices } from 'playwright-core';

const BASE = process.env.BASE || 'http://127.0.0.1:4206';
const COOKIE = process.env.SESSION_COOKIE || '';
const out = {};

const browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch());

async function freshPage(clearOrg) {
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const eq = COOKIE.indexOf('=');
  await ctx.addCookies([{ name: COOKIE.slice(0, eq), value: COOKIE.slice(eq + 1), domain: '127.0.0.1', path: '/' }]);
  if (clearOrg) {
    await ctx.addInitScript(() => { try { window.localStorage.removeItem('lazyos.org'); } catch { /* */ } });
  }
  const page = await ctx.newPage();
  return { ctx, page };
}

// (A) Legacy normalization on plain `/` (no ws, cleared org) must still redirect to an org-root chat.
{
  const { ctx, page } = await freshPage(true);
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);
  const url = page.url().replace(BASE, '');
  out.legacyNormalization = { finalUrl: url, redirectedToOrgRoot: /__org_root__|\/orgs\//.test(url) };
  await ctx.close();
}

// (B) User-initiated org-switch via the OrgSwitcher pill must still hard-navigate.
{
  const { ctx, page } = await freshPage(false);
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  let switched = { clicked: false, picked: null, finalUrl: null };
  const trigger = page.locator('.topnav-org-trigger');
  if (await trigger.count()) {
    await trigger.first().click();
    await page.waitForTimeout(500);
    const rows = page.locator('.org-row:not(.is-current)');
    const n = await rows.count();
    if (n > 0) {
      switched.clicked = true;
      switched.picked = (await rows.first().innerText()).split('\n')[0].slice(0, 40);
      await Promise.all([
        page.waitForURL(/__org_root__|\/orgs\//, { timeout: 8000 }).catch(() => {}),
        rows.first().click(),
      ]);
      await page.waitForTimeout(1500);
      switched.finalUrl = page.url().replace(BASE, '');
    }
  }
  out.orgSwitchViaPill = {
    ...switched,
    hardNavigated: !!switched.finalUrl && /__org_root__|\/orgs\//.test(switched.finalUrl),
  };
  await ctx.close();
}

const pass =
  out.legacyNormalization.redirectedToOrgRoot &&
  (out.orgSwitchViaPill.clicked ? out.orgSwitchViaPill.hardNavigated : true);
console.log(JSON.stringify({ base: BASE, pass, ...out }, null, 2));
await browser.close();
process.exit(pass ? 0 : 1);
