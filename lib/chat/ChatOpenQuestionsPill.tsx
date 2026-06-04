'use client';

/**
 * ChatOpenQuestionsPill — UX-1 (2026-05-26, Codex-Stil Bottom-Action-UX).
 *
 * Q/A-Pill ÜBER dem Composer. Ersetzt den inline-Stepper im Nachrichtenstrom
 * als PRIMÄREN Antwort-Flow für `## Offene Fragen`-Sections.
 *
 * Zwei Zustände:
 *  - **ausgeklappt** (`expanded`): aktuelle Frage + Antwort-Optionen
 *    (Klick = Antwort) + Fortschritt „n/total" + Vor/Zurück + Collapse-Button.
 *    Eine bereits gewählte Antwort wird als Badge angezeigt.
 *  - **eingeklappt** (`!expanded`): Chip „n offene Fragen" (Klick = ausklappen).
 *
 * State + Submit-Logik leben im PARENT (ChatShell) — diese Komponente ist
 * controlled. Der eigentliche Antwort-Flow (Options-Klick, Freitext-Enter
 * über den Chat-Input, finaler `reply`) wird von ChatShell orchestriert, damit
 * die submit-Reihenfolge (streaming→Queue zuerst) intakt bleibt.
 *
 * Die Pill ist absichtlich erweiterbar gehalten ("needs-action unten") —
 * später können hier auch Approval/Connector/Permission-Surfaces landen.
 */

import { useState } from 'react';

import type { PlanQuestion } from '../workstreams/parse-plan-questions';
import type { OpenQuestion } from './open-questions-lifecycle';

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

// ---------------------------------------------------------------------------
// Pure Routing-Logik (testbar ohne ChatShell-Mount)
// ---------------------------------------------------------------------------

/**
 * MAJOR 3a (2026-05-26): Frage-IDs deduplizieren.
 *
 * `parsePlanQuestions` baut `id = hashString(text)` — zwei textgleiche offene
 * Fragen kollidieren damit auf derselben ID. Das bricht die Pill: `allAnswered`
 * würde nach EINER Antwort true, der reply enthielte die Antwort doppelt, und
 * der Options-Klick-`findIndex` springt immer auf die erste Bubble zurück
 * (Navigations-Stuck). Diese Funktion vergibt der n-ten Wiederholung einer ID
 * ein `-n`-Suffix (`q1`, `q1-1`, `q1-2`, …), sodass jede Bubble separat
 * navigier- und beantwortbar bleibt. `parsePlanQuestions` selbst bleibt
 * unverändert (die Plan-Pipeline nutzt es).
 */
export function dedupeQuestionIds(
  questions: ReadonlyArray<PlanQuestion>,
): PlanQuestion[] {
  const seen = new Map<string, number>();
  return questions.map((q) => {
    const n = seen.get(q.id) ?? 0;
    seen.set(q.id, n + 1);
    return n === 0 ? q : { ...q, id: `${q.id}-${n}` };
  });
}

export interface PillAnswerRouteResult {
  /** Antworten inklusive der gerade gesetzten. */
  nextAnswers: Record<string, string>;
  /** Sind danach ALLE Fragen beantwortet? (→ finaler reply). */
  allAnswered: boolean;
  /** Falls nicht alle: Index der nächsten noch unbeantworteten Frage. */
  nextIndex: number;
}

/**
 * UX-1 (2026-05-26): Berechnet das Folge-Pill-State für EINE Antwort auf die
 * Frage `targetId`. Setzt die Antwort, prüft Vollständigkeit und ermittelt die
 * nächste offene Frage (vorwärts ab `currentIndex`, dann wrap-around).
 *
 * Wird sowohl vom Freitext-Enter-Routing (im ChatShell-submit-Handler) als auch
 * vom Options-Klick benutzt → identische Antwort-Logik, ein einziger Pfad.
 */
export function routePillAnswer(
  questions: ReadonlyArray<PlanQuestion>,
  answers: Record<string, string>,
  currentIndex: number,
  targetId: string,
  answerValue: string,
): PillAnswerRouteResult {
  const nextAnswers: Record<string, string> = { ...answers, [targetId]: answerValue };
  const allAnswered = questions.every((q) => nextAnswers[q.id] !== undefined);
  if (allAnswered || questions.length === 0) {
    return { nextAnswers, allAnswered: true, nextIndex: currentIndex };
  }
  // Startpunkt: Index der gerade beantworteten Frage (falls auffindbar),
  // sonst der currentIndex.
  const baseIdx = questions.findIndex((q) => q.id === targetId);
  const from = baseIdx >= 0 ? baseIdx : currentIndex;
  let nextIndex = from;
  for (let step = 1; step <= questions.length; step += 1) {
    const cand = (from + step) % questions.length;
    if (nextAnswers[questions[cand]!.id] === undefined) {
      nextIndex = cand;
      break;
    }
  }
  return { nextAnswers, allAnswered: false, nextIndex };
}

