#!/usr/bin/env node
/**
 * scripts/e2e-render-check.cjs — Wiederverwendbarer E2E-Render-Check-Harness
 * (2026-05-30, QA-Engineer Opus 4.8).
 *
 * WARUM: Owner fährt Auto + kann nicht selbst testen. Dieser Harness schießt
 * BEIDE Achsen über mehrere Breakpoints und sammelt pro Shot harte
 * Render-Metriken (horizontaler Overflow, Touch-Target-Verstöße, Sektions-
 * Präsenz, Surface-Marker, „SURFACE STREAMT"-Platzhalter, kaputte Bilder), damit
 * die anschließende visuelle PNG-Analyse gezielt ist.
 *
 * Zwei Modi:
 *   mode=site  — eine roh-geserved Website (z.B. http://127.0.0.1:4362) prüfen.
 *               Kein Login. Misst Sektionen, Overflow, Kontaktformular, Footer.
 *   mode=app   — die laz.ing-App (:4200). Login via master-login + Workspace-
 *               Switch (localStorage lazyos.workspace + lazyos.org-Cookie),
 *               misst Chat/Surface/preview-Karte/ActionDeck/Top-Bar-Overflow.
 *
 * Breakpoints frei wählbar (Default: 1280 desktop, 390 mobil, 360 mobil-eng).
 *
 * Usage:
 *   mode=site URL=http://127.0.0.1:4362 OUT=/tmp/e2e/site node scripts/e2e-render-check.cjs
 *   mode=app  AC=<code> WS=website OUT=/tmp/e2e/app node scripts/e2e-render-check.cjs
 *   Optional: BP="1280,390,360"  BASE=http://127.0.0.1:4200  ORG=example-company
 *
 * Playwright kommt aus dem npx-Cache (kein lokales node_modules nötig).
 * Stdout: JSON-Report { mode, shots:[{viewport,png,metrics}], ... }.
 */
const fs = require('fs');
const path = require('path');

function findPlaywright() {
  try { require.resolve('playwright'); return 'playwright'; } catch {}
  const base = path.join(process.env.HOME || '', '.npm', '_npx');
  if (fs.existsSync(base)) {
    for (const d of fs.readdirSync(base)) {
      const p = path.join(base, d, 'node_modules', 'playwright');
      if (fs.existsSync(p)) return p;
    }
  }
  throw new Error('playwright not found (local node_modules or npx cache)');
}

const BP_PRESETS = {
  1280: { width: 1280, height: 1600, label: 'desktop-1280' },
  390: { width: 390, height: 844, label: 'mobile-390' },
  360: { width: 360, height: 800, label: 'mobile-360' },
};
function vp(w) {
  return BP_PRESETS[w] || { width: Number(w), height: 900, label: `vp-${w}` };
}

