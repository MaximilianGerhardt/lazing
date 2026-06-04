/**
 * GET /api/activity/live
 *
 * Sub-Plan 4 (TopNav-Pulse) — Aggregat-Endpoint für den Background-
 * Activity-Indicator. Vereint vier Quellen zu einem schlanken Polling-
 * Payload, der ~alle 30s vom TopNav abgerufen wird:
 *
 *   1. workstreams         — status IN (active, paused, stuck)
 *   2. workflow_runs       — status = 'running'
 *   3. routines            — active=1 AND nextRunAt < now+15min
 *   4. sub_workstreams     — workstreams mit parent_workstream_id != NULL
 *                            UND status='active' (Sub-Spawns laufen)
 *
 * Privacy: requireSession + Org-Cookie-Scope. Listet nur Items aus
 * Workspaces, die der User über Memberships sehen darf — analog
 * `/api/inbox/count`.
 *
 * Read-only. Kein Spawn, keine Mutationen.
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
 * Items sind nach `lastTickMs DESC` sortiert und auf 32 gekappt — die
 * UI zeigt höchstens 10 davon, aber der Endpoint liefert leichte
 * Reserve für zukünftige Drawer-Pagination.
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

const CRON_SOON_WINDOW_MS = 15 * 60 * 1000; // 15min Vorschau
const ITEMS_LIMIT = 32;

/**
 * Stuck-Aging-Default (Owner-Fix 2026-05-28):
 *
 * Ein vor 18h stuck-markierter Workstream zaehlte VORHER ewig im
 * Live-Counter (`status IN (active, paused, stuck)` ohne Aging). Folge:
 * die InlineWorkerStatus-Pill blieb dauerhaft an („aktiv · 18h 5m"),
 * und der Owner-Befund war: „bringt mir also nicht wirklich was".
 *
 * Wurzelfix: stuck-Workstreams, deren letzter `updatedAt` aelter ist
 * als dieser Schwellwert, werden im Live-Counter NICHT mehr gezeigt.
 *
 * **Reversibel — Filter-only**, kein DB-Mutate. DB-Zeile bleibt
 * `status='stuck'`, sichtbar in /lanes etc. (no destructive change).
 * Owner kann sie via `markAbandonedStuckWorkstreams()` (lib/workstreams/
 * stuck-detector.ts) explizit auf `abandoned` setzen, wenn er aufraeumen
 * will. Trade-off Filter-only vs. status-Update siehe Doc-Kommentar
 * dort.
 *
 * Konfigurierbar via ENV `LAZYOS_STUCK_AGING_MS` (Default 6h).
 * Test-Hook: `__testing.STUCK_AGING_DEFAULT_MS`.
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
  /** Detail-Felder (nur wenn `?detail=1`). Backwards-compatible: optional. */
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
 * Resolved Workspace-IDs that the User may see. Vereinfacht (analog
 * inbox-aggregate): wenn keine Org-Cookie → alle Workspaces der
 * primären Org; sonst Org-spezifisch. Memberships werden via
 * Workspace.organizationId gegen User-Org-Set geprüft.
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

    // Welle 1 · 2026-05-03 · Single-Source-of-Truth-Filter
    // ----------------------------------------------------
    // Wenn der ChatShell aktuell einen Workstream streamt, soll dieser
    // NICHT im Background-Pulse-Pill mitzaehlen — sonst sieht der User
    // 2× "läuft" (Bubble + TopNav-Pill). Client uebergibt die ID via
    // Query-Param `?excludeWorkstream=<id>`. Filter greift sowohl auf
    // workstreams.id als auch workflow_runs.id (workflows haben ihren
    // eigenen ID-Namespace, aber wir sind defensive).
    const excludeRaw =
      req.nextUrl?.searchParams.get('excludeWorkstream') ?? null;
    const excludeWorkstreamId =
      excludeRaw && excludeRaw.length > 0 && excludeRaw.length <= 64
        ? excludeRaw
        : null;

    // Owner-Fix 2026-05-28: `?detail=1` aktiviert die zusaetzlichen
    // Detail-Felder (status, stuckSinceMs, stuckReason) im Payload.
    // Default off → bestehende Konsumenten (TopNav, Drawer) sind
    // backwards-compatible und sehen unveraenderte Counts.
    const detailMode =
      req.nextUrl?.searchParams.get('detail') === '1';

    // Owner-Fix 2026-05-28: stuck-Aging-Schwellwert (Default 6h).
    // Stuck-Workstreams aelter als dieser Wert zaehlen NICHT mehr im
    // Live-Counter (Filter-only — DB-Zeile bleibt unveraendert).
    const stuckAgingMs = readStuckAgingMs();
    const stuckAgingCutoff = now - stuckAgingMs;

    const wsIds = await resolveScopedWorkspaceIds(userId, orgCookie);
    if (wsIds.length === 0) {
      return NextResponse.json(emptyResponse(now), {
        headers: { 'cache-control': 'no-store' },
      });
    }

    const db = getDb();

    // ----- 1+4) Workstreams (incl. Sub-Workstreams) -------------------
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
      // excludeWorkstream-Filter: aktiver Stream im ChatShell soll nicht
      // doppelt gezaehlt werden (User-Frust 2026-05-03 Redundanz-Kill).
      if (excludeWorkstreamId && r.id === excludeWorkstreamId) continue;

      // Owner-Fix 2026-05-28: stuck-Aging.
      // Stuck-WS, deren updatedAt aelter ist als der Aging-Cutoff,
      // zaehlen NICHT mehr im Live-Counter und werden nicht emittiert.
      // Filter-only — DB-Zeile bleibt erhalten.
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
        // Status fuer Detail-Surface. Andere Status werden im Live-
        // Filter bereits ausgeschlossen, daher sicher auf den 3 Werten.
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

    // ----- 2) Workflow-Runs (status=running) --------------------------
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
            // SQLite + drizzle: cast NOT NULL über Filter — wir trusten den
            // Filter und nehmen workspaceId direkt in inArray.
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

    // Sortiere nach lastTickMs DESC und kappe auf ITEMS_LIMIT.
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

// Test-Hook: explizit re-exportiert für Synthetik-Tests.
export const __testing = {
  CRON_SOON_WINDOW_MS,
  ITEMS_LIMIT,
  STUCK_AGING_DEFAULT_MS,
  readStuckAgingMs,
};

// Suppress unused warnings — `or`, `gt`, `sql` sind für künftige
// Erweiterung des Aggregats reserviert.
void or;
void gt;
void sql;
