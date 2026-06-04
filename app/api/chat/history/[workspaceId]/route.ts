/**
 * GET /api/chat/history/[workspaceId]
 *
 * Phase MS · 2026-04-26. Server-Read der Chat-History fuer einen Workspace.
 * Quelle: `events`-Tabelle, gefiltert auf `entity_type='chat_message'`.
 *
 * Auth: Cookie-basiert (gleicher Pattern wie /api/events/stream).
 *
 * Query-Params:
 *   - limit  (default 60, max 200)
 *   - before (ISO-Timestamp; events mit createdAt < before)
 *
 * Response:
 *   {
 *     items: HistoryItem[],   // chronologisch (oldest first)
 *     hasMore: boolean        // true wenn limit komplett gefuellt wurde
 *   }
 *
 * Implementation: DESC-Query, dann reversed gemappt — so nehmen wir die
 * NEUESTE N Items, kein "fenster ab Start" was bei aktiver Workspace
 * dem User die alten Sachen statt der neuen zeigen wuerde.
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

// Akzeptiert echte Workspace-IDs, Sonder-Pseudos ((root)/(tmp)/__root__) und
// den Org-Root-Scope `__org_root__:<orgId>` (Phase IA.1 — Org-scoped Chat).
// Der optionale Prefix war bisher nicht erlaubt → der `:` wurde verworfen → 400.
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

  // Clear-Point (2026-06-02): jüngster „Verlauf leeren"-Marker für diesen
  // Workspace. Append-only — wir löschen nichts, sondern blenden alle
  // chat_message-Events VOR dem Marker aus. Best-effort: bei Fehler kein
  // Cutoff (alte History bleibt sichtbar, kein Crash).
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
    /* non-fatal — kein Cutoff */
  }

  // Q1: chat_message events (existing scope — User/Assistant-Bubbles).
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

  // Q2: workstream-Aktivitaet (ticket/updated, ticket/commented).
  // Wir laden hier breit (nur entityType + eventType + segmentId) und
  // filtern per JS auf payload-Felder — JSON-extract ueber Drizzle/SQLite
  // ist fragil und der Volume ist klein (10er-Bereich pro Workspace pro
  // Stunde). Limit doppelt damit auch nach JS-Filter genug uebrig bleibt.
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

    // Wir nehmen 4×limit als raw-Window — 4× Sicherheitsfaktor weil wir in JS
    // auf payload.transition / payload.kind filtern (nicht jede ticket-update
    // ist Workstream-Event; status_changed-only Updates landen z.B. raus).
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

  // ---- Streaming-Recovery V2 (2026-04-27) -----------------------------
  // Fuer jede Row in `streaming_snapshots` (Migration 0018) hangen wir
  // ein synthetisches Assistant-HistoryItem an. Die Existenz der Row =
  // "kein chat_message_completed bisher" (DELETE-after-completed-Vertrag).
  // State-Heuristik:
  //   now - updated_at < 10s  → 'streaming' (Writer noch lebendig)
  //   sonst                    → 'aborted'  (Server-Crash, 1500ms-Takt aus)
  //
  // Gefiltert auf Snapshots, deren pendingPromptId in den geladenen
  // chat_message_sent-Events vorkommt — sonst wuerden Snapshots aus
  // dem Pre-`before`-Zeitfenster oder aus parallelen Tabs hier auftauchen
  // und die Reihenfolge zerschiessen.
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
      // Set der pendingPromptIds, die wir geladen haben (Reihenfolge-Anker).
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
            // ID-Konvention: snapshot-Items bekommen `snap-<pendingPromptId>`
            // damit sie nicht mit echten Event-ULIDs kollidieren und der
            // Client sie via prefix-check erkennen kann.
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
            // pendingPromptId mitgeben damit der Client die Snapshot-
            // Bubble eindeutig dem User-Prompt zuordnen kann.
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

  // Snapshot-Items chronologisch hinter den letzten user-Bubble einsortieren,
  // der dieselbe pendingPromptId teilt. Wenn die History bereits ein
  // chat_message_sent-Item fuer diese pid enthaelt, kommt der Snapshot
  // direkt danach (Assistant-Bubble in Antwort darauf). Wenn nicht
  // (Edge-Case: sent-Event in einem geladenen, completed in keinem,
  // beide vor `before`), haengen wir am Ende an.
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

  // Workstream-Events filtern + mappen. Limit auf `limit` damit wir den
  // Client nicht mit 200+ Toasts erschlagen wenn der Workspace heiss lief.
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
