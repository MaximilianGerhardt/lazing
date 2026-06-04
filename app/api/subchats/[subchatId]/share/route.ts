/**
 * POST /api/subchats/[subchatId]/share   — manage external link (member-gated).
 *   { action: 'revoke' }                         → revoke link
 *   { action: 'renew', hours?: number }          → renew link (new token + expiry)
 *   { action: 'regenerate' }                     → rotate token (expiry unchanged)
 *
 * Auth: member of the workspace (mirrored from messages/route.ts). Mutations via
 * lib/subchats/service. On renew/regenerate the FULL public URL is returned once
 * as `externalUrl` (publicBaseUrl, not localhost).
 * Gathering-Intelligence goal P2 (2026-06-02).
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
 * Public base URL for shareable customer links. Order: ENV → runtime
 * file `data/public-url` (updated LIVE by the tunnel manager, no restart
 * needed) → request origin. Centralized in lib/hosting/public-base.ts.
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
