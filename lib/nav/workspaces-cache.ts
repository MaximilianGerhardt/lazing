// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Maximilian Gerhardt
//
// lib/nav/workspaces-cache — Singleton in-memory cache + in-flight dedupe
// for `/api/workspaces` (CP-2 / UX-Audit 2026-05-28).
//
// Problem this solves
// -------------------
// Before this module, `useWorkspaces()` (lib/nav/hooks.ts:425) fired its
// own `fetch('/api/workspaces', { cache: 'no-store' })` per hook caller.
// Six caller sites mount the hook on the same page (TicketReplyBox,
// RoutinesList, SessionsList, ChatWorkspaceInlineSwitcher,
// useChatSuggestions, WorkspaceSwitcher) → six concurrent fetches per
// page-load. Combined with other route polls, the active-test smoke
// observed 62–71 `429 Too Many Requests` over a 13-route sweep in 7s.
// On 429 the previous code reset the state to the static fallback,
// causing the WorkspaceSwitcher to flicker empty.
//
// What this does
// --------------
// 1. Module-global cache holding the last successful fetch + its timestamp.
// 2. In-flight request dedupe — if N callers ask while a fetch is already
//    in flight, they all share that single Promise.
// 3. Stale-while-revalidate: callers immediately receive cached data when
//    available, and a background refresh fires when the cache age exceeds
//    `STALE_TTL_MS` (30s). Concurrent SWR refreshes are deduped.
// 4. Exponential 429 backoff (1s → 2s → 4s … cap 30s). While backing off
//    we serve the previous successful snapshot and do NOT hammer.
// 5. Fail-soft path: when the network errors or 429s, we keep the
//    previously-returned snapshot instead of dropping to empty. The
//    only time we expose the empty/static fallback is when no successful
//    fetch has EVER happened in this session.
//
// Backwards compatibility
// -----------------------
// `useWorkspaces()` in lib/nav/hooks.ts keeps its exact public shape
// (`{ workspaces, isLoading }`) — this cache is purely internal.

import type { Workspace } from './types';
import { ROOT_WORKSPACE, STATIC_WORKSPACES } from './workspaces-data';

/** Time after which a cached entry is considered stale and SWR-refreshed. */
export const STALE_TTL_MS = 30_000;

/** First 429-backoff delay; doubles per consecutive 429 up to BACKOFF_CAP_MS. */
export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_CAP_MS = 30_000;

/** Endpoint kept centralised so tests + hook agree. */
export const WORKSPACES_ENDPOINT = '/api/workspaces';

interface CacheState {
  /** Last successful fetch payload, or `null` if none yet. */
  snapshot: readonly Workspace[] | null;
  /** ms-epoch of the last successful fetch (0 = never). */
  fetchedAt: number;
  /** In-flight Promise so concurrent callers can dedupe. */
  inFlight: Promise<readonly Workspace[]> | null;
  /** Consecutive 429 count for exponential backoff. */
  consecutive429: number;
  /** ms-epoch we are allowed to retry after a 429 (0 = no backoff active). */
  backoffUntil: number;
  /** Subscribers — fire when cache snapshot or fetch state changes. */
  listeners: Set<() => void>;
}

const state: CacheState = {
  snapshot: null,
  fetchedAt: 0,
  inFlight: null,
  consecutive429: 0,
  backoffUntil: 0,
  listeners: new Set(),
};

interface FetchOptions {
  /** Test-only — inject a custom fetch impl (defaults to globalThis.fetch). */
  readonly fetchImpl?: typeof fetch;
  /** Test-only — inject the current ms-epoch (defaults to Date.now). */
  readonly nowMs?: () => number;
}

function nowDefault(): number {
  return Date.now();
}

/**
 * Standalone public pages (e.g. external sub-chat page `/c/<token>`, no
 * login) should trigger NO authed `/api/workspaces` fetch — otherwise a
 * 401 leaks into an external guest's console. Global mounts (TopNav hook,
 * CmdPalette) do run there but do not need the workspace list.
 */
function isStandalonePublicPath(): boolean {
  if (typeof window === 'undefined') return false;
  return window.location.pathname.startsWith('/c/');
}

/** The "first paint" list — what we serve when no fetch has succeeded yet. */
function staticFallback(): readonly Workspace[] {
  return [ROOT_WORKSPACE, ...STATIC_WORKSPACES];
}

interface ApiBody {
  readonly workspaces?: ReadonlyArray<Workspace>;
}

async function performFetch(opts: FetchOptions): Promise<readonly Workspace[]> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const res = await fetchImpl(WORKSPACES_ENDPOINT, { cache: 'no-store' });
  if (res.status === 429) {
    // Trigger backoff path — caller sees the previous snapshot.
    const e = new Error('rate-limited') as Error & { code?: string };
    e.code = 'rate-limited';
    throw e;
  }
  if (!res.ok) {
    throw new Error(`status ${res.status}`);
  }
  const body = (await res.json()) as ApiBody;
  if (!Array.isArray(body.workspaces) || body.workspaces.length === 0) {
    // Treat an empty/invalid payload as "no change" — keep prior snapshot.
    throw new Error('empty-payload');
  }
  const rest = body.workspaces.filter((w) => w.id !== ROOT_WORKSPACE.id);
  return [ROOT_WORKSPACE, ...rest];
}

