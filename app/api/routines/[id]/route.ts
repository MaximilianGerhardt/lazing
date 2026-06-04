/**
 * GET    /api/routines/[id] — Vollstaendige Routine inkl. yamlConfig.
 * PATCH  /api/routines/[id] — Teil-Update (active / triggerMode / cronExpr / eventMatch / yamlConfig / name).
 * DELETE /api/routines/[id] — Routine entfernen.
 *
 * Alle Writes sind lokal (sqlite). Bridge-Proxy kommt in Sprint 3.
 * Auth: middleware-gated (Session-Cookie ODER Bearer).
 */

import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";

import { getDb } from "@/db/client";
import { routines } from "@/db/schema/routines";
import { emitErrorEvent } from "@/lib/events/emit";
import { validateYamlConfig } from "@/lib/routines/runner";
import { isValidCron, nextRunAt } from "@/lib/routines/scheduler";
import {
  EventMatchSchema,
  UpdateRoutineBodySchema,
} from "@/lib/routines/types";
import { matchesK1Deny } from "@/lib/routines/binding-resolver";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

// ---------------------------------------------------------------------------
// GET — Full Row
// ---------------------------------------------------------------------------

export async function GET(
  _req: NextRequest,
  ctx: RouteContext,
): Promise<Response> {
  const { id } = await ctx.params;
  try {
    const db = getDb();
    const rows = await db
      .select()
      .from(routines)
      .where(eq(routines.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) {
      return NextResponse.json(
        { error: "not_found", message: `routine ${id} not found` },
        { status: 404 },
      );
    }
    // Resolve SOP name if bound (read-only JOIN via raw query — avoids
    // Drizzle schema drift between the migration 0099 columns and the
    // routines Drizzle table definition).
    let sopName: string | null = null;
    if (row.sopId) {
      try {
        const sopRow = db.$raw
          .prepare("SELECT name FROM sops WHERE id = ? LIMIT 1")
          .get(row.sopId) as { name?: string } | undefined;
        sopName = sopRow?.name ?? null;
      } catch {
        // Non-fatal: SOP might not exist (race with migration or orphan ref).
        sopName = null;
      }
    }

    return NextResponse.json(
      {
        routine: {
          id: row.id,
          name: row.name,
          workspaceId: row.workspaceId,
          triggerMode: row.triggerMode,
          cronExpr: row.cronExpr,
          eventMatch: row.eventMatch,
          yamlConfig: row.yamlConfig,
          active: !!row.active,
          lastRunAt: row.lastRunAt,
          nextRunAt: row.nextRunAt,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          // SAR-2 / migration 0099 columns:
          actionKind: row.actionKind ?? "shell",
          sopId: row.sopId ?? null,
          sopName,
          goalPrompt: row.goalPrompt ?? null,
          skillBindingsJson: row.skillBindingsJson ?? null,
          mcpToolAllowlistJson: row.mcpToolAllowlistJson ?? null,
        },
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    await emitErrorEvent("lazyos", `api/routines/${id}:GET`, err);
    return NextResponse.json(
      {
        error: "read_failed",
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}

// ---------------------------------------------------------------------------
// PATCH — Partial Update
// ---------------------------------------------------------------------------

export async function PATCH(
  req: NextRequest,
  ctx: RouteContext,
): Promise<Response> {
  const { id } = await ctx.params;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsed = UpdateRoutineBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_error", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const body = parsed.data;

  // K1 preflight: reject K1-RAG tools in mcpToolAllowlist before writing to DB.
  if (body.mcpToolAllowlist && body.mcpToolAllowlist.length > 0) {
    const blocked = body.mcpToolAllowlist.filter((t) => matchesK1Deny(t));
    if (blocked.length > 0) {
      return NextResponse.json(
        { error: "k1_deny", blocked },
        { status: 400 },
      );
    }
  }

  try {
    const db = getDb();
    const current = (
      await db.select().from(routines).where(eq(routines.id, id)).limit(1)
    )[0];
    if (!current) {
      return NextResponse.json(
        { error: "not_found", message: `routine ${id} not found` },
        { status: 404 },
      );
    }

    // Resolve final values (incoming body field takes precedence, falls back
    // to current row). We need this to validate cross-field invariants
    // (e.g. triggerMode=cron requires cronExpr).
    const finalTriggerMode = body.triggerMode ?? current.triggerMode;
    // undefined → keep, null → explicitly clear.
    const finalCronExprProvided = Object.hasOwn(body, "cronExpr");
    const finalEventMatchProvided = Object.hasOwn(body, "eventMatch");

    let finalCronExpr: string | null = current.cronExpr;
    if (finalCronExprProvided) {
      finalCronExpr = body.cronExpr ?? null;
    }

    let finalEventMatchJson: string | null = current.eventMatch;
    if (finalEventMatchProvided) {
      if (body.eventMatch === null) {
        finalEventMatchJson = null;
      } else if (body.eventMatch !== undefined) {
        // Zod already validated shape.
        finalEventMatchJson = JSON.stringify(body.eventMatch);
      }
    }

    // Validate yamlConfig if provided.
    if (body.yamlConfig !== undefined) {
      try {
        validateYamlConfig(body.yamlConfig);
      } catch (err) {
        return NextResponse.json(
          {
            error: "yaml_invalid",
            message: err instanceof Error ? err.message : String(err),
          },
          { status: 400 },
        );
      }
    }

    // Cross-field validation.
    if (finalTriggerMode === "cron") {
      if (!finalCronExpr) {
        return NextResponse.json(
          {
            error: "cron_required",
            message: "triggerMode=cron requires cronExpr",
          },
          { status: 400 },
        );
      }
      const cv = isValidCron(finalCronExpr);
      if (!cv.ok) {
        return NextResponse.json(
          { error: "cron_invalid", message: cv.error },
          { status: 400 },
        );
      }
    }
    if (finalTriggerMode === "event") {
      if (!finalEventMatchJson) {
        return NextResponse.json(
          {
            error: "event_match_required",
            message: "triggerMode=event requires eventMatch",
          },
          { status: 400 },
        );
      }
      // Validate stored JSON is a valid EventMatch.
      try {
        const parsedMatch = JSON.parse(finalEventMatchJson);
        const matchValidation = EventMatchSchema.safeParse(parsedMatch);
        if (!matchValidation.success) {
          return NextResponse.json(
            {
              error: "event_match_invalid",
              issues: matchValidation.error.issues,
            },
            { status: 400 },
          );
        }
      } catch (err) {
        return NextResponse.json(
          {
            error: "event_match_invalid",
            message: err instanceof Error ? err.message : String(err),
          },
          { status: 400 },
        );
      }
    }

    // Compute nextRunAt when the schedule changed.
    const now = Date.now();
    const scheduleChanged =
      body.triggerMode !== undefined ||
      finalCronExprProvided ||
      (body.active !== undefined && body.active !== !!current.active);

    let newNextRunAt: number | null = current.nextRunAt;
    if (scheduleChanged) {
      if (
        finalTriggerMode === "cron" &&
        finalCronExpr &&
        (body.active ?? !!current.active)
      ) {
        newNextRunAt = nextRunAt(finalCronExpr, now);
      } else {
        newNextRunAt = null;
      }
    }

    const updatePayload: Partial<typeof routines.$inferInsert> = {
      updatedAt: now,
    };
    if (body.name !== undefined) updatePayload.name = body.name;
    if (body.active !== undefined) updatePayload.active = body.active;
    if (body.triggerMode !== undefined) {
      updatePayload.triggerMode = body.triggerMode;
    }
    if (finalCronExprProvided) updatePayload.cronExpr = finalCronExpr;
    if (finalEventMatchProvided) {
      updatePayload.eventMatch = finalEventMatchJson;
    }
    if (body.yamlConfig !== undefined) {
      updatePayload.yamlConfig = body.yamlConfig;
    }
    if (scheduleChanged) updatePayload.nextRunAt = newNextRunAt;

    // SAR-3: plan-dispatch columns — write only when explicitly provided.
    // null values explicitly clear the column (caller intent: remove binding).
    // undefined (field absent from request body) → leave unchanged (PATCH semantics).
    if (body.actionKind !== undefined) {
      updatePayload.actionKind = body.actionKind;
    }
    if (Object.hasOwn(body, "sopId")) {
      updatePayload.sopId = body.sopId ?? null;
    }
    if (Object.hasOwn(body, "goalPrompt")) {
      updatePayload.goalPrompt = body.goalPrompt ?? null;
    }
    if (Object.hasOwn(body, "skillBindings")) {
      updatePayload.skillBindingsJson =
        body.skillBindings != null ? JSON.stringify(body.skillBindings) : null;
    }
    if (Object.hasOwn(body, "mcpToolAllowlist")) {
      updatePayload.mcpToolAllowlistJson =
        body.mcpToolAllowlist != null
          ? JSON.stringify(body.mcpToolAllowlist)
          : null;
    }

    db.update(routines).set(updatePayload).where(eq(routines.id, id)).run();

    // Return fresh row.
    const fresh = (
      await db.select().from(routines).where(eq(routines.id, id)).limit(1)
    )[0];
    if (!fresh) {
      return NextResponse.json(
        { error: "post_update_missing" },
        { status: 500 },
      );
    }

    return NextResponse.json({
      routine: {
        id: fresh.id,
        name: fresh.name,
        workspaceId: fresh.workspaceId,
        triggerMode: fresh.triggerMode,
        cronExpr: fresh.cronExpr,
        eventMatch: fresh.eventMatch,
        yamlConfig: fresh.yamlConfig,
        active: !!fresh.active,
        lastRunAt: fresh.lastRunAt,
        nextRunAt: fresh.nextRunAt,
        createdAt: fresh.createdAt,
        updatedAt: fresh.updatedAt,
        // SAR-3 columns:
        actionKind: fresh.actionKind ?? "shell",
        sopId: fresh.sopId ?? null,
        goalPrompt: fresh.goalPrompt ?? null,
        skillBindingsJson: fresh.skillBindingsJson ?? null,
        mcpToolAllowlistJson: fresh.mcpToolAllowlistJson ?? null,
      },
    });
  } catch (err) {
    await emitErrorEvent("lazyos", `api/routines/${id}:PATCH`, err);
    return NextResponse.json(
      {
        error: "update_failed",
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}

// ---------------------------------------------------------------------------
// DELETE
// ---------------------------------------------------------------------------

export async function DELETE(
  _req: NextRequest,
  ctx: RouteContext,
): Promise<Response> {
  const { id } = await ctx.params;
  try {
    const db = getDb();
    const res = db.delete(routines).where(eq(routines.id, id)).run();
    if (res.changes === 0) {
      return NextResponse.json(
        { error: "not_found", message: `routine ${id} not found` },
        { status: 404 },
      );
    }
    return NextResponse.json({ ok: true, deleted: id });
  } catch (err) {
    await emitErrorEvent("lazyos", `api/routines/${id}:DELETE`, err);
    return NextResponse.json(
      {
        error: "delete_failed",
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
