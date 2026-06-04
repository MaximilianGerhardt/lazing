/**
 * POST /api/chat/proactive/subchat-suggestion — proaktiver, operator-facing
 * Vorschlag für den HAUPT-Chat, gespeist aus Sub-Chat-Intelligenz
 * (Proactivity-Goal, 2026-06-02).
 *
 * Wenn im Kunden-Sub-Chat etwas Neues von extern ankommt, schlägt diese Route
 * dem Operator (Ein-Mann-Agentur) EINEN konkreten nächsten Schritt vor —
 * angereichert mit workspace-isoliertem RAG-Wissen (N2). Der Vorschlag landet
 * im Composer (SUGGEST + 1-TAP-CONFIRM); NIEMALS Auto-Send, NIEMALS eine
 * Nachricht an den Kunden. Der Hauptchat bleibt Operator↔OS.
 *
 * Best-effort: Engine-/Parse-/Runtime-Fehler → `{ suggestion: '' }` mit HTTP 200
 * (die UI rendert dann nichts). Nur Auth-Grenzen (401/403) sind explizit — das
 * sind keine Engine-Fehler. Die claude-CLI ist lokal evtl. nicht verfügbar →
 * `orchestrate({ mode: 'claude-cli' })` wirft „engine not available" → gefangen
 * → leerer Vorschlag.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { canEditWorkspaceContent, getEffectiveWorkspaceRole } from '@/lib/security/permissions';
import { hasRealWorkspaceMembership } from '@/lib/security/membership';
import { currentUserIdResolved } from '@/lib/security/subject-server';
import { getSubchat, listMessages } from '@/lib/subchats/service';
import { retrieve, formatForPrompt } from '@/lib/rag/retriever';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export async function POST(req: NextRequest): Promise<Response> {
  let body: { subchatId?: string; workspaceId?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ suggestion: '' }, { status: 200, headers: NO_STORE });
  }

  const subchatId = typeof body.subchatId === 'string' ? body.subchatId : '';
  const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId.trim() : '';

  // N2: workspaceId-Scope ist Pflicht — niemals global. Best-effort leer (200),
  // statt die UI mit 400-Noise zu fluten.
  if (!/^SC-[A-Za-z0-9]{1,40}$/.test(subchatId) || workspaceId.length === 0) {
    return NextResponse.json({ suggestion: '' }, { status: 200, headers: NO_STORE });
  }

  const sc = getSubchat(subchatId);
  if (!sc) return NextResponse.json({ suggestion: '' }, { status: 200, headers: NO_STORE });

  // Defense-in-Depth: der Sub-Chat MUSS zum behaupteten Workspace gehören
  // (kein Cross-Scope, N2).
  if (sc.workspaceId !== workspaceId) {
    return NextResponse.json({ suggestion: '' }, { status: 200, headers: NO_STORE });
  }

  // Auth-Grenzen bleiben explizit (spiegelt suggest/route.ts) — das sind
  // Berechtigungs-Grenzen, keine Engine-Fehler.
  const userId = currentUserIdResolved(req);
  if (!userId) return NextResponse.json({ error: 'auth-required' }, { status: 401 });

  const role = getEffectiveWorkspaceRole(userId, sc.workspaceId);
  if (!canEditWorkspaceContent(role) || !hasRealWorkspaceMembership(userId, sc.workspaceId)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  // Letzte ~15 Nachrichten laden. Leer ⇒ nichts vorzuschlagen.
  const msgs = listMessages(subchatId, 15);
  if (msgs.length === 0) {
    return NextResponse.json({ suggestion: '' }, { status: 200, headers: NO_STORE });
  }

  // Query-Anker: letzte EXTERNE Nachricht (das Neue vom Kunden); sonst letzte
  // Nachricht im Verlauf.
  const lastCustomerMessage =
    [...msgs].reverse().find((m) => m.authorKind === 'external')?.content?.trim() ||
    msgs[msgs.length - 1].content.trim();

  const transcript = msgs
    .map((m) => `${m.authorKind === 'external' ? (m.authorName || 'Kunde') : 'Team'}: ${m.content}`)
    .join('\n')
    .slice(-4000);

  // N2: retrieve() asserted workspaceId (RagWorkspaceRequiredError bei leer) und
  // liest die workspace-isolierte View. Dieser Kunden-Scope ist es, der den
  // Vorschlag schlau macht. RAG-Fehler dürfen den Vorschlag NIE blockieren.
  let ragBlock = '';
  let ragSources: Array<{ ref: string; sim: number }> = [];
  try {
    const rag = await retrieve({ workspaceId, query: lastCustomerMessage, topK: 6 });
    ragBlock = formatForPrompt(rag); // '' bei 0 Treffern
    ragSources = rag.hits.map((h) => ({
      ref: `${h.sourceType}:${h.sourceId}`,
      sim: Number(h.similarity.toFixed(2)),
    }));
  } catch {
    ragBlock = ''; // RAG-Ausfall ⇒ Vorschlag trotzdem produzieren.
    ragSources = [];
  }

  const prompt = [
    'Du bist der OS-Assistent des Operators (Ein-Mann-Agentur). Der Operator betreut',
    `den Kunden-Workspace "${sc.title}". Im Kundenchat ist gerade Neues von extern angekommen.`,
    '',
    'Bisheriger Kundenchat-Verlauf:',
    '---',
    transcript,
    '---',
    ragBlock ? `Relevantes Workspace-Wissen (RAG, workspace-isoliert):\n${ragBlock}\n` : '',
    'Aufgabe: Schlage dem Operator EINEN konkreten nächsten Schritt / eine Fortsetzung /',
    'einen kurzen Plan-Vorschlag vor, wie er auf die letzte Kundennachricht reagieren bzw.',
    'die Arbeit am Workspace voranbringen sollte. Berücksichtige technische Komplikationen,',
    'die der Operator möglicherweise NICHT auf dem Schirm hat. Schreibe Deutsch, Du-Form,',
    'direkt und umsetzbar (3-6 Sätze, kein Vorgeplänkel). Dies ist ein VORSCHLAG an den',
    'Operator — KEINE Nachricht an den Kunden. Antworte AUSSCHLIESSLICH mit dem Vorschlagstext.',
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const { orchestrate } = await import('@/lib/llm/orchestrator');
    const result = await orchestrate({
      mode: 'claude-cli', // Opus-tier für Plan/Decision (Model-Tiering); NIEMALS Fast-Mode.
      messages: [{ role: 'user', content: prompt }],
      parallelTimeoutMs: 30_000,
    });
    const suggestion = (result.text ?? '').trim();
    return NextResponse.json(
      suggestion ? { suggestion, sources: ragSources } : { suggestion: '' },
      { headers: NO_STORE },
    );
  } catch (err) {
    console.warn(
      '[chat/proactive/subchat-suggestion] engine failed (non-fatal):',
      err instanceof Error ? err.message : String(err),
    );
    return NextResponse.json({ suggestion: '' }, { headers: NO_STORE });
  }
}
