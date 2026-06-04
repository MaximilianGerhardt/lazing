/**
 * lib/discovery-mode/__tests__/detect.test.ts
 * --------------------------------------------
 * Tests für lib/discovery-mode/detect.ts (10 Modi, N6 deterministisch).
 *
 * Abdeckung (Aufgaben-Pflicht):
 *   (a) je Modus ein klares Beispiel → korrekte Klassifikation
 *   (b) mehrdeutig → 'clarify' (nicht 'build')
 *   (c) Brainstorm-Phrase → 'brainstorm' nicht 'build' (§20.1)
 *
 * Run: `pnpm vitest run lib/discovery-mode/__tests__/detect.test.ts`
 */
import { describe, expect, it } from 'vitest';
import {
  detectDiscoveryMode,
  DISCOVERY_MODES,
  DEFAULT_DISCOVERY_MODE,
  shouldBlockDirectPlan,
  getDiscoveryModeMeta,
  NO_DIRECT_PLAN_MODES,
  type DiscoveryMode,
} from '../detect';

describe('detectDiscoveryMode — (a) je Modus ein klares Beispiel', () => {
  const cases: Array<{ mode: DiscoveryMode; text: string }> = [
    { mode: 'brainstorm', text: 'Lass uns mal brainstormen, welche Ideen wir für das Onboarding haben' },
    { mode: 'clarify', text: 'Was bedeutet eigentlich "Bridge" in diesem Kontext genau?' },
    { mode: 'extract_expertise', text: 'Wichtig ist immer, dass wir vor jedem Release unsere SOP für QA durchgehen — unsere Regel' },
    { mode: 'role_reverse_engineer', text: 'Welche Rolle und welche Skills braucht man, um diese Aufgabe zu übernehmen?' },
    { mode: 'simulate', text: 'Stell dir vor, ein Kunde beschwert sich — spiel mal durch, was der Support tun würde' },
    { mode: 'innovate', text: 'Wie können wir das grundlegend anders und innovativer denken, um uns zu differenzieren?' },
    { mode: 'plan_graph', text: 'Erstelle mir einen Plan mit den Schritten und Abhängigkeiten für das Projekt' },
    { mode: 'build', text: 'Implementiere jetzt die API und deploy sie danach' },
    { mode: 'review', text: 'Bitte review den Code und sag mir, was falsch ist und gib Feedback' },
    { mode: 'reconcile', text: 'Gleiche das Ergebnis mit unserer Vision ab — passt das zur Strategie und Erwartung?' },
  ];

  for (const c of cases) {
    it(`klassifiziert "${c.text.slice(0, 32)}…" als ${c.mode}`, () => {
      const r = detectDiscoveryMode(c.text);
      expect(r.mode).toBe(c.mode);
      expect(r.confidence).toBeGreaterThan(0);
      expect(r.signals.some((s) => s.mode === c.mode)).toBe(true);
    });
  }
});

describe('detectDiscoveryMode — (b) mehrdeutig → clarify, nicht build', () => {
  it('leere Eingabe → clarify, confidence 0', () => {
    expect(detectDiscoveryMode('').mode).toBe('clarify');
    expect(detectDiscoveryMode('   ').mode).toBe('clarify');
    expect(detectDiscoveryMode('').confidence).toBe(0);
  });

  it('zu kurze Eingabe ("bau das") → clarify (nicht build)', () => {
    const r = detectDiscoveryMode('bau das');
    expect(r.mode).toBe('clarify');
    expect(r.mode).not.toBe('build');
  });

  it('Eingabe ganz ohne Modus-Signal → clarify', () => {
    const r = detectDiscoveryMode('das ist heute echt schönes Wetter draußen');
    expect(r.mode).toBe('clarify');
    expect(r.confidence).toBe(0);
  });

  it('einzelnes schwaches Build-Verb in erkundendem Satz → NICHT build', () => {
    // "vielleicht könnten wir irgendwann mal etwas bauen" — ein build-Treffer,
    // aber inhaltlich offen. Confidence-Floor + Tie-Break dürfen NICHT build liefern.
    const r = detectDiscoveryMode('vielleicht könnten wir irgendwann mal etwas bauen');
    expect(r.mode).not.toBe('build');
  });

  it('non-string input → clarify, confidence 0', () => {
    // @ts-expect-error absichtlich falscher Typ für Robustheit
    const r = detectDiscoveryMode(null);
    expect(r.mode).toBe(DEFAULT_DISCOVERY_MODE);
    expect(r.confidence).toBe(0);
  });
});

describe('detectDiscoveryMode — (c) Brainstorm-Phrase ≠ build (§20.1)', () => {
  it('"Lass uns brainstormen ob wir eine App bauen sollten" → brainstorm', () => {
    // Enthält "App" + "bauen" (build-Signale) UND "brainstormen" (brainstorm).
    // §20.1: erkundender Modus muss gewinnen, NICHT build.
    const r = detectDiscoveryMode('Lass uns brainstormen, ob wir eine App bauen sollten');
    expect(r.mode).toBe('brainstorm');
    expect(r.mode).not.toBe('build');
  });

  it('"Spinnen wir mal: was wäre wenn wir alles neu bauen?" → brainstorm', () => {
    const r = detectDiscoveryMode('Spinnen wir mal — was wäre, wenn wir alles neu bauen?');
    expect(r.mode).toBe('brainstorm');
    expect(r.mode).not.toBe('build');
  });

  it('reiner Build-Befehl bleibt build (kein Over-Block)', () => {
    const r = detectDiscoveryMode('Implementiere die Migration und deploy sie');
    expect(r.mode).toBe('build');
  });
});

describe('Meta + Gate', () => {
  it('NO_DIRECT_PLAN_MODES = brainstorm/clarify/extract_expertise/innovate', () => {
    expect([...NO_DIRECT_PLAN_MODES].sort()).toEqual(
      ['brainstorm', 'clarify', 'extract_expertise', 'innovate'].sort(),
    );
  });

  it('shouldBlockDirectPlan stimmt mit mayPlanDirectly überein', () => {
    for (const m of DISCOVERY_MODES) {
      const meta = getDiscoveryModeMeta(m);
      expect(meta.mayPlanDirectly).toBe(!shouldBlockDirectPlan(m));
    }
  });

  it('build/plan_graph/review/reconcile dürfen direkt planen', () => {
    for (const m of ['build', 'plan_graph', 'review', 'reconcile'] as DiscoveryMode[]) {
      expect(shouldBlockDirectPlan(m)).toBe(false);
    }
  });

  it('jeder Modus hat Meta mit Label + Behavior', () => {
    for (const m of DISCOVERY_MODES) {
      const meta = getDiscoveryModeMeta(m);
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.behavior.length).toBeGreaterThan(0);
    }
  });
});

describe('Politeness-Toleranz', () => {
  it('führende Höflichkeit ändert den Modus nicht', () => {
    const bare = detectDiscoveryMode('review den Code und gib Feedback');
    const polite = detectDiscoveryMode('Hey, könntest du bitte den Code reviewen und Feedback geben?');
    expect(polite.mode).toBe(bare.mode);
    expect(polite.mode).toBe('review');
  });
});
