/**
 * Multi-Engine Adapter — public surface.
 *
 * Usage:
 *   import { chatWithFallback, detectEngines } from '@/lib/llm/engines';
 *   const { text, engine } = await chatWithFallback({
 *     messages: [{ role: 'user', content: 'hi' }],
 *   });
 */

export type {
  ChatEngine,
  EngineAvailability,
  EngineChatRequest,
  EngineChatResponse,
  EngineId,
  EngineMessage,
  EngineSelection,
} from './types';
export { claudeCli } from './claude-cli';
export { codexCli } from './codex';
export { ollama } from './ollama';
export { clearEngineCache, detectEngines, getEngine, pickEngine } from './selector';

import { detectEngines, pickEngine } from './selector';
import type {
  EngineChatRequest,
  EngineChatResponse,
  EngineId,
} from './types';

/**
 * Highest-level helper: detect engines once, run chat against the preferred
 * engine, and fall through to the next available on failure. Logs each
 * attempt so callers can see the fallback chain in action.
 */
export async function chatWithFallback(
  req: EngineChatRequest,
  opts: { only?: EngineId; forceProbe?: boolean } = {},
): Promise<EngineChatResponse & { fallbackAttempts: Array<{ engine: EngineId; error: string }> }> {
  const selection = await detectEngines({ forceProbe: opts.forceProbe });
  const attempts: Array<{ engine: EngineId; error: string }> = [];
  const skip: EngineId[] = [];

  // `only` short-circuits the chain — useful for testing one engine.
  if (opts.only) {
    const eng = selection.available.find((a) => a.engine === opts.only);
    if (!eng?.available) {
      throw new Error(
        `requested engine ${opts.only} not available: ${eng?.reason ?? 'unknown'}`,
      );
    }
    const engine = pickEngine({ ...selection, available: [eng] });
    if (!engine) throw new Error(`engine ${opts.only} not registered`);
    const result = await engine.chat(req);
    return { ...result, fallbackAttempts: [] };
  }

  for (let i = 0; i < selection.available.length; i++) {
    const engine = pickEngine(selection, skip);
    if (!engine) break;
    try {
      const result = await engine.chat(req);
      return { ...result, fallbackAttempts: attempts };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      attempts.push({ engine: engine.id, error: msg });
      skip.push(engine.id);
    }
  }
  throw new Error(
    `all engines failed. attempts=${JSON.stringify(attempts)}; ` +
      `detected=${JSON.stringify(selection.available.map((a) => ({ e: a.engine, ok: a.available, why: a.reason })))}`,
  );
}
