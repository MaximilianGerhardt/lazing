/**
 * Auto-dispatch (Phase AD · 2026-04-26).
 *
 * Reacts to 'updated' events:
 *   1. Master approval (workflowState='approved' + parent IS NULL +
 *      sub-tickets present) -> dispatch all sub-tickets to
 *      executing state, spawn a 3-stage pipeline per sub.
 *   2. Sub closed (workflowState='closed' + parent IS NOT NULL) ->
 *      check whether all siblings are also closed. If so:
 *      set master to workflowState='closed'.
 *
 * Loop guards:
 *   - LAZYOS_DISABLE_AUTO_DISPATCH=1 -> hard skip
 *   - payload.transition === 'auto_dispatch' -> echo, skip
 *   - payload.transition === 'auto_close_after_subs' -> echo, skip
 *   - max 50 sub-tickets per master (runaway cap)
 *
 * Called from emit.ts via queueMicrotask, NEVER blocking.
 * Never call a function from within auto-dispatch that itself
 * synchronously fires emitEvent and thereby triggers maybeAutoDispatch
 * again without a transition marker.
 */

import { and, asc, eq, gte, like } from 'drizzle-orm';

import { getDb } from '../../db/client';
import { events as eventsTable } from '../../db/schema/events';
import { getWorkspace } from '../workspaces';
import type { LazyEvent } from '../events/types';
import { emitEvent } from '../events/emit';
import { spawnSubTicketPipeline } from '../../server/agents/auto-dispatch-spawner';
import { workspaceIsSandbox } from '../workspaces/sandbox';

const MAX_SUB_TICKETS_PER_MASTER = 50;

interface SubTicketInfo {
  id: string;
  title: string;
  body: string;
  workstreamId?: string;
  parentMasterId: string;
  workspaceId: string;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * ULID validator: 26-character Crockford Base32. Used to
 * sanitize IDs before they are built into LIKE clauses — prevents
 * LIKE injection (% / _ / \) in re-run idempotency checks.
 *
 * Sub-Plan A Critic Finding 1 (2026-04-29).
 */
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

function safeUlid(s: string | null | undefined): string | null {
  return typeof s === 'string' && ULID_RE.test(s) ? s : null;
}

function isAutoDispatchDisabled(): boolean {
  return process.env.LAZYOS_DISABLE_AUTO_DISPATCH === '1';
}

/**
 * Sub-Plan B (2026-04-30) — [skip-mirror] echo guard.
 *
 * If a `commented`/`created` event carries a `[skip-mirror]` marker in the body
 * (text/messageSubject/body/commitMessage), it is an auto-mirror echo
 * triggered by the sub-agent spawner (e.g. a git watcher
 * that mirrors commits into the chat). These events MUST NOT trigger any
 * auto-dispatch logic — otherwise a loop arises:
 *   senior-dev commit -> watcher emit -> auto-dispatch -> spawn -> ...
 *
 * Purely defensive — the marker is set by the senior-dev build-mode prompt
 * (`git commit -m "[skip-mirror] ..."`).
 */
function hasSkipMirrorMarker(payload: Record<string, unknown>): boolean {
  const candidates: unknown[] = [
    payload.text,
    payload.body,
    payload.messageSubject,
    payload.message,
    payload.commitMessage,
    payload.subject,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.includes('[skip-mirror]')) return true;
  }
  return false;
}

/**
 * Public helper: check whether an event carries the [skip-mirror] marker.
 * Also used in tests; export surface deliberately small.
 */
export function isSkipMirrorEvent(event: LazyEvent): boolean {
  if (event.eventType !== 'commented' && event.eventType !== 'created') {
    return false;
  }
  const payload = event.payload ?? {};
  return hasSkipMirrorMarker(payload);
}

/**
 * Reads the latest (by createdAt) projection of a ticket from the
 * event log: workflowState, parentTicketId, sub-title, body. We
 * use a narrow custom path instead of the full projectTicket
 * because here we only need 4 fields and not the whole
 * sub-aggregation lookup.
 */
