'use client';

/**
 * MessageActions — Codex-artige Hover-Aktionen unter einer fertigen
 * Assistant-Antwort (Goal 2026-06-02). Codex zeigt unter jeder Antwort eine
 * dezente Reihe: Kopieren + Neu generieren. Bisher hatten nur transiente
 * Reload-Snapshots (`StreamingBubble`) solche Controls — normale persistierte
 * Antworten hatten keine.
 *
 * Sichtbarkeit per CSS: faint/zu, auf `.msg-a:hover` / `:focus-within`
 * enthüllt (Desktop) bzw. dauerhaft leicht sichtbar auf Touch-Geräten
 * (`@media (hover: none)`). Styles leben in app/components.css unter
 * `.msg-actions`.
 */

import { useCallback, useState, type ReactElement } from 'react';

export interface MessageActionsProps {
  /** Reiner Prosa-Text zum Kopieren (Surface-Tags vom Caller bereits entfernt). */
  copyText: string;
  /** Vorherigen User-Prompt neu ausführen. Weglassen blendet den Button aus. */
  onRegenerate?: () => void;
}

export function MessageActions({ copyText, onRegenerate }: MessageActionsProps): ReactElement {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(copyText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard in unsicheren Kontexten nicht verfügbar — still ignorieren */
    }
  }, [copyText]);

  return (
    <div className="msg-actions" role="group" aria-label="Nachrichten-Aktionen">
      <button
        type="button"
        className="msg-actions__btn"
        onClick={handleCopy}
        aria-label={copied ? 'Kopiert' : 'Antwort kopieren'}
      >
        {copied ? (
          <>
            Kopiert{' '}
            <svg
              width={14}
              height={14}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.6}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M5 12.5l4 4 10-10" />
            </svg>
          </>
        ) : (
          'Kopieren'
        )}
      </button>
      {onRegenerate ? (
        <button
          type="button"
          className="msg-actions__btn"
          onClick={onRegenerate}
          aria-label="Antwort neu generieren"
        >
          Neu generieren
        </button>
      ) : null}
    </div>
  );
}

export default MessageActions;
