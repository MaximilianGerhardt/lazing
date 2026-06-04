'use client';

/**
 * lib/chat/ChatHeaderToolbar.tsx
 * ------------------------------
 * Sub-Plan B · 2026-04-29 — History-Toggle.
 * 2026-05-03 Welle C — Schlankheit über alles.
 *
 * Verlauf-Pill rechts in der Sticky-Header-Row neben dem `•••`-Trigger.
 * - Bei `archivedCount === 0`: rendert NICHTS. Chat bleibt minimal,
 *   `•••` ist die einzige Header-Aktion.
 * - Off-State: dezent (Mono-Icon ▸ + „Verlauf"-Label, opacity 0.55-Hover-Aufblendung).
 * - On-State: --a-now Akzent + Badge mit archiv-Count.
 *
 * KEIN Overlay, KEIN Modal, KEIN sticky-Floating außerhalb des Stream-Containers.
 * Sticky-Layout + Backdrop leben im Parent-Wrapper (`.chat-header-toolbar-row`).
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
  // Welle C 2026-05-03: nichts rendern wenn nichts archiviert wurde.
  // Chat ist schlank, nur •••-Trigger zeigt sich.
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
