/**
 * App-Store Registry (C4 · 2026-05-25).
 *
 * Public API:
 *   listApps        — list all app_manifests rows (with optional filters)
 *   getApp          — fetch a single manifest by app_id
 *   upsertManifest  — register or update a manifest (N10 hash + PII guard + sig)
 *   installApp      — create an app_installs record + audit row (N8)
 *   enableApp       — disabled → installed transition + audit row
 *   disableApp      — installed → disabled transition + audit row
 *   uninstallApp    — remove install record + audit row
 *   listInstalls    — list installs for a scope
 *   getInstall      — fetch a specific install record
 *
 * NON-DESTRUCTIVE:
 *   "install" = record in app_installs, KEIN echter MCP-Spawn, KEIN OAuth.
 *   The R3-gated activation marker is clearly documented inline as
 *   PHASE2_APP_ACTIVATE. Nothing in this module starts a process.
 *
 * PHASE2_APP_ACTIVATE boundary:
 *   The registry marks every place where a future activation hook would
 *   attach with the comment "// PHASE2_APP_ACTIVATE: <what would happen>".
 *   Phase 2 activation is triggered by an external orchestrator once R3
 *   unlocks (see ADR-0007 §lifecycle). This module only manages records.
 *
 * N8:  Every install/enable/disable/uninstall/verify action writes an audit row.
 * N10: content_hash over canonical JSON for all written rows.
 * PII: assertNonSensitiveManifest() is called before every manifest write.
 *
 * Connector mirror:
 *   When kind='connector' or kind='mcp-server', upsertManifest may call
 *   upsertConnectorProfile() to mirror declared capabilities into
 *   connector_catalog. This is done ONLY when mirrorToConnectorCatalog=true
 *   is passed — opt-in, not automatic. The mirror is non-destructive and
 *   does not duplicate data; connector_catalog has its own PII guard.
 *
 * DB dependency: getDb() from @/db/client (same pattern as catalog.ts + vault.ts).
 * No LLM, no external I/O, no process spawning.
 */

import { createHash, randomUUID } from "node:crypto";

import { and, eq, type SQL } from "drizzle-orm";

import { getDb } from "@/db/client";
import { canonicalJSON } from "@/lib-v1/audit/canonical-json";
import {
  APP_INSTALL_ACTIONS,
  APP_INSTALL_STATUSES,
  APP_KINDS,
  APP_SCOPE_KINDS,
  type AppInstallAction,
  type AppInstallRow,
  type AppInstallStatus,
  type AppManifestRow,
  type AppScopeKind,
  appInstallAudit,
  appInstalls,
  appManifests,
} from "@/db/schema/app_store";
import {
  type AppManifest,
  assertNonSensitiveManifest,
  assertSchemaStringsInManifest,
  validateManifest,
} from "@/lib/appstore/manifest";
import {
  type SignatureVerificationResult,
  verifyManifestSignature,
} from "@/lib/appstore/signature";

// ---------------------------------------------------------------------------
// ID helpers
// ---------------------------------------------------------------------------

function manifestId(): string {
  return `AMANI-${randomUUID()}`;
}
function installId(): string {
  return `AINST-${randomUUID()}`;
}
function auditId(): string {
  return `AIAUD-${randomUUID()}`;
}

// ---------------------------------------------------------------------------
// N10 content hashes
// ---------------------------------------------------------------------------

/**
 * Compute the N10 content_hash for an app_manifests row.
 * Excludes id and content_hash from the hash (deterministic across
 * insert + re-read).
 */
