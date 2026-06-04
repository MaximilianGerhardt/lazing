/**
 * bash-path-policy.cjs — Tests
 * ============================================================================
 * Run:
 *   NODE_OPTIONS="--experimental-require-module" \
 *     node_modules/.bin/vitest run server/agents/__tests__/bash-path-policy.test.ts
 *
 * Der Hook ist ein eigenständiges node-.cjs-Skript, das via stdin JSON bekommt
 * und über Allowlist (besser-sqlite3) entscheidet. Weil er die DB per Dateipfad
 * öffnet (kein cross-process :memory:), schreiben wir eine TEMP-DB-Datei mit
 * dem realen workspace_fs_roots/workspaces-Schema + Rows und zeigen
 * LAZYOS_DB_PATH darauf. Wir rufen das Skript als child_process auf und prüfen
 * stdout (deny-JSON oder leer) + exit-code.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const HOOK = path.resolve(__dirname, '..', 'bash-path-policy.cjs');
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const HOME = os.homedir();

// Aktiver Workspace + ein FS-Root für ihn. Wir legen den Root unter
// ~/Documents/<tmp> an, damit der Cross-Project-Heuristik-Test (anderer
// Ordner unter ~/Documents) scharf wird, aber der eigene Root NICHT.
const WS_ID = 'ws-active';
const OTHER_WS_ID = 'ws-other';

let tmpDir: string;
let dbPath: string;
let activeRoot: string;
let otherRoot: string;

function setupDb(p: string): void {
  const db = new Database(p);
  db.exec(`
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL DEFAULT '',
      accent TEXT NOT NULL DEFAULT '',
      path TEXT NOT NULL DEFAULT '',
      sensitivity TEXT NOT NULL DEFAULT 'low',
      archived INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE workspace_fs_roots (
      id TEXT PRIMARY KEY NOT NULL,
      workspace_id TEXT NOT NULL,
      abs_path TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'repo',
      access TEXT NOT NULL DEFAULT 'rw',
      is_git INTEGER NOT NULL DEFAULT 1,
      github_repo_id TEXT,
      created_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    );
  `);
  // workspaces.path bewusst leer (wie in der echten DB) → der FS-Root-Pfad ist
  // die Allowlist-Quelle.
  db.prepare('INSERT INTO workspaces (id, path) VALUES (?, ?)').run(WS_ID, '');
  db.prepare('INSERT INTO workspaces (id, path) VALUES (?, ?)').run(OTHER_WS_ID, otherRoot);
  db.prepare(
    'INSERT INTO workspace_fs_roots (id, workspace_id, abs_path) VALUES (?, ?, ?)',
  ).run('r1', WS_ID, activeRoot);
  db.close();
}

function runHook(
  command: string,
  opts: { cwd?: string; dbPath?: string; workspaceId?: string } = {},
): { stdout: string; status: number | null } {
  const input = JSON.stringify({
    tool_name: 'Bash',
    tool_input: { command },
    cwd: opts.cwd ?? activeRoot,
  });
  const res = spawnSync('node', [HOOK], {
    input,
    encoding: 'utf8',
    env: {
      ...process.env,
      LAZYOS_WORKSPACE_ID: opts.workspaceId ?? WS_ID,
      LAZYOS_DB_PATH: opts.dbPath ?? dbPath,
      LAZYOS_REPO_ROOT: REPO_ROOT,
    },
  });
  return { stdout: res.stdout ?? '', status: res.status };
}

function isAllow(out: { stdout: string; status: number | null }): boolean {
  return out.status === 0 && out.stdout.trim() === '';
}

function isDeny(out: { stdout: string; status: number | null }): {
  ok: boolean;
  reason: string;
} {
  if (out.status !== 0 || out.stdout.trim() === '') return { ok: false, reason: '' };
  try {
    const parsed = JSON.parse(out.stdout);
    const hso = parsed.hookSpecificOutput;
    return {
      ok:
        hso &&
        hso.hookEventName === 'PreToolUse' &&
        hso.permissionDecision === 'deny' &&
        typeof hso.permissionDecisionReason === 'string',
      reason: hso?.permissionDecisionReason ?? '',
    };
  } catch {
    return { ok: false, reason: '' };
  }
}

beforeAll(() => {
  // tmp-Root UNTER ~/Documents, damit die Cross-Project-Heuristik realistisch
  // greift (der Hook behandelt ~/Documents als sammel-sensitive Eltern-Zone).
  const docs = path.join(HOME, 'Documents');
  tmpDir = mkdtempSync(path.join(docs, 'bash-policy-test-'));
  activeRoot = path.join(tmpDir, 'active-ws');
  otherRoot = path.join(tmpDir, 'other-ws');
  dbPath = path.join(tmpDir, 'test.db');
  setupDb(dbPath);
});

afterAll(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('bash-path-policy hook', () => {
  it('allows a command that only touches the workspace root (no stdout)', () => {
    const out = runHook(`cat ${activeRoot}/src/index.ts`);
    expect(isAllow(out)).toBe(true);
  });

  it('allows a workspace-relative ./src/x path (resolved against cwd)', () => {
    const out = runHook('cat ./src/x', { cwd: activeRoot });
    expect(isAllow(out)).toBe(true);
  });

  it('allows a no-path command like `echo hello`', () => {
    const out = runHook('echo hello');
    expect(isAllow(out)).toBe(true);
  });

  it('denies cat ~/.lazyos/lazyos.db (secret zone)', () => {
    const out = runHook('cat ~/.lazyos/lazyos.db');
    const d = isDeny(out);
    expect(d.ok).toBe(true);
    expect(d.reason).toContain('POLICY_BLOCK [secret]');
    expect(d.reason).toContain('.lazyos');
  });

  it('allows cat ~/.lazyos/cloud/x (cloud upload root is whitelisted)', () => {
    const out = runHook('cat ~/.lazyos/cloud/x');
    expect(isAllow(out)).toBe(true);
  });

  it('denies cat ~/.ssh/id_rsa (ssh secret zone)', () => {
    const out = runHook('cat ~/.ssh/id_rsa');
    expect(isDeny(out).ok).toBe(true);
  });

  it('denies cat <other-project>/.env (env secret file)', () => {
    const out = runHook(`cat ${otherRoot}/.env`);
    const d = isDeny(out);
    expect(d.ok).toBe(true);
    expect(d.reason).toContain('POLICY_BLOCK [secret]');
    expect(d.reason).toContain('.env');
  });

  it('denies a workspace-local .env even inside the active workspace', () => {
    const out = runHook('cat .env', { cwd: activeRoot });
    expect(isDeny(out).ok).toBe(true);
  });

  it('denies reading another workspace root (cross-workspace)', () => {
    const out = runHook(`cat ${otherRoot}/secrets.txt`);
    const d = isDeny(out);
    expect(d.ok).toBe(true);
    // otherRoot ist als workspaces.path des anderen WS registriert →
    // cross-workspace; ausserdem liegt er unter ~/Documents (cross-project).
    expect(d.reason).toMatch(/cross-workspace|cross-scope/);
  });

  it('fail-open: DB unreadable → allow (does not break the chat)', () => {
    // Nicht-existierende DB + ein Pfad, der NICHT der deterministische
    // Secret-Kern ist (also keine .env/secret-zone) → fail-open allow.
    const out = runHook(`cat ${otherRoot}/file.txt`, {
      dbPath: path.join(tmpDir, 'does-not-exist.db'),
    });
    expect(isAllow(out)).toBe(true);
  });

  it('fail-open with DB error still blocks the deterministic secret core (.env)', () => {
    const out = runHook(`cat ${otherRoot}/.env`, {
      dbPath: path.join(tmpDir, 'does-not-exist.db'),
    });
    expect(isDeny(out).ok).toBe(true);
  });
});
