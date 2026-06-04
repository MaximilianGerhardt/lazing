'use client';

import * as React from 'react';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';

import type {
  DecisionMode,
  DecisionOption,
  DecisionProps,
} from './types';

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
// Sentinel key tokens for the icon-role badges (confirm = accept, edit = revise).
// These render as inline SVGs via renderKeyBadge(), not as glyphs.
const KEY_ACCEPT = 'accept';
const KEY_EDIT = 'edit';
const BINARY_KEYS = [KEY_ACCEPT, KEY_EDIT] as const;
const CONFIRM_KEY = KEY_ACCEPT;

function defaultKeyFor(mode: DecisionMode, index: number): string {
  if (mode === 'confirm') return CONFIRM_KEY;
  if (mode === 'binary') return BINARY_KEYS[index] ?? LETTERS[index] ?? String(index + 1);
  return LETTERS[index] ?? String(index + 1);
}

/** Inline check mark — accept / confirm key-badge. */
function IconKeyCheck(): React.JSX.Element {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable={false}
    >
      <path d="M5 12.5 10 17 19 7" />
    </svg>
  );
}

/** Inline pencil — edit / revise key-badge. */
function IconKeyEdit(): React.JSX.Element {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable={false}
    >
      <path d="M4 20h4L19 9l-4-4L4 16v4Z" />
      <path d="M13.5 6.5 17.5 10.5" />
    </svg>
  );
}

/** Render a key-badge: SVG for the icon-role sentinels, plain text otherwise. */
function renderKeyBadge(keyGlyph: string): React.ReactNode {
  if (keyGlyph === KEY_ACCEPT) return <IconKeyCheck />;
  if (keyGlyph === KEY_EDIT) return <IconKeyEdit />;
  return keyGlyph;
}

function classNames(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/**
 * DEC-01 Decision Card.
 *
 * Three modes:
 *  - 'multi'   — radiogroup with N options, default keys A/B/C ...
 *  - 'binary'  — exactly two options, default keys accept / edit (SVG badges)
 *  - 'confirm' — single CTA option, rendered as confirm button
 *
 * Counter-Prop is optional and is only rendered when explicitly set.
 * Never synthesise a counter (see Strategie-Review).
 */
export function Decision({
  tag = 'Entscheidung benötigt',
  headline,
  sub,
  options,
  deepLink,
  mode = 'multi',
  className,
}: DecisionProps): React.JSX.Element {
  const groupId = useId();
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const initialSelected = useMemo(() => {
    const recIndex = options.findIndex((o) => o.recommended);
    if (recIndex >= 0) return recIndex;
    return mode === 'confirm' ? 0 : -1;
  }, [options, mode]);

  const [selectedIndex, setSelectedIndex] = useState<number>(initialSelected);

  const focusOption = useCallback((index: number) => {
    const btn = optionRefs.current[index];
    if (btn) btn.focus();
  }, []);

  const activate = useCallback(
    (index: number) => {
      const opt = options[index];
      if (!opt) return;
      setSelectedIndex(index);
      opt.onSelect?.();
    },
    [options],
  );

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
      const last = options.length - 1;
      if (last < 0) return;

      switch (event.key) {
        case 'ArrowDown':
        case 'ArrowRight': {
          event.preventDefault();
          const next = index >= last ? 0 : index + 1;
          focusOption(next);
          break;
        }
        case 'ArrowUp':
        case 'ArrowLeft': {
          event.preventDefault();
          const prev = index <= 0 ? last : index - 1;
          focusOption(prev);
          break;
        }
        case 'Home': {
          event.preventDefault();
          focusOption(0);
          break;
        }
        case 'End': {
          event.preventDefault();
          focusOption(last);
          break;
        }
        case ' ':
        case 'Enter': {
          event.preventDefault();
          activate(index);
          break;
        }
        default:
          break;
      }
    },
    [options.length, focusOption, activate],
  );

  const renderedTag = tag ? tag.toUpperCase() : '';

  // Confirm mode: CTA role="button" on the single option.
  const optsRole = mode === 'confirm' ? undefined : 'radiogroup';
  const optsAriaLabel = mode === 'confirm' ? undefined : headline;

  return (
    <div
      className={classNames('decision', className)}
      aria-labelledby={`${groupId}-headline`}
      data-mode={mode}
    >
      {renderedTag ? <div className="tag">{renderedTag}</div> : null}
      <h4 id={`${groupId}-headline`}>{headline}</h4>
      {sub ? <div className="sub">{sub}</div> : null}

      <div
        className="opts"
        role={optsRole}
        aria-label={optsAriaLabel}
      >
        {options.map((option, index) => {
          const isSelected = selectedIndex === index;
          const isFallbackFocus = selectedIndex < 0 && index === 0;
          return (
            <DecisionOptionButton
              key={option.id}
              option={option}
              index={index}
              mode={mode}
              isSelected={isSelected}
              isFocusable={isSelected || isFallbackFocus}
              registerRef={(el) => {
                optionRefs.current[index] = el;
              }}
              onActivate={() => activate(index)}
              onKeyDown={(event) => handleKeyDown(event, index)}
            />
          );
        })}
      </div>

      {deepLink ? (
        <button
          type="button"
          className="deep"
          onClick={deepLink.onClick}
        >
          {deepLink.label ?? 'Dossier öffnen'}
        </button>
      ) : null}
    </div>
  );
}

interface OptionButtonProps {
  option: DecisionOption;
  index: number;
  mode: DecisionMode;
  isSelected: boolean;
  isFocusable: boolean;
  registerRef: (el: HTMLButtonElement | null) => void;
  onActivate: () => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
}

function DecisionOptionButton({
  option,
  index,
  mode,
  isSelected,
  isFocusable,
  registerRef,
  onActivate,
  onKeyDown,
}: OptionButtonProps): React.JSX.Element {
  const keyGlyph = option.key ?? defaultKeyFor(mode, index);
  const isRecommended = Boolean(option.recommended);

  // In confirm mode we expose a plain button (single CTA).
  // In multi / binary mode the options form a radiogroup.
  const isRadio = mode !== 'confirm';

  // Roving tabindex for radiogroup: selected option is tabbable, or
  // the first option if nothing is selected yet. Plain button (confirm)
  // is always tabbable.
  const tabIndex = isRadio ? (isFocusable ? 0 : -1) : 0;

  return (
    <button
      ref={registerRef}
      type="button"
      className={classNames('dopt', isRecommended && 'rec')}
      role={isRadio ? 'radio' : undefined}
      aria-checked={isRadio ? isSelected : undefined}
      tabIndex={tabIndex}
      onClick={onActivate}
      onKeyDown={onKeyDown}
      data-recommended={isRecommended || undefined}
    >
      <div className="k" aria-hidden="true">
        {renderKeyBadge(keyGlyph)}
      </div>
      <div className="m">
        <div className="nm">{option.label}</div>
        {option.sublabel ? <div className="sb">{option.sublabel}</div> : null}
      </div>
      {option.counter ? (
        <div className="c" aria-label={`Stimmen: ${option.counter}`}>
          {option.counter}
        </div>
      ) : null}
    </button>
  );
}

export default Decision;
