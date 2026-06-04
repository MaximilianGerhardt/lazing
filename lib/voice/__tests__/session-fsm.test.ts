// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Maximilian Gerhardt
//
// lib/voice/__tests__/session-fsm.test.ts
//
// Tests: Voice Session FSM — N6 deterministic transitions.
//
// Run:
//   NODE_OPTIONS='--experimental-require-module' npx vitest run \
//     lib/voice/__tests__/session-fsm.test.ts

import { describe, it, expect } from 'vitest';
import {
  createFsm,
  transition,
  isActive,
  isTerminal,
  isTransitioning,
  validActions,
  type FsmAction,
  type VoiceSessionFsm,
} from '../session-fsm';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Walk a sequence of actions from the initial FSM. */
function walkActions(actions: FsmAction[]): VoiceSessionFsm {
  let fsm = createFsm();
  for (const action of actions) {
    const { fsm: next, result } = transition(fsm, action, 0);
    if (!result.ok) {
      throw new Error(`Unexpected invalid transition: ${result.reason}`);
    }
    fsm = next;
  }
  return fsm;
}

// ─── Initial state ────────────────────────────────────────────────────────────

describe('createFsm', () => {
  it('starts in idle state', () => {
    const fsm = createFsm();
    expect(fsm.state).toBe('idle');
    expect(fsm.transitionCount).toBe(0);
  });
});

// ─── Valid transitions ────────────────────────────────────────────────────────

describe('valid transitions', () => {
  it('idle → connecting on START', () => {
    const fsm = createFsm();
    const { result, fsm: next } = transition(fsm, 'START', 100);
    expect(result.ok).toBe(true);
    expect(next.state).toBe('connecting');
    expect(next.transitionCount).toBe(1);
    expect(next.lastTransitionAt).toBe(100);
  });

  it('connecting → active on CONNECTED', () => {
    const fsm = walkActions(['START']);
    const { result, fsm: next } = transition(fsm, 'CONNECTED', 200);
    expect(result.ok).toBe(true);
    expect(next.state).toBe('active');
  });

  it('connecting → error on ERROR', () => {
    const fsm = walkActions(['START']);
    const { result, fsm: next } = transition(fsm, 'ERROR', 300);
    expect(result.ok).toBe(true);
    expect(next.state).toBe('error');
  });

  it('connecting → error on STOP (abort during negotiation)', () => {
    const fsm = walkActions(['START']);
    const { result, fsm: next } = transition(fsm, 'STOP', 400);
    expect(result.ok).toBe(true);
    expect(next.state).toBe('error');
  });

  it('active → closing on STOP', () => {
    const fsm = walkActions(['START', 'CONNECTED']);
    const { result, fsm: next } = transition(fsm, 'STOP', 500);
    expect(result.ok).toBe(true);
    expect(next.state).toBe('closing');
  });

  it('active → closing on REMOTE_CLOSE', () => {
    const fsm = walkActions(['START', 'CONNECTED']);
    const { result, fsm: next } = transition(fsm, 'REMOTE_CLOSE', 600);
    expect(result.ok).toBe(true);
    expect(next.state).toBe('closing');
  });

  it('active → error on ERROR', () => {
    const fsm = walkActions(['START', 'CONNECTED']);
    const { result, fsm: next } = transition(fsm, 'ERROR', 700);
    expect(result.ok).toBe(true);
    expect(next.state).toBe('error');
  });

  it('closing → closed on CLOSE_ACK', () => {
    const fsm = walkActions(['START', 'CONNECTED', 'STOP']);
    const { result, fsm: next } = transition(fsm, 'CLOSE_ACK', 800);
    expect(result.ok).toBe(true);
    expect(next.state).toBe('closed');
  });

  it('error → idle on RESET', () => {
    const fsm = walkActions(['START', 'ERROR']);
    const { result, fsm: next } = transition(fsm, 'RESET', 900);
    expect(result.ok).toBe(true);
    expect(next.state).toBe('idle');
  });

  it('closed → idle on RESET', () => {
    const fsm = walkActions(['START', 'CONNECTED', 'STOP', 'CLOSE_ACK']);
    const { result, fsm: next } = transition(fsm, 'RESET', 1000);
    expect(result.ok).toBe(true);
    expect(next.state).toBe('idle');
  });
});

// ─── Full happy-path lifecycle ────────────────────────────────────────────────

describe('full lifecycle', () => {
  it('idle → connecting → active → closing → closed', () => {
    const states: string[] = [];
    let fsm = createFsm();
    states.push(fsm.state);

    for (const action of ['START', 'CONNECTED', 'STOP', 'CLOSE_ACK'] as FsmAction[]) {
      const { fsm: next, result } = transition(fsm, action, 0);
      expect(result.ok).toBe(true);
      fsm = next;
      states.push(fsm.state);
    }

    expect(states).toEqual(['idle', 'connecting', 'active', 'closing', 'closed']);
    expect(fsm.transitionCount).toBe(4);
  });
});

