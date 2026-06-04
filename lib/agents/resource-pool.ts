// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Maximilian Gerhardt
//
// lib/agents/resource-pool — N11 hard-cap slot allocator for heavy engines.
//
// BACKPORT-02 (2026-05-23) — Bundled into lib/agents because lazyos-stable
// has no `system/resource-pool` module yet (M-RES-01 prerequisite). The
// pool is a process-scoped singleton that gates `claude-cli + codex +
// ollama-heavy` spawns against:
//   - heavyTotal = 2  (across all kinds collectively, N11)
//   - per-kind ceilings: claude-cli ≤ 2, codex ≤ 3, ollama-heavy ≤ 1
//
// Ported verbatim from Lazing V2 `packages/runtime/src/system/resource-pool.ts`
// — only the export path differs.
//
// ─────────────────────────────────────────────────────────────────────────
// SLOT DECOUPLING (2026-05-26) — separate budget classes instead of one
// global `heavyTotal` as a universal brake.
//
// PROBLEM: The earlier `heavyTotal=2` was used in the plan-executor as
// `maxParallel` for ALL plan steps — text-only steps and
// claude-cli spawns included. This mixed the REAL N11 limit
// ("max 2 heavy local Ollama jobs") with "max parallel plan steps /
// claude-cli spawns" and artificially capped the builder width at 2.
//
// SOLUTION: Three orthogonal classes, each bound to its OWN real resource
// (getConcurrencyBudget). The heavy-engine slot pool (acquireSlot /
// heavyTotal / perKind) stays UNCHANGED for REAL heavy-engine spawns —
// the N11 limit of 2 still applies there (ollama-heavy perKind=1, heavyTotal=2).
//
//   - heavyOllama = 2      → REAL N11 limit (max 2 heavy local Ollama
//                            jobs, e.g. deepseek-r1:14b synthesis). Identical
//                            to heavyTotal; only explicitly named. UNCHANGED.
//   - spawnConcurrency = 5 → claude-cli plan-step spawns (write/bash). Bound to the
//                            worktree cap (MAX_RUN_WORKTREES=5 in
//                            worktree-manager.ts) — the real
//                            isolation limit. NO artificial cap of 2.
//   - textConcurrency      → text-only/read plan steps (no worktree, no
//                            heavy Ollama). Cores-derived, conservative
//                            (min(available cores, 6); N11 names 12 cores,
//                            we leave headroom). NO heavy slots.
//
// All three are named constants + ENV-overridable (owner tuning).
// ─────────────────────────────────────────────────────────────────────────

export type ResourceKind = 'claude-cli' | 'codex' | 'ollama-heavy';

export type SlotPriority = 'critical' | 'normal' | 'background';

export interface PoolSlot {
  readonly slotId: string;
  readonly kind: ResourceKind;
  readonly subagentId: string;
  readonly acquiredAt: number;
  readonly priority: SlotPriority;
}

export interface PoolBudget {
  readonly heavyTotal: number;
  readonly perKind: Readonly<Record<ResourceKind, number>>;
}

/**
 * Separate concurrency classes (SLOT DECOUPLING 2026-05-26).
 *
 * Each class is bound to its OWN real resource — they are
 * orthogonal. A text-only step, for instance, takes NEITHER a heavy-Ollama slot
 * NOR a worktree; it is only limited by `textConcurrency` (cores).
 *
 *  - heavyOllama:       N11 hard cap "max 2 heavy local Ollama jobs"
 *                       (== heavyTotal of the heavy-engine slot pool).
 *  - spawnConcurrency:  max parallel claude-cli plan-step spawns
 *                       (== worktree cap MAX_RUN_WORKTREES=5).
 *  - textConcurrency:   max parallel text-only/read plan steps
 *                       (cores-derived, conservatively capped).
 */
export interface ConcurrencyBudget {
  readonly heavyOllama: number;
  readonly spawnConcurrency: number;
  readonly textConcurrency: number;
}

