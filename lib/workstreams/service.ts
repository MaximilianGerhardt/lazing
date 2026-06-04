/**
 * Workstream service (phase W).
 *
 * Workstream = container for a user request. Contains the master plan ticket,
 * sub-tickets (via event-sourced parent_ticket_id), a primary Claude
 * session, and a tier mix for multi-agent spawn (phase A follows).
 *
 * Write access goes through this service. Tickets are NOT updated
 * directly — we emit `workstream_attached` events on the ticket so
 * the projection stays clean (event-sourced like everything else).
 */

import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';

import { getDb } from '../../db/client';
import { workstreams, type WorkstreamRow } from '../../db/schema/workstreams';
import { emitEvent } from '../events/emit';
import type { ActorType, WorkspaceId } from '../events/types';
import { ulid } from '../ulid';
import {
  classifyFromInput,
  isValidIntent,
  normalizeIntent,
  type WorkstreamIntent,
} from './intent-classifier';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WorkstreamStatus =
  | 'active'
  | 'paused'
  | 'done'
  | 'archived'
  | 'stuck';

export interface TierMix {
  opus: number;
  sonnet: number;
  haiku: number;
}

export interface Workstream {
  id: string;
  workspaceId: WorkspaceId;
  name: string;
  primarySessionId: string | null;
  primaryTicketId: string | null;
  tierMix: TierMix | null;
  status: WorkstreamStatus;
  costCents: number;
  qualityScore: number | null;
  description: string | null;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  // Phase Sub-WS (sprint C, 2026-04-29) — first-class sub-workstream fields.
  parentWorkstreamId: string | null;
  role: string | null;
  tmuxSessionId: string | null;
  tokensIn: number;
  tokensOut: number;
  costCentsAggregated: number;
  /**
   * 2026-05-01 — intent marker (idea | implementation | bug-fix | question
   * | discussion). NULL in the DB → 'discussion' on read.
   */
  intent: WorkstreamIntent;
}

/**
 * Sub-workstream role. An enum hint, but string-typed because new roles
 * can be added at any time without a migration.
 */
export type SubWorkstreamRole =
  | 'iterate-lead'
  | 'iterate-lead-v2'
  | 'iterate-lead-v3'
  | 'iterate-lead-v4'
  | 'iterate-lead-v5'
  | 'iterate-roaster-1'
  | 'iterate-roaster-2'
  | 'iterate-resume-lead'
  | 'iterate-resume-roaster'
  | 'tier-spawn'
  | 'synthesis'
  | 'auto-dispatch-senior-dev'
  | 'auto-dispatch-code-reviewer'
  | 'auto-dispatch-critic'
  | 'cross-roast'
  | 'sub-plan-sniper'
  | (string & {});

/** Sub-workstream status. Its own enum because of sub-specific states. */
export type SubWorkstreamStatus =
  | 'pending'
  | 'running'
  | 'done'
  | 'failed'
  | 'rate_limited'
  | 'stuck';

export interface CreateWorkstreamInput {
  workspaceId: WorkspaceId;
  name: string;
  description?: string;
  primarySessionId?: string;
  primaryTicketId?: string;
  tierMix?: TierMix;
  /** Default actor `user:max`. */
  actor?: ActorType;
  /**
   * Optional explicit intent. When not set, we classify it
   * automatically from name+description via the intent classifier (sync, heuristic).
   */
  intent?: WorkstreamIntent;
}

