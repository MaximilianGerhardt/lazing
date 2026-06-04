// Cross-Roast Critic.
//
// BACKPORT-03 from Lazing-V2 (2026-05-23 · Agent 3/8). Source:
// lazing-wt/realtime-orchestrator-v2/apps/web/src/lib/critic-loop/
// cross-roast-critic.ts (287 LOC, V2 Slice C).
//
// Activates when a step has spawned ≥ 2 parallel coder lanes whose
// diffs touch overlapping files AND the step's complexity is `complex`.
// Renders the cross-roast prompt from
// `~/.claude/skills/lazing-cross-roast/SKILL.md` (template loaded at
// runtime — the file may not exist in CI; we fall back to a built-in
// minimal template so the unit tests can run offline).
//
// Outcome:
//   - `pass/winner`  : one diff dominates on every criterion; we pass
//                      the winner forward.
//   - `synthesize`   : the diffs are complementary; we ask a synthesis
//                      lane to merge them.
//   - `fail/defenseQueue`: no diff defends itself; the cross-roast
//                      escalates to the operator with a defense queue.
//
// Discipline:
//   - N1: every diff body + critic note is forwarded verbatim into the
//     prompt. The cross-roast adapter NEVER reformats operator-visible
//     prose.
//   - N6: the activation predicate is deterministic — same inputs give
//     same activation decision.
//   - N9 / N19: the critic round inherits the coder lane's ManifestCoord
//     (same scope envelope).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type {
  CriticComment,
  CriticRepo,
  CriticRoundRow,
} from './types';

import type { PlanStep } from '../plan-first/orchestrate-plan';

/** Public surface of the cross-roast outcome. */
export type CrossRoastOutcome =
  | { readonly kind: 'pass/winner'; readonly winnerLaneId: string; readonly comments: readonly CriticComment[] }
  | { readonly kind: 'synthesize'; readonly comments: readonly CriticComment[] }
  | { readonly kind: 'fail/defenseQueue'; readonly defenseQueue: readonly string[]; readonly comments: readonly CriticComment[] };

/** A single coder lane's diff submitted to the cross-roast. */
export interface CoderLaneDiff {
  /** Stable id for the lane (subdispatch id). */
  readonly laneId: string;
  /** Verbatim diff text (N1) — the cross-roast prompt embeds it as-is. */
  readonly diff: string;
  /** Author label for the prompt header — verbatim (N1). */
  readonly authorLabel: string;
  /** Files this diff touches (used for overlap detection). */
  readonly touchedFiles: readonly string[];
}

/** Step-level metadata needed for the activation predicate. */
export interface CrossRoastStep {
  readonly id: string;
  readonly title: string;
  readonly rationale: string;
  readonly role?: PlanStep['subagentRole'];
  /** Parallel coder lanes the walker actually spawned for this step. */
  readonly parallelCount: number;
  readonly complexity: 'simple' | 'complex';
}

/** Input passed to the cross-roast judge. */
export interface CrossRoastInput {
  readonly step: CrossRoastStep;
  readonly diffs: readonly CoderLaneDiff[];
  /** Same ManifestCoord coord_key as the coder lane (INV-19). */
  readonly coordKey: string;
  readonly workstreamId: string | null;
  /** Engine adapter — we hand it the rendered prompt and parse its reply. */
  readonly callEngine: (prompt: string) => Promise<string>;
  /** Repo for persisting the round (criticRole='cross-roast'). */
  readonly repo: CriticRepo;
}

// ─── Activation predicate ───────────────────────────────────────────────────

/**
 * Determines whether the cross-roast critic should run.
 *
 * Activates when ALL hold:
 *   - `step.role === 'coder'`
 *   - `step.parallelCount >= 2`
 *   - At least two diffs touch overlapping files
 *   - `step.complexity === 'complex'`
 */
export function shouldActivateCrossRoast(
  step: CrossRoastStep,
  diffs: readonly CoderLaneDiff[],
): boolean {
  if (step.role !== 'coder') return false;
  if (step.parallelCount < 2) return false;
  if (step.complexity !== 'complex') return false;
  return bothDiffsTouchOverlappingFiles(diffs);
}

/** Pure helper — true iff ≥ 2 diffs share at least one touched file. */
export function bothDiffsTouchOverlappingFiles(
  diffs: readonly CoderLaneDiff[],
): boolean {
  const seen = new Map<string, number>();
  for (const d of diffs) {
    for (const f of d.touchedFiles) {
      seen.set(f, (seen.get(f) ?? 0) + 1);
      if ((seen.get(f) ?? 0) >= 2) return true;
    }
  }
  return false;
}

// ─── Prompt rendering ───────────────────────────────────────────────────────

/**
 * Path of the canonical cross-roast skill template on the developer
 * machine. Optional — when missing we fall back to a built-in template
 * so the CI / unit tests can run offline.
 */
const SKILL_PATH = join(
  process.env['HOME'] ?? '',
  '.claude',
  'skills',
  'lazing-cross-roast',
  'SKILL.md',
);

