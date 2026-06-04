'use client';

/**
 * ChatComposer — Apple-pure Chat-Input.
 *
 * Design intent (2026-04-24):
 *   - ONE prominent central input field (max-width 860, 56 px tall).
 *   - Mic icon INLINE on the right, like Apple Notes / Messages.
 *   - Submit arrow only visible when there is text OR STT is running.
 *   - No context chip, no workspace pill, no bullet — the
 *     header WorkspaceSwitcher is the single source of truth for scope.
 *   - Font ≥ 16 px on mobile → iOS suppresses auto-zoom.
 *   - Focus: subtle glow via `--a-now`, no hard outline.
 *   - Mic states: default → faint; listening → pulses + ring.
 *
 * API:
 *   - Controlled component — `value` + `onChange` + `onSubmit` come
 *     from the parent (ChatShell).
 *   - STT props are passed through so the composer can draw the mic button
 *     itself — the recognition logic stays in ChatShell.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { IconArrowUp, IconMic, IconMicActive, IconPaperclip } from './icons';
import type { ChatSuggestion } from './useChatSuggestions';
import { useDraftPersistence } from './draft';
import { useHaptic } from '@/lib/hooks/useHaptic';

export interface ChatComposerProps {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
  /** STT API available? Controls mic visibility. */
  sttSupported: boolean;
  /** Currently recording. */
  sttListening: boolean;
  /** Interim text from recognition (live preview). */
  sttInterim?: string;
  /** Mic toggle. */
  onSttToggle: () => void;
  /** Aria-label for the whole form. */
  ariaLabel?: string;
  /** Inline auto-suggestions (mobile-first, dropdown ABOVE the input). */
  suggestions?: ChatSuggestion[];
  /** Active suggestion (keyboard-highlighted). */
  activeSuggestIndex?: number;
  /** Caller sets via hover / arrow-keys. */
  onSuggestHover?: (i: number) => void;
  /** Called when user picks a suggestion (click / enter on active). */
  onSuggestSelect?: (s: ChatSuggestion) => void;
  /** Keyboard-nav (ArrowUp/Down/Escape). */
  onSuggestNavigate?: (key: 'up' | 'down' | 'escape') => void;
  /**
   * Phase Reload-Recovery V2 · 2026-04-27.
   * Workspace ID for draft persistence (localStorage key
   * `lazyos.chat.draft.{workspaceId}`). If set, the composer restores
   * the last draft on mount/switch and persists
   * every change debounced 500ms. If not set: draft persistence
   * inactive (backwards-compat for other mounts if ever).
   */
  workspaceId?: string;
  /**
   * File-upload hook (Sprint Cloud · 2026-04-27).
   * Receives the files from the paperclip button or drag&drop. If not
   * set → paperclip + drop are hidden.
   */
  onUploadFiles?: (files: File[]) => void;
  /** While an upload runs → the paperclip is disabled. */
  uploading?: boolean;
  // ---- Bug-2-Fix: Queue + Interrupt (Codex-Stil) · 2026-05-25 ----------
  /**
   * If true: the agent is currently streaming. The composer shows the stop
   * button and Enter enqueues the message instead of sending.
   */
  isStreaming?: boolean;
  /**
   * Stop button: aborts the running turn.
   * Shown only when isStreaming=true.
   */
  onStop?: () => void;
  /**
   * Interrupt-and-send: aborts the running turn and sends the
   * current input message immediately as a new turn (modifier gesture).
   * Shown only when isStreaming=true AND hasText.
   */
  onSendNow?: (v: string) => void;
  /**
   * Number of messages in the queue (> 0 → show queue chip).
   */
  queueLength?: number;
}

