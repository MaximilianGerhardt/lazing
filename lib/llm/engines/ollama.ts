/**
 * Ollama Engine (`http://127.0.0.1:11434/api/chat`).
 *
 * Default model picked per N11 (CLAUDE.md):
 *   - `deepseek-r1:14b` for synthesis only
 *   - smaller models (qwen2, llama3, codellama, nomic-embed-text) for
 *     role / risk checks
 *
 * We default to **`llama3`** here because:
 *   1. Smaller (4.7 GB vs 9.0 GB) — boots faster on the owner's 32 GB RAM.
 *   2. N11 explicitly reserves `deepseek-r1:14b` for synthesis — using it
 *      as the default chat-engine would burn the heavy-job budget.
 * Override per-call with `req.model` or globally via `LAZYOS_OLLAMA_MODEL`.
 */

import type {
  ChatEngine,
  EngineAvailability,
  EngineChatRequest,
  EngineChatResponse,
} from './types';

const OLLAMA_BASE_URL = (process.env.LAZYOS_OLLAMA_URL ?? 'http://127.0.0.1:11434').replace(
  /\/$/,
  '',
);
const DEFAULT_MODEL = process.env.LAZYOS_OLLAMA_MODEL ?? 'llama3';
const DEFAULT_TIMEOUT_MS = 120_000; // local LLM can be slower than API

export const ollama: ChatEngine = {
  id: 'ollama',

  async detect(): Promise<EngineAvailability> {
    const t0 = Date.now();
    try {
      const ac = new AbortController();
      const tm = setTimeout(() => ac.abort(), 1500);
      const resp = await fetch(`${OLLAMA_BASE_URL}/api/tags`, { signal: ac.signal });
      clearTimeout(tm);
      if (!resp.ok) {
        return {
          engine: 'ollama',
          available: false,
          reason: `HTTP ${resp.status} at ${OLLAMA_BASE_URL}/api/tags`,
          probeMs: Date.now() - t0,
        };
      }
      const data = (await resp.json()) as { models?: Array<{ name: string }> };
      const modelNames = (data.models ?? []).map((m) => m.name);
      const hasDefault = modelNames.includes(DEFAULT_MODEL) ||
        modelNames.some((n) => n.startsWith(`${DEFAULT_MODEL}:`));
      return {
        engine: 'ollama',
        available: modelNames.length > 0,
        reason: !modelNames.length
          ? 'ollama up but no models pulled'
          : hasDefault
            ? `ready (default model ${DEFAULT_MODEL} available)`
            : `ready but default model ${DEFAULT_MODEL} missing — set LAZYOS_OLLAMA_MODEL`,
        details: {
          baseUrl: OLLAMA_BASE_URL,
          defaultModel: DEFAULT_MODEL,
          models: modelNames,
        },
        probeMs: Date.now() - t0,
      };
    } catch (err) {
      return {
        engine: 'ollama',
        available: false,
        reason: `unreachable at ${OLLAMA_BASE_URL}: ${err instanceof Error ? err.message : String(err)}`,
        probeMs: Date.now() - t0,
      };
    }
  },

  async chat(req: EngineChatRequest): Promise<EngineChatResponse> {
    const t0 = Date.now();
    const model = req.model ?? DEFAULT_MODEL;
    const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const ac = new AbortController();
    const timeout =
      timeoutMs > 0
        ? setTimeout(() => ac.abort(new Error(`ollama timeout after ${timeoutMs}ms`)), timeoutMs)
        : null;
    const onAbort = (): void => ac.abort();
    if (req.signal) {
      if (req.signal.aborted) onAbort();
      else req.signal.addEventListener('abort', onAbort, { once: true });
    }

    let resp: Response;
    try {
      resp = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
          stream: false,
          options: req.maxTokens ? { num_predict: req.maxTokens } : undefined,
        }),
        signal: ac.signal,
      });
    } finally {
      if (timeout) clearTimeout(timeout);
      if (req.signal) req.signal.removeEventListener('abort', onAbort);
    }
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '<no body>');
      throw new Error(`ollama HTTP ${resp.status}: ${errText.slice(0, 500)}`);
    }
    const data = (await resp.json()) as {
      message?: { content?: string };
      prompt_eval_count?: number;
      eval_count?: number;
    };
    return {
      engine: 'ollama',
      model,
      text: data.message?.content ?? '',
      latencyMs: Date.now() - t0,
      usage: {
        promptTokens: data.prompt_eval_count ?? 0,
        completionTokens: data.eval_count ?? 0,
      },
    };
  },
};
