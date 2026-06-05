/**
 * Grok Engine (xAI API — `https://api.x.ai/v1`, OpenAI-compatible).
 *
 * A CLOUD engine: bring-your-own xAI API key. Set `XAI_API_KEY` (xAI's standard
 * name) or `LAZYOS_GROK_API_KEY`. Default model via `LAZYOS_GROK_MODEL`.
 *
 * SECURITY: Grok is a cloud engine, so every prompt MUST pass through the PII
 * vault before reaching it — `grok` is in `CLOUD_ENGINE_IDS` (lib/privacy/protect.ts)
 * and the cloud-egress build guard covers it. The key is read from env only and
 * never logged.
 */

import type {
  ChatEngine,
  EngineAvailability,
  EngineChatRequest,
  EngineChatResponse,
} from './types';

const GROK_BASE_URL = (process.env.LAZYOS_GROK_URL ?? 'https://api.x.ai/v1').replace(/\/$/, '');
const DEFAULT_MODEL = process.env.LAZYOS_GROK_MODEL ?? 'grok-4';
const DEFAULT_TIMEOUT_MS = 120_000;

function apiKey(): string {
  return (process.env.XAI_API_KEY ?? process.env.LAZYOS_GROK_API_KEY ?? '').trim();
}

export const grok: ChatEngine = {
  id: 'grok',

  async detect(): Promise<EngineAvailability> {
    const t0 = Date.now();
    const key = apiKey();
    if (!key) {
      return {
        engine: 'grok',
        available: false,
        reason: 'no API key — set XAI_API_KEY (or LAZYOS_GROK_API_KEY)',
        probeMs: Date.now() - t0,
      };
    }
    try {
      const ac = new AbortController();
      const tm = setTimeout(() => ac.abort(), 2500);
      const resp = await fetch(`${GROK_BASE_URL}/models`, {
        headers: { authorization: `Bearer ${key}` },
        signal: ac.signal,
      });
      clearTimeout(tm);
      if (resp.status === 401 || resp.status === 403) {
        return {
          engine: 'grok',
          available: false,
          reason: `key rejected (HTTP ${resp.status})`,
          probeMs: Date.now() - t0,
        };
      }
      if (!resp.ok) {
        return {
          engine: 'grok',
          available: false,
          reason: `HTTP ${resp.status} at ${GROK_BASE_URL}/models`,
          probeMs: Date.now() - t0,
        };
      }
      return {
        engine: 'grok',
        available: true,
        reason: `ready (default model ${DEFAULT_MODEL})`,
        details: { baseUrl: GROK_BASE_URL, defaultModel: DEFAULT_MODEL },
        probeMs: Date.now() - t0,
      };
    } catch (err) {
      return {
        engine: 'grok',
        available: false,
        reason: `unreachable at ${GROK_BASE_URL}: ${err instanceof Error ? err.message : String(err)}`,
        probeMs: Date.now() - t0,
      };
    }
  },

  async chat(req: EngineChatRequest): Promise<EngineChatResponse> {
    const t0 = Date.now();
    const key = apiKey();
    if (!key) throw new Error('grok: no API key (set XAI_API_KEY or LAZYOS_GROK_API_KEY)');
    const model = req.model ?? DEFAULT_MODEL;
    const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const ac = new AbortController();
    const timeout =
      timeoutMs > 0
        ? setTimeout(() => ac.abort(new Error(`grok timeout after ${timeoutMs}ms`)), timeoutMs)
        : null;
    const onAbort = (): void => ac.abort();
    if (req.signal) {
      if (req.signal.aborted) onAbort();
      else req.signal.addEventListener('abort', onAbort, { once: true });
    }

    let resp: Response;
    try {
      resp = await fetch(`${GROK_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model,
          messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
          stream: false,
          ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
        }),
        signal: ac.signal,
      });
    } finally {
      if (timeout) clearTimeout(timeout);
      if (req.signal) req.signal.removeEventListener('abort', onAbort);
    }
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '<no body>');
      throw new Error(`grok HTTP ${resp.status}: ${errText.slice(0, 500)}`);
    }
    const data = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    return {
      engine: 'grok',
      model,
      text: data.choices?.[0]?.message?.content ?? '',
      latencyMs: Date.now() - t0,
      usage: {
        promptTokens: data.usage?.prompt_tokens ?? 0,
        completionTokens: data.usage?.completion_tokens ?? 0,
      },
    };
  },
};
