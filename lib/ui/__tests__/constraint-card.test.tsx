/**
 * EnablerCard Tests (P15, 2026-05-01).
 *
 * Run: `npx tsx --test --test-force-exit lib/ui/__tests__/constraint-card.test.tsx`
 *
 * Wir verzichten auf React-DOM-Render (zusätzliche Test-Lib) und prüfen
 * stattdessen die Element-Tree-Struktur, die React.createElement liefert.
 * Das ist robust gegen Style-Detail-Änderungen und reicht um die Color-/
 * Severity-Mapping + Pflicht-Texte zu verifizieren.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  EnablerCard,
  type EnablerSeverity,
} from '../constraint-card';

function render(severity: EnablerSeverity, extra: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(
    EnablerCard({
      finding: 'Test-Finding ohne RLS',
      consequence: 'Trust-Zone für externe Reviewer',
      severity,
      ...extra,
    }) as React.ReactElement,
  );
}

describe('EnablerCard · severity-Mapping', () => {
  it('info: enthält "Hinweis"-Pill und blau-getönten Background', () => {
    const html = render('info');
    assert.match(html, /Hinweis/);
    assert.match(html, /#2563eb/);
    // Kein "Error" oder "Warnung":
    assert.doesNotMatch(html, /Error/i);
    assert.doesNotMatch(html, /✕/);
  });

  it('opportunity: enthält "Hebel"-Pill und grünen Tönung', () => {
    const html = render('opportunity');
    assert.match(html, /Hebel/);
    assert.match(html, /#1f9d55/);
  });

  it('gate: enthält "Quality-Gate"-Pill und gelb-getönten Background', () => {
    const html = render('gate');
    assert.match(html, /Quality-Gate/);
    assert.match(html, /#c98a00/);
    // Wichtig: KEIN "Blocked"-Wording:
    assert.doesNotMatch(html, /Blocked/i);
  });
});

describe('EnablerCard · Pflicht-Texte', () => {
  it('Headline beginnt mit "Diese Auflage öffnet dir"', () => {
    const html = render('opportunity');
    assert.match(html, /Diese Auflage öffnet dir Trust-Zone/);
  });

  it('rendert finding-Text', () => {
    const html = render('info');
    assert.match(html, /Test-Finding ohne RLS/);
  });

  it('rendert trustScoreImpact wenn gegeben', () => {
    const html = render('opportunity', { trustScoreImpact: 12 });
    assert.match(html, /\+12 Trust/);
    assert.match(html, /Wenn erfüllt/);
  });

  it('rendert KEIN Trust-Pill ohne trustScoreImpact', () => {
    const html = render('info');
    assert.doesNotMatch(html, /Wenn erfüllt/);
  });

  it('rendert source wenn gegeben', () => {
    const html = render('gate', { source: 'compliance-advisor' });
    assert.match(html, /compliance-advisor/);
  });

  it('rendert hint wenn gegeben', () => {
    const html = render('info', { hint: 'Migration vorbereitet' });
    assert.match(html, /Migration vorbereitet/);
  });

  it('aria-label spiegelt severity-Label + consequence', () => {
    const html = render('gate');
    assert.match(html, /aria-label="Quality-Gate: Trust-Zone für externe Reviewer"/);
  });
});

describe('EnablerCard · Anti-Error-Sprache', () => {
  it('enthält in keiner Severity das Wort "Error"', () => {
    for (const sev of ['info', 'opportunity', 'gate'] as const) {
      const html = render(sev);
      assert.doesNotMatch(html, /\bError\b/, `severity=${sev}`);
    }
  });

  it('enthält in keiner Severity ein ✕- oder ❌-Icon', () => {
    for (const sev of ['info', 'opportunity', 'gate'] as const) {
      const html = render(sev);
      assert.doesNotMatch(html, /[✕❌]/, `severity=${sev}`);
    }
  });

  it('enthält in keiner Severity das Wort "Blocked"', () => {
    for (const sev of ['info', 'opportunity', 'gate'] as const) {
      const html = render(sev);
      assert.doesNotMatch(html, /Blocked/i, `severity=${sev}`);
    }
  });
});
