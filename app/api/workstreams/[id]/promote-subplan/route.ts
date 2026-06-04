/**
 * POST /api/workstreams/[id]/promote-subplan — BACKPORT-03 (2026-05-23).
 *
 * Operator promotes a parent step's lazily-proposed subplan into a
 * persistent set of workstream_plan_steps rows (depth = parentDepth+1).
 * Returns 409 when MAX_SUBPLAN_DEPTH would be exceeded.
 *
 * Body:
 *   {
 *     parentStep:   PlanStep,
 *     parentDepth:  number,
 *     subplan:      ProposedPlan,
 *     coordKey:     string         // N9 ManifestCoord
 *   }
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { promoteSubplan } from '@/lib/workstreams/plan-repo';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PlanStepSchema = z.object({
  id: z.string().min(1),
  index: z.number().int().positive(),
  title: z.string().min(1),
  rationale: z.string().min(1),
  targetFiles: z.array(z.string()).optional(),
  subagentRole: z.enum(['architect', 'coder', 'tester', 'reviewer']).optional(),
  expectedArtifacts: z.array(z.string()).optional(),
});

const ProposedPlanSchema = z.object({
  id: z.string().min(1),
  originalIntent: z.string(),
  steps: z.array(PlanStepSchema).min(1),
  estimatedComplexity: z.enum(['M', 'L', 'XL']),
  proposedAt: z.number().int(),
});

const BodySchema = z.object({
  parentStep: PlanStepSchema,
  parentDepth: z.number().int().min(0).max(2),
  subplan: ProposedPlanSchema,
  coordKey: z.string().min(1),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: workstreamId } = await params;
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid-json' }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid-body', details: parsed.error.format() },
      { status: 400 },
    );
  }
  const body = parsed.data;
  try {
    const rows = promoteSubplan({
      workstreamId,
      parentStep: body.parentStep,
      parentDepth: body.parentDepth,
      subplan: body.subplan,
      coordKey: body.coordKey,
    });
    if (rows === null) {
      return NextResponse.json(
        { error: 'depth-cap-exceeded', maxDepth: 3 },
        { status: 409 },
      );
    }
    return NextResponse.json({
      ok: true,
      planId: body.subplan.id,
      depth: body.parentDepth + 1,
      stepsInserted: rows.length,
    });
  } catch (err) {
    return NextResponse.json(
      { error: 'promote-failed', message: (err as Error).message },
      { status: 500 },
    );
  }
}
