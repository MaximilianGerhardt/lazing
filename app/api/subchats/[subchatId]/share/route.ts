/**
 * POST /api/subchats/[subchatId]/share   — externen Link verwalten (member-gated).
 *   { action: 'revoke' }                         → Link widerrufen
 *   { action: 'renew', hours?: number }          → Link erneuern (neuer Token + Ablauf)
 *   { action: 'regenerate' }                     → Token rotieren (Ablauf unverändert)
 *
 * Auth: Member des Workspace (gespiegelt aus messages/route.ts). Mutationen über
 * lib/subchats/service. Bei renew/regenerate wird die VOLLE öffentliche URL als
 * `externalUrl` einmalig zurückgegeben (publicBaseUrl, kein localhost).
 * Gathering-Intelligence-Goal P2 (2026-06-02).
 */

import { NextResponse, type NextRequest } from 'next/server';

import { canEditWorkspaceContent, getEffectiveWorkspaceRole } from '@/lib/security/permissions';
import { hasRealWorkspaceMembership } from '@/lib/security/membership';
import { currentUserIdResolved } from '@/lib/security/subject-server';
import { getSubchat, regenerateToken, renewShare, revokeShare } from '@/lib/subchats/service';
import { publicBaseUrlFrom } from '@/lib/hosting/public-base';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Ctx {
  params: Promise<{ subchatId: string }>;
}

/**
 * Öffentliche Base-URL für teilbare Kunden-Links. Reihenfolge: ENV → Laufzeit-
 * Datei `data/public-url` (vom Tunnel-Manager LIVE aktualisiert, kein Neustart
 * nötig) → Request-Origin. Zentral in lib/hosting/public-base.ts.
 */
function publicBaseUrl(req: NextRequest): string {
  return publicBaseUrlFrom(req.nextUrl.origin);
}

async function resolveAndGate(
  req: NextRequest,
  subchatId: string,
): Promise<{ ok: true; userId: string; workspaceId: string } | { ok: false; res: Response }> {
  if (!/^SC-[A-Za-z0-9]{1,40}$/.test(subchatId)) {
    return { ok: false, res: NextResponse.json({ error: 'invalid_subchat_id' }, { status: 400 }) };
  }
  const sc = getSubchat(subchatId);
  if (!sc) return { ok: false, res: NextResponse.json({ error: 'subchat_not_found' }, { status: 404 }) };
  const userId = currentUserIdResolved(req);
  if (!userId) return { ok: false, res: NextResponse.json({ error: 'auth-required' }, { status: 401 }) };
  const role = getEffectiveWorkspaceRole(userId, sc.workspaceId);
  if (!canEditWorkspaceContent(role) || !hasRealWorkspaceMembership(userId, sc.workspaceId)) {
    return { ok: false, res: NextResponse.json({ error: 'forbidden' }, { status: 403 }) };
  }
  return { ok: true, userId, workspaceId: sc.workspaceId };
}

export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  const { subchatId } = await ctx.params;
  const g = await resolveAndGate(req, subchatId);
  if (!g.ok) return g.res;
  let body: { action?: string; hours?: number };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'invalid-json' }, { status: 400 });
  }
  const action = body.action;

  if (action === 'revoke') {
    const sc = revokeShare(subchatId);
    if (!sc) return NextResponse.json({ error: 'subchat_not_found' }, { status: 404 });
    return NextResponse.json(
      { ok: true, hasExternalAccess: false, externalUrl: null },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }

  if (action === 'renew') {
    const hours = typeof body.hours === 'number' && body.hours > 0 ? body.hours : 720;
    const res = renewShare(subchatId, hours);
    if (!res) return NextResponse.json({ error: 'subchat_not_found' }, { status: 404 });
    const externalUrl = `${publicBaseUrl(req)}/c/${res.rawToken}`;
    return NextResponse.json(
      { ok: true, hasExternalAccess: true, rawToken: res.rawToken, externalUrl },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }

  if (action === 'regenerate') {
    const res = regenerateToken(subchatId);
    if (!res) return NextResponse.json({ error: 'subchat_not_found' }, { status: 404 });
    const externalUrl = `${publicBaseUrl(req)}/c/${res.rawToken}`;
    return NextResponse.json(
      { ok: true, hasExternalAccess: true, rawToken: res.rawToken, externalUrl },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }

  return NextResponse.json({ error: 'invalid-action', hint: 'revoke | renew | regenerate' }, { status: 400 });
}
