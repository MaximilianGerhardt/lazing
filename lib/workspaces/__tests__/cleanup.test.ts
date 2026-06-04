/**
 * Tests für `lib/workspaces/cleanup.ts` (Owner-Bug-Fix 2026-05-29).
 *
 * Strategie:
 *   - In-Memory better-sqlite3 (`:memory:`) mit selbst-aufgesetzten
 *     Minimal-Tabellen, die die Spalten-Shapes der echten DB nachbilden
 *     (workspace_id, coord_key, segment_id, workstream_id, sop_id,
 *     template_id). KEIN Lauf der echten Migrations — das wäre zu viel
 *     Setup-Schmerz, und wir wollen die cleanup-Cascade isoliert verifizieren.
 *   - N8-Trigger werden manuell als BEFORE-DELETE-Trigger angelegt
 *     (RAISE(ABORT, ...)), damit der Fail-Soft-Pfad echt geprüft wird.
 *
 * Run:
 *   pnpm exec vitest run lib/workspaces/__tests__/cleanup.test.ts
 */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  cleanupWorkspaceData,
  disambiguateWorkspaceId,
  probeStaleWorkspaceTraces,
} from '../cleanup';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = OFF'); // wir simulieren FKs nicht — wir machen manuell.

  // Tabellen mit `workspace_id`.
  db.exec(`
    CREATE TABLE workspaces (id TEXT PRIMARY KEY, label TEXT);
    CREATE TABLE workspace_memberships (
      id TEXT PRIMARY KEY, user_id TEXT, workspace_id TEXT, role TEXT
    );
    CREATE TABLE workspace_heartbeats (
      id INTEGER PRIMARY KEY, workspace_id TEXT, ts INTEGER
    );
    CREATE TABLE workspace_fs_roots (
      id TEXT PRIMARY KEY, workspace_id TEXT, path TEXT
    );
    CREATE TABLE workspace_credentials (
      id TEXT PRIMARY KEY, workspace_id TEXT, key TEXT
    );
    CREATE TABLE workspace_beliefs (
      id TEXT PRIMARY KEY, workspace_id TEXT, claim TEXT
    );
    CREATE TABLE workspace_github_repos (
      id TEXT PRIMARY KEY, workspace_id TEXT, repo TEXT
    );
    CREATE TABLE workspace_keys (
      id TEXT PRIMARY KEY, workspace_id TEXT, k TEXT
    );
    CREATE TABLE rag_chunks (
      id TEXT PRIMARY KEY, workspace_id TEXT, content TEXT
    );
    CREATE TABLE rag_indexer_state (
      id TEXT PRIMARY KEY, workspace_id TEXT, ts INTEGER
    );
    CREATE TABLE credential_access_log (
      id INTEGER PRIMARY KEY, workspace_id TEXT, ts INTEGER
    );
    CREATE TABLE lazyos_permission_modes (
      id INTEGER PRIMARY KEY, workspace_id TEXT UNIQUE, mode TEXT
    );
    CREATE TABLE lazyos_permission_audit (
      id INTEGER PRIMARY KEY, workspace_id TEXT, op TEXT
    );
    CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY, workspace_id TEXT, action TEXT
    );
    CREATE TABLE reasoning_audit (
      id INTEGER PRIMARY KEY, workspace_id TEXT, phase TEXT
    );
    CREATE TABLE streaming_snapshots (
      id INTEGER PRIMARY KEY, workspace_id TEXT, data TEXT
    );
    CREATE TABLE decision_outcomes (
      id TEXT PRIMARY KEY, workspace_id TEXT, kind TEXT
    );
    CREATE TABLE workstreams (
      id TEXT PRIMARY KEY, workspace_id TEXT, name TEXT
    );
    CREATE TABLE sops (
      id TEXT PRIMARY KEY, workspace_id TEXT, name TEXT
    );
    CREATE TABLE flow_templates (
      id TEXT PRIMARY KEY, workspace_id TEXT, name TEXT
    );
    CREATE TABLE flow_runs (
      id TEXT PRIMARY KEY, workspace_id TEXT, status TEXT
    );

    -- Tabellen mit coord_key.
    CREATE TABLE chat_ledger (
      id TEXT PRIMARY KEY, coord_key TEXT, content_full TEXT, role TEXT
    );

    -- Tabellen mit segment_id.
    CREATE TABLE events (
      id INTEGER PRIMARY KEY, segment_id TEXT, kind TEXT
    );

    -- Derived-child Tabellen (FK auf workstreams/sops/flow_templates):
    -- N8-PROTECTED (BEFORE DELETE blockt):
    CREATE TABLE workstream_decisions (
      id TEXT PRIMARY KEY, workstream_id TEXT, rationale TEXT
    );
    CREATE TRIGGER trg_workstream_decisions_no_delete
      BEFORE DELETE ON workstream_decisions
      FOR EACH ROW
      BEGIN
        SELECT RAISE(ABORT, 'workstream_decisions is append-only (N8)');
      END;

    CREATE TABLE workstream_evidence (
      id TEXT PRIMARY KEY, workstream_id TEXT, source_ref TEXT
    );
    CREATE TRIGGER trg_workstream_evidence_no_delete
      BEFORE DELETE ON workstream_evidence
      FOR EACH ROW
      BEGIN
        SELECT RAISE(ABORT, 'workstream_evidence is append-only (N8)');
      END;

    -- sop_steps via sop_id (NICHT n8-protected):
    CREATE TABLE sop_steps (
      id TEXT PRIMARY KEY, sop_id TEXT, step_index INTEGER
    );

    -- flow_steps via template_id (NICHT n8-protected):
    CREATE TABLE flow_steps (
      id TEXT PRIMARY KEY, template_id TEXT, step_index INTEGER
    );
  `);
});

