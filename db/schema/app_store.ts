/**
 * Drizzle schema for the App-Store / MCP lifecycle foundation (C4 · 2026-05-25).
 *
 * Tables:
 *   app_manifests      — one row per registered app (manifest + signature status)
 *   app_installs       — install/disable/uninstall records per app+scope
 *   app_install_audit  — append-only N8 trace of all lifecycle actions
 *
 * ADR: docs/adr/0007-app-store-mcp-lifecycle.md
 *
 * Design:
 *   NON-DESTRUCTIVE. "Install" = record in app_installs.
 *   NO real MCP spawn, NO OAuth connect, NO process start.
 *   The real activation path is R3-gated (PHASE2_APP_ACTIVATE).
 *
 *   app_manifests does NOT duplicate connector_catalog.
 *   kind='mcp-server' manifests MAY mirror capabilities into connector_catalog
 *   after install (via lib/connectors/catalog.ts upsertConnectorProfile),
 *   but that is an opt-in bridge — not an automatic coupling.
 *
 * PII-Hard-Guard:
 *   lib/appstore/manifest.ts::assertNonSensitiveManifest() is called FIRST
 *   in upsertManifest(). Forbidden keys (workspace_id, user_id, email,
 *   token, secret, api_key, credential, etc.) throw APP_STORE_PII_GUARD.
 *
 * N8:  app_install_audit is append-only — never UPDATE/DELETE.
 * N10: content_hash = sha256 over canonical JSON (sans content_hash).
 *      Written by lib/appstore/registry.ts at every write.
 */

