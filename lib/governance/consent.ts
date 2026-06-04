/**
 * G1 — Consent-Levels (Phase 2 W2.1 · Lane G Governance · 2026-05-29).
 *
 * Master-Briefing §13.2 (verbatim, N1):
 *   „Opt-in · Transparenz · Zweckbindung · Datenminimierung · Pause/Stop
 *    jederzeit · Redaction · keine geheimen Screenshots · keine Passwörter ·
 *    keine privaten Daten · Review durch betroffene Person · Betriebsrat/
 *    Arbeitsrecht beachten"
 *
 * Lane G is the FUNDAMENTAL lane (Stage 1, Governance Gate Contract). All
 * other lanes hang off the gate that these functions provide.
 *
 * Mechanics (analogous to lib/reasoning/beliefs-repo.ts):
 *   - Takes a RAW better-sqlite3 handle — no getDb() singleton,
 *     directly in-memory testable.
 *   - PURE/low-IO: only DB read/write, NO LLM, NO net I/O.
 *   - N1:  reason_text VERBATIM (no .slice).
 *   - N9:  workspaceId-scoped.
 *   - N10: content_hash (sha256 over canonical JSON) per grant row.
 *
 * Append-only discipline (N8) is encoded in Migration 0118 via triggers:
 *   - DELETE on consent_grants → RAISE ABORT.
 *   - UPDATE on id/workspace_id/user_id/data_source/level/scope_json/
 *     reason_text/granted_at/content_hash → RAISE ABORT.
 *   - revoked_at may ONLY be set via revokeConsent (a controlled
 *     UPDATE operation that, BESIDES the column update, also creates an audit
 *     row in governance_audit — see lib/governance/audit.ts).
 *
 * Public API:
 *   hasConsent(raw, req)       — boolean, deterministic
 *   grantConsent(raw, input)   — creates a NEW grant row
 *   revokeConsent(raw, input)  — sets revoked_at on an existing
 *                                grant row + writes an audit row (the trigger
 *                                allows UPDATE ONLY on revoked_at)
 *   listConsents(raw, workspaceId, opts?)
 *                              — all grants (active + revoked), newest first
 *
 * Level ordering (higher level covers lower):
 *   none < read-only < read-derive < read-derive-act < full-automation
 */

import { createHash } from "node:crypto";

import { ulid } from "@/lib/ulid";

type RawDb = import("better-sqlite3").Database;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Owner directive §13.2 — granular consent. */
export type ConsentLevel =
  | "none"
  | "read-only"
  | "read-derive"
  | "read-derive-act"
  | "full-automation";

/** Data sources that require consent. */
export type DataSource =
  | "whatsapp"
  | "telegram"
  | "voice"
  | "meeting"
  | "email"
  | "browser-shadow"
  | "screen-capture"
  | "keystroke-capture"
  | "workspace-derive";

export interface ConsentScope {
  /** Optional time window for the permission (ms-epoch). */
  readonly timeWindow?: { readonly fromMs?: number; readonly toMs?: number };
  /** Optional data-minimization profile (whitelist of fields). */
  readonly dataMin?: readonly string[];
}

export interface ConsentGrant {
  readonly id: string;
  readonly workspaceId: string;
  readonly userId: string;
  readonly dataSource: DataSource | string;
  readonly level: ConsentLevel;
  readonly scope: ConsentScope | null;
  /** §13.2 verbatim rationale (N1). */
  readonly reasonText: string;
  readonly grantedAt: number;
  /** Nullable. When set → grant has been revoked. */
  readonly revokedAt: number | null;
  readonly contentHash: string;
}

export interface HasConsentArgs {
  readonly workspaceId: string;
  readonly userId: string;
  readonly dataSource: DataSource | string;
  readonly requiredLevel: ConsentLevel;
  /** Optional: timestamp of the check (default Date.now()). */
  readonly nowMs?: number;
}

export interface GrantConsentInput {
  readonly workspaceId: string;
  readonly userId: string;
  readonly dataSource: DataSource | string;
  readonly level: ConsentLevel;
  readonly scope?: ConsentScope | null;
  /** §13.2 verbatim rationale (N1). */
  readonly reasonText: string;
}

export interface RevokeConsentInput {
  readonly workspaceId: string;
  readonly userId: string;
  readonly dataSource: DataSource | string;
  /** Optional: specific grant ID, otherwise the most recent active grant row. */
  readonly grantId?: string;
}

// ---------------------------------------------------------------------------
// Level ordering
// ---------------------------------------------------------------------------

const LEVEL_RANK: Record<ConsentLevel, number> = {
  none: 0,
  "read-only": 1,
  "read-derive": 2,
  "read-derive-act": 3,
  "full-automation": 4,
};

