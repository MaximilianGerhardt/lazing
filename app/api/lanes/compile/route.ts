/**
 * POST /api/lanes/compile — Expertise-Compiler erreichbar gemacht
 * (Lane-D · 2026-05-30 · Opus 4.8).
 *
 * Der explizite, OWNER-GETRIGGERTE „Als Wissen speichern"-Endpoint (§7.2 kein
 * auto-run): nimmt einen Owner-/Experten-Input (direkt als rawText ODER als
 * Referenz auf einen Lane-A-`intakeEventId`) und extrahiert via
 * `compileKnowledgeForms` typisierte knowledge_forms-Rows — ALLE mit
 * review_state='pending-review' (§8.3 Gate; nichts wird ohne human-review zur
 * Belief).
 *
 * ── VERTRAG ───────────────────────────────────────────────────────────────
 *   POST { workspaceId: string, intakeEventId?: string, rawText?: string }
 *         — genau EINES von intakeEventId | rawText.
 *   → member-auth (401 → 403 wie compose-and-run)
 *   → Engine-Adapter aus detectEngines()/pickEngine() (codex AUSGESCHLOSSEN)
 *   → compileKnowledgeForms({ db, workspaceId, intakeEventId|rawText, callEngine })
 *   → 200 { forms: [...], count, rejectedCount, intakeEventId }
 *
 * N1: rawText / der aus intakeEventId gelesene raw_content fließen VERBATIM
 * (kein slice) in den Compiler; der Compiler zitiert den Owner-Wortlaut.
 * N6: malformter LLM-Output ist im Compiler fail-soft (0 Formen, kein Crash).
 *
 * Fehlerabbildung (fail-soft, klare 4xx/5xx mit reqId):
 *   - Bedienfehler des Compilers (kein/doppeltes Quellen-Argument, intakeEvent
 *     nicht im Workspace) → der Compiler wirft Error → wir mappen auf 400/404.
 *   - sonstiger harter Fehler → 500.
 *
 * Welche Chat-/Client-Geste das später aufruft (NICHT in diesem Scope): eine
 * „Als Wissen speichern"-Card im Chat (Owner bestätigt einen erklärten
 * Sachverhalt), bzw. ein Button neben einem ready-for-compile intake_events-Row
 * (Lane-A → Lane-B-Übergabe, human-getriggert).
 *
 * Auth-Muster + Engine-Wahl 1:1 wie app/api/flow/compose-and-run/route.ts.
 * ADDITIV: keine Kern-Flow-Datei berührt, kein next build/start.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { getDb } from '@/db/client';
import { currentUserIdResolved } from '@/lib/security/subject-server';
import {
  canEditWorkspaceContent,
  getEffectiveWorkspaceRole,
} from '@/lib/security/permissions';
import { detectEngines, pickEngine } from '@/lib/llm/engines/selector';
import { compileKnowledgeForms } from '@/lib/lanes/expertise-compiler/compile';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function makeReqId(): string {
  return `cmp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function isValidWorkspaceId(id: string): boolean {
  return /^[a-z0-9_(][a-z0-9_()-]{0,63}$/i.test(id);
}

interface PostBody {
  workspaceId?: unknown;
  intakeEventId?: unknown;
  rawText?: unknown;
}

export async function POST(req: NextRequest): Promise<Response> {
  const reqId = makeReqId();

  // 1. Auth-Gate (member-or-higher).
  const userId = currentUserIdResolved(req);
  if (!userId) {
    return NextResponse.json({ error: 'auth-required', reqId }, { status: 401 });
  }

  // 2. Body parsen.
  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: 'invalid_json', reqId }, { status: 400 });
  }

  const workspaceId =
    typeof body.workspaceId === 'string' ? body.workspaceId : '';
  const hasIntake =
    typeof body.intakeEventId === 'string' && body.intakeEventId.length > 0;
  // N1: rawText VERBATIM (kein slice). Nur Leer-/Typ-Validierung getrimmt.
  const rawText = typeof body.rawText === 'string' ? body.rawText : '';
  const hasRaw = rawText.trim().length > 0;

  if (!isValidWorkspaceId(workspaceId)) {
    return NextResponse.json(
      { error: 'invalid_workspace_id', reqId },
      { status: 400 },
    );
  }
  // Genau eines von beiden (XOR) — spiegelt den Compiler-Vertrag, aber als
  // klarer 400 statt als geworfener Error.
  if (hasIntake === hasRaw) {
    return NextResponse.json(
      {
        error: 'invalid_source',
        hint: 'genau EINES von intakeEventId | rawText angeben',
        reqId,
      },
      { status: 400 },
    );
  }

  // 3. Workspace-Permission (member-or-higher; Viewer/fremde User → 403).
  if (!canEditWorkspaceContent(getEffectiveWorkspaceRole(userId, workspaceId))) {
    return NextResponse.json({ error: 'forbidden', reqId }, { status: 403 });
  }

  // 4. Engine wählen — codex ausgeschlossen (wie plan-dispatch.ts).
  const selection = await detectEngines();
  const engine = pickEngine(selection, ['codex-cli']);
  if (!engine) {
    return NextResponse.json(
      { error: 'no_engine_available', reqId },
      { status: 503 },
    );
  }
  // compileKnowledgeForms erwartet callEngine: ({system,user}) => Promise<string>.
  const callEngine = async (args: {
    system: string;
    user: string;
  }): Promise<string> => {
    const r = await engine.chat({
      messages: [
        { role: 'system', content: args.system },
        { role: 'user', content: args.user },
      ],
    });
    return r.text;
  };

  // 5. Kompilieren. Der Compiler wirft NUR bei Bedienfehler (Quellen-XOR,
  //    fehlender Workspace, intakeEvent nicht gefunden); LLM/Parse sind
  //    fail-soft (0 Formen).
  try {
    const result = await compileKnowledgeForms({
      db: getDb().$raw,
      workspaceId,
      ...(hasIntake
        ? { intakeEventId: body.intakeEventId as string }
        : { rawText }), // N1: verbatim
      callEngine,
    });
    return NextResponse.json(
      {
        reqId,
        forms: result.forms,
        count: result.forms.length,
        rejectedCount: result.rejectedCount,
        intakeEventId: result.intakeEventId,
      },
      { status: 200 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // intakeEvent-not-found → 404; andere Bedienfehler → 400.
    const status = /not found/i.test(message) ? 404 : 400;
    return NextResponse.json(
      { error: 'compile_failed', message, reqId },
      { status },
    );
  }
}
