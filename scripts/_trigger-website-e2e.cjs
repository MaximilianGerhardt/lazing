#!/usr/bin/env node
/**
 * _trigger-website-e2e.cjs (2026-05-30) — startet EINEN echten „Erstelle eine
 * Website"-Lauf im laufenden :4200-Server (der die ENV-Flags AUTO_MERGE/SERVE
 * trägt). Medien-freier Prompt → kein needs-style-choice-Halt → dispatcht direkt.
 * Login + Workspace-Switch übernommen aus ui-interactive.cjs.
 *
 * Usage: AC=<code> node scripts/_trigger-website-e2e.cjs [website] [orgId] ["<intent>"]
 */
const fs = require('fs');
const path = require('path');
function findPlaywright() {
  try { require.resolve('playwright'); return 'playwright'; } catch {}
  const base = path.join(process.env.HOME || '', '.npm', '_npx');
  for (const d of fs.existsSync(base) ? fs.readdirSync(base) : []) {
    const p = path.join(base, d, 'node_modules', 'playwright');
    if (fs.existsSync(p)) return p;
  }
  throw new Error('playwright not found');
}
function L(...a) { console.error(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); }

async function main() {
  const wsId = process.argv[2] || 'website';
  const orgId = process.argv[3] || 'example-company';
  const intent = process.argv[4] ||
    'Erstelle eine moderne, schlichte Website fuer eine Beispiel-Firma namens Nordlicht Studio mit Hero, Leistungen, Referenzen und Kontakt. Apple-artiges, ruhiges Design.';
  const code = process.env.AC;
  if (!code) { console.error('AC env required'); process.exit(2); }
  const BASE = process.env.BASE || 'http://127.0.0.1:4200';
  const { chromium } = require(findPlaywright());
  const b = await chromium.launch();
  try {
    const ctx = await b.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 1800 } });
    const flowResponses = [];
    ctx.on('response', async (res) => {
      if (!/\/api\/flow\/compose-and-run/.test(res.url())) return;
      const e = { status: res.status(), method: res.request().method() };
      try { e.body = (await res.text()).slice(0, 800); } catch {}
      flowResponses.push(e);
      L('FLOW-RESP', JSON.stringify(e));
    });
    const login = await ctx.request.post(BASE + '/api/auth/master-login', {
      headers: { 'content-type': 'application/json', origin: BASE },
      data: { accessCode: code },
    });
    L('LOGIN', login.status());
    await ctx.addCookies([{ name: 'lazyos.org', value: orgId, url: BASE }]);
    await ctx.addInitScript(([wsKey, wsVal, orgKey, orgVal]) => {
      try { window.localStorage.setItem(orgKey, orgVal); window.localStorage.setItem(wsKey, wsVal); } catch {}
    }, ['lazyos.workspace', wsId, 'lazyos.org', orgId]);
    const page = await ctx.newPage();
    await page.goto(`${BASE}/orgs/${encodeURIComponent(orgId)}/chat`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
    await page.evaluate((id) => {
      try { window.localStorage.setItem('lazyos.workspace', id); window.dispatchEvent(new CustomEvent('workspace-change', { detail: { workspace: { id } } })); } catch {}
    }, wsId).catch(() => {});
    await page.waitForTimeout(4000);
    const wsHint = await page.evaluate(() => ({ ws: localStorage.getItem('lazyos.workspace') })).catch((e) => ({ err: e.message }));
    L('WS-HINT', JSON.stringify(wsHint));
    const ta = page.locator('textarea').first();
    if (!(await ta.count())) { L('FATAL no composer'); throw new Error('no composer'); }
    await ta.click();
    await ta.fill(intent);
    await ta.press('Enter');
    L('SUBMITTED', intent.slice(0, 60));
    // Auf die compose-and-run-Antwort warten (dispatch/needs-*), dann Server macht weiter.
    await page.waitForTimeout(20000);
    L('FLOW-RESPONSES-TOTAL', flowResponses.length);
    for (const r of flowResponses) L('  ', JSON.stringify(r).slice(0, 700));
  } finally {
    await b.close();
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error('ERR', e.message); process.exit(1); });
