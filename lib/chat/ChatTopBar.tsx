'use client';

/**
 * ChatTopBar — live info ABOVE the active Claude session + engine selector.
 *
 * Pill dedup (2026-05-23): previously there were two pills (ChatTopBar on top +
 * EnginePill below). User feedback: "Über dem Chat gibt es bereits eine
 * Engine pill. du hast darunter eine gebaut. Absolute Katastrophe."
 * → ChatTopBar IS now the only pill and unites display + selector.
 *
 * Shows (display):
 *   - engine mode (Parallel · Claude · Codex · Ollama — dropdown)
 *   - model (e.g. "Opus 4.7 · MAX-Plan") — only when claude-cli is active
 *   - effort ("xhigh" per lazyOS policy) — implicit via the title tooltip
 *   - context fill (% + absolute tokens)
 *   - turn count
 *
 * Behavior (selector):
 *   - A click on the engine mode opens a dropdown with 4 options.
 *   - The selection persists to localStorage (`lazyos.engine.mode`) AND
 *     POST /api/user-settings/engine. localStorage wins on read.
 *   - Availability probe via GET /api/system/engines (green dot when ok).
 *
 * Polling: every 15s + after every send (via custom event, optional).
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react';

import { Engine } from '@/lib/ui/eng';
import { IconChevronDown, IconCheck } from '../nav/icons';

// Engine-mode types (kept in sync with lib/chat/EnginePill.tsx before dedup).
export type EngineMode =
  | 'parallel-all'
  | 'claude-cli'
  | 'ultracoding'
  | 'codex-cli'
  | 'ollama';

interface EngineOption {
  mode: EngineMode;
  label: string;
  detail: string;
}

// C6 un-gate (2026-05-25): all modes selectable + safe (codex read-only in the chat).
// 2026-06-03: 'ultracoding' (code pipeline with git worktrees/tmux — NOT a chat
// engine, rejected server-side as invalid-mode) removed from the chat picker.
// 'parallel-all' = consensus (all engines overlaid + synthesized), NO more
// fastest-wins (owner directive 2026-06-03).
const ENGINE_OPTIONS: EngineOption[] = [
  { mode: 'parallel-all', label: 'Parallel', detail: 'overlay · Konsens' },
  { mode: 'claude-cli',   label: 'Claude',   detail: 'claude-cli · MAX-Plan' },
  { mode: 'codex-cli',    label: 'Codex',    detail: 'read-only sandbox' },
  { mode: 'ollama',       label: 'Ollama',   detail: 'lokal · zero-cost' },
];

const LS_ENGINE_KEY = 'lazyos.engine.mode';

interface EngineAvailability {
  engine: EngineMode;
  available: boolean;
  reason: string;
}

interface UsagePayload {
  workspaceId: string;
  sessionId: string | null;
  model: string;
  turnCount: number;
  lastInputTokens: number;
  lastOutputTokens: number;
  lastCacheReadTokens: number;
  contextTotal: number;
  contextWindow: number;
  contextFillPct: number;
  agentReachable: boolean;
  claudeAvailable: boolean;
  maxPlan: boolean;
}

interface ChatTopBarProps {
  workspaceId: string;
  /** Compact variant renders inline, full renders the big Engine-card. */
  variant?: 'compact' | 'full';
}

function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 100_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

function prettyModel(raw: string): string {
  if (raw.includes('opus-4-8')) return 'Opus 4.8 · 1M';
  if (raw.includes('opus-4-7')) return 'Opus 4.7 · 1M';
  if (raw.includes('opus-4-6')) return 'Opus 4.6';
  if (raw.includes('sonnet-4-6')) return 'Sonnet 4.6';
  if (raw.includes('haiku-4')) return 'Haiku 4.5';
  return raw;
}