afterEach(() => {
  db.close();
});

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

function seedWorkspace(id: string, label: string = id): void {
  db.prepare('INSERT INTO workspaces (id, label) VALUES (?, ?)').run(id, label);
  db.prepare(
    'INSERT INTO workspace_memberships (id, user_id, workspace_id, role) VALUES (?, ?, ?, ?)',
  ).run(`wm_${id}`, 'user_X', id, 'admin');
  db.prepare(
    'INSERT INTO workspace_heartbeats (workspace_id, ts) VALUES (?, ?)',
  ).run(id, Date.now());
  db.prepare(
    'INSERT INTO workspace_fs_roots (id, workspace_id, path) VALUES (?, ?, ?)',
  ).run(`fr_${id}`, id, `/tmp/${id}`);
  db.prepare(
    'INSERT INTO workspace_credentials (id, workspace_id, key) VALUES (?, ?, ?)',
  ).run(`cr_${id}`, id, 'OPENAI_KEY');
  db.prepare(
    'INSERT INTO workspace_beliefs (id, workspace_id, claim) VALUES (?, ?, ?)',
  ).run(`b_${id}`, id, 'belief-A');
  db.prepare(
    'INSERT INTO workspace_github_repos (id, workspace_id, repo) VALUES (?, ?, ?)',
  ).run(`gh_${id}`, id, 'foo/bar');
  db.prepare(
    'INSERT INTO workspace_keys (id, workspace_id, k) VALUES (?, ?, ?)',
  ).run(`k_${id}`, id, 'key-A');
  db.prepare(
    'INSERT INTO rag_chunks (id, workspace_id, content) VALUES (?, ?, ?)',
  ).run(`rc_${id}`, id, 'chunk content');
  db.prepare(
    'INSERT INTO rag_indexer_state (id, workspace_id, ts) VALUES (?, ?, ?)',
  ).run(`ri_${id}`, id, Date.now());
  db.prepare(
    'INSERT INTO credential_access_log (workspace_id, ts) VALUES (?, ?)',
  ).run(id, Date.now());
  db.prepare(
    'INSERT INTO lazyos_permission_modes (workspace_id, mode) VALUES (?, ?)',
  ).run(id, 'freerein');
  db.prepare(
    'INSERT INTO lazyos_permission_audit (workspace_id, op) VALUES (?, ?)',
  ).run(id, 'SEED_MODE:freerein');
  db.prepare('INSERT INTO audit_log (workspace_id, action) VALUES (?, ?)').run(
    id,
    'login',
  );
  db.prepare(
    'INSERT INTO reasoning_audit (workspace_id, phase) VALUES (?, ?)',
  ).run(id, 'phase-A');
  db.prepare(
    'INSERT INTO streaming_snapshots (workspace_id, data) VALUES (?, ?)',
  ).run(id, '{}');
  db.prepare(
    'INSERT INTO decision_outcomes (id, workspace_id, kind) VALUES (?, ?, ?)',
  ).run(`do_${id}`, id, 'kind-A');

  // chat_ledger via coord_key:
  db.prepare(
    'INSERT INTO chat_ledger (id, coord_key, content_full, role) VALUES (?, ?, ?, ?)',
  ).run(`cl_${id}_1`, id, 'Hallo!', 'user');
  db.prepare(
    'INSERT INTO chat_ledger (id, coord_key, content_full, role) VALUES (?, ?, ?, ?)',
  ).run(`cl_${id}_2`, id, 'Antwort', 'assistant');

  // events via segment_id:
  db.prepare('INSERT INTO events (segment_id, kind) VALUES (?, ?)').run(
    id,
    'message',
  );

  // workstreams + derived (decisions/evidence + plan-children):
  const wsRowId = `wsr_${id}`;
  db.prepare(
    'INSERT INTO workstreams (id, workspace_id, name) VALUES (?, ?, ?)',
  ).run(wsRowId, id, 'workstream-1');
  db.prepare(
    'INSERT INTO workstream_decisions (id, workstream_id, rationale) VALUES (?, ?, ?)',
  ).run(`wd_${id}`, wsRowId, 'because-test');
  db.prepare(
    'INSERT INTO workstream_evidence (id, workstream_id, source_ref) VALUES (?, ?, ?)',
  ).run(`we_${id}`, wsRowId, 'src://ref');

  // sops + sop_steps:
  const sopId = `sop_${id}`;
  db.prepare('INSERT INTO sops (id, workspace_id, name) VALUES (?, ?, ?)').run(
    sopId,
    id,
    'sop-A',
  );
  db.prepare(
    'INSERT INTO sop_steps (id, sop_id, step_index) VALUES (?, ?, ?)',
  ).run(`ss_${id}`, sopId, 0);

  // flow_templates + flow_steps + flow_runs:
  const tplId = `tpl_${id}`;
  db.prepare(
    'INSERT INTO flow_templates (id, workspace_id, name) VALUES (?, ?, ?)',
  ).run(tplId, id, 'tpl-A');
  db.prepare(
    'INSERT INTO flow_steps (id, template_id, step_index) VALUES (?, ?, ?)',
  ).run(`fs_${id}`, tplId, 0);
  db.prepare(
    'INSERT INTO flow_runs (id, workspace_id, status) VALUES (?, ?, ?)',
  ).run(`fr_run_${id}`, id, 'done');
}

