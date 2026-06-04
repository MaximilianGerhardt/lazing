/**
 * lib/events/emit-or-update-card.ts
 * ----------------------------------
 * Sub-Plan C · 2026-04-30 — one-card-per-(workstream, kind) helper.
 *
 * Responsibility:
 *   Emit OR update a "living" surface card in the chat stream.
 *   Per `(workspaceId, workstreamId, surfaceKind)` coord there exists
 *   at most ONE active `chat_message_completed` event within the
 *   TTL window (default 24 h). Repeated calls with the same
 *   coord update `payload.content` IN-PLACE instead of emitting a new
 *   event.
 *
 * Context (master plan 2026-04-30 late):
 *   Today tier-orchestrator + finalize route + sub-workstreams
 *   bootstrap emit separate `chat_message_completed` events per tick. With
 *   multi-wave iterations (V1..V5) this creates 4-12 duplicate cards for the same
 *   workstream + kind. The frontend (Sub-Plan A `archiveStalePeers`) hides
 *   older bubbles via `archived=true`, but the DB log + the server
 *   first-mount history (Phase MS · 2026-04-26) keep carrying the ballast.
 *
 *   `emitOrUpdateCard` makes the server path symmetric: a single
 *   event row per coord, updated in place repeatedly. The frontend replace
 *   logic stays (defense-in-depth: archived items from old builds
 *   must still be hidden).
 *
 * Idempotency + race safety:
 *   The lookup uses a structured marker at the payload root
 *   (`$.workstreamId`, `$.surfaceKind`) instead of a LIKE scan over `$.content`.
 *   Relies on the caller not overriding `metadata={workstreamId, surfaceKind}`
 *   by hand (see `emitChatMessageCompleted`).
 *
 *   Concurrent race (two parallel emits to the same coord within
 *   ms): SELECT-then-INSERT/UPDATE would not be atomic. Solution:
 *     1. First try an UPDATE on the existing row (`UPDATE ...
 *        WHERE segment_id=? AND surfaceKind=? AND workstreamId=?
 *        ORDER BY created_at DESC LIMIT 1` — better-sqlite3 allows
 *        ORDER BY/LIMIT on UPDATE since 3.30, fallback below).
 *     2. If the UPDATE hit 0 rows: INSERT via `emitChatMessageCompleted`.
 *   Both paths idempotent. In the worst case (two parallel INSERTs) the
 *   later one wins — uncritical, because archiveStalePeers archives the old one.
 *
 * Backwards-compat:
 *   Existing `chat_message_completed` events without `metadata.surfaceKind`/
 *   `metadata.workstreamId` are not matched and stay untouched.
 */

import { getDb } from '../../db/client';
import type { SurfaceKind } from '../chat/surface-parser';
import { ulid } from '../ulid';
import { broadcast } from './broadcast';
import { emitChatMessageCompleted } from './emit';
import type { LazyEvent } from './types';

/**
 * Card actor: only agent types or `system`. User cards are NOT
 * emitted via this helper — those come from `emitChatMessageSent`
 * with `role: 'user'`. emitChatMessageCompleted accepts exactly this
 * restricted actor form, so we mirror it 1:1 here.
 */
export type CardActor = `agent:${string}` | 'system';

const DEFAULT_TTL_HOURS = 24;

export interface CardCoords {
  workspaceId: string;
  workstreamId: string;
  surfaceKind: SurfaceKind;
  /**
   * Wave 7 (2026-05-01) — discriminator for multi-card-per-kind-per-workstream.
   *
   * Loop kinds (auto-dispatch-stage, iterate-version, tier-output, …) allow
   * MULTIPLE cards of the same kind per workstream, identified by a
   * second axis (stage index, version-N, agent index, roaster index, …).
   *
   * Coord definitions:
   *   - `stage:0`, `stage:1`, `stage:2`         (auto-dispatch-stage)
   *   - `v:1`, `v:2`, `v:3`                     (iterate-version)
   *   - `tier:opus#0`, `tier:sonnet#1`           (tier-output)
   *   - `roaster:1`, `roaster:2`                 (iterate-roast)
   *   - `pause:v2`, `pause:v3`                   (sniper-pause-start)
   *   - `overview` (exactly 1 per workstream — equivalent to undefined)
   *
   * If `subKey` is undefined, the old behavior applies: 1 card per
   * (workspaceId, workstreamId, surfaceKind). If `subKey` is set,
   * the lookup additionally matches on `payload.cardSubKey`. Cards with
   * `subKey=undefined` and `subKey='X'` coexist.
   *
   * Strictly typed as string — callers must build the discriminator
   * deterministically (see lib/events/loop-card-coords.ts).
   */
  subKey?: string;
}

