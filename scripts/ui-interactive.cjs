#!/usr/bin/env node
/**
 * scripts/ui-interactive.cjs — INTERAKTIVE Browser-QA-Session (2026-05-30, Opus 4.8).
 *
 * WARUM: Owner-Bugs im `website`-Chat REAL reproduzieren:
 *   1. Fragen doppelt / nur als Auswahl statt angepinnt
 *   2. Free-Text „Eigenes Video" bei aktiver Auswahl → „Stream-Fehler: Agent-Fehler"
 *   3. Kontextverlust nach Free-Text
 *   4. Surface-Proliferation / „SURFACE STREAMT"
 *
 * Treibt die UI: login → website-WS → tippe Website-Prompt → warte auf erste
 * Frage/Auswahl → tippe FREI „Eigenes Video" + Enter. Screenshotet jeden Schritt,
 * fängt Konsole-/Page-/Request-Fehler + ALLE /api/chat|flow-Responses inkl.
 * SSE-Body (event:text / event:done / event:error).
 *
 * Usage: AC=<code> node scripts/ui-interactive.cjs [website] [orgId]
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
  throw new Error('playwright not found');
}

const OUT = '/tmp/uishots';
fs.mkdirSync(OUT, { recursive: true });
const log = [];
function L(...a) { const s = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '); log.push(s); console.error(s); }

async function main() {
  const wsId = process.argv[2] || 'website';
  const orgId = process.argv[3] || 'example-company';
  const code = process.env.AC;
  if (!code) { console.error('AC env required'); process.exit(2); }
  const BASE = process.env.BASE || 'http://127.0.0.1:4200';

  const { chromium } = require(findPlaywright());
  const b = await chromium.launch();
  let step = 0;
  const shot = async (page, name) => {
    step += 1;
    const p = path.join(OUT, `${String(step).padStart(2, '0')}-${name}.png`);
    await page.screenshot({ path: p, fullPage: true }).catch((e) => L('screenshot-fail', name, e.message));
    L('SHOT', p);
    return p;
  };

  try {
    const ctx = await b.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 1800 }, deviceScaleFactor: 1 });

    // ---- Netzwerk + Konsole + Fehler einfangen --------------------------
    const netLog = [];
    const consoleErrs = [];
    const pageErrs = [];
    ctx.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') consoleErrs.push(`[${m.type()}] ${m.text()}`.slice(0, 500));
    });
    ctx.on('weberror', (e) => pageErrs.push(String(e.error()).slice(0, 500)));

    // SSE/JSON-Bodies der chat/flow-Calls mitschneiden.
    ctx.on('response', async (res) => {
      const u = res.url();
      if (!/\/api\/(chat|flow|orchestrator|workstreams)/.test(u)) return;
      const entry = { url: u.replace(BASE, ''), status: res.status(), method: res.request().method() };
      const ct = res.headers()['content-type'] || '';
      try {
        if (/event-stream/.test(ct)) {
          // SSE: body() liest den vollen (bereits abgeschlossenen) Stream.
          const body = await res.body().catch(() => null);
          if (body) {
            const txt = body.toString('utf8');
            entry.sseLen = txt.length;
            // event-Namen + error/done-Frames extrahieren
            const events = [...txt.matchAll(/event:\s*(\w+)/g)].map((m) => m[1]);
            const counts = {};
            for (const e of events) counts[e] = (counts[e] || 0) + 1;
            entry.sseEvents = counts;
            // error/done-data-Zeilen roh mitnehmen
            const errLines = txt.split('\n').filter((l) => /is_error|error|"subtype"|result_text|Agent/.test(l)).slice(0, 12);
            entry.sseErrLines = errLines.map((l) => l.slice(0, 400));
            entry.sseTail = txt.slice(-800);
          }
        } else if (/json/.test(ct) && res.status() >= 400) {
          entry.body = (await res.text().catch(() => '')).slice(0, 600);
        } else if (/json/.test(ct)) {
          const t = await res.text().catch(() => '');
          entry.bodyHead = t.slice(0, 300);
        }
      } catch (e) { entry.readErr = e.message; }
      entry.phase = global.__phase || 'init';
      netLog.push(entry);
      L('NET', JSON.stringify(entry).slice(0, 600));
    });

    // ---- Login (master-login) ------------------------------------------
    const login = await ctx.request.post(BASE + '/api/auth/master-login', {
      headers: { 'content-type': 'application/json', origin: BASE },
      data: { accessCode: code },
    });
    L('LOGIN', login.status());

    // BOTH localStorage keys + cookie VOR App-Boot. Ohne lazyos.org-localStorage
    // resettet die App den Workspace auf __org_root__:<default-org>.
    await ctx.addCookies([{ name: 'lazyos.org', value: orgId, url: BASE }]);
    await ctx.addInitScript(([wsKey, wsVal, orgKey, orgVal]) => {
      try {
        window.localStorage.setItem(orgKey, orgVal);
        window.localStorage.setItem(wsKey, wsVal);
      } catch {}
    }, ['lazyos.workspace', wsId, 'lazyos.org', orgId]);

    const page = await ctx.newPage();
    // Org-scoped Chat-Landing (Hard-Context-Switch-Pfad der App).
    await page.goto(`${BASE}/orgs/${encodeURIComponent(orgId)}/chat`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    // Aktiven Workspace IN der Seite hart auf `website` setzen (Switcher-Setter
    // nachbilden: localStorage + workspace-change-Event), dann kurz warten.
    await page.evaluate((id) => {
      try {
        window.localStorage.setItem('lazyos.workspace', id);
        window.dispatchEvent(new CustomEvent('workspace-change', { detail: { workspace: { id } } }));
      } catch {}
    }, wsId).catch((e) => L('switch-eval-fail', e.message));
    await page.waitForTimeout(4000);
    await shot(page, 'after-load');

    // Welcher Workspace ist wirklich aktiv? (DOM-Hint)
    const wsHint = await page.evaluate(() => ({
      ls: { ws: localStorage.getItem('lazyos.workspace'), org: localStorage.getItem('lazyos.org') },
      title: document.title,
      bodyHead: document.body.innerText.split('\n').filter(Boolean).slice(0, 10).join(' | ').slice(0, 300),
    })).catch((e) => ({ err: e.message }));
    L('WS-HINT', JSON.stringify(wsHint));

    // ---- Composer finden + Website-Prompt tippen -----------------------
    const ta = page.locator('textarea').first();
    const haveTa = await ta.count();
    L('textarea-count', haveTa);
    if (!haveTa) {
      await shot(page, 'no-composer');
      L('FATAL', 'kein textarea / Composer — UI nicht geladen (Login/Workspace?)');
      throw new Error('no composer');
    }

    await ta.click();
    await ta.fill('Erstelle eine Website für eine Beispiel-Firma');
    await shot(page, 'typed-website-prompt');
    global.__phase = "after-website-prompt";
    await ta.press('Enter');
    L('SUBMITTED website-prompt');

    // Auf erste Antwort / Frage / Auswahl warten (bis ~90s, Decompose dauert).
    let firstChoiceSeen = false;
    for (let i = 0; i < 18; i += 1) {
      await page.waitForTimeout(5000);
      const txt = await page.locator('body').innerText().catch(() => '');
      const hasChoice = /(Eigenes Video|Higgsfield|Heygen|Stil wählen|Wähle|Auswahl|Option|quickchoice)/i.test(txt);
      const streaming = /SURFACE STREAMT|streamt|generiert|denkt/i.test(txt);
      L(`poll#${i}`, JSON.stringify({ len: txt.length, hasChoice, streaming, head: txt.split('\n').filter(Boolean).slice(0, 6).join(' | ').slice(0, 200) }));
      if (i === 1) await shot(page, 'after-submit-5s');
      if (hasChoice && !firstChoiceSeen) { firstChoiceSeen = true; await shot(page, 'first-choice-or-question'); }
      if (firstChoiceSeen && i >= 3) break;
      if (i === 8) await shot(page, 'mid-wait');
    }
    await shot(page, 'state-before-freetext');

    // ---- DOM-Analyse: doppelte Fragen? Surfaces zählen -----------------
    const domAnalysis = await page.evaluate(() => {
      const txt = (s) => (s || '').trim();
      const all = [...document.querySelectorAll('button')].map((b) => txt(b.innerText)).filter(Boolean);
      const optionLike = all.filter((t) => /Video|Higgsfield|Heygen|Stil|Avatar/i.test(t));
      // grobe Surface-Zählung
      const surfaceMarkers = document.body.innerHTML.match(/surface:[a-z-]+/g) || [];
      const streamtCount = (document.body.innerText.match(/SURFACE STREAMT/gi) || []).length;
      // Fragen-Texte
      const questionTexts = [...document.querySelectorAll('h1,h2,h3,h4,p,div,label')]
        .map((e) => txt(e.innerText)).filter((t) => /\?$/.test(t) && t.length < 160);
      const dupQuestions = {};
      for (const q of questionTexts) dupQuestions[q] = (dupQuestions[q] || 0) + 1;
      const dups = Object.entries(dupQuestions).filter(([, n]) => n > 1);
      return {
        buttonCount: all.length,
        optionLikeButtons: optionLike,
        surfaceMarkerCount: surfaceMarkers.length,
        surfaceKinds: [...new Set(surfaceMarkers)],
        streamtPlaceholderCount: streamtCount,
        duplicateQuestions: dups,
        sampleQuestions: questionTexts.slice(0, 10),
      };
    }).catch((e) => ({ err: e.message }));
    L('DOM-ANALYSIS', JSON.stringify(domAnalysis, null, 0));

    // ---- BUG 2/3: FREI „Eigenes Video" tippen + Enter ------------------
    const netBefore = netLog.length;
    await ta.click();
    await ta.fill('Eigenes Video');
    await shot(page, 'typed-eigenes-video-freetext');
    global.__phase = "after-freetext";
    await ta.press('Enter');
    L('SUBMITTED freetext "Eigenes Video"');

    let streamErrSeen = false;
    let contextLostHint = null;
    for (let i = 0; i < 14; i += 1) {
      await page.waitForTimeout(4000);
      const txt = await page.locator('body').innerText().catch(() => '');
      const hasStreamErr = /Stream-Fehler|Agent-Fehler/i.test(txt);
      L(`freetext-poll#${i}`, JSON.stringify({ len: txt.length, hasStreamErr, head: txt.split('\n').filter(Boolean).slice(-8).join(' | ').slice(0, 240) }));
      if (hasStreamErr && !streamErrSeen) { streamErrSeen = true; await shot(page, 'STREAM-FEHLER'); }
      if (i === 1) await shot(page, 'freetext-after-4s');
      if (i === 6) await shot(page, 'freetext-mid');
      if (streamErrSeen && i >= 3) break;
    }
    await shot(page, 'final-state');

    // Kontextverlust-Heuristik: Erwähnt der Chat noch „Website"/das Projekt?
    const finalTxt = await page.locator('body').innerText().catch(() => '');
    contextLostHint = {
      mentionsWebsite: /Website|Firma|Beispiel-Firma/i.test(finalTxt),
      mentionsVideo: /Video|Higgsfield/i.test(finalTxt),
      hasStreamErr: /Stream-Fehler|Agent-Fehler/i.test(finalTxt),
      tail: finalTxt.split('\n').filter(Boolean).slice(-14).join(' | ').slice(0, 500),
    };
    const freetextNet = netLog.slice(netBefore);

    // ---- Report --------------------------------------------------------
    const report = {
      login: login.status(),
      wsRequested: wsId,
      wsHint,
      textareaFound: haveTa,
      domAnalysis,
      streamErrSeen,
      contextLostHint,
      freetextNetCalls: freetextNet,
      allNetCalls: netLog,
      consoleErrs: consoleErrs.slice(0, 30),
      pageErrs: pageErrs.slice(0, 30),
    };
    fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(OUT, 'log.txt'), log.join('\n'));
    console.log(JSON.stringify({ ok: true, streamErrSeen, shots: step, reportPath: path.join(OUT, 'report.json') }, null, 2));
  } catch (e) {
    L('ERR', e.message);
    fs.writeFileSync(path.join(OUT, 'log.txt'), log.join('\n'));
    console.log(JSON.stringify({ ok: false, error: e.message }, null, 2));
  } finally {
    await b.close();
  }
}
main().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
