/**
 * POST /api/subchats/[subchatId]/suggest — AI answer suggestions for the
 * internal team (Gathering-Intelligence goal, 2026-06-02).
 *
 * From the existing sub-chat history the engine generates 2-3 short, sendable
 * answer options (Claude-Code-app style) that account for technical
 * aspects/complications — as a safety net for the user. EXTERNAL parties NEVER
 * see this (this route is member-gated). Best-effort: engine error → empty list.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { canEditWorkspaceContent, getEffectiveWorkspaceRole } from '@/lib/security/permissions';
import { hasRealWorkspaceMembership } from '@/lib/security/membership';
import { currentUserIdResolved } from '@/lib/security/subject-server';
import { getSubchat, listMessages } from '@/lib/subchats/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Ctx {
  params: Promise<{ subchatId: string }>;
}

export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  const { subchatId } = await ctx.params;
  if (!/^SC-[A-Za-z0-9]{1,40}$/.test(subchatId)) {
    return NextResponse.json({ error: 'invalid_subchat_id' }, { status: 400 });
  }
  const sc = getSubchat(subchatId);
  if (!sc) return NextResponse.json({ error: 'subchat_not_found' }, { status: 404 });
  const userId = currentUserIdResolved(req);
  if (!userId) return NextResponse.json({ error: 'auth-required' }, { status: 401 });
  const role = getEffectiveWorkspaceRole(userId, sc.workspaceId);
  if (!canEditWorkspaceContent(role) || !hasRealWorkspaceMembership(userId, sc.workspaceId)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const msgs = listMessages(subchatId, 20);
  if (msgs.length === 0) {
    return NextResponse.json({ suggestions: [] }, { headers: { 'Cache-Control': 'no-store' } });
  }
  const transcript = msgs
    .map((m) => `${m.authorKind === 'external' ? (m.authorName || 'Kunde') : 'Team'}: ${m.content}`)
    .join('\n')
    .slice(-4000);

  const prompt = [
    'Du hilfst dem internen Team, einem Kunden in einem Projekt-Gruppenchat zu antworten.',
    'Hier der bisherige Verlauf:',
    '---',
    transcript,
    '---',
    'Schlage 2-3 kurze, direkt sendbare Antwort-Optionen (je 1-2 Sätze, Deutsch, Du-Form, freundlich-professionell) auf die letzte Kundennachricht vor.',
    'Berücksichtige mögliche technische Aspekte/Komplikationen, die der Team-User vielleicht nicht im Blick hat.',
    'Antworte AUSSCHLIESSLICH als JSON-Array von Strings, nichts sonst. Beispiel: ["…","…"].',
  ].join('\n');

  try {
    const { orchestrate } = await import('@/lib/llm/orchestrator');
    const result = await orchestrate({
      mode: 'claude-cli',
      messages: [{ role: 'user', content: prompt }],
      parallelTimeoutMs: 30_000,
      // PII vault: the prompt embeds the verbatim customer transcript.
      workspaceId: sc.workspaceId,
    });
    const suggestions = parseSuggestions(result.text);
    return NextResponse.json({ suggestions, engine: result.engine }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    console.warn('[subchats/suggest] engine failed (non-fatal):', err instanceof Error ? err.message : String(err));
    return NextResponse.json({ suggestions: [] }, { headers: { 'Cache-Control': 'no-store' } });
  }
}

/** Robust: extract a JSON array; otherwise fall back to lines/list items. */
function parseSuggestions(text: string): string[] {
  const t = (text ?? '').trim();
  // 1. JSON array anywhere in the text.
  const m = t.match(/\[[\s\S]*\]/);
  if (m) {
    try {
      const arr = JSON.parse(m[0]) as unknown;
      if (Array.isArray(arr)) {
        return arr
          .filter((x): x is string => typeof x === 'string')
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
          .slice(0, 3);
      }
    } catch {
      /* fallthrough */
    }
  }
  // 2. Fallback: numbered/bulleted lines.
  return t
    .split('\n')
    .map((l) => l.replace(/^\s*(?:[-*]|\d+[.)])\s*/, '').replace(/^["']|["']$/g, '').trim())
    .filter((l) => l.length > 3 && l.length < 400)
    .slice(0, 3);
}
