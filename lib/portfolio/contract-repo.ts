/**
 * Phase 2 W3 — portfolio spine · contract persistence slice
 * ════════════════════════════════════════════════════════════════════════
 *
 * WHAT THIS MODULE CLOSES (W3 orchestrator finding, verbatim N1)
 * ────────────────────────────────────────────────────────────────
 *   „loadPortfolioRunState rekonstruiert `LaneState.contract` NICHT aus der DB;
 *    die Gates lesen ihn aus dem State, den ein In-Memory-Caller injiziert. Der
 *    Contract-Persistenz-Slice muss `LaneState.contract` aus einer DB-Quelle
 *    zurücklesen, damit die Gates in Produktion über echte Lane-Verträge
 *    entscheiden statt nur über das, was ein In-Memory-Caller injiziert."
 *
 * Until now a lane contract could only exist IN-MEMORY — i.e. a
 * caller set `state.laneStates[id].contract` by hand (as the tests do
 * via the `withGreenContracts` spy). In production that meant: the 6 gates
 * (G1..G6) ALWAYS saw `contract: null` and blocked everything. This slice
 * gives the lane contract a persistent substrate and a reader, so that
 * `loadPortfolioRunState` (spine.ts) reads the real contract back.
 *
 * SUBSTRATE DISCIPLINE (N4 — NO new table)
 * ────────────────────────────────────────────
 * We reuse exactly the trace substrate the orchestrator already uses for
 * stage completions: `workstream_decisions`. A lane contract is written as
 * ONE decision row on the **lane-child workstream**:
 *
 *   workstream_id   = <lane-child-ws-id>   (NOT the parent — the contract
 *                     belongs to exactly ONE lane; the reader joins per lane-child)
 *   decision_kind   = 'route'              (0071 CHECK-constrained; reused as
 *                     with the stage completions — no new kind)
 *   rationale       = 'portfolio-lane-contract: <verbatim-JSON>'  (N1: the
 *                     complete contract JSON, NO .slice/.substring)
 *   evidence_refs   = ["<sentinel>"]       (0071 CHECK: array length >= 1)
 *   content_hash    = sha256(canonical contract JSON)  (N10: same
 *                     contract → same hash → idempotent re-write)
 *   actor           = 'policy'             (machine persistence, no
 *                     user/agent masking — like the stage advance)
 *
 * Why `workstream_decisions` and not `workstream_evidence`?
 *   - The contract IS a decision about the lane („this is what the contract
 *     of this lane looks like"), not a retrieval record. `decision_kind='route'` covers
 *     exactly this „routing/wiring" character and is already the
 *     kind the spine reads its portfolio rows with (consistency).
 *   - `workstream_decisions` is append-only + tamper-evident (trigger in 0071)
 *     → N8/N10 are satisfied with no extra work.
 *   - `workstream_evidence` would mis-frame the contract as a „provenance record"
 *     and waste the auditable „why?" field (rationale).
 *
 * DETERMINISM + FAIL-SOFT (N6)
 * ──────────────────────────────
 * `loadLaneContract` parses purely deterministically (JSON.parse + structural
 * validator) and NEVER throws — on a missing table, missing row,
 * broken JSON or a structurally invalid contract it returns `null`. A
 * `null` is backwards-compatible: the gates treat „no contract" exactly as
 * before this slice (the lane blocks the gate).
 *
 * BACKWARDS COMPATIBILITY with `withGreenContracts`
 * ────────────────────────────────────────────────
 * The test spy `withGreenContracts` overwrites EVERY loaded state AFTER
 * the real reader and sets all contracts to `fullContract()`. Since the spy
 * acts AFTER `loadPortfolioRunState`, it takes precedence over what this slice
 * reads from the DB — existing orchestrator tests stay untouched. With an
 * empty DB (no persisted contract) `contract: null` stays as before.
 *
 * Interface shape: like `loadPortfolioRunState`/`orchestrator.ts`, this
 * module works directly on the raw `better-sqlite3` handle — synchronous,
 * deterministic, in-memory testable (same pattern as the whole spine).
 *
 * As of: 2026-05-29
 */