function countAll(table: string, col: string, value: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${col} = ?`)
    .get(value) as { c: number };
  return row.c;
}

// ──────────────────────────────────────────────────────────────────────────
// cleanupWorkspaceData — Cascade
// ──────────────────────────────────────────────────────────────────────────

describe('cleanupWorkspaceData — Cascade-Verhalten', () => {
  it('löscht alle workspace-gebundenen Rows (full-cascade)', () => {
    seedWorkspace('example-website-2', 'PA Website 2');
    seedWorkspace('other-ws', 'Other Workspace'); // muss unangetastet bleiben

    // Sanity: vor cleanup ist alles da.
    expect(countAll('chat_ledger', 'coord_key', 'example-website-2')).toBe(2);
    expect(countAll('workstreams', 'workspace_id', 'example-website-2')).toBe(1);
    expect(countAll('events', 'segment_id', 'example-website-2')).toBe(1);

    const summary = cleanupWorkspaceData(db as never, 'example-website-2', {
      log: () => {
        /* silent */
      },
    });

    // Direkt-gebundene Tabellen sind leer für die gelöschte Workspace.
    expect(countAll('chat_ledger', 'coord_key', 'example-website-2')).toBe(0);
    expect(countAll('workstreams', 'workspace_id', 'example-website-2')).toBe(0);
    expect(countAll('workspace_memberships', 'workspace_id', 'example-website-2')).toBe(0);
    expect(countAll('workspace_heartbeats', 'workspace_id', 'example-website-2')).toBe(0);
    expect(countAll('workspace_fs_roots', 'workspace_id', 'example-website-2')).toBe(0);
    expect(countAll('workspace_credentials', 'workspace_id', 'example-website-2')).toBe(0);
    expect(countAll('workspace_beliefs', 'workspace_id', 'example-website-2')).toBe(0);
    expect(countAll('rag_chunks', 'workspace_id', 'example-website-2')).toBe(0);
    expect(countAll('rag_indexer_state', 'workspace_id', 'example-website-2')).toBe(0);
    expect(countAll('credential_access_log', 'workspace_id', 'example-website-2')).toBe(0);
    expect(countAll('lazyos_permission_modes', 'workspace_id', 'example-website-2')).toBe(0);
    expect(countAll('lazyos_permission_audit', 'workspace_id', 'example-website-2')).toBe(0);
    expect(countAll('audit_log', 'workspace_id', 'example-website-2')).toBe(0);
    expect(countAll('reasoning_audit', 'workspace_id', 'example-website-2')).toBe(0);
    expect(countAll('streaming_snapshots', 'workspace_id', 'example-website-2')).toBe(0);
    expect(countAll('decision_outcomes', 'workspace_id', 'example-website-2')).toBe(0);
    expect(countAll('events', 'segment_id', 'example-website-2')).toBe(0);
    expect(countAll('sops', 'workspace_id', 'example-website-2')).toBe(0);
    expect(countAll('flow_templates', 'workspace_id', 'example-website-2')).toBe(0);
    expect(countAll('flow_runs', 'workspace_id', 'example-website-2')).toBe(0);

    // Derived-child cascade: sop_steps + flow_steps gelöscht (über parent-IN).
    const ssRemaining = db
      .prepare('SELECT COUNT(*) AS c FROM sop_steps')
      .get() as { c: number };
    const fsRemaining = db
      .prepare('SELECT COUNT(*) AS c FROM flow_steps')
      .get() as { c: number };
    // 1 für „other-ws" muss übrig sein:
    expect(ssRemaining.c).toBe(1);
    expect(fsRemaining.c).toBe(1);

    // Audit-Trail bleibt erhalten (N8): workstream_decisions + workstream_evidence
    // wurden NICHT gelöscht, da BEFORE-DELETE-Trigger blockt.
    expect(
      countAll('workstream_decisions', 'workstream_id', 'wsr_example-website-2'),
    ).toBe(1);
    expect(
      countAll('workstream_evidence', 'workstream_id', 'wsr_example-website-2'),
    ).toBe(1);

    // Summary verifizieren.
    expect(summary.workspaceId).toBe('example-website-2');
    expect(summary.errors).toEqual([]);
    expect(summary.workspace_row_deleted).toBe(false); // default: NICHT gelöscht
    expect(summary.deleted.chat_ledger).toBe(2);
    expect(summary.deleted.workstreams).toBe(1);
    expect(summary.deleted.events).toBe(1);
    expect(summary.deleted.sop_steps).toBe(1);
    expect(summary.deleted.flow_steps).toBe(1);
    expect(summary.audit_trail_preserved).toContain('workstream_decisions:1');
    expect(summary.audit_trail_preserved).toContain('workstream_evidence:1');

    // Andere Workspace ist UNANGETASTET.
    expect(countAll('chat_ledger', 'coord_key', 'other-ws')).toBe(2);
    expect(countAll('workstreams', 'workspace_id', 'other-ws')).toBe(1);
    expect(countAll('events', 'segment_id', 'other-ws')).toBe(1);
    expect(
      countAll('workstream_decisions', 'workstream_id', 'wsr_other-ws'),
    ).toBe(1);
  });

  it('ist idempotent — zweiter Lauf = No-Op (delete-count 0)', () => {
    seedWorkspace('idempotent-ws');

    const first = cleanupWorkspaceData(db as never, 'idempotent-ws', {
      log: () => {
        /* silent */
      },
    });
    expect(first.deleted.chat_ledger).toBe(2);
    expect(first.deleted.workstreams).toBe(1);
    // Erster Lauf: Audit-Trail wurde durch Trigger geschützt.
    expect(first.audit_trail_preserved).toContain('workstream_decisions:1');

    const second = cleanupWorkspaceData(db as never, 'idempotent-ws', {
      log: () => {
        /* silent */
      },
    });
    // Alle direct-cascade-Tabellen liefern 0 (No-Op).
    expect(second.deleted.chat_ledger ?? 0).toBe(0);
    expect(second.deleted.workstreams ?? 0).toBe(0);
    expect(second.deleted.events ?? 0).toBe(0);
    // Im zweiten Lauf gibt es KEINEN Parent (workstreams) mehr → Sub-SELECT
    // ist leer → DELETE-IN feuert auf 0 Rows → Trigger schlägt nicht an
    // (weil keine Row matched). audit_trail_preserved bleibt entsprechend
    // leer für die derived-Tabellen. Das ist die korrekte Semantik:
    // „Idempotent" bedeutet „No-Op", nicht „re-melde was bereits geschützt ist".
    // Der Audit-Trail selbst ist aber noch da:
    const decisionsRemaining = db
      .prepare(
        'SELECT COUNT(*) AS c FROM workstream_decisions WHERE workstream_id = ?',
      )
      .get('wsr_idempotent-ws') as { c: number };
    expect(decisionsRemaining.c).toBe(1);
    expect(second.errors).toEqual([]);
  });

  it('löscht auch die workspaces-Row wenn opts.deleteWorkspaceRow=true', () => {
    seedWorkspace('with-row');
    const summary = cleanupWorkspaceData(db as never, 'with-row', {
      deleteWorkspaceRow: true,
      log: () => {
        /* silent */
      },
    });
    expect(summary.workspace_row_deleted).toBe(true);
    expect(countAll('workspaces', 'id', 'with-row')).toBe(0);
  });

  it('behält die workspaces-Row wenn opts.deleteWorkspaceRow weggelassen wird', () => {
    seedWorkspace('keep-row');
    const summary = cleanupWorkspaceData(db as never, 'keep-row', {
      log: () => {
        /* silent */
      },
    });
    expect(summary.workspace_row_deleted).toBe(false);
    expect(countAll('workspaces', 'id', 'keep-row')).toBe(1);
  });

  it('weist invalid workspaceId-Shapes ab', () => {
    const summary = cleanupWorkspaceData(db as never, "weird'; DROP TABLE", {
      log: () => {
        /* silent */
      },
    });
    expect(summary.errors.length).toBeGreaterThan(0);
    expect(summary.errors[0].table).toBe('<input>');
  });

  it('berührt KEINE andere Workspace (cross-workspace isolation)', () => {
    seedWorkspace('ws-a');
    seedWorkspace('ws-b');

    cleanupWorkspaceData(db as never, 'ws-a', {
      log: () => {
        /* silent */
      },
    });

    // ws-b ist komplett intakt.
    expect(countAll('chat_ledger', 'coord_key', 'ws-b')).toBe(2);
    expect(countAll('workstreams', 'workspace_id', 'ws-b')).toBe(1);
    expect(countAll('events', 'segment_id', 'ws-b')).toBe(1);
    expect(countAll('sops', 'workspace_id', 'ws-b')).toBe(1);
    expect(countAll('flow_templates', 'workspace_id', 'ws-b')).toBe(1);
    expect(countAll('lazyos_permission_modes', 'workspace_id', 'ws-b')).toBe(1);
    const ssAll = db
      .prepare('SELECT COUNT(*) AS c FROM sop_steps')
      .get() as { c: number };
    // 1 von ws-b übrig, 0 von ws-a.
    expect(ssAll.c).toBe(1);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// probeStaleWorkspaceTraces — Spürsinn für Audit-Reste
// ──────────────────────────────────────────────────────────────────────────

describe('probeStaleWorkspaceTraces — erkennt Reste', () => {
  it('liefert found=false für komplett ungenutzten Slug', () => {
    const probe = probeStaleWorkspaceTraces(db as never, 'never-existed');
    expect(probe.found).toBe(false);
    expect(probe.traces).toEqual([]);
  });

  it('erkennt Reste in chat_ledger', () => {
    db.prepare(
      'INSERT INTO chat_ledger (id, coord_key, content_full, role) VALUES (?, ?, ?, ?)',
    ).run('cl_x_1', 'example-website-2', 'stale', 'user');
    const probe = probeStaleWorkspaceTraces(db as never, 'example-website-2');
    expect(probe.found).toBe(true);
    expect(probe.traces.some((t) => t.table === 'chat_ledger')).toBe(true);
  });

  it('erkennt Reste in workstream_decisions via parent-Tabelle (workstreams)', () => {
    // Workstream + decision anlegen, dann workstream HARD-löschen vor Test.
    // Aber: workstream_decisions ist N8-protected → bleibt erhalten.
    db.prepare(
      'INSERT INTO workstreams (id, workspace_id, name) VALUES (?, ?, ?)',
    ).run('wsr_stale', 'stale-ws', 'stale-stream');
    db.prepare(
      'INSERT INTO workstream_decisions (id, workstream_id, rationale) VALUES (?, ?, ?)',
    ).run('wd_stale', 'wsr_stale', 'because-old');

    // STALE_PROBE_TABLES schaut auf workstreams.workspace_id selbst — der bleibt
    // hier stehen (kein cleanup), daher müssen wir den Trace direkt finden.
    const probe = probeStaleWorkspaceTraces(db as never, 'stale-ws');
    expect(probe.found).toBe(true);
    expect(probe.traces.some((t) => t.table === 'workstreams')).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// disambiguateWorkspaceId — F2 ID-Kollisions-Schutz
// ──────────────────────────────────────────────────────────────────────────

describe('disambiguateWorkspaceId — F2 Kollisions-Schutz', () => {
  it('gibt baseSlug zurück wenn frei', () => {
    const id = disambiguateWorkspaceId(db as never, 'fresh-slug');
    expect(id).toBe('fresh-slug');
  });

  it('hängt -2 an wenn chat_ledger noch stale Rows hat (Owner-Szenario)', () => {
    // Owner-Szenario verbatim: vorherige PA Website 2 wurde gelöscht,
    // aber chat_ledger.coord_key='example-website-2' wurde übersehen.
    db.prepare(
      'INSERT INTO chat_ledger (id, coord_key, content_full, role) VALUES (?, ?, ?, ?)',
    ).run('cl_stale_1', 'example-website-2', 'Hallo, alter Verlauf', 'user');

    const id = disambiguateWorkspaceId(db as never, 'example-website-2');
    expect(id).toBe('example-website-2-2');
  });

  it('hängt -3 an wenn -2 auch besetzt ist', () => {
    db.prepare(
      'INSERT INTO chat_ledger (id, coord_key, content_full, role) VALUES (?, ?, ?, ?)',
    ).run('cl1', 'example-website-2', 'a', 'user');
    db.prepare(
      'INSERT INTO chat_ledger (id, coord_key, content_full, role) VALUES (?, ?, ?, ?)',
    ).run('cl2', 'example-website-2-2', 'b', 'user');

    const id = disambiguateWorkspaceId(db as never, 'example-website-2');
    expect(id).toBe('example-website-2-3');
  });

  it('Notausgang: random-Suffix wenn alle nummerischen Pfade besetzt', () => {
    // Wir sperren -2..-10 in chat_ledger.
    for (let i = 2; i <= 10; i++) {
      db.prepare(
        'INSERT INTO chat_ledger (id, coord_key, content_full, role) VALUES (?, ?, ?, ?)',
      ).run(`cl_${i}`, `bingo-${i}`, 'x', 'user');
    }
    db.prepare(
      'INSERT INTO chat_ledger (id, coord_key, content_full, role) VALUES (?, ?, ?, ?)',
    ).run('cl_base', 'bingo', 'x', 'user');

    const id = disambiguateWorkspaceId(db as never, 'bingo', /*maxTries=*/ 9);
    expect(id.startsWith('bingo-')).toBe(true);
    expect(id).not.toBe('bingo');
    // Random-Pfad: 4-stelliger alpha-Suffix → Länge baseSlug + 1 + 4 = 5+5=10
    expect(id.length).toBeGreaterThanOrEqual('bingo-'.length + 4);
  });

  it('Owner-Szenario E2E: nach cleanup + create neu, neuer Slug bekommt leeren Chat', () => {
    // 1) Alte Workspace anlegen + Chat-Verlauf seeden.
    seedWorkspace('example-website-2', 'PA Website 2');
    expect(countAll('chat_ledger', 'coord_key', 'example-website-2')).toBe(2);

    // 2) Cleanup, ABER chat_ledger nur partial — simulieren wir den
    //    Original-Bug, indem wir die workspaces-Row entfernen aber chat_ledger
    //    behalten (so wie es vor F1 war).
    db.prepare('DELETE FROM workspaces WHERE id = ?').run('example-website-2');
    // chat_ledger bleibt mit 2 Rows stehen.
    expect(countAll('chat_ledger', 'coord_key', 'example-website-2')).toBe(2);

    // 3) Owner legt neuen Workspace mit gleichem Label an → slugify → gleicher Slug.
    //    F2 kickt rein: disambiguate liefert -2-Suffix.
    const newId = disambiguateWorkspaceId(db as never, 'example-website-2');
    expect(newId).toBe('example-website-2-2');

    // 4) Verifizieren: der NEUE Slug hat 0 stale Chats.
    expect(countAll('chat_ledger', 'coord_key', newId)).toBe(0);
  });
});
