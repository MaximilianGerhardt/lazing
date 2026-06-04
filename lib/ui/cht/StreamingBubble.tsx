'use client';

/**
 * lib/ui/cht/StreamingBubble.tsx
 * ------------------------------
 * Phase Reload-Recovery V2 · 2026-04-27.
 * Surface-Refactor Welle 2 (2026-05-01): Inline-Styles + lokale Keyframes
 * raus, Tokens via CSS-Klassen aus app/components.css. Keyframe `lazyos-cursor`
 * existiert in app/globals.css und wird von .bub-caret konsumiert.
 *
 * Komponenten-ID: `chat-streaming-bubble` (LazyOS Design Manifest v1.0).
 *
 * Rendert eine Assistant-Antwort die NICHT live von dieser Tab gestreamt
 * wird, sondern aus einem `streaming_snapshots`-Row im History-Endpoint
 * stammt. Zwei mutually-exclusive States:
 *
 *   - `state='streaming'`
 *       Pulsierender Caret am Textende, segment-akzentuierte Toenung
 *       (`var(--a-now)`). KEIN Spinner-Karussell. User sieht "es laeuft
 *       weiter, ich bin nur passiver Beobachter".
 *
 *   - `state='aborted'`
 *       Statisches Grau (`--ink-3`), Hinweis-Footer woertlich:
 *       "Antwort wurde unterbrochen — Teilstand gespeichert."
 *       Drei Action-Buttons:
 *           [Regenerieren] [Verwerfen] [Trotzdem kopieren]
 *
 * Zusatzfunktionen:
 *   - `inCodeBlock=true` (Snapshot wurde mid-```-Codeblock genommen):
 *       roter Inline-Hinweis "(Code unvollständig — nicht ausführen)"
 *       direkt unter dem Snippet. Verhindert dass User halb-geschriebenen
 *       Code copy-paste-faehig wahrnimmt.
 *   - `toolState != null && toolState.status='pending'`:
 *       Footer-Zeile "Tool-Aufruf nicht beendet" als Replacement fuer
 *       einen Endlos-Spinner. Tool-Name wird sichtbar.
 *
 * Design-Manifest-Compliance:
 *   - Pitch-Black-Container (`--card`), 0.5px `--line-2`-Border
 *   - SF Pro Display via `inherit` (Body setzt das in app/globals.css)
 *   - Segment-Akzent dynamisch ueber `--a-now` (body.classList)
 *   - `prefers-reduced-motion`: Caret pulsiert nicht, statisch
 *
 * Eigene UI-Komponente (kein shadcn) — folgt CLAUDE.md "Nicht in diesem
 * Projekt".
 */

import { useCallback, useState, type JSX } from 'react';

import type { StreamingState, StreamingToolState } from '@/lib/chat/types';

export interface StreamingBubbleProps {
  /** Stream-State aus dem Server-Snapshot. */
  state: StreamingState;
  /** Bisher gestreamter Text. Markdown-frei, raw. */
  partialContent: string;
  /** True wenn der letzte Snapshot mid-```-Codeblock genommen wurde. */
  inCodeBlock: boolean;
  /** Pending Tool-Call beim Crash (oder null). */
  toolState: StreamingToolState | null;
  /** "Regenerieren" — original-Prompt re-emit. */
  onRegenerate?: () => void;
  /** "Verwerfen" — Snapshot DELETE im Backend, Bubble entfernen. */
  onDiscard?: () => void;
  /** "Trotzdem kopieren" — partialContent in Zwischenablage. */
  onCopy?: () => void;
  /** Optional aria-label fuer Screenreader. */
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
      /* Clipboard kann auch ohne Permission scheitern (insecure context). */
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
