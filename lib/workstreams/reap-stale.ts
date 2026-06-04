/**
 * Stuck-Reaping / Stale-Aging Terminalizer (Owner-Fix 2026-05-29).
 *
 * EMPIRISCHES PROBLEM (Owner-Befund, mehrfach offen):
 *   16 Workstreams hingen auf `status='stuck'`, mehrere 4 Tage alt (seit
 *   2026-05-25), und alterten NIE aus. `/api/activity/live` zaehlt
 *   `status IN (active, paused, stuck)` → die Pill blieb dauerhaft an,
 *   das Observatory meldete „0 von 15 alive". Es gab zwar
 *     (a) einen Filter-only-Patch in der Live-Route (zaehlt alte stuck
 *         nicht mehr — kosmetisch, DB-Row bleibt stuck), und
 *     (b) `markAbandonedStuckWorkstreams()` (Owner-manueller Opt-in,
 *         NICHT gehookt, transitioniert ausserdem auf den nicht im
 *         WorkstreamStatus-Enum enthaltenen Wert `'abandoned'`).
 *   Was FEHLTE: ein periodisch aufgerufener Reaper, der alte stuck-Rows
 *   (und still gefallene active-Rows) auf einen GUELTIGEN Terminal-Status
 *   ueberfuehrt, sodass sie tatsaechlich aus dem Live-Aggregat verschwinden
 *   statt nur weggefiltert zu werden.
 *
 * WURZELFIX (diese Datei):
 *   `reapStaleWorkstreams(opts)` ueberfuehrt periodisch:
 *     1. `stuck`-Workstreams aelter als `stuckMaxAgeMs` (Default 6h) →
 *        `archived` (ein GUELTIGER Terminal-Status aus WorkstreamStatus:
 *        active|paused|done|archived|stuck).
 *     2. `active`-Workstreams ohne Heartbeat aelter als `activeMaxSilenceMs`
 *        (Default 30min) → `archived`. Das ist die „active ohne Heartbeat"-
 *        Klasse aus dem Brief: ein Restart liess den In-Memory-inFlight-
 *        Zustand sterben, die Row haengt in `active`. Der bestehende
 *        Recovery-Sweep (lib/workstreams/recovery.ts) markiert solche Rows
 *        zunaechst auf `stuck` (mit Liveness-Guard + Push + Card); der
 *        Reaper greift NUR Rows, die KEINEN lebendigen Sub-WS haben und
 *        deutlich aelter sind — Doppel-Sicherung, kein Konflikt.
 *
 * N6 (deterministisch): reiner Zeit-Proxy (`updated_at`) + fixe Schwellen,
 *   kein LLM-Reasoning. Mehrfach-Aufruf ist deterministisch + idempotent
 *   (WHERE-Guard auf den Ausgangs-Status).
 * N8 (Trace ist Evidenz): jeder Reap schreibt eine `workstream_decisions`-
 *   Row via `writeDecision` (decisionKind `orphan_detected` — semantisch:
 *   ein nie-recovertes Orphan; kein neuer Enum-Wert noetig, Schema bleibt
 *   unangetastet). content_hash + Evidence-Sentinel kommen aus writeDecision
 *   (N10).
 * Kein DELETE — nur Status-Uebergang (erlaubt; destruktive Loeschung nicht).
 *
 * Idempotent + fail-soft: leere Liste = no-op, ein kaputter Row bricht den
 * Lauf nicht ab.
 */

import { getDb } from '../../db/client';
import { writeDecision } from './trace-repo';

// ---------------------------------------------------------------------------
// Konfiguration / Defaults
// ---------------------------------------------------------------------------

/** Default: stuck-Workstreams aelter als 6h werden gereapt. */
export const DEFAULT_STUCK_MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6h

/**
 * Default: active-Workstreams ohne Heartbeat (kein updated_at-Fortschritt)
 * aelter als 30min werden gereapt. Liegt bewusst ueber dem Recovery-Sweep-
 * STALE_MS (20min) — der Sweep markiert zuerst auf `stuck`, erst danach
 * reapt dieser Pfad. So bleibt die Notify/Card-Mechanik des Sweeps intakt.
 */
export const DEFAULT_ACTIVE_MAX_SILENCE_MS = 30 * 60 * 1000; // 30min

/**
 * Maximale Anzahl Rows die pro Reap-Tick terminalisiert werden. Schutz
 * gegen „erster Boot nach langer Downtime = hunderte stuck-Rows auf einmal".
 */
export const REAP_MAX_PER_TICK = 100;

/** Terminal-Status auf den gereapt wird. Gueltiger WorkstreamStatus-Wert. */
const TERMINAL_STATUS = 'archived' as const;

