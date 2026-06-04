/**
 * verify-e2e.mjs — full P1..P4 mobile end-to-end on the hydrating prod build :4206.
 * Covers: nav-fix scope (P1), scope-spine crumb (P4), Kunden drawer + glyph scan (P4),
 * composer create-chat pill fit (P3), lightbox (P2). Reports decorative-glyph offenders.
 */
import { chromium, devices } from 'playwright-core';

const BASE = process.env.BASE || 'http://127.0.0.1:4206';
const COOKIE = process.env.SESSION_COOKIE || '';
const SC_IMG = 'SC-01KT47W197S0QG53GSSEJQMKAE';

const browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch());
const ctx = await browser.newContext({ ...devices['iPhone 13'] });
const eq = COOKIE.indexOf('=');
await ctx.addCookies([{ name: COOKIE.slice(0, eq), value: COOKIE.slice(eq + 1), domain: '127.0.0.1', path: '/' }]);
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message.slice(0, 140)));
page.on('console', (m) => { if (m.type() === 'error' && !/webpack-hmr|WebSocket/.test(m.text())) errs.push('console: ' + m.text().slice(0, 140)); });

// Decorative-glyph / emoji scanner: returns the offending chars + nearest text.
async function glyphScan() {
  return page.evaluate(() => {
    const re = /[⌀-➿⬀-⯿←-⇿\u{1F000}-\u{1FAFF}️]/u;
    const allow = new Set(['‹', '›', '→', '…']); // ‹ › → … tolerated
    const hits = [];
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walk.nextNode())) {
      const t = n.nodeValue || '';
      for (const ch of t) {
        if (re.test(ch) && !allow.has(ch)) {
          hits.push({ ch, code: 'U+' + ch.codePointAt(0).toString(16).toUpperCase(), near: t.trim().slice(0, 24) });
        }
      }
    }
    return hits.slice(0, 20);
  });
}
const overflow = () => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
const result = {};

// (1) Scope-spine on org-root (main chat)
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
const trigLabel = await page.locator('.topnav-org-trigger').first().getAttribute('aria-label').catch(() => null);
const crumbText = await page.locator('.topnav-org-trigger-label').first().innerText().catch(() => '');
const composerPillRowOverflow = await overflow();
const createPill = await page.locator('a[aria-label*="undenchat"], button[aria-label*="undenchat"], button[aria-label*="anleg"], a[aria-label*="anleg"]').count();
result.mainChat = { triggerAria: trigLabel, crumb: crumbText.replace(/\n/g, ' '), createChatPill: createPill, overflow: composerPillRowOverflow, glyphs: await glyphScan() };

// (2) Open the Kunden drawer (hamburger) and scan
const burger = page.locator('.topnav-hamburger, button[aria-label*="enü"], button[aria-label*="rawer"]').first();
let drawer = { opened: false };
if (await burger.count()) {
  await burger.click().catch(() => {});
  await page.waitForTimeout(800);
  const kundenHdr = await page.getByText('Kunden', { exact: false }).count();
  const badges = await page.locator('[class*="badge"], [class*="unread"]').count();
  drawer = { opened: true, kundenSectionSeen: kundenHdr > 0, badgeEls: badges, glyphs: await glyphScan(), overflow: await overflow() };
}
result.drawer = drawer;

// (3) Nav scope (P1) — quick re-confirm no redirect on a real workspace
await page.goto(BASE + '/workspaces/intern', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
result.navScope = {
  stayed: page.url().includes('/workspaces/intern'),
  org: await page.evaluate(() => { try { return localStorage.getItem('lazyos.org'); } catch { return null; } }),
  crumb: await page.locator('.topnav-org-trigger-label').first().innerText().catch(() => ''),
};

// (4) Lightbox still works (P2 regression check)
await page.goto(`${BASE}/workspaces/intern/subchats/${SC_IMG}`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2800);
const imgBtn = page.locator('button:has(img)').first();
let lightbox = false;
if (await imgBtn.count()) {
  await imgBtn.click(); await page.waitForTimeout(600);
  lightbox = await page.evaluate(() => Array.from(document.querySelectorAll('div')).some((el) => { const s = getComputedStyle(el); return s.position === 'fixed' && parseInt(s.zIndex) >= 100 && el.querySelector('img'); }));
}
result.lightbox = lightbox;

result.consoleErrors = errs.slice(0, 10);
console.log(JSON.stringify(result, null, 2));
await browser.close();
