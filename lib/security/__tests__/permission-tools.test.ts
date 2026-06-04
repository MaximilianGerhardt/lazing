/**
 * Tests fuer lib/security/permission-tools.ts (A2, 2026-05-25).
 *
 * Run: `NODE_OPTIONS='--experimental-require-module' npx vitest run lib/security/__tests__/permission-tools.test.ts`
 *
 * Covers:
 *   1. resolveAllowedToolsForMode — alle 4 Modi x relevante Rollen.
 *   2. Unset/null/unknown → plan-only + leere allowedTools (sicherer Default).
 *   3. Bash: nur in freerein/freerein-with-audit; niemals in lane/ask.
 *   4. Write/Edit: nur fuer architect/coder; niemals fuer tester/reviewer/unknown.
 *   5. Ask: immer plan-only, immer [].
 *   6. ReadOnly-Tools (Read, Grep, Glob): immer present bei non-ask+non-null.
 *   7. Modus→Tool-Matrix ist deterministisch (N6).
 *   8. CRITICAL #1 (Security-Critic): readWorkspacePermissionMode hat KEINEN
 *      owner-default-Fallback — unset/kein-Row → null → plan-only (sicher).
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import Database from 'better-sqlite3';

import {
  resolveAllowedToolsForMode,
  readWorkspacePermissionMode,
} from '../permission-tools';

// ---------------------------------------------------------------------------
// Hilfsfunktionen
// ---------------------------------------------------------------------------

function tools(mode: Parameters<typeof resolveAllowedToolsForMode>[0], role: string) {
  return resolveAllowedToolsForMode(mode, role);
}

// ---------------------------------------------------------------------------
// 1. Unset / null / unknown → sicherer Default (identisch zu heutigem Verhalten)
// ---------------------------------------------------------------------------

describe('resolveAllowedToolsForMode — Default (kein Modus gesetzt)', () => {
  it('null → plan-only + leere allowedTools', () => {
    const r = tools(null, 'coder');
    assert.equal(r.executionMode, 'plan-only');
    assert.equal(r.allowedTools.length, 0);
    assert.equal(r.resolvedMode, 'unset');
  });

  it('undefined → plan-only + leere allowedTools', () => {
    const r = tools(undefined, 'architect');
    assert.equal(r.executionMode, 'plan-only');
    assert.equal(r.allowedTools.length, 0);
    assert.equal(r.resolvedMode, 'unset');
  });

  // Unbekannter Modus-String (type-cast) → plan-only (fail-closed)
  it('unbekannter Modus-String (cast) → plan-only (fail-closed)', () => {
    const r = tools('totally-unknown-mode' as never, 'coder');
    assert.equal(r.executionMode, 'plan-only');
    assert.equal(r.allowedTools.length, 0);
    assert.equal(r.resolvedMode, 'unset');
  });
});

// ---------------------------------------------------------------------------
// 2. ask → plan-only fuer alle Rollen
// ---------------------------------------------------------------------------

describe('resolveAllowedToolsForMode — ask', () => {
  for (const role of ['coder', 'architect', 'tester', 'reviewer', 'unknown']) {
    it(`ask + role=${role} → plan-only + []`, () => {
      const r = tools('ask', role);
      assert.equal(r.executionMode, 'plan-only');
      assert.equal(r.allowedTools.length, 0);
      assert.equal(r.resolvedMode, 'ask');
    });
  }
});

// ---------------------------------------------------------------------------
// 3. freerein — alle Tools inkl. Bash fuer write-faehige Rollen
// ---------------------------------------------------------------------------

describe('resolveAllowedToolsForMode — freerein', () => {
  it('freerein + coder → execute-per-step + Read/Grep/Glob/Write/Edit/Bash', () => {
    const r = tools('freerein', 'coder');
    assert.equal(r.executionMode, 'execute-per-step');
    assert.equal(r.resolvedMode, 'freerein');
    assert.ok(r.allowedTools.includes('Read'), 'Read fehlt');
    assert.ok(r.allowedTools.includes('Grep'), 'Grep fehlt');
    assert.ok(r.allowedTools.includes('Glob'), 'Glob fehlt');
    assert.ok(r.allowedTools.includes('Write'), 'Write fehlt');
    assert.ok(r.allowedTools.includes('Edit'), 'Edit fehlt');
    assert.ok(r.allowedTools.includes('Bash'), 'Bash fehlt (freerein sollte Bash erlauben)');
  });

  it('freerein + architect → enthält Bash + Write', () => {
    const r = tools('freerein', 'architect');
    assert.ok(r.allowedTools.includes('Bash'));
    assert.ok(r.allowedTools.includes('Write'));
    assert.equal(r.executionMode, 'execute-per-step');
  });

  it('freerein + tester → Bash vorhanden, KEIN Write/Edit', () => {
    const r = tools('freerein', 'tester');
    assert.ok(r.allowedTools.includes('Bash'), 'freerein + tester sollte Bash haben');
    assert.ok(!r.allowedTools.includes('Write'), 'tester darf kein Write haben');
    assert.ok(!r.allowedTools.includes('Edit'), 'tester darf kein Edit haben');
    assert.equal(r.executionMode, 'execute-per-step');
  });

  it('freerein + reviewer → Bash vorhanden, KEIN Write/Edit', () => {
    const r = tools('freerein', 'reviewer');
    assert.ok(r.allowedTools.includes('Bash'));
    assert.ok(!r.allowedTools.includes('Write'));
    assert.ok(!r.allowedTools.includes('Edit'));
  });

  it('freerein + unknown-role → Bash vorhanden, KEIN Write/Edit', () => {
    const r = tools('freerein', 'completely-unknown');
    assert.ok(r.allowedTools.includes('Bash'));
    assert.ok(!r.allowedTools.includes('Write'));
    assert.ok(!r.allowedTools.includes('Edit'));
  });
});

// ---------------------------------------------------------------------------
// 4. freerein-with-audit — identisch zu freerein fuer Tool-Grants
// ---------------------------------------------------------------------------

describe('resolveAllowedToolsForMode — freerein-with-audit', () => {
  it('freerein-with-audit + coder → identisch zu freerein (inkl. Bash)', () => {
    const r = tools('freerein-with-audit', 'coder');
    assert.equal(r.executionMode, 'execute-per-step');
    assert.equal(r.resolvedMode, 'freerein-with-audit');
    assert.ok(r.allowedTools.includes('Bash'));
    assert.ok(r.allowedTools.includes('Write'));
    assert.ok(r.allowedTools.includes('Edit'));
  });

  it('freerein-with-audit + tester → kein Write, Bash ja', () => {
    const r = tools('freerein-with-audit', 'tester');
    assert.ok(!r.allowedTools.includes('Write'));
    assert.ok(r.allowedTools.includes('Bash'));
    assert.equal(r.executionMode, 'execute-per-step');
  });
});

// ---------------------------------------------------------------------------
// 5. lane — kein Bash, Write nur fuer architect/coder
// ---------------------------------------------------------------------------

describe('resolveAllowedToolsForMode — lane', () => {
  it('lane + coder → execute-per-step + Read/Grep/Glob/Write/Edit, kein Bash', () => {
    const r = tools('lane', 'coder');
    assert.equal(r.executionMode, 'execute-per-step');
    assert.equal(r.resolvedMode, 'lane');
    assert.ok(r.allowedTools.includes('Read'));
    assert.ok(r.allowedTools.includes('Grep'));
    assert.ok(r.allowedTools.includes('Glob'));
    assert.ok(r.allowedTools.includes('Write'));
    assert.ok(r.allowedTools.includes('Edit'));
    assert.ok(!r.allowedTools.includes('Bash'), 'lane darf kein Bash enthalten');
  });

  it('lane + architect → kein Bash, Write ja', () => {
    const r = tools('lane', 'architect');
    assert.ok(!r.allowedTools.includes('Bash'));
    assert.ok(r.allowedTools.includes('Write'));
    assert.equal(r.executionMode, 'execute-per-step');
  });

  it('lane + tester → kein Bash, kein Write/Edit, nur Read/Grep/Glob', () => {
    const r = tools('lane', 'tester');
    assert.ok(!r.allowedTools.includes('Bash'));
    assert.ok(!r.allowedTools.includes('Write'));
    assert.ok(!r.allowedTools.includes('Edit'));
    assert.ok(r.allowedTools.includes('Read'));
    assert.ok(r.allowedTools.includes('Grep'));
    assert.ok(r.allowedTools.includes('Glob'));
    assert.equal(r.executionMode, 'execute-per-step');
  });

  it('lane + reviewer → kein Bash, kein Write, nur readonly', () => {
    const r = tools('lane', 'reviewer');
    assert.ok(!r.allowedTools.includes('Bash'));
    assert.ok(!r.allowedTools.includes('Write'));
    assert.ok(r.allowedTools.includes('Read'));
    assert.equal(r.executionMode, 'execute-per-step');
  });

  it('lane + unknown-role → kein Bash, kein Write, nur readonly', () => {
    const r = tools('lane', 'any-random-role');
    assert.ok(!r.allowedTools.includes('Bash'));
    assert.ok(!r.allowedTools.includes('Write'));
    assert.ok(r.allowedTools.includes('Read'));
  });
});

// ---------------------------------------------------------------------------
// 6. Invarianten: resolvedMode korrekt berichtet
// ---------------------------------------------------------------------------

describe('resolveAllowedToolsForMode — resolvedMode invarianten', () => {
  it('freerein → resolvedMode === freerein', () => {
    assert.equal(tools('freerein', 'coder').resolvedMode, 'freerein');
  });
  it('freerein-with-audit → resolvedMode === freerein-with-audit', () => {
    assert.equal(tools('freerein-with-audit', 'coder').resolvedMode, 'freerein-with-audit');
  });
  it('lane → resolvedMode === lane', () => {
    assert.equal(tools('lane', 'coder').resolvedMode, 'lane');
  });
  it('ask → resolvedMode === ask', () => {
    assert.equal(tools('ask', 'coder').resolvedMode, 'ask');
  });
  it('null → resolvedMode === unset', () => {
    assert.equal(tools(null, 'coder').resolvedMode, 'unset');
  });
});

// ---------------------------------------------------------------------------
// 7. allowedTools ist frozen (keine Mutation erlaubt)
// ---------------------------------------------------------------------------

describe('resolveAllowedToolsForMode — allowedTools immutability', () => {
  it('allowedTools-Array ist frozen (kein push moeglich)', () => {
    const r = tools('lane', 'coder');
    assert.throws(
      () => {
        // Cast to mutable to force the push attempt.
        (r.allowedTools as string[]).push('Bash');
      },
      // TypeError: Cannot add property to frozen array.
    );
  });
});

// ---------------------------------------------------------------------------
// 8. Modus→Tool-Matrix: vollstaendige Tabelle
// ---------------------------------------------------------------------------

describe('Mode→Tool-Matrix (vollstaendig)', () => {
  const matrix: Array<{
    mode: Parameters<typeof resolveAllowedToolsForMode>[0];
    role: string;
    expectBash: boolean;
    expectWrite: boolean;
    execMode: 'plan-only' | 'execute-per-step';
  }> = [
    { mode: null,                  role: 'coder',    expectBash: false, expectWrite: false, execMode: 'plan-only' },
    { mode: null,                  role: 'architect', expectBash: false, expectWrite: false, execMode: 'plan-only' },
    { mode: 'ask',                 role: 'coder',    expectBash: false, expectWrite: false, execMode: 'plan-only' },
    { mode: 'ask',                 role: 'architect', expectBash: false, expectWrite: false, execMode: 'plan-only' },
    { mode: 'lane',                role: 'coder',    expectBash: false, expectWrite: true,  execMode: 'execute-per-step' },
    { mode: 'lane',                role: 'architect', expectBash: false, expectWrite: true,  execMode: 'execute-per-step' },
    { mode: 'lane',                role: 'tester',   expectBash: false, expectWrite: false, execMode: 'execute-per-step' },
    { mode: 'lane',                role: 'reviewer', expectBash: false, expectWrite: false, execMode: 'execute-per-step' },
    { mode: 'freerein',            role: 'coder',    expectBash: true,  expectWrite: true,  execMode: 'execute-per-step' },
    { mode: 'freerein',            role: 'architect', expectBash: true,  expectWrite: true,  execMode: 'execute-per-step' },
    { mode: 'freerein',            role: 'tester',   expectBash: true,  expectWrite: false, execMode: 'execute-per-step' },
    { mode: 'freerein-with-audit', role: 'coder',    expectBash: true,  expectWrite: true,  execMode: 'execute-per-step' },
    { mode: 'freerein-with-audit', role: 'tester',   expectBash: true,  expectWrite: false, execMode: 'execute-per-step' },
  ];

  for (const row of matrix) {
    it(`mode=${row.mode ?? 'null'} role=${row.role} → bash=${row.expectBash} write=${row.expectWrite} exec=${row.execMode}`, () => {
      const r = tools(row.mode, row.role);
      assert.equal(r.executionMode, row.execMode, `executionMode mismatch`);
      assert.equal(r.allowedTools.includes('Bash'), row.expectBash, `Bash inclusion mismatch`);
      assert.equal(r.allowedTools.includes('Write'), row.expectWrite, `Write inclusion mismatch`);
    });
  }
});

// ---------------------------------------------------------------------------
// 9. CRITICAL #1 — readWorkspacePermissionMode: KEIN owner-default-Fallback.
//    Beweist dass der Fail-Open behoben ist: ein Workspace ohne expliziten Row
//    resolved zu null → resolveAllowedToolsForMode(null) → plan-only (sicher).
// ---------------------------------------------------------------------------

/**
 * Erzeugt eine In-Memory-DB mit dem 0098-Schema und (wie in Migration 0098)
 * einem owner-default-Row, der ein tool-gewährenden Modus trägt. Damit testen
 * wir, dass dieser Row NICHT als Fallback für fremde Workspaces gewertet wird.
 */
