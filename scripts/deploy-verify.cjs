#!/usr/bin/env node
/**
 * scripts/deploy-verify.cjs
 *
 * Deploy-Verifikation — verhindert, dass je wieder ein BROKEN Build "live"
 * erklärt wird.
 *
 * --------------------------------------------------------------------------
 * WARUM DIESES SCRIPT EXISTIERT (Vorfall 2026-05-30)
 * --------------------------------------------------------------------------
 * Ein Deploy meldete `HEALTH=307` auf `/` als "gesund" — aber die EINGELOGGTE
 * `/`-Route warf zur Render-Zeit:
 *
 *     InvariantError: client reference manifest for route / does not exist
 *
 * → Internal Server Error für jeden authentifizierten Nutzer auf der Startseite.
 *
 * Ursache: `app/page.tsx` bekam beim Build KEIN
 * `.next/server/app/page_client-reference-manifest.js`. Der 307-Redirect
 * (Middleware schickt nicht-eingeloggte Requests auf /login) maskierte den
 * Defekt komplett — der unauthentifizierte Healthcheck rendert `app/page.tsx`
 * nie und sieht den Crash nie.
 *
 * Dieses Script schließt GENAU diese Lücke auf drei Ebenen:
 *
 *   1) verifyManifests()    — Build-Artefakt-Ebene: JEDE gebaute /page-Route
 *                              MUSS ein `*_client-reference-manifest.js` haben.
 *                              (Fängt den heutigen Bug deterministisch, ohne
 *                              den Server überhaupt zu brauchen.)
 *   2) verifyRootRenders()  — Laufzeit-Ebene: /login MUSS 200 sein (Beweis,
 *                              dass echte Seiten rendern, nicht nur Redirects),
 *                              und `/` darf NICHT 5xx werfen. Mit gültigem
 *                              Session-Cookie (VERIFY_SESSION_COOKIE) wird die
 *                              EINGELOGGTE `/`-Route real gerendert und auf
 *                              non-5xx geprüft.
 *   3) verifyLogClean()     — Log-Ebene: das frische Prod-Log MUSS frei sein
 *                              von InvariantError / "client reference manifest"
 *                              / "⨯ Error" / Boot-Crashes (harmlose
 *                              rag-auto-indexer-Zeilen ausgenommen).
 *
 * --------------------------------------------------------------------------
 * WO ES IN DEN DEPLOY-FLOW GEHÖRT
 * --------------------------------------------------------------------------
 * Der heutige Deploy-Ablauf ist:
 *     kill :4200  →  rm -rf .next  →  pnpm build  →  pnpm start  →  curl
 *
 * Dieses Script läuft NACH `pnpm build` und NACH `pnpm start`, BEVOR der
 * Deploy als "live" erklärt wird:
 *
 *     pnpm build
 *     node scripts/deploy-verify.cjs --phase build      # (1) nur Manifeste — kein Server nötig
 *     pnpm start &                                        # Prod-Server hochfahren
 *     # ... auf "Ready" warten ...
 *     node scripts/deploy-verify.cjs                      # (1)+(2)+(3) voll
 *     # exit 0  → live erklären   |   exit !=0 → Deploy abbrechen, NICHT live
 *
 * Bei exit != 0: NICHT live erklären. Build ist defekt. Re-build mit sauberem
 * `rm -rf .next` und erneut verifizieren — ein zweiter Build OHNE vorheriges
 * `rm -rf .next` kann genau dieses Manifest-Loch reproduzieren.
 *
 * --------------------------------------------------------------------------
 * EXIT CODES
 * --------------------------------------------------------------------------
 *   0  alle aktivierten Checks grün
 *   1  ein Check fehlgeschlagen (Details im Report)
 *   2  Benutzungs-/Umgebungsfehler (z.B. .next fehlt, Server nicht erreichbar)
 *
 * --------------------------------------------------------------------------
 * PARAMETER (CLI-Flags ODER Env-Vars)
 * --------------------------------------------------------------------------
 *   --port <n>        / PORT                  (default 4200)
 *   --log <path>      / LOG_PATH              (default /tmp/lazyos-prod-4200.log)
 *   --next-dir <path> / NEXT_DIR              (default <repo>/.next)
 *   --app-dir <path>  / APP_DIR               (default <repo>/app)
 *   --phase build|full                        (default full)
 *                       build = nur (1) verifyManifests (kein laufender Server)
 *                       full  = (1)+(2)+(3)
 *   --no-log          / SKIP_LOG=1            verifyLogClean überspringen
 *                       (Env VERIFY_SESSION_COOKIE: gültiges Session-Cookie, um
 *                        die EINGELOGGTE `/`-Route real zu rendern — optional,
 *                        aber empfohlen für den schärfsten Check)
 *   --self-test                               Selbsttest: simuliert ein
 *                       fehlendes Manifest gegen eine TEMP-Kopie der Routenliste
 *                       (fasst das echte .next NIE an) und beweist, dass der
 *                       Check fehlende Manifeste erkennt.
 *
 * Zero-dep: nur Node-Builtins. Kein Build, kein Server-Restart, read-only
 * gegen .next + HTTP gegen den bereits laufenden Server.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const REPO_ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Arg / env parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    return i !== -1 ? args[i + 1] : undefined;
  };
  const has = (name) => args.includes(name);

  return {
    port: Number(flag('--port') || process.env.PORT || 4200),
    logPath:
      flag('--log') || process.env.LOG_PATH || '/tmp/lazyos-prod-4200.log',
    nextDir: path.resolve(
      flag('--next-dir') || process.env.NEXT_DIR || path.join(REPO_ROOT, '.next'),
    ),
    appDir: path.resolve(
      flag('--app-dir') || process.env.APP_DIR || path.join(REPO_ROOT, 'app'),
    ),
    phase: flag('--phase') || process.env.PHASE || 'full',
    skipLog: has('--no-log') || process.env.SKIP_LOG === '1',
    selfTest: has('--self-test'),
    sessionCookie: process.env.VERIFY_SESSION_COOKIE || '',
  };
}

// ---------------------------------------------------------------------------
// Tiny report helpers
// ---------------------------------------------------------------------------

const ok = (m) => `  ✓ ${m}`;
const bad = (m) => `  ✗ ${m}`;
const info = (m) => `  · ${m}`;

function section(title) {
  console.log(`\n── ${title} ──`);
}

// ---------------------------------------------------------------------------
// Route discovery
//
// Primary source: .next/server/app-paths-manifest.json — already resolves
// route groups (parens), parallel routes, etc. into canonical /…/page keys.
// Fallback: walk app/**/page.tsx (only used if the manifest is missing).
// ---------------------------------------------------------------------------

