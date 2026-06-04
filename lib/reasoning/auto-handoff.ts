/**
 * A6 — Auto-workspace-handoff · Self-Learning / WHY engine · Stream A · 2026-05-27.
 *
 * Source: GOAL-lazyos-self-learning-why-engine (point 6 „Auto-Handoffs") +
 *         docs/plans/2026-05-27_self-learning-and-flow-completion-plan.md.
 *
 * Core finding this module fixes: today there is NO auto-handoff. The
 * WHY of a session (which decisions made, which beliefs
 * established, which decisions still open) disappears at session end.
 * `lib/intent-classifier.ts:180` explicitly notes „lessons learned … not
 * persisted for now". A new chat session in the SAME workspace therefore starts
 * amnesic — it reads workspaces.notes (manually maintained mini
 * CLAUDE.md) and (since RAG slice 1) rag_chunks, but NOT its own
 * decision/belief trail.
 *
 * This module closes the learning loop:
 *   1. buildWorkspaceHandoff  — aggregates the read-back trail (A1 decisions-read
 *      + A2 beliefs-repo) into a structured handoff (N1 verbatim).
 *   2. persistWorkspaceHandoff — writes a compact, human-readable
 *      summary to workspaces.notes (notes_source='ai-summary') — the
 *      existing anchor point (migration 0013), NO new table (N4).
 *   3. renderHandoffForSession — the injection block for the system prompt at
 *      the next start; truncatable with a marker.
 *
 * Approach (analogous to lib/reasoning/decisions-read.ts + beliefs-repo.ts):
 *   - Takes a RAW better-sqlite3 handle — no getDb() singleton,
 *     directly in-memory testable.
 *   - PURE except for persistWorkspaceHandoff (a targeted UPDATE on workspaces).
 *     NO LLM, NO network I/O.
 *   - Deterministic: stable order (newest first, like the read repos).
 *
 * Secret hygiene (owner directive): only aggregated
 * rationale/belief texts from the already-persisted trail are taken over. This
 * module reads NO credentials, NO env, NO files. It can only pass on
 * what is already in the DB as a decision/belief. An optional,
 * conservative redaction pass (`redactSecrets`) masks obvious
 * key patterns, in case a plaintext secret ever accidentally landed
 * in a rationale (defense-in-depth).
 */

type RawDb = import("better-sqlite3").Database;

import {
  listDecisions,
  recentRationales,
  type DecisionRow,
  type RecentRationale,
} from "@/lib/reasoning/decisions-read";
import { listBeliefs, type Belief } from "@/lib/reasoning/beliefs-repo";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** An open decision — made, but (yet) without a recorded outcome. */
export interface OpenDecision {
  readonly decisionId: string;
  readonly workstreamId: string;
  readonly decisionKind: DecisionRow["decisionKind"];
  /** The WHY, VERBATIM (N1). */
  readonly rationale: string;
  readonly actor: DecisionRow["actor"];
  readonly createdAt: number;
}

/** An established (active, non-superseded) belief — condensed. */
export interface HandoffBelief {
  readonly topic: string;
  /** The belief, VERBATIM (N1). */
  readonly belief: string;
  /** The WHY, VERBATIM (N1). */
  readonly rationale: string;
  readonly source: Belief["source"];
  readonly confidence: number | null;
}

/**
 * Structured workspace handoff. Aggregates a workspace's read-back trail
 * into „WHAT was done / WHY (recentRationales), established
 * beliefs (beliefs), open decisions (decisions without outcome)".
 *
 * N1: all text fields verbatim from the persisted trail — no .slice here.
 * The length/token budgeting happens exclusively in
 * renderHandoffForSession (with an explicit marker).
 */
export interface WorkspaceHandoff {
  readonly workspaceId: string;
  /** Time of aggregation (ms epoch). */
  readonly generatedAt: number;
  /** What was last decided + why (newest first). */
  readonly recentRationales: readonly RecentRationale[];
  /** Currently established beliefs (active, not superseded). */
  readonly beliefs: readonly HandoffBelief[];
  /** Decisions that do not yet have a recorded outcome. */
  readonly openDecisions: readonly OpenDecision[];
  /** true if nothing was aggregated (fresh/empty workspace). */
  readonly isEmpty: boolean;
}

export interface BuildHandoffOpts {
  /** Max count of recentRationales (default 12). */
  readonly rationaleLimit?: number;
  /** Max count of decisions scanned for open ones (default 50). */
  readonly decisionScanLimit?: number;
  /** Max count of open decisions in the handoff (default 10). */
  readonly openDecisionLimit?: number;
}

