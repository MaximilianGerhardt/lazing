/**
 * Workflow DSL — Pattern 4 foundation (2026-05-01).
 *
 * Addresses Critic-VETO-3 ("Sniper loop is not the moat. The methodology is a
 * markdown prompt wall, not code") + Anne (Legaly-AI): codified domain
 * workflows as deterministic steps, LLM only where unstructured
 * inference is needed.
 *
 * Design principles:
 *   - States are first-class TS values (no magic strings).
 *   - Pre/post conditions are pure async functions that read the DB or
 *     check `ctx.data` — testable in isolation.
 *   - LLM slots are explicitly typed (`none` / `fixed-prompt` / `free-inference`).
 *     `none` = deterministic code step (e.g. spawner). `fixed-prompt` =
 *     LLM with a template prompt + output schema. `free-inference` = open
 *     answer, only the output schema applies.
 *   - Transitions are explicit with an optional `condition`. Without a condition =
 *     unconditional follow-up if postConditions are ok.
 *   - `manualOverride: 'forbid'` = gate that even the operator may not skip
 *     (e.g. a deploy gate without a review pass).
 *
 * Out-of-scope of this wave (comes in a sub-sprint):
 *   - UI layer (Wave 2)
 *   - tier-orchestrator integration (Wave 3)
 *   - /api/workflows routes (Wave 2)
 */

import { z } from 'zod';

export type WorkflowId =
  | 'dev-sprint'
  | 'field-measurement'
  | 'legal-brief'
  | 'design-gate-flow'
  | 'legal-correspondence';

export type LlmSlotKind = 'none' | 'fixed-prompt' | 'free-inference';

export interface StateContext {
  workstreamId: string;
  workspaceId: string;
  data: Record<string, unknown>;
}

export interface WorkflowCondition {
  id: string;
  label: string;
  check: (ctx: StateContext) => Promise<boolean> | boolean;
}

export interface WorkflowTransition<TStateId extends string = string> {
  to: TStateId | '__terminal__';
  condition?: (ctx: StateContext) => Promise<boolean> | boolean;
  label: string;
}

export interface WorkflowState<TStateId extends string = string> {
  id: TStateId;
  label: string;
  llmSlot: LlmSlotKind;
  skillBinding: string | null;
  promptTemplate?: (ctx: StateContext) => string;
  outputSchema?: z.ZodTypeAny;
  preConditions: ReadonlyArray<WorkflowCondition>;
  postConditions: ReadonlyArray<WorkflowCondition>;
  transitions: ReadonlyArray<WorkflowTransition<TStateId>>;
  manualOverride: 'allow' | 'forbid';
}

export interface WorkflowDefinition<TStateId extends string = string> {
  id: WorkflowId;
  version: 'v1' | 'v2' | 'v3';
  label: string;
  description: string;
  initialState: TStateId;
  states: ReadonlyArray<WorkflowState<TStateId>>;
  triggerHints: ReadonlyArray<string>;
  deprecated?: boolean;
}

// --------------------------------------------------------------------------
// Persisted run — read/written by store.ts.
// --------------------------------------------------------------------------

export type WorkflowRunStatus = 'running' | 'stuck' | 'completed' | 'aborted';

export interface WorkflowRun {
  id: string;
  workflowId: WorkflowId;
  definitionVersion: 'v1' | 'v2' | 'v3';
  workspaceId: string | null;
  workstreamId: string | null;
  currentState: string;
  data: Record<string, unknown>;
  status: WorkflowRunStatus;
  createdAt: number;
  updatedAt: number;
  lastTransitionAt: number;
}

// --------------------------------------------------------------------------
// Helper: type-safe state lookup.
// --------------------------------------------------------------------------

export function findState<TStateId extends string>(
  def: WorkflowDefinition<TStateId>,
  id: string,
): WorkflowState<TStateId> | null {
  return def.states.find((s) => s.id === id) ?? null;
}
