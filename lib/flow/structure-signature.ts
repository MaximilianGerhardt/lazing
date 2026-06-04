/**
 * lib/flow/structure-signature.ts — Self-Learning workflow recording, slice 1.
 *
 * Design: docs/plans/2026-06-03_self-learning-workflow-recording-design.md (c).
 *
 * Two pure, deterministic building blocks (N6, in-memory testable, NO DB/net/LLM):
 *
 *   1. computeStructureSignature(steps) — a canonical sha256 signature over the
 *      {skill,toolKind,connector} SEQUENCE of a completed run. Deliberately
 *      TOLERANT: ignores concrete param/config values + labels (those are the
 *      parameters, not the structure). Two reel runs with a different topic →
 *      SAME signature. (Same sha256 principle as N10 contentHash, but over
 *      the FORM instead of the CONTENT.)
 *
 *   2. scoreRepetition(input) — a weighted signal heuristic (model:
 *      lib/plan-first/should-decompose.ts) that decides whether a repeated
 *      run is an SOP candidate. Threshold ≥ 3.
 *
 * Owner wording: „Dieses Self Learning und Repetitors zu erkennen ist absolut
 * wichtig" + „komplexe mehrstufige Workflows". The heuristic therefore fires
 * conservatively only on real repetition (3rd time) AND sufficient complexity.
 */

import { createHash } from 'node:crypto';

/**
 * The fields of a step relevant for the structure signature. Values/configs
 * are deliberately NOT included (those are parameters, not structure).
 */
export interface SignatureStep {
  readonly skill: string | null;
  readonly toolKind: string | null;
  readonly connectorId: string | null;
}

/**
 * Canonical, reproducible structure signature over the step sequence.
 * Fixed key order + fixed step order → deterministic (N6/N10).
 */
export function computeStructureSignature(steps: readonly SignatureStep[]): string {
  const canonical = steps.map((s) => ({
    skill: s.skill ?? null,
    toolKind: s.toolKind ?? null,
    connector: s.connectorId ?? null,
  }));
  const json = JSON.stringify(canonical);
  return 'sha256:' + createHash('sha256').update(json).digest('hex');
}

/** A step counts as a "tool step" if it drives a connector/MCP/tool. */
export function isToolStep(step: SignatureStep): boolean {
  if (step.connectorId && step.connectorId.length > 0) return true;
  const tk = step.toolKind;
  return tk === 'connector' || tk === 'mcp' || tk === 'tool';
}

export interface RepetitionScoreInput {
  /**
   * Number of completions of this signature in the workspace INCLUDING the current
   * run. 3rd run → seenCount = 3.
   */
  readonly seenCount: number;
  /** Number of steps in the run. */
  readonly stepCount: number;
  /** At least one tool/connector/MCP step present? */
  readonly hasToolStep: boolean;
  /** Does a stored template with this signature already exist? (veto) */
  readonly alreadyTemplated: boolean;
  /** Did the current run NOT end successfully? (veto) */
  readonly outcomeFailed: boolean;
}

export interface RepetitionSignal {
  readonly name: string;
  readonly weight: number;
}

export interface RepetitionScore {
  readonly score: number;
  readonly suggest: boolean;
  readonly signals: RepetitionSignal[];
}

/**
 * Threshold for "suggest SOP candidate". Conservative (false negatives preferred),
 * exactly like DECOMPOSE_THRESHOLD in should-decompose.ts.
 */
export const SUGGEST_THRESHOLD = 3;

/**
 * Deterministic repetition scoring.
 *
 * Deviation from the first design (deliberate, documented): the design awarded
 * `seenCount==2 → +1`. That would have suggested already on the
 * 2nd run for a 4-step run with a tool — which contradicts the owner wording "3×". So
 * NOW the strong +2 lever exists only from the 3rd run (`seenCount>=3`); the 2nd run
 * contributes 0. This way the suggestion fires at the earliest on the 3rd identical run, and only
 * if it is "complex multi-step" (length ≥4 OR a tool step).
 */
export function scoreRepetition(input: RepetitionScoreInput): RepetitionScore {
  const signals: RepetitionSignal[] = [];

  if (input.seenCount >= 3) {
    signals.push({ name: 'seen>=3 (3rd run, harter Wiederholungs-Beweis)', weight: 2 });
  }
  if (input.stepCount >= 4) {
    signals.push({ name: 'len>=4 (komplex mehrstufig)', weight: 1 });
  }
  if (input.hasToolStep) {
    signals.push({ name: 'has-tool-step (lohnt als Template)', weight: 1 });
  }
  if (input.alreadyTemplated) {
    signals.push({ name: 'already-templated (Idempotenz-Veto)', weight: -3 });
  }
  if (input.outcomeFailed) {
    signals.push({ name: 'outcome-failed (kein Gelernt aus Fehlschlag)', weight: -2 });
  }

  const score = signals.reduce((acc, s) => acc + s.weight, 0);
  return { score, suggest: score >= SUGGEST_THRESHOLD, signals };
}
