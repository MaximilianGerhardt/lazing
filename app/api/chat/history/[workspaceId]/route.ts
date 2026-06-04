/**
 * GET /api/chat/history/[workspaceId]
 *
 * Phase MS · 2026-04-26. Server-side read of the chat history for a workspace.
 * Source: the `events` table, filtered on `entity_type='chat_message'`.
 *
 * Auth: cookie-based (same pattern as /api/events/stream).
 *
 * Query params:
 *   - limit  (default 60, max 200)
 *   - before (ISO timestamp; events with createdAt < before)
 *
 * Response:
 *   {
 *     items: HistoryItem[],   // chronological (oldest first)
 *     hasMore: boolean        // true if the limit was fully filled
 *   }
 *
 * Implementation: DESC query, then mapped reversed — this way we take the
 * NEWEST N items, not a "window from the start" which on an active workspace
 * would show the user the old stuff instead of the new.
 */

import { NextResponse } from "next/server";

import { and, desc, eq, gt, inArray, lt } from "drizzle-orm";

import { getDb } from "@/db/client";
import { events } from "@/db/schema/events";
import {
  readSessionConfig,
  readSessionCookie,
  verifySessionCookieValue,
} from "@/lib/security/session";
import {
  chatMessageEventToHistoryItem,
  workstreamEventToHistoryItem,
  isWorkstreamHistoryEvent,
} from "@/lib/chat/serializer";
import type { HistoryItem } from "@/lib/chat/ChatShell";
import type {
  ActorType,
  EntityType,
  EventType,
  LazyEvent,
  Sensitivity,
} from "@/lib/events/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 60;
const MAX_LIMIT = 200;

// Accepts real workspace IDs, special pseudos ((root)/(tmp)/__root__) and
// the org-root scope `__org_root__:<orgId>` (Phase IA.1 — org-scoped chat).
// The optional prefix was previously not allowed → the `:` was rejected → 400.
const WORKSPACE_ID_REGEX = /^(?:__org_root__:)?[a-z0-9_()][a-z0-9_()-]{0,63}$/i;

function rowToEvent(row: typeof events.$inferSelect): LazyEvent {
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(row.payload ?? "{}");
  } catch {
    payload = {};
  }
  return {
    id: row.id,
    createdAt: row.createdAt,
    segmentId: row.segmentId,
    entityType: row.entityType as EntityType,
    entityId: row.entityId,
    eventType: row.eventType as EventType,
    actor: row.actor as ActorType,
    payload,
    sensitivity: row.sensitivity as Sensitivity,
    signature: row.signature ?? undefined,
    replayedFrom: row.replayedFrom ?? undefined,
  };
}

