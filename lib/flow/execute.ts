/**
 * Flow → run execution bridge — Flow Studio P2 · 2026-05-27.
 *
 * Source: docs/plans/2026-05-27_flow-studio-architecture.md §1 + §6.
 *
 * `dispatchFlow` is the BRIDGE from a flow template into a REAL run
 * over the EXISTING orchestration (substrate discipline N4 — NO new
 * execution engine):
 *
 *   1. getFlowTemplate + listFlowSteps  (P1 repo, lib/flow/templates-repo.ts)
 *   2. compileFlowToPlanSteps           (P1 compiler, lib/flow/compile.ts — PURE)
 *   3. create ONE workstreams run       (existing way: same table +
 *                                        column semantics as
 *                                        lib/workstreams/service.ts:createWorkstream)
 *   4. createFlowRun(... workstreamId)  (bridge flow_runs.workstream_id)
 *   5. persist plan steps               (same table + content_hash algo +
 *                                        0110 depends_on semantics as
 *                                        lib/workstreams/plan-repo.ts:insertPlanStep)
 *   6. → { runId: flowRunId, workstreamId }
 *
 * dispatchFlow ONLY PREPARES + PERSISTS. The actual run is started
 * afterwards by the existing plan-executor / tier-orchestrator (the actual
 * spawn triggering is the caller's job / P-live wiring — NOT here).
 *
 * ── Why a raw better-sqlite3 handle (instead of getDb()/createWorkstream/
 *    insertProposedPlan directly)? ──────────────────────────────────────────
 *   - The P1 surface (templates-repo.ts) works on a raw Database
 *     handle (analogous to lib/rag/retriever.ts) → directly in-memory testable.
 *   - createWorkstream() is async + emits events + classifies intent
 *     and is HARD-WIRED to the getDb() singleton; insertProposedPlan()
 *     likewise (getDb()) and additionally does NOT pass through the per-step `dependsOn`
 *     (it only iterates plan.steps → InsertPlanStepInput.dependsOn would stay empty).
 *   - We therefore do NOT REPLICATE the engine, but write into EXACTLY
 *     the same tables with EXACTLY the same content_hash payload + the same
 *     0110 depends_on semantics as insertPlanStep — synchronously, without the singleton,
 *     so that the per-step depends_on from the flow DAG is preserved 1:1.
 *
 * Discipline:
 *   - N1: title/rationale verbatim (no .slice).
 *   - N6: deterministic, no LLM (the compiler is PURE; persistence is DB-only).
 *   - N9: every plan step carries coord_key (ManifestCoord-encoded).
 *   - N10: content_hash = sha256(canonicalJson(payload sans hash)) — IDENTICAL
 *          to lib/workstreams/plan-repo.ts (depends_on/group_id are NOT part
 *          of the hash — orchestration metadata, like status).
 */

import { createHash } from "node:crypto";

import { ulid } from "@/lib/ulid";
import { compileFlowToPlanSteps, type CompileOptions } from "./compile";
import { createFlowRun, getFlowTemplate, listFlowSteps } from "./templates-repo";

type RawDb = import("better-sqlite3").Database;

// ---------------------------------------------------------------------------
// canonicalJson + sha256 — BYTE-IDENTICAL to lib/workstreams/plan-repo.ts,
// so a step written via dispatchFlow carries the same content_hash
// as one from insertPlanStep (N10 consistency across both write paths).
// ---------------------------------------------------------------------------

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value))
    return "[" + value.map(canonicalJson).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    "{" +
    keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k])).join(",") +
    "}"
  );
}

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf-8").digest("hex");
}

function nowMs(): number {
  return Date.now();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface DispatchFlowInput {
  /** flow_templates.id — which flow is executed. */
  readonly flowId: string;
  /** ManifestCoord scope (N9). Also the coord_key base for the plan steps. */
  readonly workspaceId: string;
  /**
   * Optional parent-ticket context (e.g. the chat turn that triggered the
   * flow). Persisted as the primaryTicketId of the workstreams run.
   */
  readonly parentTicketId?: string | null;
  /**
   * Optional compiler switch (default 'error' — a flow must be acyclic).
   * 'sequential' activates the documented linear fallback.
   */
  readonly onCycle?: CompileOptions["onCycle"];
  /**
   * Slice 2 (2026-06-03): parameter values for {{param.*}} interpolation in the
   * compiled plan steps. Missing → no interpolation (today's behavior).
   */
  readonly params?: CompileOptions["params"];
}

export interface DispatchFlowResult {
  /** flow_runs.id — the return run handle for the caller. */
  readonly runId: string;
  /** workstreams.id — the bridge at which the tier-orchestrator picks up the run. */
  readonly workstreamId: string;
}

export class FlowDispatchError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "FlowDispatchError";
    this.code = code;
  }
}

