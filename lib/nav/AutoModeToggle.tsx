'use client';

/**
 * AutoModeToggle — switch in the TopBar for "autonomous vs manual".
 *
 * Auto ON: every non-trivial user request automatically becomes a
 * workstream with a tier spawn (default: fast tier 1/4/8). Bug reports,
 * feature wishes, refactor requests — all documented.
 *
 * Auto OFF: only explicit "plan me X" prompts become workstreams.
 *
 * State persisted in localStorage 'lazyos.auto-mode' (boolean).
 * Passed through by the chat server prompt via the X-LazyOS-Auto-Mode header
 * to the agent server.
 */

import { useEffect, useState, type CSSProperties } from 'react';

const STORAGE_KEY = 'lazyos.auto-mode';
const CHANGE_EVENT = 'lazyos:auto-mode-change';

// SVG icons instead of Unicode emojis. Two variants — active = solid line,
// inactive = paused. Both monochrome in currentColor so they adapt to the
// topnav pills.
function AutoOnIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12l3 3 5-6" />
    </svg>
  );
}

function AutoOffIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <line x1="9" y1="9" x2="9" y2="15" />
      <line x1="15" y1="9" x2="15" y2="15" />
    </svg>
  );
}

export function isAutoModeOn(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function AutoModeToggle() {
  const [on, setOn] = useState<boolean>(false);

  useEffect(() => {
    setOn(isAutoModeOn());
    const handler = (): void => setOn(isAutoModeOn());
    window.addEventListener(CHANGE_EVENT, handler);
    window.addEventListener('storage', handler);
    return () => {
      window.removeEventListener(CHANGE_EVENT, handler);
      window.removeEventListener('storage', handler);
    };
  }, []);

  const toggle = (): void => {
    const next = !on;
    setOn(next);
    try {
      if (next) window.localStorage.setItem(STORAGE_KEY, '1');
      else window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { on: next } }));
  };

  return (
    <button
      type="button"
      onClick={toggle}
      className="topnav-gear topnav-automode"
      aria-pressed={on}
      aria-label={on ? 'Auto-Mode aktiv (klick deaktiviert)' : 'Auto-Mode aus (klick aktiviert)'}
      title={
        on
          ? 'Auto: jede Anfrage wird automatisch zu einem Multi-Agent-Workstream'
          : 'Manuell: nur explizite Plan-Anfragen werden zu Workstreams'
      }
      style={on ? activeStyle : undefined}
    >
      <span style={iconStyle} aria-hidden="true">
        {on ? <AutoOnIcon size={14} /> : <AutoOffIcon size={14} />}
      </span>
    </button>
  );
}

const activeStyle: CSSProperties = {
  background: 'color-mix(in oklab, var(--a-now) 18%, transparent)',
  borderColor: 'var(--a-now)',
  color: 'var(--a-now)',
};

const iconStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  lineHeight: 1,
};
