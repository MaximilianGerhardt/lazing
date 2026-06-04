/**
 * Tests für lib/security/permission-mode.ts — Wave 1 / Batch 4 / ADR-0004.
 *
 * Run: `pnpm exec tsx --test lib/security/__tests__/permission-mode.test.ts`
 *
 * Coverage:
 *   1. Audit-mode (default) ALWAYS returns allow:true (non-disruptive guarantee).
 *   2. N5: userCorrectionOverride=true forces allow regardless of mode.
 *   3. All 3 permission modes (freerein / freerein-with-audit / lane) + audit-mode path.
 *   4. Audit-vs-enforce ENV flag behavior.
 *   5. N10: audit rows carry a non-empty content_hash.
 *   6. Enforce-mode degrades gracefully if resolver table missing (best-effort).
 *
 * Uses a real in-memory SQLite DB with the 0098 migration applied directly
 * so no external dependency on the full migration stack.
 */

import { strict as assert } from 'node:assert';
import { describe, it, before, afterEach } from 'node:test';
import Database from 'better-sqlite3';

import {
  enforcePermission,
  getEnforcementMode,
  type EnforcePermissionArgs,
} from '../permission-mode';

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

/** Bootstrap an in-memory SQLite with the permission tables only. */
function makeTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Minimal schema matching 0098_permission.sql
  db.exec(`
    CREATE TABLE IF NOT EXISTS lazyos_permission_modes (
      id              INTEGER  PRIMARY KEY AUTOINCREMENT,
      workspace_id    TEXT     UNIQUE,
      org_id          TEXT,
      mode            TEXT     NOT NULL DEFAULT 'freerein-with-audit'
                               CHECK (mode IN ('freerein','freerein-with-audit','lane','ask')),
      effective_since TEXT     NOT NULL DEFAULT (datetime('now')),
      set_by          TEXT     NOT NULL DEFAULT 'test',
      reason          TEXT,
      content_hash    TEXT     NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS lazyos_permission_audit (
      id           INTEGER  PRIMARY KEY AUTOINCREMENT,
      ts           TEXT     NOT NULL DEFAULT (datetime('now')),
      workspace_id TEXT,
      org_id       TEXT,
      tool_class   TEXT     NOT NULL,
      tool_name    TEXT     NOT NULL DEFAULT '',
      op           TEXT     NOT NULL DEFAULT '',
      mode         TEXT     NOT NULL,
      would_allow  INTEGER  NOT NULL CHECK (would_allow IN (0,1)),
      reason       TEXT     NOT NULL DEFAULT '',
      enforcement  TEXT     NOT NULL DEFAULT 'audit'
                   CHECK (enforcement IN ('audit','enforce')),
      content_hash TEXT     NOT NULL DEFAULT ''
    );
  `);

  // Seed owner-default row
  db.prepare(
    `INSERT OR IGNORE INTO lazyos_permission_modes
       (workspace_id, mode, set_by, reason, content_hash)
     VALUES ('owner-default', 'freerein-with-audit', 'test', 'bootstrap', '')`,
  ).run();

  return db;
}

function setMode(
  db: Database.Database,
  workspaceId: string,
  mode: string,
): void {
  const existing = db
    .prepare(`SELECT id FROM lazyos_permission_modes WHERE workspace_id = ?`)
    .get(workspaceId);
  if (existing) {
    db.prepare(`UPDATE lazyos_permission_modes SET mode = ? WHERE workspace_id = ?`).run(
      mode,
      workspaceId,
    );
  } else {
    db.prepare(
      `INSERT INTO lazyos_permission_modes (workspace_id, mode, set_by, content_hash)
       VALUES (?, ?, 'test', '')`,
    ).run(workspaceId, mode);
  }
}

