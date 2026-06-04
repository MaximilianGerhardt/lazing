/**
 * Workstream → flow-template back-compiler — Flow Studio Stream C · 2026-05-27.
 *
 * Source: docs/plans/2026-05-27_flow-studio-architecture.md §1 + §6 (inversion
 * of lib/flow/execute.ts::dispatchFlow + lib/flow/compile.ts).
 *
 * Owner requirement (Stream C): „Run → wiederkehrender Prozess". An already-run
 * (or running) workstream plan should be saveable as a reusable
 * `flow_template` — repeatable via the existing
 * /api/flow/[flowId]/run.
 *
 * What this function does (PURE DB write/read operation — NO LLM, NO net):
 *   1. Reads the root plan steps of the workstream (workstream_plan_steps, depth=0)
 *      directly from the raw better-sqlite3 handle — so in-memory testable (same
 *      discipline as templates-repo.ts / execute.ts).
 *   2. Per step: reconstructs the flow-step fields (skill/toolKind/connectorId/
 *      configJson + the original flow_steps.id) from the `| flow:{...}` annotation
 *      in the rationale that execute.ts::annotateRationale appended on the
 *      forward dispatch. If the annotation is missing (the plan did NOT come from a flow,
 *      but from a free decompose), we fall back to subagentRole→skill +
 *      no tool coupling (lossless for the pure structure).
 *   3. depends_on is taken over 1:1 — but translated back from plan-step IDs
 *      (STEP-<flowStepId>) to the restored flow_steps.id, so that the
 *      DAG is topologically identical again after the re-run (compile.ts).
 *   4. Writes a flow_template + flow_steps via templates-repo (createFlowTemplate/
 *      addFlowStep) — returns {flowId}.
 *
 * Discipline:
 *   - N1: title/rationale/label/config VERBATIM (no .slice). The human-
 *     readable rationale part BEFORE the ` | flow:` suffix is only used as the
 *     step label when the annotation carries no own label; the `title` field
 *     of the plan step stays the primary label candidate (N1 verbatim).
 *   - N4 (substrate): NO new table, NO new engine — only the inversion
 *     of the existing compile→dispatch path onto the existing flow_* tables.
 *   - N6: purely deterministic (annotation parse + step-ID map), no LLM.
 *   - N9: workspaceId is set as the ManifestCoord scope on the flow_template.
 */

import {
  addFlowStep,
  createFlowTemplate,
  type FlowStep,
  type FlowTemplate,
} from "./templates-repo";

type RawDb = import("better-sqlite3").Database;

// ---------------------------------------------------------------------------
// Raw plan-step row (snake_case as in the DB) — only the fields we
// need for the back-compilation. We read directly from the handle, without the
// Drizzle singleton, so the function stays in-memory testable.
// ---------------------------------------------------------------------------

interface RawPlanStepRow {
  readonly id: string;
  readonly step_index: number;
  readonly title: string;
  readonly rationale: string;
  readonly subagent_role: string | null;
  readonly depends_on: string | null;
}

// ---------------------------------------------------------------------------
// `| flow:{...}` annotation (execute.ts::annotateRationale) — counterpart.
// ---------------------------------------------------------------------------

interface FlowAnnotation {
  readonly flowStepId: string | null;
  readonly skill: string | null;
  readonly toolKind: string | null;
  readonly connectorId: string | null;
  readonly configJson: string | null;
}

export interface CompileWorkstreamToFlowInput {
  readonly workstreamId: string;
  /** ManifestCoord scope (N9). NULL = global/template flow. */
  readonly workspaceId: string | null;
  /** Optional org scope (passed through). */
  readonly orgId?: string | null;
  /** Display name of the new flow_template (N1 verbatim). Fallback below. */
  readonly name?: string | null;
  /** Optional description (N1 verbatim). */
  readonly description?: string | null;
}

export interface CompileWorkstreamToFlowResult {
  readonly flowId: string;
  readonly template: FlowTemplate;
  readonly steps: readonly FlowStep[];
}

