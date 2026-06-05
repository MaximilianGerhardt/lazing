'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { TOP_LINKS } from './links';
import { useCurrentWorkspace, useMobileDrawer } from './hooks';
import { isTopNavHidden } from './topnav-visibility';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';
import { IconHamburger } from './icons';
import { TerminalModal } from '@/lib/terminal/TerminalModal';
import { OrgSwitcher } from './OrgSwitcher';
import { StatusCluster } from './StatusCluster';
import { OverflowMenu } from './OverflowMenu';
import { AccountAvatar } from './AccountAvatar';

/**
 * TopNav — primary navigation rendered above `.sheet`.
 *
 * Apple reduction (2026-05-30, render critic HIGH „12+ Targets, keine
 * Hierarchie"). The bar now carries at most 3-4 primary targets + ONE
 * health dot on EVERY viewport:
 *
 *   [Hamburger]  [Pill-Links]  [Org-Eyebrow · Workspace-Titel]  [Health · ••• · Profil]
 *
 * - Health = StatusCluster (ONE calm dot: green ok / amber attention /
 *   red problem). Aggregates Tpm + Observatory + Activity + Push +
 *   AutoMode + Compact into ONE tap popover — not 5 competing colors.
 * - "•••" = OverflowMenu (desktop): Terminal · GitHub · Observatory ·
 *   Einstellungen · Design-Library. On mobile the hamburger
 *   drawer takes over the same targets (already wired).
 * - Identity (org eyebrow 11pt mono + workspace title) stays the primary
 *   left display, ellipsizes cleanly.
 *
 * BRAND is rendered at runtime from `@/lib/brand` (BRAND_NAME, default 'laz.ing',
 * rollback via ENV LAZYOS_BRAND_NAME=lazyOS).
 *
 * Both workspace-dropdown and observatory-pulse live in the header on
 * ALL viewports — the user asked for them to be permanently visible.
 * The MobileDrawer still hosts a workspace row for scroll situations,
 * but it's no longer the primary switch.
 *
 * Padding: clamp(14px, 2.5vw, 22px) clamp(16px, 3vw, 40px) — honours
 * `env(safe-area-inset-top)` on notched iPhones.
 *
 * All non-token styling lives in `components.css` under the
 * `.topnav-*` namespace — no inline hex values.
 */
