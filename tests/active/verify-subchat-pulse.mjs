import { chromium, devices } from 'playwright-core';

const BASE = 'http://127.0.0.1:4200';
const COOKIE = process.env.SESSION_COOKIE;
const iPhone = devices['iPhone 13'];

const errors = [];
const browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch());
const ctx = await browser.newContext({ ...iPhone });
const [cname, cval] = COOKIE.split('=');
await ctx.addCookies([{ name: cname, value: cval, domain: '127.0.0.1', path: '/' }]);
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });

// Zentraler Hauptchat (Org-Root) — KEIN ws-Hint. Karte muss workspace-übergreifend kommen.
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000); // erstes activity-Poll

const pulse = page.locator('section[aria-label="Neues aus deinen Kundenchats"]');
const pulseVisible = await pulse.isVisible().catch(() => false);
let pulseText = '';
if (pulseVisible) pulseText = (await pulse.innerText()).replace(/\n+/g, ' | ').slice(0, 240);

const pickUp = await page.getByRole('button', { name: 'Im Hauptchat aufgreifen' }).first().isVisible().catch(() => false);
const openLink = await pulse.getByText('Öffnen', { exact: true }).first().isVisible().catch(() => false);
const chatsEntry = await page.locator('a[aria-label="Kundenchats"]').isVisible().catch(() => false);

let composerFilled = '';
if (pickUp) {
  await page.getByRole('button', { name: 'Im Hauptchat aufgreifen' }).first().click();
  await page.waitForTimeout(600);
  composerFilled = await page.locator('.lazyos-composer__input').inputValue().catch(() => '');
}

// Nach Aufgreifen sollte diese Karte verschwinden (markSeen). Neu prüfen:
const stillVisibleAfter = await pulse.isVisible().catch(() => false);

const overflow = await page.evaluate(() => {
  const de = document.documentElement;
  return { scrollW: de.scrollWidth, clientW: de.clientWidth, overflow: de.scrollWidth > de.clientWidth + 1 };
});

await page.screenshot({ path: '/tmp/subchat-pulse-mobile.png', fullPage: false });

console.log(JSON.stringify({
  pulseVisible, pulseText, pickUp, openLink, chatsEntry,
  composerFilledPreview: composerFilled.slice(0, 90),
  composerOk: composerFilled.includes('Kundenchat') && composerFilled.length > 40,
  stillVisibleAfter, overflow, pageErrors: errors.slice(0, 8),
}, null, 2));

await browser.close();