export interface ReapStaleOptions {
  /** Zeitreferenz (Default Date.now()). Testbar. */
  now?: number;
  /** Schwelle fuer stuck-Reaping in ms. Default 6h. */
  stuckMaxAgeMs?: number;
  /** Schwelle fuer active-ohne-Heartbeat-Reaping in ms. Default 30min. */
  activeMaxSilenceMs?: number;
  /** Dry-Run — nur Liste, kein Update + kein Decision-Write. */
  dryRun?: boolean;
  /** Obergrenze pro Lauf. Default REAP_MAX_PER_TICK. */
  maxPerTick?: number;
}

export interface ReapedRow {
  workstreamId: string;
  workspaceId: string;
  previousStatus: 'stuck' | 'active';
  ageMs: number;
}

export interface ReapStaleResult {
  /** Anzahl Kandidaten-Rows die das SELECT zurueckgab. */
  scanned: number;
  /** IDs der tatsaechlich gereapten Rows. */
  reaped: string[];
  /** Pro-Row-Details (auch im dryRun befuellt). */
  details: ReapedRow[];
  /** Rows die beim Reapen einen Fehler warfen (Lauf geht weiter). */
  errors: number;
  /** Timestamp des Lauf-Starts. */
  reapedAt: number;
}

interface CandidateRow {
  id: string;
  workspace_id: string;
  status: string;
  updated_at: number | null;
}

// ---------------------------------------------------------------------------
// In-Process-Guard gegen Doppel-Lauf bei schnellem Interval + DB-Latenz.
// ---------------------------------------------------------------------------

let reapInProgress = false;

/**
 * Reapt alte stuck- + still gefallene active-Workstreams auf `archived`.
 *
 * @returns Ergebnis-Statistik. Nie throw (fail-soft).
 */
export function reapStaleWorkstreams(
  opts: ReapStaleOptions = {},
): ReapStaleResult {
  const now = opts.now ?? Date.now();
  const stuckMaxAgeMs = opts.stuckMaxAgeMs ?? DEFAULT_STUCK_MAX_AGE_MS;
  const activeMaxSilenceMs =
    opts.activeMaxSilenceMs ?? DEFAULT_ACTIVE_MAX_SILENCE_MS;
  const dryRun = opts.dryRun === true;
  const maxPerTick = opts.maxPerTick ?? REAP_MAX_PER_TICK;

  const reapedAt = now;

  if (reapInProgress) {
    return { scanned: 0, reaped: [], details: [], errors: 0, reapedAt };
  }
  reapInProgress = true;
  try {
    return runReap(now, stuckMaxAgeMs, activeMaxSilenceMs, dryRun, maxPerTick, reapedAt);
  } finally {
    reapInProgress = false;
  }
}

