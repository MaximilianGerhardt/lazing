/**
 * App-Store Manifest Types + Validation (C4 · 2026-05-25).
 *
 * Provides:
 *   AppManifest   — the in-memory manifest type (parsed + validated)
 *   parseManifest — JSON string → AppManifest (throws on parse error)
 *   validateManifest — AppManifest → validated form or throws ZodError
 *   assertNonSensitiveManifest — PII guard (structural, not advisory)
 *
 * N6: All validation is deterministic (Zod schema + regex rules).
 *     No LLM, no external I/O.
 *
 * N1: manifest_json is never truncated in app_manifests.manifest_json —
 *     the full text is persisted verbatim.
 *
 * PII-Hard-Guard:
 *   assertNonSensitiveManifest() is called FIRST in upsertManifest().
 *   If ANY forbidden key is present (workspace_id, user_id, email, token,
 *   secret, api_key, credential, password, etc.) it throws with code
 *   'APP_STORE_PII_GUARD'. Mirrors the pattern from lib/connectors/catalog.ts.
 *
 * Credential-Scopes (declarative):
 *   A manifest may list credential scopes it REQUESTS via
 *   `requestedCredentialScopes`. These are declarative strings — they do NOT
 *   grant any access. The actual credential resolution follows the Vault
 *   D2-policy (lib/credentials/vault.ts) which requires explicit opt-in.
 *
 * PHASE2_APP_ACTIVATE boundary:
 *   This module validates manifests. It does NOT start processes, spawn
 *   MCP servers, or trigger OAuth flows. Those actions are gated behind
 *   R3 (see ADR-0007) and are NOT part of this foundation.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// App ID validation (deterministic regex, N6)
// ---------------------------------------------------------------------------

/**
 * Valid app_id pattern: lowercase letters/digits/dots/hyphens/underscores.
 * Must start with a letter. 2–128 chars total.
 * Examples: 'com.example.my-mcp-server', 'lazing.skill-pack.research'
 */
export const APP_ID_REGEX = /^[a-z][a-z0-9._-]{1,127}$/;

// ---------------------------------------------------------------------------
// Zod schemas (declared explicitly for N6 determinism)
// ---------------------------------------------------------------------------

/** A declared MCP tool within a manifest's capabilities list. */
const McpToolDeclarationSchema = z.object({
  /** Canonical tool name format: 'mcp__<server>__<tool>'. */
  name: z.string().min(1).max(256),
  description: z.string().max(1024).optional(),
  /**
   * JSON Schema as a serialized STRING (never a raw object — same ME-1 rule
   * as connector_capabilities.inputSchemaJson). Prevents nested PII smuggling.
   */
  inputSchemaJson: z.string().max(65536).optional(),
});

/** A declared capability within a manifest (tool or endpoint). */
const CapabilityDeclarationSchema = z.object({
  name: z.string().min(1).max(128),
  description: z.string().max(1024).optional(),
  /** Canonical MCP tool name if this is an MCP tool. */
  mcpToolName: z.string().max(256).optional(),
  /** Whether this capability is required for the app to function. */
  required: z.boolean().optional(),
});

/**
 * Zod schema for the parsed AppManifest.
 *
 * Covers all required and optional fields. Validated by validateManifest().
 * This schema is the authoritative source for what fields are legal —
 * any unknown top-level key raises in strict mode.
 */
