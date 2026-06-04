/**
 * verify-full.mjs — full feature + accessibility verification across all arc
 * surfaces on a hydrating build. Captures screenshots + structured a11y report.
 *   BASE=http://127.0.0.1:4200 SESSION_COOKIE=lazyos_session=... node verify-full.mjs
 *
 * a11y checks (manual, no axe): tap-targets <44px on icon-only controls,
 * interactive elements missing accessible name, images missing alt,
 * decorative-glyph/emoji in rendered text, horizontal overflow @390, console errors.
 */
import { chromium, devices } from 'playwright-core';

const BASE = process.env.BASE || 'http://127.0.0.1:4200';
const COOKIE = process.env.SESSION_COOKIE || '';
const SC_IMG = 'SC-01KT47W197S0QG53GSSEJQMKAE';

const browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch());
const ctx = await browser.newContext({ ...devices['iPhone 13'] });
const eq = COOKIE.indexOf('=');
await ctx.addCookies([{ name: COOKIE.slice(0, eq), value: COOKIE.slice(eq + 1), domain: '127.0.0.1', path: '/' }]);
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message.slice(0, 120)));
page.on('console', (m) => { if (m.type() === 'error' && !/webpack-hmr|WebSocket/.test(m.text())) errs.push('console: ' + m.text().slice(0, 120)); });

// Per-surface a11y audit run in the page.
async function audit() {
  return page.evaluate(() => {
    const GLYPH = /[▾▸▴◂●○◐◑⌘⚙♥✓✕✗★☆⏻⌫⏎⎘⋯«»\u{1F000}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}️]/u;
    const ALLOW = new Set(['‹', '›', '→', '…', '·', '—', '|']);
    const out = { smallTargets: [], noName: [], imgsNoAlt: 0, glyphHits: [], overflow: false };
    out.overflow = document.documentElement.scrollWidth > document.documentElement.clientWidth + 1;
    // interactive elements
    const inter = Array.from(document.querySelectorAll('button, a[href], [role="button"], [role="option"], input, textarea, select'));
    for (const el of inter) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue; // hidden
      const name = (el.getAttribute('aria-label') || el.textContent || el.getAttribute('title') || el.getAttribute('placeholder') || '').trim();
      const isIconOnly = !((el.textContent || '').trim().length);
      if (isIconOnly && (r.width < 44 || r.height < 44)) {
        out.smallTargets.push({ tag: el.tagName.toLowerCase(), cls: (el.className || '').toString().slice(0, 30), w: Math.round(r.width), h: Math.round(r.height), name: name.slice(0, 24) });
      }
      if (!name) out.noName.push({ tag: el.tagName.toLowerCase(), cls: (el.className || '').toString().slice(0, 30) });
    }
    for (const img of Array.from(document.querySelectorAll('img'))) {
      if (!img.getAttribute('alt') && img.getBoundingClientRect().width > 0) out.imgsNoAlt++;
    }
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walk.nextNode())) {
      for (const ch of (n.nodeValue || '')) {
        if (GLYPH.test(ch) && !ALLOW.has(ch)) out.glyphHits.push('U+' + ch.codePointAt(0).toString(16).toUpperCase());
      }
    }
    out.smallTargets = out.smallTargets.slice(0, 12);
    out.noName = out.noName.slice(0, 12);
    out.glyphHits = [...new Set(out.glyphHits)];
    return out;
  });
}

const surfaces = [
  { key: 'mainchat', url: '/', wait: 2600, shot: '/tmp/full-mainchat.png' },
  { key: 'subchat', url: `/workspaces/intern/subchats/${SC_IMG}`, wait: 2800, shot: '/tmp/full-subchat.png' },
  { key: 'management', url: '/workspaces/intern/subchats', wait: 2400, shot: '/tmp/full-management.png' },
];
const report = {};
for (const s of surfaces) {
  await page.goto(BASE + s.url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(s.wait);
  report[s.key] = { url: page.url().replace(BASE, ''), a11y: await audit() };
  await page.screenshot({ path: s.shot });
}
// drawer (open from main chat)
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2000);
await page.locator('.topnav-hamburger').first().click().catch(() => {});
await page.waitForTimeout(900);
report.drawer = { kundenSeen: await page.getByText('Kunden', { exact: false }).count() > 0, a11y: await audit() };
await page.screenshot({ path: '/tmp/full-drawer.png' });

report.consoleErrors = errs.slice(0, 12);
console.log(JSON.stringify(report, null, 2));
await browser.close();
