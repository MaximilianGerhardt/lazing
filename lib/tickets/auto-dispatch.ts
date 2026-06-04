/**
 * Auto-Dispatch (Phase AD · 2026-04-26).
 *
 * Reagiert auf 'updated'-Events:
 *   1. Master-Approval (workflowState='approved' + parent IS NULL +
 *      Sub-Tickets vorhanden) -> dispatch alle Sub-Tickets in
 *      executing-state, spawn 3-Stage-Pipeline pro Sub.
 *   2. Sub-Closed (workflowState='closed' + parent IS NOT NULL) ->
 *      pruefe ob alle Geschwister auch closed sind. Wenn ja:
 *      Master auf workflowState='closed' setzen.
 *
 * Loop-Guards:
 *   - LAZYOS_DISABLE_AUTO_DISPATCH=1 -> hard skip
 *   - payload.transition === 'auto_dispatch' -> Echo, skip
 *   - payload.transition === 'auto_close_after_subs' -> Echo, skip
 *   - max 50 Sub-Tickets pro Master (runaway-cap)
 *
 * Wird aus emit.ts via queueMicrotask aufgerufen, NIE blocking.
 * Niemals aus auto-dispatch heraus eine Funktion aufrufen die selbst
 * synchron emitEvent feuert und somit erneut maybeAutoDispatch
 * triggert ohne transition-Marker.
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
 * ULID-Validator: 26-Zeichen Crockford Base32. Wird genutzt um IDs zu
 * sanitizen bevor sie in LIKE-Klauseln eingebaut werden — verhindert
 * LIKE-Injection (% / _ / \) bei Re-Run-Idempotenz-Checks.
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
 * Sub-Plan B (2026-04-30) — [skip-mirror]-Echo-Guard.
 *
 * Wenn ein `commented`/`created`-Event einen `[skip-mirror]`-Marker im Body
 * (text/messageSubject/body/commitMessage) traegt, ist es ein vom
 * Sub-Agent-Spawner ausgeloester Auto-Mirror-Echo (z.B. ein git-Watcher
 * der Commits ins Chat spiegelt). Diese Events DUERFEN keine Auto-Dispatch-
 * Logik triggern — sonst entsteht ein Loop:
 *   senior-dev commit -> watcher emit -> auto-dispatch -> spawn -> ...
 *
 * Pure defensive — der Marker wird vom senior-dev-Build-Mode-Prompt
 * vorgegeben (`git commit -m "[skip-mirror] ..."`).
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
 * Public Helper: pruefen ob ein Event den [skip-mirror]-Marker traegt.
 * Wird auch in tests genutzt; export-Surface bewusst klein.
 */
export function isSkipMirrorEvent(event: LazyEvent): boolean {
  if (event.eventType !== 'commented' && event.eventType !== 'created') {
    return false;
  }
  const payload = event.payload ?? {};
  return hasSkipMirrorMarker(payload);
}

/**
 * Liest die letzte (per createdAt) Projection eines Tickets aus dem
 * Event-Log: workflowState, parentTicketId, sub-Title, Body. Wir
 * nutzen einen schmalen Eigen-Path statt der vollen projectTicket
 * weil wir hier nur 4 Felder brauchen und nicht den ganzen
 * Sub-Aggregations-Lookup.
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
 * Findet Sub-Tickets eines Masters via JSON-LIKE auf payload —
 * konsistent mit projectTicket().subTicketIds-Logik.
 * Filtert closed/done aus.
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
    if (snap.workflowState === 'executing') continue; // schon dispatched

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
    // ignore — Fallback unten
  }
  const { defaultWorkspacePath } = await import("@/lib/workspaces/projects-root");
  return defaultWorkspacePath(workspaceId);
}

/**
 * Trigger-Bedingung Master-Approval:
 *   - eventType === 'updated'
 *   - payload.workflowState === 'approved'
 *   - kein parent_ticket_id
 *   - mindestens 1 Sub-Ticket vorhanden
 *   - kein 'auto_dispatch'-Echo
 *
 * Bei Match: Sub-Tickets dispatchen + Pipelines spawnen.
 */
