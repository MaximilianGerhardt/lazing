// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Maximilian Gerhardt
//
// lib/agents/__tests__/worktree-accumulation.test.ts
// --------------------------------------------------------------------------
// AKKUMULATION (2026-05-29) — Echte-Git-Tests für das Run-Branch + Step-Worktree
// + serieller-Merge-Modell (Owner-Kern-Feature: zusammengesetzte Website).
//
// Diese Tests laufen gegen ECHTE throwaway-git-Repos in /tmp (NIE echte
// Workspaces). Keine DB-Abhängigkeit — die Akkumulations-Funktionen sind rein
// git/fs.
//
// Deckt die geforderten Szenarien ab:
//   (A) Step2→Step3 sieht Step2-Dateien (KOMPOSITION) — der Kern des Features.
//   (B) 2 parallele DISJUNKTE Steps → beide landen im Run-Branch.
//   (C) 2 parallele Steps auf GLEICHER Datei → Konflikt ({merged:false}).
//   (D) discardStepWorktree → Step-Branch weg, Run-Branch BLEIBT.
//
// Runner: NODE_OPTIONS="--experimental-require-module" node_modules/.bin/vitest run

import { execFile as _execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createOrReuseRunWorktree,
  createStepWorktree,
  mergeStepIntoRun,
  discardStepWorktree,
  listAllLazingWorktrees,
} from '../worktree-manager';

const execFile = promisify(_execFile);

// ── Temp-Repo-Helfer ────────────────────────────────────────────────────────

let repoPath: string;
let tmpRoot: string;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFile('git', ['-C', cwd, ...args]);
  return stdout;
}

