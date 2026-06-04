// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Maximilian Gerhardt
//
// lib/agents/__tests__/gated-merge.test.ts
// --------------------------------------------------------------------------
// A4 GATED Operator-Merge (2026-05-29, Opus 4.8) — echte-Git-Tests gegen
// throwaway-Repos in /tmp. Beweist: commitGatedMerge bringt den akkumulierten
// Run-Branch in den Live-Checkout (S6), konflikt-sicher (abort → Live sauber),
// findRunBranchForWorkstream + getRunBranchDiffStat (S5).
//
// Runner: NODE_OPTIONS="--experimental-require-module" node_modules/.bin/vitest run

import { execFile as _execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  commitGatedMerge,
  findRunBranchForWorkstream,
  getRunBranchDiffStat,
  listRunBranches,
} from '../worktree-manager';

const execFile = promisify(_execFile);

let repoPath: string;
let tmpRoot: string;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFile('git', ['-C', cwd, ...args]);
  return stdout;
}

// Legt einen akkumulierenden Run-Branch mit Dateien an (simuliert das Ergebnis
// des plan-executor-Accumulation-Pfads), ohne den Live-Checkout (main) zu berühren.
async function makeRunBranch(branch: string, files: Record<string, string>): Promise<void> {
  const head = (await git(repoPath, 'rev-parse', 'HEAD')).trim();
  await git(repoPath, 'branch', branch, head);
  // Auf einem temporären Worktree committen, damit main-Checkout unberührt bleibt.
  const wt = path.join(tmpRoot, `_mk-${branch.replace(/[^a-z0-9]/gi, '-')}`);
  await git(repoPath, 'worktree', 'add', '-q', wt, branch);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(wt, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  await git(wt, 'add', '-A');
  await git(wt, 'commit', '-q', '-m', `run work ${branch}`);
  await git(repoPath, 'worktree', 'remove', '--force', wt);
}

beforeEach(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lazing-gated-'));
  repoPath = path.join(tmpRoot, 'repo');
  fs.mkdirSync(repoPath, { recursive: true });
  await git(repoPath, 'init', '-q', '-b', 'main');
  await git(repoPath, 'config', 'user.name', 'test');
  await git(repoPath, 'config', 'user.email', 'test@local');
  fs.writeFileSync(path.join(repoPath, 'README.md'), '# base\n');
  await git(repoPath, 'add', '-A');
  await git(repoPath, 'commit', '-q', '-m', 'base');
});

afterEach(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('A4 commitGatedMerge', () => {
  it('merged den Run-Branch in den Live-Checkout (S6)', async () => {
    const branch = 'lazing/run/prun-PLAN-x-WS-abc';
    await makeRunBranch(branch, { 'index.html': '<h1>Home</h1>\n', 'styles.css': 'body{}\n' });

    const res = await commitGatedMerge({ repoPath, runBranch: branch });
    expect(res.merged).toBe(true);
    expect(res.sha).toBeTruthy();
    // Live-Checkout hat die Dateien jetzt.
    expect(fs.existsSync(path.join(repoPath, 'index.html'))).toBe(true);
    expect(fs.existsSync(path.join(repoPath, 'styles.css'))).toBe(true);
  });

  it('Konflikt → merged:false + Live-Checkout bleibt sauber (abort)', async () => {
    // main ändert index.html …
    fs.writeFileSync(path.join(repoPath, 'index.html'), 'MAIN VERSION\n');
    await git(repoPath, 'add', '-A');
    await git(repoPath, 'commit', '-q', '-m', 'main edits index');
    const mainHead = (await git(repoPath, 'rev-parse', 'HEAD')).trim();
    // … Run-Branch (von älterem base) ändert dieselbe Datei anders.
    const branch = 'lazing/run/prun-PLAN-y-WS-conf';
    await git(repoPath, 'branch', branch, 'HEAD~1');
    const wt = path.join(tmpRoot, '_conf');
    await git(repoPath, 'worktree', 'add', '-q', wt, branch);
    fs.writeFileSync(path.join(wt, 'index.html'), 'RUN VERSION\n');
    await git(wt, 'add', '-A');
    await git(wt, 'commit', '-q', '-m', 'run edits index');
    await git(repoPath, 'worktree', 'remove', '--force', wt);

    const res = await commitGatedMerge({ repoPath, runBranch: branch });
    expect(res.merged).toBe(false);
    expect(res.conflict).toBeTruthy();
    // Live-Checkout-HEAD unverändert (Merge wurde abgebrochen).
    expect((await git(repoPath, 'rev-parse', 'HEAD')).trim()).toBe(mainHead);
    // Working-Tree sauber (kein hängender Merge-State).
    expect((await git(repoPath, 'status', '--porcelain')).trim()).toBe('');
  });

  it('weigert sich, einen Nicht-Run-Branch zu mergen', async () => {
    await git(repoPath, 'branch', 'feature/x');
    await expect(commitGatedMerge({ repoPath, runBranch: 'feature/x' })).rejects.toThrow(/non-run-branch/);
  });

  it('findRunBranchForWorkstream findet per workstreamId', async () => {
    await makeRunBranch('lazing/run/prun-PLAN-a-WS-001', { 'a.txt': 'a' });
    await makeRunBranch('lazing/run/prun-PLAN-b-WS-002', { 'b.txt': 'b' });
    expect(await findRunBranchForWorkstream(repoPath, 'WS-002')).toBe('lazing/run/prun-PLAN-b-WS-002');
    expect(await findRunBranchForWorkstream(repoPath, 'WS-999')).toBeNull();
  });

  it('getRunBranchDiffStat liefert Datei-Liste + aheadBy (S5 Preview)', async () => {
    const branch = 'lazing/run/prun-PLAN-c-WS-stat';
    await makeRunBranch(branch, { 'index.html': 'x', 'about.html': 'y' });
    const stat = await getRunBranchDiffStat(repoPath, branch);
    expect(stat.files.sort()).toEqual(['about.html', 'index.html']);
    expect(stat.aheadBy).toBeGreaterThanOrEqual(1);
    expect(stat.stat).toContain('index.html');
  });

  it('listRunBranches listet nur lazing/run/*', async () => {
    await makeRunBranch('lazing/run/prun-PLAN-d-WS-list', { 'x': 'x' });
    await git(repoPath, 'branch', 'feature/not-a-run');
    const branches = await listRunBranches(repoPath);
    expect(branches).toContain('lazing/run/prun-PLAN-d-WS-list');
    expect(branches.some((b) => b.startsWith('feature/'))).toBe(false);
  });
});
