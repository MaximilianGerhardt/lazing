'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect } from 'react';

import { closeMobileDrawer, useCurrentWorkspace, useMobileDrawer } from './hooks';
import { IconInbox, IconMore } from './icons';
import { MobileDrawer } from './MobileDrawer';
import { useI18n } from '@/lib/i18n/use-i18n';

/**
 * Bottom tab bar (ex-ScopeTabs) — the global, persistent iOS bottom tab bar
 * AND the single mount point of the sandwich MobileDrawer.
 * UI/UX realignment 2026-06-03 (Phase B); generalized 2026-06-05 (Phase 2 SP-4/5).
 *
 * Four top-level tabs — the classic iOS pattern (≤4 of 5 max, HIG bottom-nav):
 *   Chat (`/`) · Inbox (`/inbox`) · Decisions (`/decisions`) · More.
 *
 * "More" is a <button> (NOT a Link) that opens the MobileDrawer — the same
 * sandwich menu the TopNav hamburger opens — by dispatching
 * 'lazyos:drawer:open'. Its active affordance is `aria-expanded` (the drawer
 * is a toggle, not a destination), never `aria-current` (a location marker).
 *
 * Single drawer mount (SP-5): the MobileDrawer is mounted HERE, not in
 * TopNav. TopNav returns null on /subchats/* — if the drawer lived only in
 * TopNav it would be unreachable on sub-chats (the old "back → list → back"
 * dead-end). Mounting it in the always-present bottom-bar component fixes
 * that. The TopNav hamburger now merely DISPATCHES 'lazyos:drawer:open' and
 * mirrors the open/closed state via 'lazyos:drawer:close' (see hooks.ts), so
 * there is exactly one drawer on every route — no double overlay.
 *
 * Mounting: GLOBAL (app/layout.tsx, sibling after {children}). The component
 * self-decides what renders:
 *   - The DRAWER is mounted on every route EXCEPT the external standalone
 *     sub-chat (`/c/*`), which is an account-less, chrome-less surface.
 *     (On `/` the drawer is still mounted so the hamburger keeps working;
 *     only the BAR is hidden there.)
 *   - The BAR (`<nav>`) is hidden:
 *       · ≥768px via CSS (desktop owns TopNav + hamburger),
 *       · on the chat (`/`) — the composer owns the bottom (calm chat),
 *       · on `/c/*` — account-less fullscreen.
 *     It IS shown on /subchats/* and every other mobile route.
 *
 * Scope carry: the Chat link carries the active, membership-bearing workspace
 * id as `?ws=<id>`, so the customer scope on `/` is reasserted
 * deterministically. Virtual `__` ids are omitted (no pinning to pseudo ids).
 *
 * Keyboard-aware: when the keyboard is open (visualViewport), `body.kb-open`
 * is set → the bar slides out of the way (it must never hover over an input
 * field, e.g. the decisions search or the sub-chat composer).
 */