/**
 * true ⇔ `granted` covers `required`. A higher level covers a lower one.
 * Pure function — exported for tests + canAutoRun (no-auto-run.ts).
 */
export function levelCovers(granted: ConsentLevel, required: ConsentLevel): boolean {
  return LEVEL_RANK[granted] >= LEVEL_RANK[required];
}

const VALID_LEVELS: ReadonlySet<ConsentLevel> = new Set([
  "none",
  "read-only",
  "read-derive",
  "read-derive-act",
  "full-automation",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nowMs(): number {
  return Date.now();
}

/** N10: sha256 over canonical JSON → always 64 hex characters. */
function sha256hex(payload: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function mapGrantRow(r: Record<string, unknown>): ConsentGrant {
  let scope: ConsentScope | null = null;
  const rawScope = r.scope_json;
  if (typeof rawScope === "string" && rawScope.length > 0) {
    try {
      scope = JSON.parse(rawScope) as ConsentScope;
    } catch {
      // fail-soft: invalid scope_json → null. Never throw.
      scope = null;
    }
  }
  return {
    id: String(r.id),
    workspaceId: String(r.workspace_id),
    userId: String(r.user_id),
    dataSource: String(r.data_source),
    level: String(r.level) as ConsentLevel,
    scope,
    reasonText: String(r.reason_text),
    grantedAt: Number(r.granted_at),
    revokedAt: r.revoked_at == null ? null : Number(r.revoked_at),
    contentHash: String(r.content_hash),
  };
}

function validateArgs(args: {
  workspaceId: string;
  userId: string;
  dataSource: string;
}): void {
  if (typeof args.workspaceId !== "string" || args.workspaceId.length === 0) {
    throw new Error("consent: workspaceId required");
  }
  if (typeof args.userId !== "string" || args.userId.length === 0) {
    throw new Error("consent: userId required");
  }
  if (typeof args.dataSource !== "string" || args.dataSource.length === 0) {
    throw new Error("consent: dataSource required");
  }
}

// ---------------------------------------------------------------------------
// hasConsent — deterministic check (N6: validators before LLM)
// ---------------------------------------------------------------------------

/**
 * Checks whether an ACTIVE grant with at least the required level exists for
 * (workspaceId, userId, dataSource).
 *
 * "Active" = revoked_at IS NULL AND (no timeWindow OR nowMs is within the
 * window). A higher ConsentLevel covers a lower one
 * (see levelCovers).
 *
 * Pure DB read, no LLM, fail-closed: any invalid input → false.
 */
export function hasConsent(raw: RawDb, args: HasConsentArgs): boolean {
  if (
    typeof args.workspaceId !== "string" ||
    args.workspaceId.length === 0 ||
    typeof args.userId !== "string" ||
    args.userId.length === 0 ||
    typeof args.dataSource !== "string" ||
    args.dataSource.length === 0
  ) {
    return false;
  }
  if (!VALID_LEVELS.has(args.requiredLevel)) {
    return false;
  }
  const now = args.nowMs ?? nowMs();
  const rows = raw
    .prepare(
      `SELECT * FROM consent_grants
        WHERE workspace_id = ? AND user_id = ? AND data_source = ?
          AND revoked_at IS NULL
        ORDER BY granted_at DESC, id DESC`,
    )
    .all(args.workspaceId, args.userId, args.dataSource) as Record<
    string,
    unknown
  >[];

  for (const row of rows) {
    const grant = mapGrantRow(row);
    // Time-window check (if scope.timeWindow is set).
    if (grant.scope?.timeWindow) {
      const { fromMs, toMs } = grant.scope.timeWindow;
      if (typeof fromMs === "number" && now < fromMs) continue;
      if (typeof toMs === "number" && now > toMs) continue;
    }
    if (levelCovers(grant.level, args.requiredLevel)) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// grantConsent — creates a NEW grant row (append-only spirit)
// ---------------------------------------------------------------------------

/**
 * Creates a new consent grant. Earlier grants for the same
 * (workspace, user, dataSource) combination are kept — the history
 * is traceable via listConsents. hasConsent automatically considers
 * the highest-valued NON-REVOKED grant.
 *
 * reason_text is persisted VERBATIM (N1). content_hash (N10) is computed over
 * the canonical JSON of the grant fields.
 */
export function grantConsent(raw: RawDb, input: GrantConsentInput): ConsentGrant {
  validateArgs({
    workspaceId: input.workspaceId,
    userId: input.userId,
    dataSource: input.dataSource,
  });
  if (!VALID_LEVELS.has(input.level)) {
    throw new Error(
      `grantConsent: invalid level '${String(input.level)}' — must be one of ${[
        ...VALID_LEVELS,
      ].join(", ")}`,
    );
  }
  if (typeof input.reasonText !== "string" || input.reasonText.length === 0) {
    throw new Error(
      "grantConsent: reasonText required (§13.2 verbatim Begründung, N1)",
    );
  }

  const id = `CGT-${ulid()}`;
  const ts = nowMs();
  const scopeJson = input.scope ? JSON.stringify(input.scope) : null;
  const contentHash = sha256hex({
    workspace_id: input.workspaceId,
    user_id: input.userId,
    data_source: input.dataSource,
    level: input.level,
    scope_json: scopeJson,
    reason_text: input.reasonText,
    granted_at: ts,
  });

  raw
    .prepare(
      `INSERT INTO consent_grants
         (id, workspace_id, user_id, data_source, level, scope_json,
          reason_text, granted_at, revoked_at, content_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    )
    .run(
      id,
      input.workspaceId,
      input.userId,
      input.dataSource,
      input.level,
      scopeJson,
      input.reasonText, // N1: verbatim
      ts,
      contentHash,
    );

  return {
    id,
    workspaceId: input.workspaceId,
    userId: input.userId,
    dataSource: input.dataSource,
    level: input.level,
    scope: input.scope ?? null,
    reasonText: input.reasonText,
    grantedAt: ts,
    revokedAt: null,
    contentHash,
  };
}

// ---------------------------------------------------------------------------
// revokeConsent — sets revoked_at on the most recent active grant row
// ---------------------------------------------------------------------------

/**
 * Owner directive §13.2 „Pause/Stop jederzeit": a person can withdraw their
 * consent at any time. The grant row is kept for N8 reasons
 * (the DELETE trigger blocks); revoked_at is set.
 *
 * If grantId is given, that specific grant is revoked. Otherwise:
 * the most recent ACTIVE grant (revoked_at IS NULL) for the (workspace, user,
 * dataSource) combination.
 *
 * Returns the revoked grant row, or null if nothing could be
 * revoked (fail-soft).
 */
export function revokeConsent(
  raw: RawDb,
  input: RevokeConsentInput,
): ConsentGrant | null {
  validateArgs({
    workspaceId: input.workspaceId,
    userId: input.userId,
    dataSource: input.dataSource,
  });

  const target = input.grantId
    ? (raw
        .prepare(
          `SELECT * FROM consent_grants
            WHERE id = ? AND workspace_id = ? AND user_id = ? AND data_source = ?
              AND revoked_at IS NULL
            LIMIT 1`,
        )
        .get(
          input.grantId,
          input.workspaceId,
          input.userId,
          input.dataSource,
        ) as Record<string, unknown> | undefined)
    : (raw
        .prepare(
          `SELECT * FROM consent_grants
            WHERE workspace_id = ? AND user_id = ? AND data_source = ?
              AND revoked_at IS NULL
            ORDER BY granted_at DESC, id DESC
            LIMIT 1`,
        )
        .get(input.workspaceId, input.userId, input.dataSource) as Record<
        string,
        unknown
      > | undefined);

  if (!target) return null;

  const ts = nowMs();
  raw
    .prepare(`UPDATE consent_grants SET revoked_at = ? WHERE id = ?`)
    .run(ts, target.id);

  return { ...mapGrantRow(target), revokedAt: ts };
}

// ---------------------------------------------------------------------------
// listConsents — all grants (active + revoked), newest first
// ---------------------------------------------------------------------------

export interface ListConsentsOpts {
  readonly userId?: string;
  readonly dataSource?: DataSource | string;
  readonly limit?: number;
  /** When true, only active (revoked_at IS NULL). Default false (all). */
  readonly onlyActive?: boolean;
}

export function listConsents(
  raw: RawDb,
  workspaceId: string,
  opts: ListConsentsOpts = {},
): ConsentGrant[] {
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("listConsents: workspaceId required");
  }

  const where: string[] = ["workspace_id = ?"];
  const params: unknown[] = [workspaceId];
  if (opts.userId) {
    where.push("user_id = ?");
    params.push(opts.userId);
  }
  if (opts.dataSource) {
    where.push("data_source = ?");
    params.push(opts.dataSource);
  }
  if (opts.onlyActive) {
    where.push("revoked_at IS NULL");
  }
  const limit =
    opts.limit && Number.isFinite(opts.limit) && opts.limit > 0
      ? Math.floor(opts.limit)
      : 500;
  params.push(limit);

  const rows = raw
    .prepare(
      `SELECT * FROM consent_grants
        WHERE ${where.join(" AND ")}
        ORDER BY granted_at DESC, id DESC
        LIMIT ?`,
    )
    .all(...params) as Record<string, unknown>[];
  return rows.map(mapGrantRow);
}
