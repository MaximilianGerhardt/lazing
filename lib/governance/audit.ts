/**
 * G4 — governance audit helper (Phase 2 W2.1 · Lane G Governance · 2026-05-29).
 *
 * Integration plan §4 Lane G (verbatim, N1):
 *   „audit/provenance requirements"
 *
 * Pattern analogous to lib/security/permission-mode.ts (lazyos_permission_audit).
 * This layer writes append-only decision logs to governance_audit
 * (Migration 0118) that prove what Lane G decided:
 *
 *   - every action that queries canAutoRun (no-auto-run.ts) produces a
 *     governance_audit entry with decision ∈ {allowed, denied,
 *     requires-approval}.
 *   - every revokeConsent operation produces an audit row (§13.2 „Pause/
 *     Stop jederzeit" must be verifiable).
 *   - every LIVE connector invocation produces an audit row (§13.2
 *     „Review durch betroffene Person").
 *
 * Substrate discipline:
 *   - N1:  reason VERBATIM, no .slice.
 *   - N8:  append-only triggers in the migration.
 *   - N9:  workspaceId-scoped.
 *   - N10: content_hash (sha256 over canonical JSON) per row.
 */

import { createHash } from "node:crypto";

import { ulid } from "@/lib/ulid";

import type { ActionKind } from "./no-auto-run";

type RawDb = import("better-sqlite3").Database;

export type GovernanceDecision = "allowed" | "denied" | "requires-approval";

export interface GovernanceAuditEntry {
  readonly id: string;
  readonly workspaceId: string;
  readonly userId: string;
  readonly action: string;
  readonly dataSource: string | null;
  readonly decision: GovernanceDecision;
  /** VERBATIM N1. */
  readonly reason: string;
  readonly contentHash: string;
  readonly createdAt: number;
}

export interface WriteGovernanceAuditInput {
  readonly workspaceId: string;
  readonly userId: string;
  readonly action: ActionKind | string;
  readonly dataSource?: string | null;
  readonly decision: GovernanceDecision;
  /** VERBATIM N1 — no truncation. */
  readonly reason: string;
}

function nowMs(): number {
  return Date.now();
}

function sha256hex(payload: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function mapRow(r: Record<string, unknown>): GovernanceAuditEntry {
  return {
    id: String(r.id),
    workspaceId: String(r.workspace_id),
    userId: String(r.user_id),
    action: String(r.action),
    dataSource: (r.data_source as string | null) ?? null,
    decision: String(r.decision) as GovernanceDecision,
    reason: String(r.reason),
    contentHash: String(r.content_hash),
    createdAt: Number(r.created_at),
  };
}

/**
 * Writes an append-only entry to governance_audit (Migration 0118).
 *
 * Verbatim discipline (N1): `reason` is persisted without any truncation.
 * Tamper evidence (N10): content_hash = sha256(canonical-JSON(row)).
 */
export function writeGovernanceAudit(
  raw: RawDb,
  input: WriteGovernanceAuditInput,
): GovernanceAuditEntry {
  if (typeof input.workspaceId !== "string" || input.workspaceId.length === 0) {
    throw new Error("writeGovernanceAudit: workspaceId required");
  }
  if (typeof input.userId !== "string" || input.userId.length === 0) {
    throw new Error("writeGovernanceAudit: userId required");
  }
  if (typeof input.action !== "string" || input.action.length === 0) {
    throw new Error("writeGovernanceAudit: action required");
  }
  if (
    input.decision !== "allowed" &&
    input.decision !== "denied" &&
    input.decision !== "requires-approval"
  ) {
    throw new Error(
      "writeGovernanceAudit: decision must be allowed | denied | requires-approval",
    );
  }
  if (typeof input.reason !== "string" || input.reason.length === 0) {
    throw new Error("writeGovernanceAudit: reason required (N1 verbatim)");
  }

  const id = `GAU-${ulid()}`;
  const ts = nowMs();
  const contentHash = sha256hex({
    workspace_id: input.workspaceId,
    user_id: input.userId,
    action: input.action,
    data_source: input.dataSource ?? null,
    decision: input.decision,
    reason: input.reason,
    created_at: ts,
  });

  raw
    .prepare(
      `INSERT INTO governance_audit
         (id, workspace_id, user_id, action, data_source, decision, reason,
          content_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.workspaceId,
      input.userId,
      input.action,
      input.dataSource ?? null,
      input.decision,
      input.reason, // N1: verbatim
      contentHash,
      ts,
    );

  return {
    id,
    workspaceId: input.workspaceId,
    userId: input.userId,
    action: input.action,
    dataSource: input.dataSource ?? null,
    decision: input.decision,
    reason: input.reason,
    contentHash,
    createdAt: ts,
  };
}

export interface ListGovernanceAuditOpts {
  readonly userId?: string;
  readonly action?: string;
  readonly decision?: GovernanceDecision;
  readonly limit?: number;
}

/**
 * Reads the audit rows of a workspace (newest first).
 */
export function listGovernanceAudit(
  raw: RawDb,
  workspaceId: string,
  opts: ListGovernanceAuditOpts = {},
): GovernanceAuditEntry[] {
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("listGovernanceAudit: workspaceId required");
  }
  const where: string[] = ["workspace_id = ?"];
  const params: unknown[] = [workspaceId];
  if (opts.userId) {
    where.push("user_id = ?");
    params.push(opts.userId);
  }
  if (opts.action) {
    where.push("action = ?");
    params.push(opts.action);
  }
  if (opts.decision) {
    where.push("decision = ?");
    params.push(opts.decision);
  }
  const limit =
    opts.limit && Number.isFinite(opts.limit) && opts.limit > 0
      ? Math.floor(opts.limit)
      : 200;
  params.push(limit);

  const rows = raw
    .prepare(
      `SELECT * FROM governance_audit
        WHERE ${where.join(" AND ")}
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    )
    .all(...params) as Record<string, unknown>[];
  return rows.map(mapRow);
}
