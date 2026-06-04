/**
 * server/agents/ultracoding-orchestrator.ts
 * -----------------------------------------
 * SLICE ULTRACODING-ORCHESTRATOR · 2026-06-02 — Multi-Claude file-disjoint Run.
 *
 * `runUltracoding()` is the engine-shaped entry point for the new
 * `mode:'ultracoding'` branch (BACKEND-MODE owns the orchestrator + route
 * wiring; this module owns ONLY the run logic). It mirrors the proven
 * structure of `server/agents/bug-swarm.ts`:
 *
 *   Phase 1 — Decompose the task into <=5 FILE-DISJOINT slices.
 *             Primary: one claude-cli planning call (JSON array). Deterministic
 *             N6-guard drops any slice whose `files` overlap an earlier slice.
 *             Fallback: heuristic path-bucket partition. Degenerate: single slice.
 *   Phase 2 — Spawn one claude agent per slice, in PARALLEL, each in its OWN
 *             isolated git worktree (createRunWorktree). Promise.allSettled
 *             fan-out. resourcePool slot per spawn (N11 heavy budget). On
 *             `finally`: releaseSlot ALWAYS + discardRunWorktree ALWAYS
 *             (worktree is throwaway; captured diff text survives in memory).
 *             mergeRunWorktree is NEVER called (it throws by design); merge to
 *             the live tree stays user-gated via the separate operator route.
 *   Phase 3 — Collect diffs per slice.
 *   Phase 4 — Review agent: one read-only claude pass over the concatenated
 *             diffs ("do these file-disjoint diffs conflict / break the
 *             build?"). Fail-soft.
 *   Phase 5 — Aggregate into a markdown summary (per-slice diff + branch +
 *             review verdict + bold MERGE-IS-USER-GATED note) and return an
 *             `OrchestratorResult`-shaped value.
 *
 * Hard rules honored:
 *   - Additive-only: a NEW module; touches no existing engine branch.
 *   - Gate: the caller (orchestrate / route.ts) verifies claude-cli is
 *     available BEFORE invoking this. This module additionally fails-closed on
 *     worktree-cap / slot-acquire errors per slice (never runs write-mode in
 *     the live tree).
 *   - Safety: isolated worktrees; discard in finally; never mergeRunWorktree.
 *   - Model: MODEL_NAMES.opus everywhere (Opus-only Owner-Direktive). No
 *     model-selection logic; tiers are effort labels only.
 *   - No emoji.
 */

