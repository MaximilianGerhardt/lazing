'use client';

import {
  ChangeEvent as ReactChangeEvent,
  useCallback,
  useId,
  useMemo,
  useState,
} from 'react';
import type React from 'react';

import type {
  TicketReviewAction,
  TicketReviewFeedback,
  TicketSurfaceProps,
} from './types';

function classNames(
  ...parts: Array<string | false | null | undefined>
): string {
  return parts.filter(Boolean).join(' ');
}

function statusClass(status: TicketSurfaceProps['status']): string | undefined {
  switch (status) {
    case 'done':
      return 'done';
    case 'danger':
      return 'danger';
    case 'wait':
      return 'wait';
    default:
      return undefined;
  }
}

/**
 * TCK-01 / Phase-4 — Ticket Surface (Review Request).
 *
 * Extends the basic `<Ticket>` with the review-request flow:
 *
 *   1. A checklist the reviewer must tick off.
 *   2. A prominent CTA that opens the deep-link in a new tab so
 *      the change can be verified in-situ.
 *   3. A free-form feedback textarea.
 *   4. Three QCK-style quick actions (OK / adjust / reject).
 *
 * The component is controlled internally for the checklist and
 * textarea; on quick-action click it bundles everything into a
 * `TicketReviewFeedback` object and hands it off to the parent
 * via `onFeedbackSubmit`. When no handler is provided the quick
 * actions render disabled (never fire no-op submits).
 *
 * This component is explicitly `'use client'` because it owns UI
 * state and async submission. The pure `<Ticket>` remains a
 * Server Component.
 */
