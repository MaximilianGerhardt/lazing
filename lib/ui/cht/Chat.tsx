'use client';

import type { ReactNode } from 'react';

interface ChatProps {
  children: ReactNode;
  className?: string;
}

/**
 * CHT-01 — Transformative Chat container.
 *
 * Renders a vertical stack of chat messages. Expects
 * <MsgUser>, <MsgAssistant> and <MsgCard> as children.
 *
 * A11y:
 * - `role="log"` + `aria-live="polite"` announces new messages
 *   to assistive tech without stealing focus.
 * - `aria-relevant="additions"` keeps announcements to newly
 *   appended content (not re-reads of the whole history).
 *
 * Marked 'use client' so the component can later grow
 * scroll-to-bottom / auto-stick behaviour without a breaking
 * change. Child bubbles stay server-safe (no client directive)
 * so they can be streamed from Server Components.
 */
export function Chat({ children, className }: ChatProps) {
  const cls = className ? `chat ${className}` : 'chat';
  return (
    <div
      className={cls}
      role="log"
      aria-live="polite"
      aria-relevant="additions"
    >
      {children}
    </div>
  );
}
