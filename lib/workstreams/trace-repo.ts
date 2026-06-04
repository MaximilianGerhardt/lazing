/**
 * N8 trace writes — workstream_decisions + workstream_evidence (slice B).
 *
 * Writes decisions and evidence verbatim (N1) into the append-only tables
 * `workstream_decisions` (migration 0071) and `workstream_evidence` (0069).
 *
 * Design principles:
 *   - N1:  rationale / decision text / snippet are passed VERBATIM —
 *          no .slice(), no truncation here. The caller is responsible for
 *          a sensible length.
 *   - N8:  Every decision + evidence writes a "why did we decide
 *          this?" row. An additive trace layer — no deletion, no update.
 *   - N10: Every row carries `content_hash` (sha256 over canonical JSON) for
 *          tamper-evidence. Same hash = idempotent (the UNIQUE index kicks in).
 *   - Best-effort: all public functions do NOT throw. Errors are
 *          logged — the trace is additive, not blocking.
 *
 * Table columns (exact real columns, verified against migrations 0069/0071):
 *
 *   workstream_evidence
 *     id TEXT PK, workstream_id TEXT, source_ref TEXT, source_kind TEXT,
 *     content_hash TEXT (64 hex), allowed INTEGER DEFAULT 1,
 *     bridge_id TEXT nullable, created_at INTEGER (unixepoch)
 *     CHECK source_kind IN ('rag_chunk','tool_output','user','spawn')
 *
 *   workstream_decisions
 *     id TEXT PK, workstream_id TEXT, decision_kind TEXT, rationale TEXT,
 *     evidence_refs TEXT (JSON array ≥1), content_hash TEXT (64 hex),
 *     created_at INTEGER (unixepoch), actor TEXT,
 *     recovered_at INTEGER nullable
 *     CHECK decision_kind IN ('route','pause','inject','bridge','override',
 *       'rag_retrieval_fail_closed','rag_retrieval_cross_ws_denied',
 *       'rag_retrieval_misuse','rag_retrieval_denial_write_fail',
 *       'orphan_detected','fail_closed_recovery','pos7_relaxation_override')
 *     CHECK actor IN ('user','agent','policy')
 *     CHECK evidence_refs JSON array length >= 1
 */

import { createHash } from 'node:crypto';
import { getDb } from '@/db/client';
import { ulid } from '@/lib/ulid';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Allowed source kinds for workstream_evidence (from Migration 0069 CHECK). */
export type EvidenceSourceKind = 'rag_chunk' | 'tool_output' | 'user' | 'spawn';

/**
 * Allowed decision kinds for workstream_decisions (from Migration 0071 CHECK).
 * 'route' is the generic catch-all for plan dispatch / intent routing.
 */
export type DecisionKind =
  | 'route'
  | 'pause'
  | 'inject'
  | 'bridge'
  | 'override'
  | 'rag_retrieval_fail_closed'
  | 'rag_retrieval_cross_ws_denied'
  | 'rag_retrieval_misuse'
  | 'rag_retrieval_denial_write_fail'
  | 'orphan_detected'
  | 'fail_closed_recovery'
  | 'pos7_relaxation_override';

/** Allowed actor values (from Migration 0071 CHECK). */
export type DecisionActor = 'user' | 'agent' | 'policy';

export interface WriteEvidenceInput {
  /** Workspace this evidence belongs to (for coordKey context). */
  workspaceId: string;
  /** Workstream this evidence belongs to — mandatory FK. */
  workstreamId: string;
  /**
   * Free key reference — e.g. `<sourceType>:<sourceId>` or
   * a RAG chunk ID. Lands as `source_ref` (NOT NULL).
   */
  coordKey?: string;
  /** Machine type of the source. Maps directly onto the `source_kind` CHECK enum. */
  sourceKind: EvidenceSourceKind;
  /** Optionally the ID of the concrete source (e.g. rag_chunk.id, tool_call_id). */
  sourceId?: string;
  /**
   * Verbatim snippet (N1) — may be long, no .slice() here.
   * Included in the content_hash.
   */
  snippet: string;
  /** Actor that produces the evidence ('user'|'agent'|'policy'). */
  actor?: DecisionActor;
}

