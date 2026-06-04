/**
 * POST /api/connectors/invoke
 *
 * ACL5-E (2026-05-24) — Connector-Call nach User-Approve.
 *
 * Diese Route ist der EINZIGE Weg für echte Connector-Calls nach User-Freigabe.
 * Sie empfängt die User-Bestätigung (Klick auf „Freigeben & ausführen" in der
 * connector-call-preview-Card) und ruft executeCall({..., approved:true}).
 *
 * ── Auth-Gate ─────────────────────────────────────────────────────────────────
 *   Dieselbe Härtung wie /api/connectors/[provider]/credential:
 *   (A) currentUserIdResolved → 401 wenn nicht eingeloggt.
 *   (B) canEditWorkspaceContent(getEffectiveWorkspaceRole) → 403.
 *   (C) hasRealWorkspaceMembership (IDOR-Härtung) → 403.
 *   Kein `solo-implicit-founder`-Vertrauen für diesen sensiblen Call.
 *
 * ── LIVE-Gate ────────────────────────────────────────────────────────────────
 *   executeCall ist selbst gated durch:
 *   PRE-1..PRE-4: Profil, Coverage, S4-Hardening, S6-Trust/Approval.
 *   PRE-5: LAZYOS_CONNECTOR_LIVE — default off → Dry-Run.
 *   PRE-6: Credential-Resolution ERST wenn LIVE on.
 *
 * ── Security ─────────────────────────────────────────────────────────────────
 *   - `approved:true` kommt von diesem Endpoint (User-Bestätigung = Klick).
 *   - Kein Secret in Request-Body, Response oder Logs.
 *   - Response: { ok, dryRun?, blocked?, resultSummary } — KEIN Secret.
 *   - Audit: executeCall schreibt immer eine N8-Audit-Row.
 *
 * ── N8 ───────────────────────────────────────────────────────────────────────
 *   executeCall → recordCallAudit('invoke'|'deny'|'dry-run', ...).
 *   Dieser Endpoint schreibt keine eigene Audit-Row — executeCall macht das.
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

// Provider-Regex (gespiegelt von vault.ts + credential-route.ts).
const PROVIDER_RE = /^[a-z][a-z0-9_-]{0,63}$/;

// Capability-Regex: erlaubt [a-z][a-z0-9_-]*.
const CAPABILITY_RE = /^[a-z][a-z0-9_-]{0,63}$/;

// WorkspaceId-Format-Guard (Security-Critic Finding 2, LOW).
// Verhindert dass Kontroll-/überlange Werte in Audit-result_summary landen.
// Membership-Query ist via Drizzle ohnehin parametrisiert — reine Härtung.
const WORKSPACE_ID_RE = /^[a-zA-Z0-9_:-]{1,128}$/;

// ─────────────────────────────────────────────────────────────────────────────
// IDOR-Härtung (analog credential/route.ts — Security-Critic 2a)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Für diesen sensiblen Call (echter API-Aufruf nach User-Approve) verlangen
 * wir nachgewiesene Workspace-Zugehörigkeit — `solo-implicit-founder` reicht nicht.
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
// POST-Handler
// ─────────────────────────────────────────────────────────────────────────────

interface InvokeBody {
  provider?: unknown;
  capability?: unknown;
  workspaceId?: unknown;
  /** Optionaler Payload (Keys + beliebige Werte, kein Secret). */
  payload?: unknown;
}

export async function POST(req: NextRequest): Promise<Response> {
  // ── 1. Auth-Gate ─────────────────────────────────────────────────────────
  const userId = currentUserIdResolved(req);
  if (!userId) {
    return NextResponse.json({ error: 'auth-required' }, { status: 401 });
  }

  // ── 2. Body parsen ───────────────────────────────────────────────────────
  let body: InvokeBody;
  try {
    body = (await req.json()) as InvokeBody;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  // ── 3. Validierung (N6: deterministisch vor DB-Zugriff) ──────────────────
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
  // Finding 2 (LOW): Format-Guard auf workspaceId — analog provider/capability.
  if (!WORKSPACE_ID_RE.test(workspaceId)) {
    return NextResponse.json(
      { error: 'invalid_workspace_id', message: 'workspaceId muss ^[a-zA-Z0-9_:-]{1,128}$ sein' },
      { status: 400 },
    );
  }

  // ── 4. Permission-Gate ───────────────────────────────────────────────────
  if (!canEditWorkspaceContent(getEffectiveWorkspaceRole(userId, workspaceId))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  // ── 4b. IDOR-Härtung ─────────────────────────────────────────────────────
  if (!hasRealWorkspaceMembership(userId, workspaceId)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  // ── 5. Payload sanitisieren (keine Secrets, kein PII) ────────────────────
  // Der Body-Payload kommt aus der Preview-Card (payloadSummary = Keys + Typen).
  // Wir filtern bekannte sensitive Key-Namen heraus bevor wir executeCall aufrufen.
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

  // ── 6. executeCall — gated (N6: alle PRE-1..PRE-5) ──────────────────────
  // approved:true = User hat den Call über die preview-Card freigegeben.
  // Die Gate-Kette in executeCall entscheidet über echten Call vs. Dry-Run.
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
      // approved:true: User-Bestätigung via Klick auf „Freigeben & ausführen".
      approved: true,
    });
  } catch (err) {
    // executeCall wirft intern nicht (alle Fehler → BlockedCallResult),
    // aber defensive Catch für unerwartete Exceptions.
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[connectors/invoke] executeCall threw unexpectedly:', msg);
    return NextResponse.json(
      { ok: false, blocked: 'call-error', detail: msg.slice(0, 200) },
      { status: 500 },
    );
  }

  // ── 7. Response — KEIN Secret ────────────────────────────────────────────
  if (!callResult.ok) {
    // Blockiert: PRE-Gate hat versagt oder Call-Error.
    // Finding 1 (MEDIUM): NUR der maschinenlesbare Code geht an den Client.
    // `callResult.detail` enthält interne S4-Struktur (hardened.rationale,
    // allowedMcpTools-Liste, erlaubte Capabilities) — würde einem Workspace-
    // Member per Probing das interne Toolset-Layout enumerieren lassen.
    // Die volle Begründung bleibt server-seitig in der N8-Audit-Row, die
    // executeCall ohnehin schreibt (recordCallAudit('deny', ...)).
    return NextResponse.json(
      {
        ok: false,
        blocked: callResult.blocked,
      },
      { status: 200 }, // 200 weil die Route selbst erfolgreich war; der Call war gated
    );
  }

  if (callResult.dryRun) {
    // Dry-Run: LAZYOS_CONNECTOR_LIVE ist off. Klar gelabelt.
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

  // Echter Call: status + resultSummary (kein Response-Body, kein Secret).
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
