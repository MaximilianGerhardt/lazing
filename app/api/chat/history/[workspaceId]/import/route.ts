/**
 * POST /api/chat/history/[workspaceId]/import
 *
 * Phase MS · MS.6 · 2026-04-26. One-shot migration of the existing
 * localStorage history into chat_message events. Idempotent: at most ONE
 * event is written per `payload.legacyId === item.id`.
 *
 * Auth: cookie-based.
 *
 * Body:
 *   { items: HistoryItem[] }
 *
 * Behavior:
 *   - Per item a chat_message_sent OR chat_message_completed
 *     event is written (depending on role), backdated with ts from item.ts.
 *   - Existing events with the same legacyId are skipped.
 *   - Response: { imported: N, skipped: M }
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import { and, eq, like } from "drizzle-orm";

import { getDb } from "@/db/client";
import { events } from "@/db/schema/events";
import {
  emitChatMessageCompleted,
  emitChatMessageSent,
  emitEvent,
} from "@/lib/events/emit";
import {
  readSessionConfig,
  readSessionCookie,
  verifySessionCookieValue,
} from "@/lib/security/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The org-root scope `__org_root__:<orgId>` (Phase IA.1) must pass — the
// optional prefix was previously not allowed, the `:` was rejected → 400.
const WORKSPACE_ID_REGEX = /^(?:__org_root__:)?[a-z0-9_()][a-z0-9_()-]{0,63}$/i;

const HistoryItemSchema = z.object({
  id: z.string().min(1).max(120),
  role: z.enum(["user", "assistant"]),
  content: z.string().max(64_000),
  ts: z.string().min(1).max(40),
  intent: z.string().max(64).optional(),
  durationMs: z.number().nonnegative().optional(),
});

const BodySchema = z.object({
  items: z.array(HistoryItemSchema).max(500),
});

export async function POST(
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

  // ---- Body
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_failed" },
      { status: 400 },
    );
  }

  const { items } = parsed.data;

  // ---- B2-fix 2026-04-26: Server-side already-migrated check.
  // A localStorage marker per browser/device is no good as a
  // source-of-truth — cross-device + cross-browser otherwise triggers
  // every mount anew (the UNIQUE index catches it, but 60 roundtrips per mount
  // is a performance killer). If a chat_history_migrated
  // event already exists: short-circuit back, the client sets its local
  // marker and is done.
  const db = getDb();
  let alreadyMigrated = false;
  try {
    const marker = db
      .select({ id: events.id })
      .from(events)
      .where(
        and(
          eq(events.entityType, "workspace"),
          eq(events.segmentId, workspaceId),
          eq(events.eventType, "chat_history_migrated"),
        ),
      )
      .limit(1)
      .all();
    if (marker.length > 0) alreadyMigrated = true;
  } catch (err) {
    console.warn(
      "[chat/history/import] migration-marker check failed:",
      err instanceof Error ? err.message : String(err),
    );
    // Fall through — on DB error, import anyway (idempotency
    // via the legacyId pre-check below still applies).
  }
  if (alreadyMigrated) {
    return NextResponse.json({
      imported: 0,
      skipped: items.length,
      alreadyMigrated: true,
    });
  }

  if (items.length === 0) {
    // No item => still set the marker so future mounts
    // do not retry this empty migration.
    try {
      await emitEvent({
        segmentId: workspaceId,
        entityType: "workspace",
        entityId: workspaceId,
        eventType: "chat_history_migrated",
        actor: "system",
        payload: { itemsImported: 0, itemsSkipped: 0, ts: Date.now() },
        sensitivity: "low",
      });
    } catch (err) {
      console.warn(
        "[chat/history/import] marker emit failed (empty):",
        err instanceof Error ? err.message : String(err),
      );
    }
    return NextResponse.json({ imported: 0, skipped: 0 });
  }

  // ---- Pre-check: which legacyIds are already imported?
  const knownLegacyIds = new Set<string>();
  try {
    // We search events for this workspace, entityType chat_message,
    // whose payload JSON contains the legacyId. SQLite LIKE on a TEXT payload
    // is O(n) but OK for <1000 chat_message events for one workspace
    // — and this runs exactly once per workspace per browser.
    const candidateRows = db
      .select({ payload: events.payload })
      .from(events)
      .where(
        and(
          eq(events.entityType, "chat_message"),
          eq(events.segmentId, workspaceId),
          like(events.payload, `%"legacyId"%`),
        ),
      )
      .all();
    for (const row of candidateRows) {
      try {
        const obj = JSON.parse(row.payload ?? "{}") as {
          legacyId?: unknown;
        };
        if (typeof obj.legacyId === "string") {
          knownLegacyIds.add(obj.legacyId);
        }
      } catch {
        /* ignore corrupt rows */
      }
    }
  } catch (err) {
    console.warn(
      "[chat/history/import] pre-check query failed:",
      err instanceof Error ? err.message : String(err),
    );
    // Best-effort: on a DB error in the idempotency check, import anyway —
    // a duplicate is less bad than not importing at all.
  }

  // ---- Import
  let imported = 0;
  let skipped = 0;
  for (const item of items) {
    if (knownLegacyIds.has(item.id)) {
      skipped += 1;
      continue;
    }

    const ms = Date.parse(item.ts);
    const createdAt = Number.isFinite(ms) ? ms : Date.now();

    try {
      if (item.role === "user") {
        await emitChatMessageSent({
          workspaceId,
          content: item.content,
          // pendingPromptId is only formal here — the migration emits
          // a "syntactic sent" without a real stream ever having run
          // behind it.
          pendingPromptId: `legacy-${item.id}`,
          ...(item.intent !== undefined ? { intent: item.intent } : {}),
          legacyId: item.id,
          createdAtOverride: createdAt,
        });
      } else {
        const completedInput: Parameters<
          typeof emitChatMessageCompleted
        >[0] = {
          workspaceId,
          entityId: `legacy-${item.id}`,
          content: item.content,
          outcome: "ok",
          partial: false,
          legacyId: item.id,
          createdAtOverride: createdAt,
        };
        if (item.durationMs !== undefined) {
          completedInput.durationMs = item.durationMs;
        }
        await emitChatMessageCompleted(completedInput);
      }
      imported += 1;
    } catch (err) {
      // P0-5: SQLITE_CONSTRAINT (in particular the unique index on legacyId)
      // is expected on a race between 2 tabs — skip silently, do NOT treat as
      // an error. Keep logging other errors.
      const msg = err instanceof Error ? err.message : String(err);
      const isConstraint =
        /UNIQUE constraint failed/i.test(msg) ||
        /SQLITE_CONSTRAINT/i.test(msg);
      if (!isConstraint) {
        console.warn(
          "[chat/history/import] item failed:",
          item.id,
          msg,
        );
      }
      skipped += 1;
    }
  }

  // ---- B2-fix 2026-04-26: migration-marker event after a successful import.
  // Cross-device source-of-truth — the next browser sees the event and
  // skips the import (pre-check above).
  try {
    await emitEvent({
      segmentId: workspaceId,
      entityType: "workspace",
      entityId: workspaceId,
      eventType: "chat_history_migrated",
      actor: "system",
      payload: { itemsImported: imported, itemsSkipped: skipped, ts: Date.now() },
      sensitivity: "low",
    });
  } catch (err) {
    console.warn(
      "[chat/history/import] marker emit failed:",
      err instanceof Error ? err.message : String(err),
    );
  }

  return NextResponse.json({ imported, skipped });
}
