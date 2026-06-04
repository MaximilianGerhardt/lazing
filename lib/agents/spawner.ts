// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Maximilian Gerhardt
//
// lib/agents/spawner — SubagentSpawner for lazyos-stable.
//
// BACKPORT-02 (2026-05-23) — Ported from Lazing V2
// `packages/runtime/src/subagent/spawner.ts` (514 LOC) with the
// adaptations noted in BACKPORT-SPEC-02 §6.4:
//
//   1. Engine adapter: V2 imports from `@lazing/adapters/types`; lazyos
//      uses the local `lib/llm/engines` ChatEngine interface. The
//      `chat()` call is single-shot (not streaming), so the spawner
//      emits ONE synthetic `text-delta` containing the full body
//      followed by an `end` event. A future lazyos streaming-engine
//      surface can swap in incremental tokens without changing the
//      consumer contract.
//
//   2. Worktree wiring (M-WORK-01, Wave-2, Checkup P1-#6):
//      Write-mode spawns (allowedTools ∩ {Write,Edit,Bash} ≠ ∅) receive an
//      isolated git worktree via createRunWorktree.  Text-only spawns are
//      BYTE-IDENTICAL to the pre-wiring behaviour — no FS side-effects.
//      The merge-into-main-tree path remains GATED (user-only, Phase 2 R3).
//      This closes the M-WORK-01 TODO without enabling any new destructive
//      writes: write-mode was already gated/rare; isolation just ensures that
//      IF it runs, it runs sandboxed.
//
//   3. Role-skill catalogue: same names, separate physical location —
//      lazyos catalogue ignores skills it doesn't expose.
//
//   4. CPU/RAM monitor: pure `node:os` — no changes.
//
// Responsibilities (load-bearing):
//
//   1. Acquire a heavy-engine slot from `resourcePool` BEFORE creating
//      any side effects.
//   2. Compose `roleTemplate + verbatim intent`. N1 verbatim.
//   3. Build the adapter via the injected factory.
//   4. Yield `SubagentLaneEvent`s annotated with subagentId+role.
//   5. Release the pool slot in a `finally` (even on adapter throw).
//   6. `spawnSwarm` fans out via incremental-queue multiplexing.
//   7. [M-WORK-01] For write-mode spawns: createRunWorktree → run in
//      isolated path → discardRunWorktree in finally.  Merge stays GATED.

import { cpuRamMonitor, type CpuRamMonitor } from './cpu-ram-monitor';
import { resourcePool, type PoolSlot } from './resource-pool';
import { composeSubagentSystemPrompt } from './role-prompts';
import { skillsForRole } from './role-skill-map';
import type {
  SpawnSubagentInput,
  SubagentEngine,
  SubagentHandoff,
  SubagentLaneEvent,
  SubagentRole,
} from './spawner-types';
import { WRITE_MODE_TOOLS } from './spawner-types';
import {
  createRunWorktree,
  discardRunWorktree,
} from './worktree-manager';
//
// ACCUMULATION EXCEPTION (2026-05-29): The plan-executor path was switched to the
// accumulation model (run branch + step worktree + serial merge:
// createOrReuseRunWorktree / createStepWorktree / mergeStepIntoRun /
// discardStepWorktree) so that a composed website is built step by
// step. This spawner (BACKPORT-02 from Lazing V2) DELIBERATELY stays on
// the old throwaway model (createRunWorktree/discardRunWorktree, each
// write-mode spawn = its own isolated throwaway worktree from HEAD, NO merge,
// NO composition). Reasons:
//   - The spawner is NOT the live plan-executor path (its own BACKPORT path
//     with its own SubagentLaneEvent contract + its own green tests).
//   - It has no notion of a stable plan-run runId across multiple steps;
//     spawnSwarm fans out disjoint roles in parallel — composition is not
//     the goal here (mesh/critic fan-out, not sequential website build phases).
//   - createRunWorktree/discardRunWorktree are kept and unchanged; the
//     N11 cap (max 5) is still enforced in createRunWorktree.
// A later migration can lift the spawner to createStepWorktree+mergeStepIntoRun
// if swarm runs should also accumulate — out of scope here.
import type { SwarmTopology } from './swarm-topology';

// ── Adapter factory injection ──────────────────────────────────────────────

