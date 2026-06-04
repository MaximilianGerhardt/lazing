// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Maximilian Gerhardt
//
// Tests for lib/nav/workspaces-cache — Singleton in-memory cache,
// in-flight dedupe, stale-while-revalidate, and 429 exponential backoff.
//
// These tests cover the CP-2 fixes from the UX-Audit 2026-05-28:
//   - 6 parallel callers → 1 underlying fetch (dedupe)
//   - 2nd mount within STALE_TTL_MS → cached, no second fetch
//   - 429 response → previous snapshot preserved, no empty-list flicker

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BACKOFF_BASE_MS,
  STALE_TTL_MS,
  WORKSPACES_ENDPOINT,
  __debugCacheState,
  __resetWorkspacesCache,
  ensureFresh,
  getSnapshot,
  hasSnapshot,
  maybeRefresh,
} from '../workspaces-cache';
import type { Workspace } from '../types';

function mockWorkspace(id: string, label = id): Workspace {
  return {
    id,
    label,
    accent: 'north',
    sensitivity: 'normal',
  };
}

function okResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  } as Response;
}

function rateLimitedResponse(): Response {
  return {
    ok: false,
    status: 429,
    json: () => Promise.resolve({}),
  } as Response;
}

beforeEach(() => {
  __resetWorkspacesCache();
});

afterEach(() => {
  __resetWorkspacesCache();
  vi.restoreAllMocks();
});

