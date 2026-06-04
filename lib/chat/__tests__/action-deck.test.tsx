/**
 * Tests für ActionDeck + selectPinnedItem (Slice 2 · 2026-05-30, Apple-UX).
 *
 * Deckt den Owner-Befund #1 ab („Entscheidung geht unter → muss gepinnt sein"):
 *   (a) selectPinnedItem-Priorität: Gate > Frage > Info > null.
 *   (b) ActionDeck rendert Gate wenn blockingGates da; sonst Pille; nie beide.
 *   (c) Gate-Aktion (CTA) ruft den delegierten onGateAction (single submit
 *       path, kein Doppel-Routing).
 *   (d) leerer State → null (Region rendert nichts).
 *
 * Run: NODE_OPTIONS='--experimental-require-module' npx vitest run lib/chat/__tests__/action-deck.test.tsx
 */

import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { describe, expect, it, vi, afterEach } from 'vitest';

import { ActionDeck, executeGateAction } from '../ActionDeck';
import { selectPinnedItem, looksLikeOnboarding } from '../useWorkspaceState';
import type { ChatOpenQuestionsPillProps } from '../ChatOpenQuestionsPill';
import type {
  BlockingGateState,
  OpenQuestionState,
  WorkspaceState,
} from '../../projection/types';

// ───────────────────────────────────────────────────────────────────────────
// Fixtures
// ───────────────────────────────────────────────────────────────────────────

function baseState(over: Partial<WorkspaceState> = {}): WorkspaceState {
  return {
    workspaceId: 'ws-1',
    generatedAt: 1000,
    activeFlowRun: null,
    activeWorkstreams: [],
    openQuestions: [],
    blockingGates: [],
    lastSuccessfulAction: null,
    nextAllowedUserInput: 'free-prompt',
    ...over,
  };
}

const GATE: BlockingGateState = {
  kind: 'human-decision',
  workstreamId: 'ws-x',
  description: 'Plan-Synthese fertig — welche Variante mergen?',
  createdAt: 5000,
};

const QUESTION: OpenQuestionState = {
  questionSetId: 'set-1',
  questionId: 'q1',
  text: 'Welcher Markt?',
  options: ['DACH', 'EU'],
  askedAt: 4000,
  answered: false,
};

// Minimale, vollständige Pillen-Props (ohne `questions`).
const PILL_PROPS: Omit<ChatOpenQuestionsPillProps, 'questions'> = {
  answers: {},
  currentIndex: 0,
  expanded: true,
  onSelectOption: () => {},
  onNavigate: () => {},
  onToggleExpand: () => {},
  onSubmitAll: () => {},
};

// ───────────────────────────────────────────────────────────────────────────
// (a) selectPinnedItem-Priorität
// ───────────────────────────────────────────────────────────────────────────