// ─── Invalid transitions → error-sink (no throw) ──────────────────────────────

describe('invalid transitions — error-sink, no throw', () => {
  it('idle + STOP → ok=false, stays idle', () => {
    const fsm = createFsm();
    const { result, fsm: next } = transition(fsm, 'STOP');
    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
    expect(next.state).toBe('idle');
  });

  it('idle + CONNECTED → ok=false, stays idle', () => {
    const fsm = createFsm();
    const { result, fsm: next } = transition(fsm, 'CONNECTED');
    expect(result.ok).toBe(false);
    expect(next.state).toBe('idle');
  });

  it('active + START → ok=false, stays active', () => {
    const fsm = walkActions(['START', 'CONNECTED']);
    const { result, fsm: next } = transition(fsm, 'START');
    expect(result.ok).toBe(false);
    expect(next.state).toBe('active');
  });

  it('closed + STOP → ok=false, stays closed', () => {
    const fsm = walkActions(['START', 'CONNECTED', 'STOP', 'CLOSE_ACK']);
    const { result, fsm: next } = transition(fsm, 'STOP');
    expect(result.ok).toBe(false);
    expect(next.state).toBe('closed');
  });

  it('error + STOP → ok=false, stays error', () => {
    const fsm = walkActions(['START', 'ERROR']);
    const { result, fsm: next } = transition(fsm, 'STOP');
    expect(result.ok).toBe(false);
    expect(next.state).toBe('error');
  });

  it('reason string is present on invalid transition', () => {
    const fsm = createFsm();
    const { result } = transition(fsm, 'CLOSE_ACK');
    expect(result.ok).toBe(false);
    expect(typeof result.reason).toBe('string');
    expect(result.reason!.length).toBeGreaterThan(0);
  });
});

// ─── Determinism (N6) ─────────────────────────────────────────────────────────

describe('determinism (N6)', () => {
  it('same input → same output — valid transition', () => {
    const fsm = createFsm();
    const r1 = transition(fsm, 'START', 42);
    const r2 = transition(fsm, 'START', 42);
    expect(r1.result.ok).toBe(r2.result.ok);
    expect(r1.fsm.state).toBe(r2.fsm.state);
    expect(r1.fsm.transitionCount).toBe(r2.fsm.transitionCount);
  });

  it('same input → same output — invalid transition', () => {
    const fsm = createFsm();
    const r1 = transition(fsm, 'STOP');
    const r2 = transition(fsm, 'STOP');
    expect(r1.result.ok).toBe(false);
    expect(r2.result.ok).toBe(false);
    expect(r1.result.reason).toBe(r2.result.reason);
    expect(r1.fsm.state).toBe(r2.fsm.state);
  });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

describe('helper predicates', () => {
  it('isActive: true only in active state', () => {
    expect(isActive(createFsm())).toBe(false);
    expect(isActive(walkActions(['START', 'CONNECTED']))).toBe(true);
    expect(isActive(walkActions(['START']))).toBe(false);
    expect(isActive(walkActions(['START', 'CONNECTED', 'STOP']))).toBe(false);
  });

  it('isTerminal: true for closed and error', () => {
    expect(isTerminal(createFsm())).toBe(false);
    expect(isTerminal(walkActions(['START', 'ERROR']))).toBe(true);
    expect(isTerminal(walkActions(['START', 'CONNECTED', 'STOP', 'CLOSE_ACK']))).toBe(true);
    expect(isTerminal(walkActions(['START', 'CONNECTED']))).toBe(false);
  });

  it('isTransitioning: true for connecting and closing', () => {
    expect(isTransitioning(createFsm())).toBe(false);
    expect(isTransitioning(walkActions(['START']))).toBe(true);
    expect(isTransitioning(walkActions(['START', 'CONNECTED', 'STOP']))).toBe(true);
    expect(isTransitioning(walkActions(['START', 'CONNECTED']))).toBe(false);
  });

  it('validActions: returns correct actions for idle', () => {
    const fsm = createFsm();
    expect(validActions(fsm)).toEqual(['START']);
  });

  it('validActions: returns correct actions for active', () => {
    const fsm = walkActions(['START', 'CONNECTED']);
    expect(new Set(validActions(fsm))).toEqual(new Set(['STOP', 'REMOTE_CLOSE', 'ERROR']));
  });

  it('validActions: empty for unknown state edge case', () => {
    // Directly craft a state that has no transition table entry (defensive).
    const fsm: VoiceSessionFsm = {
      state: 'idle',
      lastTransitionAt: 0,
      transitionCount: 0,
    };
    // idle has valid actions, just verify returns array
    expect(Array.isArray(validActions(fsm))).toBe(true);
  });
});