import { createHash } from 'node:crypto';

import type { Database as Sqlite } from 'better-sqlite3';

import { ulid } from '@/lib/ulid';

import type { LaneContract } from './types';
import { validateLaneContract } from './spine';

// ───────────────────────────────────────────────────────────────────────────
// Constants — the vocabulary that loadLaneContract matches against on read.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Rationale prefix for a persisted lane-contract row. Includes the
 * trailing space. Do NOT change without adjusting the reader (`loadLaneContract`)
 * at the same time — otherwise the reader won't find the contract.
 * Deliberately distinct from the stage-completion prefix
 * (`portfolio-stage-completed: `), so both 'route' decision kinds on the
 * same workstream stay cleanly separable.
 */
export const LANE_CONTRACT_PREFIX = 'portfolio-lane-contract: ';

/** Decision kind we reuse (0071 CHECK). Identical to the spine reader. */
const CONTRACT_DECISION_KIND = 'route';

/** Actor — machine persistence, no user/agent masking (N8). */
const CONTRACT_DECISION_ACTOR = 'policy';

// ───────────────────────────────────────────────────────────────────────────
// Helper functions
// ───────────────────────────────────────────────────────────────────────────

/**
 * Canonical contract JSON. Writes the 12 fields in a FIXED order,
 * so the content_hash is deterministic (two identical contracts → one
 * hash → one row, N10 idempotency). N1: NO .slice/.substring — the full
 * contract is serialized verbatim.
 */
function canonicalContractJson(contract: LaneContract): string {
  // Fixed key order (matches the integration-plan §6 sequence).
  const ordered = {
    inputEvents: contract.inputEvents,
    outputEvents: contract.outputEvents,
    dataSchema: contract.dataSchema,
    permissionRequirements: contract.permissionRequirements,
    confidenceBehavior: contract.confidenceBehavior,
    humanReviewRequirements: contract.humanReviewRequirements,
    errorStates: contract.errorStates,
    auditRequirements: contract.auditRequirements,
    uxSurfaces: contract.uxSurfaces,
    metrics: contract.metrics,
    testFixtures: contract.testFixtures,
    rolloutConstraints: contract.rolloutConstraints,
  };
  return JSON.stringify(ordered);
}

/** SHA-256 over the canonical contract JSON (N10). Always 64 hex characters. */
function contractContentHash(contract: LaneContract): string {
  return createHash('sha256')
    .update(canonicalContractJson(contract))
    .digest('hex');
}

/**
 * Pure, structural parser for a persisted contract rationale.
 * Deterministic (N6), never throws — on any error `null`.
 *
 * Accepts only when:
 *   1. the rationale begins with `LANE_CONTRACT_PREFIX`,
 *   2. the rest is valid JSON,
 *   3. the parsed object is `validateLaneContract`-valid (all 12 fields).
 *
 * Step 3 is deliberately strict: a structurally incomplete contract in the
 * DB must NOT slip through as a „real contract" and wrongly
 * green-light a gate. Incomplete → `null` → the gate blocks (safe, fail-closed
 * in the sense of the gate discipline).
 */
export function parseLaneContractRationale(
  rationale: unknown,
): LaneContract | null {
  if (typeof rationale !== 'string') return null;
  if (!rationale.startsWith(LANE_CONTRACT_PREFIX)) return null;

  // N1: the FULL remainder after the prefix is the contract JSON — no .slice
  // on the content, only cutting off the known prefix marker.
  const json = rationale.slice(LANE_CONTRACT_PREFIX.length);

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }

  const candidate = parsed as Record<string, unknown>;
  // Reconstruction into the strict LaneContract form. We take ONLY the 12
  // known fields (no passing through of foreign keys), then we validate.
  const reconstructed: LaneContract = {
    inputEvents: asStringArray(candidate.inputEvents),
    outputEvents: asStringArray(candidate.outputEvents),
    dataSchema: asStringArray(candidate.dataSchema),
    permissionRequirements: asStringArray(candidate.permissionRequirements),
    confidenceBehavior: candidate.confidenceBehavior as LaneContract['confidenceBehavior'],
    humanReviewRequirements:
      candidate.humanReviewRequirements as LaneContract['humanReviewRequirements'],
    errorStates: asStringArray(candidate.errorStates),
    auditRequirements: asStringArray(candidate.auditRequirements),
    uxSurfaces: asStringArray(candidate.uxSurfaces),
    metrics: asStringArray(candidate.metrics),
    testFixtures: asStringArray(candidate.testFixtures),
    rolloutConstraints: asStringArray(candidate.rolloutConstraints),
  };

  const v = validateLaneContract(reconstructed);
  if (!v.valid) return null;
  return reconstructed;
}

