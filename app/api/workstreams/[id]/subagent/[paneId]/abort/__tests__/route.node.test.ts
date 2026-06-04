// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Maximilian Gerhardt
//
// node:test integration test for POST /api/workstreams/[id]/subagent/[paneId]/abort
// CP-2 / UX-Audit 2026-05-28.
//
// What this file specifically covers
// ----------------------------------
// 1. The route MODULE LOADS — all imports resolve cleanly, the exported
//    POST function is callable, runtime + dynamic flags are correct.
// 2. AUTH-GATE 401 — when the request has no auth cookie, the handler
//    returns 401 with `error: 'auth-required'` BEFORE touching the DB
//    or the fleet registry. This is the minimum viable contract test
//    that does not require an in-memory better-sqlite3.
//
// The successful-abort + idempotent-abort paths are exercised at the
// pure-data layer by `lib/agents/__tests__/abort-pane.node.test.ts`,
// which is the load-bearing logic the route delegates to.

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

describe('POST /api/workstreams/[id]/subagent/[paneId]/abort — module contract', () => {
  it('module loads + exports POST', async () => {
    const mod = await import(
      '@/app/api/workstreams/[id]/subagent/[paneId]/abort/route'
    );
    assert.equal(typeof mod.POST, 'function');
    assert.equal(mod.runtime, 'nodejs');
    assert.equal(mod.dynamic, 'force-dynamic');
  });

  it('returns 401 + auth-required for unauthenticated requests', async () => {
    const mod = await import(
      '@/app/api/workstreams/[id]/subagent/[paneId]/abort/route'
    );
    // Request without auth cookies — currentUserIdResolved returns null.
    // We deliberately use a plain Request object — the route's signature
    // is NextRequest but the handler only reads cookie + JSON, both of
    // which are available on the standard Request. The cast keeps tsc
    // happy without pulling next/server into the test.
    const fakeReq = new Request(
      'http://localhost:4200/api/workstreams/ws-test/subagent/sub-coder-aaaaaaaa/abort',
      {
        method: 'POST',
        headers: {
          // intentionally no cookie / no session header
          'content-type': 'application/json',
        },
        body: '{}',
      },
    ) as unknown as Parameters<typeof mod.POST>[0];
    const ctx = {
      params: Promise.resolve({
        id: 'ws-test',
        paneId: 'sub-coder-aaaaaaaa',
      }),
    };
    const res = await mod.POST(fakeReq, ctx);
    assert.equal(res.status, 401);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, 'auth-required');
  });
});
