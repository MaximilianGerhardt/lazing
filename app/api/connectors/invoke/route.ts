/**
 * POST /api/connectors/invoke
 *
 * ACL5-E (2026-05-24) — connector call after user approve.
 *
 * This route is the ONLY way for real connector calls after user approval.
 * It receives the user confirmation (click on „Freigeben & ausführen" in the
 * connector-call-preview card) and calls executeCall({..., approved:true}).
 *
 * ── Auth gate ─────────────────────────────────────────────────────────────────
 *   The same hardening as /api/connectors/[provider]/credential:
 *   (A) currentUserIdResolved → 401 if not logged in.
 *   (B) canEditWorkspaceContent(getEffectiveWorkspaceRole) → 403.
 *   (C) hasRealWorkspaceMembership (IDOR hardening) → 403.
 *   No `solo-implicit-founder` trust for this sensitive call.
 *
 * ── LIVE gate ────────────────────────────────────────────────────────────────
 *   executeCall is itself gated by:
 *   PRE-1..PRE-4: profile, coverage, S4 hardening, S6 trust/approval.
 *   PRE-5: LAZYOS_CONNECTOR_LIVE — default off → dry run.
 *   PRE-6: credential resolution ONLY when LIVE is on.
 *
 * ── Security ─────────────────────────────────────────────────────────────────
 *   - `approved:true` comes from this endpoint (user confirmation = click).
 *   - No secret in the request body, response or logs.
 *   - Response: { ok, dryRun?, blocked?, resultSummary } — NO secret.
 *   - Audit: executeCall always writes an N8 audit row.
 *
 * ── N8 ───────────────────────────────────────────────────────────────────────
 *   executeCall → recordCallAudit('invoke'|'deny'|'dry-run', ...).
 *   This endpoint writes no audit row of its own — executeCall does that.
 */

import { and, eq } from 'drizzle-orm';
import { NextResponse, type NextRequest } from 'next/server';

import { getDb } from '@/db/client';
import { workspaceMemberships } from '@/db/schema/memberships';
import { currentUserIdResolved } from '@/lib/security/subject-server';
import {
  canEditWorkspaceContent,
  getEffectiveWorkspaceRole,
} from '@/lib/security/permissions';
import { findOrgForWorkspace, findUserOrgMembership } from '@/lib/orgs/repo';
import { executeCall } from '@/lib/connectors/invoke';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Provider regex (mirrored from vault.ts + credential-route.ts).
const PROVIDER_RE = /^[a-z][a-z0-9_-]{0,63}$/;

// Capability regex: allows [a-z][a-z0-9_-]*.
const CAPABILITY_RE = /^[a-z][a-z0-9_-]{0,63}$/;

// WorkspaceId format guard (security critic finding 2, LOW).
// Prevents control/overlong values from landing in the audit result_summary.
// The membership query is parametrized via Drizzle anyway — pure hardening.
const WORKSPACE_ID_RE = /^[a-zA-Z0-9_:-]{1,128}$/;

// ─────────────────────────────────────────────────────────────────────────────
// IDOR hardening (analogous to credential/route.ts — security critic 2a)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * For this sensitive call (real API call after user approve) we require
 * proven workspace membership — `solo-implicit-founder` is not enough.
 */