export interface UpdateWorkstreamInput {
  name?: string;
  description?: string;
  primarySessionId?: string | null;
  primaryTicketId?: string | null;
  tierMix?: TierMix | null;
  status?: WorkstreamStatus;
  costCents?: number;
  qualityScore?: number | null;
  /**
   * 2026-05-01 — the user can correct the intent after the fact when the
   * auto-classification was off (e.g. "schreib mir die Idee als bug-fix
   * auf" — the heuristic classifies idea, the user says no, this is bug-fix).
   */
  intent?: WorkstreamIntent;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Phase ORG (2026-04-27): default `system` instead of a `user:max` fake.
const DEFAULT_ACTOR: ActorType = 'system';

export function newWorkstreamId(now: number = Date.now()): string {
  return `WS-${ulid(now)}`;
}

function rowToWorkstream(row: WorkstreamRow): Workstream {
  let tierMix: TierMix | null = null;
  if (row.tierMix) {
    try {
      const parsed = JSON.parse(row.tierMix) as TierMix;
      if (
        typeof parsed.opus === 'number' &&
        typeof parsed.sonnet === 'number' &&
        typeof parsed.haiku === 'number'
      ) {
        tierMix = parsed;
      }
    } catch {
      /* malformed — ignore */
    }
  }
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    primarySessionId: row.primarySessionId,
    primaryTicketId: row.primaryTicketId,
    tierMix,
    status: (row.status as WorkstreamStatus) ?? 'active',
    costCents: row.costCents,
    qualityScore: row.qualityScore,
    description: row.description,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    archivedAt: row.archivedAt,
    parentWorkstreamId: row.parentWorkstreamId ?? null,
    role: row.role ?? null,
    tmuxSessionId: row.tmuxSessionId ?? null,
    tokensIn: row.tokensIn ?? 0,
    tokensOut: row.tokensOut ?? 0,
    costCentsAggregated: row.costCentsAggregated ?? 0,
    intent: normalizeIntent(row.intent ?? null),
  };
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createWorkstream(
  input: CreateWorkstreamInput,
): Promise<Workstream> {
  const db = getDb();
  const now = Date.now();
  const id = newWorkstreamId(now);

  // 2026-05-01 — intent classification. An explicit choice via input.intent
  // wins; otherwise the sync heuristic from name + description. Sync is
  // sufficient because no LLM latency is acceptable in the hot path; the
  // fallback path would trigger a tier spawn and is for later
  // (a separate reclassify hook).
  const explicitIntent =
    input.intent && isValidIntent(input.intent) ? input.intent : null;
  const classified = explicitIntent
    ? { intent: explicitIntent, confidence: 1, matched: [], fallbackUsed: false }
    : classifyFromInput({ name: input.name, description: input.description });
  const finalIntent: WorkstreamIntent = classified.intent;

  db.insert(workstreams)
    .values({
      id,
      workspaceId: input.workspaceId,
      name: input.name,
      primarySessionId: input.primarySessionId ?? null,
      primaryTicketId: input.primaryTicketId ?? null,
      tierMix: input.tierMix ? JSON.stringify(input.tierMix) : null,
      status: 'active',
      costCents: 0,
      qualityScore: null,
      description: input.description ?? null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      intent: finalIntent,
    })
    .run();

  // Audit event — workstream_created (custom event type; we lean on
  // generic 'created' to not break any new EventType whitelist).
  await emitEvent({
    segmentId: input.workspaceId,
    entityType: 'workspace', // closest passing existing type
    entityId: id,
    eventType: 'created',
    actor: input.actor ?? DEFAULT_ACTOR,
    payload: {
      kind: 'workstream',
      name: input.name,
      tierMix: input.tierMix ?? null,
      primarySessionId: input.primarySessionId ?? null,
      primaryTicketId: input.primaryTicketId ?? null,
      intent: finalIntent,
      intentSource: explicitIntent ? 'explicit' : 'auto-classified',
      intentConfidence: classified.confidence,
    },
    sensitivity: 'low',
  });

  const row = db
    .select()
    .from(workstreams)
    .where(eq(workstreams.id, id))
    .get();
  if (!row) throw new Error(`createWorkstream: row missing for ${id}`);
  return rowToWorkstream(row);
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export async function getWorkstream(id: string): Promise<Workstream | null> {
  const db = getDb();
  const row = db
    .select()
    .from(workstreams)
    .where(eq(workstreams.id, id))
    .get();
  return row ? rowToWorkstream(row) : null;
}

export interface ListOptions {
  workspaceId?: WorkspaceId;
  /**
   * Phase IA.5 — org filter. When set AND no workspaceId: only
   * workstreams from workspaces of this org.
   */
  orgId?: string;
  status?: WorkstreamStatus | 'all';
  limit?: number;
  /**
   * Sprint C (P0-1, 2026-04-29) — default `true`: only master workstreams
   * (parent_workstream_id IS NULL). Set to `false` for tree views.
   * Prevents the leak of sub-workstreams into the /workstreams kanban.
   */
  rootOnly?: boolean;
}

export async function listWorkstreams(
  opts: ListOptions = {},
): Promise<Workstream[]> {
  const db = getDb();
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);

  const filters = [];
  if (opts.workspaceId) {
    filters.push(eq(workstreams.workspaceId, opts.workspaceId));
  } else if (opts.orgId) {
    // Resolve org → workspace IDs, then an IN filter.
    const wsRows = db.$raw
      .prepare(
        `SELECT id FROM workspaces WHERE organization_id = ? AND archived = 0`,
      )
      .all(opts.orgId) as Array<{ id: string }>;
    if (wsRows.length === 0) {
      // No workspaces in this org → empty workstream list.
      return [];
    }
    const wsIds = wsRows.map((r) => r.id);
    filters.push(inArray(workstreams.workspaceId, wsIds));
  }
  if (opts.status && opts.status !== 'all') {
    filters.push(eq(workstreams.status, opts.status));
  } else if (!opts.status) {
    // P0-4 fix: archivedAt is nullable — eq(0) doesn't match NULL and
    // all non-archived rows have NULL there. Filter with isNull().
    filters.push(isNull(workstreams.archivedAt));
  }

  // P0-1 fix: by default only master workstreams. Sub-WS cannot
  // materialize themselves in the kanban via listWorkstreams.
  const rootOnly = opts.rootOnly !== false;
  if (rootOnly) {
    filters.push(isNull(workstreams.parentWorkstreamId));
  }

  let q = db.select().from(workstreams);
  if (filters.length === 1) q = q.where(filters[0]) as typeof q;
  else if (filters.length > 1) q = q.where(and(...filters)) as typeof q;

  const rows = q.orderBy(desc(workstreams.updatedAt)).limit(limit).all();
  return rows.map(rowToWorkstream);
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

export async function updateWorkstream(
  id: string,
  patch: UpdateWorkstreamInput,
): Promise<Workstream | null> {
  const db = getDb();
  const current = db
    .select()
    .from(workstreams)
    .where(eq(workstreams.id, id))
    .get();
  if (!current) return null;

  const now = Date.now();
  const setClause: Partial<WorkstreamRow> = { updatedAt: now };
  if (patch.name !== undefined) setClause.name = patch.name;
  if (patch.description !== undefined) setClause.description = patch.description;
  if (patch.primarySessionId !== undefined)
    setClause.primarySessionId = patch.primarySessionId;
  if (patch.primaryTicketId !== undefined)
    setClause.primaryTicketId = patch.primaryTicketId;
  if (patch.tierMix !== undefined)
    setClause.tierMix = patch.tierMix ? JSON.stringify(patch.tierMix) : null;
  if (patch.status !== undefined) {
    setClause.status = patch.status;
    if (patch.status === 'archived') setClause.archivedAt = now;
  }
  if (patch.costCents !== undefined) setClause.costCents = patch.costCents;
  if (patch.qualityScore !== undefined) setClause.qualityScore = patch.qualityScore;
  if (patch.intent !== undefined && isValidIntent(patch.intent)) {
    setClause.intent = patch.intent;
  }

  db.update(workstreams).set(setClause).where(eq(workstreams.id, id)).run();

  const next = db
    .select()
    .from(workstreams)
    .where(eq(workstreams.id, id))
    .get();
  return next ? rowToWorkstream(next) : null;
}

// ---------------------------------------------------------------------------
// Attach Ticket → Workstream (event-sourced)
// ---------------------------------------------------------------------------

/**
 * Links an existing ticket with a workstream. Emits an
 * `updated` event on the ticket with `payload.workstreamId` so the
 * TicketProjection logic picks up the connection (see lib/events/project).
 *
 * When the workstream has no primary_ticket_id yet, the ticket is
 * automatically set as the master plan ticket.
 */
export async function attachTicketToWorkstream(opts: {
  workstreamId: string;
  ticketId: string;
  workspaceId: WorkspaceId;
  parentTicketId?: string;
  actor?: ActorType;
}): Promise<void> {
  await emitEvent({
    segmentId: opts.workspaceId,
    entityType: 'ticket',
    entityId: opts.ticketId,
    eventType: 'updated',
    actor: opts.actor ?? DEFAULT_ACTOR,
    payload: {
      workstreamId: opts.workstreamId,
      ...(opts.parentTicketId ? { parentTicketId: opts.parentTicketId } : {}),
    },
    sensitivity: 'low',
  });

  const ws = await getWorkstream(opts.workstreamId);
  if (ws && !ws.primaryTicketId) {
    await updateWorkstream(opts.workstreamId, { primaryTicketId: opts.ticketId });
  }
}

// ---------------------------------------------------------------------------
// Sub-workstreams (sprint C, 2026-04-29) — first-class entity.
//
// Every tier spawn / auto-dispatch stage / iterate-lead-roaster is created as
// its OWN workstream entry with `parent_workstream_id = master.id`.
// Status starts 'pending', is set to 'running' at spawn start,
// then to 'done' / 'failed' / 'rate_limited' after the spawn result. Token/cost
// updates via UPSERT on the existing row.
// ---------------------------------------------------------------------------

export interface CreateSubWorkstreamInput {
  /** Master workstream this sub-WS belongs to. */
  parentId: string;
  /** Role (see SubWorkstreamRole). */
  role: SubWorkstreamRole;
  /** Readable name; default `${role} (sub of <parent>)`. */
  name?: string;
  /** Description (optional, for a UI tooltip). */
  description?: string;
  /** Anthropic model name or tier label for the UI. */
  model?: string;
  /** tmux session name — if already known in advance, otherwise via setTmuxSessionId. */
  tmuxSessionId?: string;
}

export async function createSubWorkstream(
  input: CreateSubWorkstreamInput,
): Promise<Workstream> {
  const db = getDb();
  const parent = db
    .select()
    .from(workstreams)
    .where(eq(workstreams.id, input.parentId))
    .get();
  if (!parent) {
    throw new Error(`createSubWorkstream: parent ${input.parentId} not found`);
  }

  const now = Date.now();
  const id = newWorkstreamId(now);
  const name = input.name ?? `${input.role}`;
  const description =
    input.description ??
    (input.model ? `Sub-WS · ${input.role} · ${input.model}` : `Sub-WS · ${input.role}`);

  db.insert(workstreams)
    .values({
      id,
      workspaceId: parent.workspaceId,
      name,
      primarySessionId: null,
      primaryTicketId: parent.primaryTicketId,
      tierMix: null,
      // 'pending' until the spawn starts — we map it to 'active' for the
      // top-level status column (which is enum-restricted), and track
      // the sub-status implicitly via tokensIn>0 / cost>0 / archivedAt.
      // Consumers read the sub-status from audit events, not from the column.
      status: 'active',
      costCents: 0,
      qualityScore: null,
      description,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      parentWorkstreamId: input.parentId,
      role: input.role,
      tmuxSessionId: input.tmuxSessionId ?? null,
      tokensIn: 0,
      tokensOut: 0,
      costCentsAggregated: 0,
      // The sub-workstream inherits the parent intent (same goal, different
      // role). Stays NULL if the parent row had no intent yet
      // (pre-0051 legacy) — the read then normalizes to 'discussion'.
      intent: parent.intent ?? null,
    })
    .run();

  // Audit event — workstream.created with kind=sub-workstream.
  await emitEvent({
    segmentId: parent.workspaceId,
    entityType: 'workspace',
    entityId: id,
    eventType: 'created',
    actor: DEFAULT_ACTOR,
    payload: {
      kind: 'sub-workstream',
      parentWorkstreamId: input.parentId,
      role: input.role,
      model: input.model ?? null,
      tmuxSessionId: input.tmuxSessionId ?? null,
      intent: parent.intent ?? null,
    },
    sensitivity: 'low',
  }).catch(() => undefined);

  const row = db
    .select()
    .from(workstreams)
    .where(eq(workstreams.id, id))
    .get();
  if (!row) throw new Error(`createSubWorkstream: row missing for ${id}`);
  return rowToWorkstream(row);
}

/** Sub-workstreams directly under `parentId`. Depth = 1. */
export async function listSubWorkstreams(
  parentId: string,
): Promise<Workstream[]> {
  const db = getDb();
  const rows = db
    .select()
    .from(workstreams)
    .where(eq(workstreams.parentWorkstreamId, parentId))
    .orderBy(workstreams.createdAt)
    .all();
  return rows.map(rowToWorkstream);
}

/**
 * Returns the master + all descendants (recursively via parent_workstream_id).
 * Limited to `maxDepth` iterations so cycles don't cause an infinite loop.
 */
export async function getWorkstreamWithDescendants(
  id: string,
  maxDepth: number = 5,
): Promise<Workstream[]> {
  const root = await getWorkstream(id);
  if (!root) return [];
  const result: Workstream[] = [root];
  // P1-5 fix: the seen set + frontier filter prevent an infinite loop on
  // corrupt parent cycles in the DB. Plus a warn log when maxDepth is
  // reached — an early hint of orphaned/too-deep sub-trees.
  const seen = new Set<string>([id]);
  let frontier: string[] = [id];
  for (let depth = 0; depth < maxDepth; depth++) {
    if (frontier.length === 0) break;
    const db = getDb();
    const rows = db
      .select()
      .from(workstreams)
      .where(inArray(workstreams.parentWorkstreamId, frontier))
      .all();
    if (rows.length === 0) break;
    const newSubs = rows
      .map(rowToWorkstream)
      .filter((s) => !seen.has(s.id));
    if (newSubs.length === 0) break;
    for (const s of newSubs) seen.add(s.id);
    result.push(...newSubs);
    frontier = newSubs.map((s) => s.id);
  }
  if (frontier.length > 0) {
    console.warn(
      `[workstreams] getWorkstreamWithDescendants: maxDepth ${maxDepth} reached with ${frontier.length} subs unread for root=${id}`,
    );
  }
  return result;
}

export interface UpdateTokenUsageInput {
  tokensIn?: number;
  tokensOut?: number;
  /** Adds (additively) to the existing `cost_cents_aggregated`. */
  costCents?: number;
  /** If set: overwrite tmux_session_id (late binding). */
  tmuxSessionId?: string;
}

/**
 * UPSERT-style token update for sub-workstreams. Additive — the caller
 * calls with the tokens of the current spawn result, we sum onto
 * the existing value. This also works for multi-round
 * spawns where the same sub issues several calls.
 */
export async function updateTokenUsage(
  workstreamId: string,
  input: UpdateTokenUsageInput,
): Promise<void> {
  const db = getDb();

  // P0-2 fix: atomic via a SQL expression instead of SELECT+SET. On parallel
  // spawns of the same sub-WS (several stages, multi-round) this prevents
  // the race condition that would otherwise overwrite token updates.
  const now = Date.now();
  const tokensIn = Math.max(0, Math.floor(input.tokensIn ?? 0));
  const tokensOut = Math.max(0, Math.floor(input.tokensOut ?? 0));
  const costCents = Math.max(0, Math.floor(input.costCents ?? 0));

  const setClause: Record<string, unknown> = {
    updatedAt: now,
    tokensIn: sql`${workstreams.tokensIn} + ${tokensIn}`,
    tokensOut: sql`${workstreams.tokensOut} + ${tokensOut}`,
    costCentsAggregated: sql`${workstreams.costCentsAggregated} + ${costCents}`,
  };
  if (input.tmuxSessionId !== undefined) {
    setClause.tmuxSessionId = input.tmuxSessionId;
  }

  db.update(workstreams)
    .set(setClause)
    .where(eq(workstreams.id, workstreamId))
    .run();

  // Critic fix #1c (2026-05-25): master liveness bump. When this WS is a
  // sub-WS (parent_workstream_id != NULL), also bump the MASTER row's
  // `updated_at`. Otherwise the recovery sweep sees the master as stale even though
  // its sub-spawns are currently writing tokens (the wave is alive). Only the
  // updated_at column — no status/token mutation on the master.
  bumpMasterUpdatedAt(workstreamId, now);
}

/**
 * Critic fix #1c — bumps the `updated_at` of the master row when `childId` is a
 * sub-WS. A single UPDATE with a subquery; no-op when childId is a
 * master (parent_workstream_id IS NULL → the subquery returns NULL → no
 * match). Best-effort: does not throw (the liveness bump is additive, not blocking).
 */
function bumpMasterUpdatedAt(childId: string, now: number): void {
  try {
    const db = getDb();
    db.$raw
      .prepare(
        `UPDATE workstreams
            SET updated_at = ?
          WHERE id = (
            SELECT parent_workstream_id FROM workstreams WHERE id = ?
          )`,
      )
      .run(now, childId);
  } catch (err) {
    console.warn(
      '[workstreams] bumpMasterUpdatedAt failed (non-fatal):',
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Sets the sub-workstream status — we map sub-statuses to the top-level status
 * + archivedAt for 'done'/'failed':
 *   - pending/running → status='active'
 *   - done            → status='done', archivedAt=now (graceful disappear)
 *   - failed          → status='paused' (stay visible for debugging)
 *   - rate_limited    → status='paused'
 */
export async function setSubWorkstreamStatus(
  workstreamId: string,
  subStatus: SubWorkstreamStatus,
): Promise<void> {
  const db = getDb();
  const row = db
    .select()
    .from(workstreams)
    .where(eq(workstreams.id, workstreamId))
    .get();
  if (!row) return;

  const now = Date.now();
  const setClause: Partial<WorkstreamRow> = { updatedAt: now };
  switch (subStatus) {
    case 'pending':
    case 'running':
      setClause.status = 'active';
      break;
    case 'done':
      setClause.status = 'done';
      // Do NOT set archivedAt — the sub-WS should stay visible in the tree
      // until the master is closed.
      break;
    case 'failed':
    case 'rate_limited':
      setClause.status = 'paused';
      break;
    case 'stuck':
      // P1-7: the sub-WS got stuck (e.g. the resume spawn returns
      // empty output). The UI renders this as a red pill.
      setClause.status = 'stuck';
      break;
  }

  db.update(workstreams)
    .set(setClause)
    .where(eq(workstreams.id, workstreamId))
    .run();

  // Critic fix #1c (2026-05-25): master liveness bump also on a status change
  // of a sub-WS (running/done/failed/...). Keeps the master row fresh for the
  // recovery sweep as long as sub-spawns report progress.
  bumpMasterUpdatedAt(workstreamId, now);
}
