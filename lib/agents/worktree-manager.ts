// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Maximilian Gerhardt
//
// lib/agents/worktree-manager — Phase 2 R1 Worktree-Isolation (S3).
//
// PURPOSE (security-critical, load-bearing):
//   Every destructive plan-run gets ONE isolated git worktree, branched
//   from the workspace repo's HEAD.  The live :4200/:4201 working directory
//   is NEVER touched by a subagent.  This file is the ONLY place where
//   worktrees are created or destroyed.
//
// SECURITY DECISIONS — explained inline:
//
//   1.  `execFile` not `exec/shell`: all git invocations go through
//       child_process.execFile so arguments are passed as an array, never
//       interpolated into a shell string.  This eliminates shell-injection
//       regardless of the values in workspaceId / planRunId.
//
//   2.  ID sanitisation (Scope-Pin, T1/T5): workspaceId and planRunId are
//       validated against SAFE_ID_RE before any path construction.  The
//       regex intentionally excludes '/', '..', shell metacharacters, and
//       whitespace — the only chars allowed are alphanumerics plus _ : . -
//       This prevents path-traversal escapes even if the caller is
//       compromised.
//
//   3.  Worktree base OUTSIDE the live repo: the worktrees live at
//       <dirname(repoPath)>/.lazing-worktrees/<workspaceId>/<planRunId>
//       i.e. a sibling of the live checkout, not inside it.  A subagent
//       that somehow escapes its worktree cannot reach the live source.
//
//   4.  Path-escape assertion: after constructing the worktree path we
//       resolve it to an absolute path and assert it is still a descendant
//       of the .lazing-worktrees base.  Node's path.resolve() + startsWith
//       is used (not string comparison) so symlink tricks don't bypass it.
//
//   5.  N11 hard-cap (max 5 simultaneous worktrees, §N11 / POS-3):
//       createRunWorktree counts active lazing/run/* worktrees BEFORE
//       creating a new one.  At ≥ MAX_RUN_WORKTREES the call throws
//       N11_WORKTREE_CAP.  Pattern copied from resource-pool.ts:96-100.
//
//   6.  mergeRunWorktree is a GATED stub (R1): merging is intentionally
//       blocked until Phase 2 R3 + Operator-Merge-Gate are built.  The
//       return type `Promise<never>` makes it impossible for callers to
//       accidentally depend on a return value.
//
// N-CONSTRAINT COMPLIANCE:
//   N1  — no truncation of log/error messages; full paths in errors.
//   N9  — planRunId is the identity anchor; branch name carries it verbatim.
//   N10 — not applicable here (no DB rows); Diff-contentHash is in plan-diff.ts.
//   N11 — MAX_RUN_WORKTREES = 5, enforced before every create.

