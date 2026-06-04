/**
 * Work-Products Collection API (Sprint 2 · 7I).
 *
 *   GET  /api/tickets/:id/products           — list (exclude superseded by default)
 *   POST /api/tickets/:id/products           — create
 *
 * Auth: middleware gated (Cookie ODER Bearer — beides ist in der
 * middleware.ts ueber `verifySessionCookieValue` plus der Bearer-Policy
 * aus `lib/security/*` abgedeckt).
 */

import { NextResponse, type NextRequest } from "next/server";

import { emitErrorEvent } from "@/lib/events/emit";
import { currentActor } from "@/lib/security/subject";
import {
  CreateWorkProductBodySchema,
} from "@/lib/work-products/schema";
import {
  WorkProductNotFoundError,
  createWorkProduct,
  listWorkProducts,
} from "@/lib/work-products/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

// ---------------------------------------------------------------------------
// GET /api/tickets/:id/products
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest, ctx: Ctx): Promise<Response> {
  const { id } = await ctx.params;
  if (!id) {
    return NextResponse.json({ error: "missing_id" }, { status: 400 });
  }

  const includeSuperseded =
    req.nextUrl.searchParams.get("includeSuperseded") === "1";

  try {
    const products = await listWorkProducts(id, { includeSuperseded });
    return NextResponse.json(
      { products, count: products.length },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    await emitErrorEvent("lazyos", `api/tickets/${id}/products:GET`, err);
    return NextResponse.json(
      { error: "list_failed", message: errorMessage(err) },
      { status: 500 },
    );
  }
}

// ---------------------------------------------------------------------------
// POST /api/tickets/:id/products
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  const { id } = await ctx.params;
  if (!id) {
    return NextResponse.json({ error: "missing_id" }, { status: 400 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsed = CreateWorkProductBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_error", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  // createdBy: aus body.actor ableiten (API behaelt Actor-Contract),
  // sonst aus dem VERIFIZIERTEN Subject.
  //
  // P0-#1b / F-1b (2026-05-25): Der frühere Fallback auf den inbound-Header
  // `x-lazyos-actor` war eine Audit-Spoof-Klasse — ein bearer-authentifizierter
  // Caller konnte damit ein beliebiges Identitäts-Label in den Audit-Trail
  // (createdBy des Work-Products) schreiben. Der Header ist jetzt von der
  // Middleware bedingungslos gestript; der Fallback kommt aus der
  // kryptographisch verifizierten Quelle (`currentActor` → verifiziertes
  // `x-lazyos-subject`, z.B. `user:<id>`, `agent:cli`, `system:bridge`).
  const createdBy = parsed.data.actor ?? currentActor(req);

  try {
    const product = await createWorkProduct({
      ticketId: id,
      type: parsed.data.type,
      title: parsed.data.title,
      content: parsed.data.content,
      mime: parsed.data.mime,
      status: parsed.data.status,
      createdBy,
    });
    return NextResponse.json(
      {
        product,
        url: `/tickets/${encodeURIComponent(id)}#wp-${product.id}`,
      },
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof WorkProductNotFoundError) {
      return NextResponse.json(
        { error: "ticket_not_found", ticketId: id },
        { status: 404 },
      );
    }
    await emitErrorEvent("lazyos", `api/tickets/${id}/products:POST`, err);
    return NextResponse.json(
      { error: "create_failed", message: errorMessage(err) },
      { status: 500 },
    );
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
