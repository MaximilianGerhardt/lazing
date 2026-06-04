/**
 * N8-Trace-Writes — workstream_decisions + workstream_evidence (Slice-B).
 *
 * Schreibt Entscheidungen und Evidenz verbatim (N1) in die append-only Tabellen
 * `workstream_decisions` (Migration 0071) und `workstream_evidence` (0069).
 *
 * Design-Prinzipien:
 *   - N1:  rationale / decision-Text / snippet werden VERBATIM übergeben —
 *          kein .slice(), kein Kürzen hier. Caller ist verantwortlich für
 *          sinnvolle Länge.
 *   - N8:  Jede Entscheidung + Evidenz schreibt eine „warum haben wir das
 *          entschieden?"-Row. Additive Trace-Schicht — kein Löschen, kein Update.
 *   - N10: Jede Row trägt `content_hash` (sha256 über kanonisches JSON) für
 *          Tamper-Evidenz. Gleicher Hash = idempotent (UNIQUE-Index greift).
 *   - Best-effort: alle öffentlichen Funktionen werfen NICHT. Fehler werden
 *          geloggt — Trace ist additiv, nicht blocking.
 *
 * Tabellen-Spalten (exakte echte Spalten, geprüft gegen Migrations 0069/0071):
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
 * 'route' ist der generische Catch-All für Plan-Dispatch / Intent-Routing.
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
  /** Workspace this evidence belongs to (für coordKey-Kontext). */
  workspaceId: string;
  /** Workstream this evidence belongs to — Pflicht-FK. */
  workstreamId: string;
  /**
   * Freie Schlüsselreferenz — z.B. `<sourceType>:<sourceId>` oder
   * eine RAG-Chunk-ID. Landet als `source_ref` (NOT NULL).
   */
  coordKey?: string;
  /** Maschinentyp der Quelle. Maps direkt auf `source_kind` CHECK-Enum. */
  sourceKind: EvidenceSourceKind;
  /** Ggf. ID der konkreten Quelle (z.B. rag_chunk.id, tool_call_id). */
  sourceId?: string;
  /**
   * Verbatim-Snippet (N1) — darf lang sein, kein .slice() hier.
   * Wird in den content_hash einbezogen.
   */
  snippet: string;
  /** Actor der die Evidenz erzeugt ('user'|'agent'|'policy'). */
  actor?: DecisionActor;
}

export interface WriteDecisionInput {
  /** Workspace (für coordKey-Kontext). */
  workspaceId: string;
  /** Workstream — Pflicht-FK. */
  workstreamId: string;
  /** Freies Koordinaten-Label (z.B. `<workspaceId>/<workstreamId>`). */
  coordKey?: string;
  /** Art der Entscheidung. */
  decisionKind: DecisionKind;
  /**
   * Verbatim-Entscheidungs-Text (N1).
   * Wird als `rationale`-Spalte persistiert.
   */
  rationale: string;
  /** Actor der die Entscheidung trifft. */
  actor?: DecisionActor;
  /**
   * Optionale vorher geschriebene Evidence-IDs zum referenzieren.
   * Wenn leer/undefined: es wird automatisch ein Sentinel-Evidence-Row
   * geschrieben (Constraint: evidence_refs JSON array length >= 1).
   */
  evidenceIds?: string[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * SHA-256 über ein kanonisches JSON-Objekt (N10 Tamper-Evidenz).
 * Ergibt immer 64 hex-Zeichen.
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
 * Schreibt einen Evidenz-Row in `workstream_evidence`. Best-effort: wirft nicht.
 *
 * Gibt die ID der geschriebenen Row zurück — oder `null` bei Fehler.
 * Idempotenz: UNIQUE(workstream_id, source_ref, content_hash) — gleicher
 * Inhalt schreibt keinen zweiten Row (ON CONFLICT IGNORE).
 */
export function writeEvidence(input: WriteEvidenceInput): string | null {
  try {
    const db = getDb();
    const id = `ev_${ulid()}`;
    const sourceRef = input.sourceId
      ? `${input.sourceKind}:${input.sourceId}`
      : `${input.sourceKind}:${input.coordKey ?? input.workspaceId}`;

    // N10: content_hash über kanonisches Payload-JSON
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

    // Bei IGNORE (Duplikat) die existierende ID via content_hash ermitteln
    // damit Caller die korrekte ID zum Referenzieren bekommt.
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
 * Schreibt einen Entscheidungs-Row in `workstream_decisions`. Best-effort: wirft nicht.
 *
 * Constraint: `evidence_refs` muss ein JSON-Array mit ≥1 Einträgen sein.
 * Wenn `input.evidenceIds` leer/undefined ist, wird automatisch ein
 * Sentinel-Evidence-Row (source_kind='agent', snippet=rationale) geschrieben,
 * dessen ID in evidence_refs landet.
 *
 * Idempotenz: UNIQUE(workstream_id, content_hash) — gleiche Entscheidung
 * wird nicht doppelt geschrieben.
 *
 * Gibt die ID der geschriebenen/existierenden Row zurück — oder `null` bei Fehler.
 */
export function writeDecision(input: WriteDecisionInput): string | null {
  try {
    const db = getDb();
    const actor: DecisionActor = input.actor ?? 'agent';

    // Sicherstellen dass evidence_refs ≥1 Element hat (DB CHECK).
    let evidenceIds: string[] = input.evidenceIds?.filter(Boolean) ?? [];
    if (evidenceIds.length === 0) {
      // Sentinel: eine Evidence-Row mit dem Rationale-Text als Snippet schreiben.
      const sentinelId = writeEvidence({
        workspaceId: input.workspaceId,
        workstreamId: input.workstreamId,
        coordKey: input.coordKey,
        sourceKind: 'spawn', // 'spawn' = agent-generiert; passt für policy-/plan-Entscheidungen
        snippet: input.rationale,
        actor,
      });
      if (!sentinelId) {
        // Sentinel-Write schlug fehl — Entscheidung ohne Evidence nicht
        // möglich (DB CHECK). Schweigen (best-effort).
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

    // N10: content_hash über kanonisches Payload-JSON
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

    // Bei IGNORE (Duplikat) existierende ID zurückgeben.
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
