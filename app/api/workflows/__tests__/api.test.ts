/**
 * Tests für /api/workflows + /api/workflows/[id] + /api/workflows/runs/[runId].
 *
 * Pattern 4 Welle 2.1 (2026-05-01).
 *
 * Run: `pnpm exec tsx --test app/api/workflows/__tests__/api.test.ts`
 *
 * Wir mocken `@/lib/security/subject-server` damit Auth deterministisch
 * grünt, und `@/lib/events/emit` damit kein DB-Write nötig ist.
 */

import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, beforeEach, describe, it } from 'node:test';

// DB-Pfad VOR dem Import setzen.
if (!process.env.LAZYOS_DB_PATH) {
  process.env.LAZYOS_DB_PATH = join(
    mkdtempSync(join(tmpdir(), 'lazyos-workflows-api-')),
    'workflows-api.db',
  );
}
process.env.LAZYOS_TEST_DISABLE_FK = '1';

// --- Mock: requireAuthenticatedUser ---------------------------------------
let authResolves: { ok: true; userId: string } | { ok: false } = {
  ok: true,
  userId: 'user_test_owner',
};
const subjectServerPath = require.resolve('@/lib/security/subject-server');
require.cache[subjectServerPath] = {
  id: subjectServerPath,
  filename: subjectServerPath,
  loaded: true,
  exports: {
    requireAuthenticatedUser: () => authResolves,
    currentUserIdResolved: () =>
      authResolves.ok ? authResolves.userId : null,
  },
} as unknown as NodeJS.Module;

// --- Mock: emitEvent (no-op DB) -------------------------------------------
const emitPath = require.resolve('@/lib/events/emit');
const emitCalls: Array<Record<string, unknown>> = [];
require.cache[emitPath] = {
  id: emitPath,
  filename: emitPath,
  loaded: true,
  exports: {
    emitEvent: async (call: Record<string, unknown>) => {
      emitCalls.push(call);
      return { ok: true };
    },
  },
} as unknown as NodeJS.Module;

