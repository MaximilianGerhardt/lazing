/**
 * POST /api/innovate — Innovation-Mode-Engine erreichbar gemacht
 * (Lane-D · 2026-05-30 · Opus 4.8).
 *
 * ── WAS SICH GEÄNDERT HAT ─────────────────────────────────────────────────
 * Bis 2026-05-29 war POST ein 501-Marketing-Stub (Vertrag in
 * `lib/innovate/contract.ts`). Die ECHTE Engine — `runInnovate` — war gebaut,
 * getestet und deployed, aber per Live-Chat NICHT erreichbar. Diese Route
 * verdrahtet sie jetzt OWNER-GETRIGGERT (kein auto-run, §7.2): jeder POST ist
 * ein expliziter Aufruf.
 *
 * Der GET-Handler + die Marketing-Mockup-Page (`app/innovate/[scope]/page.tsx`)
 * bleiben funktional: page.tsx importiert nur `PERSONA_DESCRIPTIONS`,
 * `SCOPE_LABELS`, `InnovatePersona`, `InnovateScope` aus dem CONTRACT (nicht aus
 * dieser Route) und ruft die Route NICHT auf — der neue POST-Vertrag bricht sie
 * also nicht. Die alten Typen `InnovateRequest`/`InnovatePending` bleiben im
 * Contract exportiert (kein Import wird entfernt).
 *
 * ── VERTRAG (neu) ─────────────────────────────────────────────────────────
 *   POST { workspaceId: string, rawText: string }
 *   → member-auth (401 → 403 wie compose-and-run)
 *   → Engine-Adapter aus detectEngines()/pickEngine() (codex AUSGESCHLOSSEN
 *     wie plan-dispatch.ts — reines LLM-Text-JSON, kein Code-Mode)
 *   → runInnovate(db.$raw, { workspaceId, rawText, callEngine })
 *   → 200 { assumptions, reframes, roasts, counterEvidenceSurfaces, counts }
 *
 * N1: rawText wird VERBATIM (kein slice) an runInnovate gereicht.
 * Fail-soft: Engine-Fehler → klare 5xx mit reqId; runInnovate selbst ist je
 * Stufe fail-soft (eine malformte LLM-Antwort kippt den Run nicht).
 *
 * Welche Chat-/Client-Geste das später aufruft (NICHT in diesem Scope): der
 * „Innovation"-Button auf einem Ist-Zustand/Plan (§10.2) bzw. eine Chat-Card,
 * die den aktuellen Plan-Text als rawText schickt und die counter-evidence-
 * Surfaces (R5: visuell getrennt, KEIN Antwort-Zwang) rendert.
 *
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
import { runInnovate } from '@/lib/innovate/contract';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Kleine Request-Korrelations-ID (Stil compose-and-run, ohne Extra-Import).
 * JEDER Response — auch 401/403/400 — trägt sie, damit Owner-Logs korrelierbar
 * bleiben.
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
 * GET bleibt die dokumentierende Preview-Antwort. Nicht mehr 501 — POST ist
 * jetzt live — aber weiterhin auth-gated + informativ.
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

  // 1. Auth-Gate (member-or-higher) — Vorlage compose-and-run.
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
  // N1: rawText VERBATIM übernehmen — kein trim/slice. Nur die
  // Leer-/Typ-Validierung nutzt einen getrimmten Blick.
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

  // 3. Workspace-Permission (member-or-higher; Viewer/fremde User → 403).
  if (!canEditWorkspaceContent(getEffectiveWorkspaceRole(userId, workspaceId))) {
    return NextResponse.json({ error: 'forbidden', reqId }, { status: 403 });
  }

  // 4. Engine wählen — codex ausgeschlossen (wie plan-dispatch.ts). Ohne
  //    Engine → 503 (Innovation-Pipeline braucht ein LLM).
  const selection = await detectEngines();
  const engine = pickEngine(selection, ['codex-cli']);
  if (!engine) {
    return NextResponse.json(
      { error: 'no_engine_available', reqId },
      { status: 503 },
    );
  }
  // runInnovate erwartet callEngine: (prompt: string) => Promise<string>.
  const callEngine = async (prompt: string): Promise<string> => {
    const r = await engine.chat({
      messages: [{ role: 'user', content: prompt }],
    });
    return r.text;
  };

  // 5. Engine ausführen. runInnovate ist je Stufe fail-soft; ein harter
  //    Fehler (DB/Engine-Adapter) → 500 mit reqId.
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