function notify(): void {
  for (const l of state.listeners) {
    try {
      l();
    } catch {
      /* listener-error is swallowed — never break the cache loop */
    }
  }
}

/**
 * Compute the next backoff window after a 429.
 * Doubles each consecutive 429, capped at BACKOFF_CAP_MS.
 */
function bumpBackoff(now: number): void {
  state.consecutive429 += 1;
  const delay = Math.min(
    BACKOFF_BASE_MS * 2 ** (state.consecutive429 - 1),
    BACKOFF_CAP_MS,
  );
  state.backoffUntil = now + delay;
}

function clearBackoff(): void {
  state.consecutive429 = 0;
  state.backoffUntil = 0;
}

/**
 * Returns either the cached promise (if one is already in flight) or
 * starts a new fetch, populates the cache, and resolves with the result.
 * Errors are swallowed — callers always get the "best available" snapshot
 * via `getSnapshot()` or `subscribe()`.
 */
export function ensureFresh(opts: FetchOptions = {}): Promise<readonly Workspace[]> {
  // External standalone page (/c/): never fetch authed (no 401 leak).
  if (isStandalonePublicPath()) return Promise.resolve(state.snapshot ?? staticFallback());
  const now = (opts.nowMs ?? nowDefault)();
  // Dedupe concurrent calls.
  if (state.inFlight) return state.inFlight;
  // Respect backoff window — return whatever snapshot we have.
  if (state.backoffUntil > now) {
    return Promise.resolve(state.snapshot ?? staticFallback());
  }
  state.inFlight = (async (): Promise<readonly Workspace[]> => {
    try {
      const list = await performFetch(opts);
      state.snapshot = list;
      state.fetchedAt = (opts.nowMs ?? nowDefault)();
      clearBackoff();
      notify();
      return list;
    } catch (err) {
      const isRateLimited =
        err instanceof Error && (err as Error & { code?: string }).code === 'rate-limited';
      if (isRateLimited) {
        bumpBackoff((opts.nowMs ?? nowDefault)());
      }
      // Hold the previous successful snapshot. If none, fall back to the
      // static list — but DO NOT overwrite the cache so a later success
      // can populate it.
      notify();
      return state.snapshot ?? staticFallback();
    } finally {
      state.inFlight = null;
    }
  })();
  return state.inFlight;
}

/**
 * Synchronous read of the current best snapshot. Never blocks. Always
 * returns at least the static fallback so callers don't have to guard.
 */
export function getSnapshot(): readonly Workspace[] {
  return state.snapshot ?? staticFallback();
}

/**
 * Returns whether the cache has ever been populated by a successful
 * server response (vs serving the static fallback). Drives the
 * `isLoading` flag in `useWorkspaces`.
 */
export function hasSnapshot(): boolean {
  return state.snapshot !== null;
}

/**
 * Subscribe to cache changes. Fires after every successful refresh, every
 * rate-limited backoff bump, and every failed refresh that DID NOT
 * change the snapshot — the listener can decide whether to re-render.
 *
 * Returns an unsubscribe function.
 */
export function subscribe(listener: () => void): () => void {
  state.listeners.add(listener);
  return () => {
    state.listeners.delete(listener);
  };
}

/**
 * Top-level kickoff. Callers (e.g. `useWorkspaces`) invoke this on mount.
 * If cache is fresh (younger than STALE_TTL_MS), we skip the fetch.
 * If cache is stale or empty, we trigger `ensureFresh` — but always
 * return synchronously so callers can immediately render the snapshot.
 *
 * If `force = true` (e.g. WORKSPACE_DATA_CHANGE_EVENT), the staleness
 * check is bypassed but in-flight dedupe still applies.
 */
export function maybeRefresh(opts: FetchOptions & { readonly force?: boolean } = {}): void {
  if (isStandalonePublicPath()) return; // externe Standalone-Seite: kein Fetch
  const now = (opts.nowMs ?? nowDefault)();
  const age = now - state.fetchedAt;
  const stale = state.snapshot === null || age > STALE_TTL_MS;
  if (!stale && !opts.force) return;
  void ensureFresh(opts);
}

// ─── TEST-ONLY helpers ──────────────────────────────────────────────────────

/** Reset cache to initial state — used by tests + by HMR safety. */
export function __resetWorkspacesCache(): void {
  state.snapshot = null;
  state.fetchedAt = 0;
  state.inFlight = null;
  state.consecutive429 = 0;
  state.backoffUntil = 0;
  // listeners are intentionally kept — tests subscribe before reset.
}

/** Inspect-only snapshot for tests. */
export function __debugCacheState(): {
  hasSnapshot: boolean;
  fetchedAt: number;
  inFlight: boolean;
  consecutive429: number;
  backoffUntil: number;
} {
  return {
    hasSnapshot: state.snapshot !== null,
    fetchedAt: state.fetchedAt,
    inFlight: state.inFlight !== null,
    consecutive429: state.consecutive429,
    backoffUntil: state.backoffUntil,
  };
}
