/**
 * GET /api/workstreams/[id]
 * PATCH /api/workstreams/[id]
 *
 * Detail endpoint with workstream + linked tickets (via
 * events.payload.workstreamId).
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import {
  getWorkstream,
  updateWorkstream,
  type WorkstreamStatus,
} from '@/lib/workstreams/service';
import { listTickets } from '@/lib/tickets/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PatchSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).optional(),
    primarySessionId: z.string().min(1).max(64).nullable().optional(),
    primaryTicketId: z
      .string()
      .min(1)
      .max(64)
      .regex(/^TCK-[A-Za-z0-9]+$/i)
      .nullable()
      .optional(),
    tierMix: z
      .object({
        opus: z.number().int().min(0).max(64),
        sonnet: z.number().int().min(0).max(64),
        haiku: z.number().int().min(0).max(64),
      })
      .nullable()
      .optional(),
    status: z
      .enum(['active', 'paused', 'done', 'archived'])
      .optional(),
  })
  .strict();

interface Ctx {
  params: Promise<{ id: string }>;
}

export async function GET(_req: NextRequest, ctx: Ctx): Promise<Response> {
  const { id } = await ctx.params;
  const workstream = await getWorkstream(id);
  if (!workstream) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  // Fetch all tickets in the same workspace and filter the ones with
  // workstreamId === id. Performant enough for the ~100 tickets per
  // workspace; at scale a dedicated index would pay off.
  const allTickets = await listTickets({ workspaceId: workstream.workspaceId });
  const tickets = allTickets.filter((t) => t.workstreamId === id);
  return NextResponse.json({ workstream, tickets });
}

export async function PATCH(req: NextRequest, ctx: Ctx): Promise<Response> {
  const { id } = await ctx.params;
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const parsed = PatchSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'validation_error', issues: parsed.error.issues },
      { status: 400 },
    );
  }

  try {
    const updated = await updateWorkstream(id, {
      name: parsed.data.name,
      description: parsed.data.description,
      primarySessionId: parsed.data.primarySessionId,
      primaryTicketId: parsed.data.primaryTicketId,
      tierMix: parsed.data.tierMix,
      status: parsed.data.status as WorkstreamStatus | undefined,
    });
    if (!updated) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    return NextResponse.json({ workstream: updated });
  } catch (err) {
    return NextResponse.json(
      {
        error: 'update_failed',
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
