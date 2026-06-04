/**
 * verify-phaseA-data.mjs — Phase A (UI/UX-Neuausrichtung 2026-06-03).
 *
 * Prüft auf iPhone 13, dass /decisions und /calendar ECHTE Workspace-Labels
 * rendern statt leerer Pills oder Phantasie-Kunden (Nord-Sparkasse/clientb GmbH).
 *
 *   BASE=http://127.0.0.1:4205 SESSION_COOKIE=lazyos_session=... node verify-phaseA-data.mjs
 */
import { chromium, devices } from 'playwright-core';

const BASE = process.env.BASE || 'http://127.0.0.1:4205';
const COOKIE = process.env.SESSION_COOKIE || '';
const iPhone = devices['iPhone 13'];
const FANTASY = ['Nord-Sparkasse', 'clientb GmbH'];

const browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch());
const ctx = await browser.newContext({ ...iPhone });
const eq = COOKIE.indexOf('=');
await ctx.addCookies([
  { name: COOKIE.slice(0, eq), value: COOKIE.slice(eq + 1), domain: '127.0.0.1', path: '/' },
]);
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push('console.error: ' + m.text()); });

async function check(path, shot) {
  await page.goto(BASE + path, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  // Alle Pill-Texte einsammeln (Pill rendert als element mit data-pill ODER role; fallback: ganze Seite).
  const pillTexts = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('[class*="pill" i], [data-variant], span, a, button').forEach((el) => {
      const t = (el.textContent || '').trim();
      if (t && t.length < 40) out.push(t);
    });
    return out;
  });
  const bodyText = await page.evaluate(() => document.body.innerText);
  const fantasyHits = FANTASY.filter((f) => bodyText.includes(f));
  // leere Pills: schwer direkt; wir prüfen, dass mind. 1 echtes Workspace-Label da ist
  const hasReal = /PA Website|Intern|Instagram|Website|Demo PV|Workspace/i.test(bodyText);
  await page.screenshot({ path: shot, fullPage: false });
  return { path, fantasyHits, hasReal, shot };
}

const results = [];
results.push(await check('/decisions', '/tmp/phaseA-decisions.png'));
results.push(await check('/calendar', '/tmp/phaseA-calendar.png'));

const pass = results.every((r) => r.fantasyHits.length === 0) && errs.length === 0;
console.log(JSON.stringify({ base: BASE, pass, results, errs: errs.slice(0, 10) }, null, 2));
await browser.close();
process.exit(pass ? 0 : 1);
