/**
 * POST /api/tickets/:id/comment
 * -----------------------------
 * Append a comment-event to the ticket timeline. Validates body + delegates
 * to `lib/tickets/service.addComment`, which emits a `commented` event.
 */

import { NextResponse, type NextRequest } from "next/server";

import { emitErrorEvent } from "@/lib/events/emit";
import { CommentBodySchema } from "@/lib/tickets/schema";
import { TicketNotFoundError, addComment } from "@/lib/tickets/service";
import type { ActorType } from "@/lib/events/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

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

  const parsed = CommentBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_error", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  try {
    const event = await addComment(id, {
      text: parsed.data.text,
      actor: (parsed.data.actor ?? undefined) as ActorType | undefined,
      intent: parsed.data.intent,
      target: parsed.data.target,
    });
    return NextResponse.json({ event }, { status: 201 });
  } catch (err) {
    if (err instanceof TicketNotFoundError) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    await emitErrorEvent("lazyos", `api/tickets/${id}/comment:POST`, err);
    return NextResponse.json(
      { error: "comment_failed", message: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
