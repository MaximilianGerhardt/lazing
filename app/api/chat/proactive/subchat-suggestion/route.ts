/**
 * POST /api/chat/proactive/subchat-suggestion — a proactive, operator-facing
 * suggestion for the MAIN chat, fed from sub-chat intelligence
 * (proactivity goal, 2026-06-02).
 *
 * When something new arrives from outside in the customer sub-chat, this route
 * suggests ONE concrete next step to the operator (one-person agency) —
 * enriched with workspace-isolated RAG knowledge (N2). The suggestion lands
 * in the composer (SUGGEST + 1-TAP-CONFIRM); NEVER auto-send, NEVER a
 * message to the customer. The main chat stays operator↔OS.
 *
 * Best-effort: engine/parse/runtime errors → `{ suggestion: '' }` with HTTP 200
 * (the UI then renders nothing). Only auth boundaries (401/403) are explicit — those
 * are not engine errors. The claude CLI may not be available locally →
 * `orchestrate({ mode: 'claude-cli' })` throws „engine not available" → caught
 * → empty suggestion.
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

  // N2: the workspaceId scope is required — never global. Best-effort empty (200),
  // instead of flooding the UI with 400 noise.
  if (!/^SC-[A-Za-z0-9]{1,40}$/.test(subchatId) || workspaceId.length === 0) {
    return NextResponse.json({ suggestion: '' }, { status: 200, headers: NO_STORE });
  }

  const sc = getSubchat(subchatId);
  if (!sc) return NextResponse.json({ suggestion: '' }, { status: 200, headers: NO_STORE });

  // Defense-in-depth: the sub-chat MUST belong to the claimed workspace
  // (no cross-scope, N2).
  if (sc.workspaceId !== workspaceId) {
    return NextResponse.json({ suggestion: '' }, { status: 200, headers: NO_STORE });
  }

  // Auth boundaries stay explicit (mirrors suggest/route.ts) — those are
  // permission boundaries, not engine errors.
  const userId = currentUserIdResolved(req);
  if (!userId) return NextResponse.json({ error: 'auth-required' }, { status: 401 });

  const role = getEffectiveWorkspaceRole(userId, sc.workspaceId);
  if (!canEditWorkspaceContent(role) || !hasRealWorkspaceMembership(userId, sc.workspaceId)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  // Load the last ~15 messages. Empty ⇒ nothing to suggest.
  const msgs = listMessages(subchatId, 15);
  if (msgs.length === 0) {
    return NextResponse.json({ suggestion: '' }, { status: 200, headers: NO_STORE });
  }

  // Query anchor: the last EXTERNAL message (the new thing from the customer);
  // otherwise the last message in the history.
  const lastCustomerMessage =
    [...msgs].reverse().find((m) => m.authorKind === 'external')?.content?.trim() ||
    msgs[msgs.length - 1].content.trim();

  const transcript = msgs
    .map((m) => `${m.authorKind === 'external' ? (m.authorName || 'Kunde') : 'Team'}: ${m.content}`)
    .join('\n')
    .slice(-4000);

  // N2: retrieve() asserts workspaceId (RagWorkspaceRequiredError if empty) and
  // reads the workspace-isolated view. This customer scope is what makes the
  // suggestion smart. RAG errors must NEVER block the suggestion.
  let ragBlock = '';
  let ragSources: Array<{ ref: string; sim: number }> = [];
  try {
    const rag = await retrieve({ workspaceId, query: lastCustomerMessage, topK: 6 });
    ragBlock = formatForPrompt(rag); // '' on 0 hits
    ragSources = rag.hits.map((h) => ({
      ref: `${h.sourceType}:${h.sourceId}`,
      sim: Number(h.similarity.toFixed(2)),
    }));
  } catch {
    ragBlock = ''; // RAG outage ⇒ produce the suggestion anyway.
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
      mode: 'claude-cli', // Opus tier for plan/decision (model tiering); NEVER fast mode.
      messages: [{ role: 'user', content: prompt }],
      parallelTimeoutMs: 30_000,
      // PII vault: the prompt embeds the verbatim customer transcript + RAG.
      workspaceId,
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
