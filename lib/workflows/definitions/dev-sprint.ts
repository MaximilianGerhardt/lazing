/**
 * `dev-sprint` — codified sprint workflow for lazyos own work
 * + demo-fitness + other AI-driven sprints.
 *
 * 7 states: plan → critic → consolidate → impl-spawn → review → deploy-gate
 *           → closeout (→ __terminal__)
 *
 * Methodology (Critic-VETO-3 addressed):
 *   - plan         : architecture LLM produces planV1 (free-inference)
 *   - critic       : 2-3 roasters with a fixed prompt produce roastTexts
 *   - consolidate  : architecture LLM merges roastTexts into planV2
 *   - impl-spawn   : DETERMINISTIC — spawner splits planV2 into sub-tickets,
 *                    no LLM inference here
 *   - review       : code-review LLM with a fixed prompt → reviewVerdict
 *   - deploy-gate  : DETERMINISTIC — manualOverride='forbid', requires
 *                    reviewVerdict='pass' AND deployApproved=true
 *   - closeout     : DETERMINISTIC — close tickets, transition to terminal
 *
 * Pre/post conditions are pure functions over `ctx.data`. The real LLM
 * execution does NOT happen in the runner (which is deterministic) but via
 * the tier-orchestrator integration in a later wave — the runner only returns
 * the state + prompt + schema. The first wave has no UI/no spawn hooks, i.e.
 * the conditions are satisfied directly via `ctx.data` mutation in the test.
 */

import { z } from 'zod';

import type { StateContext, WorkflowDefinition, WorkflowState } from '../dsl';

// --------------------------------------------------------------------------
// State IDs as a const tuple → type-safe `findState`.
// --------------------------------------------------------------------------

export const DEV_SPRINT_STATE_IDS = [
  'plan',
  'critic',
  'consolidate',
  'impl-spawn',
  'review',
  'deploy-gate',
  'closeout',
] as const;

export type DevSprintStateId = (typeof DEV_SPRINT_STATE_IDS)[number];

// --------------------------------------------------------------------------
// Output schemas per LLM slot. The first wave uses them only for TS typing —
// validate-on-write comes in a later wave.
// --------------------------------------------------------------------------

export const PlanV1Schema = z.object({
  goal: z.string().min(1),
  scope: z.array(z.string()).min(1),
  outOfScope: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
  assumptions: z.array(z.string()).default([]),
});

export const RoastTextSchema = z.object({
  roaster: z.string(),
  weakness: z.string().min(1),
  proposedFix: z.string().optional(),
});

export const PlanV2Schema = PlanV1Schema.extend({
  addressedRoasts: z.array(z.string()).default([]),
});

export const ReviewVerdictSchema = z.enum(['pass', 'fail']);

// --------------------------------------------------------------------------
// Helpers for preCondition reads.
// --------------------------------------------------------------------------

function has(data: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(data, key) && data[key] !== undefined && data[key] !== null;
}

function arrayHasItems(data: Record<string, unknown>, key: string): boolean {
  const v = data[key];
  return Array.isArray(v) && v.length > 0;
}

// --------------------------------------------------------------------------
// State definitions
// --------------------------------------------------------------------------

const planState: WorkflowState<DevSprintStateId> = {
  id: 'plan',
  label: 'Plan V1',
  llmSlot: 'free-inference',
  skillBinding: 'skill-architecture',
  promptTemplate: (ctx: StateContext) =>
    `You are planning a sprint for workspace ${ctx.workspaceId}.\n` +
    `Goal from data: ${JSON.stringify(ctx.data.brief ?? '(no brief)')}\n\n` +
    `Deliver planV1 with goal/scope/outOfScope/risks/assumptions.`,
  outputSchema: PlanV1Schema,
  preConditions: [],
  postConditions: [
    {
      id: 'planV1-present',
      label: 'planV1 must be present in data',
      check: (ctx) => has(ctx.data, 'planV1'),
    },
  ],
  transitions: [
    {
      to: 'critic',
      label: 'planV1 produced → roast',
    },
  ],
  manualOverride: 'allow',
};

const criticState: WorkflowState<DevSprintStateId> = {
  id: 'critic',
  label: 'Critic-Roast',
  llmSlot: 'fixed-prompt',
  skillBinding: 'skill-critic',
  promptTemplate: (ctx: StateContext) =>
    `Roast this plan from 5 perspectives (user, hacker, competitor, lawyer, performance).\n\n` +
    `PlanV1: ${JSON.stringify(ctx.data.planV1 ?? null)}\n\n` +
    `Deliver an array roastTexts with roaster + weakness + proposedFix?`,
  outputSchema: z.array(RoastTextSchema).min(1),
  preConditions: [
    {
      id: 'planV1-required',
      label: 'planV1 must be present from the plan state',
      check: (ctx) => has(ctx.data, 'planV1'),
    },
  ],
  postConditions: [
    {
      id: 'roastTexts-present',
      label: 'roastTexts must be a non-empty array',
      check: (ctx) => arrayHasItems(ctx.data, 'roastTexts'),
    },
  ],
  transitions: [
    {
      to: 'consolidate',
      label: 'roasts present → consolidate',
    },
  ],
  manualOverride: 'allow',
};

