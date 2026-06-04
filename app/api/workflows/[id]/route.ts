/**
 * /api/workflows/[id]
 *
 * GET → Single WorkflowDefinition mit kompletter State-Liste (id, label,
 * llmSlot, skillBinding, manualOverride, transitions[]). Conditions selber
 * sind Funktionen — wir geben nur deren id+label preis.
 *
 * Pattern 4 Welle 2.1 (2026-05-01).
 */

import { NextResponse, type NextRequest } from 'next/server';

import type { WorkflowId } from '@/lib/workflows/dsl';
import { getWorkflow } from '@/lib/workflows/registry';
import { requireAuthenticatedUser } from '@/lib/security/subject-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VALID_IDS: ReadonlyArray<WorkflowId> = [
  'dev-sprint',
  'field-measurement',
  'legal-brief',
  'design-gate-flow',
  'legal-correspondence',
];

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = requireAuthenticatedUser({ headers: req.headers });
  if (!auth.ok) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const { id } = await ctx.params;
  if (!(VALID_IDS as readonly string[]).includes(id)) {
    return NextResponse.json({ error: 'unknown_workflow_id' }, { status: 404 });
  }

  const def = getWorkflow(id as WorkflowId);
  if (!def) {
    return NextResponse.json({ error: 'workflow_not_found' }, { status: 404 });
  }

  const states = def.states.map((s) => ({
    id: s.id,
    label: s.label,
    llmSlot: s.llmSlot,
    skillBinding: s.skillBinding,
    manualOverride: s.manualOverride,
    preConditions: s.preConditions.map((c) => ({ id: c.id, label: c.label })),
    postConditions: s.postConditions.map((c) => ({ id: c.id, label: c.label })),
    transitions: s.transitions.map((t) => ({
      to: t.to,
      label: t.label,
      hasCondition: typeof t.condition === 'function',
    })),
  }));

  return NextResponse.json(
    {
      definition: {
        id: def.id,
        version: def.version,
        label: def.label,
        description: def.description,
        initialState: def.initialState,
        triggerHints: def.triggerHints,
        deprecated: def.deprecated ?? false,
        isStub: def.states.length === 1 && def.states[0]?.id === 'noop',
        states,
      },
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
