/**
 * /api/workflows
 *
 * GET  → Liste aller WorkflowDefinitions (Registry-Dump, ohne State-Bodies).
 * POST → Startet einen neuen Run für eine Definition.
 *
 * Pattern 4 Welle 2.1 (2026-05-01).
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { WORKFLOW_REGISTRY, getWorkflow } from '@/lib/workflows/registry';
import { createRun } from '@/lib/workflows/store';
import { emitStartedEvent } from '@/lib/workflows/runner';
import type { WorkflowId } from '@/lib/workflows/dsl';
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

const StartBodySchema = z
  .object({
    workflowId: z.string().refine(
      (v): v is WorkflowId => (VALID_IDS as readonly string[]).includes(v),
      { message: 'unknown workflowId' },
    ),
    workspaceId: z.string().min(1).max(64).optional(),
    workstreamId: z.string().min(1).max(64).optional(),
    initialData: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export async function GET(req: NextRequest): Promise<Response> {
  const auth = requireAuthenticatedUser({ headers: req.headers });
  if (!auth.ok) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const definitions = Object.values(WORKFLOW_REGISTRY).map((def) => ({
    id: def.id,
    version: def.version,
    label: def.label,
    description: def.description,
    initialState: def.initialState,
    stateCount: def.states.length,
    triggerHints: def.triggerHints,
    deprecated: def.deprecated ?? false,
    isStub: def.states.length === 1 && def.states[0]?.id === 'noop',
  }));

  return NextResponse.json(
    { definitions },
    { headers: { 'cache-control': 'no-store' } },
  );
}

export async function POST(req: NextRequest): Promise<Response> {
  const auth = requireAuthenticatedUser({ headers: req.headers });
  if (!auth.ok) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const parsed = StartBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'validation_error', issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const def = getWorkflow(parsed.data.workflowId);
  if (!def) {
    return NextResponse.json({ error: 'workflow_not_found' }, { status: 404 });
  }

  try {
    const run = await createRun({
      workflowId: parsed.data.workflowId,
      definitionVersion: def.version,
      workspaceId: parsed.data.workspaceId ?? null,
      workstreamId: parsed.data.workstreamId ?? null,
      initialState: def.initialState,
      initialData: parsed.data.initialData,
    });
    await emitStartedEvent(run);
    return NextResponse.json(
      {
        run,
        url: `/workflows/runs/${encodeURIComponent(run.id)}`,
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
