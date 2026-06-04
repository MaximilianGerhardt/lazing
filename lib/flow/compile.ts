/**
 * Flow → plan-steps compiler — Flow Studio P1 · 2026-05-27.
 *
 * Source: docs/plans/2026-05-27_flow-studio-architecture.md §1 + §6.
 *
 * `compileFlowToPlanSteps` is a PURE function (NO DB, NO I/O, no
 * LLM): it converts a flow_template + its flow_steps into an ordered
 * list of CompiledPlanStep — exactly the structure that (P2) the
 * plan-executor/tier-orchestrator is later fed (analogous to
 * db/schema/workstream_plan_steps.ts + lib/plan-first/orchestrate-plan.ts:
 * PlanStep). Substrate discipline (N4): NO new execution engine — the
 * compiler delivers only the transformation; the wiring in
 * insertProposedPlan()/plan-executor is P2.
 *
 * What the compiler does:
 *   1. Topological sort of the flow_steps by `dependsOnJson` (DAG edges).
 *      Deterministic: among equal-rank candidates the smaller
 *      `idx` wins, then the source order (stable). → Kahn's algorithm.
 *   2. Cycle detection: if a cycle exists, the topological order is
 *      impossible. Default: THROW an error (FlowCycleError) — the "standard"
 *      must be acyclic (n8n/make semantics). With `{ onCycle: 'sequential' }`
 *      there is a documented fallback: the steps are chained purely by idx
 *      sequentially (each hangs on the predecessor) and depends_on is
 *      REPLACED by the linear chain (the cyclic edges are discarded).
 *   3. Skill → role mapping: flow_steps.skill (role-skill-map key, e.g.
 *      'coder'/'architect' or domain 'Copy'/'Design'/'Aufbau') is mapped to a
 *      PlanSubagentRole ('architect'|'coder'|'tester'|'reviewer').
 *   4. tool_kind / connector_id / config are PASSED THROUGH (for P2: the
 *      executor couples the connector/MCP/engine call from them).
 *   5. depends_on is PRESERVED (as step IDs) → the parallel executor builds
 *      the ready queue from it (migration 0110 workstream_plan_steps.depends_on).
 */

import type { PlanSubagentRole } from "@/lib/plan-first/orchestrate-plan";
import type { FlowStep, FlowTemplate } from "./templates-repo";
import {
  interpolateConfigJson,
  interpolateParams,
  type ParamValues,
} from "./interpolate";

// ---------------------------------------------------------------------------
// Output type — the plan-step structure that is compiled into.
// Mirrors PlanStep (lib/plan-first/orchestrate-plan.ts) + the orchestration
// metadata from workstream_plan_steps (depends_on, tool fields). NO DB IDs/
// hashes — those are stamped by the P2 wiring (insertPlanStep) on persisting.
// ---------------------------------------------------------------------------

export interface CompiledPlanStep {
  /** Stable step ID (= flow_steps.id) so depends_on stays referenceable. */
  readonly id: string;
  /** 0-based position in topological order. */
  readonly index: number;
  /** N1: verbatim from flow_steps.label (fallback: skill / id). */
  readonly title: string;
  /** Short rationale (synthetic, deterministic — NO LLM). */
  readonly rationale: string;
  /** Mapped subagent role (closed enum) OR null for free-form/tool-only. */
  readonly subagentRole: PlanSubagentRole | null;
  /** Original skill key from the flow step (passed through for the P2 engine choice). */
  readonly skill: string | null;
  /** null | 'connector' | 'mcp' | 'engine' — passed through. */
  readonly toolKind: string | null;
  /** Soft FK to connectors.id — passed through. */
  readonly connectorId: string | null;
  /** Step parameter JSON — passed through (verbatim). */
  readonly configJson: string | null;
  /** Predecessor step IDs (DAG edges), PRESERVED for the parallel executor. */
  readonly dependsOn: readonly string[];
}

export interface CompileOptions {
  /**
   * Behavior on a cycle in the depends_on graph.
   *   'error' (default) → throws FlowCycleError.
   *   'sequential'      → documented fallback: chain steps linearly purely by idx
   *                       (cyclic edges discarded).
   */
  readonly onCycle?: "error" | "sequential";
  /**
   * Slice 2 (2026-06-03): parameter values for the runtime interpolation of
   * `{{param.<key>}}` in step label + configJson. Missing/empty → no
   * interpolation (today's behavior, no regression). N1: the stored
   * template stays verbatim, only the compiled plan steps are materialized.
   */
  readonly params?: ParamValues;
}

