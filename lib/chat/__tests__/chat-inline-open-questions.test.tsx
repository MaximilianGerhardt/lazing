/**
 * Tests für OpenQuestionsInlineRef + renderSurface('open-questions') (SP-8).
 *
 * SP-8 (2026-06) hat den interaktiven In-Bubble-Stepper (ChatInlineOpenQuestions)
 * abgeschafft. Eine `<surface:open-questions>`-Tag rendert jetzt den
 * NICHT-interaktiven Pointer `OpenQuestionsInlineRef` („↓ n offene Fragen —
 * unten beantworten"). Die EINZIGE Antwort-Surface ist die Bottom-Pill
 * (ChatOpenQuestionsPill via ActionDeck) — ein reply()-Pfad, kein Box-in-Box.
 *
 * Prüft:
 *   1. renderSurface('open-questions', …) rendert nicht-null für gültigen Payload.
 *   2. q-Feld wird korrekt auf text gemappt (Surface-Payload-Feld ist q).
 *   3. null bei fehlenden / leeren questions.
 *   4. OpenQuestionsInlineRef rendert den Pointer-Text + count<=0 → null.
 *   5. Der gerenderte Marker ist NICHT interaktiv (keine <button>-Elemente →
 *      keine zweite reply()-Surface im Feed).
 *
 * Run: NODE_OPTIONS='--experimental-require-module' npx vitest run lib/chat/__tests__/chat-inline-open-questions.test.tsx
 */

import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { describe, expect, it } from 'vitest';

import { renderSurface } from '../SurfaceRenderer';
import { OpenQuestionsInlineRef } from '../ChatInlineOpenQuestions';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mount(node: React.ReactNode): {
  container: HTMLElement;
  root: Root;
  cleanup: () => void;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<>{node}</>);
  });
  return {
    container,
    root,
    cleanup: () => {
      act(() => root.unmount());
      document.body.removeChild(container);
    },
  };
}

// ---------------------------------------------------------------------------
// 1. renderSurface integration — gibt OpenQuestionsInlineRef (Pointer) zurück
// ---------------------------------------------------------------------------

describe('renderSurface open-questions → OpenQuestionsInlineRef', () => {
  it('rendert nicht-null für gültigen Payload', () => {
    const out = renderSurface('open-questions', {
      questions: [{ id: 'q1', q: 'Testfrage?', options: ['Ja', 'Nein'] }],
    });
    expect(out).not.toBeNull();
  });

  it('workstreamId ist NICHT erforderlich', () => {
    const out = renderSurface('open-questions', {
      questions: [{ id: 'q1', q: 'Ohne WS?', options: ['A', 'B'] }],
    });
    expect(out).not.toBeNull();
  });

  it('gibt null zurück wenn questions fehlt', () => {
    const out = renderSurface('open-questions', { workstreamId: 'ws-1' });
    expect(out).toBeNull();
  });

  it('gibt null zurück wenn questions leer', () => {
    const out = renderSurface('open-questions', { questions: [] });
    expect(out).toBeNull();
  });

  it('mappt q-Feld korrekt auf text (Surface-Payload-Feld ist q, nicht text)', () => {
    // renderOpenQuestions mappt q → text; ohne korrektes Mapping wäre der
    // question-Count 0 und der Renderer gäbe null zurück.
    const out = renderSurface('open-questions', {
      questions: [{ id: 'q1', q: 'Nutzung von q-Feld?' }],
    });
    expect(out).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. Der gerenderte Marker ist NICHT interaktiv (keine zweite Antwort-Surface)
// ---------------------------------------------------------------------------

describe('open-questions Surface — nicht-interaktiver Pointer', () => {
  it('rendert KEINE Buttons (keine zweite reply()-Surface im Feed)', () => {
    const out = renderSurface('open-questions', {
      questions: [
        { id: 'q1', q: 'Welcher Markt?', options: ['DACH', 'EU'] },
        { id: 'q2', q: 'Welcher Kanal?', options: ['Email', 'Social'] },
      ],
    });
    const { container, cleanup } = mount(out);
    const buttons = container.querySelectorAll('button');
    expect(buttons.length).toBe(0);
    // Pointer-Text sichtbar.
    expect(container.textContent).toContain('offene');
    expect(container.textContent).toContain('unten beantworten');
    cleanup();
  });
});

// ---------------------------------------------------------------------------
// 3. OpenQuestionsInlineRef Komponenten-Vertrag
// ---------------------------------------------------------------------------

describe('OpenQuestionsInlineRef', () => {
  it('rendert Singular-Text bei count=1', () => {
    const { container, cleanup } = mount(<OpenQuestionsInlineRef count={1} />);
    expect(container.textContent).toContain('1 offene Frage');
    expect(container.textContent).toContain('unten beantworten');
    cleanup();
  });

  it('rendert Plural-Text bei count>1', () => {
    const { container, cleanup } = mount(<OpenQuestionsInlineRef count={3} />);
    expect(container.textContent).toContain('3 offene Fragen');
    cleanup();
  });

  it('rendert null bei count<=0', () => {
    const { container, cleanup } = mount(<OpenQuestionsInlineRef count={0} />);
    expect(container.querySelector('.open-q-ref')).toBeNull();
    cleanup();
  });
});
