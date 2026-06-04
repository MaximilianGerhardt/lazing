-- ============================================================
-- 0108_app_manifests.sql — App-Store / MCP-Lifecycle Foundation (C4)
--
-- Datum:  2026-05-25
-- Autor:  Claude Code (Batch 7d App-Store / MCP-Lifecycle sprint)
-- ADR:    docs/adr/0007-app-store-mcp-lifecycle.md
--
-- Tables created:
--   app_manifests      — one row per registered app (manifest + signature status)
--   app_installs       — install/disable/uninstall records per app+scope
--   app_install_audit  — append-only N8 trace of all lifecycle actions
--
-- Design decisions:
--   NON-DESTRUCTIVE: "install" = Registrierung/Aktivierung im Katalog,
--   KEIN echter Prozess-Spawn, KEIN OAuth-Connect, KEIN MCP-Server-Start.
--   Echter MCP-Server-Start / OAuth-Connect ist R3-gated (PHASE2_APP_ACTIVATE).
--
--   app_manifests deliberately does NOT duplicate connector_catalog.
--   When a kind='mcp-server' manifest is installed, the registry layer
--   MAY mirror declared capabilities into connector_catalog (via
--   upsertConnectorProfile) — but these are two separate tables serving
--   different purposes:
--     connector_catalog = public API contract registry (platform-global)
--     app_manifests     = versioned, signed manifest + lifecycle state
--
-- N8:  app_install_audit is append-only — no UPDATE or DELETE ever.
-- N10: content_hash = sha256 over canonical JSON (application layer).
-- N6:  Signature verification is deterministic (node:crypto verify).
--      Without pubkey → status 'unverified'. Invalid sig → 'invalid'.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS
--             throughout. Runs safely multiple times.
-- ============================================================

-- ─────────────────────────────────────────────────────────────
-- 1. app_manifests — one row per registered app / plugin
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS app_manifests (
  -- Stable internal ID; application uses ULID with AMANI- prefix.
  id              TEXT     PRIMARY KEY,

  -- Unique machine-readable app identifier, e.g. 'com.example.my-mcp-server'.
  -- Regex enforced by application layer: ^[a-z][a-z0-9._-]{1,127}$
  app_id          TEXT     NOT NULL,

  -- Human-readable display name.
  name            TEXT     NOT NULL,

  -- Semver version string, e.g. '1.2.3' or '0.1.0-alpha'.
  version         TEXT     NOT NULL,

  -- Short description (public, non-sensitive — PII guard enforced at write).
  description     TEXT,

  -- Publisher name or organization (non-sensitive metadata only).
  publisher       TEXT,

  -- App kind — drives the lifecycle branch:
  --   'mcp-server'  — declares MCP tools; lifecycle leads to PHASE2_APP_ACTIVATE
  --   'connector'   — REST/GraphQL connector; mirrors to connector_catalog
  --   'skill-pack'  — bundle of lazing skills
  kind            TEXT     NOT NULL
                           CHECK (kind IN ('mcp-server','connector','skill-pack')),

  -- Full manifest JSON (declarative, serialized TEXT).
  -- Contains declared capabilities, requested credential scopes, config schema.
  -- MUST NOT contain secrets/tokens/credentials — PII guard enforced at write.
  manifest_json   TEXT     NOT NULL,

  -- Optional cryptographic signature over canonical manifest_json.
  -- NULL = app was submitted without a signature.
  signature       TEXT,

  -- Signature verification status:
  --   'unsigned'   — no signature field present in submission
  --   'valid'      — signature verified against a known pubkey
  --   'invalid'    — signature present but verification failed
  --   'unverified' — signature present but no pubkey available to verify
  signature_status TEXT    NOT NULL DEFAULT 'unsigned'
                           CHECK (signature_status IN ('unsigned','valid','invalid','unverified')),

  -- Origin of this manifest record:
  --   'builtin'   — shipped with the platform (seed row)
  --   'local'     — loaded from local filesystem (operator-installed)
  --   'registry'  — fetched from a remote app registry
  source          TEXT     NOT NULL DEFAULT 'local'
                           CHECK (source IN ('builtin','local','registry')),

  -- N10: sha256 over canonical JSON of this manifest row (sans content_hash).
  -- Written by application layer (lib/appstore/registry.ts).
  content_hash    TEXT     NOT NULL DEFAULT '',

  created_at      INTEGER  NOT NULL,
  updated_at      INTEGER  NOT NULL,

  -- Each app_id is unique in the manifest table (one active record per app).
  UNIQUE (app_id)
);

