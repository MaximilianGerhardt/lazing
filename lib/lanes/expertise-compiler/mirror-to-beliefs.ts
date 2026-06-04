/**
 * Lane B — Expertise Compiler · Mirror-to-Beliefs (N4-Naht)
 * ════════════════════════════════════════════════════════════════════════
 *
 * Phase 2 W2.2 · 2026-05-29.
 *
 * Master-Briefing §8 (Lane B) + Integration-Plan §4 Lane B Outputs (verbatim, N1):
 *   „Glossary Entries · Principles · If-Then Rules · Exceptions · Tactics ·
 *    Eval Cases · Belief Candidates."
 *
 * ── THE N4 PROBLEM SPACE ────────────────────────────────────────────────────
 *
 * `knowledge_forms.statement/rationale` is structurally identical to
 * `workspace_beliefs.belief/rationale`. A blind text copy would be
 * N4 double-holding („Recovery before reinvention" — the same statement in two
 * stores that can drift apart). This file closes the seam:
 *
 *   1. It uses EXCLUSIVELY `upsertBelief` from
 *      lib/reasoning/beliefs-repo.ts — NO own belief writer (no
 *      second INSERT INTO workspace_beliefs anywhere).
 *   2. It writes the returned `belief.id` back into
 *      `knowledge_forms.source_json.beliefId` (back-FK). This makes
 *      a) the mirroring idempotent (an already-mirrored knowledge_form
 *         does not mirror again), and b) the projection explicit: the
 *         knowledge_form is the source, the belief the derived,
 *         recall-/reconcile-capable projection.
 *   3. Both happen in ONE TX (analogous to N2 discipline: the mirroring and
 *      the back-FK are atomic — either both or neither).
 *
 * ── TOPIC DERIVATION (deterministic, documented) ───────────────────────
 *
 * `recallRelevant` / `reconcile` (lib/reasoning/) find beliefs via
 * `workspace_beliefs.topic` (exact match + LIKE substring, lower-cased). For
 * the mirrored beliefs to be findable, the topic derivation MUST be
 * deterministic + stable. Rule (verbatim):
 *
 *   - glossary:  topic = lower(term)          (the term IS the topic)
 *   - otherwise: topic = lower(domain)         (the domain, e.g. 'pv-planning')
 *   - fallback (neither term nor domain set):
 *                topic = lower(kind)            (the knowledge form itself)
 *
 * All variants are trimmed; whitespace runs are normalized to a single space
 * (so that „PV Planning" and „pv  planning" yield the same topic).
 * NO .slice/.substring — the value is only lower-cased + whitespace-
 * normalized, never truncated (N1).
 *
 * ── DISCIPLINE ──────────────────────────────────────────────────────────────
 *   - N1:  belief/rationale are taken VERBATIM from statement/rationale.
 *   - N4:  upsertBelief is the ONLY belief writer; back-FK instead of a copy.
 *   - N8:  knowledge_forms.source_json UPDATE is allowed (the trigger blocks only
 *          id/kind/term/statement/content_hash) — the mirroring mutates NO
 *          core field.
 *   - N10: content_hash stays untouched (mirroring is annotation).
 *
 * Pure DB module: takes a raw better-sqlite3 handle (analogous to
 * lib/reasoning/beliefs-repo.ts) — no getDb() singleton, in-memory testable.
 * NO LLM, no net I/O.
 */

import { upsertBelief, type Belief } from "@/lib/reasoning/beliefs-repo";

type RawDb = import("better-sqlite3").Database;

// ───────────────────────────────────────────────────────────────────────────
// Topic derivation (exported for tests + the lane contract)
// ───────────────────────────────────────────────────────────────────────────

