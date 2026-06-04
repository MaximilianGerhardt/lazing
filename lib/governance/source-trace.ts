/**
 * G3 — Source-Trace / Raw-vs-Derived-Policy
 * (Phase 2 W2.1 · Lane G Governance · 2026-05-29).
 *
 * Integration plan §4 Lane G (verbatim, N1):
 *   „Raw vs Derived Data Policy · Source Trace Rules"
 *
 * Every unit derived from a data source (chunk, belief, message)
 * carries a source_traces row that points to its origin via derived_from_trace.
 * This way the whole provenance chain can be reconstructed backwards
 * („Wo kommt dieser belief her? → derived von welchem chunk? → der war eine
 * Zusammenfassung welcher whatsapp-message?").
 *
 * Mechanics:
 *   - Pure DB read/write, no LLM, no net I/O.
 *   - N1:  externalId / content_hash verbatim.
 *   - N9:  workspaceId-scoped.
 *   - N10: content_hash per row.
 *
 * Retention policy (default values from lib/governance/retention.ts):
 *   - rawDataDays:     30   — raw content is deleted after 30 days
 *                             (raw_retention_until = createdAt + 30d)
 *   - derivedDataDays: 365  — derived data is kept for 365 days
 *                             (raw_retention_until = createdAt + 365d when
 *                              derivedFromTrace is set)
 *
 * Public API:
 *   recordSourceTrace(raw, input)  — creates a source_traces row
 *   traceLineage(raw, contentHash) — returns the FULL provenance chain
 *   listSourceTraces(raw, opts)    — list per workspace, newest first
 */

import { ulid } from "@/lib/ulid";

import {
  DEFAULT_RETENTION_POLICY,
  type RetentionPolicy,
} from "./retention";

type RawDb = import("better-sqlite3").Database;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SourceTrace {
  readonly id: string;
  readonly workspaceId: string;
  readonly dataSource: string;
  readonly externalId: string | null;
  readonly contentHash: string;
  readonly derivedFromTrace: string | null;
  readonly rawRetentionUntil: number | null;
  readonly createdAt: number;
}

