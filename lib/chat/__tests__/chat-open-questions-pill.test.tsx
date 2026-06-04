/**
 * Tests für ChatOpenQuestionsPill (UX-1 · 2026-05-26, Bottom-Action-UX).
 *
 * Prüft die controlled Q/A-Pill ÜBER dem Composer:
 *   1. Eingeklappt → Chip „n offene Fragen"; Klick ruft onToggleExpand(true).
 *   2. Ausgeklappt → aktuelle Frage + Optionen + Fortschritt „n/total".
 *   3. Options-Klick ruft onSelectOption(qId, option) (kein Doppel-Handler).
 *   4. Collapse-Button ruft onToggleExpand(false).
 *   5. Vor/Zurück ruft onNavigate(index).
 *   6. "Antworten absenden" ist disabled ohne Antwort, ruft sonst onSubmitAll.
 *   7. Freitext-Frage (keine Optionen) → Hinweis „unten eintippen", keine
 *      eigene Textarea (der Chat-Input ist das Antwortfeld).
 *
 * Run: NODE_OPTIONS='--experimental-require-module' npx vitest run lib/chat/__tests__/chat-open-questions-pill.test.tsx
 */

import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { describe, expect, it, vi, afterEach } from 'vitest';

import { ChatOpenQuestionsPill } from '../ChatOpenQuestionsPill';
import type { PlanQuestion } from '../../workstreams/parse-plan-questions';

const Q1: PlanQuestion = { id: 'q1', text: 'Welcher Markt?', options: ['DACH', 'EU', 'USA'] };
const Q2: PlanQuestion = { id: 'q2', text: 'Welcher Kanal?', options: ['Email', 'Social'] };
const Q_FREE: PlanQuestion = { id: 'qf', text: 'Beschreib das Ziel.' };

interface Handlers {
  onSelectOption: ReturnType<typeof vi.fn<(qId: string, option: string) => void>>;
  onNavigate: ReturnType<typeof vi.fn<(index: number) => void>>;
  onToggleExpand: ReturnType<typeof vi.fn<(expanded: boolean) => void>>;
  onSubmitAll: ReturnType<typeof vi.fn<() => void>>;
}

function mountPill(props: {
  questions: PlanQuestion[];
  answers?: Record<string, string>;
  currentIndex?: number;
  expanded: boolean;
  runActive?: boolean;
}): { container: HTMLElement; root: Root; handlers: Handlers; cleanup: () => void } {
  const handlers: Handlers = {
    onSelectOption: vi.fn<(qId: string, option: string) => void>(),
    onNavigate: vi.fn<(index: number) => void>(),
    onToggleExpand: vi.fn<(expanded: boolean) => void>(),
    onSubmitAll: vi.fn<() => void>(),
  };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <ChatOpenQuestionsPill
        questions={props.questions}
        answers={props.answers ?? {}}
        currentIndex={props.currentIndex ?? 0}
        expanded={props.expanded}
        onSelectOption={handlers.onSelectOption}
        onNavigate={handlers.onNavigate}
        onToggleExpand={handlers.onToggleExpand}
        onSubmitAll={handlers.onSubmitAll}
        runActive={props.runActive ?? false}
      />,
    );
  });
  return {
    container,
    root,
    handlers,
    cleanup: () => {
      act(() => root.unmount());
      document.body.removeChild(container);
    },
  };
}

function clickButton(container: HTMLElement, text: string): void {
  const btns = Array.from(container.querySelectorAll('button'));
  const btn = btns.find(
    (b) =>
      b.textContent?.trim().includes(text) ||
      b.getAttribute('aria-label')?.includes(text),
  );
  if (!btn) throw new Error(`Button "${text}" nicht gefunden`);
  act(() => {
    btn.click();
  });
}

let activeCleanup: (() => void) | null = null;
afterEach(() => {
  activeCleanup?.();
  activeCleanup = null;
});