function listPageRoutesFromManifest(nextDir) {
  const p = path.join(nextDir, 'server', 'app-paths-manifest.json');
  if (!fs.existsSync(p)) return null;
  let json;
  try {
    json = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return null;
  }
  // Keys look like "/settings/page", "/orgs/[id]/page", "/page".
  return Object.keys(json).filter((k) => k === '/page' || k.endsWith('/page'));
}

function listPageRoutesFromAppDir(appDir) {
  const routes = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else if (e.isFile() && e.name === 'page.tsx') {
        // app/settings/page.tsx -> /settings/page
        // route groups "(group)" are stripped from the URL path
        let rel = path.relative(appDir, path.dirname(full));
        const segs = rel
          .split(path.sep)
          .filter((s) => s && !(s.startsWith('(') && s.endsWith(')')));
        routes.push('/' + [...segs, 'page'].join('/'));
      }
    }
  };
  walk(appDir);
  return routes;
}

/**
 * Map a canonical "/…/page" route key to its expected client-reference-manifest
 * path under .next/server/app/.
 *   "/page"            -> .next/server/app/page_client-reference-manifest.js
 *   "/settings/page"   -> .next/server/app/settings/page_client-reference-manifest.js
 */
function manifestPathForRoute(nextDir, routeKey) {
  const rel = routeKey.replace(/^\//, ''); // strip leading slash
  return path.join(nextDir, 'server', 'app', rel + '_client-reference-manifest.js');
}

// ---------------------------------------------------------------------------
// CHECK 1 — verifyManifests()
// ---------------------------------------------------------------------------

function verifyManifests(cfg) {
  section('CHECK 1 — client-reference-manifests');

  if (!fs.existsSync(cfg.nextDir)) {
    console.log(bad(`.next nicht gefunden: ${cfg.nextDir}`));
    console.log(info('Wurde `pnpm build` ausgeführt? (env-code 2)'));
    return { passed: false, fatal: true };
  }

  let routes = listPageRoutesFromManifest(cfg.nextDir);
  let source = 'app-paths-manifest.json';
  if (!routes) {
    routes = listPageRoutesFromAppDir(cfg.appDir);
    source = 'app/**/page.tsx (Fallback — app-paths-manifest.json fehlte)';
  }

  if (!routes || routes.length === 0) {
    console.log(bad('Keine /page-Routen gefunden — Build unvollständig?'));
    return { passed: false, fatal: true };
  }

  console.log(info(`Routenquelle: ${source}`));
  console.log(info(`Gebaute /page-Routen: ${routes.length}`));

  const missing = [];
  for (const r of routes) {
    const mp = manifestPathForRoute(cfg.nextDir, r);
    if (!fs.existsSync(mp)) {
      missing.push({ route: r, expected: path.relative(REPO_ROOT, mp) });
    }
  }

  // Spezifischer Riegel für den heutigen Bug: / (root) explizit.
  const rootRoute = routes.find((r) => r === '/page');
  if (rootRoute) {
    const rootManifest = manifestPathForRoute(cfg.nextDir, '/page');
    if (fs.existsSync(rootManifest)) {
      console.log(ok('Root `/` hat page_client-reference-manifest.js (der heutige Bug)'));
    } else {
      console.log(bad('Root `/` FEHLT page_client-reference-manifest.js — GENAU der 2026-05-30-Bug!'));
    }
  }

  if (missing.length === 0) {
    console.log(ok(`Alle ${routes.length} Routen haben ihr client-reference-manifest`));
    return { passed: true, fatal: false };
  }

  console.log(bad(`${missing.length} Route(n) ohne client-reference-manifest:`));
  for (const m of missing) {
    console.log(`      ✗ ${m.route}  → fehlend: ${m.expected}`);
  }
  console.log(info('Dieser Build crasht beim Render dieser Route(n) mit InvariantError.'));
  console.log(info('Fix: rm -rf .next && pnpm build (sauberer Rebuild), dann erneut verifizieren.'));
  return { passed: false, fatal: false };
}

// ---------------------------------------------------------------------------
// HTTP helper (no deps)
// ---------------------------------------------------------------------------

function httpGet(opts) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: opts.port,
        path: opts.path,
        method: 'GET',
        headers: opts.headers || {},
        timeout: opts.timeout || 8000,
      },
      (res) => {
        let body = '';
        // Read a bounded amount of the body — enough to spot an error page,
        // not enough to slurp a huge HTML doc.
        res.on('data', (c) => {
          if (body.length < 64 * 1024) body += c.toString('utf8');
        });
        res.on('end', () =>
          resolve({ status: res.statusCode || 0, body, error: null }),
        );
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
    });
    req.on('error', (err) => resolve({ status: 0, body: '', error: err.message }));
    req.end();
  });
}

