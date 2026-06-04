/**
 * lib/privacy/pii-vault.ts — local, encrypted PII tokenization vault.
 *
 * tokenizeText() replaces detected entities with opaque, stable placeholder
 * tokens (`[[EMAIL_1]]`) and stores the real value AES-256-GCM-encrypted in the
 * local `pii_vault` table — workspace-scoped (N9), deduplicated (same value →
 * same token). detokenizeText() reverses it locally. External LLMs only ever see
 * the tokens; the real values never leave the machine.
 *
 * Deterministic (N6): the detection floor is pure regex (pii-detectors.ts). The
 * caller may pass additional spans (e.g. from the optional local-LLM NER layer).
 * Raw better-sqlite3 so it is unit-testable in-memory.
 */

import { createHash } from "node:crypto";

import { encryptCredential, decryptCredential } from "@/lib/security/credentials";
import { ulid } from "@/lib/ulid";

import {
  detectDeterministic,
  mergeSpans,
  type PiiSpan,
  type PiiType,
} from "./pii-detectors";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Spans for entity VALUES already in this workspace's vault (e.g. names a prior
 * turn's NER detected) that reappear in `text`. This keeps a once-tokenized name
 * tokenized in later turns WITHOUT re-running the model — closing the
 * "names in re-sent history" gap. Scoped to NER types + length >= 4 + word
 * boundaries to avoid false matches on short/common strings.
 */
interface KnownEntry {
  type: PiiType;
  value: string;
  re: RegExp;
}
// Per-DB-handle cache of decrypted known names, keyed by workspace. WeakMap keyed
// by the DB object → per-connection: tests with fresh in-memory DBs never share a
// stale cache, while the long-lived app/agent connections do cache. Avoids
// decrypting every PERSON/ORG/LOCATION row + recompiling regexes on every call.
const knownCacheByDb = new WeakMap<
  object,
  Map<string, { at: number; entries: KnownEntry[] }>
>();
const KNOWN_TTL_MS = 30_000;
const KNOWN_MAX_ROWS = 2000;

function invalidateKnownCache(raw: RawDb, workspaceId: string): void {
  knownCacheByDb.get(raw as object)?.delete(workspaceId);
}

function loadKnownEntries(raw: RawDb, workspaceId: string): KnownEntry[] {
  let perWs = knownCacheByDb.get(raw as object);
  if (!perWs) {
    perWs = new Map();
    knownCacheByDb.set(raw as object, perWs);
  }
  const cached = perWs.get(workspaceId);
  if (cached && Date.now() - cached.at < KNOWN_TTL_MS) return cached.entries;

  let rows: Array<{ entity_type: string; value_enc: string }>;
  try {
    rows = raw
      .prepare(
        "SELECT entity_type, value_enc FROM pii_vault WHERE workspace_id = ? AND entity_type IN ('PERSON','ORG','LOCATION') LIMIT ?",
      )
      .all(workspaceId, KNOWN_MAX_ROWS) as Array<{ entity_type: string; value_enc: string }>;
  } catch {
    return [];
  }
  const entries: KnownEntry[] = [];
  for (const row of rows) {
    let value: string;
    try {
      value = decryptCredential(row.value_enc);
    } catch {
      continue;
    }
    if (value.length < 4) continue;
    entries.push({
      type: row.entity_type as PiiType,
      value,
      // Unicode-aware boundaries so umlaut names (e.g. "Müller") match cleanly.
      re: new RegExp(`(?<!\\p{L})${escapeRegExp(value)}(?!\\p{L})`, "gu"),
    });
  }
  perWs.set(workspaceId, { at: Date.now(), entries });
  return entries;
}

export function knownValueSpans(raw: RawDb, workspaceId: string, text: string): PiiSpan[] {
  if (!workspaceId || !text) return [];
  const spans: PiiSpan[] = [];
  for (const e of loadKnownEntries(raw, workspaceId)) {
    e.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = e.re.exec(text)) !== null) {
      spans.push({ type: e.type, start: m.index, end: m.index + e.value.length, value: e.value });
      if (m.index === e.re.lastIndex) e.re.lastIndex += 1;
    }
  }
  return spans;
}

type RawDb = import("better-sqlite3").Database;

/** Matches the placeholder tokens we emit: [[TYPE_n]] (TYPE = A–Z only). */
const TOKEN_RE = /\[\[([A-Z]+)_(\d+)\]\]/g;

