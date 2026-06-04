/**
 * Connector Invocation-Executor (ACL-5-D — 2026-05-24).
 *
 * Der einzige Ort im System, an dem ein echter externer Connector-Call passiert.
 * Sicherheitskritisch: jede fehlende Vorbedingung → fail-closed (kein Netzwerk).
 *
 * ─── Öffentliche API ───────────────────────────────────────────────────────────
 *   previewCall(args)  → CallPreview   (S5: Vorschau ohne Netzwerk, maskiert)
 *   executeCall(args)  → CallResult    (gated: alle Vorbedingungen oder blocked)
 *
 * ─── Vorbedingungs-Kette (executeCall, fail-closed, in Reihenfolge) ────────────
 *   PRE-1  Connector-Profil existiert (getConnectorProfile) → 'no-profile'
 *   PRE-2  Coverage-OK (validateCoverage requiredCaps vs. Profil) → 'coverage-fail'
 *   PRE-3  S4-Hardening (buildHardenedToolset + assertCallAllowed) → 'not-hardened'
 *   PRE-4  S6-Gate: trust='auto' ODER gültiges approvalToken → 'awaiting-approval'
 *   PRE-5  Master-Schalter LAZYOS_CONNECTOR_LIVE: off → Dry-Run (kein Netzwerk)
 *   PRE-6  Echter Call (nur wenn LIVE on + alle PRE-1..4 ok):
 *            resolveApiCredential ERST JETZT (nie früher materialisiert)
 *            → Netzwerk-Call → recordCallAudit('invoke', live:1)
 *
 * ─── Secret-Leak-Prävention ───────────────────────────────────────────────────
 *   - resolveApiCredential() wird AUSSCHLIESSLICH im echten-Call-Zweig aufgerufen.
 *     Die Variable `cred` ist lokal zum echten-Call-Block und wird nicht zurückgegeben.
 *   - result + audit + alle Logs enthalten NUR maskierte/gehashte Werte.
 *   - payloadHash = sha256(canonicalJSON(payload)) — nie der Payload selbst (D3).
 *   - Secret-Wert fließt NIEMALS in CallResult, CallPreview, oder Audit-Rows.
 *
 * ─── Audit (N8) ───────────────────────────────────────────────────────────────
 *   previewCall    → recordCallAudit('preview', live:false)
 *   executeCall:
 *     PRE-Fehler   → recordCallAudit('deny', live:false, reason)
 *     Dry-Run      → recordCallAudit('dry-run', live:false)
 *     Echter Call  → recordCallAudit('invoke', live:true, payloadHash, resultSummary)
 *
 * ─── Constraints ──────────────────────────────────────────────────────────────
 *   N2/K1:  K1-RAG-Deny ist hart (über assertCallAllowed aus invoke-policy.ts).
 *   N6:     Deterministische Gates vor Call.
 *   N8:     Audit jede Phase.
 *   N10:    content_hash auf jeder Audit-Row (via recordCallAudit).
 *   ENV:    LAZYOS_CONNECTOR_LIVE — default off = nie echter Call.
 *
 * ─── Was NICHT hier passiert ──────────────────────────────────────────────────
 *   Kein Spawn von Code-Agenten. Kein Bash. Kein File-System. Kein LLM-Call.
 *   Der Call ist ein gezielter API-Request, S4-hardened.
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
 * Eingabe-Kontext für previewCall und executeCall.
 * Enthält KEINE Secrets — Credentials werden intern via resolveApiCredential
 * aufgelöst, ausschließlich im echten-Call-Zweig.
 */
