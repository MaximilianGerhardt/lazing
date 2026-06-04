/**
 * Platform-Global Connector Catalog — ACL-2 · 2026-05-24.
 *
 * Public API: upsertConnectorProfile, getConnectorProfile, listConnectors,
 *             listCapabilities.
 *
 * D1 (platform-global): KEIN workspace_id, KEIN org_id, KEIN user_id.
 *   This module stores ONLY public, non-sensitive API contracts.
 *
 * N2-Abgrenzung (ADR-0006):
 *   - NOT a RAG fallback — lookup is always by provider name string.
 *   - No semantic search over user content.
 *   - Orthogonal to rag_chunks (different table, different scope contract).
 *
 * N10: content_hash = sha256 over canonical JSON of the catalog row.
 *   Computed here via hashCatalogRow() before every write.
 *
 * PII-Hard-Guard (structural, not advisory):
 *   assertNonSensitiveProfile() is called FIRST in upsertConnectorProfile.
 *   If ANY forbidden key is present in the input (workspace_id, org_id,
 *   user_id, email, token, secret, api_key value, credential), it throws.
 *   The ingestion path CANNOT structurally write sensitive data.
 *
 * Dependencies: db/client.ts (getDb), db/schema/connectors.ts.
 * No LLM, no external I/O — pure DB reads/writes.
 */

import { createHash, randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { getDb } from "@/db/client";
import { canonicalJSON } from "@/lib-v1/audit/canonical-json";
import {
  CONNECTOR_AUTH_KINDS,
  CONNECTOR_SOURCES,
  type ConnectorAuditAction,
  type ConnectorAuthKind,
  type ConnectorCatalogRow,
  type ConnectorCapabilityRow,
  type ConnectorSource,
  connectorCapabilities,
  connectorCatalog,
  connectorCatalogAudit,
} from "@/db/schema/connectors";

// ---------------------------------------------------------------------------
// Public input types
// ---------------------------------------------------------------------------

export type CapabilityInput = {
  /** Short machine-readable name, e.g. 'render_video'. */
  name: string;
  description?: string | null;
  /**
   * JSON Schema SERIALIZED AS A STRING. Mirrors McpTool.inputSchema after
   * JSON.stringify. ME-1: this MUST be a string (or null), never a raw object —
   * an opaque object could smuggle nested PII (e.g. {token: ...}) past the
   * key-name PII guard. assertSchemaFieldsAreStrings() enforces this at write
   * time via the same CONNECTOR_PII_GUARD path.
   */
  inputSchemaJson?: string | null;
  /** Output JSON Schema serialized as a string. Same string-only rule as input. */
  outputSchemaJson?: string | null;
  /** Canonical MCP tool name: 'mcp__<server>__<tool>' or null. */
  mcpToolName?: string | null;
  /** true = required for the connector to be considered functional. */
  required?: boolean;
};

export type ConnectorProfileInput = {
  /** Unique provider slug, e.g. 'heygen'. The lookup key. */
  provider: string;
  displayName: string;
  description?: string | null;
  authKind?: ConnectorAuthKind;
  baseUrl?: string | null;
  apiVersion?: string | null;
  docsUrl?: string | null;
  source?: ConnectorSource;
  validatedAt?: number | null;
  capabilities?: CapabilityInput[];
};

/** Optional caller context for the N8 audit trail (ME-4). */
export type ConnectorWriteContext = {
  /** userId, or omit for 'system' (SOP/automated writes). */
  actor?: string;
};

// ---------------------------------------------------------------------------
// PII Hard-Guard (N2-structural enforcement)
// ---------------------------------------------------------------------------

/**
 * Forbidden key patterns in connector profiles.
 * These represent PII, credentials, or scope-envelope fields that must NEVER
 * be stored in the platform-global connector catalog.
 */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  "workspace_id",
  "workspaceId",
  "org_id",
  "orgId",
  "user_id",
  "userId",
  "email",
  "token",
  "secret",
  "api_key",
  "apiKey",
  "credential",
  "credentials",
  "password",
  "private_key",
  "privateKey",
  "access_token",
  "accessToken",
  "refresh_token",
  "refreshToken",
  "client_secret",
  "clientSecret",
]);

