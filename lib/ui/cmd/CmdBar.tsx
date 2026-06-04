'use client';

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { CmdSuggest, type CmdSuggestion } from './CmdSuggest';

export interface CmdBarProps {
  placeholder?: string;
  value?: string;
  onChange?: (v: string) => void;
  onSubmit?: (v: string) => void;
  contextLabel?: string;
  iconGlyph?: ReactNode;
  micEnabled?: boolean;
  suggestions?: CmdSuggestion[];
}

const DEFAULT_PLACEHOLDER = 'Sprich oder tippe — ich verstehe den Kontext…';
const DEFAULT_ICON: ReactNode = (
  <svg
    width={16}
    height={16}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.6}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <circle cx="11" cy="11" r="7" />
    <path d="m21 21-4.3-4.3" />
  </svg>
);

export function CmdBar({
  placeholder = DEFAULT_PLACEHOLDER,
  value: controlledValue,
  onChange,
  onSubmit,
  contextLabel,
  iconGlyph = DEFAULT_ICON,
  micEnabled = false,
  suggestions,
}: CmdBarProps) {
  const isControlled = controlledValue !== undefined;
  const [internalValue, setInternalValue] = useState('');
  const value = isControlled ? controlledValue : internalValue;

  const reactId = useId();
  const listboxId = `cmdbar-${reactId}-listbox`;
  const inputRef = useRef<HTMLInputElement>(null);

  const openSuggest =
    Array.isArray(suggestions) && suggestions.length > 0 && value.length > 0;
  const visibleSuggestions = openSuggest ? suggestions : [];

  const [activeIndex, setActiveIndex] = useState(0);

  // Reset active row when suggestion list identity/length changes
  useEffect(() => {
    setActiveIndex(0);
  }, [visibleSuggestions.length, openSuggest]);

  const setValue = useCallback(
    (next: string) => {
      if (!isControlled) setInternalValue(next);
      onChange?.(next);
    },
    [isControlled, onChange]
  );

  const handleSubmit = useCallback(() => {
    if (openSuggest && visibleSuggestions[activeIndex]) {
      visibleSuggestions[activeIndex].onSelect();
      return;
    }
    if (value.trim().length === 0) return;
    onSubmit?.(value);
  }, [openSuggest, visibleSuggestions, activeIndex, value, onSubmit]);

  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'ArrowDown' && openSuggest) {
        e.preventDefault();
        setActiveIndex((i) =>
          visibleSuggestions.length === 0
            ? 0
            : (i + 1) % visibleSuggestions.length
        );
        return;
      }
      if (e.key === 'ArrowUp' && openSuggest) {
        e.preventDefault();
        setActiveIndex((i) =>
          visibleSuggestions.length === 0
            ? 0
            : (i - 1 + visibleSuggestions.length) % visibleSuggestions.length
        );
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        handleSubmit();
        return;
      }
      if (e.key === 'Escape' && value.length > 0) {
        e.preventDefault();
        setValue('');
        return;
      }
    },
    [openSuggest, visibleSuggestions.length, handleSubmit, value.length, setValue]
  );

  const activeDescendant = useMemo(() => {
    if (!openSuggest) return undefined;
    const s = visibleSuggestions[activeIndex];
    return s ? `${listboxId}-opt-${s.id}` : undefined;
  }, [openSuggest, visibleSuggestions, activeIndex, listboxId]);

  const showPlaceholder = value.length === 0;
  const showMic = micEnabled && showPlaceholder;
  const showCursor = !showMic;

  const focusInput = useCallback(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div
      role="combobox"
      aria-expanded={openSuggest}
      aria-haspopup="listbox"
      aria-owns={openSuggest ? listboxId : undefined}
      aria-controls={openSuggest ? listboxId : undefined}
    >
      <div
        className="cmdbar"
        onClick={focusInput}
        // Container itself is not focusable; inner input takes focus
      >
        <div className="ico" aria-hidden="true">
          {iconGlyph}
        </div>

        <label className="txt" style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
          <span className="sr-only" style={srOnlyStyle}>
            Befehl
          </span>

          {/* Visual text layer — echos input value or placeholder */}
          <span aria-hidden="true" style={{ flex: 1, minWidth: 0 }}>
            {showPlaceholder ? (
              <span className="placeholder">{placeholder}</span>
            ) : (
              <span>{value}</span>
            )}
            {showCursor ? <span className="cur" /> : null}
          </span>

          {/* Real input — visually hidden but accessible, drives state */}
          <input
            ref={inputRef}
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            aria-autocomplete="list"
            aria-activedescendant={activeDescendant}
            aria-controls={openSuggest ? listboxId : undefined}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            style={hiddenInputStyle}
          />
        </label>

        {contextLabel ? (
          <div className="ctx-chip" aria-label={`Kontext: ${contextLabel}`}>
            {contextLabel}
          </div>
        ) : null}

        {showMic ? (
          <button
            type="button"
            className="mic"
            aria-label="Spracheingabe starten"
            onClick={(e) => {
              e.stopPropagation();
              // Mic activation is host-app's concern; we simply re-focus input.
              focusInput();
            }}
          >
            <svg
              width={16}
              height={16}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.6}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <rect x="9" y="3" width="6" height="11" rx="3" />
              <path d="M5 11a7 7 0 0 0 14 0" />
              <path d="M12 18v3" />
            </svg>
          </button>
        ) : null}
      </div>

      {openSuggest ? (
        <CmdSuggest
          suggestions={visibleSuggestions}
          activeIndex={activeIndex}
          listboxId={listboxId}
          onHover={setActiveIndex}
        />
      ) : null}
    </div>
  );
}

const srOnlyStyle = {
  position: 'absolute',
  width: '1px',
  height: '1px',
  padding: 0,
  margin: '-1px',
  overflow: 'hidden',
  clip: 'rect(0,0,0,0)',
  whiteSpace: 'nowrap',
  border: 0,
} as const;

// Input lives above the visual text layer so focus-visible ring works on
// keyboard nav, but is transparent so the styled .txt span shows through.
//
// iOS-ZOOM-FIX (2026-04-24): font-size MUST be >= 16px, otherwise
// Safari zooms on focus. We set 16px explicitly here instead of font: 'inherit'
// (which would inherit 15px from .cmdbar .txt). The input is visually transparent, the
// actual rendered font comes from the <span> next to it — the 16px are
// pure iOS heuristic, not visible.
const hiddenInputStyle = {
  position: 'absolute',
  inset: 0,
  width: '100%',
  height: '100%',
  background: 'transparent',
  border: 'none',
  outline: 'none',
  color: 'transparent',
  caretColor: 'transparent',
  fontFamily: 'inherit',
  fontSize: 16,
  fontWeight: 'inherit',
  letterSpacing: 'inherit',
  padding: 0,
  margin: 0,
} as const;
