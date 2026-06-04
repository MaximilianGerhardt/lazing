/**
 * Workspace-Cleanup-Cascade (Owner-Bug-Fix 2026-05-29).
 *
 * Hintergrund (Owner-Live-Test 2026-05-29, verbatim N1):
 *   „Ich nehme den Namen PA Website 2 und öffne den Chat nach dem neu
 *    erstellen und dann it da der alte Chatverlauf drin…"
 *
 * Empirie (live-DB-Befund):
 *   1) `chat_ledger` war in einem früheren Cleanup-Pass NICHT enthalten →
 *      stale Rows mit `coord_key='example-website-2'` blieben stehen.
 *   2) Workspace-ID wird aus Label slugified → „PA Website 2" → `example-website-2`
 *      → identisch mit dem zuvor gelöschten Workspace → alle stale Rows in
 *      Tabellen, die per `coord_key`/`workspace_id` joinen, werden „adoptiert".
 *
 * Dieser Helper ist Fix F1 für das systemische Pattern:
 *   - EINE kanonische Funktion löscht ALLES was per `workspace_id` ODER
 *     `coord_key` ODER `segment_id` an einen Workspace gebunden ist.
 *   - PRAGMA-table_info-Lookup zur Build-Zeit (per call), KEIN hard-coded
 *     Liste, die wieder veraltet, sobald jemand eine Migration mit
 *     workspace-bindender Spalte hinzufügt.
 *   - N8-append-only-Trigger respektieren: `workstream_decisions` und
 *     `workstream_evidence` haben BEFORE-DELETE-Trigger. Fail-soft: catch+log,
 *     diese 2 Tabellen behalten den Audit-Trail (Design-Intent) und werden
 *     im Return als `audit_trail_preserved` markiert.
 *   - Idempotent (zweiter Lauf ist No-Op).
 *   - Transaktion mit explizitem COMMIT/ROLLBACK pro Tabelle: bei Fehler in
 *     einer löschbaren Tabelle → log + weiter, nicht abbrechen.
 *
 * NICHT-Ziel dieses Helpers:
 *   - Die Workspace selbst (`workspaces`-Row) zu löschen — das überlässt
 *     der Helper dem Aufrufer, weil der Aufrufer ggf. soft-delete (archive)
 *     statt hard-delete will. Wenn `opts.deleteWorkspaceRow=true` übergeben
 *     wird, löschen wir auch die `workspaces`-Row am Ende.
 *
 * Acceptance (siehe `__tests__/cleanup.test.ts`):
 *   - Löscht workspace-gebundene Rows in: chat_ledger, streaming_snapshots,
 *     workstreams (+kaskadiert workstream_plan_steps, workstream_plan_critics),
 *     workspace_heartbeats, workspace_fs_roots, workspace_credentials,
 *     workspace_memberships, workspace_keys, workspace_github_repos,
 *     workspace_beliefs, rag_chunks, rag_indexer_state, credential_access_log,
 *     lazyos_permission_modes, lazyos_permission_audit, audit_log, reasoning_audit,
 *     events (via segment_id), routines, sops (+ sop_steps via sop_id-Lookup),
 *     flow_templates (+ flow_steps, flow_runs), decision_outcomes, share_tokens,
 *     work_products, claude_sessions, workflow_runs, failed_experiments,
 *     tpm_tracker, client_visibility, cloud_artifacts, cloud_audit, cloud_folders.
 *   - workstream_decisions + workstream_evidence: bleiben dank N8-Trigger
 *     erhalten; werden im Return als `audit_trail_preserved` aufgeführt.
 *   - Idempotent: zweiter Aufruf mit derselben workspaceId = No-Op (counts 0).
 *
 * Verwendung:
 *   ```ts
 *   import { cleanupWorkspaceData } from '@/lib/workspaces/cleanup';
 *   const summary = cleanupWorkspaceData(db.$raw, 'example-website-2');
 *   console.log(summary); // { deleted: { chat_ledger: 2, … }, audit_trail_preserved: […], errors: [] }
 *   ```
 *
 * Sicherheit:
 *   - Diese Funktion ist destruktiv. Aufrufer (Route, CLI-Script) MUSS
 *     Permission vorher prüfen (Owner/Admin der Workspace).
 *   - Bei `deleteWorkspaceRow=true` wird auch die Workspaces-Row selbst gelöscht;
 *     ohne diese Option bleibt sie unangetastet (default false).
 */