CREATE INDEX IF NOT EXISTS idx_app_manifests_kind
  ON app_manifests (kind, source);

CREATE INDEX IF NOT EXISTS idx_app_manifests_sig_status
  ON app_manifests (signature_status)
  WHERE signature_status != 'valid';

-- ─────────────────────────────────────────────────────────────
-- 2. app_installs — install records per app+scope
--
--    Records that an app is installed/disabled/pending in a scope.
--    "Installed" means: manifest accepted + record created.
--    It does NOT mean MCP-server started or OAuth connected — that is
--    PHASE2_APP_ACTIVATE (R3-gated, separate lifecycle step).
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS app_installs (
  -- Stable install record ID; application uses ULID with AINST- prefix.
  id              TEXT     PRIMARY KEY,

  -- FK → app_manifests.app_id (via app_id, not internal id).
  -- Logical reference: install tracks the app_id, not a specific manifest version row.
  app_id          TEXT     NOT NULL
                           REFERENCES app_manifests(app_id) ON DELETE CASCADE,

  -- Scope kind:
  --   'org'       — installed for an entire org
  --   'workspace' — installed for a specific workspace
  scope_kind      TEXT     NOT NULL
                           CHECK (scope_kind IN ('org','workspace')),

  -- ID of the org or workspace this install belongs to.
  scope_id        TEXT     NOT NULL,

  -- Current install status:
  --   'installed' — active; eligible for PHASE2_APP_ACTIVATE when R3 is unlocked
  --   'disabled'  — installed but deactivated by operator/user
  --   'pending'   — install requested but not yet confirmed (e.g. awaiting review)
  status          TEXT     NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('installed','disabled','pending')),

  -- Actor who performed the install (userId or 'system').
  installed_by    TEXT     NOT NULL DEFAULT 'system',

  -- Unix-ms timestamp of the install action.
  installed_at    INTEGER  NOT NULL,

  -- N10: sha256 over canonical JSON of this install row (sans content_hash).
  content_hash    TEXT     NOT NULL DEFAULT '',

  -- Each (app_id, scope_kind, scope_id) triple is unique — one install
  -- record per app per scope.
  UNIQUE (app_id, scope_kind, scope_id)
);

CREATE INDEX IF NOT EXISTS idx_app_installs_scope
  ON app_installs (scope_kind, scope_id, status);

CREATE INDEX IF NOT EXISTS idx_app_installs_app
  ON app_installs (app_id, status);

-- ─────────────────────────────────────────────────────────────
-- 3. app_install_audit — append-only N8 trace of lifecycle actions
--
--    Every install/enable/disable/uninstall/verify action writes a row here.
--    NEVER UPDATE or DELETE from this table — it is the tamper-evident
--    audit trail (N8). content_hash covers all fields (N10).
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS app_install_audit (
  -- Audit row ID; application uses ULID with AIAUD- prefix.
  id              TEXT     PRIMARY KEY,

  -- Unix-ms timestamp of the action.
  ts              INTEGER  NOT NULL,

  -- The app this action concerns.
  app_id          TEXT     NOT NULL,

  -- Scope label: '<scope_kind>:<scope_id>', e.g. 'workspace:ws-abc123'.
  scope           TEXT     NOT NULL,

  -- Actor who triggered the action (userId or 'system').
  actor           TEXT     NOT NULL DEFAULT 'system',

  -- Lifecycle action:
  --   'install'   — install record created
  --   'enable'    — disabled → installed transition
  --   'disable'   — installed → disabled transition
  --   'uninstall' — install record removed
  --   'verify'    — signature/manifest re-verification triggered
  action          TEXT     NOT NULL
                           CHECK (action IN ('install','enable','disable','uninstall','verify')),

  -- 1 = action succeeded; 0 = action failed (reason explains why).
  success         INTEGER  NOT NULL DEFAULT 1
                           CHECK (success IN (0, 1)),

  -- Human-readable reason string (required on failure, optional on success).
  reason          TEXT,

  -- N10: sha256 over canonical JSON of this audit row (sans content_hash).
  content_hash    TEXT     NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_app_install_audit_app
  ON app_install_audit (app_id, ts);

CREATE INDEX IF NOT EXISTS idx_app_install_audit_scope
  ON app_install_audit (scope, ts);

CREATE INDEX IF NOT EXISTS idx_app_install_audit_ts
  ON app_install_audit (ts);
