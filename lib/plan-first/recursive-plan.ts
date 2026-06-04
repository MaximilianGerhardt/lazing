// Recursive Plan-in-Plan proposer.
//
// BACKPORT-03 von Lazing-V2 (2026-05-23 · Agent 3/8). Quelle:
// lazing-wt/realtime-orchestrator-v2/apps/web/src/lib/plan-first/
// recursive-plan.ts (271 LOC, V2 Slice C).
//
// Wraps `proposePlan` (orchestrate-plan.ts) with a two-tier eagerness
// model:
//
//   - depth-1 eager: every complex step of the root plan eagerly spawns
//     its own subplan up front so the operator can review the full
//     near-term scope in one approval gate.
//   - depth ≥ 2 lazy: deeper subplans are only proposed when the walker
//     actually starts the parent step (cf. `subplanTrigger`). This keeps
//     the cold-start surface small + matches operator behaviour: most
//     subplans never need a sub-subplan.
//
// Cascade vs per-level:
//   - `cascade`     : the operator pre-approves all recursion; the walker
//                     auto-approves every nested subplan.
//   - `per-level`   : each subplan needs its own approval gate before
//                     the walker descends.
//
// Hard cap at MAX_SUBPLAN_DEPTH (= 3). Beyond that the walker stops
// proposing subplans and the operator must `promoteSubplan` to start
// a fresh recursion.
//
// Discipline:
//   - N1: every proposed step's `title` + `rationale` is verbatim from
//     either an LLM emission (`proposePlan`) or a template
//     (`matchTemplate` → `templateToProposedPlan`). No reformatting.
//   - N6: the `subplanTrigger` predicate is deterministic — given the
//     same step + depth it always returns the same answer.
//   - N11: depth-1 eager spawning is bounded by the LLM/template
//     truncation cap (MAX_STEPS = 7 in `parseProposedPlan`).

import { randomUUID } from 'node:crypto';

import {
  parseProposedPlan,
  proposePlan,
  type PlanStep,
  type ProposedPlan,
} from './orchestrate-plan';
import { matchTemplate, templateToProposedPlan } from './templates';

/** INV — MAX_SUBPLAN_DEPTH hard cap. Mirrors V2's @lazing/runtime export. */
export const MAX_SUBPLAN_DEPTH = 3 as const;

export type CascadeMode = 'cascade' | 'per-level';

/**
 * A node in the recursive plan tree.
 *
 * - `step`     : the parent step this node represents (null on the root).
 * - `plan`     : the proposed plan AT this depth.
 * - `depth`    : 0..MAX_SUBPLAN_DEPTH inclusive.
 * - `children` : map keyed by step.id; only present for steps that have
 *                an eagerly-proposed (depth 1) or already-expanded (depth ≥ 2)
 *                subplan.
 * - `awaitingApproval`: true when `cascadeMode === 'per-level'` and the
 *                operator hasn't approved this node yet.
 */
export interface PlanNode {
  readonly id: string;
  readonly step: PlanStep | null;
  readonly plan: ProposedPlan;
  readonly depth: number;
  readonly cascadeMode: CascadeMode;
  readonly awaitingApproval: boolean;
  readonly children: ReadonlyMap<string, PlanNode>;
}

export interface RecursivePlan {
  readonly root: PlanNode;
  readonly cascadeMode: CascadeMode;
  /** Hard depth ceiling; mirrors `MAX_SUBPLAN_DEPTH` for caller convenience. */
  readonly maxDepth: number;
}

export interface ProposeRecursivePlanOpts {
  readonly cascadeMode?: CascadeMode;
  /** Bound the proposer; defaults to MAX_SUBPLAN_DEPTH (3). */
  readonly maxDepth?: number;
  /** Caller-supplied LLM engine. Mirrors `proposePlan`'s contract. */
  readonly callEngine: (prompt: string) => Promise<string>;
  /**
   * Optional template override. When provided, the proposer uses it
   * INSTEAD of calling the LLM for the root plan. Useful when the
   * intent matches a canonical template (the route should call
   * `matchTemplate` upfront and pass the result in).
   */
  readonly rootTemplate?: ProposedPlan;
  readonly mintId?: () => string;
  readonly now?: () => number;
  /**
   * E1 — Self-Learning / WARUM-Engine (2026-05-27). Ein bereits gerenderter
   * WARUM-Block (lib/reasoning/why-context.ts::renderWhyContextForPrompt) mit
   * früheren Begründungen + aktiven Beliefs dieses Workspace. Wird unverändert
   * an `proposePlan` durchgereicht — und zwar auf JEDER rekursiven Ebene
   * (Root-Plan + jeder eager/lazy Subplan): frühere Begründungen gelten für den
   * GANZEN Plan-Baum, nicht nur die Wurzel. So startet auch der rekursive
   * Plan-Walker nicht amnesisch.
   *
   * KEINE DB-Kopplung (E1.2): dieses Modul liest NIE selbst — der String kommt
   * fertig vom Caller (der das workspace-gescopte Read-Back besitzt, N9). Es wird
   * KEIN Re-Build pro Ebene gemacht; derselbe String wird weitergereicht.
   *
   * Fehlt der Parameter ODER ist er leer/whitespace (E1.3), ist der an die
   * Engine gereichte Prompt auf jeder Ebene BIT-IDENTISCH zu vorher — bestehende
   * Caller/Tests bleiben unverändert (proposePlan kappt leeren whyContext selbst).
   */
  readonly whyContext?: string;
}