export const AppManifestSchema = z.object({
  /**
   * Required: unique app identifier.
   * Validated against APP_ID_REGEX.
   */
  appId: z
    .string()
    .min(2)
    .max(128)
    .regex(APP_ID_REGEX, {
      message:
        "appId must match ^[a-z][a-z0-9._-]{1,127}$ (lowercase, start with letter)",
    }),

  /** Required: human-readable display name. */
  name: z.string().min(1).max(256),

  /** Required: semver version string, e.g. '1.2.3' or '0.1.0-alpha'. */
  version: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[0-9]+\.[0-9]+\.[0-9]+([-+][a-zA-Z0-9._-]+)*$/, {
      message: "version must be semver, e.g. '1.2.3' or '1.0.0-alpha.1'",
    }),

  /** Required: app kind. */
  kind: z.enum(["mcp-server", "connector", "skill-pack"]),

  /** Optional: short description (public, non-sensitive). */
  description: z.string().max(2048).optional(),

  /** Optional: publisher name or org (non-sensitive metadata only). */
  publisher: z.string().max(256).optional(),

  /**
   * MCP tools declared by this app (relevant for kind='mcp-server').
   * Declarative only — no tool is activated by listing it here.
   */
  mcpTools: z.array(McpToolDeclarationSchema).max(256).optional(),

  /**
   * General capabilities declared by this app.
   * For kind='connector', these may be mirrored to connector_catalog
   * after install. For kind='skill-pack', these are skill identifiers.
   */
  capabilities: z.array(CapabilityDeclarationSchema).max(256).optional(),

  /**
   * Credential scopes this app REQUESTS.
   * Declarative strings only — does NOT grant any credential access.
   * Actual resolution follows Vault D2-policy (lib/credentials/vault.ts).
   *
   * Examples:
   *   ['openai', 'heygen', 'stripe']
   *   ['mcp-server:my-tool:api_key']
   *
   * PHASE2_APP_ACTIVATE boundary: at activation time (R3-gated), the
   * runtime checks each requested scope against the installed credentials.
   * This field is for declaration and user-facing disclosure only.
   */
  requestedCredentialScopes: z.array(z.string().max(128)).max(64).optional(),

  /**
   * Optional: minimum platform version required to run this app.
   * Informational only in this foundation phase.
   */
  minPlatformVersion: z.string().max(32).optional(),

  /**
   * Optional: URL or path to the MCP server command (for kind='mcp-server').
   * PHASE2_APP_ACTIVATE boundary: this field is READ at activation time
   * (R3-gated) to start the MCP server process. In this foundation phase
   * it is stored but never acted upon — the PHASE2_APP_ACTIVATE gate
   * in registry.ts marks where the real spawn would happen.
   */
  mcpServerCommand: z.string().max(512).optional(),
  /**
   * Optional: CLI args for the MCP server command (for kind='mcp-server').
   *
   * PII-2: mcpServerArgs VALUES are heuristically scanned by
   * assertNonSensitiveManifest() for embedded secrets (secret-flags with
   * inline values, known token prefixes like 'sk-'/'ghp_'/JWT). Secrets MUST
   * be passed via env-var references (e.g. '${OPENAI_API_KEY}'), NEVER inline.
   * A flagged arg throws APP_STORE_PII_GUARD.
   */
  mcpServerArgs: z.array(z.string().max(256)).max(32).optional(),
});

export type AppManifest = z.infer<typeof AppManifestSchema>;

// ---------------------------------------------------------------------------
// PII Hard-Guard (structural, not advisory) — mirrors catalog.ts pattern
// ---------------------------------------------------------------------------

/**
 * Forbidden key patterns in app manifests.
 * These represent PII, credentials, or scope-envelope fields that must NEVER
 * appear in a manifest.
 */
const MANIFEST_FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
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
  "bearer",
  "auth_token",
  "authToken",
]);

/**
 * PII-1: Allowlist regex for requestedCredentialScopes[] values.
 *
 * A scope is a declarative identifier like 'openai', 'heygen', or a
 * structured 'server:tool:scope' form. The colon is allowed (for the
 * structured form) but '=' is forbidden — a value like 'api_key=sk-...'
 * would smuggle credential material through a scope string.
 *
 * Pattern: start with a lowercase letter, then 0–127 of
 * [a-z0-9._:-]. No '=', no whitespace, no uppercase.
 */
const CREDENTIAL_SCOPE_RE = /^[a-z][a-z0-9._:-]{0,127}$/;

/**
 * PII-2: Heuristic credential-material detectors for mcpServerArgs[] values.
 *
 * These detect common secret shapes embedded directly in CLI args. The scan
 * is intentionally minimal to avoid false positives on legitimate args:
 *   - secret-flag patterns: --password/--secret/--token/--api-key/--apikey
 *     immediately followed by '=' and a non-placeholder value in the SAME arg.
 *   - well-known token prefixes anywhere in an arg: 'sk-' (OpenAI),
 *     'ghp_'/'gho_'/'ghs_' (GitHub), 'xoxb-'/'xoxp-' (Slack), JWT 'eyJ' prefix.
 *
 * A placeholder value (e.g. '${SECRET}', '{{token}}', '$VAR', 'changeme',
 * 'REDACTED', empty) is NOT flagged — those are template references, not
 * embedded secrets. If this proves too aggressive in practice, the
 * mcpServerArgs schema comment documents that secrets MUST be passed via
 * env-var references, never inline.
 */