import { MODEL_NAMES } from '../../lib/agents/pricing';
import {
  createRunWorktree,
  discardRunWorktree,
} from '../../lib/agents/worktree-manager';
import { resourcePool } from '../../lib/agents/resource-pool';
import { getEngine } from '../../lib/llm/engines/selector';
import { spawnInTmux, type SpawnResult } from './tmux-spawn';
import { execFile as _execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { SubagentLaneEvent, SubagentRole } from '../../lib/agents/spawner-types';
import type { OrchestratorResult } from '../../lib/llm/orchestrator';
import type { EngineMessage } from '../../lib/llm/engines/types';

const execFile = promisify(_execFile);

// ---------------------------------------------------------------------------
// Public contract (C1) — consumed by BACKEND-MODE (orchestrate + route.ts).
// ---------------------------------------------------------------------------

export interface RunUltracodingOpts {
  /** Full conversation (RAG system block already prepended by the route). */
  readonly messages: EngineMessage[];
  /** Workspace scope (N9). Used for createRunWorktree workspaceId + surfaces. */
  readonly workspaceId: string;
  /** Optional repo path override. Defaults to resolved primary FS-root of workspaceId. */
  readonly repoPath?: string;
  /** Live lane-event sink for SSE bridging. Omitted by non-HTTP callers. */
  readonly onLaneEvent?: (ev: SubagentLaneEvent) => void;
  /** Caller abort. */
  readonly signal?: AbortSignal;
  /** Soft cap on the whole run. Default 12 min. */
  readonly totalTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Constants — mirror bug-swarm budgets (SPEC §Constants).
// ---------------------------------------------------------------------------

const SLICE_TIMEOUT_MS = 6 * 60_000;
const REVIEW_TIMEOUT_MS = 3 * 60_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 12 * 60_000;
const MAX_SLICES = 5;

/** Coder agents start at this base agentIdx; reviewer at 7900 (SPEC C2). */
const CODER_AGENT_IDX_BASE = 7000;
const REVIEWER_AGENT_IDX = 7900;

const CODER_TOOLS = ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'] as const;
const REVIEWER_TOOLS = ['Read', 'Grep', 'Glob', 'Bash'] as const;

// ---------------------------------------------------------------------------
// Internal slice + collected-result types.
// ---------------------------------------------------------------------------

interface UltraSlice {
  readonly title: string;
  readonly rationale: string;
  /** Pairwise-disjoint file set (enforced by the deterministic guard). */
  readonly files: string[];
  readonly systemPrompt: string;
}

type SliceStatus = 'done' | 'skipped' | 'failed';

interface CollectedSlice {
  readonly slice: UltraSlice;
  readonly index: number;
  readonly branch: string | null;
  readonly diffText: string;
  readonly agentText: string;
  readonly status: SliceStatus;
  readonly note?: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly latencyMs: number;
}

// ---------------------------------------------------------------------------
// Helpers — id sanitisation + repo-path resolution.
// ---------------------------------------------------------------------------

/**
 * Sanitise an arbitrary id into the SAFE_ID_RE shape that worktree-manager
 * requires (`[A-Za-z0-9_:.-]`, <=64 chars). Non-conforming chars become '-'.
 * Empty input falls back to a stable placeholder so createRunWorktree never
 * receives an empty workspaceId.
 */
function sanitizeId(raw: string): string {
  const cleaned = (raw || '').replace(/[^A-Za-z0-9_:.\-]/g, '-').slice(0, 64);
  return cleaned.length > 0 ? cleaned : 'adhoc';
}

/** Short, SAFE_ID_RE-safe slug from a title (for the planRunId suffix). */
function slug(title: string, fallback: string): string {
  const s = (title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  return s.length > 0 ? s : fallback;
}

/**
 * Resolve the primary FS-root of a workspace (the git repo the agents run in).
 * Mirrors the `workspace_fs_roots` query used by worktree-manager's boot sweep
 * (role='primary'). Lazy DB import — keeps this module importable without DB in
 * unit tests. Returns null when no root is registered (caller must bail).
 */
async function resolveRepoPath(workspaceId: string): Promise<string | null> {
  try {
    const { getDb } = await import('../../db/client');
    const raw = getDb().$raw;
    const row = raw
      .prepare(
        `SELECT abs_path
           FROM workspace_fs_roots
          WHERE workspace_id = ? AND role = 'primary'
          ORDER BY created_at ASC
          LIMIT 1`,
      )
      .get(workspaceId) as { abs_path: string } | undefined;
    return row?.abs_path ?? null;
  } catch (err) {
    console.warn(
      '[ultracoding] resolveRepoPath failed (non-fatal):',
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Task extraction — the last `user` message is the task (SPEC C2).
// ---------------------------------------------------------------------------

function extractTask(messages: EngineMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') {
      return (messages[i]?.content ?? '').trim();
    }
  }
  // Fallback: concatenate everything (degenerate, still produces a task string).
  return messages.map((m) => m.content).join('\n').trim();
}

// ---------------------------------------------------------------------------
// Phase 1 — Decompose into <=5 file-disjoint slices.
// ---------------------------------------------------------------------------

/**
 * Deterministic N6-guard: drop any slice whose `files` overlap an EARLIER
 * slice's `files`. Validator precedes trust — even a perfect planner output is
 * re-checked here. Slices with an empty `files` set after de-dup are dropped.
 */
function enforceDisjoint(slices: UltraSlice[]): UltraSlice[] {
  const seen = new Set<string>();
  const out: UltraSlice[] = [];
  for (const s of slices) {
    const norm = (s.files ?? [])
      .map((f) => String(f).trim())
      .filter((f) => f.length > 0);
    const kept = norm.filter((f) => !seen.has(f));
    if (kept.length === 0) continue; // fully overlapping → drop (N6).
    for (const f of kept) seen.add(f);
    out.push({ ...s, files: kept });
    if (out.length >= MAX_SLICES) break;
  }
  return out;
}

/** Extract candidate file paths mentioned in free text (heuristic fallback). */
function extractMentionedPaths(task: string): string[] {
  const re =
    /[A-Za-z0-9_./-]+\.(?:tsx?|jsx?|py|rs|go|java|kt|md|css|html|json|sql|ya?ml)\b/g;
  const found = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(task)) !== null) {
    found.add(m[0]);
  }
  return Array.from(found);
}

/**
 * Heuristic partition fallback: group mentioned paths by top-level module/dir
 * into <=5 buckets, one bucket = one slice. When nothing is partitionable,
 * return a single degenerate slice (still isolated).
 */
function heuristicPartition(task: string): UltraSlice[] {
  const paths = extractMentionedPaths(task);
  if (paths.length === 0) {
    return [
      {
        title: 'Gesamt-Aufgabe',
        rationale:
          'Keine partitionierbaren Pfade erkannt — degenerierte Einzel-Slice (weiterhin isoliert).',
        files: [],
        systemPrompt:
          'Implementiere die Aufgabe vollständig in einem isolierten Worktree.',
      },
    ];
  }

  const buckets = new Map<string, string[]>();
  for (const p of paths) {
    const top = p.split('/')[0] || p;
    const arr = buckets.get(top) ?? [];
    arr.push(p);
    buckets.set(top, arr);
  }

  const slices: UltraSlice[] = [];
  for (const [top, files] of buckets.entries()) {
    slices.push({
      title: `Modul ${top}`,
      rationale: `Pfad-Bucket nach Top-Level-Modul "${top}" (heuristische Partition).`,
      files,
      systemPrompt: `Implementiere die Änderungen für das Modul "${top}". Bleibe strikt innerhalb der zugewiesenen Dateien.`,
    });
    if (slices.length >= MAX_SLICES) break;
  }
  return slices;
}

/** Strip a leading/trailing ```json fence if the planner wrapped its output. */
function stripJsonFence(text: string): string {
  const t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) return fence[1].trim();
  return t;
}

/**
 * Phase 1 primary path: ask claude-cli for a JSON array of slices. The
 * planning call is best-effort; on ANY failure (engine error, non-JSON,
 * zero valid slices) we fall back to the heuristic partition.
 */
async function decomposeTask(
  task: string,
  signal: AbortSignal | undefined,
): Promise<UltraSlice[]> {
  const planningPrompt = [
    'Du bist der Ultracoding-Planer. Zerlege die folgende Coding-Aufgabe in',
    `höchstens ${MAX_SLICES} parallele Slices. HARTE Bedingung: die "files"-Mengen`,
    'der Slices müssen PAARWEISE DISJUNKT sein (kein File in zwei Slices).',
    '',
    'Antworte AUSSCHLIESSLICH mit einem JSON-Array dieser Form (kein Prosa-Text):',
    '[{"title": "...", "rationale": "...", "files": ["pfad/a.ts"], "systemPrompt": "..."}]',
    '',
    'Aufgabe:',
    task,
  ].join('\n');

  try {
    const res = await getEngine('claude-cli').chat({
      messages: [{ role: 'user', content: planningPrompt }],
      timeoutMs: 90_000,
      signal,
      // Ultrathink: claude-cli maps thinking → --effort. Default-off elsewhere;
      // here we want maximal decomposition quality. Structural no-op for other
      // engines, but this IS the claude-cli engine.
      thinking: true,
    });

    const raw = stripJsonFence(res.text ?? '');
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) throw new Error('planner did not return an array');

    const candidate: UltraSlice[] = parsed
      .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
      .map((s) => ({
        title: String(s.title ?? 'Slice'),
        rationale: String(s.rationale ?? ''),
        files: Array.isArray(s.files) ? s.files.map((f) => String(f)) : [],
        systemPrompt: String(s.systemPrompt ?? ''),
      }));

    const disjoint = enforceDisjoint(candidate);
    if (disjoint.length >= 1) return disjoint;
    // <1 valid slice after the disjoint guard → fall through to heuristic.
  } catch (err) {
    console.warn(
      '[ultracoding] decompose planning call failed — heuristic fallback:',
      err instanceof Error ? err.message : String(err),
    );
  }

  return enforceDisjoint(heuristicPartition(task));
}

