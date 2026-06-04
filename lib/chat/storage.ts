/**
 * lib/chat/storage.ts
 * -------------------
 * Phase MS · 2026-04-26. Server-first loader for the chat history.
 *
 * Strategy:
 *   1. ChatShell mount or workspace switch -> immediately `readHistoryFor(wsId)`
 *      (localStorage, instant, no flicker).
 *   2. In parallel `loadHistoryServerFirst(wsId)` -> /api/chat/history.
 *      On success: server wins, history is overwritten + cache update.
 *      On error/offline: cached stays, no user-facing error.
 *
 * Edge case (race): if the user just sent a message
 * and switches the tab immediately, the local history can be newer than the
 * server snapshot (the user message is not yet propagated). We therefore
 * compare by ts and keep local items that are newer than
 * the newest server item.
 */

import type { HistoryItem } from "./ChatShell";
// Type-only import above + runtime import for the hydrate helper from the
// replace-logic module. The circular type path (storage <-> ChatShell)
// has existed since Phase MS and is harmless to tsc (types only).
import { hydrateWorkstreamCoords } from "./replace-logic";

/**
 * System item shape as it comes from the history endpoint
 * (workstream activity — auto_dispatch, stage-comments, synthesis).
 * Mirrors the `SystemItem` interface in ChatShell.tsx 1:1.
 */
export interface ServerSystemItem {
  id: string;
  role: "system";
  kind: string;
  content: string;
  severity: "info" | "warn" | "critical";
  href?: string;
  ts: string;
}

interface HistoryResponse {
  items: HistoryItem[];
  hasMore: boolean;
  systemItems?: ServerSystemItem[];
  /**
   * Sprint H · 2026-04-30 — slash-command cutoff. If > 0: all local
   * HistoryItems with ts <= cutoffMs should be discarded, because a
   * `/clear` or `/compact` set a visibility cutoff. The server has
   * already filtered its own items; the client must align its local
   * state so local-only bubbles (optimistic echo, surface
   * cards) do not leak past the cutoff.
   */
  cutoffMs?: number;
}

export interface LoadHistoryResult {
  items: HistoryItem[];
  systemItems: ServerSystemItem[];
  /**
   * Server-side visibility cutoff (ms). 0 = no cutoff active. The caller must
   * pass this value through to `mergeServerWithLocal(server, local, cutoffMs)`
   * so the cache does not come back after `/clear`.
   */
  cutoffMs: number;
}

/**
 * Fetches the history for a workspace from the server. Throws on error;
 * the caller can then use the cache fallback.
 *
 * Phase 2026-04-26: the server additionally returns `systemItems` —
 * workstream activity (auto_dispatch, stage-comments, synthesis,
 * pipeline_complete) of the last N ticket events. Pushed by the caller
 * directly into `setSystemMessages` so that after reload not only
 * user+assistant bubbles but also the live toasts are visible.
 */
export async function loadHistoryServerFirst(
  wsId: string,
  opts: { limit?: number; signal?: AbortSignal } = {},
): Promise<LoadHistoryResult> {
  const { limit = 60, signal } = opts;
  const url = `/api/chat/history/${encodeURIComponent(wsId)}?limit=${limit}`;
  const res = await fetch(url, {
    credentials: "same-origin",
    cache: "no-store",
    ...(signal !== undefined ? { signal } : {}),
  });
  // 2026-04-27 robustness fix: 401/403 = auth gone, should keep cached.
  // Throw instead of silent — the caller catch keeps cached.
  if (res.status === 401 || res.status === 403) {
    throw new Error("history_load_unauthorized");
  }
  if (!res.ok) {
    throw new Error(`history_load_failed_${res.status}`);
  }
  const body = (await res.json()) as Partial<HistoryResponse>;
  if (!body || !Array.isArray(body.items)) {
    throw new Error("history_load_invalid_shape");
  }
  return {
    items: body.items,
    systemItems: Array.isArray(body.systemItems) ? body.systemItems : [],
    cutoffMs:
      typeof body.cutoffMs === "number" && Number.isFinite(body.cutoffMs)
        ? body.cutoffMs
        : 0,
  };
}

