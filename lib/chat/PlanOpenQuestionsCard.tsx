'use client';

/**
 * PlanOpenQuestionsCard — Welle 7 (2026-05-01)
 *
 * Persistente Card-Variante zu OpenQuestionsSurface. Der Server emittiert
 * heute beides redundant (kind='plan-open-questions' im commented-Pfad
 * UND eine `<surface:open-questions>`-Card via emitOrUpdateCard). Die
 * commented-Variante hatte keine Surface — User sah nur Toast/Spam.
 *
 * Diese Card rendert die Fragen mit QuickChoice-Buttons (analog
 * OpenQuestionsSurface) — der Klick replied via SurfaceActionContext mit
 * dem gewählten Option-Label, sodass der Server die Antwort als chat-
 * message-sent zurück bekommt.
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
