/**
 * Pattern 2 Digital-Twin MVP — Domain-Twin-Loader.
 *
 * Domain-Twin = Workspace-Snapshot (Label, Type, Sensitivity, Accent,
 * Active-Workstreams-Count, Recent-Decisions, Open-Tickets-P0/P1).
 *
 * Strategie: simple Map-LRU mit TTL=60s. Kein lru-cache-Dep nötig,
 * der Cache ist ein Performance-Layer — fail-soft, der Truth liegt in der DB.
 *
 * SQL-Queries gehen direkt über `db.$raw` (better-sqlite3 prepared statements)
 * statt über `projectTickets` — wir wollen Counts, nicht volle Projektionen.
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
    // Erste nicht-leere Zeile als Decision-Titel; Markdown-Header strippen.
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
  // Test-Hook: in Unit-Tests wollen wir DB-Init nicht triggern.
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

  // Recent Decisions: synthesis-Events der letzten Zeit, nach segmentId.
  // payload enthält JSON mit kind:'synthesis' und text. Wir limit 10 raw,
  // filtern dann auf 3 valide Synthesis-Texts.
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

  // Open Tickets P0/P1: Tickets brauchen volle Projektion (status ist
  // event-sourced). Wir nutzen aber eine Heuristik direkt auf den Events
  // um den Hot-Path schlank zu halten: Tickets mit prio P0/P1 die nicht
  // closed sind. Da Tickets event-sourced sind, gehen wir über
  // safeProjectTickets — das ist intern bereits gecached.
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
 * Domain-Twin für einen Workspace.
 * Cached 60s; bei DB-Fehler null (graceful).
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
 * Cache invalidieren (z.B. nach Workspace-Update oder Workstream-Status-
 * Wechsel). Optional — der TTL killt den Eintrag spätestens nach 60s.
 */
export function invalidateDomainTwin(workspaceId: string): void {
  cache.delete(workspaceId);
}

/** Test-Hook. */
export function __clearDomainTwinCacheForTests(): void {
  cache.clear();
}
