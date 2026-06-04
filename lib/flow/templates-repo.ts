/**
 * Flow templates repo — Flow Studio P1 · 2026-05-27.
 *
 * Source: docs/plans/2026-05-27_flow-studio-architecture.md §1.
 *
 * CRUD surface for `flow_templates` + `flow_steps` + `flow_runs`. Works on
 * a raw better-sqlite3 handle (`import('better-sqlite3').Database`) instead of
 * via Drizzle — analogous to lib/rag/retriever.ts. This makes the repo directly
 * testable with an in-memory DB (no getDb() singleton, no migration-path
 * dependency), and callers pass the production handle through via `getDb().$raw`.
 *
 * Discipline:
 *   - N1: name/description/label/config are persisted VERBATIM (no .slice).
 *   - Pure DB write/read operations — NO LLM, NO net I/O.
 *   - depends_on / graph are kept as a JSON string (the Drizzle schema mirrors
 *     the same columns in db/schema/flow_*.ts).
 *
 * Execution (P2): NOT here. A flow_run creates ONE workstreams run; the
 * bridge is flow_runs.workstream_id. The compiler (lib/flow/compile.ts) maps
 * flow_steps → plan steps; the wiring in plan-executor/tier-orchestrator is P2.
 */

import { ulid } from "@/lib/ulid";

type RawDb = import("better-sqlite3").Database;

// ---------------------------------------------------------------------------
// Typed interfaces (correspond 1:1 to the table columns)
// ---------------------------------------------------------------------------

