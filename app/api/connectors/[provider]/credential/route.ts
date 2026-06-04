/**
 * POST /api/connectors/[provider]/credential
 *
 * ACL5-B (2026-05-24) — credential-input endpoint for the
 * CredentialRequestCard surface.
 *
 * Purpose: takes the API-key secret, writes it directly into the vault
 * (putApiCredential), and returns ONLY { ok, masked } — NEVER the secret.
 *
 * SECURITY CONTRACT (ACL5-B):
 *   - The secret comes only via this POST. It is NEVER written into the chat
 *     transcript / SSE / ledger / logs.
 *   - The surface payload (which runs via emitOrUpdateCard/SSE) contains
 *     NO secret field — only provider, scopeKind, workspaceId, why.
 *   - The response of this endpoint contains ONLY { ok: true, masked: "ab••••cd" }.
 *     The plaintext of the secret never appears in the response.
 *   - The vault auth gate is twofold: here (auth cookie + workspace permission)
 *     AND internally in putApiCredential (isVaultWriteAllowed) — defense-in-depth.
 *
 * Auth: currentUserIdResolved + canEditWorkspaceContent(getEffectiveWorkspaceRole).
 * The workspace ID comes from the request body (workspaceId field), not from URL params,
 * so the scope binding is explicit and not inferred from the URL.
 *
 * Provider validation: regex ^[a-z][a-z0-9_-]{0,63}$ (identical to vault.ts PROVIDER_RE).
 * Invalid provider → 400 (no write, no audit leak).
 *
 * N8: putApiCredential always writes an audit row (put/deny).
 * N9: scope_kind + scope_id are the isolation anchor in every DB write.
 * N10: content_hash tamper-evident over canonical JSON.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { maskedPreview } from '@/lib/security/credentials';
import { currentUserIdResolved } from '@/lib/security/subject-server';
import {
  canEditWorkspaceContent,
  getEffectiveWorkspaceRole,
} from '@/lib/security/permissions';
import { hasRealWorkspaceMembership } from '@/lib/security/membership';
import { findOrgForWorkspace } from '@/lib/orgs/repo';
import { putApiCredential, type ScopeKind } from '@/lib/credentials/vault';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Provider regex (mirrored from vault.ts PROVIDER_RE).
const PROVIDER_RE = /^[a-z][a-z0-9_-]{0,63}$/;

// hasRealWorkspaceMembership: see lib/security/membership.ts (shared with vault).

interface Ctx {
  params: Promise<{ provider: string }>;
}

interface PostBody {
  secret?: unknown;
  scopeKind?: unknown;
  workspaceId?: unknown;
  config?: unknown;
}

export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  // ── 1. Auth gate (no currentUserId → 401) ─────────────────────────────────
  const userId = currentUserIdResolved(req);
  if (!userId) {
    return NextResponse.json({ error: 'auth-required' }, { status: 401 });
  }

  // ── 2. Provider validation (before DB access) ─────────────────────────────
  const { provider } = await ctx.params;
  if (!PROVIDER_RE.test(provider)) {
    return NextResponse.json(
      { error: 'invalid_provider', message: 'provider muss ^[a-z][a-z0-9_-]{0,63}$ sein' },
      { status: 400 },
    );
  }

  // ── 3. Parse the body ──────────────────────────────────────────────────────
  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  // ── 4. Validate the secret ─────────────────────────────────────────────────
  // SECURITY: we read the secret only from the POST body and do NOT log it.
  const secret = typeof body.secret === 'string' ? body.secret : '';
  if (secret.length === 0 || secret.length > 50_000) {
    return NextResponse.json(
      { error: 'invalid_secret', message: 'secret: 1-50000 Zeichen' },
      { status: 400 },
    );
  }

  // ── 5. Workspace ID + scope ────────────────────────────────────────────────
  const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId.trim() : '';
  if (!workspaceId) {
    return NextResponse.json(
      { error: 'missing_workspace_id', message: 'workspaceId fehlt im Body' },
      { status: 400 },
    );
  }

  const scopeKindRaw = typeof body.scopeKind === 'string' ? body.scopeKind : 'workspace';
  const scopeKind: ScopeKind = scopeKindRaw === 'org' ? 'org' : 'workspace';

  // The scope_id value depends on scopeKind:
  //   workspace → scopeId = workspaceId (from body).
  //   org → scopeId = the REAL orgId (via findOrgForWorkspace).
  //         workspaceId as scopeId for org scope is WRONG:
  //         isOrgAdmin(userId, workspaceId) never matches → org writes effectively broken.
  //         P0 fix (F-2, 2026-05-25): resolve the real orgId.
  let scopeId: string;
  if (scopeKind === 'org') {
    const org = findOrgForWorkspace(workspaceId);
    if (!org) {
      // Org scope without an org is pointless — no silent fallback to workspaceId.
      return NextResponse.json(
        { error: 'workspace_has_no_org', message: 'Workspace ist keiner Org zugeordnet — org-scope nicht möglich' },
        { status: 400 },
      );
    }
    scopeId = org.id;
  } else {
    scopeId = workspaceId;
  }

  // ── 6. Workspace permission gate (defense-in-depth) ───────────────────────
  // The vault has isVaultWriteAllowed() internally, but we check HERE additionally
  // so the HTTP context (req, userId) is explicitly checked (M-3 analogous).
  if (!canEditWorkspaceContent(getEffectiveWorkspaceRole(userId, workspaceId))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  // ── 6b. IDOR hardening (security critic 2a / P0-C1) ──────────────────────
  // The body `workspaceId` must NOT be trusted blindly. For this sensitive
  // credential WRITE we require a PROVEN membership (real
  // workspace OR org membership) via hasRealWorkspaceMembership from
  // lib/security/membership.ts — the same module vault.ts uses for the org
  // fallback read gate (no duplicate).
  // `solo-implicit-founder` is NOT enough.
  if (!hasRealWorkspaceMembership(userId, workspaceId)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  // ── 7. Optional: config fields (plain, no secret) ─────────────────────────
  let config: Record<string, unknown> | null = null;
  if (body.config !== null && body.config !== undefined && typeof body.config === 'object' && !Array.isArray(body.config)) {
    // Defensive: only string values allowed; no secret/token field.
    const raw = body.config as Record<string, unknown>;
    config = {};
    for (const [k, v] of Object.entries(raw)) {
      if (/secret|token|api.?key|password/i.test(k)) continue;
      if (typeof v === 'string') {
        config[k] = v;
      }
    }
    if (Object.keys(config).length === 0) config = null;
  }

  // ── 8. Vault write ─────────────────────────────────────────────────────────
  // putApiCredential:
  //   - Encrypts the secret immediately (AES-256-GCM).
  //   - Writes an audit row (N8).
  //   - Auth gate internally (isVaultWriteAllowed) → null on deny.
  //   - NEVER the secret in audit rows/logs (only a hash, no plaintext).
  const credId = putApiCredential(
    {
      scopeKind,
      scopeId,
      provider,
      kind: 'api_key',
      secret,
      config,
    },
    {
      userId,
      source: 'api.connectors.credential.post',
    },
  );

  if (credId === null) {
    // putApiCredential returns null on deny (auth gate or invalid provider).
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  // ── 9. Response: ONLY { ok, masked } — NO secret ─────────────────────────
  // maskedPreview: "ab••••cd (n)" — the plaintext NEVER appears in the response.
  const maskedValue = maskedPreview(secret);

  return NextResponse.json(
    {
      ok: true,
      // SECURITY: masked is a safe preview (never the plaintext).
      masked: maskedValue,
    },
    { status: 201 },
  );
}
