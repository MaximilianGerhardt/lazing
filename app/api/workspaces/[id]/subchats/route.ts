/**
 * GET  /api/workspaces/[id]/subchats   — list a workspace's sub-chats.
 * POST /api/workspaces/[id]/subchats   — create a sub-chat (returns rawToken once).
 *
 * Auth: workspace member (mirrored from /api/state/projection — currentUserId
 * + canEditWorkspaceContent + hasRealWorkspaceMembership). Sub-chats are
 * project-internal control, hence member-gated.
 *
 * Gathering-intelligence goal (2026-06-02).
 */

import { NextResponse, type NextRequest } from 'next/server';

import {
  canEditWorkspaceContent,
  getEffectiveWorkspaceRole,
} from '@/lib/security/permissions';
import { hasRealWorkspaceMembership } from '@/lib/security/membership';
import { currentUserIdResolved } from '@/lib/security/subject-server';
import { createSubchat, listSubchats } from '@/lib/subchats/service';
import { publicBaseUrlFrom } from '@/lib/hosting/public-base';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const WORKSPACE_ID_RE = /^(?:__org_root__:)?[a-zA-Z0-9_:()-]{1,128}$/;

/**
 * Public base URL for shareable customer links. A customer CANNOT access
 * localhost — so we prefer the configured public base and only then fall back
 * to the request origin. Order: ENV
 * (LAZYOS_PREVIEW_BASE_URL → PUBLIC_URL → BASE_URL) → runtime file
 * `data/public-url` (updated LIVE by the tunnel manager) → request origin.
 * Centralized in lib/hosting/public-base.ts.
 */
function publicBaseUrl(req: NextRequest): string {
  return publicBaseUrlFrom(req.nextUrl.origin);
}

interface Ctx {
  params: Promise<{ id: string }>;
}

function gate(req: NextRequest, workspaceId: string): { ok: true; userId: string } | { ok: false; res: Response } {
  if (!WORKSPACE_ID_RE.test(workspaceId)) {
    return { ok: false, res: NextResponse.json({ error: 'invalid_workspace_id' }, { status: 400 }) };
  }
  const userId = currentUserIdResolved(req);
  if (!userId) return { ok: false, res: NextResponse.json({ error: 'auth-required' }, { status: 401 }) };
  const role = getEffectiveWorkspaceRole(userId, workspaceId);
  if (!canEditWorkspaceContent(role) || !hasRealWorkspaceMembership(userId, workspaceId)) {
    return { ok: false, res: NextResponse.json({ error: 'forbidden' }, { status: 403 }) };
  }
  return { ok: true, userId };
}

export async function GET(req: NextRequest, ctx: Ctx): Promise<Response> {
  const { id } = await ctx.params;
  const g = gate(req, id);
  if (!g.ok) return g.res;
  try {
    const rows = listSubchats(id);
    // never serve shareTokenHash.
    const subchats = rows.map((r) => ({
      id: r.id,
      title: r.title,
      kind: r.kind,
      description: r.description,
      hasExternalAccess: Boolean(r.shareTokenHash) && !r.shareRevokedAt,
      status: r.status,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
    return NextResponse.json({ subchats }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    console.error('[subchats GET]', err);
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}

export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  const { id } = await ctx.params;
  const g = gate(req, id);
  if (!g.ok) return g.res;
  let body: { title?: string; kind?: string; description?: string; expiresInHours?: number };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'invalid-json' }, { status: 400 });
  }
  const title = (body.title ?? '').trim();
  if (title.length < 1) {
    return NextResponse.json({ error: 'invalid-title', hint: 'Titel benötigt' }, { status: 400 });
  }
  const kind = body.kind === 'internal' ? 'internal' : 'external';
  try {
    const { subchat, rawToken } = createSubchat({
      workspaceId: id,
      title,
      kind,
      description: typeof body.description === 'string' ? body.description : undefined,
      createdByUserId: g.userId,
      external: kind === 'external',
      expiresInHours: typeof body.expiresInHours === 'number' ? body.expiresInHours : 720,
    });
    // external link only for the owner, once — as a FULL public URL,
    // so that a customer can actually open it (not localhost).
    const externalUrl = rawToken ? `${publicBaseUrl(req)}/c/${rawToken}` : null;
    return NextResponse.json(
      {
        subchat: {
          id: subchat.id,
          title: subchat.title,
          kind: subchat.kind,
          description: subchat.description,
          status: subchat.status,
          createdAt: subchat.createdAt,
        },
        rawToken,
        externalUrl,
      },
      { status: 201, headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (err) {
    console.error('[subchats POST]', err);
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
