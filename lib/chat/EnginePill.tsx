'use client';

/**
 * EnginePill — compact pill below the chat composer for switching the
 * runtime-engine for the next message (Track 2 of "Engine-Pill 2026-05-23").
 *
 * Direktive (User, 2026-05-23):
 *   "über die Engine Pill im Chat unten per Dropdown auswählen können, um
 *    ggf. zu wechseln"
 *
 * Behaviour:
 *   - Default = 'parallel-all' (race all available, fastest wins).
 *   - Click → dropdown with 4 options (Parallel · Claude · Codex · Ollama).
 *   - Selection persists to localStorage AND `/api/user-settings/engine`.
 *     localStorage wins on read-conflict for sync UX.
 *   - Visual: pitch-black canvas (Pitch-Black #070707 — single primary action
 *     elsewhere on screen), brand-gradient only on active-marker, 240ms
 *     cubic-bezier transitions per Manifest v1.0.
 *
 * NOT included here:
 *   - Actually routing the next chat-message through the orchestrator. That
 *     wiring lives in ChatShell.tsx / useChatStream.ts and is gated by the
 *     mode read from this hook.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react';

import { IconChevronDown, IconCheck } from '../nav/icons';

export type EngineMode =
  | 'parallel-all'
  | 'claude-cli'
  | 'codex-cli'
  | 'ollama'
  | 'ultracoding';

interface EngineOption {
  mode: EngineMode;
  label: string;
  detail: string;
}

// C6 entgate (2026-05-25): alle vier Modi wählbar, keine Gating-Logik.
// Keine Emojis — laz.ing Design Manifest v1.0, clean typographic pill.
const OPTIONS: EngineOption[] = [
  {
    mode: 'parallel-all',
    label: 'Parallel',
    detail: 'race · fastest wins',
  },
  {
    mode: 'claude-cli',
    label: 'Claude',
    detail: 'claude-cli · MAX-Plan',
  },
  {
    mode: 'codex-cli',
    label: 'Codex',
    detail: 'read-only sandbox',
  },
  {
    mode: 'ollama',
    label: 'Ollama',
    detail: 'lokal · zero-cost',
  },
  {
    mode: 'ultracoding',
    label: 'Ultra',
    detail: 'Claude · Multi-Agent · datei-disjunkt',
  },
];

const LS_KEY = 'lazyos.engine.mode';

interface EngineAvailability {
  engine: EngineMode;
  available: boolean;
  reason: string;
}

interface Props {
  /** Optional: callback fired when the user picks a new mode. */
  onChange?: (mode: EngineMode) => void;
  /**
   * Optional: result of the most recent orchestrator-run. If set, we render
   * a tiny telemetry-strip ("via Codex · 1.2s · Claude+Ollama abgebrochen")
   * below the pill.
   */
  lastRun?: {
    engineUsed: EngineMode | string;
    latencyMs: number;
    losers?: string[];
  } | null;
}