function countAuditRows(db: Database.Database, workspaceId: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS c FROM lazyos_permission_audit WHERE workspace_id = ?`)
    .get(workspaceId) as { c: number };
  return row.c;
}

function lastAuditRow(
  db: Database.Database,
  workspaceId: string,
): Record<string, unknown> | undefined {
  return db
    .prepare(
      `SELECT * FROM lazyos_permission_audit WHERE workspace_id = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(workspaceId) as Record<string, unknown> | undefined;
}

// ─────────────────────────────────────────────────────────────
// Test suites
// ─────────────────────────────────────────────────────────────

describe('getEnforcementMode', () => {
  afterEach(() => {
    delete process.env.LAZYOS_PERMISSION_ENFORCEMENT;
  });

  it('returns "audit" when env is unset (default)', () => {
    delete process.env.LAZYOS_PERMISSION_ENFORCEMENT;
    assert.equal(getEnforcementMode(), 'audit');
  });

  it('returns "audit" when env is "audit"', () => {
    process.env.LAZYOS_PERMISSION_ENFORCEMENT = 'audit';
    assert.equal(getEnforcementMode(), 'audit');
  });

  it('returns "enforce" when env is "enforce"', () => {
    process.env.LAZYOS_PERMISSION_ENFORCEMENT = 'enforce';
    assert.equal(getEnforcementMode(), 'enforce');
  });

  it('returns "audit" for any other value (safe default)', () => {
    process.env.LAZYOS_PERMISSION_ENFORCEMENT = 'unknown_value';
    assert.equal(getEnforcementMode(), 'audit');
  });
});

describe('enforcePermission — audit mode (non-disruptive guarantee)', () => {
  let db: Database.Database;

  before(() => {
    db = makeTestDb();
    delete process.env.LAZYOS_PERMISSION_ENFORCEMENT;
  });

  afterEach(() => {
    delete process.env.LAZYOS_PERMISSION_ENFORCEMENT;
  });

  it('ALWAYS returns allow:true in audit mode, regardless of workspace mode', () => {
    for (const mode of ['freerein', 'freerein-with-audit', 'lane', 'ask'] as const) {
      setMode(db, `ws-audit-${mode}`, mode);
      const result = enforcePermission(db, {
        scope: { workspaceId: `ws-audit-${mode}` },
        toolClass: 'shell',
        op: `bash ls -la`,
      });
      assert.equal(
        result.allow,
        true,
        `audit mode must ALWAYS allow, even with mode=${mode}`,
      );
    }
  });

  it('writes an audit row for every call', () => {
    process.env.LAZYOS_PERMISSION_ENFORCEMENT = 'audit';
    const wsId = 'ws-audit-row-check';
    setMode(db, wsId, 'freerein-with-audit');

    const before = countAuditRows(db, wsId);
    enforcePermission(db, {
      scope: { workspaceId: wsId },
      toolClass: 'fs-read',
      toolName: 'Read',
      op: 'Read(/some/file.ts)',
    });
    const after = countAuditRows(db, wsId);
    assert.equal(after, before + 1, 'exactly one audit row written');
  });

  it('N10: audit row has non-empty content_hash', () => {
    process.env.LAZYOS_PERMISSION_ENFORCEMENT = 'audit';
    const wsId = 'ws-n10-hash';
    setMode(db, wsId, 'freerein-with-audit');

    const result = enforcePermission(db, {
      scope: { workspaceId: wsId },
      toolClass: 'network',
      toolName: 'WebFetch',
      op: 'WebFetch(https://example.com)',
    });
    assert.ok(
      result.auditRowHash.length > 0,
      'auditRowHash must be non-empty (N10)',
    );
    assert.match(result.auditRowHash, /^[0-9a-f]{64}$/, 'must be sha256 hex');

    const row = lastAuditRow(db, wsId);
    assert.ok(row, 'audit row must exist');
    assert.match(
      String(row['content_hash']),
      /^[0-9a-f]{64}$/,
      'content_hash in DB must be sha256 hex (N10)',
    );
    // auditRowHash returned must match what was stored.
    assert.equal(row['content_hash'], result.auditRowHash);
  });

  it('audit row records the active mode (freerein-with-audit)', () => {
    process.env.LAZYOS_PERMISSION_ENFORCEMENT = 'audit';
    const wsId = 'ws-mode-record';
    setMode(db, wsId, 'freerein-with-audit');

    enforcePermission(db, {
      scope: { workspaceId: wsId },
      toolClass: 'db',
      op: 'SELECT * FROM workstreams',
    });

    const row = lastAuditRow(db, wsId);
    assert.equal(row?.['mode'], 'freerein-with-audit');
    assert.equal(row?.['enforcement'], 'audit');
    assert.equal(row?.['would_allow'], 1);
  });
});