const SECRET_FLAG_RE =
  /^--(?:password|secret|token|api[-_]?key|client[-_]?secret|access[-_]?token)=(.+)$/i;
const TOKEN_PREFIX_RE = /(?:sk-[a-zA-Z0-9]{8,}|gh[posu]_[A-Za-z0-9]{16,}|xox[bp]-[A-Za-z0-9-]{8,}|eyJ[A-Za-z0-9_-]{8,}\.)/;
const PLACEHOLDER_RE = /^(?:\$\{.*\}|\{\{.*\}\}|\$[A-Z_][A-Z0-9_]*|<.*>|changeme|redacted|placeholder|)$/i;

function looksLikeEmbeddedSecret(arg: string): boolean {
  // (a) secret-flag with inline value
  const flagMatch = SECRET_FLAG_RE.exec(arg);
  if (flagMatch) {
    const value = flagMatch[1] ?? "";
    if (!PLACEHOLDER_RE.test(value.trim())) {
      return true;
    }
  }
  // (b) well-known token prefix anywhere in the arg
  if (TOKEN_PREFIX_RE.test(arg)) {
    return true;
  }
  return false;
}

/**
 * assertNonSensitiveManifest — structural PII guard.
 *
 * Throws if:
 *   - any top-level key OR any key in nested arrays (mcpTools, capabilities)
 *     matches a forbidden identifier (key-name guard), OR
 *   - (PII-1) any requestedCredentialScopes[] value fails the allowlist regex
 *     (e.g. contains '=' to smuggle 'api_key=sk-...'), OR
 *   - (PII-2) any mcpServerArgs[] value looks like an embedded secret.
 *
 * Called FIRST in upsertManifest() before any DB access.
 *
 * @throws {Error} with code 'APP_STORE_PII_GUARD' if any check fails.
 */
export function assertNonSensitiveManifest(manifest: Record<string, unknown>): void {
  const violations: string[] = [];

  // Check top-level keys
  for (const key of Object.keys(manifest)) {
    if (MANIFEST_FORBIDDEN_KEYS.has(key)) {
      violations.push(key);
    }
  }

  // Check nested arrays (mcpTools, capabilities)
  const nestedArrayKeys = ["mcpTools", "capabilities"] as const;
  for (const arrayKey of nestedArrayKeys) {
    const arr = manifest[arrayKey];
    if (!Array.isArray(arr)) continue;
    for (let i = 0; i < arr.length; i++) {
      const item = arr[i];
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      for (const key of Object.keys(item as Record<string, unknown>)) {
        if (MANIFEST_FORBIDDEN_KEYS.has(key)) {
          violations.push(`${arrayKey}[${i}].${key}`);
        }
      }
    }
  }

  // PII-1: scan requestedCredentialScopes[] VALUES against the allowlist regex.
  const scopes = manifest["requestedCredentialScopes"];
  if (Array.isArray(scopes)) {
    for (let i = 0; i < scopes.length; i++) {
      const scope = scopes[i];
      if (typeof scope !== "string" || !CREDENTIAL_SCOPE_RE.test(scope)) {
        violations.push(
          `requestedCredentialScopes[${i}] (value '${
            typeof scope === "string" ? scope : typeof scope
          }' must match ^[a-z][a-z0-9._:-]{0,127}$ — '=' and credential material forbidden)`,
        );
      }
    }
  }

  // PII-2: heuristic scan of mcpServerArgs[] VALUES for embedded secrets.
  const args = manifest["mcpServerArgs"];
  if (Array.isArray(args)) {
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (typeof arg === "string" && looksLikeEmbeddedSecret(arg)) {
        violations.push(
          `mcpServerArgs[${i}] (looks like an embedded secret — pass secrets via ` +
            `env-var reference like \${SECRET}, never inline)`,
        );
      }
    }
  }

  if (violations.length > 0) {
    const err = new Error(
      `[APP_STORE_PII_GUARD] Forbidden sensitive content in app manifest: ` +
        violations.join(", ") +
        `. App manifests must not contain PII, credentials, or scope-envelope fields. ` +
        `Store credentials in api_credentials (ACL-1) instead. ` +
        `Requested credential scopes go in requestedCredentialScopes[] as declarative strings.`,
    );
    (err as Error & { code: string }).code = "APP_STORE_PII_GUARD";
    throw err;
  }
}

