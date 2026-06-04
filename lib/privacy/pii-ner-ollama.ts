/**
 * lib/privacy/pii-ner-ollama.ts — OPTIONAL local-LLM named-entity layer (N11).
 *
 * Detects PERSON / ORG / LOCATION names that a regex cannot, using a SMALL LOCAL
 * Ollama model. This is the "lean local LLM" tier: it runs entirely on the box,
 * so even the entity *detection* never touches a cloud provider. Off by default
 * (set LAZYOS_PII_NER=1). Always fail-soft → returns [] on any error/timeout; the
 * deterministic detectors remain the floor.
 */

import type { PiiSpan, PiiType } from "./pii-detectors";

const DEFAULT_MODEL = "qwen2";
const NER_TYPES: ReadonlyArray<PiiType> = ["PERSON", "ORG", "LOCATION"];

export function nerEnabled(): boolean {
  const v = (process.env.LAZYOS_PII_NER ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "on";
}

function ollamaUrl(): string {
  return (process.env.LAZYOS_OLLAMA_URL?.trim() || "http://127.0.0.1:11434").replace(/\/$/, "");
}

function nerModel(): string {
  return process.env.LAZYOS_PII_NER_MODEL?.trim() || DEFAULT_MODEL;
}

/** All occurrences of `needle` in `hay` as [start,end] spans (non-overlapping). */
function occurrences(hay: string, needle: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  if (!needle) return out;
  let idx = hay.indexOf(needle);
  while (idx !== -1) {
    out.push([idx, idx + needle.length]);
    idx = hay.indexOf(needle, idx + needle.length);
  }
  return out;
}

/**
 * Ask the local model for named entities. Returns spans for every exact-substring
 * match found in `text`. Never throws.
 */
export async function detectNamedEntitiesOllama(
  text: string,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<PiiSpan[]> {
  if (!nerEnabled() || !text.trim()) return [];

  const ctrl = new AbortController();
  const onAbort = (): void => ctrl.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 8000);

  try {
    const prompt =
      "You are a PII extractor. From the TEXT, extract personal named entities. " +
      'Return ONLY a JSON array of {"type","value"} objects, where type is one of ' +
      'PERSON, ORG, LOCATION and value is the EXACT substring from the text. No prose.\n\nTEXT:\n' +
      text;
    const res = await fetch(`${ollamaUrl()}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: nerModel(),
        prompt,
        stream: false,
        format: "json",
        options: { temperature: 0 },
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { response?: string };
    const raw: unknown = JSON.parse(body.response ?? "[]");
    const list: Array<{ type?: string; value?: string }> = Array.isArray(raw)
      ? (raw as Array<{ type?: string; value?: string }>)
      : ((raw as { entities?: Array<{ type?: string; value?: string }> }).entities ?? []);

    const spans: PiiSpan[] = [];
    for (const e of list) {
      const t = (e.type ?? "").toUpperCase() as PiiType;
      if (!NER_TYPES.includes(t) || !e.value) continue;
      for (const [start, end] of occurrences(text, e.value)) {
        spans.push({ type: t, start, end, value: e.value });
      }
    }
    return spans;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}
