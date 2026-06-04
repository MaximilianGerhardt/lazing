/**
 * Flow Studio — repro persistence helpers (Track-D · 2026-05-29).
 *
 * Source: master context §10 finding 2 + Track-D task:
 *   "Jeder POST /api/flow/compose-and-run → garantierter Persistenz-Trail
 *    (flow_run + workstream + events), beobachtbar im Server-Log. UI bekommt
 *    Pending-State sofort sichtbar (Owner kann Verlauf nachvollziehen, auch
 *    wenn Engine 60s+ dauert)."
 *
 * This file is the ADDITIVE persistence layer: it writes NO new
 * tables, but extends the existing flow_runs insert/update with three
 * additional columns (migration 0116: req_id, error_message, error_code) and
 * provides four small helpers:
 *
 *   - createPendingFlowRun(db, …)       → early pending stub into flow_runs.
 *   - updateFlowRunStatus(db, runId, …) → status transition pending→running/failed.
 *   - emitFlowPendingPersistedEvent(…)  → events row (entity_type='flow_run',
 *                                          event_type='flow_pending_persisted')
 *                                          so the UI immediately has an
 *                                          observable marker.
 *   - logComposeAndRunStep(reqId, …)    → structured console.log marker
 *                                          in /tmp/lazyos-prod-4200.log
 *                                          ("[compose-and-run req=…] …").
 *
 * Discipline:
 *   - N1: error_message verbatim (no .slice — stack trace included).
 *   - N4: NO new engine, NO new table — only flow_runs extended.
 *   - N6: deterministic — every helper is pure (raw DB handle injectable).
 *   - N8: trace is evidence — error_message + error_code persisted; the event
 *         documents the pending stub.
 *   - N9: workspaceId + reqId passed everywhere (correlation across scope
 *         boundaries).
 *   - N10: no content_hash (events handle tamper-evidence; a
 *         flow_runs row is working state, not trace tier).
 *
 * Fail-soft (contract):
 *   Persistence errors must NEVER kill the HTTP response. Every helper has
 *   a try/catch + log + return-null/void. The compose spine stays
 *   bit-identical in behavior if these helpers silently fail.
 */

import { ulid } from "@/lib/ulid";

type RawDb = import("better-sqlite3").Database;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Status values (canonical from 0112_flow_studio.sql). */
export type FlowRunStatus =
  | "pending"
  | "running"
  | "done"
  | "failed"
  | "cancelled";

export interface CreatePendingFlowRunInput {
  /** flow_templates.id (returned by composeFlowFromIntent). */
  readonly flowId: string;
  /** ManifestCoord scope (N9). */
  readonly workspaceId: string;
  /**
   * Request correlation ID (UI ↔ server log ↔ DB). MUST be set —
   * owner verification path: `SELECT * FROM flow_runs WHERE req_id = ?`.
   */
  readonly reqId: string;
  /** Optionally provided ID (tests). Default = `FRUN-<ulid>`. */
  readonly id?: string;
}

export interface PendingFlowRunRow {
  readonly id: string;
  readonly flowId: string;
  readonly workspaceId: string;
  readonly workstreamId: null;
  readonly reqId: string;
  readonly status: "pending";
  readonly createdAt: number;
}

export interface UpdateFlowRunStatusInput {
  readonly runId: string;
  readonly status: FlowRunStatus;
  /** On status='running' optional: set the now-known workstreams.id. */
  readonly workstreamId?: string | null;
  /** On status='failed': verbatim error message (N1, no .slice). */
  readonly errorMessage?: string | null;
  /** On status='failed': machine-readable code. */
  readonly errorCode?: string | null;
}

// ---------------------------------------------------------------------------
// createPendingFlowRun — the early pending stub
// ---------------------------------------------------------------------------

