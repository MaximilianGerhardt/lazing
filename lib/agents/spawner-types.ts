// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Maximilian Gerhardt
//
// lib/agents/spawner-types — Subagent-Pool public types for lazyos-stable.
//
// BACKPORT-02 (2026-05-23) — Ported verbatim from Lazing V2
// `packages/runtime/src/subagent/spawner-types.ts` (189 LOC). The only
// adaptation versus the V2 source is that `SubagentEngine` aliases the
// LOCAL `ResourceKind` from `./resource-pool` (a Wave-3-stub bundled into
// this module) rather than from `../system/resource-pool`. The full role
// taxonomy (12 roles) is preserved so future packs slot in cleanly.

import type { ResourceKind, SlotPriority } from './resource-pool';

export type SubagentRole =
  | 'architect'
  | 'coder'
  | 'tester'
  | 'reviewer'
  | 'security'
  | 'perf'
  | 'policy-checker'
  | 'curator'
  | 'judge'
  | 'researcher'
  | 'planner'
  | 'scribe';

export const SUBAGENT_ROLES: readonly SubagentRole[] = [
  'architect',
  'coder',
  'tester',
  'reviewer',
  'security',
  'perf',
  'policy-checker',
  'curator',
  'judge',
  'researcher',
  'planner',
  'scribe',
] as const;

export type SubagentPack = 'dev-core' | 'governance' | 'operator-self';

export const ROLE_PACK_MAP: Readonly<Record<SubagentRole, SubagentPack>> = {
  architect: 'dev-core',
  coder: 'dev-core',
  tester: 'dev-core',
  reviewer: 'dev-core',
  security: 'dev-core',
  perf: 'dev-core',
  'policy-checker': 'governance',
  curator: 'governance',
  judge: 'governance',
  researcher: 'operator-self',
  planner: 'operator-self',
  scribe: 'operator-self',
} as const;

/** Engine label used by the spawner — maps directly to ResourceKind. */
export type SubagentEngine = ResourceKind;

/**
 * A single event emitted by a spawned subagent lane. Mirrors V2
 * `SubagentLaneEvent` but tagged with the subagent identity so the
 * integrator (chat-card) can route events to the right pane without
 * re-deriving the source.
 */
export type SubagentLaneEvent =
  | {
      readonly kind: 'started';
      readonly subagentId: string;
      readonly role: SubagentRole;
      readonly worktreeBranch: string | null;
      readonly engine: SubagentEngine;
      readonly at: number;
    }
  | {
      readonly kind: 'text-delta';
      readonly subagentId: string;
      readonly role: SubagentRole;
      readonly worktreeBranch: string | null;
      readonly text: string;
      readonly at: number;
    }
  | {
      readonly kind: 'manifestation-marker';
      readonly subagentId: string;
      readonly role: SubagentRole;
      readonly worktreeBranch: string | null;
      readonly manifestKind: string;
      readonly payloadJson: string;
      readonly at: number;
    }
  | {
      readonly kind: 'end';
      readonly subagentId: string;
      readonly role: SubagentRole;
      readonly worktreeBranch: string | null;
      readonly durationMs?: number;
      readonly reason?: string;
      readonly at: number;
    }
  | {
      readonly kind: 'error';
      readonly subagentId: string;
      readonly role: SubagentRole;
      readonly worktreeBranch: string | null;
      readonly code: string;
      readonly message: string;
      readonly at: number;
    };

export interface SubagentIntent {
  /** Verbatim operator intent — N1 forbids paraphrase. */
  readonly intentText: string;
  /** Optional intent id for trace correlation. */
  readonly intentId?: string;
}

export interface SubagentUpstreamArtifact {
  readonly fromSubagentId: string;
  readonly fromRole: SubagentRole;
  /** Free-form label: 'plan', 'diff', 'critique', etc. */
  readonly label: string;
  readonly content: string;
}

/**
 * SubagentHandoff — structured "why am I being spawned and what should I
 * produce" block that a plan-walker passes to every subagent. The
 * spawner prepends this verbatim (N1) to the per-role system prompt.
 */
export interface SubagentHandoff {
  /** 1-paragraph why-are-we-doing-this — verbatim from the operator/plan. */
  readonly mainPlanSummary: string;
  /** This subagent is step N of M (1-based, source-order). */
  readonly stepIndex: number;
  /** Total number of steps in the plan. */
  readonly totalSteps: number;
  /** Which role the spawned subagent fulfils (echo of SpawnSubagentInput.role). */
  readonly role: SubagentRole;
  /** Capability requirements that the engine MUST satisfy for this role. */
  readonly requiredCapabilities: readonly string[];
  /** Predecessor artifact contract — what's already on disk. */
  readonly dependencies: readonly {
    readonly stepIndex: number;
    readonly artifact: string;
  }[];
  /** What THIS step is expected to produce — verbatim from the plan. */
  readonly expectedArtifacts: readonly string[];
}

/**
 * The subset of tool names that indicate a write-mode spawn.
 * Mirrors the SAFE_TOOLS set in server/agents/tmux-spawn.ts.
 * A spawn is "write-mode" when allowedTools contains at least one
 * of these — it will receive an isolated git worktree instead of
 * running in the live repo or a bare temp path.
 */
export const WRITE_MODE_TOOLS = new Set(['Write', 'Edit', 'Bash'] as const);

export interface SpawnSubagentInput {
  readonly role: SubagentRole;
  readonly intent: SubagentIntent;
  readonly parentWorkstreamId: string;
  /**
   * Absolute path of the worktree the engine should run in.
   *
   * For text-only spawns (no Write/Edit/Bash in allowedTools) this is passed
   * through verbatim — the spawner does NOT create a worktree.
   *
   * For write-mode spawns the spawner REPLACES this with an isolated git
   * worktree path derived from `createRunWorktree` (M-WORK-01). The caller's
   * value is used only as a fallback when the spawner config carries no
   * worktreeConfig (test or legacy path).
   */
  readonly worktreePath: string;
  /** Which heavy engine to consume a slot for. */
  readonly engine: SubagentEngine;
  /** Optional diff context to inline into the prompt. */
  readonly contextDiff?: string;
  /** Outputs of earlier subagents in the same swarm. */
  readonly upstreamArtifacts?: readonly SubagentUpstreamArtifact[];
  /** Override the role-skill allow-list. */
  readonly skillsAllowed?: readonly string[];
  /** Caller's abort signal. */
  readonly signal?: AbortSignal;
  /** Priority forwarded into the resource-pool. */
  readonly priority?: SlotPriority;
  /** Structured handoff prepended to the system prompt. */
  readonly handoff?: SubagentHandoff;
  /**
   * Tool names forwarded to the engine adapter (e.g. "Write", "Edit", "Bash").
   * When this set intersects WRITE_MODE_TOOLS the spawn is "write-mode":
   * the spawner creates an isolated git worktree via createRunWorktree and
   * passes the isolated path as workspacePath to the adapter factory.
   * The merge-into-main-tree path remains GATED (user-only, Phase 2 R3).
   * undefined → text-only spawn; no FS side-effects, no worktree created.
   */
  readonly allowedTools?: readonly string[];
}
