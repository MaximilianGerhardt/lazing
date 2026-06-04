/**
 * lib/chat/serializer.ts
 * ----------------------
 * Mapping between `chat_message_*` events (DB) and the `HistoryItem` form
 * (UI). Phase MS · 2026-04-26.
 *
 * Used by:
 *   - `app/api/chat/history/[workspaceId]/route.ts`  (server read)
 *   - `lib/chat/ChatShell.tsx`                       (realtime push via event stream)
 *   - `app/api/chat/history/[workspaceId]/import/route.ts` (migration MS.6)
 *
 * The `HistoryItem` type lives in `ChatShell.tsx` so no cycle
 * arises (storage.ts imports HistoryItem from there).
 */

import type {
  ChatMessagePayload,
  ChatMessageToolCallSummary,
  LazyEvent,
} from "@/lib/events/types";
import type { ToolStep } from "./types";
import type { HistoryItem } from "./ChatShell";
import { eventToSurface } from "./event-to-surface";
import type { LazyEventLike } from "./useEventStream";

/**
 * Robust parse: the payload may have unknown fields / wrong types
 * (migrations, manual DB edits). We validate defensively and
 * return null if the minimum fields are missing.
 */
function parseChatMessagePayload(raw: unknown): ChatMessagePayload | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const role = obj.role;
  if (role !== "user" && role !== "assistant") return null;
  const content = typeof obj.content === "string" ? obj.content : "";
  const workspaceId =
    typeof obj.workspaceId === "string" ? obj.workspaceId : "";
  if (!workspaceId) return null;

  const out: ChatMessagePayload = {
    workspaceId,
    role,
    content,
  };

  if (typeof obj.intent === "string") out.intent = obj.intent;
  if (typeof obj.durationMs === "number") out.durationMs = obj.durationMs;
  if (
    obj.outcome === "ok" ||
    obj.outcome === "aborted" ||
    obj.outcome === "error"
  ) {
    out.outcome = obj.outcome;
  }
  if (typeof obj.partial === "boolean") out.partial = obj.partial;
  if (typeof obj.pendingPromptId === "string") {
    out.pendingPromptId = obj.pendingPromptId;
  }
  if (typeof obj.legacyId === "string") out.legacyId = obj.legacyId;
  if (typeof obj.sessionId === "string") out.sessionId = obj.sessionId;
  if (typeof obj.actor === "string") out.actor = obj.actor;

  if (Array.isArray(obj.toolCalls)) {
    const calls: ChatMessageToolCallSummary[] = [];
    for (const c of obj.toolCalls) {
      if (!c || typeof c !== "object") continue;
      const cc = c as Record<string, unknown>;
      if (typeof cc.name !== "string" || typeof cc.summary !== "string") continue;
      const tc: ChatMessageToolCallSummary = {
        name: cc.name,
        summary: cc.summary,
      };
      if (typeof cc.durationMs === "number") tc.durationMs = cc.durationMs;
      calls.push(tc);
    }
    out.toolCalls = calls;
  }

  return out;
}

function toolSummariesToToolSteps(
  calls: ChatMessageToolCallSummary[] | undefined,
): ToolStep[] | undefined {
  if (!calls || calls.length === 0) return undefined;
  return calls.map((c, idx) => {
    const step: ToolStep = {
      id: `tc-${idx}-${c.name}`,
      name: c.name,
      inputPreview: c.summary,
      status: "done",
      startedAt: 0,
    };
    if (typeof c.durationMs === "number") {
      step.endedAt = c.durationMs;
    }
    return step;
  });
}

/**
 * Maps a `chat_message_sent` OR `chat_message_completed` event to
 * a `HistoryItem`. Returns null if the event is not evaluable
 * (e.g. payload broken). The caller must filter.
 */
export function chatMessageEventToHistoryItem(
  event: LazyEvent,
): HistoryItem | null {
  if (event.entityType !== "chat_message") return null;
  if (
    event.eventType !== "chat_message_sent" &&
    event.eventType !== "chat_message_completed"
  ) {
    return null;
  }
  const payload = parseChatMessagePayload(event.payload);
  if (!payload) return null;

  const item: HistoryItem = {
    // event.id is the ULID of the row - unique per event insert,
    // perfect for dedup in the realtime sync.
    id: event.id,
    role: payload.role,
    content: payload.content,
    ts: new Date(event.createdAt).toISOString(),
  };

  if (payload.durationMs !== undefined) item.durationMs = payload.durationMs;
  if (payload.partial !== undefined) item.partial = payload.partial;
  if (typeof payload.actor === "string") item.actor = payload.actor;
  const tools = toolSummariesToToolSteps(payload.toolCalls);
  if (tools && tools.length > 0) item.tools = tools;

  // B1-fix (2026-04-26): pass pendingPromptId from the server event through
  // into the HistoryItem. Used by mergeServerWithLocal to replace local user
  // echo items (with a synthetic client-id) by their server-ULID variant.
  // Only set for role=user — for assistant events the payload field carries
  // no meaning.
  if (payload.role === "user" && typeof payload.pendingPromptId === "string") {
    item.pendingPromptId = payload.pendingPromptId;
  }

  return item;
}

