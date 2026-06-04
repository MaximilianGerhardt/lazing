/**
 * GET    /api/skills/:id     → Skill-Detail
 * PATCH  /api/skills/:id     → Skill aktualisieren (built-in: nur description)
 * DELETE /api/skills/:id     → Skill archivieren (built-in nicht erlaubt)
 */

import { NextResponse, type NextRequest } from 'next/server';

import {
  archiveSkill,
  getSkill,
  updateSkill,
  type Effort,
  type Tier,
  type UpdateSkillInput,
} from '@/lib/agents/skills/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VALID_TIERS: readonly Tier[] = ['opus', 'sonnet', 'haiku'];
const VALID_EFFORTS: readonly Effort[] = ['xhigh', 'high', 'medium', 'low'];

interface Ctx {
  params: Promise<{ id: string }>;
}

export async function GET(_req: NextRequest, ctx: Ctx): Promise<Response> {
  const { id } = await ctx.params;
  const skill = getSkill(id);
  if (!skill) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  return NextResponse.json(
    { skill },
    { headers: { 'cache-control': 'no-store' } },
  );
}

export async function PATCH(req: NextRequest, ctx: Ctx): Promise<Response> {
  const { id } = await ctx.params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  if (!isObject(body)) {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }
  const patch: UpdateSkillInput = {};
  if (typeof body.focusPrompt === 'string') patch.focusPrompt = body.focusPrompt;
  if (typeof body.preferTier === 'string') {
    if (!(VALID_TIERS as readonly string[]).includes(body.preferTier)) {
      return NextResponse.json(
        { error: 'validation_error', message: 'invalid preferTier' },
        { status: 400 },
      );
    }
    patch.preferTier = body.preferTier as Tier;
  }
  if (typeof body.defaultEffort === 'string') {
    if (!(VALID_EFFORTS as readonly string[]).includes(body.defaultEffort)) {
      return NextResponse.json(
        { error: 'validation_error', message: 'invalid defaultEffort' },
        { status: 400 },
      );
    }
    patch.defaultEffort = body.defaultEffort as Effort;
  }
  if (typeof body.defaultCount === 'number' && Number.isFinite(body.defaultCount)) {
    patch.defaultCount = Math.min(8, Math.max(1, Math.floor(body.defaultCount)));
  }
  if (body.description === null) {
    patch.description = null;
  } else if (typeof body.description === 'string') {
    patch.description = body.description;
  }
  const updated = updateSkill(id, patch);
  if (!updated) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  return NextResponse.json({ skill: updated });
}

export async function DELETE(_req: NextRequest, ctx: Ctx): Promise<Response> {
  const { id } = await ctx.params;
  const ok = archiveSkill(id);
  if (!ok) {
    return NextResponse.json(
      { error: 'archive_failed', message: 'built-in oder nicht vorhanden' },
      { status: 400 },
    );
  }
  return NextResponse.json({ ok: true });
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
