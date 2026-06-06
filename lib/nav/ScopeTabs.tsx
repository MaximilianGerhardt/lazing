'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect } from 'react';

import { closeMobileDrawer, useCurrentWorkspace, useMobileDrawer } from './hooks';
import { IconInbox, IconGear } from './icons';
import { MobileDrawer } from './MobileDrawer';
import { isConversation } from './topnav-visibility';
import { useI18n } from '@/lib/i18n/use-i18n';

/**
 * Bottom tab bar (ex-ScopeTabs) — the global, persistent iOS bottom tab bar
 * AND the single mount point of the sandwich MobileDrawer.
 * UI/UX realignment 2026-06-03 (Phase B); generalized 2026-06-05 (Phase 2
 * SP-4/5); mobile-IA realign 2026-06-06 (floating glass pill + /chats).
 *
 * Four top-level tabs — the classic messenger pattern (≤4 of 5 max, HIG
 * bottom-nav), ALL real <Link> destinations (no toggle in the bar):
 *   Chats (`/chats`) · Inbox (`/inbox`) · Decisions (`/decisions`) ·
 *   Settings (`/settings`).
 *
 * The Chat tab repoints to the new `/chats` OVERVIEW (a WhatsApp-style chat
 * list with Org/Workspace "Communities" grouping), NOT the active conversation
 * and NOT the `/workspaces` settings grid (Bug A fix). The active match also
 * lights the tab inside an open sub-chat conversation, the only conversation
 * route where the bar still renders.
 *
 * The duplicate "More" tab (which opened the SAME drawer the TopNav hamburger
 * owns — Bug C) is GONE. The hamburger is the single drawer trigger (secondary
 * nav, HIG drawer-usage). The drawer is still MOUNTED here (SP-5 invariant) so
 * it stays reachable on routes where TopNav is null.
 *
 * Single drawer mount (SP-5): the MobileDrawer is mounted HERE, not in
 * TopNav. TopNav returns null on /subchats/* — if the drawer lived only in
 * TopNav it would be unreachable on sub-chats (the old "back → list → back"
 * dead-end). Mounting it in the always-present bottom-bar component fixes
 * that. The TopNav hamburger DISPATCHES 'lazyos:drawer:open' and mirrors the
 * open/closed state via 'lazyos:drawer:close' (see hooks.ts), so there is
 * exactly one drawer on every route — no double overlay.
 *
 * Mounting: GLOBAL (app/layout.tsx, sibling after {children}). The component
 * self-decides what renders:
 *   - The DRAWER is mounted on every route EXCEPT the external standalone
 *     sub-chat (`/c/*`), which is an account-less, chrome-less surface.
 *     (On `/` the drawer is still mounted so the hamburger keeps working;
 *     only the BAR is hidden there.)
 *   - The BAR (`<nav>`) is hidden:
 *       · ≥768px via CSS (desktop owns TopNav + hamburger),
 *       · inside an OPEN conversation — the chat (`/`) AND an open sub-chat
 *         `/workspaces/<id>/subchats/<subchatId>` — there the composer owns the
 *         bottom (calm chat; `isConversation()`), so the bar is visible on the
 *         screen the user LANDS on (`/chats`) and only gone inside a live
 *         conversation (Bug B fix),
 *       · on `/c/*` — account-less fullscreen.
 *     It IS shown on `/chats`, the sub-chat LIST, and every other mobile route.
 *
 * Scope carry: the Chats link carries the active, membership-bearing workspace
 * id as `?ws=<id>`, so the customer scope is reasserted deterministically.
 * Virtual `__` ids are omitted (no pinning to pseudo ids).
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

  // The BAR is hidden INSIDE an open conversation (the chat `/` AND an open
  // sub-chat `/workspaces/*/subchats/<id>`) — there the composer owns the
  // bottom. It IS shown on `/chats`, the sub-chat list, and every other mobile
  // route (Bug B fix). The DRAWER stays mounted regardless so the hamburger
  // keeps working everywhere (SP-5).
  const showBar = !isConversation(pathname);

  // Carry the real, membership-bearing workspace id on the Chats link, so the
  // overview can deep-link a row back into the active scope on `/`.
  const carry =
    ws.id && !ws.id.startsWith('__')
      ? `?ws=${encodeURIComponent(ws.id)}`
      : '';
  const chatsHref = `/chats${carry}`;

  // Chats-tab active: the overview itself OR an open sub-chat conversation
  // (the only conversation route where the bar still renders). The bare `/`
  // chat is intentionally NOT in this list — the bar is not rendered there at
  // all (showBar=false), so a `/`-match would be moot (critic-precise predicate).
  const chatsActive =
    pathname === '/chats' ||
    pathname.startsWith('/chats/') ||
    /\/subchats(?:\/|$)/.test(pathname);

  const isActive = (href: string): boolean => {
    return pathname === href || pathname.startsWith(`${href}/`);
  };

  const tabs: Array<{
    label: string;
    href: string;
    active: boolean;
    Icon: () => React.JSX.Element;
  }> = [
    { label: t('nav.chats'), href: chatsHref, active: chatsActive, Icon: TabIconChat },
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
    {
      label: t('nav.settings'),
      href: '/settings',
      active: isActive('/settings'),
      Icon: TabIconSettings,
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

// settings — gear (reuses the shared IconGear glyph; the real 4th destination
// replacing the old duplicate "More" drawer trigger — IA realign 2026-06-06)
function TabIconSettings(): React.JSX.Element {
  return <IconGear size={24} />;
}