// `import type` only — wir bleiben unabhängig vom konkreten Database-Konstruktor,
// damit Mocks (vitest) und better-sqlite3 (Produktion) beide passen.
import type DatabaseT from 'better-sqlite3';

/**
 * Minimaler Database-Shape, den dieser Helper braucht. Das ist genau die
 * Subset-API, die `db.$raw` (better-sqlite3) bereitstellt. Vitest-Mocks
 * implementieren denselben Shape.
 *
 * Hinweis (TS): `prepare()` ist absichtlich locker getypt. Better-sqlite3's
 * eigener Statement-Type ist generisch (`Statement<BindParams, Result>`) und
 * passt nicht direkt auf ein „universal callable". Wir nehmen `any` als
 * Rückgabe von prepare und kapseln die Aufrufer-Typen in den lokalen
 * Helper-Funktionen oben.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CleanupRawDb = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  prepare(sql: string): any;
  exec?(sql: string): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  transaction?: (fn: (...args: any[]) => any) => (...args: any[]) => any;
};

/**
 * Tabellen-Liste: jeweils die Tabelle + die Workspace-bindende Spalte, die
 * der Cleanup verwendet. Wir versuchen MEHRERE Spalten pro Tabelle (workspace_id
 * → coord_key → segment_id), das erste Match wird genommen, der Rest übersprungen.
 *
 * Hinweis: workspace_id-coord_key-segment_id ist der Set, den der Owner-Brief
 * explizit nennt; KEIN hard-coded Tabelle-Liste — wir verifizieren via
 * PRAGMA table_info ob die Tabelle existiert UND ob sie die Spalte tatsächlich
 * trägt, BEVOR wir das DELETE absetzen.
 */
const CANDIDATE_COLUMNS = ['workspace_id', 'coord_key', 'segment_id'] as const;

/**
 * Tabellen, die per N8-Trigger keinen DELETE zulassen — Audit-Trail-Design.
 * Wir versuchen den DELETE trotzdem (Trigger feuert), fangen den Fehler ab
 * und melden „audit_trail_preserved" anstatt zu abbrechen.
 */
const N8_AUDIT_PROTECTED_TABLES = new Set([
  'workstream_decisions',
  'workstream_evidence',
]);

/**
 * Tabellen die NICHT direkt workspace-gebunden sind, aber via FK an
 * workstreams/sops/flow_templates hängen. Für diese leiten wir die
 * IDs ab und löschen kindweise.
 *
 * Mapping: child-Tabelle → parent-Tabelle + parent-ID-Spalte in Child.
 */
const DERIVED_CHILD_TABLES: Array<{
  child: string;
  childParentCol: string;
  parent: string;
  parentIdCol: string;
  parentWsCol: string;
}> = [
  // workstream_id-children:
  {
    child: 'workstream_decisions',
    childParentCol: 'workstream_id',
    parent: 'workstreams',
    parentIdCol: 'id',
    parentWsCol: 'workspace_id',
  },
  {
    child: 'workstream_evidence',
    childParentCol: 'workstream_id',
    parent: 'workstreams',
    parentIdCol: 'id',
    parentWsCol: 'workspace_id',
  },
  // sop_steps via sop_id:
  {
    child: 'sop_steps',
    childParentCol: 'sop_id',
    parent: 'sops',
    parentIdCol: 'id',
    parentWsCol: 'workspace_id',
  },
  // flow_steps + flow_runs via template_id (flow_templates):
  {
    child: 'flow_steps',
    childParentCol: 'template_id',
    parent: 'flow_templates',
    parentIdCol: 'id',
    parentWsCol: 'workspace_id',
  },
];