// ---------------------------------------------------------------------------
// Lane-event emission helper.
// ---------------------------------------------------------------------------

function emitLane(
  onLaneEvent: ((ev: SubagentLaneEvent) => void) | undefined,
  ev: SubagentLaneEvent,
): void {
  // no-op when omitted (non-HTTP callers). Never let a sink error break the run.
  try {
    onLaneEvent?.(ev);
  } catch {
    /* sink gone — ignore */
  }
}

// ---------------------------------------------------------------------------
// Phase 2 — spawn one claude coder per slice, isolated worktree, parallel.
// ---------------------------------------------------------------------------

function buildCoderPrompts(args: {
  slice: UltraSlice;
  task: string;
  worktreePath: string;
}): { systemPrompt: string; userPrompt: string } {
  const { slice, task, worktreePath } = args;
  const fileList =
    slice.files.length > 0 ? slice.files.join(', ') : '(keine Datei-Vorgabe)';

  const systemPrompt = [
    slice.systemPrompt,
    '',
    'Du bist ein Ultracoding-Coder in einem ISOLIERTEN git-Worktree.',
    `Working-Dir: ${worktreePath}.`,
    'Du hast Tool-Use: Read, Write, Edit, Bash, Grep, Glob.',
    '',
    'FILE-DISJUNKT-CONSTRAINT (hart): Du darfst AUSSCHLIESSLICH diese Dateien',
    `anfassen: ${fileList}.`,
    'Berühre KEINE anderen Dateien — andere Slices laufen parallel auf den ihren.',
    '',
    'PFLICHT-Schritte:',
    '1. Lies die Ziel-Dateien (Read).',
    '2. Implementiere die Änderung (Edit/Write). TypeScript strict, kein any.',
    '3. Commit MIT [skip-mirror]-Footer, NICHT pushen:',
    '   git add -A && git commit -m "[skip-mirror] ultra: <kurze msg>"',
    '4. Output: 3-5 Zeilen Zusammenfassung was du geändert hast.',
    '',
    'VERBOTEN:',
    '- Schreibzugriff außerhalb der zugewiesenen Dateien / des Working-Dir.',
    '- git push, git reset --hard, --force, --amend ohne explizites OK.',
    '- Commits ohne [skip-mirror]-Footer.',
  ].join('\n');

  const userPrompt = [
    `Ultracoding-Slice: ${slice.title}`,
    slice.rationale ? `Begründung: ${slice.rationale}` : '',
    '',
    'Gesamt-Aufgabe (Kontext):',
    task,
    '',
    `Deine Dateien (NUR diese): ${fileList}`,
    '',
    'Implementiere die Änderung als ECHTEN Code-Diff und committe mit [skip-mirror].',
  ].join('\n');

  return { systemPrompt, userPrompt };
}

