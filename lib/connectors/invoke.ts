/**
 * Connector invocation executor (ACL-5-D — 2026-05-24).
 *
 * The only place in the system where a real external connector call happens.
 * Security-critical: every missing precondition → fail-closed (no network).
 *
 * ─── Public API ────────────────────────────────────────────────────────────────
 *   previewCall(args)  → CallPreview   (S5: preview without network, masked)
 *   executeCall(args)  → CallResult    (gated: all preconditions or blocked)
 *
 * ─── Precondition chain (executeCall, fail-closed, in order) ───────────────────
 *   PRE-1  Connector profile exists (getConnectorProfile) → 'no-profile'
 *   PRE-2  Coverage OK (validateCoverage requiredCaps vs. profile) → 'coverage-fail'
 *   PRE-3  S4 hardening (buildHardenedToolset + assertCallAllowed) → 'not-hardened'
 *   PRE-4  S6 gate: trust='auto' OR a valid approvalToken → 'awaiting-approval'
 *   PRE-5  Master switch LAZYOS_CONNECTOR_LIVE: off → dry run (no network)
 *   PRE-6  Real call (only if LIVE on + all PRE-1..4 ok):
 *            resolveApiCredential ONLY NOW (never materialized earlier)
 *            → network call → recordCallAudit('invoke', live:1)
 *
 * ─── Secret-leak prevention ───────────────────────────────────────────────────
 *   - resolveApiCredential() is called EXCLUSIVELY in the real-call branch.
 *     The variable `cred` is local to the real-call block and is not returned.
 *   - result + audit + all logs contain ONLY masked/hashed values.
 *   - payloadHash = sha256(canonicalJSON(payload)) — never the payload itself (D3).
 *   - the secret value NEVER flows into CallResult, CallPreview, or audit rows.
 *
 * ─── Audit (N8) ───────────────────────────────────────────────────────────────
 *   previewCall    → recordCallAudit('preview', live:false)
 *   executeCall:
 *     PRE error    → recordCallAudit('deny', live:false, reason)
 *     Dry run      → recordCallAudit('dry-run', live:false)
 *     Real call    → recordCallAudit('invoke', live:true, payloadHash, resultSummary)
 *
 * ─── Constraints ──────────────────────────────────────────────────────────────
 *   N2/K1:  K1-RAG-Deny is hard (via assertCallAllowed from invoke-policy.ts).
 *   N6:     deterministic gates before the call.
 *   N8:     audit every phase.
 *   N10:    content_hash on every audit row (via recordCallAudit).
 *   ENV:    LAZYOS_CONNECTOR_LIVE — default off = never a real call.
 *
 * ─── What does NOT happen here ────────────────────────────────────────────────
 *   No spawn of code agents. No Bash. No file system. No LLM call.
 *   The call is a targeted API request, S4-hardened.
 */

import { createHash } from "node:crypto";

import {
  assertCallAllowed,
  buildHardenedToolset,
  type ConnectorProfile,
} from "@/lib/connectors/invoke-policy";
import {
  computePayloadHash,
  getTrust,
  recordCallAudit,
} from "@/lib/connectors/trust";
import {
  getConnectorProfile,
  listCapabilities,
} from "@/lib/connectors/catalog";
import { validateCoverage } from "@/lib/connectors/coverage";
import {
  credentialExists,
  resolveApiCredential,
} from "@/lib/credentials/vault";
import type { ConnectorScopeKind } from "@/db/schema/connector_calls";

// ─────────────────────────────────────────────────────────────────────────────
// Public Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Input context for previewCall and executeCall.
 * Contains NO secrets — credentials are resolved internally via resolveApiCredential,
 * exclusively in the real-call branch.
 */
