/**
 * Structured logging helpers backed by the event log.
 *
 * `logAuthAttempt()` and `logSecurityError()` emit `@system`-segment
 * events with a typed kind in payload (since we cannot extend the
 * `EventType` enum without a migration at this phase).
 *
 * All helpers are best-effort — they never throw. A failure to log
 * must not block the request that tried to log it.
 *
 * NOTE: Intended for Node-runtime routes (/api/auth/*, /api/events/*).
 * The Edge middleware does NOT call these; it enqueues a log payload
 * onto response headers (`x-lazyos-log`) and the companion
 * `/api/_internal/log` ingests them. See `middleware.ts` for rationale.
 */

import { emitErrorEvent, emitEvent } from "../events/emit";
import type { SegmentId } from "../events/types";

export type AuthOutcome = "ok" | "fail" | "rate_limited" | "missing_code";

export interface AuthAttempt {
  outcome: AuthOutcome;
  ip: string;
  userAgent?: string;
  path?: string;
  reason?: string;
}

export async function logAuthAttempt(attempt: AuthAttempt): Promise<void> {
  try {
    await emitEvent({
      segmentId: "@system",
      entityType: "note",
      entityId: `auth:${attempt.outcome}:${Date.now()}`,
      eventType: "error_logged",
      actor: "system",
      payload: {
        kind: "auth_attempt",
        outcome: attempt.outcome,
        ip: attempt.ip,
        userAgent: attempt.userAgent,
        path: attempt.path,
        reason: attempt.reason,
      },
      sensitivity: "medium",
    });
  } catch (err) {
    // Best-effort — do not let logging failure cascade.
    console.error("[lazyos] logAuthAttempt failed:", err);
  }
}

export async function logSecurityEvent(
  context: string,
  payload: Record<string, unknown>,
  segmentId: SegmentId = "@system",
): Promise<void> {
  try {
    await emitEvent({
      segmentId,
      entityType: "note",
      entityId: `sec:${context}:${Date.now()}`,
      eventType: "error_logged",
      actor: "system",
      payload: { kind: "security_event", context, ...payload },
      sensitivity: "medium",
    });
  } catch (err) {
    console.error("[lazyos] logSecurityEvent failed:", err);
  }
}

export async function logError(
  context: string,
  error: unknown,
  segmentId: SegmentId = "@system",
): Promise<void> {
  await emitErrorEvent(segmentId, context, error);
}
