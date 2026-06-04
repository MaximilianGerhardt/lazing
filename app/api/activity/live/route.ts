/**
 * GET /api/activity/live
 *
 * Sub-Plan 4 (TopNav pulse) — aggregate endpoint for the background
 * activity indicator. Combines four sources into a lean polling
 * payload that is fetched by the TopNav roughly every 30s:
 *
 *   1. workstreams         — status IN (active, paused, stuck)
 *   2. workflow_runs       — status = 'running'
 *   3. routines            — active=1 AND nextRunAt < now+15min
 *   4. sub_workstreams     — workstreams with parent_workstream_id != NULL
 *                            AND status='active' (sub-spawns running)
 *
 * Privacy: requireSession + org-cookie scope. Only lists items from
 * workspaces the user is allowed to see via memberships — analogous to
 * `/api/inbox/count`.
 *
 * Read-only. No spawn, no mutations.
 *
 * Response-Shape:
 *   {
 *     ok: true,
 *     now: number,
 *     running: number,
 *     paused: number,
 *     stuck: number,
 *     cronSoon: number,
 *     items: Array<{
 *       type: 'workstream' | 'workflow' | 'routine' | 'sub-workstream',
 *       id: string,
 *       label: string,
 *       phase: string | null,
 *       lastTickMs: number | null,
 *       workspaceId: string,
 *     }>
 *   }
 *
 * Items are sorted by `lastTickMs DESC` and capped at 32 — the
 * UI shows at most 10 of them, but the endpoint provides a slight
 * reserve for future drawer pagination.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { and, desc, eq, gt, inArray, isNotNull, lt, or, sql } from 'drizzle-orm';

import { getDb } from '@/db/client';
import { workstreams } from '@/db/schema/workstreams';
import { workflowRuns } from '@/db/schema/workflow_runs';
import { routines } from '@/db/schema/routines';
import { workspaces as workspacesTable } from '@/db/schema/workspaces';
import { listOrgsForUser } from '@/lib/orgs/repo';
import { currentUserIdResolved } from '@/lib/security/subject-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CRON_SOON_WINDOW_MS = 15 * 60 * 1000; // 15min preview
const ITEMS_LIMIT = 32;

/**
 * Stuck-aging default (owner fix 2026-05-28):
 *
 * A workstream marked stuck 18h ago previously counted forever in the
 * live counter (`status IN (active, paused, stuck)` without aging). Result:
 * the InlineWorkerStatus pill stayed on permanently („aktiv · 18h 5m"),
 * and the owner's verdict was: „bringt mir also nicht wirklich was".
 *
 * Root fix: stuck workstreams whose last `updatedAt` is older
 * than this threshold are NO longer shown in the live counter.
 *
 * **Reversible — filter-only**, no DB mutate. The DB row stays
 * `status='stuck'`, visible in /lanes etc. (no destructive change).
 * The owner can explicitly set it to `abandoned` via
 * `markAbandonedStuckWorkstreams()` (lib/workstreams/
 * stuck-detector.ts) when they want to clean up. Trade-off filter-only
 * vs. status update see the doc comment there.
 *
 * Configurable via ENV `LAZYOS_STUCK_AGING_MS` (default 6h).
 * Test hook: `__testing.STUCK_AGING_DEFAULT_MS`.
 */
const STUCK_AGING_DEFAULT_MS = 6 * 60 * 60 * 1000; // 6h

function readStuckAgingMs(): number {
  const raw = process.env.LAZYOS_STUCK_AGING_MS;
  if (!raw) return STUCK_AGING_DEFAULT_MS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return STUCK_AGING_DEFAULT_MS;
  return n;
}

interface ActivityItem {
  type: 'workstream' | 'workflow' | 'routine' | 'sub-workstream';
  id: string;
  label: string;
  phase: string | null;
  lastTickMs: number | null;
  workspaceId: string;
  /** Detail fields (only when `?detail=1`). Backwards-compatible: optional. */
  status?: 'active' | 'paused' | 'stuck' | null;
  stuckSinceMs?: number | null;
  stuckReason?: string | null;
}

interface ActivityResponse {
  ok: boolean;
  now: number;
  running: number;
  paused: number;
  stuck: number;
  cronSoon: number;
  items: ActivityItem[];
}

function emptyResponse(now: number, ok = true): ActivityResponse {
  return { ok, now, running: 0, paused: 0, stuck: 0, cronSoon: 0, items: [] };
}

/**
 * Resolved workspace IDs that the user may see. Simplified (analogous to
 * inbox-aggregate): if no org cookie → all workspaces of the
 * primary org; otherwise org-specific. Memberships are checked via
 * Workspace.organizationId against the user's org set.
 */
