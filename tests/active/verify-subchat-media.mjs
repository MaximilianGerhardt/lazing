import { chromium, devices } from 'playwright-core';
import { readFileSync } from 'node:fs';

const BASE = 'http://127.0.0.1:4200';
const COOKIE = process.env.SESSION_COOKIE;
const TOKEN = readFileSync('/tmp/anhang-test-token.txt', 'utf8').trim();
const SCID = readFileSync('/tmp/anhang-test-scid.txt', 'utf8').trim();
const iPhone = devices['iPhone 13'];
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{1F1E6}-\u{1F1FF}\u{FE0F}]/u;

const browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch());

async function check(label, url, { cookie, seedName } = {}) {
  const ctx = await browser.newContext({ ...iPhone });
  if (cookie) {
    const [n, v] = cookie.split('=');
    await ctx.addCookies([{ name: n, value: v, domain: '127.0.0.1', path: '/' }]);
  }
  const errors = [];
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });
  if (seedName) {
    await page.addInitScript(([t, name]) => {
      try { localStorage.setItem(`lazyos.subchat.name.${t}`, name); } catch {}
    }, [TOKEN, seedName]);
  }
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);

  const imgs0 = await page.locator('section, div').locator('img[alt]').count();
  const fileCards = await page.getByText('test-angebot.pdf', { exact: false }).count();
  const attachBtn = await page.locator('button[aria-label="Foto oder Datei anhängen"]').isVisible().catch(() => false);
  const sendBtn = await page.locator('button[aria-label="Senden"]').isVisible().catch(() => false);

  // Echter UI-Upload (Foto) + Senden
  let uploadedOk = false;
  try {
    await page.locator('input[type=file]').setInputFiles('/tmp/test-photo.png');
    await page.waitForTimeout(400);
    const ta = page.locator('textarea').first();
    await ta.fill('UI-Upload-Test Foto');
    await page.locator('button[aria-label="Senden"]').click();
    await page.waitForTimeout(2500);
    const imgs1 = await page.locator('img[alt]').count();
    uploadedOk = imgs1 > imgs0;
  } catch (e) {
    errors.push('upload: ' + e.message);
  }

  const bodyText = await page.evaluate(() => document.body.innerText);
  const overflow = await page.evaluate(() => {
    const de = document.documentElement;
    return de.scrollWidth > de.clientWidth + 1;
  });
  await page.screenshot({ path: `/tmp/subchat-media-${label}.png`, fullPage: false });
  await ctx.close();
  return {
    label, imgsBefore: imgs0, fileCards, attachBtn, sendBtn, uploadedOk,
    hasEmoji: EMOJI.test(bodyText), overflow, errors: errors.slice(0, 6),
  };
}

const ext = await check('external', `${BASE}/c/${TOKEN}`, { seedName: 'Frau clientb' });
const int = await check('internal', `${BASE}/workspaces/intern/subchats/${SCID}`, { cookie: COOKIE });
console.log(JSON.stringify({ ext, int }, null, 2));
await browser.close();
