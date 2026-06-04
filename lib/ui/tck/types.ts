/**
 * TCK-01 — Ticket types.
 *
 * `Ticket` is the pure presentational card used inside Lane-lists,
 * Card-Grids and Chat surface-blocks. `TicketSurface` is the
 * Phase-4 "review request" extension used by the agent when it
 * wants human feedback: checklist + test-target link + free-form
 * feedback + three QCK quick actions (ok / adjust / reject).
 */

export type TicketStatus = 'open' | 'done' | 'danger' | 'wait';

/**
 * Priority label. Structured values (`'P0' | 'P1' | 'P2' | 'P3'`) and
 * the two terminal states (`'DONE'`, `'ESCAL'`) are supported out of
 * the box; arbitrary strings are also accepted so the agent can pass
 * composed labels like `"P1 · HOCH"` without losing type-safety.
 */
export type TicketPrio =
  | 'P0'
  | 'P1'
  | 'P2'
  | 'P3'
  | 'DONE'
  | 'ESCAL'
  | (string & {});

export interface TicketProps {
  /** e.g. `"TCK-4281"` — rendered mono in the header. */
  id: string;
  /** Visual variant. Defaults to `'open'`. */
  status?: TicketStatus;
  /** Optional priority badge (e.g. `"P1 · HOCH"`). */
  prio?: TicketPrio;
  /** Main headline — always rendered. */
  title: string;
  /** Optional body copy. */
  body?: string;
  /** Segment tag (rendered with `.tag.a` accent styling). */
  segment?: string;
  /** Assignee label (e.g. `"Lena K."`). */
  assignee?: string;
  /** Due-date string (e.g. `"14.05."`) — rendered bold. */
  due?: string;
  /** Extra generic footer tags (neutral styling). */
  footTags?: string[];
  /**
   * Optional click handler. When provided, the card becomes
   * keyboard-activatable (button-role, Enter/Space).
   */
  onClick?: () => void;
  className?: string;
}

export interface TicketReviewChecklistItem {
  id: string;
  label: string;
  detail?: string;
}

export type TicketReviewAction = 'ok' | 'adjust' | 'reject';

export interface TicketReviewFeedback {
  quickAction?: TicketReviewAction;
  text?: string;
  checkedItems?: string[];
}

export interface TicketSurfaceProps extends TicketProps {
  /**
   * Checklist the reviewer should tick off before approving. The
   * component tracks `checked` state locally; a submission hands
   * the list of checked IDs back via `onFeedbackSubmit`.
   */
  reviewChecklist?: TicketReviewChecklistItem[];
  /**
   * If set, renders a prominent CTA that opens this URL in a new
   * tab. Intended for deep-links like `"/lanes?focus=clientb"` so
   * the reviewer can verify the change in-situ.
   */
  testTargetUrl?: string;
  /** Label for the test-target CTA. Defaults to `"Direkt testen"`. */
  testTargetLabel?: string;
  /**
   * Async submit handler. If omitted, the three quick-action
   * buttons render in a disabled state.
   */
  onFeedbackSubmit?: (feedback: TicketReviewFeedback) => Promise<void>;
}
