/**
 * POST /api/workstreams/[id]/critique — BACKPORT-03 (2026-05-23).
 *
 * Schreibt einen Critic-Verdict für einen plan-step. Operator-facing
 * Endpoint für manuelle Verdicts + Operator-Override (INV-18).
 *
 * Body:
 *   {
 *     planStepId:   string,
 *     iteration:    number,             // 0 = initial; 1+2 = fix-iter
 *     verdict:      'pass'|'conditional'|'fail',
 *     comments:     Array<{role,text,severity}>,
 *     criticRole?:  'critic'|'cross-roast'|'operator',
 *     coordKey:     string,             // INV-19
 *     override?:    { note: string }    // INV-18 (operator override path)
 *   }
 *
 * Returns 200 + { roundId, verdict, nextState } on success.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { makeCriticRepo } from '@/lib/workstreams/critic-repo';
import {
  applyOperatorOverride,
  writeCriticRoundForStep,
  type CriticLoopContext,
  type CriticLoopState,
} from '@/lib/critic-loop/critic-loop';
import { writeReasoningAudit } from '@/lib/audit/reasoning';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CommentSchema = z.object({
  role: z.string(),
  text: z.string(),
  severity: z.string(),
});

const BodySchema = z.object({
  planStepId: z.string().min(1),
  iteration: z.number().int().min(0).max(2),
  verdict: z.enum(['pass', 'conditional', 'fail']),
  comments: z.array(CommentSchema).default([]),
  criticRole: z.enum(['critic', 'cross-roast', 'operator']).default('critic'),
  coordKey: z.string().min(1),
  override: z.object({ note: z.string().min(1) }).optional(),
  workstreamIdInBody: z.string().nullable().optional(),
  role: z.enum(['architect', 'coder', 'tester', 'reviewer']).optional(),
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

  const ctx: CriticLoopContext = {
    stepId: body.planStepId,
    coordKey: body.coordKey,
    workstreamId,
    role: body.role,
  };

  const repo = makeCriticRepo();

  // Operator-Override-Pfad (INV-18) — overrides require failed-escalated.
  if (body.override !== undefined) {
    const stateForOverride: CriticLoopState = {
      kind: 'failed-escalated',
      iteration: body.iteration,
      lastVerdict: body.verdict,
    };
    try {
      const next = applyOperatorOverride({
        ctx,
        state: stateForOverride,
        note: body.override.note, // verbatim (N1)
        writeUserOverride: (args) => {
          // N8: persist the operator override as a reasoning_audit row
          // (phase='critic-override', role='operator'). Fail-soft — the helper
          // catches its own errors; the FSM transition remains the contract.
          void args;
          writeReasoningAudit({
            workstreamId,
            phase: 'critic-override',
            role: 'operator',
            llmProvider: 'operator',
            llmModel: 'manual',
            systemPrompt: `Operator override for plan step ${body.planStepId} (iteration ${body.iteration}); prior verdict: ${body.verdict}.`,
            userPrompt: body.override?.note ?? '',
            output: body.override?.note ?? '',
          });
        },
      });
      return NextResponse.json({
        ok: true,
        nextState: next,
        override: true,
      });
    } catch (err) {
      return NextResponse.json(
        { error: 'override-rejected', message: (err as Error).message },
        { status: 409 },
      );
    }
  }

  // Standard-Critic-Pfad — writeCriticRoundForStep mit critic-pending state.
  const stateForRound: CriticLoopState = {
    kind: 'critic-pending',
    iteration: body.iteration,
  };
  try {
    const after = writeCriticRoundForStep(
      ctx,
      stateForRound,
      body.verdict,
      body.comments,
      repo,
      body.criticRole === 'operator' ? 'critic' : body.criticRole,
    );
    return NextResponse.json({
      ok: true,
      roundId: after.persisted?.id ?? null,
      verdict: body.verdict,
      nextState: after.next,
      walkerHint: after.walkerHint,
    });
  } catch (err) {
    return NextResponse.json(
      { error: 'critic-write-failed', message: (err as Error).message },
      { status: 500 },
    );
  }
}
