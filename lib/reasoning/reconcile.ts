/**
 * A5 + A4 — post-process IS/OUGHT reconciliation + optional WHY follow-up.
 * Self-learning / WHY engine · Stream A · 2026-05-27.
 *
 * Source: GOAL-lazyos-self-learning-why-engine (points 5 + 4) +
 *         docs/plans/2026-05-27_self-learning-and-flow-completion-plan.md (A5/A4).
 *
 * WHY this module (PA-chat finding, verbatim):
 *   The heygen dead-end was ONLY cleaned up as an orphan — NO
 *   learning entry was created. Nobody compared the original vision/expectation (the
 *   run's rationales) against the actual result; the system could
 *   choose the same connector drift again next time. A5 closes
 *   this gap: AFTER workstream completion, a reconciliation step that determines the
 *   overall outcome, records it via recordOutcome and — on drift
 *   between a made decision and an active belief —
 *   writes a JUSTIFIED belief update (upsertBelief with supersedesId →
 *   the old belief remains as history, „do not forget", N1 spirit).
 *
 *   A4 adds the OPTIONAL WHY question: if a decision was made without a clear
 *   rationale OR deviates from an earlier belief, an
 *   open-question is produced in the format the existing
 *   open-questions pill reads (`extractOpenQuestionsFromContent` →
 *   `<surface:open-questions>{json}</surface:open-questions>`). We only EMIT
 *   this question — we NEVER block the run completion.
 *
 * Approach (analogous to lib/reasoning/beliefs-repo.ts + decisions-read.ts):
 *   - Takes a RAW better-sqlite3 handle — no getDb() singleton,
 *     directly in-memory testable. The caller (plan-executor) resolves the handle via
 *     `(await import('@/db/client')).getDb().$raw` (as documented at plan-executor.ts
 *     L461/L943) and calls this fail-soft (try/catch).
 *   - PURE/IO-light: only DB read/write via the A1/A2 repos, NO LLM, NO
 *     network I/O. `buildWhyQuestion` is a PURE function (no DB).
 *   - N1:  rationale / note / belief are passed on VERBATIM (no .slice).
 *   - Idempotent: a run is reconciled only ONCE (marker in outcome.note,
 *     see RECONCILE_MARKER — no migration change needed, N4 additive).
 */

import {
  recordOutcome,
  recallRelevant,
  upsertBelief,
  reinforceBelief,
  listOutcomes,
  beliefHistory,
  type OutcomeKind,
  type Belief,
} from "@/lib/reasoning/beliefs-repo";
import { listDecisions, type DecisionRow } from "@/lib/reasoning/decisions-read";

type RawDb = import("better-sqlite3").Database;

// ---------------------------------------------------------------------------
// Idempotency marker
// ---------------------------------------------------------------------------

/**
 * Deterministic marker embedded in the note text of the workstream outcome row.
 * `decision_outcomes` (0113) has no own unique/hash
 * column; the marker still makes the workstream reconcile idempotent without
 * a schema change (N4). reconcileWorkstream checks via listOutcomes(workstreamId)
 * whether a row with this marker already exists → a second call is a no-op.
 */
export const RECONCILE_MARKER_PREFIX = "[reconcile-v1";

function reconcileMarker(workstreamId: string): string {
  return `${RECONCILE_MARKER_PREFIX}:${workstreamId}]`;
}

// ---------------------------------------------------------------------------
// Outcome determination
// ---------------------------------------------------------------------------

/**
 * Derives the overall outcome of a run from the final step statuses:
 *   - all done                          → 'success'
 *   - all failed                        → 'failure'
 *   - at least one done AND at least one failed (or mixed with non-terminal)
 *                                       → 'partial'
 *   - no steps / only unknown statuses  → 'unknown'
 *
 * Non-terminal statuses (pending/active) should no longer occur at the reconcile
 * point (the executor marks blocked steps as failed beforehand); if they do,
 * they count as „not successful" → pushing success toward partial.
 */
export function determineOutcome(
  stepStatuses: Record<string, string>,
): OutcomeKind {
  const values = Object.values(stepStatuses);
  if (values.length === 0) return "unknown";

  let done = 0;
  let failed = 0;
  let other = 0;
  for (const v of values) {
    if (v === "done") done += 1;
    else if (v === "failed") failed += 1;
    else other += 1; // pending/active/unknown
  }

  if (done === values.length) return "success";
  if (failed === values.length) return "failure";
  if (done === 0 && failed === 0) return "unknown";
  // Mixed: something worked, something did not.
  return "partial";
}

