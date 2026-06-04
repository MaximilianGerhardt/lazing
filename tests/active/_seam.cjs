/* Verifiziert die Auto-Projekt-Naht: org-root → Build-Intent → Projekt+Switch+Bau. */
const { chromium } = require('@playwright/test');
const fs = require('node:fs');
const BASE = process.env.LAZYOS_SMOKE_BASE_URL || 'http://127.0.0.1:4200';
const CODE = process.env.LAZYOS_ACCESS_CODE;
const ROOT = process.env.LAZYOS_PROJECTS_ROOT || require('node:path').join(require('node:os').homedir(), 'lazyos-workspaces');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PROMPT = process.env.SEAM_PROMPT || 'Bau mir einen simplen Countdown-Timer als kleine App. Leg einfach los.';

(async () => {
  const b = await chromium.launch({ headless: true });
  const ctx = await b.newContext({ viewport: { width: 1100, height: 860 }, deviceScaleFactor: 2 });
  await ctx.request.post(`${BASE}/api/auth/master-login`, { headers: { 'content-type': 'application/json', origin: BASE }, data: { accessCode: CODE } });
  const p = await ctx.newPage();
  const perr = []; p.on('pageerror', (e) => perr.push(e.message.slice(0, 120)));
  await p.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await sleep(3500);
  const startUrl = p.url();
  console.log('Start-URL:', startUrl.replace(BASE, '') || '/');
  const ta = p.locator('textarea').last();
  await ta.click(); await ta.fill(PROMPT); await ta.press('Enter');
  // auf Navigation in den neuen Workspace warten (?ws=)
  let newWs = null;
  for (let t = 0; t < 30; t++) {
    await sleep(700);
    const u = p.url();
    const m = u.match(/[?&]ws=([^&]+)/); if (m && /^__/.test(decodeURIComponent(m[1]))) continue;
    if (m) { newWs = decodeURIComponent(m[1]); break; }
  }
  console.log('→ navigiert zu Workspace:', newWs || '(KEINE Navigation!)');
  if (!newWs) { console.log('FAIL: keine Auto-Projekt-Navigation'); await b.close(); return; }
  // jetzt sollte auto-submit feuern + der Agent bauen → Datei im WS-Pfad
  const dir = `${ROOT}/${newWs}`;
  let built = [];
  for (let t = 0; t < 90; t++) {
    await sleep(2000);
    try { built = fs.readdirSync(dir).filter((f) => !f.startsWith('.')); } catch {}
    if (built.length > 0) break;
  }
  console.log('gebaute Datei(en) in', dir.replace(ROOT + '/', ''), ':', built.length ? built.join(', ') : '(noch keine)');
  await sleep(2000);
  await p.evaluate(() => { const sc = [...document.querySelectorAll('*')].filter((el) => { const s = getComputedStyle(el); return (s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 40; }).sort((a, b) => b.scrollHeight - a.scrollHeight)[0]; if (sc) sc.scrollTop = sc.scrollHeight; });
  await sleep(600);
  await p.screenshot({ path: '/tmp/lazyos-flow/seam.png', fullPage: true });
  console.log('Ergebnis:', built.length > 0 ? 'SEAM OK — Projekt angelegt, gewechselt, App gebaut' : 'Build noch nicht fertig/fehlgeschlagen');
  console.log('page errors:', perr.length ? perr.join(' | ') : '(none)');
  await b.close();
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
