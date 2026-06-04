/**
 * lib/workstreams/plan-executor.ts
 * ---------------------------------
 * Slice 3 · phase 1 → EXEC (2026-05-26, laz.ing Swarm Runtime V1.1).
 *
 * TWO-MODE EXECUTOR (consent-gated, R1-isolated, parallel):
 *
 *   A) Default / safe (mode unset / 'ask'):
 *      Per step ONLY `engine.chat({messages})` — pure, tool-less text completion.
 *      NO files written, NO shell executed. This is BIT-IDENTICAL
 *      to the pre-EXEC behavior. Real tool execution happens ONLY when the
 *      workspace was explicitly set to FreeRein/Lane (user consent).
 *
 *   B) Consented (mode = 'freerein' / 'freerein-with-audit' / 'lane'):
 *      When the resolved mode grants tools (allowedTools non-empty) AND
 *      the R2 decision is allow, the step runs as a REAL tool spawn via
 *      `spawnInTmux` (--allowedTools <mode-tools> + --permission-mode acceptEdits,
 *      incl. Bash under FreeRein). This happens MANDATORILY in R1 worktree isolation:
 *      createRunWorktree → spawn in the isolated worktree → discardRunWorktree in
 *      the finally. The live checkout is NEVER touched; merge stays gated (R3).
 *      ENV `env -i`-scrubbed + K1 `--disallowedTools` (hard) are in tmux-spawn.
 *
 * PARALLELISM (task B):
 *   The former sequential loop is replaced by a dependency graph +
 *   ready queue. Steps without open `depends_on` start in parallel,
 *   bounded by the resource pool (N11 heavyTotal=2). On step-done,
 *   dependent steps become ready. Cycle-safe (cycle → sequential fallback + warn).
 *   Error-isolated per step. The status card shows running/waiting/done.
 *
 * Safety constraints (critical):
 *   - Default (unset/ask) = exactly today's safe behavior (text-only).
 *   - Bash/writes ALWAYS in R1 worktree isolation, merge stays gated.
 *   - codex stays excluded (code-mode agent, writes files/shell).
 *   - N8 audit per real tool run: a tamper-evident `workstream_decisions` row
 *     (writeDecision, content_hash-chained, N10) BEFORE the spawn + stdout audit.
 *
 * RESIDUAL (by design — honestly delimited): FreeRein-Bash = system access
 *   via an arbitrary shell. This is the explicit consent given by the user via
 *   the permission mode. R1 worktree isolation limits
 *   ONLY git operations (writes/commits/merge happen in the throwaway branch, never
 *   in the live checkout; merge is additionally gated). It does NOT limit the
 *   file reach of the process: a FreeRein-Bash run runs with the
 *   process uid and can read by ABSOLUTE path whatever that uid may read —
 *   incl. $HOME (in the env allowlist so MAX auth works), the live DB at
 *   the well-known path ($HOME/.lazyos/lazyos.db, cf. db/client.ts), a
 *   `.env.local` in the live repo root, and other projects in the home directory. `env -i`
 *   only scrubs ENV secrets, K1 locks MCP-RAG tools — neither prevents an
 *   absolute file read. The REAL multi-tenant hardening would be an OS sandbox
 *   (sandbox-exec / read-only bind of just the worktree + deny of the rest of the FS);
 *   that is DELIBERATELY NOT active yet. FreeRein therefore remains explicit,
 *   trusting user consent, not a multi-tenant sandbox promise.
 *
 * N1 (detail): step titles + rationales VERBATIM from the DB. N6: deterministic
 *   R2 gate + graph walk before every execution. N8: audit per step. N9: coordKey
 *   on all card emits. N10: content_hash stays untouched (plan-repo).
 *   N11: parallelism bound to the RESPECTIVELY correct resource (see below).
 *
 * PARALLELISM WIDTH (SLOT DECOUPLING 2026-05-26):
 *   The former `maxParallel = heavyTotal(=2)` was an artificial cap of 2
 *   for ALL plan steps — it conflated the real N11 limit ("max 2 heavy
 *   local Ollama jobs") with "max parallel plan steps / claude-cli spawns".
 *   Now the width is PLAN-DERIVED (= number of independent ready steps),
 *   bound by the RESPECTIVELY correct resource:
 *     - text-only/read steps  → textConcurrency (core-derived, ~6),
 *                               NO heavy-Ollama slot, NO worktree.
 *     - claude-cli spawn steps → spawnConcurrency (== worktree cap 5),
 *                               the real isolation limit.
 *     - heavy-Ollama use WITHIN a step → additionally the
 *                               ollama-heavy slot (heavyOllama=2), orthogonal.
 *   The cycle fallback stays width 1 (sequential). N11 stays honored:
 *   worktrees ≤ 5 (createRunWorktree cap untouched), heavy Ollama jobs ≤ 2
 *   (ollama-heavy slot). ONLY the cap of 2 on claude-cli/text steps falls away.
 */

import { listRootPlanSteps, setPlanStepStatus } from '@/lib/workstreams/plan-repo';
import { detectEngines, pickEngine } from '@/lib/llm/engines/selector';
import { protectEngine } from '@/lib/privacy/protect';
import { resourcePool } from '@/lib/agents/resource-pool';
import { MODEL_NAMES } from '@/lib/agents/pricing';
import { waitForBudget } from '@/lib/agents/tpm-budget';
import { emitOrUpdateCard } from '@/lib/events/emit-or-update-card';
import { emitChatMessageCompleted } from '@/lib/events/emit';
import { ulid } from '@/lib/ulid';
import { readPublicBaseOverride } from '@/lib/hosting/public-base';
import type { WorkstreamPlanStepRow } from '@/db/schema/workstream_plan_steps';
import { enforceExecutionStep, type PermissionModeForGate } from '@/lib/security/execution-policy';
import {
  resolveAllowedToolsForMode,
  readWorkspacePermissionMode,
} from '@/lib/security/permission-tools';
import { spawnInTmux } from '@/server/agents/tmux-spawn';
import {
  createOrReuseRunWorktree,
  createStepWorktree,
  mergeStepIntoRun,
  discardStepWorktree,
} from '@/lib/agents/worktree-manager';
import { writeDecision, writeEvidence } from '@/lib/workstreams/trace-repo';
import {
  renderDesignSystemPrompt,
  parseChosenAccent,
} from '@/lib/flow/design-system';
// LANE-2 (2026-05-30): Demo PV / PV-stringing producer wiring.
// The pv-stringing skill (compose.ts) -> 'coder' (compile.ts) is intercepted
// here BEFORE the generic coder spawn: instead of a claude-cli worktree spawn,
// the DETERMINISTIC producer runs (N6, no LLM/I/O) and writes its
// PvArtifact (surfacePayload.strings[]/inverters[]) as step output, which
// from-artifact.ts -> evaluate.ts (G5) consumes.
import {
  produceStringingPlan,
  buildExpertReviewGate,
  type StringingProducerInput,
} from '@/lib/eval/demo-pv/producer';
import {
  buildDemoStringingInput,
  isDemoPvIntent,
} from '@/lib/eval/demo-pv/demo-hardware';
import { parseFlowAnnotation } from '@/lib/flow/from-workstream';
import { execFile as _execFile } from 'node:child_process';
import { promisify as _promisify } from 'node:util';

const execFileAsync = _promisify(_execFile);

/**
 * 2026-05-29 (Opus 4.8) — lossless persistence BEFORE the worktree discard
 * (cross-roast: the smallest safe step against work loss). Captures the
 * full delta of the step worktree (committed + uncommitted) against the
 * base SHA and returns a stat + the verbatim diff (N1: no truncation).
 * Strictly fail-soft: NEVER throws — a capture error must never disturb the
 * finally/discard. Returns null when nothing could be captured.
 *
 * NOTE: This is step 1 of the accumulation plan — it STOPS the loss
 * (work lands as a patch in the trace, recoverable), but does NOT yet solve
 * composition (steps still do NOT build on each other). Steps 2-4
 * (accumulating run branch + serial merge + gated operator merge) follow.
 */