// ---------------------------------------------------------------------------
// Drift detection decision ↔ belief
// ---------------------------------------------------------------------------

/**
 * A single detected drift: a made decision deviates from an
 * active belief of the same workspace for the same topic.
 */
export interface BeliefDrift {
  readonly topic: string;
  readonly decision: DecisionRow;
  /** The active belief to supersede (whose WHY now appears outdated). */
  readonly priorBelief: Belief;
}

/**
 * Pure topic heuristic: the decision_kind is the topic key under which
 * beliefs for this kind of decision live in the ReasoningBank. (Initial
 * heuristic analogous to recallRelevant — deliberately lexical/deterministic, N6/N7.
 * Embedding-based topic matching is the documented follow-up in
 * beliefs-repo.ts.)
 */
function topicForDecision(d: DecisionRow): string {
  return d.decisionKind;
}

/**
 * Heuristic „decision deviates from belief": the decision's rationale
 * does NOT contain the belief text as a substring (case-insensitive). This is a
 * deliberately CONSERVATIVE, deterministic approximation — it detects the clear
 * case „the run did something other than what the active belief says" and
 * avoids LLM dependence on the fail-soft completion path. Refinement
 * (semantic comparison) is a follow-up.
 */
function decisionContradictsBelief(d: DecisionRow, b: Belief): boolean {
  const rationale = d.rationale.toLowerCase();
  const belief = b.belief.trim().toLowerCase();
  if (belief.length === 0) return false;
  return !rationale.includes(belief);
}

/**
 * Finds all drifts between a run's decisions and the active beliefs
 * of the same workspace. One drift per (decision × matching active belief) when
 * `decisionContradictsBelief`. Pure-read (recallRelevant + listDecisions are
 * read-only).
 */
export function detectBeliefDrift(
  raw: RawDb,
  workspaceId: string,
  decisions: readonly DecisionRow[],
): BeliefDrift[] {
  const drifts: BeliefDrift[] = [];
  for (const d of decisions) {
    const topic = topicForDecision(d);
    const beliefs = recallRelevant(raw, workspaceId, topic);
    for (const b of beliefs) {
      if (decisionContradictsBelief(d, b)) {
        drifts.push({ topic, decision: d, priorBelief: b });
      }
    }
  }
  return drifts;
}

// ---------------------------------------------------------------------------
// P0.1 — outcome-driven learning (ReasoningBank core idea)
// ---------------------------------------------------------------------------

/**
 * Deterministic marker prefix in the belief text of a P0.1 teach belief. Makes
 * teach beliefs (a) idempotently identifiable per run and (b) deterministically
 * groupable for P0.2 WITHOUT a schema change — beliefHistory(topic) filters on this prefix.
 *
 * Format:  `[teach-v1:<workstreamId>:<outcome>]`
 * The workstreamId part guarantees: the same run writes EXACTLY one
 * teach belief per (topic) (idempotency, RECONCILE_MARKER spirit at the belief level).
 */
export const TEACH_MARKER_PREFIX = "[teach-v1";

function teachMarker(workstreamId: string, outcome: OutcomeKind): string {
  return `${TEACH_MARKER_PREFIX}:${workstreamId}:${outcome}]`;
}

/** Detects a P0.1 teach belief by its marker prefix (for P0.2 grouping). */
function isTeachBelief(b: Belief): boolean {
  return b.belief.startsWith(TEACH_MARKER_PREFIX);
}

/**
 * Derives the topics under which teach beliefs should be created for this
 * run — deterministically from the failure-relevant decisions. Heuristic
 * (N6, lexical, NO schema change): per decision the topic = decisionKind
 * (the same key as drift detection + recallRelevant). Returns ONE entry
 * per distinct topic, with the VERBATIM joined rationales +
 * step-reason context for exactly this topic.
 *
 * If the run has NO decisions (e.g. a pure step error without a decision row —
 * the PA-chat heygen case, where only a connector step failed), the
 * topic falls back to a synthetic step-based key so that learning still
 * happens: `step:<sorted-failed-step-keys>`.
 */
