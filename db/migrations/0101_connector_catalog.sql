-- ============================================================
-- 0101_connector_catalog.sql — Platform-Global Connector Catalog (ACL-2)
--
-- Datum:  2026-05-24
-- Autor:  Claude Code (ACL-2 Connector-Catalog sprint)
-- ADR:    docs/adr/0006-connector-catalog-n2-demarcation.md
-- Plan:   docs/plans/2026-05-24_api-connector-layer.md D1
--
-- Tables created:
--   connector_catalog       — platform-global registry of public API contracts
--   connector_capabilities  — per-connector capability/tool definitions
--
-- Design decisions (D1):
--   Platform-global intentionally: NO workspace_id, NO org_id, NO user_id.
--   This catalog stores ONLY non-sensitive public API contracts:
--     - endpoint URLs, JSON schemas, auth kind (not auth values), rate limits,
--       API version, docs references.
--   It is NOT a RAG fallback. Lookup is always by provider name (no semantic
--   search). The application-layer Hard-Guard (assertNonSensitiveProfile) is the
--   structural enforcement of this demarcation — see lib/connectors/catalog.ts.
--
-- N2-Abgrenzung (ADR-0006):
--   connector_catalog is orthogonal to rag_chunks. rag_chunks carry
--   workspace-scoped user content with a ManifestCoord scope envelope.
--   connector_catalog carries public, non-personenbezogene API documentation.
--   No workspace_id or org_id column exists — they cannot be written by design.
--
-- N10: content_hash = sha256 over canonical JSON of the catalog row (sans
--      content_hash itself). Computed by lib/connectors/catalog.ts at write time.
--      Bootstrap sentinel for seed rows (format "bootstrap:0101:<provider>")
--      identical to the pattern in 0098_permission.sql and 0099_sops.sql.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS throughout.
-- ============================================================

-- ─────────────────────────────────────────────────────────────
-- 1. connector_catalog — one row per external API provider
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS connector_catalog (
  -- Stable identifier; application uses ULID with CONN- prefix.
  id              TEXT     PRIMARY KEY,

  -- Unique machine-readable provider slug, e.g. 'heygen', 'openai', 'stripe'.
  -- Used as the lookup key — never workspace_id or org_id.
  provider        TEXT     NOT NULL,

  -- Human-readable name, e.g. 'HeyGen Video API'.
  display_name    TEXT     NOT NULL,

  -- Short description of what the API does (public, non-sensitive).
  description     TEXT,

  -- Authentication mechanism for this API (enum-like string).
  --   'api_key'  — Bearer token / X-API-Key style
  --   'oauth'    — OAuth 2.0 (any grant type)
  --   'pat'      — Personal Access Token (GitHub-style)
  --   'none'     — public / no auth required
  --   'custom'   — provider-specific mechanism; see docs_url
  -- NOTE: This records the AUTH KIND only, never an auth VALUE.
  auth_kind       TEXT     NOT NULL DEFAULT 'api_key'
                           CHECK (auth_kind IN ('api_key','oauth','pat','none','custom')),

  -- Public base URL for the API, e.g. 'https://api.heygen.com'.
  base_url        TEXT,

  -- Semver or date-string API version, e.g. '2024-01-01' or 'v2'.
  api_version     TEXT,

  -- Link to official public documentation.
  docs_url        TEXT,

  -- How this record was created/validated:
  --   'mcp-discovery'  — discovered via enumerateMcpTools() / stdio JSON-RPC
  --   'doc-research'   — scraped / read from public docs
  --   'manual'         — entered by operator
  source          TEXT     NOT NULL DEFAULT 'manual'
                           CHECK (source IN ('mcp-discovery','doc-research','manual')),

  -- Unix-ms timestamp of last successful external validation (schema check,
  -- version ping). NULL = never validated.
  validated_at    INTEGER,

  -- N10: sha256 over canonical JSON of this row (sans content_hash).
  -- Written by application layer (lib/connectors/catalog.ts hashCatalogRow).
  -- Bootstrap sentinel format: "bootstrap:0101:<provider>"
  content_hash    TEXT     NOT NULL DEFAULT '',

  created_at      INTEGER  NOT NULL,
  updated_at      INTEGER  NOT NULL,

  -- Provider slug must be unique across the platform-global catalog.
  UNIQUE (provider)
);

CREATE INDEX IF NOT EXISTS idx_connector_catalog_provider
  ON connector_catalog (provider);

CREATE INDEX IF NOT EXISTS idx_connector_catalog_source
  ON connector_catalog (source, validated_at);

-- ─────────────────────────────────────────────────────────────
-- 2. connector_capabilities — per-connector tool/endpoint definitions
--
--    One row per named capability (maps to an MCP tool, REST endpoint,
--    or GraphQL operation). Replaced atomically on upsert of the parent
--    connector profile (DELETE + INSERT in a transaction).
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS connector_capabilities (
  id              TEXT     PRIMARY KEY,

  -- FK → connector_catalog.id. CASCADE ensures capabilities are removed
  -- when the parent connector is deleted.
  connector_id    TEXT     NOT NULL
                           REFERENCES connector_catalog(id) ON DELETE CASCADE,

  -- Short machine-readable name, e.g. 'render_video', 'list_avatars'.
  name            TEXT     NOT NULL,

  -- Human-readable description of what this capability does.
  description     TEXT,

  -- JSON Schema (as JSON text) for the capability input.
  -- Matches McpTool.inputSchema from lib-v1/mcp/tool-registry.ts.
  input_schema_json  TEXT,

  -- JSON Schema (as JSON text) for the capability output (where known).
  output_schema_json TEXT,

  -- Canonical MCP tool name if this capability is exposed via MCP.
  -- Format: 'mcp__<serverName>__<toolName>' (lib-v1/mcp/tool-registry.ts convention).
  -- NULL = not an MCP tool (REST-only or GraphQL-only endpoint).
  mcp_tool_name   TEXT,

  -- 1 = this capability is required for the connector to be considered functional;
  -- 0 = optional/supplemental capability.
  required        INTEGER  NOT NULL DEFAULT 0
                           CHECK (required IN (0, 1)),

  -- A connector_id cannot have two capabilities with the same name.
  UNIQUE (connector_id, name)
);

CREATE INDEX IF NOT EXISTS idx_connector_capabilities_connector
  ON connector_capabilities (connector_id, name);

CREATE INDEX IF NOT EXISTS idx_connector_capabilities_mcp
  ON connector_capabilities (mcp_tool_name)
  WHERE mcp_tool_name IS NOT NULL;
