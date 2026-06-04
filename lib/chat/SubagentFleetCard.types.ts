// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Maximilian Gerhardt
//
// lib/chat/SubagentFleetCard.types — pane + event types for the fleet
// chat-card surface (BACKPORT-02, 2026-05-23).
//
// Mirrors V2 `packages/manifestation/src/surfaces/SubagentFleet/types.ts`
// with three deltas:
//   - identifier renamed to `subagentId` (lazyos uses subagentId; V2 used
//     subdispatchId — the underlying primary key)
//   - role taxonomy extends generic with 'security' + 'perf' so the
//     6-role lazyos roster slots in cleanly
//   - `ManifestCoord` is dropped (the chat-card lives inside an existing
//     chat-thread coordinate; no N9 envelope at this layer)

export type SubagentPaneRole =
  | 'architect'
  | 'coder'
  | 'tester'
  | 'reviewer'
  | 'security'
  | 'perf'
  | 'generic';

export type SubagentPaneStatus =
  | 'queued'
  | 'running'
  | 'done'
  | 'failed'
  | 'aborted';

export interface SubagentPane {
  /** Stable id — matches the spawner's subagentId. */
  readonly subagentId: string;
  /** Role taxonomy — drives the glyph. */
  readonly role: SubagentPaneRole;
  /** Step / intent title (verbatim N1 — never paraphrased). */
  readonly title: string;
  /** Current lifecycle state. */
  readonly status: SubagentPaneStatus;
  /** Ticks up live as tokens stream — pure count, never the tokens themselves. */
  readonly tokensStreamed?: number;
  /** File paths touched by this lane (deduped at reducer level). */
  readonly filesTouched?: readonly string[];
  /** Last log line for the pane header — TRUNCATED TO 12 CHARS. INV-13 safety belt. */
  readonly tailLine?: string;
  /** ms-epoch when the lane started. */
  readonly startedAt?: number;
  /** ms-epoch when the lane resolved. */
  readonly endedAt?: number;
  /** When status === 'failed', the engine-side error message. */
  readonly errorMessage?: string;
}

export type SubagentFleetResolutionEvent =
  | { readonly kind: 'expand-pane'; readonly subagentId: string }
  | { readonly kind: 'abort-pane'; readonly subagentId: string }
  | { readonly kind: 'abort-fleet' }
  | { readonly kind: 'open-diff'; readonly subagentId: string }
  | { readonly kind: 'dismiss' };

/** N11 — hard cap on parallel heavy lanes, enforced in the renderer. */
export const SUBAGENT_FLEET_MAX_PANES = 5 as const;

/** INV-13 safety belt — the renderer + reducer both enforce this. */
export const SUBAGENT_FLEET_TAIL_MAX_CHARS = 12 as const;

// ── Reducer (LaneEvent → SubagentPane[]) ──────────────────────────────────

import type { SubagentLaneEvent } from '@/lib/agents';

function truncateTail(raw: string): string {
  const flat = raw.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ');
  if (flat.length <= SUBAGENT_FLEET_TAIL_MAX_CHARS) return flat;
  return flat.slice(flat.length - SUBAGENT_FLEET_TAIL_MAX_CHARS);
}

function roleForLane(role: string): SubagentPaneRole {
  switch (role) {
    case 'architect':
    case 'coder':
    case 'tester':
    case 'reviewer':
    case 'security':
    case 'perf':
      return role;
    default:
      return 'generic';
  }
}

/**
 * Apply one SubagentLaneEvent (from the spawner) to the prior pane list.
 * Returns a new array (reducer purity).
 */
export function reduceSubagentFleet(
  prior: readonly SubagentPane[],
  evt: SubagentLaneEvent,
  options: { readonly title?: string; readonly nowMs?: number } = {},
): readonly SubagentPane[] {
  switch (evt.kind) {
    case 'started': {
      if (prior.some((p) => p.subagentId === evt.subagentId)) return prior;
      const next: SubagentPane = {
        subagentId: evt.subagentId,
        role: roleForLane(evt.role),
        title: options.title ?? evt.role,
        status: 'running',
        tokensStreamed: 0,
        startedAt: evt.at,
      };
      return [...prior, next];
    }
    case 'text-delta': {
      return prior.map((p) =>
        p.subagentId === evt.subagentId
          ? {
              ...p,
              status: p.status === 'queued' ? 'running' : p.status,
              tokensStreamed: (p.tokensStreamed ?? 0) + 1,
              tailLine: truncateTail(evt.text),
            }
          : p,
      );
    }
    case 'manifestation-marker': {
      // Surfaces produced by the lane increment the file-touched count.
      return prior.map((p) => {
        if (p.subagentId !== evt.subagentId) return p;
        let path = `(${evt.manifestKind})`;
        try {
          const obj = JSON.parse(evt.payloadJson) as { path?: unknown };
          if (typeof obj.path === 'string' && obj.path.length > 0) path = obj.path;
        } catch {
          /* keep fallback */
        }
        const existing = p.filesTouched ?? [];
        if (existing.includes(path)) return p;
        return { ...p, filesTouched: [...existing, path] };
      });
    }
    case 'end': {
      return prior.map((p) =>
        p.subagentId === evt.subagentId
          ? { ...p, status: 'done', endedAt: options.nowMs ?? evt.at }
          : p,
      );
    }
    case 'error': {
      return prior.map((p) =>
        p.subagentId === evt.subagentId
          ? {
              ...p,
              status: 'failed',
              errorMessage: evt.message,
              endedAt: options.nowMs ?? evt.at,
            }
          : p,
      );
    }
    default:
      return prior;
  }
}
