/**
 * E2 — Periodic belief curation (ExpeL experience-pool → insight extraction).
 * Self-Learning / WHY engine · Stream A · 2026-05-27.
 *
 * Source: docs/plans/2026-05-27_self-learning-enhancements-plan.md §E2 +
 *         GOAL-lazyos-self-learning-why-engine.
 *
 * WHY this module:
 *   Run completion already learns (reconcile.ts: P0.1 outcome teaching,
 *   P0.2 reflection on repeated failures, P1.1 success reinforcement). But that
 *   happens PER SINGLE RUN — what is missing is the CROSS-CUTTING
 *   distillation across MANY outcomes (ExpeL „experience-pool →
 *   generalized insights"; HERMES „evaluate periodically"). curateWorkspaceBeliefs
 *   looks at the collected experience pool of a workspace, clusters by
 *   topic, forms the success/failure tally per topic and distills from it ONE
 *   generalized, reusable belief: „For <topic>: <N> successes /
 *   <M> failures → prefer <…>".
 *
 * Substrate discipline:
 *   - Takes a RAW better-sqlite3 handle (the sniper resolves it via
 *     `getDb().$raw`) — no getDb() singleton, directly in-memory testable.
 *   - PURE/IO-light: only DB read/write via the A2 repos, NO LLM, NO network I/O.
 *   - N6 deterministic: same DB + same period + same pool → same
 *     result. NO randomness, no wall-clock branching except the injectable
 *     `now` (period key).
 *   - N1: the joined WHYs are taken VERBATIM into the rationale
 *     (no .slice / .substring).
 *   - Idempotent: a dedicated CURATION_MARKER encodes (topic + period + tally
 *     fingerprint). A second run in the same period with the same tally → no-op.
 *
 * Source of the topic clusters (research decision, identical to reconcile.ts P0.2):
 *   `decision_outcomes` carries NO topic and no deterministically resolvable
 *   topic link. The clean, schema-non-invasive topic-aware source
 *   is the P0.1 teach beliefs (TEACH_MARKER_PREFIX `[teach-v1:<wsId>:<outcome>]`)
 *   — each carries its topic in the workspace_beliefs.topic column and its
 *   outcome in the belief marker. listBeliefsByMarkerPrefix(`[teach-v1`) returns them
 *   (active + superseded) → their topic + outcome IS the experience pool per topic.
 *   The GLOBAL outcome tally (decision_outcomes) serves as the minOutcomes gate.
 */

import {
  listBeliefsByMarkerPrefix,
  listOutcomesByWorkspace,
  upsertBelief,
  type Belief,
} from "@/lib/reasoning/beliefs-repo";

type RawDb = import("better-sqlite3").Database;

// ---------------------------------------------------------------------------
// Marker (idempotency + later recognition)
// ---------------------------------------------------------------------------

/**
 * Deterministic marker prefix of an E2 curation belief. Makes the distilled
 * insight (a) idempotently identifiable per (topic × period × tally) and (b)
 * cleanly distinguishable from P0.1/P0.2 beliefs for later curation runs / recall.
 *
 * Full format:  `[curate-v1:<isoPeriod>:s<succ>:f<fail>]`
 *   - isoPeriod   = `<UTC year>-W<ISO week>` (stable across year boundaries)
 *   - s<succ>/f<fail> = success/failure counters of the topic (tally fingerprint)
 * If the tally shifts in a LATER period (more successes/failures),
 * the marker changes → a NEW distillation is created (supersedes the old one).
 * If everything stays the same in the SAME period → exact same marker → no-op.
 */
export const CURATION_MARKER_PREFIX = "[curate-v1";

/** The teach-belief markers we evaluate as the experience pool per topic. */
const TEACH_MARKER_PREFIX = "[teach-v1";

function curationMarker(period: string, succ: number, fail: number): string {
  return `${CURATION_MARKER_PREFIX}:${period}:s${succ}:f${fail}]`;
}

// ---------------------------------------------------------------------------
// ISO period key (pattern from scripts/weekly-reflection-sniper.ts)
// ---------------------------------------------------------------------------