// ---------------------------------------------------------------------------
// Secret hygiene (defense-in-depth)
// ---------------------------------------------------------------------------

/**
 * Conservative redaction of obvious plaintext secrets. The trail SHOULD
 * contain no secrets (credentials live in the vault, never in rationale text),
 * but if one ever slips through, we mask it before it lands in notes/prompt.
 * Deliberately narrow, to not destroy real rationale content.
 *
 * Catches:
 *   - known key prefixes (sk-, pk-, ghp_, gho_, github_pat_, xoxb-, AKIA…)
 *   - `KEY=…` / `TOKEN=…` / `SECRET=…` / `PASSWORD=…` assignments
 *   - `Bearer <token>` headers
 */
export function redactSecrets(text: string): string {
  let out = text;
  // Known provider key formats (Stripe, GitHub, Slack, AWS, generic sk-).
  out = out.replace(
    /\b(sk|pk|rk)[-_][A-Za-z0-9]{12,}\b/g,
    "[redacted-key]",
  );
  out = out.replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[redacted-token]");
  out = out.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[redacted-token]");
  out = out.replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "[redacted-token]");
  out = out.replace(/\bAKIA[0-9A-Z]{16}\b/g, "[redacted-key]");
  // KEY=… / TOKEN=… / SECRET=… / PASSWORD=… / API_KEY=… (env style).
  out = out.replace(
    /\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD))\s*[:=]\s*\S+/gi,
    "$1=[redacted]",
  );
  // Bearer header.
  out = out.replace(/\bBearer\s+[A-Za-z0-9._-]{10,}\b/g, "Bearer [redacted]");
  return out;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_RATIONALE_LIMIT = 12;
const DEFAULT_DECISION_SCAN_LIMIT = 50;
const DEFAULT_OPEN_DECISION_LIMIT = 10;