export interface ChatOpenQuestionsPillProps {
  /** Die offenen Fragen des aktuellen Q/A-Sets (leer → nichts rendern).
   *  2026-05-28: erweiterter Typ `OpenQuestion` (PlanQuestion + optionale
   *  Enrichment-Felder context/pros/cons/recommendation/evidence). Alt-
   *  Aufrufer mit reinem PlanQuestion[] funktionieren unverändert weiter. */
  questions: Array<PlanQuestion | OpenQuestion>;
  /** Bereits gegebene Antworten (Frage-ID → Antwort-Text). */
  answers: Record<string, string>;
  /** Index der aktuell sichtbaren Frage (0-basiert). */
  currentIndex: number;
  /** Ausgeklappt = primärer Antwort-Flow; eingeklappt = Chip. */
  expanded: boolean;
  /** Options-Klick → Antwort auf die aktuelle Frage setzen (delegiert an Parent). */
  onSelectOption: (qId: string, option: string) => void;
  /** Vor/Zurück-Navigation. */
  onNavigate: (index: number) => void;
  /** Expand/Collapse-Toggle. */
  onToggleExpand: (expanded: boolean) => void;
  /**
   * Finaler Submit (alle beantworteten Fragen → EIN reply). Wird vom
   * "Antworten absenden"-Button getriggert; ChatShell baut den Q&A-Text.
   */
  onSubmitAll: () => void;
  /**
   * Workstream 4b (2026-05-27): Läuft der zugehörige Run gerade noch
   * (ask-but-proceed)? Dann zeigt die Pill ein dezentes Label, dass die Antwort
   * den NÄCHSTEN Schritt verfeinert — die Frage wirkt so nicht sinnlos, während
   * parallel weitergearbeitet wird. Default false (Run idle / Frage steht still).
   */
  runActive?: boolean;
  /**
   * 2026-05-28 (Owner-Spec D): manueller Dismiss pro Frage. Wenn gesetzt,
   * rendert die Pill ein dezentes ×-Symbol mit ≥32px Hit-Area neben der
   * aktuellen Frage; Klick ruft onDismiss(qId). ChatShell dispatched ein
   * `dismissed`-Event in den Lifecycle-Reducer + (falls Workspace-Context da)
   * optional einen workstream_decisions-Eintrag „question-dismissed".
   *
   * Wenn `undefined`, wird der Dismiss-Button NICHT gerendert (zurück-
   * kompatibel zu bestehenden Tests/Call-Sites).
   */
  onDismiss?: (qId: string) => void;
}

