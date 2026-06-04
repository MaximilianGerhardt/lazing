/**
 * A2 — Workspace ReasoningBank (learning store) + post-process outcome linkage.
 * Self-Learning / WHY engine · Stream A · 2026-05-27.
 *
 * Source: GOAL-lazyos-self-learning-why-engine +
 *         docs/plans/2026-05-27_self-learning-and-flow-completion-plan.md.
 *
 * The workspace ReasoningBank is the learning store: per topic per workspace one
 * ACTIVE belief with its WHY (rationale). A new belief
 * does NOT supersede the old one by deletion, but via supersede: the old row
 * is retained and marked as „superseded" (a NEW row references
 * it via supersedes_id). That way the full history stays reconstructable
 * („do not forget", N1 spirit) and listBeliefs only shows the current state.
 *
 * Approach (analogous to lib/flow/templates-repo.ts):
 *   - Takes a RAW better-sqlite3 handle — no getDb() singleton,
 *     directly in-memory testable.
 *   - PURE/IO-light: only DB read/write, NO LLM, NO network I/O.
 *   - N1:  belief / rationale / note are persisted VERBATIM (no .slice).
 *   - N10: every belief row carries content_hash (sha256 over canonical JSON).
 *
 * recallRelevant: starts with topic match (exact + LIKE). Embedding/vector recall
 * is a deliberately documented follow-up (NOT now) — see below.
 */

import { createHash } from "node:crypto";

import { ulid } from "@/lib/ulid";

type RawDb = import("better-sqlite3").Database;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BeliefSource = "user" | "ai";

