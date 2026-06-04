/**
 * lib/privacy/protect.ts — the integration seam for external-LLM calls.
 *
 * Wrap any call to a CLOUD engine (claude-cli / codex) like this:
 *
 *     const { safe } = await protectForExternalAsync(workspaceId, prompt);
 *     const reply = await externalEngine.chat(safe);     // cloud sees only tokens
 *     const shown = rehydrate(workspaceId, reply);        // user sees real values
 *
 * The cloud model only ever receives opaque `[[TYPE_n]]` tokens; the real values
 * stay in the local, AES-256-GCM-encrypted, workspace-scoped vault. LOCAL engines
 * (Ollama) don't need protection — they never leave the box — so callers can skip
 * this for `engine === 'ollama'`.
 *
 * Gated by LAZYOS_PII_VAULT (off by default → pure pass-through, zero overhead).
 */

import { getDb } from "@/db/client";

import { detectNamedEntitiesOllama, nerEnabled } from "./pii-ner-ollama";
import { tokenizeText, detokenizeText } from "./pii-vault";

export function piiVaultEnabled(): boolean {
  const v = (process.env.LAZYOS_PII_VAULT ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "on";
}

export interface ProtectResult {
  /** text safe to send to an external LLM (entities replaced by tokens) */
  safe: string;
  /** how many entity occurrences were tokenized */
  entityCount: number;
}

/** Deterministic-only protection (synchronous, no LLM). */
export function protectForExternal(workspaceId: string, text: string): ProtectResult {
  if (!piiVaultEnabled()) return { safe: text, entityCount: 0 };
  const r = tokenizeText(getDb().$raw, workspaceId, text);
  return { safe: r.text, entityCount: r.entityCount };
}

/**
 * Protection including the optional local-LLM named-entity layer (PERSON/ORG/…).
 * Falls back to deterministic-only if LAZYOS_PII_NER is off or the model errors.
 */
export async function protectForExternalAsync(
  workspaceId: string,
  text: string,
  opts: { signal?: AbortSignal } = {},
): Promise<ProtectResult> {
  if (!piiVaultEnabled()) return { safe: text, entityCount: 0 };
  const extra = nerEnabled() ? await detectNamedEntitiesOllama(text, opts) : [];
  const r = tokenizeText(getDb().$raw, workspaceId, text, extra);
  return { safe: r.text, entityCount: r.entityCount };
}

/** Reverse: replace tokens with the real values from this workspace's vault. */
export function rehydrate(workspaceId: string, text: string): string {
  if (!piiVaultEnabled()) return text;
  return detokenizeText(getDb().$raw, workspaceId, text).text;
}
