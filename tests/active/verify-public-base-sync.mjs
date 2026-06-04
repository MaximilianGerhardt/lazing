/**
 * verify-public-base-sync.mjs — beweist die Out-of-the-Box-Kerngarantie:
 * die öffentliche URL aus `data/public-url` propagiert LIVE in Kunden-Share-
 * Links, OHNE App-Neustart (Datei wird pro Request gelesen, 3s-Cache).
 *
 * Schreibt eine Test-URL → Share-Link nutzt sie. Ändert die Datei → nach Cache-
 * Ablauf nutzt ein neuer Share-Link die NEUE URL. Räumt vollständig auf
 * (Subchat gelöscht, data/public-url auf vorherigen Zustand zurückgesetzt).
 *
 * ENV: SESSION_COOKIE="lazyos_session=<value>"
 */
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.BASE || 'http://127.0.0.1:4200';
const COOKIE = process.env.SESSION_COOKIE;
const WS = process.env.TEST_WS || 'intern';
const FILE = join(process.cwd(), 'data', 'public-url');
const URL_A = 'https://sync-test-aaa.trycloudflare.com';
const URL_B = 'https://sync-test-bbb.trycloudflare.com';
const out = {};

// Vorherigen Zustand sichern (für sauberes Restore).
const hadFile = existsSync(FILE);
const prev = hadFile ? readFileSync(FILE, 'utf8') : null;

const hostOf = (u) => { try { return new URL(u).host; } catch { return null; } };
let subchatId = null;

try {
  // 1. Test-URL A schreiben.
  writeFileSync(FILE, URL_A + '\n');

  // 2. Externen Subchat anlegen → externalUrl muss URL_A-Host nutzen.
  const c1 = await fetch(`${BASE}/api/workspaces/${encodeURIComponent(WS)}/subchats`, {
    method: 'POST',
    headers: { cookie: COOKIE, 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'PublicSync (Wegwerf)', kind: 'external' }),
  }).then((r) => r.json());
  subchatId = c1.subchat?.id || c1.id || null;
  out.createExternalUrl = c1.externalUrl;
  out.usesUrlA = hostOf(c1.externalUrl) === hostOf(URL_A);

  // 3. Datei auf URL B ändern + Cache (3s) abwarten.
  writeFileSync(FILE, URL_B + '\n');
  await new Promise((r) => setTimeout(r, 3600));

  // 4. Share-Link erneuern → muss jetzt URL_B-Host nutzen (LIVE, kein Neustart).
  let renewUrl = null;
  if (subchatId) {
    const c2 = await fetch(`${BASE}/api/subchats/${encodeURIComponent(subchatId)}/share`, {
      method: 'POST',
      headers: { cookie: COOKIE, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'renew', hours: 720 }),
    }).then((r) => r.json());
    renewUrl = c2.externalUrl;
  }
  out.renewExternalUrl = renewUrl;
  out.usesUrlB_liveNoRestart = hostOf(renewUrl) === hostOf(URL_B);
} finally {
  // 5. Cleanup: Subchat löschen + Datei-Zustand wiederherstellen.
  if (subchatId) {
    out.cleanupDelete = (await fetch(`${BASE}/api/subchats/${encodeURIComponent(subchatId)}`, {
      method: 'DELETE',
      headers: { cookie: COOKIE },
    })).status;
  }
  if (hadFile && prev !== null) writeFileSync(FILE, prev);
  else rmSync(FILE, { force: true });
  out.fileRestored = hadFile ? existsSync(FILE) : !existsSync(FILE);
}

out.VERDICT =
  out.usesUrlA && out.usesUrlB_liveNoRestart && out.fileRestored ? 'PASS' : 'FAIL';
console.log(JSON.stringify(out, null, 2));
