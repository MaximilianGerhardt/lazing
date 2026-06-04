// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Maximilian Gerhardt
//
// lib/voice/voice-tools.ts — Voice Tool Registry (Batch 7c)
//
// Principle: Voice → Tool-Dispatch.
//
//   1. Every tool exposed to the voice model must be registered here before
//      the session.update payload includes it. The model can ONLY call tools
//      it was told about in the session config.
//
//   2. K1 hard-block applies to all voice tools (POS-8 / N2):
//      Any tool whose name matches a K1_VOICE_DENY_PATTERN is blocked before
//      dispatch — the caller receives a 'tool-denied-k1' error event, not an
//      exception. The guard runs deterministically (N6) before any async dispatch.
//
//   3. Destructive tools (delete, drop, irreversible external writes) require
//      explicit Gate approval. Flag `requiresGate: true`. Without a Gate token
//      dispatch returns `{ ok: false, reason: 'gate-required' }`.
//
//   4. Tools are GENERIC by design — they describe capabilities (submit_to_composer,
//      switch_workspace) not UI/product-specific behaviours. Feature-specific wiring
//      (which route handles submit_to_composer) lives outside this registry.
//
// Security model:
//   - No secret access inside tool handler types (tools receive plain args).
//   - K1 deny check is the first gate — happens before any arg validation.
//   - No tool name matches are case-insensitive by convention (lowercase only).

import type { VoiceToolCall } from './types';

// ─── K1 Voice Deny Patterns ───────────────────────────────────────────────────

/**
 * Tool names matching these patterns are HARD-BLOCKED via K1.
 * Pattern matching: exact equality OR glob-style prefix/* wildcard.
 *
 * Rule: add a pattern here when a tool name would give voice-invoked code
 * access to RAG, global context, or cross-workspace data without an explicit
 * Bridge approval (N2 — no global RAG fallback ever).
 *
 * Frozen at module-load time — same integrity discipline as k1-deny-patterns.ts.
 */
export const K1_VOICE_DENY_PATTERNS: ReadonlyArray<string> = Object.freeze([
  'rag_query',
  'rag_search',
  'global_rag_*',
  'cross_workspace_*',
  'drop_workspace',
  'delete_workspace',
  'purge_*',
]);

// Module-load-time integrity guard.
if (!Object.isFrozen(K1_VOICE_DENY_PATTERNS)) {
  throw new Error(
    'SECURITY: K1_VOICE_DENY_PATTERNS is not frozen. ' +
    'K1 hard-block for voice tools has been bypassed.',
  );
}

// ─── Tool types ───────────────────────────────────────────────────────────────

/**
 * A registered voice tool.
 *
 * Tools are intentionally simple value-objects — no classes, no methods that
 * close over secrets. The `schema` is a JSON-Schema-compatible object that
 * the adapter forwards in the session.update `tools` array.
 */
export interface VoiceTool {
  /** Unique tool name. lowercase_snake_case. */
  readonly name: string;
  /** Short description forwarded to the model in the session config. */
  readonly description: string;
  /**
   * JSON-Schema for the tool's `args` object. Forwarded verbatim in
   * session.update `tools[*].parameters`. Use strict schemas to limit
   * what the model can pass.
   */
  readonly schema: Readonly<Record<string, unknown>>;
  /**
   * If true, dispatch requires a Gate approval token. Without it,
   * dispatchTool() returns `{ ok: false, reason: 'gate-required' }`.
   * Use for destructive or irreversible external actions.
   */
  readonly requiresGate?: boolean;
  /**
   * Watchdog timeout in ms. If the host does not call replyToToolCall()
   * within this window, the adapter sends a stub ACK so the model can continue.
   * Default: 10000 ms.
   */
  readonly timeoutMs?: number;
}

// ─── Dispatch result ──────────────────────────────────────────────────────────

export type DispatchResult =
  | { ok: true; toolName: string }
  | { ok: false; reason: 'k1-denied' | 'unknown-tool' | 'gate-required' | 'invalid-args'; detail: string };