describe('ChatOpenQuestionsPill — eingeklappt', () => {
  it('zeigt Chip „n offene Fragen" + Klick klappt aus', () => {
    const m = mountPill({ questions: [Q1, Q2], expanded: false });
    activeCleanup = m.cleanup;
    expect(m.container.textContent).toContain('2 offene Fragen');
    clickButton(m.container, '2 offene Fragen');
    expect(m.handlers.onToggleExpand).toHaveBeenCalledWith(true);
  });

  it('eingeklappt rendert KEINE Optionen (nur Chip)', () => {
    const m = mountPill({ questions: [Q1], expanded: false });
    activeCleanup = m.cleanup;
    expect(m.container.textContent).not.toContain('DACH');
  });
});

describe('ChatOpenQuestionsPill — ask-but-proceed-Signal (Workstream 4b)', () => {
  it('zeigt das „läuft weiter"-Label NUR wenn runActive (ausgeklappt)', () => {
    const m = mountPill({ questions: [Q1], expanded: true, runActive: true });
    activeCleanup = m.cleanup;
    // Frage bleibt sichtbar UND das ask-but-proceed-Label erscheint.
    expect(m.container.textContent).toContain('Welcher Markt?');
    expect(m.container.textContent).toContain('verfeinert den nächsten Schritt');
    expect(m.container.querySelector('.oq-pill-live-note')).not.toBeNull();
  });

  it('zeigt das Label NICHT wenn der Run idle ist (runActive=false)', () => {
    const m = mountPill({ questions: [Q1], expanded: true, runActive: false });
    activeCleanup = m.cleanup;
    expect(m.container.textContent).toContain('Welcher Markt?');
    expect(m.container.textContent).not.toContain('verfeinert den nächsten Schritt');
    expect(m.container.querySelector('.oq-pill-live-note')).toBeNull();
  });

  it('eingeklappt + runActive → Chip bleibt sichtbar mit live-Marker', () => {
    const m = mountPill({ questions: [Q1, Q2], expanded: false, runActive: true });
    activeCleanup = m.cleanup;
    // Owner-Symptom-Gegenprobe: bei aktivem Run + offener Frage ist die Pill
    // (hier als Chip) WEITER sichtbar — sie scrollt nicht weg.
    expect(m.container.textContent).toContain('2 offene Fragen');
    expect(m.container.querySelector('.oq-pill-chip--live')).not.toBeNull();
  });
});

describe('ChatOpenQuestionsPill — ausgeklappt', () => {
  it('zeigt aktuelle Frage + Optionen + Fortschritt n/total', () => {
    const m = mountPill({ questions: [Q1, Q2], expanded: true });
    activeCleanup = m.cleanup;
    expect(m.container.textContent).toContain('Welcher Markt?');
    expect(m.container.textContent).toContain('DACH');
    expect(m.container.textContent).toContain('1 / 2');
  });

  it('Options-Klick ruft onSelectOption(qId, option)', () => {
    const m = mountPill({ questions: [Q1, Q2], expanded: true });
    activeCleanup = m.cleanup;
    clickButton(m.container, 'EU');
    expect(m.handlers.onSelectOption).toHaveBeenCalledTimes(1);
    expect(m.handlers.onSelectOption).toHaveBeenCalledWith('q1', 'EU');
  });

  it('Collapse-Button ruft onToggleExpand(false)', () => {
    const m = mountPill({ questions: [Q1], expanded: true });
    activeCleanup = m.cleanup;
    clickButton(m.container, 'Einklappen');
    expect(m.handlers.onToggleExpand).toHaveBeenCalledWith(false);
  });

  it('Nächste-Frage-Chevron ruft onNavigate(index+1)', () => {
    const m = mountPill({ questions: [Q1, Q2], expanded: true, currentIndex: 0 });
    activeCleanup = m.cleanup;
    clickButton(m.container, 'Nächste Frage');
    expect(m.handlers.onNavigate).toHaveBeenCalledWith(1);
  });

  it('zeigt die durch currentIndex gewählte Frage', () => {
    const m = mountPill({ questions: [Q1, Q2], expanded: true, currentIndex: 1 });
    activeCleanup = m.cleanup;
    expect(m.container.textContent).toContain('Welcher Kanal?');
    expect(m.container.textContent).toContain('2 / 2');
  });

  it('bereits gewählte Antwort wird als Badge angezeigt', () => {
    const m = mountPill({
      questions: [Q1],
      answers: { q1: 'EU' },
      expanded: true,
    });
    activeCleanup = m.cleanup;
    // Badge mit aria-label "Gewählt: EU"
    const badge = m.container.querySelector('[aria-label="Gewählt: EU"]');
    expect(badge).toBeTruthy();
  });
});

