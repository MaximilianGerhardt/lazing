/**
 * emitEvent — central entry point for EVERY new event.
 *
 * Responsibilities:
 *   - generate ULID + createdAt
 *   - default sensitivity (segment-dependent)
 *   - DB insert (append-only)
 *   - in-memory broadcast for SSE listeners
 *
 * Called by API routes AND internal helpers. Never directly
 * `db.insert(events)` — always via emitEvent so the broadcast takes effect.
 */

import { getDb } from "../../db/client";
import { events } from "../../db/schema/events";
import { schedulePushDispatch } from "../push/triggers";
import { autoUpgrade, signPayload } from "../security/sensitivity";
import { ulid } from "../ulid";
import { broadcast } from "./broadcast";
import type {
  ActorType,
  ChatMessagePayload,
  ChatMessageToolCallSummary,
  EmitEventRequest,
  LazyEvent,
  SegmentId,
  WorkspaceId,
} from "./types";

export async function emitEvent(req: EmitEventRequest): Promise<LazyEvent> {
  const db = getDb();
  const createdAt = Date.now();
  const id = ulid(createdAt);

  // Sensitivity floor — @private ALWAYS becomes `high` regardless of caller.
  const sensitivity = autoUpgrade(req.segmentId, req.sensitivity);
  const payload = req.payload ?? {};

  // For high-sensitivity events we sign the payload+metadata with
  // LAZYOS_AUTH_SECRET so an attacker with DB-write access cannot
  // forge a "sensitive" event unnoticed.
  let signature: string | undefined = undefined;
  if (sensitivity === "high") {
    const result = await signPayload({
      id,
      createdAt,
      segmentId: req.segmentId,
      entityType: req.entityType,
      entityId: req.entityId,
      eventType: req.eventType,
      actor: req.actor,
      payload,
      sensitivity,
    });
    if (result.signed) signature = result.signature;
  }

  const event: LazyEvent = {
    id,
    createdAt,
    segmentId: req.segmentId,
    entityType: req.entityType,
    entityId: req.entityId,
    eventType: req.eventType,
    actor: req.actor,
    payload,
    sensitivity,
    signature,
    replayedFrom: req.replayedFrom,
  };

  db.insert(events).values({
    id: event.id,
    createdAt: event.createdAt,
    segmentId: event.segmentId,
    entityType: event.entityType,
    entityId: event.entityId,
    eventType: event.eventType,
    actor: event.actor,
    payload: JSON.stringify(event.payload),
    sensitivity: event.sensitivity,
    signature: event.signature ?? null,
    replayedFrom: event.replayedFrom ?? null,
  }).run();

  broadcast.publish(event);

  // Push-Trigger-Engine (Stream H): async, non-blocking.
  // Never throws — engine catches all errors and audits them.
  schedulePushDispatch(event);

  // Phase AD (2026-04-26): Auto-Dispatch + Auto-Close.
  // Async via queueMicrotask — niemals blocking. Eigene Recursion-Guards
  // im Modul (LAZYOS_DISABLE_AUTO_DISPATCH + transition-Echo-Check).
  if (
    !req.replayedFrom &&
    event.entityType === 'ticket' &&
    event.eventType === 'updated' &&
    process.env.LAZYOS_TIER_DEPTH !== '1'
  ) {
    queueMicrotask(() => {
      void runAutoDispatch(event).catch((err) => {
        console.warn(
          '[auto-dispatch]',
          err instanceof Error ? err.message : String(err),
        );
      });
    });
  }

  // Fire event-triggered routines (best-effort, non-blocking). Guard with
  // a flag so routine-internal emitEvent-calls do not infinite-loop.
  if (!req.replayedFrom && event.eventType !== "error_logged") {
    queueMicrotask(() => {
      void fireEventTriggeredRoutines(event).catch((err) => {
        // Last-resort stderr — a recursive emitErrorEvent here would
        // itself trigger routine-matching and deadlock us.
        if (process.env.LAZYOS_ROUTINE_RUN !== "1") {
          console.error(
            `[lazyos] event-triggered routine dispatch failed:`,
            err,
          );
        }
      });
    });
  }

  return event;
}

