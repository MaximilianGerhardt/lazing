// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Maximilian Gerhardt
//
// node:test parallel suite for lib/nav/workspaces-cache.
//
// Why this exists alongside `workspaces-cache.test.ts` (vitest):
// the local vitest environment is currently broken (`std-env` CJS/ESM
// mismatch in `vitest/dist/config.cjs` — pre-existing infra bug,
// see install state of 2026-05-28). This file uses Node's built-in
// `node:test` + `node:assert` runner so the CP-2 cache contract is
// verifiable without pulling vitest's config loader.
//
// Run:
//   npx tsx --test --import tsx lib/nav/__tests__/workspaces-cache.node.test.ts

import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';

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

/** Simple mock-fn: returns the bound impl and tracks call count. */
function mockFn<T extends (...args: unknown[]) => unknown>(
  impl: T,
): T & { callCount: number; calls: unknown[][] } {
  let callCount = 0;
  const calls: unknown[][] = [];
  const wrapped = ((...args: unknown[]) => {
    callCount += 1;
    calls.push(args);
    return impl(...(args as Parameters<T>));
  }) as T & { callCount: number; calls: unknown[][] };
  Object.defineProperty(wrapped, 'callCount', { get: () => callCount });
  Object.defineProperty(wrapped, 'calls', { get: () => calls });
  return wrapped;
}

beforeEach(() => {
  __resetWorkspacesCache();
});

afterEach(() => {
  __resetWorkspacesCache();
});

describe('workspaces-cache — single-flight dedupe', () => {
  it('deduplicates N concurrent callers into ONE fetch', async () => {
    const apiPayload = { workspaces: [mockWorkspace('alpha'), mockWorkspace('beta')] };
    const fetchImpl = mockFn(
      () =>
        new Promise<Response>((resolve) =>
          setTimeout(() => resolve(okResponse(apiPayload)), 10),
        ),
    ) as unknown as typeof fetch;
    // Six parallel callers — mirrors the six useWorkspaces() sites.
    const callers = await Promise.all([
      ensureFresh({ fetchImpl }),
      ensureFresh({ fetchImpl }),
      ensureFresh({ fetchImpl }),
      ensureFresh({ fetchImpl }),
      ensureFresh({ fetchImpl }),
      ensureFresh({ fetchImpl }),
    ]);
    assert.equal((fetchImpl as unknown as { callCount: number }).callCount, 1);
    for (const list of callers) {
      assert.ok(list.length > 0);
    }
    assert.equal(hasSnapshot(), true);
  });

  it('uses the correct endpoint with cache: no-store', async () => {
    const fetchImpl = mockFn(() =>
      Promise.resolve(okResponse({ workspaces: [mockWorkspace('alpha')] })),
    ) as unknown as typeof fetch;
    await ensureFresh({ fetchImpl });
    const mock = fetchImpl as unknown as { callCount: number; calls: unknown[][] };
    assert.equal(mock.callCount, 1);
    assert.equal(mock.calls[0]![0], WORKSPACES_ENDPOINT);
    assert.deepEqual(mock.calls[0]![1], { cache: 'no-store' });
  });
});

describe('workspaces-cache — staleness check (maybeRefresh)', () => {
  it('skips fetch when the cache is fresh (younger than STALE_TTL_MS)', async () => {
    const fetchImpl = mockFn(() =>
      Promise.resolve(okResponse({ workspaces: [mockWorkspace('alpha')] })),
    ) as unknown as typeof fetch;
    let now = 1_000_000;
    const nowMs = (): number => now;

    maybeRefresh({ fetchImpl, nowMs });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal((fetchImpl as unknown as { callCount: number }).callCount, 1);

    now += 5_000;
    maybeRefresh({ fetchImpl, nowMs });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal((fetchImpl as unknown as { callCount: number }).callCount, 1);
  });

  it('re-fetches after STALE_TTL_MS', async () => {
    const fetchImpl = mockFn(() =>
      Promise.resolve(okResponse({ workspaces: [mockWorkspace('alpha')] })),
    ) as unknown as typeof fetch;
    let now = 1_000_000;
    const nowMs = (): number => now;

    maybeRefresh({ fetchImpl, nowMs });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal((fetchImpl as unknown as { callCount: number }).callCount, 1);

    now += STALE_TTL_MS + 1;
    maybeRefresh({ fetchImpl, nowMs });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal((fetchImpl as unknown as { callCount: number }).callCount, 2);
  });

  it('force: true bypasses the freshness check', async () => {
    const fetchImpl = mockFn(() =>
      Promise.resolve(okResponse({ workspaces: [mockWorkspace('alpha')] })),
    ) as unknown as typeof fetch;
    let now = 1_000_000;
    const nowMs = (): number => now;

    maybeRefresh({ fetchImpl, nowMs });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal((fetchImpl as unknown as { callCount: number }).callCount, 1);

    maybeRefresh({ fetchImpl, nowMs, force: true });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal((fetchImpl as unknown as { callCount: number }).callCount, 2);
  });
});