interface TeachTopic {
  readonly topic: string;
  /** VERBATIM joined rationales (N1, no .slice). */
  readonly rationale: string;
  /** Human-readable short label of the failed approach (topic). */
  readonly subject: string;
}

function deriveTeachTopics(
  decisions: readonly DecisionRow[],
  stepStatuses: Record<string, string>,
): TeachTopic[] {
  const failedSteps = Object.entries(stepStatuses)
    .filter(([, v]) => v === "failed")
    .map(([k]) => k)
    .sort();
  const stepReason =
    failedSteps.length > 0
      ? `Gescheiterte Steps: ${failedSteps.join(", ")}.`
      : "Kein einzelner failed-Step markiert.";

  if (decisions.length === 0) {
    // No decision row — learn from the step statuses anyway (heygen case).
    const topic =
      failedSteps.length > 0 ? `step:${failedSteps.join("+")}` : "run";
    return [
      {
        topic,
        subject: topic,
        rationale: stepReason,
      },
    ];
  }

  // Join the rationales VERBATIM per distinct decisionKind.
  const byTopic = new Map<string, string[]>();
  for (const d of decisions) {
    const topic = topicForDecision(d);
    const arr = byTopic.get(topic) ?? [];
    // Include empty rationales too (a marker instead of a verbatim gap) — N1: do not truncate.
    arr.push(
      d.rationale.trim().length === 0
        ? `(Decision ${d.id}: ohne Begründung)`
        : `Decision ${d.id} (verbatim): ${d.rationale}`,
    );
    byTopic.set(topic, arr);
  }

  const out: TeachTopic[] = [];
  for (const [topic, rationales] of byTopic) {
    out.push({
      topic,
      subject: topic,
      rationale: `${rationales.join(" || ")} || ${stepReason}`,
    });
  }
  return out;
}

/**
 * P0.1 — on outcome 'failure'|'partial', writes a GENERALIZED
 * teach belief per affected topic, EVEN when no pre-existing belief
 * exists (the key difference from the drift branch: detectBeliefDrift
 * needs a prior belief; P0.1 does not). This closes the PA-chat gap: a
 * run that sees a connector/step fail for the first time now produces a
 * learning entry instead of NULL.
 *
 * Idempotent per run: the teachMarker(workstreamId, outcome) in the belief text
 * prevents double writes on re-trigger — if a teach belief with
 * exactly this marker already exists for the topic, it is skipped. source='ai'.
 *
 * Returns the number of NEWLY written teach beliefs (for ReconcileResult).
 * Fail-soft at the caller; no own try/catch here (deterministic).
 */
function learnFromOutcome(
  raw: RawDb,
  workspaceId: string,
  workstreamId: string,
  outcome: OutcomeKind,
  decisions: readonly DecisionRow[],
  stepStatuses: Record<string, string>,
): number {
  if (outcome !== "failure" && outcome !== "partial") return 0;

  const marker = teachMarker(workstreamId, outcome);
  const topics = deriveTeachTopics(decisions, stepStatuses);
  let written = 0;

  for (const t of topics) {
    // Idempotency: does a teach belief with THIS run marker already exist for
    // (topic)? Then do not write again. beliefHistory returns active+superseded.
    const existing = beliefHistory(raw, workspaceId, t.topic);
    if (existing.some((b) => b.belief.includes(marker))) continue;

    upsertBelief(raw, {
      workspaceId,
      topic: t.topic,
      // belief starts with the marker (P0.2-groupable) + generalized lesson.
      belief:
        `${marker} „${t.subject}" führte zu outcome=${outcome} ` +
        `(Run ${workstreamId}).`,
      // rationale = VERBATIM the failure-related decision rationales + step reason (N1).
      rationale:
        `Outcome-getriebenes Lernen (P0.1, outcome=${outcome}). ` +
        `WARUM (verbatim zusammengefügt): ${t.rationale}`,
      source: "ai",
      // deliberately NO supersedesId: a teach belief supersedes NOTHING — it complements.
      // Start confidence moderate; P0.2 raises it on repetition.
      confidence: outcome === "failure" ? 0.5 : 0.4,
    });
    written += 1;
  }
  return written;
}