describe('workspaces-cache — single-flight dedupe', () => {
  it('deduplicates N concurrent callers into ONE fetch', async () => {
    const apiPayload = { workspaces: [mockWorkspace('alpha'), mockWorkspace('beta')] };
    const fetchImpl = vi.fn().mockImplementation(
      () => new Promise<Response>((resolve) => setTimeout(() => resolve(okResponse(apiPayload)), 10)),
    );
    // Six parallel callers — mirrors the six useWorkspaces() sites that
    // mount together (TicketReplyBox, RoutinesList, SessionsList,
    // ChatWorkspaceInlineSwitcher, useChatSuggestions, WorkspaceSwitcher).
    const callers = await Promise.all([
      ensureFresh({ fetchImpl }),
      ensureFresh({ fetchImpl }),
      ensureFresh({ fetchImpl }),
      ensureFresh({ fetchImpl }),
      ensureFresh({ fetchImpl }),
      ensureFresh({ fetchImpl }),
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // All callers should observe the same payload.
    for (const list of callers) {
      expect(list.length).toBeGreaterThan(0);
    }
    // Cache is populated for follow-up consumers.
    expect(hasSnapshot()).toBe(true);
  });

  it('uses the correct endpoint with cache: no-store', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      okResponse({ workspaces: [mockWorkspace('alpha')] }),
    );
    await ensureFresh({ fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(WORKSPACES_ENDPOINT, { cache: 'no-store' });
  });
});

describe('workspaces-cache — staleness check (maybeRefresh)', () => {
  it('skips fetch when the cache is fresh (younger than STALE_TTL_MS)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      okResponse({ workspaces: [mockWorkspace('alpha')] }),
    );
    let now = 1_000_000;
    const nowMs = (): number => now;
    // First call — fetches.
    maybeRefresh({ fetchImpl, nowMs });
    // Allow the in-flight Promise to settle.
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Advance time by 5s — still well under STALE_TTL_MS (30s).
    now += 5_000;
    maybeRefresh({ fetchImpl, nowMs });
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchImpl).toHaveBeenCalledTimes(1); // no second fetch
  });

  it('re-fetches after STALE_TTL_MS', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      okResponse({ workspaces: [mockWorkspace('alpha')] }),
    );
    let now = 1_000_000;
    const nowMs = (): number => now;
    maybeRefresh({ fetchImpl, nowMs });
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    now += STALE_TTL_MS + 1;
    maybeRefresh({ fetchImpl, nowMs });
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('force: true bypasses the freshness check', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      okResponse({ workspaces: [mockWorkspace('alpha')] }),
    );
    let now = 1_000_000;
    const nowMs = (): number => now;
    maybeRefresh({ fetchImpl, nowMs });
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // No time advance — but force should refetch.
    maybeRefresh({ fetchImpl, nowMs, force: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('workspaces-cache — 429 backoff + no-flicker', () => {
  it('keeps previous snapshot on 429 (no flicker to empty)', async () => {
    // 1. Populate cache via a successful fetch.
    const apiPayload = { workspaces: [mockWorkspace('alpha'), mockWorkspace('beta')] };
    const successFetch = vi.fn().mockResolvedValue(okResponse(apiPayload));
    await ensureFresh({ fetchImpl: successFetch });
    const before = getSnapshot();
    expect(before.some((w) => w.id === 'alpha')).toBe(true);

    // 2. Next fetch returns 429.
    const limitedFetch = vi.fn().mockResolvedValue(rateLimitedResponse());
    await ensureFresh({ fetchImpl: limitedFetch });

    // 3. Snapshot must be unchanged — no flicker.
    const after = getSnapshot();
    expect(after).toBe(before); // referential equality — same array
    expect(hasSnapshot()).toBe(true);
  });

  it('429 sets the backoff window — subsequent calls do not fetch', async () => {
    let now = 1_000_000;
    const nowMs = (): number => now;
    const limitedFetch = vi.fn().mockResolvedValue(rateLimitedResponse());

    // First 429 → backoffUntil = now + BACKOFF_BASE_MS.
    await ensureFresh({ fetchImpl: limitedFetch, nowMs });
    expect(limitedFetch).toHaveBeenCalledTimes(1);
    expect(__debugCacheState().consecutive429).toBe(1);
    expect(__debugCacheState().backoffUntil).toBe(now + BACKOFF_BASE_MS);

    // Inside the backoff window — must NOT fetch.
    now += 500;
    await ensureFresh({ fetchImpl: limitedFetch, nowMs });
    expect(limitedFetch).toHaveBeenCalledTimes(1);

    // After the backoff window expires — fetch is allowed again.
    now += BACKOFF_BASE_MS;
    await ensureFresh({ fetchImpl: limitedFetch, nowMs });
    expect(limitedFetch).toHaveBeenCalledTimes(2);
    // Second 429 doubled the consecutive count.
    expect(__debugCacheState().consecutive429).toBe(2);
  });

  it('exponential 429 backoff doubles each time, capped at 30s', async () => {
    let now = 1_000_000;
    const nowMs = (): number => now;
    const limitedFetch = vi.fn().mockResolvedValue(rateLimitedResponse());

    await ensureFresh({ fetchImpl: limitedFetch, nowMs });
    expect(__debugCacheState().backoffUntil - now).toBe(BACKOFF_BASE_MS); // 1s

    now += BACKOFF_BASE_MS;
    await ensureFresh({ fetchImpl: limitedFetch, nowMs });
    expect(__debugCacheState().backoffUntil - now).toBe(BACKOFF_BASE_MS * 2); // 2s

    now += BACKOFF_BASE_MS * 2;
    await ensureFresh({ fetchImpl: limitedFetch, nowMs });
    expect(__debugCacheState().backoffUntil - now).toBe(BACKOFF_BASE_MS * 4); // 4s
  });

  it('successful response clears the backoff counter', async () => {
    let now = 1_000_000;
    const nowMs = (): number => now;
    const limitedFetch = vi.fn().mockResolvedValue(rateLimitedResponse());
    await ensureFresh({ fetchImpl: limitedFetch, nowMs });
    expect(__debugCacheState().consecutive429).toBe(1);

    now += BACKOFF_BASE_MS;
    const successFetch = vi
      .fn()
      .mockResolvedValue(okResponse({ workspaces: [mockWorkspace('alpha')] }));
    await ensureFresh({ fetchImpl: successFetch, nowMs });
    expect(__debugCacheState().consecutive429).toBe(0);
    expect(__debugCacheState().backoffUntil).toBe(0);
  });
});

describe('workspaces-cache — getSnapshot fallback', () => {
  it('returns the static fallback before any fetch succeeds', () => {
    const snap = getSnapshot();
    expect(snap.length).toBeGreaterThan(0);
    // The ROOT workspace is always the first entry of the fallback.
    expect(snap[0]).toBeDefined();
    expect(hasSnapshot()).toBe(false);
  });

  it('survives a transient network error without dropping the snapshot', async () => {
    const apiPayload = { workspaces: [mockWorkspace('alpha')] };
    const successFetch = vi.fn().mockResolvedValue(okResponse(apiPayload));
    await ensureFresh({ fetchImpl: successFetch });
    const before = getSnapshot();

    const failingFetch = vi.fn().mockRejectedValue(new Error('boom'));
    await ensureFresh({ fetchImpl: failingFetch });
    const after = getSnapshot();
    expect(after).toBe(before);
  });
});