/**
 * Prepares a flow run: creates a workstreams run, compiles the
 * flow_steps into plan steps, persists them (with the DAG depends_on preserved)
 * and links everything via flow_runs.workstream_id. DOES NOT START.
 *
 * @throws FlowDispatchError('flow_not_found')  — no template for flowId.
 * @throws FlowDispatchError('empty_flow')       — template has 0 steps (no
 *         executable plan; we deliberately do NOT create an empty run).
 * @throws FlowCycleError (from compile.ts)       — DAG cycle on onCycle:'error'.
 */
export function dispatchFlow(
  db: RawDb,
  input: DispatchFlowInput,
): DispatchFlowResult {
  if (typeof input.flowId !== "string" || input.flowId.length === 0) {
    throw new FlowDispatchError("flow_not_found", "dispatchFlow: flowId required");
  }
  if (typeof input.workspaceId !== "string" || input.workspaceId.length === 0) {
    throw new FlowDispatchError(
      "invalid_scope",
      "dispatchFlow: workspaceId required (N9 ManifestCoord scope)",
    );
  }

  // 1. Load template + steps (P1 repo).
  const template = getFlowTemplate(db, input.flowId);
  if (!template) {
    throw new FlowDispatchError(
      "flow_not_found",
      `dispatchFlow: no flow_template with id ${input.flowId}`,
    );
  }
  const steps = listFlowSteps(db, input.flowId);

  // 2. Compile (P1 compiler, PURE). Empty flow → defined error:
  //    we do NOT create a half-empty workstreams/flow_runs run (fail-fast
  //    before any write — no orphaned run in the DB).
  const compiled = compileFlowToPlanSteps(template, steps, {
    ...(input.onCycle ? { onCycle: input.onCycle } : {}),
    ...(input.params ? { params: input.params } : {}),
  });
  if (compiled.length === 0) {
    throw new FlowDispatchError(
      "empty_flow",
      `dispatchFlow: flow ${input.flowId} has no steps — nothing to dispatch`,
    );
  }

  // ── From here: all writes in ONE transaction (no half-persisted run
  //    on an insert thrown midway — analogous to insertProposedPlan).
  const ts = nowMs();
  const workstreamId = `WS-${ulid(ts)}`;
  const planId = `PLAN-${ulid(ts)}`;
  // coord_key (N9): workspace-scoped ManifestCoord encoding. Deliberately the same
  // conservative encoding for all steps of this run (workspace scope).
  const coordKey = `ws:${input.workspaceId}`;

  const tx = db.transaction((): DispatchFlowResult => {
    // 3. Create the workstreams run — same table + column semantics as
    //    lib/workstreams/service.ts:createWorkstream. status='active',
    //    name = template name (N1 verbatim), intent='implementation'
    //    (a flow run is an execution, not an idea/question). We write
    //    ONLY the columns of the base table (0009) + intent (0051); later
    //    additive columns stay at their DEFAULTs.
    db.prepare(
      `INSERT INTO workstreams
         (id, workspace_id, name, primary_session_id, primary_ticket_id,
          tier_mix, status, cost_cents, quality_score, description,
          created_at, updated_at, archived_at, intent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      workstreamId,
      input.workspaceId,
      template.name, // N1: verbatim
      null,
      input.parentTicketId ?? null,
      null,
      "active",
      0,
      null,
      template.description ?? null, // N1: verbatim
      ts,
      ts,
      null,
      "implementation",
    );

    // 4. Create the flow_run + set the bridge flow_runs.workstream_id (P1 repo).
    const run = createFlowRun(db, {
      flowId: template.id,
      workspaceId: input.workspaceId,
      workstreamId,
      status: "pending",
    });

    // 5. Persist plan steps — same table + content_hash payload as
    //    lib/workstreams/plan-repo.ts:insertPlanStep, depth=0 (root-level).
    //    depends_on (0110) is taken over 1:1 from the compiled DAG.
    const insertStep = db.prepare(
      `INSERT INTO workstream_plan_steps
         (id, workstream_id, plan_id, parent_step_id, step_index, title,
          rationale, subagent_role, target_files_json, expected_artifacts_json,
          depth, coord_key, allowed_tools, depends_on, group_id, status,
          content_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    for (const c of compiled) {
      // Derive a stable step ID from the flow_steps.id — referenceable for
      // depends_on. We prefix with STEP- (insertPlanStep convention), and
      // map the depends_on edges to the same prefixed IDs.
      const stepId = toPlanStepId(c.id);
      const dependsOn = c.dependsOn.map(toPlanStepId);

      // content_hash payload — FIELD-IDENTICAL to insertPlanStep (N10). Fields
      // without a target slot (toolKind/connectorId/configJson/skill) are deliberately
      // NOT in the hash (they live in the rationale annotation; see below).
      const payload = {
        workstreamId,
        planId,
        parentStepId: null,
        stepIndex: c.index,
        title: c.title, // N1: verbatim
        rationale: c.rationale, // N1: verbatim (compiler annotation below)
        subagentRole: c.subagentRole ?? null,
        targetFilesJson: null,
        expectedArtifactsJson: null,
        depth: 0,
        coordKey,
        status: "pending" as const,
        createdAt: ts,
        updatedAt: ts,
      };
      const contentHash = sha256(canonicalJson(payload));

      // depends_on: 0110 semantics — JSON array when edges exist, otherwise
      // null (= immediately ready). 1:1 from the flow DAG (no invented edge).
      const dependsOnJson =
        dependsOn.length > 0 ? JSON.stringify(dependsOn) : null;

      insertStep.run(
        stepId,
        workstreamId,
        planId,
        null, // parent_step_id (root-level)
        c.index,
        c.title,
        // rationale parks the compiler fields WITHOUT a target slot (toolKind/
        // connectorId/configJson/skill) verbatim as an annotation — see
        // file doc + handoff. NO schema change in P2.
        annotateRationale(c.rationale, {
          skill: c.skill,
          toolKind: c.toolKind,
          connectorId: c.connectorId,
          configJson: c.configJson,
          flowStepId: c.id,
        }),
        c.subagentRole ?? null,
        null, // target_files_json
        null, // expected_artifacts_json
        0, // depth (root)
        coordKey,
        null, // allowed_tools (runtime default ['Read','Grep'] in plan-executor)
        dependsOnJson, // 0110: DAG edges 1:1
        null, // group_id (root steps = no group; default as in insertPlanStep)
        "pending",
        contentHash,
        ts,
        ts,
      );
    }

    return { runId: run.id, workstreamId };
  });

  return tx();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Derives a stable, prefixed plan-step ID from a flow_steps.id.
 * insertPlanStep accepts step IDs only if they begin with 'STEP-'
 * (otherwise it assigns a new ULID — which would break depends_on references).
 * We mirror this convention deterministically so the DAG edges
 * (depends_on) stay intact. Idempotent: already-STEP- stays unchanged.
 */
function toPlanStepId(flowStepId: string): string {
  return flowStepId.startsWith("STEP-") ? flowStepId : `STEP-${flowStepId}`;
}

/**
 * Appends the compiler fields WITHOUT a target slot in workstream_plan_steps (skill /
 * tool_kind / connector_id / config_json + the original flow_steps.id) as a
 * verbatim annotation to the rationale. Deliberate decision (P2): NO
 * schema change — these fields are read back from the annotation or directly from
 * flow_steps for the later R2/connector wiring (P3/live).
 *
 * N1: all values verbatim (no .slice). Deterministic (N6).
 */
function annotateRationale(
  base: string,
  meta: {
    skill: string | null;
    toolKind: string | null;
    connectorId: string | null;
    configJson: string | null;
    flowStepId: string;
  },
): string {
  // Machine-readable, deterministic suffix (a JSON object) that the
  // P3 wiring can parse without destroying the human-readable rationale.
  const annotation = {
    flowStepId: meta.flowStepId,
    skill: meta.skill,
    toolKind: meta.toolKind,
    connectorId: meta.connectorId,
    configJson: meta.configJson,
  };
  return `${base} | flow:${canonicalJson(annotation)}`;
}
