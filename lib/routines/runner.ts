/**
 * Routines-Runner — adapted onto the lazyOS stack from an upstream
 * personal-routine runner script.
 *
 * Differences:
 *   - Routine source: the `routines` table (yaml_config column) instead of a .yaml file.
 *     Traversal guards drop out; Zod validation stays.
 *   - Delivery:
 *       stdout            → stderr print (identical)
 *       memory_write      → emitEvent(entityType='note', eventType='created',
 *                           payload={markdown, routineId}) — the event log is
 *                           lazyOS' memory equivalent.
 *       ticket_create     → createTicket() in routine.workspaceId.
 *       push_send         → POST /api/push/send (Bearer LAZYOS_PUSH_SECRET).
 *       decision_request  → emitEvent(entityType='decision', eventType='approval_requested')
 *                           + push_send (so the operator gets a notification AND
 *                           the entry lands in the decision log).
 *   - Dedup: per run before delivery — checks events of the last N hours for a
 *     matching `dedupKey` marker in the payload. Skips if present.
 *   - Run history: INSERT into `routine_runs` at the end.
 *
 * No agent auto-invocation (like example-tool). `synthesize_via` lands in the
 * markdown header as a hint.
 *
 * SAR-3 (Routine→Plan-Bridge, 2026-05-24):
 *   When action_kind='plan-dispatch' on the routines row (Migration 0099),
 *   executeRoutine branches into runPlanDispatch() instead of the shell
 *   collect_context pipeline. See runPlanDispatch() for security contract.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { and, desc, eq, gte } from "drizzle-orm";
import { parse as parseYaml } from "yaml";

import { getDb } from "../../db/client";
import { events as eventsTable } from "../../db/schema/events";
import { routineRuns, routines } from "../../db/schema/routines";
import { emitEvent, emitErrorEvent } from "../events/emit";
import { createTicket } from "../tickets/service";
import { ulid } from "../ulid";
import { nextRunAt } from "./scheduler";
import {
  RoutineConfigSchema,
  normaliseRoutine,
  parsePlanDispatchColumns,
  parseJsonArraySafe,
  type CommandResult,
  type NormalisedRoutine,
  type RunResult,
} from "./types";
import {
  resolveBinding,
  auditBindingResolution,
  type RoutineBinding,
} from "./binding-resolver";
import { enforcePermissionFromSingleton } from "../security/permission-mode";
import { getSop } from "../sop/registry";
import { expandSopToPlanNodes } from "../sop/executor";
import { tryPlanDispatch } from "../plan-first/plan-dispatch";
import { createWorkstream } from "../workstreams/service";
import { insertProposedPlan } from "../workstreams/plan-repo";
import { executePlan } from "../workstreams/plan-executor";
import { writeDecision } from "../workstreams/trace-repo";
import { projectsRoot } from "../workspaces/projects-root";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Timeboxed per command — like example-tool. */
const COMMAND_TIMEOUT_MS = 30_000;

/**
 * stdout/stderr ceiling for command output. 10 MB, identical to example-tool.
 */
const MAX_BUFFER = 10 * 1024 * 1024;

// ---------------------------------------------------------------------------
// YAML → NormalisedRoutine
// ---------------------------------------------------------------------------

export class RoutineValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoutineValidationError";
  }
}

export function validateYamlConfig(yamlString: string): NormalisedRoutine {
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlString);
  } catch (err) {
    throw new RoutineValidationError(
      `YAML parse failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const zod = RoutineConfigSchema.safeParse(parsed);
  if (!zod.success) {
    throw new RoutineValidationError(
      `schema invalid: ${zod.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ")}`,
    );
  }

  return normaliseRoutine(zod.data);
}

// ---------------------------------------------------------------------------
// Command-Execution
// ---------------------------------------------------------------------------

/**
 * Runs a shell command in the workspace cwd. bash -c allows pipes
 * + variable expansion like example-tool. The shell-injection surface is acceptable because
 * the YAML is authored server-side (not user input from the chat).
 *
 * The timebox prevents a hanging command from blocking the whole tick;
 * the cumulative tick runtime is bounded by the caller.
 */
function runCommand(cmd: string, cwd: string): CommandResult {
  const startedAt = Date.now();
  const result = spawnSync("bash", ["-c", cmd], {
    cwd,
    encoding: "utf8",
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER,
    env: {
      ...process.env,
      // Defensive: we are not example-tool, but in case a nested hook
      // checks this — set it. Harmless passthrough otherwise.
      LAZYOS_ROUTINE_RUN: "1",
    },
  });

  return {
    command: cmd,
    exitCode: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    durationMs: Date.now() - startedAt,
  };
}

// ---------------------------------------------------------------------------
// Markdown rendering (identical to example-tool)
// ---------------------------------------------------------------------------

