import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
} from 'react';
import type React from 'react';

import type { TicketProps, TicketStatus } from './types';

function classNames(
  ...parts: Array<string | false | null | undefined>
): string {
  return parts.filter(Boolean).join(' ');
}

/**
 * Map `TicketStatus` to the CSS modifier on `.ticket`. The default
 * (`'open'`) yields no modifier — the base class uses `--a-now`
 * (orange) via the existing stylesheet.
 */
function statusClass(status: TicketStatus): string | undefined {
  switch (status) {
    case 'done':
      return 'done';
    case 'danger':
      return 'danger';
    case 'wait':
      return 'wait';
    case 'open':
    default:
      return undefined;
  }
}

function statusAnnouncement(status: TicketStatus): string {
  switch (status) {
    case 'done':
      return 'Erledigt';
    case 'danger':
      return 'Kritisch';
    case 'wait':
      return 'Wartet';
    case 'open':
    default:
      return 'Offen';
  }
}

/**
 * TCK-01 — Ticket.
 *
 * Pure presentational card for a task / ticket / work-item. Safe
 * to render as a Server Component — no state, no effects.
 *
 * Four status variants are driven by CSS modifiers on `.ticket`:
 *   - (default) → orange accent bar (`--a-now`)
 *   - `.done`   → green  (`--a-clientb`)
 *   - `.danger` → red    (`--a-danger`)
 *   - `.wait`   → grey   (`--ink-3`, no glow)
 */
export function Ticket({
  id,
  status = 'open',
  prio,
  title,
  body,
  segment,
  assignee,
  due,
  footTags,
  onClick,
  className,
}: TicketProps): React.JSX.Element {
  const interactive = typeof onClick === 'function';

  const handleKeyDown = interactive
    ? (event: ReactKeyboardEvent<HTMLElement>) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onClick?.();
        }
      }
    : undefined;

  const handleClick = interactive
    ? (_event: ReactMouseEvent<HTMLElement>) => {
        onClick?.();
      }
    : undefined;

  const hasFooter =
    Boolean(segment) ||
    Boolean(assignee) ||
    Boolean(due) ||
    (footTags !== undefined && footTags.length > 0);

  return (
    <article
      className={classNames('ticket', statusClass(status), className)}
      role={interactive ? 'button' : 'article'}
      tabIndex={interactive ? 0 : undefined}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      aria-label={interactive ? `Ticket ${id}: ${title}` : undefined}
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
        {/*
          Screen-reader-only status hint. The colour-coded accent bar
          is purely visual, so expose the semantics textually.
        */}
        <span className="sr-only">{statusAnnouncement(status)}</span>
      </div>

      <h5>{title}</h5>

      {body ? <div className="body">{body}</div> : null}

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

export default Ticket;