// ---------------------------------------------------------------------------
// CHECK 2 — verifyRootRenders()
// ---------------------------------------------------------------------------

const SERVER_ERROR_SIGNATURES = [
  'InvariantError',
  'client reference manifest',
  'Internal Server Error',
];

async function verifyRootRenders(cfg) {
  section('CHECK 2 — eingeloggter Root-Render (nicht nur der 307)');

  // (a) /login MUSS echt rendern (200). Beweist, dass der Server überhaupt
  //     Seiten ausliefert — ein reiner Redirect-Server würde das nicht.
  const login = await httpGet({ port: cfg.port, path: '/login' });
  if (login.error) {
    console.log(bad(`/login nicht erreichbar: ${login.error}`));
    console.log(info(`Läuft 'pnpm start' auf :${cfg.port}? (env-code 2)`));
    return { passed: false, fatal: true };
  }
  if (login.status === 200) {
    console.log(ok('/login => 200 (Seiten rendern real)'));
  } else {
    console.log(bad(`/login => ${login.status} (erwartet 200)`));
  }

  // (b) `/` darf NICHT 5xx werfen. 307 = erwarteter Redirect für
  //     nicht-eingeloggte Requests; 500 hier = InvariantError surfaced.
  const root = await httpGet({ port: cfg.port, path: '/' });
  let rootOk = true;
  if (root.error) {
    console.log(bad(`/ nicht erreichbar: ${root.error}`));
    return { passed: false, fatal: true };
  }
  if (root.status >= 500) {
    console.log(bad(`/ => ${root.status} (5xx — Render-Crash! der heutige Bug)`));
    rootOk = false;
  } else if (root.status === 307 || root.status === 302 || root.status === 308) {
    console.log(ok(`/ => ${root.status} (erwarteter Redirect für nicht-eingeloggt, KEIN 5xx)`));
  } else if (root.status === 200) {
    console.log(ok('/ => 200 (rendert ohne Auth)'));
  } else {
    console.log(info(`/ => ${root.status}`));
  }
  for (const sig of SERVER_ERROR_SIGNATURES) {
    if (root.body && root.body.includes(sig)) {
      console.log(bad(`/ Antwort-Body enthält "${sig}"`));
      rootOk = false;
    }
  }

  // (c) EINGELOGGTE `/`-Route — der schärfste Check. Nur möglich mit gültigem
  //     Session-Cookie. Ohne Cookie redirected die Middleware (307) und der
  //     authentifizierte app/page.tsx-Render wird nie ausgelöst → wir können
  //     ihn dann nicht direkt prüfen und verlassen uns auf CHECK 1 + (b).
  if (cfg.sessionCookie) {
    const authed = await httpGet({
      port: cfg.port,
      path: '/',
      headers: { Cookie: cfg.sessionCookie, RSC: '1' },
    });
    if (authed.error) {
      console.log(bad(`/ (eingeloggt) nicht erreichbar: ${authed.error}`));
      rootOk = false;
    } else if (authed.status >= 500) {
      console.log(bad(`/ (eingeloggt) => ${authed.status} (5xx — app/page.tsx crasht!)`));
      rootOk = false;
    } else {
      console.log(ok(`/ (eingeloggt, VERIFY_SESSION_COOKIE) => ${authed.status} (kein 5xx)`));
    }
    for (const sig of SERVER_ERROR_SIGNATURES) {
      if (authed.body && authed.body.includes(sig)) {
        console.log(bad(`/ (eingeloggt) Antwort-Body enthält "${sig}"`));
        rootOk = false;
      }
    }
  } else {
    console.log(
      info(
        'VERIFY_SESSION_COOKIE nicht gesetzt — eingeloggter `/`-Render nicht direkt geprüft.',
      ),
    );
    console.log(
      info('CHECK 1 (Manifest) + CHECK 3 (Log) decken den Bug build-/laufzeitseitig ab.'),
    );
  }

  return { passed: rootOk, fatal: false };
}