export function ScopeTabs(): React.JSX.Element | null {
  const pathname = usePathname() ?? '/';
  const ws = useCurrentWorkspace();
  const drawer = useMobileDrawer();
  const { t } = useI18n();

  useEffect(() => {
    const vv =
      typeof window !== 'undefined' ? window.visualViewport : null;
    if (!vv) return;
    const onResize = () => {
      // Ratio against the PHYSICAL screen height — robust on Android, where
      // window.innerHeight shrinks along with the keyboard (a delta heuristic
      // would never fire there). window.screen.height stays constant.
      const kbOpen = vv.height < window.screen.height * 0.75;
      document.body.classList.toggle('kb-open', kbOpen);
    };
    vv.addEventListener('resize', onResize);
    onResize();
    return () => {
      vv.removeEventListener('resize', onResize);
      document.body.classList.remove('kb-open');
    };
  }, []);

  // External standalone sub-chats (`/c/*`) get NO app chrome at all — no bar,
  // no drawer (account-less customers). Bail out entirely.
  const isExternalSubchat = pathname === '/c' || pathname.startsWith('/c/');
  if (isExternalSubchat) return null;

  // The BAR is hidden on the chat (`/`) — there the composer owns the bottom.
  // The DRAWER stays mounted so the TopNav hamburger keeps working on `/`.
  const showBar = pathname !== '/';

  // Carry the real, membership-bearing workspace id on the Chat link only.
  const carry =
    ws.id && !ws.id.startsWith('__')
      ? `?ws=${encodeURIComponent(ws.id)}`
      : '';
  const chatHref = `/${carry}`;

  const isActive = (href: string): boolean => {
    if (href === '/') return pathname === '/';
    return pathname === href || pathname.startsWith(`${href}/`);
  };

  const tabs: Array<{
    label: string;
    href: string;
    active: boolean;
    Icon: () => React.JSX.Element;
  }> = [
    { label: t('nav.chat'), href: chatHref, active: isActive('/'), Icon: TabIconChat },
    {
      label: t('nav.inbox'),
      href: '/inbox',
      active: isActive('/inbox'),
      Icon: TabIconInbox,
    },
    {
      label: t('nav.decisions'),
      href: '/decisions',
      active: isActive('/decisions'),
      Icon: TabIconDecisions,
    },
  ];

  return (
    <>
      {showBar ? (
        <nav aria-label="Ansichten" className="lazyos-tabbar">
          {tabs.map((tab) => (
            <Link
              key={tab.href}
              href={tab.href}
              aria-label={tab.label}
              aria-current={tab.active ? 'page' : undefined}
              className="lazyos-tabbar__item"
            >
              <tab.Icon />
              <span className="lazyos-tabbar__label">{tab.label}</span>
            </Link>
          ))}

          {/* "More" — opens the sandwich drawer (not a destination). Active
              state via aria-expanded (toggle affordance), not aria-current. */}
          <button
            type="button"
            aria-label={t('nav.more')}
            aria-expanded={drawer.open}
            aria-controls="topnav-drawer"
            aria-haspopup="dialog"
            className="lazyos-tabbar__item"
            onClick={() => {
              if (typeof window !== 'undefined') {
                window.dispatchEvent(new Event('lazyos:drawer:open'));
              }
            }}
          >
            <TabIconMore />
            <span className="lazyos-tabbar__label">{t('nav.more')}</span>
          </button>
        </nav>
      ) : null}

      {/* The ONE drawer mount (SP-5). Closing broadcasts 'lazyos:drawer:close'
          so the TopNav hamburger's aria-expanded resets in lock-step. */}
      <MobileDrawer
        open={drawer.open}
        onClose={() => {
          drawer.setOpen(false);
          closeMobileDrawer();
        }}
      />
    </>
  );
}

/* --------------------------------------------------------------------------
 * Bespoke inline SVG glyphs — self-contained. 24×24 viewBox, currentColor,
 * 1.6 stroke, round caps. Color inherits from the tab (active = var(--a-now),
 * inactive = var(--ink-3)) via the .lazyos-tabbar CSS.
 * -------------------------------------------------------------------------- */

const ICON_PROPS = {
  width: 24,
  height: 24,
  xmlns: 'http://www.w3.org/2000/svg' as const,
  fill: 'none' as const,
  viewBox: '0 0 24 24' as const,
  stroke: 'currentColor' as const,
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true as const,
  focusable: false as const,
};

// chat — bubble
function TabIconChat(): React.JSX.Element {
  return (
    <svg {...ICON_PROPS}>
      <path d="M21 11.5a8.4 8.4 0 0 1-3.9 7.1L17 21l-3.5-2.2a8.5 8.5 0 1 1 7.5-7.3z" />
    </svg>
  );
}

// inbox — tray (reuses the shared IconInbox glyph for cross-bar consistency)
function TabIconInbox(): React.JSX.Element {
  return <IconInbox size={24} />;
}

// decisions — checkmark-in-list
function TabIconDecisions(): React.JSX.Element {
  return (
    <svg {...ICON_PROPS}>
      <path d="M4 7h6" />
      <path d="M4 12h5" />
      <path d="M4 17h6" />
      <path d="M13 13.5l2.5 2.5L21 10.5" />
    </svg>
  );
}

// more — overflow menu (reuses the shared IconMore glyph)
function TabIconMore(): React.JSX.Element {
  return <IconMore size={24} />;
}
