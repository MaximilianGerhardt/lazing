/**
 * Pattern 2 Digital-Twin MVP — domain-twin loader.
 *
 * Domain twin = workspace snapshot (label, type, sensitivity, accent,
 * active-workstreams count, recent decisions, open tickets P0/P1).
 *
 * Strategy: simple Map LRU with TTL=60s. No lru-cache dep needed,
 * the cache is a performance layer — fail-soft, the truth lives in the DB.
 *
 * SQL queries go directly through `db.$raw` (better-sqlite3 prepared statements)
 * instead of through `projectTickets` — we want counts, not full projections.
 */

import { getDb } from "@/db/client";

import type { DomainTwin } from "./types";

interface CacheEntry {
  twin: DomainTwin;
  expiresAt: number;
}

const TTL_MS = 60_000;
const cache = new Map<string, CacheEntry>();

interface WorkspaceRow {
  id: string;
  label: string | null;
  workspace_type: string | null;
  sensitivity: string | null;
  accent: string | null;
}

interface CountRow {
  c: number;
}

interface SynthesisRow {
  payload: string;
}

function parseSynthesisTitle(payload: string): string | null {
  try {
    const obj = JSON.parse(payload) as {
      kind?: string;
      text?: string;
    };
    if (obj.kind !== "synthesis" || typeof obj.text !== "string") {
      return null;
    }
    // First non-empty line as the decision title; strip the markdown header.
    const firstLine = obj.text
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    if (!firstLine) return null;
    const cleaned = firstLine.replace(/^#+\s*/, "").slice(0, 120);
    return cleaned || null;
  } catch {
    return null;
  }
}

async function loadFromDb(workspaceId: string): Promise<DomainTwin | null> {
  // Test hook: in unit tests we don't want to trigger DB init.
  if (process.env.LAZYOS_TWIN_SKIP_DB === "1") {
    return null;
  }

  let db: ReturnType<typeof getDb>;
  try {
    db = getDb();
  } catch (err) {
    console.warn("[domain-twin] getDb failed:", err);
    return null;
  }

  const wsRow = db.$raw
    .prepare(
      `SELECT id, label, workspace_type, sensitivity, accent
         FROM workspaces
        WHERE id = ?`,
    )
    .get(workspaceId) as WorkspaceRow | undefined;

  if (!wsRow) {
    return null;
  }

  const activeWorkstreamsRow = db.$raw
    .prepare(
      `SELECT COUNT(*) AS c
         FROM workstreams
        WHERE workspace_id = ?
          AND status = 'active'`,
    )
    .get(workspaceId) as CountRow | undefined;

  // Recent decisions: recent synthesis events, by segmentId.
  // payload contains JSON with kind:'synthesis' and text. We limit 10 raw,
  // then filter down to 3 valid synthesis texts.
  const synthesisRows = db.$raw
    .prepare(
      `SELECT payload
         FROM events
        WHERE segment_id = ?
          AND entity_type = 'ticket'
          AND event_type = 'commented'
          AND payload LIKE '%"kind":"synthesis"%'
        ORDER BY created_at DESC
        LIMIT 10`,
    )
    .all(workspaceId) as SynthesisRow[];

  const recentDecisions: string[] = [];
  for (const row of synthesisRows) {
    const title = parseSynthesisTitle(row.payload);
    if (title) {
      recentDecisions.push(title);
      if (recentDecisions.length >= 3) break;
    }
  }

  // Open tickets P0/P1: tickets need a full projection (status is
  // event-sourced). But we use a heuristic directly on the events
  // to keep the hot path lean: tickets with prio P0/P1 that are not
  // closed. Since tickets are event-sourced, we go through
  // safeProjectTickets — which is already cached internally.
  let openTicketsP0P1 = 0;
  try {
    const { safeProjectTickets } = await import("@/lib/events/safe-projection");
    const tickets = await safeProjectTickets(workspaceId);
    openTicketsP0P1 = tickets.filter((t) => {
      if (t.status === "done") return false;
      const prio = (t.prio ?? "").toLowerCase();
      return prio === "p0" || prio === "p1";
    }).length;
  } catch (err) {
    console.warn("[domain-twin] ticket projection failed:", err);
  }

  const sensitivity: "low" | "high" =
    wsRow.sensitivity === "high" ? "high" : "low";

  return {
    workspaceId: wsRow.id,
    workspaceLabel: wsRow.label,
    workspaceType: wsRow.workspace_type,
    sensitivity,
    accent: wsRow.accent,
    activeWorkstreams: activeWorkstreamsRow?.c ?? 0,
    recentDecisions,
    openTicketsP0P1,
  };
}

/**
 * Domain twin for a workspace.
 * Cached 60s; null on a DB error (graceful).
 */
export async function getDomainTwin(
  workspaceId: string,
): Promise<DomainTwin | null> {
  const now = Date.now();
  const hit = cache.get(workspaceId);
  if (hit && hit.expiresAt > now) {
    return hit.twin;
  }

  let twin: DomainTwin | null = null;
  try {
    twin = await loadFromDb(workspaceId);
  } catch (err) {
    console.warn("[domain-twin] load failed:", err);
    return hit?.twin ?? null;
  }

  if (twin) {
    cache.set(workspaceId, { twin, expiresAt: now + TTL_MS });
  }
  return twin;
}

/**
 * Invalidate the cache (e.g. after a workspace update or workstream status
 * change). Optional — the TTL kills the entry after 60s at the latest.
 */
export function invalidateDomainTwin(workspaceId: string): void {
  cache.delete(workspaceId);
}

/** Test-Hook. */
export function __clearDomainTwinCacheForTests(): void {
  cache.clear();
}
