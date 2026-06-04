/**
 * verify-subchat-rag-erasure — beweist die GDPR-Erasure-Kette END-TO-END:
 * Subchat anlegen → Nachricht posten → in rag_chunks ingestet → Subchat HART
 * löschen → Chunk (UND FTS-Mirror) sind weg. Schließt den Audit-Leak.
 *
 * ENV: SESSION_COOKIE="lazyos_session=<value>"
 */
import Database from 'better-sqlite3';

const BASE = process.env.BASE || 'http://127.0.0.1:4200';
const COOKIE = process.env.SESSION_COOKIE;
const WS = process.env.TEST_WS || 'intern';
const DB = process.env.LAZYOS_DB_PATH || './data/lazyos.db';
const SENTINEL = 'ErasureProbe-Zaehlerstand-PV-Auswertung-' + 'x'.repeat(20);
const out = {};

const H = { cookie: COOKIE, 'content-type': 'application/json' };
const db = () => new Database(DB, { readonly: true });
const chunkCount = (sid) => {
  const d = db();
  const c = d.prepare("SELECT count(*) c FROM rag_chunks WHERE source_type='subchat' AND source_id=?").get(sid)?.c ?? 0;
  d.close();
  return c;
};

let subchatId = null;
let msgId = null;
try {
  // 1. Subchat anlegen.
  const c = await fetch(`${BASE}/api/workspaces/${encodeURIComponent(WS)}/subchats`, {
    method: 'POST', headers: H, body: JSON.stringify({ title: 'Erasure-Verify (Wegwerf)', kind: 'external' }),
  }).then((r) => r.json());
  subchatId = c.subchat?.id || c.id;
  out.subchatId = subchatId;

  // 2. Lange Nachricht posten (>30 Zeichen → wird ingestet).
  const m = await fetch(`${BASE}/api/subchats/${encodeURIComponent(subchatId)}/messages`, {
    method: 'POST', headers: H, body: JSON.stringify({ content: SENTINEL }),
  }).then((r) => r.json());
  msgId = m.message?.id || m.id;
  out.msgId = msgId;
  out.postStatus = msgId ? 201 : 'no-id';

  // 3. Auf async Ingest warten (Embedder kann beim ersten Mal laden — bis 30s).
  let present = 0;
  for (let i = 0; i < 30; i++) {
    present = chunkCount(msgId);
    if (present > 0) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  out.chunkPresentAfterPost = present;

  // 4. Subchat HART löschen.
  out.deleteStatus = (await fetch(`${BASE}/api/subchats/${encodeURIComponent(subchatId)}`, {
    method: 'DELETE', headers: { cookie: COOKIE },
  })).status;
  await new Promise((r) => setTimeout(r, 500));

  // 5. Chunk + FTS müssen weg sein.
  out.chunkAfterDelete = chunkCount(msgId);
  const d = db();
  out.ftsConsistent = d.prepare('SELECT count(*) c FROM rag_chunks_fts').get().c === d.prepare('SELECT count(*) c FROM rag_chunks').get().c;
  out.orphansRemaining = d.prepare("SELECT count(*) c FROM rag_chunks WHERE source_type='subchat' AND source_id NOT IN (SELECT id FROM subchat_messages)").get().c;
  d.close();
} catch (e) {
  out.error = String(e?.message || e);
}

out.VERDICT =
  out.chunkPresentAfterPost > 0 &&
  out.chunkAfterDelete === 0 &&
  out.ftsConsistent === true &&
  out.orphansRemaining === 0
    ? 'PASS'
    : 'FAIL';
console.log(JSON.stringify(out, null, 2));