// --- Run Migrations für workflow_runs-Tabelle -----------------------------
before(async () => {
  // Wir nutzen die Foundation-Tests-Migration via Setup-Helper. Hier
  // wir ziehen einfach die Migrations-CLI rein.
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(process.env.LAZYOS_DB_PATH!);
  // Minimal-Schema (nur was die Tests brauchen): workflow_runs + events.
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_runs (
      id                   TEXT PRIMARY KEY,
      workflow_id          TEXT NOT NULL,
      definition_version   TEXT NOT NULL,
      workspace_id         TEXT,
      workstream_id        TEXT,
      current_state        TEXT NOT NULL,
      data_json            TEXT NOT NULL DEFAULT '{}',
      status               TEXT NOT NULL DEFAULT 'running',
      created_at           INTEGER NOT NULL,
      updated_at           INTEGER NOT NULL,
      last_transition_at   INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      segment_id TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      actor TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      sensitivity TEXT NOT NULL DEFAULT 'low',
      signature TEXT,
      replayed_from TEXT
    );
  `);
  db.close();
});

// --- Imports der Routes (lazy nach Setup) ---------------------------------
function makeReq(url: string, init: { method?: string; body?: unknown } = {}): Request {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  return new Request(`http://localhost${url}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}

describe('GET /api/workflows', () => {
  beforeEach(() => {
    authResolves = { ok: true, userId: 'user_test_owner' };
    emitCalls.length = 0;
  });

  it('liefert 401 wenn nicht eingeloggt', async () => {
    authResolves = { ok: false };
    const route = await import('../route');
    const req = makeReq('/api/workflows');
    // Next.js routes erwarten NextRequest aber Request reicht für tests
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await route.GET(req as any);
    assert.equal(res.status, 401);
  });

  it('liefert 5 Definitionen', async () => {
    const route = await import('../route');
    const req = makeReq('/api/workflows');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await route.GET(req as any);
    assert.equal(res.status, 200);
    const json = (await res.json()) as {
      definitions: Array<{ id: string; isStub: boolean }>;
    };
    assert.equal(json.definitions.length, 5);
    const ids = json.definitions.map((d) => d.id).sort();
    assert.deepEqual(ids, [
      'design-gate-flow',
      'dev-sprint',
      'field-measurement',
      'legal-correspondence',
      'legal-brief',
    ]);
    // dev-sprint = full impl, others = stub
    const devWorkflow = json.definitions.find((d) => d.id === 'dev-sprint');
    assert.ok(devWorkflow);
    assert.equal(devWorkflow!.isStub, false);
    const fieldMeasurement = json.definitions.find((d) => d.id === 'field-measurement');
    assert.ok(fieldMeasurement);
    assert.equal(fieldMeasurement!.isStub, true);
  });
});

describe('POST /api/workflows', () => {
  beforeEach(() => {
    authResolves = { ok: true, userId: 'user_test_owner' };
    emitCalls.length = 0;
  });

  it('liefert 401 ohne Login', async () => {
    authResolves = { ok: false };
    const route = await import('../route');
    const req = makeReq('/api/workflows', {
      method: 'POST',
      body: { workflowId: 'dev-sprint' },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await route.POST(req as any);
    assert.equal(res.status, 401);
  });

  it('liefert 400 bei unknown workflowId', async () => {
    const route = await import('../route');
    const req = makeReq('/api/workflows', {
      method: 'POST',
      body: { workflowId: 'foo-bar' },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await route.POST(req as any);
    assert.equal(res.status, 400);
  });

  it('startet einen Run + emittet workflow.started', async () => {
    const route = await import('../route');
    const req = makeReq('/api/workflows', {
      method: 'POST',
      body: { workflowId: 'dev-sprint', workspaceId: 'lazyos' },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await route.POST(req as any);
    assert.equal(res.status, 201);
    const json = (await res.json()) as {
      run: { id: string; workflowId: string; currentState: string };
      url: string;
    };
    assert.match(json.run.id, /^wfr_/);
    assert.equal(json.run.workflowId, 'dev-sprint');
    assert.equal(json.run.currentState, 'plan');
    assert.match(json.url, /^\/workflows\/runs\/wfr_/);

    // Audit emitted
    assert.equal(emitCalls.length, 1);
    assert.equal(emitCalls[0]!.eventType, 'workflow.started');
  });
});

describe('GET /api/workflows/[id]', () => {
  beforeEach(() => {
    authResolves = { ok: true, userId: 'user_test_owner' };
  });

  it('liefert dev-sprint Definition mit 7 States', async () => {
    const route = await import('../[id]/route');
    const req = makeReq('/api/workflows/dev-sprint');
    const res = await route.GET(req as never, {
      params: Promise.resolve({ id: 'dev-sprint' }),
    });
    assert.equal(res.status, 200);
    const json = (await res.json()) as {
      definition: {
        id: string;
        states: Array<{
          id: string;
          llmSlot: string;
          manualOverride: string;
          transitions: Array<{ to: string; label: string }>;
        }>;
      };
    };
    assert.equal(json.definition.id, 'dev-sprint');
    assert.equal(json.definition.states.length, 7);
    const stateIds = json.definition.states.map((s) => s.id);
    assert.ok(stateIds.includes('plan'));
    assert.ok(stateIds.includes('deploy-gate'));
    const deployGate = json.definition.states.find((s) => s.id === 'deploy-gate');
    assert.equal(deployGate?.manualOverride, 'forbid');
  });

  it('liefert 404 bei unknown id', async () => {
    const route = await import('../[id]/route');
    const req = makeReq('/api/workflows/foo');
    const res = await route.GET(req as never, {
      params: Promise.resolve({ id: 'foo' }),
    });
    assert.equal(res.status, 404);
  });
});
