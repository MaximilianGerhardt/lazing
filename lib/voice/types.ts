// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Maximilian Gerhardt
//
// lib/voice/types.ts — Voice Foundation (Batch 7c)
//
// Public type contracts for the lazyOS voice layer.
//
// PHASE BOUNDARY:
//   Default (no LAZYOS_VOICE_LIVE): Mock-Session only — no network, no mic,
//   no OpenAI call. Deterministic for tests (N6).
//
//   PHASE2_VOICE_LIVE (gated): LAZYOS_VOICE_LIVE=1 AND OPENAI_API_KEY (or
//   LAZYOS_VOICE_OPENAI_KEY) present → OpenAiRealtimeAdapter becomes active.
//   Without the flag and key createAdapter() ALWAYS returns MockRealtimeAdapter
//   + logs a console.warn (never throws).
//
// Security invariants:
//   - API keys NEVER appear in VoiceEvent, VoiceSessionConfig, logs, or debug output.
//   - K1 deny-patterns apply to every VoiceToolCall name (see voice-tools.ts).
//   - N6: FSM transitions are pure and deterministic.

// ─── Session FSM States ───────────────────────────────────────────────────────

/**
 * Lifecycle states of a voice session.
 *
 * Valid transition graph (see session-fsm.ts for the enforced machine):
 *
 *   idle ──────────────────────────────────────────► connecting
 *   connecting ───────────────────────────────────► active
 *   connecting ── (negotiation-failed / abort) ──► error
 *   active     ── (stopSession / remote-close) ──► closing
 *   active     ── (transport-error) ─────────────► error
 *   closing    ──────────────────────────────────► closed
 *   error      ──────────────────────────────────► idle   (via reset)
 *   closed     ──────────────────────────────────► idle   (via reset)
 */
export type VoiceSessionState =
  | 'idle'
  | 'connecting'
  | 'active'
  | 'closing'
  | 'closed'
  | 'error';

// ─── Configuration ────────────────────────────────────────────────────────────

/**
 * Configuration passed to startSession().
 *
 * All fields optional — sensible defaults are applied inside session-manager.ts.
 * NEVER include API keys here; keys are read from ENV inside the adapter and
 * never stored in config objects that cross module boundaries.
 */
export interface VoiceSessionConfig {
  /** Workspace id — forwarded to the session endpoint for scope-aware instructions. */
  readonly workspaceId?: string;
  /** Model override (e.g. 'gpt-4o-realtime-preview'). null = adapter default. */
  readonly model?: string | null;
  /** Voice id for the model's TTS output. Default: 'alloy'. */
  readonly voice?: string;
  /** System instructions injected at session start. */
  readonly instructions?: string;
  /**
   * Explicit session id. When omitted the session-manager generates one
   * via crypto.randomUUID() so the id is NEVER predictable.
   */
  readonly sessionId?: string;
}

// ─── VoiceEvent — discriminated union ────────────────────────────────────────

/**
 * Every event emitted by a RealtimeAdapter implements this union.
 * Discriminated on `kind`. Consumers switch on `kind` — never inspect `.message`
 * for control flow (copy must not leak).
 *
 * Security: `message` fields on error events MUST NOT contain API keys or
 * plaintext credentials. The adapter strips them before emitting.
 */
export type VoiceEvent =
  | {
      readonly kind: 'session-started';
      readonly sessionId: string;
      readonly state: 'active';
      readonly at: number;
    }
  | {
      readonly kind: 'session-ended';
      readonly sessionId: string;
      readonly reason: VoiceSessionEndReason;
      readonly at: number;
    }
  | {
      readonly kind: 'transcript-partial';
      readonly sessionId: string;
      readonly text: string;
      readonly at: number;
    }
  | {
      readonly kind: 'transcript-final';
      readonly sessionId: string;
      readonly text: string;
      readonly at: number;
    }
  | {
      readonly kind: 'response-audio-chunk';
      readonly sessionId: string;
      /** PCM16 mono 24 kHz, base64-encoded. Empty string = silence beat. */
      readonly audioBase64: string;
      readonly at: number;
    }
  | {
      readonly kind: 'response-audio-done';
      readonly sessionId: string;
      readonly at: number;
    }
  | {
      readonly kind: 'tool-call';
      readonly sessionId: string;
      readonly toolCall: VoiceToolCall;
      readonly at: number;
    }
  | {
      readonly kind: 'error';
      readonly sessionId: string | null;
      readonly code: VoiceErrorCode;
      /** Human-readable detail — MUST NOT contain secrets. */
      readonly message: string;
      readonly at: number;
    };

export type VoiceSessionEndReason =
  | 'operator-stop'
  | 'remote-close'
  | 'transport-error'
  | 'idle-timeout';

/**
 * Enumerated error codes. UI switches on `code`; `message` is for logs only.
 * Adding a code requires a corresponding test case in session-fsm.test.ts.
 */
export type VoiceErrorCode =
  | 'not-supported'
  | 'mic-permission-denied'
  | 'backend-disabled'
  | 'ephemeral-token-failed'
  | 'transport-closed'
  | 'tool-denied-k1'
  | 'tool-unknown'
  | 'unknown';

// ─── VoiceToolCall ────────────────────────────────────────────────────────────

/**
 * A function/tool-call emitted by the remote model during a voice session.
 *
 * The voice-tools registry (voice-tools.ts) resolves `name` to a registered
 * VoiceTool. If the name is not registered or K1-denied the adapter emits a
 * `{ kind: 'error', code: 'tool-denied-k1' | 'tool-unknown' }` event instead
 * of forwarding the call.
 */
export interface VoiceToolCall {
  /** Unique call id issued by the remote model. Opaque — used for reply routing. */
  readonly callId: string;
  /** Tool name. Must match a registered VoiceTool name. */
  readonly name: string;
  /** JSON-serialisable arguments object. Never contains secrets. */
  readonly args: Readonly<Record<string, unknown>>;
}

// ─── Adapter meta ─────────────────────────────────────────────────────────────

export type VoiceAdapterKind = 'mock' | 'openai-realtime';