/**
 * Dynamic import, um Zyklus lib/events → lib/tickets/auto-dispatch → lib/events
 * zu vermeiden. Phase AD 2026-04-26.
 */
async function runAutoDispatch(event: LazyEvent): Promise<void> {
  const mod = await import('../tickets/auto-dispatch');
  // Master-Approval -> Sub-Dispatch
  await mod.maybeAutoDispatch(event);
  // Sub-Closed -> Master-Auto-Close
  await mod.maybeAutoCloseMaster(event);
}

/**
 * Dynamic import, to avoid the cycle lib/events → lib/routines → lib/events.
 * Runs asynchronously outside the caller stack.
 */
async function fireEventTriggeredRoutines(event: LazyEvent): Promise<void> {
  // Guard: routines that emit events themselves should not fire recursively
  // through their own emissions. LAZYOS_ROUTINE_RUN is set by the
  // runner in the spawnSync env; within the Node process
  // that is process-global, though — we need a finer check.
  // For the Sprint 2 MVP, the env flag plus the "skip replayed" rule suffices.
  if (process.env.LAZYOS_ROUTINE_RUN === "1") return;

  const routines = await import("../routines/runner");
  const matches = await routines.findEventTriggeredRoutines({
    eventType: event.eventType,
    entityType: event.entityType,
    payload: event.payload,
  });
  for (const m of matches) {
    await routines.executeRoutine(m.id, {
      trigger: "event",
      skipScheduleUpdate: true,
    });
  }
}

// ---------------------------------------------------------------------------
// Chat-Message-Helpers (Phase MS · 2026-04-26)
// ---------------------------------------------------------------------------

/**
 * Content-sensitivity scanner. Raises sensitivity to 'high' if the content
 * contains high-risk patterns (API keys, tokens, private keys, bearer auth).
 *
 * Rule (P0-3a): the user chats in a `low` workspace (`lazyos`,
 * `__root__`), but pastes an sk-XXX key or JWT — we would otherwise
 * store it with sensitivity='low' and leak it cross-device + via the push
 * body. Floor elevation prevents that.
 *
 * The scan is conservative: we prefer a false positive (sensitivity
 * goes up for a harmless message) over a plaintext leak in the push.
 */
