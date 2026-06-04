/**
 * A3 — WHY injection · Self-Learning / WHY engine · Stream A · 2026-05-27.
 *
 * Source: GOAL-lazyos-self-learning-why-engine (point 3) +
 *         docs/plans/2026-05-27_self-learning-and-flow-completion-plan.md (Stream A3).
 *
 * Core finding this module fixes: compose (lib/flow/compose.ts) and the
 * recursive plan proposer (lib/plan-first/orchestrate-plan.ts::proposePlan) read
 * TODAY neither workspaces.notes nor the earlier decision/belief history. Every
 * composition thus starts without memory — the system does not recommend
 * consistently („we chose X because … last time"), but anew each time.
 *
 * A3 closes this gap without a new engine (N4): it AGGREGATES the already
 * built read surfaces (A1 decisions-read + A2 beliefs-repo) into ONE
 * `WhyContext` and renders it as a prompt-injectable block that the
 * default-decompose wrapper PREPENDS to the proposePlan prompt.
 *
 * Approach (analogous to lib/flow/templates-repo.ts / decisions-read.ts):
 *   - Takes a RAW better-sqlite3 handle (getDb().$raw) — no
 *     getDb() singleton, directly in-memory testable.
 *   - PURE/IO-light: exclusively SELECTs (delegated to A1/A2), NO LLM, NO
 *     network I/O, no write.
 *   - Robust against an empty ledger: a fresh workspace (0 decisions, 0 beliefs)
 *     returns an empty WhyContext + an empty render string, NEVER an
 *     error.
 *
 * Discipline:
 *   - N1: buildWhyContext collects VERBATIM (no .slice). The token budgeting
 *         happens EXCLUSIVELY at render time (renderWhyContextForPrompt) and
 *         is transparently marked ("…(gekürzt)").
 *   - N6: the WHY is ONLY context for the LLM. The deterministic
 *         parseProposedPlan validator (in proposePlan) stays in front — the
 *         WhyContext CANNOT bypass the validator.
 *   - N2 untouched: A3 reads no RAG, writes no audit row, no cross-scope.
 *   - N9: everything is limited to the passed workspaceId (A1/A2 filter hard).
 */

import {
  recentRationales,
  listDecisions,
  type RecentRationale,
  type DecisionRow,
} from "./decisions-read";
import { recallRelevant, rankBeliefs, type Belief } from "./beliefs-repo";

type RawDb = import("better-sqlite3").Database;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface BuildWhyContextOpts {
  /** Required: workspace scope (N9). All aggregates are limited to this. */
  readonly workspaceId: string;
  /**
   * Optional: topic for the targeted belief recall (A2::recallRelevant). Without
   * a topic, NO topic-bound beliefs are collected (relevantBeliefs = [])
   * — the most recent rationales (recentRationales) always come.
   */
  readonly topic?: string;
  /** Optional: max count of recent rationales (default 12). */
  readonly decisionLimit?: number;
  /**
   * Optional: max count of relevant beliefs kept (default 12).
   * recallRelevant itself has no limit → we cap AFTER the recall, but keep
   * the newest first (A2 returns created_at DESC).
   */
  readonly beliefLimit?: number;
}

/**
 * The aggregated WHY of a workspace — structured, NOT truncated (N1). The
 * length/token budgeting happens only in renderWhyContextForPrompt.
 */
export interface WhyContext {
  readonly workspaceId: string;
  /** The recall topic (if one was requested), otherwise null. */
  readonly topic: string | null;
  /** The most recent decision rationales of the workspace (newest first). */
  readonly recentRationales: readonly RecentRationale[];
  /**
   * Active beliefs matching the topic (newest first). Empty if no topic
   * was requested OR no belief matches.
   */
  readonly relevantBeliefs: readonly Belief[];
  /**
   * The most recent routing decisions (decision_kind='route') as full rows —
   * in case the consumer needs more detail than the condensed
   * RecentRationale (e.g. evidenceRefs / contentHash). Newest first.
   */
  readonly routeDecisions: readonly DecisionRow[];
  /** true ⇔ there is no WHY at all (fresh workspace). */
  readonly isEmpty: boolean;
}

