// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Maximilian Gerhardt
//
// lib/voice/index.ts — Voice Foundation Public API (Batch 7c)
//
// Re-exports only the stable public surface. Internals (FSM helpers, adapter
// constructors, registry reset) are accessible via direct imports for tests
// but not advertised here.

// Types
export type {
  VoiceSessionState,
  VoiceSessionConfig,
  VoiceEvent,
  VoiceToolCall,
  VoiceErrorCode,
  VoiceSessionEndReason,
  VoiceAdapterKind,
} from './types';

// Session FSM (read-only public surface)
export type { VoiceSessionFsm, FsmAction, FsmTransitionResult } from './session-fsm';
export { createFsm, transition, isActive, isTerminal, isTransitioning, validActions } from './session-fsm';

// Adapter factory + diagnostics helpers
export { createAdapter, isVoiceLiveEnabled, hasVoiceKey } from './realtime-adapter';

// Voice tools registry (public surface)
export type { VoiceTool, DispatchResult } from './voice-tools';
export {
  registerVoiceTool,
  listVoiceTools,
  getVoiceTool,
  matchesK1VoiceDeny,
  dispatchTool,
  registerBuiltinVoiceTools,
  freezeRegistry,
  K1_VOICE_DENY_PATTERNS,
} from './voice-tools';

// Session manager (public API)
export type { VoiceSessionHandle } from './session-manager';
export { initVoiceLayer, startSession, endSession, getVoiceDiagnostics } from './session-manager';