/** ISO week (robust across year boundaries) — exactly the reflection-sniper's logic. */
function getIsoWeek(d: Date): number {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

/**
 * Period key `<UTC year>-W<2-digit ISO week>` — the curation cadence.
 * Pure function (depends only on the injected `now`) → deterministically testable.
 */
export function curationPeriodKey(now: Date): string {
  const week = getIsoWeek(now);
  const yyyy = now.getUTCFullYear();
  return `${yyyy}-W${String(week).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Topic tally from the teach-belief pool
// ---------------------------------------------------------------------------

/** Success/failure tally of ONE topic, derived from the teach-belief pool. */
export interface TopicTally {
  readonly topic: string;
  /** Count of outcome=success signals (today 0 — teach beliefs only arise on
   * failure/partial; success fills this counter once a later extension
   * writes success teach beliefs. Structure is prepared, N1 completeness). */
  readonly successes: number;
  /** Count of outcome=failure signals. */
  readonly failures: number;
  /** Count of outcome=partial signals. */
  readonly partials: number;
  /** Total count of evaluated experience signals of this topic. */
  readonly total: number;
  /** VERBATIM joined WHYs of all counted signals (N1, no .slice). */
  readonly joinedWhy: string;
}

/**
 * Reads the outcome from a teach marker `[teach-v1:<wsId>:<outcome>]`.
 * Returns null if the marker is not parseable (fail-soft, ignored).
 */
function outcomeFromTeachBelief(b: Belief): string | null {
  if (!b.belief.startsWith(TEACH_MARKER_PREFIX)) return null;
  const end = b.belief.indexOf("]");
  if (end < 0) return null;
  const inner = b.belief.slice(0, end); // `[teach-v1:<wsId>:<outcome>`  (marker prefix)
  const lastColon = inner.lastIndexOf(":");
  if (lastColon < 0) return null;
  const outcome = inner.slice(lastColon + 1).trim();
  return outcome.length > 0 ? outcome : null;
}

/**
 * Clusters a workspace's teach-belief pool by topic and forms per topic
 * the success/failure/partial tally + the VERBATIM joined WHYs.
 * Pure aggregation over the passed beliefs (no DB) → easily testable.
 *
 * Curation beliefs (`[curate-v1`) and reflection beliefs (`[reflect-v1`) are
 * NOT counted — we only aggregate the raw experience signals (teach),
 * not the already-distilled meta-beliefs (no self-echo).
 */
export function tallyTopicsFromTeachBeliefs(
  teachBeliefs: readonly Belief[],
): TopicTally[] {
  interface Acc {
    successes: number;
    failures: number;
    partials: number;
    whys: string[];
  }
  const byTopic = new Map<string, Acc>();

  for (const b of teachBeliefs) {
    const outcome = outcomeFromTeachBelief(b);
    if (outcome == null) continue; // no teach marker → ignore
    const acc = byTopic.get(b.topic) ?? {
      successes: 0,
      failures: 0,
      partials: 0,
      whys: [],
    };
    if (outcome === "success") acc.successes += 1;
    else if (outcome === "failure") acc.failures += 1;
    else if (outcome === "partial") acc.partials += 1;
    else continue; // unknown outcome → do not count
    acc.whys.push(b.rationale); // N1: verbatim, not truncated
    byTopic.set(b.topic, acc);
  }

  const out: TopicTally[] = [];
  for (const [topic, acc] of byTopic) {
    const total = acc.successes + acc.failures + acc.partials;
    if (total === 0) continue;
    out.push({
      topic,
      successes: acc.successes,
      failures: acc.failures,
      partials: acc.partials,
      total,
      joinedWhy: acc.whys.join(" || "),
    });
  }
  // Deterministic order: topic alphabetical (stable + testable).
  out.sort((a, b) => (a.topic < b.topic ? -1 : a.topic > b.topic ? 1 : 0));
  return out;
}

// ---------------------------------------------------------------------------
// Distillation sentence (pure formulation)
// ---------------------------------------------------------------------------

/**
 * Formulates the generalized recommendation from a topic tally. Purely
 * deterministic (no LLM): failures dominate → „check root cause / prefer
 * verified alternative"; successes dominate → „keep preferring the proven approach".
 */
function distilledRecommendation(t: TopicTally): string {
  const fail = t.failures + t.partials;
  if (fail > t.successes) {
    return (
      `bevorzuge eine verifizierte Alternative ODER kläre die Grundursache, ` +
      `bevor „${t.topic}" erneut so gewählt wird`
    );
  }
  if (t.successes > fail) {
    return `bevorzuge den bewährten „${t.topic}"-Ansatz weiter`;
  }
  return (
    `Bilanz ist ausgeglichen — entscheide „${t.topic}" fallweise und ` +
    `dokumentiere das WARUM, bis sich eine Tendenz zeigt`
  );
}

// ---------------------------------------------------------------------------
// curateWorkspaceBeliefs
// ---------------------------------------------------------------------------

export interface CurateOptions {
  /**
   * Minimum number of total outcomes (decision_outcomes) in the workspace BEFORE
   * curation runs. Below the threshold → no-op (too little evidence for a
   * generalized insight). Default 3 (same spirit as REFLECTION_THRESHOLD).
   */
  readonly minOutcomes?: number;
  /** Injectable „now" time for the period key (tests). Default new Date(). */
  readonly now?: Date;
}

export interface CuratedTopic {
  readonly topic: string;
  readonly successes: number;
  readonly failures: number;
  readonly partials: number;
  /** The ID of the newly written curation belief. */
  readonly beliefId: string;
}

export interface CurateResult {
  /** Was it skipped due to minOutcomes / empty pool? */
  readonly skipped: boolean;
  /** Reason for the skip (for sniper logging), otherwise null. */
  readonly skipReason: string | null;
  /** The period key used. */
  readonly period: string;
  /** Number of total outcomes found in the workspace (gate basis). */
  readonly outcomeCount: number;
  /** Number of evaluated topic clusters. */
  readonly topicsConsidered: number;
  /** NEWLY written curation beliefs (idempotently skipped ones NOT included). */
  readonly curated: readonly CuratedTopic[];
}

/**
 * Distills generalized, reusable beliefs from a workspace's collected
 * experience pool — one per topic, per period, idempotent.
 *
 * Flow:
 *  1. Gate: fewer than minOutcomes total outcomes (decision_outcomes) → no-op.
 *  2. Read the teach-belief pool (`[teach-v1` marker) → cluster by topic + tally.
 *  3. Per topic (with ≥1 signal): formulate a generalized belief, marker
 *     `[curate-v1:<period>:s<succ>:f<fail>]`. If exactly this marker already exists
 *     (same period + same tally) → skip (idempotent). Otherwise: write via
 *     upsertBelief; supersedes — if present — the most recent active
 *     curation belief of the same topic (supersede → history stays, N1 spirit),
 *     otherwise a fresh insert. confidence rises mildly with the evidence amount.
 *
 * Deterministic (N6), fail-soft at the caller (sniper try/catch per workspace).
 */
export function curateWorkspaceBeliefs(
  raw: RawDb,
  workspaceId: string,
  opts?: CurateOptions,
): CurateResult {
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("curateWorkspaceBeliefs: workspaceId required");
  }
  const now = opts?.now ?? new Date();
  const period = curationPeriodKey(now);
  const minOutcomes =
    opts?.minOutcomes != null &&
    Number.isFinite(opts.minOutcomes) &&
    opts.minOutcomes >= 0
      ? Math.floor(opts.minOutcomes)
      : 3;

  // 1. Gate on the GLOBAL outcome count.
  const outcomes = listOutcomesByWorkspace(raw, workspaceId);
  const outcomeCount = outcomes.length;
  if (outcomeCount < minOutcomes) {
    return {
      skipped: true,
      skipReason: `outcomes=${outcomeCount} < minOutcomes=${minOutcomes}`,
      period,
      outcomeCount,
      topicsConsidered: 0,
      curated: [],
    };
  }

  // 2. Teach-belief pool → topic tallies.
  const teach = listBeliefsByMarkerPrefix(raw, workspaceId, TEACH_MARKER_PREFIX);
  const tallies = tallyTopicsFromTeachBeliefs(teach);
  if (tallies.length === 0) {
    return {
      skipped: true,
      skipReason: "no teach-belief experience-signals to distill",
      period,
      outcomeCount,
      topicsConsidered: 0,
      curated: [],
    };
  }

  // Already-existing curation beliefs (active + superseded) for idempotency +
  // supersede resolution. Load once, filter in-memory.
  const existingCuration = listBeliefsByMarkerPrefix(
    raw,
    workspaceId,
    CURATION_MARKER_PREFIX,
  );

  const curated: CuratedTopic[] = [];

  for (const t of tallies) {
    const marker = curationMarker(period, t.successes, t.failures + t.partials);

    // Idempotency: does EXACTLY this marker already exist for this topic? → skip.
    const dup = existingCuration.some(
      (b) => b.topic === t.topic && b.belief.includes(marker),
    );
    if (dup) continue;

    // supersede: most recent active (= not superseded by any other) curation belief
    // of the same topic. We resolve activity deterministically from the
    // existingCuration list: active = no other curation row references it via
    // supersedesId.
    const supersededIds = new Set(
      existingCuration
        .map((b) => b.supersedesId)
        .filter((x): x is string => typeof x === "string"),
    );
    const priorActive = existingCuration
      .filter((b) => b.topic === t.topic && !supersededIds.has(b.id))
      .sort((a, b) =>
        b.createdAt !== a.createdAt
          ? b.createdAt - a.createdAt
          : a.id < b.id
            ? 1
            : -1,
      )[0];

    // confidence: rising mildly with the evidence amount, clamped to [0.4, 0.9].
    const confidence = Math.max(0.4, Math.min(0.9, 0.4 + 0.05 * t.total));

    const fail = t.failures + t.partials;
    const written = upsertBelief(raw, {
      workspaceId,
      topic: t.topic,
      belief:
        `${marker} Bei „${t.topic}": ${t.successes} Erfolge / ${fail} Fehler ` +
        `(${t.total} Signale, Periode ${period}) → ${distilledRecommendation(t)}.`,
      rationale:
        `Periodische Belief-Curation (E2/ExpeL-Distillation, Periode ${period}). ` +
        `Generalisiert über ${t.total} Erfahrungs-Signale zum Topic „${t.topic}" ` +
        `(${t.successes} success / ${t.failures} failure / ${t.partials} partial). ` +
        `Verbatim zusammengefügte WARUMs (N1): ${t.joinedWhy}`,
      source: "ai",
      supersedesId: priorActive?.id ?? null,
      confidence,
    });

    // Track locally so a second topic pass in the same loop
    // (same period) knows the freshly written row as a supersede/dup basis.
    existingCuration.push(written);

    curated.push({
      topic: t.topic,
      successes: t.successes,
      failures: t.failures,
      partials: t.partials,
      beliefId: written.id,
    });
  }

  return {
    skipped: false,
    skipReason: null,
    period,
    outcomeCount,
    topicsConsidered: tallies.length,
    curated,
  };
}
