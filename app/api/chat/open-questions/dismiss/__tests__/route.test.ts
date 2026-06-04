/**
 * Tests für POST /api/chat/open-questions/dismiss (2026-05-28, Owner-Spec D).
 *
 * Verifiziert die fail-soft-Audit-Spur bei manuellen Pill-Dismisses.
 * Der Endpoint MUSS:
 *  - 401 ohne Auth.
 *  - 400 bei kaputtem JSON.
 *  - 200 + ok=false bei missing questionId (Body-Issue, nicht User-Issue).
 *  - 200 + ok=false bei missing workstreamId (Free-Chat, UI-only-Dismiss OK).
 *  - 200 + ok=false bei unbekanntem Workstream (kein Schreiben).
 *  - 200 + ok=false bei forbidden-Workspace-Permission (kein Schreiben).
 *  - 200 + ok=true + decisionId bei Erfolg, decision_kind='override'.
 *  - 200 + ok=false bei writeDecision-Throw (fail-soft, nie 500).
 *
 * Run: NODE_OPTIONS='--experimental-require-module' npx vitest run \
 *      app/api/chat/open-questions/dismiss/__tests__/route.test.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;

// --- Mock-State ------------------------------------------------------------
let authedUser: string | null = 'user_test_owner';
let canEdit = true;
/** Row die der initiale SELECT zurückgibt. null = workstream-not-found. */
let wsRow: { workspace_id: string } | null = { workspace_id: 'ws-test' };

/** Verhalten von writeDecision: 'ok' → returnt id; 'null' → returnt null; 'throw' → wirft. */
let writeDecisionMode: 'ok' | 'null' | 'throw' = 'ok';
const writeDecisionMock = vi.fn<AnyFn>();

vi.mock('@/lib/security/subject-server', () => ({
  currentUserIdResolved: () => authedUser,
}));

vi.mock('@/lib/security/permissions', () => ({
  getEffectiveWorkspaceRole: () => 'admin',
  canEditWorkspaceContent: () => canEdit,
}));

vi.mock('@/lib/workstreams/trace-repo', () => ({
  writeDecision: (...args: unknown[]) => writeDecisionMock(...args),
}));

vi.mock('@/db/client', () => ({
  getDb: () => ({
    $raw: {
      prepare: () => ({
        get: () => wsRow ?? undefined,
      }),
    },
  }),
}));

async function loadPost(): Promise<AnyFn> {
  const mod = await import('../route');
  return mod.POST as unknown as AnyFn;
}

function makeReq(body: unknown, opts: { raw?: string } = {}): Request {
  const init: RequestInit = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: opts.raw ?? JSON.stringify(body),
  };
  return new Request('http://localhost/api/chat/open-questions/dismiss', init);
}

beforeEach(() => {
  authedUser = 'user_test_owner';
  canEdit = true;
  wsRow = { workspace_id: 'ws-test' };
  writeDecisionMode = 'ok';
  writeDecisionMock.mockReset();
  writeDecisionMock.mockImplementation((input: { decisionKind: string }) => {
    if (writeDecisionMode === 'throw') throw new Error('boom');
    if (writeDecisionMode === 'null') return null;
    // Verifiziere bei Aufruf auch decision_kind=override (Owner-Spec).
    expect(input.decisionKind).toBe('override');
    return 'dec_test';
  });
});

afterEach(() => {
  vi.resetModules();
});

