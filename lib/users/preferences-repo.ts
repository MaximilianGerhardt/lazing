/**
 * User-Preferences Repository (owner fix, live test 2026-05-28).
 *
 * Owner finding (verbatim):
 *   „Vollzugriff war bereits aktiviert. im neuen Workspace war es nicht
 *    aktiviert. Ggf. diese Einstellung Systemübergreifend nutzbar machen."
 *
 * Responsibility of this module:
 *   - Writes & reads `user_preferences` (migration 0114).
 *   - Encapsulates N10 content_hash (sha256 over canonical JSON).
 *   - The provider pattern preserves N4 (additive, no change to `users` or
 *     `lazyos_permission_modes`).
 *
 * Consumers:
 *   - POST /api/workspaces           — reads the default on creation and
 *                                       seeds `lazyos_permission_modes`
 *                                       for the new workspace IMMEDIATELY.
 *   - PATCH /api/permission/[wsId]/mode — writes the default to the mode the
 *                                          user explicitly chose
 *                                          (owner directive: the user default
 *                                          follows the last explicit action).
 *   - GET /api/user/preferences      — UI fallback for AllAccessToggle when
 *                                       the workspace has no explicit mode.
 *
 * Convention: the repo itself knows NO workspaces — it writes purely the
 * cross-workspace user settings. Per-workspace state stays in
 * `lazyos_permission_modes` (single source of truth per workspace).
 */

import { createHash } from "node:crypto";

import { getDb } from "@/db/client";
import {
  PERMISSION_MODES,
  type PermissionMode,
} from "../../lib-v1/permission/settings/schema";

/** Whitelist mirrored from the migration 0114 CHECK constraint. */
const SOURCE_VALUES = new Set([
  "system",
  "permission-toggle",
  "api",
  "migration",
]);

/** Persisted shape (camelCase). */
export interface UserPreferences {
  userId: string;
  defaultPermissionMode: PermissionMode | null;
  reason: string | null;
  source: "system" | "permission-toggle" | "api" | "migration";
  contentHash: string;
  createdAt: number;
  updatedAt: number;
}

interface Row {
  user_id: string;
  default_permission_mode: string | null;
  reason: string | null;
  source: string;
  content_hash: string;
  created_at: number;
  updated_at: number;
}

function rowToPrefs(row: Row): UserPreferences {
  const mode =
    row.default_permission_mode != null &&
    (PERMISSION_MODES as readonly string[]).includes(row.default_permission_mode)
      ? (row.default_permission_mode as PermissionMode)
      : null;
  const source = SOURCE_VALUES.has(row.source)
    ? (row.source as UserPreferences["source"])
    : "system";
  return {
    userId: row.user_id,
    defaultPermissionMode: mode,
    reason: row.reason,
    source,
    contentHash: row.content_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * N10 content_hash over the domain fields. We deliberately leave `created_at`,
 * `updated_at`, `id`, `content_hash` out of the hash — they are
 * provenance metadata, not the actual content of the "belief".
 */
function hashPrefs(
  userId: string,
  mode: PermissionMode | null,
  reason: string | null,
  source: string,
): string {
  const canonical: Record<string, unknown> = {};
  for (const [k, v] of Object.entries({
    user_id: userId,
    default_permission_mode: mode,
    reason,
    source,
  }).sort(([a], [b]) => a.localeCompare(b))) {
    if (v !== undefined) canonical[k] = v;
  }
  return createHash("sha256")
    .update(JSON.stringify(canonical), "utf8")
    .digest("hex");
}

/**
 * Reads the preferences row for the user. NULL = the user has no row
 * (fresh — all defaults are unset; the caller decides what that
 * means: typically "safe default 'ask'").
 */
export function getUserPreferences(userId: string): UserPreferences | null {
  if (!userId) return null;
  try {
    const db = getDb();
    const row = db.$raw
      .prepare(
        `SELECT user_id, default_permission_mode, reason, source,
                content_hash, created_at, updated_at
           FROM user_preferences
          WHERE user_id = ?
          LIMIT 1`,
      )
      .get(userId) as Row | undefined;
    return row ? rowToPrefs(row) : null;
  } catch {
    // Table missing (fresh DB) → don't throw; the caller
    // should pick the safe default itself.
    return null;
  }
}

/**
 * Convenient reader for exactly the field all callers care about.
 * Returns NULL when no row exists OR `default_permission_mode IS NULL`.
 */
export function getUserDefaultPermissionMode(
  userId: string,
): PermissionMode | null {
  return getUserPreferences(userId)?.defaultPermissionMode ?? null;
}

export interface SetDefaultPermissionModeArgs {
  userId: string;
  mode: PermissionMode | null;
  /** N1: passed through VERBATIM — no .slice. */
  reason?: string | null;
  /** N8 provenance. Default 'api'. */
  source?: UserPreferences["source"];
}

/**
 * Sets (upserts) the user default permission mode. Idempotent.
 *
 * Caller pattern (owner directive 2026-05-28):
 *   - When the user changes the workspace mode in PATCH /api/permission/[wsId]/mode,
 *     the user default is ADDITIONALLY set to the same mode
 *     (source='permission-toggle'). So the default follows the last
 *     explicit owner action.
 *   - GET /api/user/preferences then reads the field on mount of a new
 *     workspace without an explicit permission row, so the toggle shows the
 *     correct state without a second click.
 */
export function setUserDefaultPermissionMode({
  userId,
  mode,
  reason,
  source = "api",
}: SetDefaultPermissionModeArgs): UserPreferences {
  if (!userId) {
    throw new Error("setUserDefaultPermissionMode: userId required");
  }
  if (mode !== null && !(PERMISSION_MODES as readonly string[]).includes(mode)) {
    throw new Error(
      `setUserDefaultPermissionMode: invalid mode '${String(mode)}'`,
    );
  }
  const safeSource = SOURCE_VALUES.has(source) ? source : "api";
  const now = Date.now();
  const contentHash = hashPrefs(userId, mode, reason ?? null, safeSource);

  const db = getDb();
  db.$raw
    .prepare(
      `INSERT INTO user_preferences
         (user_id, default_permission_mode, reason, source, content_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         default_permission_mode = excluded.default_permission_mode,
         reason                  = excluded.reason,
         source                  = excluded.source,
         content_hash            = excluded.content_hash,
         updated_at              = excluded.updated_at`,
    )
    .run(userId, mode, reason ?? null, safeSource, contentHash, now, now);

  // Re-read for a stable return shape (and ensures the row really landed).
  const after = getUserPreferences(userId);
  if (!after) {
    // Should not happen — the upsert just succeeded.
    throw new Error("setUserDefaultPermissionMode: row vanished after upsert");
  }
  return after;
}
