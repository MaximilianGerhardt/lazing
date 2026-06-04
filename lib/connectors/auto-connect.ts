/**
 * Auto-Connect Flow — ACL5-E (2026-05-24).
 *
 * `maybeAutoConnect(prompt, ctx)` wird hybrid im Chat-Stream-Prozess aufgerufen
 * (fire-and-forget, analog plan-dispatch). Es macht KEINEN echten Connector-Call —
 * nur Detect / Setup / Preview. Echter Call nur nach User-Approve via
 * POST /api/connectors/invoke.
 *
 * ── Ablauf ────────────────────────────────────────────────────────────────────
 *   1. detectConnector(prompt, ctx) — deterministisch (N6, kein LLM, kein I/O).
 *      missing='no-connector' → no-op, return {acted:false}.
 *
 *   2. missing='profile' → connector-onboarding-SOP anstoßen (non-destruktiv,
 *      über bestehende SOP→plan-Brücke). Status-Card emittieren.
 *
 *   3. missing='credential' → credential-request-Surface emittieren
 *      (provider/scopeKind/why). KEIN Secret in der Card.
 *
 *   4. missing='none' (Profil + Credential da) → previewCall(...)
 *      → connector-call-preview-Surface emittieren (S5: Endpoint, Payload-Keys,
 *      maskiertes Credential, dryRun-Label falls LIVE off) mit Approve-Action.
 *
 * ── Constraints ───────────────────────────────────────────────────────────────
 *   - NICHT-DESTRUKTIV: kein echter Netzwerk-Call hier.
 *   - Secret NIE in Card/Transcript/SSE/Log.
 *   - Prozess-Lokalität: muss im Next-Prozess (:4200) laufen (broadcast ist
 *     In-Process-EventEmitter). Nie im agent-server (:4201) aufrufen.
 *   - Codex ist per B1-Sicherheits-Fix ausgeschlossen (destruktiver Code-Mode).
 *   - Fire-and-forget: Fehler nie an den Chat-Stream propagieren.
 *   - N8: Audit über previewCall (schreibt preview-Row).
 *   - N6: detectConnector ist deterministisch — kein LLM im Hot-Path.
 *
 * ── Wo eingehängt ────────────────────────────────────────────────────────────
 *   app/api/chat/stream/route.ts — analog zum plan-dispatch-Hybrid-Block:
 *     void maybeAutoConnect(prompt, { workspaceId, userId }).catch(...)
 *   Keine Auswirkung auf den normalen Antwort-Stream.
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
  /** Optionales Request-Abort-Signal (wird nicht an detectConnector weitergereicht,
   *  nur für künftige async-Pfade reserviert). */
  signal?: AbortSignal;
}

export type AutoConnectResult =
  | { acted: false; reason: string }
  | { acted: true; action: 'onboarding' | 'credential-request' | 'preview'; provider: string };

// ─────────────────────────────────────────────────────────────────────────────
// Interne Hilfsfunktionen
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Synchroner Existenz-Check auf api_credentials (COUNT-Query, kein Decrypt).
 * Wird als hasCredential-Callback in detectConnector injiziert (N6-konform:
 * detect.ts selbst greift nie auf api_credentials zu).
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
      // Fail-closed: wenn DB nicht erreichbar → 'credential' (kein 'none').
      return false;
    }
  };
}

/**
 * Pseudo-workstreamId für emitOrUpdateCard: ACL5-E-Connector-Karten haben
 * keinen echten Workstream. Wir nutzen ein deterministisches Präfix + Provider,
 * damit One-Card-Pro-Kind-Dedup greift (gleicher Provider → gleiche Card).
 */
function connectorCardWorkstreamId(provider: string): string {
  return `acl5e-connector-${provider}`;
}