export interface InvokeArgs {
  /** Provider-Slug aus connector_catalog, z.B. 'heygen'. */
  provider: string;
  /** Capability-Name, z.B. 'render_video'. */
  capability: string;
  /**
   * Capability-Anforderungen für Coverage-Prüfung.
   * Typischerweise [capability] — kann mehrere sein wenn der Call mehrere braucht.
   */
  requiredCaps?: readonly string[];
  /**
   * Call-Payload (Keys + Werte). Secrets dürfen hier NICHT enthalten sein —
   * der Vault füllt den Auth-Header beim echten Call selbst aus.
   */
  payload?: Record<string, unknown>;
  /** Workspace-ID für Credential-Resolution und Audit-Scoping. */
  workspaceId: string;
  /** Scope-Kind für Trust-Gate und Audit. Default: 'workspace'. */
  scopeKind?: ConnectorScopeKind;
  /** User-ID für Audit-Rows und Auth-Gate. */
  userId: string;
  /**
   * S6-Approval-Token: repräsentiert dass der Owner diesen Call freigegeben hat.
   * Der Caller (ACL5-E) setzt diesen Wert nachdem der User die preview-Card
   * bestätigt hat. Alternativ: trust='auto' via getTrust() reicht ebenfalls.
   */
  approved?: boolean;
  /** Opakes Call-ID — für Idempotenz und Audit-Korrelation. Wenn nicht gesetzt: generiert. */
  callId?: string;
}

/**
 * S5 Preview — Vorschau OHNE Netzwerk.
 * Zeigt dem Owner was gecallt werden würde, welches Credential verwendet,
 * und den Payload-Fingerprint. Kein Secret-Wert.
 */
export interface CallPreview {
  /** Immer true bei previewCall (keine Blockierungen — preview ist informativ). */
  ok: true;
  provider: string;
  capability: string;
  /**
   * Welches MCP-Tool würde aufgerufen werden.
   * null wenn die Capability kein MCP-Tool hat (REST-only).
   */
  mcpTool: string | null;
  /**
   * Basis-URL des Providers aus dem Connector-Profil.
   * null wenn nicht bekannt.
   */
  baseUrl: string | null;
  /**
   * Payload-Zusammenfassung: Keys + Typen, KEINE Werte.
   * z.B. { "template_id": "string", "ratio": "number" }
   */
  payloadSummary: Record<string, string>;
  /**
   * Welches Credential-Scope würde verwendet.
   * z.B. 'workspace:ws-123' oder 'org:org-456 (inherit)'.
   * Kein Secret-Wert, nur der Scope-Identifier.
   */
  credentialScope: string;
  /**
   * Decrypt-FREIER Credential-Hinweis für den Owner.
   *
   * ACL-5-D-Härtung (Security-Critic Finding 3): previewCall entschlüsselt das
   * Secret NICHT mehr — die Vorschau läuft bei jeder keyword-matchenden
   * Chat-Nachricht, lange bevor der Owner „Freigeben" klickt. Ein decrypt pro
   * Preview wäre unnötige Exposition. Dieser Wert ist daher ein decrypt-freies
   * Existenz-Label, KEIN aus dem Klartext abgeleiteter maskedPreview-Wert:
   *   '•••• (vorhanden)'   wenn ein Credential im Scope existiert,
   *   null                 wenn keins existiert.
   * Der erste echte Decrypt passiert ausschließlich in executeCall (PRE-6).
   * NIEMALS der Klartext.
   */
  credentialPreview: string | null;
  /**
   * Auth-Kind des Connectors ('api_key' | 'oauth' | 'pat' | 'none' | 'custom').
   */
  authKind: string;
  /**
   * sha256-Hash des Payloads (für Idempotenz). NICHT der Payload selbst.
   */
  payloadHash: string;
  /** Aktueller Trust-Level für diesen Provider+Scope. */
  currentTrust: "ask" | "auto";
  /** Ob LAZYOS_CONNECTOR_LIVE aktiv ist (würde echter Call stattfinden?). */
  liveEnabled: boolean;
  /** Correlations-ID dieser Preview-Instanz. */
  callId: string;
}

/**
 * Ergebnis von executeCall.
 *
 * ok: false → Call wurde blockiert (kein Netzwerk).
 * ok: true, dryRun: true → Dry-Run (LAZYOS_CONNECTOR_LIVE off).
 * ok: true, dryRun: false → Echter Call durchgeführt.
 *
 * NIEMALS ein Secret oder roher Response-Body hier.
 */
export type CallResult =
  | BlockedCallResult
  | DryRunCallResult
  | LiveCallResult;