/**
 * The walker / proposer's predicate: "should this step spawn a
 * subplan?" Deterministic (N6) — no LLM call, no I/O.
 *
 * Returns true when:
 *   1. The current `depth` is strictly less than `MAX_SUBPLAN_DEPTH`.
 *   2. The step's `subagentRole` is `architect` or `coder` (testers /
 *      reviewers don't generate subplans — they're terminal lanes).
 *   3. The step's `title` or `rationale` is verbose enough to indicate
 *      multi-step work (length > 60 chars OR contains a "feature-scope"
 *      noun: feature, system, service, migration, architecture).
 */
export function subplanTrigger(step: PlanStep, depth: number): boolean {
  if (depth >= MAX_SUBPLAN_DEPTH) return false;
  const role = step.subagentRole;
  if (role !== 'architect' && role !== 'coder' && role !== undefined) {
    return false;
  }
  const combined = `${step.title} ${step.rationale}`;
  if (combined.length > 60) return true;
  if (/\b(feature|system|service|migration|architektur|architecture|module|modul)\b/i.test(combined)) {
    return true;
  }
  return false;
}

function makeId(opts: ProposeRecursivePlanOpts): string {
  return (opts.mintId ?? (() => randomUUID()))();
}

function now(opts: ProposeRecursivePlanOpts): number {
  return (opts.now ?? (() => Date.now()))();
}

/**
 * Build a fresh subplan for `parentStep`. Used both by the eager
 * depth-1 pass and by the walker's lazy descent.
 *
 * Tries a template first (regex match against the step's title +
 * rationale), then falls back to the LLM (`proposePlan`).
 */
async function proposeSubplanFor(
  parentStep: PlanStep,
  depth: number,
  opts: ProposeRecursivePlanOpts,
): Promise<ProposedPlan> {
  void depth;
  const intentText = `${parentStep.title} — ${parentStep.rationale}`;
  const templateMatch = matchTemplate(intentText);
  if (templateMatch !== null) {
    return templateToProposedPlan(
      templateMatch,
      intentText,
      () => makeId(opts),
      () => now(opts),
    );
  }
  const sub = await proposePlan(intentText, opts.callEngine, {
    mintId: () => makeId(opts),
    now: () => now(opts),
    // E1: derselbe WARUM-Block gilt für jede Subplan-Ebene (kein Re-Build).
    // Fehlt/leer ⇒ proposePlan stellt nichts voran ⇒ bit-identischer Prompt.
    ...(opts.whyContext ? { whyContext: opts.whyContext } : {}),
  });
  // Defense in depth: if the LLM somehow returned an empty list we
  // re-parse a fallback so downstream code never sees a 0-step plan.
  if (sub.steps.length === 0) {
    return parseProposedPlan(
      JSON.stringify({
        estimatedComplexity: 'M',
        steps: [{ index: 1, title: parentStep.title, rationale: parentStep.rationale }],
      }),
      intentText,
      () => makeId(opts),
      () => now(opts),
    );
  }
  return sub;
}

/**
 * Build the recursive plan.
 *
 * Algorithm:
 *   1. Mint the ROOT plan — template-first, LLM-fallback.
 *   2. Eagerly walk every root step: if `subplanTrigger(step, 1)` fires,
 *      mint a depth-1 subplan immediately. (Subplans deeper than 1 are
 *      proposed lazily by the walker.)
 *   3. Tag each subplan with `awaitingApproval` per cascade mode.
 */
export async function proposeRecursivePlan(
  rootIntent: string,
  opts: ProposeRecursivePlanOpts,
): Promise<RecursivePlan> {
  const cascadeMode: CascadeMode = opts.cascadeMode ?? 'per-level';
  const maxDepth = Math.min(opts.maxDepth ?? MAX_SUBPLAN_DEPTH, MAX_SUBPLAN_DEPTH);

  // 1. Root plan — operator's intent goes in verbatim.
  const root: ProposedPlan =
    opts.rootTemplate ??
    (await (async () => {
      const t = matchTemplate(rootIntent);
      if (t !== null) {
        return templateToProposedPlan(
          t,
          rootIntent,
          () => makeId(opts),
          () => now(opts),
        );
      }
      return proposePlan(rootIntent, opts.callEngine, {
        mintId: () => makeId(opts),
        now: () => now(opts),
        // E1: WARUM-Block auch dem Root-Plan voranstellen (s. proposeSubplanFor).
        ...(opts.whyContext ? { whyContext: opts.whyContext } : {}),
      });
    })());

  // 2. Eager depth-1 expansion.
  const children = new Map<string, PlanNode>();
  if (maxDepth >= 1) {
    for (const step of root.steps) {
      if (!subplanTrigger(step, 1)) continue;
      const subPlan = await proposeSubplanFor(step, 1, opts);
      const node: PlanNode = {
        id: makeId(opts),
        step,
        plan: subPlan,
        depth: 1,
        cascadeMode,
        awaitingApproval: cascadeMode === 'per-level',
        children: new Map(),
      };
      children.set(step.id, node);
    }
  }

  const rootNode: PlanNode = {
    id: makeId(opts),
    step: null,
    plan: root,
    depth: 0,
    cascadeMode,
    awaitingApproval: false, // root approval is the existing approve-plan flow
    children,
  };

  return {
    root: rootNode,
    cascadeMode,
    maxDepth,
  };
}

/**
 * Lazy subplan proposer — called by the walker when it actually starts
 * a step that needs deeper recursion. Returns null when the depth cap
 * is reached or the trigger predicate says "don't recurse here".
 */
export async function proposeLazySubplan(
  parentStep: PlanStep,
  depth: number,
  opts: ProposeRecursivePlanOpts,
): Promise<ProposedPlan | null> {
  if (!subplanTrigger(parentStep, depth)) return null;
  return proposeSubplanFor(parentStep, depth, opts);
}
