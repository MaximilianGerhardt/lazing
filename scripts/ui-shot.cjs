#!/usr/bin/env node
/**
 * scripts/ui-shot.cjs — Reusable Browser-Test-Harness (2026-05-29, Opus 4.8).
 *
 * WARUM: Owner-Mandat „echtes Browsertesting + Screenshots + UI/UX-Auswertung".
 * Verifiziert das LIVE-gerenderte UI eines BESTIMMTEN Workspace (nicht nur die
 * Daten-API). Der Workspace-Switch passiert client-seitig über
 * localStorage['lazyos.workspace'] (+ optional lazyos.org-Cookie) — ein bloßes
 * ?ws= reicht NICHT (nur Org-Root-Hint). Wir setzen beides via addInitScript
 * BEVOR die App-Skripte laufen.
 *
 * Playwright ist NICHT in lokalen node_modules — wir laden es aus dem
 * npx-Cache (dynamisch gefunden). Browser sind unter ~/Library/Caches/ms-playwright.
 *
 * Usage:
 *   AC=<accessCode> node scripts/ui-shot.cjs <workspaceId> <outPng> [viewport] [orgId]
 *   viewport: 'desktop' (1280x1600) | 'mobile' (390x844). Default desktop.
 * Stdout: JSON { ok, ws, viewport, assertions:{drift,offeneFragen,rawJson,...}, bodyHead }.
 */
const fs = require('fs');
const path = require('path');

function findPlaywright() {
  // 1. lokale node_modules (falls je installiert)
  try { require.resolve('playwright'); return 'playwright'; } catch {}
  // 2. npx-Cache
  const base = path.join(process.env.HOME || '', '.npm', '_npx');
  if (fs.existsSync(base)) {
    for (const d of fs.readdirSync(base)) {
      const p = path.join(base, d, 'node_modules', 'playwright');
      if (fs.existsSync(p)) return p;
    }
  }
  throw new Error('playwright not found (local node_modules or npx cache)');
}

async function main() {
  const [, , wsId, outPng, viewportArg, orgIdArg] = process.argv;
  if (!wsId || !outPng) {
    console.error('usage: AC=<code> node scripts/ui-shot.cjs <wsId> <outPng> [desktop|mobile] [orgId]');
    process.exit(2);
  }
  const code = process.env.AC;
  if (!code) { console.error('AC env (access code) required'); process.exit(2); }
  const BASE = process.env.BASE || 'http://127.0.0.1:4200';
  const orgId = orgIdArg || 'example-company';
  const viewport = viewportArg === 'mobile'
    ? { width: 390, height: 844 }
    : { width: 1280, height: 1600 };

  const { chromium } = require(findPlaywright());
  const b = await chromium.launch();
  try {
    const ctx = await b.newContext({ ignoreHTTPSErrors: true, viewport, deviceScaleFactor: 2 });
    const login = await ctx.request.post(BASE + '/api/auth/master-login', {
      headers: { 'content-type': 'application/json', origin: BASE },
      data: { accessCode: code },
    });
    // Workspace-Switch VOR App-Boot: localStorage + org-cookie.
    await ctx.addCookies([{ name: 'lazyos.org', value: orgId, url: BASE }]);
    await ctx.addInitScript(([k, v]) => {
      try { window.localStorage.setItem(k, v); } catch {}
    }, ['lazyos.workspace', wsId]);

    const page = await ctx.newPage();
    await page.goto(`${BASE}/?ws=${encodeURIComponent(wsId)}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(8000); // Surfaces/History laden lassen
    await page.screenshot({ path: outPng, fullPage: true });

    const t = await page.locator('body').innerText().catch(() => '');
    const result = {
      ok: true,
      login: login.status(),
      ws: wsId,
      viewport: viewportArg === 'mobile' ? 'mobile' : 'desktop',
      png: outPng,
      assertions: {
        drift: /Warum diesmal anders|weicht von der bisherigen/.test(t),
        offeneFragen: /Offene Fragen/.test(t),
        rawJson: /"type":"result"|is_error":/.test(t),
        sessionEndNoise: /SessionEnd hook|MODULE_NOT_FOUND/.test(t),
        loadedWsHint: t.split('\n').filter(Boolean).slice(0, 8).join(' | ').slice(0, 200),
      },
    };
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await b.close();
  }
}
main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