/**
 * Writes a flow_runs row with status='pending' IMMEDIATELY after a successful
 * composeFlowFromIntent. The owner thereby sees the run even when
 *
 *   - the branch is needs-coupling/needs-style-choice (no dispatch yet),
 *   - the engine takes 60s+ (the UI immediately has a flowRunId to poll),
 *   - the dispatchFlow transaction fails midway (the status is flipped to
 *     'failed' — no orphaned UI wait).
 *
 * Fail-soft: on a DB error null is returned + a console.error
 * is logged. The HTTP response stays unaffected (same posture as all
 * other best-effort write paths in this codebase, e.g. emitOrUpdateCard).
 *
 * Return: the persisted row (with id) OR null on error.
 */
export function createPendingFlowRun(
  db: RawDb,
  input: CreatePendingFlowRunInput,
): PendingFlowRunRow | null {
  if (typeof input.flowId !== "string" || input.flowId.length === 0) {
    return null;
  }
  if (typeof input.workspaceId !== "string" || input.workspaceId.length === 0) {
    return null;
  }
  if (typeof input.reqId !== "string" || input.reqId.length === 0) {
    return null;
  }
  const id = input.id ?? `FRUN-${ulid()}`;
  const ts = Date.now();
  try {
    db.prepare(
      `INSERT INTO flow_runs
         (id, flow_id, workspace_id, workstream_id, status,
          req_id, error_message, error_code,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?, NULL, NULL, ?, ?)`,
    ).run(id, input.flowId, input.workspaceId, null, input.reqId, ts, ts);
    return {
      id,
      flowId: input.flowId,
      workspaceId: input.workspaceId,
      workstreamId: null,
      reqId: input.reqId,
      status: "pending",
      createdAt: ts,
    };
  } catch (err) {
    // Fail-soft: don't kill, just log.
    console.error(
      "[compose-and-run req=" +
        input.reqId +
        "] createPendingFlowRun failed (non-fatal):",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// updateFlowRunStatus — status transitions (pending → running | failed)
// ---------------------------------------------------------------------------

/**
 * Status transition on an existing flow_runs row. Called after the
 * early pending stub, once we know more:
 *
 *   - dispatchFlow successful → status='running', workstreamId set.
 *   - dispatchFlow/compose exception → status='failed' + errorMessage/code.
 *
 * Fail-soft: on a DB error false is returned + console.error. The
 * HTTP response stays unaffected.
 */
export function updateFlowRunStatus(
  db: RawDb,
  input: UpdateFlowRunStatusInput,
): boolean {
  if (typeof input.runId !== "string" || input.runId.length === 0) {
    return false;
  }
  const ts = Date.now();
  try {
    const r = db
      .prepare(
        `UPDATE flow_runs
            SET status = ?,
                workstream_id = COALESCE(?, workstream_id),
                error_message = COALESCE(?, error_message),
                error_code = COALESCE(?, error_code),
                updated_at = ?
          WHERE id = ?`,
      )
      .run(
        input.status,
        input.workstreamId ?? null,
        input.errorMessage ?? null,
        input.errorCode ?? null,
        ts,
        input.runId,
      );
    return r.changes > 0;
  } catch (err) {
    console.error(
      "[compose-and-run] updateFlowRunStatus failed (non-fatal):",
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}

// ---------------------------------------------------------------------------
// updateFlowRunFlowId — flow_id backfill for the early pending stub
// ---------------------------------------------------------------------------

/**
 * Phase 1 — finding 1 (2026-05-29): the early pending stub is written BEFORE
 * `composeFlowFromIntent`, BEFORE the real flow_template.id
 * exists. We use a synthetic placeholder
 * (`pending:<reqId>`) as the flow_id; after a successful compose we backfill
 * the real flowId in the same row.
 *
 * Deliberately separate from `updateFlowRunStatus`, because this path ONLY
 * establishes the correlation stub ↔ flow_template — no status transition. This
 * keeps the status machine (pending → running | failed) unambiguously readable.
 *
 * Fail-soft: on a DB error false + console.error. The HTTP response stays
 * unaffected.
 */
export function updateFlowRunFlowId(
  db: RawDb,
  input: { readonly runId: string; readonly flowId: string },
): boolean {
  if (typeof input.runId !== "string" || input.runId.length === 0) {
    return false;
  }
  if (typeof input.flowId !== "string" || input.flowId.length === 0) {
    return false;
  }
  const ts = Date.now();
  try {
    const r = db
      .prepare(
        `UPDATE flow_runs
            SET flow_id = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(input.flowId, ts, input.runId);
    return r.changes > 0;
  } catch (err) {
    console.error(
      "[compose-and-run] updateFlowRunFlowId failed (non-fatal):",
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}

// ---------------------------------------------------------------------------
// emitFlowPendingPersistedEvent — UI marker in the events stream
// ---------------------------------------------------------------------------

/**
 * Emits an events row with entity_type='flow_run',
 * event_type='flow_pending_persisted'. ChatShell + the state-projection spine
 * (P1.E) can read from it that a flow run was initiated — even
 * when the engine still takes 60s+.
 *
 * Schema reference: db/migrations/0001_initial.sql:4 — events(id, created_at,
 * segment_id, entity_type, entity_id, event_type, actor, payload, sensitivity,
 * signature, replayed_from). `segment_id` here is the workspaceId
 * (laz.ing convention: segment == workspace in the event-sourced path).
 *
 * Fail-soft: on a DB error just log.
 */
export function emitFlowPendingPersistedEvent(
  db: RawDb,
  input: {
    readonly workspaceId: string;
    readonly flowRunId: string;
    readonly flowId: string;
    readonly reqId: string;
    readonly workstreamId?: string | null;
    readonly status: "pending" | "needs-coupling" | "needs-style-choice";
  },
): void {
  try {
    const eventId = `EVT-${ulid()}`;
    const ts = Date.now();
    const payload = JSON.stringify({
      flowRunId: input.flowRunId,
      flowId: input.flowId,
      reqId: input.reqId,
      workstreamId: input.workstreamId ?? null,
      pendingStatus: input.status,
    });
    db.prepare(
      `INSERT INTO events
         (id, created_at, segment_id, entity_type, entity_id, event_type,
          actor, payload, sensitivity)
       VALUES (?, ?, ?, 'flow_run', ?, 'flow_pending_persisted',
               'system', ?, 'low')`,
    ).run(
      eventId,
      ts,
      input.workspaceId,
      input.flowRunId,
      payload,
    );
  } catch (err) {
    console.error(
      "[compose-and-run req=" +
        input.reqId +
        "] emitFlowPendingPersistedEvent failed (non-fatal):",
      err instanceof Error ? err.message : String(err),
    );
  }
}

// ---------------------------------------------------------------------------
// logComposeAndRunStep — structured server log marker
// ---------------------------------------------------------------------------

/**
 * Structured console.log in the format
 *   [compose-and-run req=<reqId>] <step> <key1=val1> <key2=val2> …
 *
 * This way the owner sees in /tmp/lazyos-prod-4200.log what really happens:
 *
 *   tail -f /tmp/lazyos-prod-4200.log | grep "compose-and-run"
 *
 * Keys/values are stringified conservatively (objects → JSON, primitives →
 * string). Null/undefined is skipped (no noise).
 */
export function logComposeAndRunStep(
  reqId: string,
  step: string,
  fields?: Readonly<Record<string, unknown>>,
): void {
  const parts: string[] = [];
  if (fields) {
    for (const [k, v] of Object.entries(fields)) {
      if (v == null) continue;
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
        parts.push(`${k}=${v}`);
      } else {
        try {
          parts.push(`${k}=${JSON.stringify(v)}`);
        } catch {
          parts.push(`${k}=<unserializable>`);
        }
      }
    }
  }
  const tail = parts.length > 0 ? " " + parts.join(" ") : "";
  console.log(`[compose-and-run req=${reqId}] ${step}${tail}`);
}

// ---------------------------------------------------------------------------
// makeRequestId — compact, unique request identifier
// ---------------------------------------------------------------------------

/**
 * Generates a compact request ID (ULID-based, prefixed `req-`).
 * Deliberately shorter in the log than a full ULID — searchability in the /tmp log + DB.
 */
export function makeRequestId(): string {
  return `req-${ulid().slice(-12).toLowerCase()}`;
}