export interface EmitOrUpdateCardInput {
  coords: CardCoords;
  /** Full card content incl. `<surface:KIND>{...}</surface:KIND>`. */
  content: string;
  /**
   * Caller actor. Default: `system` (analogous to today's card-emit sites
   * in tier-orchestrator). On card updates, the actor of the original event
   * is NOT overwritten anymore — the card "belongs" to the first caller.
   */
  actor?: CardActor;
  /**
   * Match window in hours. Default 24. Cards older than this count as
   * "expired" — a new emit creates a new event row instead of mutating the
   * days-old one (otherwise the item ts jumps back and sorts into
   * the middle of the history).
   */
  ttlHours?: number;
  /**
   * Optional durationMs/outcome override for the update path. On insert,
   * the defaults from `emitChatMessageCompleted` are used.
   */
  outcome?: 'ok' | 'aborted' | 'error';
}

export interface EmitOrUpdateCardResult {
  event: LazyEvent;
  /** `inserted` = neuer Row, `updated` = existierender Row mutiert. */
  mode: 'inserted' | 'updated';
}

interface ExistingCardRow {
  id: string;
  created_at: number;
  payload: string;
  segment_id: string;
  entity_type: string;
  entity_id: string;
  event_type: string;
  actor: string;
  sensitivity: string;
}

/**
 * Lookup + UPDATE-or-INSERT.
 *
 * Returns the resulting `LazyEvent` plus the mode. The caller can use it to
 * decide whether push triggers should run (today: insert → push, update →
 * silent refresh; see `broadcast.publishUpdate` below).
 */
export async function emitOrUpdateCard(
  input: EmitOrUpdateCardInput,
): Promise<EmitOrUpdateCardResult> {
  const ttlHours = input.ttlHours ?? DEFAULT_TTL_HOURS;
  const cutoff = Date.now() - ttlHours * 60 * 60 * 1000;
  const { workspaceId, workstreamId, surfaceKind, subKey } = input.coords;

  // Validation: coords must be non-empty. Prevents accidental
  // match collisions via `''` strings.
  if (!workspaceId || !workstreamId || !surfaceKind) {
    throw new Error(
      `[emitOrUpdateCard] coords must be fully populated, got: ${JSON.stringify(input.coords)}`,
    );
  }
  // Wave 7: subKey must be non-empty if set — otherwise a '' lands in
  // the DB and accidentally matches against NULL rows.
  if (subKey !== undefined && subKey === '') {
    throw new Error(
      `[emitOrUpdateCard] coords.subKey is set but empty — must be non-empty string`,
    );
  }

  const db = getDb();

  // Lookup: most recent card row with the same coords within the TTL.
  // ORDER BY created_at DESC LIMIT 1 — on race double-inserts the oldest
  // row stays, the newest is maintained. archiveStalePeers in the frontend
  // clears the old one as soon as it would be rendered.
  //
  // Wave 7: subKey match. If `subKey === undefined`, we only match rows
  // WITHOUT cardSubKey (i.e. json_extract returns NULL). If set, matches
  // on the same string. That way e.g. "auto-dispatch-stage|stage:0",
  // "...stage:1", "...stage:2" coexist as 3 separate cards.
  const existing =
    subKey === undefined
      ? (db.$raw
          .prepare(
            `SELECT id, created_at, payload, segment_id, entity_type, entity_id,
                    event_type, actor, sensitivity
               FROM events
              WHERE segment_id = ?
                AND event_type = 'chat_message_completed'
                AND created_at >= ?
                AND json_extract(payload, '$.surfaceKind') = ?
                AND json_extract(payload, '$.workstreamId') = ?
                AND json_extract(payload, '$.cardSubKey') IS NULL
              ORDER BY created_at DESC
              LIMIT 1`,
          )
          .get(workspaceId, cutoff, surfaceKind, workstreamId) as
          | ExistingCardRow
          | undefined)
      : (db.$raw
          .prepare(
            `SELECT id, created_at, payload, segment_id, entity_type, entity_id,
                    event_type, actor, sensitivity
               FROM events
              WHERE segment_id = ?
                AND event_type = 'chat_message_completed'
                AND created_at >= ?
                AND json_extract(payload, '$.surfaceKind') = ?
                AND json_extract(payload, '$.workstreamId') = ?
                AND json_extract(payload, '$.cardSubKey') = ?
              ORDER BY created_at DESC
              LIMIT 1`,
          )
          .get(workspaceId, cutoff, surfaceKind, workstreamId, subKey) as
          | ExistingCardRow
          | undefined);

  if (existing) {
    return updateExistingCard(existing, input);
  }

  // Insert path: regular emitChatMessageCompleted with marker metadata.
  // emitChatMessageCompleted takes care of broadcast + push trigger.
  const metadata: Record<string, unknown> = {
    surfaceKind,
    workstreamId,
  };
  if (subKey !== undefined) metadata.cardSubKey = subKey;
  const event = await emitChatMessageCompleted({
    workspaceId,
    entityId: ulid(),
    content: input.content,
    actor: input.actor ?? 'system',
    outcome: input.outcome ?? 'ok',
    metadata,
  });
  return { event, mode: 'inserted' };
}