export function TopNav(): React.JSX.Element {
  const pathname = usePathname() ?? '/';
  // SP-5: mirror-only instance (the drawer is rendered by ScopeTabs). It tracks
  // open/closed via the shared events for aria-expanded, but must NOT manage
  // the body-scroll lock — that single owner is ScopeTabs (avoids a restore
  // race that could leave the body scroll-locked).
  const drawer = useMobileDrawer({ ownsLock: false });
  const navRef = useRef<HTMLElement>(null);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const currentWorkspace = useCurrentWorkspace();

  // Export the TopNav height as a CSS variable so that layout containers
  // (e.g. ChatShell with height: 100dvh - var(--topnav-h)) compute correctly.
  // Reacts to viewport resizes and mobile-vs-desktop padding changes.
  useEffect(() => {
    const update = (): void => {
      const el = navRef.current;
      if (!el) return;
      const h = el.getBoundingClientRect().height;
      document.documentElement.style.setProperty('--topnav-h', `${Math.round(h)}px`);
    };
    update();
    const ro =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(update)
        : null;
    if (ro && navRef.current) ro.observe(navRef.current);
    window.addEventListener('resize', update);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', update);
    };
  }, []);

  // D1 fix (2026-05-30) — mobile top-bar overflow: at ≤640px the
  // secondary control actions (Terminal/GitHub/Settings/Profil) move into the
  // hamburger drawer. So Terminal stays reachable from there
  // without prop-drilling the modal state down, the TopNav listens for
  // a lightweight custom event (same pattern as
  // `lazyos:activity:refresh`).
  useEffect(() => {
    const onOpenTerminal = (): void => setTerminalOpen(true);
    window.addEventListener('lazyos:terminal:open', onOpenTerminal);
    return () =>
      window.removeEventListener('lazyos:terminal:open', onOpenTerminal);
  }, []);

  const isActive = (href: string): boolean => {
    if (href === '/') return pathname === '/';
    return pathname === href || pathname.startsWith(`${href}/`);
  };

  // 2026-04-29 — user request: remove the top bar on library pages, otherwise
  // there's a confusion risk with the chat workspace.
  // 2026-05-23 — remove the top bar in the OSS onboarding wizard (Jobs/Rams: one
  // primary task per screen, no chrome outside the 5-step journey).
  // Path list + sub-chat rule live in `topnav-visibility.ts` (shared with
  // ScopeTabs, so the bottom bar knows when IT must own the drawer mount).
  const hideTopNav = isTopNavHidden(pathname);
  if (hideTopNav) {
    if (typeof document !== 'undefined') {
      document.documentElement.style.setProperty('--topnav-h', '0px');
    }
    return <></>;
  }

  return (
    <>
      <nav ref={navRef} className="topnav" aria-label="Primär-Navigation">
        <div className="topnav-inner">
          {/* ---------- MOBILE: hamburger trigger ----------
              SP-5 (2026-06-05): the drawer is now mounted ONCE in the global
              bottom bar (ScopeTabs), so the hamburger only DISPATCHES the
              open/close events. `drawer.open` here mirrors the one true drawer
              state via the 'lazyos:drawer:open'/'…:close' listeners in
              useMobileDrawer — so aria-expanded stays accurate. */}
          <button
            type="button"
            className="topnav-hamburger"
            onClick={() => {
              if (typeof window === 'undefined') return;
              window.dispatchEvent(
                new Event(
                  drawer.open ? 'lazyos:drawer:close' : 'lazyos:drawer:open',
                ),
              );
            }}
            aria-label="Menü öffnen"
            aria-expanded={drawer.open}
            aria-controls="topnav-drawer"
          >
            <IconHamburger />
          </button>

          {/* Brand block removed 2026-04-29 — user request: "kann komplett
              raus, führt auf Ursprungslayout-Seite die niemand braucht".
              The hamburger icon is now the only top-left anchor. */}

          {/* ---------- TOP-PILLS (Chat + Inbox) — Phase Nav-C ----------
              Sub-plan A 2026-04-30: pills stay visible on mobile as
              icon-only (44x44 touch target). Desktop shows icon + label.
              `.topnav-link-label` is hidden below 768px via a media query. */}
          <ul className="topnav-links" role="list">
            {TOP_LINKS.map((l) => {
              const active = isActive(l.href);
              return (
                <li key={l.href}>
                  <Link
                    href={l.href}
                    aria-current={active ? 'page' : undefined}
                    aria-label={l.label}
                    className={`topnav-link${active ? ' is-active' : ''}`}
                  >
                    <span className="topnav-link-ico" aria-hidden="true">
                      {l.icon}
                    </span>
                    <span className="topnav-link-label">{l.label}</span>
                  </Link>
                </li>
              );
            })}
          </ul>

          {/* ---------- RIGHT CLUSTER (Apple reduction 2026-05-30) ----------
              Render critic HIGH: previously ~12+ targets (5 colored status dots +
              org + WS + pencil + Terminal + GitHub + Settings + AutoMode +
              Compact + profile) without hierarchy. Now ONE clear order,
              identical on desktop + mobile:

                Identity  → org eyebrow + workspace title (primary anchor)
                Health    → StatusCluster (ONE calm dot, detail in the tap sheet)
                Overflow  → ••• (desktop) / hamburger drawer (mobile)
                Profile   → AccountAvatar

              Lost functions: NONE.
                · Tpm/Observatory/Activity/Push/AutoMode/Compact → StatusCluster sheet
                · Terminal/GitHub/Observatory/Settings/Design → OverflowMenu (desktop)
                  + hamburger drawer (mobile, already wired).

              The terminal modal state stays up here (opens via the custom event
              `lazyos:terminal:open`, dispatched by both OverflowMenu and the
              drawer — no prop drilling). */}
          <div className="topnav-right">
            {/* Identity — primary left anchor of the cluster. */}
            <OrgSwitcher />
            <WorkspaceSwitcher />

            {/* ONE health dot (green/amber/red) instead of 5 colored dots. */}
            <StatusCluster
              vapidPublicKey={process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? ''}
            />

            {/* ••• overflow (desktop) — secondary actions, on mobile in the drawer. */}
            <OverflowMenu />

            {/* Profile stays visible — identity/account anchor on the right. */}
            <AccountAvatar />
          </div>
        </div>
      </nav>

      {/* MobileDrawer mount moved to ScopeTabs (SP-5) — one drawer globally,
          reachable on /subchats/* where TopNav returns null. */}

      {terminalOpen ? (
        <TerminalModal
          workspaceId={currentWorkspace.id}
          workspaceLabel={currentWorkspace.label}
          onClose={() => setTerminalOpen(false)}
        />
      ) : null}
    </>
  );
}

export default TopNav;
