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
import { encryptCredential } from "@/lib/security/credentials";

import { detectNamedEntitiesOllama, nerEnabled } from "./pii-ner-ollama";
import { tokenizeText, detokenizeText } from "./pii-vault";

let keyOk = false;
let keyWarned = false;
/** The vault needs LAZYOS_CREDENTIAL_KEY to encrypt values. Validate it cheaply. */
function credentialKeyPresent(): boolean {
  if (keyOk) return true;
  try {
    encryptCredential("x");
    keyOk = true;
    return true;
  } catch {
    if (!keyWarned) {
      keyWarned = true;
      console.error(
        "[pii-vault] LAZYOS_PII_VAULT is on but LAZYOS_CREDENTIAL_KEY is missing/invalid — " +
          "the vault is DISABLED (chat keeps working, but PII is NOT protected). Set the key.",
      );
    }
    return false;
  }
}

export function piiVaultEnabled(): boolean {
  const v = (process.env.LAZYOS_PII_VAULT ?? "").trim().toLowerCase();
  if (!(v === "1" || v === "true" || v === "on")) return false;
  // Fail-open to "off" (with a one-time warning) rather than crashing chat when
  // the encryption key is absent.
  return credentialKeyPresent();
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

export interface EngineMessageLike {
  role: string;
  content: string;
}

/**
 * Tokenize the `content` of every message bound for an external engine. Returns a
 * NEW array — the originals are untouched, so message persistence and on-screen
 * display keep the real text while only the cloud-bound copy is tokenized. Pure
 * pass-through when the vault is off.
 */
export function tokenizeMessages<T extends EngineMessageLike>(
  workspaceId: string,
  messages: T[],
): T[] {
  if (!piiVaultEnabled() || !workspaceId) return messages;
  const raw = getDb().$raw;
  return messages.map((m) =>
    typeof m.content === "string"
      ? ({ ...m, content: tokenizeText(raw, workspaceId, m.content).text } as T)
      : m,
  );
}

/**
 * Like tokenizeMessages, but ALSO runs the optional local-LLM NER layer
 * (PERSON / ORG / LOCATION) when LAZYOS_PII_NER is on — so names are tokenized too,
 * not just structured identifiers. Falls back to the deterministic sync path when
 * NER is off or the model is unavailable (fail-soft). Use this on outbound chat.
 */
export async function tokenizeMessagesAsync<T extends EngineMessageLike>(
  workspaceId: string,
  messages: T[],
  opts: { signal?: AbortSignal } = {},
): Promise<T[]> {
  if (!piiVaultEnabled() || !workspaceId) return messages;
  if (!nerEnabled()) return tokenizeMessages(workspaceId, messages);
  const raw = getDb().$raw;
  // NER is a local-model call (bounded by its own timeout). Run it ONCE — on the
  // new (last) user message — not over the whole re-sent history, so latency is
  // a single model round-trip, not N of them. Older messages get deterministic
  // tokenization (structured PII); their names were NER-tokenized when they were
  // the new message in their own turn.
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "user") {
      lastUserIdx = i;
      break;
    }
  }
  const out: T[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i] as T;
    if (typeof m.content !== "string") {
      out.push(m);
      continue;
    }
    const extra = i === lastUserIdx ? await detectNamedEntitiesOllama(m.content, opts) : [];
    out.push({ ...m, content: tokenizeText(raw, workspaceId, m.content, extra).text } as T);
  }
  return out;
}

/** Deterministic-only single-text tokenize for callers that already have a DB handle. */
export function tokenizeStringForExternal(workspaceId: string, text: string): string {
  if (!piiVaultEnabled() || !workspaceId || !text) return text;
  return tokenizeText(getDb().$raw, workspaceId, text).text;
}
