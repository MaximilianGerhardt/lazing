// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Maximilian Gerhardt
//
// scripts/test-worktree-manager.ts — Standalone verification for lib/agents/worktree-manager.ts
//
// Run:
//   set -a && source .env.local && set +a && ./node_modules/.bin/tsx scripts/test-worktree-manager.ts
//
// No real workspace required — creates a throwaway git repo in /tmp.
// All assertions print PASS/FAIL; exits with 0 only if all pass.
//
// Test plan (matches task spec §Datei 2):
//   T1  Create a temp git repo with one commit.
//   T2  createRunWorktree → assert worktree dir exists + branch present.
//   T3  listRunWorktrees → assert 1 entry returned.
//   T4  N11 cap: create 4 more (total 5), then a 6th → must throw N11_WORKTREE_CAP.
//   T5  Path-traversal: planRunId='../escape' → must throw.
//   T6  discardRunWorktree for all 5 → listRunWorktrees == 0.
//   T7  recoverOrphanedWorktrees → 0 (nothing left).
//   T8  Cleanup: rm -rf temp repo + .lazing-worktrees.

import { execFile as _execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import {
  createRunWorktree,
  discardRunWorktree,
  listRunWorktrees,
  MAX_RUN_WORKTREES,
  recoverOrphanedWorktrees,
} from '../lib/agents/worktree-manager';

const execFile = promisify(_execFile);

// ── Assertion helpers ──────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function pass(label: string): void {
  console.log(`  PASS  ${label}`);
  passed += 1;
}

