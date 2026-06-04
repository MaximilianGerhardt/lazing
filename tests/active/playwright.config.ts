/**
 * tests/active/playwright.config.ts
 *
 * Lokales Smoke-Setup gegen die LAUFENDE Instanz auf :4200. KEIN webServer-
 * Start (next start / next dev wird vom Owner verwaltet). Headless default,
 * `PLAYWRIGHT_HEADED=1 pnpm exec playwright test --config ...` für Debug.
 */

import path from 'node:path';

import { defineConfig, devices } from '@playwright/test';

const BASE = process.env.LAZYOS_SMOKE_BASE_URL ?? 'http://127.0.0.1:4200';
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const JSON_OUT = path.join(REPO_ROOT, 'docs', 'audits', '2026-05-28_playwright-report.json');
// Phase 1 Wave 2 (2026-05-29): separate JSON für Browser-E2E-Lauf, damit
// der Wave-1-ui-smoke-Report nicht überschrieben wird wenn beides nebeneinander
// läuft. Wir filtern in der Reporter-Liste später nach grep, hier sicherheits-
// halber ein eigener Pfad als Default; via PLAYWRIGHT_JSON_OUT überstellbar.
const JSON_OUT_OVERRIDE = process.env.PLAYWRIGHT_JSON_OUT;

export default defineConfig({
  testDir: './',
  testMatch: ['**/*.spec.ts'],
  // Wave-2-Tests können bis 180s pro Test laufen (Compose + Discovery + LLM).
  // Wave-1-Smokes setzen ihr eigenes test.setTimeout falls nötig.
  timeout: 180_000,
  expect: { timeout: 10_000 },
  fullyParallel: false, // shared cookie + DB → keep deterministic
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: [
    ['list'],
    ['json', { outputFile: JSON_OUT_OVERRIDE ?? JSON_OUT }],
    ['html', { open: 'never', outputFolder: path.join(REPO_ROOT, 'docs', 'audits', '2026-05-28_playwright-html') }],
  ],
  use: {
    baseURL: BASE,
    headless: !process.env.PLAYWRIGHT_HEADED,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ignoreHTTPSErrors: true,
    // Cookie-based session is injected per-test via storageState; no global.
  },
  projects: [
    {
      name: 'desktop-chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
    {
      name: 'mobile-iphone',
      // Use Pixel-5 device (Chromium-based emulation) to avoid the additional
      // WebKit download dance. Equivalent viewport/touch profile for our smoke
      // purposes (393 × 851, touch). For real iOS-Safari fidelity, swap to
      // devices['iPhone 14'] and install webkit.
      use: { ...devices['Pixel 5'] },
    },
  ],
});