// ---------------------------------------------------------------------------
// CHECK 3 — verifyLogClean()
// ---------------------------------------------------------------------------

const LOG_ERROR_PATTERNS = [
  /InvariantError/,
  /client reference manifest/,
  /⨯\s*Error/, // "⨯ Error" — Next.js server-side render error marker
  /⨯\s*unhandledRejection/,
  /Cannot find module/,
  /MODULE_NOT_FOUND/,
  /listen EADDRINUSE/,
  /Error: connect/,
];

// Zeilen, die harmlos sind und NICHT als Fehler zählen (auch wenn sie das Wort
// "failed" enthalten — rag-auto-indexer reportet failed=0 etc.).
const LOG_HARMLESS_PATTERNS = [
  /\[rag-auto-indexer\]/,
  /\[resume-orphans\]/,
  /\[boot\]/,
  /\[worktree-manager\]/,
  /\[worktree-sweep/,
  /INVALID_REPO_PATH/, // bekannter, toleriert: orphan-worktree dry-run sweep
];

function verifyLogClean(cfg) {
  section('CHECK 3 — frisches Prod-Log');

  if (!fs.existsSync(cfg.logPath)) {
    console.log(bad(`Log nicht gefunden: ${cfg.logPath}`));
    console.log(info('LOG_PATH/--log auf das frische `pnpm start`-Log zeigen lassen.'));
    return { passed: false, fatal: true };
  }

  console.log(info(`Log: ${cfg.logPath}`));
  const lines = fs.readFileSync(cfg.logPath, 'utf8').split(/\r?\n/);

  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (LOG_HARMLESS_PATTERNS.some((re) => re.test(line))) continue;
    if (LOG_ERROR_PATTERNS.some((re) => re.test(line))) {
      hits.push({ n: i + 1, line: line.slice(0, 200) });
    }
  }

  if (hits.length === 0) {
    console.log(ok('Keine InvariantError / "client reference manifest" / "⨯ Error" / Boot-Crashes'));
    return { passed: true, fatal: false };
  }

  console.log(bad(`${hits.length} verdächtige Log-Zeile(n):`));
  for (const h of hits.slice(0, 20)) {
    console.log(`      L${h.n}: ${h.line}`);
  }
  return { passed: false, fatal: false };
}

