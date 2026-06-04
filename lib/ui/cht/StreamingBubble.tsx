'use client';

/**
 * lib/ui/cht/StreamingBubble.tsx
 * ------------------------------
 * Phase Reload-Recovery V2 · 2026-04-27.
 * Surface refactor wave 2 (2026-05-01): inline styles + local keyframes
 * out, tokens via CSS classes from app/components.css. The `lazyos-cursor`
 * keyframe exists in app/globals.css and is consumed by .bub-caret.
 *
 * Component ID: `chat-streaming-bubble` (LazyOS Design Manifest v1.0).
 *
 * Renders an assistant answer that is NOT streamed live by this tab,
 * but comes from a `streaming_snapshots` row in the history endpoint.
 * Two mutually-exclusive states:
 *
 *   - `state='streaming'`
 *       Pulsing caret at the text end, segment-accented tint
 *       (`var(--a-now)`). NO spinner carousel. The user sees "it keeps
 *       running, I'm just a passive observer".
 *
 *   - `state='aborted'`
 *       Static gray (`--ink-3`), hint footer verbatim:
 *       "Antwort wurde unterbrochen — Teilstand gespeichert."
 *       Three action buttons:
 *           [Regenerieren] [Verwerfen] [Trotzdem kopieren]
 *
 * Extra features:
 *   - `inCodeBlock=true` (snapshot was taken mid-```-code-block):
 *       red inline hint "(Code unvollständig — nicht ausführen)"
 *       directly below the snippet. Prevents the user from perceiving
 *       half-written code as copy-paste-ready.
 *   - `toolState != null && toolState.status='pending'`:
 *       footer line "Tool-Aufruf nicht beendet" as a replacement for
 *       an endless spinner. The tool name becomes visible.
 *
 * Design-manifest compliance:
 *   - Pitch-black container (`--card`), 0.5px `--line-2` border
 *   - SF Pro Display via `inherit` (body sets it in app/globals.css)
 *   - Segment accent dynamic via `--a-now` (body.classList)
 *   - `prefers-reduced-motion`: caret does not pulse, static
 *
 * Own UI component (no shadcn) — follows CLAUDE.md "Nicht in diesem
 * Projekt".
 */

import { useCallback, useState, type JSX } from 'react';

import type { StreamingState, StreamingToolState } from '@/lib/chat/types';

export interface StreamingBubbleProps {
  /** Stream state from the server snapshot. */
  state: StreamingState;
  /** Text streamed so far. Markdown-free, raw. */
  partialContent: string;
  /** True when the last snapshot was taken mid-```-code-block. */
  inCodeBlock: boolean;
  /** Pending tool call at the crash (or null). */
  toolState: StreamingToolState | null;
  /** "Regenerieren" — re-emit the original prompt. */
  onRegenerate?: () => void;
  /** "Verwerfen" — DELETE the snapshot in the backend, remove the bubble. */
  onDiscard?: () => void;
  /** "Trotzdem kopieren" — partialContent to the clipboard. */
  onCopy?: () => void;
  /** Optional aria-label for screen readers. */
  ariaLabel?: string;
}

const ABORTED_FOOTER_TEXT =
  'Antwort wurde unterbrochen — Teilstand gespeichert.';
const CODEBLOCK_WARN_TEXT = '(Code unvollständig — nicht ausführen)';
const TOOL_PENDING_TEXT = 'Tool-Aufruf nicht beendet';

export function StreamingBubble({
  state,
  partialContent,
  inCodeBlock,
  toolState,
  onRegenerate,
  onDiscard,
  onCopy,
  ariaLabel,
}: StreamingBubbleProps): JSX.Element {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(partialContent);
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* Clipboard can also fail without permission (insecure context). */
    }
    onCopy?.();
  }, [partialContent, onCopy]);

  const isStreaming = state === 'streaming';
  const showText = partialContent.trim().length > 0;

  const role = isStreaming ? 'status' : 'article';
  const ariaLive = isStreaming ? 'polite' : undefined;
  const computedAriaLabel =
    ariaLabel ??
    (isStreaming
      ? 'Antwort streamt weiter im Hintergrund'
      : 'Abgebrochene Antwort — Teilstand gespeichert');

  return (
    <div
      className="msg-a bub-streaming"
      data-streaming-state={state}
      data-component-id="chat-streaming-bubble"
      role={role}
      aria-live={ariaLive}
      aria-label={computedAriaLabel}
    >
      <div className="txt">
        {showText ? <span>{partialContent}</span> : null}
        {isStreaming ? (
          <span
            aria-hidden="true"
            className={
              showText ? 'bub-caret' : 'bub-caret bub-caret--leading'
            }
          />
        ) : null}
        {!showText && !isStreaming ? (
          <span className="empty-placeholder">(kein Text empfangen)</span>
        ) : null}
      </div>

      {inCodeBlock ? (
        <div role="note" className="code-warn">
          {CODEBLOCK_WARN_TEXT}
        </div>
      ) : null}

      {toolState && toolState.status === 'pending' ? (
        <div role="note" className="tool-pending">
          <span className="tool-pending-dot" aria-hidden="true" />
          <span>
            <span className="tool-pending-name">{toolState.name}</span>{' '}
            · {TOOL_PENDING_TEXT}
          </span>
        </div>
      ) : null}

      {!isStreaming ? (
        <>
          <div role="note" className="aborted-footer">
            {ABORTED_FOOTER_TEXT}
          </div>
          <div className="actions-row">
            <button
              type="button"
              onClick={onRegenerate}
              disabled={!onRegenerate}
              className="btn-primary"
              aria-label="Antwort neu generieren"
            >
              Regenerieren
            </button>
            <button
              type="button"
              onClick={onDiscard}
              disabled={!onDiscard}
              className="btn-secondary"
              aria-label="Teilantwort verwerfen"
            >
              Verwerfen
            </button>
            <button
              type="button"
              onClick={handleCopy}
              className="btn-secondary"
              aria-label="Teilantwort trotzdem kopieren"
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
                'Trotzdem kopieren'
              )}
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}