// ─── Registry ─────────────────────────────────────────────────────────────────

/**
 * The voice tool registry.
 *
 * Keyed by tool name. Populated via `registerVoiceTool()`.
 * Read-only access via `getVoiceTool()` and `listVoiceTools()`.
 *
 * Design intent: the registry is populated at startup and never mutated
 * during a live session. Dynamic registration is explicitly not supported
 * (same session — same tool catalog — same model context).
 */
const _registry = new Map<string, VoiceTool>();
let _frozen = false;

/**
 * Register a voice tool.
 *
 * Throws if the registry has been frozen (session started) or if a tool
 * with the same name is already registered.
 */
export function registerVoiceTool(tool: VoiceTool): void {
  if (_frozen) {
    throw new Error(
      `[voice-tools] Cannot register tool '${tool.name}' after registry is frozen.`,
    );
  }
  if (_registry.has(tool.name)) {
    throw new Error(
      `[voice-tools] Tool '${tool.name}' is already registered. Names must be unique.`,
    );
  }
  _registry.set(tool.name, tool);
}

/**
 * Freeze the registry. Called by session-manager before session.update is sent.
 * After this point no new tools can be registered for the lifetime of the process.
 * (Tests call _resetRegistry() to unfreeze between test cases.)
 */
export function freezeRegistry(): void {
  _frozen = true;
}

/**
 * Returns all registered tools. Used to build the session.update `tools` array.
 * Returns a stable snapshot (copy) — callers cannot mutate the registry.
 */
export function listVoiceTools(): VoiceTool[] {
  return Array.from(_registry.values());
}

/**
 * Resolve a tool by name. Returns undefined if not registered.
 */
export function getVoiceTool(name: string): VoiceTool | undefined {
  return _registry.get(name);
}

// ─── K1 check (pure, N6) ─────────────────────────────────────────────────────

/**
 * Returns true if `name` matches any K1 deny pattern.
 *
 * Matching rules:
 *   - Exact match: 'rag_query' matches 'rag_query'.
 *   - Prefix wildcard: 'global_rag_*' matches any name starting with 'global_rag_'.
 *   - Case-sensitive: all tool names are lowercase_snake_case by convention.
 *
 * Pure function — no I/O, deterministic (N6).
 */
export function matchesK1VoiceDeny(name: string): boolean {
  for (const pattern of K1_VOICE_DENY_PATTERNS) {
    if (pattern.endsWith('*')) {
      const prefix = pattern.slice(0, -1);
      if (name.startsWith(prefix)) return true;
    } else {
      if (name === pattern) return true;
    }
  }
  return false;
}

// ─── Dispatch ─────────────────────────────────────────────────────────────────

/**
 * Validate and dispatch a voice tool call.
 *
 * Gate order (fail-fast, N6 — deterministic before any async):
 *   1. K1 deny check → 'k1-denied' (hard block, no gate override).
 *   2. Registry lookup → 'unknown-tool'.
 *   3. Gate check (if `requiresGate` and no `gateToken`) → 'gate-required'.
 *   4. OK — returns `{ ok: true }` so the caller can execute the tool.
 *
 * This function does NOT execute the tool. Execution is the caller's
 * responsibility (session-manager.ts routes to the registered handler).
 * This keeps the registry free of side effects and testable in isolation.
 *
 * @param toolCall    - The voice tool call from the adapter.
 * @param gateToken   - Optional Gate approval token. Required for tools with
 *                      `requiresGate: true`. Presence is checked, value not validated here.
 */
