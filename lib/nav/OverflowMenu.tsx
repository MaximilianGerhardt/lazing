'use client';

/**
 * OverflowMenu — the one "•••" menu for secondary TopNav actions (desktop).
 *
 * 2026-05-30 Apple reduction (render critic HIGH: „12+ Targets, keine
 * Hierarchie"). The bar now shows only the 3-4 primary targets
 * (org eyebrow · workspace title · health dot · ••• · profile). Everything
 * else — terminal · GitHub · settings · observatory · design library
 * — lives here behind a single "•••" trigger.
 *
 * On mobile (<768px) this menu is hidden (`topnav-right-mobile-hide`
 * on the wrapper): there the already-wired hamburger drawer takes over
 * (terminal/settings/observatory/design + profile/sign-out). We
 * do NOT duplicate the drawer — we supply the same targets on desktop.
 *
 * Mechanics = deliberately identical to StatusCluster: anchored popover, ESC +
 * tab trap + restore focus + click-outside, tokens-only styling under
 * `.topnav-overflow*` in components.css. No inline hex.
 */

import Link from 'next/link';
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
} from 'react';

import {
  IconOverflow,
  IconTerminal,
  IconGear,
  IconObservatory,
  IconLayers,
} from './icons';
import { useCurrentWorkspace } from './hooks';

interface GithubState {
  connected: boolean;
  login: string | null;
  loaded: boolean;
}