export interface FlowTemplate {
  readonly id: string;
  readonly workspaceId: string | null;
  readonly orgId: string | null;
  readonly name: string;
  readonly description: string | null;
  /** Optional soft FK to sops.id (a flow CAN be an SOP). */
  readonly sopId: string | null;
  /** Nodes+edges as a JSON string. */
  readonly graphJson: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface FlowStep {
  readonly id: string;
  readonly flowId: string;
  readonly idx: number;
  readonly label: string | null;
  /** role-skill-map key. */
  readonly skill: string | null;
  /** null | 'connector' | 'mcp' | 'engine'. */
  readonly toolKind: string | null;
  /** Optional soft FK to connectors.id. */
  readonly connectorId: string | null;
  /** Step parameters as a JSON string. */
  readonly configJson: string | null;
  /** DAG edges: JSON array of flow_steps.id (predecessors), as a JSON string. */
  readonly dependsOnJson: string | null;
  readonly createdAt: number;
}

export interface FlowRun {
  readonly id: string;
  readonly flowId: string | null;
  readonly workspaceId: string | null;
  /** Bridge to the tier-orchestrator (workstreams.id), NULL until start. */
  readonly workstreamId: string | null;
  readonly status: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface CreateFlowTemplateInput {
  readonly id?: string;
  readonly workspaceId?: string | null;
  readonly orgId?: string | null;
  readonly name: string;
  readonly description?: string | null;
  readonly sopId?: string | null;
  /** Nodes+edges. Serialized verbatim (no .slice). */
  readonly graphJson?: string;
}

export interface AddFlowStepInput {
  readonly id?: string;
  readonly flowId: string;
  readonly idx?: number;
  readonly label?: string | null;
  readonly skill?: string | null;
  readonly toolKind?: string | null;
  readonly connectorId?: string | null;
  readonly configJson?: string | null;
  /** JSON array of predecessor step IDs OR a ready JSON string. */
  readonly dependsOn?: readonly string[] | string | null;
}

export interface CreateFlowRunInput {
  readonly id?: string;
  readonly flowId?: string | null;
  readonly workspaceId?: string | null;
  readonly workstreamId?: string | null;
  readonly status?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nowMs(): number {
  return Date.now();
}

/** Accepts an array (→ JSON), a ready JSON string, or null. */
function normalizeDependsOn(
  dependsOn: readonly string[] | string | null | undefined,
): string | null {
  if (dependsOn == null) return null;
  if (typeof dependsOn === "string") return dependsOn;
  if (dependsOn.length === 0) return null;
  return JSON.stringify(dependsOn);
}

// ---------------------------------------------------------------------------
// flow_templates
// ---------------------------------------------------------------------------

export function createFlowTemplate(
  raw: RawDb,
  input: CreateFlowTemplateInput,
): FlowTemplate {
  if (typeof input.name !== "string" || input.name.length === 0) {
    throw new Error("createFlowTemplate: name required");
  }
  const id = input.id ?? `FLOW-${ulid()}`;
  const ts = nowMs();
  const row: FlowTemplate = {
    id,
    workspaceId: input.workspaceId ?? null,
    orgId: input.orgId ?? null,
    name: input.name, // N1: verbatim
    description: input.description ?? null, // N1: verbatim
    sopId: input.sopId ?? null,
    graphJson: input.graphJson ?? "{}",
    createdAt: ts,
    updatedAt: ts,
  };
  raw
    .prepare(
      `INSERT INTO flow_templates
         (id, workspace_id, org_id, name, description, sop_id, graph_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      row.workspaceId,
      row.orgId,
      row.name,
      row.description,
      row.sopId,
      row.graphJson,
      row.createdAt,
      row.updatedAt,
    );
  return row;
}

export function getFlowTemplate(raw: RawDb, id: string): FlowTemplate | null {
  const r = raw
    .prepare(`SELECT * FROM flow_templates WHERE id = ?`)
    .get(id) as Record<string, unknown> | undefined;
  return r ? mapTemplateRow(r) : null;
}

export function listFlowTemplates(
  raw: RawDb,
  workspaceId: string | null,
): FlowTemplate[] {
  // workspaceId === null → global/template flows; otherwise workspace-scoped.
  const rows = (
    workspaceId == null
      ? raw
          .prepare(
            `SELECT * FROM flow_templates WHERE workspace_id IS NULL ORDER BY created_at DESC`,
          )
          .all()
      : raw
          .prepare(
            `SELECT * FROM flow_templates WHERE workspace_id = ? ORDER BY created_at DESC`,
          )
          .all(workspaceId)
  ) as Record<string, unknown>[];
  return rows.map(mapTemplateRow);
}

// ---------------------------------------------------------------------------
// flow_steps
// ---------------------------------------------------------------------------

export function addFlowStep(raw: RawDb, input: AddFlowStepInput): FlowStep {
  if (typeof input.flowId !== "string" || input.flowId.length === 0) {
    throw new Error("addFlowStep: flowId required");
  }
  const id = input.id ?? `FSTEP-${ulid()}`;
  const ts = nowMs();
  const row: FlowStep = {
    id,
    flowId: input.flowId,
    idx: input.idx ?? 0,
    label: input.label ?? null, // N1: verbatim
    skill: input.skill ?? null,
    toolKind: input.toolKind ?? null,
    connectorId: input.connectorId ?? null,
    configJson: input.configJson ?? null, // N1: verbatim
    dependsOnJson: normalizeDependsOn(input.dependsOn),
    createdAt: ts,
  };
  raw
    .prepare(
      `INSERT INTO flow_steps
         (id, flow_id, idx, label, skill, tool_kind, connector_id, config_json, depends_on_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      row.flowId,
      row.idx,
      row.label,
      row.skill,
      row.toolKind,
      row.connectorId,
      row.configJson,
      row.dependsOnJson,
      row.createdAt,
    );
  return row;
}

export function listFlowSteps(raw: RawDb, flowId: string): FlowStep[] {
  const rows = raw
    .prepare(
      `SELECT * FROM flow_steps WHERE flow_id = ? ORDER BY idx ASC, created_at ASC`,
    )
    .all(flowId) as Record<string, unknown>[];
  return rows.map(mapStepRow);
}

// ---------------------------------------------------------------------------
// flow_runs
// ---------------------------------------------------------------------------

export function createFlowRun(raw: RawDb, input: CreateFlowRunInput): FlowRun {
  const id = input.id ?? `FRUN-${ulid()}`;
  const ts = nowMs();
  const row: FlowRun = {
    id,
    flowId: input.flowId ?? null,
    workspaceId: input.workspaceId ?? null,
    workstreamId: input.workstreamId ?? null,
    status: input.status ?? "pending",
    createdAt: ts,
    updatedAt: ts,
  };
  raw
    .prepare(
      `INSERT INTO flow_runs
         (id, flow_id, workspace_id, workstream_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      row.flowId,
      row.workspaceId,
      row.workstreamId,
      row.status,
      row.createdAt,
      row.updatedAt,
    );
  return row;
}

// ---------------------------------------------------------------------------
// Row mapper (snake_case DB → camelCase interface)
// ---------------------------------------------------------------------------

function mapTemplateRow(r: Record<string, unknown>): FlowTemplate {
  return {
    id: String(r.id),
    workspaceId: (r.workspace_id as string | null) ?? null,
    orgId: (r.org_id as string | null) ?? null,
    name: String(r.name),
    description: (r.description as string | null) ?? null,
    sopId: (r.sop_id as string | null) ?? null,
    graphJson: String(r.graph_json),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

function mapStepRow(r: Record<string, unknown>): FlowStep {
  return {
    id: String(r.id),
    flowId: String(r.flow_id),
    idx: Number(r.idx),
    label: (r.label as string | null) ?? null,
    skill: (r.skill as string | null) ?? null,
    toolKind: (r.tool_kind as string | null) ?? null,
    connectorId: (r.connector_id as string | null) ?? null,
    configJson: (r.config_json as string | null) ?? null,
    dependsOnJson: (r.depends_on_json as string | null) ?? null,
    createdAt: Number(r.created_at),
  };
}
