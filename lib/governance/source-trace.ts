/**
 * G3 — Source-Trace / Raw-vs-Derived-Policy
 * (Phase 2 W2.1 · Lane G Governance · 2026-05-29).
 *
 * Integration-Plan §4 Lane G (verbatim, N1):
 *   „Raw vs Derived Data Policy · Source Trace Rules"
 *
 * Jede aus einer Datenquelle abgeleitete Einheit (chunk, belief, message)
 * trägt eine source_traces-Row, die per derived_from_trace auf ihren Ursprung
 * zeigt. So lässt sich rückwärts die ganze Provenance-Kette rekonstruieren
 * („Wo kommt dieser belief her? → derived von welchem chunk? → der war eine
 * Zusammenfassung welcher whatsapp-message?").
 *
 * Mechanik:
 *   - Pure DB-Read/Write, kein LLM, keine Netz-I/O.
 *   - N1:  externalId / content_hash verbatim.
 *   - N9:  workspaceId-scoped.
 *   - N10: content_hash je Row.
 *
 * Retention-Policy (Default-Werte aus lib/governance/retention.ts):
 *   - rawDataDays:     30   — Raw-Inhalte werden nach 30 Tagen gelöscht
 *                             (raw_retention_until = createdAt + 30d)
 *   - derivedDataDays: 365  — Derived-Daten bleiben 365 Tage erhalten
 *                             (raw_retention_until = createdAt + 365d wenn
 *                              derivedFromTrace gesetzt ist)
 *
 * Public API:
 *   recordSourceTrace(raw, input)  — legt eine source_traces-Row an
 *   traceLineage(raw, contentHash) — gibt die VOLLE Herkunfts-Kette zurück
 *   listSourceTraces(raw, opts)    — Liste pro Workspace, neueste zuerst
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
   * Wenn gegeben, überschreibt die default-Retention. Sonst wird sie aus
   * der RetentionPolicy abgeleitet (rawData vs derivedData).
   */
  readonly rawRetentionUntil?: number | null;
  /** Optional: alternative Retention-Policy (default: DEFAULT_RETENTION_POLICY). */
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
 * Legt eine source_traces-Row an. Wenn `derivedFromTrace` gesetzt ist, wird
 * der Ziel-Trace zuvor scope-geprüft (muss demselben workspaceId angehören).
 * Bei Scope-Mismatch wird die Kante VERWORFEN (derivedFromTrace = null) —
 * KEIN Wurf, fail-soft. Cross-Workspace-Derive-Ketten sind durch
 * lib/security/dataflow-policy.ts (eigene Schicht) zu gehen.
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
      derivedFromTrace = null; // Scope-Mismatch → Kante verwerfen, fail-soft.
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
// traceLineage — volle Herkunfts-Kette
// ---------------------------------------------------------------------------

/**
 * Gibt die VOLLE Provenance-Kette zurück, beginnend mit dem direkt unter
 * `contentHash` gefundenen Trace, dann dessen derivedFromTrace, dann dessen
 * Parent, usw., bis kein Parent mehr existiert.
 *
 * Falls mehrere Traces denselben contentHash haben (Idempotenz / Re-Indexing),
 * wird der jüngste als Einstieg gewählt.
 *
 * Zyklus-Schutz: wenn ein Trace per derivedFromTrace auf sich selbst oder
 * eine bereits besuchte ID zeigt, wird die Iteration beendet (sollte nicht
 * passieren, aber fail-soft).
 *
 * Cross-Workspace-Schutz: die Kette wird IMMER innerhalb desselben
 * workspaceId gehalten — sollte ein parent_trace.workspace_id != entry.workspace_id
 * sein (sollte durch recordSourceTrace bereits verhindert werden), bricht
 * die Kette ab.
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
