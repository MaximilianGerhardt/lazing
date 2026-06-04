/* Reusable chat probe for the Codex-parity goal. Run from tests/active.
   Env: BASE (default :4200), PROBE_WS (optional ?ws=), PROBE_PROMPT, OUT (dir). */
const { chromium } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const BASE = process.env.LAZYOS_SMOKE_BASE_URL || 'http://127.0.0.1:4200';
const CODE = process.env.LAZYOS_ACCESS_CODE;
const OUT = process.env.OUT || '/tmp/lazyos-chat-probe';
const PROMPT = process.env.PROBE_PROMPT || 'Was ist 7 mal 8? Antworte in einem kurzen Satz.';
const WS = process.env.PROBE_WS || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  if (!CODE) throw new Error('LAZYOS_ACCESS_CODE not set');
  const b = await chromium.launch({ headless: true });
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
  await ctx.request.post(`${BASE}/api/auth/master-login`, { headers: { 'content-type': 'application/json', origin: BASE }, data: { accessCode: CODE } });
  const p = await ctx.newPage();
  const cerr = [], perr = [], failed = [];
  p.on('console', (m) => { if ((m.type() === 'error' || m.type() === 'warning') && !/DevTools|Analytics|Fast Refresh|HMR|Hydration completed/i.test(m.text())) cerr.push(m.text().slice(0, 160)); });
  p.on('pageerror', (e) => perr.push(e.message.slice(0, 160)));
  p.on('response', (r) => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url().replace(BASE, '')}`); });

  await p.goto(WS ? `${BASE}/?ws=${encodeURIComponent(WS)}` : `${BASE}/`, { waitUntil: 'domcontentloaded' });
  await sleep(2800);
  // count assistant bubbles BEFORE sending, so we can isolate the NEW one
  const before = await p.locator('.msg-a').count();
  const wsLabel = await p.evaluate(() => {
    const el = document.querySelector('[class*="workspace" i] , header'); return document.title + ' :: ' + (document.body.innerText.split('\n').slice(0,4).join(' | '));
  });

  const ta = p.locator('textarea').last();
  await ta.click(); await ta.fill(PROMPT); await ta.press('Enter');
  const stop = p.locator('[aria-label="Antwort stoppen"]');
  for (let t = 0; t < 30; t++) { await sleep(700); if (!(await stop.isVisible().catch(() => false)) && t > 3) break; }
  await sleep(1500);
  await p.evaluate(() => { const sc = [...document.querySelectorAll('*')].filter((el) => { const s = getComputedStyle(el); return (s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 40; }).sort((a, b) => b.scrollHeight - a.scrollHeight)[0]; if (sc) sc.scrollTop = sc.scrollHeight; });
  await sleep(700);

  const after = await p.locator('.msg-a').count();
  // newest assistant bubble text (the response to our prompt)
  const newest = await p.locator('.msg-a').last().innerText().catch(() => '');
  await p.locator('.msg-a').last().hover().catch(() => {});
  await sleep(300);
  await p.screenshot({ path: path.join(OUT, 'probe-final.png') });

  console.log('WS header/title:', wsLabel.slice(0, 120));
  console.log('assistant bubbles before/after:', before, '/', after);
  console.log('\n=== NEWEST assistant response (to our prompt) ===');
  console.log(newest.slice(0, 600));
  console.log('\nfailed reqs:', failed.length ? [...new Set(failed)].join(', ') : '(none)');
  console.log('console errs:', cerr.length ? cerr.slice(0, 5).join(' | ') : '(none)');
  console.log('page errors:', perr.length ? perr.join(' | ') : '(none)');
  await b.close();
})().catch((e) => { console.error('PROBE FAIL:', e.message); process.exit(1); });
