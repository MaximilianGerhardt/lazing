'use client';

/**
 * MessageActions — Codex-style hover actions below a finished
 * assistant answer (Goal 2026-06-02). Codex shows a
 * subtle row below every answer: copy + regenerate. Until now, only transient
 * reload snapshots (`StreamingBubble`) had such controls — normal persisted
 * answers had none.
 *
 * Visibility via CSS: faint/closed, revealed on `.msg-a:hover` / `:focus-within`
 * (desktop), or permanently slightly visible on touch devices
 * (`@media (hover: none)`). Styles live in app/components.css under
 * `.msg-actions`.
 */

import { useCallback, useState, type ReactElement } from 'react';

export interface MessageActionsProps {
  /** Pure prose text to copy (surface tags already removed by the caller). */
  copyText: string;
  /** Re-run the previous user prompt. Omitting hides the button. */
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
      /* clipboard not available in insecure contexts — silently ignore */
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