describe('selectPinnedItem — Priorität Gate > Frage > Info > null', () => {
  it('null bei null/undefined State', () => {
    expect(selectPinnedItem(null)).toBeNull();
    expect(selectPinnedItem(undefined)).toBeNull();
  });

  it('leerer State → null', () => {
    expect(selectPinnedItem(baseState())).toBeNull();
  });

  it('nur Info, wenn FlowRun läuft', () => {
    const item = selectPinnedItem(
      baseState({
        activeFlowRun: {
          flowRunId: 'fr-1',
          workstreamId: 'ws-x',
          status: 'running',
          currentPhase: 'Build',
          startedAt: 1,
          lastEventAt: 2,
        },
      }),
    );
    expect(item?.type).toBe('info');
    if (item?.type === 'info') expect(item.phase).toBe('Build');
  });

  it('Info auch bei aktiven Workstreams ohne FlowRun', () => {
    const item = selectPinnedItem(
      baseState({
        activeWorkstreams: [
          { workstreamId: 'w1', name: 'Lead', status: 'active' },
        ],
      }),
    );
    expect(item?.type).toBe('info');
  });

  it('Frage schlägt Info', () => {
    const item = selectPinnedItem(
      baseState({
        openQuestions: [QUESTION],
        activeFlowRun: {
          flowRunId: 'fr-1',
          workstreamId: 'ws-x',
          status: 'running',
          startedAt: 1,
          lastEventAt: 2,
        },
      }),
    );
    expect(item?.type).toBe('question');
    if (item?.type === 'question') expect(item.openCount).toBe(1);
  });

  it('beantwortete Fragen zählen NICHT', () => {
    const item = selectPinnedItem(
      baseState({ openQuestions: [{ ...QUESTION, answered: true }] }),
    );
    expect(item).toBeNull();
  });

  it('Gate schlägt Frage UND Info', () => {
    const item = selectPinnedItem(
      baseState({
        blockingGates: [GATE],
        openQuestions: [QUESTION],
        activeFlowRun: {
          flowRunId: 'fr-1',
          workstreamId: 'ws-x',
          status: 'running',
          startedAt: 1,
          lastEventAt: 2,
        },
      }),
    );
    expect(item?.type).toBe('gate');
    if (item?.type === 'gate') expect(item.gate.kind).toBe('human-decision');
  });

  it('wählt das JÜNGSTE Gate', () => {
    const older: BlockingGateState = { ...GATE, kind: 'credential-request', createdAt: 100 };
    const newer: BlockingGateState = { ...GATE, kind: 'live-warn', createdAt: 9000 };
    const item = selectPinnedItem(baseState({ blockingGates: [older, newer] }));
    expect(item?.type).toBe('gate');
    if (item?.type === 'gate') expect(item.gate.kind).toBe('live-warn');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Kontextverlust-Szenario (Owner, 2026-05-30): „Connector-Onboarding heygen
// unterbrochen" + kurze Eingabe „?" → DARF NICHT generisch klären. Der offene/
// pausierte Workstream wird als handlungsleitendes Resume-Item gepinnt.
// ───────────────────────────────────────────────────────────────────────────

describe('selectPinnedItem — unterbrochener Workstream → Resume (Kontext bleibt)', () => {
  it('pausierter Connector-Onboarding-Workstream → resume-Item statt „läuft"-Info', () => {
    const item = selectPinnedItem(
      baseState({
        activeWorkstreams: [
          {
            workstreamId: 'ws_heygen',
            name: 'Connector-Onboarding: heygen',
            status: 'paused',
          },
        ],
      }),
    );
    expect(item?.type).toBe('resume');
    if (item?.type === 'resume') {
      expect(item.workstreamId).toBe('ws_heygen');
      expect(item.name).toBe('Connector-Onboarding: heygen'); // N1 verbatim
      expect(item.isOnboarding).toBe(true);
    }
  });

  it('„stuck"-Status zählt ebenfalls als resumable', () => {
    const item = selectPinnedItem(
      baseState({
        activeWorkstreams: [
          { workstreamId: 'w1', name: 'Auth verbinden', status: 'stuck' },
        ],
      }),
    );
    expect(item?.type).toBe('resume');
  });

  it('Onboarding-Workstream hat Vorrang vor einem anderen pausierten', () => {
    const item = selectPinnedItem(
      baseState({
        activeWorkstreams: [
          { workstreamId: 'plain', name: 'Lead-Stream', status: 'paused' },
          {
            workstreamId: 'onb',
            name: 'OAuth-Connect: notion',
            status: 'paused',
          },
        ],
      }),
    );
    expect(item?.type).toBe('resume');
    if (item?.type === 'resume') expect(item.workstreamId).toBe('onb');
  });

  it('ein AKTIV laufender FlowRun unterdrückt Resume (kein Resume-Bedarf)', () => {
    const item = selectPinnedItem(
      baseState({
        activeFlowRun: {
          flowRunId: 'fr-1',
          workstreamId: 'ws-x',
          status: 'running',
          startedAt: 1,
          lastEventAt: 2,
        },
        activeWorkstreams: [
          { workstreamId: 'w1', name: 'Onboarding x', status: 'paused' },
        ],
      }),
    );
    expect(item?.type).toBe('info'); // Run läuft → kein Resume
  });

  it('nur „active"-Workstreams (kein paused/stuck) → bleibt generische Info', () => {
    const item = selectPinnedItem(
      baseState({
        activeWorkstreams: [
          { workstreamId: 'w1', name: 'Lead', status: 'active' },
        ],
      }),
    );
    expect(item?.type).toBe('info');
  });

  it('Gate schlägt auch Resume', () => {
    const item = selectPinnedItem(
      baseState({
        blockingGates: [GATE],
        activeWorkstreams: [
          { workstreamId: 'w1', name: 'Onboarding x', status: 'paused' },
        ],
      }),
    );
    expect(item?.type).toBe('gate');
  });
});

describe('looksLikeOnboarding — lexical Erkennung (N7)', () => {
  it('erkennt Onboarding/Connector/Auth-Begriffe', () => {
    for (const n of [
      'Connector-Onboarding: heygen',
      'OAuth-Connect notion',
      'Auth verbinden',
      'Credential eingeben',
      'Zugang herstellen',
    ]) {
      expect(looksLikeOnboarding(n)).toBe(true);
    }
  });
  it('false für nicht-Onboarding-Namen', () => {
    expect(looksLikeOnboarding('Lead-Stream')).toBe(false);
    expect(looksLikeOnboarding('Roaster-1')).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// (b)/(c)/(d) ActionDeck-Rendering
// ───────────────────────────────────────────────────────────────────────────

function mount(node: React.ReactElement): {
  container: HTMLElement;
  root: Root;
  cleanup: () => void;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  return {
    container,
    root,
    cleanup: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

describe('ActionDeck — Gate ODER Pille, nie beide', () => {
  it('(d) null pinned + keine Fragen → rendert nichts', () => {
    const { container, cleanup } = mount(
      <ActionDeck
        pinned={null}
        onGateAction={() => {}}
        pillQuestions={[]}
        pillProps={PILL_PROPS}
      />,
    );
    cleanups.push(cleanup);
    expect(container.querySelector('[data-test="action-deck"]')).toBeNull();
  });

  it('(b) Gate gepinnt → Gate-Card, KEINE Pille — auch wenn Fragen da sind', () => {
    const { container, cleanup } = mount(
      <ActionDeck
        pinned={{ type: 'gate', gate: GATE }}
        onGateAction={() => {}}
        pillQuestions={[{ id: 'q1', text: 'Welcher Markt?', options: ['DACH'] }]}
        pillProps={PILL_PROPS}
      />,
    );
    cleanups.push(cleanup);
    expect(container.querySelector('[data-test="action-deck-gate"]')).not.toBeNull();
    // Die Pille darf NICHT gleichzeitig rendern.
    expect(container.querySelector('.oq-pill')).toBeNull();
    expect(container.querySelector('[data-test="action-deck"]')?.getAttribute('data-variant')).toBe(
      'gate',
    );
  });

  it('(b) kein Gate + Fragen → die bestehende Pille (Back-Compat)', () => {
    const { container, cleanup } = mount(
      <ActionDeck
        pinned={null}
        onGateAction={() => {}}
        pillQuestions={[{ id: 'q1', text: 'Welcher Markt?', options: ['DACH', 'EU'] }]}
        pillProps={PILL_PROPS}
      />,
    );
    cleanups.push(cleanup);
    expect(container.querySelector('[data-test="action-deck-gate"]')).toBeNull();
    // Die echte Pille rendert (oq-pill-Klassen + Optionen).
    expect(container.querySelector('.oq-pill')).not.toBeNull();
    expect(container.textContent).toContain('Welcher Markt?');
  });

  it('(b) Pille bleibt erhalten, auch wenn Projektion eine Info pinnt', () => {
    // Frage-Pfad ist History-getrieben → schlägt eine Projektions-Info.
    const { container, cleanup } = mount(
      <ActionDeck
        pinned={{ type: 'info', runId: 'fr-1', phase: 'Build' }}
        onGateAction={() => {}}
        pillQuestions={[{ id: 'q1', text: 'Welcher Markt?' }]}
        pillProps={PILL_PROPS}
      />,
    );
    cleanups.push(cleanup);
    expect(container.querySelector('.oq-pill')).not.toBeNull();
    expect(container.querySelector('[data-test="action-deck-info"]')).toBeNull();
  });

  it('(c) Info-Variante, wenn kein Gate und keine Fragen', () => {
    const { container, cleanup } = mount(
      <ActionDeck
        pinned={{ type: 'info', runId: 'fr-1', phase: 'Build' }}
        onGateAction={() => {}}
        pillQuestions={[]}
        pillProps={PILL_PROPS}
      />,
    );
    cleanups.push(cleanup);
    expect(container.querySelector('[data-test="action-deck-info"]')).not.toBeNull();
    expect(container.textContent).toContain('Build');
  });

  it('(c) Gate-CTA ruft onGateAction mit dem Gate (single submit path)', () => {
    const onGateAction = vi.fn<(g: BlockingGateState) => void>();
    const { container, cleanup } = mount(
      <ActionDeck
        pinned={{ type: 'gate', gate: GATE }}
        onGateAction={onGateAction}
        pillQuestions={[]}
        pillProps={PILL_PROPS}
      />,
    );
    cleanups.push(cleanup);

    // collapsed → expand
    const bar = container.querySelector<HTMLButtonElement>('.action-deck-gate-bar');
    expect(bar).not.toBeNull();
    act(() => {
      bar!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const cta = container.querySelector<HTMLButtonElement>(
      '[data-test="action-deck-gate-cta"]',
    );
    expect(cta).not.toBeNull();
    act(() => {
      cta!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onGateAction).toHaveBeenCalledTimes(1);
    expect(onGateAction).toHaveBeenCalledWith(GATE);
  });

  it('Gate zeigt verbatim description (N1) als Headline', () => {
    const { container, cleanup } = mount(
      <ActionDeck
        pinned={{ type: 'gate', gate: GATE }}
        onGateAction={() => {}}
        pillQuestions={[]}
        pillProps={PILL_PROPS}
      />,
    );
    cleanups.push(cleanup);
    expect(container.textContent).toContain(
      'Plan-Synthese fertig — welche Variante mergen?',
    );
  });

  it('(resume) unterbrochener Workstream → Resume-Card mit Namen + CTA ruft onResume', () => {
    const onResume = vi.fn<(id: string) => void>();
    const { container, cleanup } = mount(
      <ActionDeck
        pinned={{
          type: 'resume',
          workstreamId: 'ws_heygen',
          name: 'Connector-Onboarding: heygen',
          status: 'paused',
          isOnboarding: true,
        }}
        onGateAction={() => {}}
        onResume={onResume}
        pillQuestions={[]}
        pillProps={PILL_PROPS}
      />,
    );
    cleanups.push(cleanup);
    expect(container.querySelector('[data-test="action-deck-resume"]')).not.toBeNull();
    // N1: verbatim Name im DOM.
    expect(container.textContent).toContain('Connector-Onboarding: heygen');
    expect(
      container.querySelector('[data-test="action-deck"]')?.getAttribute('data-variant'),
    ).toBe('resume');
    const cta = container.querySelector<HTMLButtonElement>(
      '[data-test="action-deck-resume-cta"]',
    );
    expect(cta).not.toBeNull();
    act(() => cta!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onResume).toHaveBeenCalledWith('ws_heygen');
  });

  it('(resume) Pille hat Vorrang vor Resume (offene Frage gewinnt)', () => {
    // Eine offene Frage (History-getrieben) ist konkreter als ein Resume-Hint.
    const { container, cleanup } = mount(
      <ActionDeck
        pinned={{
          type: 'resume',
          workstreamId: 'w1',
          name: 'Onboarding x',
          status: 'paused',
          isOnboarding: true,
        }}
        onGateAction={() => {}}
        onResume={() => {}}
        pillQuestions={[{ id: 'q1', text: 'Welcher Markt?' }]}
        pillProps={PILL_PROPS}
      />,
    );
    cleanups.push(cleanup);
    expect(container.querySelector('.oq-pill')).not.toBeNull();
    expect(container.querySelector('[data-test="action-deck-resume"]')).toBeNull();
  });

  it('live-warn-Gate trägt den danger-Akzent', () => {
    const liveWarn: BlockingGateState = {
      kind: 'live-warn',
      description: 'LIVE-Mode aktiv',
      createdAt: 7000,
    };
    const { container, cleanup } = mount(
      <ActionDeck
        pinned={{ type: 'gate', gate: liveWarn }}
        onGateAction={() => {}}
        pillQuestions={[]}
        pillProps={PILL_PROPS}
      />,
    );
    cleanups.push(cleanup);
    expect(container.querySelector('.action-deck-gate--danger')).not.toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// (BLOCKER 1) executeGateAction — der ECHTE Aktions-Pfad für ALLE 5 Gate-Kinds.
//
// Dieser Test fehlte und ließ den 4/5-Bug grün durch: zuvor wurde nur der
// gemockte onGateAction geprüft, nie die reale Selektor-Map. Hier bauen wir je
// Kind die zugehörige Stream-Card (vereinfacht, mit denselben data-test-Hooks
// wie SurfaceRenderer/CredentialRequestCard/ConnectorCallPreviewCard) und
// prüfen: non-secret → genau EIN Button-Click (single POST path);
// credential → Input fokussiert, NICHT geklickt; counter-evidence → nur
// gescrollt; fehlende Card → 'missing'.
// ───────────────────────────────────────────────────────────────────────────

describe('executeGateAction — single submit path für alle 5 Kinds', () => {
  let host: HTMLElement;
  afterEach(() => {
    host?.remove();
  });

  function build(html: string): HTMLElement {
    host = document.createElement('div');
    host.innerHTML = html;
    document.body.appendChild(host);
    return host;
  }

  function gate(kind: BlockingGateState['kind']): BlockingGateState {
    return { kind, description: `${kind} desc`, createdAt: 1 };
  }

  it('live-warn → klickt den ack-Button der Stream-Card (genau 1×)', () => {
    let clicks = 0;
    const root = build(
      `<div data-test="surface-live-warn">
         <button data-test="live-warn-ack-btn">OK weiter</button>
       </div>`,
    );
    root
      .querySelector('[data-test="live-warn-ack-btn"]')!
      .addEventListener('click', () => {
        clicks += 1;
      });
    const outcome = executeGateAction(gate('live-warn'), root);
    expect(outcome).toBe('clicked');
    expect(clicks).toBe(1); // single POST path — kein Doppel-Click.
  });

  it('human-decision → klickt die EMPFOHLENE decision-brief-Option', () => {
    let chosen = '';
    const root = build(
      `<div data-test="surface-decision-brief">
         <button data-test="decision-brief-option" data-recommended="false" data-option-id="reject">Ablehnen</button>
         <button data-test="decision-brief-option" data-recommended="true" data-option-id="confirm">Bestätigen</button>
       </div>`,
    );
    root
      .querySelectorAll('[data-test="decision-brief-option"]')
      .forEach((b) =>
        b.addEventListener('click', () => {
          chosen = (b as HTMLElement).getAttribute('data-option-id') ?? '';
        }),
      );
    const outcome = executeGateAction(gate('human-decision'), root);
    expect(outcome).toBe('clicked');
    expect(chosen).toBe('confirm'); // die primäre (empfohlene) Aktion.
  });

  it('connector-call-preview → klickt den approve-Button', () => {
    let clicks = 0;
    const root = build(
      `<div data-test="surface-connector-call-preview">
         <button data-test="connector-call-approve-btn">Freigeben</button>
       </div>`,
    );
    root
      .querySelector('[data-test="connector-call-approve-btn"]')!
      .addEventListener('click', () => {
        clicks += 1;
      });
    const outcome = executeGateAction(gate('connector-call-preview'), root);
    expect(outcome).toBe('clicked');
    expect(clicks).toBe(1);
  });

  it('credential-request (SECRET) → fokussiert den Input, klickt NICHT', () => {
    let clicks = 0;
    const root = build(
      `<div data-test="surface-credential-request">
         <input type="password" />
         <button class="srf-cred__submit">Speichern</button>
       </div>`,
    );
    root
      .querySelector('.srf-cred__submit')!
      .addEventListener('click', () => {
        clicks += 1;
      });
    const outcome = executeGateAction(gate('credential-request'), root);
    expect(outcome).toBe('focused');
    expect(clicks).toBe(0); // Secret landet NIE im Deck → kein Auto-Submit.
  });

  it('counter-evidence → scrollt nur (keine primäre Aktion)', () => {
    const root = build(`<div data-test="surface-counter-evidence">Beleg</div>`);
    const outcome = executeGateAction(gate('counter-evidence'), root);
    expect(outcome).toBe('scrolled');
  });

  it('fehlende Stream-Card → "missing" (Caller zeigt Pulse statt No-op)', () => {
    const root = build(`<div>keine Gate-Card hier</div>`);
    expect(executeGateAction(gate('human-decision'), root)).toBe('missing');
    expect(executeGateAction(gate('live-warn'), root)).toBe('missing');
  });

  it('deaktivierter Button → "missing" (kein blinder Click)', () => {
    const root = build(
      `<div data-test="surface-live-warn">
         <button data-test="live-warn-ack-btn" disabled>OK weiter</button>
       </div>`,
    );
    expect(executeGateAction(gate('live-warn'), root)).toBe('missing');
  });

  // F18: decision → klickt den ECHTEN in-feed-Option-Hook (single submit path).
  it('decision (ohne optionId) → klickt die EMPFOHLENE Option der Decision-Card', () => {
    let chosen = '';
    const root = build(
      `<div data-test="surface-decision">
         <button data-test="surface-decision-option" data-option-id="a">A</button>
         <button data-test="surface-decision-option" data-option-id="b" data-recommended="true">B</button>
       </div>`,
    );
    root
      .querySelectorAll('[data-test="surface-decision-option"]')
      .forEach((b) =>
        b.addEventListener('click', () => {
          chosen = (b as HTMLElement).getAttribute('data-option-id') ?? '';
        }),
      );
    const outcome = executeGateAction(gate('decision'), root);
    expect(outcome).toBe('clicked');
    expect(chosen).toBe('b'); // die empfohlene Primär-Aktion.
  });

  it('decision (mit optionId) → klickt GENAU diese Option (Listen-Auswahl)', () => {
    let chosen = '';
    let clicks = 0;
    const root = build(
      `<div data-test="surface-decision">
         <button data-test="surface-decision-option" data-option-id="a">A</button>
         <button data-test="surface-decision-option" data-option-id="b" data-recommended="true">B</button>
         <button data-test="surface-decision-option" data-option-id="c">C</button>
       </div>`,
    );
    root
      .querySelectorAll('[data-test="surface-decision-option"]')
      .forEach((b) =>
        b.addEventListener('click', () => {
          clicks += 1;
          chosen = (b as HTMLElement).getAttribute('data-option-id') ?? '';
        }),
      );
    const outcome = executeGateAction(gate('decision'), root, 'c');
    expect(outcome).toBe('clicked');
    expect(chosen).toBe('c'); // gezielte Listen-Auswahl, NICHT die empfohlene.
    expect(clicks).toBe(1); // genau EIN Click — kein Doppel-Submit.
  });

  it('decision ohne Decision-Card im DOM → "missing"', () => {
    const root = build(`<div>kein Decision-Surface</div>`);
    expect(executeGateAction(gate('decision'), root)).toBe('missing');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// F18 — ActionDeck rendert die gepinnte Decision: EINE empfohlene Primär-Aktion
// (gefüllt/Akzent) + ruhige Liste (progressive disclosure) + Free-Text-Hinweis.
// NICHT 4 gleichlaute Buttons. EIN onGateAction-Pfad (kein Doppel-Routing).
// ───────────────────────────────────────────────────────────────────────────

const DECISION_GATE: BlockingGateState = {
  kind: 'decision',
  description: 'Welche Variante mergen?',
  createdAt: 6000,
  options: [
    { id: 'a', label: 'Variante A' },
    { id: 'b', label: 'Variante B', recommended: true },
    { id: 'c', label: 'Variante C' },
  ],
};

describe('ActionDeck — gepinnte Decision (F18)', () => {
  function expand(container: HTMLElement): void {
    const bar = container.querySelector<HTMLButtonElement>('.action-deck-gate-bar');
    act(() => bar!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  }

  it('zeigt GENAU EINE empfohlene Primär-Aktion (gefüllt) + ruhige Liste', () => {
    const { container, cleanup } = mount(
      <ActionDeck
        pinned={{ type: 'gate', gate: DECISION_GATE }}
        onGateAction={() => {}}
        pillQuestions={[]}
        pillProps={PILL_PROPS}
      />,
    );
    cleanups.push(cleanup);
    expand(container);

    // Primär-Aktion = empfohlene Option, verbatim Label.
    const cta = container.querySelector<HTMLButtonElement>(
      '[data-test="action-deck-gate-cta"]',
    );
    expect(cta).not.toBeNull();
    expect(cta!.getAttribute('data-option-id')).toBe('b');
    expect(cta!.getAttribute('data-recommended')).toBe('true');
    expect(cta!.textContent).toContain('Variante B');

    // Die übrigen Optionen als ruhige Liste (genau 2: A + C) — NICHT als
    // weitere Primär-Buttons.
    const listOpts = container.querySelectorAll(
      '[data-test="action-deck-gate-option"]',
    );
    expect(listOpts.length).toBe(2);
    const labels = Array.from(listOpts).map((b) => b.textContent);
    expect(labels.join('|')).toContain('Variante A');
    expect(labels.join('|')).toContain('Variante C');

    // Es gibt nur EINEN data-recommended-Button (keine 4 gleichlauten).
    const recommended = container.querySelectorAll('[data-recommended="true"]');
    expect(recommended.length).toBe(1);
  });

  it('Free-Text-Antwort bleibt möglich (Hinweis sichtbar)', () => {
    const { container, cleanup } = mount(
      <ActionDeck
        pinned={{ type: 'gate', gate: DECISION_GATE }}
        onGateAction={() => {}}
        pillQuestions={[]}
        pillProps={PILL_PROPS}
      />,
    );
    cleanups.push(cleanup);
    expand(container);
    expect(
      container.querySelector('[data-test="action-deck-gate-freetext-hint"]'),
    ).not.toBeNull();
  });

  it('Primär-Aktion ruft onGateAction(gate, empfohleneOption) — EIN Pfad', () => {
    const onGateAction = vi.fn<(g: BlockingGateState, o?: unknown) => void>();
    const { container, cleanup } = mount(
      <ActionDeck
        pinned={{ type: 'gate', gate: DECISION_GATE }}
        onGateAction={onGateAction}
        pillQuestions={[]}
        pillProps={PILL_PROPS}
      />,
    );
    cleanups.push(cleanup);
    expand(container);
    const cta = container.querySelector<HTMLButtonElement>(
      '[data-test="action-deck-gate-cta"]',
    );
    act(() => cta!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onGateAction).toHaveBeenCalledTimes(1);
    const [g, opt] = onGateAction.mock.calls[0]!;
    expect(g).toBe(DECISION_GATE);
    expect((opt as { id: string }).id).toBe('b'); // empfohlen
  });

  it('Listen-Option ruft onGateAction(gate, dieseOption) — kein Doppel-Submit', () => {
    const onGateAction = vi.fn<(g: BlockingGateState, o?: unknown) => void>();
    const { container, cleanup } = mount(
      <ActionDeck
        pinned={{ type: 'gate', gate: DECISION_GATE }}
        onGateAction={onGateAction}
        pillQuestions={[]}
        pillProps={PILL_PROPS}
      />,
    );
    cleanups.push(cleanup);
    expand(container);
    const opt = container.querySelector<HTMLButtonElement>(
      '[data-test="action-deck-gate-option"][data-option-id="a"]',
    );
    expect(opt).not.toBeNull();
    act(() => opt!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onGateAction).toHaveBeenCalledTimes(1); // EIN Pfad, kein Doppel.
    const [, chosen] = onGateAction.mock.calls[0]!;
    expect((chosen as { id: string }).id).toBe('a');
  });

  it('Decision ohne Optionen → fällt auf den generischen Gate-CTA zurück', () => {
    const bare: BlockingGateState = {
      kind: 'decision',
      description: 'Entscheidung ohne Optionen',
      createdAt: 7000,
    };
    const { container, cleanup } = mount(
      <ActionDeck
        pinned={{ type: 'gate', gate: bare }}
        onGateAction={() => {}}
        pillQuestions={[]}
        pillProps={PILL_PROPS}
      />,
    );
    cleanups.push(cleanup);
    expand(container);
    // kein Options-Block, aber der generische CTA existiert.
    expect(
      container.querySelector('[data-test="action-deck-gate-options"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-test="action-deck-gate-cta"]'),
    ).not.toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// F18 — selectPinnedItem erfasst decision als Gate (über die Projektion).
// ───────────────────────────────────────────────────────────────────────────

describe('selectPinnedItem — decision-Gate wird gepinnt', () => {
  it('eine decision im blockingGates → gepinnt als gate', () => {
    const item = selectPinnedItem(baseState({ blockingGates: [DECISION_GATE] }));
    expect(item?.type).toBe('gate');
    if (item?.type === 'gate') {
      expect(item.gate.kind).toBe('decision');
      expect(item.gate.options).toHaveLength(3);
    }
  });
});
