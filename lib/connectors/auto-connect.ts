/**
 * Auto-Connect Flow — ACL5-E (2026-05-24).
 *
 * `maybeAutoConnect(prompt, ctx)` is called hybrid in the chat-stream process
 * (fire-and-forget, analogous to plan-dispatch). It makes NO real connector call —
 * only detect / setup / preview. A real call happens only after user approval via
 * POST /api/connectors/invoke.
 *
 * ── Flow ──────────────────────────────────────────────────────────────────────
 *   1. detectConnector(prompt, ctx) — deterministic (N6, no LLM, no I/O).
 *      missing='no-connector' → no-op, return {acted:false}.
 *
 *   2. missing='profile' → kick off the connector-onboarding SOP (non-destructive,
 *      via the existing SOP→plan bridge). Emit a status card.
 *
 *   3. missing='credential' → emit a credential-request surface
 *      (provider/scopeKind/why). NO secret in the card.
 *
 *   4. missing='none' (profile + credential present) → previewCall(...)
 *      → emit a connector-call-preview surface (S5: endpoint, payload keys,
 *      masked credential, dryRun label if LIVE off) with an approve action.
 *
 * ── Constraints ───────────────────────────────────────────────────────────────
 *   - NON-DESTRUCTIVE: no real network call here.
 *   - Secret NEVER in card/transcript/SSE/log.
 *   - Process locality: must run in the Next process (:4200) (broadcast is an
 *     in-process EventEmitter). Never call it in the agent-server (:4201).
 *   - Codex is excluded by the B1 security fix (destructive code mode).
 *   - Fire-and-forget: never propagate errors to the chat stream.
 *   - N8: audit via previewCall (writes a preview row).
 *   - N6: detectConnector is deterministic — no LLM in the hot path.
 *
 * ── Where it is wired in ──────────────────────────────────────────────────────
 *   app/api/chat/stream/route.ts — analogous to the plan-dispatch hybrid block:
 *     void maybeAutoConnect(prompt, { workspaceId, userId }).catch(...)
 *   No effect on the normal answer stream.
 */

import { detectConnector } from '@/lib/connectors/detect';
import { previewCall } from '@/lib/connectors/invoke';
import { getConnectorProfile } from '@/lib/connectors/catalog';
import { getOnboardingSop } from '@/lib/connectors/onboarding-sop';
import { emitOrUpdateCard } from '@/lib/events/emit-or-update-card';
import { emitAnswerRequired } from '@/lib/push/triggers';
import { getDb } from '@/db/client';
import { and, eq } from 'drizzle-orm';
import { workspaceMemberships } from '@/db/schema/memberships';
import { getSop, listSops } from '@/lib/sop/registry';
import { expandSopToPlanNodes } from '@/lib/sop/executor';
import { createWorkstream } from '@/lib/workstreams/service';
import { insertProposedPlan } from '@/lib/workstreams/plan-repo';
import { executePlan } from '@/lib/workstreams/plan-executor';
import { writeDecision } from '@/lib/workstreams/trace-repo';
import { ulid } from '@/lib/ulid';

// ─────────────────────────────────────────────────────────────────────────────
// Public Types
// ─────────────────────────────────────────────────────────────────────────────

export interface AutoConnectCtx {
  workspaceId: string;
  userId: string;
  /** Optional request abort signal (not forwarded to detectConnector,
   *  reserved only for future async paths). */
  signal?: AbortSignal;
}

export type AutoConnectResult =
  | { acted: false; reason: string }
  | { acted: true; action: 'onboarding' | 'credential-request' | 'preview'; provider: string };

// ─────────────────────────────────────────────────────────────────────────────
// Internal helper functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Synchronous existence check on api_credentials (COUNT query, no decrypt).
 * Injected as the hasCredential callback into detectConnector (N6-compliant:
 * detect.ts itself never touches api_credentials).
 */