describe('workspaces-cache — 429 backoff + no-flicker', () => {
  it('keeps previous snapshot on 429 (no flicker to empty)', async () => {
    const apiPayload = { workspaces: [mockWorkspace('alpha'), mockWorkspace('beta')] };
    const successFetch = mockFn(() => Promise.resolve(okResponse(apiPayload))) as unknown as typeof fetch;
    await ensureFresh({ fetchImpl: successFetch });
    const before = getSnapshot();
    assert.ok(before.some((w) => w.id === 'alpha'));

    const limitedFetch = mockFn(() => Promise.resolve(rateLimitedResponse())) as unknown as typeof fetch;
    await ensureFresh({ fetchImpl: limitedFetch });

    const after = getSnapshot();
    assert.strictEqual(after, before); // same array — no flicker
    assert.equal(hasSnapshot(), true);
  });

  it('429 sets the backoff window — subsequent calls do not fetch', async () => {
    let now = 1_000_000;
    const nowMs = (): number => now;
    const limitedFetch = mockFn(() => Promise.resolve(rateLimitedResponse())) as unknown as typeof fetch;

    await ensureFresh({ fetchImpl: limitedFetch, nowMs });
    assert.equal((limitedFetch as unknown as { callCount: number }).callCount, 1);
    assert.equal(__debugCacheState().consecutive429, 1);
    assert.equal(__debugCacheState().backoffUntil, now + BACKOFF_BASE_MS);

    now += 500;
    await ensureFresh({ fetchImpl: limitedFetch, nowMs });
    assert.equal((limitedFetch as unknown as { callCount: number }).callCount, 1);

    now += BACKOFF_BASE_MS;
    await ensureFresh({ fetchImpl: limitedFetch, nowMs });
    assert.equal((limitedFetch as unknown as { callCount: number }).callCount, 2);
    assert.equal(__debugCacheState().consecutive429, 2);
  });

  it('exponential 429 backoff doubles each time, capped at 30s', async () => {
    let now = 1_000_000;
    const nowMs = (): number => now;
    const limitedFetch = mockFn(() => Promise.resolve(rateLimitedResponse())) as unknown as typeof fetch;

    await ensureFresh({ fetchImpl: limitedFetch, nowMs });
    assert.equal(__debugCacheState().backoffUntil - now, BACKOFF_BASE_MS);

    now += BACKOFF_BASE_MS;
    await ensureFresh({ fetchImpl: limitedFetch, nowMs });
    assert.equal(__debugCacheState().backoffUntil - now, BACKOFF_BASE_MS * 2);

    now += BACKOFF_BASE_MS * 2;
    await ensureFresh({ fetchImpl: limitedFetch, nowMs });
    assert.equal(__debugCacheState().backoffUntil - now, BACKOFF_BASE_MS * 4);
  });

  it('successful response clears the backoff counter', async () => {
    let now = 1_000_000;
    const nowMs = (): number => now;
    const limitedFetch = mockFn(() => Promise.resolve(rateLimitedResponse())) as unknown as typeof fetch;
    await ensureFresh({ fetchImpl: limitedFetch, nowMs });
    assert.equal(__debugCacheState().consecutive429, 1);

    now += BACKOFF_BASE_MS;
    const successFetch = mockFn(() =>
      Promise.resolve(okResponse({ workspaces: [mockWorkspace('alpha')] })),
    ) as unknown as typeof fetch;
    await ensureFresh({ fetchImpl: successFetch, nowMs });
    assert.equal(__debugCacheState().consecutive429, 0);
    assert.equal(__debugCacheState().backoffUntil, 0);
  });
});

describe('workspaces-cache — getSnapshot fallback', () => {
  it('returns the static fallback before any fetch succeeds', () => {
    const snap = getSnapshot();
    assert.ok(snap.length > 0);
    assert.ok(snap[0]);
    assert.equal(hasSnapshot(), false);
  });

  it('survives a transient network error without dropping the snapshot', async () => {
    const apiPayload = { workspaces: [mockWorkspace('alpha')] };
    const successFetch = mockFn(() => Promise.resolve(okResponse(apiPayload))) as unknown as typeof fetch;
    await ensureFresh({ fetchImpl: successFetch });
    const before = getSnapshot();

    const failingFetch = mockFn(() => Promise.reject(new Error('boom'))) as unknown as typeof fetch;
    await ensureFresh({ fetchImpl: failingFetch });
    const after = getSnapshot();
    assert.strictEqual(after, before);
  });
});