const consolidateState: WorkflowState<DevSprintStateId> = {
  id: 'consolidate',
  label: 'Consolidate planV2',
  llmSlot: 'free-inference',
  skillBinding: 'skill-architecture',
  promptTemplate: (ctx: StateContext) =>
    `Merge the roasts into an improved planV2.\n\n` +
    `PlanV1: ${JSON.stringify(ctx.data.planV1 ?? null)}\n` +
    `Roasts: ${JSON.stringify(ctx.data.roastTexts ?? null)}\n\n` +
    `Deliver planV2 with an addressedRoasts list (which weaknesses were addressed).`,
  outputSchema: PlanV2Schema,
  preConditions: [
    {
      id: 'roastTexts-required',
      label: 'roastTexts must be present from the critic state',
      check: (ctx) => arrayHasItems(ctx.data, 'roastTexts'),
    },
  ],
  postConditions: [
    {
      id: 'planV2-present',
      label: 'planV2 must be present in data',
      check: (ctx) => has(ctx.data, 'planV2'),
    },
  ],
  transitions: [
    {
      to: 'impl-spawn',
      label: 'planV2 final → spawn impl tickets',
    },
  ],
  manualOverride: 'allow',
};

const implSpawnState: WorkflowState<DevSprintStateId> = {
  id: 'impl-spawn',
  label: 'Spawn Implementation Tickets',
  llmSlot: 'none',
  skillBinding: null,
  preConditions: [
    {
      id: 'planV2-required',
      label: 'planV2 must be present from the consolidate state',
      check: (ctx) => has(ctx.data, 'planV2'),
    },
  ],
  postConditions: [
    {
      id: 'implTickets-present',
      label: 'implTickets must be non-empty',
      check: (ctx) => arrayHasItems(ctx.data, 'implTickets'),
    },
  ],
  transitions: [
    {
      to: 'review',
      label: 'tickets spawned → wait for review',
    },
  ],
  manualOverride: 'allow',
};

const reviewState: WorkflowState<DevSprintStateId> = {
  id: 'review',
  label: 'Code-Review',
  llmSlot: 'fixed-prompt',
  skillBinding: 'skill-architecture',
  promptTemplate: (ctx: StateContext) =>
    `Code review for this sprint's tickets.\n\n` +
    `ImplTickets: ${JSON.stringify(ctx.data.implTickets ?? null)}\n\n` +
    `Deliver reviewVerdict: 'pass' if all tickets are clean, otherwise 'fail'.`,
  outputSchema: ReviewVerdictSchema,
  preConditions: [
    {
      id: 'implTickets-required',
      label: 'implTickets must be present',
      check: (ctx) => arrayHasItems(ctx.data, 'implTickets'),
    },
  ],
  postConditions: [
    {
      id: 'reviewVerdict-present',
      label: 'reviewVerdict must be pass|fail',
      check: (ctx) => {
        const v = ctx.data.reviewVerdict;
        return v === 'pass' || v === 'fail';
      },
    },
  ],
  transitions: [
    {
      to: 'deploy-gate',
      condition: (ctx) => ctx.data.reviewVerdict === 'pass',
      label: 'review pass → deploy-gate',
    },
    {
      to: 'critic',
      condition: (ctx) => ctx.data.reviewVerdict === 'fail',
      label: 'review fail → back to critic',
    },
  ],
  manualOverride: 'allow',
};

const deployGateState: WorkflowState<DevSprintStateId> = {
  id: 'deploy-gate',
  label: 'Deploy-Gate',
  llmSlot: 'none',
  skillBinding: null,
  preConditions: [
    {
      id: 'review-pass-required',
      label: 'reviewVerdict must be pass',
      check: (ctx) => ctx.data.reviewVerdict === 'pass',
    },
  ],
  postConditions: [
    {
      id: 'deploy-approved',
      label: 'deployApproved must be true (manually or via an auto rule)',
      check: (ctx) => ctx.data.deployApproved === true,
    },
  ],
  transitions: [
    {
      to: 'closeout',
      label: 'deploy approved → closeout',
    },
  ],
  manualOverride: 'forbid',
};

const closeoutState: WorkflowState<DevSprintStateId> = {
  id: 'closeout',
  label: 'Closeout',
  llmSlot: 'none',
  skillBinding: null,
  preConditions: [
    {
      id: 'deploy-approved-required',
      label: 'deployApproved must be true (comes from the deploy-gate)',
      check: (ctx) => ctx.data.deployApproved === true,
    },
  ],
  postConditions: [
    {
      id: 'closeout-done',
      label: 'closeoutDone must be true (the spawner sets it)',
      check: (ctx) => ctx.data.closeoutDone === true,
    },
  ],
  transitions: [
    {
      to: '__terminal__',
      label: 'closeout done → terminal',
    },
  ],
  manualOverride: 'allow',
};

export const devSprintWorkflow: WorkflowDefinition<DevSprintStateId> = {
  id: 'dev-sprint',
  version: 'v1',
  label: 'Demo Fitness Sprint (lazyos methodology)',
  description:
    '7-step sprint methodology: plan → critic → consolidate → impl-spawn → ' +
    'review → deploy-gate → closeout. LLM slots in plan/critic/consolidate/' +
    'review, deterministic states in impl-spawn/deploy-gate/closeout. ' +
    'deploy-gate is forbidden-override: no skip without review=pass.',
  initialState: 'plan',
  states: [
    planState,
    criticState,
    consolidateState,
    implSpawnState,
    reviewState,
    deployGateState,
    closeoutState,
  ],
  triggerHints: [
    'sprint',
    'dev-sprint',
    'plan→critic→build',
    'lazyos-sprint',
  ],
};