export async function GET(
  req: Request,
  context: { params: Promise<{ workspaceId: string }> },
): Promise<Response> {
  // ---- Auth
  const cookieCfg = readSessionConfig();
  if (!cookieCfg) {
    return NextResponse.json(
      { error: "auth_not_configured" },
      { status: 503 },
    );
  }
  const cookieValue = readSessionCookie(req.headers.get("cookie"));
  const verified = await verifySessionCookieValue(cookieValue, cookieCfg);
  if (!verified.ok) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // ---- Params
  const { workspaceId } = await context.params;
  if (!workspaceId || !WORKSPACE_ID_REGEX.test(workspaceId)) {
    return NextResponse.json(
      { error: "invalid_workspace_id" },
      { status: 400 },
    );
  }

  const url = new URL(req.url);
  const limitRaw = url.searchParams.get("limit");
  const beforeRaw = url.searchParams.get("before");

  let limit = DEFAULT_LIMIT;
  if (limitRaw) {
    const parsed = Number.parseInt(limitRaw, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      limit = Math.min(parsed, MAX_LIMIT);
    }
  }

  let beforeMs: number | undefined;
  if (beforeRaw) {
    const ms = Date.parse(beforeRaw);
    if (Number.isFinite(ms)) beforeMs = ms;
  }

  // ---- Query
  const db = getDb();

  // Clear point (2026-06-02): the most recent „Verlauf leeren" marker for this
  // workspace. Append-only — we delete nothing, but hide all
  // chat_message events BEFORE the marker. Best-effort: on error no
  // cutoff (old history stays visible, no crash).
  let clearPointMs: number | undefined;
  try {
    const clearRow = db
      .select({ createdAt: events.createdAt })
      .from(events)
      .where(
        and(
          eq(events.entityType, "chat_message"),
          eq(events.segmentId, workspaceId),
          eq(events.eventType, "chat_history_cleared"),
        ),
      )
      .orderBy(desc(events.createdAt))
      .limit(1)
      .all();
    if (clearRow.length > 0) clearPointMs = clearRow[0]!.createdAt;
  } catch {
    /* non-fatal — no cutoff */
  }

  // Q1: chat_message events (existing scope — user/assistant bubbles).
  const chatClauses = [
    eq(events.entityType, "chat_message"),
    eq(events.segmentId, workspaceId),
  ];
  if (clearPointMs !== undefined) {
    chatClauses.push(gt(events.createdAt, clearPointMs));
  }
  if (beforeMs !== undefined) {
    chatClauses.push(lt(events.createdAt, beforeMs));
  }
  const chatWhere =
    chatClauses.length === 1 ? chatClauses[0] : and(...chatClauses);

  // Q2: workstream activity (ticket/updated, ticket/commented).
  // We load broadly here (only entityType + eventType + segmentId) and
  // filter on payload fields in JS — JSON-extract via Drizzle/SQLite
  // is fragile and the volume is small (tens per workspace per
  // hour). Double the limit so enough remains even after the JS filter.
  const wsClauses = [
    eq(events.entityType, "ticket"),
    eq(events.segmentId, workspaceId),
    inArray(events.eventType, ["updated", "commented"]),
  ];
  if (clearPointMs !== undefined) {
    wsClauses.push(gt(events.createdAt, clearPointMs));
  }
  if (beforeMs !== undefined) {
    wsClauses.push(lt(events.createdAt, beforeMs));
  }
  const wsWhere = and(...wsClauses);

  let chatRows: Array<typeof events.$inferSelect>;
  let wsRows: Array<typeof events.$inferSelect>;
  try {
    chatRows = db
      .select()
      .from(events)
      .where(chatWhere)
      .orderBy(desc(events.createdAt))
      .limit(limit)
      .all();

    // We take 4×limit as the raw window — 4× safety factor because we filter
    // in JS on payload.transition / payload.kind (not every ticket update
    // is a workstream event; e.g. status_changed-only updates drop out).
    wsRows = db
      .select()
      .from(events)
      .where(wsWhere)
      .orderBy(desc(events.createdAt))
      .limit(Math.min(limit * 4, MAX_LIMIT * 4))
      .all();
  } catch (err) {
    console.warn(
      "[chat/history] query failed:",
      err instanceof Error ? err.message : String(err),
    );
    return NextResponse.json({ error: "db_error" }, { status: 500 });
  }

  const hasMore = chatRows.length === limit;

  // Reverse to chronological order so the client can render top-to-bottom.
  const chronologicalChat = [...chatRows].reverse();
  const items = chronologicalChat
    .map((row) => rowToEvent(row))
    .map((ev) => chatMessageEventToHistoryItem(ev))
    .filter((item): item is NonNullable<typeof item> => item !== null);

  // ---- Streaming recovery V2 (2026-04-27) -----------------------------
  // For each row in `streaming_snapshots` (migration 0018) we append
  // a synthetic assistant history item. The existence of the row =
  // "no chat_message_completed yet" (DELETE-after-completed contract).
  // State heuristic:
  //   now - updated_at < 10s  → 'streaming' (writer still alive)
  //   otherwise                → 'aborted'  (server crash, 1500ms beat off)
  //
  // Filtered to snapshots whose pendingPromptId appears in the loaded
  // chat_message_sent events — otherwise snapshots from
  // the pre-`before` time window or from parallel tabs would show up here
  // and break the ordering.
  let streamingItems: HistoryItem[] = [];
  try {
    type SnapshotRow = {
      pending_prompt_id: string;
      partial_content: string;
      tool_state: string | null;
      in_code_block: number;
      updated_at: number;
    };
    const snapshotRows = db.$raw
      .prepare(
        `SELECT pending_prompt_id, partial_content, tool_state,
                in_code_block, updated_at
           FROM streaming_snapshots
          WHERE workspace_id = ?
          ORDER BY updated_at ASC`,
      )
      .all(workspaceId) as SnapshotRow[];

    if (snapshotRows.length > 0) {
      // Set of the pendingPromptIds we loaded (ordering anchor).
      const knownPids = new Set<string>();
      for (const it of items) {
        if (it.pendingPromptId) knownPids.add(it.pendingPromptId);
      }
      const nowMs = Date.now();
      const STREAMING_HEURISTIC_MS = 10_000;

      streamingItems = snapshotRows
        .filter((r) => knownPids.has(r.pending_prompt_id))
        .map((r) => {
          const ageMs = nowMs - r.updated_at;
          const state: 'streaming' | 'aborted' =
            ageMs < STREAMING_HEURISTIC_MS ? 'streaming' : 'aborted';
          let parsedToolState: HistoryItem['toolState'] = null;
          if (r.tool_state) {
            try {
              const raw = JSON.parse(r.tool_state) as unknown;
              if (
                raw &&
                typeof raw === 'object' &&
                typeof (raw as { name?: unknown }).name === 'string'
              ) {
                const ts = raw as {
                  name: string;
                  status?: string;
                  id?: string;
                };
                parsedToolState = {
                  name: ts.name,
                  status: ts.status === 'done' ? 'done' : 'pending',
                  ...(typeof ts.id === 'string' ? { id: ts.id } : {}),
                };
              }
            } catch {
              parsedToolState = null;
            }
          }
          const item: HistoryItem = {
            // ID convention: snapshot items get `snap-<pendingPromptId>`
            // so they do not collide with real event ULIDs and the
            // client can recognize them via a prefix check.
            id: `snap-${r.pending_prompt_id}`,
            role: 'assistant',
            content: r.partial_content,
            ts: new Date(r.updated_at).toISOString(),
            partial: true,
            actor: 'agent:claude',
            streamState: state,
            partialContent: r.partial_content,
            inCodeBlock: r.in_code_block === 1,
            toolState: parsedToolState,
            snapshotUpdatedAt: new Date(r.updated_at).toISOString(),
            // Pass pendingPromptId so the client can uniquely associate the
            // snapshot bubble with the user prompt.
            pendingPromptId: r.pending_prompt_id,
          };
          return item;
        });
    }
  } catch (err) {
    console.warn(
      '[chat/history] streaming_snapshots query failed:',
      err instanceof Error ? err.message : String(err),
    );
    streamingItems = [];
  }

  // Insert snapshot items chronologically after the last user bubble
  // that shares the same pendingPromptId. If the history already contains a
  // chat_message_sent item for this pid, the snapshot comes
  // right after it (assistant bubble in reply to it). If not
  // (edge case: sent event in a loaded one, completed in none,
  // both before `before`), we append at the end.
  const merged: HistoryItem[] = [];
  const placedPids = new Set<string>();
  for (const it of items) {
    merged.push(it);
    if (it.pendingPromptId) {
      const snap = streamingItems.find(
        (s) => s.pendingPromptId === it.pendingPromptId,
      );
      if (snap) {
        merged.push(snap);
        placedPids.add(it.pendingPromptId);
      }
    }
  }
  for (const snap of streamingItems) {
    if (snap.pendingPromptId && !placedPids.has(snap.pendingPromptId)) {
      merged.push(snap);
    }
  }
  // Replace `items` with the merged list for the response.
  // (Eslint-clean: re-assign over a let-binding instead of mutating const.)
  const finalItems: HistoryItem[] = merged;

  // Filter + map workstream events. Limit to `limit` so we do not
  // overwhelm the client with 200+ toasts when the workspace ran hot.
  const chronologicalWs = [...wsRows]
    .reverse()
    .map((row) => rowToEvent(row))
    .filter((ev) =>
      isWorkstreamHistoryEvent(
        ev.entityType,
        ev.eventType,
        ev.payload as Record<string, unknown>,
      ),
    );
  const systemItems = chronologicalWs
    .map((ev) => workstreamEventToHistoryItem(ev))
    .filter(
      (item): item is NonNullable<typeof item> => item !== null,
    )
    .slice(-limit);

  return NextResponse.json(
    { items: finalItems, hasMore, systemItems },
    {
      headers: {
        "cache-control": "no-store",
      },
    },
  );
}