describe('POST /api/chat/open-questions/dismiss — Auth', () => {
  it('ohne userId → 401 auth-required', async () => {
    authedUser = null;
    const POST = await loadPost();
    const res = await POST(
      makeReq({ workstreamId: 'ws_1', questionId: 'qa' }),
    );
    expect(res.status).toBe(401);
    expect(writeDecisionMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/chat/open-questions/dismiss — Body-Validation', () => {
  it('kaputtes JSON → 400 invalid-json', async () => {
    const POST = await loadPost();
    const res = await POST(makeReq(null, { raw: '{nicht json' }));
    expect(res.status).toBe(400);
    expect(writeDecisionMock).not.toHaveBeenCalled();
  });

  it('missing questionId → 200 ok=false, kein write', async () => {
    const POST = await loadPost();
    const res = await POST(makeReq({ workstreamId: 'ws_1' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; reason: string };
    expect(body.ok).toBe(false);
    expect(body.reason).toBe('missing-questionId');
    expect(writeDecisionMock).not.toHaveBeenCalled();
  });

  it('missing workstreamId (Free-Chat) → 200 ok=false reason=no-workstream, kein write', async () => {
    const POST = await loadPost();
    const res = await POST(makeReq({ questionId: 'qa' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; reason: string; note?: string };
    expect(body.ok).toBe(false);
    expect(body.reason).toBe('no-workstream');
    expect(body.note).toContain('free-chat');
    expect(writeDecisionMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/chat/open-questions/dismiss — Workspace-Auth + Workstream-Lookup', () => {
  it('unbekannter Workstream → 200 ok=false reason=workstream-not-found, kein write', async () => {
    wsRow = null;
    const POST = await loadPost();
    const res = await POST(makeReq({ workstreamId: 'ws_missing', questionId: 'qa' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; reason: string };
    expect(body.ok).toBe(false);
    expect(body.reason).toBe('workstream-not-found');
    expect(writeDecisionMock).not.toHaveBeenCalled();
  });

  it('keine Edit-Permission → 200 ok=false reason=forbidden, kein write', async () => {
    canEdit = false;
    const POST = await loadPost();
    const res = await POST(makeReq({ workstreamId: 'ws_1', questionId: 'qa' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; reason: string };
    expect(body.ok).toBe(false);
    expect(body.reason).toBe('forbidden');
    expect(writeDecisionMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/chat/open-questions/dismiss — Erfolg + decision_kind=override', () => {
  it('Happy-Path: 200 ok=true mit decisionId, writeDecision mit kind=override + actor=user', async () => {
    const POST = await loadPost();
    const res = await POST(
      makeReq({
        workstreamId: 'ws_1',
        questionId: 'qa',
        questionText: 'Erst Copy oder erst Design?',
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; decisionId: string | null };
    expect(body.ok).toBe(true);
    expect(body.decisionId).toBe('dec_test');

    expect(writeDecisionMock).toHaveBeenCalledTimes(1);
    const callArgs = writeDecisionMock.mock.calls[0]![0] as {
      workspaceId: string;
      workstreamId: string;
      decisionKind: string;
      rationale: string;
      actor: string;
    };
    expect(callArgs.workspaceId).toBe('ws-test');
    expect(callArgs.workstreamId).toBe('ws_1');
    expect(callArgs.decisionKind).toBe('override'); // Spec
    expect(callArgs.actor).toBe('user');
    // N1-Verbatim: Frage-Text MUSS verbatim drinstehen (kein .slice).
    expect(callArgs.rationale).toContain('Erst Copy oder erst Design?');
    expect(callArgs.rationale).toContain('Pill-Dismiss');
    expect(callArgs.rationale).toContain('override');
  });

  it('writeDecision returnt null (best-effort silent failure) → 200 ok=false, kein 5xx', async () => {
    writeDecisionMode = 'null';
    // Reset assertion in mock implementation since we're not actually called with kind check
    writeDecisionMock.mockImplementation(() => null);
    const POST = await loadPost();
    const res = await POST(makeReq({ workstreamId: 'ws_1', questionId: 'qa' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; decisionId: string | null };
    expect(body.ok).toBe(false);
    expect(body.decisionId).toBeNull();
  });

  it('writeDecision throws → 200 ok=false reason=write-failed, NIE 5xx (fail-soft)', async () => {
    writeDecisionMode = 'throw';
    writeDecisionMock.mockImplementation(() => {
      throw new Error('db lock');
    });
    const POST = await loadPost();
    const res = await POST(makeReq({ workstreamId: 'ws_1', questionId: 'qa' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; reason: string };
    expect(body.ok).toBe(false);
    expect(body.reason).toBe('write-failed');
  });
});
