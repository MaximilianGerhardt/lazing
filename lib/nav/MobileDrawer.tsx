'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type TouchEvent as ReactTouchEvent,
} from 'react';

import { Pill } from '@/lib/ui/pil';
import { ActivityNowSection } from './ActivityNowSection';
import { PushSettingsSection } from './PushSettingsSection';
import { AutoModeToggle } from './AutoModeToggle';
import { CompactButton } from './CompactButton';
import { NAV_SECTIONS } from './links';
import {
  setWorkspaceId,
  useCurrentWorkspace,
  useSetWorkspace,
  useUserOrgs,
  useWorkspaces,
} from './hooks';
import {
  IconChevronRight,
  IconClose,
  LazyMark,
  IconGear,
  IconTerminal,
  IconLayers,
} from './icons';
import { LocaleSwitcher } from './LocaleSwitcher';
import type { Organization, Workspace } from './types';
import { useI18n } from '@/lib/i18n/use-i18n';
import { BRAND_NAME } from '@/lib/brand';

/**
 * Hrefs that are surfaced permanently in the header (Observatory lives
 * in the right cluster as a live pulse). Hidden from the primary drawer
 * list and demoted to the footer-tools row to reduce redundancy.
 */
export interface MobileDrawerProps {
  open: boolean;
  onClose: () => void;
}

/**
 * D2 (P4-DRAWER) — an entry of the "Kunden" inbox. An org with type ===
 * 'client' reads as a client; other org types stay grouped orgs (no
 * client relabel). `rows` are the visible workspaces, `unread` is the
 * sum of the per-workspace unread counters across `rows`.
 */
type KundeNode = {
  orgId: string;
  name: string;
  paletteIndex: number | undefined;
  isClient: boolean;
  rows: Workspace[];
  unread: number;
};

const SWIPE_CLOSE_THRESHOLD = 60; // px

/**
 * Fullscreen slide-in drawer for < 768px.
 *
 * A11y:
 *   - role="dialog", aria-modal="true"
 *   - Focus trapped between first + last focusable nodes while open
 *   - ESC closes (bound globally in `useMobileDrawer`)
 *   - Backdrop-click closes
 *   - Left-swipe on the sheet closes (touch-events)
 */