export interface RenderWhyContextOpts {
  /**
   * Soft character budget for the rendered block. If the budget is
   * exceeded, it is truncated transparently (with the "…(gekürzt)" marker). Default
   * generous (6000) — N1 spirit: better too much context than a lost WHY.
   */
  readonly maxChars?: number;
  /**
   * E3 (HERMES progressive-disclosure / MemGPT paging). Controls how much
   * FULL TEXT vs. 1-line summary is rendered:
   *
   *   - 'full' (default): every item is rendered with full belief/rationale text
   *     (today's behavior — BIT-IDENTICAL, all existing tests +
   *     live callers unchanged). On budget overflow, transparent truncation at
   *     the end (as before).
   *   - 'summary': only the top-k items (by rankBeliefs score for beliefs,
   *     order for rationales) get full text; the rest collapses to
   *     1-line summaries (topic + core sentence). That way MORE context fits the same
   *     budget — the block scales with a growing workspace.
   */
  readonly mode?: "full" | "summary";
  /**
   * E3. Effective only in mode:'summary': how many items per section get FULL TEXT
   * before the rest collapses to summary lines. Default 3.
   * <=0/undefined → default. In mode:'full' ignored.
   */
  readonly topK?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_DECISION_LIMIT = 12;
const DEFAULT_BELIEF_LIMIT = 12;
const DEFAULT_MAX_CHARS = 6000;
const TRUNCATION_MARKER = "…(gekürzt)";
const DEFAULT_TOP_K = 3;

/**
 * E3 (HERMES summary-first). Condenses a verbatim text into a 1-line
 * summary: the core sentence (up to the first sentence end) or a soft word
 * cut if no sentence end occurs. Multi-line is normalized to one line.
 * The cut is transparently marked (TRUNCATION_MARKER) so that
 * the LLM SEES that it is a condensation — N1 spirit: truncate only at
 * render time, visibly marked, never silently.
 *
 * Pure display helper (no belief/decision mutation). Default cap 160
 * characters — enough for „topic + core sentence", much shorter than a full-text entry.
 */
function summarizeLine(text: string, maxLen = 160): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length === 0) return oneLine;
  // First sentence (., !, ? followed by space/end) as the core sentence, if short enough.
  const sentenceMatch = oneLine.match(/^(.{1,160}?[.!?])(\s|$)/);
  if (sentenceMatch && sentenceMatch[1].length <= maxLen) {
    return sentenceMatch[1];
  }
  if (oneLine.length <= maxLen) return oneLine;
  // Soft word cut at the last word boundary before maxLen.
  const slice = oneLine.slice(0, maxLen);
  const lastSpace = slice.lastIndexOf(" ");
  const cut = lastSpace > maxLen * 0.6 ? slice.slice(0, lastSpace) : slice;
  return `${cut.trimEnd()} ${TRUNCATION_MARKER}`;
}

