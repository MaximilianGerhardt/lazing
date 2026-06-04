'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { TOP_LINKS } from './links';
import { useCurrentWorkspace, useMobileDrawer } from './hooks';
import { MobileDrawer } from './MobileDrawer';
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
 * Apple-Reduktion (2026-05-30, Render-Critic HOCH „12+ Targets, keine
 * Hierarchie"). Die Bar trägt jetzt auf JEDEM Viewport max. 3-4 primäre
 * Targets + EINEN Health-Punkt:
 *
 *   [Hamburger]  [Pill-Links]  [Org-Eyebrow · Workspace-Titel]  [Health · ••• · Profil]
 *
 * - Health = StatusCluster (EIN ruhiger Punkt: grün ok / amber Aufmerksam-
 *   keit / rot Problem). Aggregiert Tpm + Observatory + Activity + Push +
 *   AutoMode + Compact in EIN Tap-Popover — keine 5 konkurrierenden Farben.
 * - „•••" = OverflowMenu (Desktop): Terminal · GitHub · Observatory ·
 *   Einstellungen · Design-Library. Auf Mobile übernimmt der Hamburger-
 *   Drawer dieselben Ziele (bereits verdrahtet).
 * - Identität (Org-Eyebrow 11pt mono + Workspace-Titel) bleibt die primäre
 *   linke Anzeige, ellipst sauber.
 *
 * BRAND wird zur Laufzeit aus `@/lib/brand` (BRAND_NAME, default 'laz.ing',
 * Rollback per ENV LAZYOS_BRAND_NAME=lazyOS) gerendert.
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
  const drawer = useMobileDrawer();
  const navRef = useRef<HTMLElement>(null);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const currentWorkspace = useCurrentWorkspace();

  // Höhe der TopNav als CSS-Variable exportieren, damit Layout-Container
  // (z.B. ChatShell mit height: 100dvh - var(--topnav-h)) korrekt rechnen.
  // Reagiert auf Viewport-Resize und mobile-vs-desktop Padding-Wechsel.
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

  // D1-Fix (2026-05-30) — Mobile-Top-Bar-Overflow: auf ≤640px ziehen die
  // sekundären Steuer-Aktionen (Terminal/GitHub/Settings/Profil) in den
  // Hamburger-Drawer. Damit Terminal von dort trotzdem erreichbar bleibt,
  // ohne den Modal-State nach unten zu prop-drillen, hört die TopNav auf
  // ein leichtgewichtiges Custom-Event (gleiches Muster wie
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

  // 2026-04-29 — User-Wunsch: TopBar weg auf Library-Pages, sonst Verwechs-
  // lungs-Risiko mit Chat-Workspace.
  // 2026-05-23 — TopBar weg im OSS-Onboarding-Wizard (Jobs/Rams: one
  // primary task per screen, kein Chrome ausserhalb der 5-Step-Reise).
  const HIDE_TOPNAV_PATHS = [
    '/design',
    '/how',
    '/innovate',
    '/oss-onboarding',
    '/onboarding',
    '/login',
    // Externe Sub-Chat-Seite (Gathering-Intelligence, 2026-06-02): Kunden
    // ohne Account dürfen KEIN App-Chrome (Org-/Workspace-Switcher) sehen —
    // standalone Vollbild-Chat.
    '/c',
  ];
  const hideTopNav =
    HIDE_TOPNAV_PATHS.some((p) => pathname === p || pathname.startsWith(p + '/')) ||
    // Sub-Chat-Views (intern wie extern) sind Vollbild-standalone mit eigenem
    // Header (Gathering-Intelligence, 2026-06-02). TopNav hier ausblenden — sonst
    // mountet der OrgSwitcher, dessen Org-Normalisierung auf /workspaces/[id]/*
    // einen Hard-Redirect zum Chat auslöst und die Seite verlässt.
    /\/subchats(?:\/|$)/.test(pathname);
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
          {/* ---------- MOBILE: hamburger trigger ---------- */}
          <button
            type="button"
            className="topnav-hamburger"
            onClick={drawer.toggle}
            aria-label="Menü öffnen"
            aria-expanded={drawer.open}
            aria-controls="topnav-drawer"
          >
            <IconHamburger />
          </button>

          {/* Brand-Block 2026-04-29 entfernt — User-Wunsch: "kann komplett
              raus, führt auf Ursprungslayout-Seite die niemand braucht".
              Hamburger-Icon ist jetzt der einzige Top-Left-Anker. */}

          {/* ---------- TOP-PILLS (Chat + Inbox) — Phase Nav-C ----------
              Sub-Plan A 2026-04-30: Pills bleiben auf Mobile sichtbar als
              Icon-only (44x44 Touch-Target). Desktop zeigt Icon + Label.
              `.topnav-link-label` wird per Media-Query unter 768px ausgeblendet. */}
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

          {/* ---------- RIGHT CLUSTER (Apple-Reduktion 2026-05-30) ----------
              Render-Critic HOCH: vorher ~12+ Targets (5 farbige Status-Dots +
              Org + WS + Pencil + Terminal + GitHub + Settings + AutoMode +
              Compact + Profil) ohne Hierarchie. Jetzt EINE klare Ordnung,
              identisch auf Desktop + Mobile:

                Identität → Org-Eyebrow + Workspace-Titel (primärer Anker)
                Health    → StatusCluster (EIN ruhiger Punkt, Detail im Tap-Sheet)
                Overflow  → ••• (Desktop) / Hamburger-Drawer (Mobile)
                Profil    → AccountAvatar

              Verlorene Funktionen: KEINE.
                · Tpm/Observatory/Activity/Push/AutoMode/Compact → StatusCluster-Sheet
                · Terminal/GitHub/Observatory/Settings/Design → OverflowMenu (Desktop)
                  + Hamburger-Drawer (Mobile, bereits verdrahtet).

              Der Terminal-Modal-State bleibt hier oben (öffnet via Custom-Event
              `lazyos:terminal:open`, das sowohl OverflowMenu als auch der
              Drawer dispatchen — kein Prop-Drilling). */}
          <div className="topnav-right">
            {/* Identität — primärer linker Anker des Clusters. */}
            <OrgSwitcher />
            <WorkspaceSwitcher />

            {/* EIN Health-Punkt (grün/amber/rot) statt 5 farbiger Dots. */}
            <StatusCluster
              vapidPublicKey={process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? ''}
            />

            {/* •••-Overflow (Desktop) — sekundäre Aktionen, mobil im Drawer. */}
            <OverflowMenu />

            {/* Profil bleibt sichtbar — Identitäts-/Account-Anker rechts. */}
            <AccountAvatar />
          </div>
        </div>
      </nav>

      <MobileDrawer open={drawer.open} onClose={() => drawer.setOpen(false)} />

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
