'use client';

/**
 * ChatInlineOpenQuestions — CODEX-Stepper (2026-05-23, Umbau v2).
 *
 * Vorheriges Verhalten (v1, Bug): Jeder Options-Klick rief sofort `reply()`
 * auf → der Chat wurde sofort neu angestoßen, kein Zurück möglich.
 *
 * Neues Verhalten (Stepper):
 *  - Eine Frage pro "Screen", Vor/Zurück + Fortschrittsanzeige „n / total".
 *  - Options-Klick → setzt nur die lokale Antwort für diese Frage (visuell
 *    markiert, aria-pressed), kein reply().
 *  - Free-Text-Fragen: Textarea, Draft bleibt beim Navigieren erhalten.
 *  - Einzelfrage-Fall: kein Vor/Zurück, direkt Absenden.
 *  - Finaler "Antworten absenden"-Button: baut eine Q&A-Liste, ruft reply()
 *    EINMAL auf und lockt den Submit (kein Doppel-Submit).
 *  - Absenden erlaubt sobald ≥1 Frage beantwortet; unbeantwortete Fragen
 *    werden weggelassen (sauberer als „—"-Platzhalter).
 *
 * Render-Pfad unverändert: surface-text-render.tsx übergibt `questions`.
 * Signatur unverändert: { questions: PlanQuestion[] }.
 */

import { useState } from 'react';

import type { PlanQuestion } from '../workstreams/parse-plan-questions';
import { useSurfaceAction } from './SurfaceActionContext';

// ---------------------------------------------------------------------------
// Hilfs-Util
// ---------------------------------------------------------------------------

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

// ---------------------------------------------------------------------------
// Haupt-Komponente
// ---------------------------------------------------------------------------

export function ChatInlineOpenQuestions({
  questions,
}: {
  questions: PlanQuestion[];
}): React.JSX.Element | null {
  const { reply } = useSurfaceAction();

  // answers: gespeicherte Antwort pro Frage-ID (leer = noch nicht beantwortet).
  const [answers, setAnswers] = useState<Record<string, string>>({});
  // drafts: Free-Text-Zwischenstand pro Frage-ID (auch schon vor finalem Accept).
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // currentIndex: aktuell sichtbare Frage (0-basiert).
  const [currentIndex, setCurrentIndex] = useState<number>(0);
  // submitted: verhindert Doppel-Submit; blendet nach dem Absenden um.
  const [submitted, setSubmitted] = useState<boolean>(false);

  if (questions.length === 0) return null;

  const total = questions.length;
  const isSingle = total === 1;
  const current = questions[currentIndex]!;
  const hasOptions = Array.isArray(current.options) && current.options.length > 0;

  // Anzahl der bisher beantworteten Fragen (für Submit-Guard + Hinweis).
  const answeredCount = questions.filter((q) => answers[q.id] !== undefined).length;
  const canSubmit = answeredCount > 0 && !submitted;

  // Wie viele Fragen sind noch offen (für Warn-Hinweis im Footer)?
  const openCount = total - answeredCount;

  // ------------------------------------------------------------------
  // Handler
  // ------------------------------------------------------------------

  /** Setzt die Antwort für die aktuelle Frage (Options-Klick). */
  const selectOption = (qId: string, opt: string): void => {
    if (submitted) return;
    setAnswers((prev) => ({ ...prev, [qId]: opt }));
  };

  /** Akzeptiert den Free-Text-Draft als Antwort für die aktuelle Frage. */
  const acceptDraft = (qId: string): void => {
    if (submitted) return;
    const trimmed = (drafts[qId] ?? '').trim();
    if (trimmed.length === 0) return;
    setAnswers((prev) => ({ ...prev, [qId]: trimmed }));
  };

  /**
   * Finaler Submit: baut eine kompakte Q&A-Liste aus allen beantworteten
   * Fragen und ruft reply() EINMAL auf.
   */
  const handleSubmit = (): void => {
    if (!canSubmit) return;
    // Q&A-Text VOR dem Lock bauen (kein State-Zugriff danach nötig).
    const lines: string[] = [];
    for (const q of questions) {
      const ans = answers[q.id];
      if (ans !== undefined) {
        lines.push(`Frage: ${q.text}\nAntwort: ${ans}`);
      }
    }
    // Lock ZUERST: selbst wenn reply() (sync) wirft, ist submitted bereits
    // true → der canSubmit-Guard (!submitted) verhindert einen zweiten reply().
    setSubmitted(true);
    reply(lines.join('\n\n'));
  };

  // ------------------------------------------------------------------
  // Submitted-Zustand: kompakte Bestätigung
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
  // Aktive Frage rendern
  // ------------------------------------------------------------------

  const currentAnswer = answers[current.id];
  const currentDraft = drafts[current.id] ?? '';

  return (
    <div className="open-q-inline" role="group" aria-label="Offene Fragen">
      {/* Kopfzeile: Fortschritt + Label */}
      <div className="open-q-stepper-header">
        <span className="open-q-inline-label">Offene Fragen</span>
        {!isSingle && (
          <span className="open-q-stepper-progress" aria-live="polite">
            {currentIndex + 1} / {total}
          </span>
        )}
      </div>

      {/* Aktuelle Frage */}
      <div className="open-q-inline-q">
        <div className="open-q-inline-text">
          <span>{current.text}</span>
          {/* Bereits gewählte Antwort: inline-Badge zur schnellen Übersicht */}
          {currentAnswer !== undefined && (
            <span className="open-q-answered" aria-label={`Gewählt: ${currentAnswer}`}>
              {currentAnswer}
            </span>
          )}
        </div>

        {hasOptions ? (
          /* Options: eigene Buttons mit selected-Zustand (QuickChoice hat kein
             aria-pressed / selected-Konzept, deshalb eigene Variante). */
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
          /* Free-Text: Textarea + "Merken"-Button (kein sofortiger Submit) */
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
                // Cmd/Ctrl+Enter: Draft als Antwort für diese Frage merken
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

      {/* Footer: Navigation + finaler Submit-Button */}
      <div className="open-q-stepper-footer">
        {/* Vor/Zurück-Navigation — nur wenn mehrere Fragen */}
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
          {/* Hinweis: wie viele Fragen noch unbeantwortet */}
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
 * Kompakte, NICHT-interaktive Referenz für die `## Offene Fragen`-Section im
 * Nachrichtenstrom. Seit UX-1 ist der primäre Antwort-Flow die Q/A-Pill ÜBER
 * dem Composer (ChatOpenQuestionsPill). Diese Inline-Markierung verweist nur
 * darauf — sie eröffnet KEINEN zweiten reply()-Pfad (kein Doppel-Send).
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