function readTicketSnapshot(ticketId: string): {
  workflowState?: string;
  parentTicketId?: string;
  title: string;
  body: string;
  workstreamId?: string;
  segmentId: string;
  closed: boolean;
} | null {
  const db = getDb();
  const rows = db
    .select()
    .from(eventsTable)
    .where(
      and(eq(eventsTable.entityType, 'ticket'), eq(eventsTable.entityId, ticketId)),
    )
    .orderBy(asc(eventsTable.createdAt))
    .all();
  if (rows.length === 0) return null;

  let title = '';
  let body = '';
  let workflowState: string | undefined;
  let parentTicketId: string | undefined;
  let workstreamId: string | undefined;
  let segmentId = '';
  let closed = false;

  for (const row of rows) {
    segmentId = row.segmentId;
    let p: Record<string, unknown> = {};
    try {
      p = JSON.parse(row.payload) as Record<string, unknown>;
    } catch {
      continue;
    }
    const t = asString(p.title);
    if (t) title = t;
    const b = asString(p.body);
    if (b) body = b;
    const ws = asString(p.workflowState);
    if (ws) workflowState = ws;
    const par = asString(p.parentTicketId);
    if (par) parentTicketId = par;
    const wsid = asString(p.workstreamId);
    if (wsid) workstreamId = wsid;
    if (row.eventType === 'closed') closed = true;
  }

  return {
    workflowState,
    parentTicketId,
    title,
    body,
    workstreamId,
    segmentId,
    closed,
  };
}

/**
 * Finds sub-tickets of a master via JSON LIKE on payload —
 * consistent with projectTicket().subTicketIds logic.
 * Filters out closed/done.
 */
function findSubTickets(
  masterTicketId: string,
  workspaceId: string,
): SubTicketInfo[] {
  const db = getDb();
  const rows = db
    .select({ entityId: eventsTable.entityId })
    .from(eventsTable)
    .where(
      and(
        eq(eventsTable.entityType, 'ticket'),
        like(eventsTable.payload, `%"parentTicketId":"${masterTicketId}"%`),
      ),
    )
    .all();

  const ids = Array.from(new Set(rows.map((r) => r.entityId)));
  const subs: SubTicketInfo[] = [];
  for (const id of ids) {
    if (id === masterTicketId) continue;
    const snap = readTicketSnapshot(id);
    if (!snap) continue;
    if (snap.closed) continue;
    if (snap.workflowState === 'closed') continue;
    if (snap.workflowState === 'executing') continue; // already dispatched

    subs.push({
      id,
      title: snap.title || `Sub-Ticket ${id}`,
      body: snap.body || '(kein Body)',
      workstreamId: snap.workstreamId,
      parentMasterId: masterTicketId,
      workspaceId: snap.segmentId || workspaceId,
    });
    if (subs.length >= MAX_SUB_TICKETS_PER_MASTER) break;
  }
  return subs;
}

/**
 * Resolves the workspace path for tmux spawns. Falls back to
 * `<projectsRoot>/<workspaceId>` when there is no DB entry.
 */
async function resolveWorkspacePath(workspaceId: string): Promise<string> {
  try {
    const ws = await getWorkspace(workspaceId);
    if (ws?.path) return ws.path;
  } catch {
    // ignore — fallback below
  }
  const { defaultWorkspacePath } = await import("@/lib/workspaces/projects-root");
  return defaultWorkspacePath(workspaceId);
}

/**
 * Trigger condition master approval:
 *   - eventType === 'updated'
 *   - payload.workflowState === 'approved'
 *   - no parent_ticket_id
 *   - at least 1 sub-ticket present
 *   - no 'auto_dispatch' echo
 *
 * On match: dispatch sub-tickets + spawn pipelines.
 */
