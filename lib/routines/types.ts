/**
 * Routines — type definitions + Zod schemas.
 *
 * Counterpart to `lifeos-routine-runner.ts` (example-tool), adapted to the lazyOS
 * event bus. Differences from the original:
 *   - Delivery modes extended by `push_send` + `decision_request`.
 *   - `workspace_id` replaces `segment`.
 *   - The structure lives as a YAML string in `routines.yaml_config` instead of the
 *     file system; file-path traversal guards therefore drop out.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Delivery modes
// ---------------------------------------------------------------------------

export const DeliverySchema = z.enum([
  "stdout", // Markdown to stderr (= dev channel); always on
  "memory_write", // emitEvent → eventType='created', entityType='note'
  "ticket_create", // createTicket() in this workspace
  "push_send", // POST /api/push/send via internal Bearer
  "decision_request", // emitEvent (decision) + push_send (parallel)
]);
export type Delivery = z.infer<typeof DeliverySchema>;

// ---------------------------------------------------------------------------
// Pipeline steps (YAML list-of-single-key-maps, identical to example-tool)
// ---------------------------------------------------------------------------

export const CollectContextStepSchema = z.object({
  collect_context: z.object({
    commands: z.array(z.string().min(1)).min(1),
  }),
});

export const SynthesizeViaStepSchema = z.object({
  synthesize_via: z.string().min(1),
});

export const OutputFormatStepSchema = z.object({
  output_format: z.enum(["markdown"]),
});

export const DeliveryStepSchema = z.object({
  delivery: DeliverySchema,
});

/**
 * Optional deduplication step — if set, the runner checks
 * events of the last `within_hours` window and skips the step
 * if an event with the `key` exists.
 */
export const DedupStepSchema = z.object({
  dedup: z.object({
    key: z.string().min(1),
    within_hours: z.number().int().min(1).max(168),
  }),
});

/**
 * Push configuration (title, body template, target URL).
 * Template vars: `{count}`, `{first_title}` and more — are derived by the runner
 * from the collect output.
 */
export const PushConfigStepSchema = z.object({
  push: z.object({
    title: z.string().min(1).max(80),
    body: z.string().min(1).max(200),
    url: z.string().startsWith("/").default("/"),
    tag: z.string().optional(),
  }),
});

export const PipelineStepSchema = z.union([
  CollectContextStepSchema,
  SynthesizeViaStepSchema,
  OutputFormatStepSchema,
  DeliveryStepSchema,
  DedupStepSchema,
  PushConfigStepSchema,
]);

// ---------------------------------------------------------------------------
// Root schema for a routine YAML
// ---------------------------------------------------------------------------

export const RoutineConfigSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(120),
  workspace_id: z.string().min(1).max(64),
  description: z.string().max(500).optional(),
  pipeline: z.array(PipelineStepSchema).min(1),
});
export type RoutineConfig = z.infer<typeof RoutineConfigSchema>;

// ---------------------------------------------------------------------------
// SAR-3: Plan-Dispatch Extension Schema
//
// Validates the new DB columns introduced by Migration 0099_sops.sql.
// All fields are optional / have defaults for backwards-compatibility:
//   action_kind default 'shell' → existing routines unaffected (N-backcompat).
//
// N1: goalPrompt is validated as a non-empty string when present; it is
//     NEVER sliced or modified here — the caller thread the verbatim value
//     into the SOP step templates and the workstream description.
// ---------------------------------------------------------------------------

/**
 * Validated representation of the plan-dispatch columns read from a DB row.
 *
 * This is NOT a YAML-level schema — these columns live on the `routines`
 * table directly (Migration 0099). They are parsed separately from yamlConfig
 * in executeRoutine so that YAML stays the shell-pipeline config and the DB
 * columns carry the plan-dispatch metadata.
 */
