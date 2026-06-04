/**
 * Generic API credential vault (ACL-1, Migration 0100).
 *
 * Server-only. Raw better-sqlite3 prepared statements via getDb().$raw
 * (same pattern as lib/github/org-repo.ts).
 *
 * Core functions:
 *   putApiCredential  — upsert + encrypt + audit row.
 *   resolveApiCredential — D2 policy resolution with credential_isolation.
 *   deleteApiCredential — delete + audit row.
 *   decryptApiSecret  — best-effort decrypt, NEVER logged.
 *
 * D2 resolution policy:
 *   1. Auth gate: canEditWorkspaceContent(getEffectiveWorkspaceRole(userId, wsId))
 *      → null (no error leak) on deny.
 *   2. Workspace-own credential first (scope_kind='workspace').
 *   3. Org fallback ONLY when credential_isolation='inherit' (or the field is missing — default 'inherit').
 *      For 'isolated' → NO org fallback (external customer isolation).
 *   4. Every resolve() writes an audit row (success or deny).
 *
 * N8  — audit row on every write/resolve/delete.
 * N9  — scope_kind + scope_id as the isolation anchor on every query.
 * N10 — content_hash SHA-256 over canonical JSON (tamper-evident).
 */

import { createHash, randomUUID } from "node:crypto";

import { getDb } from "@/db/client";
import type { MembershipRole } from "@/db/schema/memberships";
import {
  decryptCredential,
  encryptCredential,
} from "@/lib/security/credentials";
import {
  canEditWorkspaceContent,
  getEffectiveWorkspaceRole,
} from "@/lib/security/permissions";
import { hasRealWorkspaceMembership } from "@/lib/security/membership";
import { findOrgForWorkspace, findUserOrgMembership } from "@/lib/orgs/repo";

// ─── Types ───────────────────────────────────────────────────────────────────

export type ScopeKind = "org" | "workspace";
export type CredentialKind = "api_key" | "pat" | "oauth";
export type AccessAction = "put" | "resolve" | "reveal" | "delete";

export interface PutApiCredentialInput {
  scopeKind: ScopeKind;
  scopeId: string;
  provider: string;
  kind: CredentialKind;
  /** Plaintext — encrypted immediately, never stored. */
  secret: string;
  /** Optional provider metadata (baseUrl, version, scope). */
  config?: Record<string, unknown> | null;
}

export interface PutActor {
  userId: string;
  source?: string;
}

export interface ResolvedApiCredential {
  id: string;
  provider: string;
  kind: CredentialKind;
  /** Decrypted secret — NEVER in a response body or logs. */
  secret: string;
  config: Record<string, unknown> | null;
  lastValidatedAt: number | null;
  /** Where the credential comes from: 'workspace-cred' | 'org-fallback'. */
  source: "workspace-cred" | "org-fallback";
}

// ─── Raw Row Types ────────────────────────────────────────────────────────────

interface ApiCredRaw {
  id: string;
  scope_kind: string;
  scope_id: string;
  provider: string;
  credential_kind: string;
  encrypted_secret: string;
  config_json: string | null;
  last_validated_at: number | null;
  content_hash: string;
  created_at: number;
  updated_at: number;
}

// ─── Auth helpers (vault-own gates, Security-Critic B-2 / M-3) ────────────────

/** Rank table mirrored from lib/security/permissions.ts. */
const ORG_ROLE_RANK: Record<MembershipRole, number> = {
  founder: 5,
  admin: 4,
  member: 3,
  viewer: 2,
  guest: 1,
};

/**
 * userId-based org-admin check (no RequestLike — the vault is also called by
 * non-HTTP callers, ACL-4/ACL-5). Returns true when the user
 * is at least `admin` in the org. Org credentials (write/delete) are
 * structural operations → admin threshold, not member.
 */
function isOrgAdmin(userId: string, orgId: string): boolean {
  const membership = findUserOrgMembership(userId, orgId);
  if (!membership) return false;
  const rank = ORG_ROLE_RANK[membership.role as MembershipRole] ?? 0;
  return rank >= ORG_ROLE_RANK.admin;
}