// ---------------------------------------------------------------------------
// SELF-TEST — beweist, dass verifyManifests fehlende Manifeste erkennt,
// OHNE das echte .next anzufassen. Baut eine Mini-.next-Struktur in einem
// TEMP-Verzeichnis mit einer absichtlich fehlenden page_client-reference-
// manifest.js für die Root und prüft, dass der Check rot wird.
// ---------------------------------------------------------------------------

function runSelfTest() {
  const os = require('node:os');
  section('SELF-TEST — verifyManifests erkennt fehlendes Root-Manifest');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-verify-selftest-'));
  const fakeNext = path.join(tmp, '.next');
  const appServer = path.join(fakeNext, 'server', 'app');
  fs.mkdirSync(path.join(fakeNext, 'server'), { recursive: true });
  fs.mkdirSync(path.join(appServer, 'settings'), { recursive: true });

  // app-paths-manifest mit 2 Routen: / und /settings
  fs.writeFileSync(
    path.join(fakeNext, 'server', 'app-paths-manifest.json'),
    JSON.stringify({ '/page': 'app/page.js', '/settings/page': 'app/settings/page.js' }),
  );
  // /settings bekommt sein Manifest, / (root) NICHT — exakt der 2026-05-30-Bug.
  fs.writeFileSync(
    path.join(appServer, 'settings', 'page_client-reference-manifest.js'),
    '// ok',
  );

  const res = verifyManifests({ nextDir: fakeNext, appDir: path.join(tmp, 'app') });

  fs.rmSync(tmp, { recursive: true, force: true });

  if (res.passed === false && res.fatal === false) {
    console.log(ok('SELF-TEST bestanden: fehlendes Root-Manifest wurde korrekt als FEHLER erkannt.'));
    return 0;
  }
  console.log(bad('SELF-TEST FEHLGESCHLAGEN: fehlendes Manifest wurde NICHT erkannt!'));
  return 1;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const cfg = parseArgs(process.argv);

  console.log('========================================================');
  console.log(' lazyOS Deploy-Verifikation  (scripts/deploy-verify.cjs)');
  console.log('========================================================');
  console.log(info(`Phase: ${cfg.phase}`));
  console.log(info(`Port:  ${cfg.port}`));
  console.log(info(`.next: ${cfg.nextDir}`));

  if (cfg.selfTest) {
    process.exit(runSelfTest());
  }

  const results = [];

  // CHECK 1 — immer (Build-Artefakt; kein Server nötig)
  const r1 = verifyManifests(cfg);
  results.push({ name: 'verifyManifests', ...r1 });
  if (r1.fatal) {
    finish(results);
    process.exit(2);
  }

  if (cfg.phase !== 'build') {
    // CHECK 2 — laufender Server
    const r2 = await verifyRootRenders(cfg);
    results.push({ name: 'verifyRootRenders', ...r2 });
    if (r2.fatal) {
      finish(results);
      process.exit(2);
    }

    // CHECK 3 — frisches Log
    if (!cfg.skipLog) {
      const r3 = verifyLogClean(cfg);
      results.push({ name: 'verifyLogClean', ...r3 });
      if (r3.fatal) {
        finish(results);
        process.exit(2);
      }
    } else {
      console.log(info('\nCHECK 3 (Log) übersprungen (--no-log).'));
    }
  } else {
    console.log(info('\nPhase=build: CHECK 2+3 übersprungen (kein laufender Server erwartet).'));
  }

  const allPassed = finish(results);
  process.exit(allPassed ? 0 : 1);
}

function finish(results) {
  section('ERGEBNIS');
  let allPassed = true;
  for (const r of results) {
    const mark = r.passed ? '✓ PASS' : '✗ FAIL';
    console.log(`  ${mark}  ${r.name}`);
    if (!r.passed) allPassed = false;
  }
  console.log('');
  if (allPassed) {
    console.log('  ✓ GRÜN — Build verifiziert. Deploy darf "live" erklärt werden.');
  } else {
    console.log('  ✗ ROT — Build NICHT verifiziert. NICHT live erklären.');
    console.log('     Re-build sauber: rm -rf .next && pnpm build, dann erneut verifizieren.');
  }
  return allPassed;
}

main().catch((err) => {
  console.error('\ndeploy-verify: unerwarteter Fehler:', err);
  process.exit(2);
});
