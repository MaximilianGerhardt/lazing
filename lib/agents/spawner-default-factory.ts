// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Maximilian Gerhardt
//
// lib/agents/spawner-default-factory — wires the SubagentSpawner to
// lazyos-stable's multi-engine ChatEngine surface (`lib/llm/engines`).
//
// BACKPORT-02 (2026-05-23) — Per BACKPORT-SPEC-02 §6.4-1 the V2 spawner
// imports from `@lazing/runtime/engine/router`. lazyos uses
// `lib/llm/engines`. The router contract maps 1:1 (engine-id → adapter)
// so this thin shim is the only adaptation needed.
//
// Engine-id mapping (SubagentEngine → EngineId):
//   - claude-cli   → 'claude-cli'
//   - codex        → 'codex-cli'
//   - ollama-heavy → 'ollama'
//
// For 'allowedSkills' enforcement we forward the list verbatim to the
// engine; lazyos engines that don't expose a sandboxed skill surface
// simply ignore the field today.

import { getEngine, type EngineChatRequest, type EngineId } from '@/lib/llm/engines';
import { protectEngine } from '@/lib/privacy/protect';

import type { SubagentEngine } from './spawner-types';
import type { SpawnerAdapter, SpawnerAdapterFactory } from './spawner';

function engineIdFromSubagentEngine(engine: SubagentEngine): EngineId {
  switch (engine) {
    case 'claude-cli':
      return 'claude-cli';
    case 'codex':
      return 'codex-cli';
    case 'ollama-heavy':
      return 'ollama';
    default: {
      const _exhaustive: never = engine;
      throw new Error(`Unknown SubagentEngine: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Default adapter factory for production wiring. Tests inject their own
 * factory (see `__tests__/spawner.test.ts`) for deterministic behaviour.
 */
export const defaultSpawnerAdapterFactory: SpawnerAdapterFactory = (input) => {
  const engineId = engineIdFromSubagentEngine(input.engine);
  // PII vault: wrap at the engine boundary when a workspace scope is present, so
  // the system + user prompts (verbatim operator intent, N1) are tokenized before
  // a cloud engine sees them and the reply is rehydrated. Pass-through for ollama,
  // vault-off, or no scope (test factories pass no workspaceId).
  const engine = protectEngine(input.workspaceId ?? '', getEngine(engineId));

  const adapter: SpawnerAdapter = {
    async runOnce(args) {
      const req: EngineChatRequest = {
        messages: [
          { role: 'system', content: args.systemPrompt },
          { role: 'user', content: args.userMessage },
        ],
        ...(args.signal ? { signal: args.signal } : {}),
        // Defense-in-depth (Codex-Write-Boundary): subagent spawning via this
        // factory always runs in read-only mode. No spawner call-site today
        // is a gated write-executor, so 'read' is the correct default here.
        // When a legitimate write path is built (gated Executor + R1-worktree),
        // it must construct its own adapter with explicit 'write' — this factory
        // must remain read-only.
        ...(engineId === 'codex-cli' ? { codexMode: 'read' as const } : {}),
      };
      const t0 = Date.now();
      const result = await engine.chat(req);
      return { text: result.text, durationMs: result.latencyMs ?? Date.now() - t0 };
    },
  };

  return adapter;
};