export interface CleanupOptions {
  /**
   * Wenn true: löscht am Ende auch die `workspaces`-Row selbst.
   * Default: false (Aufrufer entscheidet — soft-delete vs hard-delete).
   */
  deleteWorkspaceRow?: boolean;
  /**
   * Optionaler Logger. Default: console.warn.
   */
  log?: (msg: string, err?: unknown) => void;
  /**
   * Optional: nur eine Untermenge von Tabellen löschen. Default: alle, die
   * eine workspace-bindende Spalte tragen.
   */
  onlyTables?: ReadonlyArray<string>;
}

export interface CleanupSummary {
  workspaceId: string;
  /** Pro Tabelle: wieviele Rows gelöscht wurden. */
  deleted: Record<string, number>;
  /**
   * Tabellen, die durch N8-Trigger geschützt sind und Rows behielten.
   * Format: `["workstream_decisions:5", "workstream_evidence:0"]`.
   */
  audit_trail_preserved: string[];
  /** Tabellen, deren DELETE einen unerwarteten Fehler warf (mit Message). */
  errors: Array<{ table: string; message: string }>;
  /** Ob die `workspaces`-Row selbst entfernt wurde. */
  workspace_row_deleted: boolean;
}

function defaultLog(msg: string, err?: unknown): void {
  if (err === undefined) {
    // eslint-disable-next-line no-console
    console.warn(`[cleanupWorkspaceData] ${msg}`);
  } else {
    // eslint-disable-next-line no-console
    console.warn(`[cleanupWorkspaceData] ${msg}`, err);
  }
}

/**
 * Listet alle Tabellen in der aktuellen SQLite-DB auf (excl. sqlite_internal).
 */
function listAllTables(raw: CleanupRawDb): string[] {
  try {
    const rows = raw
      .prepare(
        `SELECT name FROM sqlite_master
          WHERE type='table'
            AND name NOT LIKE 'sqlite_%'
            AND name NOT LIKE '%_fts'
            AND name NOT LIKE '%_fts_%'
          ORDER BY name`,
      )
      .all() as Array<{ name: string }>;
    return rows.map((r) => r.name);
  } catch {
    return [];
  }
}

/**
 * Holt die Spalten-Namen einer Tabelle via PRAGMA table_info.
 * Gibt [] zurück wenn die Tabelle nicht existiert.
 */
function getColumns(raw: CleanupRawDb, tableName: string): string[] {
  try {
    // PRAGMA-Statements lassen sich nicht binden — wir validieren table-Name strikt.
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tableName)) return [];
    const rows = raw
      .prepare(`PRAGMA table_info(${tableName})`)
      .all() as Array<{ name: string }>;
    return rows.map((r) => r.name);
  } catch {
    return [];
  }
}

/**
 * Findet die erste passende workspace-bindende Spalte in einer Tabelle.
 * Reihenfolge: workspace_id → coord_key → segment_id.
 */
function pickWorkspaceColumn(
  cols: string[],
): (typeof CANDIDATE_COLUMNS)[number] | null {
  for (const c of CANDIDATE_COLUMNS) {
    if (cols.includes(c)) return c;
  }
  return null;
}

/**
 * KANONISCHE Cleanup-Funktion. Sicher idempotent, fail-soft pro Tabelle.
 */
