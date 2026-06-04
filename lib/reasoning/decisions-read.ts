/**
 * A1 — Decision-Read-Back · Self-Learning / WHY engine · Stream A · 2026-05-27.
 *
 * Source: GOAL-lazyos-self-learning-why-engine +
 *         docs/plans/2026-05-27_self-learning-and-flow-completion-plan.md.
 *
 * Core finding this module fixes: `workstream_decisions` (migration 0071)
 * is today ONLY written via lib/workstreams/trace-repo.ts (writeDecision)
 * and NEVER read back. The WHY of every decision (rationale, N1-verbatim,
 * N8 trail, N10 tamper-evident) thus lies fallow. This module makes the trail
 * readable — as a precondition for the WHY injection into compose/plan (A3) and
 * the post-process reconciliation (A5).
 *
 * Approach (analogous to lib/flow/templates-repo.ts):
 *   - Takes a RAW better-sqlite3 handle (`getDb().$raw`) — no
 *     getDb() singleton, directly in-memory testable.
 *   - PURE/IO-light: exclusively SELECTs, NO LLM, NO network I/O, no write.
 *   - Deterministic: stable ORDER BY (created_at DESC, id DESC as tie-break).
 *
 * Scope note (checked against 0071): `workstream_decisions` carries NO
 * own workspace_id and no coord_key — only `workstream_id` (FK on
 * workstreams). The workspace scope hangs on `workstreams.workspace_id`
 * (NOT NULL, checked in db/schema/workstreams.ts). So we join
 * workstream_decisions → workstreams to filter by workspaceId. The
 * optional `coordKey` filter is resolved against `workstream_id` — that is
 * the actually persisted scope key of the decision row (trace-repo treats
 * coordKey as a `<workspaceId>/<workstreamId>` label, but persists only
 * the workstream_id of it).
 */

type RawDb = import("better-sqlite3").Database;

import type { DecisionActor, DecisionKind } from "@/lib/workstreams/trace-repo";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A read decision row (workstream_decisions, 1:1 columns). */
export interface DecisionRow {
  readonly id: string;
  readonly workstreamId: string;
  /** Workspace scope, via JOIN from workstreams.workspace_id. */
  readonly workspaceId: string;
  readonly decisionKind: DecisionKind;
  /** The WHY, VERBATIM (N1). */
  readonly rationale: string;
  /** JSON-array string of workstream_evidence.id (≥1). */
  readonly evidenceRefs: string;
  readonly contentHash: string;
  readonly actor: DecisionActor;
  readonly createdAt: number;
  /** Recovery marker (nullable). */
  readonly recoveredAt: number | null;
}

export interface ListDecisionsOpts {
  /** Required: workspace scope (N9). Filters via JOIN on workstreams. */
  readonly workspaceId: string;
  /** Optional: only a specific decision_kind. */
  readonly kind?: DecisionKind;
  /**
   * Optional: scope key. Resolved against workstream_id (the actually
   * persisted scope of the decision row). Accepts both a plain
   * workstream_id and a `<workspaceId>/<workstreamId>` label (the latter
   * is reduced to the part after the last '/').
   */
  readonly coordKey?: string;
  /** Optional: max count (default 50). */
  readonly limit?: number;
}

/** Condensed rationale for the WHY injection (A3). */
export interface RecentRationale {
  readonly decisionKind: DecisionKind;
  /** The WHY, VERBATIM (N1). */
  readonly rationale: string;
  readonly actor: DecisionActor;
  readonly createdAt: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_LIMIT = 50;

function clampLimit(limit: number | undefined): number {
  if (limit == null || !Number.isFinite(limit) || limit <= 0) {
    return DEFAULT_LIMIT;
  }
  return Math.floor(limit);
}

/**
 * Reduces a coordKey to the workstream_id. A label of the form
 * `<workspaceId>/<workstreamId>` is reduced to the part after the last '/';
 * a plain identifier stays unchanged.
 */
function coordKeyToWorkstreamId(coordKey: string): string {
  const slash = coordKey.lastIndexOf("/");
  return slash >= 0 ? coordKey.slice(slash + 1) : coordKey;
}

function mapDecisionRow(r: Record<string, unknown>): DecisionRow {
  return {
    id: String(r.id),
    workstreamId: String(r.workstream_id),
    workspaceId: String(r.workspace_id),
    decisionKind: r.decision_kind as DecisionKind,
    rationale: String(r.rationale),
    evidenceRefs: String(r.evidence_refs),
    contentHash: String(r.content_hash),
    actor: r.actor as DecisionActor,
    createdAt: Number(r.created_at),
    recoveredAt: r.recovered_at == null ? null : Number(r.recovered_at),
  };
}

// ---------------------------------------------------------------------------
// listDecisions
// ---------------------------------------------------------------------------

/**
 * Reads workstream_decisions for a workspace — optionally filtered by
 * decision_kind and/or coordKey (→ workstream_id). Newest first.
 *
 * Join logic: workstream_decisions.workstream_id = workstreams.id, filtered
 * on workstreams.workspace_id = opts.workspaceId.
 */
export function listDecisions(
  raw: RawDb,
  opts: ListDecisionsOpts,
): DecisionRow[] {
  if (typeof opts.workspaceId !== "string" || opts.workspaceId.length === 0) {
    throw new Error("listDecisions: workspaceId required");
  }
  const where: string[] = ["w.workspace_id = ?"];
  const params: unknown[] = [opts.workspaceId];

  if (opts.kind) {
    where.push("d.decision_kind = ?");
    params.push(opts.kind);
  }
  if (opts.coordKey) {
    where.push("d.workstream_id = ?");
    params.push(coordKeyToWorkstreamId(opts.coordKey));
  }

  const limit = clampLimit(opts.limit);
  params.push(limit);

  const rows = raw
    .prepare(
      `SELECT d.id, d.workstream_id, w.workspace_id AS workspace_id,
              d.decision_kind, d.rationale, d.evidence_refs, d.content_hash,
              d.actor, d.created_at, d.recovered_at
         FROM workstream_decisions d
         JOIN workstreams w ON w.id = d.workstream_id
        WHERE ${where.join(" AND ")}
        ORDER BY d.created_at DESC, d.id DESC
        LIMIT ?`,
    )
    .all(...params) as Record<string, unknown>[];

  return rows.map(mapDecisionRow);
}

// ---------------------------------------------------------------------------
// recentRationales
// ---------------------------------------------------------------------------

/**
 * The most recent rationales of a workspace — condensed to the fields
 * relevant for the WHY injection (A3) (decisionKind, rationale, actor,
 * createdAt). Newest first.
 *
 * Deliberately NO .slice on rationale (N1) — the caller (compose/plan) is
 * responsible for sensible length/token budgeting.
 */
export function recentRationales(
  raw: RawDb,
  workspaceId: string,
  limit?: number,
): RecentRationale[] {
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("recentRationales: workspaceId required");
  }
  const n = clampLimit(limit);
  const rows = raw
    .prepare(
      `SELECT d.decision_kind, d.rationale, d.actor, d.created_at
         FROM workstream_decisions d
         JOIN workstreams w ON w.id = d.workstream_id
        WHERE w.workspace_id = ?
        ORDER BY d.created_at DESC, d.id DESC
        LIMIT ?`,
    )
    .all(workspaceId, n) as Record<string, unknown>[];

  return rows.map((r) => ({
    decisionKind: r.decision_kind as DecisionKind,
    rationale: String(r.rationale),
    actor: r.actor as DecisionActor,
    createdAt: Number(r.created_at),
  }));
}