function hasRealWorkspaceMembership(userId: string, workspaceId: string): boolean {
  const db = getDb();
  const wsMem = db
    .select({ id: workspaceMemberships.userId })
    .from(workspaceMemberships)
    .where(
      and(
        eq(workspaceMemberships.userId, userId),
        eq(workspaceMemberships.workspaceId, workspaceId),
      ),
    )
    .limit(1)
    .all();
  if (wsMem.length > 0) return true;

  const org = findOrgForWorkspace(workspaceId);
  if (org && findUserOrgMembership(userId, org.id) !== null) return true;

  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// POST handler
// ─────────────────────────────────────────────────────────────────────────────

interface InvokeBody {
  provider?: unknown;
  capability?: unknown;
  workspaceId?: unknown;
  /** Optional payload (keys + arbitrary values, no secret). */
  payload?: unknown;
}

export async function POST(req: NextRequest): Promise<Response> {
  // ── 1. Auth gate ─────────────────────────────────────────────────────────
  const userId = currentUserIdResolved(req);
  if (!userId) {
    return NextResponse.json({ error: 'auth-required' }, { status: 401 });
  }

  // ── 2. Parse the body ──────────────────────────────────────────────────────
  let body: InvokeBody;
  try {
    body = (await req.json()) as InvokeBody;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  // ── 3. Validation (N6: deterministic before DB access) ───────────────────
  const provider = typeof body.provider === 'string' ? body.provider.trim() : '';
  if (!PROVIDER_RE.test(provider)) {
    return NextResponse.json(
      { error: 'invalid_provider', message: 'provider muss ^[a-z][a-z0-9_-]{0,63}$ sein' },
      { status: 400 },
    );
  }

  const capability = typeof body.capability === 'string' ? body.capability.trim() : '';
  if (!CAPABILITY_RE.test(capability)) {
    return NextResponse.json(
      { error: 'invalid_capability', message: 'capability muss ^[a-z][a-z0-9_-]{0,63}$ sein' },
      { status: 400 },
    );
  }

  const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId.trim() : '';
  if (!workspaceId) {
    return NextResponse.json(
      { error: 'missing_workspace_id', message: 'workspaceId fehlt im Body' },
      { status: 400 },
    );
  }
  // Finding 2 (LOW): format guard on workspaceId — analogous to provider/capability.
  if (!WORKSPACE_ID_RE.test(workspaceId)) {
    return NextResponse.json(
      { error: 'invalid_workspace_id', message: 'workspaceId muss ^[a-zA-Z0-9_:-]{1,128}$ sein' },
      { status: 400 },
    );
  }

  // ── 4. Permission gate ───────────────────────────────────────────────────
  if (!canEditWorkspaceContent(getEffectiveWorkspaceRole(userId, workspaceId))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  // ── 4b. IDOR hardening ───────────────────────────────────────────────────
  if (!hasRealWorkspaceMembership(userId, workspaceId)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  // ── 5. Sanitize the payload (no secrets, no PII) ─────────────────────────
  // The body payload comes from the preview card (payloadSummary = keys + types).
  // We filter out known sensitive key names before calling executeCall.
  const rawPayload = body.payload;
  let callPayload: Record<string, unknown> | undefined;
  if (rawPayload !== null && rawPayload !== undefined && typeof rawPayload === 'object' && !Array.isArray(rawPayload)) {
    const sanitized: Record<string, unknown> = {};
    const FORBIDDEN_PAYLOAD_KEYS = new Set([
      'secret', 'token', 'api_key', 'apiKey', 'password',
      'private_key', 'privateKey', 'access_token', 'accessToken',
      'refresh_token', 'refreshToken', 'client_secret', 'clientSecret',
    ]);
    for (const [k, v] of Object.entries(rawPayload as Record<string, unknown>)) {
      if (!FORBIDDEN_PAYLOAD_KEYS.has(k)) {
        sanitized[k] = v;
      }
    }
    callPayload = sanitized;
  }

  // ── 6. executeCall — gated (N6: all PRE-1..PRE-5) ───────────────────────
  // approved:true = the user approved the call via the preview card.
  // The gate chain in executeCall decides between a real call vs. a dry run.
  let callResult;
  try {
    callResult = await executeCall({
      provider,
      capability,
      payload: callPayload,
      workspaceId,
      userId,
      scopeKind: 'workspace',
      requiredCaps: [capability],
      // approved:true: user confirmation via a click on „Freigeben & ausführen".
      approved: true,
    });
  } catch (err) {
    // executeCall does not throw internally (all errors → BlockedCallResult),
    // but a defensive catch for unexpected exceptions.
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[connectors/invoke] executeCall threw unexpectedly:', msg);
    return NextResponse.json(
      { ok: false, blocked: 'call-error', detail: msg.slice(0, 200) },
      { status: 500 },
    );
  }

  // ── 7. Response — NO secret ──────────────────────────────────────────────
  if (!callResult.ok) {
    // Blocked: the PRE gate failed or a call error.
    // Finding 1 (MEDIUM): ONLY the machine-readable code goes to the client.
    // `callResult.detail` contains internal S4 structure (hardened.rationale,
    // allowedMcpTools list, allowed capabilities) — would let a workspace
    // member enumerate the internal toolset layout by probing.
    // The full reasoning stays server-side in the N8 audit row that
    // executeCall writes anyway (recordCallAudit('deny', ...)).
    return NextResponse.json(
      {
        ok: false,
        blocked: callResult.blocked,
      },
      { status: 200 }, // 200 because the route itself succeeded; the call was gated
    );
  }

  if (callResult.dryRun) {
    // Dry run: LAZYOS_CONNECTOR_LIVE is off. Clearly labeled.
    return NextResponse.json(
      {
        ok: true,
        dryRun: true,
        resultSummary: callResult.simulatedResult.slice(0, 300),
        payloadHash: callResult.payloadHash,
      },
      { status: 200 },
    );
  }

  // Real call: status + resultSummary (no response body, no secret).
  return NextResponse.json(
    {
      ok: true,
      dryRun: false,
      resultSummary: callResult.resultSummary.slice(0, 300),
      payloadHash: callResult.payloadHash,
    },
    { status: 200 },
  );
}
