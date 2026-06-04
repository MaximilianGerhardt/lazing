'use client';

/**
 * lib/chat/ChatHeaderToolbar.tsx
 * ------------------------------
 * Sub-Plan B · 2026-04-29 — history toggle.
 * 2026-05-03 Wave C — leanness above all.
 *
 * History pill on the right of the sticky header row next to the `•••` trigger.
 * - When `archivedCount === 0`: renders NOTHING. The chat stays minimal,
 *   `•••` is the only header action.
 * - Off state: subtle (mono icon ▸ + „Verlauf" label, opacity 0.55 hover fade-in).
 * - On state: --a-now accent + badge with the archive count.
 *
 * NO overlay, NO modal, NO sticky-floating outside the stream container.
 * Sticky layout + backdrop live in the parent wrapper (`.chat-header-toolbar-row`).
 */

import { IconChevronDown, IconChevronRight } from '../nav/icons';

interface ChatHeaderToolbarProps {
  showHistory: boolean;
  onToggleHistory: () => void;
  archivedCount: number;
}

export function ChatHeaderToolbar({
  showHistory,
  onToggleHistory,
  archivedCount,
}: ChatHeaderToolbarProps): React.JSX.Element | null {
  // Wave C 2026-05-03: render nothing when nothing was archived.
  // The chat is lean, only the ••• trigger shows.
  if (archivedCount <= 0) return null;

  const label = showHistory ? 'Verlauf · an' : 'Verlauf';

  return (
    <button
      type="button"
      onClick={onToggleHistory}
      aria-pressed={showHistory}
      aria-label={
        showHistory
          ? `Verlauf einklappen (${archivedCount} archivierte Einträge sichtbar)`
          : `Verlauf zeigen — ${archivedCount} archivierte Einträge`
      }
      className="chat-toolbar__btn"
    >
      <span aria-hidden="true">{showHistory ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}</span>
      <span>{label}</span>
      <span className="chat-toolbar__badge">{archivedCount}</span>
    </button>
  );
}