/**
 * Onboarding-Workstream-Dedup (Bug-Fix 2026-05-30).
 *
 * Root-cause: jeder Chat-Prompt mit `missing='profile'` für denselben Provider
 * rief triggerOnboardingSop() → createWorkstream() AUF — ohne zu prüfen, ob für
 * diesen Provider+Workspace bereits ein laufendes Onboarding existiert. Folge:
 * 3+ gleichzeitige „Connector-Onboarding: heygen"-Workstreams.
 *
 * Diese Funktion liefert einen bereits AKTIVEN/laufenden Onboarding-Workstream
 * für denselben Provider+Workspace zurück (oder null). Status 'active' und
 * 'paused' gelten als „läuft noch" (ein pausierter Onboarding-Flow wartet i.d.R.
 * auf Owner-Input und darf nicht parallel neu gespawnt werden). 'done',
 * 'archived' und 'stuck' gelten als abgeschlossen/tot → ein erneuter Versuch ist
 * dann legitim.
 *
 * N6: deterministisch, reiner DB-Read, kein LLM, kein I/O.
 * N9: workspace_id ist der Isolation-Anker der Query — nie provider-only.
 *
 * Match auf `name = 'Connector-Onboarding: <safeProviderId>'` — exakt der Name,
 * den triggerOnboardingSop() bei createWorkstream() setzt (Single-Source).
 * Fail-open auf null (kein bestehender Run): bei DB-Fehler lieber EINEN
 * zusätzlichen Onboarding-Run als gar keinen — das Onboarding ist non-destruktiv.
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
    // Fail-open: kein bestehender Run erkannt → erlaube neuen (non-destruktiv).
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Onboarding-SOP-Pfad
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Startet den Connector-Onboarding-SOP für einen Provider ohne Katalog-Profil
 * (missing='profile'). Non-destruktiv: kein echter Netzwerk-Call, kein Spawn.
 *
 * Ablauf (P1-#5, echte SOP-Brücke, kein reiner Toast mehr):
 *   1. Sucht 'connector-onboarding'-SOP in der Registry via getSop/listSops.
 *   2. Wenn SOP gefunden: expandSopToPlanNodes → createWorkstream →
 *      insertProposedPlan (in Transaktion) → executePlan (text-only, codex
 *      excluded, NON-DESTRUCTIVE) — identisch zur SAR-3 runPlanDispatch Path A.
 *   3. Status-Card emittieren mit Verweis auf den erzeugten Workstream.
 *   4. Wenn SOP NICHT gefunden: Fallback auf Warn-Toast (bisheriges Verhalten),
 *      damit der Flow nie crasht.
 *
 * Constraints:
 *   - NICHT-DESTRUKTIV: executePlan ist text-only (engine.chat()), keine
 *     Datei-Schreiboperationen, kein codex.
 *   - NON-SECRET: kein Credential-Wert im Card-Payload.
 *   - N1: goalPrompt (provider-Name als Kontext) verbatim in Workstream-Beschreibung.
 *   - N8: writeDecision dokumentiert die Routing-Entscheidung.
 *   - N9: workspaceId als ManifestCoord auf allen persistierten Rows.
 *   - N10: insertProposedPlan stempelt contentHash auf jeden Plan-Step-Row.
 *
 * Fehlerbehandlung: wirft NICHT — alle Fehler landen als Console-warn
 * (fire-and-forget, analog maybeAutoConnect Aufrufer).
 */
async function triggerOnboardingSop(args: {
  provider: string;
  workspaceId: string;
  userId: string;
}): Promise<void> {
  const { provider, workspaceId } = args;

  // ── 1. Suche nach 'connector-onboarding'-SOP ────────────────────────────
  // Canonical built-in SOP-ID — falls kein expliziter SOP existiert, suchen
  // wir nach dem namen "Research → Synthesize → Draft → Review" (built-in seed)
  // als Fallback. Der eigentliche connector-onboarding-SOP ist workspace-scoped.
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
    // Best-effort — Registry nicht erreichbar → Fallback
  }

  // ── 2. Wenn kein matching SOP: Warn-Toast-Fallback (kein Crash) ─────────
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

  // ── 3. SOP gefunden → expandSopToPlanNodes → createWorkstream → persist ─
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

  // ── DEDUP (Bug-Fix 2026-05-30) ──────────────────────────────────────────
  // Existiert bereits ein aktiver/pausierter Onboarding-Workstream für genau
  // diesen Provider+Workspace → NICHT neu spawnen. Stattdessen die bestehende
  // Status-Card (idempotent via connectorCardWorkstreamId) erneut emittieren,
  // damit der Owner den laufenden Run sieht, und früh zurückkehren.
  // Verhindert die 3+ parallelen „Connector-Onboarding: heygen"-Workstreams.
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

  // N1: verbatim goal prompt — provider name + "Connector-Profil anlegen"
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

  // ── 4. Status-Card mit Workstream-Verweis emittieren ────────────────────
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
// maybeAutoConnect — Hauptfunktion
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Hybrid-Auto-Connect im Next-Prozess.
 *
 * Muss im Next-Prozess (:4200) laufen — broadcast ist In-Process-EventEmitter.
 * Codex ausgeschlossen (B1-Sicherheits-Fix).
 *
 * Fehlerbehandlung: der Caller (stream/route.ts) ruft diese Funktion per
 * `void maybeAutoConnect(...).catch(console.warn)` — jede Exception landet
 * im warn-Log, nie im Chat-Stream.
 *
 * @param prompt  - Roher Chat-Prompt.
 * @param ctx     - workspaceId + userId (Pflicht), optionales signal.
 * @returns       AutoConnectResult — Caller ignoriert diesen Wert.
 */
