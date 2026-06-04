/**
 * Phase IB — Inbox-Aggregator.
 *
 * Returns the items that are "waiting for the user". Server-side, read-only.
 *
 * Sources (Phase-1 MVP):
 *   - tickets in workflowState='review' (approval requested)        — P0
 *   - tickets in workflowState='approved' but not yet executed      — P1
 *   - workstreams with status='active' but stale (>24h without update) — P2
 *
 * Filter:
 *   - only workspaces in which the user is at least a viewer.
 *
 * Later sources (TBD):
 *   - @max mentions in commented events (needs its own index)
 *   - stale heartbeats that need attention
 *   - failed routines to re-trigger
 */

import { getDb } from "@/db/client";
import {
  canReadWorkspace,
  getEffectiveWorkspaceRole,
} from "@/lib/security/permissions";
import { listTickets } from "@/lib/tickets/service";

export type InboxItemKind =
  | "ticket-review"
  | "ticket-approved-pending"
  | "workstream-stale";

export interface InboxItem {
  kind: InboxItemKind;
  id: string;
  title: string;
  workspaceId: string;
  workspaceLabel: string;
  href: string;
  createdAt: number;
  updatedAt: number;
  meta?: string;
  priority: 0 | 1 | 2;
}

export interface InboxResult {
  items: InboxItem[];
  counts: Record<InboxItemKind, number>;
  total: number;
}

/**
 * Main function. Returns the aggregated inbox for a user.
 *
 * @param userId  authenticated user
 * @param opts.orgId  optional org scope. If set → only inbox items
 *                    from workspaces of this org. Phase IA.5 (2026-04-29).
 */
export async function aggregateInbox(
  userId: string,
  opts?: { orgId?: string },
): Promise<InboxResult> {
  const db = getDb();

  // All workspaces in which the user has membership in some way
  // (via org or directly). Plus solo-mode fallback.
  // Phase IA.5 — if orgId is set: only workspaces of this org. Org-root
  // pseudo-WS (`__org_root__:<id>`) and legacy `__root__` are filtered
  // out (no user should see inbox items from virtual WS).
  const baseSql = `SELECT id, label, organization_id
     FROM workspaces
    WHERE archived = 0
      AND id != '__root__'
      AND id NOT LIKE '__org_root__:%'`;
  const wsRows = (
    opts?.orgId
      ? db.$raw
          .prepare(`${baseSql} AND organization_id = ? ORDER BY label ASC`)
          .all(opts.orgId)
      : db.$raw.prepare(`${baseSql} ORDER BY label ASC`).all()
  ) as Array<{ id: string; label: string; organization_id: string | null }>;

  const visibleWs = wsRows.filter((w) =>
    canReadWorkspace(getEffectiveWorkspaceRole(userId, w.id)),
  );

  const items: InboxItem[] = [];
  const STALE_MS = 24 * 60 * 60 * 1000;
  const now = Date.now();

  for (const ws of visibleWs) {
    let tickets;
    try {
      tickets = await listTickets({ workspaceId: ws.id, limit: 200 });
    } catch {
      continue;
    }
    for (const t of tickets) {
      const tt = t as unknown as {
        id: string;
        title: string;
        workflowState?: string;
        createdAt?: number | string | Date;
        updatedAt?: number | string | Date;
      };
      const wf = tt.workflowState;
      const updatedAt = toMs(tt.updatedAt);
      const createdAt = toMs(tt.createdAt) || updatedAt;

      if (wf === "review") {
        items.push({
          kind: "ticket-review",
          id: tt.id,
          title: tt.title || tt.id,
          workspaceId: ws.id,
          workspaceLabel: ws.label,
          href: `/tickets/${encodeURIComponent(t.id)}`,
          createdAt,
          updatedAt,
          meta: "wartet auf Freigabe",
          priority: 0,
        });
      } else if (wf === "approved") {
        // Approved + not executed = waiting for dispatch.
        items.push({
          kind: "ticket-approved-pending",
          id: tt.id,
          title: tt.title || tt.id,
          workspaceId: ws.id,
          workspaceLabel: ws.label,
          href: `/tickets/${encodeURIComponent(t.id)}`,
          createdAt,
          updatedAt,
          meta: "approved · wartet auf Dispatch",
          priority: 1,
        });
      }
    }
  }

  // Stale Workstreams — Workspace-Filter via JOIN
  const visibleIds = new Set(visibleWs.map((w) => w.id));
  if (visibleIds.size > 0) {
    const placeholders = visibleWs.map(() => "?").join(",");
    const wsItems = db.$raw
      .prepare(
        `SELECT ws.id, ws.name, ws.workspace_id, ws.status,
                ws.created_at, ws.updated_at,
                w.label as ws_label
           FROM workstreams ws
           LEFT JOIN workspaces w ON w.id = ws.workspace_id
          WHERE ws.status = 'active'
            AND ws.workspace_id IN (${placeholders})
            AND ws.updated_at < ?
          ORDER BY ws.updated_at DESC
          LIMIT 50`,
      )
      .all(...visibleWs.map((w) => w.id), now - STALE_MS) as Array<{
      id: string;
      name: string;
      workspace_id: string;
      ws_label: string | null;
      created_at: number;
      updated_at: number;
    }>;

    for (const w of wsItems) {
      items.push({
        kind: "workstream-stale",
        id: w.id,
        title: w.name,
        workspaceId: w.workspace_id,
        workspaceLabel: w.ws_label ?? w.workspace_id,
        href: `/workstreams/${encodeURIComponent(w.id)}`,
        createdAt: w.created_at,
        updatedAt: w.updated_at,
        meta: "stale > 24h — sollte das geschlossen werden?",
        priority: 2,
      });
    }
  }

  items.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return b.updatedAt - a.updatedAt;
  });

  const counts: Record<InboxItemKind, number> = {
    "ticket-review": 0,
    "ticket-approved-pending": 0,
    "workstream-stale": 0,
  };
  for (const it of items) counts[it.kind]++;

  return { items, counts, total: items.length };
}

function toMs(v: number | string | Date | null | undefined): number {
  if (typeof v === "number") return v;
  if (v instanceof Date) return v.getTime();
  if (typeof v === "string") {
    const n = Number.parseInt(v, 10);
    if (Number.isFinite(n)) return n;
    const d = Date.parse(v);
    if (Number.isFinite(d)) return d;
  }
  return 0;
}