export function ChatTopBar({
  workspaceId,
  variant = 'compact',
}: ChatTopBarProps): React.JSX.Element | null {
  const [usage, setUsage] = useState<UsagePayload | null>(null);
  const [engineMode, setEngineMode] = useState<EngineMode>('parallel-all');
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [engineAvail, setEngineAvail] = useState<EngineAvailability[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const resp = await fetch(
          `/api/chat/usage?workspaceId=${encodeURIComponent(workspaceId)}`,
          { cache: 'no-store' },
        );
        if (!resp.ok) return;
        const json = (await resp.json()) as UsagePayload;
        if (!cancelled) setUsage(json);
      } catch {
        // ignore
      }
    };
    void load();
    const interval = setInterval(load, 15_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [workspaceId]);

  // Engine-mode hydration + availability probe (Track 2 of pill dedup).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const ls = window.localStorage.getItem(LS_ENGINE_KEY);
    if (ls && ENGINE_OPTIONS.some((o) => o.mode === ls)) {
      setEngineMode(ls as EngineMode);
    }
    void fetch('/api/user-settings/engine')
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { mode?: EngineMode } | null) => {
        if (!j?.mode) return;
        if (!ls) setEngineMode(j.mode);
      })
      .catch(() => {
        /* unauth/offline — localStorage covers it */
      });
    void fetch('/api/system/engines')
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { available?: EngineAvailability[] } | null) => {
        if (j?.available) setEngineAvail(j.available);
      })
      .catch(() => {
        /* swallow — pill still works without availability badges */
      });
  }, []);

  // Close dropdown on outside-click.
  useEffect(() => {
    if (!dropdownOpen) return;
    const handler = (e: MouseEvent): void => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) setDropdownOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [dropdownOpen]);

  const pickEngine = useCallback((nextMode: EngineMode) => {
    // Security imperative: gated modes must be neither set nor persisted.
    // The guard here is belt-and-suspenders — primarily the
    // disabled attribute + onClick=undefined on the button prevents any call.
    if (GATED_MODES.has(nextMode)) return;
    setEngineMode(nextMode);
    setDropdownOpen(false);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(LS_ENGINE_KEY, nextMode);
    }
    void fetch('/api/user-settings/engine', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: nextMode }),
    }).catch(() => {
      /* localStorage already covers UX */
    });
  }, []);

  const activeEngine = ENGINE_OPTIONS.find((o) => o.mode === engineMode) ?? ENGINE_OPTIONS[0];

  // Compact = the ONLY composer pill and deliberately QUIET: just the engine
  // selector (name + chevron). Telemetry (model · MAX · CTX% · turns) lives
  // in the tap-to-open dropdown header — the composer line stays quiet in EVERY
  // mode (UI/UX rework 2026-06-03, phase C1; owner directive:
  // „die Engine Pill mit dem Rest unten komplett zu viel und überfordernd").
  if (variant === 'compact') {
    const turnHint =
      usage && usage.turnCount > 0
        ? `${usage.turnCount} Turn${usage.turnCount === 1 ? '' : 's'}`
        : null;
    const title =
      usage && engineMode === 'claude-cli'
        ? `Engine: ${activeEngine.label} · ${prettyModel(usage.model)}${usage.maxPlan ? ' · MAX-Plan' : ''} · effort xhigh · ${usage.contextTotal.toLocaleString('de')} / ${usage.contextWindow.toLocaleString('de')} tokens (${usage.contextFillPct}%)${turnHint ? ` · ${turnHint}` : ''}`
        : `Engine: ${activeEngine.label}`;
    return (
      <div
        ref={rootRef}
        className="engine-pill"
        style={compactWrapStyle}
        aria-label="Chat engine status"
        data-test="engine-pill-root"
        data-engine-mode={engineMode}
        title={title}
      >
        <EngineSelectorButton
          active={activeEngine}
          open={dropdownOpen}
          onToggle={() => setDropdownOpen((v) => !v)}
        />
        {dropdownOpen ? (
          <EngineDropdown
            currentMode={engineMode}
            availability={engineAvail}
            onPick={pickEngine}
            usage={usage}
          />
        ) : null}
      </div>
    );
  }

  // the full variant needs the telemetry
  if (!usage) return null;

  const model = prettyModel(usage.model);
  const fillPct = usage.contextFillPct;

  // full variant — uses ENG-Card from /design
  const meta = (
    <>
      {model} · <b>{usage.maxPlan ? 'MAX-Plan' : 'API'}</b> · effort <b>xhigh</b>
      <br />
      Context <b>{formatTokens(usage.contextTotal)}</b>/{formatTokens(usage.contextWindow)}
      {' '}
      ({fillPct}%) · {usage.turnCount} turns
    </>
  );

  return (
    <Engine
      type="claude"
      name="Claude Code"
      status={usage.claudeAvailable ? 'running' : 'idle'}
      meta={meta}
    />
  );
}

// ---- Engine-selector helpers (pill dedup 2026-05-23) ----

interface EngineSelectorButtonProps {
  active: EngineOption;
  open: boolean;
  onToggle: () => void;
}

function EngineSelectorButton({
  active,
  open,
  onToggle,
}: EngineSelectorButtonProps): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onToggle}
      style={engineBtnStyle(open)}
      aria-expanded={open}
      aria-haspopup="listbox"
      data-test="engine-pill-trigger"
    >
      <span style={engineLabelStyle}>{active.label}</span>
      <span style={engineChevronStyle} aria-hidden><IconChevronDown size={12} /></span>
    </button>
  );
}

interface EngineDropdownProps {
  currentMode: EngineMode;
  availability: EngineAvailability[];
  onPick: (m: EngineMode) => void;
  /** Live telemetry of the active claude-cli session (header in the dropdown). */
  usage: UsagePayload | null;
}

// C6 un-gate (2026-05-25): no more gated modes — codex-cli always runs in the
// chat route with codexMode:'read' (OS-level sandbox, no write).
// parallel-all only races codex read. The empty set stays for belt-and-suspenders
// in the code (GATED_MODES.has() becomes false for all modes → no disabled button).
const GATED_MODES = new Set<EngineMode>();

