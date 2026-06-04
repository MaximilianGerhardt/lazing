// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Maximilian Gerhardt
//
// W3.H1 — JCS (RFC 8785) canonicalization for Lazing trace-tier payloads.
//
// Produces a deterministic UTF-8 string for any JSON-serializable value.
// Output is identical regardless of:
//   - JS object key insertion order (sorted UTF-16 code-unit ascending).
//   - Original number spelling (-0/0, 1.0/1, 1e10/1e+10, trailing zeros).
//   - Unicode normalization form (NFC normalized).
//
// This is the *single* canonicalizer used by M-EVID-07 (computeContentHash).
// Never call JSON.stringify for trace-tier rows.
//
// Authority: modules/W3/W3.H1/CANONICAL-JSON-SERIALIZER-SPEC.md (BUG-FIX-1 applied).

import { createHash } from 'node:crypto';

export interface CanonicalizeOptions {
  /**
   * Coerce non-JCS-representable values (Date, BigInt, undefined fields).
   * Default: throw CanonicalSerializationError.
   *
   *   "throw"   → strict; throws on Date / BigInt / undefined fields / functions / cycles.
   *   "coerce"  → Date → toISOString(), BigInt → string, undefined-field → drop.
   */
  nonJsonStrategy?: 'throw' | 'coerce';
}

export type CanonicalErrorCode =
  | 'JCS_NON_JSON_VALUE'
  | 'JCS_CYCLIC_REFERENCE'
  | 'JCS_NON_FINITE_NUMBER'
  | 'JCS_INVALID_KEY';

export class CanonicalSerializationError extends Error {
  code: CanonicalErrorCode = 'JCS_NON_JSON_VALUE';
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalSerializationError';
  }
  withCode(code: CanonicalErrorCode): this {
    this.code = code;
    return this;
  }
}

const NFC = (s: string): string => s.normalize('NFC');

export function canonicalize(value: unknown): string {
  return canonicalizeWith(value);
}

export function canonicalizeWith(
  value: unknown,
  options: CanonicalizeOptions = {},
): string {
  const strategy = options.nonJsonStrategy ?? 'throw';
  const seen = new WeakSet<object>();
  return emit(value, seen, strategy);
}

/**
 * Alias retained for spec wording (`canonicalJSON` / `canonicalJson` is the
 * spelling used by W1.H1, W1.H2, W4.H1 consumers).
 */
export function canonicalJSON(value: unknown, options?: CanonicalizeOptions): string {
  return canonicalizeWith(value, options);
}
export const canonicalJson = canonicalJSON;

/**
 * Strip auto-increment / DDL-default-timestamp fields, then sha256 the
 * canonical-JSON. 64-char lowercase hex. Used by W1.H1 audit/insert and
 * W1.H2 audit/verify to write/verify the `content_hash` column (M9 DDLS §0).
 *
 * Strip set: `id`, `content_hash`, `created_at` (deterministic across
 * insert + verify time).
 */
const STRIPPED_FIELDS = new Set<string>(['id', 'content_hash', 'created_at']);