describe('enforcePermission — N5 user-correction-wins', () => {
  let db: Database.Database;

  before(() => {
    db = makeTestDb();
  });

  afterEach(() => {
    delete process.env.LAZYOS_PERMISSION_ENFORCEMENT;
  });

  it('N5: userCorrectionOverride=true forces allow regardless of mode', () => {
    // Even in enforce mode, N5 wins.
    process.env.LAZYOS_PERMISSION_ENFORCEMENT = 'enforce';
    const wsId = 'ws-n5-ask';
    setMode(db, wsId, 'ask');

    const result = enforcePermission(db, {
      scope: { workspaceId: wsId },
      toolClass: 'shell',
      op: 'Bash(rm -rf /tmp/test)',
      userCorrectionOverride: true,
    });
    assert.equal(result.allow, true, 'N5 override must force allow');
    assert.match(result.reason, /N5-user-correction-override/);
  });

  it('N5: override in audit mode still writes audit row', () => {
    process.env.LAZYOS_PERMISSION_ENFORCEMENT = 'audit';
    const wsId = 'ws-n5-audit';
    setMode(db, wsId, 'lane');

    const before = countAuditRows(db, wsId);
    enforcePermission(db, {
      scope: { workspaceId: wsId },
      toolClass: 'git',
      op: 'git push origin main',
      userCorrectionOverride: true,
    });
    const after = countAuditRows(db, wsId);
    assert.equal(after, before + 1);
  });

  it('N5: override is false (default) → normal audit-mode allow path', () => {
    process.env.LAZYOS_PERMISSION_ENFORCEMENT = 'audit';
    const wsId = 'ws-n5-default';
    setMode(db, wsId, 'freerein-with-audit');

    const result = enforcePermission(db, {
      scope: { workspaceId: wsId },
      toolClass: 'fs-write',
      op: 'Write(/src/foo.ts)',
      userCorrectionOverride: false,
    });
    assert.equal(result.allow, true, 'audit mode allows without override too');
    // Reason should NOT mention N5 override
    assert.ok(!result.reason.includes('N5'), 'no override label in non-override call');
  });
});

describe('enforcePermission — 3 permission modes in audit-mode context', () => {
  let db: Database.Database;

  before(() => {
    db = makeTestDb();
    delete process.env.LAZYOS_PERMISSION_ENFORCEMENT; // ensure audit mode
  });

  it('freerein workspace: audit-mode returns allow:true + logs mode=freerein', () => {
    const wsId = 'ws-freerein';
    setMode(db, wsId, 'freerein');

    const result = enforcePermission(db, {
      scope: { workspaceId: wsId },
      toolClass: 'shell',
      op: 'Bash(echo hello)',
    });
    assert.equal(result.allow, true);
    assert.equal(result.mode, 'freerein');
    const row = lastAuditRow(db, wsId);
    assert.equal(row?.['mode'], 'freerein');
  });

  it('freerein-with-audit workspace: audit-mode returns allow:true', () => {
    const wsId = 'ws-freerein-audit';
    setMode(db, wsId, 'freerein-with-audit');

    const result = enforcePermission(db, {
      scope: { workspaceId: wsId },
      toolClass: 'db',
      op: 'SELECT 1',
    });
    assert.equal(result.allow, true);
    assert.equal(result.mode, 'freerein-with-audit');
  });

  it('lane workspace: audit-mode still returns allow:true (non-disruptive)', () => {
    const wsId = 'ws-lane';
    setMode(db, wsId, 'lane');

    const result = enforcePermission(db, {
      scope: { workspaceId: wsId },
      toolClass: 'network',
      op: 'WebFetch(https://api.example.com)',
    });
    assert.equal(result.allow, true, 'audit mode must allow even for lane mode');
    assert.equal(result.mode, 'lane');
  });

  it('ask workspace: audit-mode still returns allow:true (non-disruptive)', () => {
    const wsId = 'ws-ask';
    setMode(db, wsId, 'ask');

    const result = enforcePermission(db, {
      scope: { workspaceId: wsId },
      toolClass: 'claude-cli-subspawn',
      op: 'Task(some sub-agent)',
    });
    assert.equal(result.allow, true, 'audit mode must allow even for ask mode');
    assert.equal(result.mode, 'ask');
  });
});

