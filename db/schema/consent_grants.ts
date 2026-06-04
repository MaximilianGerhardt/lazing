/**
 * Drizzle schema for Lane G governance (migration 0118).
 *
 *   - consent_grants    — owner directive §13.2 (opt-in · pause/stop · review)
 *   - source_traces     — raw/derived provenance
 *   - governance_audit  — N8 trace-as-evidence
 *
 * Source: master briefing §13.2 + §7.2 + master context §6 stage 1 +
 *         integration plan §4 Lane G. Lane G is the FUNDAMENTAL lane —
 *         all other lanes (connector-invoke, spawn, plan-execute,
 *         persist-belief, …) hang on the gate contract that these tables
 *         persist.
 *
 * Substrate discipline (identical to workspace_beliefs.ts):
 *   - N1:  reason / reason_text / note verbatim — NO .slice in the
 *          application layer; the schema has no TEXT(N) lengths.
 *   - N4:  purely additive; no existing table touched.
 *   - N9:  workspaceId = ManifestCoord scope. Deliberately NO hard FK on
 *          workspaces (orphan scope rows tolerated at runtime — analogous
 *          to 0113/0111/0112).
 *   - N10: content_hash per learning-bearing row.
 *
 * Append-only discipline is coded in the migration as a trigger (RAISE
 * ABORT). Drizzle does not know these triggers; the test suite verifies them
 * against the real migration SQL (see lib/governance/__tests__).
 */

import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const consentGrants = sqliteTable(
  "consent_grants",
  {
    id: text("id").primaryKey(),
    /** ManifestCoord scope (N9), no hard FK. */
    workspaceId: text("workspace_id").notNull(),
    /** Die betroffene Person — §13.2 „Review durch betroffene Person". */
    userId: text("user_id").notNull(),
    /**
     * Datenquelle: 'whatsapp' | 'telegram' | 'voice' | 'meeting' | 'email'
     * | 'browser-shadow' | 'screen-capture' | 'keystroke-capture'
     * | 'workspace-derive'.
     */
    dataSource: text("data_source").notNull(),
    /** ConsentLevel. */
    level: text("level").notNull(),
    /** Optionales JSON: { timeWindow?, dataMin? }. */
    scopeJson: text("scope_json"),
    /** §13.2 verbatim Begründung (N1). */
    reasonText: text("reason_text").notNull(),
    grantedAt: integer("granted_at").notNull(),
    /** Nullable; gesetzt = Grant zurückgenommen. */
    revokedAt: integer("revoked_at"),
    /** N10 Tamper-Evidenz. */
    contentHash: text("content_hash").notNull(),
  },
  (t) => ({
    byWs: index("idx_consent_grants_ws").on(
      t.workspaceId,
      t.userId,
      t.dataSource,
    ),
    byWsUser: index("idx_consent_grants_ws_user").on(t.workspaceId, t.userId),
    byGrantedAt: index("idx_consent_grants_granted_at").on(t.grantedAt),
  }),
);

export const sourceTraces = sqliteTable(
  "source_traces",
  {
    id: text("id").primaryKey(),
    /** ManifestCoord-Scope (N9). */
    workspaceId: text("workspace_id").notNull(),
    dataSource: text("data_source").notNull(),
    /** Optional external ID (whatsapp-message-id, …). */
    externalId: text("external_id"),
    /** N10 — sha256 over the original content. */
    contentHash: text("content_hash").notNull(),
    /** Nullable; soft-FK on source_traces.id (derive chain). */
    derivedFromTrace: text("derived_from_trace"),
    /** ms-Epoch. */
    rawRetentionUntil: integer("raw_retention_until"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => ({
    byWs: index("idx_source_traces_ws").on(
      t.workspaceId,
      t.dataSource,
      t.createdAt,
    ),
    byHash: index("idx_source_traces_hash").on(t.contentHash),
    byDerivedFrom: index("idx_source_traces_derived_from").on(
      t.derivedFromTrace,
    ),
  }),
);

export const governanceAudit = sqliteTable(
  "governance_audit",
  {
    id: text("id").primaryKey(),
    /** ManifestCoord-Scope (N9). */
    workspaceId: text("workspace_id").notNull(),
    userId: text("user_id").notNull(),
    action: text("action").notNull(),
    dataSource: text("data_source"),
    decision: text("decision").notNull(),
    /** VERBATIM N1. */
    reason: text("reason").notNull(),
    /** N10. */
    contentHash: text("content_hash").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => ({
    byWs: index("idx_governance_audit_ws").on(t.workspaceId, t.createdAt),
    byWsUser: index("idx_governance_audit_ws_user").on(
      t.workspaceId,
      t.userId,
      t.createdAt,
    ),
    byAction: index("idx_governance_audit_action").on(t.action, t.createdAt),
  }),
);

export type ConsentGrantRow = typeof consentGrants.$inferSelect;
export type ConsentGrantInsert = typeof consentGrants.$inferInsert;
export type SourceTraceRow = typeof sourceTraces.$inferSelect;
export type SourceTraceInsert = typeof sourceTraces.$inferInsert;
export type GovernanceAuditRow = typeof governanceAudit.$inferSelect;
export type GovernanceAuditInsert = typeof governanceAudit.$inferInsert;