export async function maybeAutoConnect(
  prompt: string,
  ctx: AutoConnectCtx,
): Promise<AutoConnectResult> {
  const { workspaceId, userId } = ctx;

  // 1. Deterministisches Gate (N6, kein LLM, kein async, kein I/O außer DB-read).
  const detection = detectConnector(prompt, {
    workspaceId,
    hasCredential: buildHasCredential(workspaceId),
  });

  // missing='no-connector': kein Connector-Bezug → no-op.
  if (detection.missing === 'no-connector' || detection.provider === null) {
    return { acted: false, reason: 'no-connector-detected' };
  }

  const provider = detection.provider;

  // 2. missing='profile': Profil fehlt → Onboarding anstoßen + Status-Card.
  if (detection.missing === 'profile') {
    await triggerOnboardingSop({ provider, workspaceId, userId });
    return { acted: true, action: 'onboarding', provider };
  }

  // 3. missing='credential': Credential fehlt → credential-request-Card emittieren.
  //    SECURITY: KEIN secret-Feld im Payload. Nur provider, scopeKind, workspaceId, why.
  if (detection.missing === 'credential') {
    // Auth-Profil ableiten: API-Key vs OAuth vs engine-backed (kein Secret).
    const authProfile = deriveProviderAuthProfile(provider);

    const cardPayload = {
      provider,
      scopeKind: 'workspace' as const,
      workspaceId,
      // `why` wird aus dem rationale generiert — kein Secret, kein Payload.
      why: buildWhyText(provider, detection.neededCapabilities),
      // 2026-05-30: Auth-Profil für die mobile Credential/OAuth-Surface.
      // authKind steuert, ob API-Key-Eingabe oder OAuth-Start-Button gerendert wird.
      authKind: authProfile.authKind,
      engineBacked: authProfile.engineBacked,
      docsUrl: authProfile.docsUrl,
      signupUrl: authProfile.signupUrl,
      credentialFieldHint: authProfile.credentialFieldHint,
      // Erste benötigte Capability als Kontext (kein Secret).
      capability: detection.neededCapabilities[0] ?? null,
    };

    // SECURITY CHECK: assertNoSecret stellt sicher dass kein secret-Feld versehentlich
    // in den Card-Payload geraten ist (defensiv, sollte strukturell nie passieren).
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

  // 4. missing='none': Profil + Credential vorhanden → Preview-Card emittieren.
  //    previewCall liefert maskiertes Credential + Payload-Keys (kein Secret-Wert).
  if (detection.missing === 'none') {
    // Erste erkannte Capability nutzen (deterministisch, N6).
    const capability = detection.neededCapabilities[0] ?? 'default';

    // previewCall: S5 — kein Netzwerk-Call, schreibt N8-Audit-Row für phase='preview'.
    // Wirft nicht — Fehler in previewCall müssen hier abgefangen werden.
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
      // previewCall darf nicht den Auto-Connect-Flow killen (best-effort).
      console.warn('[auto-connect] previewCall fehlgeschlagen (non-fatal):', previewErr);
      return { acted: false, reason: 'preview-error' };
    }

    // Connector-call-preview-Card zusammenbauen.
    // SECURITY: kein Secret-Wert — nur maskiertes credentialPreview aus previewCall.
    const previewCardPayload = buildPreviewCardPayload(preview, provider, capability);

    // SECURITY CHECK: sicherstellen dass kein secret im Card-Payload ist.
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

    // B2 (2026-05-25): answer_required-Push für connector-call-preview.
    // Best-effort / non-fatal — Visibility-Gate im Helper-Body.
    // Kein Secret: preview enthält nur Provider-Name + Capability-Label.
    emitAnswerRequired({
      workspaceId,
      entityId: connectorCardWorkstreamId(provider),
      kind: 'connector-preview',
      preview: `Connector '${provider}' wartet auf Freigabe (${capability})`,
      url: `/?workspace=${encodeURIComponent(workspaceId)}`,
    });

    return { acted: true, action: 'preview', provider };
  }

  // Exhaustive: missing-Wert nicht behandelt (defensive Fallback).
  return { acted: false, reason: `unhandled-missing-${String(detection.missing)}` };
}

