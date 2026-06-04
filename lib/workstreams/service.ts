/**
 * Workstream-Service (Phase W).
 *
 * Workstream = Container für eine User-Anfrage. Enthält Master-Plan-Ticket,
 * Sub-Tickets (über Event-Sourced parent_ticket_id), eine primäre Claude-
 * Session und einen Tier-Mix für Multi-Agent-Spawn (Phase A folgt).
 *
 * Schreibzugriff geht durch diesen Service. Tickets werden NICHT direkt
 * geupdated — wir emittieren `workstream_attached`-Events am Ticket damit
 * die Projection sauber bleibt (event-sourced wie alles andere).
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
  // Phase Sub-WS (Sprint C, 2026-04-29) — first-class Sub-Workstream-Felder.
  parentWorkstreamId: string | null;
  role: string | null;
  tmuxSessionId: string | null;
  tokensIn: number;
  tokensOut: number;
  costCentsAggregated: number;
  /**
   * 2026-05-01 — Intent-Marker (idea | implementation | bug-fix | question
   * | discussion). NULL in der DB → 'discussion' beim Read.
   */
  intent: WorkstreamIntent;
}

/**
 * Sub-Workstream-Rolle. Enum-Hint, aber String-typed weil neue Rollen
 * jederzeit dazukommen koennen ohne Migration.
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

/** Sub-Workstream-Status. Eigenes Enum weil sub-spezifische States. */
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
  /** Default-Actor `user:max`. */
  actor?: ActorType;
  /**
   * Optionaler expliziter Intent. Wenn nicht gesetzt, klassifizieren wir
   * automatisch aus name+description via intent-classifier (sync, Heuristik).
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
   * 2026-05-01 — User kann den Intent nachträglich korrigieren wenn die
   * Auto-Klassifikation daneben lag (z.B. "schreib mir die Idee als bug-fix
   * auf" — Heuristik klassifiziert idea, User sagt no, das ist bug-fix).
   */
  intent?: WorkstreamIntent;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Phase ORG (2026-04-27): Default `system` statt `user:max`-Fake.
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

  // 2026-05-01 — Intent-Klassifikation. Explizite Wahl via input.intent
  // gewinnt; ansonsten Sync-Heuristik aus name + description. Sync ist
  // ausreichend, weil im Hot-Path keine LLM-Latenz akzeptabel ist; der
  // Fallback-Pfad würde einen Tier-Spawn triggern und ist für später
  // (separater Reclassify-Hook).
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

  // Audit-Event — workstream_created (custom event-type, wir lehnen uns an
  // generic 'created' an, um keine neue EventType-Whitelist zu brechen).
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
   * Phase IA.5 — Org-Filter. Wenn gesetzt UND keine workspaceId: nur
   * Workstreams aus Workspaces dieser Org.
   */
  orgId?: string;
  status?: WorkstreamStatus | 'all';
  limit?: number;
  /**
   * Sprint C (P0-1, 2026-04-29) — Default `true`: nur Master-Workstreams
   * (parent_workstream_id IS NULL). Auf `false` setzen fuer Tree-Views.
   * Verhindert das Leak von Sub-Workstreams in /workstreams Kanban.
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
    // Resolve Org → Workspace-IDs, dann IN-Filter.
    const wsRows = db.$raw
      .prepare(
        `SELECT id FROM workspaces WHERE organization_id = ? AND archived = 0`,
      )
      .all(opts.orgId) as Array<{ id: string }>;
    if (wsRows.length === 0) {
      // Keine Workspaces in dieser Org → leere Workstream-Liste.
      return [];
    }
    const wsIds = wsRows.map((r) => r.id);
    filters.push(inArray(workstreams.workspaceId, wsIds));
  }
  if (opts.status && opts.status !== 'all') {
    filters.push(eq(workstreams.status, opts.status));
  } else if (!opts.status) {
    // P0-4 Fix: archivedAt ist nullable — eq(0) matcht NULL nicht und
    // alle nicht-archivierten Rows haben dort NULL. Mit isNull() filtern.
    filters.push(isNull(workstreams.archivedAt));
  }

  // P0-1 Fix: Standardmaessig nur Master-Workstreams. Sub-WS koennen
  // sich nicht ueber listWorkstreams im Kanban materialisieren.
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
 * Verlinkt ein bestehendes Ticket mit einem Workstream. Emittiert ein
 * `updated`-Event am Ticket mit `payload.workstreamId`, damit die
 * TicketProjection-Logik die Verbindung aufnimmt (siehe lib/events/project).
 *
 * Wenn das Workstream noch keinen primary_ticket_id hat, wird das Ticket
 * automatisch als Master-Plan-Ticket gesetzt.
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
// Sub-Workstreams (Sprint C, 2026-04-29) — first-class entity.
//
// Jeder Tier-Spawn / Auto-Dispatch-Stage / Iterate-Lead-Roaster wird als
// EIGENER Workstream-Eintrag mit `parent_workstream_id = master.id` angelegt.
// Status startet 'pending', wird beim Spawn-Start auf 'running' gesetzt,
// nach Spawn-Result auf 'done' / 'failed' / 'rate_limited'. Token-/Cost-
// Updates per UPSERT auf der existing Row.
// ---------------------------------------------------------------------------

export interface CreateSubWorkstreamInput {
  /** Master-Workstream zu dem dieser Sub-WS gehört. */
  parentId: string;
  /** Rolle (siehe SubWorkstreamRole). */
  role: SubWorkstreamRole;
  /** Lesbarer Name; default `${role} (sub of <parent>)`. */
  name?: string;
  /** Beschreibung (optional, für UI-Tooltip). */
  description?: string;
  /** Anthropic-Modell-Name oder Tier-Label fürs UI. */
  model?: string;
  /** tmux-Session-Name — wenn schon vorab bekannt, sonst per setTmuxSessionId. */
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
      // 'pending' bis spawn startet — mappen wir auf 'active' für die
      // Top-Level-Status-Spalte (die enum-restringiert ist), und tracken
      // den Sub-Status implizit ueber tokensIn>0 / cost>0 / archivedAt.
      // Konsumenten lesen Sub-Status aus Audit-Events, nicht aus Spalte.
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
      // Sub-Workstream erbt den Parent-Intent (gleiches Vorhaben, andere
      // Rolle). Bleibt NULL falls Parent-Row noch keinen Intent hatte
      // (Pre-0051-Legacy) — Read normalisiert dann auf 'discussion'.
      intent: parent.intent ?? null,
    })
    .run();

  // Audit-Event — workstream.created mit kind=sub-workstream.
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