export class FromWorkstreamError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "FromWorkstreamError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Annotation-Parsing
// ---------------------------------------------------------------------------

/**
 * Separates the human-readable rationale part from the machine-readable
 * `| flow:{...}` annotation. Returns {base, annotation}; annotation is
 * null if no (valid) suffix is present (free decompose plan).
 *
 * Format (execute.ts::annotateRationale):
 *   "<base> | flow:<canonicalJson({flowStepId,skill,toolKind,connectorId,configJson})>"
 *
 * We split at the LAST ` | flow:` — the base part can itself carry pipes
 * (the rationale is VERBATIM/N1), but the annotation suffix is guaranteed to be at
 * the end and begins with the exact marker.
 */
export function parseFlowAnnotation(rationale: string): {
  base: string;
  annotation: FlowAnnotation | null;
} {
  const MARKER = " | flow:";
  const idx = rationale.lastIndexOf(MARKER);
  if (idx === -1) return { base: rationale, annotation: null };

  const base = rationale.slice(0, idx);
  const jsonPart = rationale.slice(idx + MARKER.length);
  try {
    const parsed: unknown = JSON.parse(jsonPart);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { base: rationale, annotation: null };
    }
    const o = parsed as Record<string, unknown>;
    const annotation: FlowAnnotation = {
      flowStepId: typeof o.flowStepId === "string" ? o.flowStepId : null,
      skill: typeof o.skill === "string" ? o.skill : null,
      toolKind: typeof o.toolKind === "string" ? o.toolKind : null,
      connectorId: typeof o.connectorId === "string" ? o.connectorId : null,
      configJson: typeof o.configJson === "string" ? o.configJson : null,
    };
    return { base, annotation };
  } catch {
    // Broken JSON → treat as no annotation (the rationale stays verbatim).
    return { base: rationale, annotation: null };
  }
}

/** Defensively parses the `depends_on` JSON field of a plan-step row into IDs. */
function parseDependsOn(raw: string | null): string[] {
  if (raw == null || raw.trim().length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((x): x is string => typeof x === "string" && x.length > 0);
    }
  } catch {
    /* defensive: broken → no edges */
  }
  return [];
}

/**
 * Maps a subagent_role (architect|coder|tester|reviewer|…) to a skill
 * key — only as a fallback when the `| flow:` annotation carries no skill.
 * Lossless for the pure structure (the re-run uses compile.ts::mapSkillToRole,
 * which restores the role).
 */