function fail(label: string, detail?: string): void {
  console.error(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`);
  failed += 1;
}

function assert(condition: boolean, label: string, detail?: string): void {
  if (condition) {
    pass(label);
  } else {
    fail(label, detail);
  }
}

async function assertThrows(
  fn: () => Promise<unknown>,
  expectedSubstring: string,
  label: string,
): Promise<void> {
  try {
    await fn();
    fail(label, `Expected an error containing "${expectedSubstring}" but no error was thrown.`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes(expectedSubstring)) {
      pass(label);
    } else {
      fail(label, `Error thrown but message did not include "${expectedSubstring}".\n        Got: ${msg}`);
    }
  }
}

// ── Temp-repo helpers ──────────────────────────────────────────────────────

async function createTempRepo(): Promise<string> {
  const repoPath = `/tmp/wt-test-${Date.now()}`;
  fs.mkdirSync(repoPath, { recursive: true });

  // git init
  await execFile('git', ['-C', repoPath, 'init']);

  // Configure a local identity so git commit works without global config.
  await execFile('git', ['-C', repoPath, 'config', 'user.email', 'test@lazing.local']);
  await execFile('git', ['-C', repoPath, 'config', 'user.name', 'Worktree Test']);

  // Create one commit so HEAD exists (worktree add requires a valid HEAD).
  const readmePath = path.join(repoPath, 'README.md');
  fs.writeFileSync(readmePath, '# wt-test\n');
  await execFile('git', ['-C', repoPath, 'add', '.']);
  await execFile('git', ['-C', repoPath, 'commit', '-m', 'init']);

  return repoPath;
}

async function cleanupTempRepo(repoPath: string): Promise<void> {
  const worktreesBase = path.resolve(path.dirname(repoPath), '.lazing-worktrees');

  // Remove .lazing-worktrees first (outside the repo).
  if (fs.existsSync(worktreesBase)) {
    fs.rmSync(worktreesBase, { recursive: true, force: true });
  }

  // Remove the temp repo itself.
  if (fs.existsSync(repoPath)) {
    fs.rmSync(repoPath, { recursive: true, force: true });
  }
}

// ── Main test body ─────────────────────────────────────────────────────────

async function run(): Promise<void> {
  console.log('\n=== worktree-manager test suite ===\n');

  // ── T1: Create temp git repo ─────────────────────────────────────────────
  console.log('T1  Create temp git repo');
  let repoPath = '';
  try {
    repoPath = await createTempRepo();
    pass(`T1  git init + first commit at ${repoPath}`);
  } catch (err: unknown) {
    fail('T1  git init + first commit', String(err));
    console.error('\nCannot continue without a test repo. Aborting.\n');
    process.exit(1);
  }

  const workspaceId = 'ws-test-001';

  try {
    // ── T2: createRunWorktree → worktree dir + branch ────────────────────────
    console.log('\nT2  createRunWorktree — basic create');
    const planRunId1 = 'run-001';
    const result1 = await createRunWorktree({ repoPath, workspaceId, planRunId: planRunId1 });

    assert(
      fs.existsSync(result1.worktreePath),
      `T2a  worktree directory exists at "${result1.worktreePath}"`,
    );
    assert(
      result1.branch === `lazing/run/${planRunId1}`,
      `T2b  branch name is "lazing/run/${planRunId1}"`,
      `got "${result1.branch}"`,
    );

    // Verify the branch exists in the repo.
    let branchExists = false;
    try {
      await execFile('git', ['-C', repoPath, 'rev-parse', '--verify', result1.branch]);
      branchExists = true;
    } catch {
      branchExists = false;
    }
    assert(branchExists, `T2c  branch "${result1.branch}" exists in git`);

    // ── T3: listRunWorktrees → 1 entry ───────────────────────────────────────
    console.log('\nT3  listRunWorktrees — 1 entry expected');
    const list1 = await listRunWorktrees(repoPath);
    assert(
      list1.length === 1,
      `T3a  listRunWorktrees returns 1 entry`,
      `got ${list1.length}`,
    );
    assert(
      list1[0]?.planRunId === planRunId1,
      `T3b  entry planRunId === "${planRunId1}"`,
      `got "${list1[0]?.planRunId}"`,
    );

    // ── T4: N11 cap — create 4 more, then 6th must throw ────────────────────
    console.log(`\nT4  N11 cap (MAX_RUN_WORKTREES=${MAX_RUN_WORKTREES})`);
    const extraIds: string[] = [];
    for (let i = 2; i <= MAX_RUN_WORKTREES; i++) {
      const id = `run-${String(i).padStart(3, '0')}`;
      extraIds.push(id);
      await createRunWorktree({ repoPath, workspaceId, planRunId: id });
    }

    const listAtCap = await listRunWorktrees(repoPath);
    assert(
      listAtCap.length === MAX_RUN_WORKTREES,
      `T4a  ${MAX_RUN_WORKTREES} worktrees registered at cap`,
      `got ${listAtCap.length}`,
    );

    // The 6th attempt MUST throw with N11_WORKTREE_CAP.
    await assertThrows(
      () => createRunWorktree({ repoPath, workspaceId, planRunId: 'run-006' }),
      'N11_WORKTREE_CAP',
      `T4b  6th create throws N11_WORKTREE_CAP`,
    );

    // ── T5: Path-traversal — planRunId='../escape' must throw ────────────────
    console.log('\nT5  Path-traversal guard');
    await assertThrows(
      () => createRunWorktree({ repoPath, workspaceId, planRunId: '../escape' }),
      'UNSAFE_ID',
      `T5a  planRunId="../escape" throws UNSAFE_ID`,
    );

    // Additional traversal variants.
    await assertThrows(
      () => createRunWorktree({ repoPath, workspaceId, planRunId: '../../double-escape' }),
      'UNSAFE_ID',
      `T5b  planRunId="../../double-escape" throws UNSAFE_ID`,
    );

    await assertThrows(
      () => createRunWorktree({ repoPath, workspaceId: '../ws-escape', planRunId: 'run-safe' }),
      'UNSAFE_ID',
      `T5c  workspaceId="../ws-escape" throws UNSAFE_ID`,
    );

    // ── T6: discardRunWorktree all 5 → list == 0 ─────────────────────────────
    console.log('\nT6  discardRunWorktree all 5 → list empty');
    const allIds = [planRunId1, ...extraIds];
    for (const rid of allIds) {
      await discardRunWorktree({ repoPath, planRunId: rid });
    }
    const listAfterDiscard = await listRunWorktrees(repoPath);
    assert(
      listAfterDiscard.length === 0,
      `T6a  listRunWorktrees returns 0 after discarding all ${allIds.length}`,
      `got ${listAfterDiscard.length}`,
    );

    // ── T7: recoverOrphanedWorktrees → 0 ─────────────────────────────────────
    console.log('\nT7  recoverOrphanedWorktrees → 0 (nothing left)');
    const recovered = await recoverOrphanedWorktrees(repoPath);
    assert(
      recovered === 0,
      `T7a  recoverOrphanedWorktrees returns 0`,
      `got ${recovered}`,
    );

  } finally {
    // ── T8: Cleanup ───────────────────────────────────────────────────────────
    console.log('\nT8  Cleanup temp repo + .lazing-worktrees');
    try {
      await cleanupTempRepo(repoPath);
      pass('T8a  temp repo + .lazing-worktrees removed');
    } catch (err: unknown) {
      fail('T8a  cleanup failed', String(err));
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  const total = passed + failed;
  console.log(`\n=== Results: ${passed}/${total} passed ===\n`);

  if (failed > 0) {
    console.error(`${failed} assertion(s) FAILED — see output above.\n`);
    process.exit(1);
  } else {
    console.log('All assertions passed.\n');
    process.exit(0);
  }
}

run().catch((err: unknown) => {
  console.error('[test-worktree-manager] Unhandled error:', err);
  process.exit(1);
});