// ─────────────────────────────────────────────────────────────────────────────
// Interne Bau-Hilfsfunktionen
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Baut einen kurzen menschenlesbaren „why"-Text für die credential-request-Card.
 * Kein LLM, deterministisch, kein Secret.
 */
/**
 * Auth-Profil eines Providers für die credential-request-Surface (2026-05-30).
 *
 * Leitet aus dem Connector-Katalog (`auth_kind`) + dem Onboarding-SOP ab, OB
 * der Provider einen API-Key braucht oder einen OAuth-Flow, plus Owner-relevante
 * Begleit-Infos (Doku-/Signup-Link, Feld-Hinweis, engineBacked).
 *
 * authKind-Mapping (closed enum CONNECTOR_AUTH_KINDS):
 *   'oauth'  → OAuth-Flow (Auth-starten-Button).
 *   'none'   → engine-backed (kein Credential nötig — z.B. imagegen2).
 *   sonst    → 'apikey' (api_key | pat | custom → API-Key-Eingabe).
 *
 * Kein Secret, deterministisch (N6), reiner DB-Read. Fail-open auf 'apikey'
 * (der sichere Default: API-Key-Eingabe statt einem nicht verdrahteten OAuth).
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
    // Katalog nicht erreichbar → Default unten.
  }

  const sop = getOnboardingSop(provider);

  // engineBacked: SOP-Marker hat Vorrang; sonst auth_kind='none'.
  const engineBacked = sop?.engineBacked === true || catalogAuthKind === 'none';

  let authKind: DerivedAuthKind;
  if (engineBacked) {
    authKind = 'none';
  } else if (catalogAuthKind === 'oauth') {
    authKind = 'oauth';
  } else {
    // api_key | pat | custom | unbekannt → API-Key-Eingabe (sicherer Default).
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
 * Baut einen minimalen Infer-Payload aus den Capability-Namen.
 * Nur Keys, keine Werte — dient der Payload-Summary-Vorschau.
 * Kein Secret, kein PII.
 */
function buildInferredPayload(capabilities: string[]): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const cap of capabilities.slice(0, 5)) {
    // Capability-Namen als Keys → symbolische Marker (keine echten Werte).
    payload[cap] = `<${cap}>`;
  }
  return payload;
}

/**
 * Baut den connector-call-preview-Card-Payload aus dem CallPreview-Objekt.
 * SECURITY: credentialPreview ist bereits maskiert (aus previewCall) — kein Secret.
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
    // credentialPreview: maskierter Wert aus maskedPreview() — NIE der Klartext.
    credentialPreview: preview.credentialPreview,
    authKind: preview.authKind,
    payloadHash: preview.payloadHash,
    currentTrust: preview.currentTrust,
    // dryRun: true wenn LAZYOS_CONNECTOR_LIVE nicht aktiv — klar gelabelt.
    dryRun: !preview.liveEnabled,
    liveEnabled: preview.liveEnabled,
  };
}

/**
 * SECURITY: wirft wenn irgendein bekanntes Secret-Feld im Payload-Objekt ist.
 * Defensiv — strukturell sollte kein Secret je in einen Card-Payload geraten,
 * aber diese Guard macht das explizit zur Laufzeit überprüfbar.
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
// ConnectorCallPreviewPayload — Surface-Card-Payload-Typ (kein Secret)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Payload für die connector-call-preview-Surface.
 * SECURITY: enthält KEIN secret-Feld. credentialPreview ist maskiert.
 */
export interface ConnectorCallPreviewPayload {
  provider: string;
  capability: string;
  callId: string;
  mcpTool: string | null;
  baseUrl: string | null;
  /** Payload-Zusammenfassung: Keys + Typen, KEINE Werte. */
  payloadSummary: Record<string, string>;
  /** Scope-Identifier, kein Secret. z.B. 'workspace:ws-123'. */
  credentialScope: string;
  /** Maskierter Credential-Vorschau-Wert. NIE der Klartext. null wenn kein Credential. */
  credentialPreview: string | null;
  authKind: string;
  payloadHash: string;
  currentTrust: 'ask' | 'auto';
  /** true → LAZYOS_CONNECTOR_LIVE ist off → echter Call würde Dry-Run sein. */
  dryRun: boolean;
  liveEnabled: boolean;
}
