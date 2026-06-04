/**
 * verify-navfix.mjs — Nav-Fix D (OrgBootstrap + OrgSwitcher-Guard).
 *
 * Simuliert eine frische/legacy Session (localStorage `lazyos.org` geleert vor
 * jedem Page-Script) und prüft, dass das Landen auf einem ECHTEN Kunden-
 * Workspace NICHT mehr per Org-Normalisierung zum org-root-Chat redirected.
 *
 *   BASE=http://127.0.0.1:4205 SESSION_COOKIE=lazyos_session=... node verify-navfix.mjs
 *
 * Erwartung POST-Fix (:4205): finalUrl bleibt auf der Zielseite, org gesetzt.
 * Erwartung PRE-Fix (:4200):  /workspaces/intern + /?ws=intern redirecten weg.
 */
import { chromium, devices } from 'playwright-core';

const BASE = process.env.BASE || 'http://127.0.0.1:4205';
const COOKIE = process.env.SESSION_COOKIE || '';
const iPhone = devices['iPhone 13'];

const browser = await chromium
  .launch({ channel: 'chrome' })
  .catch(() => chromium.launch());
const ctx = await browser.newContext({ ...iPhone });
const eq = COOKIE.indexOf('=');
const cname = COOKIE.slice(0, eq);
const cval = COOKIE.slice(eq + 1);
await ctx.addCookies([{ name: cname, value: cval, domain: '127.0.0.1', path: '/' }]);
// Fresh/legacy session: kein gespeichertes lazyos.org vor jedem Load.
await ctx.addInitScript(() => {
  try { window.localStorage.removeItem('lazyos.org'); } catch { /* ignore */ }
});

const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push('console.error: ' + m.text()); });

async function probe(path, label) {
  await page.goto(BASE + path, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000); // Org-Fetch + Normalisierungs-Effekt abwarten
  const finalUrl = page.url().replace(BASE, '');
  const org = await page.evaluate(() => {
    try { return localStorage.getItem('lazyos.org'); } catch { return null; }
  });
  const leftWorkspace = path.startsWith('/workspaces/') && !finalUrl.startsWith('/workspaces/');
  const wentOrgRoot = /__org_root__|\/orgs\//.test(finalUrl);
  return { label, path, finalUrl, org, redirectedAway: leftWorkspace || wentOrgRoot };
}

const results = [];
results.push(await probe('/workspaces/intern', 'real-workspace detail (TopNav visible → redirect-prone)'));
results.push(await probe('/workspaces/intern/subchats', 'subchats list (OrgBootstrap should set org)'));
results.push(await probe('/?ws=intern', 'scoped main chat (must respect ?ws)'));

const pass = results.every((r) => !r.redirectedAway);
console.log(JSON.stringify({ base: BASE, pass, results, errs: errs.slice(0, 8) }, null, 2));
await browser.close();
process.exit(pass ? 0 : 1);