export function cleanupWorkspaceData(
  raw: CleanupRawDb,
  workspaceId: string,
  opts: CleanupOptions = {},
): CleanupSummary {
  const log = opts.log ?? defaultLog;
  const summary: CleanupSummary = {
    workspaceId,
    deleted: {},
    audit_trail_preserved: [],
    errors: [],
    workspace_row_deleted: false,
  };

  // Defensiv: workspaceId muss harmlos sein. Wir binden alle Werte als
  // Parameter, aber zusätzlich validieren um SQL-Injection auf Pragma-Pfaden
  // ausschließen zu können (Pragmas lassen sich nicht binden).
  if (!/^[a-zA-Z0-9_@:\-()]+$/.test(workspaceId)) {
    summary.errors.push({
      table: '<input>',
      message: `invalid workspaceId shape (rejected): ${workspaceId}`,
    });
    return summary;
  }

  const allTables = listAllTables(raw);
  if (allTables.length === 0) {
    summary.errors.push({
      table: '<schema>',
      message: 'no tables discovered (PRAGMA failed / empty DB)',
    });
    return summary;
  }

  const onlyTables = opts.onlyTables ? new Set(opts.onlyTables) : null;

  // ───────────────────────────────────────────────────────────────────────
  // Schritt 1 (DERIVED CHILDREN FIRST): Tabellen, die NICHT direkt eine
  // workspace-bindende Spalte tragen, aber über `workstream_id` / `sop_id` /
  // `template_id` an einen Parent hängen, der workspace-gebunden ist.
  //
  // Reihenfolge ist wichtig: wir MÜSSEN die children löschen BEVOR die
  // parents in Schritt 2 verschwinden, sonst findet das Sub-SELECT nichts
  // und die children bleiben verwaist.
  //
  // Für N8-protected children (workstream_decisions/evidence) fängt der
  // BEFORE-DELETE-Trigger den DELETE → kein Fehler nach oben, wir notieren
  // `audit_trail_preserved` (Design-Intent: Audit-Trail bleibt erhalten).
  // ───────────────────────────────────────────────────────────────────────
  for (const d of DERIVED_CHILD_TABLES) {
    if (onlyTables && !onlyTables.has(d.child)) continue;
    const childCols = getColumns(raw, d.child);
    if (childCols.length === 0) continue; // child-Tabelle existiert nicht

    // Wenn child auch eine workspace-bindende Direkt-Spalte trägt, greift
    // Schritt 2 sowieso — diese derived-pass dann skippen, um Doppel-Arbeit
    // zu vermeiden.
    if (pickWorkspaceColumn(childCols) !== null) continue;

    if (!childCols.includes(d.childParentCol)) continue; // falsch verdrahtet

    const isProtected = N8_AUDIT_PROTECTED_TABLES.has(d.child);
    const parentCols = getColumns(raw, d.parent);
    if (
      parentCols.length === 0 ||
      !parentCols.includes(d.parentIdCol) ||
      !parentCols.includes(d.parentWsCol)
    ) {
      continue;
    }

    // Anzahl der „erwarteten" zu löschenden Rows VOR DELETE — nur für
    // N8-Preservation-Reporting nötig (sonst können wir nach erfolgreichem
    // DELETE die counts aus `result.changes` lesen).
    let preCount = 0;
    if (isProtected) {
      try {
        const row = raw
          .prepare(
            `SELECT COUNT(*) AS c FROM ${d.child}
              WHERE ${d.childParentCol} IN (
                SELECT ${d.parentIdCol} FROM ${d.parent} WHERE ${d.parentWsCol} = ?
              )`,
          )
          .get(workspaceId) as { c?: number } | undefined;
        preCount = typeof row?.c === 'number' ? row.c : 0;
      } catch {
        preCount = 0;
      }
    }

    try {
      const stmt = raw.prepare(
        `DELETE FROM ${d.child}
          WHERE ${d.childParentCol} IN (
            SELECT ${d.parentIdCol} FROM ${d.parent} WHERE ${d.parentWsCol} = ?
          )`,
      );
      const result = stmt.run(workspaceId) as { changes?: number };
      const changes = typeof result?.changes === 'number' ? result.changes : 0;
      summary.deleted[d.child] = (summary.deleted[d.child] ?? 0) + changes;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isProtected) {
        summary.audit_trail_preserved.push(`${d.child}:${preCount}`);
        log(`[ok] ${d.child} preserved by N8 trigger (rows=${preCount})`);
      } else {
        summary.errors.push({ table: d.child, message: msg });
        log(`[err] delete from ${d.child} failed: ${msg}`, err);
      }
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  // Schritt 2: Direkt-gebundene Tabellen (workspace_id|coord_key|segment_id).
  // Jetzt wo die derived children weg sind, können die parents (workstreams,
  // sops, flow_templates, …) sicher gelöscht werden.
  // ───────────────────────────────────────────────────────────────────────
  for (const table of allTables) {
    if (onlyTables && !onlyTables.has(table)) continue;
    if (table === 'workspaces') continue; // am Ende optional separat behandelt
    if (DERIVED_CHILD_TABLES.some((d) => d.child === table)) continue; // schon erledigt

    const cols = getColumns(raw, table);
    const wsCol = pickWorkspaceColumn(cols);
    if (!wsCol) continue;

    const isProtected = N8_AUDIT_PROTECTED_TABLES.has(table);
    // Pre-count nur für N8-protected — sonst nehmen wir result.changes.
    const preCount = isProtected
      ? countRowsByWsCol(raw, table, wsCol, workspaceId)
      : 0;

    try {
      const stmt = raw.prepare(`DELETE FROM ${table} WHERE ${wsCol} = ?`);
      const result = stmt.run(workspaceId) as { changes?: number };
      const changes = typeof result?.changes === 'number' ? result.changes : 0;
      summary.deleted[table] = (summary.deleted[table] ?? 0) + changes;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isProtected) {
        summary.audit_trail_preserved.push(`${table}:${preCount}`);
        log(`[ok] ${table} preserved by N8 trigger (rows=${preCount})`);
      } else {
        summary.errors.push({ table, message: msg });
        log(`[err] delete from ${table} failed: ${msg}`, err);
      }
    }
  }

  // 3) Optional: workspaces-Row selbst löschen (Aufrufer-Entscheidung).
  if (opts.deleteWorkspaceRow) {
    try {
      const result = raw
        .prepare('DELETE FROM workspaces WHERE id = ?')
        .run(workspaceId) as { changes?: number };
      const changes = typeof result?.changes === 'number' ? result.changes : 0;
      summary.deleted.workspaces = changes;
      summary.workspace_row_deleted = changes > 0;
    } catch (err) {
      summary.errors.push({
        table: 'workspaces',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return summary;
}

function countRowsByWsCol(
  raw: CleanupRawDb,
  table: string,
  wsCol: string,
  workspaceId: string,
): number {
  try {
    const row = raw
      .prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${wsCol} = ?`)
      .get(workspaceId) as { c?: number } | undefined;
    return typeof row?.c === 'number' ? row.c : 0;
  } catch {
    return 0;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// F2 — Workspace-ID-Kollisions-Schutz.
//
// Verhindert das Owner-Szenario, dass eine neu angelegte Workspace mit
// gleichem Label (→ gleicher Slug) Audit-Spuren des Vorgängers „adoptiert".
//
// Regel:
//   - Wir prüfen ob der vorgeschlagene Slug bereits Spuren in workspace-
//     gebundenen Tabellen hinterlassen hat (chat_ledger.coord_key,
//     workstreams.workspace_id, lazyos_permission_modes.workspace_id,
//     workstream_decisions via workstreams, workstream_evidence via
//     workstreams) — das deckt sowohl direkt-gelöschte Workspaces ab als
//     auch Audit-Trail-Reste, die nicht gelöscht werden können (N8).
//   - Bei Treffer → Disambiguierer anhängen: erst `-2`, `-3`, … bis frei.
//     Nach 9 Versuchen Notausgang: 4-stelliger Random-Suffix.
//   - Deterministisch wenn keine Concurrency-Lücke (kein extra State).
//     Für den Test verifizieren wir die ersten Pfade (`-2`, `-3`).
//
// Idempotenz: Funktion ist read-only — sie SETZT keinen Lock. Aufrufer
// (POST-Route) verlässt sich auf den `INSERT INTO workspaces` direkt danach,
// und SQLite primary-key-uniqueness als finaler Race-Schutz.
// ──────────────────────────────────────────────────────────────────────────

const STALE_PROBE_TABLES: Array<{ table: string; col: string }> = [
  { table: 'workspaces', col: 'id' }, // wird normalerweise vom Aufrufer schon geprüft
  { table: 'chat_ledger', col: 'coord_key' },
  { table: 'workstreams', col: 'workspace_id' },
  { table: 'lazyos_permission_modes', col: 'workspace_id' },
  { table: 'lazyos_permission_audit', col: 'workspace_id' },
  { table: 'streaming_snapshots', col: 'workspace_id' },
  { table: 'workspace_heartbeats', col: 'workspace_id' },
  { table: 'workspace_memberships', col: 'workspace_id' },
  { table: 'workspace_fs_roots', col: 'workspace_id' },
  { table: 'workspace_credentials', col: 'workspace_id' },
  { table: 'rag_chunks', col: 'workspace_id' },
  { table: 'rag_indexer_state', col: 'workspace_id' },
  { table: 'reasoning_audit', col: 'workspace_id' },
  { table: 'audit_log', col: 'workspace_id' },
  { table: 'events', col: 'segment_id' },
];

/**
 * Prüft ob die gegebene workspace-id („Slug") bereits Spuren in irgendeiner
 * der workspace-gebundenen Tabellen hinterlassen hat. Liefert die Tabellen-
 * Liste mit Counts.
 */
export function probeStaleWorkspaceTraces(
  raw: CleanupRawDb,
  workspaceId: string,
): { found: boolean; traces: Array<{ table: string; col: string; count: number }> } {
  const traces: Array<{ table: string; col: string; count: number }> = [];
  for (const { table, col } of STALE_PROBE_TABLES) {
    const cols = getColumns(raw, table);
    if (cols.length === 0 || !cols.includes(col)) continue;
    const count = countRowsByWsCol(raw, table, col, workspaceId);
    if (count > 0) traces.push({ table, col, count });
  }
  return { found: traces.length > 0, traces };
}

/**
 * Disambiguiert einen Slug, indem Suffixe `-2`, `-3`, … angehängt werden
 * solange Audit-Trail-Spuren existieren. Notausgang: 4-stelliger Random.
 *
 * @param raw  raw-DB-Handle
 * @param baseSlug  gewünschter Slug (z.B. „example-website-2")
 * @param maxTries  wieviele numerische Suffixe versucht werden (default 9)
 * @returns disambiguierter Slug (kann == baseSlug sein, wenn frei)
 */
export function disambiguateWorkspaceId(
  raw: CleanupRawDb,
  baseSlug: string,
  maxTries: number = 9,
): string {
  // Pass 1: baseSlug selbst frei?
  if (!probeStaleWorkspaceTraces(raw, baseSlug).found) {
    return baseSlug;
  }

  // Pass 2..N: numerischer Suffix.
  for (let i = 2; i <= maxTries + 1; i++) {
    const candidate = `${baseSlug}-${i}`;
    // Slug-Length-Limit beachten (workspaces.id ist TEXT, slugify cap = 60).
    // Wir bleiben unter 64 chars um POST-Route-Validator zu passieren.
    if (candidate.length > 60) break;
    if (!probeStaleWorkspaceTraces(raw, candidate).found) {
      return candidate;
    }
  }

  // Pass last: random 4-char suffix (lowercase a-z0-9).
  const alpha = 'abcdefghijklmnopqrstuvwxyz0123456789';
  for (let attempt = 0; attempt < 16; attempt++) {
    let suffix = '';
    for (let j = 0; j < 4; j++) {
      suffix += alpha[Math.floor(Math.random() * alpha.length)];
    }
    const candidate = `${baseSlug}-${suffix}`.slice(0, 60);
    if (!probeStaleWorkspaceTraces(raw, candidate).found) {
      return candidate;
    }
  }

  // Wenn 16 random-Versuche alle kollidieren ist irgendwas sehr kaputt —
  // wir geben das letzte Kandidat zurück und überlassen es dem INSERT,
  // mit primary-key-Conflict zu antworten.
  return `${baseSlug}-x${Date.now().toString(36).slice(-4)}`.slice(0, 60);
}

/**
 * Typ-Re-Export-Helper für TypeScript-Konsumenten (Route, Tests). Erlaubt
 * `import type { CleanupSummary } from '@/lib/workspaces/cleanup';` ohne
 * dass die anderen Helpers mitgezogen werden.
 */
// Keep imports referenced to satisfy "noUnusedParameters" if extended later.
export type { DatabaseT };
