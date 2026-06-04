/**
 * verify-emoji-routes.mjs — broad DOM emoji scan across many app routes on a
 * hydrating build. Confirms the rendered DESIGN is emoji-free everywhere.
 *   BASE=http://127.0.0.1:4200 SESSION_COOKIE=lazyos_session=... node verify-emoji-routes.mjs
 */
import { chromium, devices } from 'playwright-core';

const BASE = process.env.BASE || 'http://127.0.0.1:4200';
const COOKIE = process.env.SESSION_COOKIE || '';
const ROUTES = [
  '/', '/workspaces/intern', '/workspaces/intern/subchats',
  '/workspaces/intern/subchats/SC-01KT47W197S0QG53GSSEJQMKAE',
  '/decisions', '/lanes', '/calendar', '/tickets', '/workstreams',
  '/settings', '/design', '/how', '/routines', '/skills', '/orgs',
];

const browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch());
const ctx = await browser.newContext({ ...devices['iPhone 13'] });
const eq = COOKIE.indexOf('=');
await ctx.addCookies([{ name: COOKIE.slice(0, eq), value: COOKIE.slice(eq + 1), domain: '127.0.0.1', path: '/' }]);
const page = await ctx.newPage();

async function scanEmoji() {
  return page.evaluate(() => {
    const EMOJI = /[\u{1F300}-\u{1FAFF}\u{1F000}-\u{1F0FF}\u{1F1E6}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{2B00}-\u{2B59}\u{2300}-\u{23FF}\u{FE0F}]/u;
    const hits = [];
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walk.nextNode())) {
      for (const ch of (n.nodeValue || '')) {
        if (EMOJI.test(ch)) hits.push({ c: 'U+' + ch.codePointAt(0).toString(16).toUpperCase(), ch, near: (n.nodeValue || '').trim().slice(0, 30) });
      }
    }
    // also scan ::before/::after content of all elements
    for (const el of Array.from(document.querySelectorAll('*')).slice(0, 4000)) {
      for (const pseudo of ['::before', '::after']) {
        const c = getComputedStyle(el, pseudo).content;
        if (c && c !== 'none' && c !== 'normal') {
          for (const ch of c) if (EMOJI.test(ch)) hits.push({ c: 'U+' + ch.codePointAt(0).toString(16).toUpperCase(), ch, near: 'pseudo:' + c.slice(0, 20) });
        }
      }
    }
    return hits.slice(0, 30);
  });
}

const report = {};
let totalEmoji = 0;
for (const r of ROUTES) {
  try {
    const resp = await page.goto(BASE + r, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1800);
    const status = resp ? resp.status() : 0;
    const hits = await scanEmoji();
    totalEmoji += hits.length;
    report[r] = { status, emojiCount: hits.length, samples: hits.slice(0, 6) };
  } catch (e) {
    report[r] = { error: String(e).slice(0, 80) };
  }
}
// drawer
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
await page.locator('.topnav-hamburger').first().click().catch(() => {});
await page.waitForTimeout(800);
const drawerHits = await scanEmoji();
totalEmoji += drawerHits.length;
report['[drawer]'] = { emojiCount: drawerHits.length, samples: drawerHits.slice(0, 6) };

console.log(JSON.stringify({ totalEmojiAcrossRoutes: totalEmoji, perRoute: report }, null, 2));
await browser.close();
process.exit(totalEmoji === 0 ? 0 : 1);