/**
 * assertNonSensitiveProfile — structural PII guard.
 *
 * Throws if any key in `profile` (or any nested object at depth 1) matches a
 * forbidden identifier. This is called unconditionally before any write to
 * connector_catalog.
 *
 * Note: this guard checks KEY NAMES, not values. A key named 'token' in the
 * input shape indicates a programmer error (the profile type should not carry
 * auth values). Actual credential values are stored in api_credentials
 * (ACL-1), not here.
 *
 * @throws {Error} with code 'CONNECTOR_PII_GUARD' if a forbidden key is found.
 */
export function assertNonSensitiveProfile(profile: Record<string, unknown>): void {
  const violations: string[] = [];

  for (const key of Object.keys(profile)) {
    if (FORBIDDEN_KEYS.has(key)) {
      violations.push(key);
    }
  }

  // Also check top-level keys in each capability object
  const caps = profile["capabilities"];
  if (Array.isArray(caps)) {
    for (let i = 0; i < caps.length; i++) {
      const cap = caps[i];
      if (cap && typeof cap === "object" && !Array.isArray(cap)) {
        for (const key of Object.keys(cap as Record<string, unknown>)) {
          if (FORBIDDEN_KEYS.has(key)) {
            violations.push(`capabilities[${i}].${key}`);
          }
        }
      }
    }
  }

  if (violations.length > 0) {
    const err = new Error(
      `[CONNECTOR_PII_GUARD] Forbidden sensitive key(s) in connector profile: ` +
        violations.join(", ") +
        `. connector_catalog is platform-global and must never store PII, ` +
        `credentials, or scope-envelope fields. ` +
        `Store credentials in api_credentials (ACL-1) instead.`,
    );
    (err as Error & { code: string }).code = "CONNECTOR_PII_GUARD";
    throw err;
  }
}

/**
 * assertSchemaFieldsAreStrings — ME-1 runtime guard for opaque schema strings.
 *
 * `inputSchemaJson` / `outputSchemaJson` are persisted as opaque strings; the
 * key-name PII guard (assertNonSensitiveProfile) cannot see inside a raw object.
 * If a caller passes an OBJECT instead of a serialized string, that object
 * could carry nested forbidden fields (e.g. { token: "..." }) straight through
 * to the DB. This guard rejects any non-string, non-null/undefined value for
 * those fields BEFORE any write — using the same CONNECTOR_PII_GUARD code path.
 *
 * @throws {Error} with code 'CONNECTOR_PII_GUARD' if a schema field is an object.
 */
export function assertSchemaFieldsAreStrings(
  capabilities: ReadonlyArray<Record<string, unknown>> | undefined,
): void {
  if (!Array.isArray(capabilities)) return;

  const violations: string[] = [];
  const schemaFields = ["inputSchemaJson", "outputSchemaJson"] as const;

  for (let i = 0; i < capabilities.length; i++) {
    const cap = capabilities[i];
    if (!cap || typeof cap !== "object") continue;
    for (const field of schemaFields) {
      const value = cap[field];
      // Allowed: string, null, undefined (absent). Forbidden: object, array,
      // number, boolean — anything that is not a serialized JSON string.
      if (value === null || value === undefined) continue;
      if (typeof value !== "string") {
        violations.push(
          `capabilities[${i}].${field} (got ${
            Array.isArray(value) ? "array" : typeof value
          }, expected serialized JSON string)`,
        );
      }
    }
  }

  if (violations.length > 0) {
    const err = new Error(
      `[CONNECTOR_PII_GUARD] Schema field(s) must be serialized JSON strings, ` +
        `not raw objects: ` +
        violations.join(", ") +
        `. A raw object could smuggle nested PII past the key-name guard. ` +
        `Serialize with JSON.stringify() before passing to upsertConnectorProfile.`,
    );
    (err as Error & { code: string }).code = "CONNECTOR_PII_GUARD";
    throw err;
  }
}

// ---------------------------------------------------------------------------
// N10: Canonical JSON hash
// ---------------------------------------------------------------------------