/**
 * Filter: is this an event from which the UI derives a HistoryItem?
 * Used by the realtime listener to skip irrelevant events.
 */
export function isChatMessageEvent(eventType: string | undefined): boolean {
  return (
    eventType === "chat_message_sent" || eventType === "chat_message_completed"
  );
}

/**
 * Workstream history item — arises from ticket events (auto_dispatch,
 * stage-comments, pipeline_complete, synthesis). Loaded in the history
 * endpoint alongside the HistoryItems so that after a reload the workstream
 * activity is historically visible in the log (instead of only live in the
 * SSE stream).
 *
 * Maps 1:1 onto the `SystemItem` format in ChatShell.tsx — these then go
 * into `setSystemMessages` after mount.
 */
export interface WorkstreamHistoryItem {
  id: string;
  role: "system";
  kind: string;
  content: string;
  severity: "info" | "warn" | "critical";
  href?: string;
  ts: string;
}

/**
 * Filter: which ticket events are workstream activity that we
 * replay historically into the chat?
 *
 * - updated with transition IN (auto_dispatch, auto_close_after_subs,
 *   pipeline_complete, auto_dispatch_failed)
 * - commented with kind IN (auto-dispatch-stage, auto-dispatch-stage-retry)
 *
 * synthesis is EXPLICITLY EXCLUDED: ChatShell.handleEvent catches
 * synthesis comments live and renders them as a prominent assistant
 * HistoryItem (bug fix 2026-04-26 — previously it came twice: once
 * as an assistant bubble + once as a system toast after reload). Synthesis
 * is instead persisted client-side in localStorage (via the
 * normal history persistence with writeHistoryFor), and survives reload.
 *
 * Note: we filter HERE so the server endpoint does not stream over all
 * ticket events — that would be too much noise.
 */
export function isWorkstreamHistoryEvent(
  entityType: string,
  eventType: string,
  payload: Record<string, unknown> | null | undefined,
): boolean {
  if (entityType !== "ticket") return false;
  const p = payload ?? {};
  if (eventType === "updated") {
    const t = typeof p.transition === "string" ? p.transition : "";
    // Sub-Plan 05 Polish (2026-04-29): per-sub-ticket `auto_dispatch`
    // and `pipeline_complete` became spam in the stream (6 subs ⇒ 12
    // toasts). The LivePipeline card shows all of that. Keep: only
    // workstream-level markers (close + failed).
    return (
      t === "auto_close_after_subs" ||
      t === "auto_dispatch_failed"
    );
  }
  if (eventType === "commented") {
    const k = typeof p.kind === "string" ? p.kind : "";
    // Sub-Plan 05 Polish (2026-04-29): auto-dispatch-stage(-retry) are
    // visualized in the LivePipeline card. No additional history
    // toast spam — the card subscribes live to SSE and reads the
    // sub-ticket timelines itself on mount. Only the overview event
    // (1× per workstream) stays as a history item, because the card
    // renders it itself.
    return k === "auto-dispatch-overview";
  }
  return false;
}

// Bug B Fix 2026-04-26: WorkstreamHistoryItem.ts MUST be an ISO timestamp,
// not "HH:MM" — ChatShell merges history + systemMessages chronologically
// and needs parsable timestamps. The display format happens at render time.

/**
 * Maps a workstream event (ticket/updated or ticket/commented) to
 * a `WorkstreamHistoryItem`. Uses `eventToSurface` so the surface tag
 * is rendered exactly as in the live stream.
 *
 * Returns null if the event is not workstream-relevant.
 */
export function workstreamEventToHistoryItem(
  event: LazyEvent,
): WorkstreamHistoryItem | null {
  if (
    !isWorkstreamHistoryEvent(
      event.entityType,
      event.eventType,
      event.payload as Record<string, unknown>,
    )
  ) {
    return null;
  }

  // Adapter: LazyEvent (DB-row-shape) -> LazyEventLike (SSE-shape).
  const evLike: LazyEventLike = {
    id: event.id,
    type: event.eventType,
    entityType: event.entityType,
    entityId: event.entityId,
    segmentId: event.segmentId,
    actor: event.actor,
    sensitivity: event.sensitivity,
    ts: event.createdAt,
    payload: event.payload as Record<string, unknown>,
  };

  const mapped = eventToSurface(evLike);
  if (!mapped) return null;

  const item: WorkstreamHistoryItem = {
    id: `sys-${event.id}`,
    role: "system",
    kind: event.eventType,
    content: mapped.text,
    severity: mapped.severity,
    ts: new Date(event.createdAt).toISOString(),
  };
  if (mapped.href) item.href = mapped.href;
  return item;
}
