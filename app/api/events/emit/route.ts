/**
 * POST /api/events/emit
 *
 * Append-only event writer. Validates input with Zod, delegates to
 * `emitEvent()` (which persists + broadcasts).
 *
 * Auth (Phase 2 MVP):
 *   - `Authorization: Bearer <LAZYOS_PUSH_SECRET>` bypasses same-origin check
 *   - Otherwise: same-origin CSRF-Check against `Origin`/`Referer`
 *   - If no `LAZYOS_PUSH_SECRET` is set AND request is same-origin, we allow it
 *     (Single-User-MVP). Phase 6 introduces real auth (OAuth / session cookie).
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import { emitEvent, emitErrorEvent } from "../../../../lib/events/emit";
import type { ActorType } from "../../../../lib/events/types";
import { migrateSegmentToWorkspace } from "../../../../lib/events/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Sprint 2 · 7C: Workspace-IDs sind dynamisch (Discovery aus dem
 * konfigurierten Projects-Root). Legacy-IDs werden fuer
 * Abwaertskompatibilitaet weiterhin akzeptiert.
 */
const SegmentIdSchema = z
  .string()
  .min(1)
  .max(64)
  // Akzeptiert: Legacy-@segments, slug-Workspaces, __root__-Pseudo,
  // Klammer-IDs aus Sessions-Registry ((root)/(tmp)).
  .regex(/^(@[a-z]+|[a-z0-9_()][a-z0-9_()-]*)$/i, "invalid workspace id");
const EntityTypeSchema = z.enum(["ticket", "decision", "invoice", "routine", "note", "phase", "workspace"]);
const EventTypeSchema = z.enum([
  "created",
  "updated",
  "closed",
  "reopened",
  "decision_made",
  "decision_reverted",
  "assigned",
  "commented",
  "status_changed",
  "test_result",
  "approval_requested",
  "approved",
  "rejected",
  "executed",
  "review_request",
  "user_feedback",
  "fix_agent_triggered",
  "workspace_discovered",
  "heartbeat_swept",
  "push_sent",
  "error_logged",
]);
const SensitivitySchema = z.enum(["low", "medium", "high"]);
const ActorSchema = z
  .string()
  .min(1)
  .refine(
    (v) => v === "system" || v.startsWith("user:") || v.startsWith("agent:"),
    { message: "actor must be 'system' or 'user:*' / 'agent:*'" },
  );

const EmitEventSchema = z.object({
  segmentId: SegmentIdSchema,
  entityType: EntityTypeSchema,
  entityId: z.string().min(1).max(128),
  eventType: EventTypeSchema,
  actor: ActorSchema,
  payload: z.record(z.string(), z.unknown()).optional(),
  sensitivity: SensitivitySchema.optional(),
  replayedFrom: z.string().optional(),
});

function isAuthorized(req: Request): boolean {
  const secret = process.env.LAZYOS_PUSH_SECRET;
  const auth = req.headers.get("authorization");
  if (secret && auth === `Bearer ${secret}`) return true;

  // Same-origin check (CSRF).
  const origin = req.headers.get("origin");
  const referer = req.headers.get("referer");
  const host = req.headers.get("host");
  if (!host) return false;

  const match = (src: string | null): boolean => {
    if (!src) return false;
    try {
      const u = new URL(src);
      return u.host === host;
    } catch {
      return false;
    }
  };

  // Require same-origin unless a secret is configured and matched.
  if (match(origin) || match(referer)) return true;

  // Allow when neither origin nor referer is present AND no secret is required
  // (e.g. server-to-server fetch on the same Lambda). Phase 6 will lock this.
  if (!secret && !origin && !referer) return true;

  return false;
}

export async function POST(req: Request): Promise<Response> {
  if (!isAuthorized(req)) {
    return NextResponse.json(
      { error: "unauthorized", hint: "same-origin or bearer token required" },
      { status: 401 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsed = EmitEventSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_error", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  try {
    // Zod's refine narrows at runtime only — cast actor to the typed union.
    const event = await emitEvent({
      ...parsed.data,
      actor: parsed.data.actor as ActorType,
    });
    return NextResponse.json(event, { status: 201 });
  } catch (err) {
    await emitErrorEvent(parsed.data.segmentId, "api/events/emit", err);
    return NextResponse.json(
      { error: "emit_failed", message: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