// In-Page-Render-Audit: läuft im Browser-Kontext.
function pageAudit() {
  const doc = document;
  const de = doc.documentElement;
  const horizOverflow = Math.max(0, de.scrollWidth - de.clientWidth);
  // Elemente die über den rechten Rand ragen (Overflow-Verursacher)
  const vw = de.clientWidth;
  const offenders = [];
  for (const el of doc.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.right > vw + 2) {
      offenders.push({
        tag: el.tagName.toLowerCase(),
        cls: (el.className && typeof el.className === 'string') ? el.className.slice(0, 60) : '',
        right: Math.round(r.right),
        w: Math.round(r.width),
        txt: (el.innerText || '').trim().slice(0, 40),
      });
    }
    if (offenders.length > 40) break;
  }
  // Touch-Target-Audit: interaktive Elemente < 44px (eine Dimension) mit Inhalt.
  const smallTargets = [];
  for (const el of doc.querySelectorAll('a,button,input,select,textarea,[role="button"]')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.height < 44 || r.width < 28) {
      smallTargets.push({
        tag: el.tagName.toLowerCase(),
        h: Math.round(r.height),
        w: Math.round(r.width),
        txt: (el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim().slice(0, 30),
      });
    }
    if (smallTargets.length > 40) break;
  }
  // Kaputte Bilder
  const imgs = [...doc.querySelectorAll('img')];
  const brokenImgs = imgs.filter((i) => i.complete && i.naturalWidth === 0).length;
  // Surface-/Stream-Marker
  const html = doc.body.innerHTML;
  const surfaceMarkers = [...new Set((html.match(/surface:[a-z-]+/g) || []))];
  const streamtCount = (doc.body.innerText.match(/SURFACE STREAMT/gi) || []).length;
  // Sektions-Präsenz (Heuristik über Text + Tags)
  const bodyText = doc.body.innerText;
  const sectionTags = [...doc.querySelectorAll('section,header,footer,nav,form')].map((e) => e.tagName.toLowerCase());
  const hasForm = !!doc.querySelector('form') || doc.querySelectorAll('input,textarea').length >= 2;
  const hasFooter = !!doc.querySelector('footer') || /©|impressum|datenschutz|all rights|alle rechte/i.test(bodyText.slice(-600));
  return {
    horizOverflow,
    viewportW: vw,
    docScrollW: de.scrollWidth,
    overflowOffenders: offenders.slice(0, 12),
    overflowOffenderCount: offenders.length,
    smallTouchTargets: smallTargets.slice(0, 12),
    smallTouchTargetCount: smallTargets.length,
    brokenImgs,
    imgCount: imgs.length,
    surfaceMarkers,
    streamtCount,
    sectionTagCounts: sectionTags.reduce((a, t) => ((a[t] = (a[t] || 0) + 1), a), {}),
    hasForm,
    hasFooter,
    title: doc.title,
    bodyTextLen: bodyText.length,
    headings: [...doc.querySelectorAll('h1,h2,h3')].map((e) => (e.innerText || '').trim()).filter(Boolean).slice(0, 24),
    bodyHead: bodyText.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 8).join(' | ').slice(0, 240),
    bodyTail: bodyText.split('\n').map((s) => s.trim()).filter(Boolean).slice(-6).join(' | ').slice(0, 240),
  };
}

async function shootSite(ctx, url, outDir, bps, L) {
  const shots = [];
  for (const w of bps) {
    const v = vp(w);
    const page = await ctx.newPage();
    await page.setViewportSize({ width: v.width, height: v.height });
    const resp = await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 }).catch((e) => ({ err: e.message }));
    await page.waitForTimeout(1500);
    const png = path.join(outDir, `site-${v.label}.png`);
    await page.screenshot({ path: png, fullPage: true });
    const metrics = await page.evaluate(pageAudit).catch((e) => ({ err: e.message }));
    L('SITE', v.label, png, 'overflow=' + (metrics.horizOverflow ?? '?'));
    shots.push({ viewport: v.label, png, status: resp && resp.status ? resp.status() : (resp && resp.err) || '?', metrics });
    await page.close();
  }
  return shots;
}