export class FlowCycleError extends Error {
  /** The step IDs that remain in the (residual) cycle. */
  readonly cycleStepIds: readonly string[];
  constructor(cycleStepIds: readonly string[]) {
    super(
      `compileFlowToPlanSteps: cycle detected among flow_steps [${cycleStepIds.join(
        ", ",
      )}] — a flow template must be acyclic (DAG). Pass { onCycle: 'sequential' } for a linear fallback.`,
    );
    this.name = "FlowCycleError";
    this.cycleStepIds = cycleStepIds;
  }
}

// ---------------------------------------------------------------------------
// Skill → role mapping.
//
// flow_steps.skill is a role-skill-map key (lib/agents/role-skill-map.ts:
// architect|coder|tester|reviewer|security|perf|…) OR a domain skill
// from the Flow-Studio composer (§1: "Aufbau/Copy/Design/…"). We map to
// the CLOSED PlanSubagentRole set ('architect'|'coder'|'tester'|
// 'reviewer') that the plan-executor understands. Default for unknown/tool-
// only: 'coder' (the generic execution worker) — except when the step carries
// no skill AND is tool-only, then null (free-form, the engine decides).
// ---------------------------------------------------------------------------

const SKILL_ROLE_MAP: Readonly<Record<string, PlanSubagentRole>> = {
  // direct role-skill-map keys
  architect: "architect",
  coder: "coder",
  tester: "tester",
  reviewer: "reviewer",
  security: "reviewer",
  perf: "reviewer",
  researcher: "architect",
  planner: "architect",
  // domain Flow-Studio skills (§1 examples + obvious ones)
  aufbau: "architect",
  design: "architect",
  // PV stringing (BAHN-2 · 2026-05-30): the deterministic producer step
  // (lib/eval/demo-pv/producer.ts) is a file/artefact worker →
  // 'coder'. The plan-executor recognizes the skill (via parseFlowAnnotation from
  // the rationale) AND intercepts it BEFORE the generic coder spawn: it calls
  // produceStringingPlan instead of a claude-cli worktree spawn.
  "pv-stringing": "coder",
  // W1.2 (2026-05-30): the final assembly step (builds index.html from all
  // fragments) is a generic file worker → coder.
  assembly: "coder",
  copy: "coder",
  content: "coder",
  build: "coder",
  test: "tester",
  qa: "tester",
  review: "reviewer",
};

/**
 * Maps a flow-step skill to a PlanSubagentRole.
 * Exported for the compile test (skill→role mapping is part of the gate).
 *
 * @returns the mapped role OR null for tool-only/empty skill.
 */
export function mapSkillToRole(
  skill: string | null,
  toolKind: string | null,
): PlanSubagentRole | null {
  if (skill == null || skill.trim().length === 0) {
    // No skill: tool-only node → free-form (the engine decides) → null.
    return null;
  }
  const key = skill.trim().toLowerCase();
  const mapped = SKILL_ROLE_MAP[key];
  if (mapped) return mapped;
  // Unknown but set skill → generic execution worker.
  // (toolKind is only context here; a pure tool step without a skill lands above.)
  void toolKind;
  return "coder";
}

// ---------------------------------------------------------------------------
// depends_on parsing — tolerates JSON array string, null, empty.
// ---------------------------------------------------------------------------

function parseDependsOn(dependsOnJson: string | null): string[] {
  if (dependsOnJson == null || dependsOnJson.trim().length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(dependsOnJson);
    if (Array.isArray(parsed)) {
      return parsed.filter((x): x is string => typeof x === "string");
    }
    return [];
  } catch {
    // Defensive: broken JSON is treated as "no dependencies".
    return [];
  }
}

// ---------------------------------------------------------------------------
// Compiler
// ---------------------------------------------------------------------------

/**
 * PURE: flow template + steps → topologically ordered CompiledPlanSteps.
 *
 * @param template the flow_template (scope/metadata; currently passed through
 *                 only for docs + future scope inheritance — does not affect the
 *                 order).
 * @param steps    the flow_steps of this template.
 * @param opts     { onCycle: 'error' | 'sequential' } (default 'error').
 */