export function EnginePill({ onChange, lastRun }: Props): React.JSX.Element {
  const [mode, setMode] = useState<EngineMode>('parallel-all');
  const [open, setOpen] = useState(false);
  const [availability, setAvailability] = useState<EngineAvailability[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);

  // Mount: hydrate from localStorage first, then sync with server.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const ls = window.localStorage.getItem(LS_KEY);
    if (ls && OPTIONS.some((o) => o.mode === ls)) {
      setMode(ls as EngineMode);
    }
    // Server-sync — only updates UI if localStorage was empty.
    void fetch('/api/user-settings/engine')
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { mode?: EngineMode } | null) => {
        if (!j?.mode) return;
        if (!ls) setMode(j.mode);
      })
      .catch(() => {
        /* not authenticated or offline — fall back to localStorage default */
      });

    // Availability probe for the badge.
    void fetch('/api/system/engines')
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { available?: EngineAvailability[] } | null) => {
        if (j?.available) setAvailability(j.available);
      })
      .catch(() => {
        /* swallow — pill still works without availability badges */
      });
  }, []);

  // Close dropdown on outside-click.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent): void => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const pick = useCallback(
    (nextMode: EngineMode) => {
      setMode(nextMode);
      setOpen(false);
      onChange?.(nextMode);
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(LS_KEY, nextMode);
      }
      // Fire-and-forget server-sync.
      void fetch('/api/user-settings/engine', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: nextMode }),
      }).catch(() => {
        /* localStorage already covers UX */
      });
    },
    [onChange],
  );

  const active = OPTIONS.find((o) => o.mode === mode) ?? OPTIONS[0];

  return (
    <div
      ref={rootRef}
      style={containerStyle}
      data-test="engine-pill-root"
      data-engine-mode={mode}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={pillStyle(open)}
        aria-expanded={open}
        aria-haspopup="listbox"
        data-test="engine-pill-trigger"
      >
        <span style={pillLabelStyle}>{active.label}</span>
        <span style={pillChevronStyle} aria-hidden>
          <IconChevronDown size={12} />
        </span>
      </button>

      {lastRun ? (
        <span style={runStripStyle} data-test="engine-pill-laststrip">
          via {String(lastRun.engineUsed)} · {Math.round(lastRun.latencyMs)}ms
          {lastRun.losers && lastRun.losers.length > 0
            ? ` · ${lastRun.losers.join('+')} abgebrochen`
            : ''}
        </span>
      ) : null}

      {open ? (
        <div
          role="listbox"
          aria-label="Engine wählen"
          style={dropdownStyle}
          data-test="engine-pill-dropdown"
        >
          {OPTIONS.map((opt) => {
            const isActive = opt.mode === mode;
            const probe = availability.find((a) => a.engine === opt.mode);
            // 'parallel-all' is "available" iff at least one underlying
            // engine is. We approximate: any available.
            const parallelOk =
              opt.mode === 'parallel-all' &&
              availability.some((a) => a.available);
            // 'ultracoding' is "available" iff claude-cli is available
            // (multi-agent fan-out spawns claude-cli agents only).
            const ultraOk =
              opt.mode === 'ultracoding' &&
              availability.find((a) => a.engine === 'claude-cli')?.available ===
                true;
            const ok =
              opt.mode === 'parallel-all'
                ? parallelOk
                : opt.mode === 'ultracoding'
                  ? ultraOk
                  : probe?.available === true;
            return (
              <button
                key={opt.mode}
                type="button"
                role="option"
                aria-selected={isActive}
                onClick={() => pick(opt.mode)}
                style={optionStyle(isActive)}
                data-test={`engine-pill-opt-${opt.mode}`}
                data-available={ok ? 'true' : 'false'}
              >
                <span style={optTextWrapStyle}>
                  <span style={optLabelStyle}>
                    {opt.label}
                    {ok ? (
                      <span style={okDotStyle} aria-label="verfügbar" />
                    ) : (
                      <span style={offDotStyle} aria-label="nicht verfügbar" />
                    )}
                  </span>
                  <span style={optDetailStyle}>{opt.detail}</span>
                </span>
                {isActive ? <span style={checkStyle} aria-hidden><IconCheck size={14} /></span> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

// ---- Styles (Pitch-Black + brand-gradient only on active-marker) ----

const containerStyle: CSSProperties = {
  position: 'relative',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 10,
};

function pillStyle(open: boolean): CSSProperties {
  return {
    appearance: 'none',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '6px 10px 6px 8px',
    borderRadius: 999,
    border: '0.5px solid var(--line-2, #1f1f1f)',
    background: open
      ? 'color-mix(in oklab, var(--a-now, #c9ff4d) 6%, var(--sheet-2, #0e0e0e))'
      : 'var(--sheet-2, #0e0e0e)',
    color: 'var(--ink, #f5f5f5)',
    fontFamily: "var(--font-sans, 'SF Pro Display', system-ui)",
    fontSize: 12,
    fontWeight: 500,
    letterSpacing: '-0.005em',
    cursor: 'pointer',
    transition:
      'background 240ms cubic-bezier(0.16, 1, 0.3, 1), border-color 240ms',
  };
}

const pillLabelStyle: CSSProperties = {
  letterSpacing: '0.01em',
};

const pillChevronStyle: CSSProperties = {
  fontSize: 9,
  color: 'var(--ink-3, #6b6b6b)',
  marginLeft: 2,
};

const runStripStyle: CSSProperties = {
  fontFamily: 'var(--font-mono, ui-monospace)',
  fontSize: 10,
  letterSpacing: '0.04em',
  color: 'var(--ink-3, #6b6b6b)',
};

const dropdownStyle: CSSProperties = {
  position: 'absolute',
  bottom: 'calc(100% + 8px)',
  left: 0,
  minWidth: 260,
  padding: 6,
  borderRadius: 14,
  background: 'color-mix(in oklab, var(--sheet-2, #0e0e0e) 96%, transparent)',
  border: '0.5px solid var(--line-2, #1f1f1f)',
  boxShadow: '0 16px 36px rgba(0,0,0,0.4)',
  backdropFilter: 'blur(12px)',
  WebkitBackdropFilter: 'blur(12px)',
  zIndex: 30,
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
};

function optionStyle(active: boolean): CSSProperties {
  return {
    appearance: 'none',
    border: 'none',
    background: active
      ? 'color-mix(in oklab, var(--a-now, #c9ff4d) 10%, transparent)'
      : 'transparent',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '10px 12px',
    borderRadius: 10,
    textAlign: 'left',
    color: 'var(--ink, #f5f5f5)',
    transition: 'background 120ms ease',
  };
}

const optTextWrapStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  flex: 1,
  minWidth: 0,
};

const optLabelStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 500,
  color: 'var(--ink, #f5f5f5)',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
};

const optDetailStyle: CSSProperties = {
  fontSize: 11,
  color: 'var(--ink-3, #6b6b6b)',
  letterSpacing: '-0.005em',
};

const checkStyle: CSSProperties = {
  fontSize: 12,
  color: 'var(--a-now, #c9ff4d)',
  marginLeft: 4,
};

const okDotStyle: CSSProperties = {
  width: 6,
  height: 6,
  borderRadius: 999,
  background: 'var(--a-now, #c9ff4d)',
  display: 'inline-block',
};

const offDotStyle: CSSProperties = {
  width: 6,
  height: 6,
  borderRadius: 999,
  background: 'var(--ink-4, #4a4a4a)',
  display: 'inline-block',
};