function buildHasCredential(workspaceId: string): (provider: string) => boolean {
  return (provider: string): boolean => {
    try {
      const db = getDb();
      const row = db.$raw
        .prepare(
          `SELECT COUNT(*) as n FROM api_credentials
           WHERE scope_kind = 'workspace' AND scope_id = ? AND provider = ?`,
        )
        .get(workspaceId, provider) as { n: number } | undefined;
      return (row?.n ?? 0) > 0;
    } catch {
      // Fail-closed: if the DB is unreachable → 'credential' (not 'none').
      return false;
    }
  };
}

/**
 * Pseudo workstreamId for emitOrUpdateCard: ACL5-E connector cards have
 * no real workstream. We use a deterministic prefix + provider, so that the
 * one-card-per-kind dedup takes effect (same provider → same card).
 */
function connectorCardWorkstreamId(provider: string): string {
  return `acl5e-connector-${provider}`;
}

/**
 * Onboarding-workstream dedup (bug fix 2026-05-30).
 *
 * Root cause: every chat prompt with `missing='profile'` for the same provider
 * CALLED triggerOnboardingSop() → createWorkstream() — without checking whether
 * a running onboarding already exists for this provider+workspace. Result:
 * 3+ simultaneous „Connector-Onboarding: heygen" workstreams.
 *
 * This function returns an already ACTIVE/running onboarding workstream
 * for the same provider+workspace (or null). Status 'active' and
 * 'paused' count as "still running" (a paused onboarding flow usually waits
 * for owner input and must not be spawned anew in parallel). 'done',
 * 'archived' and 'stuck' count as finished/dead → a renewed attempt is
 * then legitimate.
 *
 * N6: deterministic, pure DB read, no LLM, no I/O.
 * N9: workspace_id is the isolation anchor of the query — never provider-only.
 *
 * Matches on `name = 'Connector-Onboarding: <safeProviderId>'` — exactly the name
 * that triggerOnboardingSop() sets at createWorkstream() (single source).
 * Fail-open to null (no existing run): on a DB error prefer ONE
 * additional onboarding run over none — onboarding is non-destructive.
 */
