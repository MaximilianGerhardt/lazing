/**
 * POST /api/chat/history/[workspaceId]/import
 *
 * Phase MS · MS.6 · 2026-04-26. One-shot-Migration der bestehenden
 * localStorage-History in chat_message-Events. Idempotent: pro
 * `payload.legacyId === item.id` wird hoechstens EIN Event geschrieben.
 *
 * Auth: Cookie-basiert.
 *
 * Body:
 *   { items: HistoryItem[] }
 *
 * Verhalten:
 *   - Pro Item wird ein chat_message_sent ODER chat_message_completed
 *     Event geschrieben (je nach role), backdated mit ts aus item.ts.
 *   - Bestehende Events mit dem gleichen legacyId werden uebersprungen.
 *   - Antwort: { imported: N, skipped: M }
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

// Org-Root-Scope `__org_root__:<orgId>` (Phase IA.1) muss durchgehen — der
// optionale Prefix war bisher nicht erlaubt, der `:` wurde verworfen → 400.
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
  // localStorage-Marker per Browser/Device taugt nicht als
  // Source-of-Truth — cross-device + cross-browser triggert sonst
  // jeder Mount neu (UNIQUE-Index fängt's, aber 60 Roundtrips pro Mount
  // ist Performance-Killer). Wenn bereits ein chat_history_migrated-
  // Event existiert: kurzzirkuit zurück, Client setzt seinen lokalen
  // Marker und ist fertig.
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
    // Fall through — bei DB-Fehler doch importieren (Idempotency
    // ueber legacyId-Pre-Check unten greift trotzdem).
  }
  if (alreadyMigrated) {
    return NextResponse.json({
      imported: 0,
      skipped: items.length,
      alreadyMigrated: true,
    });
  }

  if (items.length === 0) {
    // Kein Item => trotzdem Marker setzen damit zukuenftige Mounts
    // diese leere Migration nicht erneut versuchen.
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

  // ---- Pre-check: welche legacyIds sind schon importiert?
  const knownLegacyIds = new Set<string>();
  try {
    // Wir suchen events fuer diesen Workspace, entityType chat_message,
    // deren payload-JSON den legacyId enthaelt. SQLite-LIKE auf TEXT-payload
    // ist O(n) aber bei <1000 chat_message-Events fuer einen Workspace OK
    // — und das laeuft genau einmal pro Workspace pro Browser.
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
    // Best-effort: bei DB-Fehler im Idempotency-Check doch importieren —
    // duplicate ist weniger schlimm als gar nicht importieren.
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
          // pendingPromptId ist hier nur formal — Migration emittiert
          // ein "syntactic sent" ohne dass jemals ein echter Stream
          // dahinter lief.
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
      // P0-5: SQLITE_CONSTRAINT (insbesondere Unique-Index auf legacyId)
      // ist erwartet bei Race zwischen 2 Tabs — silent skippen, NICHT als
      // Error werten. Andere Errors weiterhin loggen.
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

  // ---- B2-fix 2026-04-26: Migration-Marker-Event nach erfolgreichem Import.
  // Cross-Device Source-of-Truth — naechster Browser sieht das Event und
  // ueberspringt den Import (Pre-Check oben).
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
