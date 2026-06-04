/**
 * Tests für lib/flow/interpolate.ts (Self-Learning Slice 2, pure/N6).
 */
import { describe, expect, it } from 'vitest';

import {
  interpolateParams,
  interpolateConfigJson,
  sanitizeParamValues,
} from '../interpolate';

describe('interpolateParams', () => {
  it('ersetzt {{param.key}} durch den Wert', () => {
    expect(interpolateParams('Reel über {{param.topic}}', { topic: 'Solar' })).toBe(
      'Reel über Solar',
    );
  });

  it('Arrays werden komma-separiert', () => {
    expect(interpolateParams('Poste auf {{param.targets}}', { targets: ['instagram', 'tiktok'] })).toBe(
      'Poste auf instagram, tiktok',
    );
  });

  it('mehrere Platzhalter + Zahlen/Booleans', () => {
    expect(
      interpolateParams('{{param.a}} x {{param.n}} ({{param.flag}})', { a: 'X', n: 3, flag: true }),
    ).toBe('X x 3 (true)');
  });

  it('unbekannter Param bleibt sichtbar stehen (fail-visible)', () => {
    expect(interpolateParams('Hallo {{param.unknown}}', { topic: 'x' })).toBe('Hallo {{param.unknown}}');
  });

  it('No-Op ohne Platzhalter / ohne Params (kein Regress)', () => {
    expect(interpolateParams('nichts zu tun', { a: '1' })).toBe('nichts zu tun');
    expect(interpolateParams('{{param.a}}', undefined)).toBe('{{param.a}}');
  });

  it('löst {{step.*}} NICHT auf (spätere Slice — bleibt stehen)', () => {
    expect(interpolateParams('{{step.x.output.y}}', { x: '1' })).toBe('{{step.x.output.y}}');
  });
});

describe('interpolateConfigJson', () => {
  it('interpoliert im JSON-String, null bleibt null', () => {
    expect(interpolateConfigJson('{"prompt":"{{param.topic}}"}', { topic: 'Solar' })).toBe(
      '{"prompt":"Solar"}',
    );
    expect(interpolateConfigJson(null, { topic: 'x' })).toBeNull();
  });
});

describe('sanitizeParamValues', () => {
  it('akzeptiert string/number/boolean/string[] und filtert Müll', () => {
    expect(
      sanitizeParamValues({ a: 'x', n: 3, flag: true, arr: ['a', 1, 'b'], obj: {}, 'bad key': 'y' }),
    ).toEqual({ a: 'x', n: 3, flag: true, arr: ['a', 'b'] });
  });

  it('Nicht-Objekt → {}', () => {
    expect(sanitizeParamValues(null)).toEqual({});
    expect(sanitizeParamValues('x')).toEqual({});
  });
});
