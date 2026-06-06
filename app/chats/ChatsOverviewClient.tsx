'use client';

/**
 * ChatsOverviewClient — the WhatsApp-style chat overview (mobile-IA realign
 * 2026-06-06). Three stacked sections, token-only, Apple-quiet:
 *
 *   1. Search   — reuses <SubchatSearch> (deep-links into a sub-chat hit).
 *   2. Communities — chats GROUPED by Org/Workspace. Reuses the shared PURE
 *      `groupCommunityNodes(...)` that backs the drawer's "Kunden" section, fed
 *      from this component's own `useWorkspaces()` / `useUserOrgs()` /
 *      `/api/subchats/activity` (the hook-bound data acquisition stays in the
 *      component; only the filter→group→sort→orphan algorithm is shared, so the
 *      two surfaces cannot drift). Per-org colour dot via the real
 *      `--palette-N-mid` token, aggregated unread badge, single-workspace
 *      collapse → one row.
 *   3. Recent chats (flat) — most-recent conversations across workspaces
 *      (sub-chats), newest first, with a last-message scent + relative time.
 *
 * Row taps:
 *   - workspace main-chat row → `/?ws=<id>` (carry the scope into the chat).
 *   - sub-chat row → `/workspaces/<id>/subchats/<subchatId>` (conversation).
 *   - org group header → expand/collapse (no navigation), like the drawer.
 *
 * Styling mirrors SubchatsClient's row styles (rowWrap/rowLink/rowTitle/
 * rowMeta) for cross-surface visual consistency. `.page-with-tabbar` reserves
 * space so the floating bar never covers the last row.
 */

import Link from 'next/link';
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
} from 'react';

import { SubchatSearch } from '@/lib/subchats/SubchatSearch';
import { useCurrentWorkspace, useUserOrgs, useWorkspaces } from '@/lib/nav/hooks';
import {
  communityDotBackground,
  groupCommunityNodes,
} from '@/lib/nav/community-groups';
import { IconChevronRight } from '@/lib/nav/icons';
import type { Workspace } from '@/lib/nav/types';

/** One row of the aggregate `/api/subchats/activity` response. */
interface ActivityRow {
  id: string; // subchatId
  title: string;
  kind: 'external' | 'internal';
  workspaceId: string;
  workspaceLabel: string;
  unreadCount?: number;
  lastExternalTs: number | null;
  lastMessage: {
    authorKind: 'internal' | 'external' | 'system';
    authorName: string | null;
    content: string;
    ts: number;
  } | null;
}

/** Carry the active scope onto a workspace main-chat deep link (skip virtual ids). */
function wsChatHref(id: string): string {
  return id.startsWith('__') ? '/' : `/?ws=${encodeURIComponent(id)}`;
}

/** Compact relative time — same scale as SubchatsClient.relativeTime. */
function relativeTime(ts: number): string {
  const ms = Date.now() - ts;
  if (!Number.isFinite(ms) || ms < 0) return 'gerade eben';
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'gerade eben';
  if (min < 60) return `vor ${min} Min`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `vor ${hrs} Std`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `vor ${days} Tg`;
  const wks = Math.floor(days / 7);
  return `vor ${wks} Wo`;
}

/** Best-effort "scent" for a recent row: last message snippet, else the kind. */
function recentScent(row: ActivityRow): string {
  const parts: string[] = [];
  const ts = row.lastMessage?.ts ?? row.lastExternalTs;
  if (ts) parts.push(relativeTime(ts));
  if (row.lastMessage?.content) {
    const snippet = row.lastMessage.content.replace(/\s+/g, ' ').trim();
    if (snippet) parts.push(snippet.length > 48 ? `${snippet.slice(0, 47)}…` : snippet);
  } else if (row.kind === 'external') {
    parts.push('Kunde');
  }
  return parts.join(' · ');
}

