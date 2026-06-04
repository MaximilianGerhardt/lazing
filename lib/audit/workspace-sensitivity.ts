/**
 * Privacy-Sprint V2 (2026-05-01) — workspace-sensitivity helper for
 * reasoning-audit persistence.
 *
 * Critic-VETO V2: `LAZYOS_AUDIT_FULL_PROMPTS=1` writes system/user prompts
 * 1:1 into the DB. In high-sensitivity workspaces (the user's own trust zone
 * with private data in the twin block) this may NEVER happen — not even when
 * the ENV flag is set.
 *
 * This helper provides a workspace's sensitivity, lookupable +
 * cached. On a DB error we return `'unknown'`; the caller must
 * then act conservatively (see `shouldPersistFullPrompts`).
 */

import { getDb } from "@/db/client";

type Sensitivity = "low" | "high" | "unknown";

interface CacheEntry {
  value: Sensitivity;
  expiresAt: number;
}

const TTL_MS = 60_000;
const cache = new Map<string, CacheEntry>();

interface WorkspaceRow {
  sensitivity: string | null;
}

/**
 * Returns the workspace sensitivity. Result cached for 60s.
 * On a DB error or missing workspace → 'unknown'.
 *
 * Important: `null`/`undefined` workspaceId → 'low' (backwards-compat,
 * legacy audits without a workspace reference behave as before: the ENV flag
 * decides alone). Only when a workspaceId is given AND the
 * lookup fails is 'unknown' returned (conservative → no
 * plaintext persistence).
 */
export function getWorkspaceSensitivity(
  workspaceId: string | null | undefined,
): Sensitivity {
  if (!workspaceId) return "low";

  const now = Date.now();
  const hit = cache.get(workspaceId);
  if (hit && hit.expiresAt > now) {
    return hit.value;
  }

  let value: Sensitivity = "unknown";
  try {
    const db = getDb();
    const row = db.$raw
      .prepare("SELECT sensitivity FROM workspaces WHERE id = ?")
      .get(workspaceId) as WorkspaceRow | undefined;
    if (row) {
      value = row.sensitivity === "high" ? "high" : "low";
    }
  } catch (err) {
    console.warn(
      "[workspace-sensitivity] lookup failed:",
      err instanceof Error ? err.message : err,
    );
    return "unknown";
  }

  cache.set(workspaceId, { value, expiresAt: now + TTL_MS });
  return value;
}

/**
 * Decides whether the plaintext prompts may be persisted on a
 * `writeReasoningAudit` call.
 *
 * Rules:
 *   1. ENV `LAZYOS_AUDIT_FULL_PROMPTS` !== "1" → NEVER persist.
 *   2. Workspace sensitivity 'high' → NEVER persist (even with ENV=1).
 *   3. Sensitivity 'unknown' → conservatively NEVER persist.
 *   4. Sensitivity 'low' + ENV=1 → persisting OK.
 */
export function shouldPersistFullPrompts(
  workspaceSensitivity: Sensitivity,
): boolean {
  if (process.env.LAZYOS_AUDIT_FULL_PROMPTS !== "1") return false;
  if (workspaceSensitivity !== "low") return false;
  return true;
}

/** Test-Hook. */
export function __clearWorkspaceSensitivityCacheForTests(): void {
  cache.clear();
}
