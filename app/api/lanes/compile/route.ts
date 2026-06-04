/**
 * POST /api/lanes/compile — expertise compiler made reachable
 * (Lane-D · 2026-05-30 · Opus 4.8).
 *
 * The explicit, OWNER-TRIGGERED „Als Wissen speichern" endpoint (§7.2 no
 * auto-run): takes an owner/expert input (directly as rawText OR as a
 * reference to a Lane-A `intakeEventId`) and extracts via
 * `compileKnowledgeForms` typed knowledge_forms rows — ALL with
 * review_state='pending-review' (§8.3 gate; nothing becomes a belief without
 * human review).
 *
 * ── CONTRACT ──────────────────────────────────────────────────────────────
 *   POST { workspaceId: string, intakeEventId?: string, rawText?: string }
 *         — exactly ONE of intakeEventId | rawText.
 *   → member auth (401 → 403 like compose-and-run)
 *   → engine adapter from detectEngines()/pickEngine() (codex EXCLUDED)
 *   → compileKnowledgeForms({ db, workspaceId, intakeEventId|rawText, callEngine })
 *   → 200 { forms: [...], count, rejectedCount, intakeEventId }
 *
 * N1: rawText / the raw_content read from intakeEventId flow VERBATIM
 * (no slice) into the compiler; the compiler quotes the owner wording.
 * N6: malformed LLM output is fail-soft in the compiler (0 forms, no crash).
 *
 * Error mapping (fail-soft, clear 4xx/5xx with reqId):
 *   - operator error of the compiler (no/double source argument, intakeEvent
 *     not in the workspace) → the compiler throws an Error → we map to 400/404.
 *   - other hard error → 500.
 *
 * Which chat/client gesture calls this later (NOT in this scope): an
 * „Als Wissen speichern" card in chat (owner confirms an explained
 * fact), or a button next to a ready-for-compile intake_events row
 * (Lane-A → Lane-B handoff, human-triggered).
 *
 * Auth pattern + engine choice 1:1 like app/api/flow/compose-and-run/route.ts.
 * ADDITIVE: no core flow file touched, no next build/start.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { getDb } from '@/db/client';
import { currentUserIdResolved } from '@/lib/security/subject-server';
import {
  canEditWorkspaceContent,
  getEffectiveWorkspaceRole,
} from '@/lib/security/permissions';
import { detectEngines, pickEngine } from '@/lib/llm/engines/selector';
import { protectEngine } from '@/lib/privacy/protect';
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

  // 1. Auth gate (member-or-higher).
  const userId = currentUserIdResolved(req);
  if (!userId) {
    return NextResponse.json({ error: 'auth-required', reqId }, { status: 401 });
  }

  // 2. Parse body.
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
  // N1: rawText VERBATIM (no slice). Only empty/type validation is trimmed.
  const rawText = typeof body.rawText === 'string' ? body.rawText : '';
  const hasRaw = rawText.trim().length > 0;

  if (!isValidWorkspaceId(workspaceId)) {
    return NextResponse.json(
      { error: 'invalid_workspace_id', reqId },
      { status: 400 },
    );
  }
  // Exactly one of the two (XOR) — mirrors the compiler contract, but as a
  // clear 400 instead of a thrown Error.
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

  // 3. Workspace permission (member-or-higher; viewer/foreign user → 403).
  if (!canEditWorkspaceContent(getEffectiveWorkspaceRole(userId, workspaceId))) {
    return NextResponse.json({ error: 'forbidden', reqId }, { status: 403 });
  }

  // 4. Pick engine — codex excluded (like plan-dispatch.ts).
  const selection = await detectEngines();
  // PII vault: wrap at the engine boundary — claude-cli (cloud) is the resolved
  // pick, and the compiler quotes the owner wording verbatim (N1) into the prompt.
  const engine = protectEngine(workspaceId, pickEngine(selection, ['codex-cli']));
  if (!engine) {
    return NextResponse.json(
      { error: 'no_engine_available', reqId },
      { status: 503 },
    );
  }
  // compileKnowledgeForms expects callEngine: ({system,user}) => Promise<string>.
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

  // 5. Compile. The compiler throws ONLY on operator error (source XOR,
  //    missing workspace, intakeEvent not found); LLM/parse are
  //    fail-soft (0 forms).
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
    // intakeEvent-not-found → 404; other operator errors → 400.
    const status = /not found/i.test(message) ? 404 : 400;
    return NextResponse.json(
      { error: 'compile_failed', message, reqId },
      { status },
    );
  }
}