/** Sub-Workstreams direkt unter `parentId`. Tiefe = 1. */
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
 * Liefert Master + alle Descendants (rekursiv via parent_workstream_id).
 * Begrenzt auf `maxDepth` Iterationen damit Zykel keine Endlosschleife geben.
 */
export async function getWorkstreamWithDescendants(
  id: string,
  maxDepth: number = 5,
): Promise<Workstream[]> {
  const root = await getWorkstream(id);
  if (!root) return [];
  const result: Workstream[] = [root];
  // P1-5 Fix: seen-Set + Frontier-Filter verhindern Endlosschleife bei
  // korrupten parent-cycles in der DB. Plus warn-Log wenn maxDepth
  // erreicht — frueher Hinweis auf orphaned/zu-tiefe Sub-Trees.
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
  /** Fügt sich (additiv) zum bisherigen `cost_cents_aggregated` dazu. */
  costCents?: number;
  /** Wenn gesetzt: tmux_session_id ueberschreiben (Late-Binding). */
  tmuxSessionId?: string;
}

/**
 * UPSERT-artiger Token-Update fuer Sub-Workstreams. Additiv — Aufrufer
 * ruft mit den Tokens des aktuellen Spawn-Ergebnis, wir summieren auf
 * den existing Wert drauf. So funktioniert das auch fuer Multi-Round-
 * Spawns wo derselbe Sub mehrere Calls absetzt.
 */
export async function updateTokenUsage(
  workstreamId: string,
  input: UpdateTokenUsageInput,
): Promise<void> {
  const db = getDb();

  // P0-2 Fix: Atomar via SQL-Expression statt SELECT+SET. Bei parallelen
  // Spawns desselben Sub-WS (mehrere Stages, Multi-Round) verhindert das
  // den Race-Condition, der sonst Token-Updates ueberschreibt.
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

  // Critic-Fix #1c (2026-05-25): Master-Liveness-Bump. Wenn dieser WS ein
  // Sub-WS ist (parent_workstream_id != NULL), bumpe auch die MASTER-Row
  // `updated_at`. Sonst sieht der Recovery-Sweep den Master als stale obwohl
  // seine Sub-Spawns gerade Tokens schreiben (die Welle lebt). Nur die
  // updated_at-Spalte — keine Status-/Token-Mutation am Master.
  bumpMasterUpdatedAt(workstreamId, now);
}

/**
 * Critic-Fix #1c — bumpt die `updated_at` der Master-Row wenn `childId` ein
 * Sub-WS ist. Ein einzelner UPDATE mit Subquery; no-op wenn childId ein
 * Master ist (parent_workstream_id IS NULL → Subquery liefert NULL → kein
 * Match). Best-effort: wirft nicht (Liveness-Bump ist additiv, nicht blocking).
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
 * Setzt Sub-Workstream-Status — wir mappen Sub-Stati auf Top-Level-Status
 * + archivedAt fuer 'done'/'failed':
 *   - pending/running → status='active'
 *   - done            → status='done', archivedAt=now (graceful disappear)
 *   - failed          → status='paused' (sichtbar bleiben fuer Debug)
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
      // archivedAt NICHT setzen — Sub-WS soll im Tree sichtbar bleiben
      // bis Master geschlossen wird.
      break;
    case 'failed':
    case 'rate_limited':
      setClause.status = 'paused';
      break;
    case 'stuck':
      // P1-7: Sub-WS ist haengen geblieben (z.B. Resume-Spawn liefert
      // leeren Output). UI rendert das als rote Pill.
      setClause.status = 'stuck';
      break;
  }

  db.update(workstreams)
    .set(setClause)
    .where(eq(workstreams.id, workstreamId))
    .run();

  // Critic-Fix #1c (2026-05-25): Master-Liveness-Bump auch bei Status-Wechsel
  // eines Sub-WS (running/done/failed/...). Hält die Master-Row für den
  // Recovery-Sweep frisch solange Sub-Spawns Fortschritt melden.
  bumpMasterUpdatedAt(workstreamId, now);
}
