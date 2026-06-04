/**
 * GET /api/workstreams[?workspaceId=&status=]
 * POST /api/workstreams
 *
 * Phase W: workstream foundation. Workstream container for multi-agent
 * plans. Not event-sourced (its own table due to aggregated state).
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import {
  createWorkstream,
  listWorkstreams,
  type WorkstreamStatus,
} from '@/lib/workstreams/service';
import type { ActorType } from '@/lib/events/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TierMixSchema = z.object({
  opus: z.number().int().min(0).max(64),
  sonnet: z.number().int().min(0).max(64),
  haiku: z.number().int().min(0).max(64),
});

const CreateBodySchema = z
  .object({
    workspaceId: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9_()][a-z0-9_()-]{0,63}$/i),
    name: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
    primarySessionId: z.string().min(1).max(64).optional(),
    primaryTicketId: z
      .string()
      .min(1)
      .max(64)
      .regex(/^TCK-[A-Za-z0-9]+$/i)
      .optional(),
    tierMix: TierMixSchema.optional(),
    actor: z
      .string()
      .min(1)
      .max(128)
      .refine(
        (v) => v === 'system' || v.startsWith('user:') || v.startsWith('agent:'),
      )
      .optional(),
  })
  .strict();

export async function GET(req: NextRequest): Promise<Response> {
  const url = req.nextUrl;
  const workspaceId = url.searchParams.get('workspaceId') ?? undefined;
  const statusRaw = url.searchParams.get('status');
  const status =
    statusRaw === 'active' ||
    statusRaw === 'paused' ||
    statusRaw === 'done' ||
    statusRaw === 'archived' ||
    statusRaw === 'all'
      ? statusRaw
      : undefined;
  const limitRaw = url.searchParams.get('limit');
  const limit = limitRaw ? Math.max(1, Math.min(500, Number(limitRaw) || 100)) : undefined;

  // Phase IA.5 — if no workspaceId comes along, fall back to the org cookie.
  const cookieOrgId = req.cookies.get('lazyos.org')?.value
    ?? req.cookies.get('lazyos_org')?.value
    ?? null;
  const orgFilter = !workspaceId && cookieOrgId && cookieOrgId !== '__all__'
    ? cookieOrgId
    : undefined;
  try {
    const workstreams = await listWorkstreams({
      workspaceId,
      orgId: orgFilter,
      status: status as WorkstreamStatus | 'all' | undefined,
      limit,
    });
    return NextResponse.json({ workstreams });
  } catch (err) {
    return NextResponse.json(
      {
        error: 'list_failed',
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const parsed = CreateBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'validation_error', issues: parsed.error.issues },
      { status: 400 },
    );
  }

  try {
    const workstream = await createWorkstream({
      workspaceId: parsed.data.workspaceId,
      name: parsed.data.name,
      description: parsed.data.description,
      primarySessionId: parsed.data.primarySessionId,
      primaryTicketId: parsed.data.primaryTicketId,
      tierMix: parsed.data.tierMix,
      actor: parsed.data.actor as ActorType | undefined,
    });
    return NextResponse.json(
      {
        workstream,
        url: `/workstreams/${encodeURIComponent(workstream.id)}`,
      },
      { status: 201 },
    );
  } catch (err) {
    return NextResponse.json(
      {
        error: 'create_failed',
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
