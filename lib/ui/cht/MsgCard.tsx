import type { ReactNode } from 'react';

interface MsgCardProps {
  /**
   * A single Surface-Block card (Chart, Decision, Ticket,
   * Invoice, ...) rendered inline inside the chat stream.
   */
  children: ReactNode;
  /**
   * Accessible label for the card region. Defaults to
   * "Assistant card" when not provided.
   */
  ariaLabel?: string;
}

/**
 * CHT-01 — Inline Surface-Card slot.
 *
 * Thin wrapper that aligns a Surface-Block with the assistant
 * column (left, max-width 520px — see `.msg-card` in
 * app/components.css). The child Surface-Block owns its own
 * visual styling; this wrapper only handles chat-layout and
 * a11y semantics.
 */
export function MsgCard({ children, ariaLabel }: MsgCardProps) {
  return (
    <div
      className="msg-card"
      role="article"
      aria-label={ariaLabel ?? 'Assistant card'}
    >
      {children}
    </div>
  );
}
