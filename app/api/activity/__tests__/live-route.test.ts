/**
 * Tests für /api/activity/live (Sub-Plan 4 — TopNav-Pulse).
 *
 * Synthetik-Fixture: 10 workstreams (mix active/paused/stuck/completed),
 * 3 workflow_runs (2 running, 1 completed), 1 routine (active, fällig
 * in 10min). Asserted Counts + Items-Sortierung.
 *
 * Run: `pnpm exec tsx --test app/api/activity/__tests__/live-route.test.ts`
 */

import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';

// DB-Pfad VOR Imports setzen.
if (!process.env.LAZYOS_DB_PATH) {
  process.env.LAZYOS_DB_PATH = join(
    mkdtempSync(join(tmpdir(), 'lazyos-activity-')),
    'activity.db',
  );
}
process.env.LAZYOS_TEST_DISABLE_FK = '1';

// --- Mock: subject-server (auth) -----------------------------------------
let mockUserId: string | null = 'user_test_owner';
const subjectServerPath = require.resolve('@/lib/security/subject-server');
require.cache[subjectServerPath] = {
  id: subjectServerPath,
  filename: subjectServerPath,
  loaded: true,
  exports: {
    currentUserIdResolved: () => mockUserId,
    requireAuthenticatedUser: () =>
      mockUserId ? { ok: true, userId: mockUserId } : { ok: false },
  },
} as unknown as NodeJS.Module;

// --- Helper: NextRequest-Stub mit cookies-API ----------------------------
function makeRequest(
  query?: string,
): import('next/server').NextRequest {
  const url = `http://localhost/api/activity/live${query ? '?' + query : ''}`;
  const req = new Request(url, {
    method: 'GET',
  });
  // NextRequest hat req.cookies.get(name) → { value } | undefined
  Object.defineProperty(req, 'cookies', {
    value: {
      get: () => undefined,
    },
  });
  Object.defineProperty(req, 'nextUrl', {
    value: new URL((req as Request).url),
  });
  return req as unknown as import('next/server').NextRequest;
}

// --- Mock: orgs/repo (listOrgsForUser) -----------------------------------
const orgsRepoPath = require.resolve('@/lib/orgs/repo');
require.cache[orgsRepoPath] = {
  id: orgsRepoPath,
  filename: orgsRepoPath,
  loaded: true,
  exports: {
    listOrgsForUser: () => [{ id: 'org_test', name: 'Test-Org' }],
  },
} as unknown as NodeJS.Module;

