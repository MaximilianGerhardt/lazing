/**
 * POST /api/proactive/decision — N8 decision audit (proactivity goal, 2026-06-02).
 *
 * When the operator in the main chat "picks up" a pre-generated proactive
 * suggestion, we write an APPEND-ONLY 'decision' entity into the event log
 * (entityType 'decision', eventType 'created') — exactly the form that
 * projectDecisions/foldDecision reads, so it appears in /decisions. We also
 * mark the stored suggestion as dismissed (dedupe).
 *
 * NEVER auto-send: this route only persists a decision; it sends
 * NO message to the customer. The actual seeding of the composer is done by the
 * client (onPickUp). Member-gated (N2/N9).
 */

import { NextResponse, type NextRequest } from 'next/server';

import { canEditWorkspaceContent, getEffectiveWorkspaceRole } from '@/lib/security/permissions';
import { hasRealWorkspaceMembership } from '@/lib/security/membership';
import { currentUserIdResolved } from '@/lib/security/subject-server';
import { currentActor } from '@/lib/security/subject';
import { getSubchat, dismissProactiveSuggestion } from '@/lib/subchats/service';
import { emitEvent } from '@/lib/events/emit';
import { ulid } from '@/lib/ulid';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest): Promise<Response> {
  let body: { subchatId?: string; suggestionId?: string; suggestion?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'bad-request' }, { status: 400 });
  }

  const subchatId = typeof body.subchatId === 'string' ? body.subchatId : '';
  const suggestionId = typeof body.suggestionId === 'string' ? body.suggestionId : '';
  const suggestion = typeof body.suggestion === 'string' ? body.suggestion.trim() : '';
  if (!/^SC-[A-Za-z0-9]{1,40}$/.test(subchatId) || suggestion.length === 0) {
    return NextResponse.json({ error: 'bad-request' }, { status: 400 });
  }

  const sc = getSubchat(subchatId);
  if (!sc) return NextResponse.json({ error: 'not-found' }, { status: 404 });

  const userId = currentUserIdResolved(req);
  if (!userId) return NextResponse.json({ error: 'auth-required' }, { status: 401 });

  const role = getEffectiveWorkspaceRole(userId, sc.workspaceId);
  if (!canEditWorkspaceContent(role) || !hasRealWorkspaceMembership(userId, sc.workspaceId)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  // N8 append-only: decision entity, scoped to the CUSTOMER workspace. Form EXACTLY
  // as foldDecision reads it (headline/sub/options on eventType 'created').
  const headline = suggestion.split('\n')[0].slice(0, 200) || 'Proaktiver Vorschlag übernommen';
  const sub = `Kundenchat „${sc.title}" — Vorschlag vom OS-Assistenten übernommen`;
  try {
    await emitEvent({
      segmentId: sc.workspaceId,
      entityType: 'decision',
      entityId: `DEC-${ulid()}`,
      eventType: 'created',
      actor: currentActor(req) as `user:${string}`,
      payload: {
        headline,
        sub,
        options: [],
        source: 'proactive-subchat-suggestion',
        subchatId,
        suggestion, // N1 verbatim
      },
      sensitivity: 'low',
    });
  } catch (err) {
    console.error('[proactive/decision] emit failed', err);
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }

  // Dedupe: dismiss the stored suggestion (idempotent; best-effort).
  if (suggestionId) {
    try {
      dismissProactiveSuggestion(suggestionId);
    } catch {
      /* non-fatal — decision is already persisted */
    }
  }

  return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
}
