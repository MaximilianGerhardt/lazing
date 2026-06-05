/**
 * GET /api/orgs/[id]/connections
 *
 * Org-scoped connections surface: lists the connector catalog (API/OAuth
 * connectors AND MCP-server connectors) together with which ones are currently
 * connected at the ORG scope (api_credentials scope_kind='org', scope_id=orgId).
 *
 * N9: org-scope isolation — a connection here is shared by the org's workspaces
 * but never leaks to another org. Secrets are never returned (only connected:bool).
 * Auth: any org member may view the list (viewer); writes require admin.
 */

import { NextResponse, type NextRequest } from "next/server";

import { getDb } from "@/db/client";
import { listConnectors } from "@/lib/connectors/catalog";
import { assertOrgRole, OrgAuthError } from "@/lib/orgs/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

function authErr(e: unknown): Response {
  if (e instanceof OrgAuthError) {
    const status = e.code === "auth-required" ? 401 : 403;
    return NextResponse.json({ error: e.code, message: e.message }, { status });
  }
  return NextResponse.json({ error: "server_error" }, { status: 500 });
}

export async function GET(req: NextRequest, ctx: Ctx): Promise<Response> {
  const { id: orgId } = await ctx.params;
  let isAdmin = false;
  try {
    assertOrgRole(req, orgId, "viewer");
    try {
      assertOrgRole(req, orgId, "admin");
      isAdmin = true;
    } catch {
      isAdmin = false;
    }
  } catch (e) {
    return authErr(e);
  }

  // Which providers are connected at THIS org's scope (no secrets exposed).
  let connected = new Set<string>();
  try {
    const rows = getDb()
      .$raw.prepare(
        "SELECT provider FROM api_credentials WHERE scope_kind = 'org' AND scope_id = ?",
      )
      .all(orgId) as Array<{ provider: string }>;
    connected = new Set(rows.map((r) => r.provider));
  } catch {
    connected = new Set();
  }

  const connectors = listConnectors()
    .map((c) => ({
      provider: c.provider,
      displayName: c.displayName,
      description: c.description ?? null,
      authKind: c.authKind ?? "api_key",
      connected: connected.has(c.provider),
    }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));

  return NextResponse.json(
    { orgId, isAdmin, connectors },
    { headers: { "Cache-Control": "no-store" } },
  );
}
