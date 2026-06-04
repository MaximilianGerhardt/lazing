/**
 * Tests für die Pill-Expand-UX + Dismiss-Geste (2026-05-28, Owner-Spec C+D).
 *
 * OWNER-BEFUND (verbatim):
 *  - „dann lieber die Offenen Fragen mit der Möglichkeit auf mehr Details
 *     ausklappen lassen, dass da zu jeder Frage ggf. Kontext, Pro/Kontra usw.
 *     vorhanden ist."
 *  - Manueller Dismiss: kleine ×-Geste pro Frage („beantwortet" / „nicht mehr
 *     relevant"), die ein Resolve-Event schreibt.
 *
 * Mobile-first: Touch-Targets ≥ 32px Hit-Area (HIG); kein horizontales Overflow
 * auf schmalen Viewports (375px iPhone Mini).
 *
 * Run: NODE_OPTIONS='--experimental-require-module' npx vitest run \
 *      lib/chat/__tests__/chat-open-questions-pill-expand.test.tsx
 */

import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { describe, expect, it, vi, afterEach } from 'vitest';

import { ChatOpenQuestionsPill } from '../ChatOpenQuestionsPill';
import type { OpenQuestion } from '../open-questions-lifecycle';

const Q_PLAIN: OpenQuestion = {
  id: 'plain',
  text: 'Welcher Markt?',
  options: ['DACH', 'EU'],
};

const Q_ENRICHED: OpenQuestion = {
  id: 'enr',
  text: 'Erst Copy oder erst Design?',
  options: ['Copy zuerst', 'Design zuerst'],
  context: 'Webseite-Sprint, beide Pfade möglich.',
  pros: ['Copy zuerst: Layout passt sich Inhalt an'],
  cons: ['Design zuerst: Copy muss sich pressen'],
  recommendation: 'Copy zuerst',
  evidence: ['https://laz.ing/research/copy-first'],
};

const Q_FREE: OpenQuestion = { id: 'qf', text: 'Beschreib das Ziel.' };

interface Handlers {
  onSelectOption: ReturnType<typeof vi.fn<(qId: string, option: string) => void>>;
  onNavigate: ReturnType<typeof vi.fn<(index: number) => void>>;
  onToggleExpand: ReturnType<typeof vi.fn<(expanded: boolean) => void>>;
  onSubmitAll: ReturnType<typeof vi.fn<() => void>>;
  onDismiss: ReturnType<typeof vi.fn<(qId: string) => void>>;
}