// ---------------------------------------------------------------------------
// P0.2 — reflection on REPEATED failures (reflection + ExpeL)
// ---------------------------------------------------------------------------

/**
 * Threshold: from this many similar failure signals for the same topic on, a
 * verbal-self-feedback meta-belief is created (reflection + ExpeL). N6: deterministic.
 */
export const REFLECTION_THRESHOLD = 3;

/** Marker prefix of a meta-reflection belief (so it is not itself counted again as
 * a failure signal and is idempotently recognizable). */
export const REFLECTION_MARKER_PREFIX = "[reflect-v1";

/**
 * P0.2 — counts similar failure signals for a topic (via the
 * P0.1 teach beliefs of the same topic) and, from REFLECTION_THRESHOLD on, writes a
 * verbal-self-feedback meta-belief with HIGH confidence. Model SPIRIT (not
 * the cron): scripts/weekly-reflection-sniper.ts — a reflective question,
 * here phrased as a teaching sentence („After N failed attempts with X: prefer/check …").
 *
 * Grouping (research decision): the clean deterministic source WITHOUT
 * a schema change is the P0.1 teach beliefs (TEACH_MARKER_PREFIX) for the topic —
 * decision_outcomes carries NO topic and no decision_id link in the
 * workstream reconcile, so an outcome→decision→kind join would not be
 * deterministically resolvable. beliefHistory(topic) returns all (active +
 * superseded) teach beliefs of the topic → their count IS the failure counter.
 *
 * Idempotent: if a reflection meta-belief for exactly this
 * threshold state (count encoded in the marker) already exists, it is not written twice.
 * Fail-soft at the caller. Returns true if a meta-belief was written.
 */
export function reflectOnRepeatedFailures(
  raw: RawDb,
  workspaceId: string,
  topic: string,
): boolean {
  if (typeof workspaceId !== "string" || workspaceId.length === 0) return false;
  if (typeof topic !== "string" || topic.length === 0) return false;

  const history = beliefHistory(raw, workspaceId, topic);
  const failureSignals = history.filter(isTeachBelief);
  const count = failureSignals.length;
  if (count < REFLECTION_THRESHOLD) return false;

  // Idempotency: the marker encodes the threshold count → only once per count.
  const marker = `${REFLECTION_MARKER_PREFIX}:${topic}:${count}]`;
  if (history.some((b) => b.belief.includes(marker))) return false;

  // Join the WHYs of the counted failed attempts VERBATIM (N1, no .slice).
  const joinedWhy = failureSignals.map((b) => b.rationale).join(" || ");

  upsertBelief(raw, {
    workspaceId,
    topic,
    belief:
      `${marker} Nach ${count} Fehlversuchen mit „${topic}": Ansatz prüfen — ` +
      `bevorzuge eine verifizierte Alternative ODER kläre die Grundursache, ` +
      `bevor „${topic}" erneut gewählt wird.`,
    rationale:
      `Reflexion (P0.2, ${count} ≥ Schwelle ${REFLECTION_THRESHOLD}). ` +
      `Verbal self-feedback über die gesammelten Fehlversuche (verbatim): ${joinedWhy}`,
    source: "ai",
    confidence: 0.85, // HIGH confidence — meta-lesson from repeated evidence.
  });
  return true;
}

// ---------------------------------------------------------------------------
// A4 — optional WHY question (PURE function, pill-readable format)
// ---------------------------------------------------------------------------

export interface WhyQuestionInput {
  readonly workstreamId: string;
  /** Decisions without a rationale (rationale empty/whitespace). */
  readonly unjustified: readonly DecisionRow[];
  /** Decisions that deviate from an active belief. */
  readonly drifts: readonly BeliefDrift[];
}

/**
 * Detects whether a decision was made „without a clear rationale": empty
 * or pure-whitespace rationale. (Verbatim preservation N1 otherwise — we only read,
 * we truncate nothing.)
 */
export function isUnjustified(d: DecisionRow): boolean {
  return d.rationale.trim().length === 0;
}