function escapeFencedContent(s: string): string {
  return s.replace(/```/g, "\\`\\`\\`");
}

function renderMarkdown(
  routine: NormalisedRoutine,
  runs: CommandResult[],
): string {
  const lines: string[] = [];
  const generatedAt = new Date().toISOString();

  lines.push(`# Routine: ${routine.name}`);
  lines.push("");
  lines.push(`- **Workspace:** \`${routine.workspaceId}\``);
  lines.push(`- **Generated:** ${generatedAt}`);
  if (routine.synthesizeVia) {
    lines.push(
      `- **Synthesis-Agent:** \`${routine.synthesizeVia}\` ` +
        `(nicht auto-invoked — Phase 6)`,
    );
  }
  lines.push(`- **Delivery:** ${routine.delivery}`);
  lines.push("");

  if (routine.commands.length > 0) {
    lines.push("## Collected context");
    lines.push("");
    for (const run of runs) {
      const ok = run.exitCode === 0;
      lines.push(`### ${ok ? "OK" : "FAIL"} \`${run.command}\``);
      lines.push("");
      lines.push(
        `- exit: ${run.exitCode} · duration: ${run.durationMs} ms` +
          (ok ? "" : " · **FAILED**"),
      );
      lines.push("");

      const stdout = run.stdout.trim();
      const stderr = run.stderr.trim();
      if (stdout.length > 0) {
        lines.push("```");
        lines.push(escapeFencedContent(stdout));
        lines.push("```");
        lines.push("");
      } else {
        lines.push("_(empty stdout)_");
        lines.push("");
      }
      if (stderr.length > 0) {
        lines.push("**stderr:**");
        lines.push("```");
        lines.push(escapeFencedContent(stderr));
        lines.push("```");
        lines.push("");
      }
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Dedup check
// ---------------------------------------------------------------------------

/**
 * Checks whether an event with payload.dedupKey === key exists within
 * `withinHours`. Used for deadline-watch: do not push the same ticket more often than
 * every 12 h.
 *
 * We scan the last `withinHours` events in the workspace and parse the
 * payload (JSON string in SQLite). No separate index — for 1-100
 * events/day per workspace this scales fine.
 */
async function isDuplicateRecently(
  workspaceId: string,
  key: string,
  withinHours: number,
): Promise<boolean> {
  const db = getDb();
  const since = Date.now() - withinHours * 3600 * 1000;
  const rows = await db
    .select({ payload: eventsTable.payload })
    .from(eventsTable)
    .where(
      and(
        eq(eventsTable.segmentId, workspaceId),
        gte(eventsTable.createdAt, since),
      ),
    );

  for (const row of rows) {
    try {
      const payload = JSON.parse(row.payload) as { dedupKey?: unknown };
      if (payload?.dedupKey === key) return true;
    } catch {
      // Malformed payload → ignore
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Delivery-Handler
// ---------------------------------------------------------------------------

async function deliverMemoryWrite(
  routine: NormalisedRoutine,
  markdown: string,
): Promise<string> {
  const event = await emitEvent({
    segmentId: routine.workspaceId,
    entityType: "note",
    entityId: `routine-${routine.id}-${Date.now()}`,
    eventType: "created",
    actor: "system",
    payload: {
      source: "routine-runner",
      routineId: routine.id,
      routineName: routine.name,
      markdown,
      dedupKey: routine.dedup?.key,
    },
    sensitivity: "low",
  });
  return event.id;
}

async function deliverTicketCreate(
  routine: NormalisedRoutine,
  markdown: string,
): Promise<string> {
  const today = new Date().toISOString().slice(0, 10);
  const ticket = await createTicket({
    workspaceId: routine.workspaceId,
    title: `${routine.name} — ${today}`,
    body: markdown,
    status: "open",
    tags: ["routine", routine.id],
    actor: "system",
  });
  return ticket.id;
}

interface PushResponse {
  ok?: boolean;
  sent?: number;
  removed?: number;
  error?: string;
}

/**
 * Fires a push via /api/push/send. Token-gated by LAZYOS_PUSH_SECRET.
 * In the runner we run inside the same Node process, but we go in
 * via HTTP because the push-send handler encapsulates the VAPID infra + subscription
 * maintenance — a direct in-process call would break the abstraction.
 *
 * Fallback: if `LAZYOS_BASE_URL` is not set, we only log and
 * return a synthetic ref (dev-friendliness).
 */
async function deliverPushSend(
  routine: NormalisedRoutine,
  markdown: string,
): Promise<string> {
  if (!routine.push) {
    throw new Error(`routine ${routine.id}: push delivery without push config`);
  }
  const secret = process.env.LAZYOS_PUSH_SECRET;
  const baseUrl = process.env.LAZYOS_BASE_URL ?? "http://127.0.0.1:4200";
  if (!secret) {
    process.stderr.write(
      `[routines] push_send skipped — LAZYOS_PUSH_SECRET not set (routine=${routine.id})\n`,
    );
    return "no-secret";
  }

  // Fill the template variables in the body. Minimal scope for the MVP:
  //   {count}      → number of successful collect commands (proxy for items)
  //   {first_line} → first non-empty stdout line of all commands
  const firstLine = markdown
    .split("\n")
    .find((l) => l.trim().length > 0 && !l.startsWith("#") && !l.startsWith("-"))
    ?.slice(0, 120) ?? "";
  const body = routine.push.body
    .replace(/\{first_line\}/g, firstLine)
    .replace(/\{routine_name\}/g, routine.name);

  const res = await fetch(`${baseUrl}/api/push/send`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify({
      title: routine.push.title,
      body,
      url: routine.push.url,
      tag: routine.push.tag ?? `routine-${routine.id}`,
    }),
  });
  const json = (await res.json().catch(() => ({}))) as PushResponse;
  if (!res.ok || !json.ok) {
    throw new Error(
      `push failed (${res.status}): ${json.error ?? JSON.stringify(json)}`,
    );
  }
  return `push:${json.sent ?? 0}`;
}

async function deliverDecisionRequest(
  routine: NormalisedRoutine,
  markdown: string,
): Promise<string> {
  if (!routine.push) {
    throw new Error(
      `routine ${routine.id}: decision_request without push config`,
    );
  }
  // 1) Write the decision event — question from push.title + body.
  const decisionId = `DEC-${ulid()}`;
  await emitEvent({
    segmentId: routine.workspaceId,
    entityType: "decision",
    entityId: decisionId,
    eventType: "approval_requested",
    actor: "system",
    payload: {
      headline: routine.push.title,
      sub: routine.push.body,
      source: "routine-runner",
      routineId: routine.id,
      markdown,
      dedupKey: routine.dedup?.key,
    },
    sensitivity: "medium",
  });
  // 2) Fire the push (best-effort — the decision is already persisted).
  try {
    await deliverPushSend(routine, markdown);
  } catch (err) {
    process.stderr.write(
      `[routines] decision_request push failed (decision ${decisionId} still created): ${String(err)}\n`,
    );
  }
  return decisionId;
}

async function deliverStdout(markdown: string): Promise<string> {
  process.stderr.write(markdown + "\n");
  return "stdout";
}

// ---------------------------------------------------------------------------
// Cwd-Resolver
// ---------------------------------------------------------------------------

function resolveWorkspaceCwd(workspaceId: string): string {
  try {
    const db = getDb();
    const row = db.$raw
      .prepare("SELECT path FROM workspaces WHERE id = ? LIMIT 1")
      .get(workspaceId) as { path: string } | undefined;
    if (row?.path && existsSync(row.path)) return row.path;
  } catch {
    // DB not yet migrated — fall through.
  }
  // The default projects root is env-configurable (LAZYOS_PROJECTS_ROOT) and
  // falls back to a cross-platform home-dir path, never a hardcoded one.
  const candidate = resolve(projectsRoot(), workspaceId);
  // Robustness (2026-06-03): if the derived path does not exist (e.g. the
  // seed routines with workspace 'lazyos', for which there is no FS directory),
  // fall back to the server CWD (repo root) — otherwise spawnSync throws with
  // ENOENT and the routine fails hard before a command runs.
  return existsSync(candidate) ? candidate : process.cwd();
}

// ---------------------------------------------------------------------------
// SAR-3: Plan-Dispatch Bridge
// ---------------------------------------------------------------------------

/**
 * SAR-3 Routine→Plan-Bridge (Phase 1, text-only, non-destructive).
 *
 * ──────────────────────────────────────────────────────────────────────────
 * SECURITY CONTRACT (read before modifying)
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Phase-1 NON-DESTRUCTIVE guarantee:
 *   - executePlan() is the ONLY execution surface called here.  It uses
 *     engine.chat() (claude --print / ollama /api/chat) — a pure text
 *     completion with NO tool-calls, NO file-writes, NO shell execution.
 *   - codex-cli is ALWAYS excluded (passed as exclusion to pickEngine inside
 *     plan-dispatch and plan-executor).  codex runs in code-mode
 *     (approval_policy="never") and would write files — that is strictly
 *     forbidden in Phase 1.
 *
 * R3-Gate (MCP tool real-invocation):
 *   Phase-1: mcpToolAllowlist is resolved + audited (N8) but the resolved
 *   mcpTools list is stored in the RunResult output only — it is NOT
 *   forwarded to any real MCP-invoking spawn.  A future Phase-2 (R3-gated)
 *   pass would wire resolvedBinding.mcpTools into the actual subagent spawn
 *   call at server/agents/tmux-spawn.ts.  The comment PHASE2_MCP_REALINVOKE
 *   marks that insertion point.
 *
 * N1 (detail-preservation):
 *   goalPrompt is passed verbatim to the workstream description and to the
 *   SOP step templates.  NEVER sliced, NEVER paraphrased here.
 *
 * N8 (trace as evidence):
 *   writeDecision() is called after workstream creation and after binding
 *   resolution.  auditBindingResolution() is called with a best-effort
 *   in-memory callback (no separate audit DB table in Phase-1; N8 full-DB
 *   write is a Phase-2 concern tracked in db/migrations TODO).
 *
 * N10 (tamper-evident):
 *   insertProposedPlan() stamps contentHash on every plan step row.
 *
 * N11 (resource budget):
 *   executePlan() manages the ResourcePool + TPM-budget internally.
 */
async function runPlanDispatch(
  routineId: string,
  routineRow: Record<string, unknown>,
  runId: string,
  startedAt: number,
  /**
   * F4: trusted scope source. Passed verbatim from the Drizzle row.workspaceId
   * (NOT NULL in db/schema/routines.ts) — NOT re-derived from the raw SELECT
   * here, so the scope can never silently be ''.
   */
  trustedWorkspaceId: string,
): Promise<RunResult> {
  const workspaceId = (trustedWorkspaceId ?? "").trim();

  // F4 Guard: never operate with an empty ManifestCoord scope (N9). createWorkstream
  // / writeDecision / insertProposedPlan all key on workspaceId; an empty scope
  // would corrupt the coord-envelope. Fail-closed before any write.
  if (!workspaceId) {
    const finishedAt = Date.now();
    return {
      runId,
      routineId,
      status: "failure",
      startedAt,
      finishedAt,
      output: "",
      error:
        "plan-dispatch: workspaceId fehlt auf Routine-Row (Migration 0099 prüfen)",
    };
  }

  // ── Permission Audit (best-effort, audit-only in Phase-1) ────────────────
  // N8: documents the intent; does NOT block in audit mode (default).
  // toolClass='claude-cli-subspawn' — closest semantics: plan-dispatch will
  // eventually spawn subagents (Phase-2). ToolClass union does not have a
  // routine-specific class yet; 'claude-cli-subspawn' is the correct escalation.
  enforcePermissionFromSingleton({
    scope: { workspaceId },
    toolClass: "claude-cli-subspawn",
    op: `routine:${routineId}`,
    toolName: "routine-plan-dispatch",
  });

  // ── Parse plan-dispatch columns ──────────────────────────────────────────
  const cols = parsePlanDispatchColumns(routineRow);
  const sopId = cols.sop_id ?? null;
  const goalPrompt = cols.goal_prompt ?? null;   // N1: verbatim — no modification
  const mcpAllowlistRaw = parseJsonArraySafe(cols.mcp_tool_allowlist_json);
  const skillBindings = cols.skill_bindings_json ?? null;

  // ── Guard: need sopId OR goalPrompt ─────────────────────────────────────
  if (!sopId && !goalPrompt) {
    const finishedAt = Date.now();
    return {
      runId,
      routineId,
      status: "failure",
      startedAt,
      finishedAt,
      output: "",
      error:
        "plan-dispatch: routine has neither sopId nor goalPrompt — " +
        "cannot build a plan skeleton. " +
        "Set sop_id or goal_prompt on the routine row.",
    };
  }

  // ── Binding resolution (N8, K1 hard-block) ───────────────────────────────
  const binding: RoutineBinding = {
    mcpToolAllowlist: mcpAllowlistRaw,
    // Skills from skill_bindings_json: defensively decode as flat array for
    // the resolver; the per-step override map is a Phase-2 concern.
    skills: skillBindings ? parseJsonArraySafe(skillBindings) : [],
  };

  const resolvedBinding = resolveBinding(binding, {
    // Phase-1: no live MCP discovery available in the routine runner context.
    // All MCP tools will be denied (unknown → denied, fail-safe N6).
    // Phase-2 would inject the discovered tool list from the MCP server here.
    discoveredTools: [],
  });

  // N8 audit hook (best-effort, in-memory callback in Phase-1).
  // PHASE2_MCP_REALINVOKE: a Phase-2 DB-write audit hook would replace this.
  //
  // F3: auditBindingResolution does NOT swallow callback throws (per its
  // docstring — it surfaces them so a Phase-2 DB-write failure can roll back
  // the transaction). In Phase-1 the callback is only stderr.write (never
  // throws), but we wrap defensively so a future audit-sink throw can never
  // abort the whole plan-dispatch run — the binding resolution itself already
  // succeeded and is best-effort trace, not a hard gate in Phase-1.
  try {
    auditBindingResolution(
      {
        routineId,
        workspaceId,
        binding,
        resolved: resolvedBinding,
        decidedAt: Date.now(),
      },
      (payload) => {
        // Phase-1: log only.  N8 DB-write is Phase-2 (lazyos_binding_resolution_audit).
        process.stderr.write(
          `[routines/plan-dispatch] binding-audit routine=${payload.routineId} ` +
            `role=${payload.resolved.role} ` +
            `mcpTools=${JSON.stringify(payload.resolved.mcpTools)} ` +
            `denied=${JSON.stringify(payload.resolved.deniedMcpTools)}\n`,
        );
      },
    );
  } catch (auditErr) {
    // Best-effort: a thrown audit sink must not abort the run in Phase-1.
    // Phase-2 (fail-closed DB audit) would re-evaluate this and roll back.
    process.stderr.write(
      `[routines/plan-dispatch] binding-audit hook threw (non-fatal, Phase-1): ` +
        `${auditErr instanceof Error ? auditErr.message : String(auditErr)}\n`,
    );
  }

  // ── Build Plan Nodes ─────────────────────────────────────────────────────
  // Path A: sopId set → deterministic expand (N6, no LLM, no I/O).
  // Path B: goalPrompt only → LLM-propose via tryPlanDispatch (non-destructive).
  let planWorkstreamId: string | undefined;
  let planId: string | undefined;

  if (sopId) {
    // Path A: SOP-backed plan skeleton.
    const sop = getSop(sopId);
    if (!sop) {
      const finishedAt = Date.now();
      return {
        runId,
        routineId,
        status: "failure",
        startedAt,
        finishedAt,
        output: "",
        error: `plan-dispatch: sopId="${sopId}" not found or archived.`,
      };
    }

    // F9: deterministic mintId so a retry of the same routine+SOP produces the
    // same plan/step IDs → identical N10 content_hash → INSERT OR IGNORE
    // idempotency holds (no hash drift across retries). The seed is stable per
    // (routineId, sopId); a monotonic counter disambiguates the 3 IDs per node
    // (plan.id, step.id, node.id) in expandSopToPlanNodes call order.
    // It deliberately does NOT include the workstreamId (which is minted later
    // and would itself vary across retries) — routineId+sopId is the stable key.
    let mintCounter = 0;
    const deterministicMintId = (): string =>
      `pd-${routineId}-${sopId}-${mintCounter++}`;

    const nodes = expandSopToPlanNodes(sop, { mintId: deterministicMintId });
    if (nodes.length === 0) {
      const finishedAt = Date.now();
      return {
        runId,
        routineId,
        status: "failure",
        startedAt,
        finishedAt,
        output: "",
        error: `plan-dispatch: SOP "${sopId}" expanded to 0 nodes (empty SOP).`,
      };
    }

    // Intent text: goalPrompt verbatim if provided; SOP name as fallback (N1).
    const intentText = goalPrompt ?? sop.name;

    // Create workstream (N1: intentText verbatim in description).
    const ws = await createWorkstream({
      workspaceId,
      name: intentText.length <= 80 ? intentText : `${intentText.slice(0, 79)}…`,
      description: intentText,
    });
    planWorkstreamId = ws.id;
    const coordKey = `${workspaceId}/${planWorkstreamId}`;

    // Persist all nodes in a single transaction (N10: insertProposedPlan stamps contentHash).
    const db = getDb();
    const rootPlan = nodes[0]!.plan;
    planId = rootPlan.id;

    const persist = db.$raw.transaction((): void => {
      for (const node of nodes) {
        insertProposedPlan({
          workstreamId: planWorkstreamId!,
          plan: node.plan,
          depth: 0,
          coordKey,
        });
      }
    });
    persist();

    // N8: trace the decision.
    writeDecision({
      workspaceId,
      workstreamId: planWorkstreamId,
      coordKey,
      decisionKind: "route",
      rationale: `Routine "${routineId}" fired plan-dispatch via SOP "${sopId}" (${nodes.length} nodes). Engine: text-only, codex excluded.`,
      actor: "agent",
    });

    // Execute (text-only, non-destructive).
    // PHASE2_MCP_REALINVOKE: resolvedBinding.mcpTools would be forwarded here
    // to the subagent spawn after R3-gate approval (Phase-2 only).
    //
    // F5 — K1-PATTERN-DRIFT GUARD (mandatory before any real-invoke):
    //   binding-resolver.ts inlines ONLY the 4 canonical-tool K1_RAG_DENY_PATTERNS
    //   (mcp__local-rag__*, mcp__standards-rag__*, mcp__lazyos-rag__*,
    //   mcp__*-global-rag__*). It deliberately OMITS the 8-entry server-name-only
    //   deny list + FILTER_VERSION held in lib-v1/mcp/tool-registry-filter.ts
    //   (MCP_TOOL_DENY_LIST). That omission is SAFE for Phase-1 (mcpTools are never
    //   invoked), but BEFORE Phase-2 forwards mcpTools to a real spawn, the K1
    //   pattern set here MUST be reconciled against MCP_TOOL_DENY_LIST +
    //   FILTER_VERSION so no RAG/cross-scope tool slips through a drift gap.
    await executePlan({
      workstreamId: planWorkstreamId,
      workspaceId,
      planId,
      coordKey,
    });

  } else {
    // Path B: LLM-propose via tryPlanDispatch (goalPrompt guaranteed non-null here).
    const dispatchResult = await tryPlanDispatch({
      workspaceId,
      prompt: goalPrompt!,
    });

    if (!dispatchResult.decomposed || !dispatchResult.workstreamId || !dispatchResult.planId) {
      const finishedAt = Date.now();
      return {
        runId,
        routineId,
        status: "failure",
        startedAt,
        finishedAt,
        output: "",
        error: `plan-dispatch: tryPlanDispatch did not decompose — reason: ${dispatchResult.reason}`,
      };
    }

    planWorkstreamId = dispatchResult.workstreamId;
    planId = dispatchResult.planId;
    const coordKey = `${workspaceId}/${planWorkstreamId}`;

    // N8: trace.
    writeDecision({
      workspaceId,
      workstreamId: planWorkstreamId,
      coordKey,
      decisionKind: "route",
      rationale: `Routine "${routineId}" fired plan-dispatch via LLM-propose (goalPrompt). Engine: text-only, codex excluded. Reason: ${dispatchResult.reason}`,
      actor: "agent",
    });

    // Execute (text-only, non-destructive).
    // PHASE2_MCP_REALINVOKE: resolvedBinding.mcpTools would be forwarded here.
    //
    // F5 — K1-PATTERN-DRIFT GUARD (mandatory before any real-invoke): see the
    // identical note on the Path-A executePlan call above. The K1 deny set in
    // binding-resolver.ts (4 canonical patterns) MUST be reconciled against
    // lib-v1/mcp/tool-registry-filter.ts MCP_TOOL_DENY_LIST + FILTER_VERSION
    // (8 server-name entries, deliberately omitted here) before Phase-2 wires
    // mcpTools into a real spawn.
    await executePlan({
      workstreamId: planWorkstreamId,
      workspaceId,
      planId,
      coordKey,
    });
  }

  const finishedAt = Date.now();
  return {
    runId,
    routineId,
    status: "success",
    startedAt,
    finishedAt,
    output: JSON.stringify({
      mode: "plan-dispatch",
      workstreamId: planWorkstreamId,
      planId,
      // Phase-1: mcpTools resolved + audited but NOT used for real-invoke.
      resolvedMcpTools: resolvedBinding.mcpTools,
      deniedMcpTools: resolvedBinding.deniedMcpTools,
    }),
    deliveryRef: planWorkstreamId,
  };
}

// ---------------------------------------------------------------------------
// Public API — executeRoutine
// ---------------------------------------------------------------------------

export interface ExecuteOptions {
  /** If set: skips the lastRunAt+nextRunAt update. For event-triggered runs. */
  skipScheduleUpdate?: boolean;
  /** Optional trigger marker (event-id, manual, cron) — lands in the run record. */
  trigger?: "manual" | "cron" | "event";
}

/**
 * Loads the routine from the DB, validates YAML, executes, writes the run record,
 * and updates `last_run_at`/`next_run_at` (in cron mode).
 *
 * Does NOT throw — all errors land as a run record with status='failure'.
 * The caller (tick loop) must NOT react to 1-N exceptions per batch.
 */
export async function executeRoutine(
  routineId: string,
  options: ExecuteOptions = {},
): Promise<RunResult> {
  const db = getDb();
  const runId = `RNR-${ulid()}`;
  const startedAt = Date.now();

  // Fetch routine row.
  const rows = await db
    .select()
    .from(routines)
    .where(eq(routines.id, routineId))
    .limit(1);
  const row = rows[0];

  if (!row) {
    const finishedAt = Date.now();
    return {
      runId,
      routineId,
      status: "failure",
      startedAt,
      finishedAt,
      output: "",
      error: `routine ${routineId} not found`,
    };
  }

  // Insert a running-marker row so the UI can show "läuft gerade".
  db.insert(routineRuns)
    .values({
      id: runId,
      routineId,
      startedAt,
      status: "running",
    })
    .run();

  // ── SAR-3: plan-dispatch branch ──────────────────────────────────────────
  // Read the new columns via $raw (they were added by Migration 0099 via
  // ALTER TABLE and are not yet in the Drizzle schema object).
  const pdRow = db.$raw
    .prepare(
      `SELECT action_kind, sop_id, goal_prompt, skill_bindings_json,
              mcp_tool_allowlist_json, workspace_id
         FROM routines WHERE id = ? LIMIT 1`,
    )
    .get(routineId) as Record<string, unknown> | undefined;

  const rawActionKind =
    typeof pdRow?.["action_kind"] === "string"
      ? pdRow["action_kind"]
      : "shell";

  // F6: detect a silent plan-dispatch→shell downgrade. parsePlanDispatchColumns
  // is intentionally dumb (returns 'shell' on any Zod failure). If the raw column
  // says 'plan-dispatch' but the parser produced 'shell', the operator would
  // otherwise never learn that the bridge silently ran as a shell pipeline.
  // We surface that on stderr here (the parser stays dumb — N6 separation).
  if (rawActionKind === "plan-dispatch") {
    const parsedCheck = parsePlanDispatchColumns(pdRow ?? {});
    if (parsedCheck.action_kind !== "plan-dispatch") {
      process.stderr.write(
        `[routine] plan-dispatch parse failed, falling back to shell id=${routineId} ` +
          `(raw action_kind='plan-dispatch' but parser yielded '${parsedCheck.action_kind}' — ` +
          `check Migration 0099 columns / JSON validity)\n`,
      );
    }
  }

  // F4: the new columns come from a raw SELECT and `workspace_id` could be NULL
  // on a malformed row. The Drizzle `row.workspaceId` (NOT NULL in schema) is the
  // trusted scope source — pass it explicitly so runPlanDispatch never operates
  // with an empty ManifestCoord scope (N9).
  const actionKind = rawActionKind;

  if (actionKind === "plan-dispatch") {
    try {
      const result = await runPlanDispatch(
        routineId,
        pdRow ?? {},
        runId,
        startedAt,
        row.workspaceId,
      );

      db.update(routineRuns)
        .set({
          status: result.status === "success" ? "success" : "failure",
          finishedAt: result.finishedAt,
          output: result.output,
          deliveryRef: result.deliveryRef ?? null,
          error: result.error ?? null,
        })
        .where(eq(routineRuns.id, runId))
        .run();

      await updateSchedule(routineId, startedAt, row.triggerMode, row.cronExpr, options);
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const finishedAt = Date.now();
      db.update(routineRuns)
        .set({ status: "failure", finishedAt, error: `plan-dispatch: ${msg}` })
        .where(eq(routineRuns.id, runId))
        .run();
      await emitErrorEvent(row.workspaceId, `routines.plan-dispatch:${routineId}`, err);
      await updateSchedule(routineId, startedAt, row.triggerMode, row.cronExpr, options);
      return {
        runId,
        routineId,
        status: "failure",
        startedAt,
        finishedAt,
        output: "",
        error: `plan-dispatch threw: ${msg}`,
      };
    }
  }
  // ── End SAR-3 branch ─────────────────────────────────────────────────────

  try {
    const routine = validateYamlConfig(row.yamlConfig);
    const cwd = resolveWorkspaceCwd(routine.workspaceId);

    // 1. Dedup check (if configured).
    if (routine.dedup) {
      const dup = await isDuplicateRecently(
        routine.workspaceId,
        routine.dedup.key,
        routine.dedup.withinHours,
      );
      if (dup) {
        const finishedAt = Date.now();
        db.update(routineRuns)
          .set({
            status: "skipped",
            finishedAt,
            output: `skipped (dedup "${routine.dedup.key}" within ${routine.dedup.withinHours}h)`,
          })
          .where(eq(routineRuns.id, runId))
          .run();
        await updateSchedule(routineId, startedAt, row.triggerMode, row.cronExpr, options);
        return {
          runId,
          routineId,
          status: "skipped",
          startedAt,
          finishedAt,
          output: "",
        };
      }
    }

    // 2. Collect commands.
    const results: CommandResult[] = [];
    for (const cmd of routine.commands) {
      results.push(runCommand(cmd, cwd));
    }

    // 3. Render markdown.
    const markdown = renderMarkdown(routine, results);
    const failures = results.filter((r) => r.exitCode !== 0).length;

    // 4. Deliver.
    let deliveryRef: string;
    try {
      switch (routine.delivery) {
        case "stdout":
          deliveryRef = await deliverStdout(markdown);
          break;
        case "memory_write":
          deliveryRef = await deliverMemoryWrite(routine, markdown);
          break;
        case "ticket_create":
          deliveryRef = await deliverTicketCreate(routine, markdown);
          break;
        case "push_send":
          deliveryRef = await deliverPushSend(routine, markdown);
          break;
        case "decision_request":
          deliveryRef = await deliverDecisionRequest(routine, markdown);
          break;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const finishedAt = Date.now();
      db.update(routineRuns)
        .set({
          status: "failure",
          finishedAt,
          output: markdown,
          error: `delivery (${routine.delivery}) failed: ${msg}`,
        })
        .where(eq(routineRuns.id, runId))
        .run();
      await updateSchedule(
        routineId,
        startedAt,
        row.triggerMode,
        row.cronExpr,
        options,
      );
      return {
        runId,
        routineId,
        status: "failure",
        startedAt,
        finishedAt,
        output: markdown,
        error: msg,
      };
    }

    // 5. Persist final run status.
    const finishedAt = Date.now();
    const status: RunResult["status"] =
      failures === 0 ? "success" : failures === results.length ? "failure" : "partial";

    db.update(routineRuns)
      .set({
        status,
        finishedAt,
        output: markdown,
        deliveryRef,
        error: failures > 0 ? `${failures}/${results.length} commands failed` : null,
      })
      .where(eq(routineRuns.id, runId))
      .run();

    await updateSchedule(routineId, startedAt, row.triggerMode, row.cronExpr, options);

    return {
      runId,
      routineId,
      status,
      startedAt,
      finishedAt,
      output: markdown,
      deliveryRef,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const finishedAt = Date.now();
    db.update(routineRuns)
      .set({ status: "failure", finishedAt, error: msg })
      .where(eq(routineRuns.id, runId))
      .run();
    await emitErrorEvent(row.workspaceId, `routines.execute:${routineId}`, err);
    await updateSchedule(routineId, startedAt, row.triggerMode, row.cronExpr, options);
    return {
      runId,
      routineId,
      status: "failure",
      startedAt,
      finishedAt,
      output: "",
      error: msg,
    };
  }
}

async function updateSchedule(
  routineId: string,
  startedAt: number,
  triggerMode: string,
  cronExpr: string | null,
  options: ExecuteOptions,
): Promise<void> {
  if (options.skipScheduleUpdate) return;
  const db = getDb();
  let next: number | null = null;
  if (triggerMode === "cron" && cronExpr) {
    next = nextRunAt(cronExpr, startedAt);
  }
  db.update(routines)
    .set({
      lastRunAt: startedAt,
      nextRunAt: next,
      updatedAt: Date.now(),
    })
    .where(eq(routines.id, routineId))
    .run();
}

// ---------------------------------------------------------------------------
// Tick loop — called by a systemd timer or an API cron job
// ---------------------------------------------------------------------------

export interface TickResult {
  checkedAt: number;
  candidates: number;
  executed: number;
  skipped: number;
  runs: RunResult[];
}

/**
 * Checks all active cron routines and runs the due ones (`next_run_at <= now`).
 * Called by the POST /api/routines/tick endpoint and/or a systemd timer.
 * Idempotent per tick (a lock is not needed for the single-node MVP).
 *
 * Hard cap: max. 10 routines per tick so a backlog does not block everything.
 */
export async function tick(now: number = Date.now()): Promise<TickResult> {
  const db = getDb();
  const rows = await db
    .select()
    .from(routines)
    .where(and(eq(routines.active, true), eq(routines.triggerMode, "cron")));

  const due = rows.filter((r) => r.nextRunAt !== null && r.nextRunAt <= now);
  const capped = due.slice(0, 10);

  // If cron routines do not yet have a nextRunAt (freshly created),
  // we compute it now for the first time — without firing them immediately.
  const needsSchedule = rows.filter(
    (r) => r.cronExpr && r.nextRunAt === null,
  );
  for (const r of needsSchedule) {
    const next = r.cronExpr ? nextRunAt(r.cronExpr, now) : null;
    if (next !== null) {
      db.update(routines)
        .set({ nextRunAt: next, updatedAt: Date.now() })
        .where(eq(routines.id, r.id))
        .run();
    }
  }

  const runs: RunResult[] = [];
  for (const r of capped) {
    runs.push(await executeRoutine(r.id, { trigger: "cron" }));
  }

  return {
    checkedAt: now,
    candidates: due.length,
    executed: capped.length,
    skipped: due.length - capped.length,
    runs,
  };
}

// ---------------------------------------------------------------------------
// Event-match helper (for heartbeat-stall etc.)
// ---------------------------------------------------------------------------

export interface EventMatchCandidate {
  eventType: string;
  entityType?: string;
  payload: Record<string, unknown>;
}

export async function findEventTriggeredRoutines(
  candidate: EventMatchCandidate,
): Promise<Array<{ id: string; match: Record<string, unknown> | null }>> {
  const db = getDb();
  const rows = await db
    .select({ id: routines.id, eventMatch: routines.eventMatch })
    .from(routines)
    .where(and(eq(routines.active, true), eq(routines.triggerMode, "event")));

  const matched: Array<{ id: string; match: Record<string, unknown> | null }> =
    [];
  for (const row of rows) {
    if (!row.eventMatch) continue;
    let match: {
      eventType: string;
      entityType?: string;
      payloadMatch?: Record<string, unknown>;
    };
    try {
      match = JSON.parse(row.eventMatch);
    } catch {
      continue;
    }
    if (match.eventType !== candidate.eventType) continue;
    if (match.entityType && match.entityType !== candidate.entityType) continue;
    if (match.payloadMatch) {
      const allOk = Object.entries(match.payloadMatch).every(
        ([k, v]) => candidate.payload[k] === v,
      );
      if (!allOk) continue;
    }
    matched.push({ id: row.id, match: match.payloadMatch ?? null });
  }
  return matched;
}

// ---------------------------------------------------------------------------
// History helper (for API + UI)
// ---------------------------------------------------------------------------

export async function getRunHistory(
  routineId: string,
  limit: number = 20,
): Promise<
  Array<{
    id: string;
    startedAt: number;
    finishedAt: number | null;
    status: string;
    error: string | null;
    deliveryRef: string | null;
  }>
> {
  const db = getDb();
  const rows = await db
    .select({
      id: routineRuns.id,
      startedAt: routineRuns.startedAt,
      finishedAt: routineRuns.finishedAt,
      status: routineRuns.status,
      error: routineRuns.error,
      deliveryRef: routineRuns.deliveryRef,
    })
    .from(routineRuns)
    .where(eq(routineRuns.routineId, routineId))
    .orderBy(desc(routineRuns.startedAt))
    .limit(Math.min(limit, 100));
  return rows;
}