export interface AcquireSlotInput {
  readonly kind: ResourceKind;
  readonly subagentId: string;
  readonly priority?: SlotPriority;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface ResourcePool {
  acquireSlot(input: AcquireSlotInput): Promise<PoolSlot>;
  /**
   * Synchronous, NON-blocking slot acquisition. Returns a slot
   * immediately if the budget allows (fast path of acquireSlot), otherwise
   * `null` — WITHOUT queuing, WITHOUT a promise, WITHOUT a timeout.
   *
   * For callers that need "fire-now-or-skip" semantics (e.g.
   * the cron scheduler loop): a full pool must NOT
   * block the sweep. `acquireSlot({ timeoutMs: 0 })` is unsuitable for this, because
   * `0 ?? DEFAULT === 0` and `timeoutMs > 0 === false` sets NO timeout —
   * the waiter lands in the queue and waits forever (stall bug).
   */
  tryAcquireSlot(input: AcquireSlotInput): PoolSlot | null;
  releaseSlot(slotId: string): void;
  getBudget(): PoolBudget;
  /**
   * Separate concurrency classes (heavyOllama / spawnConcurrency /
   * textConcurrency). The plan-executor reads the right width from here
   * PER STEP TYPE — NO longer blanket `getBudget().heavyTotal`.
   */
  getConcurrencyBudget(): ConcurrencyBudget;
  getInflight(): readonly PoolSlot[];
  queueDepth(kind: ResourceKind): number;
  /** TEST-ONLY — wipe inflight + queue and reset the slot counter. */
  __reset(): void;
}

const DEFAULT_BUDGET: PoolBudget = {
  heavyTotal: 2,
  perKind: {
    'claude-cli': 2,
    codex: 3,
    'ollama-heavy': 1,
  },
} as const;

// ─── Concurrency classes (SLOT DECOUPLING 2026-05-26) ─────────────────────
//
// Named default constants + ENV overrides (owner tuning). Each class
// binds to its OWN real resource. Negative / NaN / 0 overrides are
// rejected back to the default (fail-safe — no 0-budget deadlock).

/**
 * REAL N11 limit: max 2 heavy local Ollama jobs at once.
 * Identical to DEFAULT_BUDGET.heavyTotal — the heavy-engine slot pool and
 * the heavyOllama class share the same value (an Ollama synthesis still
 * takes acquireSlot({ kind: 'ollama-heavy' })).
 */
const DEFAULT_HEAVY_OLLAMA = 2;

/**
 * max parallel claude-cli plan-step spawns (write/bash). Bound to the
 * worktree cap MAX_RUN_WORKTREES=5 (worktree-manager.ts) — the real
 * isolation limit. Mirrored here as a literal to avoid an import-cycle
 * dependency (worktree-manager → resource-pool ↔); the value
 * in worktree-manager.ts (MAX_RUN_WORKTREES) is the source of truth.
 */
const DEFAULT_SPAWN_CONCURRENCY = 5;

/**
 * max parallel text-only/read plan steps. Cores-derived, conservatively
 * capped: min(available cores, TEXT_CONCURRENCY_CAP). N11 names 12 cores;
 * we leave headroom (cap 6), since text-only steps run no heavy Ollama
 * but still trigger claude-CLI/--print subprocesses / HTTP calls.
 */
const TEXT_CONCURRENCY_CAP = 6;

function detectCores(): number {
  try {
    // Lazy + defensive: os.availableParallelism (Node 19+) → cpus().length.
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    const os = require('node:os') as typeof import('node:os');
    const ap = (os as { availableParallelism?: () => number }).availableParallelism;
    const n = typeof ap === 'function' ? ap() : os.cpus().length;
    return Number.isFinite(n) && n > 0 ? n : 1;
  } catch {
    return 1;
  }
}

const DEFAULT_TEXT_CONCURRENCY = Math.max(1, Math.min(detectCores(), TEXT_CONCURRENCY_CAP));

/**
 * Reads a positive integer ENV override; falls back to the default on
 * missing/invalid/≤0 (fail-safe — never a 0 or negative budget).
 */
function envPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const CONCURRENCY_BUDGET: ConcurrencyBudget = {
  heavyOllama: envPositiveInt('LAZYOS_HEAVY_OLLAMA', DEFAULT_HEAVY_OLLAMA),
  spawnConcurrency: envPositiveInt('LAZYOS_SPAWN_CONCURRENCY', DEFAULT_SPAWN_CONCURRENCY),
  textConcurrency: envPositiveInt('LAZYOS_TEXT_CONCURRENCY', DEFAULT_TEXT_CONCURRENCY),
} as const;

const DEFAULT_TIMEOUT_MS = 60_000;

const PRIORITY_RANK: Readonly<Record<SlotPriority, number>> = {
  critical: 0,
  normal: 1,
  background: 2,
};

interface QueuedWaiter {
  readonly kind: ResourceKind;
  readonly subagentId: string;
  readonly priority: SlotPriority;
  readonly seq: number;
  readonly resolve: (slot: PoolSlot) => void;
  readonly reject: (err: Error) => void;
  readonly cleanup: () => void;
}

const inflight = new Map<string, PoolSlot>();
const queue: QueuedWaiter[] = [];
let slotCounter = 0;
let seqCounter = 0;

function makeSlotId(kind: ResourceKind): string {
  slotCounter += 1;
  return `slot-${kind}-${slotCounter}-${Math.random().toString(36).slice(2, 8)}`;
}

function countInflightByKind(kind: ResourceKind): number {
  let n = 0;
  for (const slot of inflight.values()) {
    if (slot.kind === kind) n += 1;
  }
  return n;
}

function canFit(kind: ResourceKind): boolean {
  if (inflight.size >= DEFAULT_BUDGET.heavyTotal) return false;
  if (countInflightByKind(kind) >= DEFAULT_BUDGET.perKind[kind]) return false;
  return true;
}

function grantSlot(
  kind: ResourceKind,
  subagentId: string,
  priority: SlotPriority,
): PoolSlot {
  const slot: PoolSlot = {
    slotId: makeSlotId(kind),
    kind,
    subagentId,
    acquiredAt: Date.now(),
    priority,
  };
  inflight.set(slot.slotId, slot);
  return slot;
}

function drainQueue(): void {
  queue.sort((a, b) => {
    const dp = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
    return dp !== 0 ? dp : a.seq - b.seq;
  });
  for (let i = 0; i < queue.length; i += 1) {
    const w = queue[i]!;
    if (!canFit(w.kind)) continue;
    queue.splice(i, 1);
    i -= 1;
    w.cleanup();
    const slot = grantSlot(w.kind, w.subagentId, w.priority);
    w.resolve(slot);
  }
}

export const resourcePool: ResourcePool = {
  acquireSlot(input: AcquireSlotInput): Promise<PoolSlot> {
    const priority = input.priority ?? 'normal';
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    if (canFit(input.kind) && queue.length === 0) {
      const slot = grantSlot(input.kind, input.subagentId, priority);
      return Promise.resolve(slot);
    }

    if (input.signal?.aborted) {
      return Promise.reject(
        new Error('ResourcePoolAborted: signal already aborted before acquire'),
      );
    }

    return new Promise<PoolSlot>((resolve, reject) => {
      seqCounter += 1;
      const seq = seqCounter;

      let cleaned = false;
      // eslint-disable-next-line prefer-const
      let waiter: QueuedWaiter;

      const cleanup = (): void => {
        if (cleaned) return;
        cleaned = true;
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (abortHandler && input.signal) {
          input.signal.removeEventListener('abort', abortHandler);
        }
      };

      const timeoutHandle: ReturnType<typeof setTimeout> | null =
        timeoutMs > 0
          ? setTimeout(() => {
              const idx = queue.indexOf(waiter);
              if (idx !== -1) queue.splice(idx, 1);
              cleanup();
              reject(new Error(`ResourcePoolTimeout: ${input.kind} after ${timeoutMs}ms`));
            }, timeoutMs)
          : null;
      timeoutHandle?.unref?.();

      const abortHandler = input.signal
        ? (): void => {
            const idx = queue.indexOf(waiter);
            if (idx !== -1) queue.splice(idx, 1);
            cleanup();
            reject(new Error(`ResourcePoolAborted: ${input.kind} acquire aborted`));
          }
        : null;
      if (input.signal && abortHandler) {
        input.signal.addEventListener('abort', abortHandler, { once: true });
      }

      waiter = {
        kind: input.kind,
        subagentId: input.subagentId,
        priority,
        seq,
        resolve,
        reject,
        cleanup,
      };
      queue.push(waiter);
      drainQueue();
    });
  },

  tryAcquireSlot(input: AcquireSlotInput): PoolSlot | null {
    // Mirror of the acquireSlot fast-path — but never queues. When the pool
    // is at budget (or a waiter is already queued ahead of us) we return null
    // immediately so the caller can defer instead of blocking.
    if (canFit(input.kind) && queue.length === 0) {
      return grantSlot(input.kind, input.subagentId, input.priority ?? 'normal');
    }
    return null;
  },

  releaseSlot(slotId: string): void {
    if (!inflight.delete(slotId)) return;
    drainQueue();
  },

  getBudget(): PoolBudget {
    return {
      heavyTotal: DEFAULT_BUDGET.heavyTotal,
      perKind: { ...DEFAULT_BUDGET.perKind },
    };
  },

  getConcurrencyBudget(): ConcurrencyBudget {
    return { ...CONCURRENCY_BUDGET };
  },

  getInflight(): readonly PoolSlot[] {
    return Array.from(inflight.values());
  },

  queueDepth(kind: ResourceKind): number {
    let n = 0;
    for (const w of queue) if (w.kind === kind) n += 1;
    return n;
  },

  __reset(): void {
    for (const w of queue) {
      w.cleanup();
      try {
        w.reject(new Error('ResourcePoolReset: __reset() called'));
      } catch {
        /* ignore */
      }
    }
    queue.length = 0;
    inflight.clear();
    slotCounter = 0;
    seqCounter = 0;
  },
};