export function ChatsOverviewClient(): React.JSX.Element {
  const { workspaces } = useWorkspaces();
  const { orgs } = useUserOrgs();
  const current = useCurrentWorkspace();

  const [activity, setActivity] = useState<ActivityRow[]>([]);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  // Activity aggregate (drives both the unread badges in Communities AND the
  // flat Recent list). Same route + non-fatal pattern as the drawer.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch('/api/subchats/activity', {
          cache: 'no-store',
          credentials: 'same-origin',
        });
        if (!res.ok) return;
        const body = (await res.json()) as { activity?: ActivityRow[] };
        if (!alive || !Array.isArray(body.activity)) return;
        setActivity(body.activity);
      } catch {
        /* non-fatal — overview renders without unread / recent */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Per-workspace unread aggregate from the activity rows.
  const unreadByWs = useMemo<Record<string, number>>(() => {
    const m: Record<string, number> = {};
    for (const a of activity) {
      if (!a.workspaceId) continue;
      m[a.workspaceId] = (m[a.workspaceId] ?? 0) + (a.unreadCount ?? 0);
    }
    return m;
  }, [activity]);

  // Communities — the SHARED grouping algorithm, fed from this component's hooks.
  const nodes = useMemo(
    () => groupCommunityNodes(workspaces, orgs, current.id, unreadByWs),
    [workspaces, orgs, current.id, unreadByWs],
  );

  // Recent flat list — newest first by last activity.
  const recent = useMemo(() => {
    return [...activity].sort((a, b) => {
      const ta = a.lastMessage?.ts ?? a.lastExternalTs ?? 0;
      const tb = b.lastMessage?.ts ?? b.lastExternalTs ?? 0;
      return tb - ta;
    });
  }, [activity]);

  const toggle = useCallback((orgId: string) => {
    setCollapsed((prev) => ({ ...prev, [orgId]: !prev[orgId] }));
  }, []);

  return (
    <main className="sheet page-with-tabbar" style={shell}>
      <header style={headerStyle}>
        <h1 style={titleStyle}>Chats</h1>
      </header>

      <div style={body}>
        {/* Search — pinned at the top (HIG search-accessible). */}
        <div style={{ marginBottom: 14 }}>
          <SubchatSearch placeholder="Chats & Wissen durchsuchen" />
        </div>

        {/* ---- Communities (Org/Workspace-grouped) ---- */}
        <section aria-label="Communities" style={sectionStyle}>
          <h2 style={sectionHeading}>Communities</h2>
          {nodes.length === 0 ? (
            <div style={emptyRow} role="note">
              Noch keine Workspaces. Leg in den Einstellungen einen an.
            </div>
          ) : (
            <ul style={list}>
              {nodes.map((node) => {
                const dotBg = communityDotBackground(node.paletteIndex);
                const dotStyle = dotBg ? { ...dot, background: dotBg } : dot;

                // Single workspace → one row that IS the community, opens its
                // main chat directly (collapse community↔workspace).
                if (node.rows.length === 1) {
                  const w = node.rows[0];
                  return (
                    <li key={node.orgId} style={rowWrap}>
                      <Link href={wsChatHref(w.id)} style={rowLink}>
                        <span style={dotStyle} aria-hidden="true" />
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div style={rowTitle}>{node.name}</div>
                          <div style={rowMeta}>{w.label}</div>
                        </div>
                        {node.unread > 0 ? <UnreadBadge count={node.unread} /> : null}
                      </Link>
                    </li>
                  );
                }

                // Multi workspace → collapsible header + child workspace rows.
                const isCollapsed = collapsed[node.orgId] === true;
                return (
                  <li key={node.orgId} style={groupWrap} role="group" aria-label={node.name}>
                    <button
                      type="button"
                      onClick={() => toggle(node.orgId)}
                      aria-expanded={!isCollapsed}
                      aria-controls={`chats-org-${node.orgId}`}
                      style={groupHead}
                    >
                      <span style={dotStyle} aria-hidden="true" />
                      <span style={groupName}>{node.name}</span>
                      {node.unread > 0 ? <UnreadBadge count={node.unread} /> : null}
                      <span style={groupCount} aria-hidden="true">
                        {node.rows.length}
                      </span>
                      <span
                        aria-hidden="true"
                        style={{
                          ...chev,
                          transform: isCollapsed ? 'none' : 'rotate(90deg)',
                        }}
                      >
                        <IconChevronRight size={14} />
                      </span>
                    </button>
                    {!isCollapsed ? (
                      <ul id={`chats-org-${node.orgId}`} style={childList} role="list">
                        {node.rows.map((w: Workspace) => (
                          <li key={w.id} style={rowWrap}>
                            <Link href={wsChatHref(w.id)} style={rowLink}>
                              <span style={childDot} aria-hidden="true" />
                              <div style={{ minWidth: 0, flex: 1 }}>
                                <div style={rowTitle}>{w.label}</div>
                                {w.meta ? <div style={rowMeta}>{w.meta}</div> : null}
                              </div>
                              {(unreadByWs[w.id] ?? 0) > 0 ? (
                                <UnreadBadge count={unreadByWs[w.id] ?? 0} />
                              ) : null}
                            </Link>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* ---- Recent chats (flat) ---- */}
        {recent.length > 0 ? (
          <section aria-label="Zuletzt" style={sectionStyle}>
            <h2 style={sectionHeading}>Zuletzt</h2>
            <ul style={list}>
              {recent.map((row) => (
                <li key={`${row.workspaceId}:${row.id}`} style={rowWrap}>
                  <Link
                    href={`/workspaces/${encodeURIComponent(
                      row.workspaceId,
                    )}/subchats/${encodeURIComponent(row.id)}`}
                    style={rowLink}
                  >
                    <span style={recentDot} aria-hidden="true" />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={rowTitle}>
                        {row.title}
                        <span style={rowOrg}> · {row.workspaceLabel}</span>
                      </div>
                      <div style={rowMeta}>{recentScent(row)}</div>
                    </div>
                    {(row.unreadCount ?? 0) > 0 ? (
                      <UnreadBadge count={row.unreadCount ?? 0} />
                    ) : null}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </main>
  );
}

/**
 * Unread pill — token-only, same recipe as MobileDrawer.UnreadBadge (no red
 * dot, no emoji; `99+` from 100). Kept local (the drawer's is private).
 */
function UnreadBadge({ count }: { count: number }): React.JSX.Element {
  return (
    <span aria-label={`${count} ungelesen`} style={unreadBadge}>
      {count > 99 ? '99+' : String(count)}
    </span>
  );
}

const shell: CSSProperties = {
  minHeight: '100dvh',
  background: 'var(--sheet)',
  color: 'var(--ink)',
  fontFamily: 'var(--font-sans)',
};
const headerStyle: CSSProperties = {
  padding: 'max(16px, env(safe-area-inset-top)) 16px 8px',
  maxWidth: 680,
  width: '100%',
  margin: '0 auto',
};
const titleStyle: CSSProperties = {
  fontSize: 'clamp(26px, 6vw, 34px)',
  fontWeight: 600,
  letterSpacing: '-0.03em',
  margin: 0,
};
const body: CSSProperties = {
  padding: '8px 16px 0',
  maxWidth: 680,
  width: '100%',
  margin: '0 auto',
};
const sectionStyle: CSSProperties = { marginTop: 18 };
const sectionHeading: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--ink-3)',
  margin: '0 0 10px 2px',
};
const list: CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};
const rowWrap: CSSProperties = {
  display: 'flex',
  alignItems: 'stretch',
  background: 'var(--sheet-2)',
  border: '0.5px solid var(--line-2)',
  borderRadius: 12,
  padding: '4px 14px 4px 12px',
};
const rowLink: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 11,
  flex: 1,
  minWidth: 0,
  minHeight: 44,
  padding: '8px 0',
  textDecoration: 'none',
  color: 'var(--ink)',
};
const rowTitle: CSSProperties = {
  fontSize: 15,
  fontWeight: 550,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};
const rowOrg: CSSProperties = { color: 'var(--ink-3)', fontWeight: 400 };
const rowMeta: CSSProperties = {
  fontSize: 12,
  color: 'var(--ink-3)',
  marginTop: 2,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};
const dot: CSSProperties = {
  width: 10,
  height: 10,
  borderRadius: 999,
  flexShrink: 0,
  background: 'var(--a-now)',
};
const childDot: CSSProperties = {
  width: 7,
  height: 7,
  borderRadius: 999,
  flexShrink: 0,
  background: 'var(--ink-3)',
};
const recentDot: CSSProperties = {
  width: 8,
  height: 8,
  borderRadius: 999,
  flexShrink: 0,
  background: 'color-mix(in oklab, var(--a-now) 60%, transparent)',
};
const groupWrap: CSSProperties = {
  background: 'var(--sheet-2)',
  border: '0.5px solid var(--line-2)',
  borderRadius: 12,
  overflow: 'hidden',
};
const groupHead: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 11,
  width: '100%',
  minHeight: 48,
  padding: '10px 14px 10px 12px',
  background: 'transparent',
  border: 'none',
  color: 'var(--ink)',
  cursor: 'pointer',
  textAlign: 'left',
};
const groupName: CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: 15,
  fontWeight: 600,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};
const groupCount: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  color: 'var(--ink-3)',
};
const chev: CSSProperties = {
  color: 'var(--ink-3)',
  display: 'inline-flex',
  transition: 'transform var(--dur-quick) ease',
};
const childList: CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: '0 10px 8px',
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
};
const emptyRow: CSSProperties = {
  padding: 18,
  borderRadius: 12,
  border: '0.5px dashed var(--line-2)',
  color: 'var(--ink-3)',
  fontSize: 14,
  textAlign: 'center',
};
const unreadBadge: CSSProperties = {
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
  alignSelf: 'center',
};

export default ChatsOverviewClient;
