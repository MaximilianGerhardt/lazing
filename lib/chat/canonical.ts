/**
 * lib/chat/canonical.ts — Canonical-JSON + content-hash helpers
 * (BACKPORT-01 · 2026-05-23, source: Lazing-V2 packages/runtime/src/coord/coord.ts)
 *
 * Single source of truth for N10 (trace tamper-evident). Whoever writes
 * chat_ledger rows or persists snapshots MUST build the same hash over
 * the same canonical-JSON projection — otherwise idempotency breaks.
 *
 * Determinism contract:
 *   1. Object keys are sorted ALPHABETICALLY (not insertion order).
 *   2. `undefined` properties are NOT serialized (matches JSON.stringify).
 *   3. Arrays keep their order (sorting would be semantics-destroying).
 *   4. Numbers with `NaN`/`Infinity` → throw an error (no silent coerce to null).
 *   5. `Date` → ISO string (for consistency with the JSON.stringify standard).
 *   6. Output is always UTF-8 sha256 in lowercase hex.
 *
 * Performance: O(n log n) due to the key sort. Negligible for chat payloads
 * (<10KB JSON) (<1ms on M-class).
 */

import { createHash } from 'node:crypto';

/** Values that canonicalJson accepts. `unknown` for objects/arrays. */
export type CanonicalValue =
  | string
  | number
  | boolean
  | null
  | CanonicalValue[]
  | { [k: string]: CanonicalValue | undefined };

/**
 * Produces a deterministic JSON representation for hashing.
 *
 * Note: this is NOT the value that goes into the DB field — the DB value is
 * `JSON.stringify(payload)`. This function returns the variant over which
 * the hash is built, with sorted keys.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/**
 * Walk + re-build with sorted keys. `undefined` is stripped (matches
 * standard JSON.stringify behavior — `{a:1,b:undefined}` → `{"a":1}`).
 */
function canonicalize(value: unknown): unknown {
  if (value === null || value === undefined) return value === undefined ? undefined : null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`canonicalJson: non-finite number is not stable (${value})`);
    }
    return value;
  }
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((v) => canonicalize(v));
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    const keys = Object.keys(obj).sort();
    for (const k of keys) {
      const v = canonicalize(obj[k]);
      // Matches JSON.stringify: undefined keys are omitted.
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
  // Functions, symbols, bigints — we throw explicitly so no
  // silent data loss slips into the audit trail.
  throw new Error(`canonicalJson: unsupported value type "${typeof value}"`);
}

/**
 * sha256(canonicalJson(value)) → 64-char lowercase hex string.
 *
 * Never take `JSON.stringify` directly for the hash — otherwise the key order
 * depends on the insertion order and the hash changes on
 * every serialization variation.
 */
export function contentHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}