/**
 * assertSchemaStringsInManifest — ME-1 guard for schema fields in mcpTools.
 *
 * inputSchemaJson must be a serialized JSON string (or absent), never a raw
 * object. A raw object could smuggle nested PII past the key-name guard.
 *
 * @throws {Error} with code 'APP_STORE_PII_GUARD' if a schema field is an object.
 */
export function assertSchemaStringsInManifest(
  manifest: Record<string, unknown>,
): void {
  const tools = manifest["mcpTools"];
  if (!Array.isArray(tools)) return;

  const violations: string[] = [];
  for (let i = 0; i < tools.length; i++) {
    const tool = tools[i];
    if (!tool || typeof tool !== "object") continue;
    const v = (tool as Record<string, unknown>)["inputSchemaJson"];
    if (v === null || v === undefined) continue;
    if (typeof v !== "string") {
      violations.push(
        `mcpTools[${i}].inputSchemaJson (got ${Array.isArray(v) ? "array" : typeof v}, expected string)`,
      );
    }
  }

  if (violations.length > 0) {
    const err = new Error(
      `[APP_STORE_PII_GUARD] mcpTools schema fields must be serialized JSON strings: ` +
        violations.join(", "),
    );
    (err as Error & { code: string }).code = "APP_STORE_PII_GUARD";
    throw err;
  }
}

// ---------------------------------------------------------------------------
// parseManifest — JSON string → raw object (pre-validation)
// ---------------------------------------------------------------------------

/**
 * parseManifest — Parse a raw JSON string into an unvalidated record.
 *
 * Does NOT validate against AppManifestSchema — call validateManifest() next.
 * Throws with code 'APP_MANIFEST_PARSE_ERROR' if the input is not valid JSON
 * or not a plain object.
 *
 * @throws {Error} with code 'APP_MANIFEST_PARSE_ERROR'
 */
export function parseManifest(jsonString: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonString);
  } catch (err) {
    const parseErr = new Error(
      `[APP_MANIFEST_PARSE_ERROR] Failed to parse manifest JSON: ${(err as Error).message}`,
    );
    (parseErr as Error & { code: string }).code = "APP_MANIFEST_PARSE_ERROR";
    throw parseErr;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    const shapeErr = new Error(
      `[APP_MANIFEST_PARSE_ERROR] Manifest JSON must be a plain object, got: ${Array.isArray(parsed) ? "array" : typeof parsed}`,
    );
    (shapeErr as Error & { code: string }).code = "APP_MANIFEST_PARSE_ERROR";
    throw shapeErr;
  }

  return parsed as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// validateManifest — full deterministic validation (N6)
// ---------------------------------------------------------------------------

export type ManifestValidationResult =
  | { ok: true; manifest: AppManifest }
  | { ok: false; errors: string[] };

/**
 * validateManifest — full deterministic validation of an already-parsed manifest.
 *
 * Runs:
 *   1. PII Hard-Guard (assertNonSensitiveManifest) — throws immediately on PII.
 *   2. Schema-string guard (assertSchemaStringsInManifest) — rejects raw objects.
 *   3. Zod schema validation (AppManifestSchema) — structural validation.
 *
 * Returns { ok: true, manifest } on success.
 * Returns { ok: false, errors } on Zod validation failure.
 * Throws (code 'APP_STORE_PII_GUARD') on PII guard violation — does NOT wrap
 * in a result because PII violations are programmer errors, not user input errors.
 *
 * N6: All validation is deterministic. No LLM, no external I/O.
 */
export function validateManifest(
  raw: Record<string, unknown>,
): ManifestValidationResult {
  // Step 1: PII guard (structural — throws on violation)
  assertNonSensitiveManifest(raw);

  // Step 2: Schema-string guard (structural — throws on violation)
  assertSchemaStringsInManifest(raw);

  // Step 3: Zod validation (N6 deterministic schema)
  const result = AppManifestSchema.safeParse(raw);
  if (!result.success) {
    const errors = result.error.issues.map(
      (e) => `${e.path.join(".") || "(root)"}: ${e.message}`,
    );
    return { ok: false, errors };
  }

  return { ok: true, manifest: result.data };
}

/**
 * parseAndValidateManifest — convenience: parse JSON string + validate.
 *
 * Equivalent to parseManifest() followed by validateManifest().
 * Throws on PII guard violations or parse errors.
 * Returns ManifestValidationResult for schema validation.
 */
export function parseAndValidateManifest(
  jsonString: string,
): ManifestValidationResult {
  const raw = parseManifest(jsonString);
  return validateManifest(raw);
}