async function shootApp(ctx, base, ws, org, code, outDir, bps, L) {
  // Login einmal pro Kontext.
  const login = await ctx.request.post(base + '/api/auth/master-login', {
    headers: { 'content-type': 'application/json', origin: base },
    data: { accessCode: code },
  });
  L('LOGIN', login.status());
  await ctx.addCookies([{ name: 'lazyos.org', value: org, url: base }]);
  await ctx.addInitScript(([wsKey, wsVal, orgKey, orgVal]) => {
    try { window.localStorage.setItem(orgKey, orgVal); window.localStorage.setItem(wsKey, wsVal); } catch {}
  }, ['lazyos.workspace', ws, 'lazyos.org', org]);

  const shots = [];
  for (const w of bps) {
    const v = vp(w);
    const page = await ctx.newPage();
    await page.setViewportSize({ width: v.width, height: v.height });
    await page.goto(`${base}/orgs/${encodeURIComponent(org)}/chat`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e) => L('goto-err', e.message));
    await page.waitForTimeout(2500);
    await page.evaluate((id) => {
      try {
        window.localStorage.setItem('lazyos.workspace', id);
        window.dispatchEvent(new CustomEvent('workspace-change', { detail: { workspace: { id } } }));
      } catch {}
    }, ws).catch(() => {});
    await page.waitForTimeout(6000); // Surfaces/History laden
    const png = path.join(outDir, `app-${v.label}.png`);
    await page.screenshot({ path: png, fullPage: true });
    const metrics = await page.evaluate(pageAudit).catch((e) => ({ err: e.message }));
    // App-spezifisch: preview-Surface + Top-Bar-Overflow + Composer
    const appExtra = await page.evaluate(() => {
      const t = document.body.innerText;
      return {
        hasComposer: !!document.querySelector('textarea'),
        previewCard: /surface:preview|Vorschau|Preview|http:\/\/127\.0\.0\.1:4362/i.test(document.body.innerHTML),
        previewLink: [...document.querySelectorAll('a')].map((a) => a.href).filter((h) => /4362/.test(h)).slice(0, 4),
        runCockpit: /run-cockpit|Cockpit|Fortschritt|Schritt \d|Lauf|completed|abgeschlossen/i.test(t),
        actionDeck: !!document.querySelector('[class*="action"],[class*="deck"],[class*="pinned"]'),
        streamtPlaceholder: (t.match(/SURFACE STREAMT/gi) || []).length,
        wsActive: (() => { try { return localStorage.getItem('lazyos.workspace'); } catch { return null; } })(),
      };
    }).catch((e) => ({ err: e.message }));
    L('APP', v.label, png, 'overflow=' + (metrics.horizOverflow ?? '?'), 'preview=' + appExtra.previewCard);
    shots.push({ viewport: v.label, png, metrics, app: appExtra });
    await page.close();
  }
  return { loginStatus: login.status(), shots };
}

async function main() {
  const mode = process.env.mode || process.env.MODE;
  const outDir = process.env.OUT || '/tmp/e2e';
  const bps = (process.env.BP || '1280,390,360').split(',').map((s) => s.trim()).filter(Boolean);
  fs.mkdirSync(outDir, { recursive: true });
  const log = [];
  const L = (...a) => { const s = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '); log.push(s); console.error(s); };

  if (!mode || !['site', 'app'].includes(mode)) {
    console.error('mode=site|app required'); process.exit(2);
  }

  const { chromium } = require(findPlaywright());
  const b = await chromium.launch();
  try {
    const ctx = await b.newContext({ ignoreHTTPSErrors: true, deviceScaleFactor: 2 });
    const consoleErrs = [];
    ctx.on('console', (m) => { if (m.type() === 'error') consoleErrs.push(m.text().slice(0, 300)); });
    ctx.on('weberror', (e) => consoleErrs.push('PAGEERR ' + String(e.error()).slice(0, 300)));

    let out;
    if (mode === 'site') {
      const url = process.env.URL;
      if (!url) { console.error('URL required for mode=site'); process.exit(2); }
      const shots = await shootSite(ctx, url, outDir, bps, L);
      out = { mode, url, shots };
    } else {
      const code = process.env.AC;
      if (!code) { console.error('AC (access code) required for mode=app'); process.exit(2); }
      const base = process.env.BASE || 'http://127.0.0.1:4200';
      const ws = process.env.WS || 'website';
      const org = process.env.ORG || 'example-company';
      const r = await shootApp(ctx, base, ws, org, code, outDir, bps, L);
      out = { mode, base, ws, org, ...r };
    }
    out.consoleErrs = consoleErrs.slice(0, 25);
    fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(out, null, 2));
    fs.writeFileSync(path.join(outDir, 'log.txt'), log.join('\n'));
    console.log(JSON.stringify(out, null, 2));
  } finally {
    await b.close();
  }
}
main().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
