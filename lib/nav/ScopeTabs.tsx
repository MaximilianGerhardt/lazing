'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect } from 'react';

import { useCurrentWorkspace } from './hooks';

/**
 * Bottom tab bar (ex-ScopeTabs) — fixed iOS bottom tab bar.
 * UI/UX realignment 2026-06-03, Phase B.
 *
 * Three top-level tabs: Chat · Decisions · Kalender. Replaces the old
 * in-page tab strip, which truncated the text on mobile ("Decisi…",
 * "Calen…") and carried a fourth "Lanes" tab (dead redirect).
 *
 * Classic chat-app pattern (owner directive „klassische App-Design-
 * orientierung", „pro View unterschiedlich bauen"):
 *  - On the list surfaces (/decisions, /calendar) the bar is visible.
 *  - On the chat (/) it is NOT mounted — there the composer owns
 *    the bottom (calm chat). Navigation back via the "Chat" bar tab.
 *  - Lanes/workstreams are no longer a top-level tab → they live in the menu.
 *
 * Scope carry: the chat link carries the active, membership-bearing workspace
 * id as `?ws=<id>`, so the customer scope on `/` is reasserted
 * deterministically. Virtual `__` ids are omitted (no pinning to
 * pseudo ids).
 *
 * Keyboard-aware: when the keyboard is open (visualViewport),
 * `body.kb-open` is set → the bar slides out of the way (it must never hover
 * over an input field, e.g. the decisions search).
 */
export function ScopeTabs(): React.JSX.Element {
  const pathname = usePathname() ?? '/';
  const ws = useCurrentWorkspace();

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
    { label: 'Chat', href: chatHref, active: isActive('/'), Icon: TabIconChat },
    {
      label: 'Decisions',
      href: '/decisions',
      active: isActive('/decisions'),
      Icon: TabIconDecisions,
    },
    {
      label: 'Kalender',
      href: '/calendar',
      active: isActive('/calendar'),
      Icon: TabIconCalendar,
    },
  ];

  return (
    <nav aria-label="Ansichten" className="lazyos-tabbar">
      {tabs.map((t) => (
        <Link
          key={t.label}
          href={t.href}
          aria-label={t.label}
          aria-current={t.active ? 'page' : undefined}
          className="lazyos-tabbar__item"
        >
          <t.Icon />
          <span className="lazyos-tabbar__label">{t.label}</span>
        </Link>
      ))}
    </nav>
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

// calendar — calendar grid
function TabIconCalendar(): React.JSX.Element {
  return (
    <svg {...ICON_PROPS}>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 9h18" />
      <path d="M8 3v4" />
      <path d="M16 3v4" />
    </svg>
  );
}