export function MobileDrawer({
  open,
  onClose,
}: MobileDrawerProps): React.JSX.Element | null {
  const pathname = usePathname() ?? '/';
  const current = useCurrentWorkspace();
  const setWorkspace = useSetWorkspace();
  const { workspaces } = useWorkspaces();

  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const touchStartX = useRef<number | null>(null);
  const touchStartY = useRef<number | null>(null);

  const { orgs } = useUserOrgs();
  const { t } = useI18n();
  // Per-org collapsed state (default: expanded)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  // D1 (P4-DRAWER) — unread aggregate per workspace from the shared activity
  // route. Self-contained in this file (the DRAWER reads the route, does not own
  // it). Only fetch when the drawer is open; an error is non-fatal (no
  // badges, the inbox renders anyway). Same pattern as SubchatPulse.tsx.
  const [unreadByWs, setUnreadByWs] = useState<Record<string, number>>({});
  useEffect(() => {
    if (!open) return;
    let alive = true;
    void (async () => {
      try {
        const res = await fetch('/api/subchats/activity', {
          cache: 'no-store',
          credentials: 'same-origin',
        });
        if (!res.ok) return;
        const body = (await res.json()) as {
          activity?: Array<{ workspaceId: string; unreadCount?: number }>;
        };
        if (!alive || !Array.isArray(body.activity)) return;
        const m: Record<string, number> = {};
        for (const a of body.activity) {
          if (!a.workspaceId) continue;
          m[a.workspaceId] = (m[a.workspaceId] ?? 0) + (a.unreadCount ?? 0);
        }
        setUnreadByWs(m);
      } catch {
        /* non-fatal — drawer renders without badges */
      }
    })();
    return () => {
      alive = false;
    };
  }, [open]);

  // Focus the close button on open.
  useEffect(() => {
    if (!open) return;
    closeButtonRef.current?.focus();
  }, [open]);

  // E.2 (2026-04-30) — a small close hint after the drawer opens, fades out after 3s.
  // An iOS-typical onboarding cue. P2 (2026-06-02): subordinated — shorter text
  // ("Nach links wischen") + once per device via a localStorage flag. Seen after the
  // first open cycle, then never again (no recurring hint noise).
  const HINT_SEEN_KEY = 'lazyos:drawer:swipe-hint-seen';
  const [showCloseHint, setShowCloseHint] = useState(false);
  useEffect(() => {
    if (!open) {
      setShowCloseHint(false);
      return;
    }
    let seen = false;
    try {
      seen = window.localStorage.getItem(HINT_SEEN_KEY) === '1';
    } catch {
      /* localStorage unavailable (privacy mode) — just show the hint */
    }
    if (seen) {
      setShowCloseHint(false);
      return;
    }
    setShowCloseHint(true);
    try {
      window.localStorage.setItem(HINT_SEEN_KEY, '1');
    } catch {
      /* non-fatal — the hint shows this session, possibly again next time */
    }
    const t = window.setTimeout(() => setShowCloseHint(false), 3000);
    return () => window.clearTimeout(t);
  }, [open]);

  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>): void => {
      if (e.key !== 'Tab') return;
      const root = dialogRef.current;
      if (!root) return;
      const focusables = root.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
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
    },
    [],
  );

  const handleBackdropClick = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>): void => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose],
  );

  // Swipe-to-close (leftward drag on sheet).
  const onTouchStart = useCallback((e: ReactTouchEvent<HTMLDivElement>): void => {
    touchStartX.current = e.touches[0]?.clientX ?? null;
    touchStartY.current = e.touches[0]?.clientY ?? null;
  }, []);

  const onTouchEnd = useCallback(
    (e: ReactTouchEvent<HTMLDivElement>): void => {
      if (touchStartX.current === null || touchStartY.current === null) return;
      const endX = e.changedTouches[0]?.clientX;
      const endY = e.changedTouches[0]?.clientY;
      if (endX === undefined || endY === undefined) return;
      const dx = endX - touchStartX.current;
      const dy = endY - touchStartY.current;
      // Only treat as swipe if mostly horizontal + leftward.
      if (dx < -SWIPE_CLOSE_THRESHOLD && Math.abs(dy) < Math.abs(dx)) {
        onClose();
      }
      touchStartX.current = null;
      touchStartY.current = null;
    },
    [onClose],
  );

  const isActive = useCallback(
    (href: string): boolean => {
      if (href === '/') return pathname === '/';
      return pathname === href || pathname.startsWith(`${href}/`);
    },
    [pathname],
  );

  // D2 (P4-DRAWER) — "Kunden" inbox model. The visible workspaces (same
  // filter as before, preserved verbatim) are grouped by org into KundeNodes.
  // A "client" is an org with type === 'client'; non-client orgs
  // (company/own/private/…) keep today's grouping behavior and
  // are NOT renamed to client. Each node carries the org palette + the
  // aggregated unread, so the render logic only needs to apply the collapse rule
  // (1 workspace ⇒ 1 row).
  const kunden = useMemo<KundeNode[]>(() => {
    const visible = workspaces.filter((w) => {
      if (w.archived) return false;
      // Virtual root workspaces (Migration 0034) not in the drawer list —
      // same filter logic as WorkspaceSwitcher.tsx L.72-73.
      if (w.id === '__root__') return false;
      if (w.id.startsWith('__org_root__:')) return false;
      // High-sensitive only visible when it is the current workspace.
      if (w.sensitivity === 'high' && w.id !== current.id) return false;
      return true;
    });
    const orgIndex = new Map<string, Organization>();
    for (const o of orgs) orgIndex.set(o.id, o);
    const groups = new Map<string, Workspace[]>();
    const orphan: Workspace[] = [];
    for (const w of visible) {
      if (w.organizationId && orgIndex.has(w.organizationId)) {
        const list = groups.get(w.organizationId) ?? [];
        list.push(w);
        groups.set(w.organizationId, list);
      } else {
        orphan.push(w);
      }
    }
    const sumUnread = (rows: Workspace[]): number =>
      rows.reduce((s, w) => s + (unreadByWs[w.id] ?? 0), 0);
    const nodes: KundeNode[] = [];
    for (const [oid, rows] of groups) {
      const org = orgIndex.get(oid);
      nodes.push({
        orgId: oid,
        name: org?.name ?? oid,
        paletteIndex: org?.paletteIndex,
        isClient: org?.type === 'client',
        rows,
        unread: sumUnread(rows),
      });
    }
    // Sorting: clients (client) first (name, locale 'de'), then non-client
    // orgs (name), then the orphan bucket as a trailing group.
    nodes.sort((a, b) => {
      if (a.isClient !== b.isClient) return a.isClient ? -1 : 1;
      return a.name.localeCompare(b.name, 'de');
    });
    if (orphan.length > 0) {
      nodes.push({
        orgId: '__orphan__',
        name: 'Ohne Org',
        paletteIndex: undefined,
        isClient: false,
        rows: orphan,
        unread: sumUnread(orphan),
      });
    }
    return nodes;
  }, [workspaces, orgs, current.id, unreadByWs]);

  const handleSelect = useCallback(
    (id: string): void => {
      setWorkspace(id);
      onClose();
    },
    [setWorkspace, onClose],
  );

  // D3 (P4-DRAWER) — single-workspace client: the row IS the client and opens
  // directly into the main chat of this workspace. `setWorkspaceId(realId, orgId)`
  // (imperative, from ./hooks) aligns the org context BEFORE the list
  // re-resolves — matches the brief signature. Goes into the WORKSPACE, not org-root.
  const handleSelectKunde = useCallback(
    (workspaceId: string, organizationId: string): void => {
      setWorkspaceId(
        workspaceId,
        organizationId === '__orphan__' ? undefined : organizationId,
      );
      onClose();
    },
    [onClose],
  );

  if (!open) return null;

  return (
    <div
      className="topnav-drawer-backdrop"
      onClick={handleBackdropClick}
      onKeyDown={handleKeyDown}
      role="presentation"
    >
      <aside
        ref={dialogRef}
        id="topnav-drawer"
        className="topnav-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Hauptmenü"
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
      >
        <header className="topnav-drawer-head">
          <span className="topnav-brand" aria-label={BRAND_NAME}>
            <span className="topnav-brand-mark" aria-hidden="true">
              <LazyMark />
            </span>
            <span className="topnav-brand-text">{BRAND_NAME}</span>
          </span>
          <button
            ref={closeButtonRef}
            type="button"
            className="topnav-drawer-close"
            onClick={onClose}
            aria-label="Menü schließen"
          >
            <IconClose />
          </button>
        </header>
        {showCloseHint ? (
          <div
            className="topnav-drawer-close-hint topnav-drawer-close-hint--quiet"
            role="status"
            aria-live="polite"
          >
            Nach links wischen
          </div>
        ) : null}

        {/* Phase Nav-C 2026-04-28: sections instead of a flat list. Three
            areas: Work / Organization / System. Observatory stays
            visible in System, because the header pulse pill is only status, not
            a direct jump. */}
        {NAV_SECTIONS.map((section) => {
          const sectionLabel = section.i18nKey
            ? t(section.i18nKey)
            : section.label;
          return (
          <nav
            key={section.id}
            aria-label={sectionLabel}
            className="topnav-drawer-section"
          >
            <h2 className="topnav-drawer-heading">{sectionLabel}</h2>
            <ul className="topnav-drawer-list" role="list">
              {section.links.map((l) => {
                const active = isActive(l.href);
                const linkLabel = l.i18nKey ? t(l.i18nKey) : l.label;
                return (
                  <li key={l.href}>
                    <Link
                      href={l.href}
                      aria-current={active ? 'page' : undefined}
                      className={`topnav-drawer-link${active ? ' is-active' : ''}`}
                      onClick={onClose}
                    >
                      <span className="topnav-drawer-ico" aria-hidden="true">
                        {l.icon}
                      </span>
                      <span className="topnav-drawer-link-label">
                        {linkLabel}
                      </span>
                      <IconChevronRight
                        className="topnav-drawer-chev"
                        size={14}
                      />
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>
          );
        })}

        <div className="topnav-drawer-sep" role="presentation" />

        {/* Sub-plan 4: "Aktiv jetzt" — running workstreams/workflows/
            routines/sub-workstreams. Loads on its own, refreshes on the
            'lazyos:activity:refresh' custom event. */}
        <ActivityNowSection onNavigate={onClose} />

        <div className="topnav-drawer-sep" role="presentation" />

        {/* "Kunden" inbox (D-slice, P4). A reframing of the former workspace
            section: each client org reads as one entry; single-workspace
            clients collapse to one row, multi-workspace clients keep
            the collapsible header. Palette dot per client, unread badge from
            /api/subchats/activity. Additive — all other drawer sections
            untouched. */}
        <section
          className="topnav-drawer-section"
          aria-label="Kunden"
        >
          <div className="topnav-drawer-ws-head">
            <h2 className="topnav-drawer-heading">Kunden</h2>
            <span className="topnav-drawer-ws-current">
              <Pill variant={current.accent}>{current.label}</Pill>
            </span>
          </div>

          <ul className="topnav-drawer-list topnav-drawer-ws-list" role="list">
            {kunden.map((node) => {
              const dotStyle =
                node.paletteIndex !== undefined
                  ? {
                      background: `var(--palette-${node.paletteIndex}, var(--a-now))`,
                    }
                  : undefined;

              // D3 — single-workspace client: ONE row, no collapsible header.
              // The row IS the client (collapse customer↔workspace) and opens
              // directly into the main chat of this workspace.
              if (node.rows.length === 1) {
                const w = node.rows[0];
                const selected = w.id === current.id;
                return (
                  <li
                    key={node.orgId}
                    className="topnav-drawer-org-group"
                    role="group"
                    aria-label={node.name}
                  >
                    <button
                      type="button"
                      className={`topnav-drawer-ws-row${
                        selected ? ' is-active' : ''
                      }`}
                      onClick={() => handleSelectKunde(w.id, node.orgId)}
                      aria-pressed={selected}
                    >
                      <span
                        className="topnav-ws-dot"
                        aria-hidden="true"
                        style={dotStyle}
                      />
                      <span className="topnav-drawer-ws-body">
                        <span className="topnav-drawer-ws-label">
                          {node.name}
                        </span>
                      </span>
                      {node.unread > 0 ? (
                        <UnreadBadge count={node.unread} />
                      ) : null}
                      {selected ? <DrawerCheck /> : null}
                    </button>
                  </li>
                );
              }

              // D3 — multi-workspace client: collapsible header (existing
              // pattern) + palette dot + aggregated unread; children via
              // WorkspaceRow with a per-workspace unread badge.
              const isCollapsed = collapsed[node.orgId] === true;
              return (
                <li
                  key={node.orgId}
                  className="topnav-drawer-org-group"
                  role="group"
                  aria-label={node.name || 'Workspaces'}
                >
                  <button
                    type="button"
                    className={`topnav-drawer-org-head${
                      isCollapsed ? ' is-collapsed' : ''
                    }`}
                    onClick={() =>
                      setCollapsed((prev) => ({
                        ...prev,
                        [node.orgId]: !isCollapsed,
                      }))
                    }
                    aria-expanded={!isCollapsed}
                    aria-controls={`drawer-org-list-${node.orgId}`}
                  >
                    <span
                      className="topnav-ws-dot"
                      aria-hidden="true"
                      style={dotStyle}
                    />
                    <span className="topnav-drawer-org-name">{node.name}</span>
                    {node.unread > 0 ? (
                      <UnreadBadge count={node.unread} />
                    ) : null}
                    <span
                      className="topnav-drawer-org-count"
                      aria-hidden="true"
                    >
                      {node.rows.length}
                    </span>
                    <IconChevronRight
                      className="topnav-drawer-org-chev"
                      size={14}
                    />
                  </button>
                  {!isCollapsed ? (
                    <ul
                      id={`drawer-org-list-${node.orgId}`}
                      className="topnav-drawer-org-children"
                      role="list"
                    >
                      {node.rows.map((w) => (
                        <li key={w.id}>
                          <WorkspaceRow
                            workspace={w}
                            selected={w.id === current.id}
                            onSelect={handleSelect}
                            unread={unreadByWs[w.id] ?? 0}
                          />
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              );
            })}
            {kunden.length === 0 ? (
              <li className="topnav-drawer-empty" role="note">
                Keine Kunden.
              </li>
            ) : null}
          </ul>
        </section>

        <div className="topnav-drawer-sep" role="presentation" />

        {/* Secondary tools — demoted from primary nav. Observatory lives
            here because the header already surfaces its live state. */}
        <section
          className="topnav-drawer-section topnav-drawer-tools"
          aria-label="System & Tools"
        >
          <h2 className="topnav-drawer-heading">System</h2>
          <ul className="topnav-drawer-tools-list" role="list">
            {/* D1 fix (2026-05-30) — the secondary top-bar control actions
                (Terminal · Settings) live at ≤640px here in the drawer,
                because they were taken out of the bar (mobile overflow). Touch
                target ≥48px via `.topnav-drawer-tools-link`. */}
            <li>
              <Link
                href="/settings"
                className={`topnav-drawer-tools-link${
                  isActive('/settings') ? ' is-active' : ''
                }`}
                onClick={onClose}
                data-testid="drawer-tools-settings"
              >
                <span className="topnav-drawer-tools-ico" aria-hidden="true">
                  <IconGear size={18} />
                </span>
                <span className="topnav-drawer-tools-label">
                  Einstellungen
                </span>
                <span className="topnav-drawer-tools-meta">
                  Konto · Engines · Benachrichtigungen
                </span>
              </Link>
            </li>
            <li>
              <button
                type="button"
                className="topnav-drawer-tools-link"
                data-testid="drawer-tools-terminal"
                onClick={() => {
                  onClose();
                  if (typeof window !== 'undefined') {
                    window.dispatchEvent(new Event('lazyos:terminal:open'));
                  }
                }}
              >
                <span className="topnav-drawer-tools-ico" aria-hidden="true">
                  <IconTerminal size={18} />
                </span>
                <span className="topnav-drawer-tools-label">Terminal</span>
                <span className="topnav-drawer-tools-meta">
                  Session dieses Workspaces
                </span>
              </button>
            </li>
            {/* Observatory is already in NAV_SECTIONS (System) — no
                duplicate entry in the same drawer (redundancy cut 2026-06-03). */}
            {process.env.NODE_ENV === 'development' && (
              <li>
                <Link
                  href="/design"
                  className="topnav-drawer-tools-link"
                  onClick={onClose}
                >
                  <span className="topnav-drawer-tools-ico" aria-hidden="true">
                    <IconLayers size={18} />
                  </span>
                  <span className="topnav-drawer-tools-label">
                    Design-Library
                  </span>
                  <span className="topnav-drawer-tools-meta">
                    Token & Komponenten
                  </span>
                </Link>
              </li>
            )}
          </ul>
        </section>

        <div className="topnav-drawer-sep" role="presentation" />

        {/* Push settings — user wish 2026-05-01: "im Navigation oder so
            push ein/aus möglich sein". Master toggle + per-rule toggles. */}
        <PushSettingsSection
          vapidPublicKey={process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? ''}
        />

        <div className="topnav-drawer-sep" role="presentation" />

        {/* 2026-05-03 wave B — settings section for AutoMode + Compact.
            Moved out of the TopNav right cluster on mobile — the header stays
            slim, power tools in the drawer. */}
        <section
          className="topnav-drawer-section topnav-drawer-settings"
          aria-label="Einstellungen"
        >
          <h2 className="topnav-drawer-heading">Einstellungen</h2>
          <ul className="topnav-drawer-settings-list" role="list">
            <li className="topnav-drawer-settings-row">
              <span className="topnav-drawer-settings-body">
                <span className="topnav-drawer-settings-label">Auto-Mode</span>
                <span className="topnav-drawer-settings-hint">
                  Jede Anfrage wird automatisch zu einem Multi-Agent-Workstream
                </span>
              </span>
              <span className="topnav-drawer-settings-action">
                <AutoModeToggle />
              </span>
            </li>
            <li className="topnav-drawer-settings-row">
              <span className="topnav-drawer-settings-body">
                <span className="topnav-drawer-settings-label">
                  Snapshot vor Compact
                </span>
                <span className="topnav-drawer-settings-hint">
                  Aktueller Stand ins Plan-File schreiben
                </span>
              </span>
              <span className="topnav-drawer-settings-action">
                <CompactButton />
              </span>
            </li>
          </ul>
        </section>

        <div className="topnav-drawer-sep" role="presentation" />

        <section className="topnav-drawer-section" style={{ padding: '0 16px' }}>
          <LocaleSwitcher />
        </section>

        <div className="topnav-drawer-sep" role="presentation" />

        <footer className="topnav-drawer-foot">
          <form action="/api/auth/logout" method="post">
            <button
              type="submit"
              className="topnav-drawer-foot-link"
            >
              Abmelden
            </button>
          </form>
          <span
            className="topnav-drawer-version"
            aria-label="Version"
          >
            v0.1.0
          </span>
        </footer>
      </aside>
    </div>
  );
}

interface WorkspaceRowProps {
  workspace: Workspace;
  selected: boolean;
  onSelect: (id: string) => void;
  /** D3 (P4-DRAWER) — optional per-workspace unread. Additive; 0 ⇒ no badge. */
  unread?: number;
}

function WorkspaceRow({
  workspace,
  selected,
  onSelect,
  unread = 0,
}: WorkspaceRowProps): React.JSX.Element {
  return (
    <button
      type="button"
      className={`topnav-drawer-ws-row${selected ? ' is-active' : ''}`}
      onClick={() => onSelect(workspace.id)}
      aria-pressed={selected}
    >
      <span
        className={`topnav-ws-dot topnav-ws-dot--${workspace.accent}`}
        aria-hidden="true"
      />
      <span className="topnav-drawer-ws-body">
        <span className="topnav-drawer-ws-label">{workspace.label}</span>
        {workspace.meta ? (
          <span className="topnav-drawer-ws-meta">{workspace.meta}</span>
        ) : null}
      </span>
      {unread > 0 ? <UnreadBadge count={unread} /> : null}
      {selected ? <DrawerCheck /> : null}
    </button>
  );
}

/**
 * D4 (P4-DRAWER) — unread pill. Token-only inline-styled (no new hex,
 * only var()/color-mix), same recipe as SubchatPulse.tsx. No red
 * dot, no emoji. `99+` from 100.
 */
function UnreadBadge({ count }: { count: number }): React.JSX.Element {
  return (
    <span
      className="topnav-drawer-kunde-unread"
      aria-label={`${count} ungelesen`}
      style={{
        flexShrink: 0,
        minWidth: 20,
        height: 20,
        padding: '0 6px',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 999,
        background: 'color-mix(in oklab, var(--a-now) 16%, transparent)',
        color: 'var(--a-now)',
        border: '0.5px solid color-mix(in oklab, var(--a-now) 30%, transparent)',
        fontSize: 11,
        fontWeight: 700,
        lineHeight: 1,
        fontVariantNumeric: 'tabular-nums',
      }}
    >
      {count > 99 ? '99+' : String(count)}
    </span>
  );
}

/**
 * D3 (P4-DRAWER) — inline SVG check (replaces the `` unicode glyph). The DRAWER
 * must NOT import from icons.tsx (a SPINE-owned file), hence inline.
 * Inherits `currentColor`; decorative ⇒ aria-hidden.
 */
function DrawerCheck(): React.JSX.Element {
  return (
    <span className="topnav-drawer-ws-check" aria-hidden="true">
      <svg
        width={14}
        height={14}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M5 12.5l4 4 10-10" />
      </svg>
    </span>
  );
}

export default MobileDrawer;
