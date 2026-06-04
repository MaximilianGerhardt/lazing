/**
 * Tests fuer ChatInlineOpenQuestions Stepper (Bug-Fix UX1 · 2026-05-25).
 *
 * Prueft:
 *   1. renderSurface('open-questions', ...) rendert ChatInlineOpenQuestions
 *      (kein null, kein OpenQuestionsSurface).
 *   2. renderSurface ohne workstreamId funktioniert weiterhin (Stepper
 *      braucht keine workstreamId — reply() uebernimmt das Absenden).
 *   3. Option-Klick loest KEIN reply() aus (kein Chat-Turn).
 *   4. Finaler Submit ("Antworten absenden") ruft reply() GENAU EINMAL auf.
 *   5. Das Payload enthaelt alle beantworteten Fragen als Q&A-Liste.
 *   6. Nach Submit ist kein zweiter Submit moeglich (submitted-Lock).
 *
 * Run: NODE_OPTIONS='--experimental-require-module' npx vitest run lib/chat/__tests__/chat-inline-open-questions.test.tsx
 */

import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { renderSurface } from '../SurfaceRenderer';
import { ChatInlineOpenQuestions } from '../ChatInlineOpenQuestions';
import { SurfaceActionProvider } from '../SurfaceActionContext';
import type { PlanQuestion } from '../../workstreams/parse-plan-questions';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const Q_WITH_OPTIONS: PlanQuestion = {
  id: 'q1',
  text: 'Welcher Markt ist Prioritaet?',
  options: ['DACH', 'EU', 'USA'],
};

const Q_WITH_OPTIONS_2: PlanQuestion = {
  id: 'q2',
  text: 'Welcher Kanal zuerst?',
  options: ['Email', 'Social', 'Direct'],
};

const TWO_QUESTIONS = [Q_WITH_OPTIONS, Q_WITH_OPTIONS_2];

/** Mount component + return helpers. */
function mountStepper(
  questions: PlanQuestion[],
  // biome-ignore lint: test helper accepts any callable
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  replyFn: Function,
): { container: HTMLElement; root: Root; cleanup: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <SurfaceActionProvider reply={replyFn as (text: string) => void} pushAssistant={() => undefined}>
        <ChatInlineOpenQuestions questions={questions} />
      </SurfaceActionProvider>,
    );
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

function clickButton(container: HTMLElement, text: string): void {
  const btns = Array.from(container.querySelectorAll('button'));
  // Match by textContent OR aria-label (fuer Navigations-Buttons mit Symbolen)
  const btn = btns.find(
    (b) =>
      b.textContent?.trim().includes(text) ||
      b.getAttribute('aria-label')?.includes(text),
  );
  if (!btn) throw new Error(`Button mit Text/aria-label "${text}" nicht gefunden`);
  act(() => {
    btn.click();
  });
}

// ---------------------------------------------------------------------------
// 1. renderSurface integration — gibt ChatInlineOpenQuestions zurueck
// ---------------------------------------------------------------------------

