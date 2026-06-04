// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Maximilian Gerhardt
//
// lib/voice/session-manager.ts — Voice Session Manager (Batch 7c)
//
// Public API for the voice layer. UI and API routes call these functions;
// they MUST NOT instantiate adapters directly.
//
// ─── PHASE BOUNDARY (PHASE2_VOICE_LIVE) ──────────────────────────────────────
//
//   startSession() calls createAdapter() which applies the gate:
//     - DEFAULT: no LAZYOS_VOICE_LIVE → MockRealtimeAdapter (no network).
//     - PHASE2_VOICE_LIVE: flag + key set → OpenAiRealtimeAdapter.
//
//   The session-manager itself has no knowledge of which adapter was selected —
//   all behaviour is polymorphic on the RealtimeAdapter interface.
//
// ─── Lifecycle ────────────────────────────────────────────────────────────────
//
//   1. registerBuiltinVoiceTools()   (called at app startup; idempotent)
//   2. startSession(config)          → VoiceSessionHandle
//   3. handle.onEvent(handler)       → subscribe to events
//   4. endSession()                  → closes adapter, emits session-ended
//
//   Multiple sessions: NOT supported. startSession() on an active session
//   ends the prior session first (warn logged).
//
// ─── Security ────────────────────────────────────────────────────────────────
//   - No key ever stored in VoiceSessionHandle or passed to callers.
//   - K1 gate runs inside dispatchTool() before any tool execution.
//   - N6: FSM guards every lifecycle step.

import { randomUUID } from 'node:crypto';
import type { VoiceEvent, VoiceSessionConfig } from './types';
import { createAdapter, isVoiceLiveEnabled, type RealtimeAdapter } from './realtime-adapter';
import { isActive, isTransitioning } from './session-fsm';
import {
  dispatchTool,
  registerBuiltinVoiceTools,
  type DispatchResult,
} from './voice-tools';

// ─── Public handle ────────────────────────────────────────────────────────────

/**
 * A live (or ended) voice session handle returned by startSession().
 *
 * Callers subscribe via `onEvent()` and call `endSession()` when done.
 * The handle is safe to hold after the session ends — `onEvent()` will simply
 * not emit any further events.
 */
export interface VoiceSessionHandle {
  /** Session id — stable for the lifetime of the handle. */
  readonly sessionId: string;
  /** Subscribe to all events from this session. Returns unsubscribe. */
  onEvent(handler: (event: VoiceEvent) => void): () => void;
  /**
   * End the session. Idempotent. Emits session-ended once.
   * Returns after the adapter's disconnect resolves.
   */
  endSession(): Promise<void>;
  /**
   * Reply to a tool-call. The session-manager routes the call through
   * K1 + registry gates first; returns the dispatch result.
   *
   * After a successful dispatch (`result.ok === true`) the caller is
   * responsible for executing the tool and posting the output back to the
   * model — this is intentional: the manager provides the dispatch/gate
   * decisions, not the execution environment.
   */
  replyToToolCall(
    callId: string,
    toolName: string,
    output: Readonly<Record<string, unknown>>,
    gateToken?: string,
  ): DispatchResult;
}

// ─── Module-level state ───────────────────────────────────────────────────────

let _activeAdapter: RealtimeAdapter | null = null;
let _activeSessionId: string | null = null;

// ─── Startup bootstrap ────────────────────────────────────────────────────────

/**
 * Initialize the voice layer. Call once at application startup.
 * Idempotent: repeated calls are safe (no-op if already initialized).
 *
 * Registers the built-in generic voice tools.
 * Does NOT freeze the registry — application code can still add custom tools
 * before the first session starts.
 */
export function initVoiceLayer(): void {
  registerBuiltinVoiceTools();
}

// ─── startSession ─────────────────────────────────────────────────────────────

/**
 * Start a voice session.
 *
 * If a session is already active it is ended first (warn + graceful teardown).
 *
 * Returns a VoiceSessionHandle. In Mock mode (no LAZYOS_VOICE_LIVE) the
 * session is immediately active with no network or mic activity.
 *
 * PHASE2_VOICE_LIVE BOUNDARY:
 *   The adapter selection in createAdapter() is the only gate:
 *   - Without LAZYOS_VOICE_LIVE: returns MockRealtimeAdapter → mock session.
 *   - With LAZYOS_VOICE_LIVE + key: returns OpenAiRealtimeAdapter → live session.
 */
export async function startSession(config: VoiceSessionConfig = {}): Promise<VoiceSessionHandle> {
  // Teardown any existing active session.
  if (_activeAdapter !== null) {
    const fsmState = _activeAdapter.fsm.state;
    if (isActive(_activeAdapter.fsm) || isTransitioning(_activeAdapter.fsm)) {
      console.warn(
        `[voice] startSession() called with an active session (state=${fsmState}). ` +
        `Ending prior session first.`,
      );
      await _activeAdapter.disconnect('operator-stop');
    }
    _activeAdapter = null;
    _activeSessionId = null;
  }

  const adapter = createAdapter();
  _activeAdapter = adapter;

  const resolvedConfig: VoiceSessionConfig = {
    ...config,
    sessionId: config.sessionId ?? randomUUID(),
  };

  // Connect (may throw only for synchronous pre-checks; all async failures
  // arrive via error events — the adapter contract).
  let sessionId: string;
  try {
    sessionId = await adapter.connect(resolvedConfig);
  } catch (err) {
    _activeAdapter = null;
    throw err;
  }

  _activeSessionId = sessionId;

  // Build the handle.
  const handle: VoiceSessionHandle = {
    sessionId,

    onEvent(handler: (event: VoiceEvent) => void): () => void {
      return adapter.onEvent(handler);
    },

    async endSession(): Promise<void> {
      if (_activeAdapter !== adapter) return; // already torn down
      await adapter.disconnect('operator-stop');
      _activeAdapter = null;
      _activeSessionId = null;
    },

    replyToToolCall(
      callId: string,
      toolName: string,
      _output: Readonly<Record<string, unknown>>,
      gateToken?: string,
    ): DispatchResult {
      // Build a minimal VoiceToolCall for the gate check.
      const toolCall = { callId, name: toolName, args: {} };
      return dispatchTool(toolCall, gateToken);
    },
  };

  return handle;
}

// ─── endSession (module-level) ────────────────────────────────────────────────

/**
 * End the current active session from outside the handle.
 * Useful for global teardown (e.g. page unload, workspace switch).
 * No-op if no active session.
 */
export async function endSession(): Promise<void> {
  if (_activeAdapter === null) return;
  await _activeAdapter.disconnect('operator-stop');
  _activeAdapter = null;
  _activeSessionId = null;
}

// ─── Diagnostics (safe, no key exposure) ──────────────────────────────────────

/**
 * Returns a safe diagnostics snapshot for health checks.
 * No key, no session content — only adapter kind + FSM state.
 */
export function getVoiceDiagnostics(): {
  adapterKind: string;
  fsmState: string;
  sessionId: string | null;
  liveEnabled: boolean;
} {
  return {
    adapterKind: _activeAdapter?.kind ?? 'none',
    fsmState: _activeAdapter?.fsm.state ?? 'idle',
    sessionId: _activeSessionId,
    liveEnabled: isVoiceLiveEnabled(),
  };
}