export interface TokenizeResult {
  /** the text with every detected entity replaced by a token */
  text: string;
  /** number of entity occurrences replaced */
  entityCount: number;
  /** the distinct tokens used */
  tokens: string[];
}

function valueHash(workspaceId: string, type: string, value: string): string {
  return createHash("sha256")
    .update(workspaceId)
    .update("\0")
    .update(type)
    .update("\0")
    .update(value)
    .digest("hex");
}

function lookupOrCreateToken(
  raw: RawDb,
  workspaceId: string,
  type: string,
  value: string,
): string {
  const h = valueHash(workspaceId, type, value);
  const findByHash = (): string | undefined =>
    (
      raw
        .prepare("SELECT token FROM pii_vault WHERE workspace_id = ? AND value_hash = ?")
        .get(workspaceId, h) as { token: string } | undefined
    )?.token;

  const existing = findByHash();
  if (existing) return existing;

  const enc = encryptCredential(value);
  const insert = raw.prepare(
    `INSERT INTO pii_vault (id, workspace_id, token, entity_type, value_enc, value_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  // Counter-race guard: this DB is shared with the agent-server process, so the
  // COUNT+1 → INSERT pair is not atomic across processes. On a unique-index
  // conflict, re-read by value (a concurrent writer already stored it) or retry
  // with a fresh counter.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const cnt = raw
      .prepare("SELECT COUNT(*) AS c FROM pii_vault WHERE workspace_id = ? AND entity_type = ?")
      .get(workspaceId, type) as { c: number } | undefined;
    const token = `[[${type}_${(cnt?.c ?? 0) + 1}]]`;
    try {
      insert.run(`pii_${ulid()}`, workspaceId, token, type, enc, h, Date.now());
      // A new name landed → the cross-turn known-value cache for this workspace is
      // stale; drop it so the next tokenizeText picks the name up immediately
      // instead of waiting out the TTL.
      if (type === "PERSON" || type === "ORG" || type === "LOCATION") {
        invalidateKnownCache(raw, workspaceId);
      }
      return token;
    } catch {
      const again = findByHash();
      if (again) return again; // value was stored by a concurrent writer
      // else: token-counter collision → loop and recompute the count
    }
  }
  // Effectively unreachable; never leak the raw value — fall back to a placeholder.
  return findByHash() ?? `[[${type}_0]]`;
}

/**
 * Replace every detected PII entity in `text` with a vault token. `extraSpans`
 * lets the caller inject spans from the optional local-LLM NER layer. Replacement
 * runs right-to-left so offsets stay valid.
 */
export function tokenizeText(
  raw: RawDb,
  workspaceId: string,
  text: string,
  extraSpans: PiiSpan[] = [],
): TokenizeResult {
  if (!workspaceId || !text) return { text, entityCount: 0, tokens: [] };

  // Merge deterministic + known-value (cross-turn names) + injected spans,
  // resolve overlaps, replace from the end.
  const spans = mergeSpans([
    ...detectDeterministic(text),
    ...knownValueSpans(raw, workspaceId, text),
    ...extraSpans,
  ]);
  if (spans.length === 0) return { text, entityCount: 0, tokens: [] };

  spans.sort((a, b) => b.start - a.start);
  let out = text;
  const tokens: string[] = [];
  for (const span of spans) {
    const token = lookupOrCreateToken(raw, workspaceId, span.type, span.value);
    tokens.push(token);
    out = out.slice(0, span.start) + token + out.slice(span.end);
  }
  return { text: out, entityCount: spans.length, tokens: [...new Set(tokens)] };
}

/**
 * Reverse tokenizeText: replace `[[TYPE_n]]` tokens with the decrypted real value
 * from THIS workspace's vault. Unknown tokens (e.g. from another workspace) are
 * left untouched — cross-workspace de-tokenization is impossible by construction.
 */
export function detokenizeText(
  raw: RawDb,
  workspaceId: string,
  text: string,
): { text: string; restored: number } {
  if (!workspaceId || !text) return { text, restored: 0 };
  let restored = 0;
  const stmt = raw.prepare(
    "SELECT value_enc FROM pii_vault WHERE workspace_id = ? AND token = ?",
  );
  const out = text.replace(TOKEN_RE, (match) => {
    const row = stmt.get(workspaceId, match) as { value_enc: string } | undefined;
    if (!row) return match;
    try {
      const v = decryptCredential(row.value_enc);
      restored += 1;
      return v;
    } catch {
      return match;
    }
  });
  return { text: out, restored };
}
