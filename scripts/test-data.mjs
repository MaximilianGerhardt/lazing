#!/usr/bin/env node
/**
 * test-data.mjs — reproduzierbare Wegwerf-Testdaten (Seed/Reset), marker-basiert.
 *
 *   node scripts/test-data.mjs seed    # legt markierte Test-Workspaces/Subchats/Messages an
 *   node scripts/test-data.mjs reset   # löscht NUR die markierten Seed-Daten (nie echte)
 *   node scripts/test-data.mjs status  # zeigt, was an Seed-Daten existiert
 *
 * Marker: alle Seed-IDs beginnen mit `seed-test-` (Workspaces) bzw. liegen in
 * einem seed-test-Workspace. Reset matcht NUR diesen Marker → echte Daten sicher.
 * Direkt-Insert via better-sqlite3 (Testdaten; umgeht bewusst den RAG-Ingest).
 */
import Database from 'better-sqlite3';

const DB_PATH = './data/lazyos.db';
const MARK = 'seed-test-';
const cmd = process.argv[2];

function ulidish(prefix) {
  // Kein Date.now()-Verbot hier (reines CLI-Tooling, kein Workflow-Replay).
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`.toUpperCase();
}

const db = new Database(DB_PATH);
db.pragma('foreign_keys = OFF');

function hasCol(table, col) {
  try { return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col); } catch { return false; }
}

function seed() {
  const now = Date.now();
  const wsId = `${MARK}demo`;
  // Workspace
  const wsCols = db.prepare('PRAGMA table_info(workspaces)').all().map((c) => c.name);
  const wsRow = { id: wsId, label: 'Seed-Demo Kunde', accent: 'north', path: '/tmp/seed-demo', sensitivity: 'low', archived: 0, workspace_type: 'client', created_at: now, updated_at: now };
  const cols = Object.keys(wsRow).filter((c) => wsCols.includes(c));
  db.prepare(`INSERT OR REPLACE INTO workspaces (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((c) => wsRow[c]));
  // Subchat
  const scId = ulidish('SC-SEED');
  const scCols = db.prepare('PRAGMA table_info(subchats)').all().map((c) => c.name);
  const scRow = { id: scId, workspace_id: wsId, title: 'Demo-Kundenchat (Seed)', kind: 'external', status: 'active', created_at: now, updated_at: now };
  const sc = Object.keys(scRow).filter((c) => scCols.includes(c));
  db.prepare(`INSERT INTO subchats (${sc.join(',')}) VALUES (${sc.map(() => '?').join(',')})`).run(...sc.map((c) => scRow[c]));
  // Messages (extern + intern)
  const insMsg = (i, kind, name, content) => {
    const id = ulidish('SCM-SEED');
    const mCols = db.prepare('PRAGMA table_info(subchat_messages)').all().map((c) => c.name);
    const row = { id, subchat_id: scId, workspace_id: wsId, author_kind: kind, author_name: name, content, ingested: 0, created_at: now + i * 1000 };
    const m = Object.keys(row).filter((c) => mCols.includes(c));
    db.prepare(`INSERT INTO subchat_messages (${m.join(',')}) VALUES (${m.map(() => '?').join(',')})`).run(...m.map((c) => row[c]));
  };
  insMsg(0, 'external', 'Kunde Demo', 'Hallo, koennen wir die PV-Auswertung besprechen?');
  insMsg(1, 'internal', 'Team', 'Klar, ich schaue mir die Zaehlerstaende an.');
  console.log(`Seed OK: workspace ${wsId}, subchat ${scId}, 2 Nachrichten.`);
}

function reset() {
  const wsIds = db.prepare(`SELECT id FROM workspaces WHERE id LIKE '${MARK}%'`).all().map((r) => r.id);
  const scIds = db.prepare(`SELECT id FROM subchats WHERE id LIKE 'SC-SEED%'${wsIds.length ? ` OR workspace_id IN (${wsIds.map(() => '?').join(',')})` : ''}`).all(...(wsIds.length ? wsIds : [])).map((r) => r.id);
  const tx = db.transaction(() => {
    let n = {};
    if (scIds.length) {
      const ph = scIds.map(() => '?').join(',');
      if (hasCol('subchat_read_markers', 'subchat_id')) db.prepare(`DELETE FROM subchat_read_markers WHERE subchat_id IN (${ph})`).run(...scIds);
      n.messages = db.prepare(`DELETE FROM subchat_messages WHERE subchat_id IN (${ph})`).run(...scIds).changes;
      n.subchats = db.prepare(`DELETE FROM subchats WHERE id IN (${ph})`).run(...scIds).changes;
    }
    if (wsIds.length) {
      const ph = wsIds.map(() => '?').join(',');
      try { db.prepare(`DELETE FROM rag_chunks WHERE workspace_id IN (${ph})`).run(...wsIds); } catch {}
      try { db.prepare(`DELETE FROM rag_chunks_fts WHERE workspace_id IN (${ph})`).run(...wsIds); } catch {}
      n.workspaces = db.prepare(`DELETE FROM workspaces WHERE id IN (${ph})`).run(...wsIds).changes;
    }
    console.log('Reset OK:', JSON.stringify(n));
  });
  tx();
}

function status() {
  const ws = db.prepare(`SELECT count(*) c FROM workspaces WHERE id LIKE '${MARK}%'`).get().c;
  const sc = db.prepare(`SELECT count(*) c FROM subchats WHERE id LIKE 'SC-SEED%'`).get().c;
  console.log(`Seed-Status: ${ws} Workspace(s), ${sc} Subchat(s).`);
}

if (cmd === 'seed') seed();
else if (cmd === 'reset') reset();
else if (cmd === 'status') status();
else { console.error('Nutzung: node scripts/test-data.mjs <seed|reset|status>'); process.exit(1); }
db.close();
