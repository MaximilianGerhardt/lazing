/**
 * Phase OSS.5 — Local models (stub).
 *
 * Architecture sketch for Ollama / LM-Studio / vLLM integration. Today
 * ONLY type defs + resolver. Real provider calls in `lib/agents/spawn.ts`
 * will be implemented in a dedicated wave after the OSS launch
 * (Phase LM-Implement).
 *
 * Config via ENV `LAZYOS_LOCAL_MODEL`:
 *   - empty / not set → no local mode, claude-code CLI as today
 *   - `ollama:gemma3:7b` → Ollama on default URL `http://127.0.0.1:11434`
 *   - `ollama:gemma3:7b@http://other:11434` → custom base URL
 *   - `lmstudio:qwen2.5-coder-32b` → LM-Studio on `http://127.0.0.1:1234`
 *   - `vllm:deepseek-coder-v3` → vLLM on `http://127.0.0.1:8000`
 *
 * Architecture docs: `docs/architecture/local-models.md`.
 */

export type LocalModelProvider = 'ollama' | 'lmstudio' | 'vllm';

export interface LocalModelConfig {
  provider: LocalModelProvider;
  model: string;
  baseUrl: string;
}

const DEFAULT_BASE_URLS: Record<LocalModelProvider, string> = {
  ollama: 'http://127.0.0.1:11434',
  lmstudio: 'http://127.0.0.1:1234',
  vllm: 'http://127.0.0.1:8000',
};

function isProvider(s: string): s is LocalModelProvider {
  return s === 'ollama' || s === 'lmstudio' || s === 'vllm';
}

/**
 * Parse ENV `LAZYOS_LOCAL_MODEL` into a LocalModelConfig or null.
 *
 * Format: `<provider>:<model>[@<base-url>]`
 */
export function resolveLocalModel(
  raw: string | undefined = process.env.LAZYOS_LOCAL_MODEL,
): LocalModelConfig | null {
  if (!raw || raw.trim() === '') return null;
  const [providerAndModel, baseUrl] = raw.split('@');
  const [provider, ...modelParts] = providerAndModel.split(':');
  if (!isProvider(provider)) return null;
  const model = modelParts.join(':').trim();
  if (model.length === 0) return null;
  return {
    provider,
    model,
    baseUrl: baseUrl?.trim() || DEFAULT_BASE_URLS[provider],
  };
}

/**
 * Hook for the future spawn layer. Today: returns a 501 marker. Will be
 * replaced by a real provider call in Phase LM-Implement.
 */
export class LocalModelNotImplementedError extends Error {
  constructor(public readonly config: LocalModelConfig) {
    super(
      `LocalModelProvider "${config.provider}" not yet implemented. ` +
        `Phase LM-Implement comes after OSS-Launch.`,
    );
    this.name = 'LocalModelNotImplementedError';
  }
}

export function ensureLocalModelImplemented(
  config: LocalModelConfig,
): never {
  throw new LocalModelNotImplementedError(config);
}
