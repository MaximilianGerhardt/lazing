/**
 * POST /api/reasoning-audit/[id]/verify
 *
 * Triggert verifyOne(id) synchron — re-spawnt das Original-Prompt-Paar,
 * vergleicht via Embedding-Cosine, schreibt verified_status zurück.
 *
 * Auth: Bearer LAZYOS_PUSH_SECRET (für Cron-Trigger) ODER eingeloggter
 * User (für UI-Trigger).
 *
 * Achtung: kostet echte LLM-Inferenz. Rate-Limit auf Caller-Seite empfohlen.
 *
 * Pattern 5 Welle 3 (2026-05-01).
 */

import { NextResponse, type NextRequest } from "next/server";

import { verifyOne } from "@/lib/audit/reasoning-verify";
import { currentUserIdResolved } from "@/lib/security/subject-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

function isAuthed(req: NextRequest): boolean {
  const auth = req.headers.get("authorization") ?? "";
  const expected = process.env.LAZYOS_PUSH_SECRET;
  if (expected && auth === `Bearer ${expected}`) return true;
  return Boolean(currentUserIdResolved(req));
}

export async function POST(
  req: NextRequest,
  ctx: RouteContext,
): Promise<Response> {
  if (!isAuthed(req)) {
    return NextResponse.json(
      { error: "auth-required" },
      { status: 401 },
    );
  }

  const { id } = await ctx.params;
  try {
    const decision = await verifyOne(id);
    if (!decision) {
      return NextResponse.json({ error: "not-found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, decision });
  } catch (err) {
    return NextResponse.json(
      {
        error: "verify-failed",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
