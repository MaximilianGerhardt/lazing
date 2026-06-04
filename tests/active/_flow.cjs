/* Multi-Turn Flow-Test: Brainstorm → Mini-App-Idee → Bau. Aus User-Sicht. */
const { chromium } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const BASE = process.env.LAZYOS_SMOKE_BASE_URL || 'http://127.0.0.1:4200';
const CODE = process.env.LAZYOS_ACCESS_CODE;
const WS = process.env.PROBE_WS || 'lesetracker-test';
const OUT = '/tmp/lazyos-flow';
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TURNS = [
  { t: 'Hey, ich lese in letzter Zeit viel, verliere aber den Überblick was ich schon durch hab und wie viel pro Woche. Hast du eine Idee, wie ich das einfacher machen könnte?', wait: 60 },
  { t: 'Eine kleine App klingt gut. Was müsste die mindestens können, damit sie wirklich nützlich ist — aber nicht überladen?', wait: 60 },
  { t: 'Okay, lass uns das als Mini-App bauen: Bücher anlegen, gelesene Seiten pro Tag eintragen, und eine simple Wochen-Statistik mit kleinem Chart. Mach mir kurz einen Plan und dann leg los.', wait: 150 },
];

async function settle(page, maxS) {
  const stop = page.locator('[aria-label="Antwort stoppen"]');
  // warte bis streaming startet, dann bis es endet
  for (let t = 0; t < 12; t++) { await sleep(500); if (await stop.isVisible().catch(() => false)) break; }
  const deadline = Date.now() + maxS * 1000;
  while (Date.now() < deadline) {
    await sleep(800);
    if (!(await stop.isVisible().catch(() => false))) break;
  }
  await sleep(2500); // plan-dispatch fire-and-forget nachlaufen lassen
}

async function scrollBottom(page) {
  await page.evaluate(() => {
    const sc = [...document.querySelectorAll('*')].filter((el) => { const s = getComputedStyle(el); return (s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 40; }).sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
    if (sc) sc.scrollTop = sc.scrollHeight;
  });
}

(async () => {
  if (!CODE) throw new Error('LAZYOS_ACCESS_CODE not set');
  const b = await chromium.launch({ headless: true });
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
  await ctx.request.post(`${BASE}/api/auth/master-login`, { headers: { 'content-type': 'application/json', origin: BASE }, data: { accessCode: CODE } });
  await ctx.addInitScript((ws) => {
    try { localStorage.setItem('lazyos.workspace', ws); localStorage.setItem('lazyos.chat.history.migrated.' + ws, '1'); } catch (e) {}
  }, WS);
  const p = await ctx.newPage();
  const failed = [], perr = [];
  p.on('response', (r) => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url().replace(BASE, '')}`); });
  p.on('pageerror', (e) => perr.push(e.message.slice(0, 140)));

  await p.goto(`${BASE}/?ws=${encodeURIComponent(WS)}`, { waitUntil: 'domcontentloaded' });
  await sleep(3500);
  const header = (await p.evaluate(() => document.body.innerText)).split('\n').filter((l) => l.trim()).slice(0, 5).join(' | ');
  console.log('WS-Header:', header.slice(0, 120));

  for (let i = 0; i < TURNS.length; i++) {
    const turn = TURNS[i];
    const ta = p.locator('textarea').last();
    await ta.click(); await ta.fill(turn.t); await ta.press('Enter');
    await settle(p, turn.wait);
    await scrollBottom(p);
    await sleep(600);
    const newest = await p.locator('.msg-a').last().innerText().catch(() => '');
    const planCards = await p.locator('.srf-subplan').count();
    await p.screenshot({ path: path.join(OUT, `turn${i + 1}.png`) });
    console.log(`\n========== TURN ${i + 1} ==========`);
    console.log('USER:', turn.t.slice(0, 90));
    console.log('plan-cards sichtbar:', planCards);
    console.log('ASSISTANT (newest .msg-a):\n' + newest.slice(0, 700));
  }

  // Gesamt-Snapshot
  await p.screenshot({ path: path.join(OUT, 'full.png'), fullPage: true });
  const allText = await p.evaluate(() => document.body.innerText);
  fs.writeFileSync(path.join(OUT, 'transcript.txt'), allText);
  console.log('\n=== failed reqs:', failed.length ? [...new Set(failed)].join(', ') : '(none)');
  console.log('=== page errors:', perr.length ? perr.join(' | ') : '(none)');
  await b.close();
})().catch((e) => { console.error('FLOW FAIL:', e.message); process.exit(1); });