/** A belief row of the workspace ReasoningBank (1:1 columns from 0113). */
export interface Belief {
  readonly id: string;
  readonly workspaceId: string;
  readonly topic: string;
  /** The belief, VERBATIM (N1). */
  readonly belief: string;
  /** The WHY, VERBATIM (N1). */
  readonly rationale: string;
  readonly source: BeliefSource;
  /** Nullable: which older belief this one superseded. */
  readonly supersedesId: string | null;
  readonly confidence: number | null;
  readonly contentHash: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface UpsertBeliefInput {
  readonly workspaceId: string;
  readonly topic: string;
  /** The belief, VERBATIM (N1). */
  readonly belief: string;
  /** The WHY, VERBATIM (N1). */
  readonly rationale: string;
  readonly source: BeliefSource;
  /**
   * Optional: ID of the belief row to supersede. If set, it is marked as
   * superseded (the new row references it via supersedes_id) — the
   * old row is retained (history). If NOT set, this is a
   * fresh belief without supersession.
   */
  readonly supersedesId?: string | null;
  readonly confidence?: number | null;
}

export type OutcomeKind = "success" | "failure" | "partial" | "unknown";

export interface RecordOutcomeInput {
  readonly workspaceId: string;
  /** At least one of decisionId / workstreamId should be set. */
  readonly decisionId?: string | null;
  readonly workstreamId?: string | null;
  readonly outcome: OutcomeKind;
  /** VERBATIM Detail (N1), optional. */
  readonly note?: string | null;
}

export interface DecisionOutcome {
  readonly id: string;
  readonly workspaceId: string;
  readonly decisionId: string | null;
  readonly workstreamId: string | null;
  readonly outcome: OutcomeKind;
  readonly note: string | null;
  readonly createdAt: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nowMs(): number {
  return Date.now();
}

/** N10: sha256 over canonical JSON → always 64 hex chars. */
function sha256hex(payload: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function mapBeliefRow(r: Record<string, unknown>): Belief {
  return {
    id: String(r.id),
    workspaceId: String(r.workspace_id),
    topic: String(r.topic),
    belief: String(r.belief),
    rationale: String(r.rationale),
    source: r.source as BeliefSource,
    supersedesId: (r.supersedes_id as string | null) ?? null,
    confidence: r.confidence == null ? null : Number(r.confidence),
    contentHash: String(r.content_hash),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

function mapOutcomeRow(r: Record<string, unknown>): DecisionOutcome {
  return {
    id: String(r.id),
    workspaceId: String(r.workspace_id),
    decisionId: (r.decision_id as string | null) ?? null,
    workstreamId: (r.workstream_id as string | null) ?? null,
    outcome: r.outcome as OutcomeKind,
    note: (r.note as string | null) ?? null,
    createdAt: Number(r.created_at),
  };
}

// ---------------------------------------------------------------------------
// upsertBelief
// ---------------------------------------------------------------------------

/**
 * Creates a new belief. If `supersedesId` is set, the
 * referenced older belief is superseded (it is retained; the new row
 * references it via supersedes_id). The „superseded?" property is NOT
 * stored as a column on the old row, but derived: a belief is
 * superseded as soon as any OTHER row references it via supersedes_id
 * (see listBeliefs). That keeps workspace_beliefs a pure append-only insert
 * without updating the historical rows.
 *
 * Returns the newly created belief row.
 */
export function upsertBelief(raw: RawDb, input: UpsertBeliefInput): Belief {
  if (typeof input.workspaceId !== "string" || input.workspaceId.length === 0) {
    throw new Error("upsertBelief: workspaceId required");
  }
  if (typeof input.topic !== "string" || input.topic.length === 0) {
    throw new Error("upsertBelief: topic required");
  }
  if (typeof input.belief !== "string" || input.belief.length === 0) {
    throw new Error("upsertBelief: belief required");
  }
  if (typeof input.rationale !== "string" || input.rationale.length === 0) {
    throw new Error("upsertBelief: rationale required");
  }
  if (input.source !== "user" && input.source !== "ai") {
    throw new Error("upsertBelief: source must be 'user' | 'ai'");
  }

  // If supersedesId is given: validate that the target row exists
  // and belongs to the same workspace (otherwise ignore → null, no cross-scope).
  let supersedesId: string | null = input.supersedesId ?? null;
  if (supersedesId) {
    const target = raw
      .prepare(
        `SELECT id FROM workspace_beliefs WHERE id = ? AND workspace_id = ? LIMIT 1`,
      )
      .get(supersedesId, input.workspaceId) as { id: string } | undefined;
    if (!target) {
      supersedesId = null; // unbekannte/fremde Ziel-ID → keine Ablöse-Kante
    }
  }

  const id = `BLF-${ulid()}`;
  const ts = nowMs();
  const contentHash = sha256hex({
    workspace_id: input.workspaceId,
    topic: input.topic,
    belief: input.belief,
    rationale: input.rationale,
    source: input.source,
    supersedes_id: supersedesId,
  });

  const row: Belief = {
    id,
    workspaceId: input.workspaceId,
    topic: input.topic, // N1: verbatim
    belief: input.belief, // N1: verbatim
    rationale: input.rationale, // N1: verbatim
    source: input.source,
    supersedesId,
    confidence: input.confidence ?? null,
    contentHash,
    createdAt: ts,
    updatedAt: ts,
  };

  raw
    .prepare(
      `INSERT INTO workspace_beliefs
         (id, workspace_id, topic, belief, rationale, source, supersedes_id,
          confidence, content_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      row.workspaceId,
      row.topic,
      row.belief,
      row.rationale,
      row.source,
      row.supersedesId,
      row.confidence,
      row.contentHash,
      row.createdAt,
      row.updatedAt,
    );

  return row;
}

// ---------------------------------------------------------------------------
// listBeliefs — only ACTIVE (non-superseded) beliefs
// ---------------------------------------------------------------------------

/**
 * Lists the ACTIVE beliefs of a workspace — i.e. all beliefs that have been
 * superseded by NO other row via supersedes_id. Newest first.
 */
export function listBeliefs(raw: RawDb, workspaceId: string): Belief[] {
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("listBeliefs: workspaceId required");
  }
  const rows = raw
    .prepare(
      `SELECT b.* FROM workspace_beliefs b
        WHERE b.workspace_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM workspace_beliefs s
             WHERE s.supersedes_id = b.id
          )
        ORDER BY b.created_at DESC, b.id DESC`,
    )
    .all(workspaceId) as Record<string, unknown>[];
  return rows.map(mapBeliefRow);
}

// ---------------------------------------------------------------------------
// beliefHistory — full chain of a topic (active + superseded)
// ---------------------------------------------------------------------------

/**
 * Returns the FULL history of a topic (active + superseded beliefs),
 * newest first. „Do not forget" — superseded beliefs stay visible.
 */
export function beliefHistory(
  raw: RawDb,
  workspaceId: string,
  topic: string,
): Belief[] {
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("beliefHistory: workspaceId required");
  }
  if (typeof topic !== "string" || topic.length === 0) {
    throw new Error("beliefHistory: topic required");
  }
  const rows = raw
    .prepare(
      `SELECT * FROM workspace_beliefs
        WHERE workspace_id = ? AND topic = ?
        ORDER BY created_at DESC, id DESC`,
    )
    .all(workspaceId, topic) as Record<string, unknown>[];
  return rows.map(mapBeliefRow);
}

// ---------------------------------------------------------------------------
// recallRelevant — active beliefs for the topic
// ---------------------------------------------------------------------------

/**
 * Fetches the active (non-superseded) beliefs of a workspace that match a
 * topic. Initial heuristic: exact match OR LIKE (substring, case-
 * insensitive via the SQLite default collation on ASCII).
 *
 * RANKING (P1.3 — Generative-Agents recency·importance·relevance, stays
 * LEXICAL N7): instead of purely chronological (created_at DESC), the result
 * is now sorted by a DETERMINISTIC score combining three signals
 * — analogous to the Generative-Agents memory stream (recency · importance
 * · relevance), but deliberately WITHOUT embedding:
 *
 *   - relevance: topic-match strength. An EXACT match (b.topic = topic) weighs more
 *     than a plain LIKE substring hit.
 *   - importance: confidence (0..1; null → neutral 0.5). A belief
 *     reinforced by success (reinforceBelief) or a high-confidence reflection meta-belief
 *     ranks before a low-confidence one.
 *   - recency: updated_at (fresher = higher), normalized over the observed
 *     [min,max] window of the hits → purely relative, no wall-clock assumption.
 *
 * The tie-break stays deterministic (updated_at DESC, created_at DESC, id DESC),
 * so tests are stable. The return FORM is unchanged (Belief[]) —
 * backwards-compatible; only the order is now weighted, and an
 * optional `limit` cuts after the ranking.
 *
 * FOLLOW-UP (NOT now — deliberately documented): embedding/vector recall as a
 * FOURTH signal (semantic relevance). Once nomic-embed-text embeddings per
 * belief exist (N7: lexical RAG before vector sophistication), the
 * lexical relevance component is augmented with cosine similarity — the same
 * score function, just one additional term. Until then the ranking stays purely
 * lexical/deterministically testable.
 */
export function recallRelevant(
  raw: RawDb,
  workspaceId: string,
  topic: string,
  opts?: { limit?: number },
): Belief[] {
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("recallRelevant: workspaceId required");
  }
  if (typeof topic !== "string" || topic.length === 0) {
    throw new Error("recallRelevant: topic required");
  }
  // LIKE pattern: escape special characters (% _) so a user topic does not act
  // as a wildcard. ESCAPE '\' activates the escape sequence.
  const escaped = topic.replace(/[\\%_]/g, (c) => `\\${c}`);
  const likePattern = `%${escaped}%`;

  const rows = raw
    .prepare(
      `SELECT b.* FROM workspace_beliefs b
        WHERE b.workspace_id = ?
          AND (b.topic = ? OR b.topic LIKE ? ESCAPE '\\')
          AND NOT EXISTS (
            SELECT 1 FROM workspace_beliefs s
             WHERE s.supersedes_id = b.id
          )
        ORDER BY b.updated_at DESC, b.created_at DESC, b.id DESC`,
    )
    .all(workspaceId, topic, likePattern) as Record<string, unknown>[];

  const beliefs = rows.map(mapBeliefRow);
  const ranked = rankBeliefs(beliefs, topic);

  const limit =
    opts?.limit && Number.isFinite(opts.limit) && opts.limit > 0
      ? Math.floor(opts.limit)
      : undefined;
  return limit == null ? ranked : ranked.slice(0, limit);
}

// ---------------------------------------------------------------------------
// P1.3 — deterministischer gewichteter Recall-Score (lexical, N7)
// ---------------------------------------------------------------------------

/** Weights of the three signals. The sum is NOT normalized — only the ratio
 * matters for the sort. relevance dominates (exact > LIKE is the strongest
 * deterministic signal), confidence and recency fine-tune. */
const RECALL_W_RELEVANCE = 1.0;
const RECALL_W_CONFIDENCE = 0.6;
const RECALL_W_RECENCY = 0.4;

/**
 * Pure score/sort function (no DB). Sorts a belief list descending
 * by weighted score = f(relevance, importance/confidence, recency). On
 * exactly equal scores, the deterministic tie-break order applies
 * (updated_at DESC, created_at DESC, id DESC) — stable and testable.
 *
 * recency is normalized RELATIVE to the observed [min,max] window of the passed
 * list: the oldest hit gets 0, the newest 1 (with only one
 * distinct updated_at: neutral 1, since „as fresh as it gets"). This avoids
 * any wall-clock/time-window assumption and keeps the score deterministic.
 */
export function rankBeliefs(beliefs: readonly Belief[], topic: string): Belief[] {
  if (beliefs.length <= 1) return [...beliefs];

  const topicLc = topic.toLowerCase();
  const updatedTimes = beliefs.map((b) => b.updatedAt);
  const minU = Math.min(...updatedTimes);
  const maxU = Math.max(...updatedTimes);
  const span = maxU - minU;

  const score = (b: Belief): number => {
    // relevance: exact-topic-Match = 1.0, sonst LIKE-Treffer = 0.5.
    const relevance = b.topic.toLowerCase() === topicLc ? 1.0 : 0.5;
    // importance: confidence (null → neutral 0.5), geklemmt auf [0,1].
    const conf = b.confidence == null ? 0.5 : b.confidence;
    const importance = Math.max(0, Math.min(1, conf));
    // recency: relativ im Fenster; ohne Span (alle gleich) neutral 1.
    const recency = span === 0 ? 1 : (b.updatedAt - minU) / span;
    return (
      RECALL_W_RELEVANCE * relevance +
      RECALL_W_CONFIDENCE * importance +
      RECALL_W_RECENCY * recency
    );
  };

  return [...beliefs].sort((a, b) => {
    const sb = score(b);
    const sa = score(a);
    if (sb !== sa) return sb - sa;
    // Deterministischer Tie-break.
    if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
    if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
}

// ---------------------------------------------------------------------------
// P1.1 — reinforceBelief (Erfolg verstärkt; Voyager-Reinforcement / EWC++)
// ---------------------------------------------------------------------------

export interface ReinforceBeliefInput {
  readonly workspaceId: string;
  /** ID der zu verstärkenden AKTIVEN Belief-Row. */
  readonly beliefId: string;
  /** Confidence-Zuwachs (positiv). Default 0.1. Ergebnis wird auf [0,1] geklemmt. */
  readonly delta?: number;
  /** VERBATIM Begründung der Verstärkung (N1) — wird der neuen rationale angehängt. */
  readonly rationale: string;
}

/**
 * Verstärkt eine bestehende AKTIVE Überzeugung, wenn ein Run-Outcome sie
 * bestätigt hat (P1.1 — Generative-Agents-importance / Voyager-Reinforcement).
 *
 * Mechanik (EWC++ / „nicht vergessen"): KEIN In-Place-UPDATE der alten Row.
 * Stattdessen wird via upsertBelief(supersedesId) eine NEUE Row mit
 * HÖHERER confidence angelegt, die die alte ablöst — die Historie bleibt voll
 * rekonstruierbar (beliefHistory). belief-Text wird VERBATIM übernommen, die
 * neue rationale = alte rationale + verstärkender Outcome-Kontext (N1, kein
 * .slice). Die confidence steigt um `delta` (Default 0.1), geklemmt auf [0,1];
 * Start-confidence null gilt als neutral 0.5.
 *
 * Gibt die neue (verstärkte) Belief-Row zurück, oder `null`, wenn die beliefId
 * im Workspace nicht (mehr aktiv) existiert — fail-soft, kein Wurf.
 */
export function reinforceBelief(
  raw: RawDb,
  input: ReinforceBeliefInput,
): Belief | null {
  if (typeof input.workspaceId !== "string" || input.workspaceId.length === 0) {
    throw new Error("reinforceBelief: workspaceId required");
  }
  if (typeof input.beliefId !== "string" || input.beliefId.length === 0) {
    throw new Error("reinforceBelief: beliefId required");
  }
  if (typeof input.rationale !== "string" || input.rationale.length === 0) {
    throw new Error("reinforceBelief: rationale required");
  }

  // Die zu verstärkende Row muss aktiv (nicht-abgelöst) + im Workspace sein.
  const target = raw
    .prepare(
      `SELECT b.* FROM workspace_beliefs b
        WHERE b.id = ? AND b.workspace_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM workspace_beliefs s
             WHERE s.supersedes_id = b.id
          )
        LIMIT 1`,
    )
    .get(input.beliefId, input.workspaceId) as
    | Record<string, unknown>
    | undefined;
  if (!target) return null;

  const current = mapBeliefRow(target);
  const delta = Number.isFinite(input.delta) ? (input.delta as number) : 0.1;
  const base = current.confidence == null ? 0.5 : current.confidence;
  const next = Math.max(0, Math.min(1, base + delta));

  return upsertBelief(raw, {
    workspaceId: input.workspaceId,
    topic: current.topic, // N1: verbatim
    belief: current.belief, // N1: belief-Text unverändert übernommen
    rationale:
      `${current.rationale} | Bestätigt (P1.1-Reinforcement, ` +
      `confidence ${base}→${next}): ${input.rationale}`,
    source: "ai",
    supersedesId: current.id,
    confidence: next,
  });
}

// ---------------------------------------------------------------------------
// recordOutcome — Entscheidung/Workstream ↔ Ergebnis (Post-Prozess-Abgleich A5)
// ---------------------------------------------------------------------------

/**
 * Verknüpft eine getroffene Entscheidung (decisionId) und/oder einen ganzen
 * Workstream (workstreamId) additiv mit ihrem Ergebnis. Additiv, weil
 * workstream_decisions append-only ist (0071-Trigger) — das Outcome darf NICHT
 * in-place auf die Decision-Row geschrieben werden.
 *
 * Speist den späteren Post-Prozess-Abgleich (A5): „Hat die Begründung X zum
 * erhofften Ergebnis geführt?" → mögliche Belief-Revision via upsertBelief.
 *
 * Gibt die angelegte Outcome-Row zurück.
 */
export function recordOutcome(
  raw: RawDb,
  input: RecordOutcomeInput,
): DecisionOutcome {
  if (typeof input.workspaceId !== "string" || input.workspaceId.length === 0) {
    throw new Error("recordOutcome: workspaceId required");
  }
  if (!input.decisionId && !input.workstreamId) {
    throw new Error(
      "recordOutcome: at least one of decisionId / workstreamId required",
    );
  }
  const valid: OutcomeKind[] = ["success", "failure", "partial", "unknown"];
  if (!valid.includes(input.outcome)) {
    throw new Error(
      "recordOutcome: outcome must be one of success|failure|partial|unknown",
    );
  }

  const id = `DOUT-${ulid()}`;
  const ts = nowMs();
  const row: DecisionOutcome = {
    id,
    workspaceId: input.workspaceId,
    decisionId: input.decisionId ?? null,
    workstreamId: input.workstreamId ?? null,
    outcome: input.outcome,
    note: input.note ?? null, // N1: verbatim
    createdAt: ts,
  };

  raw
    .prepare(
      `INSERT INTO decision_outcomes
         (id, workspace_id, decision_id, workstream_id, outcome, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      row.workspaceId,
      row.decisionId,
      row.workstreamId,
      row.outcome,
      row.note,
      row.createdAt,
    );

  return row;
}

/**
 * Liest die Outcomes eines Workspace — optional gefiltert auf eine Entscheidung
 * oder einen Workstream. Neueste zuerst. (Lese-Surface für A5.)
 */
export function listOutcomes(
  raw: RawDb,
  opts: {
    workspaceId: string;
    decisionId?: string;
    workstreamId?: string;
    limit?: number;
  },
): DecisionOutcome[] {
  if (typeof opts.workspaceId !== "string" || opts.workspaceId.length === 0) {
    throw new Error("listOutcomes: workspaceId required");
  }
  const where: string[] = ["workspace_id = ?"];
  const params: unknown[] = [opts.workspaceId];
  if (opts.decisionId) {
    where.push("decision_id = ?");
    params.push(opts.decisionId);
  }
  if (opts.workstreamId) {
    where.push("workstream_id = ?");
    params.push(opts.workstreamId);
  }
  const limit =
    opts.limit && Number.isFinite(opts.limit) && opts.limit > 0
      ? Math.floor(opts.limit)
      : 100;
  params.push(limit);

  const rows = raw
    .prepare(
      `SELECT * FROM decision_outcomes
        WHERE ${where.join(" AND ")}
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    )
    .all(...params) as Record<string, unknown>[];
  return rows.map(mapOutcomeRow);
}

// ---------------------------------------------------------------------------
// E2 — additive Lese-Helfer für die periodische Belief-Curation (curate.ts)
// ---------------------------------------------------------------------------

/**
 * E2-ADDITIV (Stream A, 2026-05-27): Lese-Helfer für den belief-curation-Sniper.
 *
 * `listOutcomes` filtert auf EINE decision_id ODER EINEN workstream_id — für die
 * übergreifende ExpeL-Distillation (curateWorkspaceBeliefs) brauchen wir aber den
 * GANZEN Outcome-Pool eines Workspace (alle Runs, alle Decisions), neueste zuerst.
 * Genau das, plus ein höherer Default-Limit (Curation schaut über viele Runs),
 * leistet dieser Helfer. KEIN Eingriff in `listOutcomes` (bestehender Export
 * unverändert) — additiv, deterministisch (stabile ORDER BY).
 *
 * Default-Limit bewusst 1000 (statt 100 bei listOutcomes), damit eine Periode
 * nicht vorzeitig abgeschnitten wird; der Caller kann es überschreiben.
 */
export function listOutcomesByWorkspace(
  raw: RawDb,
  workspaceId: string,
  opts?: { limit?: number },
): DecisionOutcome[] {
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("listOutcomesByWorkspace: workspaceId required");
  }
  const limit =
    opts?.limit && Number.isFinite(opts.limit) && opts.limit > 0
      ? Math.floor(opts.limit)
      : 1000;
  const rows = raw
    .prepare(
      `SELECT * FROM decision_outcomes
        WHERE workspace_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    )
    .all(workspaceId, limit) as Record<string, unknown>[];
  return rows.map(mapOutcomeRow);
}

/**
 * E2-ADDITIV: liefert alle Beliefs eines Workspace (AKTIV + abgelöst), deren
 * belief-Text mit einem gegebenen Marker-Präfix beginnt — z.B. die P0.1-Lehr-
 * Beliefs (`[teach-v1`) ODER die P0.2-Reflexions-Beliefs (`[reflect-v1`) ODER die
 * E2-Curation-Beliefs (`[curate-v1`). Neueste zuerst. KEINE supersede-Filterung
 * (Curation will den vollen Verlauf zählen — analog beliefHistory). Deterministisch.
 *
 * Wir matchen via LIKE auf den Präfix; `prefix` wird gegen LIKE-Sonderzeichen
 * (% _ \) escaped, damit Marker-Klammern/Doppelpunkte nicht als Wildcard wirken.
 */
export function listBeliefsByMarkerPrefix(
  raw: RawDb,
  workspaceId: string,
  prefix: string,
): Belief[] {
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("listBeliefsByMarkerPrefix: workspaceId required");
  }
  if (typeof prefix !== "string" || prefix.length === 0) {
    throw new Error("listBeliefsByMarkerPrefix: prefix required");
  }
  const escaped = prefix.replace(/[\\%_]/g, (c) => `\\${c}`);
  const likePattern = `${escaped}%`;
  const rows = raw
    .prepare(
      `SELECT * FROM workspace_beliefs
        WHERE workspace_id = ?
          AND belief LIKE ? ESCAPE '\\'
        ORDER BY created_at DESC, id DESC`,
    )
    .all(workspaceId, likePattern) as Record<string, unknown>[];
  return rows.map(mapBeliefRow);
}
