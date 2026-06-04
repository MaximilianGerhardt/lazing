/**
 * Tests für PATCH /api/permission/[workspaceId]/mode — Owner-Fix Live-Test 2026-05-28.
 *
 * Fokus: User-Default-Propagation. Wenn der User einen Workspace-Mode
 * explizit toggelt, soll sein system-übergreifender User-Default mit-aktualisiert
 * werden (Owner-Direktive: „wenn ich Vollzugriff einschalte, will ich das
 * überall haben").
 *
 * Run:
 *   pnpm exec vitest run app/api/permission/\\[workspaceId\\]/mode/__tests__/route.test.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// --- Mock-State ------------------------------------------------------------
let authedUser: string | null = 'user_test_owner';
let canEdit = true;
let hasMembership = true;
const userDefaultSetCalls: Array<{
  userId: string;
  mode: string | null;
  reason?: string | null;
  source?: string;
}> = [];

vi.mock('@/lib/security/subject-server', () => ({
  currentUserIdResolved: () => authedUser,
}));

vi.mock('@/lib/security/permissions', () => ({
  canEditWorkspaceContent: () => canEdit,
  getEffectiveWorkspaceRole: () => (canEdit ? 'admin' : null),
}));

vi.mock('@/lib/security/membership', () => ({
  hasRealWorkspaceMembership: () => hasMembership,
}));

vi.mock('@/lib/users/preferences-repo', () => ({
  setUserDefaultPermissionMode: (args: {
    userId: string;
    mode: string | null;
    reason?: string | null;
    source?: string;
  }) => {
    userDefaultSetCalls.push(args);
    return {
      userId: args.userId,
      defaultPermissionMode: args.mode,
      reason: args.reason ?? null,
      source: args.source ?? 'api',
      contentHash: 'hash-stub',
      createdAt: 1,
      updatedAt: 1,
    };
  },
}));

vi.mock('@/db/client', () => ({
  getDb: () => ({
    $raw: {
      prepare: () => ({
        run: () => ({ changes: 1 }),
        get: () => undefined,
      }),
      transaction: (fn: () => void) => () => fn(),
    },
  }),
}));

async function loadPatch(): Promise<
  (req: Request, ctx: { params: Promise<{ workspaceId: string }> }) => Promise<Response>
> {
  const mod = await import('../route');
  return mod.PATCH as unknown as (
    req: Request,
    ctx: { params: Promise<{ workspaceId: string }> },
  ) => Promise<Response>;
}

function makeReq(body: unknown): Request {
  return new Request(
    'http://localhost/api/permission/ws-test/mode',
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
}

const ctx = {
  params: Promise.resolve({ workspaceId: 'ws-test' }),
};

beforeEach(() => {
  authedUser = 'user_test_owner';
  canEdit = true;
  hasMembership = true;
  userDefaultSetCalls.length = 0;
});

afterEach(() => {
  vi.resetModules();
});

describe('PATCH /api/permission/[workspaceId]/mode — User-Default Propagation', () => {
  it('default propagation: setzt User-Default auf den gewählten Mode (default-propagate-on)', async () => {
    const PATCH = await loadPatch();
    const res = await PATCH(makeReq({ mode: 'freerein' }), ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      mode: string;
      user_default_updated: boolean;
    };
    expect(body.ok).toBe(true);
    expect(body.mode).toBe('freerein');
    expect(body.user_default_updated).toBe(true);

    // setUserDefaultPermissionMode wurde mit dem gleichen Mode aufgerufen.
    expect(userDefaultSetCalls).toHaveLength(1);
    expect(userDefaultSetCalls[0].userId).toBe('user_test_owner');
    expect(userDefaultSetCalls[0].mode).toBe('freerein');
    expect(userDefaultSetCalls[0].source).toBe('permission-toggle');
  });

  it('propagateToUserDefault="skip" → User-Default bleibt unangetastet (explicit-skip)', async () => {
    const PATCH = await loadPatch();
    const res = await PATCH(
      makeReq({ mode: 'ask', propagateToUserDefault: 'skip' }),
      ctx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user_default_updated: boolean };
    expect(body.user_default_updated).toBe(false);
    expect(userDefaultSetCalls).toHaveLength(0);
  });

  it('User-Default folgt auch dem Deaktivieren auf "ask" (toggle-off-propagates)', async () => {
    // Owner-Befund: wenn der User ausschaltet, soll sich der Default auch
    // auf 'ask' aktualisieren — der Default folgt der LETZTEN Aktion.
    const PATCH = await loadPatch();
    const res = await PATCH(makeReq({ mode: 'ask' }), ctx);
    expect(res.status).toBe(200);
    expect(userDefaultSetCalls).toHaveLength(1);
    expect(userDefaultSetCalls[0].mode).toBe('ask');
  });

  it('invalider Mode → 400, kein User-Default-Schreiben (invalid-mode-no-propagate)', async () => {
    const PATCH = await loadPatch();
    const res = await PATCH(makeReq({ mode: 'not-a-mode' }), ctx);
    expect(res.status).toBe(400);
    expect(userDefaultSetCalls).toHaveLength(0);
  });

  it('Auth-Fehler → 401, kein User-Default-Schreiben (auth-required)', async () => {
    authedUser = null;
    const PATCH = await loadPatch();
    const res = await PATCH(makeReq({ mode: 'freerein' }), ctx);
    expect(res.status).toBe(401);
    expect(userDefaultSetCalls).toHaveLength(0);
  });

  it('keine Membership → 403, kein User-Default-Schreiben (forbidden-no-propagate)', async () => {
    hasMembership = false;
    const PATCH = await loadPatch();
    const res = await PATCH(makeReq({ mode: 'freerein' }), ctx);
    expect(res.status).toBe(403);
    expect(userDefaultSetCalls).toHaveLength(0);
  });
});
