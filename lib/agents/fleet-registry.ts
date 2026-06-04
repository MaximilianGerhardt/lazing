// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Maximilian Gerhardt
//
// lib/agents/fleet-registry — process-scoped in-memory store of live
// subagent panes per parent workstream / fleet id (BACKPORT-02).
//
// Why this exists: lazyos-stable does not yet expose the V2 lane-event
// SSE bus; the API endpoints in app/api/agents/{spawn,status} drive the
// fleet locally so the smoke-test + the chat-card UI can render fleets
// before the SSE wiring lands. When the SSE bus lands in Wave-2 the
// registry becomes the materialised view backing the GET /status
// endpoint.
//
// Storage shape: per-fleet-id → SubagentPane[] (deduped by subagentId).
// `ingest(evt)` mutates the in-place array and notifies any listeners.

import { reduceSubagentFleet, type SubagentPane } from '@/lib/chat/SubagentFleetCard.types';

import type { SubagentLaneEvent, SubagentRole } from './spawner-types';

interface FleetEntry {
  readonly fleetId: string;
  panes: readonly SubagentPane[];
  /** Map subagentId → role for the smoke-test title rendering. */
  readonly roles: Map<string, SubagentRole>;
  /** Original intent text (verbatim N1) for the fleet header. */
  intentText: string;
  /** Last-update ms-epoch. */
  updatedAt: number;
}

const fleets = new Map<string, FleetEntry>();

function ensureFleet(fleetId: string, intentText?: string): FleetEntry {
  let entry = fleets.get(fleetId);
  if (!entry) {
    entry = {
      fleetId,
      panes: [],
      roles: new Map(),
      intentText: intentText ?? '',
      updatedAt: Date.now(),
    };
    fleets.set(fleetId, entry);
  } else if (intentText && !entry.intentText) {
    entry.intentText = intentText;
  }
  return entry;
}

export function ingestLaneEvent(
  fleetId: string,
  evt: SubagentLaneEvent,
  options: { readonly intentText?: string; readonly title?: string } = {},
): void {
  const entry = ensureFleet(fleetId, options.intentText);
  if (evt.kind === 'started') {
    entry.roles.set(evt.subagentId, evt.role);
  }
  // Use the spawned role's name as the per-pane title when no explicit
  // title is supplied.
  const role = entry.roles.get(evt.subagentId) ?? 'generic';
  const title = options.title ?? `${role} — ${entry.intentText || 'subagent'}`;
  entry.panes = reduceSubagentFleet(entry.panes, evt, { title, nowMs: Date.now() });
  entry.updatedAt = Date.now();
}

export interface FleetStatusSnapshot {
  readonly fleetId: string;
  readonly intentText: string;
  readonly panes: ReadonlyArray<SubagentPane>;
  readonly updatedAt: number;
}

export function getFleet(fleetId: string): FleetStatusSnapshot | null {
  const entry = fleets.get(fleetId);
  if (!entry) return null;
  return {
    fleetId: entry.fleetId,
    intentText: entry.intentText,
    panes: entry.panes,
    updatedAt: entry.updatedAt,
  };
}

export function listFleets(): ReadonlyArray<FleetStatusSnapshot> {
  return Array.from(fleets.values()).map((e) => ({
    fleetId: e.fleetId,
    intentText: e.intentText,
    panes: e.panes,
    updatedAt: e.updatedAt,
  }));
}

/**
 * Find the fleetId whose pane-list contains the given subagentId.
 * Used by the abort route, which only receives a subagentId in the URL.
 * subagentIds are minted by the spawner as `sub-<role>-<8alnum>`, so they
 * are globally unique within a process.
 */
export function findFleetByPaneId(subagentId: string): string | null {
  for (const [fleetId, entry] of fleets) {
    if (entry.panes.some((p) => p.subagentId === subagentId)) return fleetId;
  }
  return null;
}

/**
 * Mark a single pane as `aborted` and stamp `endedAt` (CP-2, UX-Audit
 * 2026-05-28). Idempotent — calling abort on a pane that is already
 * `done`/`failed`/`aborted` is a no-op (preserves the prior terminal
 * state). Returns the resulting pane status so the caller can decide
 * the HTTP response code (200 = transitioned, 200 + `unchanged: true`
 * if already terminal, `null` if the pane / fleet was not found).
 */
export function abortPane(
  fleetId: string,
  subagentId: string,
): { status: 'aborted' | 'done' | 'failed' | 'unchanged'; previousStatus: string } | null {
  const entry = fleets.get(fleetId);
  if (!entry) return null;
  const pane = entry.panes.find((p) => p.subagentId === subagentId);
  if (!pane) return null;

  const previousStatus = pane.status;
  // Terminal states are not overwritten — abort is idempotent.
  if (pane.status === 'done' || pane.status === 'failed' || pane.status === 'aborted') {
    return { status: 'unchanged', previousStatus };
  }

  const now = Date.now();
  entry.panes = entry.panes.map((p) =>
    p.subagentId === subagentId
      ? { ...p, status: 'aborted' as const, endedAt: now }
      : p,
  );
  entry.updatedAt = now;
  return { status: 'aborted', previousStatus };
}

/** TEST-ONLY — wipe registry. */
export function __resetFleetRegistry(): void {
  fleets.clear();
}

/** TEST-ONLY — seed a pane (mirrors what a `started` event would do). */
export function __seedFleetPane(
  fleetId: string,
  pane: SubagentPane,
  intentText?: string,
): void {
  const entry = ensureFleet(fleetId, intentText);
  entry.roles.set(pane.subagentId, pane.role as SubagentRole);
  entry.panes = [...entry.panes.filter((p) => p.subagentId !== pane.subagentId), pane];
  entry.updatedAt = Date.now();
}