export async function maybeAutoDispatch(event: LazyEvent): Promise<void> {
  if (isAutoDispatchDisabled()) return;
  if (event.entityType !== 'ticket') return;
  // Sub-Plan B: skip-mirror-Echo-Guard fuer commented/created-Events.
  // Auch wenn der Hauptpfad nur 'updated' verarbeitet, ein generischer
  // Guard ist Defense-In-Depth fuer kuenftige Erweiterungen.
  if (isSkipMirrorEvent(event)) return;
  if (event.eventType !== 'updated') return;

  const payload = event.payload ?? {};
  const workflowState = asString(payload.workflowState);
  if (workflowState !== 'approved') return;

  // Echo-Schutz: dieses Update kommt von uns selbst (auto_dispatch transition)
  const transition = asString(payload.transition);
  if (transition === 'auto_dispatch' || transition === 'auto_close_after_subs') {
    return;
  }

  // Sub-Plan G (2026-04-30): Lock-Token-Check. Wenn der Event einen
  // `dispatchLockToken` mitführt, prüfen wir ob er noch dem aktuellen
  // Workstream-Lock entspricht. Mismatch = ein neuerer Dispatch hat den
  // Lock erworben oder der Lock wurde gecleart (Master geschlossen) —
  // dieser Event ist stale, skip damit wir nicht doppelt spawnen.
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
      // currentToken === null → Lock wurde gecleart (Master closed) → skip.
      if (!currentToken) {
        console.log(
          `[auto-dispatch] cleared-lock-skip ws=${payloadWorkstreamId} payload=${payloadLockToken.slice(0, 6)}`,
        );
        return;
      }
    } catch {
      // Lock-Check ist nicht-fatal — bei DB-Edge-Fehler weiterlaufen.
    }
  }

  const masterTicketId = event.entityId;
  const masterSnap = readTicketSnapshot(masterTicketId);
  if (!masterSnap) return;
  // Nur Master (kein parent)
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

  // Phase WSC.1 (2026-04-26): EIN Overview-Event am Master damit der Chat
  // eine Live-Pipeline-Card rendert. Pro-Sub-Ticket-Toasts (auto_dispatch
  // transition) bleiben — die Card konsumiert die als Live-Updates.
  //
  // Sub-Plan A (2026-04-29) — LIKE-Idempotenz analog zu
  // emitIteratePipelineCardIfAbsent: wenn in den letzten 24h bereits eine
  // auto-dispatch-overview-comment fuer denselben (workstreamId,
  // masterTicketId)-Coord existiert, skippen wir das Emit. So entstehen
  // bei Re-Runs (z.B. nach Stage-Failure-Retry) nicht stapelweise neue
  // live-pipeline-Cards im Chat.
  const overviewWorkstreamId = subs[0]?.workstreamId ?? '';
  if (overviewWorkstreamId) {
    try {
      const dbForCheck = getDb();
      const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
      // Sub-Plan A Finding 1 (2026-04-29): Splitte LIKE auf zwei separate
      // Klauseln (JSON-Key-Reihenfolge-robust) und sanitize beide IDs als
      // ULID bevor sie in den LIKE-Pattern wandern. Bei ungueltigem
      // Format: skip Idempotency-Check (= emit normal, kein Block).
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
    // Workstream-less master (sollte selten sein) — emit ohne Idempotenz-
    // Check, weil die LIKE-Coord ohne workstreamId nicht eindeutig waere.
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

  // Phase RA.4 — Sniper-Hook in Auto-Dispatch: bevor wir die Sub-Spawns
  // starten, geben wir dem User ein Pause-Window zum Inject. Default 25s,
  // via ENV LAZYOS_AUTODISPATCH_PAUSE_MS überschreibbar (=0 deaktiviert).
  //
  // V3 Wire-Punkt 3 (2026-05-01): in Sandbox-Workspaces überspringen wir
  // die Pause komplett. Sandbox = „freie Hand IM Spielfeld" → kein
  // 25s-Friction-Schritt, Sub-Pipelines starten direkt.
  const pauseMsRaw = (process.env.LAZYOS_AUTODISPATCH_PAUSE_MS ?? '25000').trim();
  let pauseMs = Math.max(0, Math.min(120000, parseInt(pauseMsRaw, 10) || 0));
  try {
    if (pauseMs > 0 && (await workspaceIsSandbox(event.segmentId))) {
      pauseMs = 0;
    }
  } catch {
    // Sandbox-Check ist nicht-fatal — bei DB-Edge-Fehler Standardpause.
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
      // User hat „Trotzdem stoppen" oder Inject gedrückt → Auto-Dispatch
      // STOPPEN. Sub-Spawns nicht mehr starten. User kann Master neu
      // approven oder die Subs manuell triggern.
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

  // Pipelines parallel pro Sub-Ticket starten. Innerhalb einer Pipeline
  // laufen die 3 Stages sequentiell (siehe spawnSubTicketPipeline).
  // Jede Pipeline ist tmux-isoliert, kein Promise.all-Awaiting im
  // Caller noetig — wir feuern und vergessen mit Error-Catch.
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
 * Master-Auto-Close nach allen Sub-Tickets closed.
 *   - eventType === 'updated' UND payload.workflowState === 'closed'
 *   - Ticket hat parent_ticket_id
 *   - kein 'auto_close_after_subs'-Echo
 *
 * Bei Match: Master des Sub-Tickets pruefen, ob alle Geschwister closed
 * sind. Wenn ja: Master auf workflowState='closed' setzen mit
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
  if (!masterTicketId) return; // kein Sub

  // Master-State pruefen — wenn er bereits 'closed' ist, nichts zu tun
  const masterSnap = readTicketSnapshot(masterTicketId);
  if (!masterSnap) return;
  if (masterSnap.workflowState === 'closed' || masterSnap.closed) return;

  // Alle Geschwister-Subs holen, pruefen ob ALLE closed
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

  // Sub-Plan G (2026-04-30): Lock auf dem Workstream clearen — sonst hängt
  // ein zukünftiger Re-Run für 60 s fest. Idempotent: Workstream ohne Lock
  // wird einfach übersprungen.
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
 * Snapshots aller Sub-Tickets eines Masters (auch closed) — fuer
 * Auto-Close-Check.
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
