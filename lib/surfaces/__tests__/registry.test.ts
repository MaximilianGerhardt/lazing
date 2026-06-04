/**
 * Surface Library · Registry-Tests (Flow Studio P4 · 2026-05-27)
 * =============================================================
 * Gate fuer die Vollstaendigkeit + Konsistenz der Surface-Library:
 *
 *   • KEIN Loch: jeder SURFACE_KINDS-Eintrag hat Meta (getSurfaceMeta ≠ null)
 *     und der Round-Trip kind→meta.kind stimmt.
 *   • Kategorien sind aus der erlaubten Menge.
 *   • Beispielhafte fachliche Einordnungen stimmen.
 *   • listSurfacesByCategory liefert nicht-leer fuer Kern-Kategorien.
 *   • getSurfaceMeta ist tolerant gegen Unsinn (null, kein Throw).
 *
 * Compile-time-Vollstaendigkeit (Record<SurfaceKind, …>) wird zusaetzlich
 * vom tsc-Gate bewiesen; dieser Test sichert die *Runtime*-Seite.
 */

import { describe, it, expect } from 'vitest';
import { SURFACE_KINDS } from '@/lib/chat/surface-parser';
import {
  SURFACE_LIBRARY,
  SURFACE_CATEGORIES,
  getSurfaceMeta,
  listSurfacesByCategory,
  listAllSurfaces,
  type SurfaceCategory,
} from '@/lib/surfaces/registry';

describe('Surface Library registry', () => {
  it('hat fuer JEDEN SURFACE_KINDS-Eintrag Meta (kein Loch)', () => {
    for (const kind of SURFACE_KINDS) {
      const meta = getSurfaceMeta(kind);
      expect(meta, `fehlende Meta fuer kind="${kind}"`).not.toBeNull();
      expect(meta?.kind).toBe(kind);
    }
  });

  it('deckt genau die SURFACE_KINDS ab (keine extra-Eintraege, kein Loch)', () => {
    const libKinds = Object.keys(SURFACE_LIBRARY).sort();
    const parserKinds = [...SURFACE_KINDS].sort();
    expect(libKinds).toEqual(parserKinds);
  });

  it('jede Meta traegt eine gueltige Kategorie', () => {
    for (const kind of SURFACE_KINDS) {
      const meta = getSurfaceMeta(kind)!;
      expect(SURFACE_CATEGORIES).toContain(meta.category);
    }
  });

  it('jede Meta hat nicht-leeres label + description und bool interactive', () => {
    for (const kind of SURFACE_KINDS) {
      const meta = getSurfaceMeta(kind)!;
      expect(typeof meta.label).toBe('string');
      expect(meta.label.length).toBeGreaterThan(0);
      expect(typeof meta.description).toBe('string');
      expect(meta.description.length).toBeGreaterThan(0);
      expect(typeof meta.interactive).toBe('boolean');
    }
  });

  it('emitsSecret ist — wenn gesetzt — immer false (Secret-Invariante)', () => {
    for (const kind of SURFACE_KINDS) {
      const meta = getSurfaceMeta(kind)!;
      if (meta.emitsSecret !== undefined) {
        expect(meta.emitsSecret).toBe(false);
      }
    }
  });

  it('listAllSurfaces deckt vollstaendig in kanonischer Reihenfolge', () => {
    const all = listAllSurfaces();
    expect(all.map((m) => m.kind)).toEqual([...SURFACE_KINDS]);
  });

  it('konkrete fachliche Einordnungen stimmen', () => {
    expect(getSurfaceMeta('flow-graph')?.category).toBe('flow');
    expect(getSurfaceMeta('subplan')?.category).toBe('flow');
    expect(getSurfaceMeta('preview')?.category).toBe('status');
    expect(getSurfaceMeta('workflow')?.category).toBe('progress');
    expect(getSurfaceMeta('prompt')?.category).toBe('prompt');
    expect(getSurfaceMeta('connector-call-preview')?.category).toBe('tool');
    expect(getSurfaceMeta('document')?.category).toBe('data');
  });

  it('Credential-/Connector-Surfaces sind als emitsSecret:false dokumentiert', () => {
    for (const kind of [
      'credential-request',
      'credential-prompt',
      'connector-call-preview',
    ] as const) {
      expect(getSurfaceMeta(kind)?.emitsSecret).toBe(false);
    }
  });

  it('listSurfacesByCategory liefert nicht-leer fuer Kern-Kategorien', () => {
    for (const cat of ['progress', 'prompt'] as SurfaceCategory[]) {
      const list = listSurfacesByCategory(cat);
      expect(list.length).toBeGreaterThan(0);
      list.forEach((m) => expect(m.category).toBe(cat));
    }
  });

  it('listSurfacesByCategory: Summe ueber alle Kategorien == alle Kinds', () => {
    const total = SURFACE_CATEGORIES.reduce(
      (acc, cat) => acc + listSurfacesByCategory(cat).length,
      0,
    );
    expect(total).toBe(SURFACE_KINDS.length);
  });

  it('getSurfaceMeta ist tolerant gegen unbekannten/leeren Input', () => {
    expect(getSurfaceMeta('does-not-exist')).toBeNull();
    expect(getSurfaceMeta('')).toBeNull();
    expect(getSurfaceMeta('toString')).toBeNull();
    expect(getSurfaceMeta('__proto__')).toBeNull();
  });
});