function EngineDropdown({
  currentMode,
  availability,
  onPick,
  usage,
}: EngineDropdownProps): React.JSX.Element {
  // Telemetry header (phase C1): model · MAX · CTX% · turns now live HERE
  // instead of on the composer line. Only meaningful with an active claude-cli session.
  const showTelemetry = usage && currentMode === 'claude-cli';
  const fillPct = usage?.contextFillPct ?? 0;
  const ctxColor =
    fillPct > 80 ? 'var(--a-danger)' : fillPct > 60 ? 'var(--a-warn)' : 'var(--a-now)';
  return (
    <div
      role="listbox"
      aria-label="Engine wählen"
      style={dropdownStyle}
      data-test="engine-pill-dropdown"
    >
      {showTelemetry && usage ? (
        <div style={dropdownTelemetryStyle} data-test="engine-pill-telemetry">
          <span style={{ fontWeight: 600, color: 'var(--ink)' }}>
            {prettyModel(usage.model)}
          </span>
          {usage.maxPlan ? <span style={planBadgeStyle}>MAX</span> : null}
          <span style={{ marginLeft: 'auto', color: ctxColor }}>
            {fillPct}% CTX
            {usage.turnCount > 0
              ? ` · ${usage.turnCount} Turn${usage.turnCount === 1 ? '' : 's'}`
              : ''}
          </span>
        </div>
      ) : null}
      {ENGINE_OPTIONS.map((opt) => {
        const isActive = opt.mode === currentMode;
        // C6 un-gate: GATED_MODES is empty — isGated is always false.
        // Belt-and-suspenders: the guard stays, may prevent a future regression.
        const isGated = GATED_MODES.has(opt.mode);
        const probe = availability.find((a) => a.engine === opt.mode);
        // Availability dot (green/gray) from the probe result.
        const ok = !isGated && probe?.available === true;
        return (
          <button
            key={opt.mode}
            type="button"
            role="option"
            aria-selected={isActive}
            onClick={isGated ? undefined : () => onPick(opt.mode)}
            disabled={isGated}
            style={optionStyle(isActive, isGated)}
            data-test={`engine-pill-opt-${opt.mode}`}
            data-available={isGated ? 'gated' : ok ? 'true' : 'false'}
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
  );
}

const compactWrapStyle: CSSProperties = {
  position: 'relative',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  padding: '5px 10px',
  borderRadius: 'var(--radius-pill, 999px)',
  // Opaque (was 85%/transparent) — parent-bleed fix (sweep 2026-05-01)
  background: 'var(--sheet-2)',
  border: '0.5px solid var(--line-2)',
  // D2-Fix (2026-05-30): 10px → 11px (WCAG-AA minimum size for meta text).
  fontSize: 11,
  fontFamily: 'var(--font-mono)',
  letterSpacing: '0.02em',
  color: 'var(--ink-2)',
  maxWidth: '100%',
  flexWrap: 'wrap',
  justifyContent: 'center',
  rowGap: 2,
};

function engineBtnStyle(open: boolean): CSSProperties {
  return {
    appearance: 'none',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    padding: '3px 6px 3px 5px',
    borderRadius: 999,
    border: '0.5px solid var(--line-2, #1f1f1f)',
    background: open
      ? 'color-mix(in oklab, var(--a-now, #c9ff4d) 6%, var(--sheet-2, #0e0e0e))'
      : 'transparent',
    color: 'var(--ink, #f5f5f5)',
    fontFamily: 'var(--font-sans, system-ui)',
    fontSize: 11,
    fontWeight: 500,
    letterSpacing: '0.01em',
    cursor: 'pointer',
    transition: 'background var(--dur-base) var(--spring-snappy), border-color var(--dur-base) var(--spring-snappy)',
  };
}

const engineLabelStyle: CSSProperties = {
  letterSpacing: '0.01em',
  fontWeight: 500,
};

const engineChevronStyle: CSSProperties = {
  fontSize: 11,
  color: 'var(--ink-3, #6b6b6b)',
  marginLeft: 1,
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

const dropdownTelemetryStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '8px 12px',
  marginBottom: 2,
  borderBottom: '0.5px solid var(--line-2)',
  fontSize: 11,
  fontFamily: 'var(--font-mono)',
  letterSpacing: '0.02em',
  color: 'var(--ink-2)',
};

function optionStyle(active: boolean, gated = false): CSSProperties {
  return {
    appearance: 'none',
    border: 'none',
    background: active
      ? 'color-mix(in oklab, var(--a-now, #c9ff4d) 10%, transparent)'
      : 'transparent',
    // Gated engines: no pointer cursor, full opacity reduction signals
    // "not interactive" — consistent with the existing offDot style.
    cursor: gated ? 'not-allowed' : 'pointer',
    opacity: gated ? 0.4 : 1,
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '10px 12px',
    borderRadius: 10,
    textAlign: 'left',
    color: 'var(--ink, #f5f5f5)',
    transition: 'background 120ms ease',
    fontFamily: 'var(--font-sans, system-ui)',
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

const planBadgeStyle: CSSProperties = {
  fontSize: 10,
  letterSpacing: '0.1em',
  padding: '1px 6px',
  background: 'color-mix(in oklab, var(--a-now) 15%, transparent)',
  color: 'var(--a-now)',
  borderRadius: 4,
  marginLeft: 2,
};
