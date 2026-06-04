/**
 * Formal verifier for the workflow FSM (Wave 3b, 2026-05-03).
 *
 * Addresses the "symbolic AI" pillar: workflow definitions are
 * code artefacts, so we can verify them statically instead of hoping at
 * runtime. Algorithms:
 *
 *   1. Reachability via BFS from initialState → unreachable states.
 *   2. Deadlock detection: non-terminal state without outgoing transitions.
 *   3. Race-condition heuristic: multiple parallel-spawn state transitions
 *      that write the same top-level key in `outputSchema`.
 *
 * Pure logic. No DB access. No LLM. No async.
 *
 * CI gate: `pnpm verify:workflows` loads all workflows from the registry
 * + verifies; exit-1 on findings.
 */

import { z } from 'zod';

import type {
  WorkflowDefinition,
  WorkflowState,
  WorkflowTransition,
} from './dsl';

export interface FsmVerifyResult {
  workflowId: string;
  reachable: string[];
  unreachable: string[];
  deadlocks: string[];
  raceConditions: ReadonlyArray<{
    stateA: string;
    stateB: string;
    sharedKey: string;
  }>;
  /** Convenience: whether any finding existed. */
  hasFindings: boolean;
}

const TERMINAL = '__terminal__' as const;

/**
 * Extracts the top-level keys of a Zod schema (ZodObject).
 * For the race-condition heuristic. Other schema types (e.g. ZodEnum)
 * return an empty array.
 */
function extractTopLevelKeys(schema: z.ZodTypeAny | undefined): string[] {
  if (!schema) return [];
  // Zod 4: schema.def.type === 'object' + schema.def.shape (or schema.shape).
  // Zod 3 fallback: schema._def.typeName === 'ZodObject' + schema.shape.
  const anyS = schema as unknown as {
    _def?: { typeName?: string };
    def?: { type?: string; shape?: Record<string, unknown> };
    shape?: Record<string, unknown>;
  };
  const isObjectV4 = anyS.def?.type === 'object';
  const isObjectV3 = anyS._def?.typeName === 'ZodObject';
  if (!isObjectV4 && !isObjectV3) return [];
  const shape = anyS.def?.shape ?? anyS.shape;
  if (!shape || typeof shape !== 'object') return [];
  return Object.keys(shape);
}

function bfs(
  initial: string,
  states: ReadonlyArray<WorkflowState>,
): Set<string> {
  const byId = new Map(states.map((s) => [s.id, s]));
  const reached = new Set<string>();
  const queue: string[] = [];
  if (byId.has(initial)) {
    reached.add(initial);
    queue.push(initial);
  }
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const node = byId.get(cur);
    if (!node) continue;
    for (const t of node.transitions) {
      if (t.to === TERMINAL) continue;
      if (!reached.has(t.to)) {
        reached.add(t.to);
        queue.push(t.to);
      }
    }
  }
  return reached;
}

function findDeadlocks(states: ReadonlyArray<WorkflowState>): string[] {
  const deadlocks: string[] = [];
  for (const s of states) {
    const outgoing = s.transitions.filter((t: WorkflowTransition) => true);
    if (outgoing.length === 0) {
      deadlocks.push(s.id);
      continue;
    }
    // States that only point to __terminal__ are not deadlocks — they are
    // properly terminating. But if all transitions are __terminal__ AND
    // there is no REAL outgoing state, this is an intended end state.
    // We mark only 0-outgoing as a deadlock.
  }
  return deadlocks;
}

function findRaceConditions(
  states: ReadonlyArray<WorkflowState>,
): Array<{ stateA: string; stateB: string; sharedKey: string }> {
  // Heuristic: two states that are reachable in parallel FROM THE SAME source
  // state AND both write the same top-level output keys.
  // This is the only form of "race" that the DSL layer can even
  // express (everything else is a runtime choice).
  const findings: Array<{ stateA: string; stateB: string; sharedKey: string }> = [];
  const byId = new Map(states.map((s) => [s.id, s]));

  for (const src of states) {
    // Collect all target states reachable from src that are non-terminal.
    const targets = src.transitions
      .filter((t: WorkflowTransition) => t.to !== TERMINAL)
      .map((t: WorkflowTransition) => byId.get(t.to))
      .filter((s): s is WorkflowState => !!s);
    if (targets.length < 2) continue;

    for (let i = 0; i < targets.length; i += 1) {
      for (let j = i + 1; j < targets.length; j += 1) {
        const a = targets[i];
        const b = targets[j];
        const aKeys = new Set(extractTopLevelKeys(a.outputSchema));
        const bKeys = extractTopLevelKeys(b.outputSchema);
        for (const k of bKeys) {
          if (aKeys.has(k)) {
            findings.push({ stateA: a.id, stateB: b.id, sharedKey: k });
          }
        }
      }
    }
  }
  return findings;
}

/**
 * Verifies a workflow against 3 classes of defects.
 */
export function verifyFsm(workflow: WorkflowDefinition): FsmVerifyResult {
  const allIds = workflow.states.map((s) => s.id);
  const reached = bfs(workflow.initialState, workflow.states);
  const reachable = allIds.filter((id) => reached.has(id));
  const unreachable = allIds.filter((id) => !reached.has(id));
  const deadlocks = findDeadlocks(workflow.states);
  const raceConditions = findRaceConditions(workflow.states);

  return {
    workflowId: workflow.id,
    reachable,
    unreachable,
    deadlocks,
    raceConditions,
    hasFindings:
      unreachable.length > 0 ||
      deadlocks.length > 0 ||
      raceConditions.length > 0,
  };
}