function clampPositive(value: number | undefined, fallback: number): number {
  if (value == null || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

/**
 * Reads the decision_ids of the workspace for which at least one
 * decision_outcomes entry exists. Defensive against a missing table: if
 * decision_outcomes (migration 0113) does not (yet) exist, „no outcome
 * known" applies → all decisions count as open (fail-soft, never throw).
 */
function resolvedDecisionIds(raw: RawDb, workspaceId: string): Set<string> {
  const resolved = new Set<string>();
  try {
    const rows = raw
      .prepare(
        `SELECT DISTINCT decision_id
           FROM decision_outcomes
          WHERE workspace_id = ? AND decision_id IS NOT NULL`,
      )
      .all(workspaceId) as { decision_id: unknown }[];
    for (const r of rows) {
      if (r.decision_id != null) resolved.add(String(r.decision_id));
    }
  } catch {
    /* decision_outcomes missing → empty set (all open). fail-soft. */
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// buildWorkspaceHandoff
// ---------------------------------------------------------------------------

/**
 * Aggregates a workspace's read-back trail into a structured
 * handoff. Scope-isolated via workspaceId (A1/A2 filter internally via
 * workstreams.workspace_id resp. workspace_beliefs.workspace_id).
 *
 * „Open decisions" = decisions whose id does NOT appear in decision_outcomes
 * (no recorded result). Limited to openDecisionLimit,
 * newest first (listDecisions returns created_at DESC).
 *
 * Robust against a fresh workspace: empty trail → isEmpty=true, all arrays
 * empty, NO error.
 */
export function buildWorkspaceHandoff(
  raw: RawDb,
  workspaceId: string,
  opts: BuildHandoffOpts = {},
): WorkspaceHandoff {
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("buildWorkspaceHandoff: workspaceId required");
  }

  const rationaleLimit = clampPositive(
    opts.rationaleLimit,
    DEFAULT_RATIONALE_LIMIT,
  );
  const decisionScanLimit = clampPositive(
    opts.decisionScanLimit,
    DEFAULT_DECISION_SCAN_LIMIT,
  );
  const openDecisionLimit = clampPositive(
    opts.openDecisionLimit,
    DEFAULT_OPEN_DECISION_LIMIT,
  );

  const rationales = recentRationales(raw, workspaceId, rationaleLimit);

  const activeBeliefs = listBeliefs(raw, workspaceId).map(
    (b): HandoffBelief => ({
      topic: b.topic,
      belief: b.belief,
      rationale: b.rationale,
      source: b.source,
      confidence: b.confidence,
    }),
  );

  // Open decisions: scan the most recent decisions, filter out those with
  // a recorded outcome, keep openDecisionLimit (newest first).
  const allDecisions = listDecisions(raw, {
    workspaceId,
    limit: decisionScanLimit,
  });
  const resolved = resolvedDecisionIds(raw, workspaceId);
  const openDecisions: OpenDecision[] = allDecisions
    .filter((d) => !resolved.has(d.id))
    .slice(0, openDecisionLimit)
    .map((d) => ({
      decisionId: d.id,
      workstreamId: d.workstreamId,
      decisionKind: d.decisionKind,
      rationale: d.rationale,
      actor: d.actor,
      createdAt: d.createdAt,
    }));

  const isEmpty =
    rationales.length === 0 &&
    activeBeliefs.length === 0 &&
    openDecisions.length === 0;

  return {
    workspaceId,
    generatedAt: Date.now(),
    recentRationales: rationales,
    beliefs: activeBeliefs,
    openDecisions,
    isEmpty,
  };
}

// ---------------------------------------------------------------------------
// renderHandoffForSession
// ---------------------------------------------------------------------------

export interface RenderHandoffOpts {
  /**
   * Max characters for the entire rendered block. If the block is longer,
   * it is hard-truncated and a marker (TRUNCATION_MARKER) is appended. Default
   * 4000 (pain threshold analogous to readWorkspaceNotes 8000, but this block comes
   * ADDITIONALLY, hence more conservative). 0/undefined → no limit.
   */
  readonly maxChars?: number;
  /**
   * E3 (HERMES progressive-disclosure / MemGPT paging). Controls full text vs.
   * 1-line summary:
   *
   *   - 'full' (default): every item with full text (today's behavior —
   *     BIT-IDENTICAL; all existing tests + live callers + persistWorkspaceHandoff
   *     unchanged). On budget overflow, hard end cut with a marker (as before).
   *   - 'summary': the top-k items per section get full text, the rest
   *     collapses to 1-line summaries (topic + core sentence). That way the block
   *     covers MORE items in the same budget for a growing workspace instead of hard
   *     truncating. Secret redaction (redactSecrets) runs on BOTH paths.
   */
  readonly mode?: "full" | "summary";
  /**
   * E3. Effective only in mode:'summary': full-text items per section before the
   * rest collapses to summary lines. Default 3. <=0/undefined → default.
   */
  readonly topK?: number;
}

/** Marker that indicates a hard truncation in renderHandoffForSession. */
export const TRUNCATION_MARKER = "\n\n[… Handoff gekürzt — voller Trail via Decision-Log]";

const HANDOFF_HEADER = "## Workspace-Gedächtnis (auto-Handoff · zuletzt in diesem Workspace)";

/**
 * Renders a handoff as a human-/LLM-readable Markdown block for the
 * system prompt at session start. Format (German output, rendered verbatim):
 *
 *   ## Workspace-Gedächtnis (auto-Handoff · …)
 *   In diesem Workspace zuletzt:
 *   - [route] <rationale>
 *   - …
 *   Etablierte Überzeugungen:
 *   - <topic>: <belief> (warum: <rationale>)
 *   - …
 *   Offene Entscheidungen (noch kein Ergebnis):
 *   - [bridge] <rationale>
 *   - …
 *
 * Fresh/empty workspace (handoff.isEmpty) → empty string (no block, no
 * noise in the prompt). Secret redaction ALWAYS runs (defense-in-depth).
 */
export function renderHandoffForSession(
  handoff: WorkspaceHandoff,
  opts: RenderHandoffOpts = {},
): string {
  if (handoff.isEmpty) return "";

  // E3: summary-first only with explicit mode:'summary'. Default = full =
  // bit-identical to the existing path (existing tests + persistWorkspaceHandoff
  // + live callers unchanged).
  if (opts.mode === "summary") {
    return renderHandoffSummary(handoff, opts);
  }

  const lines: string[] = [HANDOFF_HEADER, ""];

  if (handoff.recentRationales.length > 0) {
    lines.push("In diesem Workspace zuletzt:");
    for (const r of handoff.recentRationales) {
      lines.push(`- [${r.decisionKind}] ${redactSecrets(r.rationale)}`);
    }
    lines.push("");
  }

  if (handoff.beliefs.length > 0) {
    lines.push("Etablierte Überzeugungen:");
    for (const b of handoff.beliefs) {
      const conf =
        b.confidence != null ? ` (Konfidenz ${b.confidence})` : "";
      lines.push(
        `- ${redactSecrets(b.topic)}: ${redactSecrets(b.belief)}${conf} — warum: ${redactSecrets(b.rationale)}`,
      );
    }
    lines.push("");
  }

  if (handoff.openDecisions.length > 0) {
    lines.push("Offene Entscheidungen (noch kein Ergebnis):");
    for (const d of handoff.openDecisions) {
      lines.push(`- [${d.decisionKind}] ${redactSecrets(d.rationale)}`);
    }
    lines.push("");
  }

  let block = lines.join("\n").trimEnd();

  const maxChars = clampPositive(opts.maxChars, 4000);
  if (block.length > maxChars) {
    // Hard truncate + marker. maxChars as a HARD budget incl. the marker.
    const keep = Math.max(0, maxChars - TRUNCATION_MARKER.length);
    block = block.slice(0, keep) + TRUNCATION_MARKER;
  }

  return block;
}

// ---------------------------------------------------------------------------
// E3 — summary-first Renderer (HERMES progressive-disclosure)
// ---------------------------------------------------------------------------

const DEFAULT_HANDOFF_TOP_K = 3;
/** Inline marker of a condensed (summary) line — visible, never silent (N1 spirit). */
const SUMMARY_LINE_MARKER = "…(gekürzt)";

/**
 * Condenses a verbatim text into a 1-line summary (core sentence or soft
 * word cut). Multi-line is normalized to one line. Cut visibly
 * marked. Pure display helper — NO mutation of the trail.
 */
function summarizeLine(text: string, maxLen = 160): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length === 0) return oneLine;
  const sentenceMatch = oneLine.match(/^(.{1,160}?[.!?])(\s|$)/);
  if (sentenceMatch && sentenceMatch[1].length <= maxLen) {
    return sentenceMatch[1];
  }
  if (oneLine.length <= maxLen) return oneLine;
  const slice = oneLine.slice(0, maxLen);
  const lastSpace = slice.lastIndexOf(" ");
  const cut = lastSpace > maxLen * 0.6 ? slice.slice(0, lastSpace) : slice;
  return `${cut.trimEnd()} ${SUMMARY_LINE_MARKER}`;
}

/**
 * Ranking of HandoffBeliefs for the summary path. HandoffBelief carries only
 * confidence (no updatedAt/match-topic like the full belief), so we rank
 * by the confidence signal (consistent with the confidence weight in
 * beliefs-repo::rankBeliefs) — highest confidence first, stable index tie-break.
 * null-confidence is treated like 0.5 (the neutral default in rankBeliefs).
 */
function rankHandoffBeliefs(
  beliefs: readonly HandoffBelief[],
): HandoffBelief[] {
  const conf = (b: HandoffBelief): number => (b.confidence == null ? 0.5 : b.confidence);
  return beliefs
    .map((b, idx) => ({ b, idx }))
    .sort((x, y) => {
      const d = conf(y.b) - conf(x.b);
      if (d !== 0) return d;
      return x.idx - y.idx; // stable: original order (newest first).
    })
    .map((e) => e.b);
}

/**
 * mode:'summary' path for renderHandoffForSession. top-k items per section
 * full text, rest as 1-line summary. Beliefs ranked by confidence, the rest
 * in the given (newest-first) order. Secret redaction runs on every
 * line — also in the summary path (defense-in-depth, identical to the full path).
 */
function renderHandoffSummary(
  handoff: WorkspaceHandoff,
  opts: RenderHandoffOpts,
): string {
  const topK = clampPositive(opts.topK, DEFAULT_HANDOFF_TOP_K);
  const lines: string[] = [HANDOFF_HEADER, ""];

  if (handoff.recentRationales.length > 0) {
    lines.push("In diesem Workspace zuletzt:");
    handoff.recentRationales.forEach((r, idx) => {
      const text = redactSecrets(r.rationale);
      if (idx < topK) {
        lines.push(`- [${r.decisionKind}] ${text}`);
      } else {
        lines.push(`· [${r.decisionKind}] ${summarizeLine(text)}`);
      }
    });
    lines.push("");
  }

  if (handoff.beliefs.length > 0) {
    lines.push("Etablierte Überzeugungen:");
    const ranked = rankHandoffBeliefs(handoff.beliefs);
    ranked.forEach((b, idx) => {
      if (idx < topK) {
        const conf = b.confidence != null ? ` (Konfidenz ${b.confidence})` : "";
        lines.push(
          `- ${redactSecrets(b.topic)}: ${redactSecrets(b.belief)}${conf} — warum: ${redactSecrets(b.rationale)}`,
        );
      } else {
        lines.push(
          `· ${redactSecrets(b.topic)}: ${summarizeLine(redactSecrets(b.belief))}`,
        );
      }
    });
    lines.push("");
  }

  if (handoff.openDecisions.length > 0) {
    lines.push("Offene Entscheidungen (noch kein Ergebnis):");
    handoff.openDecisions.forEach((d, idx) => {
      const text = redactSecrets(d.rationale);
      if (idx < topK) {
        lines.push(`- [${d.decisionKind}] ${text}`);
      } else {
        lines.push(`· [${d.decisionKind}] ${summarizeLine(text)}`);
      }
    });
    lines.push("");
  }

  let block = lines.join("\n").trimEnd();

  const maxChars = clampPositive(opts.maxChars, 4000);
  if (block.length > maxChars) {
    const keep = Math.max(0, maxChars - TRUNCATION_MARKER.length);
    block = block.slice(0, keep) + TRUNCATION_MARKER;
  }

  return block;
}

// ---------------------------------------------------------------------------
// buildSessionHandoffBlock — the ONE place that assembles the handoff block
// for the system prompt from the workspace trail (build → render → separator).
// Pure (takes the raw DB handle), so the session-start seam is round-trip-
// testable (it is untested today). Returns the prompt lines OR []
// (empty/faulty trail → no block, never break the prompt).
// ---------------------------------------------------------------------------

export function buildSessionHandoffBlock(
  raw: RawDb,
  workspaceId: string,
  opts: { maxChars?: number } = {},
): string[] {
  try {
    const handoff = buildWorkspaceHandoff(raw, workspaceId);
    if (handoff.isEmpty) return [];
    const rendered = renderHandoffForSession(handoff, {
      maxChars: opts.maxChars ?? 4000,
    });
    if (rendered.trim().length === 0) return [];
    return [rendered, "", "---", ""];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// persistWorkspaceHandoff
// ---------------------------------------------------------------------------

export interface PersistHandoffOpts {
  /** Max characters of the persisted summary (default 8000, like the notes cap). */
  readonly maxChars?: number;
}

export interface PersistHandoffResult {
  /** true if workspaces.notes was written. */
  readonly written: boolean;
  /** Reason, if not written. */
  readonly skippedReason?: "empty-handoff" | "foreign-notes-source";
}

/**
 * Persists a compact, human-readable handoff summary to
 * `workspaces.notes` with `notes_source='ai-summary'`.
 *
 * REPLACE strategy (documented):
 *   - We write ONLY if the existing notes source is NOT manual.
 *     Concretely: notes_source IN (NULL, 'ai-summary') → we may
 *     overwrite (it is either empty or an earlier auto-handoff).
 *     notes_source = 'manual' (or any other non-'ai-summary' source) →
 *     we leave the notes UNTOUCHED (skippedReason='foreign-notes-source').
 *     That way the auto-handoff never kills the user-maintained workspace notes
 *     (mini-CLAUDE.md, authoritative — readWorkspaceNotes injects them with priority).
 *   - The ai-summary notes are COMPLETELY replaced on every run (not
 *     appended) so they do not grow unboundedly — the handoff is always
 *     the current aggregated state. Idempotent: same trail → same
 *     text → same notes value.
 *
 * Fresh/empty workspace (handoff.isEmpty) → no write (skippedReason=
 * 'empty-handoff'), so an empty auto-handoff does not overwrite a possibly existing
 * earlier summary with an empty string.
 *
 * Secret hygiene: the persisted summary runs through renderHandoffForSession
 * (incl. redactSecrets). Only aggregated rationale/belief texts land in the
 * notes — never credentials.
 */
export function persistWorkspaceHandoff(
  raw: RawDb,
  workspaceId: string,
  handoff: WorkspaceHandoff,
  opts: PersistHandoffOpts = {},
): PersistHandoffResult {
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("persistWorkspaceHandoff: workspaceId required");
  }
  if (handoff.isEmpty) {
    return { written: false, skippedReason: "empty-handoff" };
  }

  // Check the existing notes_source — never kill a manual/foreign source.
  const existing = raw
    .prepare("SELECT notes_source FROM workspaces WHERE id = ?")
    .get(workspaceId) as { notes_source?: string | null } | undefined;
  const currentSource = existing?.notes_source ?? null;
  if (currentSource != null && currentSource !== "ai-summary") {
    return { written: false, skippedReason: "foreign-notes-source" };
  }

  const maxChars = clampPositive(opts.maxChars, 8000);
  // We use the session render function as the canonical summary
  // (a single format source). maxChars hard-bounded with a marker.
  const summary = renderHandoffForSession(handoff, { maxChars });
  if (summary.length === 0) {
    // Can only happen if isEmpty was wrongly false — defensive.
    return { written: false, skippedReason: "empty-handoff" };
  }

  raw
    .prepare(
      `UPDATE workspaces
          SET notes = ?,
              notes_updated_at = ?,
              notes_source = 'ai-summary'
        WHERE id = ?`,
    )
    .run(summary, handoff.generatedAt, workspaceId);

  return { written: true };
}