export function dispatchTool(
  toolCall: VoiceToolCall,
  gateToken?: string,
): DispatchResult {
  const { name, callId } = toolCall;

  // Gate 1: K1 hard-block (POS-8 / N2).
  if (matchesK1VoiceDeny(name)) {
    return {
      ok: false,
      reason: 'k1-denied',
      detail:
        `[voice-tools] K1 hard-block: tool '${name}' (callId=${callId}) ` +
        `matches a K1_VOICE_DENY_PATTERN. Voice tools cannot access global RAG ` +
        `or cross-workspace data without explicit Bridge approval.`,
    };
  }

  // Gate 2: Registry lookup.
  const tool = _registry.get(name);
  if (!tool) {
    return {
      ok: false,
      reason: 'unknown-tool',
      detail:
        `[voice-tools] Unknown tool '${name}' (callId=${callId}). ` +
        `Register it via registerVoiceTool() before session.update is sent.`,
    };
  }

  // Gate 3: Gate approval for destructive tools.
  if (tool.requiresGate && !gateToken) {
    return {
      ok: false,
      reason: 'gate-required',
      detail:
        `[voice-tools] Tool '${name}' (callId=${callId}) requires Gate approval. ` +
        `Pass a valid gateToken to dispatchTool().`,
    };
  }

  return { ok: true, toolName: name };
}

// ─── Built-in generic tools (pre-registered) ─────────────────────────────────

/**
 * Register the standard set of generic voice tools.
 *
 * These are intentionally generic — they describe capability names that the
 * model can invoke. Feature-specific wiring is the responsibility of the
 * application layer (route handlers, composers, etc.).
 *
 * Call this once at application startup, before freezeRegistry().
 * Idempotent-safe: if already registered (e.g. repeated calls in tests),
 * the function skips without error when `ifNotPresent` option is used.
 */
export function registerBuiltinVoiceTools(): void {
  const tools: VoiceTool[] = [
    {
      name: 'submit_to_composer',
      description:
        'Submit a voice-dictated message or instruction to the active workspace composer. ' +
        'The model speaks the text and the system routes it as a chat input.',
      schema: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: 'The text to submit to the composer.',
          },
        },
        required: ['text'],
        additionalProperties: false,
      },
      timeoutMs: 30000,
    },
    {
      name: 'switch_workspace',
      description: 'Switch the active workspace by slug or id.',
      schema: {
        type: 'object',
        properties: {
          workspaceId: {
            type: 'string',
            description: 'The workspace id or slug to switch to.',
          },
        },
        required: ['workspaceId'],
        additionalProperties: false,
      },
      timeoutMs: 2000,
    },
    {
      name: 'list_workspaces',
      description: 'List all workspaces the operator has access to.',
      schema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      timeoutMs: 2000,
    },
    {
      name: 'create_workspace',
      description: 'Create a new workspace with the given name.',
      schema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Display name for the new workspace.',
          },
        },
        required: ['name'],
        additionalProperties: false,
      },
      timeoutMs: 5000,
    },
    {
      name: 'spawn_researcher',
      description: 'Spawn a researcher subagent on a given topic within the active workspace.',
      schema: {
        type: 'object',
        properties: {
          topic: {
            type: 'string',
            description: 'Research topic or question.',
          },
          workspaceId: {
            type: 'string',
            description: 'Target workspace id. Defaults to the active workspace.',
          },
        },
        required: ['topic'],
        additionalProperties: false,
      },
      timeoutMs: 30000,
    },
    {
      name: 'spawn_planner',
      description: 'Spawn a planner subagent to create or extend a plan in the active workspace.',
      schema: {
        type: 'object',
        properties: {
          goal: {
            type: 'string',
            description: 'The planning goal or objective.',
          },
          workspaceId: {
            type: 'string',
            description: 'Target workspace id. Defaults to the active workspace.',
          },
        },
        required: ['goal'],
        additionalProperties: false,
      },
      timeoutMs: 30000,
    },
  ];

  for (const tool of tools) {
    if (!_registry.has(tool.name)) {
      _registry.set(tool.name, tool);
    }
  }
}

// ─── Test helper (NOT exported from index.ts) ─────────────────────────────────

/**
 * Reset the registry for tests. ONLY call from test code.
 * Exported from this file so tests can import it; NOT re-exported from index.ts.
 */
export function _resetRegistry(): void {
  _registry.clear();
  _frozen = false;
}
