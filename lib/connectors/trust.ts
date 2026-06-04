/**
 * Connector Trust-Store (ACL-5-C — 2026-05-24).
 *
 * Verwaltet den Trust-Level ('ask'|'auto') pro Connector+Scope und schreibt
 * jeden Phase-Übergang eines Connector-Calls in das Audit-Log.
 *
 * Design:
 *   D1  Trust-Default 'ask' — fail-closed Richtung Bestätigung (N6).
 *       getTrust() gibt 'ask' zurück wenn kein Eintrag existiert.
 *   D2  setTrust() schreibt einen Approval-Eintrag + eine Audit-Row (N8).
 *   D3  recordCallAudit() schreibt payload_hash statt rohem Payload (kein PII/Secret).
 *   D4  content_hash (N10) via canonicalJSON auf beiden Tabellen.
 *   D5  Secrets tauchen hier nirgends auf.
 *
 * N8:  Jede Trust-Änderung + jeder Phase-Übergang schreibt eine Audit-Row.
 * N10: content_hash = sha256(canonicalJSON(row ohne hash-Feld)).
 * N9:  scope_kind + scope_id sind Pflicht-Anker für alle Queries.
 *
 * Fail-closed Pattern:
 *   - DB-Fehler bei getTrust → Fallback 'ask' (niemals 'auto' bei Unklarheit).
 *   - recordCallAudit ist best-effort (niemals die Call-Pipeline blockieren,
 *     aber sichtbar loggen wenn ein Audit-Write schlägt — N8-Observability).
 */

