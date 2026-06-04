/**
 * verify-phaseC-composer.mjs — Phase C (UI/UX-Neuausrichtung 2026-06-03).
 * Ruhiger Composer: Engine-Pill = nur Selector (Telemetrie im Dropdown),
 * EIN Kundenchats-Icon, Vollzugriff = Lock-Icon. iPhone 13.
 *
 *   BASE=http://127.0.0.1:4205 SESSION_COOKIE=lazyos_session=... node verify-phaseC-composer.mjs
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

await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2600);

const info = await page.evaluate(() => {
  const pill = document.querySelector('[data-test="engine-pill-root"]');
  const pillText = pill ? (pill.textContent || '').trim() : null;
  // inline telemetry markers that should NO LONGER be on the row:
  const inlineTelemetry = pillText ? /CTX|Turn|Opus|Sonnet|Haiku|MAX/.test(pillText) : false;
  const lock = document.querySelector('[data-test="all-access-trigger"]');
  const lockText = lock ? (lock.textContent || '').trim() : null;
  const kundenchats = document.querySelector('a[aria-label="Kundenchats"]');
  const neuer = document.querySelector('[aria-label="Neuer Kundenchat"]');
  // input position (thumb zone): bottom of the composer textarea
  const ta = document.querySelector('textarea');
  const taRect = ta ? ta.getBoundingClientRect() : null;
  return {
    pillText,
    inlineTelemetry,
    lockPresent: !!lock,
    lockHasText: !!(lockText && lockText.length > 0),
    kundenchatsPresent: !!kundenchats,
    neuerKundenchatGone: !neuer,
    inputBottom: taRect ? Math.round(taRect.bottom) : null,
    viewportH: window.innerHeight,
  };
});

await page.screenshot({ path: '/tmp/phaseC-chat.png', fullPage: false });

const pass =
  info.pillText !== null &&
  info.inlineTelemetry === false && // telemetry moved off the row
  info.lockPresent &&
  info.lockHasText === false && // lock is icon-only now
  info.kundenchatsPresent &&
  info.neuerKundenchatGone && // the 2nd sub-chat icon merged away
  errs.length === 0;

console.log(JSON.stringify({ base: BASE, pass, info, errs: errs.slice(0, 6) }, null, 2));
await browser.close();
process.exit(pass ? 0 : 1);
