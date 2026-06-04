/**
 * SOP Executor — SAR-2 · 2026-05-24.
 *
 * `expandSopToPlanNodes(sop): PlanNode[]`
 *
 * Pure function: converts a SopWithSteps into an array of PlanNode objects
 * (lib/plan-first/recursive-plan.ts). No LLM calls, no DB writes, no side
 * effects. The caller (SAR-3, Wave 2) is responsible for persisting the
 * resulting nodes via workstream_plan_steps.
 *
 * Mapping contract:
 *   sop_step.title            → PlanNode.plan.steps[0].title        (verbatim, N1)
 *   sop_step.step_prompt_template → PlanNode.plan.steps[0].rationale (verbatim, N1)
 *   sop_step.subagent_role    → PlanNode.plan.steps[0].subagentRole
 *   sop_step.step_index       → PlanNode.plan.steps[0].index (1-based)
 *   sop.id + step_index       → PlanNode.id (deterministic, no randomness)
 *   sop.name                  → PlanNode.plan.originalIntent
 *
 * Each SOP step becomes ONE root-level PlanNode (depth=0) with a single
 * contained ProposedPlan step. Children map is always empty — the SOP
 * executor does NOT trigger recursive subplan expansion (that is the
 * recursive-plan.ts concern, Wave 2).
 *
 * N1: stepPromptTemplate is placed in PlanStep.rationale verbatim.
 *     expandSopToPlanNodes NEVER slices, NEVER reformats it.
 * N6: The mapping is deterministic — given the same SopWithSteps input, the
 *     output is always the same array.
 */

import { randomUUID } from "node:crypto";

import type { PlanNode } from "@/lib/plan-first/recursive-plan";
import type { PlanStep, ProposedPlan, PlanSubagentRole } from "@/lib/plan-first/orchestrate-plan";

import type { SopWithSteps } from "./registry";

// ---------------------------------------------------------------------------
// Role coercion
// ---------------------------------------------------------------------------

/**
 * SOP steps may carry 'researcher' or 'scribe' which are not in the
 * PlanSubagentRole union (architect | coder | tester | reviewer).
 * We map the two extras to the nearest PlanSubagentRole:
 *   researcher → (none — leave undefined so the walker can pick freely)
 *   scribe     → (none — leave undefined)
 *   anything else → as-is if it's a valid PlanSubagentRole, else undefined.
 */
const VALID_PLAN_ROLES = new Set<PlanSubagentRole>([
  "architect",
  "coder",
  "tester",
  "reviewer",
]);

function toPlanRole(role: string | null | undefined): PlanSubagentRole | undefined {
  if (!role) return undefined;
  if ((VALID_PLAN_ROLES as Set<string>).has(role)) {
    return role as PlanSubagentRole;
  }
  // researcher + scribe: map to undefined (no plan-role preference)
  return undefined;
}

// ---------------------------------------------------------------------------
// expandSopToPlanNodes
// ---------------------------------------------------------------------------

/**
 * Convert a SopWithSteps into an ordered array of PlanNode objects.
 *
 * - Empty SOP (0 steps) returns [].
 * - Each step becomes exactly one PlanNode at depth=0.
 * - PlanNode.plan contains exactly one PlanStep.
 * - PlanNode.children is always an empty Map.
 * - PlanNode.awaitingApproval is always false (approval handled by caller).
 * - PlanNode.cascadeMode is always 'per-level' (conservative default).
 *
 * The `mintId` parameter is injectable for deterministic testing.
 * Default uses randomUUID() so production code gets unique IDs.
 */
export function expandSopToPlanNodes(
  sop: SopWithSteps,
  opts?: {
    mintId?: () => string;
    now?: () => number;
  },
): PlanNode[] {
  if (sop.steps.length === 0) return [];

  const mintId = opts?.mintId ?? (() => randomUUID());
  const nowMs = opts?.now ?? (() => Date.now());

  // Sort steps by step_index ascending (deterministic, N6).
  const sortedSteps = [...sop.steps].sort((a, b) => a.stepIndex - b.stepIndex);

  return sortedSteps.map((sopStep) => {
    // 1-based index for PlanStep (mirrors orchestrate-plan.ts contract)
    const stepIndex = sopStep.stepIndex + 1;

    const planStep: PlanStep = {
      id: mintId(),
      index: stepIndex,
      // N1: title verbatim from sop_step
      title: sopStep.title,
      // N1: rationale is the FULL step_prompt_template — never sliced
      rationale: sopStep.stepPromptTemplate,
      subagentRole: toPlanRole(sopStep.subagentRole),
    };

    const plan: ProposedPlan = {
      id: mintId(),
      // N1: originalIntent is the SOP name (the SOP is its own intent descriptor)
      originalIntent: sop.name,
      steps: [planStep],
      estimatedComplexity: "M",
      proposedAt: nowMs(),
    };

    const node: PlanNode = {
      id: mintId(),
      step: planStep,
      plan,
      depth: 0,
      cascadeMode: "per-level",
      awaitingApproval: false,
      children: new Map(),
    };

    return node;
  });
}