import { createHash, randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { getDb } from "@/db/client";
import { canonicalJSON } from "@/lib-v1/audit/canonical-json";
import {
  CONNECTOR_CALL_PHASES,
  CONNECTOR_SCOPE_KINDS,
  CONNECTOR_TRUST_VALUES,
  type ConnectorCallPhase,
  type ConnectorScopeKind,
  type ConnectorTrust,
  connectorCallApprovals,
  connectorCallAudit,
} from "@/db/schema/connector_calls";

// ─────────────────────────────────────────────────────────────────────────────
// Public Types
// ─────────────────────────────────────────────────────────────────────────────

export interface TrustArgs {
  scopeKind: ConnectorScopeKind;
  scopeId: string;
  provider: string;
}

export interface SetTrustArgs extends TrustArgs {
  trust: ConnectorTrust;
  /**
   * Akteur der den Trust-Level ändert.
   *
   * Finding 4a (Doc): Der Caller MUSS hier eine BEREITS AUTHENTIFIZIERTE userId
   * (oder 'system' für automatisierte Writes) übergeben. setTrust führt KEINEN
   * eigenen Auth-/Session-Lookup durch — es vertraut dem übergebenen Wert und
   * schreibt ihn unverändert in set_by + die N8-Audit-Row. Eine nicht-validierte
   * oder vom Client kontrollierte ID hier würde die Audit-Attribution fälschbar
   * machen. Authentifizierung passiert in der Route/dem Handler vor diesem Aufruf.
   */
  actor: string;
  /** Optionale Begründung für N8-Rückverfolgbarkeit. */
  reason?: string;
}

export interface RecordCallAuditArgs {
  scopeKind: ConnectorScopeKind;
  scopeId: string;
  provider: string;
  capability: string;
  userId: string;
  phase: ConnectorCallPhase;
  /** true = echter Netzwerk-Call; false = Dry-Run oder nicht-invoke Phase. */
  live?: boolean;
  /**
   * Der Call-Payload CANONICAL-JSON-HASH (sha256 von canonical-JSON des Payloads).
   * NIE der rohe Payload — kein Secret, kein PII im Audit-Log (D3).
   * Wenn undefined: kein Payload bekannt (OK für 'deny' vor Payload-Konstruktion).
   */
  payloadHash?: string;
  /** Kurze Ergebnis-Zusammenfassung. z.B. 'status=200 duration=340ms'. NIE Response-Body. */
  resultSummary?: string;
  success: boolean;
  /** Deny-Grund oder Fehler-Text. NULL bei Erfolg. */
  reason?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Interne Hilfsfunktionen
// ─────────────────────────────────────────────────────────────────────────────

/** ID-Generator mit Präfix für visuelle Unterscheidbarkeit. */
function generateId(prefix: string): string {
  return `${prefix}${randomUUID()}`;
}

/**
 * Finding 6a: gültiges payloadHash-Format = sha256-hex (64 chars [0-9a-f]).
 * recordCallAudit lehnt alles andere ab (kein Roh-Payload im Audit).
 */
const PAYLOAD_HASH_RE = /^[0-9a-f]{64}$/;

/**
 * N10 content_hash für einen connector_call_approvals-Row.
 * Deckt alle Felder außer content_hash selbst ab.
 */
function hashApprovalRow(row: {
  id: string;
  scopeKind: string;
  scopeId: string;
  provider: string;
  trust: string;
  setBy: string;
  reason: string | null;
  createdAt: number;
  updatedAt: number;
}): string {
  const canonical = canonicalJSON({
    id: row.id,
    scope_kind: row.scopeKind,
    scope_id: row.scopeId,
    provider: row.provider,
    trust: row.trust,
    set_by: row.setBy,
    reason: row.reason ?? null,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * N10 content_hash für einen connector_call_audit-Row.
 * Deckt alle Felder außer content_hash selbst ab.
 */
function hashAuditRow(row: {
  id: string;
  ts: number;
  scopeKind: string;
  scopeId: string;
  provider: string;
  capability: string;
  userId: string;
  phase: string;
  live: number;
  payloadHash: string | null;
  resultSummary: string | null;
  success: number;
  reason: string | null;
}): string {
  const canonical = canonicalJSON({
    id: row.id,
    ts: row.ts,
    scope_kind: row.scopeKind,
    scope_id: row.scopeId,
    provider: row.provider,
    capability: row.capability,
    user_id: row.userId,
    phase: row.phase,
    live: row.live,
    payload_hash: row.payloadHash ?? null,
    result_summary: row.resultSummary ?? null,
    success: row.success,
    reason: row.reason ?? null,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Validiert scope_kind gegen die erlaubten Werte (N6 deterministisch).
 * Wirft wenn der Wert ungültig ist (fail-closed).
 */
function assertValidScopeKind(scopeKind: string): asserts scopeKind is ConnectorScopeKind {
  if (!(CONNECTOR_SCOPE_KINDS as readonly string[]).includes(scopeKind)) {
    throw new Error(
      `[trust] Ungültiger scope_kind '${scopeKind}': erwartet ${CONNECTOR_SCOPE_KINDS.join(" | ")}. Fail-closed.`,
    );
  }
}

/**
 * Validiert phase gegen die erlaubten Werte (N6 deterministisch).
 * Wirft wenn der Wert ungültig ist (fail-closed).
 */
function assertValidPhase(phase: string): asserts phase is ConnectorCallPhase {
  if (!(CONNECTOR_CALL_PHASES as readonly string[]).includes(phase)) {
    throw new Error(
      `[trust] Ungültige phase '${phase}': erwartet ${CONNECTOR_CALL_PHASES.join(" | ")}. Fail-closed.`,
    );
  }
}

/**
 * Validiert trust gegen die erlaubten Werte (N6 deterministisch).
 * Wirft wenn der Wert ungültig ist (fail-closed).
 */
function assertValidTrust(trust: string): asserts trust is ConnectorTrust {
  if (!(CONNECTOR_TRUST_VALUES as readonly string[]).includes(trust)) {
    throw new Error(
      `[trust] Ungültiger trust-Wert '${trust}': erwartet ${CONNECTOR_TRUST_VALUES.join(" | ")}. Fail-closed.`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// getTrust — fail-closed Richtung 'ask'
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Liest den Trust-Level für einen Connector in einem Scope.
 *
 * Trust-Default (D1): 'ask' — fail-closed Richtung Bestätigung.
 * Wenn kein Eintrag existiert oder ein DB-Fehler auftritt: immer 'ask'.
 * Niemals 'auto' als impliziter Default.
 *
 * @returns 'ask' | 'auto'
 */
export function getTrust(
  scopeKind: ConnectorScopeKind,
  scopeId: string,
  provider: string,
): ConnectorTrust {
  // Vorab-Validierung (N6): ungültige scopeKind → sofort 'ask' (fail-closed).
  // Wirft hier NICHT (wäre breaking für Aufrufer) — stattdessen warn + fallback.
  if (!(CONNECTOR_SCOPE_KINDS as readonly string[]).includes(scopeKind)) {
    // eslint-disable-next-line no-console
    console.warn(
      `[trust:getTrust] Ungültiger scope_kind '${scopeKind}' — Fallback zu 'ask' (fail-closed).`,
    );
    return "ask";
  }

  if (!scopeId?.trim() || !provider?.trim()) {
    // eslint-disable-next-line no-console
    console.warn(
      `[trust:getTrust] scopeId oder provider leer — Fallback zu 'ask' (fail-closed).`,
    );
    return "ask";
  }

  try {
    const db = getDb();
    const row = db
      .select({ trust: connectorCallApprovals.trust })
      .from(connectorCallApprovals)
      .where(
        and(
          eq(connectorCallApprovals.scopeKind, scopeKind),
          eq(connectorCallApprovals.scopeId, scopeId.trim()),
          eq(connectorCallApprovals.provider, provider.trim()),
        ),
      )
      .get();

    if (!row) {
      // Kein Eintrag = 'ask' (default fail-closed, D1).
      return "ask";
    }

    // Validiere den gespeicherten Wert (N6: deterministisch, Tamper-Guard).
    const stored = row.trust;
    if (!(CONNECTOR_TRUST_VALUES as readonly string[]).includes(stored)) {
      // Gespeicherter Wert ist ungültig/tampered → fail-closed.
      // eslint-disable-next-line no-console
      console.warn(
        `[trust:getTrust] Ungültiger gespeicherter trust-Wert '${stored}' für provider='${provider}' — Fallback zu 'ask'.`,
      );
      return "ask";
    }

    return stored as ConnectorTrust;
  } catch (err) {
    // DB-Fehler → fail-closed (D1: niemals 'auto' bei Unklarheit).
    // eslint-disable-next-line no-console
    console.warn(
      `[trust:getTrust] DB-Fehler — Fallback zu 'ask' (fail-closed):`,
      err,
    );
    return "ask";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// setTrust — persistiert + schreibt N8-Audit-Row
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Setzt den Trust-Level für einen Connector in einem Scope.
 *
 * Schreibt in EINER atomaren DB-Transaktion (P2-#10, N8 fail-closed):
 *   1. Approval-Upsert in connector_call_approvals.
 *   2. Audit-Row in connector_call_audit mit phase='approve'.
 *
 * Fail-closed: wenn der Audit-Write wirft → gesamte Transaktion rollt zurück.
 * Eine Trust-Änderung KANN NICHT ohne Audit-Row persistieren (N8 hard-contract,
 * im Gegensatz zu recordCallAudit das best-effort ist).
 *
 * Wirft bei ungültigem scopeKind, trust, leerem provider/scopeId/actor (N6).
 * Wirft wenn die DB-Transaktion schlägt (Caller muss fangen oder propagieren).
 *
 * N10: content_hash auf beiden Rows.
 * N8:  Audit-Row mit phase='approve' — in derselben TX wie der Approval (fail-closed).
 */
export function setTrust(args: SetTrustArgs): void {
  // N6: Deterministisch validieren bevor DB-Zugriff.
  assertValidScopeKind(args.scopeKind);
  assertValidTrust(args.trust);

  if (!args.scopeId?.trim()) {
    throw new Error("[trust:setTrust] scopeId darf nicht leer sein.");
  }
  if (!args.provider?.trim()) {
    throw new Error("[trust:setTrust] provider darf nicht leer sein.");
  }
  if (!args.actor?.trim()) {
    throw new Error("[trust:setTrust] actor darf nicht leer sein.");
  }

  const db = getDb();
  const now = Date.now();
  const trimmedScopeId = args.scopeId.trim();
  const trimmedProvider = args.provider.trim();
  const trimmedActor = args.actor.trim();
  const trimmedReason = args.reason?.trim() ?? null;

  // Prüfe ob bereits ein Eintrag existiert (für createdAt-Stabilität).
  // Außerhalb der Transaktion, da es nur ein Read ist (keine TX nötig).
  const existing = db
    .select()
    .from(connectorCallApprovals)
    .where(
      and(
        eq(connectorCallApprovals.scopeKind, args.scopeKind),
        eq(connectorCallApprovals.scopeId, trimmedScopeId),
        eq(connectorCallApprovals.provider, trimmedProvider),
      ),
    )
    .get();

  const id = existing?.id ?? generateId("CCA-");
  const createdAt = existing?.createdAt ?? now;

  // N10 content_hash für den Approval-Eintrag.
  const contentHash = hashApprovalRow({
    id,
    scopeKind: args.scopeKind,
    scopeId: trimmedScopeId,
    provider: trimmedProvider,
    trust: args.trust,
    setBy: trimmedActor,
    reason: trimmedReason,
    createdAt,
    updatedAt: now,
  });

  // N8-Audit-Row vorbereiten (innerhalb der TX geschrieben).
  const auditId = generateId("CCAUD-");
  const auditTs = now; // selbe Millisekunde wie Approval für TX-Atomizität
  const auditContentHash = hashAuditRow({
    id: auditId,
    ts: auditTs,
    scopeKind: args.scopeKind,
    scopeId: trimmedScopeId,
    provider: trimmedProvider,
    capability: `trust-change:${args.trust}`,
    userId: trimmedActor,
    phase: "approve",
    live: 0,
    payloadHash: null,
    resultSummary: `Trust-Level für '${trimmedProvider}' auf '${args.trust}' gesetzt`,
    success: 1,
    reason: trimmedReason,
  });

  // P2-#10 (N8 fail-closed): Approval-Upsert + Audit-Row in EINER Transaktion.
  // Wirft der Audit-Write → rollback der ganzen TX → kein Approval ohne Audit.
  // better-sqlite3 `.transaction(fn)` gibt eine Wrapper-Funktion zurück;
  // `txFn()` führt fn synchron + atomar aus und wirft bei jedem Fehler in fn.
  const txFn = db.$raw.transaction(() => {
    // 1. Approval-Upsert.
    db.insert(connectorCallApprovals)
      .values({
        id,
        scopeKind: args.scopeKind,
        scopeId: trimmedScopeId,
        provider: trimmedProvider,
        trust: args.trust,
        setBy: trimmedActor,
        reason: trimmedReason,
        contentHash,
        createdAt,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          connectorCallApprovals.scopeKind,
          connectorCallApprovals.scopeId,
          connectorCallApprovals.provider,
        ],
        set: {
          trust: args.trust,
          setBy: trimmedActor,
          reason: trimmedReason,
          contentHash,
          updatedAt: now,
        },
      })
      .run();

    // 2. Audit-Row (N8, phase='approve'). Wirft hier → TX rollback.
    db.insert(connectorCallAudit)
      .values({
        id: auditId,
        ts: auditTs,
        scopeKind: args.scopeKind,
        scopeId: trimmedScopeId,
        provider: trimmedProvider,
        capability: `trust-change:${args.trust}`,
        userId: trimmedActor,
        phase: "approve",
        live: 0,
        payloadHash: null,
        resultSummary: `Trust-Level für '${trimmedProvider}' auf '${args.trust}' gesetzt`,
        success: 1,
        reason: trimmedReason,
        contentHash: auditContentHash,
      })
      .run();
  });

  txFn(); // wirft bei Fehler → Caller propagiert (fail-closed)
}

// ─────────────────────────────────────────────────────────────────────────────
// recordCallAudit — best-effort, payload_hash statt payload
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Schreibt einen Phase-Übergang eines Connector-Calls in connector_call_audit.
 *
 * Best-effort: schlägt niemals fehl (try/catch, warn auf Fehler) —
 * ein fehlgeschlagener Audit-Write darf nicht die Call-Pipeline blockieren.
 * N8-Observability: Fehler werden als console.warn sichtbar gemacht.
 *
 * Sicherheits-Constraint (D3 + Finding 6a):
 *   payloadHash muss sha256(canonicalJSON(payload)) sein, NICHT der rohe Payload.
 *   recordCallAudit validiert das jetzt selbst: payloadHash muss dem Format
 *   /^[0-9a-f]{64}$/ entsprechen. Tut er das nicht (z.B. weil ein Caller
 *   versehentlich den rohen Payload übergibt), wird der Wert NIE roh geschrieben —
 *   er wird auf null gesetzt und der reason bekommt den Marker 'invalid-payload-hash'.
 *   So landet selbst bei einem Caller-Fehler kein Klartext (Secret/PII) im Audit.
 *
 * N10: content_hash auf der geschriebenen Row.
 *
 * @param args  Audit-Kontext. payloadHash = sha256(canonical-JSON(payload)) oder undefined.
 */
export function recordCallAudit(args: RecordCallAuditArgs): void {
  try {
    // N6: Validierung vor DB-Zugriff.
    assertValidScopeKind(args.scopeKind);
    assertValidPhase(args.phase);

    if (!args.scopeId?.trim() || !args.provider?.trim()) {
      // eslint-disable-next-line no-console
      console.warn("[trust:recordCallAudit] scopeId oder provider leer — Audit-Write übersprungen.");
      return;
    }

    const db = getDb();
    const id = generateId("CCAUD-");
    const ts = Date.now();
    const liveInt = args.live === true ? 1 : 0;
    const successInt = args.success === true ? 1 : 0;
    const trimmedResultSummary = args.resultSummary?.trim() ?? null;
    let trimmedReason = args.reason?.trim() ?? null;

    // Finding 6a: payloadHash MUSS ein sha256-hex sein (64 chars [0-9a-f]).
    // Ein Caller könnte versehentlich den ROHEN Payload als payloadHash übergeben
    // → Klartext (Secret/PII) im Audit-Log. Fail-closed: bei Format-Mismatch wird
    // der übergebene Wert NIE roh geschrieben, sondern auf null gesetzt und der
    // reason-Suffix 'invalid-payload-hash' angehängt (sichtbarer Evidence-Hinweis).
    const rawPayloadHash = args.payloadHash?.trim();
    let trimmedPayloadHash: string | null;
    if (rawPayloadHash === undefined || rawPayloadHash.length === 0) {
      trimmedPayloadHash = null;
    } else if (PAYLOAD_HASH_RE.test(rawPayloadHash)) {
      trimmedPayloadHash = rawPayloadHash;
    } else {
      // Mismatch: niemals den Roh-Wert schreiben. null + reason-Marker.
      trimmedPayloadHash = null;
      trimmedReason = trimmedReason
        ? `${trimmedReason} [invalid-payload-hash]`
        : "invalid-payload-hash";
      // eslint-disable-next-line no-console
      console.warn(
        "[trust:recordCallAudit] payloadHash hatte kein sha256-hex-Format — auf null gesetzt (kein Roh-Wert im Audit, Finding 6a).",
      );
    }

    const contentHash = hashAuditRow({
      id,
      ts,
      scopeKind: args.scopeKind,
      scopeId: args.scopeId.trim(),
      provider: args.provider.trim(),
      capability: args.capability.trim(),
      userId: args.userId.trim(),
      phase: args.phase,
      live: liveInt,
      payloadHash: trimmedPayloadHash,
      resultSummary: trimmedResultSummary,
      success: successInt,
      reason: trimmedReason,
    });

    db.insert(connectorCallAudit)
      .values({
        id,
        ts,
        scopeKind: args.scopeKind,
        scopeId: args.scopeId.trim(),
        provider: args.provider.trim(),
        capability: args.capability.trim(),
        userId: args.userId.trim(),
        phase: args.phase,
        live: liveInt,
        payloadHash: trimmedPayloadHash,
        resultSummary: trimmedResultSummary,
        success: successInt,
        reason: trimmedReason,
        contentHash,
      })
      .run();
  } catch (err) {
    // Best-effort: nie die Call-Pipeline blockieren.
    // Sichtbar loggen für N8-Observability.
    // eslint-disable-next-line no-console
    console.warn("[trust:recordCallAudit] Audit-Write fehlgeschlagen:", err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// computePayloadHash — Hilfsfunktion für Caller (D3)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Berechnet den sha256-Hash über canonical-JSON eines Call-Payloads.
 *
 * Caller MÜSSEN diese Funktion (oder eine äquivalente) benutzen BEVOR sie
 * payloadHash an recordCallAudit übergeben. Sie dürfen NICHT den rohen Payload
 * weitergeben.
 *
 * Throw-safe: bei Serialisierungs-Fehlern wird 'sha256:error:<type>' zurückgegeben
 * damit der Audit-Write nicht blockiert wird (D3-safe: kein Payload im Audit, egal was).
 */
export function computePayloadHash(payload: unknown): string {
  try {
    const canonical = canonicalJSON(payload, { nonJsonStrategy: "coerce" });
    return createHash("sha256").update(canonical, "utf8").digest("hex");
  } catch {
    // Fallback: sha256 über JSON.stringify (niemals der Payload selbst im Audit).
    try {
      return createHash("sha256").update(JSON.stringify(payload) ?? "", "utf8").digest("hex");
    } catch {
      return "sha256:error:unserializable";
    }
  }
}
