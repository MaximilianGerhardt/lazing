/**
 * Drizzle schema for the platform-global connector catalog (ACL-2 · 2026-05-24).
 *
 * Design:
 *   connector_catalog      — one row per external API provider.
 *   connector_capabilities — per-connector tool/endpoint definitions.
 *
 * D1 (platform-global, deliberate): NO workspace_id, NO org_id, NO user_id.
 * This catalog stores exclusively public, non-personal
 * API contracts (endpoints, JSON schemas, auth type, rate limits, version).
 *
 * N2 boundary (ADR-0006):
 *   Orthogonal to rag_chunks. rag_chunks = workspace-scoped user content.
 *   connector_catalog = public API documentation, no scope envelope needed.
 *   Lookup: by provider-name string, NOT semantic search (no RAG fallback).
 *
 * N10: content_hash = sha256 over the canonical JSON of the catalog row (without hash).
 *      Computed by lib/connectors/catalog.ts. Bootstrap sentinel possible.
 *
 * PII hard guard: lib/connectors/catalog.ts::assertNonSensitiveProfile() throws
 *   on workspace_id, org_id, user_id, email, token, secret, api_key values,
 *   credential. upsertConnectorProfile calls this guard before every write —
 *   the ingestion path structurally cannot write sensitive data.
 */

