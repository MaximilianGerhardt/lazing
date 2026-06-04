'use client';

/**
 * ChatWorkspaceInlineSwitcher
 * ---------------------------
 * A compact second access point for the workspace switch, placed directly to the
 * LEFT of the chat input. The primary switcher in the header (right) stays
 * in place — this variant is explicitly optimized for the chat input field
 * so Max can switch in the typing flow without moving the mouse/the
 * gaze to the top bar.
 *
 * Behavior:
 * - trigger = pill with accent dot + label (max-width 180px via ellipsis)
 * - click → inline popover with a list (max-height 240px, scrollbar)
 * - click on a workspace → useSetWorkspace() triggers an event
 *   (header switcher + body class + ChatShell effect follow)
 * - click-outside / ESC closes
 * - archived workspaces are filtered out (analogous to WorkspaceSwitcher)
 *
 * This component is deliberately kept WITHOUT search/filter — the header
 * has the full variant. Here a quick switch is primary.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';

import {
  useCurrentWorkspace,
  useSetWorkspace,
  useWorkspaces,
} from '@/lib/nav/hooks';
import { IconChevronDown, IconCheck } from '../nav/icons';
import type { Workspace } from '@/lib/nav/types';

export function ChatWorkspaceInlineSwitcher(): React.JSX.Element {
  const current = useCurrentWorkspace();
  const setWorkspace = useSetWorkspace();
  const { workspaces } = useWorkspaces();

  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // Visible rows: all non-archived; private only when already active.
  const rows = useMemo<Workspace[]>(() => {
    return workspaces.filter((w) => {
      if (w.archived) return false;
      if (w.sensitivity === 'high' && w.id !== current.id) return false;
      return true;
    });
  }, [workspaces, current.id]);

  // ESC + click-outside.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setOpen(false);
        setActiveIndex(-1);
        triggerRef.current?.focus();
      }
    };
    const onClick = (e: MouseEvent): void => {
      const target = e.target as Node | null;
      if (!target) return;
      if (popoverRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      setOpen(false);
      setActiveIndex(-1);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onClick);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onClick);
    };
  }, [open]);

  // activeIndex is set purely imperatively in `openPopover` / handlePopoverKeyDown.
  // No sync effect needed — rows are stable enough for the duration of an
  // open popover (fetch hydrates them once via
  // useWorkspaces).

  // Scroll active row into view.
  useEffect(() => {
    if (!open || activeIndex < 0) return;
    const list = listRef.current;
    if (!list) return;
    const row = list.querySelectorAll<HTMLElement>('[data-row]')[activeIndex];
    row?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open]);

  const handleSelect = useCallback(
    (id: string): void => {
      if (id !== current.id) {
        setWorkspace(id);
      }
      setOpen(false);
      setActiveIndex(-1);
      triggerRef.current?.focus();
    },
    [setWorkspace, current.id],
  );

  const handlePopoverKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>): void => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIndex((i) => (i + 1 >= rows.length ? 0 : i + 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex((i) =>
          i - 1 < 0 ? Math.max(0, rows.length - 1) : i - 1,
        );
      } else if (e.key === 'Enter') {
        const target = rows[activeIndex];
        if (target) {
          e.preventDefault();
          handleSelect(target.id);
        }
      }
    },
    [rows, activeIndex, handleSelect],
  );

  const openPopover = useCallback((): void => {
    const selectedIdx = rows.findIndex((w) => w.id === current.id);
    setActiveIndex(selectedIdx >= 0 ? selectedIdx : 0);
    setOpen(true);
  }, [rows, current.id]);

  const toggleOpen = useCallback((): void => {
    if (open) {
      setOpen(false);
      setActiveIndex(-1);
    } else {
      openPopover();
    }
  }, [open, openPopover]);

  const handleTriggerKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLButtonElement>): void => {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openPopover();
      }
    },
    [openPopover],
  );

  return (
    <div style={wrapperStyle}>
      <button
        ref={triggerRef}
        type="button"
        className="lazyos-chat-ws-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Workspace: ${current.label}. Klicken zum Wechseln.`}
        onClick={toggleOpen}
        onKeyDown={handleTriggerKeyDown}
        style={{
          ...triggerStyle,
          ...(open ? triggerOpenStyle : {}),
        }}
        title={`Workspace: ${current.label}`}
      >
        <span
          aria-hidden="true"
          style={{
            ...dotStyle,
            background: `var(--accent-${current.accent}, var(--a-now))`,
          }}
        />
        <span style={labelStyle}>{current.label}</span>
        <span aria-hidden="true" style={caretStyle}>
          <IconChevronDown size={12} />
        </span>
      </button>

      {open ? (
        <div
          ref={popoverRef}
          className="lazyos-chat-ws-popover"
          role="dialog"
          aria-label="Workspace wählen"
          onKeyDown={handlePopoverKeyDown}
          style={popoverStyle}
        >
          <ul
            ref={listRef}
            role="listbox"
            aria-label="Workspaces"
            style={listStyle}
          >
            {rows.map((w, idx) => {
              const selected = w.id === current.id;
              const active = idx === activeIndex;
              return (
                <li key={w.id} style={{ listStyle: 'none' }}>
                  <button
                    type="button"
                    data-row
                    role="option"
                    aria-selected={selected}
                    tabIndex={-1}
                    onClick={() => handleSelect(w.id)}
                    onMouseEnter={() => setActiveIndex(idx)}
                    style={{
                      ...itemStyle,
                      ...(active ? itemActiveStyle : {}),
                      ...(selected ? itemSelectedStyle : {}),
                    }}
                  >
                    <span
                      aria-hidden="true"
                      style={{
                        ...dotStyle,
                        background: `var(--accent-${w.accent}, var(--a-now))`,
                      }}
                    />
                    <span style={itemLabelStyle}>{w.label}</span>
                    {selected ? (
                      <span aria-hidden="true" style={checkStyle}>
                        <IconCheck size={14} />
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })}
            {rows.length === 0 ? (
              <li
                role="note"
                style={{
                  padding: '10px 12px',
                  fontSize: 12,
                  color: 'var(--ink-3)',
                }}
              >
                Keine Workspaces.
              </li>
            ) : null}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

export default ChatWorkspaceInlineSwitcher;

// -----------------------------------------------------------------------
// Styles
// -----------------------------------------------------------------------

const wrapperStyle: CSSProperties = {
  position: 'relative',
  flexShrink: 0,
};

const triggerStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  height: 36,
  padding: '0 10px',
  maxWidth: 180,
  border: '0.5px solid var(--line-2)',
  borderRadius: 999,
  background: 'var(--sheet-2)',
  color: 'var(--ink-2)',
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontSize: 12,
  letterSpacing: '-0.01em',
  transition: 'border-color 120ms, background 120ms, color 120ms',
  flexShrink: 0,
};

const triggerOpenStyle: CSSProperties = {
  borderColor: 'var(--ink-3)',
  color: 'var(--ink)',
};

const dotStyle: CSSProperties = {
  width: 8,
  height: 8,
  borderRadius: '50%',
  flexShrink: 0,
  boxShadow: '0 0 0 1px color-mix(in srgb, var(--ink) 10%, transparent)',
};

const labelStyle: CSSProperties = {
  maxWidth: 120,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontWeight: 500,
};

const caretStyle: CSSProperties = {
  fontSize: 9,
  opacity: 0.55,
  marginLeft: 2,
};

const popoverStyle: CSSProperties = {
  position: 'absolute',
  bottom: 'calc(100% + 6px)',
  left: 0,
  minWidth: 220,
  maxWidth: 280,
  background: 'var(--glass, var(--sheet-2))',
  backdropFilter: 'blur(30px)',
  WebkitBackdropFilter: 'blur(30px)',
  border: '0.5px solid var(--line-2)',
  borderRadius: 12,
  padding: 6,
  boxShadow: '0 20px 40px -10px rgba(0, 0, 0, 0.35)',
  zIndex: 40,
};

const listStyle: CSSProperties = {
  margin: 0,
  padding: 0,
  maxHeight: 240,
  overflowY: 'auto',
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
};

const itemStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  width: '100%',
  padding: '8px 10px',
  border: 'none',
  background: 'transparent',
  color: 'var(--ink-2)',
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontSize: 13,
  letterSpacing: '-0.01em',
  borderRadius: 8,
  textAlign: 'left',
};

const itemActiveStyle: CSSProperties = {
  background: 'var(--sheet)',
  color: 'var(--ink)',
};

const itemSelectedStyle: CSSProperties = {
  color: 'var(--ink)',
  fontWeight: 500,
};

const itemLabelStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const checkStyle: CSSProperties = {
  fontSize: 11,
  color: 'var(--a-now)',
  flexShrink: 0,
};