async function resolveScopedWorkspaceIds(
  userId: string,
  orgCookie: string | null,
): Promise<string[]> {
  const userOrgs = listOrgsForUser(userId).map((o) => o.id);
  if (userOrgs.length === 0) return [];

  let allowedOrgIds: Set<string>;
  if (orgCookie && orgCookie !== '__all__') {
    if (!userOrgs.includes(orgCookie)) return [];
    allowedOrgIds = new Set([orgCookie]);
  } else {
    allowedOrgIds = new Set(userOrgs);
  }

  const db = getDb();
  const rows = db
    .select({ id: workspacesTable.id, orgId: workspacesTable.organizationId })
    .from(workspacesTable)
    .all();

  return rows
    .filter((r) => {
      if (!r.orgId) return false;
      return allowedOrgIds.has(r.orgId);
    })
    .map((r) => r.id);
}

export async function GET(req: NextRequest): Promise<Response> {
  const now = Date.now();
  const userId = currentUserIdResolved(req);
  if (!userId) {
    return NextResponse.json(emptyResponse(now, false), { status: 200 });
  }

  try {
    const orgCookie =
      req.cookies.get('lazyos.org')?.value ??
      req.cookies.get('lazyos_org')?.value ??
      null;

    // Wave 1 · 2026-05-03 · single-source-of-truth filter
    // ----------------------------------------------------
    // If the ChatShell is currently streaming a workstream, it should
    // NOT also count in the background pulse pill — otherwise the user sees
    // "läuft" twice (bubble + TopNav pill). The client passes the ID via
    // the query param `?excludeWorkstream=<id>`. The filter applies to both
    // workstreams.id and workflow_runs.id (workflows have their
    // own ID namespace, but we are defensive).
    const excludeRaw =
      req.nextUrl?.searchParams.get('excludeWorkstream') ?? null;
    const excludeWorkstreamId =
      excludeRaw && excludeRaw.length > 0 && excludeRaw.length <= 64
        ? excludeRaw
        : null;

    // Owner fix 2026-05-28: `?detail=1` enables the additional
    // detail fields (status, stuckSinceMs, stuckReason) in the payload.
    // Default off → existing consumers (TopNav, drawer) are
    // backwards-compatible and see unchanged counts.
    const detailMode =
      req.nextUrl?.searchParams.get('detail') === '1';

    // Owner fix 2026-05-28: stuck-aging threshold (default 6h).
    // Stuck workstreams older than this value NO longer count in the
    // live counter (filter-only — the DB row stays unchanged).
    const stuckAgingMs = readStuckAgingMs();
    const stuckAgingCutoff = now - stuckAgingMs;

    const wsIds = await resolveScopedWorkspaceIds(userId, orgCookie);
    if (wsIds.length === 0) {
      return NextResponse.json(emptyResponse(now), {
        headers: { 'cache-control': 'no-store' },
      });
    }

    const db = getDb();

    // ----- 1+4) Workstreams (incl. sub-workstreams) -------------------
    const wsRows = db
      .select({
        id: workstreams.id,
        workspaceId: workstreams.workspaceId,
        name: workstreams.name,
        status: workstreams.status,
        role: workstreams.role,
        mode: workstreams.mode,
        parentWorkstreamId: workstreams.parentWorkstreamId,
        updatedAt: workstreams.updatedAt,
      })
      .from(workstreams)
      .where(
        and(
          inArray(workstreams.workspaceId, wsIds),
          inArray(workstreams.status, ['active', 'paused', 'stuck']),
        ),
      )
      .orderBy(desc(workstreams.updatedAt))
      .limit(ITEMS_LIMIT)
      .all();

    let running = 0;
    let paused = 0;
    let stuck = 0;
    const items: ActivityItem[] = [];

    for (const r of wsRows) {
      // excludeWorkstream filter: the active stream in the ChatShell should
      // not be counted twice (user frustration 2026-05-03 redundancy kill).
      if (excludeWorkstreamId && r.id === excludeWorkstreamId) continue;

      // Owner fix 2026-05-28: stuck-aging.
      // Stuck workstreams whose updatedAt is older than the aging cutoff
      // NO longer count in the live counter and are not emitted.
      // Filter-only — the DB row is preserved.
      if (
        r.status === 'stuck' &&
        (r.updatedAt ?? 0) < stuckAgingCutoff
      ) {
        continue;
      }

      if (r.status === 'active') running += 1;
      else if (r.status === 'paused') paused += 1;
      else if (r.status === 'stuck') stuck += 1;

      const isSub =
        r.parentWorkstreamId !== null && r.parentWorkstreamId !== undefined;

      const item: ActivityItem = {
        type: isSub ? 'sub-workstream' : 'workstream',
        id: r.id,
        label: r.name,
        phase: r.role ?? r.mode ?? null,
        lastTickMs: r.updatedAt ?? null,
        workspaceId: r.workspaceId,
      };

      if (detailMode) {
        // Status for the detail surface. Other statuses are already
        // excluded in the live filter, so safe on the 3 values.
        if (r.status === 'active' || r.status === 'paused' || r.status === 'stuck') {
          item.status = r.status;
        } else {
          item.status = null;
        }
        if (r.status === 'stuck') {
          const ageMs = r.updatedAt ? now - r.updatedAt : null;
          item.stuckSinceMs = ageMs;
          if (ageMs !== null && ageMs > 0) {
            const min = Math.floor(ageMs / 60_000);
            if (min < 60) {
              item.stuckReason = `kein Event seit ${min}m`;
            } else {
              const h = Math.floor(min / 60);
              item.stuckReason = `kein Event seit ${h}h ${min % 60}m`;
            }
          } else {
            item.stuckReason = 'kein Heartbeat';
          }
        } else {
          item.stuckSinceMs = null;
          item.stuckReason = null;
        }
      }

      items.push(item);
    }

    // ----- 2) Workflow runs (status=running) --------------------------
    const wfRows = db
      .select({
        id: workflowRuns.id,
        workflowId: workflowRuns.workflowId,
        workspaceId: workflowRuns.workspaceId,
        currentState: workflowRuns.currentState,
        lastTransitionAt: workflowRuns.lastTransitionAt,
      })
      .from(workflowRuns)
      .where(
        and(
          eq(workflowRuns.status, 'running'),
          isNotNull(workflowRuns.workspaceId),
          inArray(
            // SQLite + drizzle: cast NOT NULL via filter — we trust the
            // filter and take workspaceId directly into inArray.
            workflowRuns.workspaceId,
            wsIds,
          ),
        ),
      )
      .orderBy(desc(workflowRuns.lastTransitionAt))
      .limit(ITEMS_LIMIT)
      .all();

    for (const r of wfRows) {
      if (excludeWorkstreamId && r.id === excludeWorkstreamId) continue;
      running += 1;
      const item: ActivityItem = {
        type: 'workflow',
        id: r.id,
        label: r.workflowId,
        phase: r.currentState,
        lastTickMs: r.lastTransitionAt,
        workspaceId: r.workspaceId ?? '',
      };
      if (detailMode) {
        item.status = 'active';
        item.stuckSinceMs = null;
        item.stuckReason = null;
      }
      items.push(item);
    }

    // ----- 3) Routines (active + nextRunAt soon) ----------------------
    const cronCutoff = now + CRON_SOON_WINDOW_MS;
    const rtRows = db
      .select({
        id: routines.id,
        name: routines.name,
        workspaceId: routines.workspaceId,
        nextRunAt: routines.nextRunAt,
      })
      .from(routines)
      .where(
        and(
          eq(routines.active, true),
          inArray(routines.workspaceId, wsIds),
          isNotNull(routines.nextRunAt),
          lt(routines.nextRunAt, cronCutoff),
        ),
      )
      .orderBy(routines.nextRunAt)
      .limit(ITEMS_LIMIT)
      .all();

    let cronSoon = 0;
    for (const r of rtRows) {
      cronSoon += 1;
      items.push({
        type: 'routine',
        id: r.id,
        label: r.name,
        phase: 'scheduled',
        lastTickMs: r.nextRunAt ?? null,
        workspaceId: r.workspaceId,
      });
    }

    // Sort by lastTickMs DESC and cap at ITEMS_LIMIT.
    items.sort((a, b) => (b.lastTickMs ?? 0) - (a.lastTickMs ?? 0));
    const trimmed = items.slice(0, ITEMS_LIMIT);

    const body: ActivityResponse = {
      ok: true,
      now,
      running,
      paused,
      stuck,
      cronSoon,
      items: trimmed,
    };

    return NextResponse.json(body, {
      headers: { 'cache-control': 'no-store' },
    });
  } catch (err) {
    return NextResponse.json(
      {
        ...emptyResponse(now, false),
        error: 'aggregate-failed',
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 200 },
    );
  }
}

// Test hook: explicitly re-exported for synthetic tests.
export const __testing = {
  CRON_SOON_WINDOW_MS,
  ITEMS_LIMIT,
  STUCK_AGING_DEFAULT_MS,
  readStuckAgingMs,
};

// Suppress unused warnings — `or`, `gt`, `sql` are reserved for future
// extension of the aggregate.
void or;
void gt;
void sql;
