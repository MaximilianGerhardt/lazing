import { chromium, devices } from 'playwright-core';

/** Capture current mobile UI state for the UI/UX critique (iPhone 13). */
const BASE = 'http://127.0.0.1:4200';
const C = process.env.SESSION_COOKIE;
const eq = C.indexOf('=');
const browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch());
const ctx = await browser.newContext({ ...devices['iPhone 13'] });
await ctx.addCookies([{ name: C.slice(0, eq), value: C.slice(eq + 1), domain: '127.0.0.1', path: '/' }]);
const page = await ctx.newPage();

const shots = [];
async function shot(path, file, afterFn) {
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  if (afterFn) await afterFn();
  await page.screenshot({ path: file });
  // capture any horizontal overflow + the menu/segment text content
  const meta = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    bodyText: document.body.innerText.slice(0, 600),
  }));
  shots.push({ path, file, overflow: meta.overflow });
}

await shot('/', '/tmp/ui-chat.png');
await shot('/decisions', '/tmp/ui-decisions.png');
await shot('/calendar', '/tmp/ui-calendar.png');
await shot('/workstreams', '/tmp/ui-workstreams.png');

// open the mobile drawer/menu (hamburger)
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1000);
const burger = page.locator('button[aria-label="Menü"], button[aria-label="Menu"], [aria-label*="enü"]').first();
if (await burger.isVisible().catch(() => false)) {
  await burger.click();
  await page.waitForTimeout(600);
}
await page.screenshot({ path: '/tmp/ui-menu.png' });

console.log(JSON.stringify(shots, null, 2));
await browser.close();