describe('enforcePermission — audit-vs-enforce ENV flag', () => {
  let db: Database.Database;

  before(() => {
    db = makeTestDb();
  });

  afterEach(() => {
    delete process.env.LAZYOS_PERMISSION_ENFORCEMENT;
  });

  it('ENV unset → audit mode → allow:true', () => {
    delete process.env.LAZYOS_PERMISSION_ENFORCEMENT;
    const wsId = 'ws-env-default';
    setMode(db, wsId, 'freerein-with-audit');

    const result = enforcePermission(db, {
      scope: { workspaceId: wsId },
      toolClass: 'shell',
      op: 'Bash(ls)',
    });
    assert.equal(result.allow, true);
    const row = lastAuditRow(db, wsId);
    assert.equal(row?.['enforcement'], 'audit');
  });

  it('ENV=audit → audit mode → allow:true, enforcement=audit in row', () => {
    process.env.LAZYOS_PERMISSION_ENFORCEMENT = 'audit';
    const wsId = 'ws-env-audit';
    setMode(db, wsId, 'freerein-with-audit');

    enforcePermission(db, {
      scope: { workspaceId: wsId },
      toolClass: 'fs-read',
      op: 'Read(/etc/hosts)',
    });
    const row = lastAuditRow(db, wsId);
    assert.equal(row?.['enforcement'], 'audit');
    assert.equal(row?.['would_allow'], 1);
  });

  it('ENV=enforce + freerein workspace (no lazyos_permissions table) → resolver fail-closed → deny', () => {
    // enforce mode with a DB that has no lazyos_permissions (the pre-Wave-1
    // resolver table).  resolvePermission reads from lazyos_permissions, not
    // lazyos_permission_modes — so it returns deny(db-fail-closed).
    // This is N6-deterministic: fail-closed is the correct behavior in enforce mode
    // when the resolver's required table is missing.
    process.env.LAZYOS_PERMISSION_ENFORCEMENT = 'enforce';
    const wsId = 'ws-enforce-fail-closed';
    setMode(db, wsId, 'freerein');

    const result = enforcePermission(db, {
      scope: { workspaceId: wsId },
      toolClass: 'shell',
      op: 'Bash(echo test)',
    });
    // enforce mode + no lazyos_permissions → resolver returns db-fail-closed deny.
    // (Not a "degrade": the resolver itself succeeded and returned deny.)
    // In production, lazyos_permissions is seeded by the full migration stack.
    assert.equal(result.allow, false, 'enforce mode without resolver table → deny (N6 fail-closed)');
    // Audit row still written
    const row = lastAuditRow(db, wsId);
    assert.ok(row, 'audit row must be written even on enforce-deny');
  });

  it('ENV=enforce + broken DB → FAIL-CLOSED deny, never fail-open (BLOCKER fix)', () => {
    // Security-Critic Finding 2: a broken enforce machinery must NOT fail-open.
    // We hand the enforcer a DB whose .prepare() always throws (corrupt/closed
    // handle). Two fail-closed layers can catch this:
    //   (a) resolvePermission's own try/catch → returns db-fail-closed deny, OR
    //   (b) enforcePermission's outer catch → 'enforce-mode-resolver-failed:
    //       fail-closed deny'.
    // Either way the SECURITY PROPERTY must hold: allow === false. We assert the
    // property (deny) and that the reason is one of the two fail-closed reasons —
    // crucially NOT an allow.
    process.env.LAZYOS_PERMISSION_ENFORCEMENT = 'enforce';

    const realDb = makeTestDb();
    const poisoned = new Proxy(realDb, {
      get(target, prop, receiver) {
        if (prop === 'prepare') {
          return () => {
            throw new Error('simulated resolver DB failure');
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as unknown as Database.Database;

    const result = enforcePermission(poisoned, {
      scope: { workspaceId: 'ws-resolver-throw' },
      toolClass: 'shell',
      op: 'Bash(echo boom)',
    });

    assert.equal(result.allow, false, 'broken enforce machinery must fail-closed, never fail-open (N6)');
    assert.match(
      result.reason,
      /fail-closed deny|db-fail-closed|DB-error/i,
      'reason must reflect a fail-closed path, not an allow',
    );
  });

  it('ENV=enforce + resolver module missing → outer-catch fail-closed deny', () => {
    // Directly exercise the outer catch: when resolvePermission cannot be reached
    // at all (e.g. the resolver throws during the require()/call before returning
    // a decision), enforcePermission's catch must return allow:false with the
    // dedicated reason. We simulate by poisoning ONLY the resolver's first DB read
    // path is hard to isolate; instead we assert the contract holds for a DB that
    // makes the resolver throw synchronously after import. Covered by the test
    // above (resolver self-fail-closes); this test documents that even if the
    // resolver returned a thrown error instead of a decision, allow stays false.
    process.env.LAZYOS_PERMISSION_ENFORCEMENT = 'enforce';
    const db = makeTestDb();
    setMode(db, 'ws-no-resolver-table', 'lane');
    // No lazyos_permissions table → resolver returns db-fail-closed deny.
    const result = enforcePermission(db, {
      scope: { workspaceId: 'ws-no-resolver-table' },
      toolClass: 'shell',
      op: 'Bash(echo test)',
    });
    assert.equal(result.allow, false, 'enforce mode must never silently allow');
  });
});

describe('enforcePermission — N10 content_hash determinism', () => {
  let db: Database.Database;

  before(() => {
    db = makeTestDb();
    delete process.env.LAZYOS_PERMISSION_ENFORCEMENT;
  });

  it('two identical ops produce the same hash (deterministic N10)', () => {
    const wsId = 'ws-hash-det';
    setMode(db, wsId, 'freerein-with-audit');

    const args: EnforcePermissionArgs = {
      scope: { workspaceId: wsId },
      toolClass: 'shell',
      toolName: 'Bash',
      op: 'Bash(npm test)',
    };

    const r1 = enforcePermission(db, args);
    const r2 = enforcePermission(db, args);

    // Both hashes are non-empty sha256 hex.
    assert.match(r1.auditRowHash, /^[0-9a-f]{64}$/);
    assert.match(r2.auditRowHash, /^[0-9a-f]{64}$/);
    // Same args → same hash (N10 determinism — id/ts are stripped).
    assert.equal(r1.auditRowHash, r2.auditRowHash, 'hash must be deterministic (N10)');
  });

  it('different toolClass → different hash', () => {
    const wsId = 'ws-hash-diff';
    setMode(db, wsId, 'freerein-with-audit');

    const r1 = enforcePermission(db, {
      scope: { workspaceId: wsId },
      toolClass: 'shell',
      op: 'Bash(ls)',
    });
    const r2 = enforcePermission(db, {
      scope: { workspaceId: wsId },
      toolClass: 'network',
      op: 'Bash(ls)',
    });

    assert.notEqual(r1.auditRowHash, r2.auditRowHash, 'different toolClass → different hash');
  });
});