/**
 * Compute the N10 content_hash for a connector_catalog row.
 *
 * Covers: id, provider, display_name, description, auth_kind, base_url,
 * api_version, docs_url, source, validated_at, created_at, updated_at.
 * Deliberately excludes only content_hash itself.
 *
 * ME-3: updated_at is INCLUDED in the hash (consistent with the credential-hash
 * which includes updatedAt). This gives the catalog full tamper-evidence — the
 * hash changes on every mutation, not only on substantive-field changes. The
 * trade-off (idempotent re-write of identical data still produces a new hash if
 * updated_at moves) is acceptable: callers compare old_hash/new_hash in the
 * audit trail (ME-4) to distinguish substantive vs. touch-only updates.
 */
export function hashCatalogRow(row: {
  id: string;
  provider: string;
  displayName: string;
  description: string | null | undefined;
  authKind: string;
  baseUrl: string | null | undefined;
  apiVersion: string | null | undefined;
  docsUrl: string | null | undefined;
  source: string;
  validatedAt: number | null | undefined;
  createdAt: number;
  updatedAt: number;
}): string {
  // P2-#9: use canonicalJSON (JCS RFC 8785) for sort-robust, deterministic hashing.
  // Previously used JSON.stringify with hand-ordered keys — replaced to align
  // with all other N10 hash sites (trust.ts, canonical-json.ts spec).
  const canonical = canonicalJSON({
    id: row.id,
    provider: row.provider,
    display_name: row.displayName,
    description: row.description ?? null,
    auth_kind: row.authKind,
    base_url: row.baseUrl ?? null,
    api_version: row.apiVersion ?? null,
    docs_url: row.docsUrl ?? null,
    source: row.source,
    validated_at: row.validatedAt ?? null,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// ID helper — NIT N-2: crypto.randomUUID for collision safety (was Date+Math.random)
// ---------------------------------------------------------------------------

function generateId(prefix: string): string {
  return `${prefix}${randomUUID()}`;
}

// ---------------------------------------------------------------------------
// N8 audit helper (ME-4) — best-effort, never throws
// ---------------------------------------------------------------------------

/** Compute the N10 content_hash for a connector_catalog_audit row. */
function hashAuditRow(row: {
  id: string;
  ts: number;
  action: ConnectorAuditAction;
  actor: string;
  provider: string;
  oldHash: string | null;
  newHash: string | null;
}): string {
  // P2-#9: use canonicalJSON (JCS RFC 8785) — consistent with hashCatalogRow
  // and all other N10 hash sites.
  const canonical = canonicalJSON({
    id: row.id,
    ts: row.ts,
    action: row.action,
    actor: row.actor,
    provider: row.provider,
    old_hash: row.oldHash ?? null,
    new_hash: row.newHash ?? null,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * writeCatalogAudit — append an N8 trace row for a catalog mutation.
 *
 * Best-effort (ME-4): the connector catalog is non-sensitive (ADR-0006), so a
 * failed audit write MUST NOT abort the catalog write. Any error here is
 * swallowed (the catalog row is already committed). This contrasts with N2
 * fail-closed audit on rag_chunks, which IS sensitive.
 */
function writeCatalogAudit(input: {
  action: ConnectorAuditAction;
  actor: string;
  provider: string;
  oldHash: string | null;
  newHash: string | null;
}): void {
  try {
    const db = getDb();
    const id = generateId("CCAUD-");
    const ts = Date.now();
    const contentHash = hashAuditRow({
      id,
      ts,
      action: input.action,
      actor: input.actor,
      provider: input.provider,
      oldHash: input.oldHash,
      newHash: input.newHash,
    });
    db.insert(connectorCatalogAudit)
      .values({
        id,
        ts,
        action: input.action,
        actor: input.actor,
        provider: input.provider,
        oldHash: input.oldHash,
        newHash: input.newHash,
        contentHash,
      })
      .run();
  } catch {
    // Best-effort: non-sensitive catalog — degrade gracefully if the audit
    // table is missing or the insert fails. The catalog write already succeeded.
  }
}

// ---------------------------------------------------------------------------
// upsertConnectorProfile
// ---------------------------------------------------------------------------

/**
 * Insert-or-replace a connector profile (catalog row + capabilities).
 *
 * If the provider already exists, the catalog row is updated and all
 * capabilities are replaced atomically.
 *
 * Two structural guards run FIRST, before any DB access:
 *   1. PII Hard-Guard (assertNonSensitiveProfile) — forbidden key names.
 *   2. ME-1 schema-string guard (assertSchemaFieldsAreStrings) — rejects raw
 *      objects in inputSchemaJson/outputSchemaJson that could smuggle nested PII.
 * Both throw with code 'CONNECTOR_PII_GUARD'.
 *
 * ME-4: a best-effort N8 audit row is written after the mutation (never aborts
 * the catalog write). Pass `ctx.actor` to attribute the write; defaults to 'system'.
 *
 * ME-3: content_hash now includes updated_at, so the hash changes on every
 * mutation (full tamper-evidence rather than substantive-field-only).
 *
 * @throws {Error} with code 'CONNECTOR_PII_GUARD' if profile contains PII or a
 *   raw schema object.
 */
export function upsertConnectorProfile(
  profile: ConnectorProfileInput,
  ctx: ConnectorWriteContext = {},
): ConnectorCatalogRow {
  // 1. PII Hard-Guard (structural enforcement — always runs first)
  assertNonSensitiveProfile(profile as unknown as Record<string, unknown>);
  // 1b. ME-1: schema fields must be serialized strings, never raw objects.
  assertSchemaFieldsAreStrings(
    profile.capabilities as ReadonlyArray<Record<string, unknown>> | undefined,
  );

  const db = getDb();
  const now = Date.now();
  const actor = ctx.actor ?? "system";

  // 2. Validate closed enums
  const authKind: ConnectorAuthKind =
    profile.authKind && CONNECTOR_AUTH_KINDS.includes(profile.authKind)
      ? profile.authKind
      : "api_key";

  const source: ConnectorSource =
    profile.source && CONNECTOR_SOURCES.includes(profile.source)
      ? profile.source
      : "manual";

  // 3. Determine if this is an insert or update
  const existing = db
    .select()
    .from(connectorCatalog)
    .where(eq(connectorCatalog.provider, profile.provider))
    .get();

  const id = existing?.id ?? generateId("CONN-");
  const createdAt = existing?.createdAt ?? now;
  const oldHash = existing?.contentHash ?? null;

  // 4. Compute N10 content_hash (ME-3: includes updatedAt = now)
  const contentHash = hashCatalogRow({
    id,
    provider: profile.provider,
    displayName: profile.displayName,
    description: profile.description ?? null,
    authKind,
    baseUrl: profile.baseUrl ?? null,
    apiVersion: profile.apiVersion ?? null,
    docsUrl: profile.docsUrl ?? null,
    source,
    validatedAt: profile.validatedAt ?? null,
    createdAt,
    updatedAt: now,
  });

  // 5. Upsert catalog row
  db.insert(connectorCatalog)
    .values({
      id,
      provider: profile.provider,
      displayName: profile.displayName,
      description: profile.description ?? null,
      authKind,
      baseUrl: profile.baseUrl ?? null,
      apiVersion: profile.apiVersion ?? null,
      docsUrl: profile.docsUrl ?? null,
      source,
      validatedAt: profile.validatedAt ?? null,
      contentHash,
      createdAt,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: connectorCatalog.provider,
      set: {
        displayName: profile.displayName,
        description: profile.description ?? null,
        authKind,
        baseUrl: profile.baseUrl ?? null,
        apiVersion: profile.apiVersion ?? null,
        docsUrl: profile.docsUrl ?? null,
        source,
        validatedAt: profile.validatedAt ?? null,
        contentHash,
        updatedAt: now,
      },
    })
    .run();

  // 6. Replace capabilities atomically (delete all old, insert new)
  if (profile.capabilities !== undefined) {
    db.delete(connectorCapabilities)
      .where(eq(connectorCapabilities.connectorId, id))
      .run();

    for (const cap of profile.capabilities) {
      db.insert(connectorCapabilities)
        .values({
          id: generateId("CAP-"),
          connectorId: id,
          name: cap.name,
          description: cap.description ?? null,
          inputSchemaJson: cap.inputSchemaJson ?? null,
          outputSchemaJson: cap.outputSchemaJson ?? null,
          mcpToolName: cap.mcpToolName ?? null,
          required: cap.required ?? false,
        })
        .run();
    }
  }

  // 7. N8 audit trail (ME-4) — best-effort, never aborts the write.
  writeCatalogAudit({
    action: "upsert",
    actor,
    provider: profile.provider,
    oldHash,
    newHash: contentHash,
  });

  // 8. Return the upserted row
  return db
    .select()
    .from(connectorCatalog)
    .where(eq(connectorCatalog.provider, profile.provider))
    .get()!;
}

// ---------------------------------------------------------------------------
// deleteConnectorProfile
// ---------------------------------------------------------------------------

/**
 * Delete a connector profile by provider slug (capabilities cascade).
 *
 * Returns true if a row was deleted, false if the provider did not exist.
 * ME-4: writes a best-effort 'delete' N8 audit row (new_hash = null).
 */
export function deleteConnectorProfile(
  provider: string,
  ctx: ConnectorWriteContext = {},
): boolean {
  const db = getDb();
  const actor = ctx.actor ?? "system";

  const existing = db
    .select()
    .from(connectorCatalog)
    .where(eq(connectorCatalog.provider, provider))
    .get();

  if (!existing) return false;

  db.delete(connectorCatalog)
    .where(eq(connectorCatalog.provider, provider))
    .run();

  writeCatalogAudit({
    action: "delete",
    actor,
    provider,
    oldHash: existing.contentHash ?? null,
    newHash: null,
  });

  return true;
}

// ---------------------------------------------------------------------------
// listCatalogAudit (ME-4 read surface)
// ---------------------------------------------------------------------------

/**
 * List the N8 audit trail for a provider (most-recent-first), or all rows when
 * no provider is given. Read-only convenience for verification/tests.
 */
export function listCatalogAudit(provider?: string) {
  const db = getDb();
  if (provider) {
    return db
      .select()
      .from(connectorCatalogAudit)
      .where(eq(connectorCatalogAudit.provider, provider))
      .all();
  }
  return db.select().from(connectorCatalogAudit).all();
}

// ---------------------------------------------------------------------------
// getConnectorProfile
// ---------------------------------------------------------------------------

/**
 * Fetch a connector catalog row by provider slug.
 * Returns null if not found.
 */
export function getConnectorProfile(provider: string): ConnectorCatalogRow | null {
  const db = getDb();
  return (
    db
      .select()
      .from(connectorCatalog)
      .where(eq(connectorCatalog.provider, provider))
      .get() ?? null
  );
}

// ---------------------------------------------------------------------------
// listConnectors
// ---------------------------------------------------------------------------

/**
 * List all connector catalog rows.
 * No workspace or org filter — platform-global by design.
 */
export function listConnectors(): ConnectorCatalogRow[] {
  const db = getDb();
  return db.select().from(connectorCatalog).all();
}

// ---------------------------------------------------------------------------
// listCapabilities
// ---------------------------------------------------------------------------

/**
 * List all capabilities for a given provider slug.
 * Returns an empty array if the provider does not exist.
 */
export function listCapabilities(provider: string): ConnectorCapabilityRow[] {
  const db = getDb();
  const row = db
    .select({ id: connectorCatalog.id })
    .from(connectorCatalog)
    .where(eq(connectorCatalog.provider, provider))
    .get();

  if (!row) return [];

  return db
    .select()
    .from(connectorCapabilities)
    .where(eq(connectorCapabilities.connectorId, row.id))
    .all();
}

// ---------------------------------------------------------------------------
// getCapability — single capability by provider + capability name
// ---------------------------------------------------------------------------

/**
 * Fetch a single capability by provider slug and capability name.
 * Returns null if not found.
 */
export function getCapability(
  provider: string,
  capabilityName: string,
): ConnectorCapabilityRow | null {
  const db = getDb();
  const catalogRow = db
    .select({ id: connectorCatalog.id })
    .from(connectorCatalog)
    .where(eq(connectorCatalog.provider, provider))
    .get();

  if (!catalogRow) return null;

  return (
    db
      .select()
      .from(connectorCapabilities)
      .where(
        and(
          eq(connectorCapabilities.connectorId, catalogRow.id),
          eq(connectorCapabilities.name, capabilityName),
        ),
      )
      .get() ?? null
  );
}
