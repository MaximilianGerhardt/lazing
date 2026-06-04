/**
 * POST /api/workstreams/[id]/subagent/[paneId]/abort
 *
 * CP-2 / UX-Audit 2026-05-28 — wires the "Abort" affordance on the
 * SubagentFleetCard to a real backend (previously dead — see
 * `lib/chat/SurfaceRenderer.tsx:1832-1840` and the explicit
 * "follow-up wenn SSE-Wiring angebunden wird" comment).
 *
 * Semantics:
 *   - `[id]`     = parent workstreamId (drives the workspace permission gate).
 *   - `[paneId]` = `subagentId` from the SubagentFleet surface payload
 *                  (globally unique within the process — minted by the
 *                  spawner as `sub-<role>-<8alnum>`).
 *
 *   1. Auth: must be a logged-in user with edit-content rights on the
 *      parent workstream's workspace (same gate as
 *      /api/workstreams/[id]/cancel).
 *   2. Mark the pane as `aborted` in the in-process fleet registry
 *      (`lib/agents/fleet-registry.ts:abortPane`). Idempotent —
 *      a second abort on a terminal pane returns `{ ok: true,
 *      unchanged: true }` without touching state.
 *   3. Best-effort: release any inflight `ResourcePool` slot acquired
 *      by this subagentId so the heavy-pool isn't held hostage by an
 *      aborted lane.
 *   4. NO Bridge approval — UX-Audit explicitly chose this default; a
 *      Bridge gate around abort would be a larger slice. Operator is
 *      already authenticated + workspace-edit-gated.
 *
 * Response shape:
 *   200 { ok: true, workstreamId, paneId, previousStatus, status }
 *   200 { ok: true, unchanged: true, ... }   ← pane already terminal
 *   401 { error: 'auth-required' }
 *   403 { error: 'forbidden' }
 *   404 { error: 'not-found' }               ← workstream or pane missing
 */

import { NextResponse, type NextRequest } from 'next/server';

import { getDb } from '@/db/client';
import {
  canEditWorkspaceContent,
  getEffectiveWorkspaceRole,
} from '@/lib/security/permissions';
import { currentUserIdResolved } from '@/lib/security/subject-server';
import { abortPane, findFleetByPaneId } from '@/lib/agents/fleet-registry';
import { resourcePool } from '@/lib/agents/resource-pool';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface WsRow {
  workspace_id: string;
  status: string;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; paneId: string }> },
): Promise<Response> {
  const { id: workstreamId, paneId: rawPaneId } = await params;
  const paneId = decodeURIComponent(rawPaneId);

  // ── 1. Auth + workspace edit-content gate ────────────────────────────
  const userId = currentUserIdResolved(req);
  if (!userId) {
    return NextResponse.json({ error: 'auth-required' }, { status: 401 });
  }
  const db = getDb();
  const ws = db.$raw
    .prepare('SELECT workspace_id, status FROM workstreams WHERE id = ?')
    .get(workstreamId) as WsRow | undefined;
  if (!ws) {
    return NextResponse.json({ error: 'not-found', detail: 'workstream' }, { status: 404 });
  }
  if (!canEditWorkspaceContent(getEffectiveWorkspaceRole(userId, ws.workspace_id))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  // ── 2. Locate the pane in the in-process fleet registry ──────────────
  // The fleet-id is operator-chosen (NOT 1:1 with workstreamId). We
  // resolve it from the paneId — pane ids are globally unique.
  const fleetId = findFleetByPaneId(paneId);
  if (!fleetId) {
    return NextResponse.json(
      { error: 'not-found', detail: 'pane', paneId },
      { status: 404 },
    );
  }

  const abortResult = abortPane(fleetId, paneId);
  if (!abortResult) {
    // findFleetByPaneId already returned non-null, so this is a race
    // condition (pane removed between lookup + mutate). Treat as 404.
    return NextResponse.json(
      { error: 'not-found', detail: 'pane', paneId },
      { status: 404 },
    );
  }

  // ── 3. Best-effort slot release (heavy-pool reclaim) ─────────────────
  // `getInflight()` exposes the slot list; we release any slot whose
  // `subagentId` matches. Wrapped in try/catch so a registry mismatch
  // never breaks the abort path — the pane-state mutation in step 2 is
  // the load-bearing signal.
  let slotsReleased = 0;
  try {
    const inflight = resourcePool.getInflight();
    for (const slot of inflight) {
      if (slot.subagentId === paneId) {
        resourcePool.releaseSlot(slot.slotId);
        slotsReleased += 1;
      }
    }
  } catch {
    /* non-fatal */
  }

  return NextResponse.json(
    {
      ok: true,
      workstreamId,
      paneId,
      previousStatus: abortResult.previousStatus,
      status: abortResult.status,
      unchanged: abortResult.status === 'unchanged',
      slotsReleased,
      fleetId,
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
