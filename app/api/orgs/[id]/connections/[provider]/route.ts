/**
 * PUT    /api/orgs/[id]/connections/[provider]  — connect (store secret, org scope)
 * DELETE /api/orgs/[id]/connections/[provider]  — disconnect
 *
 * Org-scoped connector credentials (api_credentials scope_kind='org'). The secret
 * is encrypted at rest by the vault and never returned. Admin-only. The vault
 * double-checks org-admin on write (defense in depth). N9 isolation: the scope
 * anchor is the orgId.
 */

import { NextResponse, type NextRequest } from "next/server";

import { assertOrgRole, OrgAuthError } from "@/lib/orgs/auth";
import { putApiCredential, deleteApiCredential } from "@/lib/credentials/vault";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string; provider: string }>;
}

function authErr(e: unknown): Response {
  if (e instanceof OrgAuthError) {
    const status = e.code === "auth-required" ? 401 : 403;
    return NextResponse.json({ error: e.code, message: e.message }, { status });
  }
  return NextResponse.json({ error: "server_error" }, { status: 500 });
}

export async function PUT(req: NextRequest, ctx: Ctx): Promise<Response> {
  const { id: orgId, provider } = await ctx.params;
  let userId: string;
  try {
    ({ userId } = assertOrgRole(req, orgId, "admin"));
  } catch (e) {
    return authErr(e);
  }

  let secret = "";
  try {
    const body = (await req.json()) as { secret?: unknown };
    secret = typeof body.secret === "string" ? body.secret.trim() : "";
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (secret.length === 0) {
    return NextResponse.json({ error: "missing_secret" }, { status: 400 });
  }

  const credId = putApiCredential(
    { scopeKind: "org", scopeId: orgId, provider, kind: "api_key", secret },
    { userId, source: "org-connections" },
  );
  if (!credId) {
    // invalid provider or vault auth-denied (both audited inside the vault).
    return NextResponse.json({ error: "connect_failed" }, { status: 400 });
  }
  return NextResponse.json({ ok: true, provider, connected: true });
}

export async function DELETE(req: NextRequest, ctx: Ctx): Promise<Response> {
  const { id: orgId, provider } = await ctx.params;
  let userId: string;
  try {
    ({ userId } = assertOrgRole(req, orgId, "admin"));
  } catch (e) {
    return authErr(e);
  }

  const removed = deleteApiCredential("org", orgId, provider, {
    userId,
    source: "org-connections",
  });
  return NextResponse.json({ ok: true, provider, connected: false, removed });
}