export async function maybeAutoDispatch(event: LazyEvent): Promise<void> {
  if (isAutoDispatchDisabled()) return;
  if (event.entityType !== 'ticket') return;
  // Sub-Plan B: skip-mirror echo guard for commented/created events.
  // Even though the main path only processes 'updated', a generic
  // guard is defense-in-depth for future extensions.
  if (isSkipMirrorEvent(event)) return;
  if (event.eventType !== 'updated') return;

  const payload = event.payload ?? {};
  const workflowState = asString(payload.workflowState);
  if (workflowState !== 'approved') return;

  // Echo protection: this update comes from ourselves (auto_dispatch transition)
  const transition = asString(payload.transition);
  if (transition === 'auto_dispatch' || transition === 'auto_close_after_subs') {
    return;
  }

  // Sub-Plan G (2026-04-30): lock-token check. If the event carries a
  // `dispatchLockToken`, we check whether it still matches the current
  // workstream lock. Mismatch = a newer dispatch acquired the
  // lock or the lock was cleared (master closed) —
  // this event is stale, skip so we don't spawn twice.
  const payloadLockToken = asString(payload.dispatchLockToken);
  const payloadWorkstreamId = asString(payload.workstreamId);
  if (payloadLockToken && payloadWorkstreamId) {
    try {
      const db = getDb();
      const row = db.$raw
        .prepare(
          'SELECT dispatch_lock_token FROM workstreams WHERE id = ?',
        )
        .get(payloadWorkstreamId) as
        | { dispatch_lock_token: string | null }
        | undefined;
      const currentToken = row?.dispatch_lock_token ?? null;
      if (currentToken && currentToken !== payloadLockToken) {
        console.log(
          `[auto-dispatch] stale-token-skip ws=${payloadWorkstreamId} payload=${payloadLockToken.slice(0, 6)} current=${currentToken.slice(0, 6)}`,
        );
        return;
      }
      // currentToken === null → lock was cleared (master closed) → skip.
      if (!currentToken) {
        console.log(
          `[auto-dispatch] cleared-lock-skip ws=${payloadWorkstreamId} payload=${payloadLockToken.slice(0, 6)}`,
        );
        return;
      }
    } catch {
      // Lock check is non-fatal — on a DB edge error, keep going.
    }
  }

  const masterTicketId = event.entityId;
  const masterSnap = readTicketSnapshot(masterTicketId);
  if (!masterSnap) return;
  // Master only (no parent)
  if (masterSnap.parentTicketId) return;

  const subs = findSubTickets(masterTicketId, event.segmentId);
  if (subs.length === 0) return;
  if (subs.length > MAX_SUB_TICKETS_PER_MASTER) {
    console.warn(
      `[auto-dispatch] Master ${masterTicketId} hat ${subs.length} Subs — capped auf ${MAX_SUB_TICKETS_PER_MASTER}`,
    );
  }

  const workspacePath = await resolveWorkspacePath(event.segmentId);

  console.log(
    `[auto-dispatch] Master ${masterTicketId} approved — dispatching ${subs.length} Sub-Tickets`,
  );

  // Phase WSC.1 (2026-04-26): ONE overview event on the master so the chat
  // renders a live-pipeline card. Per-sub-ticket toasts (auto_dispatch
  // transition) remain — the card consumes them as live updates.
  //
  // Sub-Plan A (2026-04-29) — LIKE idempotency analogous to
  // emitIteratePipelineCardIfAbsent: if an
  // auto-dispatch-overview comment for the same (workstreamId,
  // masterTicketId) coord already exists in the last 24h, we skip the emit. This
  // way, re-runs (e.g. after a stage-failure retry) don't pile up new
  // live-pipeline cards in the chat.
  const overviewWorkstreamId = subs[0]?.workstreamId ?? '';
  if (overviewWorkstreamId) {
    try {
      const dbForCheck = getDb();
      const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
      // Sub-Plan A Finding 1 (2026-04-29): split LIKE into two separate
      // clauses (robust to JSON-key order) and sanitize both IDs as
      // ULID before they go into the LIKE pattern. On invalid
      // format: skip the idempotency check (= emit normally, no block).
      const wsIdSafe = safeUlid(overviewWorkstreamId);
      const masterIdSafe = safeUlid(masterTicketId);
      let skipDueToIdempotency = false;
      if (wsIdSafe && masterIdSafe) {
        const existing = dbForCheck
          .select({ id: eventsTable.id })
          .from(eventsTable)
          .where(
            and(
              eq(eventsTable.entityType, 'ticket'),
              eq(eventsTable.entityId, masterTicketId),
              eq(eventsTable.eventType, 'commented'),
              gte(eventsTable.createdAt, oneDayAgo),
              like(eventsTable.payload, `%"kind":"auto-dispatch-overview"%`),
              like(eventsTable.payload, `%"workstreamId":"${wsIdSafe}"%`),
              like(eventsTable.payload, `%"masterTicketId":"${masterIdSafe}"%`),
            ),
          )
          .limit(1)
          .all();
        skipDueToIdempotency = existing.length > 0;
      }
      if (skipDueToIdempotency) {
        console.log(
          `[auto-dispatch] overview-skip (idempotency hit) master=${masterTicketId} ws=${overviewWorkstreamId}`,
        );
      } else {
        await emitEvent({
          segmentId: event.segmentId,
          entityType: 'ticket',
          entityId: masterTicketId,
          eventType: 'commented',
          actor: 'agent:auto-dispatch',
          payload: {
            kind: 'auto-dispatch-overview',
            workstreamId: overviewWorkstreamId,
            masterTicketId,
            subTickets: subs.slice(0, MAX_SUB_TICKETS_PER_MASTER).map((s) => ({
              id: s.id,
              title: s.title,
            })),
          },
          sensitivity: 'low',
        });
      }
    } catch (err) {
      console.warn(
        '[auto-dispatch] overview-emit failed:',
        err instanceof Error ? err.message : String(err),
      );
    }
  } else {
    // Workstream-less master (should be rare) — emit without an idempotency
    // check, because the LIKE coord without workstreamId would not be unique.
    await emitEvent({
      segmentId: event.segmentId,
      entityType: 'ticket',
      entityId: masterTicketId,
      eventType: 'commented',
      actor: 'agent:auto-dispatch',
      payload: {
        kind: 'auto-dispatch-overview',
        workstreamId: '',
        masterTicketId,
        subTickets: subs.slice(0, MAX_SUB_TICKETS_PER_MASTER).map((s) => ({
          id: s.id,
          title: s.title,
        })),
      },
      sensitivity: 'low',
    }).catch((err) => {
      console.warn(
        '[auto-dispatch] overview-emit failed:',
        err instanceof Error ? err.message : String(err),
      );
    });
  }

  // Phase RA.4 — sniper hook in auto-dispatch: before we start the sub-spawns,
  // we give the user a pause window to inject. Default 25s,
  // overridable via ENV LAZYOS_AUTODISPATCH_PAUSE_MS (=0 disables).
  //
  // V3 wire-point 3 (2026-05-01): in sandbox workspaces we skip
  // the pause entirely. Sandbox = "free hand ON the playing field" → no
  // 25s friction step, sub-pipelines start directly.
  const pauseMsRaw = (process.env.LAZYOS_AUTODISPATCH_PAUSE_MS ?? '25000').trim();
  let pauseMs = Math.max(0, Math.min(120000, parseInt(pauseMsRaw, 10) || 0));
  try {
    if (pauseMs > 0 && (await workspaceIsSandbox(event.segmentId))) {
      pauseMs = 0;
    }
  } catch {
    // Sandbox check is non-fatal — on a DB edge error, default pause.
  }
  if (pauseMs > 0) {
    const pauseStartedAt = Date.now();
    await emitEvent({
      segmentId: subs[0]?.workspaceId ?? 'lazyos',
      entityType: 'ticket',
      entityId: masterTicketId,
      eventType: 'commented',
      actor: 'agent:auto-dispatch',
      payload: {
        kind: 'auto-dispatch-pause',
        workstreamId: subs[0]?.workstreamId ?? '',
        masterTicketId,
        pauseStartedAt,
        pauseDurationMs: pauseMs,
        subCount: subs.length,
      },
      sensitivity: 'low',
    }).catch(() => undefined);

    const { waitForSniperPause } = await import(
      '../../server/agents/tier-orchestrator'
    );
    const corrections = await waitForSniperPause(
      masterTicketId,
      pauseStartedAt,
      pauseMs,
    );
    if (corrections > 0) {
      // User pressed "stop anyway" or inject → STOP auto-dispatch.
      // Don't start the sub-spawns anymore. User can re-approve the
      // master or trigger the subs manually.
      await emitEvent({
        segmentId: subs[0]?.workspaceId ?? 'lazyos',
        entityType: 'ticket',
        entityId: masterTicketId,
        eventType: 'commented',
        actor: 'agent:auto-dispatch',
        payload: {
          kind: 'auto-dispatch-cancelled',
          masterTicketId,
          reason: 'user-correction-during-pause',
          corrections,
        },
        sensitivity: 'low',
      }).catch(() => undefined);
      return;
    }
  }

  // Start pipelines in parallel per sub-ticket. Within a pipeline
  // the 3 stages run sequentially (see spawnSubTicketPipeline).
  // Each pipeline is tmux-isolated, no Promise.all awaiting in the
  // caller needed — we fire and forget with an error catch.
  for (const sub of subs.slice(0, MAX_SUB_TICKETS_PER_MASTER)) {
    void spawnSubTicketPipeline({
      workspaceId: sub.workspaceId,
      workspacePath,
      subTicketId: sub.id,
      masterTicketId,
      workstreamId: sub.workstreamId,
      subTicketTitle: sub.title,
      subTicketBody: sub.body,
    }).catch((err) => {
      console.error(
        `[auto-dispatch] pipeline failed for sub ${sub.id}:`,
        err instanceof Error ? err.message : String(err),
      );
    });
  }
}