export interface InvokeArgs {
  /** Provider slug from connector_catalog, e.g. 'heygen'. */
  provider: string;
  /** Capability name, e.g. 'render_video'. */
  capability: string;
  /**
   * Capability requirements for the coverage check.
   * Typically [capability] — can be several if the call needs several.
   */
  requiredCaps?: readonly string[];
  /**
   * Call payload (keys + values). Secrets must NOT be contained here —
   * the vault fills in the auth header itself on the real call.
   */
  payload?: Record<string, unknown>;
  /** Workspace ID for credential resolution and audit scoping. */
  workspaceId: string;
  /** Scope kind for the trust gate and audit. Default: 'workspace'. */
  scopeKind?: ConnectorScopeKind;
  /** User ID for audit rows and the auth gate. */
  userId: string;
  /**
   * S6 approval token: represents that the owner has approved this call.
   * The caller (ACL5-E) sets this value after the user has confirmed the
   * preview card. Alternatively: trust='auto' via getTrust() is also sufficient.
   */
  approved?: boolean;
  /** Opaque call ID — for idempotency and audit correlation. Generated if not set. */
  callId?: string;
}

/**
 * S5 preview — preview WITHOUT network.
 * Shows the owner what would be called, which credential is used,
 * and the payload fingerprint. No secret value.
 */
export interface CallPreview {
  /** Always true on previewCall (no blocking — preview is informational). */
  ok: true;
  provider: string;
  capability: string;
  /**
   * Which MCP tool would be called.
   * null if the capability has no MCP tool (REST-only).
   */
  mcpTool: string | null;
  /**
   * Base URL of the provider from the connector profile.
   * null if not known.
   */
  baseUrl: string | null;
  /**
   * Payload summary: keys + types, NO values.
   * e.g. { "template_id": "string", "ratio": "number" }
   */
  payloadSummary: Record<string, string>;
  /**
   * Which credential scope would be used.
   * e.g. 'workspace:ws-123' or 'org:org-456 (inherit)'.
   * No secret value, only the scope identifier.
   */
  credentialScope: string;
  /**
   * Decrypt-FREE credential hint for the owner.
   *
   * ACL-5-D hardening (Security-Critic Finding 3): previewCall no longer
   * decrypts the secret — the preview runs on every keyword-matching
   * chat message, long before the owner clicks „Freigeben". A decrypt per
   * preview would be unnecessary exposure. This value is therefore a decrypt-free
   * existence label, NOT a maskedPreview value derived from the plaintext:
   *   '•••• (vorhanden)'   if a credential exists in the scope,
   *   null                 if none exists.
   * The first real decrypt happens exclusively in executeCall (PRE-6).
   * NEVER the plaintext.
   */
  credentialPreview: string | null;
  /**
   * Auth kind of the connector ('api_key' | 'oauth' | 'pat' | 'none' | 'custom').
   */
  authKind: string;
  /**
   * sha256 hash of the payload (for idempotency). NOT the payload itself.
   */
  payloadHash: string;
  /** Current trust level for this provider+scope. */
  currentTrust: "ask" | "auto";
  /** Whether LAZYOS_CONNECTOR_LIVE is active (would a real call take place?). */
  liveEnabled: boolean;
  /** Correlation ID of this preview instance. */
  callId: string;
}

/**
 * Result of executeCall.
 *
 * ok: false → call was blocked (no network).
 * ok: true, dryRun: true → dry run (LAZYOS_CONNECTOR_LIVE off).
 * ok: true, dryRun: false → real call performed.
 *
 * NEVER a secret or raw response body here.
 */
export type CallResult =
  | BlockedCallResult
  | DryRunCallResult
  | LiveCallResult;

export interface BlockedCallResult {
  ok: false;
  /**
   * Block reason (machine-readable for ACL5-E):
   *   'no-profile'          — connector profile not found.
   *   'coverage-fail'       — coverage check failed.
   *   'not-hardened'        — capability not in the S4-hardened toolset.
   *   'awaiting-approval'   — trust='ask' + no valid approvalToken.
   *   'credential-missing'  — credential not in the vault.
   *   'call-error'          — real call failed (network/HTTP).
   */
  blocked: BlockedReason;
  detail?: string;
  callId: string;
}

