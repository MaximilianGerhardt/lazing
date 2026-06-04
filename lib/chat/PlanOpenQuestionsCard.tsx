'use client';

/**
 * PlanOpenQuestionsCard — Wave 7 (2026-05-01)
 *
 * Persistent card variant of OpenQuestionsSurface. The server today emits
 * both redundantly (kind='plan-open-questions' in the commented path
 * AND a `<surface:open-questions>` card via emitOrUpdateCard). The
 * commented variant had no surface — the user only saw toast/spam.
 *
 * This card renders the questions with QuickChoice buttons (analogous to
 * OpenQuestionsSurface) — the click replies via SurfaceActionContext with
 * the chosen option label, so the server gets the answer back as a chat-
 * message-sent.
 */

import type { ReactElement } from 'react';

import { useSurfaceAction } from './SurfaceActionContext';

interface Question {
  id: string;
  q: string;
  options?: string[];
}

interface Props {
  workstreamId?: string;
  workspaceId?: string;
  questions: Question[];
}

export function PlanOpenQuestionsCard(props: Props): ReactElement {
  const { reply } = useSurfaceAction();
  return (
    <div
      className="srf-plan-questions"
      role="region"
      aria-label="Offene Fragen zum Plan"
    >
      <div className="srf-plan-questions__header">
        <span className="srf-plan-questions__badge">Offene Fragen</span>
        <span className="srf-plan-questions__title">
          {props.questions.length === 1
            ? 'Eine offene Frage zum Plan'
            : `${props.questions.length} offene Fragen zum Plan`}
        </span>
      </div>
      <ul className="srf-plan-questions__list">
        {props.questions.map((q, idx) => (
          <li key={q.id || idx} className="srf-plan-questions__item">
            <div className="srf-plan-questions__question">{q.q}</div>
            {q.options && q.options.length > 0 ? (
              <div className="srf-plan-questions__options">
                {q.options.map((opt) => (
                  <button
                    key={opt}
                    type="button"
                    className="srf-plan-questions__opt press"
                    onClick={() => reply(`${q.q}\n→ ${opt}`)}
                  >
                    {opt}
                  </button>
                ))}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