export function computeContentHash(
  row: Record<string, unknown>,
  options: CanonicalizeOptions = {},
): string {
  const stripped: Record<string, unknown> = {};
  for (const k of Object.keys(row)) {
    if (STRIPPED_FIELDS.has(k)) continue;
    const v = row[k];
    if (v === undefined) continue;
    stripped[k] = v;
  }
  const canonical = canonicalizeWith(stripped, options);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function emit(
  value: unknown,
  seen: WeakSet<object>,
  strategy: 'throw' | 'coerce',
): string {
  if (value === null) return 'null';

  const t = typeof value;
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'number') return emitNumber(value as number);
  if (t === 'string') return emitString(value as string);

  if (t === 'bigint') {
    if (strategy === 'coerce') return emitString(String(value));
    throw new CanonicalSerializationError(
      "BigInt not representable in JCS; use nonJsonStrategy='coerce' or convert at caller",
    ).withCode('JCS_NON_JSON_VALUE');
  }

  if (t === 'function' || t === 'symbol' || t === 'undefined') {
    throw new CanonicalSerializationError(
      `Value of type ${t} is not JSON-serializable`,
    ).withCode('JCS_NON_JSON_VALUE');
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) throw cyclicErr();
    seen.add(value);
    const parts = value.map((v) => emit(v ?? null, seen, strategy));
    seen.delete(value);
    return '[' + parts.join(',') + ']';
  }

  if (value instanceof Date) {
    if (strategy === 'coerce') return emitString(value.toISOString());
    throw new CanonicalSerializationError(
      'Date not representable in JCS; convert at caller (epoch int) or use coerce',
    ).withCode('JCS_NON_JSON_VALUE');
  }

  if (t === 'object') {
    if (seen.has(value as object)) throw cyclicErr();
    seen.add(value as object);

    const obj = value as Record<string, unknown>;
    // Collect keys, filter undefined-fields per strategy, sort by UTF-16 code units.
    const keys: string[] = [];
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (v === undefined) {
        if (strategy === 'coerce') continue;
        throw new CanonicalSerializationError(
          `Field ${JSON.stringify(k)} is undefined; not representable in JCS`,
        ).withCode('JCS_NON_JSON_VALUE');
      }
      keys.push(NFC(k));
    }
    keys.sort(); // default String < operator = UTF-16 code-unit ascending = JCS §3.2.3

    const parts = keys.map((k) => {
      // The key here was NFC-normalized above, but obj[k] uses the ORIGINAL key.
      // We must look up by original key — but we lost it. So instead, build a
      // map of NFC-key → original-key during the collection pass.
      const originalKey = findOriginalKey(obj, k);
      const v = obj[originalKey];
      return emitString(k) + ':' + emit(v, seen, strategy);
    });
    seen.delete(value as object);
    return '{' + parts.join(',') + '}';
  }

  throw new CanonicalSerializationError(`Unsupported type: ${t}`).withCode(
    'JCS_NON_JSON_VALUE',
  );
}

/**
 * Find the original key in `obj` that NFC-normalizes to `nfcKey`.
 * Fast path: nfcKey itself exists as-is in obj.
 */
function findOriginalKey(obj: Record<string, unknown>, nfcKey: string): string {
  if (Object.prototype.hasOwnProperty.call(obj, nfcKey)) return nfcKey;
  for (const k of Object.keys(obj)) {
    if (NFC(k) === nfcKey) return k;
  }
  return nfcKey; // fallback (shouldn't happen)
}

function emitNumber(n: number): string {
  if (!Number.isFinite(n)) {
    throw new CanonicalSerializationError(
      `Non-finite number ${n} is not representable in JCS`,
    ).withCode('JCS_NON_FINITE_NUMBER');
  }
  if (Object.is(n, -0)) return '0';
  // RFC-8785 §3.2.2.3 mandates ECMA-262 Number.prototype.toString().
  // JS default String(n) implements exactly that algorithm — no strip, no rewrite.
  // Examples: 1e21 → "1e+21", 0.1 → "0.1", 1 → "1", 1e-7 → "1e-7", 1e20 → "100000000000000000000".
  return String(n);
}

function emitString(s: string): string {
  const nfc = NFC(s);
  let out = '"';
  for (let i = 0; i < nfc.length; i++) {
    const c = nfc.charCodeAt(i);
    if (c === 0x22) out += '\\"';
    else if (c === 0x5c) out += '\\\\';
    else if (c === 0x08) out += '\\b';
    else if (c === 0x09) out += '\\t';
    else if (c === 0x0a) out += '\\n';
    else if (c === 0x0c) out += '\\f';
    else if (c === 0x0d) out += '\\r';
    else if (c < 0x20) out += '\\u' + c.toString(16).padStart(4, '0');
    else out += nfc[i];
  }
  return out + '"';
}

function cyclicErr(): CanonicalSerializationError {
  return new CanonicalSerializationError('cyclic reference').withCode(
    'JCS_CYCLIC_REFERENCE',
  );
}
