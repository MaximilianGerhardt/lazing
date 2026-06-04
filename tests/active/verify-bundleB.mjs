import { chromium, devices } from 'playwright-core';

/**
 * verify-bundleB.mjs — Bündel B Gate (Playwright iPhone 13).
 *
 * Prüft: (1) ScopeTabs auf allen vier Flächen sichtbar + scope-carry (Chat-Link
 * trägt ?ws=<aktiver Workspace>), (2) Tab-Navigation re-rendert die Bar inkl.
 * Lanes→/workstreams-Redirect mit erhaltenem Highlight, (3) Onboarding-Wizard
 * „Neuer Kunde" rendert + Schritt-Vorlauf, (4) keine Emojis im DOM, kein
 * Horizontal-Scroll @390px, ≥44px-Targets, keine Konsolen-/Page-Errors.
 */

const BASE = 'http://127.0.0.1:4200';
const COOKIE = process.env.SESSION_COOKIE; // "lazyos_session=<value>"
const WS = process.env.TEST_WS || 'intern';
const WS_ORG = process.env.TEST_WS_ORG || 'example-company';
const iPhone = devices['iPhone 13'];

const errors = [];
const browser = await chromium
  .launch({ channel: 'chrome' })
  .catch(() => chromium.launch());
const ctx = await browser.newContext({ ...iPhone });
const eq = COOKIE.indexOf('=');
await ctx.addCookies([
  {
    name: COOKIE.slice(0, eq),
    value: COOKIE.slice(eq + 1),
    domain: '127.0.0.1',
    path: '/',
  },
  // Org-Kontext konsistent zum aktiven Workspace setzen, sonst normalisiert der
  // OrgSwitcher die Org auf org-root zurück und redirected `/` weg (kein Bug —
  // Legacy-Verhalten). Konsistent = kein Redirect → ScopeTabs sichtbar + carry.
  { name: 'lazyos.org', value: WS_ORG, domain: '127.0.0.1', path: '/' },
]);
// Aktiven Workspace + Org seeden, damit ScopeTabs scope-carry zeigt.
await ctx.addInitScript(
  ([ws, org]) => {
    try {
      localStorage.setItem('lazyos.workspace', ws);
      localStorage.setItem('lazyos.org', org);
    } catch {}
  },
  [WS, WS_ORG],
);

const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push('console.error: ' + m.text());
});

const EMOJI =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{2190}-\u{21FF}\u{2705}\u{2728}\u{274C}]/u;

async function probe(path, label) {
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);
  const nav = page.locator('nav[aria-label="Ansichten"]');
  const navVisible = await nav.isVisible().catch(() => false);
  const overflow = await page.evaluate(() => {
    const de = document.documentElement;
    return de.scrollWidth > de.clientWidth + 1;
  });
  const domEmoji = await page.evaluate(() => document.body.innerText);
  const minTap = await page.evaluate(() => {
    const links = [...document.querySelectorAll('nav[aria-label="Ansichten"] a')];
    return links.length
      ? Math.min(...links.map((a) => a.getBoundingClientRect().height))
      : 0;
  });
  return {
    label,
    finalUrl: page.url().replace(BASE, ''),
    navVisible,
    overflow,
    emojiInDom: EMOJI.test(domEmoji),
    minTabHeight: Math.round(minTap),
  };
}

const results = [];

// 1) Chat-Root: scope-carry prüfen (Chat-Link soll ?ws=<WS> tragen)
results.push(await probe('/', 'chat'));
const chatHref = await page
  .locator('nav[aria-label="Ansichten"] a', { hasText: 'Chat' })
  .first()
  .getAttribute('href')
  .catch(() => null);
const scopeCarry = !!chatHref && chatHref.includes(`ws=${WS}`);
await page.screenshot({ path: '/tmp/bundleB-chat.png' });

// 2) Decisions
results.push(await probe('/decisions', 'decisions'));

// 3) Lanes-Tab → Klick → soll auf /workstreams landen (Redirect) + Bar + lit
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(300);
await page
  .locator('nav[aria-label="Ansichten"] a', { hasText: 'Lanes' })
  .first()
  .click();
await page.waitForTimeout(800);
const lanesLandUrl = page.url().replace(BASE, '');
const lanesBar = await page
  .locator('nav[aria-label="Ansichten"]')
  .isVisible()
  .catch(() => false);
const lanesLit = await page
  .locator('nav[aria-label="Ansichten"] a[aria-current="page"]', {
    hasText: 'Lanes',
  })
  .isVisible()
  .catch(() => false);
await page.screenshot({ path: '/tmp/bundleB-lanes.png' });

// 4) Calendar
results.push(await probe('/calendar', 'calendar'));

// 5) Onboarding-Wizard — NICHT-destruktiv: Schritt 1 rendert + ist interaktiv.
//    (Ein „Weiter"-Klick würde via POST /api/orgs eine echte Client-Org anlegen
//    → bewusst NICHT klicken; nur Render + Eingabe + Button-Enable prüfen.)
await page.goto(`${BASE}/onboarding/kunde`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(600);
const wizardHeading = await page
  .getByText('Wie heißt der Kunde?', { exact: false })
  .first()
  .isVisible()
  .catch(() => false);
const nameInput = page.locator('input[type="text"]').first();
let inputFillable = false;
let weiterEnabledAfterFill = false;
let onbEmoji = false;
let onbOverflow = false;
try {
  const weiter = page.getByRole('button', { name: /Weiter/i }).first();
  // Vor Eingabe: Weiter disabled (orgName < 2 Zeichen).
  const disabledBefore = await weiter.isDisabled().catch(() => false);
  await nameInput.fill('Beispiel Kunde');
  inputFillable = (await nameInput.inputValue()) === 'Beispiel Kunde';
  await page.waitForTimeout(150);
  weiterEnabledAfterFill =
    disabledBefore && !(await weiter.isDisabled().catch(() => true));
  onbEmoji = EMOJI.test(await page.evaluate(() => document.body.innerText));
  onbOverflow = await page.evaluate(() => {
    const de = document.documentElement;
    return de.scrollWidth > de.clientWidth + 1;
  });
} catch (e) {
  errors.push('onboarding: ' + e.message);
}
await page.screenshot({ path: '/tmp/bundleB-onboarding.png' });

const summary = {
  surfaces: results,
  scopeCarry: { chatHref, ok: scopeCarry },
  lanes: { landUrl: lanesLandUrl, barVisible: lanesBar, tabLit: lanesLit },
  onboarding: {
    wizardHeading,
    inputFillable,
    weiterEnabledAfterFill,
    emojiInDom: onbEmoji,
    overflow: onbOverflow,
  },
  pageErrors: errors.slice(0, 10),
  VERDICT:
    results.every((r) => r.navVisible && !r.overflow && !r.emojiInDom && r.minTabHeight >= 44) &&
    scopeCarry &&
    lanesBar &&
    lanesLit &&
    lanesLandUrl.startsWith('/workstreams') &&
    wizardHeading &&
    inputFillable &&
    weiterEnabledAfterFill &&
    !onbEmoji &&
    !onbOverflow &&
    errors.length === 0
      ? 'PASS'
      : 'FAIL',
};

console.log(JSON.stringify(summary, null, 2));
await browser.close();