import { index, integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

// ---------------------------------------------------------------------------
// app_manifests — one row per registered app / plugin
// ---------------------------------------------------------------------------

export const appManifests = sqliteTable(
  "app_manifests",
  {
    /** ULID with AMANI- prefix for visual distinction. */
    id: text("id").primaryKey(),

    /**
     * Unique machine-readable app identifier.
     * Regex: ^[a-z][a-z0-9._-]{1,127}$
     * Examples: 'com.example.my-mcp-server', 'lazing.skill-pack.research'
     */
    appId: text("app_id").notNull().unique(),

    /** Human-readable display name. */
    name: text("name").notNull(),

    /** Semver version string, e.g. '1.2.3' or '0.1.0-alpha'. */
    version: text("version").notNull(),

    /** Short description (public, non-sensitive). */
    description: text("description"),

    /** Publisher name or organization (non-sensitive metadata only). */
    publisher: text("publisher"),

    /**
     * App kind — drives the lifecycle branch:
     *   'mcp-server'  — declares MCP tools; lifecycle leads to PHASE2_APP_ACTIVATE
     *   'connector'   — REST/GraphQL connector; may mirror to connector_catalog
     *   'skill-pack'  — bundle of lazing skills
     */
    kind: text("kind", { enum: ["mcp-server", "connector", "skill-pack"] }).notNull(),

    /**
     * Full manifest JSON (declarative, serialized TEXT).
     * Declared capabilities, requested credential scopes, config schema.
     * PII-Hard-Guard enforced at write time — no secrets/tokens/credentials.
     */
    manifestJson: text("manifest_json").notNull(),

    /**
     * Optional cryptographic signature over canonical manifest_json.
     * NULL = submitted without a signature.
     * Scheme: ed25519 over sha256(canonical-manifest-json).
     * See lib/appstore/signature.ts for verification logic.
     */
    signature: text("signature"),

    /**
     * Signature verification status:
     *   'unsigned'   — no signature field present
     *   'valid'      — signature verified against a known pubkey
     *   'invalid'    — signature present but verification failed
     *   'unverified' — signature present but no pubkey available
     */
    signatureStatus: text("signature_status", {
      enum: ["unsigned", "valid", "invalid", "unverified"],
    })
      .notNull()
      .default("unsigned"),

    /**
     * Origin of this manifest record:
     *   'builtin'  — shipped with the platform
     *   'local'    — loaded from local filesystem (operator-installed)
     *   'registry' — fetched from a remote app registry
     */
    source: text("source", { enum: ["builtin", "local", "registry"] })
      .notNull()
      .default("local"),

    /**
     * N10: sha256 over canonical JSON of this row (sans content_hash).
     * Written by lib/appstore/registry.ts::hashManifestRow().
     */
    contentHash: text("content_hash").notNull().default(""),

    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => ({
    byKind: index("idx_app_manifests_kind").on(table.kind, table.source),
    bySigStatus: index("idx_app_manifests_sig_status").on(table.signatureStatus),
  }),
);

export type AppManifestRow = typeof appManifests.$inferSelect;
export type AppManifestInsert = typeof appManifests.$inferInsert;

// ---------------------------------------------------------------------------
// app_installs — install records per app+scope
// ---------------------------------------------------------------------------

export const appInstalls = sqliteTable(
  "app_installs",
  {
    /** ULID with AINST- prefix. */
    id: text("id").primaryKey(),

    /**
     * Logical FK → app_manifests.app_id (via app_id string, not internal id).
     * ON DELETE CASCADE: removing a manifest removes all its install records.
     */
    appId: text("app_id")
      .notNull()
      .references(() => appManifests.appId, { onDelete: "cascade" }),

    /**
     * Scope kind:
     *   'org'       — installed for an entire org
     *   'workspace' — installed for a specific workspace
     */
    scopeKind: text("scope_kind", { enum: ["org", "workspace"] }).notNull(),

    /** ID of the org or workspace this install belongs to. */
    scopeId: text("scope_id").notNull(),

    /**
     * Current install status:
     *   'installed' — active; eligible for PHASE2_APP_ACTIVATE when R3 is unlocked
     *   'disabled'  — installed but deactivated
     *   'pending'   — install requested but not yet confirmed
     */
    status: text("status", { enum: ["installed", "disabled", "pending"] })
      .notNull()
      .default("pending"),

    /** Actor who performed the install (userId or 'system'). */
    installedBy: text("installed_by").notNull().default("system"),

    /** Unix-ms timestamp of the install action. */
    installedAt: integer("installed_at").notNull(),

    /**
     * N10: sha256 over canonical JSON of this install row (sans content_hash).
     */
    contentHash: text("content_hash").notNull().default(""),
  },
  (table) => ({
    byScope: index("idx_app_installs_scope").on(
      table.scopeKind,
      table.scopeId,
      table.status,
    ),
    byApp: index("idx_app_installs_app").on(table.appId, table.status),
    uniqueAppScope: unique("uq_app_installs_app_scope").on(
      table.appId,
      table.scopeKind,
      table.scopeId,
    ),
  }),
);

export type AppInstallRow = typeof appInstalls.$inferSelect;
export type AppInstallInsert = typeof appInstalls.$inferInsert;

// ---------------------------------------------------------------------------
// app_install_audit — append-only N8 trace of all lifecycle actions
//
// NEVER UPDATE or DELETE from this table. It is the tamper-evident
// audit trail. content_hash covers all fields (N10).
// ---------------------------------------------------------------------------

export const appInstallAudit = sqliteTable(
  "app_install_audit",
  {
    /** ULID with AIAUD- prefix. */
    id: text("id").primaryKey(),

    /** Unix-ms timestamp of the action. */
    ts: integer("ts").notNull(),

    /** The app this action concerns. */
    appId: text("app_id").notNull(),

    /**
     * Scope label: '<scope_kind>:<scope_id>'.
     * Example: 'workspace:ws-abc123' or 'org:org-xyz789'.
     */
    scope: text("scope").notNull(),

    /** Actor who triggered the action (userId or 'system'). */
    actor: text("actor").notNull().default("system"),

    /**
     * Lifecycle action:
     *   'install'   — install record created
     *   'enable'    — disabled → installed transition
     *   'disable'   — installed → disabled transition
     *   'uninstall' — install record removed
     *   'verify'    — signature/manifest re-verification triggered
     */
    action: text("action", {
      enum: ["install", "enable", "disable", "uninstall", "verify"],
    }).notNull(),

    /** 1 = action succeeded; 0 = failed (reason explains why). */
    success: integer("success", { mode: "boolean" }).notNull().default(true),

    /** Human-readable reason string (required on failure, optional on success). */
    reason: text("reason"),

    /**
     * N10: sha256 over canonical JSON of this audit row (sans content_hash).
     */
    contentHash: text("content_hash").notNull().default(""),
  },
  (table) => ({
    byApp: index("idx_app_install_audit_app").on(table.appId, table.ts),
    byScope: index("idx_app_install_audit_scope").on(table.scope, table.ts),
    byTs: index("idx_app_install_audit_ts").on(table.ts),
  }),
);

export type AppInstallAuditRow = typeof appInstallAudit.$inferSelect;
export type AppInstallAuditInsert = typeof appInstallAudit.$inferInsert;

// ---------------------------------------------------------------------------
// Closed enum exports (mirrors SQL CHECK constraints)
// ---------------------------------------------------------------------------

export const APP_KINDS = ["mcp-server", "connector", "skill-pack"] as const;
export type AppKind = (typeof APP_KINDS)[number];

export const APP_SOURCES = ["builtin", "local", "registry"] as const;
export type AppSource = (typeof APP_SOURCES)[number];

export const APP_SIGNATURE_STATUSES = [
  "unsigned",
  "valid",
  "invalid",
  "unverified",
] as const;
export type AppSignatureStatus = (typeof APP_SIGNATURE_STATUSES)[number];

export const APP_INSTALL_STATUSES = ["installed", "disabled", "pending"] as const;
export type AppInstallStatus = (typeof APP_INSTALL_STATUSES)[number];

export const APP_INSTALL_ACTIONS = [
  "install",
  "enable",
  "disable",
  "uninstall",
  "verify",
] as const;
export type AppInstallAction = (typeof APP_INSTALL_ACTIONS)[number];

export const APP_SCOPE_KINDS = ["org", "workspace"] as const;
export type AppScopeKind = (typeof APP_SCOPE_KINDS)[number];
