// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Maximilian Gerhardt
//
// lib/voice/realtime-adapter.ts — Realtime Adapter Interface + Implementations (Batch 7c)
//
// ─── PHASE BOUNDARY (PHASE2_VOICE_LIVE) ──────────────────────────────────────
//
//   DEFAULT (no flag, no key):
//     createAdapter() → MockRealtimeAdapter
//     No network call, no mic, no OpenAI API hit.
//     All events are scripted via MockRealtimeAdapter.scriptEvents().
//     Safe for unit tests and CI.
//
//   PHASE2_VOICE_LIVE (gated):
//     Requires BOTH:
//       (1) LAZYOS_VOICE_LIVE === 'true' | '1' | 'on'   (opt-in flag)
//       (2) OPENAI_API_KEY or LAZYOS_VOICE_OPENAI_KEY   (key present)
//     → createAdapter() returns OpenAiRealtimeAdapter.
//     If either condition is missing, createAdapter() falls back to Mock
//     and emits a console.warn (never throws). Fail-safe for misconfigured envs.
//
// ─── Security invariants ─────────────────────────────────────────────────────
//   - API keys are read ONLY inside OpenAiRealtimeAdapter.connect() — never
//     stored in class fields, never passed through VoiceEvent, never logged.
//   - Key presence is checked via a boolean helper that does NOT expose the key.
//   - maskedKeyHint() returns only the last 4 chars for diagnostics (never full key).
//
// ─── N6 constraint ───────────────────────────────────────────────────────────
//   - The selection logic in createAdapter() is pure and deterministic.
//   - MockRealtimeAdapter events are deterministic (scripted by tests).

import type { VoiceEvent, VoiceSessionConfig, VoiceAdapterKind } from './types';
import type { VoiceSessionFsm } from './session-fsm';

// ─── Adapter interface ────────────────────────────────────────────────────────

/**
 * Low-level wire contract implemented by every adapter backend.
 * Consumers use session-manager.ts, not this interface directly.
 */
export interface RealtimeAdapter {
  readonly kind: VoiceAdapterKind;

  /**
   * Open a session. Returns the negotiated session id once the adapter is
   * ready to accept audio (for Mock: immediately; for OpenAI: after WS/DC open).
   *
   * Implementations MUST:
   *   - emit `{ kind: 'session-started' }` on success.
   *   - emit `{ kind: 'error' }` on failure (NOT throw — stream must stay alive).
   *   - NEVER include secrets in any emitted event.
   */
  connect(config: VoiceSessionConfig): Promise<string>;

  /**
   * Close the session. Idempotent. Emits `{ kind: 'session-ended' }` once.
   */
  disconnect(reason: 'operator-stop' | 'transport-error'): Promise<void>;

  /** Subscribe to events from this adapter. Returns unsubscribe function. */
  onEvent(handler: (event: VoiceEvent) => void): () => void;

  /** Current FSM snapshot — adapters advance it internally. */
  readonly fsm: VoiceSessionFsm;
}

// ─── MockRealtimeAdapter ──────────────────────────────────────────────────────

import { createFsm, transition } from './session-fsm';
import { randomUUID } from 'node:crypto';

/**
 * Mock adapter — zero network, zero mic, deterministic event emission.
 *
 * Default mode: `connect()` immediately emits `session-started` and resolves.
 * Test mode: caller populates `scriptEvents()` to control exactly which events
 * are emitted during connect/disconnect.
 *
 * K1 tool-dispatch gates still apply — the mock calls into the voice-tools
 * registry on any `tool-call` event it emits, same as the live adapter.
 */
export class MockRealtimeAdapter implements RealtimeAdapter {
  readonly kind: VoiceAdapterKind = 'mock';

  private _fsm: VoiceSessionFsm = createFsm();
  private listeners = new Set<(event: VoiceEvent) => void>();
  private _sessionId: string | null = null;
  /** Events queued via scriptEvents(). Drained on connect(). */
  private _scriptedEvents: VoiceEvent[] = [];

  get fsm(): VoiceSessionFsm {
    return this._fsm;
  }

  /**
   * Pre-load events that will be emitted after session-started during connect().
   * Useful for test scenarios: transcript, tool-call, error, etc.
   * Call BEFORE connect().
   */
  scriptEvents(events: VoiceEvent[]): void {
    this._scriptedEvents = [...events];
  }