/**
 * Builds the optional WHY-question text in the format the existing
 * open-questions pill reads:
 *   `<surface:open-questions>{ "questions": [ { "id", "q" }, ... ] }</surface:open-questions>`
 * (field shape exactly like `parseSurfaceQuestions` in
 * lib/chat/open-questions-lifecycle.ts: `q.q ?? q.text`, `id`+`q` non-empty.)
 *
 * Returns `null` when there is nothing to ask (no decision without a rationale and
 * no deviating decision) — the caller then appends NOTHING to the
 * completion card. PURE: no DB, no side effect. Idempotent, stable IDs
 * (workstreamId-prefixed) so the pill does not pin the same set twice.
 */
export function buildWhyQuestion(input: WhyQuestionInput): string | null {
  const questions: Array<{ id: string; q: string }> = [];

  for (const d of input.unjustified) {
    questions.push({
      id: `why-${input.workstreamId}-unjustified-${d.id}`,
      q:
        `Diese Entscheidung (${d.decisionKind}) wurde ohne erkennbare Begründung getroffen. ` +
        `Warum wurde so entschieden? (Decision ${d.id})`,
    });
  }

  for (const drift of input.drifts) {
    questions.push({
      id: `why-${input.workstreamId}-drift-${drift.decision.id}`,
      q:
        `Diese Entscheidung (${drift.decision.decisionKind}) weicht von der bisherigen ` +
        `Überzeugung ab: „${drift.priorBelief.belief}". ` +
        `Warum diesmal anders? (Decision ${drift.decision.id})`,
    });
  }

  if (questions.length === 0) return null;

  // De-dup by ID (a decision can theoretically be both unjustified AND
  // drift → the first occurrence wins, like collectOpenQuestionsFromHistory).
  const seen = new Set<string>();
  const dedupedById = questions.filter((q) => {
    if (seen.has(q.id)) return false;
    seen.add(q.id);
    return true;
  });

  // 2026-05-29 (Opus 4.8) — owner finding: 5× the SAME drift sentence (only a different
  // decision ID) = noise. Additionally collapse by CORE TEXT (strip the suffix
  // „(Decision …)"): identical reflections → ONE entry, with
  // „(×N Entscheidungen)" when repeated. This keeps the insight visible
  // without repeating the same statement.
  const coreOf = (q: string): string => q.replace(/\s*\(Decision [^)]+\)\s*$/, '').trim();
  const byCore = new Map<string, { core: string; count: number }>();
  for (const q of dedupedById) {
    const core = coreOf(q.q);
    const e = byCore.get(core);
    if (e) e.count += 1;
    else byCore.set(core, { core, count: 1 });
  }
  const deduped = Array.from(byCore.values()).map((e) => ({
    q: e.count > 1 ? `${e.core} (×${e.count} Entscheidungen)` : e.core,
  }));

  // 2026-05-29 (Opus 4.8) — owner finding: these self-reflections of the system
  // (decision deviates from belief / decision without rationale) were output up to here
  // as `<surface:open-questions>` → they landed in the
  // user-visible „Offene Fragen" pill and demanded an ANSWER. That is
  // wrong (R3: prompts only for DECISIONS; R4: evidence ≠ decision): these are
  // NOT decisions the user must make, but internal
  // drift/rationale reflections of the WHY engine. They belong in the
  // counter-evidence channel (E4 Devil's-Advocate, R5: visually separate, no
  // answer obligation) — the actual learning effect (drift beliefs) is written
  // by reconcile into the trace anyway. Here just make them visible.
  const text = deduped.map((q) => `• ${q.q}`).join('\n');
  const json = JSON.stringify({
    text,
    verdict: 'falsifiable',
    counterEvidenceCount: deduped.length,
  });
  return `<surface:counter-evidence>${json}</surface:counter-evidence>`;
}

// ---------------------------------------------------------------------------
// A5 — reconcileWorkstream
// ---------------------------------------------------------------------------

export interface ReconcileArgs {
  readonly workspaceId: string;
  readonly workstreamId: string;
  /** ManifestCoord key (N9), format `<workspaceId>/<workstreamId>`. */
  readonly coordKey: string;
  /** Final step-status map of the run (pending/active/done/failed). */
  readonly stepStatuses: Record<string, string>;
}