import { index, integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

// ---------------------------------------------------------------------------
// connector_catalog — one row per external API provider
// ---------------------------------------------------------------------------

export const connectorCatalog = sqliteTable(
  "connector_catalog",
  {
    /** ULID with CONN- prefix for visual distinction. */
    id: text("id").primaryKey(),

    /**
     * Unique machine-readable provider slug, e.g. 'heygen', 'openai', 'stripe'.
     * This is the primary lookup key — no workspace_id or org_id scope.
     */
    provider: text("provider").notNull().unique(),

    /** Human-readable name, e.g. 'HeyGen Video API'. */
    displayName: text("display_name").notNull(),

    /** Short description of what the API does (public, non-sensitive). */
    description: text("description"),

    /**
     * Authentication mechanism (kind only, never a value):
     *   'api_key' | 'oauth' | 'pat' | 'none' | 'custom'
     */
    authKind: text("auth_kind").notNull().default("api_key"),

    /** Public base URL, e.g. 'https://api.heygen.com'. */
    baseUrl: text("base_url"),

    /** Semver or date-string API version, e.g. '2024-01-01' or 'v2'. */
    apiVersion: text("api_version"),

    /** Link to official public documentation. */
    docsUrl: text("docs_url"),

    /**
     * How this record was created:
     *   'mcp-discovery' | 'doc-research' | 'manual'
     */
    source: text("source").notNull().default("manual"),

    /**
     * Unix-ms timestamp of last successful external validation.
     * NULL = never validated.
     */
    validatedAt: integer("validated_at"),

    /**
     * N10: sha256 over canonical JSON of this row (sans content_hash).
     * Computed by lib/connectors/catalog.ts::hashCatalogRow().
     * Bootstrap sentinel for seed rows: "bootstrap:0101:<provider>".
     */
    contentHash: text("content_hash").notNull().default(""),

    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => ({
    byProvider: index("idx_connector_catalog_provider").on(table.provider),
    bySource: index("idx_connector_catalog_source").on(
      table.source,
      table.validatedAt,
    ),
  }),
);

export type ConnectorCatalogRow = typeof connectorCatalog.$inferSelect;
export type ConnectorCatalogInsert = typeof connectorCatalog.$inferInsert;

// ---------------------------------------------------------------------------
// connector_capabilities — per-connector tool/endpoint definitions
// ---------------------------------------------------------------------------

export const connectorCapabilities = sqliteTable(
  "connector_capabilities",
  {
    /** ULID with CAP- prefix. */
    id: text("id").primaryKey(),

    /**
     * FK → connector_catalog.id.
     * ON DELETE CASCADE: removing a connector removes all its capabilities.
     */
    connectorId: text("connector_id").notNull(),

    /**
     * Short machine-readable capability name, e.g. 'render_video', 'list_avatars'.
     * Unique per connector.
     */
    name: text("name").notNull(),

    /** Human-readable description of what this capability does. */
    description: text("description"),

    /**
     * JSON Schema (as JSON text) for the capability input.
     * Mirrors McpTool.inputSchema from lib-v1/mcp/tool-registry.ts.
     */
    inputSchemaJson: text("input_schema_json"),

    /**
     * JSON Schema (as JSON text) for the capability output (where known).
     */
    outputSchemaJson: text("output_schema_json"),

    /**
     * Canonical MCP tool name if exposed via MCP.
     * Format: 'mcp__<serverName>__<toolName>'
     * NULL = not an MCP tool (REST-only or GraphQL-only endpoint).
     */
    mcpToolName: text("mcp_tool_name"),

    /**
     * 1 = required for the connector to be considered functional.
     * 0 = optional / supplemental.
     */
    required: integer("required", { mode: "boolean" }).notNull().default(false),
  },
  (table) => ({
    byConnector: index("idx_connector_capabilities_connector").on(
      table.connectorId,
      table.name,
    ),
    byMcp: index("idx_connector_capabilities_mcp").on(table.mcpToolName),
    uniqueConnectorName: unique("uq_connector_capabilities_connector_name").on(
      table.connectorId,
      table.name,
    ),
  }),
);

export type ConnectorCapabilityRow = typeof connectorCapabilities.$inferSelect;
export type ConnectorCapabilityInsert = typeof connectorCapabilities.$inferInsert;

// ---------------------------------------------------------------------------
// connector_catalog_audit — append-only N8 trace of catalog mutations (ME-4)
//
// Best-effort (NOT fail-closed) — the catalog is non-sensitive (ADR-0006), so
// a failed audit write must not abort the catalog write. N8 still requires a
// "why/when did this change?" row to exist.
// ---------------------------------------------------------------------------

export const connectorCatalogAudit = sqliteTable(
  "connector_catalog_audit",
  {
    /** crypto.randomUUID with CCAUD- prefix. */
    id: text("id").primaryKey(),
    /** Unix-ms timestamp of the mutation. */
    ts: integer("ts").notNull(),
    /** 'upsert' | 'delete'. */
    action: text("action").notNull(),
    /** userId, or 'system' for SOP/automated writes. */
    actor: text("actor").notNull().default("system"),
    /** Provider slug that was mutated. */
    provider: text("provider").notNull(),
    /** Catalog row content_hash BEFORE the mutation (NULL for first insert). */
    oldHash: text("old_hash"),
    /** Catalog row content_hash AFTER the mutation (NULL for delete). */
    newHash: text("new_hash"),
    /** N10: sha256 over canonical JSON of this audit row (sans content_hash). */
    contentHash: text("content_hash").notNull().default(""),
  },
  (table) => ({
    byProvider: index("idx_connector_catalog_audit_provider").on(
      table.provider,
      table.ts,
    ),
    byTs: index("idx_connector_catalog_audit_ts").on(table.ts),
  }),
);

export type ConnectorCatalogAuditRow = typeof connectorCatalogAudit.$inferSelect;
export type ConnectorCatalogAuditInsert = typeof connectorCatalogAudit.$inferInsert;

export const CONNECTOR_AUDIT_ACTIONS = ["upsert", "delete"] as const;
export type ConnectorAuditAction = (typeof CONNECTOR_AUDIT_ACTIONS)[number];

// ---------------------------------------------------------------------------
// Auth kind closed enum (mirrors SQL CHECK constraint)
// ---------------------------------------------------------------------------

export const CONNECTOR_AUTH_KINDS = [
  "api_key",
  "oauth",
  "pat",
  "none",
  "custom",
] as const;
export type ConnectorAuthKind = (typeof CONNECTOR_AUTH_KINDS)[number];

// ---------------------------------------------------------------------------
// Source closed enum (mirrors SQL CHECK constraint)
// ---------------------------------------------------------------------------

export const CONNECTOR_SOURCES = [
  "mcp-discovery",
  "doc-research",
  "manual",
] as const;
export type ConnectorSource = (typeof CONNECTOR_SOURCES)[number];
