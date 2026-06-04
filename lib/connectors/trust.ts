/**
 * Connector trust store (ACL-5-C — 2026-05-24).
 *
 * Manages the trust level ('ask'|'auto') per connector+scope and writes
 * every phase transition of a connector call to the audit log.
 *
 * Design:
 *   D1  Trust default 'ask' — fail-closed towards confirmation (N6).
 *       getTrust() returns 'ask' when no entry exists.
 *   D2  setTrust() writes an approval entry + an audit row (N8).
 *   D3  recordCallAudit() writes payload_hash instead of the raw payload (no PII/secret).
 *   D4  content_hash (N10) via canonicalJSON on both tables.
 *   D5  Secrets never appear here.
 *
 * N8:  every trust change + every phase transition writes an audit row.
 * N10: content_hash = sha256(canonicalJSON(row without the hash field)).
 * N9:  scope_kind + scope_id are mandatory anchors for all queries.
 *
 * Fail-closed pattern:
 *   - DB error in getTrust → fallback 'ask' (never 'auto' on ambiguity).
 *   - recordCallAudit is best-effort (never block the call pipeline,
 *     but log visibly when an audit write fails — N8 observability).
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
   * The actor changing the trust level.
   *
   * Finding 4a (doc): the caller MUST pass an ALREADY AUTHENTICATED userId here
   * (or 'system' for automated writes). setTrust performs NO
   * own auth/session lookup — it trusts the passed value and
   * writes it unchanged into set_by + the N8 audit row. A non-validated
   * or client-controlled ID here would make the audit attribution forgeable.
   * Authentication happens in the route/handler before this call.
   */
  actor: string;
  /** Optional justification for N8 traceability. */
  reason?: string;
}

