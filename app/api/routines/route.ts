/**
 * GET  /api/routines           — Liste aller Routinen (proxied to VPS when bridge configured).
 * POST /api/routines           — Create (LOCAL — writes via proxy land in Sprint 3).
 *
 * Auth: middleware-gated (Session-Cookie ODER Bearer).
 */

import { NextResponse, type NextRequest } from "next/server";

import { getDb } from "@/db/client";
import { routines } from "@/db/schema/routines";
import { emitErrorEvent } from "@/lib/events/emit";
import { validateYamlConfig } from "@/lib/routines/runner";
import { isValidCron, nextRunAt } from "@/lib/routines/scheduler";
import { CreateRoutineBodySchema } from "@/lib/routines/types";
import { ulid } from "@/lib/ulid";
import { desc } from "drizzle-orm";
import { bridgeOrLocal, emptyCollection } from "@/lib/vps-bridge/route-helpers";
import { matchesK1Deny } from "@/lib/routines/binding-resolver";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function listRoutinesLocal(): Promise<Response> {
  try {
    const db = getDb();
    const rows = await db
      .select({
        id: routines.id,
        name: routines.name,
        workspaceId: routines.workspaceId,
        triggerMode: routines.triggerMode,
        cronExpr: routines.cronExpr,
        eventMatch: routines.eventMatch,
        lastRunAt: routines.lastRunAt,
        nextRunAt: routines.nextRunAt,
        active: routines.active,
        createdAt: routines.createdAt,
        updatedAt: routines.updatedAt,
      })
      .from(routines)
      .orderBy(desc(routines.updatedAt));

    return NextResponse.json(
      { routines: rows },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    await emitErrorEvent("lazyos", "api/routines:GET", err);
    // Degrade to empty collection so the UI can render an empty-state
    // rather than a 500 banner. The degraded header communicates the
    // underlying failure.
    return emptyCollection("routines");
  }
}

export async function GET(): Promise<Response> {
  return bridgeOrLocal<{ routines: unknown[] }>({
    path: "/api/routines",
    fallback: () => listRoutinesLocal(),
    validate: (body): body is { routines: unknown[] } => {
      if (!body || typeof body !== "object") return false;
      return Array.isArray((body as { routines?: unknown }).routines);
    },
  });
}

export async function POST(req: NextRequest): Promise<Response> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsed = CreateRoutineBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_error", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const body = parsed.data;

  // K1 preflight: reject K1-RAG tools in mcpToolAllowlist before writing to DB.
  // Silent-accept would let a client persist K1-denied tools and discover the
  // block only at execution time. Preflight gives an unambiguous 400 instead.
  if (body.mcpToolAllowlist && body.mcpToolAllowlist.length > 0) {
    const blocked = body.mcpToolAllowlist.filter((t) => matchesK1Deny(t));
    if (blocked.length > 0) {
      return NextResponse.json(
        { error: "k1_deny", blocked },
        { status: 400 },
      );
    }
  }

  // YAML pre-validate — lieber hier mit 400 abweisen als erst beim ersten Run.
  // Exception: plan-dispatch routines may omit a meaningful YAML pipeline (the
  // SOP→plan bridge bypasses the collect_context pipeline entirely). We still
  // require yamlConfig to be syntactically valid YAML (not necessarily a valid
  // RoutineConfig) so the column is never garbage; but for action_kind=
  // 'plan-dispatch' we skip the RoutineConfig schema validation step because
  // the YAML pipeline fields are irrelevant for this action kind.
  if (body.actionKind !== "plan-dispatch") {
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

  // Cron-Validate falls cron-Modus.
  if (body.triggerMode === "cron") {
    if (!body.cronExpr) {
      return NextResponse.json(
        { error: "cron_required", message: "triggerMode=cron requires cronExpr" },
        { status: 400 },
      );
    }
    const cv = isValidCron(body.cronExpr);
    if (!cv.ok) {
      return NextResponse.json(
        { error: "cron_invalid", message: cv.error },
        { status: 400 },
      );
    }
  }

  if (body.triggerMode === "event" && !body.eventMatch) {
    return NextResponse.json(
      { error: "event_match_required", message: "triggerMode=event requires eventMatch" },
      { status: 400 },
    );
  }

  try {
    const db = getDb();
    const now = Date.now();
    const id = `RTN-${ulid()}`;
    const next =
      body.triggerMode === "cron" && body.cronExpr
        ? nextRunAt(body.cronExpr, now)
        : null;

    // SAR-3: serialise plan-dispatch columns to DB representation.
    // skillBindings → JSON map string; mcpToolAllowlist → JSON array string.
    // Both default to null (absent → no override).
    const skillBindingsJson = body.skillBindings
      ? JSON.stringify(body.skillBindings)
      : null;
    const mcpToolAllowlistJson = body.mcpToolAllowlist
      ? JSON.stringify(body.mcpToolAllowlist)
      : null;

    db.insert(routines)
      .values({
        id,
        name: body.name,
        workspaceId: body.workspaceId,
        yamlConfig: body.yamlConfig,
        triggerMode: body.triggerMode,
        cronExpr: body.cronExpr ?? null,
        eventMatch: body.eventMatch ? JSON.stringify(body.eventMatch) : null,
        lastRunAt: null,
        nextRunAt: next,
        active: body.active,
        createdAt: now,
        updatedAt: now,
        // SAR-3 columns (Migration 0099 — present in Drizzle schema):
        actionKind: body.actionKind,
        sopId: body.sopId ?? null,
        goalPrompt: body.goalPrompt ?? null,
        skillBindingsJson,
        mcpToolAllowlistJson,
      })
      .run();

    return NextResponse.json({ id, nextRunAt: next }, { status: 201 });
  } catch (err) {
    await emitErrorEvent(body.workspaceId, "api/routines:POST", err);
    return NextResponse.json(
      {
        error: "create_failed",
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
