/**
 * counter-evidence Surface-Parser Tests (E4.3, P13, 2026-05-27).
 *
 * Run:
 *   NODE_OPTIONS="--experimental-require-module" \
 *     node_modules/.bin/vitest run lib/chat/__tests__/counter-evidence-parse.test.ts
 *
 * Sicherstellen, dass `counter-evidence` als first-class Surface-Kind
 * erkannt wird (Whitelist + Stream-Parser + Coord-Extraktion).
 */

import { describe, expect, it } from 'vitest';

import {
  SURFACE_KINDS,
  parseSurfaceStream,
  extractWorkstreamCoords,
  type ParsedChunk,
} from '../surface-parser';

async function* once(s: string): AsyncIterable<string> {
  yield s;
}

async function collect(s: string): Promise<ParsedChunk[]> {
  const out: ParsedChunk[] = [];
  for await (const c of parseSurfaceStream(once(s))) out.push(c);
  return out;
}

describe('counter-evidence surface kind', () => {
  it('ist in der SURFACE_KINDS-Whitelist', () => {
    expect((SURFACE_KINDS as readonly string[]).includes('counter-evidence')).toBe(
      true,
    );
  });

  it('wird vom Stream-Parser als surface-chunk erkannt (nicht als Text)', async () => {
    const payload = {
      verdict: 'falsifiable',
      counterEvidenceCount: 3,
      unfalsifiable: false,
      text: '## Counter-Evidence\n### Counter 1: Foo\nBar.',
    };
    const tag = `<surface:counter-evidence>${JSON.stringify(
      payload,
    )}</surface:counter-evidence>`;
    const chunks = await collect(tag);

    const surface = chunks.find((c) => c.type === 'surface');
    expect(surface).toBeDefined();
    if (surface && surface.type === 'surface') {
      expect(surface.kind).toBe('counter-evidence');
      const data = surface.data as Record<string, unknown>;
      expect(data.verdict).toBe('falsifiable');
      expect(data.counterEvidenceCount).toBe(3);
    }
  });

  it('extrahiert workstreamId-Coords für die counter-evidence-Card', () => {
    const tag = `<surface:counter-evidence>${JSON.stringify({
      workstreamId: '01J0000000000000000000000A',
      verdict: 'unfalsifiable',
      unfalsifiable: true,
    })}</surface:counter-evidence>`;
    const coords = extractWorkstreamCoords(tag);
    expect(coords).not.toBeNull();
    expect(coords?.surfaceKind).toBe('counter-evidence');
    expect(coords?.workstreamId).toBe('01J0000000000000000000000A');
  });
});