/**
 * Minimal contract the spawner needs from a lazyos engine adapter. We
 * keep this narrower than `ChatEngine` so the runtime stays decoupled
 * from per-engine config evolution. The adapter MUST expose a single
 * `runOnce()` returning a structured result.
 */
export interface SpawnerAdapter {
  /**
   * Single-shot adapter call. The adapter is responsible for honouring
   * `signal` (abort) and the `allowedSkills` allow-list when supported.
   * Returns the full assistant text + optional duration.
   */
  runOnce(args: {
    readonly systemPrompt: string;
    readonly userMessage: string;
    readonly signal?: AbortSignal;
  }): Promise<{ readonly text: string; readonly durationMs?: number }>;
}

export interface SpawnerAdapterFactoryInput {
  readonly engine: SubagentEngine;
  readonly workspacePath: string;
  readonly allowedSkills: readonly string[];
  /**
   * Workspace scope for the PII vault (N9). Forwarded from SpawnSubagentInput.
   * The default factory uses it to wrap a cloud engine (tokenize prompts /
   * rehydrate reply). Optional — absent → no tokenization (test factories).
   */
  readonly workspaceId?: string;
}

export type SpawnerAdapterFactory = (input: SpawnerAdapterFactoryInput) => SpawnerAdapter;

/**
 * Worktree isolation config for write-mode spawns (M-WORK-01).
 *
 * When present in SubagentSpawnerConfig, write-mode spawns (those with
 * allowedTools ∩ {Write,Edit,Bash} ≠ ∅) receive an isolated git worktree
 * instead of running in `input.worktreePath` directly.
 *
 * When ABSENT the spawner behaves BYTE-IDENTICALLY to the pre-wiring
 * version — text-only spawns are completely unaffected; write-mode spawns
 * fall back to the caller-supplied `worktreePath` (legacy/test path).
 *
 * Security posture:
 *   - This wiring does NOT enable any new destructive writes.  Write-mode
 *     spawns were already gated upstream; isolation ensures they run in a
 *     throwaway branch, never touching the live checkout.
 *   - mergeRunWorktree is intentionally GATED (throws always in R1).
 *     The worktree is discarded (rolled back) in the finally block.
 *   - N11 cap is enforced by createRunWorktree itself; at-cap the spawn
 *     fails with code 'worktree-cap-exhausted' and no FS change occurs.
 */
export interface WorktreeConfig {
  /**
   * Absolute path to the live git repository (the main checkout, NOT a
   * worktree).  Passed verbatim to createRunWorktree as `repoPath`.
   */
  readonly repoPath: string;
  /**
   * Workspace identifier — used as the worktree directory grouping under
   * .lazing-worktrees/<workspaceId>/.  Must match SAFE_ID_RE
   * ([A-Za-z0-9_:.-]{1,64}) — the spawner sanitises it before use.
   */
  readonly workspaceId: string;
}

export interface SubagentSpawnerConfig {
  readonly adapterFactory: SpawnerAdapterFactory;
  /** Override the slot timeout for the resource-pool acquire. Default: 60s. */
  readonly slotTimeoutMs?: number;
  /** Clock override — for deterministic test timestamps. */
  readonly now?: () => number;
  /** Subagent-id generator override. Default: 'sub-<role>-<8char>'. */
  readonly idGen?: (role: SubagentRole) => string;
  /** CPU/RAM gate override. Tests inject a fake monitor. */
  readonly cpuRamMonitor?: CpuRamMonitor;
  /**
   * Worktree isolation config (M-WORK-01).
   * When provided, write-mode spawns (allowedTools ∩ {Write,Edit,Bash} ≠ ∅)
   * run inside isolated git worktrees instead of the live repo path.
   * When absent, all spawns use the caller-supplied worktreePath unchanged —
   * preserving the pre-wiring behaviour exactly (BYTE-IDENTICAL for
   * text-only spawns; legacy fallback for write-mode).
   *
   * POSTURE: Providing this config does NOT enable any new destructive
   * writes — it only ensures existing write-mode spawns run sandboxed.
   * The merge path stays GATED (Phase 2 R3, user-only FSM transition).
   */
  readonly worktreeConfig?: WorktreeConfig;
}

// ── Public API ─────────────────────────────────────────────────────────────

