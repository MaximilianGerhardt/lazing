/**
 * POST /api/workstreams/[id]/extract-subs — Sub-Plan 04 Welle 1 Fix.
 *
 * If the V_final plan contains NO ## Sub-Tickets YAML block
 * (resume-prompt bug until the afternoon of 2026-04-29), this endpoint spawns
 * a Sonnet agent that reads the plan text and extracts a strict YAML-block
 * format. From it, sub-tickets are created via createSubTicketEvent.
 *
 * Idempotent: if the master ticket already has sub-tickets, no-op.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { getDb } from '@/db/client';
import { defaultWorkspacePath } from '@/lib/workspaces/projects-root';
import {
  canEditWorkspaceContent,
  getEffectiveWorkspaceRole,
} from '@/lib/security/permissions';
import { currentUserIdResolved } from '@/lib/security/subject-server';
import {
  parseSubTicketsBlock,
  createSubTicketEvent,
} from '@/server/agents/tier-orchestrator';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface WsRow {
  id: string;
  workspace_id: string;
  primary_ticket_id: string | null;
  name: string;
}

async function authOk(req: NextRequest): Promise<{ userId: string } | null> {
  const userId = currentUserIdResolved(req);
  if (userId) return { userId };
  const auth = req.headers.get('authorization') ?? '';
  const m = /^Bearer\s+(.+)$/.exec(auth);
  if (m) {
    const expected = (process.env.LAZYOS_CHAT_KEY ?? '').trim();
    if (expected.length > 0 && m[1] === expected) return { userId: '@system' };
  }
  return null;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id: workstreamId } = await params;
  const auth = await authOk(req);
  if (!auth) {
    return NextResponse.json({ error: 'auth-required' }, { status: 401 });
  }
  const db = getDb();
  const ws = db.$raw
    .prepare(
      'SELECT id, workspace_id, primary_ticket_id, name FROM workstreams WHERE id=?',
    )
    .get(workstreamId) as WsRow | undefined;
  if (!ws || !ws.primary_ticket_id) {
    return NextResponse.json({ error: 'not-found' }, { status: 404 });
  }
  if (
    auth.userId !== '@system' &&
    !canEditWorkspaceContent(getEffectiveWorkspaceRole(auth.userId, ws.workspace_id))
  ) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  // Idempotent: sub-tickets already present?
  const existing = db.$raw
    .prepare(
      `SELECT count(*) as c FROM events
        WHERE event_type='created'
          AND json_extract(payload,'$.parentTicketId')=?`,
    )
    .get(ws.primary_ticket_id) as { c: number } | undefined;
  if ((existing?.c ?? 0) > 0) {
    return NextResponse.json({
      ok: true,
      already: existing!.c,
      created: 0,
    });
  }

  // Fetch the V_final plan text
  const planRow = db.$raw
    .prepare(
      `SELECT json_extract(payload,'$.text') as text
         FROM events
        WHERE entity_type='ticket' AND entity_id=?
          AND event_type='commented'
          AND json_extract(payload,'$.kind')='iterate-version'
        ORDER BY CAST(json_extract(payload,'$.version') AS INTEGER) DESC,
                 created_at DESC
        LIMIT 1`,
    )
    .get(ws.primary_ticket_id) as { text: string | null } | undefined;
  if (!planRow?.text) {
    return NextResponse.json({ error: 'no-plan' }, { status: 400 });
  }

  // First parse directly — maybe a sub-tickets block IS already in there
  let parsed = parseSubTicketsBlock(planRow.text);

  if (parsed.length === 0) {
    // No YAML block in the plan — Sonnet spawn that extracts it
    try {
      const { spawnInTmux } = await import('@/server/agents/tmux-spawn');
      const { MODEL_NAMES } = await import('@/lib/agents/pricing');
      const wsPathRow = db.$raw
        .prepare('SELECT path FROM workspaces WHERE id=?')
        .get(ws.workspace_id) as { path: string | null } | undefined;
      const workspacePath =
        wsPathRow?.path?.trim() || defaultWorkspacePath(ws.workspace_id);

      const systemPrompt = [
        'Du bist Sub-Ticket-Extractor.',
        'Lies den Master-Plan und identifiziere 2-6 ausführbare Sub-Aufgaben.',
        'Output ist NUR ein YAML-Code-Block, kein Drumherum-Text.',
        'Format strikt:',
        '```yaml',
        '- title: <Imperativ max 80 chars>',
        '  prio: P1',
        '  body: |',
        '    <2-4 Sätze: was, mit welchem Akzeptanzkriterium>',
        '- title: ...',
        '  prio: P2',
        '  body: |',
        '    ...',
        '```',
        'prio aus P0|P1|P2|P3. KEINE Markdown-Formatierung im body.',
        'Maximal 6 Items.',
      ].join('\n');

      const result = await spawnInTmux({
        workspaceId: ws.workspace_id,
        workspacePath,
        workstreamId: `${ws.id}-sub-extract`,
        tier: 'sonnet',
        agentIdx: 1,
        model: MODEL_NAMES.sonnet,
        systemPrompt,
        userPrompt: `Master-Plan:\n\n${planRow.text.slice(0, 8000)}`,
        timeoutMs: 3 * 60_000,
      });
      if (result.text && result.text.trim().length > 0) {
        // Wrap the output in a ## Sub-Tickets section so that
        // parseSubTicketsBlock takes effect
        const wrapped = `## Sub-Tickets\n\n${result.text}`;
        parsed = parseSubTicketsBlock(wrapped);
      }
    } catch (err) {
      return NextResponse.json(
        {
          error: 'extract-failed',
          detail: err instanceof Error ? err.message : String(err),
        },
        { status: 500 },
      );
    }
  }

  if (parsed.length === 0) {
    return NextResponse.json(
      {
        error: 'no-subs-extracted',
        hint: 'Sonnet hat keinen parseable YAML-Block produziert.',
      },
      { status: 422 },
    );
  }

  // Create sub-ticket events
  let created = 0;
  for (const sub of parsed) {
    await createSubTicketEvent({
      workspaceId: ws.workspace_id,
      parentTicketId: ws.primary_ticket_id,
      workstreamId: ws.id,
      title: sub.title,
      prio: sub.prio,
      body: sub.body,
    });
    created += 1;
  }

  return NextResponse.json({
    ok: true,
    workstreamId: ws.id,
    masterTicketId: ws.primary_ticket_id,
    extracted: parsed.length,
    created,
    titles: parsed.map((p) => p.title),
  });
}
