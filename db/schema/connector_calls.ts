/**
 * Drizzle schema for connector call approvals + audit (migration 0105, ACL-5-C).
 *
 * Design decisions:
 *   D1  Trust DEFAULT 'ask' — fail-closed toward confirmation.
 *       'auto' must be set explicitly via setTrust(). Never auto by default.
 *   D2  UNIQUE(scope_kind, scope_id, provider) — one trust entry per scope+provider.
 *   D3  connector_call_audit: payload_hash instead of the raw payload (N8-safe, no PII/secret).
 *   D4  content_hash N10: sha256 over the canonical JSON of each row without this field.
 *   D5  No FK from connector_call_audit to connector_call_approvals —
 *       the audit log survives trust changes/deletes.
 *
 * N9: scope_kind + scope_id are required anchors for all queries.
 * N10: content_hash (sha256 canonical JSON) on both tables.
 * N8: connector_call_audit is append-only evidence.
 */

import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// ─── connector_call_approvals — trust level per connector+scope ──────────────

export const connectorCallApprovals = sqliteTable(
  "connector_call_approvals",
  {
    id: text("id").primaryKey(),

    /**
     * N9 scope anchor.
     * 'org' | 'workspace'
     */
    scopeKind: text("scope_kind").notNull(),

    /**
     * org_id or workspace_id depending on scopeKind.
     */
    scopeId: text("scope_id").notNull(),

    /**
     * Provider identifier from connector_catalog, e.g. 'heygen', 'openai'.
     */
    provider: text("provider").notNull(),

    /**
     * Trust level:
     *   'ask'  (default, fail-closed) — every call needs explicit approval.
     *   'auto' — the connector may be called without manual confirmation.
     *            Active only after an explicit setTrust('auto') by the owner.
     */
    trust: text("trust").notNull().default("ask"),

    /**
     * Who set the trust level (userId or 'system').
     */
    setBy: text("set_by").notNull().default("system"),

    /**
     * Optional reason (N8 traceability).
     */
    reason: text("reason"),

    /**
     * N10: sha256 over the canonical JSON of this row (without this field).
     */
    contentHash: text("content_hash").notNull().default(""),

    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => ({
    byScopeIdx: index("idx_connector_call_approvals_scope").on(
      table.scopeKind,
      table.scopeId,
    ),
    byProviderIdx: index("idx_connector_call_approvals_provider").on(
      table.provider,
    ),
    uniqScopeProvider: uniqueIndex("uq_connector_call_approvals_scope_provider").on(
      table.scopeKind,
      table.scopeId,
      table.provider,
    ),
  }),
);

export type ConnectorCallApprovalRow = typeof connectorCallApprovals.$inferSelect;
export type ConnectorCallApprovalInsert = typeof connectorCallApprovals.$inferInsert;

/** Closed enum for trust levels (mirrors SQL CHECK). */
export const CONNECTOR_TRUST_VALUES = ["ask", "auto"] as const;
export type ConnectorTrust = (typeof CONNECTOR_TRUST_VALUES)[number];

/** Closed enum for scope kinds (mirrors api_credentials convention). */
export const CONNECTOR_SCOPE_KINDS = ["org", "workspace"] as const;
export type ConnectorScopeKind = (typeof CONNECTOR_SCOPE_KINDS)[number];

// ─── connector_call_audit — Append-only N8/N10 Audit-Log ────────────────────

export const connectorCallAudit = sqliteTable(
  "connector_call_audit",
  {
    id: text("id").primaryKey(),

    /** Zeitstempel des Events (epoch-ms). */
    ts: integer("ts").notNull(),

    /** N9 scope anchor. 'org' | 'workspace'. */
    scopeKind: text("scope_kind").notNull(),

    /** org_id or workspace_id depending on scopeKind. */
    scopeId: text("scope_id").notNull(),

    /** Provider from connector_catalog. */
    provider: text("provider").notNull(),

    /** Capability name from connector_capabilities.name. */
    capability: text("capability").notNull(),

    /** Calling user (userId or 'system'). */
    userId: text("user_id").notNull(),

    /**
     * Phase of the audit event:
     *   'preview'  — call presented to the owner (S5).
     *   'approve'  — owner approved (S6).
     *   'invoke'   — executed (live=1) or dry-run (live=0).
     *   'deny'     — blocked by a gate (S4/S5/S6).
     *   'dry-run'  — LAZYOS_CONNECTOR_LIVE=off, no network.
     */
    phase: text("phase").notNull(),

    /**
     * 1 = real network call; 0 = dry-run/simulation or non-invoke phase.
     */
    live: integer("live").notNull().default(0),

    /**
     * sha256 over the canonical JSON of the call payload — NEVER the raw payload.
     * NULL if no payload is known at the time of the event.
     * Prevents secrets/PII from landing in the audit log (D3).
     */
    payloadHash: text("payload_hash"),

    /**
     * Short human-readable summary of the result.
     * e.g. 'status=200 duration=340ms' or 'dry-run: mocked'.
     * NEVER raw API response bodies.
     */
    resultSummary: text("result_summary"),

    /**
     * 1 = phase succeeded; 0 = phase failed/deny.
     */
    success: integer("success").notNull().default(0),

    /** Reason for deny or error; NULL on success. */
    reason: text("reason"),

    /**
     * N10: sha256 over the canonical JSON of this row (without this field).
     */
    contentHash: text("content_hash").notNull().default(""),
  },
  (table) => ({
    byTsIdx: index("idx_connector_call_audit_ts").on(table.ts),
    byScopeIdx: index("idx_connector_call_audit_scope").on(
      table.scopeKind,
      table.scopeId,
      table.ts,
    ),
    byProviderIdx: index("idx_connector_call_audit_provider").on(
      table.provider,
      table.ts,
    ),
    byUserIdx: index("idx_connector_call_audit_user").on(
      table.userId,
      table.ts,
    ),
  }),
);

export type ConnectorCallAuditRow = typeof connectorCallAudit.$inferSelect;
export type ConnectorCallAuditInsert = typeof connectorCallAudit.$inferInsert;

/** Closed enum for audit phases (mirrors SQL CHECK). */
export const CONNECTOR_CALL_PHASES = [
  "preview",
  "approve",
  "invoke",
  "deny",
  "dry-run",
] as const;
export type ConnectorCallPhase = (typeof CONNECTOR_CALL_PHASES)[number];