// --- Schema-Setup --------------------------------------------------------
before(async () => {
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(process.env.LAZYOS_DB_PATH!);
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id                  TEXT PRIMARY KEY,
      label               TEXT NOT NULL,
      accent              TEXT NOT NULL DEFAULT 'north',
      path                TEXT NOT NULL DEFAULT '',
      sensitivity         TEXT NOT NULL DEFAULT 'low',
      archived            INTEGER NOT NULL DEFAULT 0,
      sandbox_mode        INTEGER NOT NULL DEFAULT 0,
      credential_owner    TEXT,
      description         TEXT,
      org_chart           TEXT,
      organization_id     TEXT,
      workspace_type      TEXT NOT NULL DEFAULT 'default',
      notes               TEXT,
      notes_updated_at    INTEGER,
      notes_source        TEXT,
      logo_url            TEXT,
      wordmark_url        TEXT,
      brand_colors        TEXT,
      brand_voice         TEXT,
      email_signature     TEXT,
      canonical_domain    TEXT,
      created_at          INTEGER NOT NULL DEFAULT 0,
      updated_at          INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS workstreams (
      id                       TEXT PRIMARY KEY,
      workspace_id             TEXT NOT NULL,
      name                     TEXT NOT NULL,
      primary_session_id       TEXT,
      primary_ticket_id        TEXT,
      tier_mix                 TEXT,
      status                   TEXT NOT NULL DEFAULT 'active',
      cost_cents               INTEGER NOT NULL DEFAULT 0,
      quality_score            REAL,
      classification_embedding TEXT,
      description              TEXT,
      created_at               INTEGER NOT NULL,
      updated_at               INTEGER NOT NULL,
      archived_at              INTEGER,
      parent_workstream_id     TEXT,
      role                     TEXT,
      tmux_session_id          TEXT,
      tokens_in                INTEGER NOT NULL DEFAULT 0,
      tokens_out               INTEGER NOT NULL DEFAULT 0,
      cost_cents_aggregated    INTEGER NOT NULL DEFAULT 0,
      mode                     TEXT,
      iterate_config_json      TEXT,
      dispatch_lock_token      TEXT,
      dispatch_lock_ts         INTEGER
    );

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

    CREATE TABLE IF NOT EXISTS routines (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      workspace_id    TEXT NOT NULL,
      yaml_config     TEXT NOT NULL,
      trigger_mode    TEXT NOT NULL DEFAULT 'manual',
      cron_expr       TEXT,
      event_match     TEXT,
      last_run_at     INTEGER,
      next_run_at     INTEGER,
      active          INTEGER NOT NULL DEFAULT 1,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    );
  `);

  const now = Date.now();

  // 1 Test-Workspace in Org
  db.prepare(
    `INSERT INTO workspaces (id, label, organization_id, created_at, updated_at) VALUES (?,?,?,?,?)`,
  ).run('ws_test', 'Test-WS', 'org_test', now, now);

  // 10 Workstreams: 5 active, 2 paused, 1 stuck, 1 completed, 1 sub-active
  const wsStmt = db.prepare(
    `INSERT INTO workstreams (id, workspace_id, name, status, created_at, updated_at, parent_workstream_id, role, mode)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  );
  for (let i = 0; i < 5; i++) {
    wsStmt.run(
      `ws-act-${i}`,
      'ws_test',
      `Active ${i}`,
      'active',
      now - i * 1000,
      now - i * 1000,
      null,
      'lead',
      'iterate',
    );
  }
  wsStmt.run(
    'ws-pause-1',
    'ws_test',
    'Paused 1',
    'paused',
    now,
    now,
    null,
    null,
    null,
  );
  wsStmt.run(
    'ws-pause-2',
    'ws_test',
    'Paused 2',
    'paused',
    now,
    now,
    null,
    null,
    null,
  );
  wsStmt.run(
    'ws-stuck-1',
    'ws_test',
    'Stuck 1',
    'stuck',
    now,
    now,
    null,
    null,
    null,
  );
  wsStmt.run(
    'ws-completed-1',
    'ws_test',
    'Done 1',
    'completed',
    now,
    now,
    null,
    null,
    null,
  );
  wsStmt.run(
    'ws-sub-1',
    'ws_test',
    'Sub-Active',
    'active',
    now,
    now,
    'ws-act-0',
    'roaster-1',
    null,
  );

  // 3 Workflow-Runs: 2 running, 1 completed
  const wfStmt = db.prepare(
    `INSERT INTO workflow_runs (id, workflow_id, definition_version, workspace_id, current_state, status, created_at, updated_at, last_transition_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  );
  wfStmt.run(
    'wfr_1',
    'dev-sprint',
    'v1',
    'ws_test',
    'analyse',
    'running',
    now,
    now,
    now,
  );
  wfStmt.run(
    'wfr_2',
    'field-measurement',
    'v1',
    'ws_test',
    'foto',
    'running',
    now,
    now,
    now - 500,
  );
  wfStmt.run(
    'wfr_3',
    'design-gate-flow',
    'v1',
    'ws_test',
    'final',
    'completed',
    now,
    now,
    now,
  );

  // 1 Routine: active, nextRunAt in 10min (= cronSoon, da Window=15min)
  db.prepare(
    `INSERT INTO routines (id, name, workspace_id, yaml_config, trigger_mode, next_run_at, active, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(
    'rtn_1',
    'Daily Audit',
    'ws_test',
    'foo: bar',
    'cron',
    now + 10 * 60 * 1000,
    1,
    now,
    now,
  );

  // 1 weitere Routine: active aber nextRunAt in 1h (= NICHT cronSoon)
  db.prepare(
    `INSERT INTO routines (id, name, workspace_id, yaml_config, trigger_mode, next_run_at, active, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(
    'rtn_2',
    'Weekly Audit',
    'ws_test',
    'foo: bar',
    'cron',
    now + 60 * 60 * 1000,
    1,
    now,
    now,
  );

  db.close();
});

describe('GET /api/activity/live', () => {
  it('aggregiert running/paused/stuck korrekt + cronSoon im 15min-Window', async () => {
    const route = await import('../live/route');
    const req = makeRequest();
    const res = await route.GET(req);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      ok: boolean;
      running: number;
      paused: number;
      stuck: number;
      cronSoon: number;
      items: Array<{
        type: string;
        id: string;
        label: string;
        phase: string | null;
      }>;
    };

    assert.equal(body.ok, true, 'ok=true');
    // 5 active workstreams + 1 sub-active + 2 workflow-runs running = 8
    assert.equal(body.running, 8, `running=8, got ${body.running}`);
    assert.equal(body.paused, 2, 'paused=2');
    assert.equal(body.stuck, 1, 'stuck=1');
    // 1 routine in 10min → cronSoon=1 (15min-Window)
    assert.equal(body.cronSoon, 1, 'cronSoon=1');

    // Items sollte mind. die WS+WF+RT enthalten
    const types = body.items.map((i) => i.type);
    assert.ok(types.includes('workstream'), 'has workstream');
    assert.ok(types.includes('sub-workstream'), 'has sub-workstream');
    assert.ok(types.includes('workflow'), 'has workflow');
    assert.ok(types.includes('routine'), 'has routine');

    // Sub-Workstream phase = role (roaster-1)
    const sub = body.items.find((i) => i.type === 'sub-workstream');
    assert.ok(sub, 'sub-workstream exists');
    assert.equal(sub!.phase, 'roaster-1');

    // Workflow phase = currentState
    const wf = body.items.find((i) => i.id === 'wfr_1');
    assert.ok(wf, 'wfr_1 in items');
    assert.equal(wf!.phase, 'analyse');
  });

  it('liefert leere Response wenn User nicht authenticated', async () => {
    mockUserId = null;
    const route = await import('../live/route');
    const req = makeRequest();
    const res = await route.GET(req);
    const body = (await res.json()) as { ok: boolean; running: number };
    assert.equal(body.ok, false);
    assert.equal(body.running, 0);
  });
});

// ----- Welle 1 · 2026-05-03 — excludeWorkstream-Filter -------------------
//
// Single-Source-of-Truth-Refactor: ChatShell broadcastet die ID des aktiven
// Streams, BackgroundActivityIndicator filtert sie raus damit nichts doppelt
// gezaehlt wird. Hier verifiziert: query-param greift sowohl auf workstreams
// als auch workflow_runs, und der Aggregat-Count rechnet konsistent runter.
describe('GET /api/activity/live ?excludeWorkstream=', () => {
  it('schliesst gegebene Workstream-ID aus running-Count + items', async () => {
    mockUserId = 'user_test_owner';
    const route = await import('../live/route');
    const req = makeRequest('excludeWorkstream=ws-act-0');
    const res = await route.GET(req);
    const body = (await res.json()) as {
      ok: boolean;
      running: number;
      items: Array<{ id: string; type: string }>;
    };
    assert.equal(body.ok, true);
    // Vorher running=8 (5 active + 1 sub + 2 wf). Nach Exclude einer
    // active-Workstream (ws-act-0): running=7.
    assert.equal(body.running, 7, `running should be 7, got ${body.running}`);
    assert.ok(
      !body.items.some((i) => i.id === 'ws-act-0'),
      'ws-act-0 should not be in items',
    );
  });

  it('schliesst gegebene Workflow-Run-ID aus', async () => {
    mockUserId = 'user_test_owner';
    const route = await import('../live/route');
    const req = makeRequest('excludeWorkstream=wfr_1');
    const res = await route.GET(req);
    const body = (await res.json()) as {
      ok: boolean;
      running: number;
      items: Array<{ id: string; type: string }>;
    };
    assert.equal(body.ok, true);
    assert.equal(body.running, 7, `running should be 7, got ${body.running}`);
    assert.ok(!body.items.some((i) => i.id === 'wfr_1'));
  });

  it('ohne excludeWorkstream-Param identisch zum Default-Aggregat', async () => {
    mockUserId = 'user_test_owner';
    const route = await import('../live/route');
    const req = makeRequest();
    const res = await route.GET(req);
    const body = (await res.json()) as { running: number };
    assert.equal(body.running, 8);
  });
});

// ----- Owner-Fix 2026-05-28 — Stuck-Aging im Live-Counter -----------------
//
// Vorher: stuck-Workstreams zaehlten ewig im Live-Counter (kein Aging).
// → Inline-Pill blieb stehen mit „aktiv · 18h 5m". Owner: nutzlos.
// → Fix: stuck-WS mit updatedAt aelter als LAZYOS_STUCK_AGING_MS (Default
//   6h) werden im Live-Endpoint nicht mehr gezeigt (Filter-only).
describe('GET /api/activity/live — Stuck-Aging', () => {
  it('zaehlt FRISCH stuck (innerhalb Aging-Window)', async () => {
    mockUserId = 'user_test_owner';
    const route = await import('../live/route');
    const req = makeRequest();
    const res = await route.GET(req);
    const body = (await res.json()) as { ok: boolean; stuck: number };
    assert.equal(body.ok, true);
    // Fixture-stuck (ws-stuck-1) wurde mit now eingespielt → frisch → zaehlt.
    assert.equal(body.stuck, 1, `stuck=1 fuer frisch-stuck, got ${body.stuck}`);
  });

  it('zaehlt ALTEN stuck (> 6h) NICHT mehr im Live-Counter', async () => {
    mockUserId = 'user_test_owner';
    // Setze einen alten stuck-WS in die DB.
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(process.env.LAZYOS_DB_PATH!);
    const longAgo = Date.now() - 18 * 60 * 60 * 1000; // 18h
    db.prepare(
      `INSERT INTO workstreams (id, workspace_id, name, status, created_at, updated_at, parent_workstream_id, role, mode)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(
      'ws-stuck-aged-1',
      'ws_test',
      'Aged Stuck',
      'stuck',
      longAgo,
      longAgo,
      null,
      null,
      null,
    );
    db.close();

    const route = await import('../live/route');
    const req = makeRequest();
    const res = await route.GET(req);
    const body = (await res.json()) as {
      ok: boolean;
      stuck: number;
      items: Array<{ id: string }>;
    };
    assert.equal(body.ok, true);
    // Der alte stuck-WS darf NICHT in items + stuck-Counter bleibt 1.
    assert.equal(
      body.stuck,
      1,
      `aged stuck wurde nicht herausgefiltert, stuck=${body.stuck}`,
    );
    assert.ok(
      !body.items.some((i) => i.id === 'ws-stuck-aged-1'),
      'aged stuck-WS darf nicht in items',
    );
  });

  it('respektiert LAZYOS_STUCK_AGING_MS-ENV (1ms = alles wird aged)', async () => {
    mockUserId = 'user_test_owner';
    const prev = process.env.LAZYOS_STUCK_AGING_MS;
    process.env.LAZYOS_STUCK_AGING_MS = '1';
    try {
      const route = await import('../live/route');
      const req = makeRequest();
      const res = await route.GET(req);
      const body = (await res.json()) as { ok: boolean; stuck: number };
      assert.equal(body.ok, true);
      // Bei 1ms cutoff sollte JEDER stuck weg sein (auch der frische, weil
      // updatedAt < now ist).
      assert.equal(body.stuck, 0, `mit 1ms-cutoff stuck=0, got ${body.stuck}`);
    } finally {
      if (prev === undefined) delete process.env.LAZYOS_STUCK_AGING_MS;
      else process.env.LAZYOS_STUCK_AGING_MS = prev;
    }
  });
});