export interface ReconcileResult {
  /** Was the run already reconciled before? Then no-op (all fields „empty"). */
  readonly alreadyReconciled: boolean;
  /** The determined overall outcome (also on alreadyReconciled: the fresh verdict). */
  readonly outcome: OutcomeKind;
  /** Number of written belief updates (supersede, drift branch). */
  readonly beliefUpdates: number;
  /** P0.1: number of NEWLY written outcome teach beliefs (failure/partial). */
  readonly outcomeLessons: number;
  /** P0.2: number of written reflection meta-beliefs (≥ threshold). */
  readonly reflections: number;
  /** P1.1: number of beliefs reinforced by success (reinforce/supersede). */
  readonly reinforcements: number;
  /** Detected drifts (decision ↔ belief). */
  readonly drifts: readonly BeliefDrift[];
  /** Decisions without a recognizable rationale. */
  readonly unjustified: readonly DecisionRow[];
  /**
   * Optional WHY-question text in the pill-readable format (or null). The caller
   * appends it to the completion card — it NEVER blocks.
   */
  readonly whyQuestion: string | null;
}

const EMPTY_RESULT = (outcome: OutcomeKind): ReconcileResult => ({
  alreadyReconciled: true,
  outcome,
  beliefUpdates: 0,
  outcomeLessons: 0,
  reflections: 0,
  reinforcements: 0,
  drifts: [],
  unjustified: [],
  whyQuestion: null,
});

/**
 * The post-process IS/OUGHT reconciliation after workstream completion (A5 + A4).
 *
 * Flow:
 *  1. Idempotency guard: if a workstream outcome with the
 *     reconcile marker already exists → no-op (prevents double writes on re-trigger).
 *  2. Determine the overall outcome (determineOutcome) + recordOutcome (workstream-
 *     wide, with a marker in the note for idempotency).
 *  3. Read the run's decisions (listDecisions, coordKey-scoped) → drift against
 *     active beliefs (detectBeliefDrift). Per drift a JUSTIFIED belief
 *     update via upsertBelief(supersedesId) — the old belief stays as history.
 *  4. A4: decisions without a rationale + deviating ones → optional WHY question
 *     (buildWhyQuestion). Only produce, do NOT block.
 *
 * Does NOT throw on „nothing to do" (empty steps → outcome 'unknown', still
 * writes the marker row so the run counts as reconciled). The caller invokes
 * this fail-soft (try/catch) — an error here must NEVER tip over the run completion.
 */