function normalizeTopic(value: string): string {
  // lower + whitespace runs → one space + trim. NO slice (N1).
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Deterministic topic derivation from kind/term/domain. See the module doc.
 * Throws if none of the three sources yields a non-empty topic — a
 * mirroring without a topic would not be findable by recallRelevant.
 */
export function deriveBeliefTopic(args: {
  kind: string;
  term: string | null;
  domain: string | null;
}): string {
  const { kind, term, domain } = args;
  if (kind === "glossary" && typeof term === "string" && term.trim().length > 0) {
    return normalizeTopic(term);
  }
  if (typeof domain === "string" && domain.trim().length > 0) {
    return normalizeTopic(domain);
  }
  if (typeof kind === "string" && kind.trim().length > 0) {
    return normalizeTopic(kind);
  }
  throw new Error(
    "deriveBeliefTopic: cannot derive a non-empty topic from kind/term/domain",
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Result type
// ───────────────────────────────────────────────────────────────────────────

export interface MirrorResult {
  /** The mirrored (newly created) belief row. */
  readonly belief: Belief;
  /** The derived topic (for recall/reconcile findability). */
  readonly topic: string;
  /** true when the knowledge_form was already mirrored (no-op return of the existing belief projection). */
  readonly alreadyMirrored: boolean;
}

// ───────────────────────────────────────────────────────────────────────────
// mirrorApprovedKnowledgeFormToBelief
// ───────────────────────────────────────────────────────────────────────────

/**
 * Mirrors an APPROVED knowledge_form into workspace_beliefs (0113) and writes
 * the back-FK (belief.id) into knowledge_forms.source_json.beliefId — both in
 * ONE TX.
 *
 * Idempotent: if source_json.beliefId is already set AND the referenced
 * belief row still exists, it is NOT mirrored again (alreadyMirrored=true,
 * existing belief row returned).
 *
 * Fail-fast (throws) when:
 *   - the knowledge_form does not exist,
 *   - its review_state ≠ 'approved' (only approved is mirrored — §8
 *     human-review gate),
 *
 * @param raw              raw better-sqlite3 handle
 * @param knowledgeFormId  id of the knowledge_forms row to mirror
 */
export function mirrorApprovedKnowledgeFormToBelief(
  raw: RawDb,
  knowledgeFormId: string,
): MirrorResult {
  if (typeof knowledgeFormId !== "string" || knowledgeFormId.length === 0) {
    throw new Error(
      "mirrorApprovedKnowledgeFormToBelief: knowledgeFormId required",
    );
  }

  const kf = raw
    .prepare(
      `SELECT id, workspace_id, kind, term, statement, rationale, domain,
              source_json, review_state
         FROM knowledge_forms
        WHERE id = ?
        LIMIT 1`,
    )
    .get(knowledgeFormId) as
    | {
        id: string;
        workspace_id: string;
        kind: string;
        term: string | null;
        statement: string;
        rationale: string | null;
        domain: string | null;
        source_json: string | null;
        review_state: string;
      }
    | undefined;

  if (!kf) {
    throw new Error(
      `mirrorApprovedKnowledgeFormToBelief: knowledge_form '${knowledgeFormId}' not found`,
    );
  }
  if (kf.review_state !== "approved") {
    throw new Error(
      `mirrorApprovedKnowledgeFormToBelief: knowledge_form '${knowledgeFormId}' ` +
        `is '${kf.review_state}', only 'approved' may be mirrored (§8 review gate)`,
    );
  }

  // Parse the existing source_json (defensive — may be null / broken).
  let sourceObj: Record<string, unknown> = {};
  if (typeof kf.source_json === "string" && kf.source_json.length > 0) {
    try {
      const parsed = JSON.parse(kf.source_json);
      if (parsed && typeof parsed === "object") {
        sourceObj = parsed as Record<string, unknown>;
      }
    } catch {
      // broken JSON → we start with an empty envelope and overwrite it
      // below in a controlled way (no data loss on core fields — they live in
      // their own columns).
      sourceObj = {};
    }
  }

  const topic = deriveBeliefTopic({
    kind: kf.kind,
    term: kf.term,
    domain: kf.domain,
  });

  const existingBeliefId =
    typeof sourceObj.beliefId === "string" ? sourceObj.beliefId : null;

  // Idempotency: already mirrored + target belief still exists (in the same WS)?
  if (existingBeliefId) {
    const existing = raw
      .prepare(
        `SELECT id, workspace_id, topic, belief, rationale, source,
                supersedes_id, confidence, content_hash, created_at, updated_at
           FROM workspace_beliefs
          WHERE id = ? AND workspace_id = ?
          LIMIT 1`,
      )
      .get(existingBeliefId, kf.workspace_id) as
      | Record<string, unknown>
      | undefined;
    if (existing) {
      return {
        belief: {
          id: String(existing.id),
          workspaceId: String(existing.workspace_id),
          topic: String(existing.topic),
          belief: String(existing.belief),
          rationale: String(existing.rationale),
          source: existing.source as Belief["source"],
          supersedesId: (existing.supersedes_id as string | null) ?? null,
          confidence:
            existing.confidence == null ? null : Number(existing.confidence),
          contentHash: String(existing.content_hash),
          createdAt: Number(existing.created_at),
          updatedAt: Number(existing.updated_at),
        },
        topic,
        alreadyMirrored: true,
      };
    }
    // The back-FK pointed at a no-longer-existent belief row → mirror anew.
  }

  // ONE TX: upsertBelief (the only belief writer, N4) + back-FK UPDATE.
  const txn = raw.transaction((): Belief => {
    const belief = upsertBelief(raw, {
      workspaceId: kf.workspace_id,
      topic,
      belief: kf.statement, // N1: verbatim
      // workspace_beliefs.rationale is NOT NULL — knowledge_forms.rationale
      // is nullable. Fall back to the statement (verbatim, no slice), so
      // the NOT-NULL discipline is preserved without inventing content.
      rationale:
        typeof kf.rationale === "string" && kf.rationale.length > 0
          ? kf.rationale // N1: verbatim
          : kf.statement, // N1: verbatim fallback
      source: "ai", // derived from the Lane-B compilation
    });

    const nextSourceJson = JSON.stringify({
      ...sourceObj,
      beliefId: belief.id,
    });

    // N8: source_json UPDATE is allowed (the trigger blocks only id/kind/term/
    // statement/content_hash). updated_at may grow along.
    raw
      .prepare(
        `UPDATE knowledge_forms
            SET source_json = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(nextSourceJson, Date.now(), kf.id);

    return belief;
  });

  const belief = txn();

  return { belief, topic, alreadyMirrored: false };
}
