'use client';

/**
 * SessionControls — Apple-pure session action sheet.
 *
 * 2026-05-03 Wave A — Redesign after user frustration:
 *  > „diese buttons sind eine ui design katastrophe und nicht an der
 *  > design library weiterentwickelt worden! jede einbindung benötigt
 *  > design expertise ala steve jobs und design thinking!!"
 *
 * Before: 4 pill buttons side by side with two-tap confirm, density junk,
 * mobile broken. Now: 1 icon-only `•••` trigger + action sheet.
 *
 *  - Mobile (<480px) → bottom sheet (slide-up via spring-bouncy 240ms)
 *  - Desktop ≥480px  → anchored popover below the trigger
 *  - Inline confirm step for destructive actions (stop / new session
 *    / clear) — the row morphs for 4s to „Wirklich? — Bestätigen" and
 *    then reverts automatically. Replaces the two-tap pattern.
 *  - Backdrop tap / ESC close, focus trap active while open.
 *
 * REGISTRY handlers stay unchanged (DRY with slash commands).
 *
 * Tokens-only, no inline hex. Reduced-motion via globals.css.
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';

import type { HistoryItem } from './ChatShell';
import { REGISTRY, type SystemItem } from './slash-commands';

export interface SessionControlsProps {
  workspaceId: string;
  history: HistoryItem[];
  setHistory: (
    next: HistoryItem[] | ((prev: HistoryItem[]) => HistoryItem[]),
  ) => void;
  pushSystemToast: (item: SystemItem) => void;
  clearSystemMessages?: () => void;
}

type ActionId = 'session-new' | 'clear' | 'compact' | 'stop';
type BusyId = ActionId | null;

const CONFIRM_REVERT_MS = 4000;

interface ActionRow {
  id: ActionId;
  label: string;
  description: string;
  ariaLabel: string;
  destructive: boolean;
  icon: ReactNode;
  /** When `true` the row renders as a pure tap action (compact). Otherwise an inline confirm step. */
  immediate?: boolean;
}

