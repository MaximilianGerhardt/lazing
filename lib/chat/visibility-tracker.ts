/**
 * visibility-tracker — SQLite-backed Phase MS push heuristic (cross-process).
 *
 * **Bug fix 2026-04-26 (P0-1):** previously an in-memory Map with a globalThis singleton.
 * `markClientVisible` ran in the Next.js process (via /api/chat/visibility),
 * `isAnyClientVisible` in the agent-server process (via onChatMessageCompleted).
 * Singletons are process-local — the push trigger NEVER saw the Map and
 * pushes always fired, even when the user was active in the tab.
 *
 * Fix: table `client_visibility` (workspace_id PK, last_seen_ms NOT NULL)
 * — both processes open the same SQLite file via LAZYOS_DB_PATH and
 * see the same picture. Access stays cheap (SELECT/UPDATE on PK,
 * better-sqlite3 sync, sub-ms).
 *
 * Idea: the frontend pings `/api/chat/visibility` every ~15s with
 * `{ wsId, visible: document.visibilityState === 'visible' }`. We
 * track per workspace the last "visible=true" timestamp. If
 * this value is younger than the TTL, at least one client counts as
 * "watching" and the push is suppressed.
 */

import { getDb } from "../../db/client";

const VISIBILITY_TTL_MS = 30_000;

/**
 * Marks the workspace as "currently actively watched by a client".
 * Called by the visibility heartbeat endpoint.
 */
export function markClientVisible(workspaceId: string, now: number = Date.now()): void {
  try {
    const db = getDb();
    db.$raw
      .prepare(
        `INSERT INTO client_visibility (workspace_id, last_seen_ms)
         VALUES (?, ?)
         ON CONFLICT(workspace_id) DO UPDATE SET last_seen_ms = excluded.last_seen_ms`,
      )
      .run(workspaceId, now);
  } catch (err) {
    // Last resort: visibility is best-effort. A DB error must not
    // crash the heartbeat endpoint — that would only have the effect
    // that pushes fire again (= the old default).
    console.warn(
      "[visibility-tracker] markClientVisible failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Removes the visibility entry — e.g. because the client explicitly
 * sends `visible: false`. We could also just do nothing and
 * wait for the TTL; but explicit clearing allows an "I'm leaving
 * now, feel free to push me" signal.
 */
export function markClientHidden(workspaceId: string): void {
  try {
    const db = getDb();
    db.$raw
      .prepare(`DELETE FROM client_visibility WHERE workspace_id = ?`)
      .run(workspaceId);
  } catch (err) {
    console.warn(
      "[visibility-tracker] markClientHidden failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * True if a client reported the workspace as "visible" within the TTL.
 * False otherwise (or if the entry is stale).
 *
 * On a DB error: conservatively return `false` — the push fires. Better
 * one notification too many than miss an important answer.
 */
export function isAnyClientVisible(
  workspaceId: string,
  now: number = Date.now(),
): boolean {
  try {
    const db = getDb();
    const row = db.$raw
      .prepare(
        `SELECT last_seen_ms FROM client_visibility
         WHERE workspace_id = ? AND last_seen_ms > ?`,
      )
      .get(workspaceId, now - VISIBILITY_TTL_MS) as
      | { last_seen_ms: number }
      | undefined;
    return Boolean(row);
  } catch (err) {
    console.warn(
      "[visibility-tracker] isAnyClientVisible failed:",
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}

/** For tests/debug only. */
export function __resetVisibilityForTests(): void {
  try {
    const db = getDb();
    db.$raw.exec(`DELETE FROM client_visibility`);
  } catch {
    /* ignore in tests */
  }
}

export const VISIBILITY_TTL_MS_EXPORT = VISIBILITY_TTL_MS;