export interface SubagentSpawner {
  spawnSubagent(input: SpawnSubagentInput): AsyncIterable<SubagentLaneEvent>;
  spawnSwarm(input: SpawnSwarmInput): AsyncIterable<SubagentLaneEvent>;
}

export interface SpawnSwarmInput {
  /** Verbatim roles to fan out. Duplicates allowed (e.g. 3 coders for mesh). */
  readonly roles: readonly SubagentRole[];
  readonly intent: SpawnSubagentInput['intent'];
  /** Topology label — passed through for telemetry only. */
  readonly topology: SwarmTopology;
  readonly parentWorkstreamId: string;
  /**
   * Per-role worktree paths. Length MUST match `roles.length`. Caller
   * provides; TODO(Wave-2 M-WORK-01) wires the real worktreeManager.
   */
  readonly worktreePaths: readonly string[];
  /** Per-role engine. Length MUST match `roles.length`. */
  readonly engines: readonly SubagentEngine[];
  readonly signal?: AbortSignal;
  readonly upstreamArtifacts?: SpawnSubagentInput['upstreamArtifacts'];
  /** Per-role handoff prelude (HANDOFF-DOC). */
  readonly handoffs?: readonly (SubagentHandoff | undefined)[];
}

// ── Implementation ─────────────────────────────────────────────────────────

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

function makeSubagentId(role: SubagentRole): string {
  let s = '';
  for (let i = 0; i < 8; i += 1) {
    s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return `sub-${role}-${s}`;
}

function rolePriority(role: SubagentRole): 'critical' | 'normal' | 'background' {
  // Security wins critical — a security finding must NEVER be starved by
  // a slow coder. Reviewer is high but not critical. Coder/architect are
  // the default. Perf + tester are background.
  switch (role) {
    case 'security':
    case 'policy-checker':
    case 'judge':
      return 'critical';
    case 'reviewer':
      return 'critical';
    case 'coder':
    case 'architect':
    case 'researcher':
    case 'planner':
      return 'normal';
    case 'tester':
    case 'perf':
    case 'curator':
    case 'scribe':
      return 'background';
    default:
      return 'normal';
  }
}

/**
 * Derive the `lazing/run/*` branch name from a worktree path — used to
 * annotate SubagentLaneEvents with the branch so the UI can link to the
 * diff preview.
 *
 * M-WORK-01 (Wave-2): the spawner maintains a local branch-tracking map
 * (`activeBranches`) that is populated when a worktree is created.
 * Text-only spawns never touch this map and still return null.
 *
 * The `activeBranches` map is scoped to the spawner instance created by
 * `createSubagentSpawner` — no global mutable state.
 */
function makeBranchTracker(): {
  set: (path: string, branch: string) => void;
  get: (path: string) => string | null;
  delete: (path: string) => void;
} {
  const map = new Map<string, string>();
  return {
    set: (path, branch) => map.set(path, branch),
    get: (path) => map.get(path) ?? null,
    delete: (path) => { map.delete(path); },
  };
}

/**
 * Sanitise a raw ID so it can be passed to worktree-manager's SAFE_ID_RE
 * validation.  Strips any character outside [A-Za-z0-9_:.-] and truncates
 * to 64 chars.  A prefix is prepended so the result is always non-empty.
 */
function sanitiseWorktreeId(raw: string, prefix: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_:.\-]/g, '-').slice(0, 64);
  // Guarantee non-empty and starts with a safe char
  return cleaned.length > 0 ? cleaned : `${prefix}-fallback`;
}

/**
 * Determine whether a spawn is "write-mode" — i.e. the allowedTools set
 * intersects WRITE_MODE_TOOLS ({Write, Edit, Bash}).
 *
 * Text-only spawns (allowedTools undefined or no overlap) return false —
 * the spawner behaviour is BYTE-IDENTICAL to the pre-wiring version.
 */
function isWriteMode(allowedTools: readonly string[] | undefined): boolean {
  if (!allowedTools || allowedTools.length === 0) return false;
  return allowedTools.some((t) => WRITE_MODE_TOOLS.has(t as never));
}

