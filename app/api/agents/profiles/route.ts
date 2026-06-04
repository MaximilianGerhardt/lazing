/**
 * GET  /api/agents/profiles?workspaceId=...  — Mitarbeiter-Profile listen.
 * POST /api/agents/profiles                  — ein Profil anlegen.
 *
 * „Mitarbeiter"-Profile Slice 1 (2026-06-03). Auth: eingeloggt; bei Workspace-
 * Scope zusätzlich Membership (für POST).
 */

import { NextResponse, type NextRequest } from 'next/server';

import { canEditWorkspaceContent, getEffectiveWorkspaceRole } from '@/lib/security/permissions';
import { hasRealWorkspaceMembership } from '@/lib/security/membership';
import { currentUserIdResolved } from '@/lib/security/subject-server';
import {
  AgentProfileError,
  createAgentProfile,
  listAgentProfiles,
  type AgentProfile,
} from '@/lib/agents/profiles-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function serialize(p: AgentProfile) {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    role: p.role,
    skills: p.skills,
    mcpServers: p.mcpServers,
    sops: p.sops,
    apis: p.apis,
    workspaceId: p.workspaceId,
    createdAt: p.createdAt,
  };
}

export async function GET(req: NextRequest): Promise<Response> {
  const userId = currentUserIdResolved(req);
  if (!userId) return NextResponse.json({ error: 'auth-required' }, { status: 401 });
  const url = new URL(req.url);
  const workspaceId = url.searchParams.get('workspaceId');
  const profiles = listAgentProfiles({ workspaceId: workspaceId ?? null }).map(serialize);
  return NextResponse.json({ profiles }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(req: NextRequest): Promise<Response> {
  const userId = currentUserIdResolved(req);
  if (!userId) return NextResponse.json({ error: 'auth-required' }, { status: 401 });

  let body: {
    name?: string;
    description?: string;
    role?: string;
    skills?: unknown;
    mcpServers?: unknown;
    sops?: unknown;
    apis?: unknown;
    workspaceId?: string;
    orgId?: string;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'invalid-json' }, { status: 400 });
  }

  // Workspace-Scope → Membership-Pflicht.
  if (body.workspaceId) {
    const role = getEffectiveWorkspaceRole(userId, body.workspaceId);
    if (!canEditWorkspaceContent(role) || !hasRealWorkspaceMembership(userId, body.workspaceId)) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    }
  }

  const asList = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

  try {
    const profile = createAgentProfile({
      name: body.name ?? '',
      description: body.description ?? null,
      role: body.role ?? '',
      skills: asList(body.skills),
      mcpServers: asList(body.mcpServers),
      sops: asList(body.sops),
      apis: asList(body.apis),
      workspaceId: body.workspaceId ?? null,
      orgId: body.orgId ?? null,
      createdBy: userId,
    });
    return NextResponse.json(
      { profile: serialize(profile) },
      { status: 201, headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (err) {
    if (err instanceof AgentProfileError) {
      return NextResponse.json({ error: err.code, message: err.message }, { status: 400 });
    }
    return NextResponse.json(
      { error: 'create-failed', message: err instanceof Error ? err.message : 'unknown' },
      { status: 500 },
    );
  }
}