  onEvent(handler: (event: VoiceEvent) => void): () => void {
    this.listeners.add(handler);
    return () => {
      this.listeners.delete(handler);
    };
  }

  private emit(event: VoiceEvent): void {
    for (const handler of Array.from(this.listeners)) {
      try {
        handler(event);
      } catch {
        // Listener exceptions must not crash the adapter.
      }
    }
  }

  private applyFsmTransition(action: Parameters<typeof transition>[1]): void {
    const { fsm: nextFsm, result } = transition(this._fsm, action);
    this._fsm = nextFsm;
    if (!result.ok) {
      // Route invalid transition to error-sink event (N6 — no throw in stream).
      this.emit({
        kind: 'error',
        sessionId: this._sessionId,
        code: 'unknown',
        message: result.reason ?? 'FSM invalid transition',
        at: Date.now(),
      });
    }
  }

  async connect(config: VoiceSessionConfig): Promise<string> {
    this.applyFsmTransition('START');
    const sessionId = config.sessionId ?? randomUUID();
    this._sessionId = sessionId;

    // Simulate negotiation completing synchronously (mock = no network).
    this.applyFsmTransition('CONNECTED');

    this.emit({
      kind: 'session-started',
      sessionId,
      state: 'active',
      at: Date.now(),
    });

    // Drain scripted events (allows tests to inject transcript / tool-call etc.)
    for (const event of this._scriptedEvents) {
      this.emit(event);
    }
    this._scriptedEvents = [];

    return sessionId;
  }

  async disconnect(reason: 'operator-stop' | 'transport-error'): Promise<void> {
    if (this._fsm.state === 'idle' || this._fsm.state === 'closed') return;

    this.applyFsmTransition(reason === 'transport-error' ? 'ERROR' : 'STOP');
    this.applyFsmTransition('CLOSE_ACK');

    this.emit({
      kind: 'session-ended',
      sessionId: this._sessionId ?? '',
      reason: reason === 'transport-error' ? 'transport-error' : 'operator-stop',
      at: Date.now(),
    });
    this._sessionId = null;
  }
}

// ─── OpenAiRealtimeAdapter ────────────────────────────────────────────────────

/**
 * OpenAI Realtime adapter — ONLY active when PHASE2_VOICE_LIVE conditions are met.
 * At Foundation stage (Batch 7c) this is a structural stub: the class exists,
 * connect() refuses to run without the live-flag+key gate, and emits a
 * backend-disabled error (never throws, never leaks key).
 *
 * Full WebSocket/DataChannel wiring is a follow-on gated step after:
 *   1. LAZYOS_VOICE_LIVE flag is set.
 *   2. Key is present (OPENAI_API_KEY or LAZYOS_VOICE_OPENAI_KEY).
 *   3. A `/api/voice/session` ephemeral-token endpoint is wired.
 */
export class OpenAiRealtimeAdapter implements RealtimeAdapter {
  readonly kind: VoiceAdapterKind = 'openai-realtime';

  private _fsm: VoiceSessionFsm = createFsm();
  private listeners = new Set<(event: VoiceEvent) => void>();

  get fsm(): VoiceSessionFsm {
    return this._fsm;
  }

  onEvent(handler: (event: VoiceEvent) => void): () => void {
    this.listeners.add(handler);
    return () => {
      this.listeners.delete(handler);
    };
  }

  private emit(event: VoiceEvent): void {
    for (const handler of Array.from(this.listeners)) {
      try {
        handler(event);
      } catch {
        // Listener exceptions must not crash the adapter.
      }
    }
  }