export interface RecordCallAuditArgs {
  scopeKind: ConnectorScopeKind;
  scopeId: string;
  provider: string;
  capability: string;
  userId: string;
  phase: ConnectorCallPhase;
  /** true = real network call; false = dry run or non-invoke phase. */
  live?: boolean;
  /**
   * The call payload's CANONICAL-JSON HASH (sha256 of the payload's canonical-JSON).
   * NEVER the raw payload — no secret, no PII in the audit log (D3).
   * If undefined: no payload known (OK for 'deny' before payload construction).
   */
  payloadHash?: string;
  /** Short result summary. e.g. 'status=200 duration=340ms'. NEVER a response body. */
  resultSummary?: string;
  success: boolean;
  /** Deny reason or error text. NULL on success. */
  reason?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helper functions
// ─────────────────────────────────────────────────────────────────────────────

/** ID generator with a prefix for visual distinguishability. */
function generateId(prefix: string): string {
  return `${prefix}${randomUUID()}`;
}

/**
 * Finding 6a: valid payloadHash format = sha256-hex (64 chars [0-9a-f]).
 * recordCallAudit rejects anything else (no raw payload in the audit).
 */
const PAYLOAD_HASH_RE = /^[0-9a-f]{64}$/;

/**
 * N10 content_hash for a connector_call_approvals row.
 * Covers all fields except content_hash itself.
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
 * N10 content_hash for a connector_call_audit row.
 * Covers all fields except content_hash itself.
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
 * Validates scope_kind against the allowed values (N6 deterministic).
 * Throws if the value is invalid (fail-closed).
 */
function assertValidScopeKind(scopeKind: string): asserts scopeKind is ConnectorScopeKind {
  if (!(CONNECTOR_SCOPE_KINDS as readonly string[]).includes(scopeKind)) {
    throw new Error(
      `[trust] Ungültiger scope_kind '${scopeKind}': erwartet ${CONNECTOR_SCOPE_KINDS.join(" | ")}. Fail-closed.`,
    );
  }
}

/**
 * Validates phase against the allowed values (N6 deterministic).
 * Throws if the value is invalid (fail-closed).
 */
function assertValidPhase(phase: string): asserts phase is ConnectorCallPhase {
  if (!(CONNECTOR_CALL_PHASES as readonly string[]).includes(phase)) {
    throw new Error(
      `[trust] Ungültige phase '${phase}': erwartet ${CONNECTOR_CALL_PHASES.join(" | ")}. Fail-closed.`,
    );
  }
}

/**
 * Validates trust against the allowed values (N6 deterministic).
 * Throws if the value is invalid (fail-closed).
 */
function assertValidTrust(trust: string): asserts trust is ConnectorTrust {
  if (!(CONNECTOR_TRUST_VALUES as readonly string[]).includes(trust)) {
    throw new Error(
      `[trust] Ungültiger trust-Wert '${trust}': erwartet ${CONNECTOR_TRUST_VALUES.join(" | ")}. Fail-closed.`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// getTrust — fail-closed towards 'ask'
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reads the trust level for a connector in a scope.
 *
 * Trust default (D1): 'ask' — fail-closed towards confirmation.
 * If no entry exists or a DB error occurs: always 'ask'.
 * Never 'auto' as an implicit default.
 *
 * @returns 'ask' | 'auto'
 */
export function getTrust(
  scopeKind: ConnectorScopeKind,
  scopeId: string,
  provider: string,
): ConnectorTrust {
  // Pre-validation (N6): invalid scopeKind → immediately 'ask' (fail-closed).
  // Does NOT throw here (would be breaking for callers) — instead warn + fallback.
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
      // No entry = 'ask' (default fail-closed, D1).
      return "ask";
    }

    // Validate the stored value (N6: deterministic, tamper guard).
    const stored = row.trust;
    if (!(CONNECTOR_TRUST_VALUES as readonly string[]).includes(stored)) {
      // Stored value is invalid/tampered → fail-closed.
      // eslint-disable-next-line no-console
      console.warn(
        `[trust:getTrust] Ungültiger gespeicherter trust-Wert '${stored}' für provider='${provider}' — Fallback zu 'ask'.`,
      );
      return "ask";
    }

    return stored as ConnectorTrust;
  } catch (err) {
    // DB error → fail-closed (D1: never 'auto' on ambiguity).
    // eslint-disable-next-line no-console
    console.warn(
      `[trust:getTrust] DB-Fehler — Fallback zu 'ask' (fail-closed):`,
      err,
    );
    return "ask";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// setTrust — persists + writes an N8 audit row
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sets the trust level for a connector in a scope.
 *
 * Writes in ONE atomic DB transaction (P2-#10, N8 fail-closed):
 *   1. Approval upsert into connector_call_approvals.
 *   2. Audit row into connector_call_audit with phase='approve'.
 *
 * Fail-closed: if the audit write throws → the entire transaction rolls back.
 * A trust change CANNOT persist without an audit row (N8 hard contract,
 * unlike recordCallAudit which is best-effort).
 *
 * Throws on an invalid scopeKind, trust, empty provider/scopeId/actor (N6).
 * Throws if the DB transaction fails (the caller must catch or propagate).
 *
 * N10: content_hash on both rows.
 * N8:  audit row with phase='approve' — in the same TX as the approval (fail-closed).
 */
export function setTrust(args: SetTrustArgs): void {
  // N6: validate deterministically before DB access.
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

  // Check whether an entry already exists (for createdAt stability).
  // Outside the transaction, since it is only a read (no TX needed).
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

  // N10 content_hash for the approval entry.
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

  // Prepare the N8 audit row (written inside the TX).
  const auditId = generateId("CCAUD-");
  const auditTs = now; // same millisecond as the approval for TX atomicity
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

  // P2-#10 (N8 fail-closed): approval upsert + audit row in ONE transaction.
  // If the audit write throws → rollback of the whole TX → no approval without audit.
  // better-sqlite3 `.transaction(fn)` returns a wrapper function;
  // `txFn()` runs fn synchronously + atomically and throws on any error in fn.
  const txFn = db.$raw.transaction(() => {
    // 1. Approval upsert.
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

    // 2. Audit row (N8, phase='approve'). If it throws here → TX rollback.
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

  txFn(); // throws on error → the caller propagates (fail-closed)
}

// ─────────────────────────────────────────────────────────────────────────────
// recordCallAudit — best-effort, payload_hash statt payload
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Writes a phase transition of a connector call into connector_call_audit.
 *
 * Best-effort: never fails (try/catch, warn on error) —
 * a failed audit write must not block the call pipeline.
 * N8 observability: errors are surfaced as console.warn.
 *
 * Security constraint (D3 + Finding 6a):
 *   payloadHash must be sha256(canonicalJSON(payload)), NOT the raw payload.
 *   recordCallAudit now validates this itself: payloadHash must match the format
 *   /^[0-9a-f]{64}$/. If it does not (e.g. because a caller
 *   accidentally passes the raw payload), the value is NEVER written raw —
 *   it is set to null and the reason gets the marker 'invalid-payload-hash'.
 *   This way, even on a caller error, no plaintext (secret/PII) ends up in the audit.
 *
 * N10: content_hash on the written row.
 *
 * @param args  Audit context. payloadHash = sha256(canonical-JSON(payload)) or undefined.
 */
export function recordCallAudit(args: RecordCallAuditArgs): void {
  try {
    // N6: validation before DB access.
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

    // Finding 6a: payloadHash MUST be a sha256-hex (64 chars [0-9a-f]).
    // A caller could accidentally pass the RAW payload as payloadHash
    // → plaintext (secret/PII) in the audit log. Fail-closed: on a format mismatch
    // the passed value is NEVER written raw, but set to null and the
    // reason suffix 'invalid-payload-hash' is appended (visible evidence hint).
    const rawPayloadHash = args.payloadHash?.trim();
    let trimmedPayloadHash: string | null;
    if (rawPayloadHash === undefined || rawPayloadHash.length === 0) {
      trimmedPayloadHash = null;
    } else if (PAYLOAD_HASH_RE.test(rawPayloadHash)) {
      trimmedPayloadHash = rawPayloadHash;
    } else {
      // Mismatch: never write the raw value. null + reason marker.
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
    // Best-effort: never block the call pipeline.
    // Log visibly for N8 observability.
    // eslint-disable-next-line no-console
    console.warn("[trust:recordCallAudit] Audit-Write fehlgeschlagen:", err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// computePayloadHash — helper for callers (D3)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Computes the sha256 hash over the canonical-JSON of a call payload.
 *
 * Callers MUST use this function (or an equivalent one) BEFORE passing
 * payloadHash to recordCallAudit. They must NOT forward the raw payload.
 *
 * Throw-safe: on serialization errors 'sha256:error:<type>' is returned
 * so the audit write is not blocked (D3-safe: no payload in the audit, whatever happens).
 */
export function computePayloadHash(payload: unknown): string {
  try {
    const canonical = canonicalJSON(payload, { nonJsonStrategy: "coerce" });
    return createHash("sha256").update(canonical, "utf8").digest("hex");
  } catch {
    // Fallback: sha256 over JSON.stringify (never the payload itself in the audit).
    try {
      return createHash("sha256").update(JSON.stringify(payload) ?? "", "utf8").digest("hex");
    } catch {
      return "sha256:error:unserializable";
    }
  }
}