export interface DryRunCallResult {
  ok: true;
  dryRun: true;
  provider: string;
  capability: string;
  /** Clearly labeled simulated result. No network call. */
  simulatedResult: string;
  payloadHash: string;
  callId: string;
}

export interface LiveCallResult {
  ok: true;
  dryRun: false;
  provider: string;
  capability: string;
  /** HTTP status code of the real call. */
  status: number;
  /**
   * Short summary of the result.
   * NEVER a raw response body or secret value.
   * e.g. 'status=200 duration=342ms size=1.2kb'.
   */
  resultSummary: string;
  payloadHash: string;
  callId: string;
}

export type BlockedReason =
  | "no-profile"
  | "coverage-fail"
  | "not-hardened"
  | "awaiting-approval"
  | "credential-missing"
  | "call-error";

// ─────────────────────────────────────────────────────────────────────────────
// Internal helper functions
// ─────────────────────────────────────────────────────────────────────────────

/** Reads and normalizes the LAZYOS_CONNECTOR_LIVE master switch. */
function isLiveEnabled(): boolean {
  const val = (process.env.LAZYOS_CONNECTOR_LIVE ?? "").trim().toLowerCase();
  return val === "on" || val === "1" || val === "true";
}

/** Generates a correlation ID when none was passed. */
function makeCallId(): string {
  return `cinvoke-${createHash("sha256")
    .update(`${Date.now()}-${Math.random()}`)
    .digest("hex")
    .slice(0, 16)}`;
}

/**
 * Builds a payload summary (keys + types, NO values).
 * This prevents secrets from accidentally ending up in the preview.
 */
function buildPayloadSummary(payload?: Record<string, unknown>): Record<string, string> {
  if (!payload) return {};
  const summary: Record<string, string> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value === null) {
      summary[key] = "null";
    } else if (Array.isArray(value)) {
      summary[key] = `array[${value.length}]`;
    } else {
      summary[key] = typeof value;
    }
  }
  return summary;
}

/**
 * Builds the ConnectorProfile object for S4 buildHardenedToolset from catalog data.
 * Only the fields relevant for S4 (provider + capabilities with mcpToolName).
 */