/**
 * Capture ALL of the agent's work in the worktree relative to its BASE (the
 * sha the worktree branched from). `git diff <baseSha>` in one invocation
 * covers BOTH every commit the agent made AND any uncommitted working-tree
 * changes — robust to 0, 1, or N commits (the old `HEAD~1..HEAD` mis-reported
 * the pre-existing commit when the agent made 0 commits). Falls back to
 * `git diff HEAD` (working-tree) if no baseSha was captured.
 */
async function captureDiff(worktreePath: string, baseSha: string): Promise<string> {
  const ref = baseSha && /^[0-9a-f]{7,40}$/.test(baseSha) ? baseSha : 'HEAD';
  try {
    const { stdout } = await execFile(
      'git',
      ['-C', worktreePath, 'diff', ref],
      { maxBuffer: 8 * 1024 * 1024 },
    );
    return stdout.trim();
  } catch {
    return '';
  }
}

/**
 * Run one slice end-to-end in its own worktree. ALWAYS releases the pool slot
 * and discards the worktree in `finally` (rollback — the captured diff text
 * survives in memory for the summary). Never throws past this function; returns
 * a CollectedSlice describing the outcome so Promise.allSettled stays clean.
 */
async function runSlice(args: {
  slice: UltraSlice;
  index: number;
  task: string;
  workspaceId: string;
  repoPath: string;
  runId: string;
  signal: AbortSignal | undefined;
  onLaneEvent?: (ev: SubagentLaneEvent) => void;
}): Promise<CollectedSlice> {
  const { slice, index, task, workspaceId, repoPath, runId, signal, onLaneEvent } = args;
  const t0 = Date.now();
  const role: SubagentRole = 'coder';
  const subagentId = `ultra-${runId}-${index}`;
  const planRunId = sanitizeId(`ultra-${runId}-${index}-${slug(slice.title, String(index))}`);

  const empty = (status: SliceStatus, note: string, branch: string | null): CollectedSlice => ({
    slice,
    index,
    branch,
    diffText: '',
    agentText: note,
    status,
    note,
    promptTokens: 0,
    completionTokens: 0,
    latencyMs: Date.now() - t0,
  });

  // 1. Acquire a heavy-engine slot (N11). On failure → error lane, skip slice.
  let slotId: string | null = null;
  try {
    const slot = await resourcePool.acquireSlot({
      kind: 'claude-cli',
      subagentId,
      priority: 'normal',
      timeoutMs: SLICE_TIMEOUT_MS,
      signal,
    });
    slotId = slot.slotId;
  } catch (err) {
    emitLane(onLaneEvent, {
      kind: 'error',
      subagentId,
      role,
      worktreeBranch: null,
      engine: 'claude-cli',
      code: 'slot-acquire-failed',
      message: err instanceof Error ? err.message : String(err),
      at: Date.now(),
    } as SubagentLaneEvent);
    return empty('skipped', 'slot-acquire-failed', null);
  }

  let worktreePath: string | null = null;
  let branch: string | null = null;
  let baseSha = '';
  try {
    // 2. Create the isolated worktree. N11_WORKTREE_CAP at >=5 → skip slice.
    try {
      const created = await createRunWorktree({
        repoPath,
        workspaceId: sanitizeId(workspaceId),
        planRunId,
      });
      worktreePath = created.worktreePath;
      branch = created.branch;
      // Record the branch-point SHA — captureDiff diffs against it later
      // (captures ALL commits + uncommitted changes in one call).
      try {
        const { stdout } = await execFile(
          'git',
          ['-C', worktreePath, 'rev-parse', 'HEAD'],
          { maxBuffer: 1024 * 1024 },
        );
        baseSha = stdout.trim();
      } catch {
        /* baseSha bleibt '' → captureDiff fällt auf `git diff HEAD` zurück */
      }
    } catch (err) {
      emitLane(onLaneEvent, {
        kind: 'error',
        subagentId,
        role,
        worktreeBranch: null,
        engine: 'claude-cli',
        code: 'worktree-cap-exhausted',
        message: err instanceof Error ? err.message : String(err),
        at: Date.now(),
      } as SubagentLaneEvent);
      return empty('skipped', 'worktree-cap-exhausted', null);
    }

    // started lane event — worktree is live.
    emitLane(onLaneEvent, {
      kind: 'started',
      subagentId,
      role,
      worktreeBranch: branch,
      engine: 'claude-cli',
      at: Date.now(),
    });

    // 3. Spawn the coder agent in the worktree.
    const { systemPrompt, userPrompt } = buildCoderPrompts({ slice, task, worktreePath });
    let result: SpawnResult;
    try {
      result = await spawnInTmux({
        workspaceId,
        workspacePath: worktreePath,
        workstreamId: `ultra-${runId}-${index}`,
        tier: 'opus',
        agentIdx: CODER_AGENT_IDX_BASE + index,
        model: MODEL_NAMES.opus,
        systemPrompt,
        userPrompt,
        timeoutMs: SLICE_TIMEOUT_MS,
        allowedTools: CODER_TOOLS,
      });
    } catch (err) {
      emitLane(onLaneEvent, {
        kind: 'error',
        subagentId,
        role,
        worktreeBranch: branch,
        engine: 'claude-cli',
        code: 'spawn-failed',
        message: err instanceof Error ? err.message : String(err),
        at: Date.now(),
      } as SubagentLaneEvent);
      return empty('failed', `spawn-failed: ${err instanceof Error ? err.message : String(err)}`, branch);
    }

    const agentText = (result.text ?? '').trim();
    const failed =
      result.timedOut || result.exitCode !== 0 || agentText.length === 0;

    // 4. Capture the diff from the worktree (before discard in finally).
    const diffText = await captureDiff(worktreePath, baseSha);

    // text-delta + end lane events.
    emitLane(onLaneEvent, {
      kind: 'text-delta',
      subagentId,
      role,
      worktreeBranch: branch,
      text: agentText.slice(0, 4000),
      at: Date.now(),
    });
    emitLane(onLaneEvent, {
      kind: 'end',
      subagentId,
      role,
      worktreeBranch: branch,
      durationMs: result.durationMs,
      reason: failed ? 'failed' : 'ok',
      at: Date.now(),
    });

    const produced = diffText.length > 0;
    return {
      slice,
      index,
      branch,
      diffText,
      agentText,
      status: failed && !produced ? 'failed' : 'done',
      note: failed ? `timed_out=${result.timedOut} exit=${result.exitCode}` : undefined,
      promptTokens: result.tokens?.input ?? 0,
      completionTokens: result.tokens?.output ?? 0,
      latencyMs: Date.now() - t0,
    };
  } finally {
    // ALWAYS release the slot + discard the worktree (rollback). Never call
    // mergeRunWorktree — merge stays user-gated via commitGatedMerge.
    if (slotId) {
      try {
        resourcePool.releaseSlot(slotId);
      } catch {
        /* release best-effort */
      }
    }
    try {
      await discardRunWorktree({ repoPath, planRunId });
    } catch (err) {
      console.warn(
        `[ultracoding] discardRunWorktree failed for ${planRunId} (non-fatal):`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Phase 4 — review agent (read-only claude-cli pass over the diffs).
// ---------------------------------------------------------------------------

async function reviewDiffs(args: {
  collected: CollectedSlice[];
  signal: AbortSignal | undefined;
}): Promise<string> {
  const { collected, signal } = args;
  const withDiffs = collected.filter((c) => c.diffText.length > 0);
  if (withDiffs.length === 0) {
    return 'Review übersprungen — keine Diffs produziert.';
  }

  const concatenated = withDiffs
    .map(
      (c) =>
        `### Slice ${c.index + 1}: ${c.slice.title}\nDateien: ${c.slice.files.join(', ') || '(keine)'}\n\n${c.diffText.slice(0, 6000)}`,
    )
    .join('\n\n');

  const reviewPrompt = [
    'Du bist der Ultracoding-Reviewer. Die folgenden Diffs stammen aus',
    'file-disjunkten, parallel gelaufenen Slices. Prüfe:',
    '- Überschneiden / kollidieren die Diffs trotz Disjunktheits-Anspruch?',
    '- Brechen sie den Build (offensichtliche Typ-/Import-Fehler)?',
    '- Risiko pro Slice (kurz).',
    'Antworte kompakt in Markdown, eine Risiko-Zeile pro Slice + ein Gesamt-Urteil.',
    '',
    concatenated,
  ].join('\n');

  try {
    const res = await getEngine('claude-cli').chat({
      messages: [{ role: 'user', content: reviewPrompt }],
      timeoutMs: REVIEW_TIMEOUT_MS,
      signal,
      thinking: true,
    });
    const text = (res.text ?? '').trim();
    return text.length > 0 ? text : 'Review lieferte keinen Text — übersprungen.';
  } catch (err) {
    return `Review übersprungen — Review-Call fehlgeschlagen: ${
      err instanceof Error ? err.message : String(err)
    }`;
  }
}

// ---------------------------------------------------------------------------
// Phase 5 — aggregate into the final markdown summary.
// ---------------------------------------------------------------------------

function buildSummary(collected: CollectedSlice[], reviewVerdict: string): string {
  const lines: string[] = [];
  lines.push('# Ultracoding-Lauf — Ergebnis (datei-disjunkt, isolierte Worktrees)');
  lines.push('');

  for (const c of collected) {
    lines.push(`## Slice ${c.index + 1}: ${c.slice.title}`);
    lines.push(`- Branch: \`${c.branch ?? '(kein Worktree)'}\``);
    lines.push(
      `- Dateien: ${c.slice.files.length > 0 ? c.slice.files.join(', ') : '(keine Vorgabe)'}`,
    );
    lines.push(`- Status: ${c.status}${c.note ? ` (${c.note})` : ''}`);
    if (c.agentText) {
      lines.push('');
      lines.push('Agent-Zusammenfassung:');
      lines.push('');
      lines.push(c.agentText.slice(0, 1500));
    }
    if (c.diffText) {
      lines.push('');
      lines.push('Vorgeschlagener Diff:');
      lines.push('');
      lines.push('```diff');
      lines.push(c.diffText.slice(0, 12000));
      lines.push('```');
    }
    lines.push('');
  }

  lines.push('## Review-Verdikt');
  lines.push('');
  lines.push(reviewVerdict);
  lines.push('');
  lines.push(
    '**MERGE IST USER-GATED — kein Auto-Merge. Diffs liegen auf Branch ' +
      '`lazing/run/ultra-*`; Freigabe über den Operator-Merge.**',
  );

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Public entry point.
// ---------------------------------------------------------------------------

/**
 * Returns the OrchestratorResult shape so BACKEND-MODE can treat it like any
 * engine result. See C1. Never auto-merges; every worktree is discarded.
 */
export async function runUltracoding(
  opts: RunUltracodingOpts,
): Promise<OrchestratorResult> {
  const t0 = Date.now();
  const totalTimeoutMs = opts.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;

  // Total-run soft cap: an AbortController OR'd with the caller's signal so a
  // wedged run can't exceed totalTimeoutMs.
  const totalCtl = new AbortController();
  const totalTimer = setTimeout(() => totalCtl.abort(), totalTimeoutMs);
  if (totalTimer.unref) totalTimer.unref();
  const onCallerAbort = (): void => totalCtl.abort();
  if (opts.signal) {
    if (opts.signal.aborted) totalCtl.abort();
    else opts.signal.addEventListener('abort', onCallerAbort, { once: true });
  }
  const signal = totalCtl.signal;

  const runId = sanitizeId(`${Date.now().toString(36)}`);
  const task = extractTask(opts.messages);

  try {
    // Resolve the repo path (primary FS-root) unless overridden.
    const repoPath = opts.repoPath ?? (await resolveRepoPath(opts.workspaceId));
    if (!repoPath) {
      // Fail-closed: without a repo we cannot create isolated worktrees.
      throw new Error(
        'ultracoding: kein primärer FS-Root für den Workspace gefunden — ' +
          'Worktree-Isolation nicht möglich (fail-closed, kein Lauf im Live-Tree).',
      );
    }

    // ── Phase 1: Decompose ──
    const slices = await decomposeTask(task, signal);

    // ── Phase 2: Spawn coders in parallel (each in its own worktree) ──
    const settled = await Promise.allSettled(
      slices.map((slice, index) =>
        runSlice({
          slice,
          index,
          task,
          workspaceId: opts.workspaceId,
          repoPath,
          runId,
          signal,
          onLaneEvent: opts.onLaneEvent,
        }),
      ),
    );

    // ── Phase 3: Collect ──
    const collected: CollectedSlice[] = settled.map((s, i) => {
      if (s.status === 'fulfilled') return s.value;
      // A rejected runSlice (should be rare — runSlice catches internally).
      return {
        slice: slices[i],
        index: i,
        branch: null,
        diffText: '',
        agentText: `(slice rejected: ${
          s.reason instanceof Error ? s.reason.message : String(s.reason)
        })`,
        status: 'failed' as SliceStatus,
        note: 'rejected',
        promptTokens: 0,
        completionTokens: 0,
        latencyMs: 0,
      };
    });

    // ── Phase 4: Review ──
    const reviewVerdict = await reviewDiffs({ collected, signal });

    // ── Phase 5: Aggregate ──
    const text = buildSummary(collected, reviewVerdict);

    const promptTokens = collected.reduce((acc, c) => acc + c.promptTokens, 0);
    const completionTokens = collected.reduce(
      (acc, c) => acc + c.completionTokens,
      0,
    );

    return {
      engine: 'claude-cli',
      model: MODEL_NAMES.opus,
      text,
      latencyMs: Date.now() - t0,
      usage: { promptTokens, completionTokens },
      mode: 'ultracoding',
      attempts: collected.map((c) => ({
        engine: 'claude-cli' as const,
        latencyMs: c.latencyMs,
        // `won` = this slice produced a usable diff.
        won: c.diffText.length > 0,
        error: c.status === 'done' ? undefined : c.note,
      })),
    };
  } finally {
    clearTimeout(totalTimer);
    if (opts.signal) opts.signal.removeEventListener('abort', onCallerAbort);
  }
}
