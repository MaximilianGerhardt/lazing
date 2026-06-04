/**
 * tests/active/utils/db-verify.ts
 *
 * READ-ONLY sqlite3-Helper für die Browser-E2E-Tests (Phase 1 Wave 2,
 * 2026-05-29). Liest Counts + Latest-Rows aus der laufenden lazyos.db,
 * damit die Tests verifizieren können DASS ein Flow-Run/Answer/Pending-
 * Event tatsächlich persistiert wurde (nicht nur „die UI behauptet es").
 *
 * Disziplin (Owner-Spec):
 *   - KEIN INSERT/UPDATE/DELETE.
 *   - Pfad: `~/.lazyos/lazyos.db` (override via LAZYOS_DB_PATH).
 *   - Wirft NICHT bei DB-Fehlern — gibt -1 / null / [] zurück, damit
 *     fail-soft-Akzeptanztests dokumentieren statt zu crashen.
 *   - Nutzt das `sqlite3` CLI-Binary (synchron). Latenz vernachlässigbar
 *     für unsere Use-Cases (Single-Digit-ms pro Query).
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

export const DB_PATH =
  process.env.LAZYOS_DB_PATH ??
  path.resolve(__dirname, '..', '..', '..', 'data', 'lazyos.db');

function sqlite(query: string): string {
  if (!existsSync(DB_PATH)) return '';
  try {
    return execFileSync('sqlite3', [DB_PATH, query], {
      encoding: 'utf8',
      timeout: 5_000,
    }).trim();
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[db-verify] sqlite error: ${(e as Error).message.split('\n')[0]}`);
    return '';
  }
}

/** Generic COUNT(*). Returns -1 on error. */
export function count(table: string, where?: string): number {
  const q = `SELECT COUNT(*) FROM ${table}${where ? ` WHERE ${where}` : ''};`;
  const out = sqlite(q);
  const n = Number.parseInt(out, 10);
  return Number.isFinite(n) ? n : -1;
}

/**
 * Anzahl flow_runs für einen Workspace die SEIT `sinceMs` (epoch-ms)
 * angelegt wurden. ≥1 = die Flow-Komposition hat persistiert.
 */
export function countFlowRunsSince(
  workspaceId: string,
  sinceMs: number,
): number {
  return count(
    'flow_runs',
    `workspace_id = '${workspaceId.replace(/'/g, "''")}' AND created_at >= ${sinceMs}`,
  );
}

/**
 * Anzahl `flow_pending_persisted` Events für diesen Workspace seit `sinceMs`.
 * Indiziert dass compose-and-run die needs-style-choice / needs-coupling-
 * Phase als event persistiert hat (Phase 1 Trace-Surface).
 */
export function countFlowPendingPersistedSince(
  workspaceId: string,
  sinceMs: number,
): number {
  return count(
    'events',
    `segment_id = '${workspaceId.replace(/'/g, "''")}' ` +
      `AND event_type = 'flow_pending_persisted' AND created_at >= ${sinceMs}`,
  );
}

/**
 * Liest eine strukturierte Antwort aus `question_answers`. Liefert
 * { answered: boolean, answer: string|null }. Read-only.
 */
export function readStructuredAnswer(
  workspaceId: string,
  questionId: string,
): { answered: boolean; answer: string | null } {
  // Tabelle kann unter zwei Namen existieren (Migrations-Drift):
  //   - question_answers (häufiger)
  //   - chat_question_answers (neuer Name in einigen Migrationen)
  const tableQ = sqlite(
    "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('question_answers','chat_question_answers') LIMIT 1;",
  );
  if (!tableQ) return { answered: false, answer: null };
  const table = tableQ;
  const out = sqlite(
    `SELECT answer FROM ${table} ` +
      `WHERE workspace_id = '${workspaceId.replace(/'/g, "''")}' ` +
      `AND question_id = '${questionId.replace(/'/g, "''")}' ` +
      `ORDER BY created_at DESC LIMIT 1;`,
  );
  if (!out) return { answered: false, answer: null };
  return { answered: true, answer: out };
}

/** Existiert ein Workspace mit der gegebenen id? */
export function workspaceExists(workspaceId: string): boolean {
  const out = sqlite(
    `SELECT id FROM workspaces WHERE id = '${workspaceId.replace(/'/g, "''")}' LIMIT 1;`,
  );
  return out.length > 0;
}

/** Liest path-Wert eines Workspaces (kann '' sein). */
export function getWorkspacePath(workspaceId: string): string {
  return sqlite(
    `SELECT path FROM workspaces WHERE id = '${workspaceId.replace(/'/g, "''")}' LIMIT 1;`,
  );
}

/**
 * Anzahl `workstreams` mit dem Workspace-Scope seit `sinceMs`.
 * Wave-2-Akzeptanz: ein Plan-Submit erzeugt **genau einen** workstream.
 */
export function countWorkstreamsSince(
  workspaceId: string,
  sinceMs: number,
): number {
  return count(
    'workstreams',
    `workspace_id = '${workspaceId.replace(/'/g, "''")}' AND created_at >= ${sinceMs}`,
  );
}

/**
 * Letzten N Events eines bestimmten event_type für einen Workspace.
 * Read-only Debugging-Helper.
 */
export function recentEvents(
  workspaceId: string,
  eventType: string,
  limit = 5,
): string {
  return sqlite(
    `SELECT id, datetime(created_at/1000,'unixepoch'), substr(payload, 1, 120) ` +
      `FROM events ` +
      `WHERE segment_id = '${workspaceId.replace(/'/g, "''")}' ` +
      `AND event_type = '${eventType.replace(/'/g, "''")}' ` +
      `ORDER BY created_at DESC LIMIT ${limit};`,
  );
}

/** Liest die ERSTE user-Chat-Message eines Workspace (für Prompt-B-Fallback). */
export function readFirstUserChatMessage(
  workspaceId: string,
): string | null {
  const out = sqlite(
    `SELECT json_extract(payload, '$.content') FROM events ` +
      `WHERE segment_id = '${workspaceId.replace(/'/g, "''")}' ` +
      `AND entity_type = 'chat_message' AND actor LIKE 'user:%' ` +
      `ORDER BY created_at ASC LIMIT 1;`,
  );
  return out.length > 0 ? out : null;
}