/**
 * Helper coercion: returns the array if it is one, otherwise `[]`.
 * (The strictness — only non-empty strings — is handled by `validateLaneContract`.)
 */
function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? (v as string[]) : [];
}

// ───────────────────────────────────────────────────────────────────────────
// persistLaneContract — Writer.
// ───────────────────────────────────────────────────────────────────────────

export interface PersistLaneContractInput {
  /** workstreams.id of the lane-CHILD workstream (role='lane:<id>'). */
  workstreamId: string;
  /** The complete 12-point contract of this lane. */
  contract: LaneContract;
}

export type PersistLaneContractResult =
  | {
      persisted: true;
      /** workstream_decisions.id of the written (or existing) row. */
      decisionId: string;
      /** content_hash of the contract row (N10). */
      contentHash: string;
    }
  | {
      persisted: false;
      /** Verbatim rationale for why it was not persisted (N8-readable). */
      reason: string;
    };

/**
 * Persists the 12-point LaneContract of a lane-child workstream as ONE
 * append-only `workstream_decisions` row (N4 substrate, N8 trace, N10 hash).
 *
 * Flow:
 *   0. The contract MUST be structurally complete (`validateLaneContract`) —
 *      we don't persist a broken contract (otherwise the reader would read it
 *      back as null anyway).
 *   1. Sentinel evidence row (workstream_evidence) for the 0071 CHECK
 *      (evidence_refs >= 1). If the table is missing (reduced schema) →
 *      fail-soft synthetic ref.
 *   2. ONE decision row: decision_kind='route', rationale=PREFIX+verbatim-JSON,
 *      content_hash=sha256(canonical JSON), actor='policy'. INSERT OR IGNORE
 *      → the same contract twice = idempotent (UNIQUE(workstream_id,
 *      content_hash)).
 *
 * Everything in ONE transaction. Never throws — on a DB error `persisted:false`.
 *
 * IMPORTANT: `workstreamId` is the LANE-CHILD, not the parent. The reader
 * (`loadLaneContract`) joins per lane-child — a contract belongs to exactly one
 * lane.
 */
