// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Maximilian Gerhardt
//
// M-EVID-07 — lazyos-trace-evidence skill implementation.
// N10 — Tamper-Evident Trace via sha256(canonicalize(payload)).
//
// Authority: modules/W2/M-EVID-07/TRACE-EVIDENCE-SKILL-SPEC.md
// Depends: lib/audit/canonical-json.ts (W3.H1 JCS RFC-8785)

import { createHash } from 'node:crypto';
import {
  canonicalize,
  CanonicalSerializationError as W3H1CanonicalError,
} from './canonical-json';

/**
 * N10 — compute the canonical content hash of any trace-tier payload.
 *
 * Implementation: sha256(canonicalize(payload)) where canonicalize is JCS
 * (RFC 8785). The output is the lower-case hex digest (64 chars).
 *
 * Deterministic across:
 *   - Node 20.x and 22.x (B-R7 mitigation).
 *   - Key order in JS objects.
 *   - NFC vs. combined unicode forms.
 *   - Number-spelling (-0 / 0, 1.0 / 1, 1e10 / 10000000000).
 *
 * Throws CanonicalSerializationError on inputs that JCS cannot represent
 * (functions, undefined values, BigInt without explicit hint, cycles).
 */
export function computeContentHash(payload: unknown): string {
  let canonical: string;
  try {
    canonical = canonicalize(payload);
  } catch (e) {
    // Wrap W3.H1 error in the M-EVID-07 code namespace.
    if (e instanceof W3H1CanonicalError) {
      throw new CanonicalSerializationError(e.message);
    }
    throw e;
  }
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Re-compute the hash over the supplied payload and compare against the row's
 * stored contentHash. Constant-time compare to avoid timing leaks on hot paths.
 */
export function verifyTamperEvidence<R extends { contentHash: string }>(
  row: R,
  payload: unknown,
): boolean {
  const expected = row.contentHash;
  const actual = computeContentHash(payload);
  return timingSafeEqualHex(expected, actual);
}

/**
 * Strict-mode variant — throws TamperDetectedError if hashes disagree. Use in
 * Slice-D Trace-UI on read, in Slice-C runtime when re-reading a ledger row
 * before referencing it, and in CI integrity-sweeps.
 */
export function assertTamperEvidence<R extends { contentHash: string }>(
  row: R,
  payload: unknown,
  context?: { rowKind: string; rowId: string },
): void {
  if (!verifyTamperEvidence(row, payload)) {
    throw new TamperDetectedError(
      `[N10] tamper detected on ${context?.rowKind ?? 'row'} ${
        context?.rowId ?? row.contentHash
      }`,
    );
  }
}

export class TamperDetectedError extends Error {
  readonly code = 'N10_TAMPER_DETECTED';
  constructor(message: string) {
    super(message);
    this.name = 'TamperDetectedError';
  }
}

export class CanonicalSerializationError extends Error {
  readonly code = 'M_EVID_07_CANONICAL_FAIL';
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalSerializationError';
  }
}

/** Constant-time hex compare. Returns false on length mismatch. */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
