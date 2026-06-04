/**
 * POST /api/workstreams/[id]/execute-plan
 *
 * Slice 3 · Phase 1 — NICHT-DESTRUKTIVE Plan-Ausführung (2026-05-23).
 *
 * Startet den sequenziellen Plan-Executor (`executePlan`) im Hintergrund.
 * Pro Step wird NUR `engine.chat()` aufgerufen (reine Text-Completion,
 * kein Code-Execute, kein File-Write). Antwortet sofort mit HTTP 202.
 *
 * Vorlage: app/api/workstreams/[id]/spawn/route.ts (Background-Run-Pattern).
 *
 * Auth: Cookie-Session reicht (default API-Auth via middleware).
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { getWorkstream } from '@/lib/workstreams/service';
import { executePlan } from '@/lib/workstreams/plan-executor';
import { currentUserIdResolved } from '@/lib/security/subject-server';
import { canEditWorkspaceContent, getEffectiveWorkspaceRole } from '@/lib/security/permissions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  planId: z.string().min(1),
  // coordKey ist optional — wir leiten ihn aus workspaceId+workstreamId ab,
  // wenn der Caller ihn nicht explizit mitschickt.
  coordKey: z.string().min(1).optional(),
});

interface Ctx {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  const { id } = await ctx.params;

  // Ownership-Check (Critic-M3-Fix, 2026-05-23): nur eingeloggte Workspace-
  // Editors dürfen einen Plan-Run starten. Ohne das könnte jeder authentifizierte
  // Caller per fremder workstreamId einen Run auf einem fremden Workstream
  // auslösen. Pattern analog app/api/rag/index/route.ts (401 → 404 → 403).
  const userId = currentUserIdResolved(req);
  if (!userId) {
    return NextResponse.json({ error: 'auth-required' }, { status: 401 });
  }

  // Workstream validieren (404 wenn unbekannt).
  const ws = await getWorkstream(id);
  if (!ws) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  // Effektive Workspace-Rolle: Viewer/Guests/fremde User → 403.
  if (!canEditWorkspaceContent(getEffectiveWorkspaceRole(userId, ws.workspaceId))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  // Body parsen.
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    raw = {};
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'validation_error', issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const { planId } = parsed.data;
  // coordKey-Ableitung: wenn nicht mitgeschickt, nutzen wir den kanonischen
  // ManifestCoord-Key-Format (N9): "<workspaceId>/<workstreamId>".
  const coordKey = parsed.data.coordKey ?? `${ws.workspaceId}/${ws.id}`;

  // Hintergrund-Spawn (kein await, sofort 202 zurück).
  // executePlan ist best-effort/non-fatal pro Step — Fehler landen im console.error.
  void executePlan({
    workstreamId: ws.id,
    workspaceId: ws.workspaceId,
    planId,
    coordKey,
  }).catch((err: unknown) => {
    console.error(
      '[execute-plan] executePlan background error:',
      err instanceof Error ? err.message : String(err),
    );
  });

  return NextResponse.json(
    { ok: true, planId, workstreamId: id },
    { status: 202 },
  );
}