function scanContentSensitivity(content: string): "low" | "high" {
  if (!content || content.length === 0) return "low";
  const patterns: RegExp[] = [
    /sk-[A-Za-z0-9]{20,}/, // OpenAI/Stripe-Style
    /sk_(?:live|test)_[A-Za-z0-9]{16,}/, // Stripe restricted
    /gh[ps]_[A-Za-z0-9]{30,}/, // GitHub PAT
    /AKIA[A-Z0-9]{16}/, // AWS Access Key
    /eyJ[A-Za-z0-9+/=_-]{20,}\.[A-Za-z0-9+/=_-]{20,}\.[A-Za-z0-9+/=_-]{10,}/, // JWT
    /-----BEGIN [A-Z ]+PRIVATE KEY-----/, // PEM
    /(?:api[_-]?key|secret|password|token|bearer)\s*[=:]\s*['"]?[A-Za-z0-9+/]{16,}/i, // assignments
    /LAZYOS_[A-Z_]+\s*=\s*\S+/, // env-style
  ];
  for (const re of patterns) {
    if (re.test(content)) return "high";
  }
  return "low";
}

/** Raises a sensitivity to the maximum of two values. */
function maxSensitivity(
  a: "low" | "medium" | "high",
  b: "low" | "medium" | "high",
): "low" | "medium" | "high" {
  const order = { low: 0, medium: 1, high: 2 } as const;
  return order[a] >= order[b] ? a : b;
}

/**
 * Persists a user message to the event log. Fired BEFORE the
 * agent-stream call, so the message survives even
 * if the agent server hangs or the client disconnects.
 *
 * The caller must generate `pendingPromptId` (e.g. ULID) and send it back to
 * the client so it recognizes its own echo.
 *
 * Sensitivity: mirrors the workspace — `private` workspace -> high.
 */
export interface EmitChatMessageSentInput {
  workspaceId: WorkspaceId;
  content: string;
  pendingPromptId: string;
  intent?: string;
  /**
   * Who triggered the event. Mirrored both as the top-level ev.actor field
   * (typed ActorType) and in payload.actor (rendering string).
   * Default since Phase ORG (2026-04-27): `system` — the caller MUST explicitly
   * pass the user actor (`currentActor(req)`), otherwise the
   * event lands as an anonymous system action in the audit log. That is more
   * GDPR-compliant than the old `user:max` hardcode fallback.
   * Other values: `agent:api`, `agent:terminal-claude`, `agent:cli`.
   */
  actor?: `user:${string}` | `agent:${string}` | "system";
  /** Migration-Marker (MS.6). */
  legacyId?: string;
  /** Override createdAt (MS.6 backdating). */
  createdAtOverride?: number;
}

export async function emitChatMessageSent(
  input: EmitChatMessageSentInput,
): Promise<LazyEvent> {
  const actor = input.actor ?? "system";
  const payload: ChatMessagePayload = {
    workspaceId: input.workspaceId,
    role: "user",
    content: input.content,
    pendingPromptId: input.pendingPromptId,
    actor,
    ...(input.intent !== undefined ? { intent: input.intent } : {}),
    ...(input.legacyId !== undefined ? { legacyId: input.legacyId } : {}),
  };

  // P0-3a: the content scan raises sensitivity when API keys/tokens/secrets
  // are present in plaintext. Otherwise autoUpgrade only cares about the
  // workspace, not the content itself.
  const contentFloor = scanContentSensitivity(input.content);
  const sensitivity: "low" | "medium" | "high" = maxSensitivity(
    "low",
    contentFloor,
  );

  if (input.createdAtOverride !== undefined) {
    return emitEventBackdated({
      segmentId: input.workspaceId,
      entityType: "chat_message",
      entityId: input.pendingPromptId,
      eventType: "chat_message_sent",
      actor,
      payload: payload as unknown as Record<string, unknown>,
      sensitivity,
      createdAt: input.createdAtOverride,
    });
  }

  return emitEvent({
    segmentId: input.workspaceId,
    entityType: "chat_message",
    entityId: input.pendingPromptId,
    eventType: "chat_message_sent",
    actor,
    payload: payload as unknown as Record<string, unknown>,
    sensitivity,
  });
}

export interface EmitChatMessageCompletedInput {
  workspaceId: WorkspaceId;
  /** entityId for the event (e.g. completion ULID). */
  entityId: string;
  content: string;
  durationMs?: number;
  outcome?: "ok" | "aborted" | "error";
  partial?: boolean;
  toolCalls?: ChatMessageToolCallSummary[];
  sessionId?: string;
  /**
   * Who answered. Default: `agent:claude` (Claude Code CLI).
   * Override for other backends/sub-agents (e.g. `agent:senior-dev`).
   */
  actor?: `agent:${string}` | "system";
  /** Migration-Marker (MS.6). */
  legacyId?: string;
  /** Override createdAt (MS.6 backdating). */
  createdAtOverride?: number;
  /**
   * P1-4 (Sprint C, 2026-04-29): structured markers at the payload root.
   * Serves e.g. the idempotent sub-workstreams card emission via
   * `json_extract(payload, '$.surfaceKind')`. Backwards-compat: existing
   * fields in the ChatMessagePayload are NOT overwritten.
   */
  metadata?: Record<string, unknown>;
}

export async function emitChatMessageCompleted(
  input: EmitChatMessageCompletedInput,
): Promise<LazyEvent> {
  const actor = input.actor ?? "agent:claude";
  const payload: ChatMessagePayload & Record<string, unknown> = {
    workspaceId: input.workspaceId,
    role: "assistant",
    content: input.content,
    actor,
    ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
    ...(input.outcome !== undefined ? { outcome: input.outcome } : {}),
    ...(input.partial !== undefined ? { partial: input.partial } : {}),
    ...(input.toolCalls !== undefined ? { toolCalls: input.toolCalls } : {}),
    ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    ...(input.legacyId !== undefined ? { legacyId: input.legacyId } : {}),
  };
  // P1-4: merge metadata in without overwriting core ChatMessagePayload
  // fields.
  if (input.metadata) {
    for (const [k, v] of Object.entries(input.metadata)) {
      if (!(k in payload)) {
        payload[k] = v;
      }
    }
  }

  // P0-3a: content scan for assistant messages too — the agent may
  // accidentally echo tokens (user pasted a key, agent quotes it
  // back). Floor elevation prevents the echo message from being
  // stored as 'low'.
  const contentFloor = scanContentSensitivity(input.content);
  const sensitivity: "low" | "medium" | "high" = maxSensitivity(
    "low",
    contentFloor,
  );

  if (input.createdAtOverride !== undefined) {
    return emitEventBackdated({
      segmentId: input.workspaceId,
      entityType: "chat_message",
      entityId: input.entityId,
      eventType: "chat_message_completed",
      actor,
      payload: payload as unknown as Record<string, unknown>,
      sensitivity,
      createdAt: input.createdAtOverride,
    });
  }

  return emitEvent({
    segmentId: input.workspaceId,
    entityType: "chat_message",
    entityId: input.entityId,
    eventType: "chat_message_completed",
    actor,
    payload: payload as unknown as Record<string, unknown>,
    sensitivity,
  });
}

/**
 * Variant of emitEvent that lets callers override `createdAt` for
 * MS.6 migration imports. ULID is still derived from the override
 * timestamp so chronological ordering matches the legacy item.
 *
 * Skips the routines + push triggers because backfilled history must
 * not retro-trigger automation. Broadcast IS published — that is fine
 * for live consumers (none, since events with old ts are ignored by
 * "include initial" filter anyway).
 */
async function emitEventBackdated(req: EmitEventRequest & {
  createdAt: number;
}): Promise<LazyEvent> {
  const db = getDb();
  const createdAt = req.createdAt;
  const id = ulid(createdAt);

  const sensitivity = autoUpgrade(req.segmentId, req.sensitivity);
  const payload = req.payload ?? {};

  const event: LazyEvent = {
    id,
    createdAt,
    segmentId: req.segmentId,
    entityType: req.entityType,
    entityId: req.entityId,
    eventType: req.eventType,
    actor: req.actor,
    payload,
    sensitivity,
    replayedFrom: req.replayedFrom,
  };

  db.insert(events).values({
    id: event.id,
    createdAt: event.createdAt,
    segmentId: event.segmentId,
    entityType: event.entityType,
    entityId: event.entityId,
    eventType: event.eventType,
    actor: event.actor,
    payload: JSON.stringify(event.payload),
    sensitivity: event.sensitivity,
    signature: null,
    replayedFrom: event.replayedFrom ?? null,
  }).run();

  // No broadcast/push/routines for backdated events.
  return event;
}

/**
 * „Verlauf leeren" ("clear history") — server-side clear marker for a workspace
 * (2026-06-02). Append-only: does NOT delete events, but sets a cutoff.
 * `GET /api/chat/history/[workspaceId]` hides `chat_message` events before the
 * most recent clear marker. Reversible. The marker NEVER renders as a bubble
 * (serializer.chatMessageEventToHistoryItem returns null for foreign event
 * types). Sensitivity stays 'low' (no content). The broadcast informs
 * live clients on other devices.
 */
export async function emitChatHistoryCleared(
  workspaceId: SegmentId,
  actor: ActorType = "system",
): Promise<LazyEvent> {
  return emitEvent({
    segmentId: workspaceId,
    entityType: "chat_message",
    entityId: `clear:${workspaceId}`,
    eventType: "chat_history_cleared",
    actor,
    payload: { workspaceId },
    sensitivity: "low",
  });
}

/**
 * Self-observability: all internal errors are written to the log as an event
 * (Phase 2). Silent failure forbidden.
 */
export async function emitErrorEvent(
  segmentId: SegmentId,
  context: string,
  error: unknown,
): Promise<void> {
  try {
    await emitEvent({
      segmentId,
      entityType: "note",
      entityId: `error:${context}`,
      eventType: "error_logged",
      actor: "system",
      payload: {
        context,
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
      sensitivity: "medium",
    });
  } catch {
    // Last-resort: if the log itself fails, we fall back to stderr —
    // otherwise we'd infinite-loop.
    console.error(`[lazyos] error_logged failed for ${context}:`, error);
  }
}