export function compileFlowToPlanSteps(
  template: FlowTemplate,
  steps: readonly FlowStep[],
  opts: CompileOptions = {},
): CompiledPlanStep[] {
  void template; // currently not order-relevant; deliberately passed through.
  const onCycle = opts.onCycle ?? "error";

  if (steps.length === 0) return [];

  // Stable source order: by idx, then by input index (tie-break).
  const ordered = steps
    .map((s, srcIdx) => ({ step: s, srcIdx }))
    .sort((a, b) =>
      a.step.idx !== b.step.idx ? a.step.idx - b.step.idx : a.srcIdx - b.srcIdx,
    );

  const idSet = new Set(ordered.map((o) => o.step.id));
  // Parse raw edges; count only edges to existing steps (dangling
  // depends_on to deleted steps are ignored — NO invented nodes).
  const depsById = new Map<string, string[]>();
  for (const { step } of ordered) {
    const deps = parseDependsOn(step.dependsOnJson).filter(
      (d) => d !== step.id && idSet.has(d),
    );
    depsById.set(step.id, deps);
  }

  // --- Kahn's algorithm (deterministic) ---------------------------------
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>(); // dep → [steps that need it]
  for (const { step } of ordered) {
    indegree.set(step.id, 0);
    dependents.set(step.id, []);
  }
  for (const { step } of ordered) {
    for (const dep of depsById.get(step.id)!) {
      indegree.set(step.id, (indegree.get(step.id) ?? 0) + 1);
      dependents.get(dep)!.push(step.id);
    }
  }

  // Position in `ordered` as a deterministic tie-break for the ready queue.
  const posById = new Map<string, number>();
  ordered.forEach((o, i) => posById.set(o.step.id, i));

  const sortedIds: string[] = [];
  // ready = indegree 0, sorted by source position (idx, srcIdx).
  const ready = ordered
    .filter((o) => (indegree.get(o.step.id) ?? 0) === 0)
    .map((o) => o.step.id);
  ready.sort((a, b) => (posById.get(a)! - posById.get(b)!));

  while (ready.length > 0) {
    const id = ready.shift()!;
    sortedIds.push(id);
    const newlyReady: string[] = [];
    for (const dependent of dependents.get(id)!) {
      const d = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, d);
      if (d === 0) newlyReady.push(dependent);
    }
    if (newlyReady.length > 0) {
      newlyReady.sort((a, b) => posById.get(a)! - posById.get(b)!);
      // Merge-insert so the global source-position order is preserved.
      for (const nr of newlyReady) ready.push(nr);
      ready.sort((a, b) => posById.get(a)! - posById.get(b)!);
    }
  }

  // --- Cycle? Not all steps processed ---------------------------------------
  if (sortedIds.length !== ordered.length) {
    const remaining = ordered
      .map((o) => o.step.id)
      .filter((id) => !sortedIds.includes(id));
    if (onCycle === "error") {
      throw new FlowCycleError(remaining);
    }
    // sequential fallback: linear chain purely by source order; cyclic
    // depends_on are DISCARDED and replaced by "hangs on the direct predecessor"
    // (each step gets exactly one edge to its idx predecessor).
    return buildSequentialFallback(ordered.map((o) => o.step), opts.params);
  }

  // --- Successfully topologically sorted: map into CompiledPlanStep --------
  const stepById = new Map(ordered.map((o) => [o.step.id, o.step]));
  return sortedIds.map((id, index) => {
    const step = stepById.get(id)!;
    return toCompiled(step, index, depsById.get(id)!, opts.params);
  });
}

// ---------------------------------------------------------------------------
// Fallback: purely sequential by source order.
// ---------------------------------------------------------------------------

function buildSequentialFallback(
  steps: readonly FlowStep[],
  params?: ParamValues,
): CompiledPlanStep[] {
  return steps.map((step, index) => {
    const dependsOn = index === 0 ? [] : [steps[index - 1].id];
    return toCompiled(step, index, dependsOn, params);
  });
}

// ---------------------------------------------------------------------------
// Single-step mapping (N1: title/config verbatim).
// ---------------------------------------------------------------------------

function toCompiled(
  step: FlowStep,
  index: number,
  dependsOn: readonly string[],
  params?: ParamValues,
): CompiledPlanStep {
  const role = mapSkillToRole(step.skill, step.toolKind);
  const rawTitle =
    step.label && step.label.trim().length > 0
      ? step.label // N1: verbatim (template); interpolation only on the copy
      : step.skill && step.skill.trim().length > 0
        ? step.skill
        : step.id;
  // Slice 2: materialize {{param.*}} (no-op without params/placeholder).
  const title = interpolateParams(rawTitle, params);
  const rationaleParts: string[] = [`Flow-Step ${index + 1}`];
  if (step.skill) rationaleParts.push(`skill=${step.skill}`);
  if (step.toolKind) rationaleParts.push(`tool=${step.toolKind}`);
  if (step.connectorId) rationaleParts.push(`connector=${step.connectorId}`);
  return {
    id: step.id,
    index,
    title,
    rationale: rationaleParts.join(" · "),
    subagentRole: role,
    skill: step.skill,
    toolKind: step.toolKind,
    connectorId: step.connectorId,
    // Slice 2: materialize {{param.*}} in configJson (string level, N1-faithful).
    configJson: interpolateConfigJson(step.configJson, params),
    dependsOn: [...dependsOn],
  };
}
