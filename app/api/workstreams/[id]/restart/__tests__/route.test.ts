/**
 * Tests für POST /api/workstreams/[id]/restart — Recovery-Affordanz (2026-05-25).
 *
 * Run: NODE_OPTIONS='--experimental-require-module' npx vitest run app/api/workstreams/[id]/restart/__tests__/route.test.ts
 *
 * Fokus (Critic-Fix #3): Doppel-Spawn-Race. Das atomare Claim-UPDATE
 * (stuck→active WHERE status='stuck') ist der Race-Schutz. Bei changes===0
 * (zweiter, langsamerer Request) → 409, KEIN zweiter Spawn.
 *
 * Mocks: Auth + Permissions + DB-Layer + trace-repo + tier-orchestrator.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;

// --- Mock-State ------------------------------------------------------------
let authedUser: string | null = 'user_test_owner';
let canEdit = true;
/** Row die der initiale SELECT zurückgibt. */
let wsRow: {
  workspace_id: string;
  status: string;
  name: string;
  primary_ticket_id: string | null;
} | null = {
  workspace_id: 'ws-test',
  status: 'stuck',
  name: 'Test Run',
  primary_ticket_id: 'TKT-1',
};
/** changes-Wert den das Claim-UPDATE zurückgibt (1 = Claim gewonnen, 0 = verloren). */
let claimChanges = 1;

const runIterateResumeMock = vi.fn<AnyFn>().mockResolvedValue({ version: 2 });

vi.mock('@/lib/security/subject-server', () => ({
  currentUserIdResolved: () => authedUser,
}));

vi.mock('@/lib/security/permissions', () => ({
  getEffectiveWorkspaceRole: () => 'admin',
  canEditWorkspaceContent: () => canEdit,
}));

vi.mock('@/lib/workstreams/trace-repo', () => ({
  writeDecision: () => 'dec_test',
}));

vi.mock('@/server/agents/tier-orchestrator', () => ({
  runIterateResume: (...args: unknown[]) => runIterateResumeMock(...args),
}));

vi.mock('@/db/client', () => ({
  getDb: () => ({
    $raw: {
      prepare: (sql: string) => ({
        get: () => wsRow ?? undefined,
        run: () => {
          // Nur das Claim-UPDATE (stuck→active) hat einen kontrollierten
          // changes-Wert; alle anderen .run() returnen changes=1.
          if (sql.includes("status = 'active'") && sql.includes("status = 'stuck'")) {
            return { changes: claimChanges };
          }
          return { changes: 1 };
        },
        all: () => [],
      }),
    },
  }),
}));

async function loadPost(): Promise<AnyFn> {
  const mod = await import('../route');
  return mod.POST as unknown as AnyFn;
}

function makeReq(): Request {
  return new Request('http://localhost/api/workstreams/WS-1/restart', {
    method: 'POST',
  });
}

const params = Promise.resolve({ id: 'WS-1' });

beforeEach(() => {
  authedUser = 'user_test_owner';
  canEdit = true;
  wsRow = {
    workspace_id: 'ws-test',
    status: 'stuck',
    name: 'Test Run',
    primary_ticket_id: 'TKT-1',
  };
  claimChanges = 1;
  runIterateResumeMock.mockClear();
  runIterateResumeMock.mockResolvedValue({ version: 2 });
});

afterEach(() => {
  vi.resetModules();
});

describe('POST /api/workstreams/[id]/restart — Claim-Race', () => {
  it('Claim gewonnen (changes=1) → spawnt runIterateResume', async () => {
    claimChanges = 1;
    const POST = await loadPost();
    const res = await POST(makeReq(), { params });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; restarted: boolean };
    expect(body.ok).toBe(true);
    expect(body.restarted).toBe(true);
    expect(runIterateResumeMock).toHaveBeenCalledTimes(1);
  });

  it('(#3) Claim verloren (changes=0, zweiter Request) → 409, KEIN Spawn', async () => {
    claimChanges = 0;
    const POST = await loadPost();
    const res = await POST(makeReq(), { params });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('already-claimed');
    // Race-Verifikation: der zweite Request darf NICHT spawnen.
    expect(runIterateResumeMock).not.toHaveBeenCalled();
  });

  it('Status nicht stuck (active) → 409 invalid-state, kein Claim, kein Spawn', async () => {
    wsRow = {
      workspace_id: 'ws-test',
      status: 'active',
      name: 'Test Run',
      primary_ticket_id: 'TKT-1',
    };
    const POST = await loadPost();
    const res = await POST(makeReq(), { params });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid-state');
    expect(runIterateResumeMock).not.toHaveBeenCalled();
  });

  it('Claim gewonnen aber kein Master-Ticket → restarted:false, kein Spawn', async () => {
    claimChanges = 1;
    wsRow = {
      workspace_id: 'ws-test',
      status: 'stuck',
      name: 'Test Run',
      primary_ticket_id: null,
    };
    const POST = await loadPost();
    const res = await POST(makeReq(), { params });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; restarted: boolean; reason: string };
    expect(body.ok).toBe(true);
    expect(body.restarted).toBe(false);
    expect(body.reason).toBe('no-master-ticket-status-reset-to-active');
    expect(runIterateResumeMock).not.toHaveBeenCalled();
  });

  it('nicht authentifiziert → 401', async () => {
    authedUser = null;
    const POST = await loadPost();
    const res = await POST(makeReq(), { params });
    expect(res.status).toBe(401);
  });

  it('keine Edit-Permission → 403', async () => {
    canEdit = false;
    const POST = await loadPost();
    const res = await POST(makeReq(), { params });
    expect(res.status).toBe(403);
  });

  it('Workstream nicht gefunden → 404', async () => {
    wsRow = null;
    const POST = await loadPost();
    const res = await POST(makeReq(), { params });
    expect(res.status).toBe(404);
  });
});