export function ChatOpenQuestionsPill({
  questions,
  answers,
  currentIndex,
  expanded,
  onSelectOption,
  onNavigate,
  onToggleExpand,
  onSubmitAll,
  runActive = false,
  onDismiss,
}: ChatOpenQuestionsPillProps): React.JSX.Element | null {
  // 2026-05-28 (Owner-Spec C): per-Frage „Details ausklappen"-State. Lebt
  // KOMPONENTEN-LOKAL — die Detail-Sichtbarkeit ist reine View-State und muss
  // sich nicht in ChatShell verewigen. Default eingeklappt: die Frage selbst
  // bleibt 1-Zeilen-Summary, Pro/Kontra/Empfehlung/Kontext erscheinen erst auf
  // Klick. Nur Fragen, die TATSÄCHLICH Enrichment-Felder haben, zeigen den
  // Toggle (sonst wirkt der Button sinnlos).
  const [detailsOpen, setDetailsOpen] = useState<Record<string, boolean>>({});

  if (questions.length === 0) return null;

  const total = questions.length;
  const answeredCount = questions.filter((q) => answers[q.id] !== undefined).length;
  const safeIndex = Math.min(Math.max(currentIndex, 0), total - 1);
  const current = questions[safeIndex]! as OpenQuestion;
  const hasOptions = Array.isArray(current.options) && current.options.length > 0;
  const currentAnswer = answers[current.id];
  const isSingle = total === 1;
  const openCount = total - answeredCount;
  const canSubmit = answeredCount > 0;

  // Hat die AKTUELLE Frage Enrichment-Felder? (context/pros/cons/recommendation/
  // evidence). Wenn ja → Toggle anzeigen. Owner-Spec C: „pro Frage ausklappbar".
  const hasEnrichment =
    typeof current.context === 'string' ||
    typeof current.recommendation === 'string' ||
    (Array.isArray(current.pros) && current.pros.length > 0) ||
    (Array.isArray(current.cons) && current.cons.length > 0) ||
    (Array.isArray(current.evidence) && current.evidence.length > 0);
  const isDetailOpen = detailsOpen[current.id] === true;

  // -------------------------------------------------------------------
  // Eingeklappt: kompakter Chip "n offene Fragen"
  // -------------------------------------------------------------------
  if (!expanded) {
    return (
      <div className="oq-pill oq-pill--collapsed">
        <button
          type="button"
          className={cx('oq-pill-chip', runActive && 'oq-pill-chip--live')}
          onClick={() => onToggleExpand(true)}
          aria-label={`${openCount} offene ${openCount === 1 ? 'Frage' : 'Fragen'} — ausklappen${runActive ? ' (Run läuft weiter)' : ''}`}
        >
          <span className="oq-pill-chip-dot" aria-hidden="true" />
          {openCount} offene {openCount === 1 ? 'Frage' : 'Fragen'}
        </button>
      </div>
    );
  }

  // -------------------------------------------------------------------
  // Ausgeklappt: Frage + Optionen + Fortschritt + Nav + Submit
  // -------------------------------------------------------------------
  return (
    <div className="oq-pill oq-pill--expanded" role="group" aria-label="Offene Fragen">
      <div className="oq-pill-header">
        <span className="oq-pill-label">Offene Fragen</span>
        <div className="oq-pill-header-right">
          {!isSingle && (
            <span className="oq-pill-progress" aria-live="polite">
              {safeIndex + 1} / {total}
            </span>
          )}
          <button
            type="button"
            className="oq-pill-collapse"
            aria-label="Einklappen"
            title="Einklappen"
            onClick={() => onToggleExpand(false)}
          >
            ▾
          </button>
        </div>
      </div>

      {/* Workstream 4b (2026-05-27): ask-but-proceed-Signal. Nur wenn der Run
          noch aktiv ist — sonst wirkt die Frage sinnlos, während parallel
          gearbeitet wird. Dezent, eine Zeile, kein eigenes Surface. */}
      {runActive && (
        <div className="oq-pill-live-note" role="status">
          <span className="oq-pill-live-dot" aria-hidden="true" />
          läuft weiter — deine Antwort verfeinert den nächsten Schritt
        </div>
      )}

      <div className="oq-pill-q">
        <div className="oq-pill-q-text">
          <span>{current.text}</span>
          {currentAnswer !== undefined && (
            <span className="oq-pill-answered" aria-label={`Gewählt: ${currentAnswer}`}>
              {currentAnswer}
            </span>
          )}
          {/* 2026-05-28 (Owner-Spec C): „Details"-Toggle pro Frage — nur wenn
              tatsächlich Enrichment-Felder vorhanden. Sonst nichts rendern,
              damit die Pill nicht mit toten Buttons vollgepflastert ist. */}
          {hasEnrichment && (
            <button
              type="button"
              className="oq-pill-details-toggle"
              aria-expanded={isDetailOpen}
              aria-label={isDetailOpen ? 'Details einklappen' : 'Details ausklappen'}
              title={isDetailOpen ? 'Details einklappen' : 'Details ausklappen'}
              onClick={() =>
                setDetailsOpen((prev) => ({ ...prev, [current.id]: !isDetailOpen }))
              }
            >
              {isDetailOpen ? 'Details ▴' : 'Details ▾'}
            </button>
          )}
          {/* 2026-05-28 (Owner-Spec D): manueller Dismiss („beantwortet" / „nicht
              mehr relevant"). Nur wenn der Parent einen Handler durchreicht;
              sonst nicht im DOM (Backward-Compat zu bestehenden Tests). Hit-
              Area ≥32×32 — HIG-konform. */}
          {onDismiss && (
            <button
              type="button"
              className="oq-pill-dismiss"
              aria-label={`Frage „${current.text}" als beantwortet markieren`}
              title="Beantwortet / nicht mehr relevant"
              onClick={() => onDismiss(current.id)}
            >
              ×
            </button>
          )}
        </div>

        {/* 2026-05-28 (Owner-Spec C): Detail-Panel pro Frage. Reihenfolge:
            Kontext → Empfehlung (hervorgehoben) → Pro/Kontra → Evidenz. Reines
            Lesen — keine Aktionen darin (Antwort-Aktion bleibt unten in den
            Options/Composer). Auf 375px-Viewports stapelt sich alles vertikal,
            kein horizontales Overflow. */}
        {hasEnrichment && isDetailOpen && (
          <div
            className="oq-pill-details"
            role="region"
            aria-label={`Details zu „${current.text}"`}
          >
            {typeof current.context === 'string' && current.context.length > 0 && (
              <p className="oq-pill-detail-context">{current.context}</p>
            )}
            {typeof current.recommendation === 'string' &&
              current.recommendation.length > 0 && (
                <p className="oq-pill-detail-rec">
                  <span className="oq-pill-detail-rec-label">Empfehlung</span>{' '}
                  {current.recommendation}
                </p>
              )}
            {Array.isArray(current.pros) && current.pros.length > 0 && (
              <div className="oq-pill-detail-block">
                <span className="oq-pill-detail-block-label">Pro</span>
                <ul className="oq-pill-detail-list">
                  {current.pros.map((p, i) => (
                    <li key={`${current.id}-pro-${i}`}>{p}</li>
                  ))}
                </ul>
              </div>
            )}
            {Array.isArray(current.cons) && current.cons.length > 0 && (
              <div className="oq-pill-detail-block">
                <span className="oq-pill-detail-block-label">Kontra</span>
                <ul className="oq-pill-detail-list">
                  {current.cons.map((c, i) => (
                    <li key={`${current.id}-con-${i}`}>{c}</li>
                  ))}
                </ul>
              </div>
            )}
            {Array.isArray(current.evidence) && current.evidence.length > 0 && (
              <div className="oq-pill-detail-block">
                <span className="oq-pill-detail-block-label">Belege</span>
                <ul className="oq-pill-detail-list oq-pill-detail-evidence">
                  {current.evidence.map((e, i) => (
                    <li key={`${current.id}-ev-${i}`}>{e}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {hasOptions ? (
          /* Bug 2 Fix (2026-05-30, Owner „es muss IMMER die Möglichkeit geben,
             auch darauf zu antworten"): Optionen sind ein ANGEBOT, kein Zwang.
             Auch mit Optionen ist Freitext über den Composer ein vollwertiger
             Antwort-Pfad — ChatShell routet ihn via routePillAnswer auf
             dieselbe Frage. Die Hinweis-Zeile macht das sichtbar, sonst wirkt
             die Frage wie eine reine Auswahl. */
          <>
            <div className="oq-pill-opts" role="group" aria-label={current.text}>
              {(current.options ?? []).map((opt, i) => (
                <button
                  key={`${current.id}-opt-${i}`}
                  type="button"
                  className={cx(
                    'oq-pill-opt',
                    answers[current.id] === opt && 'oq-pill-opt--sel',
                  )}
                  aria-pressed={answers[current.id] === opt}
                  onClick={() => onSelectOption(current.id, opt)}
                >
                  {opt}
                </button>
              ))}
            </div>
            <div
              className="oq-pill-freetext-hint oq-pill-freetext-hint--withopts"
              data-test="oq-pill-freetext-hint"
            >
              oder eigene Antwort unten eintippen ↓
            </div>
          </>
        ) : (
          /* Freitext-Fragen: KEINE eigene Textarea — der Chat-Input ist das
             Antwortfeld (ChatShell verzweigt im submit-Handler). Hinweis-Zeile
             damit der User weiß, wohin er tippt. */
          <div
            className="oq-pill-freetext-hint"
            data-test="oq-pill-freetext-hint"
          >
            Antwort unten eintippen ↓
          </div>
        )}
      </div>

      <div className="oq-pill-footer">
        {!isSingle && (
          <div className="oq-pill-nav">
            <button
              type="button"
              className="oq-pill-chev"
              aria-label="Vorherige Frage"
              disabled={safeIndex === 0}
              onClick={() => onNavigate(safeIndex - 1)}
            >
              &lsaquo;
            </button>
            <button
              type="button"
              className="oq-pill-chev"
              aria-label="Nächste Frage"
              disabled={safeIndex === total - 1}
              onClick={() => onNavigate(safeIndex + 1)}
            >
              &rsaquo;
            </button>
          </div>
        )}

        <div className="oq-pill-send-group">
          {openCount > 0 && answeredCount > 0 && (
            <span className="oq-pill-hint">
              {openCount} {openCount === 1 ? 'Frage' : 'Fragen'} offen
            </span>
          )}
          <button
            type="button"
            className="oq-pill-send"
            onClick={onSubmitAll}
            disabled={!canSubmit}
          >
            Antworten absenden
            {answeredCount > 0 && !isSingle ? ` (${answeredCount})` : ''}
          </button>
        </div>
      </div>
    </div>
  );
}

export default ChatOpenQuestionsPill;