function makeDbWithOwnerDefault(ownerDefaultMode: string): Database.Database {
  const db = new Database(':memory:');
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
  `);
  db.prepare(
    `INSERT INTO lazyos_permission_modes (workspace_id, mode, set_by, content_hash)
     VALUES ('owner-default', ?, 'system:0098-migration', '')`,
  ).run(ownerDefaultMode);
  return db;
}

describe('readWorkspacePermissionMode — CRITICAL #1 (kein owner-default Fail-Open)', () => {
  it('Workspace OHNE eigenen Row → null (KEIN owner-default-Fallback), trotz freerein-with-audit owner-default', () => {
    // owner-default trägt das alte (gefährliche) freerein-with-audit.
    const db = makeDbWithOwnerDefault('freerein-with-audit');
    try {
      const mode = readWorkspacePermissionMode(db, 'some-fresh-workspace');
      assert.equal(mode, null, 'fremder Workspace darf NICHT auf owner-default zurückfallen');
      // Und der sichere Default zieht durch:
      const r = resolveAllowedToolsForMode(mode, 'coder');
      assert.equal(r.executionMode, 'plan-only', 'unset → plan-only (sicher)');
      assert.equal(r.allowedTools.length, 0, 'unset → keine Tools');
    } finally {
      db.close();
    }
  });

  it('owner-default selbst → null (Sentinel ist nie ein Tool-Grant)', () => {
    const db = makeDbWithOwnerDefault('freerein');
    try {
      assert.equal(readWorkspacePermissionMode(db, 'owner-default'), null);
    } finally {
      db.close();
    }
  });

  it('NUR ein expliziter Workspace-Row gewährt Tools (lane)', () => {
    const db = makeDbWithOwnerDefault('ask');
    try {
      db.prepare(
        `INSERT INTO lazyos_permission_modes (workspace_id, mode, set_by, content_hash)
         VALUES ('ws-explicit', 'lane', 'user:u1', '')`,
      ).run();
      const mode = readWorkspacePermissionMode(db, 'ws-explicit');
      assert.equal(mode, 'lane', 'expliziter Row muss greifen');
      const r = resolveAllowedToolsForMode(mode, 'coder');
      assert.equal(r.executionMode, 'execute-per-step');
      assert.ok(r.allowedTools.includes('Write'), 'lane + coder → Write erlaubt');
      assert.ok(!r.allowedTools.includes('Bash'), 'lane → kein Bash');
    } finally {
      db.close();
    }
  });

  it('expliziter freerein-Row gewährt FreeRein (inkl. Bash)', () => {
    const db = makeDbWithOwnerDefault('ask');
    try {
      db.prepare(
        `INSERT INTO lazyos_permission_modes (workspace_id, mode, set_by, content_hash)
         VALUES ('ws-free', 'freerein', 'user:u1', '')`,
      ).run();
      const mode = readWorkspacePermissionMode(db, 'ws-free');
      assert.equal(mode, 'freerein');
      const r = resolveAllowedToolsForMode(mode, 'coder');
      assert.ok(r.allowedTools.includes('Bash'));
    } finally {
      db.close();
    }
  });

  it('fehlende Tabelle → null (fail-closed, kein throw)', () => {
    const db = new Database(':memory:');
    try {
      // Keine Tabelle angelegt.
      assert.equal(readWorkspacePermissionMode(db, 'any'), null);
    } finally {
      db.close();
    }
  });

  it('ungültiger Modus-Wert im Row → null (fail-closed)', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE lazyos_permission_modes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id TEXT UNIQUE,
        mode TEXT NOT NULL
      );
    `);
    db.prepare(
      `INSERT INTO lazyos_permission_modes (workspace_id, mode) VALUES ('ws-bad', 'garbage-mode')`,
    ).run();
    try {
      assert.equal(readWorkspacePermissionMode(db, 'ws-bad'), null);
    } finally {
      db.close();
    }
  });
});