export function persistLaneContract(
  db: Sqlite,
  input: PersistLaneContractInput,
): PersistLaneContractResult {
  const { workstreamId, contract } = input;

  if (typeof workstreamId !== 'string' || workstreamId.length === 0) {
    return { persisted: false, reason: 'persistLaneContract: workstreamId required' };
  }

  const validation = validateLaneContract(contract);
  if (!validation.valid) {
    return {
      persisted: false,
      reason: `persistLaneContract: contract invalid — ${validation.issues.join('; ')}`,
    };
  }

  const json = canonicalContractJson(contract);
  const rationale = `${LANE_CONTRACT_PREFIX}${json}`;
  const contentHash = contractContentHash(contract);

  try {
    const decisionId = db.transaction(() => {
      // (1) Sentinel evidence (0071 CHECK: evidence_refs >= 1). N8 provenance.
      const evId = `ev_${ulid()}`;
      const evSourceRef = `lane-contract:${workstreamId}`;
      const evHash = createHash('sha256')
        .update(
          JSON.stringify({
            workstream_id: workstreamId,
            source_ref: evSourceRef,
            source_kind: 'spawn',
            content_hash: contentHash,
          }),
        )
        .digest('hex');
      let evidenceId = evId;
      try {
        db.prepare(
          `INSERT OR IGNORE INTO workstream_evidence
             (id, workstream_id, source_ref, source_kind, content_hash, allowed, bridge_id, created_at)
           VALUES (?, ?, ?, 'spawn', ?, 1, NULL, unixepoch())`,
        ).run(evId, workstreamId, evSourceRef, evHash);
        const existingEv = db
          .prepare(
            `SELECT id FROM workstream_evidence
              WHERE workstream_id = ? AND source_ref = ? AND content_hash = ?
              LIMIT 1`,
          )
          .get(workstreamId, evSourceRef, evHash) as { id: string } | undefined;
        evidenceId = existingEv?.id ?? evId;
      } catch (evErr) {
        // workstream_evidence missing (reduced schema) → synthetic ref.
        console.warn(
          '[portfolio/contract-repo] evidence write skipped (table missing?), using synthetic ref:',
          evErr instanceof Error ? evErr.message : String(evErr),
        );
        evidenceId = `synthetic:${evHash}`;
      }

      // (2) Contract decision (append-only, idempotent via UNIQUE content_hash).
      const decId = `dec_${ulid()}`;
      const evidenceRefsJson = JSON.stringify([evidenceId]);
      db.prepare(
        `INSERT OR IGNORE INTO workstream_decisions
           (id, workstream_id, decision_kind, rationale, evidence_refs,
            content_hash, actor, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())`,
      ).run(
        decId,
        workstreamId,
        CONTRACT_DECISION_KIND,
        rationale,
        evidenceRefsJson,
        contentHash,
        CONTRACT_DECISION_ACTOR,
      );

      const existingDec = db
        .prepare(
          `SELECT id FROM workstream_decisions
            WHERE workstream_id = ? AND content_hash = ?
            LIMIT 1`,
        )
        .get(workstreamId, contentHash) as { id: string } | undefined;

      return existingDec?.id ?? decId;
    })();

    return { persisted: true, decisionId, contentHash };
  } catch (err) {
    console.warn(
      '[portfolio/contract-repo] persistLaneContract failed (non-fatal):',
      err instanceof Error ? err.message : String(err),
    );
    return {
      persisted: false,
      reason: `persistLaneContract: write failed — ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}

// ───────────────────────────────────────────────────────────────────────────
// loadLaneContract — Reader.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Reads the persisted 12-point LaneContract of a lane-child workstream
 * back from the DB. Deterministic (N6), fail-soft → `null`.
 *
 * The NEWEST valid contract row wins (ORDER BY created_at DESC, id
 * DESC) — so a lane can extend its contract append-only and the
 * reader always returns the most recent one. Append-only (N8): old versions
 * stay preserved as trace.
 *
 * Returns `null` when:
 *   - workstreamId empty/invalid,
 *   - the table is missing (reduced schema),
 *   - no contract row exists,
 *   - none of the rows contain a structurally complete contract JSON.
 *
 * `null` is backwards-compatible: the gates treat „no contract" exactly as
 * it was BEFORE this slice.
 */
export function loadLaneContract(
  db: Sqlite,
  workstreamId: string,
): LaneContract | null {
  if (typeof workstreamId !== 'string' || workstreamId.length === 0) {
    return null;
  }

  let rows: Array<{ rationale: string }>;
  try {
    rows = db
      .prepare(
        `SELECT rationale FROM workstream_decisions
          WHERE workstream_id = ?
            AND decision_kind = '${CONTRACT_DECISION_KIND}'
          ORDER BY created_at DESC, id DESC`,
      )
      .all(workstreamId) as Array<{ rationale: string }>;
  } catch {
    // Table missing or similar → fail-soft.
    return null;
  }

  // The newest row that parses as a valid contract wins. We walk the
  // list deterministically (DESC) and take the first hit — other
  // 'route' rows (e.g. stage completions on the parent) don't match the prefix
  // and are skipped.
  for (const row of rows) {
    const contract = parseLaneContractRationale(row.rationale);
    if (contract) return contract;
  }
  return null;
}
