/**
 * Drizzle schema for the generic API credential vault (migration 0100, ACL-1).
 *
 * Design decisions:
 *   - `api_credentials` stores one encrypted secret per (scope, provider).
 *     UNIQUE(scope_kind, scope_id, provider) — no duplicate possible.
 *   - `credential_access_log` is append-only (N8). NO FK on api_credentials —
 *     the audit remains even if the credential is deleted.
 *   - content_hash (N10): SHA-256 over the canonical JSON of the row (without the hash field itself).
 *   - encrypted_secret: AES-256-GCM via lib/security/credentials.ts. NEVER plaintext.
 *
 * N9: scope_kind + scope_id are the isolation anchor. Every query on
 * `api_credentials` MUST have both fields in the WHERE.
 */

import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// ─── Primary Credential-Vault ────────────────────────────────────────────────

export const apiCredentials = sqliteTable(
  "api_credentials",
  {
    id: text("id").primaryKey(),
    /** N9 scope anchor. 'org' | 'workspace'. */
    scopeKind: text("scope_kind").notNull(),
    /** org_id or workspace_id depending on scopeKind. */
    scopeId: text("scope_id").notNull(),
    /** Provider identifier: 'heygen' | 'openai' | 'anthropic' | 'stripe' | … */
    provider: text("provider").notNull(),
    /** 'api_key' | 'pat' | 'oauth' */
    credentialKind: text("credential_kind").notNull(),
    /** AES-256-GCM ciphertext. NEVER plaintext. */
    encryptedSecret: text("encrypted_secret").notNull(),
    /** Optional provider metadata as a JSON string (baseUrl, version, scope). */
    configJson: text("config_json"),
    /** Last successful validate timestamp (epoch-ms). */
    lastValidatedAt: integer("last_validated_at"),
    /** N10: SHA-256 tamper hash over canonical JSON. */
    contentHash: text("content_hash").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => ({
    byScopeIdx: index("idx_api_credentials_scope").on(table.scopeKind, table.scopeId),
    byProviderIdx: index("idx_api_credentials_provider").on(table.provider),
    uniqScopeProvider: uniqueIndex("uniq_api_credentials_scope_provider").on(
      table.scopeKind,
      table.scopeId,
      table.provider,
    ),
  }),
);

export type ApiCredentialRow = typeof apiCredentials.$inferSelect;
export type ApiCredentialInsert = typeof apiCredentials.$inferInsert;

// ─── Append-only Audit-Log ───────────────────────────────────────────────────

export const credentialAccessLog = sqliteTable(
  "credential_access_log",
  {
    id: text("id").primaryKey(),
    ts: integer("ts").notNull(),
    scopeKind: text("scope_kind").notNull(),
    scopeId: text("scope_id").notNull(),
    provider: text("provider").notNull(),
    userId: text("user_id").notNull(),
    /** 'put' | 'resolve' | 'reveal' | 'delete' */
    action: text("action").notNull(),
    /** Caller context, e.g. route path or vault method name. */
    source: text("source"),
    /** 1 = success, 0 = deny/error. */
    success: integer("success").notNull(),
    /** Success source ('workspace-cred' | 'org-fallback') or deny reason. */
    reason: text("reason"),
    /** N10: SHA-256 of this audit row. */
    contentHash: text("content_hash").notNull(),
  },
  (table) => ({
    byTsIdx: index("idx_credential_access_log_ts").on(table.ts),
    byScopeIdx: index("idx_credential_access_log_scope").on(table.scopeKind, table.scopeId),
    byUserIdx: index("idx_credential_access_log_user").on(table.userId, table.ts),
  }),
);

export type CredentialAccessLogRow = typeof credentialAccessLog.$inferSelect;
export type CredentialAccessLogInsert = typeof credentialAccessLog.$inferInsert;
