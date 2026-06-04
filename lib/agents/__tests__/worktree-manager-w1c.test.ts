// W1c — Self-Learning P0 (2026-05-28). recoverOrphanedWorktreesAll iteriert
// über alle primary FS-Roots in workspace_fs_roots und ruft pro Pfad das
// bestehende recoverOrphanedWorktrees() fail-soft.
//
// Vertrag:
//   - leerer FS-Roots-Bestand ⇒ scanned=0, errors=[]
//   - DB-Lese-Fehler (workspace_fs_roots fehlt) ⇒ Helper kippt NICHT,
//     liefert scanned=0 zurück.
//   - apply=false ⇒ dryRun=true im Result; discarded=0
//   - apply=true ⇒ dryRun=false; discardRunWorktree wird gerufen (smoke).
//
// Wir testen NICHT die Git-Discard-Mechanik (die hat ihren eigenen Test in
// scripts/test-worktree-manager.ts T1..T7). Hier nur den Boot-Wrapper.
//
// Runner: NODE_OPTIONS="--experimental-require-module" node_modules/.bin/vitest run

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, beforeAll } from 'vitest';

if (!process.env.LAZYOS_DB_PATH) {
  process.env.LAZYOS_DB_PATH = join(
    mkdtempSync(join(tmpdir(), 'lazyos-w1c-')),
    'w1c-test.db',
  );
}
process.env.LAZYOS_TEST_DISABLE_FK = '1';

import { recoverOrphanedWorktreesAll } from '../worktree-manager';
import { getDb } from '@/db/client';

beforeAll(() => {
  getDb();
});

describe('recoverOrphanedWorktreesAll — W1c Boot-Sweep', () => {
  it('leerer workspace_fs_roots-Bestand ⇒ scanned=0 (kein Fehler)', async () => {
    // Tabelle existiert (Migration 0124 oder ähnlich), aber leer.
    const raw = getDb().$raw;
    // Sicherheits-Cleanup: falls vorherige Tests Rows angelegt haben, leeren.
    try {
      raw.prepare('DELETE FROM workspace_fs_roots').run();
    } catch {
      // Tabelle existiert evtl. nicht (Test-DB ohne FS-Migration) — der
      // Helper-Catch fängt das, scanned bleibt 0.
    }
    const result = await recoverOrphanedWorktreesAll();
    expect(result.scanned).toBe(0);
    expect(result.discarded).toBe(0);
    expect(result.errors).toEqual([]);
  });

  it('apply:false default ⇒ dryRun=true im Result-Objekt', async () => {
    const result = await recoverOrphanedWorktreesAll({ apply: false });
    expect(result.dryRun).toBe(true);
    expect(result.discarded).toBe(0);
  });

  it('apply:true ⇒ dryRun=false im Result-Objekt', async () => {
    const result = await recoverOrphanedWorktreesAll({ apply: true });
    expect(result.dryRun).toBe(false);
  });

  it('non-existent abs_path ⇒ in errors[] aufgenommen, kein throw', async () => {
    const raw = getDb().$raw;
    // Versuche einen primary-FS-Root auf nicht-existentem Pfad einzutragen.
    // Falls die Tabelle nicht da ist, überspringen wir — wir testen die
    // happy-Pfad-Robustheit gegen DB-Probleme im vorherigen Test.
    try {
      raw
        .prepare(
          `INSERT INTO workspace_fs_roots
             (id, workspace_id, abs_path, role, access, is_git, github_repo_id,
              created_at, updated_at)
           VALUES (?, ?, ?, 'primary', 'rw', 1, NULL, ?, ?)`,
        )
        .run(
          'fsroot-w1c-test-1',
          'ws-w1c-bad',
          '/this/path/does/not/exist/anywhere',
          Date.now(),
          Date.now(),
        );
    } catch {
      // Tabelle nicht da ⇒ Test skippen (helper liefert scanned=0).
      const result = await recoverOrphanedWorktreesAll({ apply: true });
      expect(result.scanned).toBe(0);
      return;
    }

    const result = await recoverOrphanedWorktreesAll({ apply: true });
    expect(result.scanned).toBe(1);
    // Pfad existiert nicht → INVALID_REPO_PATH in errors[].
    expect(result.errors.length).toBe(1);
    expect(result.errors[0].workspaceId).toBe('ws-w1c-bad');
    expect(result.errors[0].error).toMatch(/INVALID_REPO_PATH|does not exist/);
  });
});
