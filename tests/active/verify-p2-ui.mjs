/**
 * verify-p2-ui.mjs — P2 messenger UI on the hydrating prod build :4206.
 * Checks: management list (kind toggle + per-row action sheet), image lightbox,
 * composer (camera/attach popover + mic), no emojis, no overflow @390, 0 console errors.
 */
import { chromium, devices } from 'playwright-core';

const BASE = process.env.BASE || 'http://127.0.0.1:4206';
const COOKIE = process.env.SESSION_COOKIE || '';
const SC_IMG = 'SC-01KT47W197S0QG53GSSEJQMKAE'; // Anhang-Test (image attachments)

const browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch());
const ctx = await browser.newContext({ ...devices['iPhone 13'] });
const eq = COOKIE.indexOf('=');
await ctx.addCookies([{ name: COOKIE.slice(0, eq), value: COOKIE.slice(eq + 1), domain: '127.0.0.1', path: '/' }]);
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message.slice(0, 160)));
page.on('console', (m) => { if (m.type() === 'error' && !/webpack-hmr|WebSocket/.test(m.text())) errs.push('console: ' + m.text().slice(0, 160)); });

const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{1F1E6}-\u{1F1FF}]/u;
async function scan(label) {
  const txt = await page.evaluate(() => document.body.innerText || '');
  const m = txt.match(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{1F1E6}-\u{1F1FF}]/u);
  const ov = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  return { label, emoji: m ? m[0] : null, overflow: ov };
}

const result = {};

// (1) Management list
await page.goto(BASE + '/workspaces/intern/subchats', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
const toggleExtern = await page.getByText('Kundenchat (extern)', { exact: false }).count();
const toggleIntern = await page.getByText('Team-Chat (intern)', { exact: false }).count();
// open the per-row "..." menu of the first row
let sheetActions = [];
const dots = page.locator('button[aria-label*="ptionen"], button[aria-label*="Verwalten"], button[aria-label*="enü"]');
let dotCount = await dots.count();
if (dotCount === 0) {
  // fallback: a small trailing button in each row
  const rowBtns = page.locator('button:has(svg)');
  dotCount = await rowBtns.count();
}
// try clicking the last button in the first row region
try {
  const candidate = page.locator('button').filter({ hasText: '' });
  // Heuristic: click an element that opens a sheet; look for known action labels after
  const menuBtn = page.locator('[aria-label*="ptionen"], [aria-label*="erwalten"]').first();
  if (await menuBtn.count()) { await menuBtn.click(); await page.waitForTimeout(400); }
} catch { /* */ }
for (const lbl of ['Umbenennen', 'Archivieren', 'Löschen', 'Link verwalten', 'Link aktiv', 'Widerrufen']) {
  if (await page.getByText(lbl, { exact: false }).count()) sheetActions.push(lbl);
}
result.managementList = {
  kindToggle: toggleExtern > 0 && toggleIntern > 0,
  rowMenuButtons: dotCount,
  sheetActionsSeen: sheetActions,
  ...(await scan('list')),
};

// (2) Internal subchat with image → lightbox
await page.goto(`${BASE}/workspaces/intern/subchats/${SC_IMG}`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2800);
const imgButtons = page.locator('button:has(img)');
const imgBtnCount = await imgButtons.count();
let lightboxOpened = false;
if (imgBtnCount > 0) {
  await imgButtons.first().click();
  await page.waitForTimeout(700);
  // Lightbox: full-screen fixed overlay with an img + close button
  lightboxOpened = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('div'));
    return els.some((el) => {
      const s = getComputedStyle(el);
      return s.position === 'fixed' && (parseInt(s.zIndex) >= 100) &&
        el.getBoundingClientRect().width >= window.innerWidth - 2 &&
        el.querySelector('img');
    });
  });
}
const micBtn = await page.locator('button[aria-label*="ufnahme"], button[aria-label*="prach"], button[aria-label*="Mikro"]').count();
const attachBtn = await page.locator('button[aria-label*="nhang"], button[aria-label*="nhäng"], button[aria-label*="Datei"]').count();
result.internalView = {
  imageRenderedAsButton: imgBtnCount > 0,
  lightboxOpened,
  micButton: micBtn,
  attachButton: attachBtn,
  ...(await scan('internal')),
};

result.consoleErrors = errs.slice(0, 8);
result.pass =
  result.managementList.kindToggle &&
  !result.managementList.emoji && !result.managementList.overflow &&
  result.internalView.imageRenderedAsButton && result.internalView.lightboxOpened &&
  !result.internalView.emoji && !result.internalView.overflow &&
  errs.length === 0;

console.log(JSON.stringify(result, null, 2));
await page.screenshot({ path: '/tmp/p2-internal-lightbox.png' });
await browser.close();
process.exit(result.pass ? 0 : 1);