const FALLBACK_TEMPLATE = `Du bist der Cross-Roast-Kritiker.

Auftrag: Vergleiche die ${'{laneCount}'} parallelen Diffs für den Step «${'{stepTitle}'}».

Output STRICT JSON:
{
  "outcome": "pass/winner" | "synthesize" | "fail/defenseQueue",
  "winnerLaneId": "<laneId or null>",
  "defenseQueue": ["<laneId>", ...],
  "comments": [ { "role": "cross-roast", "text": "<verbatim>", "severity": "info|minor|major|blocker" } ]
}`;

/**
 * Load the cross-roast template from the developer's ~/.claude/skills
 * folder when present; fall back to the built-in template otherwise.
 *
 * Exported for tests.
 */
export function loadCrossRoastTemplate(): string {
  try {
    if (existsSync(SKILL_PATH)) {
      return readFileSync(SKILL_PATH, 'utf-8');
    }
  } catch {
    /* fall through to fallback */
  }
  return FALLBACK_TEMPLATE;
}

/** Render the prompt. Embeds diffs verbatim (N1). */
export function renderCrossRoastPrompt(input: {
  readonly step: CrossRoastStep;
  readonly diffs: readonly CoderLaneDiff[];
  readonly template?: string;
}): string {
  const tpl = input.template ?? loadCrossRoastTemplate();
  const diffBlocks = input.diffs
    .map(
      (d, i) =>
        `### Diff ${i + 1} — Lane ${d.laneId} (${d.authorLabel})\n\`\`\`diff\n${d.diff}\n\`\`\``,
    )
    .join('\n\n');
  const header = [
    `Step: ${input.step.title}`,
    `Rationale: ${input.step.rationale}`,
    `Parallel-lane count: ${input.diffs.length}`,
    '',
    'Per design must emit a STRICT JSON object per the schema in the template.',
    '',
  ].join('\n');
  return [tpl, '', '---', '', header, diffBlocks].join('\n');
}

// ─── Output parser ──────────────────────────────────────────────────────────

interface RawOutcome {
  readonly outcome?: unknown;
  readonly winnerLaneId?: unknown;
  readonly defenseQueue?: unknown;
  readonly comments?: unknown;
}

function parseOutcome(raw: string): CrossRoastOutcome {
  let body = raw.trim();
  if (body.startsWith('```')) {
    const firstNewline = body.indexOf('\n');
    if (firstNewline !== -1) body = body.slice(firstNewline + 1);
    if (body.endsWith('```')) body = body.slice(0, -3);
    body = body.trim();
  }
  let parsed: RawOutcome;
  try {
    parsed = JSON.parse(body) as RawOutcome;
  } catch (err) {
    throw new Error(
      `cross-roast: invalid JSON outcome: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const comments = normaliseComments(parsed.comments);
  const outcome = parsed.outcome;
  if (outcome === 'pass/winner') {
    if (typeof parsed.winnerLaneId !== 'string' || parsed.winnerLaneId.length === 0) {
      throw new Error('cross-roast: pass/winner requires `winnerLaneId`');
    }
    return { kind: 'pass/winner', winnerLaneId: parsed.winnerLaneId, comments };
  }
  if (outcome === 'synthesize') {
    return { kind: 'synthesize', comments };
  }
  if (outcome === 'fail/defenseQueue') {
    const queue = Array.isArray(parsed.defenseQueue)
      ? (parsed.defenseQueue as unknown[]).filter(
          (q): q is string => typeof q === 'string' && q.length > 0,
        )
      : [];
    return { kind: 'fail/defenseQueue', defenseQueue: queue, comments };
  }
  throw new Error(`cross-roast: unknown outcome value: ${JSON.stringify(outcome)}`);
}

function normaliseComments(raw: unknown): readonly CriticComment[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((c): c is CriticComment => {
      if (typeof c !== 'object' || c === null) return false;
      const obj = c as Record<string, unknown>;
      return (
        typeof obj['role'] === 'string' &&
        typeof obj['text'] === 'string' &&
        typeof obj['severity'] === 'string'
      );
    })
    .map((c) => ({ role: c.role, text: c.text, severity: c.severity })); // N1 verbatim
}

// ─── Orchestrator entrypoint ────────────────────────────────────────────────

export interface CrossRoastResult {
  readonly outcome: CrossRoastOutcome;
  readonly round: CriticRoundRow;
}

/**
 * Run the cross-roast judge. Skips when activation predicate is false
 * — the caller falls back to the single-critic loop.
 *
 * Returns the outcome AND the persisted critic round so the walker
 * can use the round id when narrating progress to the operator.
 */
export async function runCrossRoastCritic(
  input: CrossRoastInput,
): Promise<CrossRoastResult | null> {
  if (!shouldActivateCrossRoast(input.step, input.diffs)) return null;
  const prompt = renderCrossRoastPrompt({ step: input.step, diffs: input.diffs });
  const raw = await input.callEngine(prompt);
  const outcome = parseOutcome(raw);
  // Persist the round under the SAME coordKey as the coder lane (INV-19).
  // The verdict is derived from the cross-roast outcome.
  const verdict =
    outcome.kind === 'pass/winner'
      ? 'pass'
      : outcome.kind === 'synthesize'
        ? 'conditional'
        : 'fail';
  const { row } = input.repo.writeCriticRound({
    planStepId: input.step.id,
    iteration: 0,
    verdict,
    comments: outcome.comments,
    criticRole: 'cross-roast',
    coordKey: input.coordKey,
    workstreamId: input.workstreamId,
  });
  return { outcome, round: row };
}