function roleToSkillFallback(role: string | null): string | null {
  if (role == null || role.trim().length === 0) return null;
  return role.trim();
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Back-compiles the root plan steps of a workstream into a new
 * flow_template + flow_steps (depends_on 1:1). Returns {flowId, template, steps}.
 *
 * Throws FromWorkstreamError('no_steps') if the workstream has no root steps
 * (nothing to save). Writes template + steps NON-transactionally via the
 * repo (analogous to templates-repo callers); the caller (route) wraps if needed.
 */
export function compileWorkstreamToFlow(
  raw: RawDb,
  input: CompileWorkstreamToFlowInput,
): CompileWorkstreamToFlowResult {
  if (
    typeof input.workstreamId !== "string" ||
    input.workstreamId.length === 0
  ) {
    throw new FromWorkstreamError(
      "invalid_workstream_id",
      "compileWorkstreamToFlow: workstreamId required",
    );
  }

  // 1. Read root plan steps (depth=0), ordered by step_index.
  const rows = raw
    .prepare(
      `SELECT id, step_index, title, rationale, subagent_role, depends_on
         FROM workstream_plan_steps
        WHERE workstream_id = ? AND depth = 0
        ORDER BY step_index ASC`,
    )
    .all(input.workstreamId) as RawPlanStepRow[];

  if (rows.length === 0) {
    throw new FromWorkstreamError(
      "no_steps",
      `compileWorkstreamToFlow: workstream ${input.workstreamId} has no root plan steps`,
    );
  }

  // 2. Resolve plan-step ID → restored flow_steps.id.
  //    The annotation carries the ORIGINAL flow_steps.id (flowStepId). If it
  //    exists, we use it (depends_on edges stay referenceable). Otherwise
  //    we take the plan-step ID itself as a stable node key.
  const planIdToFlowId = new Map<string, string>();
  const parsedRows = rows.map((row) => {
    const { base, annotation } = parseFlowAnnotation(row.rationale);
    const flowStepId =
      annotation?.flowStepId && annotation.flowStepId.length > 0
        ? annotation.flowStepId
        : row.id;
    planIdToFlowId.set(row.id, flowStepId);
    return { row, base, annotation, flowStepId };
  });

  // 3. Create the flow_template (N9 scope, N1 name verbatim).
  const fallbackName = `Prozess aus ${input.workstreamId}`;
  const name =
    typeof input.name === "string" && input.name.trim().length > 0
      ? input.name // N1: verbatim
      : fallbackName;
  const template = createFlowTemplate(raw, {
    workspaceId: input.workspaceId ?? null,
    orgId: input.orgId ?? null,
    name,
    description: input.description ?? null,
    // graph_json: compact nodes+edges mirror (for the P3 visualization).
    graphJson: JSON.stringify(
      buildGraphJson(parsedRows, planIdToFlowId),
    ),
  });

  // 4. Write flow_steps — translate depends_on back from plan-step IDs to flow_steps.id
  //    (nodes not in the plan are discarded —
  //    NO invented edges, identical to the compile.ts discipline).
  const steps: FlowStep[] = [];
  parsedRows.forEach(({ row, base, annotation, flowStepId }, idx) => {
    const dependsOnFlowIds = parseDependsOn(row.depends_on)
      .map((planDepId) => planIdToFlowId.get(planDepId))
      .filter((x): x is string => typeof x === "string" && x.length > 0);

    const skill =
      annotation?.skill && annotation.skill.length > 0
        ? annotation.skill
        : roleToSkillFallback(row.subagent_role);

    const step = addFlowStep(raw, {
      id: flowStepId,
      flowId: template.id,
      idx,
      // N1: the title of the plan step is the primary label candidate (verbatim).
      // base (human-readable rationale part) is only context, not the label.
      label: row.title,
      skill,
      toolKind: annotation?.toolKind ?? null,
      connectorId: annotation?.connectorId ?? null,
      configJson: annotation?.configJson ?? null,
      dependsOn: dependsOnFlowIds.length > 0 ? dependsOnFlowIds : null,
    });
    void base; // deliberately not used as the label (title wins, N1).
    steps.push(step);
  });

  return { flowId: template.id, template, steps };
}

// ---------------------------------------------------------------------------
// graph_json — compact nodes+edges mirror for the visualization (P3).
// Mirrors the payload format of the <surface:flow-graph> emission (nodes/edges).
// ---------------------------------------------------------------------------

function buildGraphJson(
  parsedRows: ReadonlyArray<{
    row: RawPlanStepRow;
    base: string;
    annotation: FlowAnnotation | null;
    flowStepId: string;
  }>,
  planIdToFlowId: ReadonlyMap<string, string>,
): { nodes: Array<Record<string, unknown>>; edges: Array<{ from: string; to: string }> } {
  const nodes = parsedRows.map(({ row, annotation, flowStepId }) => ({
    id: flowStepId,
    label: row.title, // N1: verbatim
    ...(annotation?.skill ? { skill: annotation.skill } : {}),
    ...(annotation?.toolKind ? { tool: annotation.toolKind } : {}),
  }));
  const edges: Array<{ from: string; to: string }> = [];
  for (const { row, flowStepId } of parsedRows) {
    for (const planDepId of parseDependsOn(row.depends_on)) {
      const fromFlowId = planIdToFlowId.get(planDepId);
      if (fromFlowId) edges.push({ from: fromFlowId, to: flowStepId });
    }
  }
  return { nodes, edges };
}
