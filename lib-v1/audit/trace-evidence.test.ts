// SPDX-License-Identifier: GPL-3.0-or-later
// M-EVID-07 — trace-evidence skill tests.
// Authority: modules/W2/M-EVID-07/TRACE-EVIDENCE-SKILL-SPEC.md §4 (T1-T15).

import { describe, it, expect } from 'vitest';
import {
  computeContentHash,
  verifyTamperEvidence,
  assertTamperEvidence,
  TamperDetectedError,
  CanonicalSerializationError,
} from './trace-evidence';

describe('M-EVID-07 / trace-evidence', () => {
  it('T1: same input produces same hash 1000 times in a row (determinism)', () => {
    const payload = {
      kind: 'decision',
      rationale: 'Long rationale ' + 'x'.repeat(2000),
      evidence_refs: ['ev-01', 'ev-02', 'ev-03'],
      nested: { actor: 'agent', confidence: 0.93 },
    };
    const baseline = computeContentHash(payload);
    for (let i = 0; i < 1000; i++) {
      expect(computeContentHash(payload)).toBe(baseline);
    }
    expect(baseline).toMatch(/^[0-9a-f]{64}$/);
  });

  it('T2: single-byte mutation breaks the hash', () => {
    const payload = { body: 'hello', n: 42 };
    const row = { contentHash: computeContentHash(payload) };

    expect(verifyTamperEvidence(row, { body: 'Hello', n: 42 })).toBe(false);
    expect(verifyTamperEvidence(row, { body: 'hello', n: 43 })).toBe(false);
    expect(
      verifyTamperEvidence(row, { body: 'hello', n: 42, sneak: 'x' }),
    ).toBe(false);
    expect(verifyTamperEvidence(row, payload)).toBe(true);
  });

  it('T3: object-key order does not affect the hash', () => {
    const a = { x: 1, y: 2, nested: { a: 1, b: 2 } };
    const b = { nested: { b: 2, a: 1 }, y: 2, x: 1 };
    expect(computeContentHash(a)).toBe(computeContentHash(b));
  });

  it('T4: NFC vs combined unicode form normalizes identically', () => {
    const a = { greeting: 'café' };
    const b = { greeting: 'café' }; // NFD
    expect(computeContentHash(a)).toBe(computeContentHash(b));
  });

  it('T5: -0 vs 0 same hash', () => {
    expect(computeContentHash(-0)).toBe(computeContentHash(0));
  });

  it('T6: 1e10 vs 10000000000 canonical-equivalence', () => {
    expect(computeContentHash(1e10)).toBe(computeContentHash(10000000000));
  });

  it('T7: array order DOES affect hash (N1 — arrays preserve order)', () => {
    expect(computeContentHash([1, 2, 3])).not.toBe(computeContentHash([3, 2, 1]));
  });

  it('T8: empty object stable hash', () => {
    const h1 = computeContentHash({});
    const h2 = computeContentHash({});
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('T9: deeply nested 10-deep structure stable on 100 repeats', () => {
    let nested: Record<string, unknown> = { leaf: 'value' };
    for (let i = 0; i < 10; i++) nested = { child: nested };
    const baseline = computeContentHash(nested);
    for (let i = 0; i < 100; i++) {
      expect(computeContentHash(nested)).toBe(baseline);
    }
  });

  it('T12: throws on cyclic input', () => {
    const cyc: Record<string, unknown> = { a: 1 };
    cyc.self = cyc;
    expect(() => computeContentHash(cyc)).toThrow(CanonicalSerializationError);
  });

  it('T13: throws on undefined field values', () => {
    expect(() => computeContentHash({ a: undefined })).toThrow(
      CanonicalSerializationError,
    );
  });

  it('T14: assertTamperEvidence throws TamperDetectedError with context', () => {
    const payload = { x: 1 };
    const row = { contentHash: computeContentHash(payload) };
    expect(() =>
      assertTamperEvidence(row, { x: 2 }, { rowKind: 'ledger', rowId: 'r_1' }),
    ).toThrow(TamperDetectedError);
    // success path
    expect(() =>
      assertTamperEvidence(row, payload, { rowKind: 'ledger', rowId: 'r_1' }),
    ).not.toThrow();
  });

  it('T15: output regex ^[0-9a-f]{64}$ for 100 random payloads', () => {
    for (let i = 0; i < 100; i++) {
      const payload = {
        i,
        body: `payload-${i}-${Math.random()}`,
        nested: { v: Math.random() },
      };
      expect(computeContentHash(payload)).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