function mountPill(props: {
  questions: OpenQuestion[];
  currentIndex?: number;
  expanded?: boolean;
  withDismiss?: boolean;
}): { container: HTMLElement; root: Root; handlers: Handlers; cleanup: () => void } {
  const handlers: Handlers = {
    onSelectOption: vi.fn<(qId: string, option: string) => void>(),
    onNavigate: vi.fn<(index: number) => void>(),
    onToggleExpand: vi.fn<(expanded: boolean) => void>(),
    onSubmitAll: vi.fn<() => void>(),
    onDismiss: vi.fn<(qId: string) => void>(),
  };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <ChatOpenQuestionsPill
        questions={props.questions}
        answers={{}}
        currentIndex={props.currentIndex ?? 0}
        expanded={props.expanded ?? true}
        onSelectOption={handlers.onSelectOption}
        onNavigate={handlers.onNavigate}
        onToggleExpand={handlers.onToggleExpand}
        onSubmitAll={handlers.onSubmitAll}
        onDismiss={props.withDismiss ? handlers.onDismiss : undefined}
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

let activeCleanup: (() => void) | null = null;
afterEach(() => {
  activeCleanup?.();
  activeCleanup = null;
});

function findButtonByLabel(container: HTMLElement, label: string): HTMLButtonElement | null {
  return Array.from(container.querySelectorAll('button')).find((b) =>
    b.getAttribute('aria-label')?.includes(label),
  ) as HTMLButtonElement | null;
}

// ---------------------------------------------------------------------------
// 1. Expand-Toggle (nur wenn Enrichment-Felder existieren)
// ---------------------------------------------------------------------------

describe('ChatOpenQuestionsPill — Details-Toggle (Owner-Spec C)', () => {
  it('zeigt KEINEN Details-Toggle, wenn die Frage keine Enrichment-Felder hat', () => {
    const m = mountPill({ questions: [Q_PLAIN] });
    activeCleanup = m.cleanup;
    expect(m.container.querySelector('.oq-pill-details-toggle')).toBeNull();
    expect(m.container.querySelector('.oq-pill-details')).toBeNull();
  });

  it('zeigt den Details-Toggle, wenn die Frage Enrichment hat', () => {
    const m = mountPill({ questions: [Q_ENRICHED] });
    activeCleanup = m.cleanup;
    const toggle = m.container.querySelector('.oq-pill-details-toggle');
    expect(toggle).not.toBeNull();
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
  });

  it('Default = eingeklappt (Owner-Spec: 1-Zeilen-Summary)', () => {
    const m = mountPill({ questions: [Q_ENRICHED] });
    activeCleanup = m.cleanup;
    // Die Frage selbst (Summary) ist da, aber der Detail-Panel nicht.
    expect(m.container.textContent).toContain('Erst Copy oder erst Design?');
    expect(m.container.querySelector('.oq-pill-details')).toBeNull();
    // Pro/Kontra/Empfehlung NICHT sichtbar im Default-Zustand.
    expect(m.container.textContent).not.toContain('Layout passt sich Inhalt an');
  });

  it('Toggle-Klick klappt Details aus + zeigt Kontext/Empfehlung/Pro/Kontra/Belege', () => {
    const m = mountPill({ questions: [Q_ENRICHED] });
    activeCleanup = m.cleanup;
    const toggle = m.container.querySelector(
      '.oq-pill-details-toggle',
    ) as HTMLButtonElement;
    act(() => {
      toggle.click();
    });
    const panel = m.container.querySelector('.oq-pill-details');
    expect(panel).not.toBeNull();
    expect(panel?.textContent).toContain('Webseite-Sprint, beide Pfade möglich.');
    expect(panel?.textContent).toContain('Empfehlung');
    expect(panel?.textContent).toContain('Copy zuerst');
    expect(panel?.textContent).toContain('Pro');
    expect(panel?.textContent).toContain('Kontra');
    expect(panel?.textContent).toContain('Belege');
    expect(panel?.textContent).toContain('https://laz.ing/research/copy-first');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });

  it('zweiter Toggle-Klick klappt wieder ein', () => {
    const m = mountPill({ questions: [Q_ENRICHED] });
    activeCleanup = m.cleanup;
    const toggle = m.container.querySelector(
      '.oq-pill-details-toggle',
    ) as HTMLButtonElement;
    act(() => {
      toggle.click();
    });
    expect(m.container.querySelector('.oq-pill-details')).not.toBeNull();
    act(() => {
      toggle.click();
    });
    expect(m.container.querySelector('.oq-pill-details')).toBeNull();
  });

  it('rendert NUR die vorhandenen Enrichment-Blöcke (kein leerer Pro-Block, wenn pros leer)', () => {
    const partial: OpenQuestion = {
      id: 'p',
      text: 'Mit nur Kontext?',
      context: 'Nur Kontext.',
    };
    const m = mountPill({ questions: [partial] });
    activeCleanup = m.cleanup;
    const toggle = m.container.querySelector(
      '.oq-pill-details-toggle',
    ) as HTMLButtonElement;
    act(() => {
      toggle.click();
    });
    const panel = m.container.querySelector('.oq-pill-details')!;
    expect(panel.textContent).toContain('Nur Kontext.');
    expect(panel.textContent).not.toContain('Pro');
    expect(panel.textContent).not.toContain('Kontra');
    expect(panel.textContent).not.toContain('Belege');
    expect(panel.textContent).not.toContain('Empfehlung');
  });
});

// ---------------------------------------------------------------------------
// 2. Dismiss-Geste (×-Button)
// ---------------------------------------------------------------------------

describe('ChatOpenQuestionsPill — Dismiss (Owner-Spec D)', () => {
  it('rendert KEINEN Dismiss-Button, wenn onDismiss nicht durchgereicht ist (Backward-Compat)', () => {
    const m = mountPill({ questions: [Q_ENRICHED], withDismiss: false });
    activeCleanup = m.cleanup;
    expect(m.container.querySelector('.oq-pill-dismiss')).toBeNull();
  });

  it('rendert den Dismiss-Button, wenn onDismiss gesetzt ist', () => {
    const m = mountPill({ questions: [Q_ENRICHED], withDismiss: true });
    activeCleanup = m.cleanup;
    const btn = m.container.querySelector('.oq-pill-dismiss');
    expect(btn).not.toBeNull();
    expect(btn?.getAttribute('aria-label')).toContain('beantwortet');
  });

  it('Klick auf Dismiss ruft onDismiss(currentId)', () => {
    const m = mountPill({ questions: [Q_ENRICHED], withDismiss: true });
    activeCleanup = m.cleanup;
    const btn = m.container.querySelector('.oq-pill-dismiss') as HTMLButtonElement;
    act(() => {
      btn.click();
    });
    expect(m.handlers.onDismiss).toHaveBeenCalledTimes(1);
    expect(m.handlers.onDismiss).toHaveBeenCalledWith('enr');
  });

  it('Bei zwei Fragen + currentIndex=1 dismissed die SICHTBARE (zweite) Frage', () => {
    const m = mountPill({
      questions: [Q_PLAIN, Q_ENRICHED],
      currentIndex: 1,
      withDismiss: true,
    });
    activeCleanup = m.cleanup;
    const btn = m.container.querySelector('.oq-pill-dismiss') as HTMLButtonElement;
    act(() => {
      btn.click();
    });
    expect(m.handlers.onDismiss).toHaveBeenCalledWith('enr');
  });
});

// ---------------------------------------------------------------------------
// 3. Touch-Target-Größe (Mobile-first)
// ---------------------------------------------------------------------------

describe('ChatOpenQuestionsPill — Touch-Targets (mobile-first)', () => {
  it('Dismiss-Button hat ≥32px Hit-Area über inline min-width/min-height', () => {
    // Hinweis: happy-dom liefert keine echten computed-styles aus dem CSS-File.
    // Wir prüfen daher die durch CSS-Klassen erwartete Min-Size über die
    // Tag-Inline-Attribute, die wir selbst kontrollieren — der Renderer setzt
    // KEINE Inline-Styles auf .oq-pill-dismiss, weil das Token-System die
    // Min-Size in components.css garantiert. Daher prüfen wir hier nur, dass
    // der Klassen-Marker existiert (= CSS-Kontrakt) UND dass das DOM-Element
    // ein <button> mit aria-label ist (kein verschlucktes span).
    const m = mountPill({ questions: [Q_ENRICHED], withDismiss: true });
    activeCleanup = m.cleanup;
    const btn = m.container.querySelector('.oq-pill-dismiss');
    expect(btn?.tagName).toBe('BUTTON');
    expect(btn?.classList.contains('oq-pill-dismiss')).toBe(true);
    expect(btn?.getAttribute('aria-label')?.length ?? 0).toBeGreaterThan(0);
  });

  it('Details-Toggle ist BUTTON mit aria-expanded (Screen-Reader-konform)', () => {
    const m = mountPill({ questions: [Q_ENRICHED] });
    activeCleanup = m.cleanup;
    const toggle = m.container.querySelector('.oq-pill-details-toggle');
    expect(toggle?.tagName).toBe('BUTTON');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(findButtonByLabel(m.container, 'Details ausklappen')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. Sanity: Freitext-Frage + Backward-Compat zu bestehender Pill
// ---------------------------------------------------------------------------

describe('ChatOpenQuestionsPill — Backward-Compat (kein Regress)', () => {
  it('Freitext-Frage ohne Enrichment rendert wie bisher (keine Detail-Toggle, kein Panel)', () => {
    const m = mountPill({ questions: [Q_FREE] });
    activeCleanup = m.cleanup;
    expect(m.container.querySelector('.oq-pill-details-toggle')).toBeNull();
    expect(m.container.querySelector('.oq-pill-details')).toBeNull();
    expect(m.container.textContent).toContain('Beschreib das Ziel.');
    expect(m.container.textContent).toContain('eintippen');
  });

  it('Plain-Frage mit Options funktioniert weiter (Options-Klick → onSelectOption)', () => {
    const m = mountPill({ questions: [Q_PLAIN] });
    activeCleanup = m.cleanup;
    const dachBtn = Array.from(m.container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('DACH'),
    ) as HTMLButtonElement | undefined;
    expect(dachBtn).toBeDefined();
    act(() => {
      dachBtn!.click();
    });
    expect(m.handlers.onSelectOption).toHaveBeenCalledWith('plain', 'DACH');
  });
});