export const PlanDispatchColumnsSchema = z.object({
  /**
   * 'shell' → existing collect_context/delivery pipeline (default, N-backcompat).
   * 'plan-dispatch' → SAR-3 Routine→Plan bridge.
   */
  action_kind: z.enum(["shell", "plan-dispatch"]).default("shell"),

  /**
   * Optional FK to sops.id. When set + action_kind='plan-dispatch':
   * expandSopToPlanNodes() is used instead of LLM-propose (tryPlanDispatch).
   */
  sop_id: z.string().min(1).max(128).optional().nullable(),

  /**
   * N1: verbatim goal text. Threaded into SOP step {{goal_prompt}} templates
   * and stored as the workstream description. NEVER sliced.
   */
  goal_prompt: z.string().min(1).max(10_000).optional().nullable(),

  /**
   * JSON map { "<stepIndex>": "<skillId>" } — per-step skill overrides.
   * Parsed defensively: invalid JSON → treated as empty.
   */
  skill_bindings_json: z.string().optional().nullable(),

  /**
   * JSON array of requested MCP tool names (canonical form mcp__<srv>__<tool>).
   * Phase-1: stored + audited but NOT forwarded to real-invoke spawn (R3-gate).
   * Parsed defensively: invalid JSON → treated as [].
   */
  mcp_tool_allowlist_json: z.string().optional().nullable(),
});

export type PlanDispatchColumns = z.infer<typeof PlanDispatchColumnsSchema>;

/**
 * Parse plan-dispatch columns from a raw DB row.
 * Returns safe defaults when columns are missing (e.g., old rows before 0099).
 * NEVER throws — all validation errors yield the safe default.
 */
export function parsePlanDispatchColumns(
  row: Record<string, unknown>,
): PlanDispatchColumns {
  const result = PlanDispatchColumnsSchema.safeParse({
    action_kind: row["actionKind"] ?? row["action_kind"] ?? "shell",
    sop_id: row["sopId"] ?? row["sop_id"] ?? null,
    goal_prompt: row["goalPrompt"] ?? row["goal_prompt"] ?? null,
    skill_bindings_json:
      row["skillBindingsJson"] ?? row["skill_bindings_json"] ?? null,
    mcp_tool_allowlist_json:
      row["mcpToolAllowlistJson"] ?? row["mcp_tool_allowlist_json"] ?? null,
  });

  if (result.success) return result.data;

  // Zod failed — return safe defaults (preserves N-backcompat).
  return {
    action_kind: "shell",
    sop_id: null,
    goal_prompt: null,
    skill_bindings_json: null,
    mcp_tool_allowlist_json: null,
  };
}

/**
 * Parse a JSON string defensively, returning [] on any error.
 * Used for mcp_tool_allowlist_json and skill_bindings_json.
 */
export function parseJsonArraySafe(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((v): v is string => typeof v === "string");
    }
  } catch {
    // Malformed JSON → fall through
  }
  return [];
}

// ---------------------------------------------------------------------------
// Normalised view — easier to consume than a list-of-maps
// ---------------------------------------------------------------------------

export interface NormalisedRoutine {
  id: string;
  name: string;
  workspaceId: string;
  description?: string;
  commands: string[];
  synthesizeVia?: string;
  outputFormat: "markdown";
  delivery: Delivery;
  dedup?: { key: string; withinHours: number };
  push?: { title: string; body: string; url: string; tag?: string };
}

export function normaliseRoutine(config: RoutineConfig): NormalisedRoutine {
  let commands: string[] | null = null;
  let synthesizeVia: string | undefined;
  let outputFormat: "markdown" | null = null;
  let delivery: Delivery | null = null;
  let dedup: NormalisedRoutine["dedup"];
  let push: NormalisedRoutine["push"];

  for (const step of config.pipeline) {
    if ("collect_context" in step) {
      if (commands !== null) {
        throw new Error(`routine ${config.id}: duplicate collect_context`);
      }
      commands = step.collect_context.commands;
    } else if ("synthesize_via" in step) {
      if (synthesizeVia !== undefined) {
        throw new Error(`routine ${config.id}: duplicate synthesize_via`);
      }
      synthesizeVia = step.synthesize_via;
    } else if ("output_format" in step) {
      if (outputFormat !== null) {
        throw new Error(`routine ${config.id}: duplicate output_format`);
      }
      outputFormat = step.output_format;
    } else if ("delivery" in step) {
      if (delivery !== null) {
        throw new Error(`routine ${config.id}: duplicate delivery`);
      }
      delivery = step.delivery;
    } else if ("dedup" in step) {
      dedup = { key: step.dedup.key, withinHours: step.dedup.within_hours };
    } else if ("push" in step) {
      push = step.push;
    }
  }

  if (commands === null) {
    throw new Error(`routine ${config.id}: missing collect_context step`);
  }
  if (outputFormat === null) {
    outputFormat = "markdown"; // Default — like the example-tool runner.
  }
  if (delivery === null) {
    throw new Error(`routine ${config.id}: missing delivery step`);
  }

  // push_send / decision_request require a push config.
  if ((delivery === "push_send" || delivery === "decision_request") && !push) {
    throw new Error(
      `routine ${config.id}: delivery=${delivery} requires a \`push:\` step`,
    );
  }

  return {
    id: config.id,
    name: config.name,
    workspaceId: config.workspace_id,
    description: config.description,
    commands,
    synthesizeVia,
    outputFormat,
    delivery,
    dedup,
    push,
  };
}