// ----- Owner-Fix 2026-05-28 — Detail-Mode liefert status/stuckSinceMs ------
describe('GET /api/activity/live ?detail=1 — Detail-Felder', () => {
  it('liefert status fuer alle WS-Items', async () => {
    mockUserId = 'user_test_owner';
    const route = await import('../live/route');
    const req = makeRequest('detail=1');
    const res = await route.GET(req);
    const body = (await res.json()) as {
      ok: boolean;
      items: Array<{
        id: string;
        type: string;
        status?: string | null;
        stuckSinceMs?: number | null;
        stuckReason?: string | null;
      }>;
    };
    assert.equal(body.ok, true);
    const wsItem = body.items.find((i) => i.id === 'ws-act-0');
    assert.ok(wsItem, 'ws-act-0 in items');
    assert.equal(wsItem!.status, 'active');

    const stuckItem = body.items.find((i) => i.id === 'ws-stuck-1');
    if (stuckItem) {
      assert.equal(stuckItem.status, 'stuck');
      assert.ok(
        stuckItem.stuckReason && stuckItem.stuckReason.length > 0,
        'stuckReason populated',
      );
    }
  });

  it('ohne detail=1 bleibt der Payload schlank (backwards-compatible)', async () => {
    mockUserId = 'user_test_owner';
    const route = await import('../live/route');
    const req = makeRequest();
    const res = await route.GET(req);
    const body = (await res.json()) as {
      ok: boolean;
      items: Array<Record<string, unknown>>;
    };
    assert.equal(body.ok, true);
    const wsItem = body.items.find((i) => (i as { id: string }).id === 'ws-act-0');
    assert.ok(wsItem);
    // status/stuckSinceMs/stuckReason duerfen NICHT im Default-Payload sein.
    assert.equal(wsItem!['status'], undefined, 'status nur in detail-mode');
    assert.equal(
      wsItem!['stuckSinceMs'],
      undefined,
      'stuckSinceMs nur in detail-mode',
    );
  });
});