beforeEach(async () => {
  // Repo liegt UNTER tmpRoot, damit der .lazing-worktrees-Sibling auch in /tmp ist.
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lazing-accum-'));
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
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

// Simuliert die Arbeit eines Steps + den Merge-Pfad des plan-executors:
// schreibt Dateien im Step-Worktree, committet sie auf den Step-Branch,
// merged in den Run-Branch. Gibt das Merge-Ergebnis zurück.
async function runStepAndMerge(args: {
  workspaceId: string;
  stepId: string;
  runBranch: string;
  files: Record<string, string>;
}): Promise<{ merged: boolean; conflict?: string; worktreePath: string; stepBranch: string }> {
  const { worktreePath, stepBranch } = await createStepWorktree({
    repoPath,
    workspaceId: args.workspaceId,
    stepId: args.stepId,
    baseBranch: args.runBranch,
  });
  for (const [rel, content] of Object.entries(args.files)) {
    const abs = path.join(worktreePath, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  await execFile('git', ['-C', worktreePath, 'add', '-A']);
  await execFile('git', [
    '-C', worktreePath, '-c', 'user.name=lazing', '-c', 'user.email=lazing@local',
    'commit', '-m', `step ${args.stepId}`,
  ]);
  const merge = await mergeStepIntoRun({ repoPath, runBranch: args.runBranch, stepBranch });
  return { ...merge, worktreePath, stepBranch };
}

// Liest den Datei-Inhalt am Tip eines Branches (ohne Checkout) via git show.
async function fileAtBranch(branch: string, file: string): Promise<string | null> {
  try {
    const { stdout } = await execFile('git', ['-C', repoPath, 'show', `${branch}:${file}`]);
    return stdout;
  } catch {
    return null;
  }
}

describe('AKKUMULATION — Run-Branch + Step-Worktree + serieller Merge', () => {
  it('createOrReuseRunWorktree legt lazing/run/<runId>-Branch an (idempotent, kein Worktree)', async () => {
    const { runBranch } = await createOrReuseRunWorktree({
      repoPath, workspaceId: 'ws1', runId: 'run-A',
    });
    expect(runBranch).toBe('lazing/run/run-A');
    // Branch existiert.
    const branches = await git(repoPath, 'branch', '--list', 'lazing/run/run-A');
    expect(branches).toContain('lazing/run/run-A');
    // KEIN Worktree (checkout-frei → kein N11-Cap-Verbrauch).
    const wts = await listAllLazingWorktrees(repoPath);
    expect(wts.find((w) => w.branch === 'lazing/run/run-A')).toBeUndefined();

    // Idempotent: zweiter Aufruf wirft nicht, liefert denselben Branch.
    const again = await createOrReuseRunWorktree({ repoPath, workspaceId: 'ws1', runId: 'run-A' });
    expect(again.runBranch).toBe('lazing/run/run-A');
  });

  // ── (A) KOMPOSITION: Step3 sieht Step2-Arbeit ─────────────────────────────
  it('(A) Step2→Step3 sieht die Dateien von Step2 (Komposition)', async () => {
    const { runBranch } = await createOrReuseRunWorktree({
      repoPath, workspaceId: 'ws1', runId: 'run-compose',
    });

    // Step 2 schreibt index.html, merged.
    const s2 = await runStepAndMerge({
      workspaceId: 'ws1', stepId: 'STEP-2', runBranch,
      files: { 'index.html': '<h1>Home</h1>\n' },
    });
    expect(s2.merged).toBe(true);
    await discardStepWorktree({ repoPath, stepBranch: s2.stepBranch });

    // Step 3 branched JETZT vom Run-Tip → MUSS index.html aus Step2 sehen.
    const { worktreePath: wt3, stepBranch: sb3 } = await createStepWorktree({
      repoPath, workspaceId: 'ws1', stepId: 'STEP-3', baseBranch: runBranch,
    });
    // BEWEIS der Komposition: Step2-Datei ist im Step3-Worktree vorhanden.
    expect(fs.existsSync(path.join(wt3, 'index.html'))).toBe(true);
    expect(fs.readFileSync(path.join(wt3, 'index.html'), 'utf8')).toContain('<h1>Home</h1>');

    // Step 3 fügt about.html hinzu, merged.
    fs.writeFileSync(path.join(wt3, 'about.html'), '<h1>About</h1>\n');
    await execFile('git', ['-C', wt3, 'add', '-A']);
    await execFile('git', [
      '-C', wt3, '-c', 'user.name=lazing', '-c', 'user.email=lazing@local',
      'commit', '-m', 'step 3',
    ]);
    const m3 = await mergeStepIntoRun({ repoPath, runBranch, stepBranch: sb3 });
    expect(m3.merged).toBe(true);

    // Run-Branch enthält JETZT BEIDE Dateien (zusammengesetzte Website).
    expect(await fileAtBranch(runBranch, 'index.html')).toContain('<h1>Home</h1>');
    expect(await fileAtBranch(runBranch, 'about.html')).toContain('<h1>About</h1>');
  });

  // ── (B) Zwei DISJUNKTE Steps → beide im Run-Branch ────────────────────────
  it('(B) 2 disjunkte Steps (verschiedene Dateien) → beide landen im Run-Branch', async () => {
    const { runBranch } = await createOrReuseRunWorktree({
      repoPath, workspaceId: 'ws1', runId: 'run-disjoint',
    });

    // Beide Step-Worktrees gleichzeitig vom selben Run-Tip branchen
    // (Parallel-Simulation), DANN seriell mergen (wie der Per-runId-Mutex).
    const a = await createStepWorktree({
      repoPath, workspaceId: 'ws1', stepId: 'STEP-A', baseBranch: runBranch,
    });
    const b = await createStepWorktree({
      repoPath, workspaceId: 'ws1', stepId: 'STEP-B', baseBranch: runBranch,
    });
    fs.writeFileSync(path.join(a.worktreePath, 'hero.css'), '.hero{}\n');
    fs.writeFileSync(path.join(b.worktreePath, 'footer.css'), '.footer{}\n');
    for (const wt of [a.worktreePath, b.worktreePath]) {
      await execFile('git', ['-C', wt, 'add', '-A']);
      await execFile('git', [
        '-C', wt, '-c', 'user.name=lazing', '-c', 'user.email=lazing@local',
        'commit', '-m', 'step',
      ]);
    }
    // Serieller Merge (Mutex-Reihenfolge).
    const mA = await mergeStepIntoRun({ repoPath, runBranch, stepBranch: a.stepBranch });
    const mB = await mergeStepIntoRun({ repoPath, runBranch, stepBranch: b.stepBranch });
    expect(mA.merged).toBe(true);
    expect(mB.merged).toBe(true);

    // Beide disjunkten Dateien im Run-Branch.
    expect(await fileAtBranch(runBranch, 'hero.css')).toContain('.hero{}');
    expect(await fileAtBranch(runBranch, 'footer.css')).toContain('.footer{}');
  });

  // ── (C) Zwei Steps auf GLEICHER Datei → Konflikt ──────────────────────────
  it('(C) 2 parallele Steps auf derselben Datei → zweiter Merge ist Konflikt', async () => {
    const { runBranch } = await createOrReuseRunWorktree({
      repoPath, workspaceId: 'ws1', runId: 'run-conflict',
    });

    const a = await createStepWorktree({
      repoPath, workspaceId: 'ws1', stepId: 'STEP-X', baseBranch: runBranch,
    });
    const b = await createStepWorktree({
      repoPath, workspaceId: 'ws1', stepId: 'STEP-Y', baseBranch: runBranch,
    });
    // Beide ändern dieselbe Datei mit unterschiedlichem Inhalt.
    fs.writeFileSync(path.join(a.worktreePath, 'config.json'), '{"v":1}\n');
    fs.writeFileSync(path.join(b.worktreePath, 'config.json'), '{"v":2}\n');
    for (const wt of [a.worktreePath, b.worktreePath]) {
      await execFile('git', ['-C', wt, 'add', '-A']);
      await execFile('git', [
        '-C', wt, '-c', 'user.name=lazing', '-c', 'user.email=lazing@local',
        'commit', '-m', 'step',
      ]);
    }
    const mA = await mergeStepIntoRun({ repoPath, runBranch, stepBranch: a.stepBranch });
    const mB = await mergeStepIntoRun({ repoPath, runBranch, stepBranch: b.stepBranch });

    // Erster Merge ok, zweiter kollidiert.
    expect(mA.merged).toBe(true);
    expect(mB.merged).toBe(false);
    expect(mB.conflict).toBeTruthy();
    expect(mB.conflict).toContain('config.json');

    // Run-Branch behält den ERSTEN Step (kein halber Merge nach dem Abort).
    expect(await fileAtBranch(runBranch, 'config.json')).toContain('{"v":1}');
  });

  // ── (D) discardStepWorktree → Step-Branch weg, Run-Branch BLEIBT ──────────
  it('(D) discardStepWorktree entfernt Step-Branch+Worktree, Run-Branch bleibt erhalten', async () => {
    const { runBranch } = await createOrReuseRunWorktree({
      repoPath, workspaceId: 'ws1', runId: 'run-keep',
    });
    const s = await runStepAndMerge({
      workspaceId: 'ws1', stepId: 'STEP-K', runBranch,
      files: { 'page.html': '<p>x</p>\n' },
    });
    expect(s.merged).toBe(true);

    await discardStepWorktree({ repoPath, stepBranch: s.stepBranch, deleteBranch: true });

    // Step-Branch ist weg.
    const stepBranches = await git(repoPath, 'branch', '--list', s.stepBranch);
    expect(stepBranches.trim()).toBe('');
    // Step-Worktree ist weg.
    const wts = await listAllLazingWorktrees(repoPath);
    expect(wts.find((w) => w.branch === s.stepBranch)).toBeUndefined();
    // Run-Branch BLEIBT — mit der akkumulierten Arbeit.
    const runBranches = await git(repoPath, 'branch', '--list', runBranch);
    expect(runBranches).toContain(runBranch);
    expect(await fileAtBranch(runBranch, 'page.html')).toContain('<p>x</p>');
  });

  it('discardStepWorktree weigert sich, einen Run-Branch zu löschen (Schutz)', async () => {
    const { runBranch } = await createOrReuseRunWorktree({
      repoPath, workspaceId: 'ws1', runId: 'run-protect',
    });
    // Versuch, einen lazing/run/*-Branch über discardStepWorktree zu löschen → No-op.
    await discardStepWorktree({ repoPath, stepBranch: runBranch, deleteBranch: true });
    const branches = await git(repoPath, 'branch', '--list', runBranch);
    expect(branches).toContain(runBranch);
  });
});