// ---------------------------------------------------------------------------
// Event-match predicate (for triggerMode='event')
// ---------------------------------------------------------------------------

export const EventMatchSchema = z.object({
  eventType: z.string().min(1),
  entityType: z.string().optional(),
  /** Optional key→value match on `event.payload[key]`. */
  payloadMatch: z.record(z.string(), z.unknown()).optional(),
});
export type EventMatch = z.infer<typeof EventMatchSchema>;

// ---------------------------------------------------------------------------
// API-Shapes
// ---------------------------------------------------------------------------

export const CreateRoutineBodySchema = z.object({
  name: z.string().min(1).max(120),
  workspaceId: z.string().min(1).max(64),
  yamlConfig: z.string().min(1),
  triggerMode: z.enum(["cron", "manual", "event"]).default("manual"),
  cronExpr: z.string().min(1).max(100).optional(),
  eventMatch: EventMatchSchema.optional(),
  active: z.boolean().default(true),
  // SAR-3: Plan-dispatch columns (all optional; default 'shell' → backward-compat).
  // Defensive: missing → 'shell'. action_kind must be set to 'plan-dispatch' to
  // activate the SOP→plan bridge; omitting it (or sending 'shell') leaves the
  // existing collect_context pipeline fully untouched (N-backcompat).
  actionKind: z.enum(["shell", "plan-dispatch"]).default("shell"),
  sopId: z.string().min(1).max(128).optional(),
  goalPrompt: z.string().min(1).max(10_000).optional(),
  skillBindings: z.record(z.string(), z.string()).optional(),
  mcpToolAllowlist: z.array(z.string().min(1)).optional(),
});
export type CreateRoutineBody = z.infer<typeof CreateRoutineBodySchema>;

export const UpdateRoutineBodySchema = z.object({
  name: z.string().min(1).max(120).optional(),
  yamlConfig: z.string().min(1).optional(),
  triggerMode: z.enum(["cron", "manual", "event"]).optional(),
  cronExpr: z.string().min(1).max(100).nullable().optional(),
  eventMatch: EventMatchSchema.nullable().optional(),
  active: z.boolean().optional(),
  // SAR-3: Plan-dispatch columns — all optional for partial update.
  // null → explicitly clear the column; undefined → leave unchanged.
  actionKind: z.enum(["shell", "plan-dispatch"]).optional(),
  sopId: z.string().min(1).max(128).nullable().optional(),
  goalPrompt: z.string().min(1).max(10_000).nullable().optional(),
  skillBindings: z.record(z.string(), z.string()).nullable().optional(),
  mcpToolAllowlist: z.array(z.string().min(1)).nullable().optional(),
});
export type UpdateRoutineBody = z.infer<typeof UpdateRoutineBodySchema>;

// ---------------------------------------------------------------------------
// Run-Results
// ---------------------------------------------------------------------------

export interface CommandResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface RunResult {
  runId: string;
  routineId: string;
  status: "success" | "failure" | "partial" | "skipped";
  startedAt: number;
  finishedAt: number;
  output: string;
  error?: string;
  deliveryRef?: string;
}