export function ChatComposer({
  value,
  onChange,
  onSubmit,
  placeholder = 'Sag mir etwas …',
  disabled = false,
  sttSupported,
  sttListening,
  sttInterim = '',
  onSttToggle,
  ariaLabel = 'Nachricht eingeben',
  suggestions = [],
  activeSuggestIndex = 0,
  onSuggestHover,
  onSuggestSelect,
  onSuggestNavigate,
  workspaceId,
  onUploadFiles,
  uploading = false,
  isStreaming = false,
  onStop,
  onSendNow,
  queueLength = 0,
}: ChatComposerProps) {
  // UX-1 (2026-05-26): auto-grow `<textarea>` instead of single-line `<input>`.
  // Grows up to ~7 lines, then internal scroll, shrinks back on delete.
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const hasSuggestions = suggestions.length > 0;
  const [isDragOver, setIsDragOver] = useState(false);
  // Wave 5 (2026-05-01): native iOS haptic on the send button.
  // `medium` = deliberate action (send), differs from `light`
  // on suggestion tap. The hook bails silently when unsupported.
  const triggerHaptic = useHaptic();

  // UX-1 (2026-05-26): auto-grow resize. Measures scrollHeight after every
  // value change (typing, paste, STT append, programmatic setInput) and
  // sets the textarea height to min(scrollHeight, 7 lines). Until then
  // it grows with it; after that overflow-y:auto (CSS) takes over the scroll.
  // `value` AND `sttInterim` as triggers — the interim tail lies in
  // an overlay, but the value itself changes on the STT final append.
  const MAX_ROWS = 7;
  const resizeTextarea = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    // 1) to 'auto' so scrollHeight does NOT stick to the old
    //    (larger) value on shrink — otherwise the box only grows, never shrinks.
    el.style.height = 'auto';
    // 2) read line-height from the computed style (CSS = single source).
    //    Fallback 23px ≈ 16px * 1.4 if 'normal'/NaN.
    const cs = window.getComputedStyle(el);
    const lh = Number.parseFloat(cs.lineHeight);
    const lineHeight = Number.isFinite(lh) && lh > 0 ? lh : 23;
    const padY =
      (Number.parseFloat(cs.paddingTop) || 0) +
      (Number.parseFloat(cs.paddingBottom) || 0);
    const maxHeight = lineHeight * MAX_ROWS + padY;
    const next = Math.min(el.scrollHeight, maxHeight);
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, []);

  useEffect(() => {
    resizeTextarea();
  }, [value, sttInterim, resizeTextarea]);

  const handleFiles = useCallback(
    (files: FileList | null) => {
      if (!onUploadFiles || !files || files.length === 0) return;
      onUploadFiles(Array.from(files));
    },
    [onUploadFiles],
  );

  // Phase Reload-Recovery V2 · 2026-04-27.
  // Draft persistence per workspace. The hook is a no-op when workspaceId
  // is undefined. The restore path goes via `onChange` (controlled).
  // Persist happens debounced 500ms internally.
  useDraftPersistence(
    workspaceId ?? '__no_persist__',
    value,
    useCallback(
      (restored: string) => {
        // Only restore if the current value is empty — otherwise we would
        // overwrite a typing action (race: user types while
        // localStorage is being read).
        if (value.length === 0) {
          onChange(restored);
        }
      },
      // Deliberately NOT `value` in deps — this callback is only
      // a mount/workspace-switch trigger. The hook stabilizes it
      // internally via a ref.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [onChange],
    ),
  );

  // Visual value = actual value + live interim (if STT is running)
  // The actual <input> shows only `value`; the interim text is
  // rendered AFTER the input as a faint-gray tail so it does not
  // disturb typing.
  const showInterim =
    sttListening && sttInterim.length > 0 && !disabled;

  const hasText = value.trim().length > 0;
  // Submit arrow also visible during STT — so the user can send the
  // interim text directly instead of waiting for auto-stop.
  const showSend = hasText || sttListening;

  const handleSubmit = useCallback(() => {
    if (disabled) return;
    const v = value.trim();
    if (v.length === 0) return;
    // Wave 5: haptic feedback on submit. Only if navigator.vibrate
    // is available AND not prefers-reduced-motion (the hook checks both).
    triggerHaptic('medium');
    onSubmit(v);
  }, [disabled, onSubmit, triggerHaptic, value]);

  // Bug-2-Fix: interrupt-send (modifier gesture Cmd/Ctrl+Enter during streaming).
  const handleSendNow = useCallback(() => {
    if (disabled) return;
    const v = value.trim();
    if (v.length === 0) return;
    triggerHaptic('medium');
    onSendNow?.(v);
  }, [disabled, onSendNow, triggerHaptic, value]);

  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      if (hasSuggestions) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          onSuggestNavigate?.('down');
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          onSuggestNavigate?.('up');
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          onSuggestNavigate?.('escape');
          return;
        }
        if (e.key === 'Tab') {
          const pick = suggestions[activeSuggestIndex];
          if (pick && onSuggestSelect) {
            e.preventDefault();
            onSuggestSelect(pick);
            return;
          }
        }
        if (e.key === 'Enter' && !e.shiftKey) {
          const pick = suggestions[activeSuggestIndex];
          if (pick && onSuggestSelect) {
            e.preventDefault();
            onSuggestSelect(pick);
            return;
          }
        }
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        // Bug-2-Fix: Cmd/Ctrl+Enter during streaming → interrupt-send.
        // Plain Enter → normal submit (enqueued or immediate depending on ChatShell logic).
        if (isStreaming && (e.metaKey || e.ctrlKey) && onSendNow) {
          handleSendNow();
        } else {
          handleSubmit();
        }
      }
    },
    [
      handleSubmit,
      handleSendNow,
      hasSuggestions,
      isStreaming,
      onSendNow,
      suggestions,
      activeSuggestIndex,
      onSuggestNavigate,
      onSuggestSelect,
    ],
  );

  const micLabel = sttListening
    ? 'Aufnahme stoppen'
    : sttSupported
      ? 'Spracheingabe starten'
      : 'Spracheingabe nicht verfügbar';

  return (
    <form
      className="lazyos-composer"
      aria-label={ariaLabel}
      onSubmit={(e) => {
        e.preventDefault();
        handleSubmit();
      }}
      style={{ position: 'relative' }}
    >
      {/* Bug-2-Fix: queue chip — shows how many messages are enqueued. */}
      {queueLength > 0 ? (
        <div style={queueChipStyle} aria-live="polite" aria-label={`${queueLength} Nachricht${queueLength > 1 ? 'en' : ''} in Warteschlange`}>
          <span style={queueChipDotStyle} aria-hidden="true" />
          {queueLength === 1
            ? '1 eingereiht'
            : `${queueLength} eingereiht`}
        </div>
      ) : null}
      {hasSuggestions ? (
        <div
          role="listbox"
          aria-label="Vorschläge"
          style={suggestionListStyle}
        >
          {suggestions.map((s, i) => {
            const active = i === activeSuggestIndex;
            return (
              <button
                key={s.id}
                type="button"
                role="option"
                aria-selected={active}
                onMouseEnter={onSuggestHover ? () => onSuggestHover(i) : undefined}
                onMouseDown={(e) => {
                  // mousedown before blur — so the click does not lose the input
                  e.preventDefault();
                }}
                onClick={() => onSuggestSelect?.(s)}
                onTouchEnd={(e) => {
                  e.preventDefault();
                  onSuggestSelect?.(s);
                }}
                style={{
                  ...suggestionItemStyle,
                  background: active
                    ? 'color-mix(in oklab, var(--a-now) 10%, transparent)'
                    : 'transparent',
                }}
              >
                <span style={suggestionKindStyle(s.kind)}>
                  {s.kind === 'act'
                    ? 'TUE'
                    : s.kind === 'ws'
                      ? 'WS'
                      : s.kind === 'slash'
                        ? 'CMD'
                        : 'GEHE'}
                </span>
                <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
                  <span style={suggestionLabelStyle}>{s.label}</span>
                  {s.detail ? <span style={suggestionDetailStyle}>{s.detail}</span> : null}
                </div>
                <span style={{ fontSize: 11, color: 'var(--ink-4)', fontFamily: 'var(--font-mono)' }}>
                  {active ? '↵' : ''}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
      <div
        className={[
          'lazyos-composer__shell',
          sttListening ? 'lazyos-composer__shell--listening' : '',
          isDragOver && onUploadFiles
            ? 'lazyos-composer__shell--drag-over'
            : '',
        ]
          .filter(Boolean)
          .join(' ')}
        onClick={() => inputRef.current?.focus()}
        onDragEnter={
          onUploadFiles
            ? (e) => {
                e.preventDefault();
                if (e.dataTransfer.types.includes('Files')) setIsDragOver(true);
              }
            : undefined
        }
        onDragOver={
          onUploadFiles
            ? (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'copy';
              }
            : undefined
        }
        onDragLeave={
          onUploadFiles
            ? (e) => {
                if (e.currentTarget.contains(e.relatedTarget as Node)) return;
                setIsDragOver(false);
              }
            : undefined
        }
        onDrop={
          onUploadFiles
            ? (e) => {
                e.preventDefault();
                setIsDragOver(false);
                handleFiles(e.dataTransfer.files);
              }
            : undefined
        }
        role="presentation"
      >
        <div className="lazyos-composer__field">
          {/* UX-1 (2026-05-26): auto-grow textarea (rows=1, bis 7 Zeilen).
              Enter=submit (handleKeyDown), Shift+Enter=Newline (fällt durch,
              default-Verhalten der Textarea), Cmd/Ctrl+Enter=Interrupt-Send
              (Queue-Arbeit beibehalten). */}
          <textarea
            ref={inputRef}
            rows={1}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={sttListening ? 'Hör zu …' : placeholder}
            disabled={disabled}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            aria-label={ariaLabel}
            className="lazyos-composer__input"
          />
          {showInterim ? (
            <span
              aria-hidden="true"
              className="lazyos-composer__interim"
            >
              {value.length > 0 && !value.endsWith(' ') ? ' ' : ''}
              {sttInterim}
            </span>
          ) : null}
        </div>

        <div className="lazyos-composer__actions">
          {onUploadFiles ? (
            <>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx,.txt,.md,.csv,.json,.zip"
                style={{ display: 'none' }}
                onChange={(e) => {
                  handleFiles(e.target.files);
                  if (fileInputRef.current) fileInputRef.current.value = '';
                }}
              />
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (uploading) return;
                  fileInputRef.current?.click();
                }}
                aria-label={uploading ? 'Lade hoch' : 'Datei anhängen'}
                aria-busy={uploading}
                title={uploading ? 'Lade hoch …' : 'Datei anhängen'}
                disabled={uploading}
                className="lazyos-composer__upload"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  minWidth: 44,
                  minHeight: 44,
                }}
              >
                <IconPaperclip size={18} />
              </button>
            </>
          ) : null}

          <button
            type="button"
            onMouseDown={(e) => {
              // onMouseDown instead of onClick — fires before the outer-div focus handler,
              // and is more robust against iOS Safari's synthetic click events in PWA.
              e.preventDefault();
              e.stopPropagation();
            }}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onSttToggle();
            }}
            onTouchEnd={(e) => {
              // iOS PWA: touch events as an additional safety path — some versions
              // of iOS Safari in standalone mode swallow synthetic clicks.
              e.preventDefault();
              e.stopPropagation();
              onSttToggle();
            }}
            aria-label={micLabel}
            aria-pressed={sttListening}
            aria-disabled={!sttSupported}
            title={micLabel}
            className={
              sttListening
                ? 'lazyos-composer__mic lazyos-composer__mic--live'
                : 'lazyos-composer__mic'
            }
            style={!sttSupported ? micDisabledInlineStyle : undefined}
          >
            {sttListening ? <IconMicActive size={18} /> : <IconMic size={18} />}
          </button>

          {/* Bug-2-Fix: Stop-Button — sichtbar wenn Agent streamt. */}
          {isStreaming && onStop ? (
            <button
              type="button"
              onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); onStop(); }}
              aria-label="Antwort stoppen"
              title="Antwort stoppen"
              className="lazyos-composer__stop press"
            >
              {/* Square icon — universelles Stop-Symbol */}
              <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
                <rect x="2" y="2" width="10" height="10" rx="2" />
              </svg>
            </button>
          ) : null}

          {/* Bug-2-Fix: SendNow-Button — Interrupt + sofort senden (Cmd/Ctrl+Enter). */}
          {isStreaming && hasText && onSendNow ? (
            <button
              type="button"
              onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleSendNow(); }}
              aria-label="Sofort senden (unterbricht laufende Antwort)"
              title="Sofort senden — unterbricht (Cmd ↵)"
              disabled={disabled}
              className="lazyos-composer__send-now press press-strong"
            >
              <IconArrowUp size={16} />
            </button>
          ) : null}

          {/* Normal Send — nur wenn nicht streaming */}
          {!isStreaming && showSend ? (
            <button
              type="submit"
              aria-label="Senden"
              title="Senden"
              disabled={disabled || !hasText}
              className="lazyos-composer__send press press-strong"
            >
              <IconArrowUp size={16} />
            </button>
          ) : null}
        </div>
      </div>
    </form>
  );
}