/**
 * Master auto-close after all sub-tickets are closed.
 *   - eventType === 'updated' AND payload.workflowState === 'closed'
 *   - ticket has a parent_ticket_id
 *   - no 'auto_close_after_subs' echo
 *
 * On match: check the master of the sub-ticket whether all siblings are
 * closed. If so: set the master to workflowState='closed' with
 * transition='auto_close_after_subs'.
 */
export async function maybeAutoCloseMaster(event: LazyEvent): Promise<void> {
  if (isAutoDispatchDisabled()) return;
  if (event.entityType !== 'ticket') return;
  if (isSkipMirrorEvent(event)) return;
  if (event.eventType !== 'updated') return;

  const payload = event.payload ?? {};
  const workflowState = asString(payload.workflowState);
  if (workflowState !== 'closed') return;

  const transition = asString(payload.transition);
  if (transition === 'auto_close_after_subs') return;

  const subTicketId = event.entityId;
  const subSnap = readTicketSnapshot(subTicketId);
  if (!subSnap) return;
  const masterTicketId = subSnap.parentTicketId;
  if (!masterTicketId) return; // not a sub

  // Check the master state — if it is already 'closed', nothing to do
  const masterSnap = readTicketSnapshot(masterTicketId);
  if (!masterSnap) return;
  if (masterSnap.workflowState === 'closed' || masterSnap.closed) return;

  // Fetch all sibling subs, check whether ALL are closed
  const allSubs = findAllSubTicketSnapshots(masterTicketId);
  if (allSubs.length === 0) return;
  const allClosed = allSubs.every(
    (s) => s.workflowState === 'closed' || s.closed,
  );
  if (!allClosed) return;

  console.log(
    `[auto-dispatch] Alle ${allSubs.length} Subs von Master ${masterTicketId} closed — schliesse Master`,
  );

  await emitEvent({
    segmentId: masterSnap.segmentId || event.segmentId,
    entityType: 'ticket',
    entityId: masterTicketId,
    eventType: 'updated',
    actor: 'system',
    payload: {
      workflowState: 'closed',
      transition: 'auto_close_after_subs',
      subTicketsTotal: allSubs.length,
      subTicketsClosed: allSubs.length,
      ...(subSnap.workstreamId ? { workstreamId: subSnap.workstreamId } : {}),
    },
    sensitivity: 'low',
  }).catch((err) => {
    console.error('[auto-dispatch] master auto-close emit failed:', err);
  });

  // Sub-Plan G (2026-04-30): clear the lock on the workstream — otherwise
  // a future re-run hangs for 60 s. Idempotent: a workstream without a lock
  // is simply skipped.
  if (subSnap.workstreamId) {
    try {
      const db = getDb();
      db.$raw
        .prepare(
          'UPDATE workstreams SET dispatch_lock_token = NULL, dispatch_lock_ts = NULL WHERE id = ?',
        )
        .run(subSnap.workstreamId);
    } catch (err) {
      console.warn('[auto-dispatch] lock-clear failed:', err);
    }
  }
}

/**
 * Snapshots of all sub-tickets of a master (including closed) — for the
 * auto-close check.
 */
function findAllSubTicketSnapshots(
  masterTicketId: string,
): Array<{
  id: string;
  workflowState?: string;
  closed: boolean;
}> {
  const db = getDb();
  const rows = db
    .select({ entityId: eventsTable.entityId })
    .from(eventsTable)
    .where(
      and(
        eq(eventsTable.entityType, 'ticket'),
        like(eventsTable.payload, `%"parentTicketId":"${masterTicketId}"%`),
      ),
    )
    .all();
  const ids = Array.from(new Set(rows.map((r) => r.entityId))).filter(
    (i) => i !== masterTicketId,
  );
  const out: Array<{ id: string; workflowState?: string; closed: boolean }> = [];
  for (const id of ids) {
    const snap = readTicketSnapshot(id);
    if (!snap) continue;
    out.push({ id, workflowState: snap.workflowState, closed: snap.closed });
  }
  return out;
}
