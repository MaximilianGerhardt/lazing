'use client';

/**
 * ChatOpenQuestionsPill — UX-1 (2026-05-26, Codex-style bottom-action UX).
 *
 * Q/A pill ABOVE the composer. Replaces the inline stepper in the message stream
 * as the PRIMARY answer flow for `## Offene Fragen` sections.
 *
 * Two states:
 *  - **expanded** (`expanded`): current question + answer options
 *    (click = answer) + progress „n/total" + forward/back + collapse button.
 *    An already chosen answer is shown as a badge.
 *  - **collapsed** (`!expanded`): chip „n offene Fragen" (click = expand).
 *
 * State + submit logic live in the PARENT (ChatShell) — this component is
 * controlled. The actual answer flow (option click, free-text Enter
 * via the chat input, final `reply`) is orchestrated by ChatShell so that
 * the submit order (streaming→queue first) stays intact.
 *
 * The pill is deliberately kept extensible ("needs-action at the bottom") —
 * later approval/connector/permission surfaces can also land here.
 */

import { useState } from 'react';

import type { PlanQuestion } from '../workstreams/parse-plan-questions';
import type { OpenQuestion } from './open-questions-lifecycle';

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

// ---------------------------------------------------------------------------
// Pure routing logic (testable without a ChatShell mount)
// ---------------------------------------------------------------------------

/**
 * MAJOR 3a (2026-05-26): deduplicate question IDs.
 *
 * `parsePlanQuestions` builds `id = hashString(text)` — two text-identical open
 * questions thus collide on the same ID. That breaks the pill: `allAnswered`
 * would become true after ONE answer, the reply would contain the answer twice, and
 * the option-click `findIndex` always jumps back to the first bubble
 * (navigation stuck). This function gives the n-th repetition of an ID
 * a `-n` suffix (`q1`, `q1-1`, `q1-2`, …) so each bubble stays separately
 * navigable and answerable. `parsePlanQuestions` itself stays
 * unchanged (the plan pipeline uses it).
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
  /** Answers including the one just set. */
  nextAnswers: Record<string, string>;
  /** Are ALL questions answered afterwards? (→ final reply). */
  allAnswered: boolean;
  /** If not all: index of the next still-unanswered question. */
  nextIndex: number;
}

/**
 * UX-1 (2026-05-26): computes the follow-up pill state for ONE answer to the
 * question `targetId`. Sets the answer, checks completeness and determines the
 * next open question (forward from `currentIndex`, then wrap-around).
 *
 * Used both by the free-text Enter routing (in the ChatShell submit handler) and
 * by the option click → identical answer logic, a single path.
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
  // Starting point: index of the just-answered question (if findable),
  // otherwise currentIndex.
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
  /** The open questions of the current Q/A set (empty → render nothing).
   *  2026-05-28: extended type `OpenQuestion` (PlanQuestion + optional
   *  enrichment fields context/pros/cons/recommendation/evidence). Old
   *  callers with a plain PlanQuestion[] keep working unchanged. */
  questions: Array<PlanQuestion | OpenQuestion>;
  /** Answers already given (question ID → answer text). */
  answers: Record<string, string>;
  /** Index of the currently visible question (0-based). */
  currentIndex: number;
  /** Expanded = primary answer flow; collapsed = chip. */
  expanded: boolean;
  /** Option click → set the answer on the current question (delegated to the parent). */
  onSelectOption: (qId: string, option: string) => void;
  /** Forward/back navigation. */
  onNavigate: (index: number) => void;
  /** Expand/collapse toggle. */
  onToggleExpand: (expanded: boolean) => void;
  /**
   * Final submit (all answered questions → ONE reply). Triggered by the
   * "Antworten absenden" button; ChatShell builds the Q&A text.
   */
  onSubmitAll: () => void;
  /**
   * Workstream 4b (2026-05-27): is the associated run still running
   * (ask-but-proceed)? Then the pill shows a subtle label that the answer
   * refines the NEXT step — so the question doesn't feel pointless while work
   * continues in parallel. Default false (run idle / question stands still).
   */
  runActive?: boolean;
  /**
   * 2026-05-28 (Owner spec D): manual dismiss per question. When set,
   * the pill renders a subtle × symbol with a ≥32px hit area next to the
   * current question; clicking calls onDismiss(qId). ChatShell dispatches a
   * `dismissed` event into the lifecycle reducer + (if a workspace context exists)
   * optionally a workstream_decisions entry „question-dismissed".
   *
   * When `undefined`, the dismiss button is NOT rendered (backwards-
   * compatible with existing tests/call sites).
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
  // 2026-05-28 (Owner spec C): per-question „Details ausklappen" state. Lives
  // COMPONENT-LOCAL — the detail visibility is pure view state and need not
  // be immortalized in ChatShell. Default collapsed: the question itself
  // stays a 1-line summary, pros/cons/recommendation/context appear only on
  // click. Only questions that ACTUALLY have enrichment fields show the
  // toggle (otherwise the button feels pointless).
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

  // Does the CURRENT question have enrichment fields? (context/pros/cons/recommendation/
  // evidence). If so → show the toggle. Owner spec C: „pro Frage ausklappbar".
  const hasEnrichment =
    typeof current.context === 'string' ||
    typeof current.recommendation === 'string' ||
    (Array.isArray(current.pros) && current.pros.length > 0) ||
    (Array.isArray(current.cons) && current.cons.length > 0) ||
    (Array.isArray(current.evidence) && current.evidence.length > 0);
  const isDetailOpen = detailsOpen[current.id] === true;

  // -------------------------------------------------------------------
  // Collapsed: compact chip "n offene Fragen"
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
  // Expanded: question + options + progress + nav + submit
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

      {/* Workstream 4b (2026-05-27): ask-but-proceed signal. Only when the run
          is still active — otherwise the question feels pointless while work
          continues in parallel. Subtle, one line, no own surface. */}
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
          {/* 2026-05-28 (Owner spec C): „Details" toggle per question — only when
              enrichment fields are actually present. Otherwise render nothing,
              so the pill is not plastered with dead buttons. */}
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
          {/* 2026-05-28 (Owner spec D): manual dismiss („beantwortet" / „nicht
              mehr relevant"). Only when the parent passes a handler through;
              otherwise not in the DOM (backwards-compat with existing tests). Hit
              area ≥32×32 — HIG-compliant. */}
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

        {/* 2026-05-28 (Owner spec C): detail panel per question. Order:
            context → recommendation (highlighted) → pros/cons → evidence. Pure
            reading — no actions in it (the answer action stays below in the
            options/composer). On 375px viewports everything stacks vertically,
            no horizontal overflow. */}
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
          /* Bug 2 Fix (2026-05-30, owner „es muss IMMER die Möglichkeit geben,
             auch darauf zu antworten"): options are an OFFER, not a constraint.
             Even with options, free text via the composer is a full-fledged
             answer path — ChatShell routes it via routePillAnswer to
             the same question. The hint line makes this visible, otherwise
             the question looks like a pure selection. */
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
          /* Free-text questions: NO own textarea — the chat input is the
             answer field (ChatShell branches in the submit handler). A hint line
             so the user knows where to type. */
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