// Fallback inline für den Disabled-Case — primäre Styles stehen in CSS.
const micDisabledInlineStyle: CSSProperties = {
  opacity: 0.35,
  cursor: 'not-allowed',
};

// ---- Bug-2-Fix: Queue-Chip Styles ----------------------------------------
const queueChipStyle: CSSProperties = {
  position: 'absolute',
  top: 'calc(100% + 6px)',
  left: '50%',
  transform: 'translateX(-50%)',
  display: 'flex',
  alignItems: 'center',
  gap: 5,
  padding: '4px 10px',
  borderRadius: 20,
  fontSize: 11,
  fontFamily: 'var(--font-mono)',
  fontWeight: 600,
  letterSpacing: '0.04em',
  color: 'var(--a-now)',
  background: 'color-mix(in oklab, var(--a-now) 12%, transparent)',
  border: '0.5px solid color-mix(in oklab, var(--a-now) 30%, transparent)',
  pointerEvents: 'none',
  whiteSpace: 'nowrap',
  zIndex: 5,
};

const queueChipDotStyle: CSSProperties = {
  width: 6,
  height: 6,
  borderRadius: '50%',
  background: 'var(--a-now)',
  flexShrink: 0,
};

// ---- Suggestion Dropdown Styles ----
const suggestionListStyle: CSSProperties = {
  position: 'absolute',
  bottom: 'calc(100% + 8px)',
  left: 0,
  right: 0,
  maxHeight: 'min(50vh, 320px)',
  overflowY: 'auto',
  padding: 6,
  borderRadius: 14,
  background: 'color-mix(in oklab, var(--sheet-2) 96%, transparent)',
  border: '0.5px solid var(--line-2)',
  boxShadow: '0 12px 32px rgba(0,0,0,0.35)',
  backdropFilter: 'blur(10px)',
  WebkitBackdropFilter: 'blur(10px)',
  zIndex: 20,
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
};

const suggestionItemStyle: CSSProperties = {
  appearance: 'none',
  border: 'none',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '12px 12px',
  borderRadius: 10,
  textAlign: 'left',
  minHeight: 44,
  fontFamily: 'inherit',
  color: 'var(--ink)',
  transition: 'background 120ms ease',
};

function suggestionKindStyle(kind: 'nav' | 'act' | 'ws' | 'slash'): CSSProperties {
  const color =
    kind === 'act'
      ? 'var(--a-now)'
      : kind === 'ws'
        ? 'var(--a-warn)'
        : kind === 'slash'
          ? 'var(--a-now)'
          : 'var(--ink-3)';
  return {
    fontSize: 9,
    fontFamily: 'var(--font-mono)',
    letterSpacing: '0.1em',
    padding: '3px 7px',
    borderRadius: 4,
    background: `color-mix(in oklab, ${color} 18%, transparent)`,
    color,
    fontWeight: 600,
    flexShrink: 0,
  };
}

const suggestionLabelStyle: CSSProperties = {
  fontSize: 14,
  fontWeight: 500,
  color: 'var(--ink)',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

const suggestionDetailStyle: CSSProperties = {
  fontSize: 11,
  color: 'var(--ink-3)',
  letterSpacing: '-0.005em',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};
