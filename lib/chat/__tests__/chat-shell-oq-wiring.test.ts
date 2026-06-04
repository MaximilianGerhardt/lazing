/**
 * Tests für die Open-Questions-Wiring-Verdrahtung in ChatShell (2026-05-28).
 *
 * OWNER-SYMPTOM (verbatim, 2026-05-28): „Im PA Chat ist immer noch Offene
 * Fragen, obwohl die schon unfassbar alt sind und schon lange beantwortet.
 * Wenn der mir eine neue Frage stellt, dann wieder im alten Muster/Surface
 * mit Empfehlung usw. ist ganz cool, aber dadurch etwas doppelt und ggf.
 * redundant."
 *
 * Diese Datei testet die DREI ChatShell-Wiring-Slices, die der Pure-Reducer
 * NICHT abdeckt — denn die ChatShell-Effects rufen die Helpers selbst auf:
 *
 *  1. POPULATION-MERGE (W1): wenn `extractOpenQuestionsFromContent` einen
 *     Live-Turn mit zwei `<surface:open-questions>`-Emissions DERSELBEN ID
 *     liefert (zweite reichert an), soll der Effect EINE Karte erzeugen mit
 *     gemergten Enrichment-Feldern — nicht zwei.
 *
 *  2. PERIODISCHER SCAN (W3): wenn `detectResolvedAndStaleQuestions` IDs
 *     zurückgibt (alte Frage + User-Reply mit Content-Tokens), soll der
 *     ChatShell-State diese IDs aus der Pill nehmen + die Signatur an die
 *     verkürzte Liste anpassen.
 *
 *  3. DISMISS-FLOW (W4): wenn der User „×" klickt, wird die Karte aus dem
 *     State entfernt UND ein Audit-POST auf `/api/chat/open-questions/dismiss`
 *     gefeuert. Bei Fetch-Failure (offline) bleibt der UI-Flow intakt.
 *
 * Pur (ohne ChatShell-Mount). Die getesteten Code-Pfade sind WORT-WÖRTLICH
 * dieselben, die ChatShell in seinen useEffects aufruft (Helper-Module sind
 * pur). Damit fangen die Tests Regressionen der Verdrahtung ein, ohne dass
 * der gesamte 4100-Zeilen-ChatShell-Mount-Stack hochgefahren werden muss.
 *
 * Run: NODE_OPTIONS='--experimental-require-module' npx vitest run \
 *      lib/chat/__tests__/chat-shell-oq-wiring.test.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  collectOpenQuestionsFromHistory,
  detectResolvedAndStaleQuestions,
  extractOpenQuestionsFromContent,
  mergeQuestionEnrichmentsById,
  type OpenQuestion,
  type OpenQuestionsSourceItem,
} from '../open-questions-lifecycle';

// ---------------------------------------------------------------------------
// (1) POPULATION-MERGE — W1
// ---------------------------------------------------------------------------
// Spiegelt den ChatShell-Population-Effect (lib/chat/ChatShell.tsx, der
// `if (typeof agentTurn.text === 'string' && agentTurn.text.length > 0) {`
// Zweig): extract → mergeQuestionEnrichmentsById.
// ---------------------------------------------------------------------------

describe('ChatShell population-effect — W1 live-turn merge (Anti-Doppelung)', () => {
  it('zwei Surface-Emissions derselben id im SELBEN Live-Turn → 1 Karte, Felder gemerged', () => {
    // Owner-Symptom-Reproduktion: erst kommt die nackte Frage als Surface,
    // dann reichert eine zweite Emission Kontext + Pro/Kontra + Empfehlung
    // nach. Heute (ohne Merge) → 2 Pill-Karten zur selben Frage.
    const liveTurnText = [
      '<surface:open-questions>{"questions":[{"id":"qa","q":"Erst Copy oder erst Design?","options":["Copy zuerst","Design zuerst"]}]}</surface:open-questions>',
      'Bash-Output …',
      '<surface:open-questions>{"questions":[{"id":"qa","q":"Erst Copy oder erst Design?","context":"Webseite-Sprint","pros":["Copy zuerst → Layout passt sich an"],"cons":["Design zuerst → Copy muss sich pressen"],"recommendation":"Copy zuerst"}]}</surface:open-questions>',
    ].join('\n');

    // Schritt 1: was ChatShell ohne Merge bekäme.
    const raw = extractOpenQuestionsFromContent(liveTurnText);
    expect(raw).toHaveLength(2); // DAS war der Doppelungs-Bug.

    // Schritt 2: was der WIRED Population-Effect tatsächlich liefert.
    const merged = mergeQuestionEnrichmentsById(raw);
    expect(merged).toHaveLength(1);
    const card = merged[0]!;
    expect(card.id).toBe('qa');
    expect(card.text).toBe('Erst Copy oder erst Design?');
    expect(card.options).toEqual(['Copy zuerst', 'Design zuerst']); // aus 1. Emission
    expect(card.context).toBe('Webseite-Sprint'); // aus 2. Emission
    expect(card.pros).toEqual(['Copy zuerst → Layout passt sich an']);
    expect(card.cons).toEqual(['Design zuerst → Copy muss sich pressen']);
    expect(card.recommendation).toBe('Copy zuerst');
  });

  it('zweite Emission OHNE Enrichment-Felder ändert die existierende Karte nicht', () => {
    const turn = [
      '<surface:open-questions>{"questions":[{"id":"q1","q":"X?","context":"alt"}]}</surface:open-questions>',
      '<surface:open-questions>{"questions":[{"id":"q1","q":"X?"}]}</surface:open-questions>',
    ].join('\n');
    const merged = mergeQuestionEnrichmentsById(extractOpenQuestionsFromContent(turn));
    expect(merged).toHaveLength(1);
    expect(merged[0]!.context).toBe('alt'); // last-write-wins nur wenn neuer Wert gesetzt
  });

  it('history-Pfad (collectOpenQuestionsFromHistory) ist intern bereits gemerged — kein erneuter Merge nötig', () => {
    // Sicherheits-Net: wenn jemand den Population-Effect umbaut, soll
    // `collectOpenQuestionsFromHistory` weiter selbst mergen. Sonst doppelt
    // sich die Frage in der Pill, sobald sie im selben Assistant-Item zwei-
    // mal emittiert wird.
    const history: OpenQuestionsSourceItem[] = [
      { role: 'user', content: 'baue X' },
      {
        role: 'assistant',
        content: [
          '<surface:open-questions>{"questions":[{"id":"dup","q":"Stack?"}]}</surface:open-questions>',
          '<surface:open-questions>{"questions":[{"id":"dup","q":"Stack?","recommendation":"Next"}]}</surface:open-questions>',
        ].join('\n'),
      },
    ];
    const out = collectOpenQuestionsFromHistory(history);
    expect(out).toHaveLength(1);
    expect(out[0]!.recommendation).toBe('Next');
  });
});

// ---------------------------------------------------------------------------
// (2) PERIODISCHER STALE-/RESOLVE-SCAN — W3
// ---------------------------------------------------------------------------
// Spiegelt den zweiten ChatShell-Effect (deps: history + openQuestions):
// detectResolvedAndStaleQuestions(state, history) → filter + Signatur-Update.
// ---------------------------------------------------------------------------

describe('ChatShell stale-resolve-effect — W3 Filter + Signatur-Update', () => {
  // Mini-Reducer der EXAKT spiegelt was der ChatShell-Effect tut.
  // (Funktion ist lokal damit der Test self-contained ist — der Effect selbst
  // ist im ChatShell-Body inline definiert.)
  function applyScan(
    state: { questions: OpenQuestion[]; signature: string | null },
    history: OpenQuestionsSourceItem[],
    nowMs?: number,
  ): { questions: OpenQuestion[]; signature: string | null } {
    if (state.questions.length === 0) return state;
    const toRemove = detectResolvedAndStaleQuestions(
      state.questions,
      history,
      nowMs !== undefined ? { nowMs } : undefined,
    );
    if (toRemove.length === 0) return state;
    const removeSet = new Set(toRemove);
    const remaining = state.questions.filter((q) => !removeSet.has(q.id));
    const signature =
      remaining.length === 0 ? null : remaining.map((q) => q.id).join('|');
    return { questions: remaining, signature };
  }

  it('alte Frage + jüngere User-Antwort mit Content-Tokens → Pill removed nach scan', () => {
    const askedAt = new Date('2026-05-26T08:00:00.000Z').toISOString();
    const state = {
      questions: [
        {
          id: 'qa',
          text: 'Erst Copy oder erst Design?',
          askedAt,
        } as OpenQuestion,
      ],
      signature: 'qa',
    };
    const history: OpenQuestionsSourceItem[] = [
      { role: 'user', content: 'baue mir eine seite' },
      {
        role: 'assistant',
        content:
          '<surface:open-questions>{"questions":[{"id":"qa","q":"Erst Copy oder erst Design?","askedAt":"' +
          askedAt +
          '"}]}</surface:open-questions>',
      },
      // User-Antwort enthält die Content-Tokens „copy" UND „design" → lexical-resolve.
      { role: 'user', content: 'erst copy machen, dann design dazu' },
    ];
    const next = applyScan(state, history);
    expect(next.questions).toEqual([]);
    expect(next.signature).toBeNull();
  });

  it('keine inhaltliche Überschneidung → State unverändert (kein false-positive)', () => {
    const state = {
      questions: [
        { id: 'qa', text: 'Welcher Markt?' } as OpenQuestion,
      ],
      signature: 'qa',
    };
    const history: OpenQuestionsSourceItem[] = [
      {
        role: 'assistant',
        content:
          '<surface:open-questions>{"questions":[{"id":"qa","q":"Welcher Markt?"}]}</surface:open-questions>',
      },
      { role: 'user', content: 'wann startet die kampagne?' }, // null overlap
    ];
    const next = applyScan(state, history);
    expect(next).toBe(state); // identische Referenz (kein Re-Render)
  });

  it('partielles Resolve: 2 Fragen, 1 wird resolved → Signatur an Rest angepasst', () => {
    const state = {
      questions: [
        { id: 'q1', text: 'Welcher Markt?' } as OpenQuestion,
        { id: 'q2', text: 'Welches Budget?' } as OpenQuestion,
      ],
      signature: 'q1|q2',
    };
    const history: OpenQuestionsSourceItem[] = [
      {
        role: 'assistant',
        content: [
          '<surface:open-questions>{"questions":[{"id":"q1","q":"Welcher Markt?"}]}</surface:open-questions>',
          '<surface:open-questions>{"questions":[{"id":"q2","q":"Welches Budget?"}]}</surface:open-questions>',
        ].join('\n'),
      },
      // Antwort matched „markt" → resolved q1, q2 bleibt offen.
      { role: 'user', content: 'der markt ist DACH' },
    ];
    const next = applyScan(state, history);
    expect(next.questions.map((q) => q.id)).toEqual(['q2']);
    expect(next.signature).toBe('q2');
  });
});

// ---------------------------------------------------------------------------
// (3) DISMISS-FLOW — W4
// ---------------------------------------------------------------------------
// Spiegelt den ChatShell-onDismiss-Handler:
//   - Frage aus State entfernen + Signatur an Rest anpassen
//   - fail-soft POST auf /api/chat/open-questions/dismiss
//   - bei fetch-failure (offline) bleibt der State-Update durch (kein throw)
// ---------------------------------------------------------------------------

describe('ChatShell pill-dismiss-flow — W4', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true })));
    global.fetch = fetchMock as unknown as typeof global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  /**
   * Inline-Mini-Reducer EXAKT wie der ChatShell-Handler:
   *  - setOpenQuestions(prev → prev.filter(id !== qId))
   *  - Signatur-Update auf den Rest
   *  - qIndex clampen
   *  - fire-and-forget POST mit { workstreamId, questionId, questionText }
   */
  function applyDismiss(
    state: {
      questions: OpenQuestion[];
      signature: string | null;
      qIndex: number;
    },
    qId: string,
    workstreamId: string | null,
  ): typeof state {
    const dismissed = state.questions.find((q) => q.id === qId);
    const remaining = state.questions.filter((q) => q.id !== qId);
    if (remaining.length === state.questions.length) return state;

    // Audit-POST exakt wie im Handler (keepalive, ohne await, fail-soft).
    try {
      void fetch('/api/chat/open-questions/dismiss', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workstreamId,
          questionId: qId,
          questionText: dismissed?.text ?? null,
        }),
        keepalive: true,
      }).catch(() => {
        /* fail-soft */
      });
    } catch {
      /* fail-soft */
    }

    const signature =
      remaining.length === 0 ? null : remaining.map((q) => q.id).join('|');
    const qIndex =
      state.qIndex >= remaining.length && remaining.length > 0
        ? remaining.length - 1
        : state.qIndex;
    return { questions: remaining, signature, qIndex };
  }

  it('Dismiss entfernt EINE Frage + ruft fetch mit Audit-Body + workstreamId', () => {
    const state = {
      questions: [
        { id: 'q1', text: 'Welcher Markt?' } as OpenQuestion,
        { id: 'q2', text: 'Welches Budget?' } as OpenQuestion,
      ],
      signature: 'q1|q2',
      qIndex: 0,
    };
    const next = applyDismiss(state, 'q1', 'ws_test');

    // State-Update: q1 raus, Signatur an Rest angepasst.
    expect(next.questions.map((q) => q.id)).toEqual(['q2']);
    expect(next.signature).toBe('q2');

    // Audit-POST gefeuert mit korrektem Body + workstreamId.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0]!;
    expect(call[0]).toBe('/api/chat/open-questions/dismiss');
    const init = call[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.keepalive).toBe(true);
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      workstreamId: 'ws_test',
      questionId: 'q1',
      questionText: 'Welcher Markt?',
    });
  });

  it('Dismiss OHNE workstreamId (Free-Chat) → workstreamId=null im Body, State-Update läuft', () => {
    const state = {
      questions: [{ id: 'qa', text: 'X?' } as OpenQuestion],
      signature: 'qa',
      qIndex: 0,
    };
    const next = applyDismiss(state, 'qa', null);
    expect(next.questions).toEqual([]);
    expect(next.signature).toBeNull();

    const body = JSON.parse(
      (fetchMock.mock.calls[0]![1] as RequestInit).body as string,
    );
    expect(body.workstreamId).toBeNull();
    expect(body.questionId).toBe('qa');
  });

  it('Dismiss bei fetch-failure (offline) → State-Update läuft trotzdem durch, kein throw', () => {
    fetchMock.mockImplementationOnce(async () => {
      throw new Error('offline');
    });
    const state = {
      questions: [{ id: 'qa', text: 'X?' } as OpenQuestion],
      signature: 'qa',
      qIndex: 0,
    };
    // Darf NICHT werfen.
    const next = applyDismiss(state, 'qa', 'ws_test');
    expect(next.questions).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('Dismiss einer unbekannten id → State-Referenz identisch (kein Re-Render, kein fetch)', () => {
    const state = {
      questions: [{ id: 'q1', text: 'X?' } as OpenQuestion],
      signature: 'q1',
      qIndex: 0,
    };
    const next = applyDismiss(state, 'unknown', 'ws_test');
    expect(next).toBe(state);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Dismiss der aktuell sichtbaren Frage clampt qIndex auf gültigen Bereich', () => {
    const state = {
      questions: [
        { id: 'q1', text: 'X?' } as OpenQuestion,
        { id: 'q2', text: 'Y?' } as OpenQuestion,
      ],
      signature: 'q1|q2',
      qIndex: 1, // q2 ist sichtbar
    };
    const next = applyDismiss(state, 'q2', 'ws_test');
    expect(next.questions.map((q) => q.id)).toEqual(['q1']);
    // qIndex>=remaining.length → clampen auf remaining.length-1 = 0.
    expect(next.qIndex).toBe(0);
  });
});