import { execFile as _execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(_execFile);

// ── Constants ──────────────────────────────────────────────────────────────

/**
 * Hard cap: maximum simultaneous lazing/run/* worktrees.
 * Matches N11 / POS-3 (Worktree-Cap 4/5 — 5 is the outer limit).
 * `resource-pool.ts` is the analogue for heavy-engine slots.
 */
export const MAX_RUN_WORKTREES = 5;

/**
 * Regex for safe IDs (workspaceId, planRunId).
 * Allows alphanumerics and _ : . - only.
 * Explicitly excludes / .. whitespace and shell metacharacters.
 */
const SAFE_ID_RE = /^[A-Za-z0-9_:.\-]{1,64}$/;

/**
 * Branch prefix that marks all run-scoped worktrees.
 * Used as a filter in listRunWorktrees so we never touch
 * unrelated branches/worktrees.
 */
const BRANCH_PREFIX = 'lazing/run/';

/**
 * Branch prefix for per-STEP worktrees in the ACCUMULATION model (2026-05-29).
 *
 * ACCUMULATION (owner core feature: composed website):
 *   The old path branched EVERY step from live HEAD (createRunWorktree per step
 *   via planRunId='pstep-<stepId>') → step N did NOT see step N-1 → no
 *   composition. The new path separates RUN from STEP:
 *
 *     - lazing/run/<runId>   = accumulating run branch (ONE per plan run),
 *                              NO worktree, NO checkout → NO cap consumption.
 *                              Successful steps are merged here.
 *     - lazing/step/<stepId> = throwaway step worktree, branched from the RUN tip
 *                              (not from live HEAD) → sees all previously
 *                              merged steps. Consumes the N11 cap (≤5).
 *
 *   So step N builds on the merged work of steps <N → the website
 *   composes itself step by step. The live checkout (main) is NEVER
 *   touched — merge into main stays GATED (mergeRunWorktree, R4/operator gate).
 */
const STEP_BRANCH_PREFIX = 'lazing/step/';

// ── Internal helpers ───────────────────────────────────────────────────────

/**
 * Validate that `id` is safe to embed in a file-system path.
 * Throws a descriptive error on violation — the caller must not proceed.
 * Security: prevents path-traversal (T1/T5) via the ID inputs.
 */
function assertSafeId(id: string, label: string): void {
  if (!SAFE_ID_RE.test(id)) {
    throw new Error(
      `UNSAFE_ID: ${label} "${id}" contains forbidden characters. ` +
        `Only [A-Za-z0-9_:.-] up to 64 chars are allowed. ` +
        `This check exists to prevent path-traversal attacks (T1/T5).`,
    );
  }
}

/**
 * Assert that `repoPath` exists on disk and is inside a git work-tree.
 * Uses `git -C <path> rev-parse --is-inside-work-tree` as the canonical check.
 * Security: prevents callers from pointing us at arbitrary directories (T5).
 */
async function assertIsGitRepo(repoPath: string): Promise<void> {
  if (!fs.existsSync(repoPath)) {
    throw new Error(
      `INVALID_REPO_PATH: "${repoPath}" does not exist on disk. ` +
        `The repoPath must be an existing git repository.`,
    );
  }

  try {
    const { stdout } = await execFile('git', [
      '-C',
      repoPath,
      'rev-parse',
      '--is-inside-work-tree',
    ]);
    if (stdout.trim() !== 'true') {
      throw new Error('unexpected output');
    }
  } catch (_err) {
    throw new Error(
      `INVALID_REPO_PATH: "${repoPath}" is not inside a git work-tree. ` +
        `git rev-parse --is-inside-work-tree returned a non-true value or failed.`,
    );
  }
}

/**
 * Derive the absolute worktree base directory for a given repo.
 * Worktrees live OUTSIDE the repo: <dirname(repoPath)>/.lazing-worktrees/
 * This is intentional — a subagent that escapes its worktree cannot
 * reach the live source tree (T1).
 */
function worktreesBase(repoPath: string): string {
  return path.resolve(path.dirname(repoPath), '.lazing-worktrees');
}

/**
 * Build the absolute path for a single run worktree.
 * After resolution we assert the path is still under worktreesBase (no escape).
 * Security: path.resolve() collapses any '..' components; the startsWith
 * assertion catches any remaining tricks.
 */
function buildWorktreePath(
  repoPath: string,
  workspaceId: string,
  planRunId: string,
): string {
  const base = worktreesBase(repoPath);
  const candidate = path.resolve(base, workspaceId, planRunId);

  // Security assertion: the resolved path MUST be under .lazing-worktrees.
  // This catches cases where workspaceId / planRunId contained '..' after
  // Unicode normalisation or other edge cases that SAFE_ID_RE might miss.
  // The trailing path.sep ensures "base" cannot be a prefix of a sibling dir.
  const baseWithSep = base.endsWith(path.sep) ? base : base + path.sep;
  if (!candidate.startsWith(baseWithSep)) {
    throw new Error(
      `PATH_ESCAPE: resolved worktree path "${candidate}" is not under ` +
        `the expected base "${base}". Possible path-traversal attempt.`,
    );
  }

  return candidate;
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Create an isolated git worktree for a single plan-run.
 *
 * The worktree is at:
 *   <dirname(repoPath)>/.lazing-worktrees/<workspaceId>/<planRunId>
 *
 * A new branch `lazing/run/<planRunId>` is created inside the repo,
 * pointing at the current HEAD of `repoPath`.
 *
 * Security invariants (enforced before any git call):
 *   - workspaceId + planRunId are validated against SAFE_ID_RE.
 *   - repoPath is verified to be an existing git repo.
 *   - N11 worktree cap (≥ MAX_RUN_WORKTREES → throw, never silently drop).
 *   - Resolved worktree path is asserted to be under .lazing-worktrees/.
 *
 * Idempotency: if the worktree directory already exists (e.g. crashed
 * mid-creation), we throw clearly — the caller should discard + retry.
 *
 * @returns { worktreePath, branch } — the absolute FS path and git branch name.
 */
export async function createRunWorktree(args: {
  repoPath: string;
  workspaceId: string;
  planRunId: string;
}): Promise<{ worktreePath: string; branch: string }> {
  const { repoPath, workspaceId, planRunId } = args;

  // 1. Validate IDs before any path construction (security: T1/T5).
  assertSafeId(workspaceId, 'workspaceId');
  assertSafeId(planRunId, 'planRunId');

  // 2. Verify repoPath is a real git repo (not arbitrary directory).
  await assertIsGitRepo(repoPath);

  // 3. N11 hard-cap check — count active run worktrees BEFORE creating.
  //    Pattern mirrors resource-pool.ts:96-100 (canFit → throw, not drop).
  const existing = await listRunWorktrees(repoPath);
  if (existing.length >= MAX_RUN_WORKTREES) {
    throw new Error(
      `N11_WORKTREE_CAP: cannot create worktree for planRunId "${planRunId}" — ` +
        `${existing.length} run worktrees already exist (cap=${MAX_RUN_WORKTREES}). ` +
        `Discard a finished run before starting a new one. ` +
        `Active runs: ${existing.map((w) => w.planRunId).join(', ')}`,
    );
  }

  // 4. Build and security-assert the worktree path.
  const worktreePath = buildWorktreePath(repoPath, workspaceId, planRunId);
  const branch = `${BRANCH_PREFIX}${planRunId}`;

  // 5. Create parent directory if it doesn't exist yet.
  //    We create <base>/<workspaceId>/ explicitly so git worktree add
  //    doesn't fail on missing intermediate dirs.
  const parentDir = path.dirname(worktreePath);
  fs.mkdirSync(parentDir, { recursive: true });

  // 6. Invoke git worktree add.
  //    Using execFile (NOT exec) — arguments are an array, not a shell string.
  //    -b creates the new branch; git refuses if it already exists, which
  //    gives us idempotency-detection "for free".
  try {
    await execFile('git', [
      '-C',
      repoPath,
      'worktree',
      'add',
      worktreePath,
      '-b',
      branch,
    ]);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);

    // If the worktree directory already exists, report clearly (T9 recovery).
    if (msg.includes('already exists') || msg.includes('already checked out')) {
      throw new Error(
        `WORKTREE_EXISTS: worktree at "${worktreePath}" or branch "${branch}" ` +
          `already exists. Run discardRunWorktree first to clean up, ` +
          `then retry. (original error: ${msg})`,
      );
    }

    throw new Error(
      `WORKTREE_CREATE_FAILED: git worktree add failed for planRunId ` +
        `"${planRunId}" at "${worktreePath}". ` +
        `Original error: ${msg}`,
    );
  }

  return { worktreePath, branch };
}

/**
 * Discard (roll back) a run worktree — S7 Rollback.
 *
 * Steps:
 *   1. `git -C repoPath worktree remove --force <wtPath>`
 *   2. `git -C repoPath branch -D lazing/run/<planRunId>`
 *
 * Both steps are best-effort: errors are logged but not re-thrown.
 * Rationale: a partial discard (e.g. worktree gone but branch lingers)
 * is recoverable on next boot via recoverOrphanedWorktrees(), and a
 * throw here would prevent the finally-block in plan-executor from
 * completing cleanup.  The N11 cap will block new creates until the
 * orphan is fully cleaned.
 */
export async function discardRunWorktree(args: {
  repoPath: string;
  planRunId: string;
}): Promise<void> {
  const { repoPath, planRunId } = args;

  // Validate ID even in discard — prevents log-injection via planRunId.
  assertSafeId(planRunId, 'planRunId');
  await assertIsGitRepo(repoPath);

  // We need workspaceId to build the path, but discard is called without it.
  // Instead we find the worktree by scanning the list — this is safe because
  // listRunWorktrees only returns lazing/run/* entries.
  const existing = await listRunWorktrees(repoPath);
  const entry = existing.find((w) => w.planRunId === planRunId);
  const branch = `${BRANCH_PREFIX}${planRunId}`;

  // Step 1: remove the worktree from git's tracking + delete the directory.
  if (entry) {
    try {
      await execFile('git', [
        '-C',
        repoPath,
        'worktree',
        'remove',
        '--force',
        entry.worktreePath,
      ]);
    } catch (err: unknown) {
      // Non-fatal: log and continue to branch cleanup.
      // A missing worktree dir is expected on VPS-reboot recovery (T9).
      console.warn(
        `[worktree-manager] discardRunWorktree: git worktree remove failed ` +
          `for "${entry.worktreePath}" (planRunId="${planRunId}"). ` +
          `Continuing with branch deletion. ` +
          `Error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else {
    console.warn(
      `[worktree-manager] discardRunWorktree: no active worktree found for ` +
        `planRunId="${planRunId}". Branch deletion will still be attempted.`,
    );
  }

  // Step 2: delete the tracking branch (best-effort).
  try {
    await execFile('git', ['-C', repoPath, 'branch', '-D', branch]);
  } catch (err: unknown) {
    // Non-fatal: if the branch was never created (mid-create crash) this is expected.
    console.warn(
      `[worktree-manager] discardRunWorktree: git branch -D "${branch}" failed ` +
        `(planRunId="${planRunId}"). This is expected if creation never completed. ` +
        `Error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * List all currently registered lazing/run/* worktrees for a given repo.
 *
 * Uses `git worktree list --porcelain` and filters to branches matching
 * the BRANCH_PREFIX.  Only worktrees that git knows about are returned —
 * orphaned directories left by a crashed discard are NOT included
 * (recoverOrphanedWorktrees handles those).
 *
 * The main worktree (the live repo itself) is never included because
 * it does not have a `lazing/run/*` branch.
 */
export async function listRunWorktrees(
  repoPath: string,
): Promise<Array<{ worktreePath: string; branch: string; planRunId: string }>> {
  await assertIsGitRepo(repoPath);

  let stdout: string;
  try {
    ({ stdout } = await execFile('git', [
      '-C',
      repoPath,
      'worktree',
      'list',
      '--porcelain',
    ]));
  } catch (err: unknown) {
    throw new Error(
      `LIST_WORKTREES_FAILED: git worktree list failed for "${repoPath}". ` +
        `Error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Porcelain format (one stanza per worktree, blank-line separated):
  //   worktree /absolute/path
  //   HEAD <sha>
  //   branch refs/heads/<branchname>    ← or "detached"
  //   <blank line>
  const results: Array<{
    worktreePath: string;
    branch: string;
    planRunId: string;
  }> = [];

  const stanzas = stdout.split(/\n\n+/);
  for (const stanza of stanzas) {
    if (!stanza.trim()) continue;

    const lines = stanza.trim().split('\n');
    let wtPath: string | undefined;
    let branchRef: string | undefined;

    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        wtPath = line.slice('worktree '.length).trim();
      } else if (line.startsWith('branch ')) {
        branchRef = line.slice('branch '.length).trim();
        // Normalise refs/heads/lazing/run/... → lazing/run/...
        if (branchRef.startsWith('refs/heads/')) {
          branchRef = branchRef.slice('refs/heads/'.length);
        }
      }
    }

    if (!wtPath || !branchRef) continue;
    if (!branchRef.startsWith(BRANCH_PREFIX)) continue;

    const planRunId = branchRef.slice(BRANCH_PREFIX.length);
    if (!planRunId) continue;

    results.push({ worktreePath: wtPath, branch: branchRef, planRunId });
  }

  return results;
}

/**
 * Recover orphaned worktrees after a VPS reboot or crash (T9).
 *
 * ACCUMULATION (2026-05-29): the semantics are now MORE PRECISE.
 *   - lazing/step/* worktrees + branches → CLEAN UP (throwaway, the tmux session
 *     is gone after reboot, the step never finished → discard).
 *   - lazing/run/* branches → KEEP. They carry the accumulated work
 *     of a plan run (composed website) and are checkout-free (no
 *     worktree, no leak). Deleting a run branch would destroy exactly the
 *     feature we are building.
 *   - the ephemeral _merge worktree (on the run branch) → remove (worktree gone,
 *     run-branch ref STAYS). It is only the short-lived merge stage.
 *
 * Legacy note: the old spawner path still creates lazing/run/* WORKTREES
 * (createRunWorktree with checkout). These are also cleaned up here —
 * a registered worktree on the run branch is always a leak (the new path
 * never creates one). So we remove the WORKTREE but leave the
 * run-BRANCH ref standing.
 *
 * Intended call-site: lib/heartbeat/runner.ts / instrumentation.ts at boot.
 *
 * @returns the number of worktrees that were discarded.
 */
export async function recoverOrphanedWorktrees(
  repoPath: string,
): Promise<number> {
  const orphans = await listAllLazingWorktrees(repoPath);
  let discarded = 0;

  for (const orphan of orphans) {
    try {
      if (orphan.branch.startsWith(STEP_BRANCH_PREFIX)) {
        // Discard step worktree + step branch completely.
        await discardStepWorktree({
          repoPath,
          stepBranch: orphan.branch,
          deleteBranch: true,
        });
        discarded += 1;
      } else if (orphan.branch.startsWith(BRANCH_PREFIX)) {
        // Run branch has a WORKTREE → that is a leak (legacy spawner or
        // a stuck _merge). Remove the worktree, KEEP the run BRANCH.
        await execFile('git', [
          '-C',
          repoPath,
          'worktree',
          'remove',
          '--force',
          orphan.worktreePath,
        ]);
        discarded += 1;
      }
    } catch (err: unknown) {
      // Log but continue — we want to attempt all discards even if one fails.
      console.warn(
        `[worktree-manager] recoverOrphanedWorktrees: failed to discard ` +
          `branch="${orphan.branch}". ` +
          `Error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (discarded > 0) {
    console.log(
      `[worktree-manager] recoverOrphanedWorktrees: discarded ${discarded} ` +
        `orphaned worktree(s) in "${repoPath}".`,
    );
  }

  return discarded;
}

/**
 * W1c — Boot sweep over ALL registered workspace repos (Self-Learning P0).
 *
 * Audit finding (docs/audits/2026-05-28_self-learning-healing-audit.md): after
 * a VPS reboot/crash, lazing/run/* worktrees + tmux sessions linger ("10 leaked
 * sessions May 20-25"). `recoverOrphanedWorktrees(repoPath)` exists per
 * repo but only has test callers. This wrapper iterates over all primary
 * FS roots from `workspace_fs_roots` and calls the existing recovery per path,
 * fail-soft + idempotent.
 *
 * Dry-run: `{ apply: false }` (default) only lists what is orphaned, without
 * discarding — useful for boot telemetry. `{ apply: true }` performs the real
 * `discardRunWorktree` calls.
 *
 * Idempotent: a second call with identical state is a no-op (every discard is
 * internally idempotent — `git worktree remove` fails cleanly when the WT
 * is already gone, `branch -D` when the branch is missing; both are logged).
 *
 * Fail-soft: one error per workspace does NOT block the others.
 *
 * @returns { scanned, discarded, dryRun, errors } — telemetry for the caller.
 */
export interface RecoverAllResult {
  /** Number of workspace FS roots that were scanned. */
  scanned: number;
  /** Aggregated number of discarded worktrees (across all repos). */
  discarded: number;
  /** true if `apply:false` — discardRunWorktree was NOT called. */
  dryRun: boolean;
  /** Per-workspace error messages (lazyOS pattern: log+continue, never throw). */
  errors: Array<{ workspaceId: string; absPath: string; error: string }>;
}

export async function recoverOrphanedWorktreesAll(
  opts?: { apply?: boolean },
): Promise<RecoverAllResult> {
  const apply = opts?.apply ?? false;
  const errors: RecoverAllResult['errors'] = [];
  let scanned = 0;
  let discarded = 0;

  // Lazy import: avoid worktree-manager depending on db/client/fs-roots —
  // this file is also imported in path tests WITHOUT a DB.
  let primaryRoots: Array<{ workspaceId: string; absPath: string }> = [];
  try {
    const { getDb } = await import('../../db/client');
    const raw = getDb().$raw;
    const rows = raw
      .prepare(
        `SELECT workspace_id, abs_path
           FROM workspace_fs_roots
          WHERE role = 'primary'
          ORDER BY created_at ASC`,
      )
      .all() as Array<{ workspace_id: string; abs_path: string }>;
    primaryRoots = rows.map((r) => ({
      workspaceId: r.workspace_id,
      absPath: r.abs_path,
    }));
  } catch (err) {
    // DB unreachable (fresh boot, migration still running, test env without
    // workspace_fs_roots table): we return an empty scanned list instead of
    // throwing. The boot caller (instrumentation.ts) logs this non-fatal.
    console.warn(
      '[worktree-manager] recoverOrphanedWorktreesAll: FS-Roots-Read fehlgeschlagen ' +
        '(non-fatal — kein Sweep ausgeführt):',
      err instanceof Error ? err.message : String(err),
    );
    return { scanned: 0, discarded: 0, dryRun: apply === false, errors: [] };
  }

  for (const root of primaryRoots) {
    scanned += 1;
    try {
      // Dry-run: only list what IS orphaned, but don't discard.
      if (!apply) {
        const orphans = await listRunWorktrees(root.absPath);
        if (orphans.length > 0) {
          console.log(
            `[worktree-manager] recoverOrphanedWorktreesAll[dry-run]: ` +
              `workspace=${root.workspaceId} would discard ${orphans.length} orphan(s) ` +
              `at "${root.absPath}".`,
          );
        }
        continue;
      }
      const n = await recoverOrphanedWorktrees(root.absPath);
      discarded += n;
    } catch (err) {
      errors.push({
        workspaceId: root.workspaceId,
        absPath: root.absPath,
        error: err instanceof Error ? err.message : String(err),
      });
      console.warn(
        `[worktree-manager] recoverOrphanedWorktreesAll: workspace=${root.workspaceId} ` +
          `at "${root.absPath}" failed (continuing): ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  if (apply && discarded > 0) {
    console.log(
      `[worktree-manager] recoverOrphanedWorktreesAll: discarded ${discarded} ` +
        `orphan(s) across ${scanned} workspace(s) (${errors.length} workspace error(s)).`,
    );
  }

  return { scanned, discarded, dryRun: !apply, errors };
}

// ════════════════════════════════════════════════════════════════════════════
// ACCUMULATION — run branch + step worktree + serial merge (2026-05-29)
// ════════════════════════════════════════════════════════════════════════════
//
// Steps 2+3 of the accumulation plan. Separates the (cap-free) run branch from
// the (cap-bound) step worktree so steps can build on each other
// (composition). Step 1 (lossless diff persistence) lives in the plan-executor
// and STAYS. Step 4 (gated operator merge into live/main) is NOT here —
// mergeRunWorktree still throws (R1 gate untouched).

/**
 * Checks whether a local branch exists. Idempotency helper for
 * createOrReuseRunWorktree. Error → false (fail-soft, caller then creates it).
 */
async function branchExists(repoPath: string, branch: string): Promise<boolean> {
  try {
    await execFile('git', [
      '-C',
      repoPath,
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/heads/${branch}`,
    ]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Creates (or reuses) the accumulating RUN branch of a
 * plan run: `lazing/run/<runId>`, branched from HEAD.
 *
 * NO `git worktree add` → NO checkout → NO consumption of the N11 worktree cap.
 * The run branch is only a ref; the steps materialize in their own
 * step worktrees (createStepWorktree, baseBranch=runBranch) and merge their
 * work back (mergeStepIntoRun). So step N sees all previously merged steps.
 *
 * Idempotent: if the branch already exists (re-entry/retry of the same run),
 * it is reused UNCHANGED (NO reset to HEAD — otherwise accumulated
 * work would be lost).
 *
 * Security: runId validated against SAFE_ID_RE (T1/T5, path/ref injection).
 *
 * @returns { runBranch } — the branch name (no path, since no worktree).
 */
export async function createOrReuseRunWorktree(args: {
  repoPath: string;
  workspaceId: string;
  runId: string;
}): Promise<{ runBranch: string }> {
  const { repoPath, workspaceId, runId } = args;

  assertSafeId(workspaceId, 'workspaceId');
  assertSafeId(runId, 'runId');
  await assertIsGitRepo(repoPath);

  const runBranch = `${BRANCH_PREFIX}${runId}`;

  // Idempotent: branch exists → reuse (keep accumulated tips).
  if (await branchExists(repoPath, runBranch)) {
    return { runBranch };
  }

  // Create branch from HEAD — WITHOUT checkout (no worktree, no cap).
  try {
    await execFile('git', [
      '-C',
      repoPath,
      'branch',
      runBranch,
      'HEAD',
    ]);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // Race: between branchExists and branch-create a parallel call created
    // the branch → that is exactly the desired result, non-fatal.
    if (msg.includes('already exists')) {
      return { runBranch };
    }
    throw new Error(
      `RUN_BRANCH_CREATE_FAILED: git branch "${runBranch}" failed for runId ` +
        `"${runId}" in "${repoPath}". Original error: ${msg}`,
    );
  }

  return { runBranch };
}

/**
 * Creates a throwaway STEP worktree, branched FROM THE RUN TIP (baseBranch),
 * NOT from live HEAD:
 *
 *   git worktree add <p> -b lazing/step/<stepId> <baseBranch>
 *
 * This way the step worktree contains all steps previously merged into the run →
 * composition. The worktree lives — like the run worktrees — OUTSIDE the
 * live repo (.lazing-worktrees/<workspaceId>/step-<stepId>).
 *
 * N11 cap: step worktrees are now the ONLY cap-relevant worktrees
 * (run branches are checkout-free). We count ALL registered lazing
 * worktrees (run/* + step/*) and throw at ≥ MAX_RUN_WORKTREES.
 *
 * Security: stepId + workspaceId against SAFE_ID_RE; path-escape assertion.
 *
 * @returns { worktreePath, stepBranch }
 */
export async function createStepWorktree(args: {
  repoPath: string;
  workspaceId: string;
  stepId: string;
  baseBranch: string;
}): Promise<{ worktreePath: string; stepBranch: string }> {
  const { repoPath, workspaceId, stepId, baseBranch } = args;

  assertSafeId(workspaceId, 'workspaceId');
  assertSafeId(stepId, 'stepId');
  await assertIsGitRepo(repoPath);

  // baseBranch must be a lazing run branch (defense-in-depth: we branch
  // only from a ref we control, never from arbitrary user input).
  if (!baseBranch.startsWith(BRANCH_PREFIX)) {
    throw new Error(
      `STEP_BASE_INVALID: baseBranch "${baseBranch}" is not a lazing/run/* ` +
        `branch. createStepWorktree only branches off a managed run-tip.`,
    );
  }

  // N11 cap over ALL lazing worktrees (run/* + step/*). Step worktrees are
  // now the cap-bearing units; run branches have no worktree.
  const existing = await listAllLazingWorktrees(repoPath);
  if (existing.length >= MAX_RUN_WORKTREES) {
    throw new Error(
      `N11_WORKTREE_CAP: cannot create step worktree for stepId "${stepId}" — ` +
        `${existing.length} lazing worktrees already exist (cap=${MAX_RUN_WORKTREES}). ` +
        `Active: ${existing.map((w) => w.branch).join(', ')}`,
    );
  }

  // Path: .lazing-worktrees/<workspaceId>/step-<stepId> (unique, escape-proof).
  const worktreePath = buildWorktreePath(repoPath, workspaceId, `step-${stepId}`);
  const stepBranch = `${STEP_BRANCH_PREFIX}${stepId}`;

  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });

  try {
    await execFile('git', [
      '-C',
      repoPath,
      'worktree',
      'add',
      worktreePath,
      '-b',
      stepBranch,
      baseBranch,
    ]);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('already exists') || msg.includes('already checked out')) {
      throw new Error(
        `STEP_WORKTREE_EXISTS: worktree at "${worktreePath}" or branch ` +
          `"${stepBranch}" already exists. Run discardStepWorktree first. ` +
          `(original error: ${msg})`,
      );
    }
    throw new Error(
      `STEP_WORKTREE_CREATE_FAILED: git worktree add failed for stepId ` +
        `"${stepId}" off "${baseBranch}" at "${worktreePath}". ` +
        `Original error: ${msg}`,
    );
  }

  return { worktreePath, stepBranch };
}

/**
 * Result of mergeStepIntoRun. `merged:false` with `conflict` = the step branch
 * collides with the run tip (e.g. two parallel steps on the same file).
 * The caller then marks the step 'failed' + writes a conflict decision.
 */
export interface MergeStepResult {
  merged: boolean;
  /** Conflict detail (file list / git output), set only on merged:false. */
  conflict?: string;
}

/**
 * Merges a step branch into the run branch: `git merge --no-ff <stepBranch>`,
 * executed IN the run context via `git -C repoPath merge` with a
 * checkout-free approach.
 *
 * SERIALIZED: the caller MUST hold a mutex/promise chain per runId —
 * git allows no parallel merge into the same branch (index lock), and
 * serial merges are the prerequisite for deterministic composition.
 * This function does NOT serialize itself (it does not know the runId mutex);
 * it is the critical section that runs under the mutex.
 *
 * Mechanics (checkout-free, since the run branch has no worktree): we do NOT merge
 * in the live checkout (that would be an N violation). Instead we materialize the
 * merge via a temporary, ephemeral worktree of the run branch:
 *   1. git worktree add --no-checkout? → no, we need the tree for --no-ff.
 * In practice: we use a short-lived worktree on the run branch, merge there
 * --no-ff, and remove the worktree again. The run-branch ref moves
 * to the merge commit. Conflict → merge is aborted (git merge --abort),
 * the run branch stays at the old tip, {merged:false,conflict} returned.
 *
 * Conflict-free: {merged:true}. The run branch is NEVER touched via branch -D.
 */
export async function mergeStepIntoRun(args: {
  repoPath: string;
  runBranch: string;
  stepBranch: string;
}): Promise<MergeStepResult> {
  const { repoPath, runBranch, stepBranch } = args;

  await assertIsGitRepo(repoPath);
  if (!runBranch.startsWith(BRANCH_PREFIX)) {
    throw new Error(
      `MERGE_RUN_INVALID: runBranch "${runBranch}" is not a lazing/run/* branch.`,
    );
  }
  if (!stepBranch.startsWith(STEP_BRANCH_PREFIX)) {
    throw new Error(
      `MERGE_STEP_INVALID: stepBranch "${stepBranch}" is not a lazing/step/* branch.`,
    );
  }

  // Ephemeral merge worktree on the run branch. Unique path per merge attempt
  // (runBranch is exclusive per mutex section, so the branch name suffices).
  const runId = runBranch.slice(BRANCH_PREFIX.length);
  const base = worktreesBase(repoPath);
  const mergeWtPath = path.resolve(base, '_merge', runId);
  const baseWithSep = base.endsWith(path.sep) ? base : base + path.sep;
  if (!mergeWtPath.startsWith(baseWithSep)) {
    throw new Error(
      `PATH_ESCAPE: merge worktree path "${mergeWtPath}" not under "${base}".`,
    );
  }

  fs.mkdirSync(path.dirname(mergeWtPath), { recursive: true });

  // 1. Check out the run branch into a short-lived worktree.
  try {
    await execFile('git', [
      '-C',
      repoPath,
      'worktree',
      'add',
      mergeWtPath,
      runBranch,
    ]);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // Stale merge worktree from an aborted operation → clean up + retry.
    if (msg.includes('already exists') || msg.includes('already checked out')) {
      await execFile('git', [
        '-C',
        repoPath,
        'worktree',
        'remove',
        '--force',
        mergeWtPath,
      ]).catch(() => {});
      await execFile('git', [
        '-C',
        repoPath,
        'worktree',
        'add',
        mergeWtPath,
        runBranch,
      ]);
    } else {
      throw new Error(
        `MERGE_WORKTREE_ADD_FAILED: cannot check out run "${runBranch}" for merge. ` +
          `Original error: ${msg}`,
      );
    }
  }

  let result: MergeStepResult;
  try {
    // 2. --no-ff merge of the step branch into the checked-out run branch.
    await execFile('git', [
      '-C',
      mergeWtPath,
      'merge',
      '--no-ff',
      '--no-edit',
      stepBranch,
    ]);
    result = { merged: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // Capture conflict detail (verbatim, N1) BEFORE we abort.
    let conflict = msg;
    try {
      const { stdout } = await execFile('git', [
        '-C',
        mergeWtPath,
        'diff',
        '--name-only',
        '--diff-filter=U',
      ]);
      const files = stdout.trim();
      if (files) conflict = `conflicting files:\n${files}\n--- git output ---\n${msg}`;
    } catch {
      /* conflict stays = msg */
    }
    // Abort the merge cleanly → run branch stays at the old tip (no half merge).
    await execFile('git', ['-C', mergeWtPath, 'merge', '--abort']).catch(() => {});
    result = { merged: false, conflict };
  } finally {
    // 3. Remove the ephemeral merge worktree. Run-branch ref STAYS (now points
    //    to the merge commit on success). NEVER branch -D the run branch.
    await execFile('git', [
      '-C',
      repoPath,
      'worktree',
      'remove',
      '--force',
      mergeWtPath,
    ]).catch((e: unknown) => {
      console.warn(
        `[worktree-manager] mergeStepIntoRun: cleanup of merge worktree ` +
          `"${mergeWtPath}" failed (non-fatal): ` +
          (e instanceof Error ? e.message : String(e)),
      );
    });
  }

  return result;
}

/**
 * Discards ONLY a step worktree + (by default) its step branch.
 * The run branch is NEVER touched — the accumulated work lives on there.
 *
 * `deleteBranch=false` keeps the step branch (e.g. for conflict forensics),
 * but removes the worktree (frees the N11 cap slot).
 *
 * Best-effort: never throws (analogous to discardRunWorktree) — a finally call in
 * the plan-executor must not fail. Partial discards are cleaned up by boot recovery
 * (recoverOrphanedWorktrees).
 */
export async function discardStepWorktree(args: {
  repoPath: string;
  stepBranch: string;
  deleteBranch?: boolean;
}): Promise<void> {
  const { repoPath, stepBranch, deleteBranch = true } = args;
  await assertIsGitRepo(repoPath);

  if (!stepBranch.startsWith(STEP_BRANCH_PREFIX)) {
    // Defense: never accidentally delete a run branch.
    console.warn(
      `[worktree-manager] discardStepWorktree: refusing non-step branch ` +
        `"${stepBranch}" (only ${STEP_BRANCH_PREFIX}* allowed).`,
    );
    return;
  }

  // Find the worktree (path unknown — via the list).
  const all = await listAllLazingWorktrees(repoPath);
  const entry = all.find((w) => w.branch === stepBranch);

  if (entry) {
    await execFile('git', [
      '-C',
      repoPath,
      'worktree',
      'remove',
      '--force',
      entry.worktreePath,
    ]).catch((err: unknown) => {
      console.warn(
        `[worktree-manager] discardStepWorktree: worktree remove failed for ` +
          `"${entry.worktreePath}" (${stepBranch}): ` +
          (err instanceof Error ? err.message : String(err)),
      );
    });
  }

  if (deleteBranch) {
    await execFile('git', ['-C', repoPath, 'branch', '-D', stepBranch]).catch(
      (err: unknown) => {
        console.warn(
          `[worktree-manager] discardStepWorktree: branch -D "${stepBranch}" failed ` +
            `(expected if never created): ` +
            (err instanceof Error ? err.message : String(err)),
        );
      },
    );
  }
}

/**
 * Lists ALL lazing worktrees (lazing/run/* AND lazing/step/* AND the
 * ephemeral _merge worktree on the run branch). Cap counting + step recovery
 * need the overall view; listRunWorktrees (run/* only) remains unchanged for the
 * spawner legacy paths.
 */
export async function listAllLazingWorktrees(
  repoPath: string,
): Promise<Array<{ worktreePath: string; branch: string }>> {
  await assertIsGitRepo(repoPath);

  let stdout: string;
  try {
    ({ stdout } = await execFile('git', [
      '-C',
      repoPath,
      'worktree',
      'list',
      '--porcelain',
    ]));
  } catch (err: unknown) {
    throw new Error(
      `LIST_WORKTREES_FAILED: git worktree list failed for "${repoPath}". ` +
        `Error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const results: Array<{ worktreePath: string; branch: string }> = [];
  const stanzas = stdout.split(/\n\n+/);
  for (const stanza of stanzas) {
    if (!stanza.trim()) continue;
    const lines = stanza.trim().split('\n');
    let wtPath: string | undefined;
    let branchRef: string | undefined;
    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        wtPath = line.slice('worktree '.length).trim();
      } else if (line.startsWith('branch ')) {
        branchRef = line.slice('branch '.length).trim();
        if (branchRef.startsWith('refs/heads/')) {
          branchRef = branchRef.slice('refs/heads/'.length);
        }
      }
    }
    if (!wtPath || !branchRef) continue;
    if (
      !branchRef.startsWith(BRANCH_PREFIX) &&
      !branchRef.startsWith(STEP_BRANCH_PREFIX)
    ) {
      continue;
    }
    results.push({ worktreePath: wtPath, branch: branchRef });
  }
  return results;
}

/**
 * GATED (Phase 2 R3+) — Merge a run worktree into the live repo.
 *
 * This function intentionally always throws in R1.  It exists as a typed
 * placeholder so callers can be written now without accidentally triggering
 * a merge.  The return type `Promise<never>` ensures no code can depend on
 * a return value from this stub.
 *
 * Merge will only be enabled in R3 after:
 *   - S6 Operator-Merge-Gate (user-only FSM transition) is built.
 *   - S5 Diff-Preview (contentHash-verified) is built.
 *   - E2E ship-gate test proves "merge only after explicit operator click".
 *
 * Security: allowing merge before the gate would re-introduce T2/T8 risks.
 */
export async function mergeRunWorktree(_args: {
  repoPath: string;
  planRunId: string;
}): Promise<never> {
  throw new Error(
    'merge not enabled — Phase 2 R3 + Operator-Merge-Gate erforderlich. ' +
      'mergeRunWorktree is intentionally gated in R1. ' +
      'Build S6 (user-only FSM merge-transition) + S5 (Diff-Preview + contentHash) ' +
      'before enabling this path.',
  );
}

// ---------------------------------------------------------------------------
// A4 (2026-05-29, Opus 4.8) — GATED operator merge (S5+S6).
//
// The accumulating run branch (lazing/run/prun-…) carries the composed
// work of all successful steps. `commitGatedMerge` is the ONLY path
// that brings it into the live checkout (main of the workspace repo) — and is
// invoked EXCLUSIVELY by the user-only FSM transition (POST /api/workstreams/[id]/
// merge-run, member auth), NEVER automatically. `mergeRunWorktree` (above)
// stays the throw stub for non-gated callers (R1). This keeps R1 intact:
// no auto-merge into live; the operator clicks deliberately.
// ---------------------------------------------------------------------------

/** All accumulating run branches (lazing/run/*) of a repo. */
export async function listRunBranches(repoPath: string): Promise<string[]> {
  await assertIsGitRepo(repoPath);
  try {
    const { stdout } = await execFile('git', [
      '-C', repoPath, 'branch', '--list', `${BRANCH_PREFIX}*`,
      '--format=%(refname:short)',
    ]);
    return stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Finds the run branch of a workstream. The run branch is named
 * `lazing/run/prun-<planId>-<workstreamId>` (plan-executor::runId) → we match
 * the branch whose name contains the workstreamId. If there are several (should not
 * happen) the most recent one via committerdate.
 */
export async function findRunBranchForWorkstream(
  repoPath: string,
  workstreamId: string,
): Promise<string | null> {
  if (!workstreamId) return null;
  const branches = await listRunBranches(repoPath);
  // Robust against runId truncation: the 56-char slice can truncate the
  // workstreamId at the end (old format {planId}-{workstreamId}). So we also match a
  // 24-char prefix of the workstreamId (ULID core, survives the truncation).
  const wsPrefix = workstreamId.slice(0, 24);
  const matches = branches.filter(
    (b) => b.includes(workstreamId) || (wsPrefix.length >= 12 && b.includes(wsPrefix)),
  );
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];
  // Several → pick the most recent.
  try {
    const { stdout } = await execFile('git', [
      '-C', repoPath, 'for-each-ref', '--sort=-committerdate',
      '--format=%(refname:short)', `refs/heads/${BRANCH_PREFIX}*`,
    ]);
    const ordered = stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    return ordered.find((b) => matches.includes(b)) ?? matches[0];
  } catch {
    return matches[0];
  }
}

/** Diff preview (S5): stat + file list of the run branch against live HEAD. */
export async function getRunBranchDiffStat(
  repoPath: string,
  runBranch: string,
): Promise<{ stat: string; files: string[]; aheadBy: number }> {
  try {
    await assertIsGitRepo(repoPath);
    const base = (await execFile('git', ['-C', repoPath, 'rev-parse', 'HEAD'])).stdout.trim();
    const range = `${base}..${runBranch}`;
    const { stdout: stat } = await execFile(
      'git', ['-C', repoPath, 'diff', '--stat', range],
      { maxBuffer: 8 * 1024 * 1024 },
    );
    const { stdout: names } = await execFile('git', ['-C', repoPath, 'diff', '--name-only', range]);
    const files = names.split('\n').map((s) => s.trim()).filter(Boolean);
    let aheadBy = 0;
    try {
      const { stdout: count } = await execFile('git', ['-C', repoPath, 'rev-list', '--count', range]);
      aheadBy = parseInt(count.trim(), 10) || 0;
    } catch { /* ignore */ }
    return { stat: stat.trim(), files, aheadBy };
  } catch {
    return { stat: '', files: [], aheadBy: 0 };
  }
}

/**
 * GATED operator merge (S6): merges the run branch into the live checkout
 * (current HEAD of repoPath). Call ONLY from the user-only API path.
 * `--no-ff` → clear merge commit. On conflict: `merge --abort` (live stays
 * clean) + {merged:false, conflict}. Does NOT throw on conflict (fail-soft return).
 */
export async function commitGatedMerge(args: {
  repoPath: string;
  runBranch: string;
}): Promise<{ merged: boolean; sha?: string; conflict?: string }> {
  const { repoPath, runBranch } = args;
  await assertIsGitRepo(repoPath);
  if (!runBranch.startsWith(BRANCH_PREFIX)) {
    throw new Error(
      `commitGatedMerge: refusing non-run-branch "${runBranch}" ` +
        `(only ${BRANCH_PREFIX}* allowed).`,
    );
  }
  try {
    await execFile('git', ['-C', repoPath, 'rev-parse', '--verify', runBranch]);
  } catch {
    return { merged: false, conflict: `run-branch "${runBranch}" existiert nicht` };
  }
  try {
    await execFile('git', [
      '-C', repoPath, 'merge', '--no-ff', '--no-edit', runBranch,
    ]);
  } catch (err: unknown) {
    try { await execFile('git', ['-C', repoPath, 'merge', '--abort']); } catch { /* ignore */ }
    const m = err instanceof Error ? err.message : String(err);
    return { merged: false, conflict: m.slice(0, 800) };
  }
  try {
    const sha = (await execFile('git', ['-C', repoPath, 'rev-parse', 'HEAD'])).stdout.trim();
    return { merged: true, sha };
  } catch {
    return { merged: true };
  }
}