describe('renderSurface open-questions → ChatInlineOpenQuestions', () => {
  it('rendert nicht-null fuer gueltigen Payload', () => {
    const out = renderSurface('open-questions', {
      questions: [{ id: 'q1', q: 'Testtfrage?', options: ['Ja', 'Nein'] }],
    });
    expect(out).not.toBeNull();
  });

  it('workstreamId ist NICHT erforderlich (Stepper braucht ihn nicht)', () => {
    // Kein workstreamId im Payload — renderOpenQuestions darf trotzdem rendern.
    const out = renderSurface('open-questions', {
      questions: [{ id: 'q1', q: 'Ohne WS?', options: ['A', 'B'] }],
    });
    expect(out).not.toBeNull();
  });

  it('gibt null zurueck wenn questions fehlt', () => {
    const out = renderSurface('open-questions', { workstreamId: 'ws-1' });
    expect(out).toBeNull();
  });

  it('gibt null zurueck wenn questions leer', () => {
    const out = renderSurface('open-questions', { questions: [] });
    expect(out).toBeNull();
  });

  it('mappt q-Feld korrekt auf text (Surface-Payload-Feld ist q, nicht text)', () => {
    // renderOpenQuestions mappt q → text fuer PlanQuestion.
    // Wenn das fehl schlaegt, wuerde questions.length === 0 und null zurueck kommen.
    const out = renderSurface('open-questions', {
      questions: [{ id: 'q1', q: 'Nutzung von q-Feld?' }],
    });
    expect(out).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. Stepper-Verhalten: Klick → kein Chat-Turn
// ---------------------------------------------------------------------------

describe('ChatInlineOpenQuestions — Option-Klick loest kein reply() aus', () => {
  let replyMock: ReturnType<typeof vi.fn>;
  let cleanup: () => void;
  let container: HTMLElement;

  beforeEach(() => {
    replyMock = vi.fn<(text: string) => void>();
    const mounted = mountStepper([Q_WITH_OPTIONS], replyMock);
    container = mounted.container;
    cleanup = mounted.cleanup;
  });

  afterEach(() => cleanup());

  it('reply() wird nach Option-Klick NICHT aufgerufen', () => {
    clickButton(container, 'DACH');
    expect(replyMock).not.toHaveBeenCalled();
  });

  it('reply() wird nach mehreren Option-Klicks NICHT aufgerufen', () => {
    clickButton(container, 'DACH');
    clickButton(container, 'EU');
    clickButton(container, 'USA');
    expect(replyMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 3. Finaler Submit: reply() genau EINMAL, Payload korrekt
// ---------------------------------------------------------------------------

describe('ChatInlineOpenQuestions — Finaler Submit', () => {
  let replyMock: ReturnType<typeof vi.fn>;
  let cleanup: () => void;
  let container: HTMLElement;

  beforeEach(() => {
    replyMock = vi.fn<(text: string) => void>();
    const mounted = mountStepper([Q_WITH_OPTIONS], replyMock);
    container = mounted.container;
    cleanup = mounted.cleanup;
  });

  afterEach(() => cleanup());

  it('Submit-Button ist disabled bevor eine Antwort gewaehlt wurde', () => {
    const submitBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Antworten absenden'),
    );
    expect(submitBtn).toBeTruthy();
    expect(submitBtn!.hasAttribute('disabled')).toBe(true);
  });

  it('reply() wird nach Antwort + Submit GENAU EINMAL aufgerufen', () => {
    clickButton(container, 'DACH');
    expect(replyMock).not.toHaveBeenCalled(); // noch kein Submit

    clickButton(container, 'Antworten absenden');
    expect(replyMock).toHaveBeenCalledTimes(1);
  });

  it('Payload enthaelt Frage + Antwort als Q&A-Text', () => {
    clickButton(container, 'EU');
    clickButton(container, 'Antworten absenden');

    const payload: string = replyMock.mock.calls[0][0];
    expect(payload).toContain('Welcher Markt ist Prioritaet?');
    expect(payload).toContain('EU');
  });
});

// ---------------------------------------------------------------------------
// 4. Mehrere Fragen: alle Antworten gebuendelt in EINEM Submit
// ---------------------------------------------------------------------------

describe('ChatInlineOpenQuestions — Multi-Fragen gebundelt absenden', () => {
  let replyMock: ReturnType<typeof vi.fn>;
  let cleanup: () => void;
  let container: HTMLElement;

  beforeEach(() => {
    replyMock = vi.fn<(text: string) => void>();
    const mounted = mountStepper(TWO_QUESTIONS, replyMock);
    container = mounted.container;
    cleanup = mounted.cleanup;
  });

  afterEach(() => cleanup());

  it('reply() wird GENAU EINMAL aufgerufen auch bei 2 Fragen', () => {
    // Frage 1 beantworten
    clickButton(container, 'DACH');
    expect(replyMock).not.toHaveBeenCalled();

    // Zu Frage 2 navigieren
    clickButton(container, 'Nächste Frage');
    expect(replyMock).not.toHaveBeenCalled();

    // Frage 2 beantworten
    clickButton(container, 'Email');
    expect(replyMock).not.toHaveBeenCalled();

    // Finaler Submit
    clickButton(container, 'Antworten absenden');
    expect(replyMock).toHaveBeenCalledTimes(1);
  });

  it('Payload enthaelt beide Antworten in einem Text-Block', () => {
    clickButton(container, 'DACH');
    clickButton(container, 'Nächste Frage');
    clickButton(container, 'Social');
    clickButton(container, 'Antworten absenden');

    const payload: string = replyMock.mock.calls[0][0];
    // Beide Fragen + Antworten muessen im selben String sein
    expect(payload).toContain('Welcher Markt ist Prioritaet?');
    expect(payload).toContain('DACH');
    expect(payload).toContain('Welcher Kanal zuerst?');
    expect(payload).toContain('Social');
  });
});

// ---------------------------------------------------------------------------
// 5. Submitted-Lock: kein Doppel-Submit
// ---------------------------------------------------------------------------

describe('ChatInlineOpenQuestions — Submitted-Lock', () => {
  it('zweiter Submit-Klick ruft reply() kein zweites Mal auf', () => {
    const replyMock = vi.fn<(text: string) => void>();
    const { container, cleanup } = mountStepper([Q_WITH_OPTIONS], replyMock);

    clickButton(container, 'DACH');
    clickButton(container, 'Antworten absenden');
    // Nach dem Submit ist die Komponente im submitted-Zustand —
    // der Submit-Button verschwindet, kein weiterer Klick moeglich.
    // Wir versuchen einen zweiten Submit (falls Button noch da ist).
    try {
      clickButton(container, 'Antworten absenden');
    } catch {
      // Button nicht mehr da — das ist der erwartete Zustand.
    }

    expect(replyMock).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('reply wirft (sync) → submitted bleibt true, kein zweiter reply (M4)', () => {
    // Lock-vor-reply-Garantie: setSubmitted(true) läuft VOR reply(). Wenn
    // reply synchron wirft, ist die Komponente trotzdem im submitted-Zustand
    // (Button verschwindet), ein zweiter Submit ist unmöglich.
    const replyMock = vi.fn<(text: string) => void>(() => {
      throw new Error('reply boom');
    });
    const { container, cleanup } = mountStepper([Q_WITH_OPTIONS], replyMock);

    clickButton(container, 'DACH');
    // Erster Submit: reply wirft — der Klick-Handler schluckt nicht, aber
    // setSubmitted lief bereits davor. act() re-rendert in den done-Zustand.
    try {
      clickButton(container, 'Antworten absenden');
    } catch {
      // synchroner Throw aus reply — erwartet.
    }

    // Submit-Button darf nicht mehr existieren (submitted=true → done-Render).
    const submitBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Antworten absenden'),
    );
    expect(submitBtn).toBeUndefined();

    // Selbst wenn wir einen zweiten Submit erzwingen wollten: kein Button da.
    try {
      clickButton(container, 'Antworten absenden');
    } catch {
      // Button nicht mehr da — erwartet.
    }

    // reply wurde GENAU EINMAL aufgerufen (kein Doppel-Submit trotz throw).
    expect(replyMock).toHaveBeenCalledTimes(1);
    cleanup();
  });
});
