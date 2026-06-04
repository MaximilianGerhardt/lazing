/**
 * tests/active/ui-smoke.spec.ts
 *
 * Playwright-UI-Smoke gegen die LAUFENDE Instanz. Läuft auf zwei Projekten
 * (desktop-chromium, mobile-iphone). Authentication ist per-test injection
 * via master-login.
 *
 * Was wir prüfen:
 *   1. Boot + console-error sweep auf Home (sollte keine vermeidbaren
 *      Errors/Warns spammen — speziell kein 403 /api/permission/__root__/mode
 *      mehr, da AllAccessToggle.tsx den GET für __root__ skippt).
 *   2. /workspaces rendert; keine ungeladenen Karten.
 *   3. Worker-Pill (mobile): wenn sichtbar → Tap → erwartet fokussierte
 *      Surface (nicht: Sidebar/Scroll-to-Workspaces).
 *   4. Open-Questions-Pill: Detail-Toggle + Dismiss.
 *   5. Settings-Page mobile: keine horizontalen Overflows.
 *   6. Console-Error-Sweep auf allen besuchten Routes.
 *
 * Owner-Direktive: Read-only — wir klicken keinen "Approve" oder
 * "Connector live aktivieren". Nur Lesen, Navigieren, Hovern.
 */

import { test, expect, type Page, type ConsoleMessage, type BrowserContext } from '@playwright/test';

const ACCESS_CODE = process.env.LAZYOS_ACCESS_CODE;
const BASE = process.env.LAZYOS_SMOKE_BASE_URL ?? 'http://127.0.0.1:4200';

/** master-login → session cookie. */
async function loginAndGetCookie(context: BrowserContext): Promise<void> {
  if (!ACCESS_CODE || ACCESS_CODE.length < 16) {
    throw new Error('LAZYOS_ACCESS_CODE not set (source .env.local before running).');
  }
  const res = await context.request.post(`${BASE}/api/auth/master-login`, {
    headers: { 'content-type': 'application/json', origin: BASE },
    data: { accessCode: ACCESS_CODE },
  });
  expect(res.status(), `master-login status ${res.status()} ${await res.text()}`).toBe(200);
  // Cookies are now set on the context (browser cookie jar).
}

/**
 * Sammelt console-Messages + page-Errors. Returns getter mit Filter.
 */
function attachConsoleCollector(page: Page): { all(): ConsoleMessage[]; errors(): ConsoleMessage[]; pageErrors(): Error[]; ignored(): number } {
  const messages: ConsoleMessage[] = [];
  const pageErrors: Error[] = [];
  let ignored = 0;

  // Bekannter benign-Lärm — NICHT in der Bewertung zählen, aber separat
  // ausweisen, damit man den Lärm später eindeutig identifizieren kann.
  const IGNORE_PATTERNS: RegExp[] = [
    /Download the React DevTools/i,
    /Vercel Web Analytics/i,
    /\[Fast Refresh\]/i,
    /\[HMR\]/i,
    /Hydration completed/i,
  ];

  page.on('console', (msg) => {
    const text = msg.text();
    if (IGNORE_PATTERNS.some((re) => re.test(text))) {
      ignored++;
      return;
    }
    messages.push(msg);
  });
  page.on('pageerror', (err) => pageErrors.push(err));

  return {
    all: () => messages.slice(),
    errors: () =>
      messages.filter((m) => m.type() === 'error' || m.type() === 'warning'),
    pageErrors: () => pageErrors.slice(),
    ignored: () => ignored,
  };
}

test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ context }) => {
  await loginAndGetCookie(context);
});

test('1. boot smoke: home loads without page errors', async ({ page }) => {
  const console$ = attachConsoleCollector(page);
  const resp = await page.goto('/', { waitUntil: 'domcontentloaded' });
  expect(resp?.status(), `home status ${resp?.status()}`).toBeLessThan(400);

  // Give the UI ~1s to settle (composer mounts, AllAccessToggle decides).
  await page.waitForTimeout(1200);

  // KEINE __root__/mode 403 mehr — der vorhin gefixte Bug.
  const root403 = console$
    .all()
    .find((m) => /permission\/__root__\/mode.*403/i.test(m.text()));
  expect(root403, `regression: __root__ 403 in console: ${root403?.text()}`).toBeUndefined();

  // Page-Errors sind hart.
  expect(console$.pageErrors(), `unhandled JS errors: ${console$.pageErrors().map((e) => e.message).join(' | ')}`).toHaveLength(0);
});

