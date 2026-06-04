/**
 * Tests für POST / GET /api/chat/answer · 2026-05-29 (Phase 1 Track AB · Befund B).
 *
 * Verifiziert die strukturierte Antwort-Persistenz für Open-Questions:
 *   - 401 ohne Auth (POST + GET).
 *   - 400 bei kaputtem JSON (POST).
 *   - 200 + ok=false bei missing Pflicht-Feldern (workspaceId/questionId/answer/sourceTurnId).
 *   - 200 + ok=false bei forbidden-Workspace-Permission (kein Schreiben).
 *   - 200 + ok=true + answerId bei Erfolg.
 *   - 200 + ok=true + duplicate=true bei idempotentem zweiten Post.
 *   - 200 + ok=false bei DB-Throw (fail-soft, nie 500).
 *   - GET liefert answered=false wenn keine Row, answered=true wenn vorhanden.
 *
 * Run:
 *   NODE_OPTIONS='--experimental-require-module' npx vitest run \
 *     app/api/chat/answer/__tests__/route.test.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;

// --- Mock-State ------------------------------------------------------------
let authedUser: string | null = 'user_test_owner';
let canEdit = true;

interface Row {
  id: string;
  workspace_id: string;
  workstream_id: string | null;
  flow_run_id: string | null;
  plan_id: string | null;
  question_set_id: string | null;
  question_id: string;
  answer: string;
  source_turn_id: string;
  surface_id: string | null;
  created_at: number;
  content_hash: string;
}

let store: Row[] = [];
let writeDecisionShouldThrow = false;
let dbInsertShouldThrow = false;
let dbSelectShouldThrow = false;

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
      prepare: (sql: string) => {
        const trimmed = sql.trim();
        if (/^INSERT\s+OR\s+IGNORE\s+INTO\s+question_answers/i.test(trimmed)) {
          return {
            run: (
              id: string,
              workspaceId: string,
              workstreamId: string | null,
              flowRunId: string | null,
              planId: string | null,
              questionSetId: string | null,
              questionId: string,
              answer: string,
              sourceTurnId: string,
              surfaceId: string | null,
              createdAt: number,
              contentHash: string,
            ) => {
              if (dbInsertShouldThrow) throw new Error('boom');
              // Idempotenz: UNIQUE(content_hash) ODER UNIQUE(source_turn_id, question_id)
              const dup = store.find(
                (r) =>
                  r.content_hash === contentHash ||
                  (r.source_turn_id === sourceTurnId && r.question_id === questionId),
              );
              if (dup) return { changes: 0 };
              store.push({
                id,
                workspace_id: workspaceId,
                workstream_id: workstreamId,
                flow_run_id: flowRunId,
                plan_id: planId,
                question_set_id: questionSetId,
                question_id: questionId,
                answer,
                source_turn_id: sourceTurnId,
                surface_id: surfaceId,
                created_at: createdAt,
                content_hash: contentHash,
              });
              return { changes: 1 };
            },
          };
        }
        if (/^SELECT\s+id\s+FROM\s+question_answers/i.test(trimmed)) {
          return {
            get: (contentHash: string, sourceTurnId: string, questionId: string) => {
              const dup = store.find(
                (r) =>
                  r.content_hash === contentHash ||
                  (r.source_turn_id === sourceTurnId && r.question_id === questionId),
              );
              return dup ? { id: dup.id } : undefined;
            },
          };
        }
        // GET-Pfad: SELECT id, workspace_id, ... ORDER BY created_at DESC
        if (/^SELECT\s+id,\s*workspace_id/i.test(trimmed)) {
          return {
            get: (wsId: string, qid: string) => {
              if (dbSelectShouldThrow) throw new Error('boom');
              const matches = store
                .filter((r) => r.workspace_id === wsId && r.question_id === qid)
                .sort((a, b) => b.created_at - a.created_at);
              return matches[0] ?? undefined;
            },
          };
        }
        return { run: () => ({ changes: 0 }), get: () => undefined };
      },
    },
  }),
}));

async function loadRoute(): Promise<{ POST: AnyFn; GET: AnyFn }> {
  const mod = await import('../route');
  return {
    POST: mod.POST as unknown as AnyFn,
    GET: mod.GET as unknown as AnyFn,
  };
}

function makePost(body: unknown, opts: { raw?: string } = {}): Request {
  const init: RequestInit = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: opts.raw ?? JSON.stringify(body),
  };
  return new Request('http://localhost/api/chat/answer', init);
}

function makeGet(query: Record<string, string>): Request {
  const qs = new URLSearchParams(query).toString();
  return new Request(`http://localhost/api/chat/answer?${qs}`, {
    method: 'GET',
  });
}

beforeEach(() => {
  authedUser = 'user_test_owner';
  canEdit = true;
  store = [];
  writeDecisionShouldThrow = false;
  dbInsertShouldThrow = false;
  dbSelectShouldThrow = false;
  writeDecisionMock.mockReset();
  writeDecisionMock.mockImplementation((input: { decisionKind?: string }) => {
    if (writeDecisionShouldThrow) throw new Error('audit-boom');
    expect(input.decisionKind).toBe('override');
    return 'dec_test';
  });
});

afterEach(() => {
  vi.resetModules();
});

// ===========================================================================
// POST — Auth
// ===========================================================================

describe('POST /api/chat/answer — Auth', () => {
  it('ohne userId → 401 auth-required', async () => {
    authedUser = null;
    const { POST } = await loadRoute();
    const res = await POST(
      makePost({
        workspaceId: 'ws-1',
        questionId: 'q-1',
        answer: 'antwort',
        sourceTurnId: 'turn-1',
      }),
    );
    expect(res.status).toBe(401);
    expect(store.length).toBe(0);
  });
});

// ===========================================================================
// POST — Body-Validation
// ===========================================================================

describe('POST /api/chat/answer — Body-Validation', () => {
  it('kaputtes JSON → 400 invalid-json', async () => {
    const { POST } = await loadRoute();
    const res = await POST(makePost(null, { raw: '{nicht json' }));
    expect(res.status).toBe(400);
    expect(store.length).toBe(0);
  });

  it('missing workspaceId → 200 ok=false reason=missing-workspaceId', async () => {
    const { POST } = await loadRoute();
    const res = await POST(
      makePost({
        questionId: 'q-1',
        answer: 'a',
        sourceTurnId: 't-1',
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; reason: string };
    expect(body.ok).toBe(false);
    expect(body.reason).toBe('missing-workspaceId');
    expect(store.length).toBe(0);
  });

  it('missing questionId → 200 ok=false reason=missing-questionId', async () => {
    const { POST } = await loadRoute();
    const res = await POST(
      makePost({
        workspaceId: 'ws-1',
        answer: 'a',
        sourceTurnId: 't-1',
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; reason: string };
    expect(body.ok).toBe(false);
    expect(body.reason).toBe('missing-questionId');
  });

  it('missing answer → 200 ok=false reason=missing-answer', async () => {
    const { POST } = await loadRoute();
    const res = await POST(
      makePost({
        workspaceId: 'ws-1',
        questionId: 'q-1',
        sourceTurnId: 't-1',
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; reason: string };
    expect(body.ok).toBe(false);
    expect(body.reason).toBe('missing-answer');
  });

  it('missing sourceTurnId → 200 ok=false reason=missing-sourceTurnId', async () => {
    const { POST } = await loadRoute();
    const res = await POST(
      makePost({
        workspaceId: 'ws-1',
        questionId: 'q-1',
        answer: 'a',
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; reason: string };
    expect(body.ok).toBe(false);
    expect(body.reason).toBe('missing-sourceTurnId');
  });
});

// ===========================================================================
// POST — Permission
// ===========================================================================

describe('POST /api/chat/answer — Permission', () => {
  it('forbidden → 200 ok=false reason=forbidden, kein write', async () => {
    canEdit = false;
    const { POST } = await loadRoute();
    const res = await POST(
      makePost({
        workspaceId: 'ws-1',
        questionId: 'q-1',
        answer: 'a',
        sourceTurnId: 't-1',
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; reason: string };
    expect(body.ok).toBe(false);
    expect(body.reason).toBe('forbidden');
    expect(store.length).toBe(0);
  });
});

// ===========================================================================
// POST — Persistenz + Idempotenz
// ===========================================================================

describe('POST /api/chat/answer — Persistenz + Idempotenz', () => {
  it('Pflicht-Felder erfüllt + permission ok → 200 ok=true + answerId + Row persistiert', async () => {
    const { POST } = await loadRoute();
    const res = await POST(
      makePost({
        workspaceId: 'ws-1',
        workstreamId: 'ws-stream-7',
        flowRunId: 'flow-run-9',
        planId: 'plan-42',
        questionSetId: 'qset-3',
        questionId: 'q-target',
        answer: 'Wir gehen mit Higgsfield + manueller Prompt-Pflege.',
        sourceTurnId: 'turn-abc',
        surfaceId: 'surface-xyz',
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      answerId: string;
      duplicate: boolean;
    };
    expect(body.ok).toBe(true);
    expect(body.duplicate).toBe(false);
    expect(typeof body.answerId).toBe('string');
    expect(store.length).toBe(1);
    expect(store[0].workspace_id).toBe('ws-1');
    expect(store[0].workstream_id).toBe('ws-stream-7');
    expect(store[0].flow_run_id).toBe('flow-run-9');
    expect(store[0].plan_id).toBe('plan-42');
    expect(store[0].question_set_id).toBe('qset-3');
    expect(store[0].question_id).toBe('q-target');
    // VERBATIM (N1)
    expect(store[0].answer).toBe(
      'Wir gehen mit Higgsfield + manueller Prompt-Pflege.',
    );
    expect(store[0].source_turn_id).toBe('turn-abc');
    expect(store[0].surface_id).toBe('surface-xyz');
    expect(typeof store[0].content_hash).toBe('string');
    expect(store[0].content_hash.length).toBe(64); // sha256 hex
    // N8 — workstream_decisions wurde geschrieben.
    expect(writeDecisionMock).toHaveBeenCalledTimes(1);
  });

  it('Optionals fehlen → null im Store, weiterhin 200 ok=true', async () => {
    const { POST } = await loadRoute();
    const res = await POST(
      makePost({
        workspaceId: 'ws-1',
        questionId: 'q-1',
        answer: 'A',
        sourceTurnId: 'turn-1',
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(store[0].workstream_id).toBeNull();
    expect(store[0].flow_run_id).toBeNull();
    expect(store[0].plan_id).toBeNull();
    expect(store[0].question_set_id).toBeNull();
    expect(store[0].surface_id).toBeNull();
    // Kein workstream → KEIN writeDecision-Call (fortsetzungs-hint kein-op).
    expect(writeDecisionMock).not.toHaveBeenCalled();
  });

  it('zweiter identischer Post → 200 ok=true duplicate=true (Idempotenz via content_hash)', async () => {
    const { POST } = await loadRoute();
    const envelope = {
      workspaceId: 'ws-1',
      questionId: 'q-1',
      answer: 'gleiche antwort',
      sourceTurnId: 'turn-x',
    };
    const r1 = await POST(makePost(envelope));
    const b1 = (await r1.json()) as { ok: boolean; duplicate: boolean };
    expect(b1.duplicate).toBe(false);
    const r2 = await POST(makePost(envelope));
    const b2 = (await r2.json()) as {
      ok: boolean;
      duplicate: boolean;
      answerId: string | null;
    };
    expect(b2.ok).toBe(true);
    expect(b2.duplicate).toBe(true);
    // Antwort-ID des Originals wird zurückgegeben.
    expect(typeof b2.answerId).toBe('string');
    expect(store.length).toBe(1);
  });

  it('Post 2 mit gleichem (sourceTurnId, questionId) aber anderer Antwort → ebenfalls duplicate (defense-in-depth)', async () => {
    const { POST } = await loadRoute();
    await POST(
      makePost({
        workspaceId: 'ws-1',
        questionId: 'q-1',
        answer: 'erste',
        sourceTurnId: 'turn-anker',
      }),
    );
    const r2 = await POST(
      makePost({
        workspaceId: 'ws-1',
        questionId: 'q-1',
        answer: 'zweite (Tippfehler korrigiert)',
        sourceTurnId: 'turn-anker', // gleicher Turn-Anker
      }),
    );
    const b2 = (await r2.json()) as { ok: boolean; duplicate: boolean };
    expect(b2.ok).toBe(true);
    expect(b2.duplicate).toBe(true);
    expect(store.length).toBe(1);
    // Erste Antwort bleibt — Defense-in-depth gegen Client-Bugs (gleicher Turn).
    expect(store[0].answer).toBe('erste');
  });

  it('DB-throw beim INSERT → 200 ok=false reason=write-failed (fail-soft, kein 500)', async () => {
    dbInsertShouldThrow = true;
    const { POST } = await loadRoute();
    const res = await POST(
      makePost({
        workspaceId: 'ws-1',
        questionId: 'q-1',
        answer: 'a',
        sourceTurnId: 't-1',
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; reason: string };
    expect(body.ok).toBe(false);
    expect(body.reason).toBe('write-failed');
  });

  it('writeDecision-Throw → trotzdem 200 ok=true (Audit ist Bonus, fail-soft)', async () => {
    writeDecisionShouldThrow = true;
    // writeDecisionMock-Implementation überschreiben damit kein expect() darin wirft.
    writeDecisionMock.mockReset();
    writeDecisionMock.mockImplementation(() => {
      throw new Error('audit-boom');
    });
    const { POST } = await loadRoute();
    const res = await POST(
      makePost({
        workspaceId: 'ws-1',
        workstreamId: 'ws-stream-1',
        questionId: 'q-1',
        answer: 'a',
        sourceTurnId: 't-1',
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(store.length).toBe(1);
  });
});

// ===========================================================================
// GET — Hydration
// ===========================================================================

describe('GET /api/chat/answer — Hydration', () => {
  it('ohne userId → 401', async () => {
    authedUser = null;
    const { GET } = await loadRoute();
    const res = await GET(makeGet({ wsId: 'ws-1', qid: 'q-1' }));
    expect(res.status).toBe(401);
  });

  it('missing wsId → 200 ok=false reason=missing-wsId answered=false', async () => {
    const { GET } = await loadRoute();
    const res = await GET(makeGet({ qid: 'q-1' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      reason: string;
      answered: boolean;
    };
    expect(body.ok).toBe(false);
    expect(body.reason).toBe('missing-wsId');
    expect(body.answered).toBe(false);
  });

  it('missing qid → 200 ok=false reason=missing-qid answered=false', async () => {
    const { GET } = await loadRoute();
    const res = await GET(makeGet({ wsId: 'ws-1' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reason: string; answered: boolean };
    expect(body.reason).toBe('missing-qid');
    expect(body.answered).toBe(false);
  });

  it('forbidden → 200 ok=false reason=forbidden answered=false', async () => {
    canEdit = false;
    const { GET } = await loadRoute();
    const res = await GET(makeGet({ wsId: 'ws-1', qid: 'q-1' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reason: string; answered: boolean };
    expect(body.reason).toBe('forbidden');
    expect(body.answered).toBe(false);
  });

  it('keine Row → 200 ok=true answered=false', async () => {
    const { GET } = await loadRoute();
    const res = await GET(makeGet({ wsId: 'ws-1', qid: 'q-1' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; answered: boolean };
    expect(body.ok).toBe(true);
    expect(body.answered).toBe(false);
  });

  it('Row vorhanden → 200 ok=true answered=true + Felder', async () => {
    const { POST, GET } = await loadRoute();
    // Erst per POST befüllen.
    await POST(
      makePost({
        workspaceId: 'ws-1',
        workstreamId: 'ws-stream-7',
        questionId: 'q-1',
        answer: 'Higgsfield',
        sourceTurnId: 'turn-1',
      }),
    );
    const res = await GET(makeGet({ wsId: 'ws-1', qid: 'q-1' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      answered: boolean;
      answer: string;
      workstreamId: string;
    };
    expect(body.ok).toBe(true);
    expect(body.answered).toBe(true);
    expect(body.answer).toBe('Higgsfield');
    expect(body.workstreamId).toBe('ws-stream-7');
  });

  it('DB-Throw beim SELECT → 200 ok=false reason=read-failed answered=false', async () => {
    dbSelectShouldThrow = true;
    const { GET } = await loadRoute();
    const res = await GET(makeGet({ wsId: 'ws-1', qid: 'q-1' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      reason: string;
      answered: boolean;
    };
    expect(body.ok).toBe(false);
    expect(body.reason).toBe('read-failed');
    expect(body.answered).toBe(false);
  });
});
