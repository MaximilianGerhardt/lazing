/**
 * FsmGraph render tests — Pattern 4 Welle 2.3 (2026-05-01).
 *
 * Run: `npx tsx --test --test-force-exit app/workflows/_components/__tests__/FsmGraph.test.tsx`
 *
 * Wir nutzen `renderToStaticMarkup` (kein DOM benötigt). Die Tests prüfen
 * dass:
 *   - Alle States als <rect>-Knoten gerendert werden
 *   - Transitions als <path>-Edges gerendert werden
 *   - Initial-State 'start'-Marker bekommt
 *   - LLM-Slot 'fixed-prompt' eine stroke-dasharray bekommt
 *   - Active-State (--a-now) highlighted ist
 *   - Empty-State sauber rendert (keine States)
 */

'use client'; // Datei selbst ist nicht client-rendered, aber FsmGraph ist es.

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { FsmGraph } from '../FsmGraph';

function render(props: Parameters<typeof FsmGraph>[0]): string {
  return renderToStaticMarkup(React.createElement(FsmGraph, props));
}

describe('FsmGraph · render', () => {
  it('rendert alle States als rect + Labels', () => {
    const html = render({
      states: [
        {
          id: 'plan',
          label: 'Plan',
          llmSlot: 'free-inference',
          manualOverride: 'allow',
          transitions: [{ to: 'review', label: 'planV1 ready' }],
        },
        {
          id: 'review',
          label: 'Review',
          llmSlot: 'fixed-prompt',
          manualOverride: 'forbid',
          transitions: [{ to: '__terminal__', label: 'pass' }],
        },
      ],
      initialState: 'plan',
    });
    // Beide State-IDs erscheinen
    assert.match(html, /plan/);
    assert.match(html, /review/);
    // Beide State-Labels
    assert.match(html, /Plan/);
    assert.match(html, /Review/);
    // Mindestens 2 rect für die States
    const rectMatches = html.match(/<rect[^>]*\/>|<rect[^>]*>/g) ?? [];
    assert.ok(rectMatches.length >= 2, `expected >=2 rects, got ${rectMatches.length}`);
    // Transition-Edge als path
    assert.match(html, /<path[^>]*d="M /);
    // Terminal-Marker
    assert.match(html, /terminal/);
  });

  it('markiert initial-State mit "start"', () => {
    const html = render({
      states: [
        {
          id: 'plan',
          label: 'Plan',
          llmSlot: 'none',
          manualOverride: 'allow',
          transitions: [],
        },
      ],
      initialState: 'plan',
    });
    assert.match(html, /start/);
  });

  it('rendert fixed-prompt mit stroke-dasharray', () => {
    const html = render({
      states: [
        {
          id: 'critic',
          label: 'Critic',
          llmSlot: 'fixed-prompt',
          manualOverride: 'allow',
          transitions: [],
        },
      ],
      initialState: 'critic',
    });
    assert.match(html, /stroke-dasharray="4,3"/);
  });

  it('highlighted active-State', () => {
    const html = render({
      states: [
        {
          id: 'plan',
          label: 'Plan',
          llmSlot: 'free-inference',
          manualOverride: 'allow',
          transitions: [],
        },
      ],
      initialState: 'plan',
      activeStateId: 'plan',
    });
    // Active-fill enthält --a-now via color-mix
    assert.match(html, /--a-now/);
  });

  it('liefert empty-state bei leerer States-Liste', () => {
    const html = render({ states: [], initialState: 'foo' });
    assert.match(html, /keine States/i);
  });

  it('rendert dev-sprint mit allen 7 States', async () => {
    const def = (await import('@/lib/workflows/definitions/dev-sprint'))
      .devSprintWorkflow;
    const graphStates = def.states.map((s) => ({
      id: s.id,
      label: s.label,
      llmSlot: s.llmSlot,
      manualOverride: s.manualOverride,
      transitions: s.transitions.map((t) => ({ to: t.to, label: t.label })),
    }));
    const html = render({
      states: graphStates,
      initialState: def.initialState,
    });
    for (const s of def.states) {
      assert.match(html, new RegExp(s.id), `missing state ${s.id}`);
    }
  });
});
