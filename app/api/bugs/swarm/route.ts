/**
 * POST /api/bugs/swarm
 * --------------------
 * Sprint H · 2026-04-30 — Bug-Fix-Swarm Trigger.
 *
 * Body:
 *   {
 *     workspaceId: string;
 *     bugDescription: string;
 *     errorContext?: { stack?: string; file?: string; line?: number };
 *   }
 *
 * Response:
 *   { swarmId, workstreamId, masterTicketId }
 *
 * Server-Pfad:
 *   1. Master-Ticket anlegen (prio P0, title aus erster Zeile)
 *   2. Workstream anlegen (mode='bug-swarm')
 *   3. Surface-Card emittieren (<surface:bug-fix-swarm>)
 *   4. runBugSwarm() im Hintergrund starten — Endpoint antwortet sofort.
 */

import fs from 'node:fs';

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { createTicket } from '@/lib/tickets/service';
import { createWorkstream, updateWorkstream } from '@/lib/workstreams/service';
import { getWorkspace } from '@/lib/workspaces';
import { defaultWorkspacePath, projectsRoot } from '@/lib/workspaces/projects-root';
import { getDb } from '@/db/client';
import { ulid } from '@/lib/ulid';
import { runBugSwarm } from '@/server/agents/bug-swarm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BodySchema = z
  .object({
    workspaceId: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9_()][a-z0-9_()-]{0,63}$/i),
    bugDescription: z.string().min(1).max(20_000),
    errorContext: z
      .object({
        stack: z.string().max(20_000).optional(),
        file: z.string().max(500).optional(),
        line: z.number().int().min(1).max(10_000_000).optional(),
      })
      .optional(),
  })
  .strict();

async function resolveWorkspacePath(workspaceId: string): Promise<string> {
  if (workspaceId === '__root__') return projectsRoot();
  const ws = await getWorkspace(workspaceId).catch(() => null);
  if (ws && typeof ws.path === 'string' && fs.existsSync(ws.path)) return ws.path;
  const guess = defaultWorkspacePath(workspaceId);
  if (fs.existsSync(guess)) return guess;
  return projectsRoot();
}

function firstLine(s: string, max = 80): string {
  const line = s.split('\n').find((l) => l.trim().length > 0) ?? s;
  return line.trim().slice(0, max);
}

export async function POST(req: NextRequest): Promise<Response> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'validation_error', issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const { workspaceId, bugDescription, errorContext } = parsed.data;

  // 1. Master-Ticket
  const titleLine = firstLine(bugDescription, 80);
  const ticketBody = [
    bugDescription,
    errorContext?.stack ? `\n\nStack-Trace:\n${errorContext.stack}` : '',
    errorContext?.file
      ? `\n\nHinweis-File: ${errorContext.file}${errorContext.line ? `:${errorContext.line}` : ''}`
      : '',
  ].join('');

  const ticket = await createTicket({
    workspaceId,
    title: `Bug: ${titleLine}`,
    body: ticketBody,
    prio: 'P0',
    actor: 'system',
  });

  // 2. Workstream
  const workstream = await createWorkstream({
    workspaceId,
    name: `Bug-Swarm: ${titleLine}`,
    description: 'Bug-Fix-Swarm: 3 parallele Diagnose-Spawns + Konsens + Fix + Root-Cause.',
    primaryTicketId: ticket.id,
  });

  // 3. mode='bug-swarm' + Initial-Config persistieren (analog zu spawn-route).
  try {
    const db = getDb();
    db.$raw
      .prepare(
        `UPDATE workstreams SET mode = ?, iterate_config_json = ? WHERE id = ?`,
      )
      .run('bug-swarm', JSON.stringify({ swarmRoles: ['senior-dev', 'code-reviewer', 'critic'] }), workstream.id);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[bug-swarm] mode-persist failed:', err);
  }

  // Mark ticket as workstream-attached (best-effort).
  await updateWorkstream(workstream.id, { primaryTicketId: ticket.id }).catch(
    () => undefined,
  );

  const swarmId = `BSW-${ulid()}`;
  const workspacePath = await resolveWorkspacePath(workspaceId);

  // 4. Background-Run — wir warten NICHT, der Frontend pollt.
  void (async () => {
    try {
      await runBugSwarm({
        swarmId,
        workspaceId,
        workspacePath,
        workstreamId: workstream.id,
        masterTicketId: ticket.id,
        bugDescription,
        errorContext,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[bug-swarm] runBugSwarm crashed:', err);
    }
  })();

  return NextResponse.json({
    ok: true,
    swarmId,
    workstreamId: workstream.id,
    masterTicketId: ticket.id,
  });
}