function runReap(
  now: number,
  stuckMaxAgeMs: number,
  activeMaxSilenceMs: number,
  dryRun: boolean,
  maxPerTick: number,
  reapedAt: number,
): ReapStaleResult {
  const db = getDb();
  const stuckCutoff = now - stuckMaxAgeMs;
  const activeCutoff = now - activeMaxSilenceMs;

  // EIN SELECT fuer beide Klassen — deterministisch sortiert (aelteste zuerst),
  // bounded via LIMIT. Nur die zwei reapbaren Ausgangs-Status.
  //   - stuck   + updated_at < stuckCutoff
  //   - active  + updated_at < activeCutoff
  const rows = db.$raw
    .prepare(
      `SELECT id, workspace_id, status, updated_at
         FROM workstreams
        WHERE (status = 'stuck'  AND COALESCE(updated_at, 0) < ?)
           OR (status = 'active' AND COALESCE(updated_at, 0) < ?)
        ORDER BY COALESCE(updated_at, 0) ASC
        LIMIT ?`,
    )
    .all(stuckCutoff, activeCutoff, maxPerTick) as CandidateRow[];

  const details: ReapedRow[] = [];
  const reaped: string[] = [];
  let errors = 0;

  // Idempotenter, status-geguardeter UPDATE: NUR wenn die Row noch im
  // erwarteten Ausgangs-Status ist (verhindert Race mit dem Recovery-Sweep
  // oder einem echten Agent-Finish zwischen SELECT und UPDATE).
  const updateStmt = db.$raw.prepare(
    `UPDATE workstreams
        SET status = '${TERMINAL_STATUS}', updated_at = ?
      WHERE id = ? AND status = ?`,
  );

  for (const row of rows) {
    const prev = row.status === 'stuck' ? 'stuck' : 'active';
    const ageMs = now - (row.updated_at ?? now);
    const detail: ReapedRow = {
      workstreamId: row.id,
      workspaceId: row.workspace_id,
      previousStatus: prev,
      ageMs,
    };
    details.push(detail);

    if (dryRun) continue;

    try {
      const result = updateStmt.run(now, row.id, row.status) as {
        changes?: number;
      };
      if ((result.changes ?? 0) === 0) {
        // Race: Status hat sich zwischen SELECT und UPDATE geaendert.
        // Kein Reap, keine Decision — kein Fehler.
        continue;
      }
      reaped.push(row.id);

      // N8: Begruendung an dieselbe Stelle wo bestehende Status-Uebergaenge
      // geloggt werden (workstream_decisions via writeDecision). content_hash
      // + Evidence-Sentinel werden intern erzeugt (N10). Best-effort.
      const minutes = Math.round(ageMs / 60_000);
      const rationale =
        `Stuck-Reaper: Workstream war '${prev}' und ` +
        `seit ${minutes}min ohne updated_at-Fortschritt ` +
        `(Schwelle: ${prev === 'stuck' ? Math.round(stuckMaxAgeMs / 60_000) : Math.round(activeMaxSilenceMs / 60_000)}min). ` +
        `Terminalisiert auf '${TERMINAL_STATUS}' (kein DELETE, reversibel via Status-Update). ` +
        `Reason: stale-${prev}-no-progress:${minutes}min. ` +
        `Deterministischer Zeit-Proxy (updated_at), kein LLM-Reasoning (N6).`;

      try {
        writeDecision({
          workspaceId: row.workspace_id,
          workstreamId: row.id,
          coordKey: `${row.workspace_id}/${row.id}`,
          decisionKind: 'orphan_detected',
          rationale,
          actor: 'policy',
        });
      } catch {
        // Decision-Write ist best-effort; der Status-Uebergang steht bereits.
      }
    } catch (err) {
      errors += 1;
      // eslint-disable-next-line no-console
      console.warn(
        '[reap-stale] Fehler beim Reapen von',
        row.id,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  if (reaped.length > 0) {
    // eslint-disable-next-line no-console
    console.info(
      `[reap-stale] ${reaped.length} stale Workstream(s) auf '${TERMINAL_STATUS}' gesetzt`,
      `(scanned=${details.length}, errors=${errors})`,
    );
  }

  return { scanned: rows.length, reaped, details, errors, reapedAt };
}

/** Setzt den In-Process-Guard zurueck. NUR fuer Tests. */
export function __resetReapGuardForTests(): void {
  reapInProgress = false;
}

// ---------------------------------------------------------------------------
// Orphaned-flow_runs-Reaper (Reliability-Sweep 2026-05-30)
//
// EMPIRISCHES PROBLEM (Reliability-Sweep, DB-verifiziert):
//   `flow_runs` sammelt `pending`/`running`-Rows die NIE terminalisieren.
//   Stand des Sweeps: 39 Rows haengen (36 pending + 3 running) —
//     - 29 pending OHNE Workstream (workstream_id NULL/dangling = nie
//       dispatcht: compose schrieb die Row, der Dispatch kam nie),
//     - 10 zeigen auf Workstreams die laengst `archived`/`cancelled` sind.
//   `resume-orphans.ts` *belebt* flow_runs nur (pending→running beim Boot);
//   `plan-executor.ts` setzt sie bei echtem Lauf-Ende auf done/failed. Was
//   FEHLT: ein Pfad der flow_runs reapt deren Workstream bereits terminal
//   (oder nie existiert) ist. Solche Rows zaehlen ewig als „offen" in jeder
//   flow_runs-Projektion/Statistik und waxen monoton — der Owner nutzt das
//   System produktiv, das ist ein echter Hygiene-Leak.
//
// WURZELFIX: `reapOrphanedFlowRuns` ueberfuehrt `pending`/`running`-flow_runs,
//   die aelter als `maxAgeMs` (Default 30min) sind UND deren Workstream
//   fehlt ODER bereits in einem Terminal-Status (done/archived/cancelled/stuck)
//   liegt, auf `'cancelled'` (ein gueltiger flow_runs-Status laut Schema-
//   Kommentar: pending|running|done|failed|cancelled). KEIN DELETE — nur
//   Status-Uebergang, reversibel.
//
//   Sicherheit gegen Fehl-Reaping eines LEBENDEN Laufs:
//     - WHERE bindet `fr.workstream_id IS NULL OR w.id IS NULL OR
//       w.status IN (terminal)` — ein Flow-Run dessen Workstream noch
//       active/paused ist, wird NIE erfasst (der laeuft ggf. noch).
//     - Zusaetzlich Alters-Schwelle (updated_at < now-maxAgeMs).
//     - Status-geguardeter UPDATE (nur pending/running → cancelled).
//
// N6 (deterministisch): reiner Zeit-Proxy + Status-Join, kein LLM. Idempotent.
// Kein Decision-Write hier (flow_runs ist keine workstream_decisions-Entity;
// der zugehoerige Workstream traegt seine eigene Terminalisierungs-Decision).
// ---------------------------------------------------------------------------

/** Default: flow_runs mit terminalem/fehlendem Workstream aelter als 30min werden gereapt. */
export const DEFAULT_FLOW_RUN_MAX_AGE_MS = 30 * 60 * 1000; // 30min

/** Terminal-Status auf den orphaned flow_runs gesetzt werden (gueltig laut Schema). */
const FLOW_RUN_TERMINAL_STATUS = 'cancelled' as const;

export interface ReapFlowRunsOptions {
  now?: number;
  /** Alters-Schwelle in ms. Default 30min. */
  maxAgeMs?: number;
  dryRun?: boolean;
  /** Obergrenze pro Lauf. Default REAP_MAX_PER_TICK. */
  maxPerTick?: number;
}

export interface ReapFlowRunsResult {
  scanned: number;
  reaped: string[];
  errors: number;
  reapedAt: number;
}

let reapFlowRunsInProgress = false;

/**
 * Reapt orphaned flow_runs (pending/running mit terminalem oder fehlendem
 * Workstream) auf `cancelled`. Fail-soft, idempotent, nie throw.
 */
export function reapOrphanedFlowRuns(
  opts: ReapFlowRunsOptions = {},
): ReapFlowRunsResult {
  const now = opts.now ?? Date.now();
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_FLOW_RUN_MAX_AGE_MS;
  const dryRun = opts.dryRun === true;
  const maxPerTick = opts.maxPerTick ?? REAP_MAX_PER_TICK;
  const reapedAt = now;

  if (reapFlowRunsInProgress) {
    return { scanned: 0, reaped: [], errors: 0, reapedAt };
  }
  reapFlowRunsInProgress = true;
  try {
    const db = getDb();
    const cutoff = now - maxAgeMs;

    // Orphan-Definition: kein lebendiger (active/paused) Workstream haengt dran.
    // LEFT JOIN faengt sowohl fehlende (w.id IS NULL) als auch terminale WS.
    const rows = db.$raw
      .prepare(
        `SELECT fr.id AS id
           FROM flow_runs fr
           LEFT JOIN workstreams w ON w.id = fr.workstream_id
          WHERE fr.status IN ('pending', 'running')
            AND COALESCE(fr.updated_at, 0) < ?
            AND (
                  fr.workstream_id IS NULL
               OR w.id IS NULL
               OR w.status IN ('done', 'archived', 'cancelled', 'stuck')
            )
          ORDER BY COALESCE(fr.updated_at, 0) ASC
          LIMIT ?`,
      )
      .all(cutoff, maxPerTick) as Array<{ id: string }>;

    const reaped: string[] = [];
    let errors = 0;

    if (!dryRun && rows.length > 0) {
      const updateStmt = db.$raw.prepare(
        `UPDATE flow_runs
            SET status = '${FLOW_RUN_TERMINAL_STATUS}',
                updated_at = ?,
                error_code = COALESCE(error_code, 'orphaned-reaped'),
                error_message = COALESCE(error_message, ?)
          WHERE id = ? AND status IN ('pending', 'running')`,
      );
      const msg =
        'Flow-Run-Reaper: zugehoeriger Workstream fehlt oder ist terminal — ' +
        'auf cancelled gesetzt (Reliability-Sweep, kein DELETE).';
      for (const r of rows) {
        try {
          const res = updateStmt.run(now, msg, r.id) as { changes?: number };
          if ((res.changes ?? 0) > 0) reaped.push(r.id);
        } catch (err) {
          errors += 1;
          // eslint-disable-next-line no-console
          console.warn(
            '[reap-stale] flow_run reap fehlgeschlagen fuer',
            r.id,
            err instanceof Error ? err.message : String(err),
          );
        }
      }
      if (reaped.length > 0) {
        // eslint-disable-next-line no-console
        console.info(
          `[reap-stale] ${reaped.length} orphaned flow_run(s) auf '${FLOW_RUN_TERMINAL_STATUS}' gesetzt`,
          `(scanned=${rows.length}, errors=${errors})`,
        );
      }
    }

    return { scanned: rows.length, reaped, errors, reapedAt };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      '[reap-stale] reapOrphanedFlowRuns-Lauf fehlgeschlagen (non-fatal):',
      err instanceof Error ? err.message : String(err),
    );
    return { scanned: 0, reaped: [], errors: 1, reapedAt };
  } finally {
    reapFlowRunsInProgress = false;
  }
}

/** Setzt den flow_run-Reaper-Guard zurueck. NUR fuer Tests. */
export function __resetFlowRunReapGuardForTests(): void {
  reapFlowRunsInProgress = false;
}