function buildConnectorProfileForS4(provider: string): ConnectorProfile {
  const caps = listCapabilities(provider);
  return {
    provider,
    capabilities: caps.map((c) => ({
      name: c.name,
      mcpToolName: c.mcpToolName ?? null,
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// previewCall — S5 preview without network
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds a preview for a connector call WITHOUT network.
 *
 * S5: shows the owner what would be called, which credential scope,
 * the masked credential hint and payload fingerprint. Writes an
 * N8 audit row with phase='preview'.
 *
 * The preview is ALWAYS ok:true — it can never "fail" in the
 * blocking sense. A missing profile or credential is returned as information
 * (credentialPreview: null, mcpTool: null), not as an error.
 * The owner thus gets the full picture before having to approve.
 *
 * Secret-leak prevention (ACL-5-D hardening, Security-Critic Finding 3):
 *   - previewCall no longer decrypts the secret. It does NOT call
 *     resolveApiCredential() (= decrypt). Instead it determines, decrypt-FREE
 *     via credentialExists(), only the existence + the scope.
 *     Rationale: maybeAutoConnect calls previewCall on every keyword-matching
 *     chat message (missing='none') — a decrypt per message, long before
 *     the owner clicks „Freigeben", would be unnecessary plaintext exposure.
 *   - credentialPreview is a decrypt-free existence label ('•••• (vorhanden)'
 *     or null) — NEVER a maskedPreview value derived from the plaintext.
 *   - the first real decrypt happens exclusively in executeCall (PRE-6).
 *
 * @param args  InvokeArgs (payload, workspaceId, userId, provider, capability).
 * @returns     CallPreview (always ok:true).
 */
export function previewCall(args: InvokeArgs): CallPreview {
  const callId = args.callId ?? makeCallId();
  const scopeKind = args.scopeKind ?? "workspace";
  const requiredCaps = args.requiredCaps ?? [args.capability];
  const payloadHash = computePayloadHash(args.payload ?? {});

  // Read the profile (null → empty defaults, preview is informational not blocking).
  const profile = getConnectorProfile(args.provider);
  const capabilities = args.provider ? listCapabilities(args.provider) : [];

  // Find the MCP tool for this capability.
  const capRow = capabilities.find((c) => c.name === args.capability);
  const mcpTool = capRow?.mcpToolName ?? null;

  // Credential existence + scope — DECRYPT-FREE (no resolveApiCredential).
  // credentialExists() only does an existence lookup + scope derivation,
  // NEVER calls decryptCredential(). No plaintext secret is touched.
  let credentialScope = `workspace:${args.workspaceId}`;
  let credentialPreview: string | null = null;
  try {
    const existence = credentialExists(args.workspaceId, args.provider);
    credentialScope = existence.scopeLabel;
    if (existence.exists) {
      // Decrypt-free label — NO maskedPreview(secret), no decrypt.
      // '•' kept for UI consistency (the card shows „Credential vorhanden").
      credentialPreview = "•••• (vorhanden)";
    }
  } catch {
    // Existence lookup failed (DB error) — preview shows „fehlt".
    credentialPreview = null;
  }

  // Current trust level.
  const currentTrust = getTrust(scopeKind, args.workspaceId, args.provider);

  // N8 audit for the preview phase.
  recordCallAudit({
    scopeKind,
    scopeId: args.workspaceId,
    provider: args.provider,
    capability: args.capability,
    userId: args.userId,
    phase: "preview",
    live: false,
    payloadHash,
    resultSummary: `preview: ${args.provider}.${args.capability} caps=[${requiredCaps.join(",")}]`,
    success: true,
  });

  return {
    ok: true,
    provider: args.provider,
    capability: args.capability,
    mcpTool,
    baseUrl: profile?.baseUrl ?? null,
    payloadSummary: buildPayloadSummary(args.payload),
    credentialScope,
    credentialPreview,
    authKind: profile?.authKind ?? "api_key",
    payloadHash,
    currentTrust,
    liveEnabled: isLiveEnabled(),
    callId,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// executeCall — Gated Invocation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Executes a connector call or blocks it fail-closed.
 *
 * ─── Precondition chain (order = priority, first fail wins) ───────────────────
 *
 *   PRE-1  getConnectorProfile(provider) !== null
 *          → blocked: 'no-profile'
 *          Rationale: without a profile there is no known API convention,
 *          no base_url, no auth_kind — a call would be uncontrolled.
 *
 *   PRE-2  validateCoverage(requiredCaps, profile).ok === true
 *          → blocked: 'coverage-fail'
 *          Rationale (N6): deterministic coverage check before any LLM or
 *          network. A missing capability → the connector cannot fulfill the
 *          task; fail-closed prevents partial execution.
 *
 *   PRE-3  assertCallAllowed(provider, capability, buildHardenedToolset(...))
 *          → blocked: 'not-hardened'
 *          Rationale (S4, K1): the capability must be in the provider's S4-hardened
 *          MCP toolset. K1 tools (RAG, Bash, File) are structurally
 *          excluded here — even if they are erroneously in the profile.
 *
 *   PRE-4  getTrust(scopeKind, workspaceId, provider) === 'auto'
 *          OR args.approved === true
 *          → blocked: 'awaiting-approval'
 *          Rationale (S6): every real call needs owner consent. Default
 *          'ask' blocks. The caller (ACL5-E) sets approved:true after the
 *          owner has confirmed the preview card.
 *
 *   PRE-5  LAZYOS_CONNECTOR_LIVE === 'on'|'1'|'true'
 *          → if NOT: dry run (dryRun:true), no network.
 *          Rationale: master switch. Default is off = never a real call.
 *          The owner flips this value after review.
 *
 *   PRE-6  resolveApiCredential(workspaceId, userId, provider) !== null
 *          → blocked: 'credential-missing'
 *          Rationale: called ONLY NOW — after all other gates.
 *          The secret is materialized only when a call actually happens.
 *          The variable stays local in the call block, is not returned.
 *
 * ─── Real call ────────────────────────────────────────────────────────────────
 *   When LIVE on + all PRE-1..4 ok + PRE-6 ok:
 *   Generic fetch against profile.baseUrl + capability endpoint.
 *   The auth header is built from cred.kind + cred.secret (provider-agnostic).
 *   cred.secret does NOT appear in result, result_summary, logs or audit.
 *   After the call: recordCallAudit('invoke', live:1, payloadHash, resultSummary).
 *
 * @param args  InvokeArgs.
 * @returns     CallResult (BlockedCallResult | DryRunCallResult | LiveCallResult).
 */
export async function executeCall(args: InvokeArgs): Promise<CallResult> {
  const callId = args.callId ?? makeCallId();
  const scopeKind = args.scopeKind ?? "workspace";
  const requiredCaps = args.requiredCaps ?? [args.capability];
  const payloadHash = computePayloadHash(args.payload ?? {});

  // ─── Shared helper: deny with an audit row and return blocked ─────────────
  const deny = (blocked: BlockedReason, detail: string): BlockedCallResult => {
    recordCallAudit({
      scopeKind,
      scopeId: args.workspaceId,
      provider: args.provider,
      capability: args.capability,
      userId: args.userId,
      phase: "deny",
      live: false,
      payloadHash,
      resultSummary: `blocked:${blocked} — ${detail.slice(0, 120)}`,
      success: false,
      reason: `${blocked}: ${detail}`,
    });
    return { ok: false, blocked, detail, callId };
  };

  // ─── PRE-1: connector profile ─────────────────────────────────────────────
  const profile = getConnectorProfile(args.provider);
  if (!profile) {
    return deny(
      "no-profile",
      `Provider '${args.provider}' nicht im Connector-Katalog. ` +
        `Connector-Onboarding (ACL-4) muss zuerst abgeschlossen werden.`,
    );
  }

  // ─── PRE-2: coverage check (N6) ──────────────────────────────────────────
  const caps = listCapabilities(args.provider);
  const coverageProfile = {
    provider: args.provider,
    apiVersion: profile.apiVersion ?? null,
    capabilities: caps.map((c) => ({ name: c.name })),
  };
  const coverage = validateCoverage(requiredCaps, coverageProfile);
  if (!coverage.ok) {
    return deny(
      "coverage-fail",
      `Coverage-Prüfung fehlgeschlagen: fehlende Capabilities [${coverage.missing.join(", ")}] ` +
        `im Profil von '${args.provider}'. Profil muss zuerst aktualisiert werden.`,
    );
  }

  // ─── PRE-3: S4 tool hardening (K1-Deny, provider namespace) ─────────────
  const s4Profile = buildConnectorProfileForS4(args.provider);
  const hardened = buildHardenedToolset(args.provider, s4Profile, requiredCaps);
  try {
    assertCallAllowed(args.provider, args.capability, hardened);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return deny(
      "not-hardened",
      `S4-Gate blockiert: ${reason}`,
    );
  }

  // ─── PRE-4: S6 gate — trust 'auto' OR approval token ─────────────────────
  const trust = getTrust(scopeKind, args.workspaceId, args.provider);
  const hasApproval = args.approved === true;
  if (trust !== "auto" && !hasApproval) {
    return deny(
      "awaiting-approval",
      `Trust-Level '${trust}' für '${args.provider}' erfordert explizite Owner-Freigabe. ` +
        `Entweder trust='auto' per setTrust() setzen oder approved:true vom Owner übergeben (S6).`,
    );
  }

  // ─── PRE-5: master switch ─────────────────────────────────────────────────
  if (!isLiveEnabled()) {
    // Dry run: no network, clearly labeled.
    recordCallAudit({
      scopeKind,
      scopeId: args.workspaceId,
      provider: args.provider,
      capability: args.capability,
      userId: args.userId,
      phase: "dry-run",
      live: false,
      payloadHash,
      resultSummary: `dry-run: LAZYOS_CONNECTOR_LIVE not set — simulated ${args.provider}.${args.capability}`,
      success: true,
    });
    return {
      ok: true,
      dryRun: true,
      provider: args.provider,
      capability: args.capability,
      simulatedResult:
        `[DRY-RUN] LAZYOS_CONNECTOR_LIVE ist nicht aktiv. ` +
        `Call würde aufrufen: ${args.provider}.${args.capability} ` +
        `via ${hardened.allowedMcpTools[0] ?? "(kein MCP-Tool)"} ` +
        `mit Payload-Hash ${payloadHash.slice(0, 12)}…`,
      payloadHash,
      callId,
    };
  }

  // ─── PRE-6: credential resolution (ONLY NOW) ─────────────────────────────
  // Important: not called earlier. The variable `cred` stays local.
  const cred = resolveApiCredential(args.workspaceId, args.userId, args.provider);
  if (!cred) {
    return deny(
      "credential-missing",
      `Kein Credential für Provider '${args.provider}' in Workspace '${args.workspaceId}' gefunden. ` +
        `Credential via ACL-5-B erfassen.`,
    );
  }

  // ─── Real call ──────────────────────────────────────────────────────────
  // cred.secret is used EXCLUSIVELY for the auth header.
  // It does NOT appear in result, result_summary, logs or audit.
  const callStart = Date.now();
  let status = 0;
  let resultSummary = "";
  let callOk = false;

  try {
    // Auth header built provider-agnostic from auth_kind.
    const authHeader = buildAuthHeader(profile.authKind, cred.secret);

    // Endpoint: base_url + capability path (best-effort from the mcpTool tail).
    const capRow = caps.find((c) => c.name === args.capability);
    const endpointPath = capRow
      ? inferEndpointPath(args.capability, capRow.mcpToolName)
      : `/${args.capability}`;
    const url = `${(profile.baseUrl ?? "").replace(/\/$/, "")}${endpointPath}`;

    const response = await fetch(url, {
      method: args.payload ? "POST" : "GET",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...authHeader,
      },
      body: args.payload ? JSON.stringify(args.payload) : undefined,
    });

    status = response.status;
    const duration = Date.now() - callStart;
    // resultSummary NEVER contains the response body (N8, no leak).
    // Only status code, duration and size (from Content-Length).
    const contentLength = response.headers.get("content-length");
    resultSummary =
      `status=${status} duration=${duration}ms` +
      (contentLength ? ` size=${formatSize(parseInt(contentLength, 10))}` : "");
    callOk = response.ok;
  } catch (err) {
    const duration = Date.now() - callStart;
    // Error text: no cred.secret, no payload (N8).
    // ACL-5-D hardening (Finding 2): the concrete resolved secret is removed
    // directly from the error text via string-replace (strongest defense),
    // in addition to the defensive {12,} heuristic. cred.secret can e.g. land in a
    // TypeError message when fetch builds a URL with an embedded credential.
    resultSummary = `call-error after ${duration}ms: ${maskSensitiveFromError(
      err,
      cred.secret,
    )}`;
    status = 0;
    callOk = false;
  }

  // N8 audit row for invoke (live=1).
  // payloadHash instead of payload (D3), resultSummary without secret (D5).
  recordCallAudit({
    scopeKind,
    scopeId: args.workspaceId,
    provider: args.provider,
    capability: args.capability,
    userId: args.userId,
    phase: "invoke",
    live: true,
    payloadHash,
    resultSummary,
    success: callOk,
    reason: callOk ? undefined : resultSummary,
  });

  if (!callOk) {
    return {
      ok: false,
      blocked: "call-error",
      detail: resultSummary,
      callId,
    };
  }

  return {
    ok: true,
    dryRun: false,
    provider: args.provider,
    capability: args.capability,
    status,
    resultSummary,
    payloadHash,
    callId,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal call helpers (not called from outside)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds the auth header from auth_kind + secret.
 * The secret flows ONLY into the HTTP header (not into logs, not into return values).
 *
 * Supported auth_kinds:
 *   api_key → 'X-API-Key: <secret>'
 *   pat     → 'Authorization: Bearer <secret>'
 *   oauth   → 'Authorization: Bearer <secret>'
 *   custom  → 'Authorization: Bearer <secret>' (best-effort)
 *   none    → {} (no auth header)
 */
function buildAuthHeader(
  authKind: string,
  secret: string,
): Record<string, string> {
  switch (authKind) {
    case "api_key":
      return { "X-API-Key": secret };
    case "pat":
    case "oauth":
    case "custom":
      return { Authorization: `Bearer ${secret}` };
    case "none":
      return {};
    default:
      // Unknown auth_kind: Bearer to be safe (at least it tries).
      return { Authorization: `Bearer ${secret}` };
  }
}

/**
 * Derives an endpoint path from the capability name and MCP tool name.
 * Best-effort: none of these values contains a secret.
 */
function inferEndpointPath(capabilityName: string, mcpToolName: string | null): string {
  // If mcpToolName has 'mcp__<provider>__<tool>' format, use the tail as the path.
  if (mcpToolName) {
    const parts = mcpToolName.split("__");
    if (parts.length >= 3) {
      const tail = parts.slice(2).join("/");
      return `/${tail.replace(/_/g, "-")}`;
    }
  }
  // Fallback: capability name as the path (kebab-case).
  return `/${capabilityName.replace(/_/g, "-")}`;
}

/**
 * Formats a byte size human-readable.
 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}b`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}kb`;
  return `${(bytes / 1024 / 1024).toFixed(1)}mb`;
}

/**
 * Masks potentially sensitive information out of error texts.
 * Prevents API keys or URLs with embedded credentials from ending up in logs/audit.
 *
 * ACL-5-D hardening (Finding 2), two defense layers:
 *   1. EXACT replace of the concrete resolved secret (strongest guarantee): the
 *      current cred.secret is literally replaced with '••••', if it
 *      appears in the error text (e.g. via an embedded-credential URL). This rules out
 *      a leak of the active secret, independent of the heuristic.
 *   2. Defensive heuristic: every contiguous {12,} token of
 *      [A-Za-z0-9_-] is masked (threshold lowered from 32 to 12) — also catches
 *      shorter keys/tokens that are NOT the active cred.secret.
 *
 * @param err     The caught error.
 * @param secret  The current resolved secret (for layer 1). Optional —
 *                if empty/undefined only the heuristic is applied.
 */
function maskSensitiveFromError(err: unknown, secret?: string): string {
  let msg = err instanceof Error ? err.message : String(err);

  // Layer 1: exact secret replace (only if the secret is non-trivial).
  if (secret && secret.length >= 4) {
    // Global, escaped replace of the plaintext secret with '••••'.
    const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    msg = msg.replace(new RegExp(escaped, "g"), "••••");
  }

  // Layer 2: defensive heuristic — mask long hex/base64-like strings.
  // Threshold lowered to {12,} (was {32,}).
  return msg.replace(/[A-Za-z0-9_-]{12,}/g, "[masked]").slice(0, 200);
}