describe('ChatOpenQuestionsPill — Absenden', () => {
  it('Absenden ist disabled ohne Antwort', () => {
    const m = mountPill({ questions: [Q1], expanded: true });
    activeCleanup = m.cleanup;
    const btn = Array.from(m.container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Antworten absenden'),
    );
    expect(btn?.hasAttribute('disabled')).toBe(true);
  });

  it('Absenden ruft onSubmitAll wenn ≥1 Frage beantwortet', () => {
    const m = mountPill({
      questions: [Q1, Q2],
      answers: { q1: 'DACH' },
      expanded: true,
    });
    activeCleanup = m.cleanup;
    clickButton(m.container, 'Antworten absenden');
    expect(m.handlers.onSubmitAll).toHaveBeenCalledTimes(1);
  });
});

describe('ChatOpenQuestionsPill — Freitext-Frage', () => {
  it('rendert KEINE Textarea (Chat-Input ist das Antwortfeld)', () => {
    const m = mountPill({ questions: [Q_FREE], expanded: true });
    activeCleanup = m.cleanup;
    expect(m.container.querySelector('textarea')).toBeNull();
    expect(m.container.textContent).toContain('eintippen');
  });
});

describe('ChatOpenQuestionsPill — leere Fragen', () => {
  it('rendert null bei 0 Fragen', () => {
    const m = mountPill({ questions: [], expanded: true });
    activeCleanup = m.cleanup;
    expect(m.container.querySelector('.oq-pill')).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Bug 2 (2026-05-30, Owner verbatim): „nicht als Fragen angeheftet, sondern
// als Auswahlmöglichkeiten … aber es muss IMMER die Möglichkeit geben, auch
// darauf zu antworten" (= Freitext, nicht nur Optionen klicken).
// ───────────────────────────────────────────────────────────────────────────
describe('ChatOpenQuestionsPill — Freitext IMMER möglich (auch mit Optionen)', () => {
  it('Frage MIT Optionen zeigt BEIDES: die Optionen UND den Freitext-Hinweis', () => {
    const m = mountPill({ questions: [Q1], expanded: true });
    activeCleanup = m.cleanup;
    // Optionen sind da …
    expect(m.container.querySelectorAll('.oq-pill-opt')).toHaveLength(3);
    // … UND der sichtbare Freitext-Pfad (kein aria-hidden mehr).
    const hint = m.container.querySelector('[data-test="oq-pill-freetext-hint"]');
    expect(hint).not.toBeNull();
    expect(hint?.getAttribute('aria-hidden')).toBeNull();
    expect(hint?.textContent).toContain('eigene Antwort');
    expect(m.container.querySelector('.oq-pill-freetext-hint--withopts')).not.toBeNull();
  });

  it('die Frage erscheint GENAU EINMAL — keine doppelte Frage-Zeile', () => {
    const m = mountPill({ questions: [Q1], expanded: true });
    activeCleanup = m.cleanup;
    const occurrences = m.container.querySelectorAll('.oq-pill-q-text');
    expect(occurrences).toHaveLength(1);
    // Der Frage-Text taucht als Frage auf, NICHT zusätzlich als nackte
    // Auswahl-Überschrift (Optionen tragen den Text nur als aria-label).
    const visibleQ = m.container.querySelector('.oq-pill-q-text span');
    expect(visibleQ?.textContent).toBe('Welcher Markt?');
  });

  it('Options-Klick und Freitext nutzen denselben Antwort-Pfad (onSelectOption)', () => {
    const m = mountPill({ questions: [Q1], expanded: true });
    activeCleanup = m.cleanup;
    // Options-Klick delegiert an onSelectOption (der Freitext-Pfad in ChatShell
    // ruft dieselbe routePillAnswer-Logik — hier verifiziert: kein zweiter
    // versteckter Submit-Handler in der Pill).
    const opt = m.container.querySelector<HTMLButtonElement>('.oq-pill-opt');
    act(() => opt!.click());
    expect(m.handlers.onSelectOption).toHaveBeenCalledWith('q1', 'DACH');
  });
});