function findActiveOnboardingWorkstreamId(
  workspaceId: string,
  safeProviderId: string,
): string | null {
  try {
    const db = getDb();
    const row = db.$raw
      .prepare(
        `SELECT id FROM workstreams
         WHERE workspace_id = ?
           AND name = ?
           AND status IN ('active', 'paused')
         ORDER BY created_at ASC
         LIMIT 1`,
      )
      .get(workspaceId, `Connector-Onboarding: ${safeProviderId}`) as
      | { id: string }
      | undefined;
    return row?.id ?? null;
  } catch {
    // Fail-open: no existing run detected → allow a new one (non-destructive).
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Onboarding-SOP path
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Starts the connector-onboarding SOP for a provider without a catalog profile
 * (missing='profile'). Non-destructive: no real network call, no spawn.
 *
 * Flow (P1-#5, real SOP bridge, no longer just a toast):
 *   1. Looks up the 'connector-onboarding' SOP in the registry via getSop/listSops.
 *   2. If the SOP is found: expandSopToPlanNodes → createWorkstream →
 *      insertProposedPlan (in a transaction) → executePlan (text-only, codex
 *      excluded, NON-DESTRUCTIVE) — identical to SAR-3 runPlanDispatch Path A.
 *   3. Emit a status card referencing the created workstream.
 *   4. If the SOP is NOT found: fall back to a warn toast (previous behavior),
 *      so the flow never crashes.
 *
 * Constraints:
 *   - NON-DESTRUCTIVE: executePlan is text-only (engine.chat()), no
 *     file-write operations, no codex.
 *   - NON-SECRET: no credential value in the card payload.
 *   - N1: goalPrompt (provider name as context) verbatim in the workstream description.
 *   - N8: writeDecision documents the routing decision.
 *   - N9: workspaceId as ManifestCoord on all persisted rows.
 *   - N10: insertProposedPlan stamps contentHash on every plan-step row.
 *
 * Error handling: does NOT throw — all errors land as a console.warn
 * (fire-and-forget, analogous to the maybeAutoConnect caller).
 */
async function triggerOnboardingSop(args: {
  provider: string;
  workspaceId: string;
  userId: string;
}): Promise<void> {
  const { provider, workspaceId } = args;

  // ── 1. Look up the 'connector-onboarding' SOP ───────────────────────────
  // Canonical built-in SOP id — if no explicit SOP exists, we look up
  // the name "Research → Synthesize → Draft → Review" (built-in seed)
  // as a fallback. The actual connector-onboarding SOP is workspace-scoped.
  const CONNECTOR_ONBOARDING_SOP_NAME_PATTERNS = [
    'connector-onboarding',
    'connector onboarding',
    'onboarding',
  ];

  let sopId: string | null = null;
  try {
    const sops = listSops(workspaceId);
    const found = sops.find((s) =>
      CONNECTOR_ONBOARDING_SOP_NAME_PATTERNS.some((p) =>
        s.name.toLowerCase().includes(p),
      ),
    );
    if (found) sopId = found.id;
  } catch {
    // Best-effort — registry unreachable → fallback
  }

  // ── 2. If no matching SOP: warn-toast fallback (no crash) ───────────────
  if (!sopId) {
    const sopHint = `Kein Connector-Onboarding-SOP für '${provider}' im Katalog. Onboarding erforderlich.`;
    await emitOrUpdateCard({
      coords: {
        workspaceId,
        workstreamId: connectorCardWorkstreamId(provider),
        surfaceKind: 'toast',
      },
      content: `<surface:toast>${JSON.stringify({
        variant: 'warn',
        iconGlyph: 'C',
        title: `Connector '${provider}' — Profil fehlt`,
        body: sopHint,
      })}</surface:toast>`,
      actor: 'system',
    });
    return;
  }

  // ── 3. SOP found → expandSopToPlanNodes → createWorkstream → persist ────
  const sop = getSop(sopId);
  if (!sop) {
    // SOP ID resolved but now archived or gone — fallback to toast.
    await emitOrUpdateCard({
      coords: {
        workspaceId,
        workstreamId: connectorCardWorkstreamId(provider),
        surfaceKind: 'toast',
      },
      content: `<surface:toast>${JSON.stringify({
        variant: 'warn',
        iconGlyph: 'C',
        title: `Connector '${provider}' — Profil fehlt`,
        body: `Connector-Onboarding-SOP '${sopId}' archiviert oder nicht auffindbar.`,
      })}</surface:toast>`,
      actor: 'system',
    });
    return;
  }

  // F4 Guard: workspaceId must be non-empty (N9 ManifestCoord invariant).
  const trustedWorkspaceId = workspaceId.trim();
  if (!trustedWorkspaceId) {
    console.warn('[auto-connect] triggerOnboardingSop: workspaceId fehlt — kein Dispatch.');
    return;
  }

  // #4 — sanitize provider for ID / internal name construction only.
  // Card display and goalPrompt use the original `provider` (verbatim, N1).
  // IDs and workstream.name must never contain shell-unsafe or DB-path-special
  // characters that could slip through from a crafted detectConnector result.
  const safeProviderId = provider.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64);

  // ── DEDUP (bug fix 2026-05-30) ──────────────────────────────────────────
  // If an active/paused onboarding workstream already exists for exactly
  // this provider+workspace → do NOT spawn a new one. Instead re-emit the
  // existing status card (idempotent via connectorCardWorkstreamId),
  // so the owner sees the running run, and return early.
  // Prevents the 3+ parallel „Connector-Onboarding: heygen" workstreams.
  const existingWsId = findActiveOnboardingWorkstreamId(trustedWorkspaceId, safeProviderId);
  if (existingWsId) {
    writeDecision({
      workspaceId: trustedWorkspaceId,
      workstreamId: existingWsId,
      coordKey: `${trustedWorkspaceId}/${existingWsId}`,
      decisionKind: 'route',
      rationale:
        `Auto-Connect onboarding DEDUP: aktiver Onboarding-Workstream ` +
        `'${existingWsId}' für provider '${provider}' existiert bereits — ` +
        `kein neuer Spawn (Bug-Fix 2026-05-30).`,
      actor: 'agent',
    });
    await emitOrUpdateCard({
      coords: {
        workspaceId: trustedWorkspaceId,
        workstreamId: connectorCardWorkstreamId(provider),
        surfaceKind: 'onboarding-progress',
      },
      content: `<surface:onboarding-progress>${JSON.stringify({
        provider,
        workstreamId: existingWsId,
        status: 'in-progress',
        deduped: true,
      })}</surface:onboarding-progress>`,
      actor: 'system',
    });
    return;
  }

  // N1: verbatim goal prompt — provider name + "create connector profile"
  const goalPrompt = `Connector-Profil für '${provider}' anlegen (automatisches Onboarding via SOP '${sop.name}').`;

  // Deterministic node IDs: acl5e prefix + safeProviderId + sopId + counter.
  // This ensures idempotency across retries for the same provider.
  let mintCounter = 0;
  const mintId = (): string =>
    `acl5e-${safeProviderId}-${sopId}-${mintCounter++}`;

  const nodes = expandSopToPlanNodes(sop, { mintId });
  if (nodes.length === 0) {
    // Empty SOP — fall through to toast.
    await emitOrUpdateCard({
      coords: {
        workspaceId,
        workstreamId: connectorCardWorkstreamId(provider),
        surfaceKind: 'toast',
      },
      content: `<surface:toast>${JSON.stringify({
        variant: 'warn',
        iconGlyph: 'C',
        title: `Connector '${provider}' — Profil fehlt`,
        body: `Connector-Onboarding-SOP '${sopId}' hat keine Steps (leer).`,
      })}</surface:toast>`,
      actor: 'system',
    });
    return;
  }

  // Create workstream (N1: goalPrompt verbatim in description).
  // name uses safeProviderId for internal storage; display contexts show `provider`.
  const ws = await createWorkstream({
    workspaceId: trustedWorkspaceId,
    name: `Connector-Onboarding: ${safeProviderId}`,
    description: goalPrompt,
  });
  const planWorkstreamId = ws.id;
  const coordKey = `${trustedWorkspaceId}/${planWorkstreamId}`;
  const rootPlan = nodes[0]!.plan;
  const planId = rootPlan.id;

  // Persist all nodes in a single transaction (N10: insertProposedPlan stamps contentHash).
  const db = getDb();
  const persist = db.$raw.transaction((): void => {
    for (const node of nodes) {
      insertProposedPlan({
        workstreamId: planWorkstreamId,
        plan: node.plan,
        depth: 0,
        coordKey,
      });
    }
  });
  persist();

  // N8: trace the routing decision.
  writeDecision({
    workspaceId: trustedWorkspaceId,
    workstreamId: planWorkstreamId,
    coordKey,
    decisionKind: 'route',
    rationale:
      `Auto-Connect triggered Connector-Onboarding via SOP '${sopId}' ` +
      `for provider '${provider}' (${nodes.length} nodes). ` +
      `Engine: text-only, codex excluded. workspaceId='${trustedWorkspaceId}'.`,
    actor: 'agent',
  });

  // ── 4. Emit the status card with a workstream reference ─────────────────
  // Card first — executePlan is fire-and-forget so the user sees progress
  // immediately, even if execution is delayed.
  await emitOrUpdateCard({
    coords: {
      workspaceId: trustedWorkspaceId,
      workstreamId: connectorCardWorkstreamId(provider),
      surfaceKind: 'onboarding-progress',
    },
    content: `<surface:onboarding-progress>${JSON.stringify({
      provider,
      workstreamId: planWorkstreamId,
      planId,
      sopId,
      sopName: sop.name,
      stepCount: nodes.length,
      goalPrompt,
      status: 'dispatched',
    })}</surface:onboarding-progress>`,
    actor: 'system',
  });

  // ── 5. executePlan (text-only, non-destructive) ─────────────────────────
  // Fire-and-forget: error must NOT propagate to maybeAutoConnect caller.
  // N11: executePlan manages the ResourcePool + TPM-budget internally.
  // PHASE2_MCP_REALINVOKE: mcpTools not forwarded here (Phase-1 only).
  executePlan({
    workstreamId: planWorkstreamId,
    workspaceId: trustedWorkspaceId,
    planId,
    coordKey,
  }).catch((execErr) => {
    console.warn(
      `[auto-connect] triggerOnboardingSop executePlan failed ` +
        `(provider=${provider}, workstreamId=${planWorkstreamId}): `,
      execErr,
    );
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// maybeAutoConnect — main function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Hybrid auto-connect in the Next process.
 *
 * Must run in the Next process (:4200) — broadcast is an in-process EventEmitter.
 * Codex excluded (B1 security fix).
 *
 * Error handling: the caller (stream/route.ts) invokes this function via
 * `void maybeAutoConnect(...).catch(console.warn)` — every exception lands
 * in the warn log, never in the chat stream.
 *
 * @param prompt  - Raw chat prompt.
 * @param ctx     - workspaceId + userId (required), optional signal.
 * @returns       AutoConnectResult — the caller ignores this value.
 */
export async function maybeAutoConnect(
  prompt: string,
  ctx: AutoConnectCtx,
): Promise<AutoConnectResult> {
  const { workspaceId, userId } = ctx;

  // 1. Deterministic gate (N6, no LLM, no async, no I/O except a DB read).
  const detection = detectConnector(prompt, {
    workspaceId,
    hasCredential: buildHasCredential(workspaceId),
  });

  // missing='no-connector': no connector reference → no-op.
  if (detection.missing === 'no-connector' || detection.provider === null) {
    return { acted: false, reason: 'no-connector-detected' };
  }

  const provider = detection.provider;

  // 2. missing='profile': profile missing → kick off onboarding + status card.
  if (detection.missing === 'profile') {
    await triggerOnboardingSop({ provider, workspaceId, userId });
    return { acted: true, action: 'onboarding', provider };
  }

  // 3. missing='credential': credential missing → emit a credential-request card.
  //    SECURITY: NO secret field in the payload. Only provider, scopeKind, workspaceId, why.
  if (detection.missing === 'credential') {
    // Derive the auth profile: API key vs OAuth vs engine-backed (no secret).
    const authProfile = deriveProviderAuthProfile(provider);

    const cardPayload = {
      provider,
      scopeKind: 'workspace' as const,
      workspaceId,
      // `why` is generated from the rationale — no secret, no payload.
      why: buildWhyText(provider, detection.neededCapabilities),
      // 2026-05-30: auth profile for the mobile credential/OAuth surface.
      // authKind controls whether an API-key input or an OAuth-start button is rendered.
      authKind: authProfile.authKind,
      engineBacked: authProfile.engineBacked,
      docsUrl: authProfile.docsUrl,
      signupUrl: authProfile.signupUrl,
      credentialFieldHint: authProfile.credentialFieldHint,
      // First required capability as context (no secret).
      capability: detection.neededCapabilities[0] ?? null,
    };

    // SECURITY CHECK: assertNoSecret ensures that no secret field has accidentally
    // slipped into the card payload (defensive, should structurally never happen).
    assertNoSecretInPayload(cardPayload);

    await emitOrUpdateCard({
      coords: {
        workspaceId,
        workstreamId: connectorCardWorkstreamId(provider),
        surfaceKind: 'credential-request',
      },
      content: `<surface:credential-request>${JSON.stringify(cardPayload)}</surface:credential-request>`,
      actor: 'system',
    });

    return { acted: true, action: 'credential-request', provider };
  }

  // 4. missing='none': profile + credential present → emit a preview card.
  //    previewCall returns a masked credential + payload keys (no secret value).
  if (detection.missing === 'none') {
    // Use the first detected capability (deterministic, N6).
    const capability = detection.neededCapabilities[0] ?? 'default';

    // previewCall: S5 — no network call, writes an N8 audit row for phase='preview'.
    // Does not throw — errors in previewCall must be caught here.
    let preview;
    try {
      preview = previewCall({
        provider,
        capability,
        payload: buildInferredPayload(detection.neededCapabilities),
        workspaceId,
        userId,
        requiredCaps: detection.neededCapabilities.slice(0, 3),
      });
    } catch (previewErr) {
      // previewCall must not kill the auto-connect flow (best-effort).
      console.warn('[auto-connect] previewCall fehlgeschlagen (non-fatal):', previewErr);
      return { acted: false, reason: 'preview-error' };
    }

    // Assemble the connector-call-preview card.
    // SECURITY: no secret value — only the masked credentialPreview from previewCall.
    const previewCardPayload = buildPreviewCardPayload(preview, provider, capability);

    // SECURITY CHECK: ensure no secret is in the card payload.
    assertNoSecretInPayload(previewCardPayload as unknown as Record<string, unknown>);

    await emitOrUpdateCard({
      coords: {
        workspaceId,
        workstreamId: connectorCardWorkstreamId(provider),
        surfaceKind: 'connector-call-preview',
      },
      content: `<surface:connector-call-preview>${JSON.stringify(previewCardPayload)}</surface:connector-call-preview>`,
      actor: 'system',
    });

    // B2 (2026-05-25): answer_required push for connector-call-preview.
    // Best-effort / non-fatal — visibility gate in the helper body.
    // No secret: preview contains only the provider name + capability label.
    emitAnswerRequired({
      workspaceId,
      entityId: connectorCardWorkstreamId(provider),
      kind: 'connector-preview',
      preview: `Connector '${provider}' wartet auf Freigabe (${capability})`,
      url: `/?workspace=${encodeURIComponent(workspaceId)}`,
    });

    return { acted: true, action: 'preview', provider };
  }

  // Exhaustive: missing value not handled (defensive fallback).
  return { acted: false, reason: `unhandled-missing-${String(detection.missing)}` };
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal builder helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds a short human-readable „why" text for the credential-request card.
 * No LLM, deterministic, no secret.
 */
/**
 * Auth profile of a provider for the credential-request surface (2026-05-30).
 *
 * Derives from the connector catalog (`auth_kind`) + the onboarding SOP WHETHER
 * the provider needs an API key or an OAuth flow, plus owner-relevant
 * accompanying info (docs/signup link, field hint, engineBacked).
 *
 * authKind mapping (closed enum CONNECTOR_AUTH_KINDS):
 *   'oauth'  → OAuth flow (start-auth button).
 *   'none'   → engine-backed (no credential needed — e.g. imagegen2).
 *   else     → 'apikey' (api_key | pat | custom → API-key input).
 *
 * No secret, deterministic (N6), pure DB read. Fail-open to 'apikey'
 * (the safe default: API-key input instead of a non-wired OAuth).
 */
type DerivedAuthKind = 'apikey' | 'oauth' | 'none';

interface ProviderAuthProfile {
  authKind: DerivedAuthKind;
  engineBacked: boolean;
  docsUrl: string | null;
  signupUrl: string | null;
  credentialFieldHint: string | null;
}

function deriveProviderAuthProfile(provider: string): ProviderAuthProfile {
  let catalogAuthKind: string | null = null;
  let docsUrl: string | null = null;
  try {
    const profile = getConnectorProfile(provider);
    if (profile) {
      catalogAuthKind = (profile as { authKind?: string | null }).authKind ?? null;
      docsUrl = (profile as { docsUrl?: string | null }).docsUrl ?? null;
    }
  } catch {
    // Catalog unreachable → default below.
  }

  const sop = getOnboardingSop(provider);

  // engineBacked: the SOP marker takes precedence; otherwise auth_kind='none'.
  const engineBacked = sop?.engineBacked === true || catalogAuthKind === 'none';

  let authKind: DerivedAuthKind;
  if (engineBacked) {
    authKind = 'none';
  } else if (catalogAuthKind === 'oauth') {
    authKind = 'oauth';
  } else {
    // api_key | pat | custom | unknown → API-key input (safer default).
    authKind = 'apikey';
  }

  return {
    authKind,
    engineBacked,
    docsUrl,
    signupUrl: sop?.accountSignupUrl ?? null,
    credentialFieldHint: sop?.credentialFieldHint ?? null,
  };
}

function buildWhyText(provider: string, capabilities: string[]): string {
  if (capabilities.length === 0) {
    return `'${provider}' wird für diese Anfrage benötigt.`;
  }
  const capList = capabilities.slice(0, 3).join(', ');
  return `'${provider}' wird für ${capList} benötigt.`;
}

/**
 * Builds a minimal inferred payload from the capability names.
 * Keys only, no values — serves the payload-summary preview.
 * No secret, no PII.
 */
function buildInferredPayload(capabilities: string[]): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const cap of capabilities.slice(0, 5)) {
    // Capability names as keys → symbolic markers (no real values).
    payload[cap] = `<${cap}>`;
  }
  return payload;
}

/**
 * Builds the connector-call-preview card payload from the CallPreview object.
 * SECURITY: credentialPreview is already masked (from previewCall) — no secret.
 */
function buildPreviewCardPayload(
  preview: import('@/lib/connectors/invoke').CallPreview,
  provider: string,
  capability: string,
): ConnectorCallPreviewPayload {
  return {
    provider,
    capability,
    callId: preview.callId,
    mcpTool: preview.mcpTool,
    baseUrl: preview.baseUrl,
    payloadSummary: preview.payloadSummary,
    credentialScope: preview.credentialScope,
    // credentialPreview: masked value from maskedPreview() — NEVER the plaintext.
    credentialPreview: preview.credentialPreview,
    authKind: preview.authKind,
    payloadHash: preview.payloadHash,
    currentTrust: preview.currentTrust,
    // dryRun: true when LAZYOS_CONNECTOR_LIVE is not active — clearly labeled.
    dryRun: !preview.liveEnabled,
    liveEnabled: preview.liveEnabled,
  };
}

/**
 * SECURITY: throws if any known secret field is in the payload object.
 * Defensive — structurally no secret should ever end up in a card payload,
 * but this guard makes that explicitly checkable at runtime.
 */
function assertNoSecretInPayload(payload: Record<string, unknown>): void {
  const FORBIDDEN_IN_CARD = new Set([
    'secret', 'token', 'api_key', 'apiKey', 'password',
    'private_key', 'privateKey', 'access_token', 'accessToken',
    'refresh_token', 'refreshToken', 'client_secret', 'clientSecret',
  ]);
  for (const key of Object.keys(payload)) {
    if (FORBIDDEN_IN_CARD.has(key)) {
      throw new Error(
        `[auto-connect] SECURITY: forbidden key '${key}' in card payload — secret must never appear in chat/SSE.`,
      );
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ConnectorCallPreviewPayload — surface-card payload type (no secret)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Payload for the connector-call-preview surface.
 * SECURITY: contains NO secret field. credentialPreview is masked.
 */
export interface ConnectorCallPreviewPayload {
  provider: string;
  capability: string;
  callId: string;
  mcpTool: string | null;
  baseUrl: string | null;
  /** Payload summary: keys + types, NO values. */
  payloadSummary: Record<string, string>;
  /** Scope identifier, no secret. e.g. 'workspace:ws-123'. */
  credentialScope: string;
  /** Masked credential preview value. NEVER the plaintext. null if no credential. */
  credentialPreview: string | null;
  authKind: string;
  payloadHash: string;
  currentTrust: 'ask' | 'auto';
  /** true → LAZYOS_CONNECTOR_LIVE is off → a real call would be a dry run. */
  dryRun: boolean;
  liveEnabled: boolean;
}