function clampPositive(n: number | undefined, fallback: number): number {
  if (n == null || !Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

/**
 * Human-readable label for a decision_kind. Pure display helper for the
 * prompt block — the canonical values come from 0071 (DecisionKind).
 */
function labelForKind(kind: string): string {
  switch (kind) {
    case "route":
      return "Routing";
    case "pause":
      return "Pause";
    case "inject":
      return "Injektion";
    case "bridge":
      return "Bridge (Cross-Scope)";
    case "override":
      return "Override";
    default:
      return kind;
  }
}

function labelForActor(actor: string): string {
  switch (actor) {
    case "user":
      return "Owner";
    case "agent":
      return "Agent";
    case "policy":
      return "Policy";
    default:
      return actor;
  }
}

// ---------------------------------------------------------------------------
// buildWhyContext
// ---------------------------------------------------------------------------

/**
 * Aggregates a workspace's WHY: recent rationales (A1
 * recentRationales) + topic-relevant active beliefs (A2 recallRelevant) +
 * recent routing decisions (A1 listDecisions{kind:'route'}).
 *
 * Robust against an empty ledger: a fresh workspace returns a WhyContext
 * with empty arrays + isEmpty=true (no error). Missing tables in a
 * minimal DB throw — that is the caller DB's job (live: all migrations present);
 * for tests, the migrations are loaded.
 *
 * NO .slice / .substring on contents (N1) — the limits only bound the
 * NUMBER of rows (the A1/A2 queries already do that via LIMIT). Token budgeting
 * on contents happens only in renderWhyContextForPrompt.
 */
export function buildWhyContext(
  raw: RawDb,
  opts: BuildWhyContextOpts,
): WhyContext {
  if (typeof opts.workspaceId !== "string" || opts.workspaceId.length === 0) {
    throw new Error("buildWhyContext: workspaceId required (N9 scope)");
  }
  const decisionLimit = clampPositive(opts.decisionLimit, DEFAULT_DECISION_LIMIT);
  const beliefLimit = clampPositive(opts.beliefLimit, DEFAULT_BELIEF_LIMIT);
  const topic =
    typeof opts.topic === "string" && opts.topic.trim().length > 0
      ? opts.topic
      : null;

  // A1: recent rationales (all kinds) + recent routing decisions.
  const rationales = recentRationales(raw, opts.workspaceId, decisionLimit);
  const routeDecisions = listDecisions(raw, {
    workspaceId: opts.workspaceId,
    kind: "route",
    limit: decisionLimit,
  });

  // A2: topic-relevant active beliefs (only if a topic was requested).
  // recallRelevant has no LIMIT → we cap the COUNT after the recall
  // (newest first, since A2 returns created_at DESC). This is a row-count
  // bound, NOT a content .slice (N1 untouched).
  let relevantBeliefs: Belief[] = [];
  if (topic) {
    const recalled = recallRelevant(raw, opts.workspaceId, topic);
    relevantBeliefs =
      recalled.length > beliefLimit ? recalled.slice(0, beliefLimit) : recalled;
  }

  const isEmpty =
    rationales.length === 0 &&
    relevantBeliefs.length === 0 &&
    routeDecisions.length === 0;

  return {
    workspaceId: opts.workspaceId,
    topic,
    recentRationales: rationales,
    relevantBeliefs,
    routeDecisions,
    isEmpty,
  };
}

// ---------------------------------------------------------------------------
// renderWhyContextForPrompt
// ---------------------------------------------------------------------------

/**
 * Formats a WhyContext as a prompt-injectable block that the
 * default-decompose PREPENDS to the proposePlan prompt. Here — and ONLY here —
 * truncation is allowed (token budget). The truncation is transparent: every capped
 * line / the capped block carries the "…(gekürzt)" marker.
 *
 * Empty WhyContext (fresh workspace) → empty string (the decompose then
 * prepends nothing; behavior bit-identical to today).
 *
 * Structure of the block (German output, rendered verbatim):
 *   ── Frühere Entscheidungen in diesem Workspace / warum ──
 *   Aktive Überzeugungen (Topic "<topic>"):
 *     - <belief> — weil: <rationale> [Owner|Agent]
 *   Jüngste Begründungen:
 *     - [Routing|Pause|…] <rationale> [Owner|Agent]
 *   ── Ende früherer Kontext (nutze ihn für konsistente, begründete Empfehlungen) ──
 */
export function renderWhyContextForPrompt(
  ctx: WhyContext,
  opts: RenderWhyContextOpts = {},
): string {
  if (ctx.isEmpty) return "";

  // E3: summary-first only with explicit mode:'summary'. Default = full =
  // bit-identical to the existing path below (existing tests + live callers unchanged).
  if (opts.mode === "summary") {
    return renderWhyContextSummary(ctx, opts);
  }

  const maxChars = clampPositive(opts.maxChars, DEFAULT_MAX_CHARS);

  const header = "── Frühere Entscheidungen in diesem Workspace / warum ──";
  const footer =
    "── Ende früherer Kontext (nutze ihn für konsistente, begründete Empfehlungen) ──";

  // We build the lines fully and truncate transparently AFTERWARDS — so
  // the cut is deterministic and the marker lands at a block boundary.
  const lines: string[] = [header];

  if (ctx.relevantBeliefs.length > 0) {
    const topicLabel = ctx.topic ? ` (Topic "${ctx.topic}")` : "";
    lines.push(`Aktive Überzeugungen${topicLabel}:`);
    for (const b of ctx.relevantBeliefs) {
      lines.push(`  - ${b.belief} — weil: ${b.rationale} [${labelForActor(b.source)}]`);
    }
  }

  if (ctx.recentRationales.length > 0) {
    lines.push("Jüngste Begründungen:");
    for (const r of ctx.recentRationales) {
      lines.push(
        `  - [${labelForKind(r.decisionKind)}] ${r.rationale} [${labelForActor(r.actor)}]`,
      );
    }
  }

  lines.push(footer);

  const full = lines.join("\n");
  if (full.length <= maxChars) return full;

  // ── Transparent truncation (token budget) ────────────────────────────────
  // We keep the header, cut to maxChars (minus space for the marker
  // + footer) at a line boundary and append the marker + footer so
  // the LLM SEES that context is missing (instead of a silent hard cut).
  const tail = `\n${TRUNCATION_MARKER}\n${footer}`;
  const budget = Math.max(header.length, maxChars - tail.length);

  let kept = "";
  for (const line of lines) {
    if (line === footer) continue; // footer comes from `tail`
    const candidate = kept.length === 0 ? line : `${kept}\n${line}`;
    if (candidate.length > budget) break;
    kept = candidate;
  }
  // Fallback: not even the header fits the budget → hard, but marked
  // cut of the header (never an empty/misleading block).
  if (kept.length === 0) {
    kept = header.slice(0, budget);
  }
  return `${kept}${tail}`;
}

// ---------------------------------------------------------------------------
// E3 — summary-first Renderer (HERMES progressive-disclosure)
// ---------------------------------------------------------------------------

/**
 * mode:'summary' path. Strategy:
 *   - Beliefs are sorted via rankBeliefs (weighted f(recency,confidence,match));
 *     the top-k get full text (belief + why), the rest collapses
 *     to 1-line summaries (topic + core sentence). Secret redaction does NOT run on either
 *     path in why-context (this module does not redact — it reads an already
 *     redacted trail; symmetric to the full path, which also does not redact).
 *   - Rationales: top-k full text, rest as summary lines (in the given
 *     order — A1 returns created_at DESC, so „newest first" full text).
 *
 * At the same budget, the result covers MORE items than the full-truncated path
 * (each remaining entry now costs only ~1 short line instead of a full-text block).
 * On budget overflow, the same transparent end truncation as in the full path applies.
 */
function renderWhyContextSummary(
  ctx: WhyContext,
  opts: RenderWhyContextOpts,
): string {
  const maxChars = clampPositive(opts.maxChars, DEFAULT_MAX_CHARS);
  const topK = clampPositive(opts.topK, DEFAULT_TOP_K);

  const header = "── Frühere Entscheidungen in diesem Workspace / warum ──";
  const footer =
    "── Ende früherer Kontext (nutze ihn für konsistente, begründete Empfehlungen) ──";

  const lines: string[] = [header];

  if (ctx.relevantBeliefs.length > 0) {
    const topicLabel = ctx.topic ? ` (Topic "${ctx.topic}")` : "";
    lines.push(`Aktive Überzeugungen${topicLabel}:`);
    // Weighted ranking (relevance > confidence > recency) — top-k full text.
    const ranked = ctx.topic
      ? rankBeliefs(ctx.relevantBeliefs, ctx.topic)
      : [...ctx.relevantBeliefs];
    ranked.forEach((b, idx) => {
      if (idx < topK) {
        lines.push(
          `  - ${b.belief} — weil: ${b.rationale} [${labelForActor(b.source)}]`,
        );
      } else {
        lines.push(`  · ${b.topic}: ${summarizeLine(b.belief)}`);
      }
    });
  }

  if (ctx.recentRationales.length > 0) {
    lines.push("Jüngste Begründungen:");
    ctx.recentRationales.forEach((r, idx) => {
      if (idx < topK) {
        lines.push(
          `  - [${labelForKind(r.decisionKind)}] ${r.rationale} [${labelForActor(r.actor)}]`,
        );
      } else {
        lines.push(
          `  · [${labelForKind(r.decisionKind)}] ${summarizeLine(r.rationale)}`,
        );
      }
    });
  }

  lines.push(footer);

  const full = lines.join("\n");
  if (full.length <= maxChars) return full;

  // The same transparent end truncation as the full path (marker + footer stay).
  const tail = `\n${TRUNCATION_MARKER}\n${footer}`;
  const budget = Math.max(header.length, maxChars - tail.length);
  let kept = "";
  for (const line of lines) {
    if (line === footer) continue;
    const candidate = kept.length === 0 ? line : `${kept}\n${line}`;
    if (candidate.length > budget) break;
    kept = candidate;
  }
  if (kept.length === 0) {
    kept = header.slice(0, budget);
  }
  return `${kept}${tail}`;
}