export function reconcileWorkstream(
  raw: RawDb,
  args: ReconcileArgs,
): ReconcileResult {
  if (typeof args.workspaceId !== "string" || args.workspaceId.length === 0) {
    throw new Error("reconcileWorkstream: workspaceId required");
  }
  if (typeof args.workstreamId !== "string" || args.workstreamId.length === 0) {
    throw new Error("reconcileWorkstream: workstreamId required");
  }

  const outcome = determineOutcome(args.stepStatuses);
  const marker = reconcileMarker(args.workstreamId);

  // 1. Idempotency guard — already reconciled?
  const prior = listOutcomes(raw, {
    workspaceId: args.workspaceId,
    workstreamId: args.workstreamId,
  });
  if (prior.some((o) => typeof o.note === "string" && o.note.includes(marker))) {
    return EMPTY_RESULT(outcome);
  }

  // 2. Record the overall outcome (workstream-wide). Marker in the note for idempotency;
  //    then follows the human-readable IS/OUGHT verdict (N1 verbatim detail).
  const doneCount = Object.values(args.stepStatuses).filter(
    (v) => v === "done",
  ).length;
  const totalCount = Object.keys(args.stepStatuses).length;
  recordOutcome(raw, {
    workspaceId: args.workspaceId,
    workstreamId: args.workstreamId,
    outcome,
    note:
      `${marker} IST/SOLL-Abgleich: outcome=${outcome} ` +
      `(${doneCount}/${totalCount} Steps done). ` +
      `Erwartung (SOLL) = die Decision-rationales dieses Runs; ` +
      `Ergebnis (IST) = finale Step-Status.`,
  });

  // 3. Drift decision ↔ active belief → justified belief update.
  const decisions = listDecisions(raw, {
    workspaceId: args.workspaceId,
    coordKey: args.coordKey,
  });
  const drifts = detectBeliefDrift(raw, args.workspaceId, decisions);

  let beliefUpdates = 0;
  for (const drift of drifts) {
    // Justified learning entry: the NEW belief takes over verbatim what
    // the run actually decided; the WHY (rationale) quotes the
    // decision rationale VERBATIM (N1) + the outcome context. supersedesId keeps
    // the old belief as history (never forget).
    upsertBelief(raw, {
      workspaceId: args.workspaceId,
      topic: drift.topic,
      belief:
        `Run ${args.workstreamId} entschied (${drift.decision.decisionKind}) ` +
        `abweichend von „${drift.priorBelief.belief}".`,
      rationale:
        `Post-Prozess-Drift (outcome=${outcome}). ` +
        `Entscheidungs-WARUM (verbatim): ${drift.decision.rationale} ` +
        `| Abgelöste Überzeugung: ${drift.priorBelief.belief} ` +
        `(deren WARUM: ${drift.priorBelief.rationale})`,
      source: "ai",
      supersedesId: drift.priorBelief.id,
    });
    beliefUpdates += 1;
  }

  // 3b. P0.1 — outcome-driven learning (ReasoningBank core idea): on
  //     failure/partial write a GENERALIZED teach belief, EVEN without a
  //     pre-existing belief (closes the PA-chat heygen gap). Deterministic,
  //     idempotent per run (teachMarker in the belief text).
  const outcomeLessons = learnFromOutcome(
    raw,
    args.workspaceId,
    args.workstreamId,
    outcome,
    decisions,
    args.stepStatuses,
  );

  // 3c. P0.2 — reflection on REPEATED failures: for each affected topic, check
  //     whether ≥ threshold similar failure signals are present → meta-reflection
  //     belief with high confidence. Only relevant on failure/partial; on success
  //     nothing is newly counted here. Fail-soft per topic.
  let reflections = 0;
  if (outcome === "failure" || outcome === "partial") {
    const reflectedTopics = new Set<string>();
    for (const t of deriveTeachTopics(decisions, args.stepStatuses)) {
      if (reflectedTopics.has(t.topic)) continue;
      reflectedTopics.add(t.topic);
      try {
        if (reflectOnRepeatedFailures(raw, args.workspaceId, t.topic)) {
          reflections += 1;
        }
      } catch {
        // fail-soft: reflection must never tip over the reconcile.
      }
    }
  }

  // 3d. P1.1 — success reinforces: on outcome 'success', for each decision whose
  //     rationale CONFIRMS an ACTIVE belief (belief text contained as a substring of the
  //     rationale = the opposite of decisionContradictsBelief),
  //     raise its confidence (reinforceBelief → supersede, history stays).
  //     Reinforce per (beliefId) only ONCE, even if multiple decisions match.
  let reinforcements = 0;
  if (outcome === "success") {
    const reinforced = new Set<string>();
    for (const d of decisions) {
      const topic = topicForDecision(d);
      const beliefs = recallRelevant(raw, args.workspaceId, topic);
      for (const b of beliefs) {
        // Confirmation = NON-contradiction + non-empty belief + not yet reinforced
        // + no system-generated teach/reflection meta-belief (those we do not reinforce
        // via decision match — they have no decision reference).
        if (reinforced.has(b.id)) continue;
        if (isTeachBelief(b) || b.belief.startsWith(REFLECTION_MARKER_PREFIX)) {
          continue;
        }
        if (decisionContradictsBelief(d, b)) continue; // contradicts → no reinforce
        try {
          const r = reinforceBelief(raw, {
            workspaceId: args.workspaceId,
            beliefId: b.id,
            rationale:
              `Run ${args.workstreamId} bestätigte (${d.decisionKind}) ` +
              `die Überzeugung. Entscheidungs-WARUM (verbatim): ${d.rationale}`,
          });
          if (r) {
            reinforced.add(b.id);
            reinforcements += 1;
          }
        } catch {
          // fail-soft: reinforcement must never tip over the reconcile.
        }
      }
    }
  }

  // 4. A4 — optional WHY question (no rationale OR deviating).
  const unjustified = decisions.filter(isUnjustified);
  const whyQuestion = buildWhyQuestion({
    workstreamId: args.workstreamId,
    unjustified,
    drifts,
  });

  return {
    alreadyReconciled: false,
    outcome,
    beliefUpdates,
    outcomeLessons,
    reflections,
    reinforcements,
    drifts,
    unjustified,
    whyQuestion,
  };
}