/**
 * UPDATE path: mutates payload.content + payload.updatedAt in-place. The
 * event row keeps its ID + created_at + actor — so the card does not "move"
 * in the chronological stream.
 *
 * Single-statement UPDATE = atomic. On a concurrent update to the same row
 * the later one wins (last-write-wins). Both writers see the same
 * marker match, which is OK.
 */
function updateExistingCard(
  existing: ExistingCardRow,
  input: EmitOrUpdateCardInput,
): EmitOrUpdateCardResult {
  const db = getDb();

  let parsedPayload: Record<string, unknown> = {};
  try {
    parsedPayload = JSON.parse(existing.payload) as Record<string, unknown>;
  } catch {
    parsedPayload = {};
  }

  const nextPayload: Record<string, unknown> = {
    ...parsedPayload,
    content: input.content,
    updatedAt: Date.now(),
    surfaceKind: input.coords.surfaceKind,
    workstreamId: input.coords.workstreamId,
    ...(input.coords.subKey !== undefined
      ? { cardSubKey: input.coords.subKey }
      : {}),
    ...(input.outcome !== undefined ? { outcome: input.outcome } : {}),
  };

  db.$raw
    .prepare(`UPDATE events SET payload = ? WHERE id = ?`)
    .run(JSON.stringify(nextPayload), existing.id);

  // Re-broadcast as a chat_message_completed event so SSE subscribers see the
  // new content live. The event keeps id+created_at, so for the
  // frontend dedup it is a known key — the replace logic in the client recognizes
  // it and replaces the content of the existing bubble in-place.
  const updatedEvent: LazyEvent = {
    id: existing.id,
    createdAt: existing.created_at,
    segmentId: existing.segment_id,
    entityType: existing.entity_type as LazyEvent['entityType'],
    entityId: existing.entity_id,
    eventType: 'chat_message_completed',
    actor: existing.actor as LazyEvent['actor'],
    payload: nextPayload,
    sensitivity: existing.sensitivity as LazyEvent['sensitivity'],
  };

  // Best-effort broadcast — if there are no listeners it costs nothing.
  // Push triggers do NOT run (no new event = no new push, otherwise
  // the user would get a push notif for every V1→V5 wave of the same card).
  try {
    broadcast.publish(updatedEvent);
  } catch {
    /* broadcast non-fatal */
  }

  return { event: updatedEvent, mode: 'updated' };
}