export function hashManifestRow(row: {
  appId: string;
  name: string;
  version: string;
  description: string | null | undefined;
  publisher: string | null | undefined;
  kind: string;
  manifestJson: string;
  signature: string | null | undefined;
  signatureStatus: string;
  source: string;
  createdAt: number;
  updatedAt: number;
}): string {
  const canonical = canonicalJSON({
    app_id: row.appId,
    name: row.name,
    version: row.version,
    description: row.description ?? null,
    publisher: row.publisher ?? null,
    kind: row.kind,
    manifest_json: row.manifestJson,
    signature: row.signature ?? null,
    signature_status: row.signatureStatus,
    source: row.source,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Compute the N10 content_hash for an app_installs row.
 */
export function hashInstallRow(row: {
  appId: string;
  scopeKind: string;
  scopeId: string;
  status: string;
  installedBy: string;
  installedAt: number;
}): string {
  const canonical = canonicalJSON({
    app_id: row.appId,
    scope_kind: row.scopeKind,
    scope_id: row.scopeId,
    status: row.status,
    installed_by: row.installedBy,
    installed_at: row.installedAt,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Compute the N10 content_hash for an app_install_audit row.
 */
export function hashAuditRow(row: {
  id: string;
  ts: number;
  appId: string;
  scope: string;
  actor: string;
  action: string;
  success: boolean;
  reason: string | null | undefined;
}): string {
  const canonical = canonicalJSON({
    id: row.id,
    ts: row.ts,
    app_id: row.appId,
    scope: row.scope,
    actor: row.actor,
    action: row.action,
    success: row.success,
    reason: row.reason ?? null,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// N8 audit helper — always writes, never throws
// ---------------------------------------------------------------------------

/**
 * writeInstallAudit — append an N8 trace row (best-effort, never aborts caller).
 *
 * Unlike vault.ts (which is fail-closed), app_install_audit is best-effort:
 * a failed audit write must not abort the install/enable/disable operation.
 * The install record is already committed; the audit row adds observability.
 *
 * N8-1: A failed audit write is NOT silently swallowed — it is logged via
 * console.error('[APP_STORE_AUDIT_WRITE_FAILED]', e) so that audit loss is
 * observable (N8: trace is evidence, not telemetry). The write stays best-
 * effort (it does not re-throw), but it is no longer dark.
 */
function writeInstallAudit(entry: {
  appId: string;
  scope: string;
  actor: string;
  action: AppInstallAction;
  success: boolean;
  reason: string | null;
}): void {
  try {
    const db = getDb();
    const id = auditId();
    const ts = Date.now();
    const contentHash = hashAuditRow({
      id,
      ts,
      appId: entry.appId,
      scope: entry.scope,
      actor: entry.actor,
      action: entry.action,
      success: entry.success,
      reason: entry.reason ?? null,
    });
    db.insert(appInstallAudit)
      .values({
        id,
        ts,
        appId: entry.appId,
        scope: entry.scope,
        actor: entry.actor,
        action: entry.action,
        success: entry.success,
        reason: entry.reason ?? null,
        contentHash,
      })
      .run();
  } catch (e) {
    // Best-effort: non-sensitive lifecycle record — degrade gracefully but
    // OBSERVABLY (N8-1). The install/enable/disable write already succeeded;
    // we only lost the audit row. Surface it so audit loss is not dark.
    // eslint-disable-next-line no-console
    console.error("[APP_STORE_AUDIT_WRITE_FAILED]", {
      appId: entry.appId,
      scope: entry.scope,
      action: entry.action,
      success: entry.success,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

// ---------------------------------------------------------------------------
// Scope label helper
// ---------------------------------------------------------------------------

function scopeLabel(scopeKind: AppScopeKind, scopeId: string): string {
  return `${scopeKind}:${scopeId}`;
}

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export type UpsertManifestInput = {
  /** Parsed + validated manifest object. */
  manifest: AppManifest;
  /** Origin of this manifest. Defaults to 'local'. */
  source?: "builtin" | "local" | "registry";
  /**
   * Optional BASE64URL-encoded signature over canonicalJSON(manifest).
   * If absent → signatureStatus='unsigned'.
   */
  signature?: string | null;
  /**
   * Optional PEM-encoded Ed25519 public key for signature verification.
   * If absent with a signature → signatureStatus='unverified'.
   */
  pubkeyPem?: string | null;
  /**
   * If true AND kind is 'connector' or 'mcp-server', mirror declared
   * capabilities into connector_catalog via upsertConnectorProfile().
   * Default: false (opt-in).
   */
  mirrorToConnectorCatalog?: boolean;
};

/**
 * AssertAccess — optional authorization callback injected by the Route-Layer.
 *
 * AUTH-1: This module performs NO authorization or membership checks itself
 * (same posture as the discovery layer, NOT the same as vault.ts which gates
 * internally). The Route-Layer is responsible for verifying that `actor` is a
 * member of `scopeId` before calling any lifecycle function.
 *
 * To let the Route-Layer enforce the gate at the lowest layer (defense in
 * depth), every lifecycle function accepts an optional `assertAccess` callback.
 * When provided, it is invoked BEFORE any DB write. If it throws, NO write and
 * NO success-audit row is produced — the throw propagates to the caller.
 *
 * Canonical wiring (Route-Layer):
 *   installApp({ ..., assertAccess: (actor, sk, sid) => {
 *     if (sk === 'workspace' && !hasRealWorkspaceMembership(actor, sid))
 *       throw new Error('[APP_STORE_AUTH_DENIED] not a member');
 *   }})
 *
 * See lib/security/membership.ts::hasRealWorkspaceMembership for the gate
 * the Route-Layer should use.
 */
export type AssertAccess = (
  actor: string,
  scopeKind: AppScopeKind,
  scopeId: string,
) => void;

export type InstallAppInput = {
  appId: string;
  scopeKind: AppScopeKind;
  scopeId: string;
  /** Actor performing the install (userId or 'system'). */
  actor?: string;
  /**
   * Initial status. Defaults to 'pending'.
   *
   * R3-1/SIG-1: Use 'installed' ONLY if the caller has already verified the
   * manifest's signatureStatus out-of-band. installApp() additionally HARD-
   * BLOCKS initialStatus='installed' when signatureStatus==='invalid' (throws).
   * It does NOT block 'unsigned'/'unverified' → 'installed' (that gate is a
   * known Phase-2 policy decision, see ADR-0007 §SIG-1). Default is 'pending'.
   */
  initialStatus?: AppInstallStatus;
  /**
   * AUTH-1: Optional authorization callback. When provided, invoked BEFORE
   * any DB write with (actor, scopeKind, scopeId). If it throws, no write
   * and no success-audit row is produced.
   */
  assertAccess?: AssertAccess;
};

// ---------------------------------------------------------------------------
// listApps
// ---------------------------------------------------------------------------

export type ListAppsFilter = {
  kind?: AppManifest["kind"];
  source?: "builtin" | "local" | "registry";
  signatureStatus?: "unsigned" | "valid" | "invalid" | "unverified";
};

/**
 * listApps — list all registered app manifests.
 *
 * QUERY-1: Applies ALL set filters as a compound AND condition (previously
 * an if/else-if chain only honored the first filter). Returns all rows when
 * no filter is given.
 */
export function listApps(filter?: ListAppsFilter): AppManifestRow[] {
  const db = getDb();

  const conditions: SQL[] = [];
  if (filter?.kind !== undefined) {
    conditions.push(eq(appManifests.kind, filter.kind));
  }
  if (filter?.source !== undefined) {
    conditions.push(eq(appManifests.source, filter.source));
  }
  if (filter?.signatureStatus !== undefined) {
    conditions.push(eq(appManifests.signatureStatus, filter.signatureStatus));
  }

  if (conditions.length === 0) {
    return db.select().from(appManifests).all();
  }

  return db
    .select()
    .from(appManifests)
    .where(conditions.length === 1 ? conditions[0] : and(...conditions))
    .all();
}

// ---------------------------------------------------------------------------
// getApp
// ---------------------------------------------------------------------------

/**
 * getApp — fetch a single manifest by app_id.
 * Returns null if not found.
 */
export function getApp(appId: string): AppManifestRow | null {
  const db = getDb();
  return (
    db
      .select()
      .from(appManifests)
      .where(eq(appManifests.appId, appId))
      .get() ?? null
  );
}

// ---------------------------------------------------------------------------
// upsertManifest
// ---------------------------------------------------------------------------

/**
 * upsertManifest — register or update an app manifest in the catalog.
 *
 * Runs in order:
 *   1. PII Hard-Guard (assertNonSensitiveManifest) — throws on forbidden keys.
 *   2. Schema-string guard (assertSchemaStringsInManifest) — rejects raw objects.
 *   3. Zod validation (validateManifest) — structural schema check.
 *   4. Signature verification (verifyManifestSignature) — N6 deterministic.
 *   5. Upsert app_manifests row with N10 content_hash.
 *   6. Optional: mirror capabilities to connector_catalog (opt-in).
 *
 * @throws {Error} with code 'APP_STORE_PII_GUARD' — PII/schema guard violations.
 * @throws {Error} with code 'APP_MANIFEST_VALIDATION_ERROR' — Zod schema failure.
 */
export function upsertManifest(input: UpsertManifestInput): AppManifestRow {
  const { manifest, source = "local", signature = null, pubkeyPem = null } = input;

  // 1+2. PII guards (run on the raw manifest object — same as parseManifest caller would have done,
  //   but we re-run defensively here as belt-and-suspenders)
  assertNonSensitiveManifest(manifest as unknown as Record<string, unknown>);
  assertSchemaStringsInManifest(manifest as unknown as Record<string, unknown>);

  // 3. Zod validation (N6 — deterministic)
  const validation = validateManifest(manifest as unknown as Record<string, unknown>);
  if (!validation.ok) {
    const err = new Error(
      `[APP_MANIFEST_VALIDATION_ERROR] Manifest schema validation failed: ` +
        validation.errors.join("; "),
    );
    (err as Error & { code: string }).code = "APP_MANIFEST_VALIDATION_ERROR";
    throw err;
  }

  // 4. Signature verification (N6 — deterministic)
  const sigResult: SignatureVerificationResult = verifyManifestSignature(
    validation.manifest,
    signature ?? null,
    pubkeyPem ?? null,
  );

  const db = getDb();
  const now = Date.now();

  // Check for existing row (upsert logic)
  const existing = db
    .select()
    .from(appManifests)
    .where(eq(appManifests.appId, manifest.appId))
    .get();

  const id = existing?.id ?? manifestId();
  const createdAt = existing?.createdAt ?? now;
  const manifestJson = JSON.stringify(manifest);

  // 5. Compute N10 hash
  const contentHash = hashManifestRow({
    appId: manifest.appId,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description ?? null,
    publisher: manifest.publisher ?? null,
    kind: manifest.kind,
    manifestJson,
    signature: signature ?? null,
    signatureStatus: sigResult.status,
    source,
    createdAt,
    updatedAt: now,
  });

  // 5b. Upsert app_manifests row
  db.insert(appManifests)
    .values({
      id,
      appId: manifest.appId,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description ?? null,
      publisher: manifest.publisher ?? null,
      kind: manifest.kind,
      manifestJson,
      signature: signature ?? null,
      signatureStatus: sigResult.status,
      source,
      contentHash,
      createdAt,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: appManifests.appId,
      set: {
        name: manifest.name,
        version: manifest.version,
        description: manifest.description ?? null,
        publisher: manifest.publisher ?? null,
        kind: manifest.kind,
        manifestJson,
        signature: signature ?? null,
        signatureStatus: sigResult.status,
        source,
        contentHash,
        updatedAt: now,
      },
    })
    .run();

  // 6. Optional mirror to connector_catalog (opt-in, non-destructive)
  // PHASE2_APP_ACTIVATE: at activation time, the MCP server command in
  //   manifest.mcpServerCommand would be used to spawn the server process.
  //   For now we only optionally mirror static capability metadata.
  if (input.mirrorToConnectorCatalog && (manifest.kind === "connector" || manifest.kind === "mcp-server")) {
    mirrorToConnectorCatalog(manifest);
  }

  return db
    .select()
    .from(appManifests)
    .where(eq(appManifests.appId, manifest.appId))
    .get()!;
}

// ---------------------------------------------------------------------------
// installApp
// ---------------------------------------------------------------------------

/**
 * installApp — create an app_installs record and write an N8 audit row.
 *
 * NON-DESTRUCTIVE: creates a record in app_installs. Does NOT start any
 * process, OAuth flow, or MCP server.
 *
 * @precondition AUTH-1: This function performs NO authorization. The Caller
 *   MUST verify that `actor` has membership in `scopeId` before calling —
 *   same posture as vault.ts callers. At the Route-Layer, gate via
 *   lib/security/membership.ts::hasRealWorkspaceMembership (workspace scope)
 *   or the equivalent org-membership check (org scope). Alternatively, pass
 *   `input.assertAccess` so the gate runs inside this function before any
 *   write.
 *
 * R3-1/SIG-1: If `initialStatus==='installed'` AND the manifest's stored
 *   signatureStatus is 'invalid', this throws APP_SIGNATURE_INVALID — an
 *   invalid signature must never reach an 'installed' record. 'unsigned' and
 *   'unverified' are NOT hard-blocked here (Phase-2 policy gap, see ADR-0007).
 *
 * PHASE2_APP_ACTIVATE: When status='installed', this is where a future
 *   activation hook would attach. The activator (R3-gated) would read the
 *   manifest.mcpServerCommand and start the server. This foundation does
 *   not implement that step.
 *
 * @throws {Error} with code 'APP_NOT_FOUND' if appId does not exist in app_manifests.
 * @throws {Error} with code 'APP_SIGNATURE_INVALID' if initialStatus='installed'
 *   and signatureStatus='invalid'.
 * @throws whatever `input.assertAccess` throws (before any write).
 * @returns the created or updated AppInstallRow.
 */
export function installApp(input: InstallAppInput): AppInstallRow {
  const {
    appId,
    scopeKind,
    scopeId,
    actor = "system",
    initialStatus = "pending",
    assertAccess,
  } = input;

  // AUTH-1: optional injected authorization gate — runs BEFORE any DB write.
  // If it throws, no write and no success-audit row is produced.
  if (assertAccess) {
    assertAccess(actor, scopeKind, scopeId);
  }

  const db = getDb();

  // Verify the manifest exists
  const manifest = db
    .select()
    .from(appManifests)
    .where(eq(appManifests.appId, appId))
    .get();

  if (!manifest) {
    const err = new Error(
      `[APP_NOT_FOUND] No manifest found for app_id '${appId}'. ` +
        `Call upsertManifest() first to register the app.`,
    );
    (err as Error & { code: string }).code = "APP_NOT_FOUND";
    throw err;
  }

  // R3-1/SIG-1: hard-block 'installed' for an invalid-signature manifest.
  if (initialStatus === "installed" && manifest.signatureStatus === "invalid") {
    const err = new Error(
      `[APP_SIGNATURE_INVALID] Cannot install app '${appId}' with status ` +
        `'installed': manifest signatureStatus is 'invalid'. Re-verify the ` +
        `manifest signature before activating.`,
    );
    (err as Error & { code: string }).code = "APP_SIGNATURE_INVALID";
    throw err;
  }

  const now = Date.now();
  const scope = scopeLabel(scopeKind, scopeId);

  // Check for existing install (idempotent upsert)
  const existing = db
    .select()
    .from(appInstalls)
    .where(
      and(
        eq(appInstalls.appId, appId),
        eq(appInstalls.scopeKind, scopeKind),
        eq(appInstalls.scopeId, scopeId),
      ),
    )
    .get();

  if (existing) {
    // Already installed — update status if needed and write audit row
    const newStatus: AppInstallStatus =
      existing.status === "installed" ? "installed" : initialStatus;

    if (existing.status !== newStatus) {
      const contentHash = hashInstallRow({
        appId,
        scopeKind,
        scopeId,
        status: newStatus,
        installedBy: existing.installedBy,
        installedAt: existing.installedAt,
      });

      db.update(appInstalls)
        .set({ status: newStatus, contentHash })
        .where(eq(appInstalls.id, existing.id))
        .run();
    }

    writeInstallAudit({
      appId,
      scope,
      actor,
      action: "install",
      success: true,
      reason: existing.status === "installed" ? "idempotent-already-installed" : "status-updated",
    });

    return db
      .select()
      .from(appInstalls)
      .where(eq(appInstalls.id, existing.id))
      .get()!;
  }

  // New install
  const id = installId();
  const contentHash = hashInstallRow({
    appId,
    scopeKind,
    scopeId,
    status: initialStatus,
    installedBy: actor,
    installedAt: now,
  });

  db.insert(appInstalls)
    .values({
      id,
      appId,
      scopeKind,
      scopeId,
      status: initialStatus,
      installedBy: actor,
      installedAt: now,
      contentHash,
    })
    .run();

  // R3-1/SIG-1: initialStatus='installed' is only safe when the caller has
  //   verified the manifest signatureStatus beforehand. We hard-block
  //   signatureStatus==='invalid' above; the default is 'pending'. Promoting
  //   'unsigned'/'unverified' manifests to 'installed' is a deliberate caller
  //   choice that Phase-2 policy may further restrict (ADR-0007 §SIG-1 gap).
  // PHASE2_APP_ACTIVATE: If initialStatus='installed' and kind='mcp-server',
  //   the future activator would read manifest.mcpServerCommand here and
  //   spawn the MCP server process via the platform's process manager.
  //   That step requires R3 unlock and is NOT implemented in this phase.

  writeInstallAudit({
    appId,
    scope,
    actor,
    action: "install",
    success: true,
    reason: `status:${initialStatus}`,
  });

  return db
    .select()
    .from(appInstalls)
    .where(eq(appInstalls.id, id))
    .get()!;
}

// ---------------------------------------------------------------------------
// enableApp / disableApp
// ---------------------------------------------------------------------------

/**
 * enableApp — transition an install from 'disabled' to 'installed'.
 *
 * @precondition AUTH-1: This function performs NO authorization. The Caller
 *   MUST verify that `actor` has membership in `scopeId` before calling —
 *   same posture as vault.ts callers. At the Route-Layer, gate via
 *   lib/security/membership.ts::hasRealWorkspaceMembership (workspace scope)
 *   or the equivalent org-membership check. Alternatively, pass `assertAccess`
 *   so the gate runs inside this function before any write.
 *
 * PHASE2_APP_ACTIVATE: Future hook point. At R3 activation, re-enabling
 *   would also restart the MCP server process if it had been stopped.
 *   This foundation only updates the status record.
 *
 * @throws whatever `assertAccess` throws (before any write).
 * @returns true if transitioned, false if not found or already installed.
 */
export function enableApp(
  appId: string,
  scopeKind: AppScopeKind,
  scopeId: string,
  actor = "system",
  assertAccess?: AssertAccess,
): boolean {
  // AUTH-1: optional injected authorization gate — runs BEFORE any DB write.
  if (assertAccess) {
    assertAccess(actor, scopeKind, scopeId);
  }

  const db = getDb();
  const scope = scopeLabel(scopeKind, scopeId);

  const existing = db
    .select()
    .from(appInstalls)
    .where(
      and(
        eq(appInstalls.appId, appId),
        eq(appInstalls.scopeKind, scopeKind),
        eq(appInstalls.scopeId, scopeId),
      ),
    )
    .get();

  if (!existing) {
    writeInstallAudit({ appId, scope, actor, action: "enable", success: false, reason: "not-found" });
    return false;
  }

  if (existing.status === "installed") {
    writeInstallAudit({ appId, scope, actor, action: "enable", success: true, reason: "already-installed" });
    return true;
  }

  const contentHash = hashInstallRow({
    appId,
    scopeKind,
    scopeId,
    status: "installed",
    installedBy: existing.installedBy,
    installedAt: existing.installedAt,
  });

  db.update(appInstalls)
    .set({ status: "installed", contentHash })
    .where(eq(appInstalls.id, existing.id))
    .run();

  writeInstallAudit({ appId, scope, actor, action: "enable", success: true, reason: "enabled" });
  return true;
}

/**
 * disableApp — transition an install from 'installed' to 'disabled'.
 *
 * @precondition AUTH-1: This function performs NO authorization. The Caller
 *   MUST verify that `actor` has membership in `scopeId` before calling —
 *   same posture as vault.ts callers. At the Route-Layer, gate via
 *   lib/security/membership.ts::hasRealWorkspaceMembership (workspace scope)
 *   or the equivalent org-membership check. Alternatively, pass `assertAccess`
 *   so the gate runs inside this function before any write.
 *
 * PHASE2_APP_ACTIVATE: Future hook point. At R3, disabling would also
 *   stop the MCP server process gracefully.
 *
 * @throws whatever `assertAccess` throws (before any write).
 * @returns true if transitioned, false if not found or already disabled.
 */
export function disableApp(
  appId: string,
  scopeKind: AppScopeKind,
  scopeId: string,
  actor = "system",
  assertAccess?: AssertAccess,
): boolean {
  // AUTH-1: optional injected authorization gate — runs BEFORE any DB write.
  if (assertAccess) {
    assertAccess(actor, scopeKind, scopeId);
  }

  const db = getDb();
  const scope = scopeLabel(scopeKind, scopeId);

  const existing = db
    .select()
    .from(appInstalls)
    .where(
      and(
        eq(appInstalls.appId, appId),
        eq(appInstalls.scopeKind, scopeKind),
        eq(appInstalls.scopeId, scopeId),
      ),
    )
    .get();

  if (!existing) {
    writeInstallAudit({ appId, scope, actor, action: "disable", success: false, reason: "not-found" });
    return false;
  }

  if (existing.status === "disabled") {
    writeInstallAudit({ appId, scope, actor, action: "disable", success: true, reason: "already-disabled" });
    return true;
  }

  const contentHash = hashInstallRow({
    appId,
    scopeKind,
    scopeId,
    status: "disabled",
    installedBy: existing.installedBy,
    installedAt: existing.installedAt,
  });

  db.update(appInstalls)
    .set({ status: "disabled", contentHash })
    .where(eq(appInstalls.id, existing.id))
    .run();

  writeInstallAudit({ appId, scope, actor, action: "disable", success: true, reason: "disabled" });
  return true;
}

// ---------------------------------------------------------------------------
// uninstallApp
// ---------------------------------------------------------------------------

/**
 * uninstallApp — remove an install record + write an N8 audit row.
 *
 * @precondition AUTH-1: This function performs NO authorization. The Caller
 *   MUST verify that `actor` has membership in `scopeId` before calling —
 *   same posture as vault.ts callers. At the Route-Layer, gate via
 *   lib/security/membership.ts::hasRealWorkspaceMembership (workspace scope)
 *   or the equivalent org-membership check. Alternatively, pass `assertAccess`
 *   so the gate runs inside this function before any write.
 *
 * NOTE: This removes the app_installs row. The app_manifests row is NOT
 * removed (manifests are versioned records, not session state). To fully
 * remove a manifest, delete it via direct DB operation (not exposed here
 * to prevent accidental data loss).
 *
 * PHASE2_APP_ACTIVATE: Future hook. At R3, uninstall would also terminate
 *   the MCP server process and revoke credential bindings.
 *
 * @throws whatever `assertAccess` throws (before any write).
 * @returns true if an install record was found and removed, false otherwise.
 */
export function uninstallApp(
  appId: string,
  scopeKind: AppScopeKind,
  scopeId: string,
  actor = "system",
  assertAccess?: AssertAccess,
): boolean {
  // AUTH-1: optional injected authorization gate — runs BEFORE any DB write.
  if (assertAccess) {
    assertAccess(actor, scopeKind, scopeId);
  }

  const db = getDb();
  const scope = scopeLabel(scopeKind, scopeId);

  const existing = db
    .select()
    .from(appInstalls)
    .where(
      and(
        eq(appInstalls.appId, appId),
        eq(appInstalls.scopeKind, scopeKind),
        eq(appInstalls.scopeId, scopeId),
      ),
    )
    .get();

  if (!existing) {
    writeInstallAudit({ appId, scope, actor, action: "uninstall", success: false, reason: "not-found" });
    return false;
  }

  db.delete(appInstalls)
    .where(eq(appInstalls.id, existing.id))
    .run();

  writeInstallAudit({ appId, scope, actor, action: "uninstall", success: true, reason: "uninstalled" });
  return true;
}

// ---------------------------------------------------------------------------
// listInstalls / getInstall
// ---------------------------------------------------------------------------

/**
 * listInstalls — list all install records for a scope.
 * Returns an empty array if no installs exist.
 */
export function listInstalls(
  scopeKind: AppScopeKind,
  scopeId: string,
): AppInstallRow[] {
  const db = getDb();
  return db
    .select()
    .from(appInstalls)
    .where(
      and(
        eq(appInstalls.scopeKind, scopeKind),
        eq(appInstalls.scopeId, scopeId),
      ),
    )
    .all();
}

/**
 * getInstall — fetch a specific install record.
 * Returns null if not found.
 */
export function getInstall(
  appId: string,
  scopeKind: AppScopeKind,
  scopeId: string,
): AppInstallRow | null {
  const db = getDb();
  return (
    db
      .select()
      .from(appInstalls)
      .where(
        and(
          eq(appInstalls.appId, appId),
          eq(appInstalls.scopeKind, scopeKind),
          eq(appInstalls.scopeId, scopeId),
        ),
      )
      .get() ?? null
  );
}

/**
 * listInstallAudit — list N8 audit rows for an app (most-recent-first).
 * Read-only convenience for verification/tests.
 */
export function listInstallAudit(appId: string) {
  const db = getDb();
  return db
    .select()
    .from(appInstallAudit)
    .where(eq(appInstallAudit.appId, appId))
    .all();
}

// ---------------------------------------------------------------------------
// Internal: connector_catalog mirror (opt-in bridge, non-destructive)
// ---------------------------------------------------------------------------

/**
 * mirrorToConnectorCatalog — mirror app capabilities into connector_catalog.
 *
 * Called by upsertManifest when mirrorToConnectorCatalog=true and
 * kind is 'connector' or 'mcp-server'.
 *
 * This is a non-destructive best-effort operation: failures are swallowed
 * so they do not abort the manifest upsert. The mirror is informational —
 * connector_catalog has its own PII guard and audit trail.
 *
 * PHASE2_APP_ACTIVATE boundary: this mirrors STATIC capability metadata.
 * Dynamic connection (API calls, OAuth) is R3-gated and NOT done here.
 */
function mirrorToConnectorCatalog(manifest: AppManifest): void {
  try {
    // Dynamic import to avoid circular dependencies — catalog.ts imports from
    // db/schema/connectors, not from lib/appstore. This import is safe because
    // it only runs when explicitly requested by the caller.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { upsertConnectorProfile } = require("@/lib/connectors/catalog") as {
      upsertConnectorProfile: (profile: unknown, ctx?: unknown) => unknown;
    };

    const capabilities = manifest.capabilities?.map((cap) => ({
      name: cap.name,
      description: cap.description ?? null,
      mcpToolName: cap.mcpToolName ?? null,
      required: cap.required ?? false,
    })) ?? [];

    // Also include MCP tools as capabilities
    const mcpCaps = manifest.mcpTools?.map((tool) => ({
      name: tool.name,
      description: tool.description ?? null,
      inputSchemaJson: tool.inputSchemaJson ?? null,
      mcpToolName: tool.name,
      required: false,
    })) ?? [];

    const allCaps = [...capabilities, ...mcpCaps];

    upsertConnectorProfile(
      {
        provider: manifest.appId,
        displayName: manifest.name,
        description: manifest.description ?? null,
        // source: app-store-managed manifest → 'mcp-discovery' if mcp-server, else 'manual'
        source: manifest.kind === "mcp-server" ? "mcp-discovery" : "manual",
        ...(allCaps.length > 0 ? { capabilities: allCaps } : {}),
      },
      { actor: "app-store-mirror" },
    );
  } catch {
    // Best-effort: mirror failure must not abort the manifest upsert.
    // The connector_catalog is a separate concern.
  }
}