export function OverflowMenu(): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(
    null,
  );
  const [github, setGithub] = useState<GithubState>({
    connected: false,
    login: null,
    loaded: false,
  });

  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<Element | null>(null);

  const menuId = useId();
  const currentWorkspace = useCurrentWorkspace();

  // GitHub-Status einmalig (lazy) laden — wie GitHubIndicator vorher.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/github/status', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : {}))
      .then((data: { connected?: boolean; login?: string | null }) => {
        if (cancelled) return;
        setGithub({
          connected: !!data.connected,
          login: data.login ?? null,
          loaded: true,
        });
      })
      .catch(() => {
        if (!cancelled)
          setGithub({ connected: false, login: null, loaded: true });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const closeMenu = useCallback(() => setOpen(false), []);
  const openMenu = useCallback(() => {
    previouslyFocused.current = document.activeElement;
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      setAnchor({
        top: Math.round(rect.bottom + 6),
        right: Math.max(8, Math.round(window.innerWidth - rect.right)),
      });
    }
    setOpen(true);
  }, []);

  // ESC + Tab-Trap.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeMenu();
        return;
      }
      if (e.key !== 'Tab') return;
      const root = menuRef.current;
      if (!root) return;
      const focusables = root.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [tabindex]:not([tabindex="-1"]), a[href]',
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
  }, [open, closeMenu]);

  // Restore-Focus on close.
  useEffect(() => {
    if (open) return;
    if (previouslyFocused.current instanceof HTMLElement) {
      previouslyFocused.current.focus();
    }
  }, [open]);

  const openTerminal = useCallback((): void => {
    closeMenu();
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event('lazyos:terminal:open'));
    }
  }, [closeMenu]);

  const githubLabel = github.connected
    ? `GitHub verbunden${github.login ? ` als @${github.login}` : ''}`
    : 'GitHub verbinden';
  const terminalHint =
    currentWorkspace.id === '__root__'
      ? 'Sessions-Übersicht'
      : currentWorkspace.label;

  return (
    <div className="topnav-overflow topnav-right-mobile-hide">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (open ? closeMenu() : openMenu())}
        className="topnav-gear topnav-overflow__trigger"
        data-state={open ? 'open' : 'closed'}
        aria-label="Weitere Aktionen"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        title="Weitere Aktionen"
        data-testid="topnav-overflow-trigger"
      >
        <IconOverflow />
      </button>

      {open ? (
        <div
          className="topnav-overflow-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeMenu();
          }}
          role="presentation"
        >
          <div
            ref={menuRef}
            id={menuId}
            className="topnav-overflow-menu"
            role="menu"
            aria-label="Weitere Aktionen"
            style={
              anchor
                ? ({
                    '--popover-anchor-top': `${anchor.top}px`,
                    '--popover-anchor-right': `${anchor.right}px`,
                  } as CSSProperties)
                : undefined
            }
          >
            <button
              type="button"
              role="menuitem"
              className="topnav-overflow-item"
              onClick={openTerminal}
              data-testid="overflow-terminal"
            >
              <span className="topnav-overflow-item__ico" aria-hidden="true">
                <IconTerminal size={16} />
              </span>
              <span className="topnav-overflow-item__body">
                <span className="topnav-overflow-item__label">Terminal</span>
                <span className="topnav-overflow-item__meta">{terminalHint}</span>
              </span>
            </button>

            <Link
              href="/settings#github"
              role="menuitem"
              className="topnav-overflow-item"
              onClick={closeMenu}
              data-testid="overflow-github"
              data-connected={github.connected ? 'yes' : 'no'}
            >
              <span
                className="topnav-overflow-item__ico"
                aria-hidden="true"
                style={{
                  color: github.connected ? 'var(--a-now)' : undefined,
                }}
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path d="M12 2C6.48 2 2 6.58 2 12.22c0 4.5 2.87 8.32 6.85 9.67.5.1.68-.22.68-.49v-1.7c-2.78.6-3.37-1.35-3.37-1.35-.45-1.16-1.11-1.47-1.11-1.47-.91-.63.07-.62.07-.62 1 .07 1.53 1.05 1.53 1.05.9 1.56 2.36 1.1 2.93.85.09-.66.35-1.1.63-1.36-2.22-.26-4.55-1.13-4.55-5.04 0-1.11.39-2.02 1.03-2.73-.1-.26-.45-1.3.1-2.71 0 0 .84-.27 2.75 1.04A9.42 9.42 0 0 1 12 7.06c.85.004 1.7.12 2.5.34 1.9-1.31 2.74-1.04 2.74-1.04.55 1.41.2 2.45.1 2.71.64.71 1.03 1.62 1.03 2.73 0 3.92-2.34 4.78-4.57 5.03.36.32.68.94.68 1.91v2.82c0 .27.18.6.69.49C19.13 20.54 22 16.72 22 12.22 22 6.58 17.52 2 12 2z" />
                </svg>
              </span>
              <span className="topnav-overflow-item__body">
                <span className="topnav-overflow-item__label">GitHub</span>
                <span className="topnav-overflow-item__meta">{githubLabel}</span>
              </span>
            </Link>

            <Link
              href="/observatory"
              role="menuitem"
              className="topnav-overflow-item"
              onClick={closeMenu}
              data-testid="overflow-observatory"
              prefetch={false}
            >
              <span className="topnav-overflow-item__ico" aria-hidden="true">
                <IconObservatory size={16} />
              </span>
              <span className="topnav-overflow-item__body">
                <span className="topnav-overflow-item__label">Observatory</span>
                <span className="topnav-overflow-item__meta">
                  Live-Status aller Workspaces
                </span>
              </span>
            </Link>

            <div className="topnav-overflow-sep" role="separator" />

            <Link
              href="/settings"
              role="menuitem"
              className="topnav-overflow-item"
              onClick={closeMenu}
              data-testid="overflow-settings"
            >
              <span className="topnav-overflow-item__ico" aria-hidden="true">
                <IconGear size={16} />
              </span>
              <span className="topnav-overflow-item__body">
                <span className="topnav-overflow-item__label">
                  Einstellungen
                </span>
                <span className="topnav-overflow-item__meta">
                  Konto · Engines · Benachrichtigungen
                </span>
              </span>
            </Link>

            {process.env.NODE_ENV === 'development' && (
              <Link
                href="/design"
                role="menuitem"
                className="topnav-overflow-item"
                onClick={closeMenu}
                data-testid="overflow-design"
              >
                <span className="topnav-overflow-item__ico" aria-hidden="true">
                  <IconLayers size={16} />
                </span>
                <span className="topnav-overflow-item__body">
                  <span className="topnav-overflow-item__label">
                    Design-Library
                  </span>
                  <span className="topnav-overflow-item__meta">
                    Token & Komponenten
                  </span>
                </span>
              </Link>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default OverflowMenu;