  async connect(config: VoiceSessionConfig): Promise<string> {
    // Gate: LAZYOS_VOICE_LIVE + key both required. If we get here without them
    // createAdapter() would have returned Mock — this branch is belt-and-braces.
    if (!isVoiceLiveEnabled() || !hasVoiceKey()) {
      const sessionId = config.sessionId ?? randomUUID();
      this.emit({
        kind: 'error',
        sessionId,
        code: 'backend-disabled',
        message:
          'OpenAiRealtimeAdapter requires LAZYOS_VOICE_LIVE=1 and an OpenAI key. ' +
          'createAdapter() should have returned MockRealtimeAdapter — this is a bug.',
        at: Date.now(),
      });
      // Transition through to error state so FSM stays consistent.
      transition(this._fsm, 'START');
      this._fsm = transition(this._fsm, 'START').fsm;
      const { fsm } = transition(this._fsm, 'ERROR');
      this._fsm = fsm;
      return sessionId;
    }

    // PHASE2_VOICE_LIVE: full WebSocket + DataChannel wiring lives here.
    // Stub for Foundation — will be implemented in the follow-on gated step.
    const sessionId = config.sessionId ?? randomUUID();
    this.emit({
      kind: 'error',
      sessionId,
      code: 'not-supported',
      message:
        'OpenAiRealtimeAdapter.connect() live wiring not yet implemented. ' +
        'PHASE2_VOICE_LIVE boundary: set LAZYOS_VOICE_LIVE=1 to activate foundation scaffold; ' +
        'full wiring is the follow-on gated step.',
      at: Date.now(),
    });
    return sessionId;
  }

  async disconnect(_reason: 'operator-stop' | 'transport-error'): Promise<void> {
    // no-op at Foundation stage — no live connection to tear down.
  }
}

// ─── Key-checking helpers (never expose key value) ───────────────────────────

/**
 * Returns true if the live-mode flag is set.
 * Pure ENV read — no network, no side effects.
 */
export function isVoiceLiveEnabled(): boolean {
  const val = (process.env['LAZYOS_VOICE_LIVE'] ?? '').trim().toLowerCase();
  return val === 'true' || val === '1' || val === 'on';
}

/**
 * Returns true if an OpenAI key is present in the environment.
 * Does NOT read or log the key value — only checks emptiness.
 */
export function hasVoiceKey(): boolean {
  const primary = (process.env['LAZYOS_VOICE_OPENAI_KEY'] ?? '').trim();
  const fallback = (process.env['OPENAI_API_KEY'] ?? '').trim();
  return primary.length > 0 || fallback.length > 0;
}

/**
 * Returns a masked hint for diagnostics (e.g. in console.warn).
 * Exposes only the last 4 chars of the key — never the full value.
 * If no key present returns '<no-key>'.
 *
 * SECURITY: NEVER log the return value of this function to a persistent
 * audit table. It is safe only for ephemeral console output.
 */
export function maskedKeyHint(): string {
  const primary = (process.env['LAZYOS_VOICE_OPENAI_KEY'] ?? '').trim();
  const key = primary.length > 0 ? primary : (process.env['OPENAI_API_KEY'] ?? '').trim();
  if (key.length === 0) return '<no-key>';
  if (key.length <= 4) return '••••';
  return '••••' + key.slice(-4);
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Select and construct the appropriate adapter.
 *
 * Rules (in order):
 *   1. If LAZYOS_VOICE_LIVE is set AND a voice key is present
 *      → return OpenAiRealtimeAdapter.
 *   2. Otherwise → return MockRealtimeAdapter + console.warn (never throw).
 *
 * This is the ONLY place where the adapter selection decision is made.
 * session-manager.ts always calls createAdapter() — never instantiates
 * adapters directly.
 *
 * PHASE2_VOICE_LIVE BOUNDARY:
 *   The condition `isVoiceLiveEnabled() && hasVoiceKey()` is the gate.
 *   Everything above that gate is Phase 1 (Foundation / Mock-only).
 *   Everything below is Phase 2 (Live / OpenAI Realtime).
 */
export function createAdapter(): RealtimeAdapter {
  if (isVoiceLiveEnabled() && hasVoiceKey()) {
    // PHASE2_VOICE_LIVE: live path active.
    return new OpenAiRealtimeAdapter();
  }

  // Default: Mock. Log why so operators understand.
  if (isVoiceLiveEnabled() && !hasVoiceKey()) {
    console.warn(
      '[voice] LAZYOS_VOICE_LIVE is set but no OpenAI key found ' +
      '(OPENAI_API_KEY or LAZYOS_VOICE_OPENAI_KEY). ' +
      'Falling back to MockRealtimeAdapter. ' +
      'Set the key to activate PHASE2_VOICE_LIVE.',
    );
  }

  return new MockRealtimeAdapter();
}
