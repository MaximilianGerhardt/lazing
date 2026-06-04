/**
 * GET  /api/skills          → Liste aller aktiven Skills (alphabetisch)
 * POST /api/skills          → Neuen User-Skill anlegen
 *
 * Bearer-Auth wie bei den anderen Mutationen.
 */

import { NextResponse, type NextRequest } from 'next/server';

import {
  createSkill,
  listSkills,
  type CreateSkillInput,
  type Effort,
  type Tier,
} from '@/lib/agents/skills/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VALID_TIERS: readonly Tier[] = ['opus', 'sonnet', 'haiku'];
const VALID_EFFORTS: readonly Effort[] = ['xhigh', 'high', 'medium', 'low'];

export async function GET(req: NextRequest): Promise<Response> {
  const includeArchived = req.nextUrl.searchParams.get('includeArchived') === '1';
  const skills = listSkills({ includeArchived });
  return NextResponse.json(
    { skills },
    { headers: { 'cache-control': 'no-store' } },
  );
}

export async function POST(req: NextRequest): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  if (!isObject(body)) {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const focusPrompt =
    typeof body.focusPrompt === 'string' ? body.focusPrompt.trim() : '';
  if (name.length < 2 || focusPrompt.length < 10) {
    return NextResponse.json(
      {
        error: 'validation_error',
        message: 'name >= 2, focusPrompt >= 10 Zeichen',
      },
      { status: 400 },
    );
  }
  const preferTierRaw = typeof body.preferTier === 'string' ? body.preferTier : 'sonnet';
  const defaultEffortRaw =
    typeof body.defaultEffort === 'string' ? body.defaultEffort : 'medium';
  if (!(VALID_TIERS as readonly string[]).includes(preferTierRaw)) {
    return NextResponse.json(
      { error: 'validation_error', message: 'invalid preferTier' },
      { status: 400 },
    );
  }
  if (!(VALID_EFFORTS as readonly string[]).includes(defaultEffortRaw)) {
    return NextResponse.json(
      { error: 'validation_error', message: 'invalid defaultEffort' },
      { status: 400 },
    );
  }
  const defaultCount =
    typeof body.defaultCount === 'number' && Number.isFinite(body.defaultCount)
      ? Math.min(8, Math.max(1, Math.floor(body.defaultCount)))
      : 1;
  const description =
    typeof body.description === 'string' && body.description.trim().length > 0
      ? body.description.trim()
      : undefined;

  const input: CreateSkillInput = {
    name,
    focusPrompt,
    preferTier: preferTierRaw as Tier,
    defaultEffort: defaultEffortRaw as Effort,
    defaultCount,
    description,
  };

  try {
    const skill = createSkill(input);
    return NextResponse.json({ skill }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      {
        error: 'create_failed',
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
