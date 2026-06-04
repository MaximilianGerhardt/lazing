/**
 * /api/workflows/runs/[runId]
 *
 * GET  → Run-Status + History (workflow.* events from `events`-Tabelle).
 * POST → Manual-Override-Transition (`{ targetState }`). Erfordert
 *        manualOverride='allow' am current state — sonst 409.
 *
 * Pattern 4 Welle 2.1 (2026-05-01).
 */

import { NextResponse, type NextRequest } from 'next/server';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';

import { getDb } from '@/db/client';
import { events as eventsTable } from '@/db/schema/events';
import { loadRun } from '@/lib/workflows/store';
import { transitionTo } from '@/lib/workflows/runner';
import { getWorkflow } from '@/lib/workflows/registry';
import { findState } from '@/lib/workflows/dsl';
import { requireAuthenticatedUser } from '@/lib/security/subject-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TransitionBodySchema = z
  .object({
    targetState: z.string().min(1).max(64),
  })
  .strict();

const WORKFLOW_EVENT_TYPES = [
  'workflow.started',
  'workflow.transitioned',
  'workflow.stuck',
  'workflow.completed',
] as const;

interface HistoryEntry {
  id: string;
  createdAt: number;
  eventType: string;
  actor: string;
  payload: Record<string, unknown>;
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ runId: string }> },
): Promise<Response> {
  const auth = requireAuthenticatedUser({ headers: req.headers });
  if (!auth.ok) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const { runId } = await ctx.params;
  const run = await loadRun(runId);
  if (!run) {
    return NextResponse.json({ error: 'run_not_found' }, { status: 404 });
  }

  const def = getWorkflow(run.workflowId, run.definitionVersion);
  const currentStateNode = def ? findState(def, run.currentState) : null;

  // History: workflow.*-Events aus Events-Tabelle.
  const db = getDb();
  const eventRows = await db
    .select()
    .from(eventsTable)
    .where(
      and(
        eq(eventsTable.entityType, 'workflow_run'),
        eq(eventsTable.entityId, run.id),
        inArray(eventsTable.eventType, WORKFLOW_EVENT_TYPES as readonly string[] as string[]),
      ),
    )
    .orderBy(desc(eventsTable.createdAt))
    .limit(200);

  const history: HistoryEntry[] = eventRows.map((row) => {
    let payload: Record<string, unknown> = {};
    try {
      const obj = JSON.parse(row.payload) as unknown;
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        payload = obj as Record<string, unknown>;
      }
    } catch {
      // ignore malformed payload
    }
    return {
      id: row.id,
      createdAt: row.createdAt,
      eventType: row.eventType,
      actor: row.actor,
      payload,
    };
  });

  return NextResponse.json(
    {
      run,
      currentStateMeta: currentStateNode
        ? {
            label: currentStateNode.label,
            llmSlot: currentStateNode.llmSlot,
            manualOverride: currentStateNode.manualOverride,
            transitions: currentStateNode.transitions.map((t) => ({
              to: t.to,
              label: t.label,
            })),
          }
        : null,
      history,
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ runId: string }> },
): Promise<Response> {
  const auth = requireAuthenticatedUser({ headers: req.headers });
  if (!auth.ok) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const { runId } = await ctx.params;
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const parsed = TransitionBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'validation_error', issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const run = await loadRun(runId);
  if (!run) {
    return NextResponse.json({ error: 'run_not_found' }, { status: 404 });
  }

  try {
    await transitionTo(runId, parsed.data.targetState);
    const updated = await loadRun(runId);
    return NextResponse.json({ run: updated });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = msg.includes("manualOverride='forbid'") ? 409 : 400;
    return NextResponse.json(
      { error: 'transition_failed', detail: msg },
      { status },
    );
  }
}