export interface WriteDecisionInput {
  /** Workspace (for coordKey context). */
  workspaceId: string;
  /** Workstream — mandatory FK. */
  workstreamId: string;
  /** Free coordinate label (e.g. `<workspaceId>/<workstreamId>`). */
  coordKey?: string;
  /** Kind of decision. */
  decisionKind: DecisionKind;
  /**
   * Verbatim decision text (N1).
   * Persisted as the `rationale` column.
   */
  rationale: string;
  /** Actor that makes the decision. */
  actor?: DecisionActor;
  /**
   * Optional previously-written evidence IDs to reference.
   * If empty/undefined: a sentinel evidence row is written
   * automatically (constraint: evidence_refs JSON array length >= 1).
   */
  evidenceIds?: string[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * SHA-256 over a canonical JSON object (N10 tamper-evidence).
 * Always yields 64 hex characters.
 */
function sha256hex(payload: Record<string, unknown>): string {
  return createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex');
}

// ---------------------------------------------------------------------------
// writeEvidence
// ---------------------------------------------------------------------------

/**
 * Writes an evidence row into `workstream_evidence`. Best-effort: does not throw.
 *
 * Returns the ID of the written row — or `null` on error.
 * Idempotency: UNIQUE(workstream_id, source_ref, content_hash) — the same
 * content writes no second row (ON CONFLICT IGNORE).
 */
export function writeEvidence(input: WriteEvidenceInput): string | null {
  try {
    const db = getDb();
    const id = `ev_${ulid()}`;
    const sourceRef = input.sourceId
      ? `${input.sourceKind}:${input.sourceId}`
      : `${input.sourceKind}:${input.coordKey ?? input.workspaceId}`;

    // N10: content_hash over the canonical payload JSON
    const contentHash = sha256hex({
      workstream_id: input.workstreamId,
      source_ref: sourceRef,
      source_kind: input.sourceKind,
      snippet: input.snippet,
    });

    db.$raw
      .prepare(
        `INSERT OR IGNORE INTO workstream_evidence
           (id, workstream_id, source_ref, source_kind, content_hash, allowed, bridge_id, created_at)
         VALUES (?, ?, ?, ?, ?, 1, NULL, unixepoch())`,
      )
      .run(id, input.workstreamId, sourceRef, input.sourceKind, contentHash);

    // On IGNORE (duplicate), determine the existing ID via content_hash
    // so the caller gets the correct ID to reference.
    const existing = db.$raw
      .prepare(
        `SELECT id FROM workstream_evidence
          WHERE workstream_id = ? AND source_ref = ? AND content_hash = ?
          LIMIT 1`,
      )
      .get(input.workstreamId, sourceRef, contentHash) as { id: string } | undefined;

    return existing?.id ?? id;
  } catch (err) {
    console.warn('[trace-repo] writeEvidence failed (non-fatal):', err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// writeDecision
// ---------------------------------------------------------------------------

/**
 * Writes a decision row into `workstream_decisions`. Best-effort: does not throw.
 *
 * Constraint: `evidence_refs` must be a JSON array with ≥1 entries.
 * If `input.evidenceIds` is empty/undefined, a
 * sentinel evidence row (source_kind='agent', snippet=rationale) is written
 * automatically, whose ID lands in evidence_refs.
 *
 * Idempotency: UNIQUE(workstream_id, content_hash) — the same decision
 * is not written twice.
 *
 * Returns the ID of the written/existing row — or `null` on error.
 */
export function writeDecision(input: WriteDecisionInput): string | null {
  try {
    const db = getDb();
    const actor: DecisionActor = input.actor ?? 'agent';

    // Ensure evidence_refs has ≥1 element (DB CHECK).
    let evidenceIds: string[] = input.evidenceIds?.filter(Boolean) ?? [];
    if (evidenceIds.length === 0) {
      // Sentinel: write an evidence row with the rationale text as the snippet.
      const sentinelId = writeEvidence({
        workspaceId: input.workspaceId,
        workstreamId: input.workstreamId,
        coordKey: input.coordKey,
        sourceKind: 'spawn', // 'spawn' = agent-generated; fits policy/plan decisions
        snippet: input.rationale,
        actor,
      });
      if (!sentinelId) {
        // The sentinel write failed — a decision without evidence is not
        // possible (DB CHECK). Stay silent (best-effort).
        console.warn(
          '[trace-repo] writeDecision: sentinel evidence write failed, skipping decision',
          { workstreamId: input.workstreamId, decisionKind: input.decisionKind },
        );
        return null;
      }
      evidenceIds = [sentinelId];
    }

    const id = `dec_${ulid()}`;
    const evidenceRefsJson = JSON.stringify(evidenceIds);

    // N10: content_hash over the canonical payload JSON
    const contentHash = sha256hex({
      workstream_id: input.workstreamId,
      decision_kind: input.decisionKind,
      rationale: input.rationale,
      evidence_refs: evidenceRefsJson,
      actor,
    });

    db.$raw
      .prepare(
        `INSERT OR IGNORE INTO workstream_decisions
           (id, workstream_id, decision_kind, rationale, evidence_refs, content_hash, actor, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())`,
      )
      .run(
        id,
        input.workstreamId,
        input.decisionKind,
        input.rationale,
        evidenceRefsJson,
        contentHash,
        actor,
      );

    // On IGNORE (duplicate), return the existing ID.
    const existing = db.$raw
      .prepare(
        `SELECT id FROM workstream_decisions
          WHERE workstream_id = ? AND content_hash = ?
          LIMIT 1`,
      )
      .get(input.workstreamId, contentHash) as { id: string } | undefined;

    return existing?.id ?? id;
  } catch (err) {
    console.warn('[trace-repo] writeDecision failed (non-fatal):', err);
    return null;
  }
}