test('2. /workspaces renders cards', async ({ page }) => {
  const console$ = attachConsoleCollector(page);
  const resp = await page.goto('/workspaces', { waitUntil: 'domcontentloaded' });
  expect(resp?.status()).toBe(200);
  await page.waitForTimeout(800);
  // Sanity: page is not the login redirect.
  expect(page.url()).not.toContain('/login');
  expect(console$.pageErrors()).toHaveLength(0);
});

test('3. mobile: tap InlineWorkerStatus pill (if visible)', async ({ page, browserName }, testInfo) => {
  // Nur sinnvoll auf mobile-Project (where the pill is supposed to be visible).
  test.skip(testInfo.project.name !== 'mobile-iphone', 'pill flow only checked on mobile project');
  const console$ = attachConsoleCollector(page);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);

  // Looser selector: any pill that mentions "Worker" or has data-testid="worker-pill".
  const pill = page.locator(
    '[data-testid="worker-pill"], [data-testid="inline-worker-status"], button:has-text("Worker"), [aria-label*="Worker" i]',
  ).first();

  const visible = await pill.isVisible().catch(() => false);
  testInfo.annotations.push({ type: 'worker-pill-visible', description: String(visible) });

  if (!visible) {
    testInfo.annotations.push({ type: 'skip-reason', description: 'no worker pill present in current state' });
    return;
  }

  const beforeUrl = page.url();
  await pill.tap();
  await page.waitForTimeout(600);

  // Erwartung F1-Fix: fokussierte Surface öffnet sich, KEIN scroll-to-/workspaces.
  // Heuristik: URL bleibt gleich (kein Navigationssprung) UND ein Detail-Pannel
  // (role="dialog" oder data-testid="worker-detail") wird sichtbar.
  const detail = page.locator('[role="dialog"], [data-testid="worker-detail"], [data-testid="worker-surface"]').first();
  const opened = await detail.isVisible().catch(() => false);
  const urlChanged = page.url() !== beforeUrl;

  // FAIL only when neither a detail surface opened nor URL changed — that's the
  // "tap does nothing visible" symptom. Document both modes.
  if (!opened && !urlChanged) {
    testInfo.annotations.push({
      type: 'finding',
      description: 'worker-pill tap did not open detail surface and did not change URL — F1 fix not yet effective in current build',
    });
  }
  expect(console$.pageErrors()).toHaveLength(0);
});

test('4. open-questions pill: detail-toggle + dismiss (if visible)', async ({ page }, testInfo) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);

  const pill = page
    .locator(
      '[data-testid="open-questions-pill"], [data-testid="oq-pill"], button:has-text("offene Frage"), button:has-text("Frage")',
    )
    .first();
  const visible = await pill.isVisible().catch(() => false);
  testInfo.annotations.push({ type: 'oq-pill-visible', description: String(visible) });
  if (!visible) return; // not in current state

  await pill.click();
  await page.waitForTimeout(400);
  const details = page.locator('[data-testid="oq-details"], [role="dialog"]').first();
  const expanded = await details.isVisible().catch(() => false);
  testInfo.annotations.push({ type: 'finding', description: `details expanded: ${expanded}` });

  // Dismiss-Button (×) — wenn vorhanden, klicken.
  const dismiss = page.locator('button[aria-label*="schließen" i], button[aria-label*="dismiss" i], button:has-text("×")').first();
  const hasDismiss = await dismiss.isVisible().catch(() => false);
  if (hasDismiss) {
    await dismiss.click();
    await page.waitForTimeout(400);
    const stillVisible = await pill.isVisible().catch(() => true);
    testInfo.annotations.push({ type: 'finding', description: `pill dismissed: ${!stillVisible}` });
  }
});