/**
 * Central write/delete authorization for the vault.
 *
 * - scope_kind='workspace' → canEditWorkspaceContent(getEffectiveWorkspaceRole).
 *   The caller MUST pass scopeId = workspaceId.
 * - scope_kind='org' → isOrgAdmin(userId, scopeId=orgId).
 *
 * Returns true when allowed. Writes NO audit row (the caller does that
 * deterministically with the correct action value).
 */
function isVaultWriteAllowed(
  scopeKind: ScopeKind,
  scopeId: string,
  userId: string,
): boolean {
  if (scopeKind === "workspace") {
    return canEditWorkspaceContent(getEffectiveWorkspaceRole(userId, scopeId));
  }
  // scopeKind === 'org'
  return isOrgAdmin(userId, scopeId);
}

/**
 * Provider validation (Security-Critic N-1). Prevents dirty
 * audit/DB values. Lowercase alphanumeric + '-' '_', max 64 chars,
 * must start with a letter.
 */
const PROVIDER_RE = /^[a-z][a-z0-9_-]{0,63}$/;

function isValidProvider(provider: string): boolean {
  return PROVIDER_RE.test(provider);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeCredId(): string {
  return `apicred-${randomUUID()}`;
}

function makeLogId(): string {
  return `aclog-${randomUUID()}`;
}

/**
 * N10: SHA-256 over the row's canonical JSON.
 * Canonical = alphabetically sorted keys, no content_hash field itself.
 */
function computeCredHash(fields: {
  scopeKind: string;
  scopeId: string;
  provider: string;
  credentialKind: string;
  encryptedSecret: string;
  configJson: string | null;
  createdAt: number;
  updatedAt: number;
}): string {
  const payload = JSON.stringify({
    config_json: fields.configJson,
    credential_kind: fields.credentialKind,
    encrypted_secret: fields.encryptedSecret,
    provider: fields.provider,
    scope_id: fields.scopeId,
    scope_kind: fields.scopeKind,
    ts_created: fields.createdAt,
    ts_updated: fields.updatedAt,
  });
  return createHash("sha256").update(payload).digest("hex");
}

function computeLogHash(fields: {
  id: string;
  ts: number;
  scopeKind: string;
  scopeId: string;
  provider: string;
  userId: string;
  action: string;
  source: string | null;
  success: number;
  reason: string | null;
}): string {
  const payload = JSON.stringify({
    action: fields.action,
    id: fields.id,
    provider: fields.provider,
    reason: fields.reason,
    scope_id: fields.scopeId,
    scope_kind: fields.scopeKind,
    source: fields.source,
    success: fields.success,
    ts: fields.ts,
    user_id: fields.userId,
  });
  return createHash("sha256").update(payload).digest("hex");
}

// ─── Audit-Row Writer ─────────────────────────────────────────────────────────

function writeAuditRow(entry: {
  scopeKind: string;
  scopeId: string;
  provider: string;
  userId: string;
  action: AccessAction;
  source: string | null;
  success: boolean;
  reason: string | null;
}): void {
  const db = getDb();
  const id = makeLogId();
  const ts = Date.now();
  const success = entry.success ? 1 : 0;
  const hash = computeLogHash({
    id,
    ts,
    scopeKind: entry.scopeKind,
    scopeId: entry.scopeId,
    provider: entry.provider,
    userId: entry.userId,
    action: entry.action,
    source: entry.source ?? null,
    success,
    reason: entry.reason ?? null,
  });

  db.$raw
    .prepare(
      `INSERT INTO credential_access_log
         (id, ts, scope_kind, scope_id, provider, user_id, action, source, success, reason, content_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      ts,
      entry.scopeKind,
      entry.scopeId,
      entry.provider,
      entry.userId,
      entry.action,
      entry.source ?? null,
      success,
      entry.reason ?? null,
      hash,
    );
}

// ─── Internal: fetch raw credential row ──────────────────────────────────────

function fetchCredRow(
  scopeKind: ScopeKind,
  scopeId: string,
  provider: string,
): ApiCredRaw | null {
  const db = getDb();
  const row = db.$raw
    .prepare(
      `SELECT * FROM api_credentials
       WHERE scope_kind = ? AND scope_id = ? AND provider = ?
       LIMIT 1`,
    )
    .get(scopeKind, scopeId, provider) as ApiCredRaw | undefined;
  return row ?? null;
}

// ─── Internal: read credential_isolation from workspace ───────────────────────

/**
 * Reads `credential_isolation` defensively and FAIL-CLOSED (Security-Critic B-1).
 *
 * ONLY the explicit string 'inherit' yields 'inherit'. Everything else — null,
 * garbage, a missing column (catch), the workspace does not exist — yields
 * 'isolated'. Rationale: a de-facto external workspace must NEVER
 * inherit org credentials by accident. Existing workspaces have the DB DEFAULT
 * 'inherit' (Migration ACL-3) → unchanged; only the unknown gets isolated.
 *
 * N6: deterministic. Fail-safe direction = MORE isolation (the safe side).
 */
function readCredentialIsolation(workspaceId: string): "inherit" | "isolated" {
  const db = getDb();
  try {
    const row = db.$raw
      .prepare(
        `SELECT credential_isolation FROM workspaces WHERE id = ? LIMIT 1`,
      )
      .get(workspaceId) as { credential_isolation?: string | null } | undefined;

    const val = row?.credential_isolation;
    // FAIL-CLOSED: only an explicit 'inherit' permits the org fallback.
    return val === "inherit" ? "inherit" : "isolated";
  } catch {
    // Column does not exist yet (ACL-3 not landed) → fail-closed isolated.
    return "isolated";
  }
}

// ─── putApiCredential ─────────────────────────────────────────────────────────

/**
 * Upsert of an API credential for scope+provider.
 *
 * Auth gate (Security-Critic M-3): workspace-scope → canEditWorkspaceContent,
 * org-scope → isOrgAdmin. Deny → NO write + deny audit + return null.
 * Provider validation (N-1): invalid provider → no write + deny audit.
 *
 * Encrypts the secret immediately with encryptCredential (AES-256-GCM).
 * Writes an audit row ('put'). Returns the row ID, or null on deny.
 *
 * N9: scope_kind + scope_id are the isolation anchor.
 * N10: content_hash is computed over the row.
 */
export function putApiCredential(
  input: PutApiCredentialInput,
  actor: PutActor,
): string | null {
  // ── N-1: provider validation (before any DB access) ───────────────────────
  if (!isValidProvider(input.provider)) {
    writeAuditRow({
      scopeKind: input.scopeKind,
      scopeId: input.scopeId,
      provider: input.provider,
      userId: actor.userId,
      action: "put",
      source: actor.source ?? "vault.putApiCredential",
      success: false,
      reason: "invalid-provider",
    });
    return null;
  }

  // ── M-3: auth gate ─────────────────────────────────────────────────────────
  if (!isVaultWriteAllowed(input.scopeKind, input.scopeId, actor.userId)) {
    writeAuditRow({
      scopeKind: input.scopeKind,
      scopeId: input.scopeId,
      provider: input.provider,
      userId: actor.userId,
      action: "put",
      source: actor.source ?? "vault.putApiCredential",
      success: false,
      reason: "auth-denied",
    });
    return null;
  }

  const db = getDb();
  const now = Date.now();
  const encrypted = encryptCredential(input.secret);
  const configJson = input.config ? JSON.stringify(input.config) : null;

  const existing = fetchCredRow(input.scopeKind, input.scopeId, input.provider);

  let id: string;

  if (existing) {
    id = existing.id;
    const hash = computeCredHash({
      scopeKind: input.scopeKind,
      scopeId: input.scopeId,
      provider: input.provider,
      credentialKind: input.kind,
      encryptedSecret: encrypted,
      configJson,
      createdAt: existing.created_at,
      updatedAt: now,
    });

    db.$raw
      .prepare(
        `UPDATE api_credentials
         SET credential_kind = ?, encrypted_secret = ?, config_json = ?,
             content_hash = ?, updated_at = ?
         WHERE scope_kind = ? AND scope_id = ? AND provider = ?`,
      )
      .run(
        input.kind,
        encrypted,
        configJson,
        hash,
        now,
        input.scopeKind,
        input.scopeId,
        input.provider,
      );
  } else {
    id = makeCredId();
    const hash = computeCredHash({
      scopeKind: input.scopeKind,
      scopeId: input.scopeId,
      provider: input.provider,
      credentialKind: input.kind,
      encryptedSecret: encrypted,
      configJson,
      createdAt: now,
      updatedAt: now,
    });

    db.$raw
      .prepare(
        `INSERT INTO api_credentials
           (id, scope_kind, scope_id, provider, credential_kind,
            encrypted_secret, config_json, content_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.scopeKind,
        input.scopeId,
        input.provider,
        input.kind,
        encrypted,
        configJson,
        hash,
        now,
        now,
      );
  }

  writeAuditRow({
    scopeKind: input.scopeKind,
    scopeId: input.scopeId,
    provider: input.provider,
    userId: actor.userId,
    action: "put",
    source: actor.source ?? "vault.putApiCredential",
    success: true,
    reason: existing ? "updated" : "created",
  });

  return id;
}

// ─── resolveApiCredential ─────────────────────────────────────────────────────

/**
 * D2 policy resolution:
 *
 *   1. Auth gate via canEditWorkspaceContent(getEffectiveWorkspaceRole).
 *      Non-member → null (no error leak) + deny audit row.
 *   2. Workspace-own credential (scope_kind='workspace', scope_id=workspaceId).
 *      Read the workspace-own credential: existing gate (a workspace editor may).
 *   3. Org fallback — ONLY when credential_isolation='inherit' (defensive default).
 *      For 'isolated' → NO org fallback, null when there is no WS credential.
 *      Org fallback (scope='org'): additionally require a REAL org/workspace membership via
 *      hasRealWorkspaceMembership — `solo-implicit-founder` alone is
 *      NOT enough (Security-Critic P0-C1: read-asymmetry fix 2026-05-25).
 *   4. Audit row on every call (success + reason OR deny + reason).
 *
 * Returns ResolvedApiCredential or null (on auth deny, not found,
 * decrypt error). Never throws exceptions upward.
 *
 * N2: no global fallback — the org fallback is explicitly scope-gated.
 * N8: audit row per call.
 * N9: scope anchor on every query.
 */
export function resolveApiCredential(
  workspaceId: string,
  userId: string,
  provider: string,
): ResolvedApiCredential | null {
  // ── 1. Auth gate ───────────────────────────────────────────────────────────
  const role = getEffectiveWorkspaceRole(userId, workspaceId);
  if (!canEditWorkspaceContent(role)) {
    writeAuditRow({
      scopeKind: "workspace",
      scopeId: workspaceId,
      provider,
      userId,
      action: "resolve",
      source: "vault.resolveApiCredential",
      success: false,
      reason: "auth-denied",
    });
    return null;
  }

  // ── 2. Workspace-own credential ───────────────────────────────────────────
  const wsRow = fetchCredRow("workspace", workspaceId, provider);
  if (wsRow) {
    const secret = safeDecrypt(wsRow.encrypted_secret);
    if (secret === null) {
      writeAuditRow({
        scopeKind: "workspace",
        scopeId: workspaceId,
        provider,
        userId,
        action: "resolve",
        source: "vault.resolveApiCredential",
        success: false,
        reason: "decrypt-error",
      });
      return null;
    }

    writeAuditRow({
      scopeKind: "workspace",
      scopeId: workspaceId,
      provider,
      userId,
      action: "resolve",
      source: "vault.resolveApiCredential",
      success: true,
      reason: "workspace-cred",
    });

    return {
      id: wsRow.id,
      provider,
      kind: wsRow.credential_kind as CredentialKind,
      secret,
      config: wsRow.config_json ? safeJsonParse(wsRow.config_json) : null,
      lastValidatedAt: wsRow.last_validated_at,
      source: "workspace-cred",
    };
  }

  // ── 3. Org fallback — only when credential_isolation='inherit' ────────────
  const isolation = readCredentialIsolation(workspaceId);
  if (isolation === "isolated") {
    // External customer isolation: no fallback, no leak.
    writeAuditRow({
      scopeKind: "workspace",
      scopeId: workspaceId,
      provider,
      userId,
      action: "resolve",
      source: "vault.resolveApiCredential",
      success: false,
      reason: "isolation-block",
    });
    return null;
  }

  // isolation='inherit' → org-membership gate (Security-Critic P0-C1).
  //
  // canEditWorkspaceContent() also returns true for 'solo-implicit-founder' —
  // that is an implicit bootstrap fallback without proven membership.
  // For the org-fallback read we require a REAL membership:
  //   (A) an explicit workspace_memberships row, OR
  //   (B) an org_memberships row for the workspace's org.
  // Without a real membership: deny + audit + null (no secret leak).
  if (!hasRealWorkspaceMembership(userId, workspaceId)) {
    writeAuditRow({
      scopeKind: "workspace",
      scopeId: workspaceId,
      provider,
      userId,
      action: "resolve",
      source: "vault.resolveApiCredential",
      success: false,
      reason: "org-fallback-membership-denied",
    });
    return null;
  }

  // Real membership confirmed → org lookup
  const org = findOrgForWorkspace(workspaceId);
  if (!org) {
    writeAuditRow({
      scopeKind: "workspace",
      scopeId: workspaceId,
      provider,
      userId,
      action: "resolve",
      source: "vault.resolveApiCredential",
      success: false,
      reason: "not-found",
    });
    return null;
  }

  const orgRow = fetchCredRow("org", org.id, provider);
  if (!orgRow) {
    writeAuditRow({
      scopeKind: "workspace",
      scopeId: workspaceId,
      provider,
      userId,
      action: "resolve",
      source: "vault.resolveApiCredential",
      success: false,
      reason: "not-found",
    });
    return null;
  }

  const orgSecret = safeDecrypt(orgRow.encrypted_secret);
  if (orgSecret === null) {
    writeAuditRow({
      scopeKind: "workspace",
      scopeId: workspaceId,
      provider,
      userId,
      action: "resolve",
      source: "vault.resolveApiCredential",
      success: false,
      reason: "decrypt-error",
    });
    return null;
  }

  writeAuditRow({
    // Audit references the workspace context (where the resolution took place),
    // not the org scope (to preserve N9 scope clarity).
    scopeKind: "workspace",
    scopeId: workspaceId,
    provider,
    userId,
    action: "resolve",
    source: "vault.resolveApiCredential",
    success: true,
    reason: "org-fallback",
  });

  return {
    id: orgRow.id,
    provider,
    kind: orgRow.credential_kind as CredentialKind,
    secret: orgSecret,
    config: orgRow.config_json ? safeJsonParse(orgRow.config_json) : null,
    lastValidatedAt: orgRow.last_validated_at,
    source: "org-fallback",
  };
}

// ─── deleteApiCredential ──────────────────────────────────────────────────────

/**
 * Deletes a credential (scope_kind + scope_id + provider).
 *
 * Auth gate (Security-Critic B-2): workspace-scope → canEditWorkspaceContent,
 * org-scope → isOrgAdmin. Deny → NO delete + deny audit + return false.
 * The vault no longer relies on the caller.
 *
 * Always writes an audit row.
 *
 * N9: deletion is only possible via all three isolation keys.
 */
export function deleteApiCredential(
  scopeKind: ScopeKind,
  scopeId: string,
  provider: string,
  actor: PutActor,
): boolean {
  // ── B-2: auth gate ─────────────────────────────────────────────────────────
  if (!isVaultWriteAllowed(scopeKind, scopeId, actor.userId)) {
    writeAuditRow({
      scopeKind,
      scopeId,
      provider,
      userId: actor.userId,
      action: "delete",
      source: actor.source ?? "vault.deleteApiCredential",
      success: false,
      reason: "auth-denied",
    });
    return false;
  }

  const db = getDb();
  const res = db.$raw
    .prepare(
      `DELETE FROM api_credentials
       WHERE scope_kind = ? AND scope_id = ? AND provider = ?`,
    )
    .run(scopeKind, scopeId, provider);

  const deleted = res.changes > 0;
  writeAuditRow({
    scopeKind,
    scopeId,
    provider,
    userId: actor.userId,
    action: "delete",
    source: actor.source ?? "vault.deleteApiCredential",
    success: deleted,
    reason: deleted ? "deleted" : "not-found",
  });

  return deleted;
}

// ─── decryptApiSecret (best-effort) ──────────────────────────────────────────

/**
 * Decrypts an encrypted_secret value.
 *
 * NEVER write the result into logs, HTTP responses or trace rows.
 * Returns null on a decrypt error (instead of an exception).
 */
export function decryptApiSecret(encryptedSecret: string): string | null {
  return safeDecrypt(encryptedSecret);
}

// ─── credentialExists (decrypt-free existence/scope check, ACL-5-D hardening) ──

/**
 * Result of credentialExists — decrypt-FREE.
 *
 * NEVER contains the (decrypted) secret. NO decrypt is performed —
 * only an existence lookup + scope derivation + the length of the encrypted
 * blob (NOT the plaintext length, NOT the plaintext).
 */
export interface CredentialExistence {
  /** true if a credential exists for scope+provider (or org fallback). */
  exists: boolean;
  /**
   * Where the credential would come from: 'workspace-cred' | 'org-fallback' | null.
   * null if none exists.
   */
  source: "workspace-cred" | "org-fallback" | null;
  /** Human-readable scope label, e.g. 'workspace:ws-1' or 'org-fallback'. */
  scopeLabel: string;
}

/**
 * Decrypt-FREE existence and scope check for an API credential.
 *
 * ACL-5-D hardening (Security-Critic Finding 3): previewCall must NOT decrypt
 * the real secret on every keyword-matching chat message. This
 * function determines ONLY whether a credential exists and in which scope —
 * WITHOUT calling decryptCredential(). No plaintext secret is ever touched.
 *
 * Mirrors the D2 resolution order of resolveApiCredential (workspace
 * first, org fallback only when credential_isolation='inherit') — but WITHOUT
 * decrypt and WITHOUT an auth-gate audit row (it is a cheap, read-only,
 * non-revealing check, not a 'resolve' event).
 *
 * @returns CredentialExistence (exists, source, scopeLabel) — never a secret.
 */
export function credentialExists(
  workspaceId: string,
  provider: string,
): CredentialExistence {
  // 1. Workspace-own credential.
  const wsRow = fetchCredRow("workspace", workspaceId, provider);
  if (wsRow) {
    return {
      exists: true,
      source: "workspace-cred",
      scopeLabel: `workspace:${workspaceId}`,
    };
  }

  // 2. Org fallback — only when credential_isolation='inherit' (fail-closed).
  const isolation = readCredentialIsolation(workspaceId);
  if (isolation === "isolated") {
    return { exists: false, source: null, scopeLabel: `workspace:${workspaceId}` };
  }

  const org = findOrgForWorkspace(workspaceId);
  if (!org) {
    return { exists: false, source: null, scopeLabel: `workspace:${workspaceId}` };
  }

  const orgRow = fetchCredRow("org", org.id, provider);
  if (orgRow) {
    return {
      exists: true,
      source: "org-fallback",
      scopeLabel: `org-fallback (workspace:${workspaceId})`,
    };
  }

  return { exists: false, source: null, scopeLabel: `workspace:${workspaceId}` };
}

// ─── recordRevealAudit (Security-Critic L-1) ──────────────────────────────────

/**
 * Writes a 'reveal' audit row (N8). Every plaintext revelation of a
 * credential — regardless of which route or which vault — MUST be audited,
 * not only via last_revealed_at.
 *
 * Wrapper over the internal writeAuditRow mechanism so that HTTP routes
 * (which have NO access to the private helper) write consistent reveal rows
 * with a correct content_hash (N10).
 */
export function recordRevealAudit(entry: {
  scopeKind: ScopeKind;
  scopeId: string;
  provider: string;
  userId: string;
  source?: string;
  success: boolean;
  reason?: string;
}): void {
  writeAuditRow({
    scopeKind: entry.scopeKind,
    scopeId: entry.scopeId,
    provider: entry.provider,
    userId: entry.userId,
    action: "reveal",
    source: entry.source ?? "api.credentials.reveal",
    success: entry.success,
    reason: entry.reason ?? (entry.success ? "revealed" : "reveal-failed"),
  });
}

// ─── Private Helpers ──────────────────────────────────────────────────────────

function safeDecrypt(encrypted: string): string | null {
  try {
    return decryptCredential(encrypted);
  } catch {
    return null;
  }
}

function safeJsonParse(raw: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