export function SessionControls({
  workspaceId,
  history,
  setHistory,
  pushSystemToast,
  clearSystemMessages,
}: SessionControlsProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<BusyId>(null);
  const [confirmingId, setConfirmingId] = useState<ActionId | null>(null);
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<Element | null>(null);
  const confirmRevertTimer = useRef<number | null>(null);

  const sheetId = useId();

  // ───────────────────────────────────────────────────────────────────────
  //  Handlers (REGISTRY stays single-source — no logic dup).
  // ───────────────────────────────────────────────────────────────────────

  const triggerClear = useCallback(async () => {
    if (busy) return;
    setBusy('clear');
    try {
      const cmd = REGISTRY.get('/clear');
      if (!cmd) return;
      await cmd.handler({
        workspaceId,
        history,
        setHistory,
        pushSystemToast,
        clearSystemMessages,
        fetch: window.fetch.bind(window),
      });
    } finally {
      setBusy(null);
    }
  }, [busy, workspaceId, history, setHistory, pushSystemToast, clearSystemMessages]);

  const triggerCompact = useCallback(async () => {
    if (busy) return;
    setBusy('compact');
    try {
      const cmd = REGISTRY.get('/compact');
      if (!cmd) return;
      await cmd.handler({
        workspaceId,
        history,
        setHistory,
        pushSystemToast,
        clearSystemMessages,
        fetch: window.fetch.bind(window),
      });
    } finally {
      setBusy(null);
    }
  }, [busy, workspaceId, history, setHistory, pushSystemToast, clearSystemMessages]);

  const triggerSessionNew = useCallback(async () => {
    if (busy) return;
    setBusy('session-new');
    try {
      const cmd = REGISTRY.get('/session-new');
      if (!cmd) return;
      await cmd.handler({
        workspaceId,
        history,
        setHistory,
        pushSystemToast,
        clearSystemMessages,
        fetch: window.fetch.bind(window),
      });
    } finally {
      setBusy(null);
    }
  }, [busy, workspaceId, history, setHistory, pushSystemToast, clearSystemMessages]);

  const triggerStop = useCallback(async () => {
    if (busy) return;
    setBusy('stop');
    try {
      const wsListRes = await fetch(
        `/api/workstreams?workspaceId=${encodeURIComponent(workspaceId)}&status=active`,
        { cache: 'no-store' },
      );
      if (!wsListRes.ok) {
        pushSystemToast({
          id: `slash-stop-${Date.now()}`,
          role: 'system',
          kind: 'session-stop-fail',
          ts: new Date().toISOString(),
          severity: 'warn',
          content: `Stoppen fehlgeschlagen: HTTP ${wsListRes.status}`,
        });
        return;
      }
      const body = (await wsListRes.json().catch(() => ({}))) as {
        items?: Array<{ id: string }>;
      };
      const ids = (body.items ?? []).map((i) => i.id);
      if (ids.length === 0) {
        pushSystemToast({
          id: `slash-stop-${Date.now()}`,
          role: 'system',
          kind: 'session-stop-noop',
          ts: new Date().toISOString(),
          severity: 'info',
          content: 'Keine aktiven Workstreams in diesem Workspace.',
        });
        return;
      }
      let okCount = 0;
      await Promise.all(
        ids.map(async (id) => {
          try {
            const r = await fetch(`/api/workstreams/${encodeURIComponent(id)}/cancel`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ reason: 'session-controls-stop' }),
            });
            if (r.ok) okCount += 1;
          } catch {
            /* ignore */
          }
        }),
      );
      pushSystemToast({
        id: `slash-stop-${Date.now()}`,
        role: 'system',
        kind: okCount === ids.length ? 'session-stop-ok' : 'session-stop-partial',
        ts: new Date().toISOString(),
        severity: okCount === ids.length ? 'info' : 'warn',
        content: `Aktive Workstreams gestoppt — ${okCount}/${ids.length} cancelled.`,
      });
    } finally {
      setBusy(null);
    }
  }, [busy, workspaceId, pushSystemToast]);

  const runAction = useCallback(
    async (id: ActionId) => {
      if (id === 'clear') await triggerClear();
      else if (id === 'compact') await triggerCompact();
      else if (id === 'session-new') await triggerSessionNew();
      else if (id === 'stop') await triggerStop();
    },
    [triggerClear, triggerCompact, triggerSessionNew, triggerStop],
  );

  // ───────────────────────────────────────────────────────────────────────
  //  Sheet open/close + side-effects (focus, ESC, body-lock).
  // ───────────────────────────────────────────────────────────────────────

  const closeSheet = useCallback(() => {
    setOpen(false);
    setConfirmingId(null);
    if (confirmRevertTimer.current !== null) {
      window.clearTimeout(confirmRevertTimer.current);
      confirmRevertTimer.current = null;
    }
  }, []);

  const openSheet = useCallback(() => {
    previouslyFocused.current = document.activeElement;
    // Anchored popover: compute position relative to the trigger.
    // Top = below the trigger (bottom + 6px spacer).
    // Right = from the viewport edge to the trigger edge.
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      setAnchor({
        top: Math.round(rect.bottom + 6),
        right: Math.max(8, Math.round(window.innerWidth - rect.right)),
      });
    }
    setOpen(true);
  }, []);

  // ESC + Tab-trap.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeSheet();
        return;
      }
      if (e.key !== 'Tab') return;
      const root = sheetRef.current;
      if (!root) return;
      const focusables = root.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, closeSheet]);

  // Initial focus on the first row when opening, restore when closing.
  useEffect(() => {
    if (open) {
      // requestAnimationFrame so the sheet is in the DOM.
      const id = requestAnimationFrame(() => {
        const first =
          sheetRef.current?.querySelector<HTMLElement>('[data-sheet-row]');
        first?.focus();
      });
      return () => cancelAnimationFrame(id);
    }
    // restore
    if (previouslyFocused.current instanceof HTMLElement) {
      previouslyFocused.current.focus();
    }
  }, [open]);

  // Cleanup confirm-timer on unmount.
  useEffect(
    () => () => {
      if (confirmRevertTimer.current !== null) {
        window.clearTimeout(confirmRevertTimer.current);
      }
    },
    [],
  );

  // ───────────────────────────────────────────────────────────────────────
  //  Row click: inline confirm for destructive, immediate for non-destructive.
  // ───────────────────────────────────────────────────────────────────────

  const onRowActivate = useCallback(
    (action: ActionRow) => {
      if (busy) return;
      if (action.immediate || !action.destructive) {
        // Compact = immediate, without confirm. Sheet closes after the run.
        void runAction(action.id).then(() => {
          closeSheet();
        });
        return;
      }
      // First activation: show the confirm step.
      if (confirmingId !== action.id) {
        setConfirmingId(action.id);
        if (confirmRevertTimer.current !== null) {
          window.clearTimeout(confirmRevertTimer.current);
        }
        confirmRevertTimer.current = window.setTimeout(() => {
          setConfirmingId(null);
          confirmRevertTimer.current = null;
        }, CONFIRM_REVERT_MS);
        return;
      }
      // Second activation: execute + close the sheet.
      if (confirmRevertTimer.current !== null) {
        window.clearTimeout(confirmRevertTimer.current);
        confirmRevertTimer.current = null;
      }
      setConfirmingId(null);
      void runAction(action.id).then(() => {
        closeSheet();
      });
    },
    [busy, confirmingId, runAction, closeSheet],
  );

  // ───────────────────────────────────────────────────────────────────────
  //  Action definitions — iOS music-sheet pattern: non-destructive on top,
  //  section divider, destructive cluster at the bottom.
  // ───────────────────────────────────────────────────────────────────────

  const actions: ActionRow[] = [
    {
      id: 'compact',
      label: 'Verlauf kompaktieren',
      description: 'Ältere Items verkleinern, jüngste behalten',
      ariaLabel: 'Verlauf kompaktieren — Server-Snapshot + lokaler Trim',
      destructive: false,
      immediate: true,
      icon: <IconCompact />,
    },
    {
      id: 'session-new',
      label: 'Neue Session',
      description: 'Verlauf leeren + aktive Workstreams stoppen',
      ariaLabel: 'Neue Session: aktive Workstreams stoppen und Verlauf leeren',
      destructive: true,
      icon: <IconSessionNew />,
    },
    {
      id: 'clear',
      label: 'Verlauf leeren',
      description: 'Lokaler Verlauf weg, Server unberührt',
      ariaLabel: 'Chat-Verlauf lokal leeren',
      destructive: true,
      icon: <IconClear />,
    },
    {
      id: 'stop',
      label: 'Aktive Workstreams stoppen',
      description: 'Alle laufenden in diesem Workspace canceln',
      ariaLabel: 'Aktive Workstreams in diesem Workspace stoppen',
      destructive: true,
      icon: <IconStop />,
    },
  ];

  const firstDestructiveIdx = actions.findIndex((a) => a.destructive);

  const onBackdropClick = (e: ReactMouseEvent<HTMLDivElement>): void => {
    if (e.target === e.currentTarget) closeSheet();
  };

  // ───────────────────────────────────────────────────────────────────────
  //  Render.
  // ───────────────────────────────────────────────────────────────────────

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (open ? closeSheet() : openSheet())}
        className="chat-session-trigger"
        aria-label="Sitzungs-Aktionen"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={sheetId}
        data-state={open ? 'open' : 'closed'}
      >
        <IconDots />
      </button>

      {open ? (
        <div
          className="chat-session-sheet-backdrop"
          onClick={onBackdropClick}
          role="presentation"
          data-mounted="true"
        >
          <div
            ref={sheetRef}
            id={sheetId}
            className="chat-session-sheet"
            role="menu"
            aria-modal="true"
            aria-label="Sitzungs-Aktionen"
            style={
              anchor
                ? ({
                    '--popover-anchor-top': `${anchor.top}px`,
                    '--popover-anchor-right': `${anchor.right}px`,
                  } as CSSProperties)
                : undefined
            }
            onKeyDown={(e: ReactKeyboardEvent<HTMLDivElement>) => {
              // Prevent bubble for captured keys
              if (e.key === 'Escape') e.stopPropagation();
            }}
          >
            <span className="chat-session-sheet__handle" aria-hidden="true" />
            <h2 className="chat-session-sheet__title">Sitzung verwalten</h2>

            <ul className="chat-session-sheet__list" role="none">
              {actions.map((action, idx) => {
                const isConfirming = confirmingId === action.id;
                const isBusy = busy === action.id;
                const isDestructive = action.destructive;
                const showSeparatorBefore = idx === firstDestructiveIdx && idx > 0;
                return (
                  <li
                    key={action.id}
                    role="none"
                    className={`chat-session-sheet__item${
                      showSeparatorBefore ? ' chat-session-sheet__item--separator-before' : ''
                    }`}
                  >
                    <button
                      type="button"
                      role="menuitem"
                      data-sheet-row="true"
                      data-destructive={isDestructive ? 'true' : undefined}
                      data-confirming={isConfirming ? 'true' : undefined}
                      data-busy={isBusy ? 'true' : undefined}
                      disabled={isBusy || (busy !== null && busy !== action.id)}
                      aria-label={isConfirming ? `Bestätigen: ${action.ariaLabel}` : action.ariaLabel}
                      onClick={() => onRowActivate(action)}
                      className="chat-session-sheet__row"
                    >
                      <span className="chat-session-sheet__icon" aria-hidden="true">
                        {action.icon}
                      </span>
                      <span className="chat-session-sheet__body">
                        {isConfirming ? (
                          <>
                            <span className="chat-session-sheet__label">
                              Wirklich {action.label.toLowerCase()}?
                            </span>
                            <span className="chat-session-sheet__hint">
                              Tippen zum Bestätigen
                            </span>
                          </>
                        ) : (
                          <>
                            <span className="chat-session-sheet__label">
                              {action.label}
                            </span>
                            <span className="chat-session-sheet__hint">
                              {action.description}
                            </span>
                          </>
                        )}
                      </span>
                      {isBusy ? (
                        <span
                          className="chat-session-sheet__busy"
                          aria-hidden="true"
                        />
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>

            {/* Cancel row (iOS pattern: full-width, separate background). */}
            <button
              type="button"
              data-sheet-row="true"
              data-cancel="true"
              className="chat-session-sheet__cancel"
              onClick={closeSheet}
              aria-label="Abbrechen — Sheet schließen"
            >
              Abbrechen
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}

// ───────────────────────────────────────────────────────────────────────────
//  Icons (16px stroke-2 round, Apple-pure).
// ───────────────────────────────────────────────────────────────────────────

const ICON_PROPS = {
  width: 20,
  height: 20,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
} satisfies Partial<React.SVGAttributes<SVGElement>>;

function IconDots(): React.JSX.Element {
  // 16px for the toolbar trigger (smaller hit surface).
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <circle cx="5" cy="12" r="2" />
      <circle cx="12" cy="12" r="2" />
      <circle cx="19" cy="12" r="2" />
    </svg>
  );
}

function IconSessionNew(): React.JSX.Element {
  return (
    <svg {...ICON_PROPS}>
      <path d="M21 12a9 9 0 1 1-3.5-7.1" />
      <path d="M21 4v5h-5" />
    </svg>
  );
}

function IconClear(): React.JSX.Element {
  return (
    <svg {...ICON_PROPS}>
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    </svg>
  );
}

function IconCompact(): React.JSX.Element {
  return (
    <svg {...ICON_PROPS}>
      <path d="M4 9h16" />
      <path d="M4 15h16" />
      <path d="M9 4l3 3 3-3" />
      <path d="M9 20l3-3 3 3" />
    </svg>
  );
}

function IconStop(): React.JSX.Element {
  return (
    <svg {...ICON_PROPS}>
      <rect x="6" y="6" width="12" height="12" rx="1.5" />
    </svg>
  );
}

// Eslint pacifier — `CSSProperties` as a re-export, in case needed externally.
export type _SessionControlsCSSPlaceholder = CSSProperties;

export default SessionControls;