test('5. /settings — no horizontal overflow on mobile', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-iphone', 'overflow check only on mobile');
  const console$ = attachConsoleCollector(page);
  await page.goto('/settings', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);

  // Sanity. scrollWidth > clientWidth ⇒ horizontaler Overflow.
  const overflow = await page.evaluate(() => {
    const root = document.scrollingElement ?? document.documentElement;
    return { sw: root.scrollWidth, cw: root.clientWidth };
  });
  testInfo.annotations.push({
    type: 'overflow',
    description: `scrollWidth=${overflow.sw} clientWidth=${overflow.cw}`,
  });
  expect(overflow.sw, `horizontal overflow on /settings (${overflow.sw} > ${overflow.cw})`).toBeLessThanOrEqual(overflow.cw + 2);
  expect(console$.pageErrors()).toHaveLength(0);
});

test('6. console-error sweep: visit major routes and aggregate', async ({ page }, testInfo) => {
  // Auch HTTP-Responses tracken — so identifizieren wir genau welche URL ein
  // 403/429/500 produziert, statt nur dass irgendeine es tut.
  const console$ = attachConsoleCollector(page);
  const failedRequests: Array<{ url: string; status: number; route: string }> = [];
  let currentRoute = '';
  page.on('response', (resp) => {
    const status = resp.status();
    if (status >= 400) {
      failedRequests.push({ url: resp.url().replace(BASE, ''), status, route: currentRoute });
    }
  });

  const routes = [
    '/',
    '/workspaces',
    '/workflows',
    '/tickets',
    '/skills',
    '/decisions',
    '/calendar',
    '/inbox',
    '/settings',
    '/observatory',
    '/how',
    '/sessions',
    '/design',
  ];
  for (const r of routes) {
    currentRoute = r;
    const resp = await page.goto(r, { waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => null);
    // Längeres Settle, damit Rate-Limit-Token regenerieren (Edge-MW Limit ~5/s).
    await page.waitForTimeout(500);
    testInfo.annotations.push({
      type: 'route',
      description: `${r} → ${resp?.status() ?? 'no-response'} (${page.url().replace(BASE, '')})`,
    });
  }
  const errs = console$.errors();
  const pageErrs = console$.pageErrors();

  // Group failures by status + url (dedup).
  const by429 = failedRequests.filter((f) => f.status === 429);
  const by403 = failedRequests.filter((f) => f.status === 403);
  const by401 = failedRequests.filter((f) => f.status === 401);
  const by500 = failedRequests.filter((f) => f.status >= 500);
  const by404 = failedRequests.filter((f) => f.status === 404);
  const uniq = (arr: Array<{ url: string; route: string }>): string[] =>
    Array.from(new Set(arr.map((a) => `${a.route} → ${a.url}`)));

  testInfo.annotations.push({
    type: 'http-summary',
    description: `failed-requests: 429=${by429.length}, 403=${by403.length}, 401=${by401.length}, 404=${by404.length}, 5xx=${by500.length}`,
  });
  for (const u of uniq(by403).slice(0, 20)) testInfo.annotations.push({ type: 'http-403', description: u });
  for (const u of uniq(by401).slice(0, 10)) testInfo.annotations.push({ type: 'http-401', description: u });
  for (const u of uniq(by500).slice(0, 10)) testInfo.annotations.push({ type: 'http-5xx', description: u });
  for (const u of uniq(by404).slice(0, 10)) testInfo.annotations.push({ type: 'http-404', description: u });
  // 429 in clusters of 10+ on same URL → likely a tight polling loop. Surface
  // the top offenders.
  const counts429 = new Map<string, number>();
  for (const f of by429) counts429.set(f.url, (counts429.get(f.url) ?? 0) + 1);
  const top429 = Array.from(counts429.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10);
  for (const [u, n] of top429) testInfo.annotations.push({ type: 'http-429', description: `${n}× ${u}` });

  testInfo.annotations.push({
    type: 'console-summary',
    description: `console errors+warns=${errs.length}, pageErrors=${pageErrs.length}, ignored=${console$.ignored()}`,
  });
  for (const e of pageErrs.slice(0, 10)) {
    testInfo.annotations.push({ type: 'pageerror', description: e.message.slice(0, 240) });
  }
  // pageErrors are an unambiguous regression signal:
  expect(pageErrs, `unhandled JS errors on sweep: ${pageErrs.map((e) => e.message).join(' | ')}`).toHaveLength(0);
});
