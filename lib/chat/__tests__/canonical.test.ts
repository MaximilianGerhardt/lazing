/**
 * Tests für lib/chat/canonical.ts (BACKPORT-01 · 2026-05-23).
 *
 * Beweist N10-Determinism: gleicher Payload → gleicher Hash, unabhängig
 * von Key-Insertion-Order oder undefined-Properties.
 */

import { describe, expect, it } from 'vitest';

import { canonicalJson, contentHash } from '../canonical';

describe('canonicalJson', () => {
  it('sorts object keys alphabetically', () => {
    const a = canonicalJson({ b: 1, a: 2, c: 3 });
    const b = canonicalJson({ c: 3, a: 2, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":2,"b":1,"c":3}');
  });

  it('strips undefined properties (matches JSON.stringify)', () => {
    expect(canonicalJson({ a: 1, b: undefined, c: 3 })).toBe('{"a":1,"c":3}');
  });

  it('preserves array order (semantic)', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });

  it('serialises Date as ISO string', () => {
    const d = new Date('2026-05-23T12:00:00.000Z');
    expect(canonicalJson({ at: d })).toBe('{"at":"2026-05-23T12:00:00.000Z"}');
  });

  it('throws on NaN / Infinity (no silent coerce)', () => {
    expect(() => canonicalJson({ x: NaN })).toThrow(/non-finite/);
    expect(() => canonicalJson({ x: Infinity })).toThrow(/non-finite/);
  });

  it('handles nested objects with sorted keys recursively', () => {
    const a = canonicalJson({ outer: { z: 1, a: 2 }, alpha: 'x' });
    const b = canonicalJson({ alpha: 'x', outer: { a: 2, z: 1 } });
    expect(a).toBe(b);
  });

  it('throws on function / symbol values', () => {
    expect(() => canonicalJson({ f: () => 1 })).toThrow(/unsupported/);
  });
});

describe('contentHash', () => {
  it('produces 64-char lowercase hex', () => {
    const h = contentHash({ a: 1 });
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable across key-reorder', () => {
    const h1 = contentHash({ a: 1, b: 'two', c: [3, 4, 5] });
    const h2 = contentHash({ c: [3, 4, 5], b: 'two', a: 1 });
    expect(h1).toBe(h2);
  });

  it('changes when any leaf changes', () => {
    const h1 = contentHash({ a: 1, b: 2 });
    const h2 = contentHash({ a: 1, b: 3 });
    expect(h1).not.toBe(h2);
  });

  it('treats null and undefined differently (undefined is dropped)', () => {
    const h1 = contentHash({ a: 1, b: null });
    const h2 = contentHash({ a: 1, b: undefined });
    expect(h1).not.toBe(h2);
  });

  it('matches V2-reference vector for empty object', () => {
    // sha256("{}") in lowercase-hex.
    expect(contentHash({})).toBe(
      '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
    );
  });
});