export interface RecordSourceTraceInput {
  readonly workspaceId: string;
  readonly dataSource: string;
  readonly externalId?: string | null;
  readonly contentHash: string;
  readonly derivedFromTrace?: string | null;
  /**
   * If given, overrides the default retention. Otherwise it is derived
   * from the RetentionPolicy (rawData vs derivedData).
   */
  readonly rawRetentionUntil?: number | null;
  /** Optional: alternative retention policy (default: DEFAULT_RETENTION_POLICY). */
  readonly retention?: RetentionPolicy;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function nowMs(): number {
  return Date.now();
}

function mapRow(r: Record<string, unknown>): SourceTrace {
  return {
    id: String(r.id),
    workspaceId: String(r.workspace_id),
    dataSource: String(r.data_source),
    externalId: (r.external_id as string | null) ?? null,
    contentHash: String(r.content_hash),
    derivedFromTrace: (r.derived_from_trace as string | null) ?? null,
    rawRetentionUntil:
      r.raw_retention_until == null ? null : Number(r.raw_retention_until),
    createdAt: Number(r.created_at),
  };
}

function computeRetention(
  input: RecordSourceTraceInput,
  createdAt: number,
): number | null {
  if (typeof input.rawRetentionUntil === "number") {
    return input.rawRetentionUntil;
  }
  if (input.rawRetentionUntil === null) {
    return null;
  }
  const policy = input.retention ?? DEFAULT_RETENTION_POLICY;
  const days =
    input.derivedFromTrace == null
      ? policy.rawDataDays
      : policy.derivedDataDays;
  if (!Number.isFinite(days) || days <= 0) return null;
  return createdAt + days * MS_PER_DAY;
}

// ---------------------------------------------------------------------------
// recordSourceTrace
// ---------------------------------------------------------------------------

/**
 * Creates a source_traces row. If `derivedFromTrace` is set, the target
 * trace is scope-checked beforehand (must belong to the same workspaceId).
 * On a scope mismatch the edge is DISCARDED (derivedFromTrace = null) —
 * NO throw, fail-soft. Cross-workspace derive chains must go through
 * lib/security/dataflow-policy.ts (its own layer).
 */
export function recordSourceTrace(
  raw: RawDb,
  input: RecordSourceTraceInput,
): SourceTrace {
  if (typeof input.workspaceId !== "string" || input.workspaceId.length === 0) {
    throw new Error("recordSourceTrace: workspaceId required");
  }
  if (typeof input.dataSource !== "string" || input.dataSource.length === 0) {
    throw new Error("recordSourceTrace: dataSource required");
  }
  if (typeof input.contentHash !== "string" || input.contentHash.length === 0) {
    throw new Error("recordSourceTrace: contentHash required");
  }

  let derivedFromTrace: string | null = input.derivedFromTrace ?? null;
  if (derivedFromTrace) {
    const parent = raw
      .prepare(
        `SELECT id FROM source_traces WHERE id = ? AND workspace_id = ? LIMIT 1`,
      )
      .get(derivedFromTrace, input.workspaceId) as { id: string } | undefined;
    if (!parent) {
      derivedFromTrace = null; // Scope mismatch → discard the edge, fail-soft.
    }
  }

  const id = `STR-${ulid()}`;
  const ts = nowMs();
  const retention = computeRetention(
    { ...input, derivedFromTrace },
    ts,
  );

  raw
    .prepare(
      `INSERT INTO source_traces
         (id, workspace_id, data_source, external_id, content_hash,
          derived_from_trace, raw_retention_until, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.workspaceId,
      input.dataSource,
      input.externalId ?? null,
      input.contentHash,
      derivedFromTrace,
      retention,
      ts,
    );

  return {
    id,
    workspaceId: input.workspaceId,
    dataSource: input.dataSource,
    externalId: input.externalId ?? null,
    contentHash: input.contentHash,
    derivedFromTrace,
    rawRetentionUntil: retention,
    createdAt: ts,
  };
}

// ---------------------------------------------------------------------------
// traceLineage — full provenance chain
// ---------------------------------------------------------------------------

/**
 * Returns the FULL provenance chain, starting with the trace found directly
 * under `contentHash`, then its derivedFromTrace, then its
 * parent, and so on, until no parent remains.
 *
 * If multiple traces share the same contentHash (idempotency / re-indexing),
 * the most recent one is chosen as the entry point.
 *
 * Cycle protection: if a trace points via derivedFromTrace to itself or
 * an already-visited ID, the iteration is terminated (should not
 * happen, but fail-soft).
 *
 * Cross-workspace protection: the chain is ALWAYS kept within the same
 * workspaceId — should a parent_trace.workspace_id != entry.workspace_id
 * occur (which recordSourceTrace should already prevent), the
 * chain breaks off.
 */
export function traceLineage(raw: RawDb, contentHash: string): SourceTrace[] {
  if (typeof contentHash !== "string" || contentHash.length === 0) {
    throw new Error("traceLineage: contentHash required");
  }
  const entry = raw
    .prepare(
      `SELECT * FROM source_traces
        WHERE content_hash = ?
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
    )
    .get(contentHash) as Record<string, unknown> | undefined;
  if (!entry) return [];

  const lineage: SourceTrace[] = [];
  const visited = new Set<string>();
  let current: SourceTrace | null = mapRow(entry);
  const wsId = current.workspaceId;

  while (current && !visited.has(current.id)) {
    lineage.push(current);
    visited.add(current.id);
    if (!current.derivedFromTrace) break;
    const next = raw
      .prepare(
        `SELECT * FROM source_traces
          WHERE id = ? AND workspace_id = ?
          LIMIT 1`,
      )
      .get(current.derivedFromTrace, wsId) as Record<string, unknown> | undefined;
    current = next ? mapRow(next) : null;
  }

  return lineage;
}

// ---------------------------------------------------------------------------
// listSourceTraces
// ---------------------------------------------------------------------------

export interface ListSourceTracesOpts {
  readonly dataSource?: string;
  readonly limit?: number;
}

export function listSourceTraces(
  raw: RawDb,
  workspaceId: string,
  opts: ListSourceTracesOpts = {},
): SourceTrace[] {
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("listSourceTraces: workspaceId required");
  }
  const where: string[] = ["workspace_id = ?"];
  const params: unknown[] = [workspaceId];
  if (opts.dataSource) {
    where.push("data_source = ?");
    params.push(opts.dataSource);
  }
  const limit =
    opts.limit && Number.isFinite(opts.limit) && opts.limit > 0
      ? Math.floor(opts.limit)
      : 500;
  params.push(limit);
  const rows = raw
    .prepare(
      `SELECT * FROM source_traces
        WHERE ${where.join(" AND ")}
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    )
    .all(...params) as Record<string, unknown>[];
  return rows.map(mapRow);
}
