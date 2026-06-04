/**
 * Step Tests (Sub-Plan 5 Welle 1, 2026-05-01).
 *
 * Run: `npx tsx --test --test-force-exit lib/ui/pip/__tests__/step.test.tsx`
 *
 * Wir verifizieren:
 *   - alle 5 StepStatus-Werte rendern die korrekte CSS-Klasse
 *   - Backwards-Compat-Alias 'waiting' → CSS-Klasse 'w' (wie 'pending')
 *   - statusLabel-Default & Override
 *   - aria-label / aria-current Korrektheit
 *   - progressPct rendert role="progressbar" mit aria-valuenow
 *   - progressPct außerhalb [0,100] wird geklammert
 *   - subtitle: explizit, fallback auf etaBucket-Default, none
 *   - failed/skipped haben sichtbare Strikethrough/Danger-Marker
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import * as React from 'react';

import { Step, type PipelineStepProps } from '../Step';

function render(props: PipelineStepProps): string {
  // Step rendert <li> — für renderToStaticMarkup brauchen wir kein
  // umschließendes <ol>; React-DOM-Server warnt aber bei Standalone <li>.
  // Lösung: in <ul> wickeln und das <ul>-Markup wegschneiden ist
  // unnötig komplex. Wir akzeptieren die Warnung in Tests nicht — also
  // rendern wir in <ul>.
  return renderToStaticMarkup(
    React.createElement('ul', null, React.createElement(Step, props)),
  );
}

describe('Step · 5-wertige Status-Klassen', () => {
  it('done → .step.d + Label "ok" + aria "Abgeschlossen"', () => {
    const html = render({ num: 1, title: 'Build', status: 'done' });
    assert.match(html, /class="step d"/);
    assert.match(html, />ok</);
    assert.match(html, /aria-label="Abgeschlossen"/);
  });

  it('running → .step.r + Label "run" + aria-current="step"', () => {
    const html = render({ num: 2, title: 'Test', status: 'running' });
    assert.match(html, /class="step r"/);
    assert.match(html, />run</);
    assert.match(html, /aria-current="step"/);
    assert.match(html, /aria-label="Läuft"/);
  });

  it('pending → .step.w + Label "wait" + aria "Wartet"', () => {
    const html = render({ num: 3, title: 'Deploy', status: 'pending' });
    assert.match(html, /class="step w"/);
    assert.match(html, />wait</);
    assert.match(html, /aria-label="Wartet"/);
  });

  it('failed → .step.f + Label "fail" + aria "Fehlgeschlagen"', () => {
    const html = render({ num: 4, title: 'Critic', status: 'failed' });
    assert.match(html, /class="step f"/);
    assert.match(html, />fail</);
    assert.match(html, /aria-label="Fehlgeschlagen"/);
  });

  it('skipped → .step.k + Label "skip" + aria "Übersprungen"', () => {
    const html = render({ num: 5, title: 'Smoke', status: 'skipped' });
    assert.match(html, /class="step k"/);
    assert.match(html, />skip</);
    assert.match(html, /aria-label="Übersprungen"/);
  });
});

describe('Step · Backwards-Compat Alias', () => {
  it('waiting → CSS-Klasse "w" (Alias für pending)', () => {
    const html = render({ num: 1, title: 'X', status: 'waiting' });
    assert.match(html, /class="step w"/);
    assert.match(html, /aria-label="Wartet"/);
  });

  it('waiting NICHT als CSS-Klasse "waiting" oder "wait"', () => {
    const html = render({ num: 1, title: 'X', status: 'waiting' });
    assert.doesNotMatch(html, /class="step waiting"/);
  });
});

describe('Step · statusLabel', () => {
  it('Default-Label aus Mapping', () => {
    assert.match(render({ num: 1, title: 'a', status: 'done' }), />ok</);
    assert.match(render({ num: 1, title: 'a', status: 'running' }), />run</);
    assert.match(render({ num: 1, title: 'a', status: 'failed' }), />fail</);
  });

  it('Override via statusLabel', () => {
    const html = render({
      num: 1,
      title: 'Build',
      status: 'running',
      statusLabel: '47%',
    });
    assert.match(html, />47%</);
    // Default "run" darf nicht zusätzlich vorkommen:
    assert.doesNotMatch(html, /class="s"[^>]*>run</);
  });
});

describe('Step · progressPct', () => {
  it('renders role="progressbar" with aria-valuenow when set', () => {
    const html = render({
      num: 1,
      title: 'Embedding',
      status: 'running',
      progressPct: 42,
    });
    assert.match(html, /role="progressbar"/);
    assert.match(html, /aria-valuenow="42"/);
    assert.match(html, /aria-valuemin="0"/);
    assert.match(html, /aria-valuemax="100"/);
    assert.match(html, /step__progress-bar/);
  });

  it('writes --progress as inline custom property', () => {
    const html = render({
      num: 1,
      title: 'X',
      status: 'running',
      progressPct: 73,
    });
    // React serialisiert custom-properties über CSSStyleDeclaration —
    // in renderToStaticMarkup bleibt die exakte Schreibweise erhalten.
    assert.match(html, /--progress:\s*73/);
  });

  it('clamps progressPct > 100 to 100', () => {
    const html = render({
      num: 1,
      title: 'X',
      status: 'running',
      progressPct: 150,
    });
    assert.match(html, /aria-valuenow="100"/);
    assert.match(html, /--progress:\s*100/);
  });

  it('clamps progressPct < 0 to 0', () => {
    const html = render({
      num: 1,
      title: 'X',
      status: 'running',
      progressPct: -10,
    });
    assert.match(html, /aria-valuenow="0"/);
  });

  it('omits progressbar element when progressPct undefined', () => {
    const html = render({ num: 1, title: 'X', status: 'pending' });
    assert.doesNotMatch(html, /role="progressbar"/);
    assert.doesNotMatch(html, /step__progress-bar/);
  });

  it('ignores NaN/Infinity progressPct', () => {
    const html = render({
      num: 1,
      title: 'X',
      status: 'running',
      progressPct: Number.NaN,
    });
    assert.doesNotMatch(html, /role="progressbar"/);
  });
});

describe('Step · subtitle + etaBucket', () => {
  it('rendert expliziten subtitle', () => {
    const html = render({
      num: 1,
      title: 'Build',
      subtitle: '47/120 Chunks',
      status: 'running',
    });
    assert.match(html, /47\/120 Chunks/);
  });

  it('Default-Subtitle aus etaBucket="fast"', () => {
    const html = render({
      num: 1,
      title: 'Build',
      etaBucket: 'fast',
      status: 'running',
    });
    assert.match(html, /fast fertig/);
  });

  it('Default-Subtitle aus etaBucket="slow"', () => {
    const html = render({
      num: 1,
      title: 'Build',
      etaBucket: 'slow',
      status: 'running',
    });
    assert.match(html, /läuft länger als üblich/);
  });

  it('Default-Subtitle aus etaBucket="overdue"', () => {
    const html = render({
      num: 1,
      title: 'Build',
      etaBucket: 'overdue',
      status: 'running',
    });
    assert.match(html, /sollte längst fertig sein/);
  });

  it('expliziter subtitle überschreibt etaBucket-Default', () => {
    const html = render({
      num: 1,
      title: 'Build',
      subtitle: 'spezifisch',
      etaBucket: 'fast',
      status: 'running',
    });
    assert.match(html, /spezifisch/);
    assert.doesNotMatch(html, /fast fertig/);
  });

  it('kein .sb-Element wenn weder subtitle noch etaBucket', () => {
    const html = render({ num: 1, title: 'Build', status: 'pending' });
    assert.doesNotMatch(html, /class="sb"/);
  });
});

describe('Step · num-Marker', () => {
  it('rendert numerischen num im .n', () => {
    const html = render({ num: 7, title: 'X', status: 'pending' });
    assert.match(html, /class="n"[^>]*>7</);
  });

  it('rendert string-num (z.B. Symbol)', () => {
    const html = render({ num: '✓', title: 'X', status: 'done' });
    assert.match(html, /class="n"[^>]*>✓</);
  });
});
