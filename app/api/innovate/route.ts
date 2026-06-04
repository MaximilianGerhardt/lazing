/**
 * POST /api/innovate — Innovation-mode engine made reachable
 * (Lane-D · 2026-05-30 · Opus 4.8).
 *
 * ── WHAT CHANGED ──────────────────────────────────────────────────────────
 * Until 2026-05-29, POST was a 501 marketing stub (contract in
 * `lib/innovate/contract.ts`). The REAL engine — `runInnovate` — was built,
 * tested and deployed, but NOT reachable via live chat. This route
 * now wires it up OWNER-TRIGGERED (no auto-run, §7.2): every POST is
 * an explicit call.
 *
 * The GET handler + the marketing mockup page (`app/innovate/[scope]/page.tsx`)
 * stay functional: page.tsx imports only `PERSONA_DESCRIPTIONS`,
 * `SCOPE_LABELS`, `InnovatePersona`, `InnovateScope` from the CONTRACT (not from
 * this route) and does NOT call the route — so the new POST contract does not
 * break it. The old types `InnovateRequest`/`InnovatePending` stay exported in
 * the contract (no import is removed).
 *
 * ── CONTRACT (new) ────────────────────────────────────────────────────────
 *   POST { workspaceId: string, rawText: string }
 *   → member auth (401 → 403 like compose-and-run)
 *   → engine adapter from detectEngines()/pickEngine() (codex EXCLUDED
 *     like plan-dispatch.ts — pure LLM text JSON, no code mode)
 *   → runInnovate(db.$raw, { workspaceId, rawText, callEngine })
 *   → 200 { assumptions, reframes, roasts, counterEvidenceSurfaces, counts }
 *
 * N1: rawText is passed VERBATIM (no slice) to runInnovate.
 * Fail-soft: engine error → clear 5xx with reqId; runInnovate itself is
 * fail-soft per stage (a malformed LLM response does not tip the run).
 *
 * Which chat/client gesture calls this later (NOT in this scope): the
 * „Innovation" button on a current-state/plan (§10.2) or a chat card
 * that sends the current plan text as rawText and renders the counter-evidence
 * surfaces (R5: visually separated, NO forced answer).
 *
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
import { runInnovate } from '@/lib/innovate/contract';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Small request correlation ID (style compose-and-run, without an extra import).
 * EVERY response — including 401/403/400 — carries it, so owner logs stay
 * correlatable.
 */
function makeReqId(): string {
  return `inv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function isValidWorkspaceId(id: string): boolean {
  return /^[a-z0-9_(][a-z0-9_()-]{0,63}$/i.test(id);
}

interface PostBody {
  workspaceId?: unknown;
  rawText?: unknown;
}

/**
 * GET stays the documenting preview response. No longer 501 — POST is
 * now live — but still auth-gated + informative.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const userId = currentUserIdResolved(req);
  if (!userId) {
    return NextResponse.json({ error: 'auth-required' }, { status: 401 });
  }
  return NextResponse.json({
    method: 'GET',
    info: 'POST { workspaceId, rawText } → Innovation-Mode (Annahmen offenlegen → umkehren → roasten). Vertrag: lib/innovate/contract.ts::runInnovate.',
    status: 'live',
  });
}

export async function POST(req: NextRequest): Promise<Response> {
  const reqId = makeReqId();

  // 1. Auth gate (member-or-higher) — template compose-and-run.
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
  // N1: take rawText VERBATIM — no trim/slice. Only the
  // empty/type validation uses a trimmed view.
  const rawText = typeof body.rawText === 'string' ? body.rawText : '';

  if (!isValidWorkspaceId(workspaceId)) {
    return NextResponse.json(
      { error: 'invalid_workspace_id', reqId },
      { status: 400 },
    );
  }
  if (rawText.trim().length === 0) {
    return NextResponse.json(
      { error: 'invalid_raw_text', hint: 'rawText Pflicht', reqId },
      { status: 400 },
    );
  }

  // 3. Workspace permission (member-or-higher; viewer/foreign user → 403).
  if (!canEditWorkspaceContent(getEffectiveWorkspaceRole(userId, workspaceId))) {
    return NextResponse.json({ error: 'forbidden', reqId }, { status: 403 });
  }

  // 4. Pick engine — codex excluded (like plan-dispatch.ts). Without an
  //    engine → 503 (the innovation pipeline needs an LLM).
  const selection = await detectEngines();
  // PII vault: wrap at the engine boundary — pickEngine(…,['codex-cli']) resolves
  // to claude-cli (cloud), and runInnovate embeds the user's rawText verbatim.
  const engine = protectEngine(workspaceId, pickEngine(selection, ['codex-cli']));
  if (!engine) {
    return NextResponse.json(
      { error: 'no_engine_available', reqId },
      { status: 503 },
    );
  }
  // runInnovate expects callEngine: (prompt: string) => Promise<string>.
  const callEngine = async (prompt: string): Promise<string> => {
    const r = await engine.chat({
      messages: [{ role: 'user', content: prompt }],
    });
    return r.text;
  };

  // 5. Run the engine. runInnovate is fail-soft per stage; a hard
  //    error (DB/engine adapter) → 500 with reqId.
  try {
    const result = await runInnovate(getDb().$raw, {
      workspaceId,
      rawText, // N1: verbatim
      callEngine,
    });
    return NextResponse.json(
      {
        reqId,
        assumptions: result.assumptions,
        reframes: result.reframes,
        roasts: result.roasts,
        counterEvidenceSurfaces: result.counterEvidenceSurfaces,
        counts: {
          assumptions: result.assumptions.length,
          reframes: result.reframes.length,
          roasts: result.roasts.length,
        },
      },
      { status: 200 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: 'innovate_failed', message, reqId },
      { status: 500 },
    );
  }
}