/**
 * Merge logic: server items are the truth. Local items whose ID
 * does NOT appear in the server list stay in (independent of the
 * timestamp) — this catches SurfaceActionProvider-pushed cards,
 * mock-mode replies, recovered live snapshots and all other
 * client-side items that the server-first path would send back
 * if it knew nothing.
 *
 * **Bug fix 2026-04-26 (P1-1):** previously we dropped local items only
 * because they were older than the newest server item — that made, e.g.,
 * surface cards disappear that the SurfaceActionProvider had pushed
 * into the log with `pushAssistant` (no backend event, so never on the
 * server). Also: result sorting was missing,
 * trailing-local items were blindly appended.
 *
 * Plus: pendingPromptId mapping. If a server item corresponds via
 * `payload.pendingPromptId` to a local item (same user prompt, different
 * ID), the server wins (= ULID id). The local counterpart is discarded,
 * NOT kept as a duplicate.
 *
 * Dedup per id (event.id collision = same item).
 */
/**
 * Sub-Plan A · 2026-04-29 — hydrate migration on a flat list.
 * Reads workstreamId + surfaceKind from the content (regex-light) if
 * the fields are missing. Pure: returns a new array with possibly augmented
 * items, the original items are not mutated.
 *
 * Sub-Plan A Finding 5 (2026-04-29): additionally sets the marker
 * `_coordsHydrated=true` so items that have already been processed once
 * can skip immediately on the next read.
 *
 * Hint 1 (Sub-Plan A · 2026-04-29): exported so ChatShell.tsx uses the
 * same pure helper instead of maintaining its own variant.
 */
export function hydrateCoordsList(items: HistoryItem[]): HistoryItem[] {
  let mutated = false;
  const out = items.map((it) => {
    const next = hydrateWorkstreamCoords(it);
    if (next !== it) mutated = true;
    return next;
  });
  return mutated ? out : items;
}

/**
 * Sub-Plan A · 2026-04-29 — replace pass on a flat list.
 * Per (workstreamId, surfaceKind) coord, the CHRONOLOGICALLY NEWEST
 * non-archived item is kept alive, all older peers get
 * `archived=true`. Applied after the server merge so a reload
 * does not suddenly show 5 old cards of the same workstream.
 *
 * Expects an already chronologically ASC-sorted list (as
 * `mergeServerWithLocal` returns it).
 */
export function applyReplacePass(items: HistoryItem[]): HistoryItem[] {
  // last live item per coord key.
  const lastLiveByCoord = new Map<string, number>();
  for (let i = 0; i < items.length; i += 1) {
    const it = items[i];
    if (it.archived) continue;
    if (!it.workstreamId || !it.surfaceKind) continue;
    const key = `${it.surfaceKind}::${it.workstreamId}`;
    lastLiveByCoord.set(key, i);
  }
  if (lastLiveByCoord.size === 0) return items;
  let mutated = false;
  const next = items.map((it, idx) => {
    if (it.archived) return it;
    if (!it.workstreamId || !it.surfaceKind) return it;
    const key = `${it.surfaceKind}::${it.workstreamId}`;
    const liveIdx = lastLiveByCoord.get(key);
    if (liveIdx === undefined || liveIdx === idx) return it;
    mutated = true;
    return { ...it, archived: true };
  });
  return mutated ? next : items;
}

