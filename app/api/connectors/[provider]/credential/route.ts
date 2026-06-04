/**
 * POST /api/connectors/[provider]/credential
 *
 * ACL5-B (2026-05-24) — Credential-Eingabe-Endpoint für die
 * CredentialRequestCard-Surface.
 *
 * Zweck: Nimmt den API-Key-Secret entgegen, schreibt ihn direkt in den Vault
 * (putApiCredential), und gibt NUR { ok, masked } zurück — NIEMALS das Secret.
 *
 * SECURITY CONTRACT (ACL5-B):
 *   - Das Secret kommt nur über diesen POST. Es wird NIEMALS in Chat-
 *     Transcript / SSE / Ledger / Logs geschrieben.
 *   - Die Surface-Payload (die via emitOrUpdateCard/SSE läuft) enthält
 *     KEIN secret-Feld — nur provider, scopeKind, workspaceId, why.
 *   - Die Antwort dieses Endpoints enthält NUR { ok: true, masked: "ab••••cd" }.
 *     Der Klartext des Secrets erscheint nie in der Response.
 *   - Vault-Auth-Gate ist zweifach: hier (Auth-Cookie + Workspace-Permission)
 *     UND intern in putApiCredential (isVaultWriteAllowed) — Defense-in-depth.
 *
 * Auth: currentUserIdResolved + canEditWorkspaceContent(getEffectiveWorkspaceRole).
 * Workspace-ID kommt aus dem Request-Body (workspaceId-Feld), nicht aus URL-Params,
 * damit die Scope-Bindung explizit ist und nicht aus der URL erschlossen wird.
 *
 * Provider-Validierung: Regex ^[a-z][a-z0-9_-]{0,63}$ (identisch zu vault.ts PROVIDER_RE).
 * Ungültiger Provider → 400 (kein Write, kein Audit-Leak).
 *
 * N8: putApiCredential schreibt immer eine Audit-Row (put/deny).
 * N9: scope_kind + scope_id sind der Isolation-Anker in jedem DB-Write.
 * N10: content_hash tamper-evident über canonical JSON.
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

// Provider-Regex (gespiegelt von vault.ts PROVIDER_RE).
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
  // ── 1. Auth-Gate (kein currentUserId → 401) ───────────────────────────────
  const userId = currentUserIdResolved(req);
  if (!userId) {
    return NextResponse.json({ error: 'auth-required' }, { status: 401 });
  }

  // ── 2. Provider-Validierung (vor DB-Zugriff) ──────────────────────────────
  const { provider } = await ctx.params;
  if (!PROVIDER_RE.test(provider)) {
    return NextResponse.json(
      { error: 'invalid_provider', message: 'provider muss ^[a-z][a-z0-9_-]{0,63}$ sein' },
      { status: 400 },
    );
  }

  // ── 3. Body parsen ─────────────────────────────────────────────────────────
  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  // ── 4. Secret validieren ──────────────────────────────────────────────────
  // SECURITY: wir lesen den Secret nur aus dem POST-Body und loggen ihn NICHT.
  const secret = typeof body.secret === 'string' ? body.secret : '';
  if (secret.length === 0 || secret.length > 50_000) {
    return NextResponse.json(
      { error: 'invalid_secret', message: 'secret: 1-50000 Zeichen' },
      { status: 400 },
    );
  }

  // ── 5. Workspace-ID + Scope ────────────────────────────────────────────────
  const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId.trim() : '';
  if (!workspaceId) {
    return NextResponse.json(
      { error: 'missing_workspace_id', message: 'workspaceId fehlt im Body' },
      { status: 400 },
    );
  }

  const scopeKindRaw = typeof body.scopeKind === 'string' ? body.scopeKind : 'workspace';
  const scopeKind: ScopeKind = scopeKindRaw === 'org' ? 'org' : 'workspace';

  // Der scope_id-Wert hängt vom scopeKind ab:
  //   workspace → scopeId = workspaceId (aus Body).
  //   org → scopeId = ECHTE orgId (via findOrgForWorkspace).
  //         workspaceId als scopeId für org-scope ist FALSCH:
  //         isOrgAdmin(userId, workspaceId) matcht nie → org-writes faktisch kaputt.
  //         P0-Fix (F-2, 2026-05-25): echte orgId auflösen.
  let scopeId: string;
  if (scopeKind === 'org') {
    const org = findOrgForWorkspace(workspaceId);
    if (!org) {
      // Org-Scope ohne Org ist sinnlos — kein silenter Fallback auf workspaceId.
      return NextResponse.json(
        { error: 'workspace_has_no_org', message: 'Workspace ist keiner Org zugeordnet — org-scope nicht möglich' },
        { status: 400 },
      );
    }
    scopeId = org.id;
  } else {
    scopeId = workspaceId;
  }

  // ── 6. Workspace-Permission-Gate (Defense-in-depth) ───────────────────────
  // Vault hat intern isVaultWriteAllowed(), aber wir prüfen HIER zusätzlich
  // damit der HTTP-Kontext (req, userId) explizit geprüft ist (M-3 analog).
  if (!canEditWorkspaceContent(getEffectiveWorkspaceRole(userId, workspaceId))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  // ── 6b. IDOR-Härtung (Security-Critic 2a / P0-C1) ────────────────────────
  // Body-`workspaceId` darf NICHT blind vertraut werden. Für diesen sensiblen
  // Credential-WRITE verlangen wir eine NACHGEWIESENE Zugehörigkeit (echte
  // workspace- ODER org-Membership) via hasRealWorkspaceMembership aus
  // lib/security/membership.ts — dasselbe Modul, das vault.ts für den Org-
  // Fallback-Read-Gate nutzt (kein Duplikat).
  // `solo-implicit-founder` reicht NICHT.
  if (!hasRealWorkspaceMembership(userId, workspaceId)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  // ── 7. Optional: config-Felder (Plain, kein Secret) ───────────────────────
  let config: Record<string, unknown> | null = null;
  if (body.config !== null && body.config !== undefined && typeof body.config === 'object' && !Array.isArray(body.config)) {
    // Defensiv: nur String-Values erlaubt; kein secret/token-Feld.
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

  // ── 8. Vault-Write ────────────────────────────────────────────────────────
  // putApiCredential:
  //   - Verschlüsselt das Secret sofort (AES-256-GCM).
  //   - Schreibt Audit-Row (N8).
  //   - Auth-Gate intern (isVaultWriteAllowed) → null bei Deny.
  //   - NIEMALS das Secret in Audit-Rows/Logs (nur hash, kein Klartext).
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
    // putApiCredential gibt null bei Deny zurück (Auth-Gate oder ungültiger Provider).
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  // ── 9. Antwort: NUR { ok, masked } — KEIN Secret ─────────────────────────
  // maskedPreview: "ab••••cd (n)" — der Klartext erscheint NIE in der Response.
  const maskedValue = maskedPreview(secret);

  return NextResponse.json(
    {
      ok: true,
      // SECURITY: masked ist eine sichere Vorschau (nie der Klartext).
      masked: maskedValue,
    },
    { status: 201 },
  );
}
