/**
 * Engine Selector — auto-detect availability + fallback chain.
 *
 * Order (per directive 2026-05-23, "claude-api out"):
 *   1. claude-cli (MAX-Plan, zero-cost per turn)
 *   2. codex-cli (OpenAI Codex, per-turn cost on different vendor)
 *   3. ollama (local, zero-cost, slower)
 *
 * claude-api (direct Anthropic Messages-API call) was removed 2026-05-23 —
 * user frustration ("I don't need it at all, no idea why it doesn't run").
 * MAX-Plan-OAuth via claude-cli covers the same use case zero-cost.
 *
 * The selector caches detection results for 60s to avoid spawning child
 * processes on every request. Force a fresh probe by passing `forceProbe`.
 */

import { claudeCli } from './claude-cli';
import { codexCli } from './codex';
import { grok } from './grok';
import { ollama } from './ollama';
import type {
  ChatEngine,
  EngineAvailability,
  EngineId,
  EngineSelection,
} from './types';

// Preference/fallback order: MAX-plan claude → paid clouds (codex, grok) → local
// ollama as the free fallback.
const ENGINE_ORDER: ChatEngine[] = [claudeCli, codexCli, grok, ollama];
const ENGINES_BY_ID: Record<EngineId, ChatEngine> = {
  'claude-cli': claudeCli,
  'codex-cli': codexCli,
  grok,
  ollama,
};

const CACHE_TTL_MS = 60_000;
let cachedSelection: EngineSelection | null = null;
let cachedAt = 0;

export async function detectEngines(opts: { forceProbe?: boolean } = {}): Promise<EngineSelection> {
  const now = Date.now();
  if (
    !opts.forceProbe &&
    cachedSelection &&
    now - cachedAt < CACHE_TTL_MS
  ) {
    return cachedSelection;
  }
  // Probe all in parallel — each engine has its own short timeout.
  const probes = await Promise.all(ENGINE_ORDER.map((e) => safeProbe(e)));
  const preferred = probes.find((p) => p.available)?.engine ?? null;
  const sel: EngineSelection = {
    preferred,
    available: probes,
    detectedAt: now,
  };
  cachedSelection = sel;
  cachedAt = now;
  return sel;
}

async function safeProbe(engine: ChatEngine): Promise<EngineAvailability> {
  try {
    return await engine.detect();
  } catch (err) {
    return {
      engine: engine.id,
      available: false,
      reason: `probe crashed: ${err instanceof Error ? err.message : String(err)}`,
      probeMs: 0,
    };
  }
}

export function getEngine(id: EngineId): ChatEngine {
  return ENGINES_BY_ID[id];
}

/**
 * Pick the highest-priority **available** engine that hasn't already been
 * skipped via the `skip` list. Returns null when no engine is available.
 */
export function pickEngine(selection: EngineSelection, skip: EngineId[] = []): ChatEngine | null {
  const skipSet = new Set(skip);
  for (const probe of selection.available) {
    if (probe.available && !skipSet.has(probe.engine)) {
      return ENGINES_BY_ID[probe.engine];
    }
  }
  return null;
}

/**
 * Convenience: clear the selector cache. Use after auth-change ("user logged
 * in to Claude") so the next call doesn't return the stale `not-authenticated`
 * snapshot.
 */
export function clearEngineCache(): void {
  cachedSelection = null;
  cachedAt = 0;
}