export function TicketSurface(props: TicketSurfaceProps): React.JSX.Element {
  const {
    // Ticket base props
    id,
    status = 'open',
    prio,
    title,
    body,
    segment,
    assignee,
    due,
    footTags,
    className,
    // Surface extension props
    reviewChecklist,
    testTargetUrl,
    testTargetLabel = 'Direkt testen',
    onFeedbackSubmit,
  } = props;

  const surfaceId = useId();
  const checklistLegendId = `${surfaceId}-checklist`;
  const feedbackLabelId = `${surfaceId}-feedback`;
  const quickActionsLabelId = `${surfaceId}-actions`;

  // --- Checklist state ------------------------------------------------------
  const initialCheckedMap = useMemo<Record<string, boolean>>(
    () =>
      (reviewChecklist ?? []).reduce<Record<string, boolean>>((acc, item) => {
        acc[item.id] = false;
        return acc;
      }, {}),
    [reviewChecklist],
  );

  const [checkedMap, setCheckedMap] = useState<Record<string, boolean>>(
    initialCheckedMap,
  );

  const toggleChecked = useCallback(
    (itemId: string) =>
      (event: ReactChangeEvent<HTMLInputElement>) => {
        const next = event.target.checked;
        setCheckedMap((prev) => ({ ...prev, [itemId]: next }));
      },
    [],
  );

  const checkedItems = useMemo(
    () => Object.keys(checkedMap).filter((key) => checkedMap[key] === true),
    [checkedMap],
  );

  // --- Feedback text --------------------------------------------------------
  const [text, setText] = useState<string>('');
  const handleTextChange = useCallback(
    (event: ReactChangeEvent<HTMLTextAreaElement>) => {
      setText(event.target.value);
    },
    [],
  );

  // --- Submission -----------------------------------------------------------
  const [submitting, setSubmitting] = useState<TicketReviewAction | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = typeof onFeedbackSubmit === 'function';

  const submit = useCallback(
    async (quickAction: TicketReviewAction) => {
      if (!onFeedbackSubmit) return;
      setSubmitting(quickAction);
      setError(null);
      const payload: TicketReviewFeedback = {
        quickAction,
        text: text.trim() === '' ? undefined : text.trim(),
        checkedItems,
      };
      try {
        await onFeedbackSubmit(payload);
      } catch (err) {
        // Surface a terse message; the parent is responsible for
        // richer error handling (toast, re-queue, ...).
        const message =
          err instanceof Error && err.message
            ? err.message
            : 'Feedback konnte nicht gesendet werden.';
        setError(message);
      } finally {
        setSubmitting(null);
      }
    },
    [onFeedbackSubmit, text, checkedItems],
  );

  const hasFooter =
    Boolean(segment) ||
    Boolean(assignee) ||
    Boolean(due) ||
    (footTags !== undefined && footTags.length > 0);

  return (
    <article
      className={classNames(
        'ticket',
        'ticket-surface',
        statusClass(status),
        className,
      )}
      aria-labelledby={`${surfaceId}-title`}
      data-ticket-id={id}
      data-status={status}
    >
      <div className="th">
        <span className="tid">{id}</span>
        {prio ? (
          <span
            className="prio"
            role="status"
            aria-label={`Priorität ${prio}`}
          >
            {prio}
          </span>
        ) : null}
      </div>

      <h5 id={`${surfaceId}-title`}>{title}</h5>

      {body ? <div className="body">{body}</div> : null}

      {reviewChecklist && reviewChecklist.length > 0 ? (
        <fieldset
          className="ticket-checklist"
          aria-labelledby={checklistLegendId}
        >
          <legend id={checklistLegendId}>Checkliste</legend>
          <ul>
            {reviewChecklist.map((item) => {
              const inputId = `${surfaceId}-chk-${item.id}`;
              const isChecked = checkedMap[item.id] === true;
              return (
                <li key={item.id}>
                  <label htmlFor={inputId}>
                    <input
                      id={inputId}
                      type="checkbox"
                      checked={isChecked}
                      onChange={toggleChecked(item.id)}
                    />
                    <span className="ck-label">
                      <span className="ck-main">{item.label}</span>
                      {item.detail ? (
                        <span className="ck-detail">{item.detail}</span>
                      ) : null}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        </fieldset>
      ) : null}

      {testTargetUrl ? (
        <a
          className="ticket-test-target"
          href={testTargetUrl}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`${testTargetLabel} (öffnet in neuem Tab)`}
        >
          {testTargetLabel}
          <span aria-hidden="true"> ↗</span>
        </a>
      ) : null}

      <label className="ticket-feedback-label" htmlFor={feedbackLabelId}>
        Feedback
      </label>
      <textarea
        id={feedbackLabelId}
        className="ticket-feedback"
        value={text}
        onChange={handleTextChange}
        placeholder="Anmerkungen, Hinweise, Blocker …"
        rows={3}
      />

      <div
        className="qc ticket-qc"
        role="group"
        aria-labelledby={quickActionsLabelId}
      >
        <span id={quickActionsLabelId} className="sr-only">
          Schnellaktionen
        </span>
        <button
          type="button"
          className="p"
          onClick={() => {
            void submit('ok');
          }}
          disabled={!canSubmit || submitting !== null}
          aria-busy={submitting === 'ok'}
        >
          OK
          <small>Freigeben</small>
        </button>
        <button
          type="button"
          onClick={() => {
            void submit('adjust');
          }}
          disabled={!canSubmit || submitting !== null}
          aria-busy={submitting === 'adjust'}
        >
          Anpassen
          <small>Nachbessern</small>
        </button>
        <button
          type="button"
          onClick={() => {
            void submit('reject');
          }}
          disabled={!canSubmit || submitting !== null}
          aria-busy={submitting === 'reject'}
        >
          Ablehnen
          <small>Verwerfen</small>
        </button>
      </div>

      {error ? (
        <div role="alert" className="ticket-error">
          {error}
        </div>
      ) : null}

      {hasFooter ? (
        <div className="foot">
          {segment ? <span className="tag a">{segment}</span> : null}
          {assignee ? <span>{assignee}</span> : null}
          {footTags && footTags.length > 0
            ? footTags.map((tag) => (
                <span className="tag" key={tag}>
                  {tag}
                </span>
              ))
            : null}
          <span style={{ flex: 1 }} aria-hidden="true" />
          {due ? (
            <span>
              fällig <b>{due}</b>
            </span>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

export default TicketSurface;