export function createSubagentSpawner(config: SubagentSpawnerConfig): SubagentSpawner {
  const cfg = {
    adapterFactory: config.adapterFactory,
    slotTimeoutMs: config.slotTimeoutMs ?? 60_000,
    now: config.now ?? Date.now,
    idGen: config.idGen ?? makeSubagentId,
    cpuRamMonitor: config.cpuRamMonitor ?? cpuRamMonitor,
    worktreeConfig: config.worktreeConfig,
  };

  // Per-spawner-instance branch tracking map (M-WORK-01).
  // Maps isolated worktree path → branch name for SubagentLaneEvent annotation.
  // Only populated for write-mode spawns; text-only spawns never touch it.
  const branchTracker = makeBranchTracker();

  // Only heavy engines go through the CPU/RAM gate. lazyos-stable
  // surfaces three heavy kinds via the resource-pool: claude-cli,
  // codex, ollama-heavy.
  const isHeavyEngine = (engine: SubagentEngine): boolean =>
    engine === 'claude-cli' || engine === 'codex' || engine === 'ollama-heavy';

  async function* spawnSubagent(input: SpawnSubagentInput): AsyncIterable<SubagentLaneEvent> {
    const subagentId = cfg.idGen(input.role);

    // M-WORK-01: resolve the effective worktree path.
    // For text-only spawns this is a no-op (same as before).
    // For write-mode spawns we create an isolated git worktree BEFORE
    // acquiring the resource-pool slot — fail-closed: if the worktree
    // cap is exhausted we never reach the slot acquire or the adapter.
    const writeMode = isWriteMode(input.allowedTools);
    let effectiveWorktreePath = input.worktreePath;
    // planRunId used for the isolated branch; scoped to this subagent.
    // subagentId is already safe for path use (sub-<role>-<8alnum>).
    const planRunId = sanitiseWorktreeId(subagentId, 'run');

    if (writeMode && cfg.worktreeConfig) {
      // N11 cap + path-traversal checks are all inside createRunWorktree.
      // On cap-exhaustion it throws N11_WORKTREE_CAP — we catch it below
      // and emit an error event (fail-closed, never falls back to live path).
      let worktreeResult: { worktreePath: string; branch: string };
      try {
        worktreeResult = await createRunWorktree({
          repoPath: cfg.worktreeConfig.repoPath,
          workspaceId: sanitiseWorktreeId(cfg.worktreeConfig.workspaceId, 'ws'),
          planRunId,
        });
      } catch (err) {
        // Fail-closed: yield error and stop — do NOT fall back to
        // the live repo path.  A write-mode spawn without isolation
        // is worse than no spawn at all.
        const msg = err instanceof Error ? err.message : String(err);
        yield {
          kind: 'error',
          subagentId,
          role: input.role,
          worktreeBranch: null,
          code: msg.startsWith('N11_WORKTREE_CAP') ? 'worktree-cap-exhausted' : 'worktree-create-failed',
          message: `[M-WORK-01] write-mode spawn aborted — cannot create isolated worktree: ${msg}`,
          at: cfg.now(),
        };
        return;
      }
      effectiveWorktreePath = worktreeResult.worktreePath;
      branchTracker.set(effectiveWorktreePath, worktreeResult.branch);
      if (process.env['NODE_ENV'] !== 'production') {
        // eslint-disable-next-line no-console
        console.log(
          `[lazyos-worktree] created isolated worktree for write-mode spawn: ` +
          `subagentId=${subagentId} branch=${worktreeResult.branch} path=${effectiveWorktreePath}`,
        );
      }
    }

    // Branch annotation for SubagentLaneEvents.
    // For write-mode spawns this returns the lazing/run/* branch we just created.
    // For text-only spawns this always returns null (no map entry, no change).
    const worktreeBranch = branchTracker.get(effectiveWorktreePath);
    const at = cfg.now();

    // M-WORK-01 outer try/finally: ensures the isolated worktree is discarded
    // on ALL exit paths — normal, system-overload, slot-acquire-failed, adapter
    // throw, and abort.  Only runs cleanup when a worktree was actually created
    // (writeMode && worktreeConfig && effectiveWorktreePath ≠ input.worktreePath).
    // Text-only spawns never enter the cleanup branch — the condition is false.
    try {
      // Yield `started` immediately so the UI can show "waiting on slot".
      yield {
        kind: 'started',
        subagentId,
        role: input.role,
        worktreeBranch,
        engine: input.engine,
        at,
      };

      // CPU/RAM gate — refuse heavy spawn EARLY when the host is overloaded.
      if (isHeavyEngine(input.engine) && !cfg.cpuRamMonitor.canSpawnHeavy()) {
        const reason = cfg.cpuRamMonitor.reason();
        if (process.env['NODE_ENV'] !== 'production') {
          // eslint-disable-next-line no-console
          console.log(
            `[lazyos-subagent-spawn] REJECTED role=${input.role} engine=${input.engine} reason=system-overload (${reason})`,
          );
        }
        yield {
          kind: 'error',
          subagentId,
          role: input.role,
          worktreeBranch,
          code: 'system-overload',
          message: `Refusing heavy spawn: ${reason}`,
          at: cfg.now(),
        };
        return;
      }

      let slot: PoolSlot;
      try {
        slot = await resourcePool.acquireSlot({
          kind: input.engine,
          subagentId,
          priority: input.priority ?? rolePriority(input.role),
          timeoutMs: cfg.slotTimeoutMs,
          ...(input.signal ? { signal: input.signal } : {}),
        });
      } catch (err) {
        yield {
          kind: 'error',
          subagentId,
          role: input.role,
          worktreeBranch,
          code: 'slot-acquire-failed',
          message: err instanceof Error ? err.message : String(err),
          at: cfg.now(),
        };
        return;
      }

      if (process.env['NODE_ENV'] !== 'production') {
        // eslint-disable-next-line no-console
        console.log(
          `[lazyos-resource-pool] acquired kind=${input.engine} subagent=${subagentId} slotId=${slot.slotId} inflight=${resourcePool.getInflight().length}/${resourcePool.getBudget().heavyTotal}`,
        );
        // eslint-disable-next-line no-console
        console.log(
          `[lazyos-subagent-spawn] role=${input.role} engine=${input.engine} worktree=${effectiveWorktreePath} handoffPresent=${input.handoff ? 'true' : 'false'}`,
        );
      }

      const startTime = cfg.now();
      try {
        const allowedSkills = input.skillsAllowed ?? skillsForRole(input.role);
        const adapter = cfg.adapterFactory({
          engine: input.engine,
          workspacePath: effectiveWorktreePath,
          allowedSkills,
          ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
        });

        const systemPrompt = composeSubagentSystemPrompt({
          role: input.role,
          intentText: input.intent.intentText, // N1 verbatim
          ...(input.upstreamArtifacts ? { upstreamArtifacts: input.upstreamArtifacts } : {}),
          ...(input.contextDiff ? { contextDiff: input.contextDiff } : {}),
          ...(input.handoff ? { handoff: input.handoff } : {}),
        });

        const abortCtl = new AbortController();
        const onAbort = (): void => abortCtl.abort();
        if (input.signal) {
          if (input.signal.aborted) {
            abortCtl.abort();
          } else {
            input.signal.addEventListener('abort', onAbort, { once: true });
          }
        }

        try {
          const result = await adapter.runOnce({
            systemPrompt,
            userMessage: input.intent.intentText, // N1 verbatim
            signal: abortCtl.signal,
          });
          // lazyos engines are single-shot; emit one synthetic text-delta
          // followed by `end`. A future streaming engine surface can yield
          // incremental tokens directly without changing the consumer.
          yield {
            kind: 'text-delta',
            subagentId,
            role: input.role,
            worktreeBranch,
            text: result.text,
            at: cfg.now(),
          };
          yield {
            kind: 'end',
            subagentId,
            role: input.role,
            worktreeBranch,
            durationMs: result.durationMs ?? cfg.now() - startTime,
            reason: 'stop',
            at: cfg.now(),
          };
        } finally {
          if (input.signal) input.signal.removeEventListener('abort', onAbort);
        }

        if (process.env['NODE_ENV'] !== 'production') {
          // eslint-disable-next-line no-console
          console.log(
            `[lazyos-subagent-result] role=${input.role} ok=true durationMs=${cfg.now() - startTime}`,
          );
        }
      } catch (err) {
        yield {
          kind: 'error',
          subagentId,
          role: input.role,
          worktreeBranch,
          code: 'spawn-failed',
          message: err instanceof Error ? err.message : String(err),
          at: cfg.now(),
        };
        if (process.env['NODE_ENV'] !== 'production') {
          // eslint-disable-next-line no-console
          console.log(
            `[lazyos-subagent-result] role=${input.role} ok=false durationMs=${cfg.now() - startTime}`,
          );
        }
      } finally {
        // ALWAYS release the slot — leaking starves the next acquire.
        resourcePool.releaseSlot(slot.slotId);
        if (process.env['NODE_ENV'] !== 'production') {
          // eslint-disable-next-line no-console
          console.log(
            `[lazyos-resource-pool] released kind=${input.engine} subagent=${subagentId} slotId=${slot.slotId} inflight=${resourcePool.getInflight().length}/${resourcePool.getBudget().heavyTotal}`,
          );
        }
      }
    } finally {
      // M-WORK-01: discard the isolated worktree after the spawn completes on
      // ALL paths (success, system-overload, slot-acquire-failed, adapter error,
      // abort).  This is the rollback path — the worktree was always throwaway.
      //
      // Merge into the live tree is intentionally GATED (Phase 2 R3 / S6,
      // user-only FSM transition).  discardRunWorktree is best-effort and never
      // throws (it warns on partial failure), so it cannot mask the original error.
      //
      // The condition guards that a worktree was actually created:
      //   writeMode && worktreeConfig → wiring is active
      //   effectiveWorktreePath ≠ input.worktreePath → creation succeeded (path was replaced)
      // Text-only spawns always have effectiveWorktreePath === input.worktreePath, so
      // this branch is dead code for them — BYTE-IDENTICAL to pre-wiring behaviour.
      if (writeMode && cfg.worktreeConfig && effectiveWorktreePath !== input.worktreePath) {
        branchTracker.delete(effectiveWorktreePath);
        // Discard is fire-and-forget: we don't await so the finally returns promptly.
        // The N11 cap will block new creates until the orphan is cleaned by
        // recoverOrphanedWorktrees (boot recovery, analogous to resource-pool.__reset).
        discardRunWorktree({
          repoPath: cfg.worktreeConfig.repoPath,
          planRunId,
        }).catch((err: unknown) => {
          console.warn(
            `[lazyos-worktree] discardRunWorktree best-effort failed for ` +
            `subagentId=${subagentId} planRunId=${planRunId}: ` +
            `${err instanceof Error ? err.message : String(err)}`,
          );
        });
      }
    }
  }

  async function* spawnSwarm(input: SpawnSwarmInput): AsyncIterable<SubagentLaneEvent> {
    if (
      input.roles.length !== input.worktreePaths.length ||
      input.roles.length !== input.engines.length
    ) {
      throw new Error(
        `spawnSwarm: roles (${input.roles.length}), worktreePaths (${input.worktreePaths.length}), and engines (${input.engines.length}) must have the same length`,
      );
    }

    type LaneItem =
      | { readonly kind: 'event'; readonly event: SubagentLaneEvent }
      | { readonly kind: 'done' };

    const buffer: LaneItem[] = [];
    let waiter: ((v: LaneItem) => void) | null = null;

    const push = (item: LaneItem): void => {
      if (waiter) {
        const w = waiter;
        waiter = null;
        w(item);
      } else {
        buffer.push(item);
      }
    };

    let running = input.roles.length;

    for (let i = 0; i < input.roles.length; i += 1) {
      const role = input.roles[i]!;
      const worktreePath = input.worktreePaths[i]!;
      const engine = input.engines[i]!;
      void (async () => {
        try {
          for await (const ev of spawnSubagent({
            role,
            intent: input.intent,
            parentWorkstreamId: input.parentWorkstreamId,
            worktreePath,
            engine,
            ...(input.signal ? { signal: input.signal } : {}),
            ...(input.upstreamArtifacts ? { upstreamArtifacts: input.upstreamArtifacts } : {}),
            ...(input.handoffs && input.handoffs[i] ? { handoff: input.handoffs[i] } : {}),
          })) {
            push({ kind: 'event', event: ev });
          }
        } finally {
          running -= 1;
          push({ kind: 'done' });
        }
      })();
    }

    while (running > 0 || buffer.length > 0) {
      let item: LaneItem;
      if (buffer.length > 0) {
        item = buffer.shift()!;
      } else {
        item = await new Promise<LaneItem>((resolve) => {
          waiter = resolve;
        });
      }
      if (item.kind === 'event') yield item.event;
    }
  }

  return { spawnSubagent, spawnSwarm };
}
