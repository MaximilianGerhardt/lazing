'use client';

/**
 * ChatInlineOpenQuestions — open-questions in-stream marker.
 *
 * SP-8 (2026-06): the INTERACTIVE in-bubble stepper that used to live here was
 * retired. It opened a SECOND, competing answer path (its own reply()) next to
 * the bottom pill (ChatOpenQuestionsPill via ActionDeck) — a box-in-box that
 * broke with the design and risked double-sends. The single answer surface is
 * now the bottom pill; the stream only shows a compact, NON-interactive
 * POINTER to it.
 *
 * Only `OpenQuestionsInlineRef` remains. Both the `<surface:open-questions>`
 * tag (renderOpenQuestions in SurfaceRenderer) and the `## Offene Fragen`
 * markdown section (surface-text-render.tsx) render it — one consistent marker,
 * one reply() path.
 */

// ---------------------------------------------------------------------------
// OpenQuestionsInlineRef — compact, NON-interactive stream marker.
// ---------------------------------------------------------------------------
/**
 * Points at the bottom Q/A pill (ChatOpenQuestionsPill) where the questions are
 * actually answered. Opens NO reply() path of its own (no double send).
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

export default OpenQuestionsInlineRef;
