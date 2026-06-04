// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Maximilian Gerhardt
//
// lib/voice/session-fsm.ts — Voice Session State Machine (Batch 7c)
//
// N6 (Deterministic validators precede symbolic reasoning):
//   This module is PURE. No I/O, no async, no side effects.
//   Same input → same output, always. Testable without network.
//
// Allowed transitions (enforced — all others route to error-sink):
//
//   idle        → connecting    (startSession called)
//   connecting  → active        (adapter negotiated OK)
//   connecting  → error         (negotiation failed / key missing / abort)
//   active      → closing       (stopSession called, or remote-close)
//   active      → error         (transport-error mid-session)
//   closing     → closed        (adapter confirmed session end)
//   error       → idle          (reset — explicit operator action)
//   closed      → idle          (reset — explicit operator action)
//
// Invalid transitions: produce a FsmTransitionResult with `ok: false` and
// a `reason` string. They NEVER throw — the caller routes to an error-sink
// event. This is by design: an invalid transition in a streaming context must
// not unwind the call stack and drop buffered events.

import type { VoiceSessionState } from './types';

// ─── Public types ─────────────────────────────────────────────────────────────

export type FsmAction =
  | 'START'    // caller wants to begin a session
  | 'CONNECTED' // adapter negotiated OK
  | 'STOP'     // caller wants to end the session
  | 'REMOTE_CLOSE' // remote side closed the session
  | 'ERROR'    // transport or negotiation error
  | 'CLOSE_ACK' // adapter confirmed session end
  | 'RESET';   // explicit operator reset from error/closed

export interface FsmTransitionResult {
  readonly ok: boolean;
  /** The new state. Equals the input state when `ok === false`. */
  readonly next: VoiceSessionState;
  /**
   * Human-readable reason for a rejected transition. N8-tauglich.
   * Only present when `ok === false`.
   */
  readonly reason?: string;
}

/**
 * Immutable snapshot of the FSM.
 * All fields readonly — create fresh instances via `createFsm()` / `transition()`.
 */
export interface VoiceSessionFsm {
  readonly state: VoiceSessionState;
  /** ISO-8601 timestamp of the last successful transition. For N8 audit rows. */
  readonly lastTransitionAt: number;
  /** Number of transitions applied (including failed ones that stayed in-state). */
  readonly transitionCount: number;
}

// ─── Allowed transition table ─────────────────────────────────────────────────

/** (fromState, action) → toState. Only valid transitions listed. */
const TRANSITIONS: ReadonlyMap<VoiceSessionState, Readonly<Partial<Record<FsmAction, VoiceSessionState>>>> =
  new Map([
    ['idle', { START: 'connecting' } as const],
    ['connecting', { CONNECTED: 'active', ERROR: 'error', STOP: 'error' } as const],
    ['active', { STOP: 'closing', REMOTE_CLOSE: 'closing', ERROR: 'error' } as const],
    ['closing', { CLOSE_ACK: 'closed', ERROR: 'error' } as const],
    ['error', { RESET: 'idle' } as const],
    ['closed', { RESET: 'idle' } as const],
  ]);

// ─── Factory ──────────────────────────────────────────────────────────────────

/** Create a new FSM in the initial `idle` state. */
export function createFsm(): VoiceSessionFsm {
  return {
    state: 'idle',
    lastTransitionAt: Date.now(),
    transitionCount: 0,
  };
}

// ─── Pure transition function ─────────────────────────────────────────────────

/**
 * Apply `action` to `fsm` and return the transition result.
 *
 * PURE — never mutates `fsm`. Returns a new `VoiceSessionFsm` on success
 * (embedded in `next`), or the original `fsm` when the transition is invalid.
 *
 * Callers MUST check `result.ok` and route `!ok` to an error-sink VoiceEvent.
 * They MUST NOT throw or crash on `!ok` — the invariant is fail-open for the
 * caller, fail-closed for the state (state does not change on invalid input).
 *
 * @param fsm    - Current FSM snapshot (immutable).
 * @param action - The action to apply.
 * @param now    - Wall-clock ms (injectable for tests; defaults to Date.now()).
 * @returns FsmTransitionResult + updated `fsm` (on `ok=true`) or original (on `ok=false`).
 */
export function transition(
  fsm: VoiceSessionFsm,
  action: FsmAction,
  now: number = Date.now(),
): { result: FsmTransitionResult; fsm: VoiceSessionFsm } {
  const allowed = TRANSITIONS.get(fsm.state);
  const toState = allowed?.[action];

  if (toState === undefined) {
    const reason =
      `FSM: invalid transition ${fsm.state} --[${action}]--> (no target). ` +
      `Allowed actions from '${fsm.state}': [${Object.keys(allowed ?? {}).join(', ') || 'none'}].`;
    return {
      result: { ok: false, next: fsm.state, reason },
      fsm,
    };
  }

  const nextFsm: VoiceSessionFsm = {
    state: toState,
    lastTransitionAt: now,
    transitionCount: fsm.transitionCount + 1,
  };

  return {
    result: { ok: true, next: toState },
    fsm: nextFsm,
  };
}

// ─── Convenience helpers (pure) ───────────────────────────────────────────────

/** Returns true if the FSM is in a terminal state (closed or error). */
export function isTerminal(fsm: VoiceSessionFsm): boolean {
  return fsm.state === 'closed' || fsm.state === 'error';
}

/** Returns true if a session is currently live and accepting audio. */
export function isActive(fsm: VoiceSessionFsm): boolean {
  return fsm.state === 'active';
}

/** Returns true if a session is transitioning (connecting or closing). */
export function isTransitioning(fsm: VoiceSessionFsm): boolean {
  return fsm.state === 'connecting' || fsm.state === 'closing';
}

/**
 * List all valid actions from the current state.
 * Useful for UI guards (mic button enabled/disabled).
 */
export function validActions(fsm: VoiceSessionFsm): FsmAction[] {
  const allowed = TRANSITIONS.get(fsm.state);
  if (!allowed) return [];
  return Object.keys(allowed) as FsmAction[];
}