export function mergeServerWithLocal(
  serverItems: HistoryItem[],
  localItems: HistoryItem[],
  cutoffMs = 0,
): HistoryItem[] {
  // Sprint H · 2026-04-30 / Bug 3 (2026-05-03) — the server-side
  // slash cutoff takes precedence over the localStorage log. Local items
  // with `ts <= cutoffMs` are KILLED — they are explicitly "no longer
  // in the visible range".
  //
  // 2026-05-03 (Bug 3 fix): synthetic `chat-compacted` cards with
  // ts <= cutoffMs are also discarded. Previously we let them through — that
  // was wrong when a NEWER /clear came after a /compact: the old
  // compact summary reappeared even though the user explicitly
  // said "everything gone". Correct behavior: compacted cards with
  // ts > cutoffMs are "created after the cutoff" and survive;
  // everything before is dead.
  let filteredLocal = localItems;
  if (cutoffMs > 0) {
    filteredLocal = localItems.filter((it) => {
      const tms = Date.parse(it.ts);
      // Non-parsable ts: keep conservatively — no cutoff match.
      if (!Number.isFinite(tms)) return true;
      return tms > cutoffMs;
    });
  }
  // 2026-04-27 robustness fix: if the server delivers an EMPTY list
  // (e.g. new DB, different workspace, transient bug) but local items
  // exist — NEVER kill the local state. User complaint:
  // "chat disappears after close+open". Cause: server delivered
  // empty items[], cached was overwritten with empty.
  //
  // EXCEPTION (Bug 3 / 2026-05-03): if the server returns cutoffMs > 0
  // AND an empty items list, that IS an explicit "log cleared"
  // signal from the server (typically after `/clear`). In that case
  // we must NOT rescue the local state — otherwise the cache stays
  // visible even though the user said /clear.
  // Sub-Plan A · 2026-04-29 — first run all items through the hydrate
  // migration so old persistence formats get their workstreamId/surfaceKind
  // fields supplied before the replace pass decides.
  const hydratedServer = hydrateCoordsList(serverItems);
  const hydratedLocal = hydrateCoordsList(filteredLocal);
  if (hydratedServer.length === 0 && hydratedLocal.length > 0) {
    // Empty server + cutoff active = explicit /clear. We already
    // sort out local items via filteredLocal — if any are still
    // present now, they were created post-cutoff (e.g.
    // optimistic echo after the /clear). Keep them.
    return applyReplacePass([...hydratedLocal].sort(byTsAsc));
  }
  if (hydratedLocal.length === 0) {
    return applyReplacePass([...hydratedServer].sort(byTsAsc));
  }
  if (hydratedServer.length === 0) {
    return applyReplacePass([...hydratedLocal].sort(byTsAsc));
  }

  const serverIds = new Set(hydratedServer.map((i) => i.id));

  // pendingPromptId mapping: every server item that has a
  // payload.pendingPromptId refers to a local item
  // with that pendingPromptId. Drop the local item — the server ULID wins.
  //
  // Bug C fix 2026-04-26: ChatShell.submit now explicitly attaches
  // `pendingPromptId` to the local userMsg item after onPendingId
  // (instead of using it as the id). The match now runs cleanly via
  // localItem.pendingPromptId === serverItem.pendingPromptId.
  // Previously it only matched if the local ID happened to be the
  // pendingPromptId — which it never is (local id = nextId('user') = `user-XYZ`).
  const pendingIdsConsumed = new Set<string>();
  for (const s of hydratedServer) {
    if (typeof s.pendingPromptId === "string" && s.pendingPromptId.length > 0) {
      pendingIdsConsumed.add(s.pendingPromptId);
    }
  }

  // Keep local items IF:
  //   - id not in serverIds (the server does not know it)
  //   - pendingPromptId NOT consumed by a server item
  //   - backward-compat: id also not in pendingIdsConsumed (old
  //     localStorage items from before the Bug C fix, where id ===
  //     pendingPromptId was falsely expected — never the case,
  //     but it costs us nothing to leave the check in)
  const survivingLocal = hydratedLocal.filter((it) => {
    if (serverIds.has(it.id)) return false;
    if (it.pendingPromptId && pendingIdsConsumed.has(it.pendingPromptId)) {
      return false;
    }
    if (pendingIdsConsumed.has(it.id)) return false;
    return true;
  });

  return applyReplacePass(
    [...hydratedServer, ...survivingLocal].sort(byTsAsc),
  );
}

