'use client';

/**
 * ChatInlineOpenQuestions — CODEX stepper (2026-05-23, rebuild v2).
 *
 * Previous behavior (v1, bug): every option click immediately called `reply()`
 * → the chat was re-triggered instantly, no going back possible.
 *
 * New behavior (stepper):
 *  - One question per "screen", forward/back + progress display „n / total".
 *  - Option click → only sets the local answer for this question (visually
 *    marked, aria-pressed), no reply().
 *  - Free-text questions: textarea, the draft is kept while navigating.
 *  - Single-question case: no forward/back, submit directly.
 *  - Final "Antworten absenden" button: builds a Q&A list, calls reply()
 *    ONCE and locks the submit (no double submit).
 *  - Submit allowed as soon as ≥1 question is answered; unanswered questions
 *    are omitted (cleaner than a „—" placeholder).
 *
 * Render path unchanged: surface-text-render.tsx passes `questions`.
 * Signature unchanged: { questions: PlanQuestion[] }.
 */

import { useState } from 'react';

import type { PlanQuestion } from '../workstreams/parse-plan-questions';
import { useSurfaceAction } from './SurfaceActionContext';

// ---------------------------------------------------------------------------
// Helper util
// ---------------------------------------------------------------------------

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function ChatInlineOpenQuestions({
  questions,
}: {
  questions: PlanQuestion[];
}): React.JSX.Element | null {
  const { reply } = useSurfaceAction();

  // answers: stored answer per question ID (empty = not yet answered).
  const [answers, setAnswers] = useState<Record<string, string>>({});
  // drafts: free-text intermediate state per question ID (even before final accept).
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // currentIndex: currently visible question (0-based).
  const [currentIndex, setCurrentIndex] = useState<number>(0);
  // submitted: prevents a double submit; switches the view after sending.
  const [submitted, setSubmitted] = useState<boolean>(false);

  if (questions.length === 0) return null;

  const total = questions.length;
  const isSingle = total === 1;
  const current = questions[currentIndex]!;
  const hasOptions = Array.isArray(current.options) && current.options.length > 0;

  // Number of questions answered so far (for the submit guard + hint).
  const answeredCount = questions.filter((q) => answers[q.id] !== undefined).length;
  const canSubmit = answeredCount > 0 && !submitted;

  // How many questions are still open (for the warning hint in the footer)?
  const openCount = total - answeredCount;

  // ------------------------------------------------------------------
  // Handlers
  // ------------------------------------------------------------------

  /** Sets the answer for the current question (option click). */
  const selectOption = (qId: string, opt: string): void => {
    if (submitted) return;
    setAnswers((prev) => ({ ...prev, [qId]: opt }));
  };

  /** Accepts the free-text draft as the answer for the current question. */
  const acceptDraft = (qId: string): void => {
    if (submitted) return;
    const trimmed = (drafts[qId] ?? '').trim();
    if (trimmed.length === 0) return;
    setAnswers((prev) => ({ ...prev, [qId]: trimmed }));
  };

  /**
   * Final submit: builds a compact Q&A list from all answered
   * questions and calls reply() ONCE.
   */
  const handleSubmit = (): void => {
    if (!canSubmit) return;
    // Build the Q&A text BEFORE the lock (no state access needed afterwards).
    const lines: string[] = [];
    for (const q of questions) {
      const ans = answers[q.id];
      if (ans !== undefined) {
        lines.push(`Frage: ${q.text}\nAntwort: ${ans}`);
      }
    }
    // Lock FIRST: even if reply() (sync) throws, submitted is already
    // true → the canSubmit guard (!submitted) prevents a second reply().
    setSubmitted(true);
    reply(lines.join('\n\n'));
  };

  // ------------------------------------------------------------------
  // Submitted state: compact confirmation
  // ------------------------------------------------------------------

  if (submitted) {
    return (
      <div className="open-q-inline open-q-inline--done" role="status">
        <span className="open-q-inline-label">
          {answeredCount} {answeredCount === 1 ? 'Antwort' : 'Antworten'} gesendet
        </span>
      </div>
    );
  }

  // ------------------------------------------------------------------
  // Render the active question
  // ------------------------------------------------------------------

  const currentAnswer = answers[current.id];
  const currentDraft = drafts[current.id] ?? '';

  return (
    <div className="open-q-inline" role="group" aria-label="Offene Fragen">
      {/* Header row: progress + label */}
      <div className="open-q-stepper-header">
        <span className="open-q-inline-label">Offene Fragen</span>
        {!isSingle && (
          <span className="open-q-stepper-progress" aria-live="polite">
            {currentIndex + 1} / {total}
          </span>
        )}
      </div>

      {/* Current question */}
      <div className="open-q-inline-q">
        <div className="open-q-inline-text">
          <span>{current.text}</span>
          {/* Already chosen answer: inline badge for a quick overview */}
          {currentAnswer !== undefined && (
            <span className="open-q-answered" aria-label={`Gewählt: ${currentAnswer}`}>
              {currentAnswer}
            </span>
          )}
        </div>

        {hasOptions ? (
          /* Options: own buttons with a selected state (QuickChoice has no
             aria-pressed / selected concept, hence the own variant). */
          <div
            className="open-q-stepper-opts"
            role="group"
            aria-label={current.text}
          >
            {(current.options ?? []).map((opt, i) => (
              <button
                key={`${current.id}-opt-${i}`}
                type="button"
                className={cx(
                  'open-q-opt',
                  answers[current.id] === opt && 'open-q-opt--sel',
                )}
                aria-pressed={answers[current.id] === opt}
                onClick={() => selectOption(current.id, opt)}
              >
                {opt}
              </button>
            ))}
          </div>
        ) : (
          /* Free text: textarea + "Merken" button (no immediate submit) */
          <div className="open-q-input-row">
            <textarea
              className="open-q-textarea"
              rows={2}
              value={currentDraft}
              placeholder="Antwort eintippen …"
              onChange={(e) =>
                setDrafts((prev) => ({ ...prev, [current.id]: e.target.value }))
              }
              onKeyDown={(e) => {
                // Cmd/Ctrl+Enter: remember the draft as the answer for this question
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  acceptDraft(current.id);
                }
              }}
            />
            <button
              type="button"
              className="open-q-submit"
              onClick={() => acceptDraft(current.id)}
              disabled={currentDraft.trim().length === 0}
              title="Antwort für diese Frage merken (Cmd+Enter)"
            >
              Merken
            </button>
          </div>
        )}
      </div>

      {/* Footer: navigation + final submit button */}
      <div className="open-q-stepper-footer">
        {/* Forward/back navigation — only when multiple questions */}
        {!isSingle && (
          <div className="open-q-stepper-nav">
            <button
              type="button"
              className="open-q-chev"
              aria-label="Vorherige Frage"
              disabled={currentIndex === 0}
              onClick={() => setCurrentIndex((i) => i - 1)}
            >
              &lsaquo;
            </button>
            <button
              type="button"
              className="open-q-chev"
              aria-label="Nächste Frage"
              disabled={currentIndex === total - 1}
              onClick={() => setCurrentIndex((i) => i + 1)}
            >
              &rsaquo;
            </button>
          </div>
        )}

        <div className="open-q-stepper-send-group">
          {/* Hint: how many questions are still unanswered */}
          {openCount > 0 && answeredCount > 0 && (
            <span className="open-q-stepper-hint">
              {openCount} {openCount === 1 ? 'Frage' : 'Fragen'} offen
            </span>
          )}
          <button
            type="button"
            className="open-q-stepper-send"
            onClick={handleSubmit}
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

export default ChatInlineOpenQuestions;

// ---------------------------------------------------------------------------
// OpenQuestionsInlineRef — UX-1 (2026-05-26)
// ---------------------------------------------------------------------------
/**
 * Compact, NON-interactive reference for the `## Offene Fragen` section in the
 * message stream. Since UX-1 the primary answer flow is the Q/A pill ABOVE
 * the composer (ChatOpenQuestionsPill). This inline marker only points
 * to it — it opens NO second reply() path (no double send).
 */
export function OpenQuestionsInlineRef({
  count,
}: {
  count: number;
}): React.JSX.Element | null {
  if (count <= 0) return null;
  return (
    <div className="open-q-ref" role="note">
      <span className="open-q-ref-icon" aria-hidden="true">
        ↓
      </span>
      <span>
        {count} offene {count === 1 ? 'Frage' : 'Fragen'} — unten beantworten
      </span>
    </div>
  );
}
