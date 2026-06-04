#!/usr/bin/env node
/**
 * scripts/routine-db.cjs — cwd-unabhängige DB-Metriken für die Default-Routinen.
 *
 * Warum (UI/UX-Neuausrichtung 2026-06-03, Phase D): die alten Seed-Routinen
 * riefen `sqlite3 "$LAZYOS_DB_PATH"` mit Linux-Pfaden auf. Auf dem macOS-Host
 * existiert weder der Pfad noch ist die System-sqlite3-CLI verlässlich gegen
 * die WAL/better-sqlite3-DB. Dieser Helper nutzt better-sqlite3 (read-only)
 * und löst die DB relativ zu DIESEM Script auf (data/lazyos.db) — egal aus
 * welchem cwd der Routine-Runner spawnt.
 *
 *   node <repo>/scripts/routine-db.cjs open-tickets
 *   node <repo>/scripts/routine-db.cjs due-soon
 */
const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');

const envPath = process.env.LAZYOS_DB_PATH;
const dbPath =
  envPath && path.isAbsolute(envPath) && fs.existsSync(envPath)
    ? envPath
    : path.join(__dirname, '..', 'data', 'lazyos.db');

const cmd = process.argv[2] || 'open-tickets';

let db;
try {
  db = new Database(dbPath, { readonly: true, fileMustExist: true });
} catch {
  // DB nicht erreichbar → kein harter Fehler, damit die Routine nicht scheitert.
  process.stdout.write('0 (DB nicht erreichbar)\n');
  process.exit(0);
}

function openTicketCount() {
  const created = db
    .prepare(
      "SELECT DISTINCT entity_id AS id FROM events WHERE entity_type='ticket' AND event_type IN ('created','ticket_created')",
    )
    .all()
    .map((r) => r.id);
  const closed = new Set(
    db
      .prepare(
        "SELECT DISTINCT entity_id AS id FROM events WHERE entity_type='ticket' AND (event_type IN ('closed','ticket_deleted') OR (event_type='status_changed' AND json_extract(payload,'$.status') IN ('done','closed')))",
      )
      .all()
      .map((r) => r.id),
  );
  return created.filter((id) => !closed.has(id)).length;
}

function dueTickets() {
  const rows = db
    .prepare(
      "SELECT entity_id AS id, json_extract(payload,'$.due') AS due, json_extract(payload,'$.title') AS title FROM events WHERE entity_type='ticket' AND json_extract(payload,'$.due') IS NOT NULL ORDER BY created_at DESC",
    )
    .all();
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    if (!seen.has(r.id)) {
      seen.add(r.id);
      out.push(r);
    }
  }
  return out;
}

if (cmd === 'open-tickets') {
  process.stdout.write(`${openTicketCount()} offene Tickets\n`);
} else if (cmd === 'due-soon') {
  const d = dueTickets();
  if (d.length === 0) {
    process.stdout.write('Keine Tickets mit Fälligkeitsdatum.\n');
  } else {
    process.stdout.write(`${d.length} Ticket(s) mit Deadline:\n`);
    for (const t of d.slice(0, 10)) {
      process.stdout.write(`- ${t.title || t.id} (fällig ${t.due})\n`);
    }
  }
} else {
  process.stdout.write(`unknown command: ${cmd}\n`);
}

db.close();