export interface BlockedCallResult {
  ok: false;
  /**
   * Blockierungs-Grund (maschinenlesbar für ACL5-E):
   *   'no-profile'          — Connector-Profil nicht gefunden.
   *   'coverage-fail'       — Coverage-Prüfung fehlgeschlagen.
   *   'not-hardened'        — Capability nicht im S4-gehärteten Toolset.
   *   'awaiting-approval'   — trust='ask' + kein gültiger approvalToken.
   *   'credential-missing'  — Credential nicht im Vault.
   *   'call-error'          — Echter Call fehlgeschlagen (Netzwerk/HTTP).
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
  /** Klar gelabeltes simuliertes Resultat. Kein Netzwerk-Call. */
  simulatedResult: string;
  payloadHash: string;
  callId: string;
}

export interface LiveCallResult {
  ok: true;
  dryRun: false;
  provider: string;
  capability: string;
  /** HTTP-Statuskode des echten Calls. */
  status: number;
  /**
   * Kurzfassung des Ergebnisses.
   * NIEMALS ein roher Response-Body oder Secret-Wert.
   * z.B. 'status=200 duration=342ms size=1.2kb'.
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
// Interne Hilfsfunktionen
// ─────────────────────────────────────────────────────────────────────────────

/** Liest und normalisiert den LAZYOS_CONNECTOR_LIVE-Master-Schalter. */
function isLiveEnabled(): boolean {
  const val = (process.env.LAZYOS_CONNECTOR_LIVE ?? "").trim().toLowerCase();
  return val === "on" || val === "1" || val === "true";
}

/** Generiert eine Correlation-ID wenn keine übergeben wurde. */
function makeCallId(): string {
  return `cinvoke-${createHash("sha256")
    .update(`${Date.now()}-${Math.random()}`)
    .digest("hex")
    .slice(0, 16)}`;
}

/**
 * Baut eine Payload-Zusammenfassung (Keys + Typen, KEINE Werte).
 * Secrets können damit nicht versehentlich in die Preview gelangen.
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
 * Baut das ConnectorProfile-Objekt für S4 buildHardenedToolset aus Katalog-Daten.
 * Nur die für S4 relevanten Felder (provider + capabilities mit mcpToolName).
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
// previewCall — S5 Vorschau ohne Netzwerk
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Baut eine Vorschau für einen Connector-Call OHNE Netzwerk.
 *
 * S5: Zeigt dem Owner was gecallt werden würde, welches Credential-Scope,
 * maskierten Credential-Hinweis und Payload-Fingerprint. Schreibt einen
 * N8-Audit-Row mit phase='preview'.
 *
 * Die Preview ist IMMER ok:true — sie kann niemals "fehlschlagen" im
 * Blockierungs-Sinne. Fehlendes Profil oder Credential wird als Information
 * zurückgegeben (credentialPreview: null, mcpTool: null), nicht als Error.
 * Der Owner bekommt damit das volle Bild bevor er freigeben muss.
 *
 * Secret-Leak-Prävention (ACL-5-D-Härtung, Security-Critic Finding 3):
 *   - previewCall entschlüsselt das Secret NICHT mehr. Es ruft KEIN
 *     resolveApiCredential() (= decrypt) auf. Stattdessen ermittelt es via
 *     credentialExists() decrypt-FREI nur die Existenz + den Scope.
 *     Rationale: maybeAutoConnect ruft previewCall bei jeder keyword-matchenden
 *     Chat-Nachricht (missing='none') — ein decrypt pro Nachricht, lange bevor
 *     der Owner „Freigeben" klickt, wäre unnötige Klartext-Exposition.
 *   - credentialPreview ist ein decrypt-freies Existenz-Label ('•••• (vorhanden)'
 *     oder null) — NIE ein aus dem Klartext abgeleiteter maskedPreview-Wert.
 *   - Der erste echte Decrypt passiert ausschließlich in executeCall (PRE-6).
 *
 * @param args  InvokeArgs (payload, workspaceId, userId, provider, capability).
 * @returns     CallPreview (immer ok:true).
 */
export function previewCall(args: InvokeArgs): CallPreview {
  const callId = args.callId ?? makeCallId();
  const scopeKind = args.scopeKind ?? "workspace";
  const requiredCaps = args.requiredCaps ?? [args.capability];
  const payloadHash = computePayloadHash(args.payload ?? {});

  // Profil lesen (null → leere Defaults, Preview ist informativ nicht blockierend).
  const profile = getConnectorProfile(args.provider);
  const capabilities = args.provider ? listCapabilities(args.provider) : [];

  // MCP-Tool für diese Capability finden.
  const capRow = capabilities.find((c) => c.name === args.capability);
  const mcpTool = capRow?.mcpToolName ?? null;

  // Credential-Existenz + Scope — DECRYPT-FREI (kein resolveApiCredential).
  // credentialExists() macht nur einen Existenz-Lookup + Scope-Ableitung,
  // ruft NIEMALS decryptCredential(). Kein Klartext-Secret wird berührt.
  let credentialScope = `workspace:${args.workspaceId}`;
  let credentialPreview: string | null = null;
  try {
    const existence = credentialExists(args.workspaceId, args.provider);
    credentialScope = existence.scopeLabel;
    if (existence.exists) {
      // Decrypt-freies Label — KEIN maskedPreview(secret), kein decrypt.
      // '•' beibehalten für UI-Konsistenz (Card zeigt „Credential vorhanden").
      credentialPreview = "•••• (vorhanden)";
    }
  } catch {
    // Existenz-Lookup fehlgeschlagen (DB-Fehler) — preview zeigt „fehlt".
    credentialPreview = null;
  }

  // Aktueller Trust-Level.
  const currentTrust = getTrust(scopeKind, args.workspaceId, args.provider);

  // N8 Audit für Preview-Phase.
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
 * Führt einen Connector-Call aus oder blockiert ihn fail-closed.
 *
 * ─── Vorbedingungs-Kette (Reihenfolge = Priorität, erstes Fail wins) ──────────
 *
 *   PRE-1  getConnectorProfile(provider) !== null
 *          → blocked: 'no-profile'
 *          Rationale: ohne Profil gibt es keine bekannte API-Konvention,
 *          keinen base_url, keine auth_kind — ein Call wäre unkontrolliert.
 *
 *   PRE-2  validateCoverage(requiredCaps, profile).ok === true
 *          → blocked: 'coverage-fail'
 *          Rationale (N6): deterministischer Coverage-Check vor jedem LLM oder
 *          Netzwerk. Eine fehlende Capability → der Connector kann den Auftrag
 *          nicht erfüllen; Fail-closed verhindert Partial-Execution.
 *
 *   PRE-3  assertCallAllowed(provider, capability, buildHardenedToolset(...))
 *          → blocked: 'not-hardened'
 *          Rationale (S4, K1): die Capability muss im S4-gehärteten MCP-Toolset
 *          des Providers sein. K1-Tools (RAG, Bash, File) sind hier strukturell
 *          ausgeschlossen — auch wenn sie fälschlicherweise im Profil stehen.
 *
 *   PRE-4  getTrust(scopeKind, workspaceId, provider) === 'auto'
 *          ODER args.approved === true
 *          → blocked: 'awaiting-approval'
 *          Rationale (S6): jeder echte Call braucht Owner-Zustimmung. Default
 *          'ask' blockiert. Der Caller (ACL5-E) setzt approved:true nachdem der
 *          Owner die preview-Card bestätigt hat.
 *
 *   PRE-5  LAZYOS_CONNECTOR_LIVE === 'on'|'1'|'true'
 *          → wenn NICHT: Dry-Run (dryRun:true), kein Netzwerk.
 *          Rationale: Master-Schalter. Default ist off = nie echter Call.
 *          Der Owner flippt diesen Wert nach Review.
 *
 *   PRE-6  resolveApiCredential(workspaceId, userId, provider) !== null
 *          → blocked: 'credential-missing'
 *          Rationale: wird ERST JETZT aufgerufen — nach allen anderen Gates.
 *          Das Secret wird nur dann materialisiert wenn tatsächlich gecallt wird.
 *          Variable bleibt lokal im Call-Block, wird nicht zurückgegeben.
 *
 * ─── Echter Call ──────────────────────────────────────────────────────────────
 *   Wenn LIVE on + alle PRE-1..4 ok + PRE-6 ok:
 *   Generischer fetch gegen profile.baseUrl + capability-endpoint.
 *   Auth-Header wird aus cred.kind + cred.secret gebaut (provider-agnostisch).
 *   cred.secret taucht NICHT in result, result_summary, logs oder audit auf.
 *   Nach dem Call: recordCallAudit('invoke', live:1, payloadHash, resultSummary).
 *
 * @param args  InvokeArgs.
 * @returns     CallResult (BlockedCallResult | DryRunCallResult | LiveCallResult).
 */
export async function executeCall(args: InvokeArgs): Promise<CallResult> {
  const callId = args.callId ?? makeCallId();
  const scopeKind = args.scopeKind ?? "workspace";
  const requiredCaps = args.requiredCaps ?? [args.capability];
  const payloadHash = computePayloadHash(args.payload ?? {});

  // ─── Shared helper: deny mit Audit-Row und geblockt zurückgeben ───────────
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

  // ─── PRE-1: Connector-Profil ──────────────────────────────────────────────
  const profile = getConnectorProfile(args.provider);
  if (!profile) {
    return deny(
      "no-profile",
      `Provider '${args.provider}' nicht im Connector-Katalog. ` +
        `Connector-Onboarding (ACL-4) muss zuerst abgeschlossen werden.`,
    );
  }

  // ─── PRE-2: Coverage-Prüfung (N6) ────────────────────────────────────────
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

  // ─── PRE-3: S4 Tool-Hardening (K1-Deny, Provider-Namespace) ─────────────
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

  // ─── PRE-4: S6-Gate — Trust 'auto' ODER Approval-Token ───────────────────
  const trust = getTrust(scopeKind, args.workspaceId, args.provider);
  const hasApproval = args.approved === true;
  if (trust !== "auto" && !hasApproval) {
    return deny(
      "awaiting-approval",
      `Trust-Level '${trust}' für '${args.provider}' erfordert explizite Owner-Freigabe. ` +
        `Entweder trust='auto' per setTrust() setzen oder approved:true vom Owner übergeben (S6).`,
    );
  }

  // ─── PRE-5: Master-Schalter ───────────────────────────────────────────────
  if (!isLiveEnabled()) {
    // Dry-Run: kein Netzwerk, klar gelabelt.
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

  // ─── PRE-6: Credential-Resolution (ERST JETZT) ───────────────────────────
  // Wichtig: wird nicht früher aufgerufen. Variable `cred` bleibt lokal.
  const cred = resolveApiCredential(args.workspaceId, args.userId, args.provider);
  if (!cred) {
    return deny(
      "credential-missing",
      `Kein Credential für Provider '${args.provider}' in Workspace '${args.workspaceId}' gefunden. ` +
        `Credential via ACL-5-B erfassen.`,
    );
  }

  // ─── Echter Call ──────────────────────────────────────────────────────────
  // cred.secret wird AUSSCHLIESSLICH für den Auth-Header verwendet.
  // Es taucht NICHT in result, result_summary, logs oder audit auf.
  const callStart = Date.now();
  let status = 0;
  let resultSummary = "";
  let callOk = false;

  try {
    // Auth-Header provider-agnostisch aus auth_kind gebaut.
    const authHeader = buildAuthHeader(profile.authKind, cred.secret);

    // Endpoint: base_url + capability-Pfad (best-effort aus mcpTool-Tail).
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
    // resultSummary enthält NIEMALS den Response-Body (N8, kein Leak).
    // Nur Statuskode, Dauer und Größe (aus Content-Length).
    const contentLength = response.headers.get("content-length");
    resultSummary =
      `status=${status} duration=${duration}ms` +
      (contentLength ? ` size=${formatSize(parseInt(contentLength, 10))}` : "");
    callOk = response.ok;
  } catch (err) {
    const duration = Date.now() - callStart;
    // Fehlertext: kein cred.secret, kein Payload (N8).
    // ACL-5-D-Härtung (Finding 2): das konkrete resolvte Secret wird direkt
    // aus dem Fehlertext per string-replace entfernt (stärkste Verteidigung),
    // zusätzlich zur defensiven {12,}-Heuristik. cred.secret kann z.B. in einer
    // TypeError-Message landen wenn fetch eine URL mit embedded credential baut.
    resultSummary = `call-error after ${duration}ms: ${maskSensitiveFromError(
      err,
      cred.secret,
    )}`;
    status = 0;
    callOk = false;
  }

  // N8 Audit-Row für invoke (live=1).
  // payloadHash statt Payload (D3), resultSummary ohne Secret (D5).
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
// Interne Call-Helpers (kein Aufruf von außen)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Baut den Auth-Header aus auth_kind + Secret.
 * Secret fließt NUR in den HTTP-Header (nicht in Logs, nicht in Rückgabewerte).
 *
 * Unterstützte auth_kinds:
 *   api_key → 'X-API-Key: <secret>'
 *   pat     → 'Authorization: Bearer <secret>'
 *   oauth   → 'Authorization: Bearer <secret>'
 *   custom  → 'Authorization: Bearer <secret>' (best-effort)
 *   none    → {} (kein Auth-Header)
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
      // Unbekannte auth_kind: sicherheitshalber Bearer (versucht es zumindest).
      return { Authorization: `Bearer ${secret}` };
  }
}

/**
 * Leitet einen Endpoint-Pfad aus dem Capability-Namen und MCP-Tool-Namen ab.
 * Best-effort: keiner dieser Werte enthält ein Secret.
 */
function inferEndpointPath(capabilityName: string, mcpToolName: string | null): string {
  // Wenn mcpToolName 'mcp__<provider>__<tool>' Format hat, Tail als Pfad nutzen.
  if (mcpToolName) {
    const parts = mcpToolName.split("__");
    if (parts.length >= 3) {
      const tail = parts.slice(2).join("/");
      return `/${tail.replace(/_/g, "-")}`;
    }
  }
  // Fallback: capability-name als Pfad (kebab-case).
  return `/${capabilityName.replace(/_/g, "-")}`;
}

/**
 * Formatiert eine Byte-Größe menschenlesbar.
 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}b`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}kb`;
  return `${(bytes / 1024 / 1024).toFixed(1)}mb`;
}

/**
 * Maskiert potentiell sensitive Informationen aus Fehler-Texten.
 * Verhindert dass API-Keys oder URLs mit embedded credentials in Logs/Audit landen.
 *
 * ACL-5-D-Härtung (Finding 2), zwei Verteidigungsschichten:
 *   1. EXAKT-Replace des konkreten resolvten Secrets (stärkste Garantie): der
 *      aktuelle cred.secret wird wörtlich durch '••••' ersetzt, falls er
 *      (z.B. über eine embedded-credential-URL) im Fehlertext steht. Damit ist
 *      ein Leak des aktiven Secrets ausgeschlossen, unabhängig von der Heuristik.
 *   2. Defensive Heuristik: jeder zusammenhängende {12,}-Token aus
 *      [A-Za-z0-9_-] wird maskiert (Schwelle von 32 auf 12 gesenkt) — fängt
 *      auch kürzere Keys/Tokens ab, die NICHT der aktive cred.secret sind.
 *
 * @param err     Der gefangene Fehler.
 * @param secret  Das aktuelle resolvte Secret (für Schicht 1). Optional —
 *                wenn leer/undefined wird nur die Heuristik angewandt.
 */
function maskSensitiveFromError(err: unknown, secret?: string): string {
  let msg = err instanceof Error ? err.message : String(err);

  // Schicht 1: exakter Secret-Replace (nur wenn das Secret nicht-trivial ist).
  if (secret && secret.length >= 4) {
    // Globaler, escapeter Replace des Klartext-Secrets durch '••••'.
    const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    msg = msg.replace(new RegExp(escaped, "g"), "••••");
  }

  // Schicht 2: defensive Heuristik — lange hex/base64-ähnliche Strings maskieren.
  // Schwelle auf {12,} gesenkt (war {32,}).
  return msg.replace(/[A-Za-z0-9_-]{12,}/g, "[masked]").slice(0, 200);
}