/**
 * Sub-Plan A Finding 3 (2026-04-29): stable sorting on TS tie
 * or unparseable TS. Tiebreaker = lexical comparison of the id, so the
 * replace-pass behavior becomes deterministic and local items do not
 * disappear on equal ts.
 */
function byTsAsc(a: HistoryItem, b: HistoryItem): number {
  const am = Date.parse(a.ts);
  const bm = Date.parse(b.ts);
  const amOk = Number.isFinite(am);
  const bmOk = Number.isFinite(bm);
  if (amOk && bmOk) {
    if (am !== bm) return am - bm;
  }
  // TS tie OR unparseable: deterministic per id.
  return a.id.localeCompare(b.id);
}

// ---------------------------------------------------------------------------
// Sub-Plan B · 2026-04-29 — history toggle ("Nur Fokus" vs. "Verlauf an")
//
// Boolean stored per workspace: is the "Verlauf" pill currently active?
// Default = false (focus mode). On workspace switch the caller resets the
// state explicitly to false (see ChatShell — the switch effect does NOT call
// readShowHistoryFor, but hard-sets `setShowHistory(false)`).
//
// It is still persisted per workspace so a reload restores the last
// toggle state of the same workspace. Edge case: the user
// expands the log, navigates away, navigates straight back
// (same workspace) → the reload path picks the state back up, the
// switch path does not. Both are intended: user wish "auto-reset on
// submitUserMessage", "reset on workspace switch", but "reload should
// show the last state so an accidental F5 does not cause a loss".
// ---------------------------------------------------------------------------

const SHOW_HISTORY_BASE = "lazyos.chat.showHistory";

function showHistoryKeyFor(workspaceId: string): string {
  return `${SHOW_HISTORY_BASE}.${workspaceId}`;
}

export function readShowHistoryFor(workspaceId: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    const raw = window.localStorage.getItem(showHistoryKeyFor(workspaceId));
    return raw === "1" || raw === "true";
  } catch {
    return false;
  }
}

export function writeShowHistoryFor(
  workspaceId: string,
  value: boolean,
): void {
  if (typeof window === "undefined") return;
  try {
    if (value) {
      window.localStorage.setItem(showHistoryKeyFor(workspaceId), "1");
    } else {
      window.localStorage.removeItem(showHistoryKeyFor(workspaceId));
    }
  } catch {
    // ignore — quota/private-mode
  }
}

// ---------------------------------------------------------------------------
// Sub-Plan B · 2026-04-29 — clear-history helper for the /clear command
// ---------------------------------------------------------------------------

/**
 * Clears the localStorage entry of a workspace's chat history. The
 * key must match `historyKeyFor(workspaceId)` from ChatShell.tsx
 * exactly — we mirror the `lazyos.chat.history.<wsId>` schema.
 *
 * Additionally dispatches a StorageEvent, if `dispatchEvent` is available,
 * so other open tabs also update their log.
 *
 * Idempotent — no difference between "was empty anyway" and "actually
 * cleared". Does NOT throw on quota/private-mode.
 *
 * **Important:** DB events stay untouched. This is a pure client-state
 * operation. On the next history load via `loadHistoryServerFirst`
 * the log is restored from the server.
 */
const HISTORY_KEY_BASE = "lazyos.chat.history";

export function clearHistoryFor(workspaceId: string): void {
  if (typeof window === "undefined") return;
  const key = `${HISTORY_KEY_BASE}.${workspaceId}`;
  try {
    window.localStorage.removeItem(key);
  } catch {
    // ignore — quota/private-mode
  }
  // StorageEvent for cross-tab sync. happy-dom throws on some versions
  // when StorageEvent is not available — defensive try/catch.
  try {
    if (typeof StorageEvent === "function") {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key,
          oldValue: null,
          newValue: null,
          storageArea: window.localStorage,
        }),
      );
    }
  } catch {
    // ignore
  }
}
