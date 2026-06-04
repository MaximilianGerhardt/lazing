/**
 * verify-phaseB-nav.mjs — Phase B (UI/UX-Neuausrichtung 2026-06-03).
 * Bottom-Tab-Bar: 3 Tabs, kein Text-Bruch, sichtbar auf Listen-Surfaces,
 * NICHT auf dem Chat. iPhone 13.
 *
 *   BASE=http://127.0.0.1:4205 SESSION_COOKIE=lazyos_session=... node verify-phaseB-nav.mjs
 */
import { chromium, devices } from 'playwright-core';

const BASE = process.env.BASE || 'http://127.0.0.1:4205';
const COOKIE = process.env.SESSION_COOKIE || '';
const iPhone = devices['iPhone 13'];

const browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch());
const ctx = await browser.newContext({ ...iPhone });
const eq = COOKIE.indexOf('=');
await ctx.addCookies([
  { name: COOKIE.slice(0, eq), value: COOKIE.slice(eq + 1), domain: '127.0.0.1', path: '/' },
]);
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));

// Workspace-Kontext erst über den Chat etablieren (der normale Einstieg).
// Sonst feuert beim allerersten Sub-Page-Direktaufruf ohne localStorage die
// Org-Root-Normalisierung und redirected nach /?ws=… — ein Test-Artefakt,
// kein realer User-Pfad (User landen zuerst im Chat, der den Scope seedet).
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);

async function inspect(path, shot, expectBar) {
  await page.goto(BASE + path, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2200);
  const bar = await page.evaluate(() => {
    const el = document.querySelector('.lazyos-tabbar');
    if (!el) return { present: false };
    const items = [...el.querySelectorAll('.lazyos-tabbar__item')].map((it) => {
      const label = it.querySelector('.lazyos-tabbar__label');
      const r = label ? label.getBoundingClientRect() : null;
      // truncation check: scrollWidth > clientWidth means text is clipped
      const clipped = label ? label.scrollWidth > label.clientWidth + 1 : false;
      return {
        text: (label?.textContent || '').trim(),
        active: it.getAttribute('aria-current') === 'page',
        clipped,
      };
    });
    const rect = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      present: true,
      position: cs.position,
      bottom: rect.bottom,
      viewportH: window.innerHeight,
      atBottom: Math.abs(rect.bottom - window.innerHeight) < 2,
      items,
    };
  });
  await page.screenshot({ path: shot, fullPage: false });
  const ok =
    expectBar === bar.present &&
    (!expectBar || (bar.atBottom && bar.items.length === 3 && bar.items.every((i) => !i.clipped && i.text.length > 0)));
  return { path, expectBar, ok, bar, shot };
}

const results = [];
results.push(await inspect('/decisions', '/tmp/phaseB-decisions.png', true));
results.push(await inspect('/calendar', '/tmp/phaseB-calendar.png', true));
results.push(await inspect('/', '/tmp/phaseB-chat.png', false));

const pass = results.every((r) => r.ok) && errs.length === 0;
console.log(JSON.stringify({ base: BASE, pass, results, errs: errs.slice(0, 6) }, null, 2));
await browser.close();
process.exit(pass ? 0 : 1);