async function captureWorktreeDiff(
  worktreePath: string,
  baseSha: string | null,
): Promise<{ stat: string; diff: string } | null> {
  try {
    // Stage uncommitted changes so the diff captures committed+uncommitted.
    await execFileAsync('git', ['-C', worktreePath, 'add', '-A']).catch(() => {});
    const base = baseSha && /^[0-9a-f]{7,40}$/.test(baseSha) ? baseSha : 'HEAD';
    const [statRes, diffRes] = await Promise.all([
      execFileAsync('git', ['-C', worktreePath, 'diff', '--stat', base], {
        maxBuffer: 8 * 1024 * 1024,
      }).catch(() => ({ stdout: '' })),
      execFileAsync('git', ['-C', worktreePath, 'diff', base], {
        maxBuffer: 32 * 1024 * 1024,
      }).catch(() => ({ stdout: '' })),
    ]);
    const stat = (statRes.stdout || '').trim();
    const diff = (diffRes.stdout || '').trim();
    if (stat.length === 0 && diff.length === 0) return null;
    return { stat, diff };
  } catch {
    return null; // never throw
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

export interface ExecutePlanArgs {
  workstreamId: string;
  workspaceId: string;
  planId: string;
  /** ManifestCoord-Key (N9), Format: "<workspaceId>/<workstreamId>". */
  coordKey: string;
}

/**
 * Hard total deadline for the background run (critic fix M2). Without a cap,
 * a multi-stage plan could hold slots for minutes with no abort path
 * (the route returns 202 immediately, there is no request lifecycle anymore).
 * After the deadline, acquireSlot/engine.chat abort → remaining steps
 * quickly fall to 'failed'.
 */
const EXEC_TOTAL_DEADLINE_MS = 240_000;

/** Status values the status card shows (running/waiting/done). */
type StepStatus = 'pending' | 'active' | 'done' | 'failed';

/**
 * W2.1 (2026-05-30): detects website-like intents (same keywords as the
 * assembly-step append in compose.ts). Only then are the mandatory
 * design system + the artifact chaining forwarded — otherwise the
 * prompt stays bit-identical to the pre-W2.1 behavior (backwards-compatible). N6.
 */
export function isWebsiteIntent(intent: string): boolean {
  return /\b(website|webseite|web-?site|landing|landingpage|landing-page|homepage|home-?page|page|site)\b/i.test(
    intent || '',
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Flow-graph structure-hash cache (Flow Studio stream C · C1, 2026-05-27)
// ────────────────────────────────────────────────────────────────────────────
//
// FINDING (stream C): the <surface:flow-graph> emission so far fired on EVERY
// updateCard call — i.e. coupled only to step STATUS transitions. Owner SHOULD:
// "always visualize too when something changes/extends" — so ALSO on
// STRUCTURE changes (new steps, changed depends_on/edges, changed tools).
//
// Solution (additive, N6 deterministic): we compute per emit a STRUCTURE
// hash over the nodes (id+label+skill+tool) + edges (from→to) — deliberately WITHOUT
// the running statuses (those are captured separately as runStatus). We cache per
// (workspaceId, workstreamId) the last emitted structure hash AND
// run status. A re-emit is only needed when structure OR runStatus
// changed. So a pure status repetition produces NO redundant
// emit, while a structure extension MANDATORILY triggers a new visualization
// (even when runStatus stays the same).
//
// A Map instead of a memory-leak risk: the keys are short-lived per run; a run does NOT
// explicitly clear its entry on completion (best-effort), but the map grows
// only by the number of concurrently running runs — negligible (N11: max 5
// worktrees, plan runs are rarer). If desired the executor can delete the
// entry at the end; we keep it minimally invasive.
interface FlowGraphEmitState {
  structureHash: string;
  runStatus: string;
}
const flowGraphEmitCache = new Map<string, FlowGraphEmitState>();

/**
 * Exported for testability (stream C · C1): clears the structure-hash cache. Called by
 * the C1 test between cases so one case doesn't clog the next.
 * NOT needed in production (keys are run-scoped) — purely for deterministic tests.
 */
export function __resetFlowGraphEmitCacheForTests(): void {
  flowGraphEmitCache.clear();
}

/** Deterministic structure hash over nodes (without status) + edges. N6. */
export function computeFlowStructureHash(
  nodes: ReadonlyArray<{ id: string; label: string; skill?: string; tool?: string }>,
  edges: ReadonlyArray<{ from: string; to: string }>,
): string {
  // Stable, status-free serialization. Nodes sorted by id (order-
  // independent), edges as sorted from>to pairs. A plain string comparison
  // suffices — we need no cryptographic strength (no tamper protection here,
  // that's content_hash on the plan-step rows; N10 stays untouched).
  const nodePart = [...nodes]
    .map((n) => `${n.id}${n.label}${n.skill ?? ''}${n.tool ?? ''}`)
    .sort()
    .join('');
  const edgePart = [...edges]
    .map((e) => `${e.from}>${e.to}`)
    .sort()
    .join('');
  return `${nodePart}|${edgePart}`;
}

/**
 * C1 core (testable): decides whether the flow-graph surface must be
 * (re-)emitted, and updates the cache. True = emit. The side effect on
 * the cache is intentional (last-emitted state). Pure status repetition →
 * false; structure change OR runStatus change → true.
 */
export function shouldEmitFlowGraph(
  cacheKey: string,
  structureHash: string,
  runStatus: string,
): boolean {
  const prev = flowGraphEmitCache.get(cacheKey);
  const changed =
    !prev || prev.structureHash !== structureHash || prev.runStatus !== runStatus;
  if (changed) {
    flowGraphEmitCache.set(cacheKey, { structureHash, runStatus });
  }
  return changed;
}

// ────────────────────────────────────────────────────────────────────────────
// Workspace FS path resolution (for R1 worktree isolation)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Resolves the FS path of a workspace (= repoPath for createRunWorktree).
 * Mirror of the private helpers in app/api/bugs/swarm/route.ts +
 * lib/tickets/auto-dispatch.ts (workspaces.path → fallback projects/<id>).
 *
 * Lazy import so the text-only path (default) touches no DB/workspace service
 * — it is called ONLY when real tool spawns should run.
 */
async function resolveWorkspacePath(workspaceId: string): Promise<string> {
  try {
    const { getWorkspace } = await import('@/lib/workspaces');
    const ws = await getWorkspace(workspaceId);
    if (ws?.path) return ws.path;
  } catch {
    /* ignore — fallback below */
  }
  const { defaultWorkspacePath } = await import('@/lib/workspaces/projects-root');
  return defaultWorkspacePath(workspaceId);
}

// ────────────────────────────────────────────────────────────────────────────
// Dependency-graph helpers (task B)
// ────────────────────────────────────────────────────────────────────────────

/** Defensively parses the `depends_on` JSON field of a step row into step IDs. */
function parseDependsOn(row: WorkstreamPlanStepRow): string[] {
  const raw = (row as { dependsOn?: string | null }).dependsOn;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((x): x is string => typeof x === 'string' && x.length > 0);
    }
  } catch {
    /* malformed → treat like no dependency (conservatively ready) */
  }
  return [];
}

/** Reads the `group_id` field (default: parentStepId, otherwise null). */
function readGroupId(row: WorkstreamPlanStepRow): string | null {
  const g = (row as { groupId?: string | null }).groupId;
  if (typeof g === 'string' && g.length > 0) return g;
  return row.parentStepId ?? null;
}

/**
 * Cycle detection over the depends_on graph (Kahn topo walk).
 * Returns true when a cycle exists OR a dependency points to an
 * unknown step ID that would clog the ready queue.
 *
 * On true → the caller falls back to sequential execution (warn).
 * N6: a purely deterministic graph walk, no LLM.
 */
function hasCycleOrDanglingDep(
  steps: readonly WorkstreamPlanStepRow[],
  depsById: Map<string, string[]>,
): boolean {
  const ids = new Set(steps.map((s) => s.id));

  // Dangling: a dependency points to a step ID that isn't in the plan.
  // That would block the ready queue forever → treat like a cycle.
  for (const deps of depsById.values()) {
    for (const d of deps) {
      if (!ids.has(d)) return true;
    }
  }

  // Kahn: repeatedly remove steps with 0 remaining open deps.
  const remaining = new Map<string, Set<string>>();
  for (const s of steps) {
    remaining.set(s.id, new Set(depsById.get(s.id) ?? []));
  }
  let progressed = true;
  while (progressed && remaining.size > 0) {
    progressed = false;
    for (const [id, deps] of Array.from(remaining.entries())) {
      if (deps.size === 0) {
        remaining.delete(id);
        for (const set of remaining.values()) set.delete(id);
        progressed = true;
      }
    }
  }
  // Whatever remains sits in a cycle.
  return remaining.size > 0;
}

// ────────────────────────────────────────────────────────────────────────────
// Card live-update helper
// ────────────────────────────────────────────────────────────────────────────

/**
 * Emits (or updates) the `subplan` card in the chat stream.
 * stepStatuses = current state of all step IDs (pending/active/done/failed).
 */
async function updateCard(opts: {
  workspaceId: string;
  workstreamId: string;
  planId: string;
  coordKey: string;
  steps: readonly WorkstreamPlanStepRow[];
  stepStatuses: Record<string, string>;
  originalIntent: string;
  /**
   * W2.2 (2026-05-30): step IDs that are NOW waiting on a blocking gate
   * (e.g. the expert-review gate). These steps stay 'active' in the DB,
   * but carry the `needs-input` status in the flow graph (→ an actionable node).
   * Optional — if the set is missing, the rendering is identical to before.
   */
  gateWaitingStepIds?: ReadonlySet<string>;
  /**
   * W2.2: per gate-waiting step, the gate kind the node taps on
   * (the SAME gate as the ActionDeck pin → one executeGateAction path, no
   * double routing). Default 'human-decision' (expert gate).
   */
  gateKindByStep?: ReadonlyMap<string, string>;
}): Promise<void> {
  const { workspaceId, workstreamId, planId, steps, stepStatuses, originalIntent } = opts;
  const gateWaitingStepIds = opts.gateWaitingStepIds ?? null;
  const gateKindByStep = opts.gateKindByStep ?? null;

  const rootPlanPayload = {
    id: planId,
    originalIntent,
    estimatedComplexity: 'L' as const,
    proposedAt: Date.now(),
    steps: steps.map((s) => ({
      id: s.id,
      index: s.stepIndex,
      title: s.title,       // N1: verbatim
      rationale: s.rationale, // N1: verbatim
      subagentRole: s.subagentRole ?? undefined,
      groupId: readGroupId(s),
    })),
    depth: 0,
    awaitingApproval: false,
    workstreamId,
    stepStatuses,
  };

  const preamble =
    `Plan wird ausgeführt.\n\n`;

  try {
    await emitOrUpdateCard({
      coords: { workspaceId, workstreamId, surfaceKind: 'subplan' },
      content:
        preamble +
        '<surface:subplan>' +
        JSON.stringify(rootPlanPayload) +
        '</surface:subplan>',
      actor: 'system',
    });
  } catch (err) {
    // The card update is best-effort — must not kill the step loop.
    console.warn('[plan-executor] emitOrUpdateCard failed (non-fatal):', err);
  }

  // Flow Studio (2026-05-27): ADDITIVELY emit the same run as <surface:flow-graph>
  // (n8n-style visualization; the subplan card stays untouched).
  // Its own best-effort try — must NEVER kill the step loop.
  try {
    // W2.2 (2026-05-30): `needs-input` added. A step is `needs-input` when
    // it is waiting on a blocking gate (gateWaitingStepIds) — it stays
    // 'active' in the DB but becomes actionable in the graph (detail panel → the ONE
    // executeGateAction path). The explicit 'needs-input' raw status is
    // also passed through (forward compatibility), in case it's ever persisted.
    const mapFlowStatus = (stepId: string, s: string | undefined): string => {
      if (gateWaitingStepIds && gateWaitingStepIds.has(stepId)) return 'needs-input';
      return s === 'active'
        ? 'running'
        : s === 'done'
          ? 'done'
          : s === 'failed'
            ? 'failed'
            : s === 'needs-input'
              ? 'needs-input'
              : 'idle';
    };
    const nodes = steps.map((s) => {
      let tool: string | undefined;
      const m = /\|\s*flow:(\{.*\})\s*$/.exec(s.rationale ?? '');
      if (m) {
        try {
          const parsed = JSON.parse(m[1]) as { tool?: string };
          if (parsed.tool) tool = parsed.tool;
        } catch { /* ignore */ }
      }
      const status = mapFlowStatus(s.id, stepStatuses[s.id]);
      // W2.2: a needs-input node carries the gate kind it taps on — the
      // node tap targets the SAME stream card as the ActionDeck pin
      // (executeGateAction(gate.kind) → one POST path, no drift).
      const gateKind =
        status === 'needs-input'
          ? (gateKindByStep?.get(s.id) ?? 'human-decision')
          : undefined;
      return {
        id: s.id,
        label: s.title,
        ...(s.subagentRole ? { skill: s.subagentRole } : {}),
        ...(tool ? { tool } : {}),
        status,
        ...(gateKind ? { gateKind } : {}),
      };
    });
    const edges: Array<{ from: string; to: string }> = [];
    for (const s of steps) {
      const raw = (s as { dependsOn?: string | null }).dependsOn;
      if (typeof raw === 'string' && raw.length > 0) {
        try {
          const deps = JSON.parse(raw);
          if (Array.isArray(deps)) {
            for (const d of deps) if (typeof d === 'string') edges.push({ from: d, to: s.id });
          }
        } catch { /* ignore */ }
      }
    }
    const vals = Object.values(stepStatuses);
    const runStatus = vals.includes('failed')
      ? 'failed'
      : vals.includes('active')
        ? 'running'
        : vals.length > 0 && vals.every((x) => x === 'done')
          ? 'done'
          : 'idle';

    // C1: only (re-)emit when STRUCTURE (nodes/edges/tools) OR
    // runStatus changed since the last emit. A pure status
    // repetition (e.g. a second updateCard call in the finally) produces NO
    // redundant emit; a structure extension (new steps / changed
    // depends_on / changed tools), by contrast, ALWAYS triggers a new visualization
    // — even when runStatus stays the same. Owner SHOULD: "always
    // visualize too when something changes/extends".
    const structureHash = computeFlowStructureHash(nodes, edges);
    const cacheKey = `${workspaceId}/${workstreamId}`;
    // W2.2: a switch into/out of `needs-input` does NOT change the FlowRunStatus
    // (the run continues), but must re-emit — otherwise the owner won't see the
    // just-opened, actionable gate node. The needs-input
    // signature (sorted IDs) is therefore folded into the emit key.
    const needsInputSig = nodes
      .filter((n) => n.status === 'needs-input')
      .map((n) => n.id)
      .sort()
      .join(',');
    const emitKey = needsInputSig ? `${runStatus}#ni:${needsInputSig}` : runStatus;
    if (shouldEmitFlowGraph(cacheKey, structureHash, emitKey)) {
      await emitOrUpdateCard({
        coords: { workspaceId, workstreamId, surfaceKind: 'flow-graph' },
        content:
          '<surface:flow-graph>' +
          JSON.stringify({
            workstreamId,
            // C3: workspaceId in the payload → the FlowGraphCard can
            // trigger "save as process" (POST /api/flow/from-workstream)
            // without having to guess the workspace from the URL/context.
            workspaceId,
            title: originalIntent,
            runStatus,
            nodes,
            edges,
          }) +
          '</surface:flow-graph>',
        actor: 'system',
      });
    }
  } catch (err) {
    console.warn('[plan-executor] flow-graph emit failed (non-fatal):', err);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Core executor
// ────────────────────────────────────────────────────────────────────────────

export async function executePlan(args: ExecutePlanArgs): Promise<void> {
  const { workstreamId, workspaceId, planId, coordKey } = args;

  // 1. Read steps — ordered by stepIndex (plan-repo: listRootPlanSteps).
  const allRootSteps = listRootPlanSteps(workstreamId);
  const filtered = allRootSteps.filter((s) => s.planId === planId);
  const steps = filtered.length > 0 ? filtered : allRootSteps;
  if (filtered.length === 0 && allRootSteps.length > 0) {
    console.warn(
      `[plan-executor] planId=${planId} matcht keine Steps in ws=${workstreamId} — ` +
        `führe alle ${allRootSteps.length} root-Steps aus.`,
    );
  }

  if (steps.length === 0) {
    console.warn(`[plan-executor] workstream=${workstreamId} hat keine root Steps (planId=${planId})`);
    return;
  }

  // originalIntent — workstream description verbatim (N1) or fallback label.
  let originalIntent = `Plan ${planId}`;
  try {
    const { getWorkstream } = await import('@/lib/workstreams/service');
    const ws = await getWorkstream(workstreamId);
    if (ws?.description) originalIntent = ws.description;
    else if (ws?.name) originalIntent = ws.name;
  } catch {
    /* non-fatal — the fallback label applies */
  }

  // 1b. Read the workspace permission mode (A2 / A·EXEC).
  //     Default (no row) → null → resolveAllowedToolsForMode(null) → plan-only.
  //     Real tool execution ONLY when FreeRein/Lane is explicitly set.
  let workspaceMode: import('@/lib-v1/permission/settings/schema').PermissionMode | null = null;
  try {
    const { getDb } = await import('@/db/client');
    workspaceMode = readWorkspacePermissionMode(getDb().$raw, workspaceId);
    console.info(
      `[plan-executor] workspace=${workspaceId} permission_mode=${workspaceMode ?? '(unset→plan-only)'}`,
    );
  } catch (modeErr) {
    // DB error on mode read → fail-closed: null → plan-only default remains.
    console.warn('[plan-executor] permission-mode read failed — falling back to plan-only:', modeErr);
  }

  // FreeRein/Lane grant real tools → we need the repoPath for
  // R1 worktree isolation. Resolve ONLY then (the text-only path stays DB-free).
  const modeGrantsTools =
    workspaceMode === 'freerein' ||
    workspaceMode === 'freerein-with-audit' ||
    workspaceMode === 'lane';
  let repoPath: string | null = null;
  if (modeGrantsTools) {
    try {
      repoPath = await resolveWorkspacePath(workspaceId);
    } catch (e) {
      console.warn('[plan-executor] resolveWorkspacePath failed — falling back to text-only:', e);
      repoPath = null;
    }
  }

  // 2. Pick the engine. EXCLUDE codex (code-mode agent → breaks isolation /
  //    the non-destructive mandate). Allowed: claude-cli (--print, tool-capable via
  //    tmux-spawn flags) + ollama (pure /api/chat POST, text-only).
  const selection = await detectEngines();
  // PII vault: wrap at the engine boundary. The text-only step branch sends the
  // step prompt (built from the verbatim user intent, N1) straight to claude-cli
  // (cloud) without going through spawnInTmux — so tokenize/rehydrate here. The
  // real-spawn branch is already covered by spawnInTmux; pass-through for ollama.
  const engine = protectEngine(workspaceId, pickEngine(selection, ['codex-cli']));

  if (!engine) {
    console.error(`[plan-executor] Keine Engine verfügbar. Alle Steps werden auf 'failed' gesetzt.`);
    const failStatuses: Record<string, string> = {};
    for (const step of steps) {
      try { setPlanStepStatus(step.id, 'failed'); } catch { /* ignore */ }
      failStatuses[step.id] = 'failed';
    }
    await updateCard({ workspaceId, workstreamId, planId, coordKey, steps, stepStatuses: failStatuses, originalIntent }).catch(() => undefined);
    return;
  }

  // Real tool spawns run via tmux (claude-CLI). Ollama can't do an
  // --allowedTools spawn → text-only. Bash/writes need claude-cli + repoPath.
  const canRealSpawn = engine.id === 'claude-cli' && repoPath !== null;

  // ── ACCUMULATION (2026-05-29): stable runId + run branch + merge mutex ────
  //
  // ONE runId per PLAN RUN (not per step) — it anchors the accumulating
  // run branch lazing/run/<runId>. Every step branches FROM the run tip (not from
  // live HEAD) and merges its work back serially → step N sees step <N
  // (the composed website). SAFE_ID_RE-conformant (planId/workstreamId are
  // already ULID-like; defensively sanitized).
  // 2026-05-29 (Opus 4.8) — workstreamId FIRST: the run branch is looked up by
  // workstreamId (findRunBranchForWorkstream / merge-run API).
  // With {planId}-{workstreamId}, the 56-char slice cut the workstreamId off
  // the end → lookup failed. workstreamId in front ⇒ intact; the planId tail may be
  // truncated (not a lookup key).
  const runId = `prun-${`${workstreamId}-${planId}`
    .replace(/[^A-Za-z0-9_:.\-]/g, '-')
    .slice(0, 56)}`;

  // Create the run branch ONCE per run — BEFORE the scheduler, ONLY when real
  // spawns are possible (the text-only path stays DB-/git-free). Idempotent
  // (createOrReuseRunWorktree): on a retry of the same run, the branch is reused with
  // its accumulated work, NO reset to HEAD.
  let runBranch: string | null = null;
  if (canRealSpawn && repoPath) {
    try {
      const wsIdForBranch =
        workspaceId.replace(/[^A-Za-z0-9_:.\-]/g, '-').slice(0, 50) || 'ws';
      const r = await createOrReuseRunWorktree({
        repoPath,
        workspaceId: wsIdForBranch,
        runId,
      });
      runBranch = r.runBranch;
      console.info(
        `[plan-executor][accumulate] run-branch=${runBranch} runId=${runId} ` +
          `(Steps branchen vom Run-Tip, mergen seriell zurück; Live-Checkout unberührt)`,
      );
    } catch (e) {
      // Run-branch setup failed → NO accumulation possible. We do
      // NOT degrade to the old per-step-from-HEAD path (that would silently
      // be a composition loss). Instead the run continues text-only
      // (safe, no data loss) — the spawns fall back to engine.chat,
      // because runBranch stays null (see the considerRealSpawn guard below).
      console.error(
        `[plan-executor][accumulate] Run-Branch-Setup fehlgeschlagen — ` +
          `Spawns fallen auf text-only zurück (keine Akkumulation): ` +
          (e instanceof Error ? e.message : String(e)),
      );
      runBranch = null;
    }
  }

  // Per-runId merge mutex: serializes mergeStepIntoRun (Git allows no
  // parallel merge into the same branch; serial merges = deterministic
  // composition). A promise chain — each merge waits on the previous.
  let mergeChain: Promise<void> = Promise.resolve();
  const runSerializedMerge = <T>(fn: () => Promise<T>): Promise<T> => {
    const result = mergeChain.then(fn, fn);
    // Continue the chain, swallow errors (the caller handles them via result).
    mergeChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  // SLOT DECOUPLING: ONLY real heavy-Ollama use draws the N11 heavy slot
  // (ollama-heavy, cap 2). claude-cli steps (text-only --print OR
  // worktree-isolated spawn) no longer draw a heavy slot — their
  // parallelism is bound by the scheduler width (text/spawnConcurrency) or
  // the worktree cap (5), NOT by the artificial cap of 2.
  const usesHeavyOllama = engine.id === 'ollama';

  // M2 fix: total-deadline controller.
  const execCtl = new AbortController();
  const execDeadline = setTimeout(() => execCtl.abort(), EXEC_TOTAL_DEADLINE_MS);

  // Status map: all pending.
  const stepStatuses: Record<string, StepStatus> = {};
  for (const step of steps) {
    stepStatuses[step.id] = (step.status as StepStatus) ?? 'pending';
  }

  // W2.2 (2026-05-30): steps waiting on a blocking gate. The step
  // stays 'active' in the DB (it has done its work and is waiting for
  // human approval) — but in the flow graph it becomes `needs-input` and thus
  // actionable. gateKindByStep remembers which gate card the node tap
  // targets → the SAME executeGateAction path as the ActionDeck pin.
  const gateWaitingStepIds = new Set<string>();
  const gateKindByStep = new Map<string, string>();

  // Collects the outputs per step for the completion card (group-sorted).
  const stepOutputs: Array<{ step: WorkstreamPlanStepRow; text: string }> = [];

  // ── Build the dependency graph (task B) ────────────────────────────────────
  const depsById = new Map<string, string[]>();
  for (const s of steps) depsById.set(s.id, parseDependsOn(s));

  const cycle = hasCycleOrDanglingDep(steps, depsById);
  if (cycle) {
    console.warn(
      `[plan-executor] depends_on-Graph hat Zyklus/dangling-dep in ws=${workstreamId} — ` +
        `Fallback auf sequenzielle Ausführung (alle Deps ignoriert).`,
    );
  }
  // In the cycle fallback we ignore all deps (sequentially in stepIndex order).
  const effectiveDeps = (stepId: string): string[] =>
    cycle ? [] : (depsById.get(stepId) ?? []);

  // ── Determine the step class PER STEP (SLOT DECOUPLING) ─────────────────────
  //
  // A step is 'spawn' (claude-cli write/bash → worktree-isolated) when the
  // mode grants tools AND a real spawn path exists AND the
  // (deterministic, N6) tool resolution for the step role is non-empty.
  // Otherwise 'text' (text-only engine.chat — no worktree, no heavy-Ollama).
  // This mirrors EXACTLY the `considerRealSpawn` logic in runStep (single source:
  // resolveAllowedToolsForMode) — we just compute it ahead of time to pick the
  // right parallelism class per step.
  // ACCUMULATION: a real spawn is only possible when the run branch stands
  // (otherwise the step can't branch from the run tip) — otherwise text-only.
  const canAccumulate = canRealSpawn && runBranch !== null;

  // ── W2.1: website run? → chain the mandatory design system forward ──────────
  // Only on website-like intent. The accent chosen by the design step is
  // parsed on the first detected design output + then forwarded to all following
  // steps. State per run (no module state).
  const websiteRun = isWebsiteIntent(originalIntent);
  let chosenAccent = 'own'; // laz.ing default accent until the design step chooses.

  type StepClass = 'text' | 'spawn';
  const classOf = (step: WorkstreamPlanStepRow): StepClass => {
    if (!modeGrantsTools || !canAccumulate) return 'text';
    const stepRole = step.subagentRole ?? 'reviewer';
    const res = resolveAllowedToolsForMode(workspaceMode, stepRole);
    return res.allowedTools.length > 0 ? 'spawn' : 'text';
  };
  const stepClassById = new Map<string, StepClass>();
  for (const s of steps) stepClassById.set(s.id, classOf(s));

  // Read separate budget classes — no longer heavyTotal as a universal brake.
  //   - text steps  → textConcurrency (core-derived, ~6)
  //   - spawn steps → spawnConcurrency (== worktree cap 5)
  // The cycle fallback forces width 1 (sequential, all deps ignored).
  const cb = resourcePool.getConcurrencyBudget();
  const textConcurrency = cycle ? 1 : Math.max(1, cb.textConcurrency);
  const spawnConcurrency = cycle ? 1 : Math.max(1, cb.spawnConcurrency);

  // ── Per-step runner (R2 gate → spawn-or-chat) ──────────────────────────────
  const runStep = async (step: WorkstreamPlanStepRow): Promise<void> => {
    const stepLabel = `plan-step:${step.id}`;
    let slot: Awaited<ReturnType<typeof resourcePool.acquireSlot>> | null = null;

    try {
      // SLOT DECOUPLING: the heavy engine slot (ollama-heavy, N11 cap 2) is
      // acquired ONLY for real heavy-Ollama use. claude-cli steps (text
      // or worktree spawn) acquire NO slot here — their parallelism is
      // already bound by the scheduler width (text/spawnConcurrency) + the
      // worktree cap. That was the bug: a text-only step should never
      // consume one of the 2 heavy-Ollama slots.
      if (usesHeavyOllama) {
        slot = await resourcePool.acquireSlot({
          kind: 'ollama-heavy',
          subagentId: stepLabel,
          priority: 'normal',
          timeoutMs: 20_000,
          signal: execCtl.signal,
        });
      }
      await waitForBudget(`plan-exec:${workspaceId}`);

      setPlanStepStatus(step.id, 'active');
      stepStatuses[step.id] = 'active';
      await updateCard({ workspaceId, workstreamId, planId, coordKey, steps, stepStatuses, originalIntent, gateWaitingStepIds, gateKindByStep });

      // ── TRACK 2: DETERMINISTIC PV-STRINGING STEP (BEFORE any spawn) ─────────
      //
      // A pv-stringing step does NOT run as a claude-cli worktree spawn. It calls
      // the deterministic producer (N6) and stores its PvArtifact as the step
      // output — from there from-artifact.ts → evaluate.ts (G5) consumes the
      // electrical model. Because this path NEVER reaches the spawn branch,
      // the step also can't wrongly fail at the W1.1 non-empty-diff gate as
      // no_artifact (that gate only applies in the spawn path).
      if (isPvStringingStep(step)) {
        const pvOutput = runPvStringingStep(step);
        stepOutputs.push({ step, text: pvOutput });

        // N8: audit the deterministic producer run (searchable, hash-
        // chained). actor='policy' (no user, no LLM). Best-effort.
        try {
          writeDecision({
            workspaceId,
            workstreamId,
            coordKey,
            decisionKind: 'route',
            actor: 'policy',
            rationale:
              `pv_stringing_producer=true step=${step.id} role=${step.subagentRole ?? '(none)'} ` +
              `deterministic=true no_spawn=true no_worktree=true — Producer-Output ` +
              `(verbatim, N1):\n${pvOutput}`,
          });
        } catch { /* writeDecision best-effort */ }

        // ── W3.2: EXPERT GATE for install-grade without expertReviewed ───────
        //
        // buildExpertReviewGate returns a HumanDecisionGatePayload WHEN an
        // install-grade approval is requested without review (otherwise null). We
        // read the requested grade + review status from the configJson
        // annotation; if it's missing, no install-grade is requested → no gate.
        try {
          const cfgRaw = parseFlowAnnotation(step.rationale ?? '').annotation?.configJson ?? null;
          if (cfgRaw) {
            const cfg = JSON.parse(cfgRaw) as Record<string, unknown>;
            const requestedGrade = cfg.requestedGrade;
            if (requestedGrade === 'sales' || requestedGrade === 'proposal' || requestedGrade === 'install') {
              const gate = buildExpertReviewGate({
                requestedGrade,
                expertReviewed: cfg.expertReviewed === true,
                ...(typeof cfg.quoteId === 'string' ? { quoteId: cfg.quoteId } : {}),
                ...(typeof cfg.approvalId === 'string' ? { approvalId: cfg.approvalId } : {}),
                ...(Array.isArray(cfg.reviewItems)
                  ? { reviewItems: (cfg.reviewItems as unknown[]).filter((x): x is string => typeof x === 'string') }
                  : {}),
              });
              if (gate) {
                // W2.2: the step now waits for human approval →
                // in the flow graph `needs-input` (actionable node) instead of
                // running on invisibly. The node tap targets the SAME
                // <surface:human-decision> card → one executeGateAction path.
                gateWaitingStepIds.add(step.id);
                gateKindByStep.set(step.id, 'human-decision');
                await updateCard({
                  workspaceId,
                  workstreamId,
                  planId,
                  coordKey,
                  steps,
                  stepStatuses,
                  originalIntent,
                  gateWaitingStepIds,
                  gateKindByStep,
                }).catch(() => undefined);

                // Emit the gate payload via the existing surface-emit
                // path as <surface:human-decision>. The ActionDeck/executeGate-
                // Action path (track 1) renders + processes approve: it applies
                // setsFieldOnApprove (approval.expertReviewed=true) and
                // harvests grantsDecisionsOnApprove into workstream_decisions —
                // exactly these decisions lift expert-review-optional in the eval.
                // N8: the gate rationale is verbatim owner-readable.
                await emitChatMessageCompleted({
                  workspaceId,
                  entityId: ulid(),
                  content: `<surface:human-decision>${JSON.stringify(gate)}</surface:human-decision>`,
                  actor: 'system',
                  outcome: 'ok',
                  metadata: {
                    surfaceKind: 'human-decision',
                    workstreamId,
                    planId,
                    gateId: gate.gateId,
                  },
                }).catch(() => undefined);
                console.info(
                  `[plan-executor][pv-stringing] step=${step.id} EXPERT-GATE emittiert ` +
                    `(install-grade ohne expertReviewed) gateId=${gate.gateId}`,
                );
              }
            }
          }
        } catch { /* gate emit best-effort — no step fail */ }

        // W2.2: the step is complete → clear the gate-waiting marker, so the
        // final flow-graph emit shows the node as `done` (not `needs-input`).
        // Idempotent: a delete without a prior add is a no-op.
        gateWaitingStepIds.delete(step.id);
        gateKindByStep.delete(step.id);
        setPlanStepStatus(step.id, 'done');
        stepStatuses[step.id] = 'done';
        return;
      }

      // LOW #5: the default role for tool resolution is 'reviewer' (read-only).
      const stepRole = step.subagentRole ?? 'reviewer';
      const modeResolution = resolveAllowedToolsForMode(workspaceMode, stepRole);
      const resolvedExecutionMode = modeResolution.executionMode;

      // Should this step run real tools AT ALL? ONLY when:
      //   - the mode grants tools (FreeRein/Lane, NOT unset/ask),
      //   - the tool resolution is non-empty, AND
      //   - a real spawn is possible (claude-cli + repoPath resolved).
      // Otherwise → DEFAULT-SAFE: text-only engine.chat (today's behavior,
      // bit-equal). NO R2 gate as a step blocker in the default — text-only is
      // tool-less (no write, no shell) and therefore inherently uncritical.
      const considerRealSpawn =
        modeGrantsTools &&
        modeResolution.allowedTools.length > 0 &&
        canAccumulate;

      let wantsRealSpawn = false;
      let gateReason = '(text-only — Modus gewährt keine Tools / kein Spawn-Pfad)';

      if (considerRealSpawn) {
        // The R2 gate is the AUTHORIZATION for the real tool spawn (N6).
        // R2 decides on fs read/fs write; Bash is passed through separately as
        // permissionMode (not in requestedTools).
        const stepAllowedToolsNoShell = modeResolution.allowedTools.filter(
          (t) => t !== 'Bash' && t !== 'Shell' && t !== 'Exec',
        );
        const gateMode: PermissionModeForGate | undefined =
          workspaceMode === 'freerein' ||
          workspaceMode === 'freerein-with-audit' ||
          workspaceMode === 'lane'
            ? workspaceMode
            : undefined;

        const policyDecision = enforceExecutionStep({
          role: stepRole,
          executionMode: resolvedExecutionMode,
          requestedTools:
            stepAllowedToolsNoShell.length > 0 ? stepAllowedToolsNoShell : ['Read', 'Grep'],
          workspaceId,
          ...(gateMode ? { permissionMode: gateMode } : {}),
        });
        // On R2 deny → DEFENSE-IN-DEPTH: NO crash, NO tool spawn,
        // but a fallback to the safe text-only path.
        wantsRealSpawn = policyDecision.allow;
        gateReason = policyDecision.reason;
      }

      // N8: audit the decision (stdout audit; DB audit = R3 task).
      const auditLine = `[plan-executor][security-gate] step=${step.id} ` +
        `role=${stepRole} ` +
        `workspace_mode=${modeResolution.resolvedMode} ` +
        `executionMode=${resolvedExecutionMode} ` +
        `consider_spawn=${considerRealSpawn} ` +
        `real_spawn=${wantsRealSpawn} ` +
        `mode_tools=${JSON.stringify(modeResolution.allowedTools)} ` +
        `reason="${gateReason}"`;
      if (wantsRealSpawn) console.info(auditLine);
      else console.warn(auditLine);

      let outputText: string;

      if (wantsRealSpawn && repoPath && runBranch) {
        // ── N8/N10: TAMPER-EVIDENT DB DECISION BEFORE THE REAL TOOL RUN ──────
        //
        // Every real tool run (incl. Bash) MUST leave a searchable, hash-
        // chained decision in `workstream_decisions` — not
        // just ephemeral stdout. writeDecision writes content_hash =
        // sha256(canonicalJson({workstream_id, decision_kind, rationale,
        // evidence_refs})) + a sentinel evidence row (N10 chaining).
        // decision_kind='route' (gate routing/spawn authorization, as in
        // plan-dispatch). actor='policy' (deterministic R2 gate, no user).
        // N1: rationale VERBATIM, NO .slice — the granted tools (incl. Bash)
        // are fully in it. Best-effort: writeDecision never throws.
        const decisionRationale =
          `real_spawn=true mode=${modeResolution.resolvedMode} step=${step.id} ` +
          `role=${stepRole} coordKey=${coordKey} ` +
          `granted_tools=${JSON.stringify(modeResolution.allowedTools)} ` +
          `executionMode=${resolvedExecutionMode} ` +
          `worktree_isolated=true merge_gated=true ` +
          `reason=${gateReason}`;
        const decisionId = writeDecision({
          workspaceId,
          workstreamId,
          coordKey,
          decisionKind: 'route',
          actor: 'policy',
          rationale: decisionRationale,
        });
        console.info(
          `[plan-executor][decision] step=${step.id} workstream_decisions.id=${decisionId ?? '(write-failed)'} content_hash-chained=true`,
        );

        // ── REAL TOOL SPAWN — MANDATORILY R1-WORKTREE-ISOLATED ───────────────
        //
        // Bash/writes happen in the isolated worktree (createRunWorktree),
        // NEVER on the live checkout. Merge stays gated (mergeRunWorktree throws in R1).
        // ENV `env -i`-scrubbed + K1 `--disallowedTools` (hard) are in
        // tmux-spawn. Error-isolated: a spawn error kills only this step.
        // W2.1: on website runs, forward the mandatory design system + the
        // artifacts produced so far. Otherwise undefined → bit-
        // identical prompt (backwards-compatible).
        const sharedDesignContext = websiteRun
          ? renderDesignSystemPrompt(chosenAccent)
          : undefined;
        const priorArtifacts = websiteRun
          ? summarizePriorArtifacts(stepOutputs)
          : undefined;

        outputText = await runRealSpawnIsolated({
          step,
          stepRole,
          repoPath,
          workspaceId,
          workstreamId,
          coordKey,
          runBranch, // ACCUMULATION: step branches from the run tip, merges back
          serializeMerge: runSerializedMerge,
          allowedTools: modeResolution.allowedTools, // incl. Bash under FreeRein
          originalIntent,
          stepNumber: steps.indexOf(step) + 1,
          totalSteps: steps.length,
          signal: execCtl.signal,
          ...(sharedDesignContext ? { sharedDesignContext } : {}),
          ...(priorArtifacts ? { priorArtifacts } : {}),
        });
      } else {
        // ── TEXT-ONLY (default safe / ollama / lane-without-spawn) ───────────
        // Pure chat completion, NO tool calls, NO file writes.
        const stepPrompt = buildStepPrompt({
          role: step.subagentRole ?? 'coder',
          originalIntent,
          stepIndex: steps.indexOf(step) + 1,
          totalSteps: steps.length,
          title: step.title,
          rationale: step.rationale,
        });
        const response = await engine.chat({
          messages: [{ role: 'user', content: stepPrompt }],
          timeoutMs: 60_000,
          signal: execCtl.signal,
        });
        outputText = response.text;
      }

      stepOutputs.push({ step, text: outputText });
      // W2.1: extract the accent chosen by the design step → forward it.
      if (websiteRun) {
        const role = (step.subagentRole ?? '').toLowerCase();
        const isDesignStep =
          role === 'design' ||
          /\b(design|style|styling|visual|theme|farb|gestalt|branding)\b/i.test(step.title);
        if (isDesignStep) chosenAccent = parseChosenAccent(outputText);
      }
      setPlanStepStatus(step.id, 'done');
      stepStatuses[step.id] = 'done';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[plan-executor] Step ${step.id} (${step.title}) failed: ${msg}`);
      try { setPlanStepStatus(step.id, 'failed'); } catch { /* ignore */ }
      stepStatuses[step.id] = 'failed';
      stepOutputs.push({ step, text: `[Fehler: ${msg}]` });
    } finally {
      if (slot) {
        try { resourcePool.releaseSlot(slot.slotId); } catch { /* ignore */ }
      }
      await updateCard({ workspaceId, workstreamId, planId, coordKey, steps, stepStatuses, originalIntent, gateWaitingStepIds, gateKindByStep }).catch(() => undefined);
    }
  };

  // ── Parallel scheduler: ready queue, separate class budgets ────────────────
  //
  // A step is READY when all of its effective deps are 'done'. Steps
  // whose dep is 'failed' are NOT started (error-isolated): they
  // stay 'pending' and are set to 'failed' at the end as blocked.
  //
  // The width is plan-derived: up to `textConcurrency` text steps AND
  // up to `spawnConcurrency` spawn steps run concurrently (orthogonal).
  await runReadyQueue({
    steps,
    effectiveDeps,
    stepStatuses,
    classOf: (id: string): 'text' | 'spawn' => stepClassById.get(id) ?? 'text',
    limits: { text: textConcurrency, spawn: spawnConcurrency },
    runStep,
  });

  // Steps that never became ready (dep failed) → blocked → mark failed.
  for (const step of steps) {
    if (stepStatuses[step.id] === 'pending') {
      const reason = '[übersprungen — eine Voraussetzung (depends_on) ist fehlgeschlagen]';
      try { setPlanStepStatus(step.id, 'failed'); } catch { /* ignore */ }
      stepStatuses[step.id] = 'failed';
      stepOutputs.push({ step, text: reason });
    }
  }
  await updateCard({ workspaceId, workstreamId, planId, coordKey, steps, stepStatuses, originalIntent, gateWaitingStepIds, gateKindByStep }).catch(() => undefined);

  clearTimeout(execDeadline);

  // ── A5 + A4: post-process IS/OUGHT reconciliation (additive, fail-soft) ────
  //
  // AFTER run completion (step status final): determine the overall outcome +
  // recordOutcome, drift decision↔active belief → justified belief update
  // (supersede, history kept), and — on an unjustified/diverging
  // decision — produce an OPTIONAL WHY question. Exactly this was missing in
  // the PA chat: the heygen dead end was only cleaned up as an orphan, no learning
  // entry. The WHY question is appended below to the completion content so
  // the existing open-questions pill shows it (extractOpenQuestionsFromContent).
  //
  // NON-BLOCKING: an error in the reconcile must NEVER topple run completion
  // (try/catch + log). The flow-graph/parallel logic stays untouched.
  let reconcileWhyQuestion: string | null = null;
  try {
    const { getDb } = await import('@/db/client');
    const { reconcileWorkstream } = await import('@/lib/reasoning/reconcile');
    const reconcileResult = reconcileWorkstream(getDb().$raw, {
      workspaceId,
      workstreamId,
      coordKey,
      stepStatuses,
    });
    reconcileWhyQuestion = reconcileResult.whyQuestion;
    console.info(
      `[plan-executor][reconcile] ws=${workstreamId} outcome=${reconcileResult.outcome} ` +
        `already=${reconcileResult.alreadyReconciled} ` +
        `beliefUpdates=${reconcileResult.beliefUpdates} ` +
        `drifts=${reconcileResult.drifts.length} ` +
        `unjustified=${reconcileResult.unjustified.length} ` +
        `whyQuestion=${reconcileWhyQuestion ? 'yes' : 'no'}`,
    );
  } catch (err) {
    console.warn('[plan-executor] Reconcile fehlgeschlagen (non-fatal):', err);
  }

  // ── E5.1: persist the auto workspace handoff (additive, fail-soft) ─────────
  //
  // DIRECTLY after the A5 reconcile: write the UI-visible workspace handoff into
  // `workspaces.notes`. buildWorkspaceHandoff aggregates the read-back
  // trail (recentRationales + active beliefs + open decisions) scope-isolated
  // over workspaceId; persistWorkspaceHandoff writes it as notes_source=
  // 'ai-summary'. So far persistWorkspaceHandoff had NO caller → the
  // notes column was never auto-filled (the start feed in workspace-
  // session runs independently, live-aggregated, and is NOT affected).
  //
  // REPLACE protection (rely on it, documented): persistWorkspaceHandoff
  //   - writes ONLY when notes_source ∈ {NULL, 'ai-summary'} — a user-maintained
  //     'manual' note ALWAYS stays untouched (foreign notes source);
  //   - REPLACEs the ai-summary entirely (no append growth, idempotent);
  //   - on an empty handoff (isEmpty) writes NOTHING (no clobbering of an
  //     earlier summary with an empty string).
  //
  // NON-BLOCKING: an error here must NEVER topple run completion (its own
  // try/catch + log). Idempotent / last-write-wins is fine (it's a REPLACE of the
  // ai-summary). Its own block (not in the reconcile catch), so a reconcile
  // error doesn't swallow the handoff and vice versa.
  try {
    const { getDb } = await import('@/db/client');
    const { buildWorkspaceHandoff, persistWorkspaceHandoff } = await import(
      '@/lib/reasoning/auto-handoff'
    );
    const raw = getDb().$raw;
    const handoff = buildWorkspaceHandoff(raw, workspaceId);
    const handoffResult = persistWorkspaceHandoff(raw, workspaceId, handoff);
    console.info(
      `[plan-executor][handoff] ws=${workspaceId} ` +
        `written=${handoffResult.written} ` +
        `skipped=${handoffResult.skippedReason ?? 'none'}`,
    );
  } catch (err) {
    console.warn('[plan-executor] Handoff-Persist fehlgeschlagen (non-fatal):', err);
  }

  // ── Self-learning: workflow-repetition detector (slice 1, additive, fail-soft) ─
  //
  // Owner vision (2026-06-03): „Dieses Self Learning und Repetitors zu erkennen
  // ist absolut wichtig." AFTER run completion, detectWorkflowRepetition computes
  // a canonical structure signature of the run that happened, counts earlier
  // identical runs (append-only `workflow.structure_seen` events, N8/N9) and
  // decides deterministically (score ≥ 3, at the earliest the 3rd identical run + complex
  // multi-stage) whether the AI should suggest „Als wiederverwendbaren Workflow speichern?".
  // NEVER auto-save: on `suggest`, exactly ONE clickable
  // <surface:flow-recurrence> card is emitted; saving runs through the
  // existing /api/flow/from-workstream path (C3), owner-gated.
  //
  // NON-BLOCKING: its own try/catch — a detector error must NEVER topple
  // run completion (same pattern as the reconcile/handoff block).
  try {
    const { getDb } = await import('@/db/client');
    const { detectWorkflowRepetition } = await import('@/lib/flow/repetition-detect');
    const rep = detectWorkflowRepetition(getDb().$raw, { workspaceId, workstreamId });
    if (rep) {
      console.info(
        `[plan-executor][repetition] ws=${workspaceId} ws_id=${workstreamId} ` +
          `seen=${rep.seenCount} score=${rep.score} suggest=${rep.suggest}`,
      );
      if (rep.suggest) {
        await emitChatMessageCompleted({
          workspaceId,
          entityId: ulid(),
          actor: 'system',
          outcome: 'ok',
          content:
            '<surface:flow-recurrence>' +
            JSON.stringify({
              workstreamId,
              workspaceId,
              title: originalIntent,
              seenCount: rep.seenCount,
              stepCount: rep.stepCount,
              summary: rep.stepSummary,
            }) +
            '</surface:flow-recurrence>',
        }).catch(() => undefined);
      }
    }
  } catch (err) {
    console.warn('[plan-executor] Repetition-Detektor fehlgeschlagen (non-fatal):', err);
  }

  // 4. Completion card — grouped by group_id (membership).
  // 2026-05-29 (Opus 4.8) — owner finding (2×): the WHY/drift reflections of the
  // self-learning loop do NOT belong in the chat UI (neither as an open question nor
  // as a counter-evidence card) — they are system-internal self-reflection about
  // routing decisions, not user input. The LEARNING happens in the trace anyway
  // (reconcileWorkstream writes the drift beliefs); we simply do NOT
  // surface it. reconcileWhyQuestion is therefore deliberately NO LONGER appended
  // to the summary (it was the source of the „Warum diesmal anders?" pollution). `void` marks
  // the deliberate non-use (the loop effect stays, the surface disappears).
  void reconcileWhyQuestion;
  const summaryContent = buildSummaryContent(originalIntent, stepOutputs);
  try {
    await emitChatMessageCompleted({
      workspaceId,
      entityId: ulid(),
      content: summaryContent,
      actor: 'system',
      outcome: 'ok',
      metadata: {
        surfaceKind: 'plan-exec-summary',
        workstreamId,
        planId,
      },
    });
  } catch (err) {
    console.warn('[plan-executor] Abschluss-Emit fehlgeschlagen (non-fatal):', err);
  }

  // ── W1.3 (2026-05-30) — AUTO-MERGE (owner decision, flag-gated) ────────────
  //
  // With `LAZYOS_AUTO_MERGE_RUN='on'` AND "all steps done" AND a non-empty
  // run diff, the composed run is AUTOMATICALLY merged into the live checkout
  // (commitGatedMerge) — no owner tap. The W1.1 diff gate has already
  // eliminated all empty no-op steps, so only real work arrives. The
  // <surface:merge-offer> card (below) is kept as a fallback/audit; on
  // auto-merge success it is skipped (autoMerged=true). Default
  // (flag off) = the previous member-gated behavior (card only). An N8 decision per
  // auto-merge. R1 discipline deliberately softened in favor of autonomy (owner-mandated).
  let autoMerged = false;
  if (
    process.env.LAZYOS_AUTO_MERGE_RUN === 'on' &&
    canAccumulate &&
    runBranch &&
    repoPath
  ) {
    const allDone = steps.every((s) => stepStatuses[s.id] === 'done');
    if (allDone) {
      try {
        const { getRunBranchDiffStat, commitGatedMerge } = await import(
          '@/lib/agents/worktree-manager'
        );
        const diff = await getRunBranchDiffStat(repoPath, runBranch);
        if (diff.aheadBy > 0 && diff.files.length > 0) {
          const merge = await commitGatedMerge({ repoPath, runBranch });
          // N8: Auto-Merge auditieren (tamper-evidente Decision, verbatim).
          try {
            writeDecision({
              workspaceId,
              workstreamId,
              coordKey,
              decisionKind: 'route',
              actor: 'policy',
              rationale: merge.merged
                ? `auto_merge=true (LAZYOS_AUTO_MERGE_RUN=on) run_branch=${runBranch} ` +
                  `files=${diff.files.length} aheadBy=${diff.aheadBy} → in Live gemergt ` +
                  `(${merge.sha ?? 'sha?'}). Owner-mandatierte Voll-Autonomie; ` +
                  `W1.1-Diff-Gate garantiert nicht-leere Steps.`
                : `auto_merge ABGEBROCHEN: run_branch=${runBranch} → Konflikt, Live ` +
                  `unverändert. ${merge.conflict ?? ''}`,
            });
          } catch { /* writeDecision best-effort */ }
          if (merge.merged) {
            autoMerged = true;
            console.info(
              `[plan-executor][auto-merge] ws=${workstreamId} runBranch=${runBranch} ` +
                `files=${diff.files.length} sha=${merge.sha ?? '?'} — automatisch in Live gemergt`,
            );
            // W1.4: after a successful auto-merge, serve + emit a preview.
            await emitPreviewAfterMerge({
              workspaceId,
              workstreamId,
              planId,
              repoPath,
              title: originalIntent,
            });
          } else {
            console.warn(
              `[plan-executor][auto-merge] ws=${workstreamId} KONFLIKT — fällt auf ` +
                `Merge-Offer-Karte zurück. ${merge.conflict ?? ''}`,
            );
          }
        }
      } catch (err) {
        console.warn('[plan-executor] Auto-Merge fehlgeschlagen (non-fatal):', err);
      }
    }
  }

  // A4 (2026-05-29) — merge offer: when accumulation has left real work on the
  // run branch (≥1 commit ahead), make it visible to the owner that
  // the composed work is ready for a gated merge into the live checkout.
  // The merge itself happens ONLY on an owner click (POST .../merge-run, R1).
  // Best-effort, never throws. Emits the clickable <surface:merge-offer> card
  // (surface wave 2026-05-29): [In Live mergen] POSTs /api/workstreams/[id]/
  // merge-run — the ONLY gated write path into the live checkout (R1/R3).
  // W1.3: on a successful auto-merge the card is skipped.
  if (!autoMerged && canAccumulate && runBranch && repoPath) {
    try {
      const { getRunBranchDiffStat } = await import('@/lib/agents/worktree-manager');
      const diff = await getRunBranchDiffStat(repoPath, runBranch);
      if (diff.aheadBy > 0 && diff.files.length > 0) {
        const mergeOfferPayload = {
          runBranch,
          fileCount: diff.files.length,
          files: diff.files,
          workstreamId,
          workspaceId,
        };
        await emitChatMessageCompleted({
          workspaceId,
          entityId: ulid(),
          content: `<surface:merge-offer>${JSON.stringify(mergeOfferPayload)}</surface:merge-offer>`,
          actor: 'system',
          outcome: 'ok',
          metadata: {
            surfaceKind: 'merge-offer',
            workstreamId,
            planId,
          },
        });
        console.info(
          `[plan-executor][merge-offer] ws=${workstreamId} runBranch=${runBranch} ` +
            `files=${diff.files.length} aheadBy=${diff.aheadBy} — bereit für gated Merge`,
        );
      }
    } catch (err) {
      console.warn('[plan-executor] Merge-Offer-Emit fehlgeschlagen (non-fatal):', err);
    }
  }

  // ── RUN COMPLETION STATUS (2026-05-30) ─────────────────────────────────────
  // executePlan NEVER set the workstream/flow_run to a terminal status →
  // a successful run (all steps done, auto-merge to main, website live)
  // stayed 'active' and was wrongly marked 'stuck' by the recovery sweep
  // (a misleading "interrupted" card despite a delivered result). Now: all
  // steps terminal → workstream 'done' (at least 1 done) or 'failed' (all failed),
  // + flow_runs analogously. Fail-soft, idempotent; cancelled/archived/already-terminal
  // are NOT overwritten.
  try {
    const { getDb } = await import('@/db/client');
    const raw = getDb().$raw;
    const allTerminal =
      steps.length > 0 &&
      steps.every((s) =>
        ['done', 'failed', 'skipped'].includes(stepStatuses[s.id] ?? ''),
      );
    if (allTerminal) {
      const anyDone = steps.some((s) => stepStatuses[s.id] === 'done');
      const finalStatus = anyDone ? 'done' : 'failed';
      const now = Date.now();
      raw
        .prepare(
          "UPDATE workstreams SET status=?, updated_at=? WHERE id=? AND status NOT IN ('cancelled','archived','done','failed')",
        )
        .run(finalStatus, now, workstreamId);
      raw
        .prepare(
          "UPDATE flow_runs SET status=?, updated_at=? WHERE workstream_id=? AND status IN ('running','pending')",
        )
        .run(finalStatus, now, workstreamId);
      console.info(
        `[plan-executor][complete] ws=${workstreamId} status=${finalStatus} ` +
          `(alle ${steps.length} Steps terminal) — Run abgeschlossen, kein Recovery-Sweep-stuck.`,
      );
    }
  } catch (err) {
    console.warn(
      '[plan-executor] Run-Abschluss-Status-Set fehlgeschlagen (non-fatal):',
      err,
    );
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Parallel scheduler
// ────────────────────────────────────────────────────────────────────────────

/**
 * Ready-queue scheduler with SEPARATE class budgets (SLOT DECOUPLING).
 *
 * Starts ready steps as soon as their deps are 'done' — up to `limits.text`
 * text steps AND up to `limits.spawn` spawn steps CONCURRENTLY (orthogonal:
 * the classes share NO common pool anymore). More ready steps than
 * the class budget → the rest wait in the queue (do NOT drop).
 *
 * Deterministic start order: ready steps are checked in stepIndex order
 * (stable + reproducible). In the cycle fallback both limits are 1 +
 * effectiveDeps=[] → a pure sequential stepIndex loop.
 *
 * NO deadlock/race: a purely synchronous launchReady fastpath; on every
 * step-done (Promise.race) it reschedules.
 */
async function runReadyQueue(opts: {
  steps: readonly WorkstreamPlanStepRow[];
  effectiveDeps: (stepId: string) => string[];
  stepStatuses: Record<string, string>;
  classOf: (stepId: string) => 'text' | 'spawn';
  limits: { text: number; spawn: number };
  runStep: (step: WorkstreamPlanStepRow) => Promise<void>;
}): Promise<void> {
  const { steps, effectiveDeps, stepStatuses, classOf, limits, runStep } = opts;
  const ordered = [...steps].sort((a, b) => a.stepIndex - b.stepIndex);
  const started = new Set<string>();
  const inflight = new Set<Promise<void>>();
  // Per-class counter — the two budgets are orthogonal (no common pool).
  const running: Record<'text' | 'spawn', number> = { text: 0, spawn: 0 };

  const isReady = (step: WorkstreamPlanStepRow): boolean => {
    if (started.has(step.id)) return false;
    if (stepStatuses[step.id] !== 'pending') return false;
    const deps = effectiveDeps(step.id);
    // All deps must be 'done'. A 'failed' dep → never ready
    // (the step stays pending → marked as blocked at the end).
    return deps.every((d) => stepStatuses[d] === 'done');
  };

  const launchReady = (): void => {
    for (const step of ordered) {
      if (!isReady(step)) continue;
      const cls = classOf(step.id);
      // Class budget full → do NOT (yet) start this step; a later
      // step of the other class may still start in the same wave.
      if (running[cls] >= limits[cls]) continue;
      started.add(step.id);
      running[cls] += 1;
      const p = runStep(step).finally(() => {
        running[cls] -= 1;
        inflight.delete(p);
      });
      inflight.add(p);
    }
  };

  launchReady();
  while (inflight.size > 0) {
    // Wait for the next finished step, then start the newly-ready ones.
    await Promise.race(inflight);
    launchReady();
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Real tool spawn (R1-isolated)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Runs a step as a real claude-CLI tool spawn — MANDATORILY in an
 * isolated git step worktree. The live checkout (main) is NEVER touched.
 *
 * ACCUMULATION (2026-05-29 — owner core feature, composed website):
 *   1. createStepWorktree(baseBranch=runBranch) — throwaway step worktree +
 *      lazing/step/<stepId> branch, branched FROM THE RUN TIP (not from live HEAD).
 *      Thereby the worktree contains all steps merged into the run before →
 *      step N sees step <N (composition). The N11 cap (max 5) is checked here.
 *   2. spawnInTmux({ workspacePath: worktreePath, allowedTools }) — the CLI
 *      runs in the isolated worktree with --allowedTools <mode-tools> (incl. Bash
 *      under FreeRein). ENV env -i-scrubbed, K1 --disallowedTools hard.
 *   3. exit=0 → mergeStepIntoRun(runBranch ← stepBranch) UNDER the per-runId
 *      mutex (serialized --no-ff merge). Conflict → step 'failed' +
 *      writeDecision(conflict diff). The run branch thus accumulates step by
 *      step the entire website.
 *   4. finally: captureWorktreeDiff (STAYS, N8 trace) + discardStepWorktree
 *      (only step worktree+step branch). The RUN branch is NEVER discarded.
 *
 * The merge into the live tree (main) is still GATED (mergeRunWorktree throws;
 * operator merge = step 4, not here).
 *
 * Error-isolated: throws on worktree-cap/spawn errors — the caller (runStep)
 * catches it and marks ONLY this step 'failed'.
 */
async function runRealSpawnIsolated(opts: {
  step: WorkstreamPlanStepRow;
  stepRole: string;
  repoPath: string;
  workspaceId: string;
  workstreamId: string;
  coordKey: string;
  /** ACCUMULATION: the accumulating run branch (lazing/run/<runId>). */
  runBranch: string;
  /** Per-runId mutex: serializes mergeStepIntoRun (git index lock). */
  serializeMerge: <T>(fn: () => Promise<T>) => Promise<T>;
  allowedTools: readonly string[];
  originalIntent: string;
  stepNumber: number;
  totalSteps: number;
  signal: AbortSignal;
  /** W2.1: mandatory design system (rendered) — only on website runs. */
  sharedDesignContext?: string;
  /** W2.1: prior artifacts (path hints) — only on website runs. */
  priorArtifacts?: string;
}): Promise<string> {
  const {
    step, stepRole, repoPath, workspaceId, workstreamId, coordKey,
    runBranch, serializeMerge,
    allowedTools, originalIntent, stepNumber, totalSteps,
    sharedDesignContext, priorArtifacts,
  } = opts;

  // stepId: stable + SAFE_ID_RE-conformant (createStepWorktree validates hard).
  // Step IDs have the form 'STEP-<ulid>' → already [A-Za-z0-9-]; defensively sanitized.
  const stepIdSafe = step.id.replace(/[^A-Za-z0-9_:.\-]/g, '-').slice(0, 56) || 'step';
  const wsId = workspaceId.replace(/[^A-Za-z0-9_:.\-]/g, '-').slice(0, 50) || 'ws';

  // 1. Create the step worktree FROM THE RUN TIP (N11 cap here; throws on exhaustion).
  const { worktreePath, stepBranch } = await createStepWorktree({
    repoPath,
    workspaceId: wsId,
    stepId: stepIdSafe,
    baseBranch: runBranch,
  });
  console.info(
    `[plan-executor][accumulate] step=${step.id} worktree=${worktreePath} ` +
      `step-branch=${stepBranch} base=${runBranch} ` +
      `allowedTools=${JSON.stringify(allowedTools)} (vom Run-Tip gebrancht; Live unberührt)`,
  );

  // Base SHA = the current run tip (NOT live HEAD). This way the diff in the
  // lossless persistence captures only the DELTA work of this step against the run.
  let baseSha: string | null = null;
  try {
    const r = await execFileAsync('git', ['-C', repoPath, 'rev-parse', runBranch]);
    baseSha = (r.stdout || '').trim() || null;
  } catch {
    baseSha = null;
  }

  // Set in the try, read in the finally for the merge-before-discard decision.
  let spawnSucceeded = false;

  try {
    const systemPrompt = buildExecSystemPrompt({ role: stepRole });
    const userPrompt = buildStepPrompt({
      role: stepRole,
      originalIntent,
      stepIndex: stepNumber,
      totalSteps,
      title: step.title,
      rationale: step.rationale,
      execute: true,
      ...(sharedDesignContext ? { sharedDesignContext } : {}),
      ...(priorArtifacts ? { priorArtifacts } : {}),
    });

    // FS-2/FS-3 (2026-05-26): FS sandbox spec — DARK-BUT-READY. Fully
    // wired, but active ONLY when LAZYOS_FS_SANDBOX='on' is explicitly set.
    // The target posture is enforce-by-default (a security restriction
    // doesn't belong behind an opt-in); this FIRST executor rollout is deliberately
    // conservatively opt-in until MAX-auth-under-sandbox is empirically
    // verified in the real claude+tmux path — otherwise there's a risk of breaking
    // live spawns while the owner tests. Flip to enforce-default = loosen this one condition.
    let sandboxSpec:
      | import('@/lib/security/fs-sandbox').FsSandboxSpec
      | undefined;
    if (process.env.LAZYOS_FS_SANDBOX === 'on') {
      try {
        const { buildSandboxSpec } = await import('@/lib/security/fs-sandbox');
        const { resolveWorkspaceRoots } = await import('@/lib/workspaces/fs-roots');
        const { getDb } = await import('@/db/client');
        // FS-2: the full path set of the workspace (primary + ro/rw roots).
        const resolved = resolveWorkspaceRoots(getDb().$raw, workspaceId);
        sandboxSpec = buildSandboxSpec({
          worktreePath, // rw, isolated — NEVER the live root
          roRoots: resolved.roRoots.map((r) => r.absPath),
          liveGitDir: `${repoPath}/.git`, // otherwise git ops in the worktree break
          homeDir: process.env.HOME ?? '/root',
        });
      } catch (e) {
        // Fail-open to TODAY's behavior (env -i + K1, without an FS boundary) —
        // NOT fail-closed: a spec-build error must not kill the spawn.
        console.warn('[plan-executor][fs-sandbox] spec build failed — spawning WITHOUT sandbox:', e);
        sandboxSpec = undefined;
      }
    }

    // 2. Tool spawn in the ISOLATED worktree. Bash only when in allowedTools
    //    (FreeRein). tmux-spawn sanitizes via SAFE_TOOLS + env -i + K1.
    const result = await spawnInTmux({
      workspaceId,
      workspacePath: worktreePath, // ← isolation: NEVER the live repoPath
      workstreamId,
      // Owner directive (2026-05-29): exclusively Opus for agentic work
      // (MAX plan, quality over cost). MODEL_NAMES.opus = single source of truth.
      tier: 'opus',
      agentIdx: 0,
      model: MODEL_NAMES.opus,
      systemPrompt,
      userPrompt,
      // 2026-05-29 (empirical): a real coding step (e.g. motion layer) needs
      // ~120s, larger steps (hero section, app scaffold, multi-file components)
      // 5–15 min. With --output-format json there is NO partial log until the end →
      // too short a timeout kills real, running work mid-way (exit=-1,
      // 0 tokens) AND the worktree is discarded → work lost. Owner principle
      // quality>speed (weeks ok) ⇒ a generous 20 min/step.
      timeoutMs: 1_200_000,
      maxTurns: 30,
      allowedTools: [...allowedTools], // incl. Bash under FreeRein
      sandboxSpec, // FS-3: undefined except LAZYOS_FS_SANDBOX='on'
    });

    // N8: real tool run audited.
    console.info(
      `[plan-executor][tool-run] step=${step.id} exit=${result.exitCode} ` +
        `tokensOut=${result.tokens.output} timedOut=${result.timedOut} rateLimited=${result.rateLimited}`,
    );

    // ── ACCUMULATION: on exit=0, merge the step work into the run branch ──────
    //
    // Only a successful spawn (exitCode 0, no timeout) may accumulate.
    // We commit the agent's (possibly uncommitted) changes onto the
    // step branch, then merge SERIALLY (per-runId mutex) --no-ff into the
    // run branch. Conflict → step fails + writeDecision(conflict diff, N8/N1).
    if (result.exitCode === 0 && !result.timedOut) {
      // ── W1.1 NON-EMPTY-DIFF GATE (2026-05-30) ────────────────────────────
      // The weak `exit=0` gate so far waved through empty no-op merges (the
      // coder wrote only a .md note or nothing → the run tip stayed put).
      // Now: after `git add -A`, check whether the worktree diff against the run tip
      // (baseSha) is NON-EMPTY. Empty diff → step `failed` (no_artifact),
      // NO silent merge. Reuse captureWorktreeDiff (fail-soft, never throws).
      await execFileAsync('git', ['-C', worktreePath, 'add', '-A']).catch(() => {});
      const artifactDiff = await captureWorktreeDiff(worktreePath, baseSha);
      // ROLE EXCEPTION (critic 2026-05-30): the gate applies ONLY to roles from
      // which a file artifact is expected (describeArtifactContract != null —
      // coder/architect/copy/design/assembly). reviewer/tester/analyst deliberately
      // write nothing → no no_artifact fail (otherwise they block the chain).
      const expectsArtifact =
        describeArtifactContract(step.subagentRole ?? '', step.title) !== null;
      if (expectsArtifact && !artifactDiff) {
        try {
          writeDecision({
            workspaceId,
            workstreamId,
            coordKey,
            decisionKind: 'route',
            actor: 'policy',
            rationale:
              `no_artifact=true step=${step.id} step_branch=${stepBranch} ` +
              `run_branch=${runBranch} — exit=0 aber LEERER Worktree-Diff gegen den ` +
              `Run-Tip (keine Datei geschrieben). Step gilt als fehlgeschlagen; ` +
              `KEIN No-op-Merge. (W1.1 Artefakt-Vertrag verletzt.)`,
          });
        } catch { /* writeDecision best-effort */ }
        console.warn(
          `[plan-executor][accumulate] step=${step.id} NO_ARTIFACT — exit=0, aber leerer ` +
            `Diff gegen ${runBranch}. Step failt, kein Merge.`,
        );
        throw new Error(
          `NO_ARTIFACT: step ${step.id} (${step.title}) hat exit=0, aber KEINE Datei ` +
            `geschrieben (leerer Worktree-Diff). Artefakt-Vertrag verletzt — ` +
            `kein No-op-Merge.`,
        );
      }

      spawnSucceeded = true;

      // 1. Commit the step work so the merge carries it (the agent does not
      //    necessarily commit itself). add -A already done above. The diff is
      //    guaranteed non-empty (gate above), so a commit can only fail through real
      //    conflicts/lock — then fail-soft (the merge gate catches it).
      try {
        await execFileAsync('git', [
          '-C', worktreePath, '-c', 'user.name=lazing', '-c', 'user.email=lazing@local',
          'commit', '-m', `step ${step.id}: ${step.title}`,
        ]).catch(() => { /* defensive: maybe already committed → the merge carries it */ });
      } catch (e) {
        console.warn(
          `[plan-executor][accumulate] step=${step.id} commit-staging failed (non-fatal): ` +
            (e instanceof Error ? e.message : String(e)),
        );
      }

      // 2. SERIAL merge into the run branch (the mutex keeps the git index lock away).
      const merge = await serializeMerge(() =>
        mergeStepIntoRun({ repoPath, runBranch, stepBranch }),
      );

      if (!merge.merged) {
        // Conflict: NOT accumulated. Tamper-evident decision (N8/N10) with
        // verbatim conflict diff (N1), then signal the step as failed
        // (throw → runStep catch sets 'failed').
        const conflictDetail = merge.conflict ?? '(kein Detail)';
        try {
          writeDecision({
            workspaceId,
            workstreamId,
            coordKey,
            decisionKind: 'route',
            actor: 'policy',
            rationale:
              `merge_conflict=true step=${step.id} step_branch=${stepBranch} ` +
              `run_branch=${runBranch} — Step NICHT in den Run akkumuliert. ` +
              `conflict_detail (verbatim, N1):\n${conflictDetail}`,
          });
        } catch { /* writeDecision best-effort */ }
        console.warn(
          `[plan-executor][accumulate] step=${step.id} MERGE-KONFLIKT gegen ${runBranch} — ` +
            `Step failt, Arbeit bleibt im Trace (captureWorktreeDiff). Detail: ${conflictDetail}`,
        );
        throw new Error(
          `MERGE_CONFLICT: step ${step.id} (${stepBranch}) konnte nicht in ${runBranch} ` +
            `gemergt werden:\n${conflictDetail}`,
        );
      }

      console.info(
        `[plan-executor][accumulate] step=${step.id} in ${runBranch} gemergt (--no-ff) — ` +
          `nachfolgende Steps sehen diese Arbeit.`,
      );
    }

    const head = spawnSucceeded
      ? `[ausgeführt + in Run-Branch ${runBranch} akkumuliert — Merge in Live bleibt gated]\n`
      : `[ausgeführt im Step-Worktree ${stepBranch} (exit=${result.exitCode}) — NICHT akkumuliert]\n`;
    return head + (result.text || '(kein Output)');
  } finally {
    // 2b. LOSSLESS PERSISTENCE before the discard (step 1 of the accumulation plan,
    //     STAYS): save the delta work of the step worktree (against the run tip) as a
    //     patch into the trace (workstream_evidence, N8) BEFORE the
    //     step worktree is discarded. On a successful merge the work is
    //     in the run branch anyway (recoverable); on conflict/error THIS is
    //     the recovery source. Strictly fail-soft (captureWorktreeDiff never throws).
    try {
      const captured = await captureWorktreeDiff(worktreePath, baseSha);
      if (captured) {
        const snippet =
          `[step-worktree-diff] step=${step.id} branch=${stepBranch} merged=${spawnSucceeded}\n` +
          `--- stat ---\n${captured.stat}\n--- diff (verbatim, N1) ---\n${captured.diff}`;
        writeEvidence({
          workspaceId,
          workstreamId,
          coordKey: `${workspaceId}/${workstreamId}`,
          sourceKind: 'spawn',
          sourceId: step.id,
          snippet, // N1: verbatim, no slice
          actor: 'agent',
        });
        console.info(
          `[plan-executor][persist] step=${step.id} Step-Diff im Trace gesichert ` +
            `(${captured.diff.length} bytes; recoverbar trotz discard)`,
        );
      }
    } catch (capErr) {
      console.warn(
        `[plan-executor][persist] Diff-Capture best-effort failed for step=${step.id}: ` +
          `${capErr instanceof Error ? capErr.message : String(capErr)}`,
      );
    }

    // 3. Discard ONLY the step worktree + step branch. The RUN branch (with the
    //    accumulated work) STAYS — it is the composition target. Best-effort.
    await discardStepWorktree({ repoPath, stepBranch, deleteBranch: true }).catch(
      (err: unknown) => {
        console.warn(
          `[plan-executor][accumulate] discardStepWorktree best-effort failed for ` +
            `step=${step.id} stepBranch=${stepBranch}: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      },
    );
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Prompt-Builder
// ────────────────────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────────────────────
// W1.4 — serve + preview emit after (auto-)merge (2026-05-30)
// ────────────────────────────────────────────────────────────────────────────
//
// AFTER a successful merge, statically serve the composed website (locally +
// optionally Tailscale via LAZYOS_SERVE_LOCAL) and emit a tappable <surface:preview>
// card (reuse renderPreview, SurfaceRenderer NOT edited). Strictly
// best-effort/fail-soft: a serve/emit error must never topple the merge path.
// A shared hook point for the auto-merge path (W1.3) AND the merge-run API.
export async function emitPreviewAfterMerge(opts: {
  workspaceId: string;
  workstreamId: string;
  planId?: string;
  repoPath: string;
  title: string;
}): Promise<void> {
  const { workspaceId, workstreamId, planId, repoPath, title } = opts;
  try {
    const { serveWorkspaceStatic } = await import('@/lib/deploy/serve-local');
    const serve = await serveWorkspaceStatic({ repoPath, workspaceId });
    // Preview-URL priority:
    //  1. LAZYOS_PREVIEW_BASE_URL (an explicit reverse-proxy/tunnel base, e.g. a
    //     Cloudflare/ngrok URL that makes the workspace serve reachable on mobile —
    //     bypasses CGNAT/IPv6 where tailnet/funnel fail). Maps the whole serve
    //     to the tunnel root (no :port). Trailing slash trimmed.
    //  2. publicUrl (Tailscale, mobile only within the tailnet),
    //  3. localUrl (local only).
    // ENV → runtime file `data/public-url` (updated live by the tunnel manager)
    // → Tailscale publicUrl → localUrl.
    const previewBase = readPublicBaseOverride();
    const url = previewBase ?? serve.publicUrl ?? serve.localUrl;
    const payload: Record<string, unknown> = {
      url,
      title,
      status: 'ready',
    };
    if (serve.note) payload.note = serve.note;
    await emitChatMessageCompleted({
      workspaceId,
      entityId: ulid(),
      content: `<surface:preview>${JSON.stringify(payload)}</surface:preview>`,
      actor: 'system',
      outcome: 'ok',
      metadata: {
        surfaceKind: 'preview',
        workstreamId,
        ...(planId ? { planId } : {}),
      },
    });
    console.info(
      `[plan-executor][preview] ws=${workspaceId} url=${url} ` +
        `port=${serve.port} spawned=${serve.spawned} public=${serve.publicUrl ?? '(none)'}`,
    );
  } catch (err) {
    console.warn('[plan-executor] Preview-Emit fehlgeschlagen (non-fatal):', err);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// W1.1 — artifact contract per skill/role (2026-05-30)
// ────────────────────────────────────────────────────────────────────────────
//
// Every step gets a mandatory target path + artifact format. The
// weak `exit=0` gate so far waved .md notes through as "success". With the
// contract + the non-empty-diff gate (spawn success check), a step without
// a real file artifact is marked `no_artifact` failed.
//
// The skill/role is derived heuristically from role + title (DE+EN, against the
// compose.ts assignSkill keys). N6 deterministic.

// ───────────────────────────────────────────────────────────────────────────
// TRACK 2 (2026-05-30): PV-stringing step detection + deterministic execution
// ════════════════════════════════════════════════════════════════════════════
//
// A pv-stringing step carries in the DB ONLY `subagentRole='coder'` (closed enum,
// db/schema/workstream_plan_steps.ts) — the ORIGINAL skill 'pv-stringing' lives in
// the `| flow:{...}` annotation of the rationale (lib/flow/execute.ts::annotateRationale).
// We detect the step robustly via parseFlowAnnotation; a title-pattern fallback
// catches free decompose plans without a flow annotation (against the compose.ts keys).
//
// The producer (lib/eval/demo-pv/producer.ts) is DETERMINISTIC (N6, no
// LLM/I/O). It THEREFORE runs in the plan-executor BEFORE the claude-cli spawn branch — it
// writes NO file into the worktree but produces its PvArtifact and stores
// it serialized as the step output. This also bypasses the W1.1 non-empty-diff
// gate (which only applies to real spawn steps); a deterministic producer step
// never reaches the spawn path and consequently cannot fail as no_artifact.

/** Marker with which a deterministically produced PV artifact is serialized in the
 *  step output text. from-artifact.ts → evaluate.ts reads the parsed object
 *  (surfacePayload.strings[]/inverters[]) as the electrical model. */
export const PV_STRINGING_OUTPUT_MARKER = '<pv-stringing-artifact>';
const PV_STRINGING_OUTPUT_MARKER_END = '</pv-stringing-artifact>';

// The same pattern as the compose.ts SKILL_RULE for 'pv-stringing' — as a title
// fallback when no flow annotation is present (a free decompose plan).
const PV_STRINGING_TITLE_RE =
  /\b(string|stringing|wechselrichter|inverter|pv-?auslegung|modulbelegung|photovoltaik|dachbelegung)\b/i;

/**
 * Deterministically detects whether a step is the PV-stringing producer step.
 * Primarily via the `| flow:{...}` annotation (skill==='pv-stringing'), fallback
 * via the title pattern. Exported for the wiring test.
 */
export function isPvStringingStep(step: WorkstreamPlanStepRow): boolean {
  try {
    const { annotation } = parseFlowAnnotation(step.rationale ?? '');
    if (annotation?.skill && annotation.skill.trim().toLowerCase() === 'pv-stringing') {
      return true;
    }
  } catch {
    /* defensive: broken rationale → title fallback */
  }
  return PV_STRINGING_TITLE_RE.test(step.title ?? '');
}

/**
 * Extracts the producer inputs (RoofPlane[]/module/inverter) from the step
 * context. Source: the `configJson` of the `| flow:{...}` annotation (owner-/flow-
 * given hardware). §15.6-HONEST: if configJson or an input is missing, we return
 * NO invented default hardware — the producer then runs with
 * empty/missing inputs and produces (intentionally) 0 strings + a verbatim reason.
 * Deterministic (N6), never throws.
 *
 * Exported for the wiring test.
 */
export function extractStringingInput(
  step: WorkstreamPlanStepRow,
): StringingProducerInput {
  // Default: empty inputs → the producer honestly reports "no inverter/module/roof".
  const empty: StringingProducerInput = {
    roofPlanes: [],
    module: undefined as unknown as StringingProducerInput['module'],
    inverter: undefined as unknown as StringingProducerInput['inverter'],
  };

  // DEMO FALLBACK (2026-05-30): if the intent ITSELF explicitly marks itself as
  // an example/demo/sample PV run (keyword „beispiel"/„demo"/„muster" + PV)
  // AND NO owner-given hardware is present, we use a clearly
  // marked demo hardware set (RoofPlane/module/inverter). §15.6: this is
  // NO secret guessing — every demo value appears as a visible
  // `assumptions:[…DEMO assumption…]` in the producer output. So an
  // „Erstelle ein Beispiel-PV-Projekt" delivers a demonstrable, G5-PASSing package;
  // for real projects the hardware stays owner-input-dependent (if it's missing →
  // honestly empty → G5 BLOCKs). The demo applies ONLY as a last resort, NEVER when
  // real hardware is in the configJson.
  const intentText = step.title ?? '';
  const demoFallback = (): StringingProducerInput =>
    isDemoPvIntent(intentText) ? buildDemoStringingInput() : empty;

  let configJson: string | null = null;
  try {
    configJson = parseFlowAnnotation(step.rationale ?? '').annotation?.configJson ?? null;
  } catch {
    configJson = null;
  }
  if (!configJson) return demoFallback();
  try {
    const parsed: unknown = JSON.parse(configJson);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return demoFallback();
    const o = parsed as Record<string, unknown>;
    // Real hardware given? Only then do we pass the configJson through. If
    // both module and inverter are missing (no real hardware input), a
    // demo-PV intent falls back to the demo set (a real intent without hardware stays
    // honestly empty).
    const hasRealHardware =
      (o.module && typeof o.module === 'object') ||
      (o.inverter && typeof o.inverter === 'object');
    if (!hasRealHardware) return demoFallback();
    // We pass the given fields through 1:1 (the producer is defensive and
    // leaves missing/broken inputs honestly empty; NO filling in here).
    return {
      roofPlanes: Array.isArray(o.roofPlanes)
        ? (o.roofPlanes as StringingProducerInput['roofPlanes'])
        : [],
      module: o.module as StringingProducerInput['module'],
      inverter: o.inverter as StringingProducerInput['inverter'],
      ...(o.modulesPerPlane && typeof o.modulesPerPlane === 'object'
        ? { modulesPerPlane: o.modulesPerPlane as Record<string, number> }
        : {}),
      ...(typeof o.tMinC === 'number' ? { tMinC: o.tMinC } : {}),
      ...(typeof o.tMaxC === 'number' ? { tMaxC: o.tMaxC } : {}),
      ...(typeof o.vmpTempCoeffPctPerC === 'number'
        ? { vmpTempCoeffPctPerC: o.vmpTempCoeffPctPerC }
        : {}),
      ...(typeof o.stringIdPrefix === 'string'
        ? { stringIdPrefix: o.stringIdPrefix }
        : {}),
    };
  } catch {
    return demoFallback();
  }
}

/**
 * Runs the deterministic PV-stringing producer for a step and
 * serializes the result as step output text. The text contains:
 *   • a human-readable header (strings/assumptions/omissions, N1 verbatim),
 *   • a machine-readable `<pv-stringing-artifact>{...}</…>` block, whose
 *     JSON matches exactly the GenericBuildArtifact shape that from-artifact.ts
 *     consumes (surfacePayload.strings[]/inverters[]).
 *
 * Pure function (N6) — no I/O, no spawn, no worktree. Exported for the
 * wiring test.
 */
export function runPvStringingStep(step: WorkstreamPlanStepRow): string {
  const input = extractStringingInput(step);
  const result = produceStringingPlan(input);

  const headLines: string[] = [
    `[pv-stringing · deterministischer Producer — kein LLM, kein Worktree-Spawn]`,
    `Strings erzeugt: ${result.strings.length}` +
      (result.strings.length > 0
        ? ` (${result.strings.map((s) => `${s.id}:${s.moduleCount}×Modul`).join(', ')})`
        : ''),
    `Stringing-Regel-Verletzungen (Selbst-Verifikation): ${
      result.ruleViolations.length === 0 ? '0 (PASS)' : result.ruleViolations.join(' | ')
    }`,
  ];
  if (result.assumptions.length > 0) {
    headLines.push(
      `Annahmen (sichtbar, §15.6): ` +
        result.assumptions.map((a) => `${a.field}=${a.value} (${a.reason})`).join(' | '),
    );
  }
  if (result.omissions.length > 0) {
    headLines.push(
      `Ausgelassen (ehrlich leer, kein Raten): ` +
        result.omissions
          .map((om) => `${om.roofPlaneId ?? '(global)'}: ${om.reason}`)
          .join(' | '),
    );
  }

  const artifactJson = JSON.stringify(result.artifact);
  return (
    headLines.join('\n') +
    '\n' +
    PV_STRINGING_OUTPUT_MARKER +
    artifactJson +
    PV_STRINGING_OUTPUT_MARKER_END
  );
}

/**
 * Reads a PvArtifact JSON previously serialized by runPvStringingStep back out
 * of the step output text. Returns the parsed GenericBuildArtifact-compatible
 * object or null (no marker / broken JSON). Deterministic, never
 * throws. Exported for the wiring test (which runs the G5 eval over exactly this
 * output).
 */
export function parsePvStringingOutput(text: string): unknown | null {
  if (typeof text !== 'string') return null;
  const start = text.indexOf(PV_STRINGING_OUTPUT_MARKER);
  if (start === -1) return null;
  const from = start + PV_STRINGING_OUTPUT_MARKER.length;
  const end = text.indexOf(PV_STRINGING_OUTPUT_MARKER_END, from);
  if (end === -1) return null;
  try {
    return JSON.parse(text.slice(from, end));
  } catch {
    return null;
  }
}

/**
 * W2.1 (2026-05-30): summarizes the step outputs produced so far as a compact
 * "prior artifacts" list (title + expected target path), so the
 * next step knows what it builds on. N1: titles verbatim (no .slice).
 */
function summarizePriorArtifacts(
  outputs: ReadonlyArray<{ step: WorkstreamPlanStepRow; text: string }>,
): string | undefined {
  if (outputs.length === 0) return undefined;
  const lines = outputs.map((o) => {
    const contract = describeArtifactContract(o.step.subagentRole ?? '', o.step.title);
    const pathHint = contract ? contract.split('\n')[0] : '(kein Datei-Artefakt)';
    return `- Schritt „${o.step.title}" → ${pathHint}`;
  });
  return lines.join('\n');
}

/**
 * Returns the mandatory artifact contract (path + format) for a step.
 * Exported for the W1.1 test (the artifact contract is part of the gate).
 */
export function describeArtifactContract(role: string, title: string): string | null {
  const r = (role || '').toLowerCase();
  const t = (title || '').toLowerCase();

  // assembly — the final assembly (own skill, highest priority).
  if (r === 'assembly' || /\b(assembl|zusammenbau|zusammensetz|finale.+seite|index\.html)\b/.test(t)) {
    return [
      `Ziel-Datei: \`index.html\` im Workspace-Root.`,
      `Lies ALLE Fragmente im Worktree (\`design/tokens.css\`, \`content/site.config.json\`,`,
      `etwaige Sektions-Dateien) und baue daraus EINE ansehbare, in sich vollständige`,
      `\`index.html\`: verlinke/inline \`design/tokens.css\`, rendere die Sektionstexte aus`,
      `\`content/site.config.json\` gegen den Sektions-Katalog des Design-Systems.`,
      `Plain HTML/CSS — im Browser OHNE Build-Tool ansehbar. Platzhalter-Bilder =`,
      `CSS-Gradient oder inline-SVG (KEINE externen/Connector-Assets).`,
    ].join('\n');
  }
  // design → CSS custom properties.
  if (r === 'design' || /\b(design|style|styling|visual|theme|farb|gestalt|branding|mockup)\b/.test(t)) {
    return [
      `Ziel-Datei: \`design/tokens.css\` (CSS-Custom-Properties unter \`:root\`).`,
      `Tokenisiere das verbindliche Design-System als echte CSS-Variablen (--ink,`,
      `--accent, --sheet, Spacing-Scale, Type-Scale …). KEINE Markdown-Datei,`,
      `KEINE Erklärung. Wähle NUR Akzent + Stimme INNERHALB des Systems`,
      `(nenne deinen gewählten Akzent als \`/* accent: <key> */\`).`,
    ].join('\n');
  }
  // copywriting → site.config.json.
  if (r === 'copy' || r === 'copywriting' || /\b(copy|text|texte|caption|headline|slogan|wording|inhalt)\b/.test(t)) {
    return [
      `Ziel-Datei: \`content/site.config.json\` (gültiges JSON).`,
      `Schreibe die Sektions-Texte als JSON-Objekt, je Sektion (hero/features/proof/`,
      `cta/footer) die im Design-System genannten Inhalts-Felder. KEINE Prosa-Datei,`,
      `KEIN Markdown — striktes JSON, das der Assembly-Step parsen kann.`,
    ].join('\n');
  }
  // architecture/structure → index.html skeleton.
  if (r === 'architect' || r === 'architecture' || /\b(aufbau|struktur|architektur|architecture|setup|layout|gerüst|scaffold)\b/.test(t)) {
    return [
      `Ziel-Datei: \`index.html\` im Workspace-Root — das STRUKTUR-Gerüst.`,
      `Lege das semantische HTML-Skelett der Seite an: \`<section>\`-Container für`,
      `hero/features/proof/cta/footer (in dieser Reihenfolge), \`<link>\` auf`,
      `\`design/tokens.css\`. Noch keine finalen Texte (die füllt copy/assembly) —`,
      `aber valide, im Browser ladbare HTML-Datei. KEINE Markdown-Notiz.`,
    ].join('\n');
  }
  // coder / generic worker → a concrete file in the workspace root.
  if (r === 'coder' || r === 'build') {
    return [
      `Ziel: eine konkrete, ladbare Datei im Workspace-Root (z.B. ein HTML/CSS/JS-`,
      `Fragment dieser Sektion). KEINE Markdown-Notiz, KEIN reiner Vorschlags-Text —`,
      `schreibe das Artefakt als echte Datei mit dem \`Write\`-Tool.`,
    ].join('\n');
  }
  // reviewer/tester etc. — no file artifact enforced (default behavior).
  return null;
}

/**
 * Builds the prompt for a single plan step.
 *
 * `execute: false` (default / text-only): the prompt explicitly forbids
 *   code execution, file writes, or shell calls — a purely textual proposal.
 * `execute: true` (real tool spawn in the isolated worktree): the prompt
 *   allows the implementation with the granted tools but notes that
 *   everything happens in the isolated worktree (no merge without an operator gate).
 */
function buildStepPrompt(opts: {
  role: string;
  originalIntent: string;
  stepIndex: number;
  totalSteps: number;
  title: string;
  rationale: string;
  execute?: boolean;
  /**
   * W2.1 (2026-05-30): the mandatory website design system +
   * the accent chosen by the design step — forwarded to EVERY
   * subsequent coder/copy/assembly step. Set only for website-like
   * runs (otherwise undefined → bit-identical to the pre-W2.1 behavior).
   */
  sharedDesignContext?: string;
  /**
   * W2.1 (2026-05-30): the artifacts produced so far (path → short
   * description) that the step should read/respect. Forward chaining
   * of the already-collected stepOutputs. Set only for website-like runs.
   */
  priorArtifacts?: string;
}): string {
  // W1.1 (2026-05-30): a mandatory artifact contract per skill. The step
  // MUST write a concrete file — not a .md explanation. The artifact IS
  // the result. An empty worktree diff → the spawn gate fails the step
  // (no_artifact) instead of a silent no-op merge.
  const artifactContract = describeArtifactContract(opts.role, opts.title);

  if (opts.execute) {
    const lines: string[] = [
      `Du bist ein ${opts.role}-Agent im laz.ing Swarm Runtime.`,
      ``,
      `Plan-Kontext: "${opts.originalIntent}"`,
      ``,
      `Schritt ${opts.stepIndex}/${opts.totalSteps}: ${opts.title}`,
      `Begründung: ${opts.rationale}`,
      ``,
    ];
    if (opts.sharedDesignContext) {
      lines.push(opts.sharedDesignContext, ``);
    }
    if (opts.priorArtifacts) {
      lines.push(
        `── BISHERIGE ARTEFAKTE (lies + respektiere sie, baue darauf auf) ──`,
        opts.priorArtifacts,
        `── ENDE ARTEFAKTE ──`,
        ``,
      );
    }
    if (artifactContract) {
      lines.push(
        `── ARTEFAKT-VERTRAG (VERBINDLICH) ──`,
        artifactContract,
        `WICHTIG: Schreibe mit dem \`Write\`-Tool die oben genannte Datei.`,
        `Das ARTEFAKT (die Datei) IST das Ergebnis — KEINE Markdown-Erklärung,`,
        `KEINE Notiz-Datei, KEIN Vorschlags-Text. Wenn am Ende keine Datei`,
        `geschrieben wurde, gilt der Schritt als FEHLGESCHLAGEN (no_artifact).`,
        `── ENDE VERTRAG ──`,
        ``,
      );
    }
    lines.push(
      `Setze diesen Schritt mit den dir gewährten Tools um.`,
      `WICHTIG: Du arbeitest in einem ISOLIERTEN Git-Worktree (throwaway).`,
      `Der Live-Code-Baum ist NICHT betroffen — ein Merge passiert nur nach`,
      `expliziter Operator-Freigabe. Mache fokussierte, nachvollziehbare Änderungen.`,
    );
    return lines.join('\n');
  }
  return [
    `Du bist ein ${opts.role}-Agent im laz.ing Swarm Runtime.`,
    ``,
    `Plan-Kontext: "${opts.originalIntent}"`,
    ``,
    `Schritt ${opts.stepIndex}/${opts.totalSteps}: ${opts.title}`,
    `Begründung: ${opts.rationale}`,
    ``,
    `Skizziere KURZ (max 8 Zeilen) konkret WIE du diesen Schritt umsetzen würdest:`,
    `- Welche Dateien / Module wären betroffen?`,
    `- Welches Vorgehen (in 2-3 Stichwörtern)?`,
    `- Welche Risiken oder offene Fragen gibt es?`,
    ``,
    `WICHTIG: KEINE Code-Ausführung, KEINE Datei-Writes, KEINE Shell-Befehle.`,
    `Nur ein knapper Textvorschlag.`,
  ].join('\n');
}

/** System prompt for the real tool spawn (terse, role-specific). */
function buildExecSystemPrompt(opts: { role: string }): string {
  return [
    `Du bist ein ${opts.role}-Subagent im laz.ing Swarm Runtime.`,
    `Du arbeitest in einem isolierten Git-Worktree. Bleibe beim aktuellen Schritt,`,
    `vermeide Seiteneffekte außerhalb des Worktrees, dokumentiere deine Änderungen knapp.`,
  ].join('\n');
}

// ────────────────────────────────────────────────────────────────────────────
// Summary builder (grouped by group_id)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Builds the content for the final assistant message.
 * "Sort all subplans by membership after completion" =
 * grouped by group_id; steps without a group land under "(ungruppiert)".
 */
function buildSummaryContent(
  originalIntent: string,
  outputs: Array<{ step: WorkstreamPlanStepRow; text: string }>,
): string {
  // Bucket by group_id — group order = first occurrence.
  const groupOrder: string[] = [];
  const buckets = new Map<string, Array<{ step: WorkstreamPlanStepRow; text: string }>>();
  for (const o of outputs) {
    const key = readGroupId(o.step) ?? '(ungruppiert)';
    if (!buckets.has(key)) {
      buckets.set(key, []);
      groupOrder.push(key);
    }
    buckets.get(key)!.push(o);
  }

  const lines: string[] = [
    `Plan-Ausführung abgeschlossen.`,
    `Vorhaben: ${originalIntent}`,
    ``,
  ];

  const multiGroup = groupOrder.length > 1;
  for (const groupKey of groupOrder) {
    if (multiGroup) {
      lines.push(`### Gruppe: ${groupKey}`, ``);
    }
    const bucket = buckets.get(groupKey)!;
    // Within the group, sort stably by stepIndex.
    bucket.sort((a, b) => a.step.stepIndex - b.step.stepIndex);
    for (const { step, text } of bucket) {
      lines.push(
        `**Schritt ${step.stepIndex}: ${step.title}**`,
        `Rolle: ${step.subagentRole ?? 'coder'} | Begründung: ${step.rationale}`,
        ``,
        text.trim(),
        ``,
      );
    }
  }
  return lines.join('\n');
}
