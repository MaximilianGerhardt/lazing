/**
 * Work-Products Single-Item API (Sprint 2 · 7I).
 *
 *   GET    /api/tickets/:id/products/:wpId   — single work-product (full content)
 *   PATCH  /api/tickets/:id/products/:wpId   — update (title/content/status)
 *   DELETE /api/tickets/:id/products/:wpId   — soft-delete (status='superseded')
 */

import { NextResponse, type NextRequest } from "next/server";

import { emitErrorEvent } from "@/lib/events/emit";
import type { ActorType } from "@/lib/events/types";
import { UpdateWorkProductBodySchema } from "@/lib/work-products/schema";
import {
  WorkProductNotFoundError,
  getWorkProduct,
  supersedeWorkProduct,
  updateWorkProduct,
} from "@/lib/work-products/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string; wpId: string }>;
}

// ---------------------------------------------------------------------------
// GET /api/tickets/:id/products/:wpId
// ---------------------------------------------------------------------------

export async function GET(_req: NextRequest, ctx: Ctx): Promise<Response> {
  const { id, wpId } = await ctx.params;
  if (!id || !wpId) {
    return NextResponse.json({ error: "missing_id" }, { status: 400 });
  }

  try {
    const product = await getWorkProduct(id, wpId);
    if (!product) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json(
      { product },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    await emitErrorEvent(
      "lazyos",
      `api/tickets/${id}/products/${wpId}:GET`,
      err,
    );
    return NextResponse.json(
      { error: "read_failed", message: errorMessage(err) },
      { status: 500 },
    );
  }
}

// ---------------------------------------------------------------------------
// PATCH
// ---------------------------------------------------------------------------

export async function PATCH(req: NextRequest, ctx: Ctx): Promise<Response> {
  const { id, wpId } = await ctx.params;
  if (!id || !wpId) {
    return NextResponse.json({ error: "missing_id" }, { status: 400 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsed = UpdateWorkProductBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_error", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  try {
    const product = await updateWorkProduct(id, wpId, {
      title: parsed.data.title,
      content: parsed.data.content,
      mime: parsed.data.mime,
      status: parsed.data.status,
      actor: (parsed.data.actor ?? undefined) as ActorType | undefined,
    });
    return NextResponse.json({ product });
  } catch (err) {
    if (err instanceof WorkProductNotFoundError) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    await emitErrorEvent(
      "lazyos",
      `api/tickets/${id}/products/${wpId}:PATCH`,
      err,
    );
    return NextResponse.json(
      { error: "update_failed", message: errorMessage(err) },
      { status: 500 },
    );
  }
}

// ---------------------------------------------------------------------------
// DELETE (soft)
// ---------------------------------------------------------------------------

export async function DELETE(
  _req: NextRequest,
  ctx: Ctx,
): Promise<Response> {
  const { id, wpId } = await ctx.params;
  if (!id || !wpId) {
    return NextResponse.json({ error: "missing_id" }, { status: 400 });
  }

  try {
    const product = await supersedeWorkProduct(id, wpId);
    return NextResponse.json({ product, superseded: true });
  } catch (err) {
    if (err instanceof WorkProductNotFoundError) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    await emitErrorEvent(
      "lazyos",
      `api/tickets/${id}/products/${wpId}:DELETE`,
      err,
    );
    return NextResponse.json(
      { error: "supersede_failed", message: errorMessage(err) },
      { status: 500 },
    );
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
