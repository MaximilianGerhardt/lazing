/**
 * lazyOS — workspace session orchestrator
 *
 * Owns the per-workspace Claude-Code CLI session lifecycle. Pre Stream A'
 * the design assumed a long-lived interactive `claude` process living
 * inside a tmux pane; we talked to it via `send-keys` and parsed `capture-
 * pane` output (stripping ANSI, detecting `●` tool-markers, sniffing for
 * the ready prompt). That approach works but is fragile — tmux pane width
 * affects wrapping, ANSI sequences drift between Claude-Code versions, and
 * race conditions between "prompt submitted" and "response started" are
 * real.
 *
 * **Stream A' empirical finding (2026-04-24):** Claude Code 2.1+ exposes
 *
 *   claude --print --input-format=stream-json --output-format=stream-json
 *          --include-partial-messages --session-id=<uuid>
 *
 * which emits the same shape of events we already mapped in the old SDK-
 * based server (message_start, content_block_delta, assistant frames with
 * tool_use blocks, user frames with tool_result blocks, final result
 * message). `--session-id` + `--resume <uuid>` preserves context across
 * invocations — that IS the "pro Workspace bleibt Context" promise from
 * the memory pin, just via disk-persisted session files instead of a
 * live tmux pane.
 *
 * So the current implementation: one Claude-CLI invocation per /chat
 * request, resuming the workspace's session-id. The tmux pane is kept as
 * a parallel human-attach surface (`lazyos-ws-<id>`) but is not on the
 * request path. That gives us robust JSONL streaming and lets Max still
 * `tmux attach -t lazyos-ws-X` for ad-hoc terminal work inside a
 * workspace.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAgentDb } from './db';
import {
  buildWorkspaceHandoff,
  persistWorkspaceHandoff,
  buildSessionHandoffBlock,
} from '@/lib/reasoning/auto-handoff';
import { formatSubchatContextBlock } from '@/lib/subchats/service';
import {
  assessRotation,
  effectiveAgeMs,
  rotationEnabled,
  rotationPolicyFromEnv,
  type RotationReason,
} from '@/lib/sessions/degradation-detector';
import { appendLedgerRow } from '../lib/chat/ledger';
import { openTranscript, transcriptPath, type TranscriptWriter } from './transcript-writer';
import { logPromptSent, logResponseReceived } from './chat-event-log';
import { emitChatMessageCompleted } from '../lib/events/emit';
import { onChatMessageCompleted } from '../lib/push/triggers';
import { recordTokens, waitForBudget } from '../lib/agents/tpm-budget';
import { MODEL_NAMES } from '../lib/agents/pricing';
import { BRAND_NAME } from '../lib/brand';
import { ulid } from '../lib/ulid';
import { defaultWorkspacePath, projectsRoot } from '../lib/workspaces/projects-root';
import type { ChatMessageToolCallSummary } from '../lib/events/types';
import {
  tmuxAvailable,
  sessionExists,
  createSession,
  killSession,
  listPanes,
  splitWindow,
  selectPane,
  sendKeysToPane,
  assertSafeSessionName,
} from './tmux-controller';
import { createSnapshotWriter, type SnapshotWriter } from './streaming-snapshots';

// ---------------------------------------------------------------------------
// DB access.
// ---------------------------------------------------------------------------

export interface ClaudeSessionRow {
  workspaceId: string;
  sessionId: string;
  claudeVersion: string | null;
  lastPromptAt: number;
  turnCount: number;
  tokenEstimate: number;
  lastResult: string | null;
  createdAt: number;
  rotatedAt: number | null;
  updatedAt: number;
}

export interface WorkspaceRow {
  id: string;
  path: string;
  label: string;
  sensitivity: string;
  archived: number;
}

/**
 * Root workspace = cross-workspace mode (handoff point 2). Virtual — not
 * in the workspaces table. Working directory = projects root, so the
 * agent sees all projects.
 */
export const ROOT_WORKSPACE_ID = '__root__';

function rootWorkspaceRow(): WorkspaceRow {
  return {
    id: ROOT_WORKSPACE_ID,
    path: projectsRoot(),
    label: 'Root · Cross-Workspace',
    sensitivity: 'low',
    archived: 0,
  };
}

export function getWorkspace(workspaceId: string): WorkspaceRow | null {
  if (workspaceId === ROOT_WORKSPACE_ID) return rootWorkspaceRow();
  const db = getAgentDb();
  const row = db
    .prepare('SELECT id, path, label, sensitivity, archived FROM workspaces WHERE id = ?')
    .get(workspaceId) as WorkspaceRow | undefined;
  return row ?? null;
}

/**
 * Chat tool access (2026-05-26) — closes the gap "Bash/WebFetch don't run in
 * the live chat".
 *
 * Cause: the chat spawn used `--print --permission-mode=acceptEdits` WITHOUT
 * `--allowedTools`. In `--print` (non-interactive) acceptEdits only accepts
 * file edits automatically; Bash/WebFetch/WebSearch need an approval
 * that does not exist non-interactively → they were silently denied. Pre-approval
 * via `--allowedTools` (like the executor in tmux-spawn) lets them run.
 *
 * Gating = the existing workspace permission mode (lazyos_permission_modes):
 *   - 'freerein' / 'freerein-with-audit' → ALL-ACCESS: Bash + WebFetch +
 *     WebSearch + file tools pre-approved. This is the deliberate owner
 *     authorization (UI toggle "full access" next to the engine pill).
 *   - everything else (ask/lane/unset) → today's safe behavior (edits only).
 *
 * Fail-closed: any error/missing row → no full access.
 */
export function resolveChatToolAccess(workspaceId: string): {
  fullAccess: boolean;
  allowedTools: string | null;
} {
  try {
    const db = getAgentDb();
    const row = db
      .prepare('SELECT mode FROM lazyos_permission_modes WHERE workspace_id = ? LIMIT 1')
      .get(workspaceId) as { mode?: string } | undefined;
    const mode = row?.mode;
    if (mode === 'freerein' || mode === 'freerein-with-audit') {
      return {
        fullAccess: true,
        // Comma-separated as ONE argv value (proven tmux-spawn pattern).
        allowedTools: 'Read,Edit,Write,Bash,Grep,Glob,WebFetch,WebSearch',
      };
    }
  } catch {
    /* fail-closed */
  }
  return { fullAccess: false, allowedTools: null };
}

/**
 * Determine the repo root robustly. This file lives under <repo>/server/, so
 * `..` is the repo root. We derive it from the module location (instead of
 * process.cwd(), which can differ depending on the systemd WorkingDirectory) — exactly
 * the same pattern as server/db.ts (PROJECT_ROOT).
 */
function resolveRepoRoot(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url)); // <repo>/server
    return path.resolve(here, '..');
  } catch {
    return process.cwd();
  }
}

/**
 * Absolute path to the PreToolUse Bash policy hook. Lives next to the other
 * agent scripts under server/agents/. Injected as `node <abs>.cjs`.
 */
function bashPolicyHookPath(): string {
  return path.join(resolveRepoRoot(), 'server', 'agents', 'bash-path-policy.cjs');
}

/**
 * Builds the `--settings` JSON string that registers the Bash workspace-path
 * policy hook as a PreToolUse matcher on `Bash`. Empirically verified (claude
 * 2.1.150): `--settings '<json>'` accepts the JSON string directly and merges
 * with the global ~/.claude/settings.json. The hook decides allow (exit 0,
 * no stdout) vs. deny (deny-JSON on stdout).
 *
 * Use ONLY in the fullAccess branch — if the agent does not get pre-approved
 * Bash access anyway, no Bash guardrail is needed.
 */
export function buildBashPolicySettingsJson(): string {
  return JSON.stringify({
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [
            {
              type: 'command',
              command: `node ${bashPolicyHookPath()}`,
              timeout: 5000,
            },
          ],
        },
      ],
    },
  });
}

/**
 * Returns the `--settings` argv fragments for the Bash policy hook — but ONLY
 * in the fullAccess branch. For non-fullAccess: empty array (no hook). Spread
 * exactly like this into the `args` of `sendPrompt`; testable as an exported
 * pure function without spawning `claude`.
 */
export function bashPolicyArgs(fullAccess: boolean): string[] {
  if (!fullAccess) return [];
  return ['--settings', buildBashPolicySettingsJson()];
}

function getClaudeSession(
  workspaceId: string,
  db: ReturnType<typeof getAgentDb> = getAgentDb(),
): ClaudeSessionRow | null {
  const row = db
    .prepare(
      `SELECT workspace_id AS workspaceId,
              session_id   AS sessionId,
              claude_version AS claudeVersion,
              last_prompt_at AS lastPromptAt,
              turn_count    AS turnCount,
              COALESCE(token_estimate, 0) AS tokenEstimate,
              last_result   AS lastResult,
              created_at    AS createdAt,
              rotated_at    AS rotatedAt,
              updated_at    AS updatedAt
         FROM claude_sessions
        WHERE workspace_id = ?`,
    )
    .get(workspaceId) as ClaudeSessionRow | undefined;
  return row ?? null;
}

function upsertClaudeSession(row: {
  workspaceId: string;
  sessionId: string;
  claudeVersion?: string | null;
  lastResult?: string | null;
  turnIncrement?: number;
  tokenIncrement?: number;
}): void {
  const db = getAgentDb();
  const now = Date.now();
  const existing = getClaudeSession(row.workspaceId);
  if (!existing) {
    db.prepare(
      `INSERT INTO claude_sessions
         (workspace_id, session_id, claude_version, last_prompt_at, turn_count, token_estimate, last_result, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.workspaceId,
      row.sessionId,
      row.claudeVersion ?? null,
      now,
      row.turnIncrement ?? 0,
      row.tokenIncrement ?? 0,
      row.lastResult ?? null,
      now,
      now,
    );
    return;
  }
  db.prepare(
    `UPDATE claude_sessions
        SET session_id     = ?,
            claude_version = COALESCE(?, claude_version),
            last_prompt_at = ?,
            turn_count     = turn_count + ?,
            token_estimate = COALESCE(token_estimate, 0) + ?,
            last_result    = COALESCE(?, last_result),
            updated_at     = ?
      WHERE workspace_id = ?`,
  ).run(
    row.sessionId,
    row.claudeVersion ?? null,
    now,
    row.turnIncrement ?? 0,
    row.tokenIncrement ?? 0,
    row.lastResult ?? null,
    now,
    row.workspaceId,
  );
}

export function resetClaudeSession(workspaceId: string): void {
  const db = getAgentDb();
  db.prepare('DELETE FROM claude_sessions WHERE workspace_id = ?').run(workspaceId);
}

export interface RotateResult {
  rotated: boolean;
  reason: RotationReason | 'handoff-persist-failed';
  newSessionId?: string;
  handoffWritten?: boolean;
}

/**
 * FAIL-CLOSED session rotation: FIRST persist a handoff (so the
 * running context — decisions, beliefs, open points, plan state — lands in
 * `workspaces.notes` and is re-injected by the NEXT fresh session via
 * buildLazyosSystemPrompt), and rotate ONLY if the persist did
 * NOT throw. A "skip" (empty handoff / foreign notes source) is NOT an
 * error — empty = nothing to lose; foreign/manual notes are re-injected at
 * session start anyway. Only a real DB throw blocks the rotation.
 *
 * Rotation = new UUID + bookkeeping (prev_session_id/rotation_count/reason),
 * turn_count + token_estimate back to 0, last_result NULL. The next
 * ensureSession() then returns isNew=true → fresh --session-id instead of --resume.
 */
export interface RotateDeps {
  /** Override for tests; default = getAgentDb(). */
  db?: ReturnType<typeof getAgentDb>;
  /** Persists the handoff; THROWS ⇒ no rotation. Default = build+persist. */
  persist?: (
    db: ReturnType<typeof getAgentDb>,
    workspaceId: string,
  ) => { written: boolean };
  newId?: () => string;
  now?: () => number;
}

export function rotateSessionWithHandoff(
  workspaceId: string,
  reason: RotationReason,
  deps: RotateDeps = {},
): RotateResult {
  const db = deps.db ?? getAgentDb();
  const newIdFn = deps.newId ?? randomUUID;
  const nowFn = deps.now ?? Date.now;
  const persistFn =
    deps.persist ??
    ((d, ws): { written: boolean } =>
      persistWorkspaceHandoff(d, ws, buildWorkspaceHandoff(d, ws)));

  const prev = getClaudeSession(workspaceId, db);
  if (!prev) return { rotated: false, reason };

  // 1. Persist the handoff fail-closed. The order is critical: first the
  //    handoff (succeeds/skips), THEN replace the UUID — if the persist throws,
  //    the session stays UNCHANGED (no context loss).
  let handoffWritten = false;
  try {
    const res = persistFn(db, workspaceId);
    handoffWritten = res.written;
  } catch (err) {
    console.warn(
      `[workspace-session] rotation handoff-persist failed for ${workspaceId} — NICHT rotiert:`,
      err instanceof Error ? err.message : err,
    );
    return { rotated: false, reason: 'handoff-persist-failed' };
  }

  // 2. Rotate (new UUID, bookkeeping, reset budgets).
  const newId = newIdFn();
  const now = nowFn();
  try {
    const res = db.prepare(
      `UPDATE claude_sessions
          SET session_id      = ?,
              prev_session_id = ?,
              rotation_count  = COALESCE(rotation_count, 0) + 1,
              rotated_at      = ?,
              rotation_reason = ?,
              turn_count      = 0,
              token_estimate  = 0,
              last_result     = NULL,
              last_prompt_at  = ?,
              updated_at      = ?
        WHERE workspace_id = ? AND session_id = ?`,
      // MED-2 (review): condition the UPDATE on the previously read UUID. If a
      // concurrent request has already rotated, session_id != prev.sessionId
      // → changes=0 → we do NOT rotate again (no UUID clobber/orphaned
      // session). The handoff was then persisted twice (harmless).
    ).run(newId, prev.sessionId, now, reason, now, now, workspaceId, prev.sessionId);
    if ((res as { changes?: number }).changes === 0) {
      return { rotated: false, reason };
    }
  } catch (err) {
    console.warn(
      `[workspace-session] rotation UPDATE failed for ${workspaceId}:`,
      err instanceof Error ? err.message : err,
    );
    return { rotated: false, reason };
  }

  return { rotated: true, reason, newSessionId: newId, handoffWritten };
}

/**
 * Task boundary: a plan/workstream is cleanly completed → a fresh session for
 * the next task (best practice: one session per coding task, provided
 * the session has already done work). Idempotent + fail-soft; rotates only if
 * the detector (with taskBoundary=true) agrees.
 *
 * NOTE: deliberately NOT (yet) wired into the workstream-completion paths —
 * an auto-rotation on workstream end would interrupt a running operator chat
 * session mid-conversation (worse output). Available for
 * an explicit "new task" action. The degradation rotation in ensureSession
 * (turn/token/age budget) is the active path.
 */
export function rotateSessionOnTaskBoundary(workspaceId: string): RotateResult {
  if (!rotationEnabled()) return { rotated: false, reason: 'none' };
  const sess = getClaudeSession(workspaceId);
  if (!sess) return { rotated: false, reason: 'none' };
  const decision = assessRotation(
    {
      turnCount: sess.turnCount,
      tokenEstimate: sess.tokenEstimate,
      ageMs: effectiveAgeMs(sess.createdAt, sess.rotatedAt, Date.now()),
      lastResult: sess.lastResult,
    },
    /* taskBoundary */ true,
    rotationPolicyFromEnv(),
  );
  if (!decision.rotate) return { rotated: false, reason: 'none' };
  return rotateSessionWithHandoff(workspaceId, decision.reason);
}

/**
 * Reads the workspace notes maintained manually or via AI
 * (mini-CLAUDE.md). Injected into every system prompt as the topmost block
 * so the AI knows workspace-specific conventions +
 * priorities — without having to guess them from the event log.
 */
function readWorkspaceNotes(workspaceId: string): string | null {
  try {
    const db = getAgentDb();
    const row = db
      .prepare('SELECT notes FROM workspaces WHERE id = ?')
      .get(workspaceId) as { notes?: string | null } | undefined;
    const txt = row?.notes?.trim() ?? '';
    if (txt.length === 0) return null;
    // Hard cap: 8KB so the system prompt does not explode. Notes
    // may in principle be longer (max 50KB in the editor), but in the
    // prompt context 8KB is the pain threshold.
    return txt.length > 8000 ? txt.slice(0, 8000) + '\n\n[...notes truncated]' : txt;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Session lifecycle.
// ---------------------------------------------------------------------------

const TMUX_PREFIX = 'lazyos-ws-';

export function tmuxSessionName(workspaceId: string): string {
  // tmux session names only allow `[a-z0-9_-]` (see assertSafeSessionName).
  // Org-root pseudo-workspaces carry the form `__org_root__:<orgId>` — the
  // `:` (and any other special character) would otherwise break session creation
  // → "unsafe session name" → chat dead in the org-root context (fix 2026-05-23).
  // Mapping to `-` is deterministic (same workspace ID ⇒ same session).
  const safe = workspaceId.replace(/[^a-z0-9_-]/gi, '-');
  return TMUX_PREFIX + safe;
}

export interface SessionHandle {
  workspaceId: string;
  workspacePath: string;
  sessionId: string;     // Claude-Code session UUID
  tmuxSession: string;   // lazyos-ws-<id>
  tmuxAttachable: boolean;
  isNew: boolean;        // true if we just created the Claude session
}

/**
 * Ensure a workspace has:
 *   1. A row in `claude_sessions` with a valid session-id (created if missing).
 *   2. A matching tmux session `lazyos-ws-<id>` (created if missing and tmux
 *      is available — not fatal if tmux is down, chat still works).
 *
 * Returns the handle needed for `sendPrompt`.
 */
export async function ensureSession(workspaceId: string): Promise<SessionHandle> {
  const ws = getWorkspace(workspaceId);
  if (!ws) {
    throw new Error(`workspace_not_found: ${workspaceId}`);
  }
  if (ws.archived === 1) {
    throw new Error(`workspace_archived: ${workspaceId}`);
  }

  // Fix A2 (2026-06-02): if `workspaces.path` is empty, fall back to the
  // deterministic default path (`<LAZYOS_PROJECTS_ROOT>/<id>`)
  // and create the directory. Otherwise the Claude CLI spawns with cwd='' → the
  // agent cannot write files → a "build me this" intent falls back to
  // clarifying questions instead of building (the brainstorm→build loop). Best-effort;
  // an explicit DB path always wins.
  const resolvedPath =
    ws.path && ws.path.trim().length > 0 ? ws.path : defaultWorkspacePath(workspaceId);
  try {
    mkdirSync(resolvedPath, { recursive: true });
  } catch (err) {
    console.warn(
      `[workspace-session] mkdir workspacePath failed for ${workspaceId} (non-fatal):`,
      err instanceof Error ? err.message : err,
    );
  }

  let sess = getClaudeSession(workspaceId);
  let isNew = false;
  if (!sess) {
    const newId = randomUUID();
    upsertClaudeSession({ workspaceId, sessionId: newId });
    sess = getClaudeSession(workspaceId);
    if (!sess) {
      throw new Error(`claude_session_insert_failed: ${workspaceId}`);
    }
    isNew = true;
  } else if (sess.turnCount === 0 && sess.lastResult !== 'error') {
    // Row exists (e.g. after /session/restart) but no turn has successfully
    // run yet AND no prior error has been recorded — Claude-CLI has no
    // transcript file for this UUID, but reuse is safe.
    // Use --session-id rather than --resume to prime it.
    //
    // 2026-05-07 fix: removed the case where last_result='error' would also
    // hit this branch — that produced a deadlock where Claude-CLI saw the
    // orphaned UUID, exited empty, set last_result='error' again, and the
    // next request would reuse the same broken UUID. Now a turn_count=0 +
    // last_result='error' row falls through to the harder reset below.
    isNew = true;
  } else if (sess.lastResult === 'error') {
    // Self-heal 2026-04-25: if the last turn was `error_during_execution`
    // (transcript corrupt, the Claude CLI cannot resume the session),
    // we would otherwise spin forever — every new request produces
    // the same error. Instead: discard the old session, generate a fresh
    // UUID. The conversation history is lost, but the user
    // can chat again.
    console.warn(
      `[workspace-session] previous turn errored for ${workspaceId}, starting fresh session`,
    );
    const newId = randomUUID();
    getAgentDb()
      .prepare('DELETE FROM claude_sessions WHERE workspace_id = ?')
      .run(workspaceId);
    upsertClaudeSession({ workspaceId, sessionId: newId });
    sess = getClaudeSession(workspaceId);
    if (!sess) throw new Error(`claude_session_reset_failed: ${workspaceId}`);
    isNew = true;
  }

  // Autonomous degradation rotation (2026-06-03): before we continue an EXISTING
  // session via --resume, we check whether it is degraded (too many
  // turns / too much token proxy / too old / CLI turn cap reached). If so:
  // persist the handoff (fail-closed) + rotate to a fresh UUID — the
  // fresh session re-injects the handoff via buildLazyosSystemPrompt. NOT
  // when last_result='error' (the self-heal path above handles that).
  if (sess && !isNew && rotationEnabled()) {
    const now = Date.now();
    const decision = assessRotation(
      {
        turnCount: sess.turnCount,
        tokenEstimate: sess.tokenEstimate,
        // CRIT-1: age since the LAST rotation, not since created_at —
        // otherwise a session older than maxAge would rotate every turn (loop).
        ageMs: effectiveAgeMs(sess.createdAt, sess.rotatedAt, now),
        lastResult: sess.lastResult,
      },
      /* taskBoundary */ false,
      rotationPolicyFromEnv(),
    );
    if (decision.rotate) {
      const r = rotateSessionWithHandoff(workspaceId, decision.reason);
      if (r.rotated) {
        console.info(
          `[workspace-session] session rotated for ${workspaceId} (${decision.reason}): ${decision.detail}`,
        );
        sess = getClaudeSession(workspaceId) ?? sess;
        isNew = true;
      }
    }
  }

  const tmuxName = tmuxSessionName(workspaceId);
  assertSafeSessionName(tmuxName);
  let tmuxAttachable = false;
  if (await tmuxAvailable()) {
    try {
      await ensureMirrorLayout(tmuxName, workspaceId, resolvedPath, ws.label);
      tmuxAttachable = true;
    } catch (err) {
      // Tmux failure is non-fatal — Claude-CLI works without it, the tmux
      // pane is only for human attach.
      console.warn(
        `[workspace-session] tmux mirror layout failed for ${workspaceId}:`,
        err instanceof Error ? err.message : err,
      );
      tmuxAttachable = false;
    }
  }

  return {
    workspaceId,
    workspacePath: resolvedPath,
    sessionId: sess.sessionId,
    tmuxSession: tmuxName,
    tmuxAttachable,
    isNew,
  };
}

/**
 * Guarantee that the tmux session `lazyos-ws-<id>` has our two-pane mirror
 * layout:
 *
 *   pane 0 (top, 30%):  tail -f /tmp/lazyos-transcript-<id>.log
 *   pane 1 (bottom, 70%): interactive Bash rooted in the workspace cwd
 *
 * Rules:
 *   - If the session doesn't exist → create fresh with the full layout.
 *   - If it exists but has only 1 pane (legacy / pre-Option-C) → kill +
 *     recreate with the layout. This is the migration path for sessions
 *     created by the single-pane version of this file.
 *   - If it exists with ≥2 panes AND pane 0's command is `tail` (any flavour
 *     — `tail`, `tail -F`, etc.) → leave it alone, layout is already good.
 *   - If pane 0 is NOT a tail (someone typed into it manually and shell
 *     replaced `tail`) → leave it alone too; that's the user's choice and
 *     killing the session would nuke their work. We only guarantee layout
 *     on first creation.
 *
 * The transcript file is touched before split so `tail -f` has something to
 * open immediately (otherwise it spins until the first write).
 */
async function ensureMirrorLayout(
  sessionName: string,
  workspaceId: string,
  workspacePath: string,
  workspaceLabel: string,
): Promise<void> {
  assertSafeSessionName(sessionName);
  const transcriptFile = transcriptPath(workspaceId);

  // Always make sure the transcript file exists (tail -f vs missing file
  // starts with an error message in some tail versions; coreutils tail is
  // fine but GNU tail -F is nicer).
  try {
    closeSync(openSync(transcriptFile, 'a'));
  } catch {
    /* EACCES / ENOSPC — we'll still try to create the session, pane 0
       tail will show the error and pane 1 bash still works */
  }

  const exists = await sessionExists(sessionName);

  if (!exists) {
    await createMirrorSession(sessionName, workspaceId, workspacePath, workspaceLabel);
    return;
  }

  // Session exists — inspect pane count.
  let panes = await listPanes(sessionName);
  if (panes.length < 2) {
    // Legacy single-pane layout → migrate.
    console.warn(
      `[workspace-session] migrating legacy single-pane session ${sessionName} → mirror layout`,
    );
    try {
      await killSession(sessionName);
    } catch {
      /* non-fatal */
    }
    await createMirrorSession(sessionName, workspaceId, workspacePath, workspaceLabel);
    return;
  }
  // Two or more panes → layout is already mirror-shaped (or user-customised).
  // Leave it as-is.
}

async function createMirrorSession(
  sessionName: string,
  workspaceId: string,
  workspacePath: string,
  workspaceLabel: string,
): Promise<void> {
  const transcriptFile = transcriptPath(workspaceId);

  // Pane 0 is created by new-session; it runs `tail -F` against the log.
  // We use `tail -F` (capital F) so it survives log rotation / truncation
  // (which openTranscript does on open if the file is huge).
  //
  // Then we split below to create pane 1 — the user-facing bash in cwd.
  await createSession({
    name: sessionName,
    cwd: workspacePath,
    command: `/bin/sh -c 'echo "${BRAND_NAME} · Workspace: ${escapeShell(workspaceLabel)} · attach via: tmux attach -t ${sessionName}"; echo "─── Live Chat Transcript ───"; exec tail -F ${transcriptFile}'`,
    env: { HOME: process.env.HOME ?? '/root' },
  });

  // Give tmux ~100ms to fully boot the session before we split it. In
  // practice new-session returns only after the pane is live, but tmux
  // occasionally races with a very-fast subsequent split-window.
  await sleep(100);

  // Split-v with percent=70 → the NEW pane (bash) takes 70%, the original
  // (tail) keeps 30%. This matches the spec: top 30% transcript, bottom
  // 70% workspace.
  await splitWindow({
    name: sessionName,
    direction: 'v',
    percent: 70,
    cwd: workspacePath,
  });

  // tmux's `pane-base-index` may be 0 OR 1 depending on user config. Read
  // the actual indices back and treat them positionally: first pane is the
  // original (tail), second is the split we just created (bash).
  let bashPaneIndex = 1;
  try {
    const panes = (await listPanes(sessionName)).slice().sort((a, b) => a.index - b.index);
    if (panes.length >= 2) {
      bashPaneIndex = panes[1]!.index;
    }
  } catch {
    /* fall back to static 1 — will be wrong on base-index=1 configs but
       the split still produced a usable layout, just banner lands in
       tail pane. Not a deal-breaker. */
  }

  // Make the bash pane the active pane so `attach` lands there by default
  // — user usually wants to type, not watch.
  try {
    await selectPane(sessionName, bashPaneIndex);
  } catch {
    /* non-fatal */
  }

  // Small banner in the bash pane so users know where they are.
  try {
    await sendKeysToPane(
      sessionName,
      bashPaneIndex,
      `clear && echo "${BRAND_NAME} · ${workspaceLabel} (${workspaceId}) · ${workspacePath}"`,
      true,
    );
  } catch {
    /* non-fatal — banner is cosmetic */
  }
}

function escapeShell(s: string): string {
  // Single-quote-safe escape for embedding into a `/bin/sh -c '...'` command.
  return s.replace(/['"`$\\]/g, '_').slice(0, 120);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function restartSession(workspaceId: string): Promise<SessionHandle> {
  resetClaudeSession(workspaceId);
  const tmuxName = tmuxSessionName(workspaceId);
  try {
    await killSession(tmuxName);
  } catch (err) {
    // Non-fatal.
    console.warn(
      `[workspace-session] tmux killSession ${tmuxName} warning:`,
      err instanceof Error ? err.message : err,
    );
  }
  return ensureSession(workspaceId);
}

// ---------------------------------------------------------------------------
// Claude-CLI event shapes. These mirror the stream-json envelopes emitted
// by `claude --print --output-format=stream-json --include-partial-messages`.
// Kept permissive — unknown fields are ignored, unknown event types pass
// through to `unknown` with the raw JSON attached.
// ---------------------------------------------------------------------------

export type ClaudeToolInput = Record<string, unknown>;

export type ParsedEvent =
  | { kind: 'ready'; sessionId: string }
  | { kind: 'token'; text: string }
  | {
      kind: 'tool_call';
      id: string | null;
      name: string;
      inputPreview: string;
    }
  | {
      kind: 'tool_result';
      toolUseId: string | null;
      isError: boolean;
      outputPreview: string;
    }
  | {
      kind: 'done';
      subtype: string | null;
      durationMs: number | null;
      numTurns: number | null;
      isError: boolean;
      tooManyTurns: boolean;
      resultText: string | null;
      sessionId: string | null;
    }
  | { kind: 'error'; message: string }
  | { kind: 'permission_denied'; tool: string | null; reason: string | null };

// ---------------------------------------------------------------------------
// Spawn + stream Claude Code.
// ---------------------------------------------------------------------------

export interface SendPromptOpts {
  workspaceId: string;
  prompt: string;
  signal: AbortSignal;
  onEvent: (event: ParsedEvent) => void;
  /** Extra env for the child process (merged over process.env). */
  extraEnv?: Record<string, string>;
  /**
   * Phase MU.3 — when set, the spawn loads the user's own Claude-MAX
   * credentials (provided claude_max_status='own') instead of the shared system
   * token. For 'shared' or no binding: the system HOME stays active.
   */
  userId?: string;
  /** Bump this only for debugging — breaking out of session context. */
  forceFreshSession?: boolean;
  /** Cap on output bytes; safety net against runaway generations. */
  maxOutputBytes?: number;
  /** Request-ID from the HTTP layer; used as entity_id in the chat-event-log. */
  reqId?: string;
  /**
   * Phase MS · 2026-04-26 (P1-2): called with the ULID of the persisted
   * `chat_message_completed` event so the caller can pass it on as the
   * SSE frame `result_event_id` to the client. The
   * client then sets this ID as HistoryItem.id, by which dedup against
   * the live event stream matches (echo filter).
   */
  onResultEventId?: (eventId: string) => void;
  /**
   * Streaming recovery V2 (2026-04-27). When set: every 1500 ms the
   * current `partial_content` plus the `in_code_block` flag and active
   * tool call are UPSERTed into `streaming_snapshots`. Before persisting
   * `chat_message_completed`, a final flush + DELETE of the row is
   * performed. If the server is killed before that happens, the
   * row stays — the history endpoint shows it as `aborted` after 10 s.
   *
   * Identical to the `pendingPromptId` from `chat_message_sent` (payload
   * field + entityId of the sent event).
   */
  pendingPromptId?: string;
  /**
   * 2-stage model (owner 2026-06-03). When true, this turn's claude spawn
   * gets `--effort <thinkingBudget>` (default 'high') — deeper
   * thinking when a multi-step intent is detected. Missing/false → NO
   * `--effort` (fast turn, today's default behavior). `--effort` is
   * the native reasoning-depth lever of the claude CLI (low/medium/high/xhigh/max).
   */
  thinking?: boolean;
  thinkingBudget?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

/**
 * Build the lazyOS-awareness system-prompt append.
 *
 * This gets concatenated with Claude Code's default system prompt every
 * turn — so every token here is paid on every /chat call. Keep it lean.
 *
 * Contract:
 *   - Tell Claude WHICH workspace it's in (substituted live).
 *   - Tell Claude that `lazyos-cli` exists and what it does.
 *   - Give exactly the commands it will need, with correct syntax.
 *   - Do NOT reproduce the full usage page; Claude can `lazyos-cli --help`
 *     itself if unsure.
 *
 * Changing this requires a session-server restart (or a new workspace
 * session) to take effect, because Claude Code caches the initial
 * system-prompt per session.
 */
function buildLazyosSystemPrompt(workspaceId: string): string {
  const isRoot = workspaceId === ROOT_WORKSPACE_ID;
  const ws = JSON.stringify(workspaceId);
  if (isRoot) {
    return buildRootSystemPrompt();
  }
  // Workspace-specific notes (mini-CLAUDE.md from the DB) are injected
  // up front. This way the AI sees priorities + conventions + what NOT
  // to start BEFORE it decides about tickets. On error
  // (notes empty / DB glitch) the pre-block is simply dropped.
  const wsNotes = readWorkspaceNotes(workspaceId);
  const notesBlock = wsNotes
    ? [
        '## Workspace-Notes (vom User gepflegt — autoritativ)',
        '',
        wsNotes,
        '',
        '---',
        '',
      ]
    : [];
  // A6 (Self-Learning/Auto-Handoff): the workspace-bound memory —
  // prior rationales, established convictions, open decisions,
  // aggregated live from the reasoning tables. This way the AI "remembers" at
  // start without needing an explicit end hook. AFTER the user notes
  // (those stay authoritative); strictly fail-soft (read error ⇒ no block, never
  // break the prompt); workspace-scoped (N9); secret-redacted (auto-handoff).
  // Extracted + round-trip tested (lib/reasoning/__tests__/handoff-roundtrip):
  // builds the handoff block (build → render → separator), fail-soft = [].
  const handoffBlock = buildSessionHandoffBlock(getAgentDb(), workspaceId, {
    maxChars: 4000,
  });
  // Always-on subchat context (2026-06-03): the most recent customer communication
  // of this workspace — injected UNCONDITIONALLY (not query-driven), so
  // the main chat ALWAYS knows the subchat knowledge (owner: "must be recognized").
  const subchatCtx = formatSubchatContextBlock(workspaceId);
  const subchatBlock = subchatCtx ? [subchatCtx, '', '---', ''] : [];
  return [
    ...notesBlock,
    ...handoffBlock,
    ...subchatBlock,
    `## ${BRAND_NAME}-Integration`,
    `Du läufst als ${BRAND_NAME}-Agent im Workspace ${ws}.`,
    '',
    'Neben Read/Write/Edit/Bash/Grep/Glob/WebSearch hast du Zugriff auf',
    `die ${BRAND_NAME}-API über das CLI-Tool \`lazyos-cli\` (via Bash aufrufen).`,
    'Es gibt JSON auf stdout, Fehler auf stderr mit Exit-Code ≠ 0.',
    '',
    'Wichtige Commands:',
    `  lazyos-cli ticket create ${ws} "<Titel>" --priority=P1 --body="..."`,
    `  lazyos-cli ticket list --workspace=${ws} [--status=open|done|danger|wait]`,
    '  lazyos-cli ticket get <id>',
    '  lazyos-cli ticket update <id> --status=done',
    '  lazyos-cli ticket timeline <id>',
    '  lazyos-cli workspace list',
    '  lazyos-cli heartbeat status',
    '  lazyos-cli routine list',
    '  lazyos-cli routine trigger <id>',
    '  lazyos-cli push send "<Titel>" "<Body>" [--url=/tickets/<id>]',
    `  lazyos-cli cloud list ${ws} [--folder=<id>]            # was liegt in der Workspace-Cloud`,
    `  lazyos-cli cloud stats ${ws}                           # Counts + Bytes`,
    `  lazyos-cli cloud upload ${ws} <local-file>             # lokale Datei in die Cloud heben`,
    `  lazyos-cli cloud generate ${ws} --md-file=<path> --title="..."  # Markdown→PDF generieren + Cloud-Upload`,
    `  lazyos-cli cloud generate ${ws} --xlsx-file=<json> --title="..." # JSON→XLSX (Excel) — Kosten/Reports/Pricing. JSON: {"sheets":[{"name":"...","headers":["A","B"],"rows":[["x",1]]}]}. Werte verbatim (N1). Lokal, kein Cloud-Sandbox (N2).`,
    `  lazyos-cli cloud generate ${ws} --docx-file=<md> --title="..."   # Markdown→DOCX (Word) — Angebote/Verträge/Reports als editierbares Word.`,
    `  lazyos-cli cloud generate ${ws} --pptx-file=<json> --title="..." # JSON→PPTX (PowerPoint) — einfache Kunden-Pitches. JSON: {"subtitle":"...","slides":[{"title":"...","bullets":["..."]}]}. N1 verbatim.`,
    `  lazyos-cli cloud generate ${ws} --html-file=<html> --landscape --title="..." # HTML→PDF (Design-Deck). BEVORZUGT für schöne Pitches/Decks/Visuals: gestalte ein HTML-Deck (laz.ing Pitch-Black/Glows, je Folie ein <section>, @page size:1280px 720px) und binde generierte Bilder ein (via /image ODER /api/imagegen → previewUrl). Sieht deutlich besser aus als pptx.`,
    '  lazyos-cli cloud delete <artifact-id>                   # soft-delete + storage-cleanup',
    '',
    'WICHTIG — EINZELNES BILD/Foto/Logo/Grafik/Illustration: NIEMALS selbst per HTML/Bash/',
    'Screenshot/ffmpeg faken (das gibt kein echtes Bild + keine Vorschau). Echte Bilder',
    'erzeugt NUR das ImageGen2-Surface. Sag dem User schlicht, er soll `/image <beschreibung>`',
    'tippen (ODER er formuliert „erstelle ein Bild von …" — das routet automatisch dorthin).',
    'Das zeigt eine animierte Lade-Karte + das fertige Bild als Vorschau im Chat. NUR für',
    'mehrseitige DOKUMENTE/Decks nutzt du cloud generate (PDF/DOCX/XLSX/HTML-Deck) oben.',
    '  lazyos-cli system restart [--services=agent,web]        # Phase AR: Service-Refresh nach Code-Aenderungen, autonom erlaubt',
    '  lazyos-cli system status                                # Health der Services',
    '',
    'Regeln:',
    `- Wenn der User sagt "leg ein Ticket an": nutze sofort \`lazyos-cli ticket create ${ws} ...\`.`,
    '  Nicht planen, nicht nachfragen — einfach anlegen. Fehlt der Titel, frag EINMAL kurz nach.',
    '- Wenn der User fragt "was ist offen / welche Tickets / To-dos":',
    `  rufe \`lazyos-cli ticket list --workspace=${ws} --status=open\` auf und fasse zusammen.`,
    '- Für beliebige Aktionen, die Max in der UI sehen soll (Push, Heartbeat, Routine):',
    '  nutze das CLI statt nur davon zu reden.',
    '- Unsicher, ob ein Command existiert? `lazyos-cli --help` lesen, nicht raten.',
    '- Prio-Werte: P0 (Deal-Breaker), P1 (wichtig), P2 (nice-to-have), P3 (backlog).',
    '- Status-Werte: open (aktiv), done (erledigt), danger (blockiert), wait (wartet auf Input).',
    '',
    '### BAU-MODUS (2026-06-02 · Codex-/Claude-Code-artig)',
    'Wenn der User etwas KONKRETES bauen/erstellen will (eine App, ein Prototyp,',
    'eine HTML-Seite, ein Skript, eine Datei) — **bau es sofort**: leg die Datei(en)',
    'mit Write/Edit in deinem Arbeitsverzeichnis (cwd) an und zeig das Ergebnis',
    '(`<surface:terminal>` mit `ls`/Pfad + 1-2 Sätze, was du gebaut hast und wie man',
    'es öffnet). Dein cwd ist beschreibbar — du DARFST dort Dateien anlegen.',
    '**NICHT** in einer Klärungs-Schleife nachfragen ("womit starten wir?"): bei',
    'einem klaren Auftrag wie „leg los" / „bau das" baust du eine sinnvolle erste',
    'Version mit vernünftigen, kurz dokumentierten Default-Annahmen und iterierst',
    'DANN auf Feedback. Eine einzelne kurze Rückfrage ist nur OK, wenn ohne sie',
    'gar nicht sinnvoll gestartet werden kann — sonst: bauen.',
    '',
    'Antworte dem User auf Deutsch (Max\' Präferenz), es sei denn er fragt bewusst auf Englisch.',
    '',
    '## Surface-First Mindset (PFLICHT)',
    '',
    'Dein Chat rendert spezielle XML-ähnliche Tags als echte UI-Karten aus der',
    'LazyOS-Design-Library. **Jede sinnvolle Antwort enthält mindestens EIN**',
    '`<surface:TYPE>{json}</surface:TYPE>` — nicht nur wenn der User explizit',
    `danach fragt. Das ist das transformative ${BRAND_NAME}-UI-Prinzip.`,
    '',
    '**Regel 1 — Keine ASCII-Art, keine Text-Tabellen, keine Plain-JSON-Dumps.**',
    'Wenn du Daten zeigst → Surface-Card. Wenn du Output zeigst → Surface-Card.',
    '',
    '**Regel 2 — Freitext kurz.** Max 1-2 Sätze umgebender Text. Die Karte ist die Antwort.',
    '',
    '**Regel 3 — Tags NICHT in Markdown-Codeblocks (keine Backticks drumrum!).**',
    'Schreib den Tag direkt in deine Antwort, so wie eine eingebettete Komponente.',
    '',
    '### Surface-Katalog (12 Kinds):',
    '',
    '`<surface:chart>{"title":"PV-Ertrag 2026","value":"10.380 kWh/a","data":[320,480,820,1100,1320,1410,1440,1280,950,620,360,280]}</surface:chart>`',
    '  LineChart (data=number[]) oder BarChart (bars=[{height:0-100, variant?}]).',
    '  Wenn User nach Zahlen/Trend/Stand fragt → IMMER Chart-Surface.',
    '',
    '`<surface:ticket>{"id":"TCK-4281","status":"open","prio":"P1","title":"...","body":"...","segment":"demo-client","assignee":"Claude","due":"14.05."}</surface:ticket>`',
    '  Ticket-Karte. status: open|done|danger|wait. Nach jedem `lazyos-cli ticket create`',
    '  antworte mit Ticket-Surface (ID aus CLI-Output). Nie nur „Ticket TCK-XY angelegt."',
    '',
    '`<surface:decision>{"headline":"Freigabe X","sub":"Kontext","options":[{"id":"a","label":"Ja","recommended":true},{"id":"b","label":"Nein"}]}</surface:decision>`',
    '  Multi-Option-Entscheidung. Bei Ambiguitäten, Approval-Requests, Pfad-Wahlen.',
    '',
    '`<surface:quickchoice>{"options":[{"id":"yes","label":"Ja","primary":true},{"id":"no","label":"Nein"}]}</surface:quickchoice>`',
    '  2-3 Buttons für schnelle Ja/Nein/Dossier-Entscheidungen. Kürzer als decision.',
    '',
    '`<surface:approval>{"ticketId":"TCK-XYZ","title":"Freigabe X","sub":"..."}</surface:approval>`',
    '  Approve/Reject-Knöpfe die direkt zum Ticket linken. Für Workflow-State=review.',
    '',
    '`<surface:invoice>{"number":"RE-2026-0142","status":"draft","title":"...","totalAmount":"14.018,20 €","lines":[{"label":"...","amount":"..."}]}</surface:invoice>`',
    '  Rechnung-Karte. status: draft | sent | paid | overdue.',
    '',
    '`<surface:pipeline>{"steps":[{"num":1,"title":"...","status":"done"},{"num":2,"title":"...","status":"running"}]}</surface:pipeline>`',
    '  Pipeline-Stufen. status: done | running | waiting.',
    '',
    '`<surface:terminal>{"lines":[{"text":"$ git status","spans":[{"text":"$","level":"prompt"},{"text":" git status"}]},{"text":"clean","spans":[{"text":"clean","level":"ok"}]}]}</surface:terminal>`',
    '  Shell-Output rendern nach Bash-Calls. Levels: host|prompt|dim|error|ok|claude|codex.',
    '  IMMER Terminal-Surface zeigen wenn du Bash-Output als Ergebnis hast.',
    '',
    '`<surface:toast>{"variant":"warn","iconGlyph":"!","title":"DATEV-Token läuft ab","body":"heute 00:00"}</surface:toast>`',
    '  Notification/Warnung. variant: default | ok | warn | err.',
    '',
    '`<surface:heartbeat>{"count":8,"label":"Workspaces aktiv","ariaLabel":"..."}</surface:heartbeat>`',
    '  Heartbeat-Pulse für Projekt-Status/Übersicht.',
    '',
    '`<surface:workspace>{"label":"Demo PV","variant":"clientb"}</surface:workspace>`',
    '  Workspace-Pill inline. variant = accent.',
    '',
    '`<surface:routine>{"name":"morning-brief","schedule":"täglich 08:00","lastRun":"vor 3h"}</surface:routine>`',
    '  Routine-Card. Nach `lazyos-cli routine list` als Surface, nicht als Text.',
    '',
    `\`<surface:document>{"id":"ART-...","filename":"Bericht.pdf","mime":"application/pdf","bytes":141000,"pages":12,"workspace":"${workspaceId}","downloadUrl":"/api/cloud/ART-...","previewUrl":"/api/cloud/ART-.../preview","thumbnailUrl":"/api/cloud/ART-.../thumb"}</surface:document>\``,
    '  Datei-Card (WhatsApp-Style: großes Cover-Thumbnail, Tap = öffnen, Download-Button).',
    `  Nach jedem \`lazyos-cli cloud generate ${ws} ...\` ODER \`cloud upload\` MUSST du die`,
    '  zurückgelieferte `surfaceMarkup` 1:1 ins Chat einfügen — der User soll die Datei',
    '  direkt anklicken und öffnen können, ohne extra Schritte. Nicht nur "PDF erstellt" sagen.',
    '',
    `\`<surface:cloud-browser>{"workspace":"${workspaceId}","workspaceLabel":"...","artifactCount":42,"totalBytes":12500000,"folderCount":3,"href":"/workspaces/${workspaceId}/cloud"}</surface:cloud-browser>\``,
    '  Cloud-Stats-Karte. Bei "was liegt in meiner Cloud" / "wie voll" / "Cloud-Übersicht" zeigen.',
    '',
    '`<surface:folder>{"id":"FLD-...","name":"Verträge 2026","path":"/projekte/2026","itemCount":12}</surface:folder>`',
    '  Folder-Card. Bei `lazyos-cli cloud list` für jeden Folder ein Surface, nicht Text.',
    '',
    '## Cloud-Workflow (Pflicht-Pattern bei PDF-Erzeugung)',
    `Wenn der User sagt "schreib mir einen Bericht/Plan/Konzept als PDF" oder ähnlich:`,
    `  1. Markdown lokal als Tempfile schreiben (Bash: \`cat > /tmp/<name>.md\`).`,
    `  2. \`lazyos-cli cloud generate ${ws} --md-file=/tmp/<name>.md --title="..."\`.`,
    `  3. Die zurückkommende \`surfaceMarkup\`-Zeile UNVERÄNDERT in deine Antwort einfügen.`,
    `  4. Maximal ein Satz Begleittext ("Hier ist der Bericht …"), dann Surface.`,
    `Niemals den Markdown-Inhalt im Chat dumpen — der User will die Datei, nicht den Roh-Text.`,
    '',
    '`<surface:agent>{"role":"senior-dev","status":"läuft","counter":"3 Tools","statusVariant":"live","variant":"lead","avatarGlyph":"SD","desc":"Implementiert Fix"}</surface:agent>`',
    '  Sub-Agent-Karte (Teammate). variant: lead | standard | add. statusVariant: live | idle | eta.',
    '  Bei Sub-Agent-Spawn (Task-Tool) IMMER eine surface:agent Karte zeigen.',
    '',
    '`<surface:swarm>{"title":"Konsens","value":"n=50","sub":"Median markiert","cells":[{"variant":"consensus"},{"variant":"median"},{"variant":"running"},{"variant":"outlier"}]}</surface:swarm>`',
    '  Schwarm-Heatmap (Multi-Agent-Konsens). variant: consensus|median|outlier|running|empty.',
    '',
    `\`<surface:tier-choice>{"title":"Plan erkannt — wie tief?","summary":"5 Sub-Themen, mittel komplex","planTitle":"<kurztitel>","workspaceId":"${workspaceId}","presets":[{"id":"fast","label":"Schnell","cost":"MAX-Plan","tiers":{"opus":1,"sonnet":4,"haiku":8}},{"id":"balanced","label":"Balanced","cost":"MAX-Plan","tiers":{"opus":2,"sonnet":6,"haiku":12},"recommended":true},{"id":"deep","label":"Tief","cost":"MAX-Plan","tiers":{"opus":4,"sonnet":8,"haiku":16}}]}</surface:tier-choice>\``,
    '',
    `\`<surface:workflow-pipeline>{"ticketId":"TCK-...","ticketTitle":"...","state":"review","workspaceId":"${workspaceId}"}</surface:workflow-pipeline>\``,
    '  Live-FSM-Pipeline für ein Ticket. State: draft|review|approved|executed|closed|rejected.',
    '  IMMER emittieren wenn du gerade einen Workflow-Schritt ausgeführt hast (Approval-Request, Approve, Execute, Close).',
    '  Card hört live auf weitere Workflow-Events am gleichen Ticket — kein Reload nötig.',
    '',
    `\`<surface:credential-prompt>{"workspaceId":"${workspaceId}","name":"STRIPE_SECRET_KEY","description":"...","docsUrl":"https://..."}</surface:credential-prompt>\``,
    '  KEY-ANFRAGE-Card. Nutze NIEMALS plaintext-Keys im Chat. Wenn du einen Key brauchst (Stripe, Supabase, etc.):',
    '  1. Pruefe ob er in workspace_credentials existiert (server-side, nicht im Chat).',
    '  2. Wenn nicht: emittiere `credential-prompt` mit dem erwarteten name (UPPER_SNAKE_CASE), kurzer description + docsUrl.',
    '  3. Der User trippt direkt in der Card → encrypted storage. Du bekommst nur den Hinweis dass der Key da ist, NICHT den Klartext.',
    '',
    'AUTO-MODE: Wenn die User-Message am Ende `[Auto-Mode aktiv]` enthaelt, behandle JEDE nicht-triviale Anfrage (>=2 Sub-Themen ODER ein Bug-Fix/Feature/Refactor-Request) automatisch als grossen Plan und emittiere `tier-choice` mit recommended-Preset `fast` (Schnell). Auto-Mode overridet die normalen Trigger-Bedingungen.',
    '  PFLICHT bei "großem Plan". Ein "großer Plan" liegt vor wenn:',
    '   • der User Wörter wie "plane", "Konzept", "wie bauen wir", "großer Plan", "orchestriere", "brich auf in"',
    '   • UND die Anfrage ≥3 Sub-Themen hat ODER ein nicht-triviales Feature beschreibt',
    `  In diesem Fall NUR \`tier-choice\` als ALLERERSTE Antwort emittieren. KEIN Decision, KEINE Pipeline, KEIN Markdown-Plan davor. \`workspaceId\` MUSS "${workspaceId}" sein.`,
    '  Bei Klick auf einen Preset legt das Frontend einen Workstream an und triggert den Tier-Spawn — du musst nichts weiter tun außer auf den Spawn-Output reagieren.',
    '',
    '### Mapping Nutzer-Absicht → Surface:',
    '',
    '- "Stand / wie geht / Fortschritt / Zahlen / Übersicht"  → `chart`',
    '- "Ticket anlegen / leg Ticket an / To-do"              → `ticket` (nach cli-create)',
    '- "Liste Tickets / was ist offen"                         → ein `ticket` pro relevantem Eintrag',
    '- "bash / git / ls / kommando ausführen / output"        → `terminal` nach Bash-Call',
    '- "Entscheidung / sollten wir / ja oder nein"            → `quickchoice` oder `decision`',
    '- "Freigabe / approve / genehmigen"                      → `approval`',
    '- "Rechnung / Invoice / DATEV"                           → `invoice`',
    '- "Workspace-Gesundheit / Heartbeat"                     → `heartbeat` + evtl. `toast` warn',
    '- "Routine / Cron / Morning-Brief"                       → `routine`',
    '- "Plane / Konzept / brich auf / großer Plan"            → `tier-choice` (PFLICHT-Override für alles andere)',
    '',
    'Wenn nichts davon trifft (reine Konversation, Frage beantworten): kurzer Textabsatz OK.',
    '',
    '## Pflicht: Userflow-Section (Phase U)',
    '',
    'In jedem Plan-Output (Synthesis, Pipeline-Erklärung, größere Antworten) **MUSS** eine Section enthalten:',
    '```',
    '## User-Sicht',
    '1. Du klickst X.',
    '2. System fragt Y.',
    '3. Du antwortest …',
    '4. System macht Z.',
    '',
    '## Offene Fragen',
    'PFLICHT-Format pro Frage (≥80% mit OPTIONS — sonst muss User tippen statt klicken):',
    '`- [?] <Frage> | OPTIONS: <A> | <B> | <C>` (2-5 plausible Optionen).',
    'Beispiel: `- [?] Sidebar-Position? | OPTIONS: rechts Desktop | unter Editor | Drawer-Modal`',
    'NUR ohne OPTIONS bei reinen Erklärungs-Fragen (z.B. Schema-Detail).',
    '```',
    '`[?]`-Marker + OPTIONS: werden vom UI als QuickChoice-Card mit Klick-Buttons gerendert. Schreib aus Max-Perspektive ("Du klickst..."), kein Tech-Speak.',
    '',
    '## tmux-Spiegel (Session-Awareness)',
    `Deine Antworten erscheinen **live** in der tmux-Session \`lazyos-ws-${workspaceId}\` — pane 0`,
    '(oben) zeigt einen ANSI-gefärbten Chat-Transcript, pane 1 (unten) ist eine Bash im Workspace-cwd.',
    '`tmux attach -t lazyos-ws-' + workspaceId + '` schaltet Max live drauf. Das Transcript-Log',
    'liegt auf `/tmp/lazyos-transcript-' + workspaceId + '.log`. Kein Thema — läuft parallel, keine',
    'Aktion deinerseits nötig. Nur mitwissen: deine Tokens + Tool-Calls sind für Max mitlesbar.',
  ].join('\n');
}

/**
 * Root mode — cross-workspace executive floor.
 *
 * No workspace binding. The agent operates across ALL projects and may:
 *   - create new workspaces
 *   - create tickets in any workspace (via --workspace=<id>)
 *   - trigger routines across workspaces
 *   - meta operations (org chart, user settings, backup, system restart)
 */
function buildRootSystemPrompt(): string {
  const root = projectsRoot();
  return [
    `## ${BRAND_NAME} · Root · Cross-Workspace-Modus`,
    `Du läufst als ${BRAND_NAME}-Root-Agent — NICHT an einen einzelnen Workspace gebunden.`,
    `Dein Arbeitsverzeichnis ist beschreibbar; Projekt-Verzeichnisse liegen unter \`${root}\`.`,
    '',
    '### BAU-MODUS (2026-06-02): Wenn Max etwas KONKRETES bauen/erstellen will',
    '(App, Prototyp, HTML-Seite, Skript), bau es SOFORT statt zu fragen "welcher',
    'Workspace?". Optionen, je nach Wunsch:',
    `  (a) Schnell-Prototyp: direkt in deinem cwd anlegen + \`<surface:terminal>\` zeigen.`,
    '  (b) Eigenständiges Projekt: erst ein Workspace anlegen, dann darin bauen:',
    `      \`mkdir -p ${root}/<id> && lazyos-cli workspace create <id> "<Label>" --path=${root}/<id>\``,
    '      danach die Datei(en) im Projekt-Pfad anlegen + `<surface:workspace>`-Pill +',
    '      Hinweis, dass Max in das neue Projekt wechseln kann. Keine Klärungs-Schleife.',
    '',
    'Mission: Max gibt Chef-Anweisungen („leg Projekt X an", „Status über alle Workspaces",',
    '„Kanban-Review Cross-Team"). Du bist das Orchestrierungs-Layer.',
    '',
    '### Erweiterte Permissions (Root-Modus only):',
    '',
    '- **Tickets überall erstellen:** `lazyos-cli ticket create <workspaceId> "<Titel>" ...`',
    '  — `<workspaceId>` ist explizit zu nennen, nicht `__root__`. Wähle den passenden',
    '  Ziel-Workspace (lazyos, demo-client, tap, private, ...) basierend auf User-Intent.',
    '',
    '- **Cross-Workspace-Listen:** `lazyos-cli ticket list` (ohne --workspace) listet',
    '  alle Tickets aus allen Workspaces. Für Kanban-Overview, Chairman-Digest.',
    '',
    '- **Routinen triggern:** `lazyos-cli routine list` und `lazyos-cli routine trigger <id>`',
    '  ohne Workspace-Bindung.',
    '',
    '- **Neue Workspaces:** Wenn Max „leg Projekt <X> an" sagt:',
    `  1. \`mkdir -p ${root}/<X> && cd ${root}/<X> && git init\``,
    `  2. \`lazyos-cli workspace create <X> "<Label>" --path=${root}/<X>\``,
    '  3. Gib dem Projekt ein initiales README + Ticket „Projekt-Setup".',
    '',
    '- **Meta-Aktionen:** Observatory-Reports, Heartbeat-Checks cross-workspace,',
    '  Session-Analytics, Organization-Struktur.',
    '',
    '- **Cloud-Operationen pro Workspace:**',
    '  `lazyos-cli cloud list <workspaceId>`        — Files in der Workspace-Cloud',
    '  `lazyos-cli cloud stats <workspaceId>`       — Size + Counts',
    '  `lazyos-cli cloud upload <workspaceId> <file>` — lokale Datei in die Cloud heben',
    '  `lazyos-cli cloud generate <workspaceId> --md-file=<path> --title="..."` — Markdown→PDF',
    '  Bei PDF-Erzeugung im Auftrag des Users: nach `cloud generate` den `surfaceMarkup`-Output',
    '  unverändert ins Chat einfügen — der User kriegt eine WhatsApp-Style Card mit Open/Download.',
    '  demo-private/private/example-app-* sind sensitivity=high → Upload Day-1 blockiert (DSGVO Phase-2).',
    '',
    '### Surface-First Mindset (PFLICHT)',
    '',
    'Jede sinnvolle Antwort enthält mindestens EIN `<surface:TYPE>{json}</surface:TYPE>`.',
    'Besonders im Root-Modus: Multi-Workspace-Übersichten → `chart` oder `swarm`-Heatmap.',
    'Neue Projekte → `workspace`-Pill + `ticket`-Card für Setup-Ticket.',
    'Cross-Workspace-Tickets-Listen → eine Ticket-Surface pro Eintrag (aggregiert).',
    '',
    '### Regeln:',
    '- Antworte auf Deutsch (Max\' Präferenz).',
    '- Kein Workspace-Assumption — sag immer *welchen* Workspace du ansprichst.',
    '- Wenn User in einem Projekt-Ordner etwas will und nicht explizit einen Workspace',
    '  nennt: frag EINMAL kurz oder lese `.lazyos-workspace`-Marker aus dem cwd.',
    '- Bei destruktiven Aktionen (rm, workspace archive, git push --force): kurz',
    '  bestätigen lassen via `<surface:quickchoice>`.',
    '- **Service-Restart ist AUTONOM erlaubt** (Phase AR 2026-04-28): nach',
    '  Code-Aenderungen die einen Refresh brauchen (next build done, server/-Code',
    '  geaendert) rufst du DIREKT `lazyos-cli system restart --services=web,agent',
    '  --reason="..."` ohne Rueckfrage. Restart=always faengt sowieso ab, kein',
    '  Datenrisiko. NICHT autonom: pkill, rm, git reset --hard, DB-DROP.',
    '',
    '### Mapping Nutzer-Absicht → Surface:',
    '- „Stand über alle Projekte / Gesamtübersicht"  → `chart` oder `swarm`',
    '- „Was ist kritisch / was eskaliert"            → `ticket` pro P0/P1',
    '- „Leg Projekt an" / „Neues Workspace"          → `workspace`-Pill + `ticket` Setup',
    '- „Alle Routinen"                                → `routine` pro aktiver Routine',
    '- „Workspace-Gesundheit"                         → `heartbeat` + `toast` bei stale',
    '',
    '## tmux-Spiegel',
    'Root-Mode nutzt tmux-Session `lazyos-ws-__root__`. Transcript unter',
    '`/tmp/lazyos-transcript-__root__.log`. Läuft parallel — keine Aktion nötig.',
  ].join('\n');
}

/**
 * Run a single Claude-Code turn against the workspace session. This is the
 * **hot path** from `POST /chat`.
 *
 * Flow:
 *   1. ensureSession → get workspace path + session-id
 *   2. spawn `claude --print --input-format=stream-json
 *                    --output-format=stream-json --include-partial-messages
 *                    --session-id=<sid>` if fresh OR `--resume=<sid>` if existing
 *   3. Write one stream-json input envelope: user message with prompt
 *   4. Read child stdout line-by-line as JSONL; emit normalised ParsedEvents
 *   5. Terminal event is `{type:"result"}` — when seen, wait for child exit
 *      then resolve.
 *
 * Abort: `signal.aborted` triggers child.kill('SIGINT'); Claude-CLI handles
 * SIGINT gracefully (stops tool-use, flushes a result frame).
 */
export async function sendPrompt(opts: SendPromptOpts): Promise<void> {
  // Phase QA (2026-04-28): PRE-spawn TPM budget check for the main chat.
  // Sleeps adaptively when the MAX-plan TPM bucket is already highly utilized.
  // Prevents collision with parallel tier spawns + my terminal Claude.
  await waitForBudget(`workspace-session:${opts.workspaceId}`);

  const handle = await ensureSession(opts.workspaceId);

  // Open the tmux-mirror transcript for this turn. Failing to open is
  // NON-fatal — the chat path must never die because we couldn't tail a log.
  let transcript: TranscriptWriter | null = null;
  try {
    transcript = openTranscript(opts.workspaceId);
  } catch (err) {
    console.warn(
      `[workspace-session] openTranscript failed for ${opts.workspaceId}:`,
      err instanceof Error ? err.message : err,
    );
    transcript = null;
  }

  // Read the current turn count from the DB so the transcript header shows
  // a meaningful number. This is "turn about to start", so we add 1.
  let turnNumber = 1;
  try {
    const row = getClaudeSession(opts.workspaceId);
    if (row) turnNumber = row.turnCount + 1;
  } catch {
    /* non-fatal */
  }

  if (transcript) {
    try {
      transcript.turnStart(turnNumber, opts.prompt);
    } catch {
      /* non-fatal */
    }
  }

  // Persist the user prompt to the event log (cross-device, audit, replay).
  // NEVER throws.
  const turnStartedAt = Date.now();
  const logReqId = opts.reqId ?? `turn-${turnStartedAt}`;
  // PII vault: opts.prompt arrives tokenized from the proxy. The local event log
  // is local + workspace-scoped, so persist the REAL text — rehydrate it here.
  // Fail-soft: never break the (non-throwing) log.
  let logPrompt = opts.prompt;
  try {
    const { piiVaultEnabled } = await import('../lib/privacy/protect');
    if (piiVaultEnabled()) {
      const { detokenizeText } = await import('../lib/privacy/pii-vault');
      logPrompt = detokenizeText(getAgentDb(), opts.workspaceId, logPrompt).text;
    }
  } catch {
    /* keep tokenized rather than fail the log */
  }
  logPromptSent({
    reqId: logReqId,
    workspaceId: opts.workspaceId,
    sessionId: handle.sessionId,
    prompt: logPrompt,
  });

  // PII vault: one gated, synchronous tokenize/detokenize pair for this turn.
  // piiTok runs BEFORE the spawn (system prompt + RAG block) so the cloud only
  // sees placeholders; piiDetok runs inside the (sync) close callback so local
  // persistence (history / ledger / event log) keeps the REAL values. Fail-soft
  // → identity functions when the vault is off or unavailable.
  let piiTok = (t: string): string => t;
  let piiDetok = (t: string): string => t;
  try {
    const { piiVaultEnabled } = await import('../lib/privacy/protect');
    if (piiVaultEnabled()) {
      const { tokenizeText, detokenizeText } = await import('../lib/privacy/pii-vault');
      const piiRaw = getAgentDb();
      piiTok = (t: string): string => (t ? tokenizeText(piiRaw, opts.workspaceId, t).text : t);
      piiDetok = (t: string): string => (t ? detokenizeText(piiRaw, opts.workspaceId, t).text : t);
    }
  } catch {
    /* keep identity functions */
  }

  // Fan-out event emitter: calls the caller's onEvent AND writes to the
  // transcript. Transcript write errors are swallowed so they cannot break
  // the SSE path.
  let charsOut = 0;
  let toolCalls = 0;
  let responseText = '';
  /**
   * Phase MS: aggregated tool-call summaries for the chat_message_completed
   * event. Map: toolUseId -> {name, startedAt, summary}. On tool_result
   * we couple the summary with the duration.
   */
  const toolCallTracker: Map<string, { name: string; startedAt: number; summary: string }> =
    new Map();
  const toolCallSummaries: ChatMessageToolCallSummary[] = [];

  // Streaming recovery V2: snapshot writer for the reload path. Only
  // if the caller passes a pendingPromptId — otherwise no UPSERT
  // (no recovery possible, because history would have no key).
  //
  // 2026-04-27 stability fix: default-OFF after repeated agent crashes
  // on long streams (>5min, many tool_calls). Suspicion: appendToken
  // accumulates large buffers in the JS heap, or a flushFinal rejection
  // kills the Node process. Re-activatable via env LAZYOS_STREAMING_SNAPSHOTS=1.
  // Recovery path without a snapshot: chat_message_completed on child.on('close')
  // persists the final output via the Phase-MS flow — so nothing is
  // lost, only live co-reading from a second tab is missing.
  const SNAPSHOTS_ENABLED = process.env.LAZYOS_STREAMING_SNAPSHOTS === '1';
  let snapshotWriter: SnapshotWriter | null = null;
  if (SNAPSHOTS_ENABLED && opts.pendingPromptId) {
    try {
      snapshotWriter = createSnapshotWriter({
        pendingPromptId: opts.pendingPromptId,
        workspaceId: opts.workspaceId,
      });
    } catch (err) {
      console.warn(
        '[workspace-session] createSnapshotWriter failed:',
        err instanceof Error ? err.message : err,
      );
      snapshotWriter = null;
    }
  }

  const emit = (ev: ParsedEvent): void => {
    try {
      opts.onEvent(ev);
    } catch {
      /* caller errors are their problem — don't let them break streaming */
    }
    if (ev.kind === 'tool_call') {
      const key = ev.id ?? `${ev.name}:${Date.now()}-${toolCalls}`;
      toolCallTracker.set(key, {
        name: ev.name,
        startedAt: Date.now(),
        summary: ev.inputPreview.slice(0, 240),
      });
    }
    if (ev.kind === 'tool_result' && ev.toolUseId) {
      const tracked = toolCallTracker.get(ev.toolUseId);
      if (tracked) {
        toolCallSummaries.push({
          name: tracked.name,
          summary: tracked.summary,
          durationMs: Date.now() - tracked.startedAt,
        });
        toolCallTracker.delete(ev.toolUseId);
      }
    }
    // Aggregations run ALWAYS, even when no transcript writer is open
    // — otherwise responseText / toolCalls in chat_message_completed are
    // empty.
    if (ev.kind === 'token') {
      charsOut += ev.text.length;
      responseText += ev.text;
      // Streaming recovery: pass the token through to the snapshot writer.
      // The writer accumulates locally and persists every 1500 ms.
      if (snapshotWriter) snapshotWriter.appendToken(ev.text);
    }
    if (ev.kind === 'tool_call') {
      toolCalls += 1;
      if (snapshotWriter) {
        snapshotWriter.setToolState({
          name: ev.name,
          status: 'pending',
          id: ev.id,
        });
      }
    }
    if (ev.kind === 'tool_result' && snapshotWriter) {
      // Tool result came back → no open tool call in the
      // snapshot anymore. For nested tool calls the
      // next tool_call overwrites the state anyway.
      snapshotWriter.clearToolState();
    }
    if (!transcript) return;
    try {
      switch (ev.kind) {
        case 'token':
          transcript.token(ev.text);
          break;
        case 'tool_call':
          transcript.toolCall(ev.name, ev.inputPreview);
          break;
        case 'tool_result':
          transcript.toolResult(ev.outputPreview, ev.isError);
          break;
        case 'permission_denied':
          transcript.permissionDenied(ev.tool, ev.reason);
          break;
        case 'error':
          transcript.error(ev.message);
          break;
        // 'ready' and 'done' are handled outside emit — ready is silent in
        // the transcript (header already shown at turnStart), done becomes
        // a turn-footer with aggregated meta.
      }
    } catch {
      /* swallow */
    }
  };

  // Chat tool access (2026-05-26): with all-access (freerein) pre-approve the
  // tools, otherwise Bash/WebFetch/WebSearch do not run in --print mode.
  const chatAccess = resolveChatToolAccess(opts.workspaceId);
  const args = [
    '--print',
    // Opus-only (owner directive 2026-05-29/30): pin the chat spawn explicitly to
    // Opus 4.8. Without `--model` the claude CLI would take its configured
    // default model (which depending on the local CLI config may be Sonnet) —
    // a silent non-Opus path. MODEL_NAMES.opus = single source of truth.
    '--model',
    MODEL_NAMES.opus,
    // 2-stage model (owner 2026-06-03): normal chat = fast (NO
    // --effort). Only when the client has detected a multi-step intent
    // (shouldDecompose → thinking:true) does this turn raise the reasoning depth
    // via `--effort`. Default = empty array = today's fast behavior.
    ...(opts.thinking ? ['--effort', opts.thinkingBudget ?? 'high'] : []),
    '--input-format=stream-json',
    '--output-format=stream-json',
    '--include-partial-messages',
    '--verbose',            // required for stream-json output
    '--permission-mode=acceptEdits',
    ...(chatAccess.fullAccess && chatAccess.allowedTools
      ? ['--allowedTools', chatAccess.allowedTools]
      : []),
    // Workspace path isolation (2026-05-26): ONLY in the fullAccess branch do we
    // attach a PreToolUse Bash hook that checks every shell command against the
    // workspace path allowlist and rejects cross-workspace/secret accesses.
    // claude runs NORMALLY (unsandboxed) — only individual Bash commands
    // are blocked. (A kernel FS sandbox around claude was discarded: claude
    // goes silently mute under it during the API turn.) `--settings` with a JSON string
    // merges with ~/.claude/settings.json (empirically verified, claude 2.1.150).
    ...bashPolicyArgs(chatAccess.fullAccess),
    // lazyOS-awareness: inject a compact system-prompt append that teaches
    // Claude about the CLI bridge (`lazyos-cli`) and its workspace
    // context. Without this, Claude has Read/Write/Edit/Bash but no idea
    // that tickets / heartbeat / routines / push exist as first-class
    // lazyOS concepts. Keep the text SHORT — long system prompts burn
    // tokens every turn.
    '--append-system-prompt',
    // PII vault: the system prompt embeds subchat customer comms + workspace
    // notes + the handoff block — tokenize it before it reaches the cloud.
    piiTok(buildLazyosSystemPrompt(opts.workspaceId)),
  ];
  // For a freshly-minted session, pass --session-id so we can persist the
  // UUID we stored. For an existing session, use --resume to continue the
  // transcript. Claude-CLI errors out if you combine the two.
  if (handle.isNew || opts.forceFreshSession) {
    args.push('--session-id', handle.sessionId);
  } else {
    args.push('--resume', handle.sessionId);
  }

  // Spawn inside the workspace cwd so relative paths resolve correctly for
  // Read/Write/Edit/Bash built-ins.
  //
  // Auth routing: Claude-CLI picks ANTHROPIC_API_KEY over the stored MAX-Plan
  // credentials if both are present. We want MAX-Plan (no credit spend), so
  // we strip ANTHROPIC_API_KEY from the child env unless the caller explicitly
  // opts into API-key mode via extraEnv.LAZYOS_USE_API_KEY=1.
  const baseEnv: NodeJS.ProcessEnv = { ...process.env };
  if (!(opts.extraEnv?.LAZYOS_USE_API_KEY === '1')) {
    delete baseEnv.ANTHROPIC_API_KEY;
  }
  baseEnv.HOME = process.env.HOME ?? '/root';
  // Phase MU.3 — per-user token routing. If opts.userId is set, we check
  // whether the user has stored their own credentials and route the spawn
  // into a user sandbox with its own .credentials.json. Errors in the routing
  // are non-fatal — the fallback is the system token (shared).
  if (opts.userId) {
    try {
      const { prepareUserSandbox } = await import(
        '../lib/agents/user-credentials-routing'
      );
      const sandbox = prepareUserSandbox(opts.userId);
      baseEnv.HOME = sandbox.home;
      baseEnv.LAZYOS_CLAUDE_MODE = sandbox.mode;
      if (sandbox.email) baseEnv.LAZYOS_CLAUDE_EMAIL = sandbox.email;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        '[workspace-session] user-credentials-routing failed:',
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  // Session context tracking (handoff point 5): lazyos-cli reads this env
  // and adds the sessionId into every ticket-create/update payload. This way
  // the session↔ticket link is persistently recorded in the event log.
  baseEnv.LAZYOS_SESSION_ID = handle.sessionId;
  baseEnv.LAZYOS_WORKSPACE_ID = opts.workspaceId;
  // The workspace-path policy hook needs the DB path + repo root to build the
  // allowlist and find itself. LAZYOS_WORKSPACE_ID is
  // already set (see above). LAZYOS_DB_PATH usually already comes from process.env
  // (.env.local / systemd unit), but we set a robust default if
  // not — mirrored from server/db.ts (DB_PATH default). LAZYOS_REPO_ROOT
  // resolves a relative LAZYOS_DB_PATH against the repo root.
  baseEnv.LAZYOS_REPO_ROOT = resolveRepoRoot();
  if (!baseEnv.LAZYOS_DB_PATH) {
    baseEnv.LAZYOS_DB_PATH =
      process.env.LAZYOS_DB_PATH ?? path.join(os.homedir(), '.lazyos', 'lazyos.db');
  }

  const child = spawn('claude', args, {
    cwd: handle.workspacePath,
    env: { ...baseEnv, ...(opts.extraEnv ?? {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Wire abort.
  const onAbort = (): void => {
    try {
      if (!child.killed) child.kill('SIGINT');
    } catch {
      /* ignore */
    }
    // Escalate to SIGKILL after 5s if still running.
    setTimeout(() => {
      try {
        if (!child.killed) child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }, 5000).unref();
  };
  if (opts.signal.aborted) {
    onAbort();
  } else {
    opts.signal.addEventListener('abort', onAbort, { once: true });
  }

  // RAG slice 1 (2026-05-23): per-turn retrieval with the CURRENT question.
  // The context is prepended BEFORE the user prompt that goes to claude — NOT
  // in --append-system-prompt (that is cached per session, see
  // buildLazyosSystemPrompt). Workspace-isolated via retrieve() (view filter
  // workspace_id + sensitivity!='high'). Cheap count guard: as long as the
  // workspace has no rag_chunks, no embed call → zero extra latency.
  // Any error is non-fatal — then the bare prompt goes out.
  // Path/pattern identical to server/agents/tier-orchestrator.ts:injectRagContext.
  let effectivePrompt = opts.prompt;
  try {
    const ragCount = getAgentDb()
      .prepare('SELECT COUNT(*) AS n FROM rag_chunks WHERE workspace_id = ?')
      .get(opts.workspaceId) as { n: number } | undefined;
    if (ragCount && ragCount.n > 0) {
      const { retrieve, formatForPrompt } = await import('../lib/rag/retriever');
      const ragResult = await retrieve({
        workspaceId: opts.workspaceId,
        query: opts.prompt,
        topK: 8,
        tokenCap: 4000,
      });
      let ragBlock = formatForPrompt(ragResult);
      // PII vault: the retrieved RAG context can contain customer emails / IBANs /
      // names, so tokenize it too BEFORE it is prepended to the cloud prompt. The
      // response is rehydrated locally afterwards.
      if (ragBlock) {
        ragBlock = piiTok(ragBlock);
        effectivePrompt = `${ragBlock}\n---\n${opts.prompt}`;
      }
    }
  } catch (err) {
    console.warn(
      '[workspace-session] rag-inject-fail (non-fatal):',
      err instanceof Error ? err.message : err,
    );
  }

  // Send the user message (one JSONL envelope, then close stdin).
  const userEnvelope = JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text: effectivePrompt }],
    },
  });
  try {
    child.stdin.write(userEnvelope + '\n');
    child.stdin.end();
  } catch (err) {
    onAbort();
    throw err;
  }

  // 'ready' is a caller-facing signal only; the transcript already has a
  // header from turnStart above.
  try {
    opts.onEvent({ kind: 'ready', sessionId: handle.sessionId });
  } catch {
    /* ignore */
  }

  // Stream parsing.
  const maxBytes = opts.maxOutputBytes ?? 8 * 1024 * 1024;
  let totalBytes = 0;
  let buffer = '';
  let resultSeen = false;
  let tooManyTurns = false;
  let lastResultSubtype: string | null = null;
  let finalResultText: string | null = null;
  let finalSessionId: string | null = null;
  let numTurns: number | null = null;
  let durationMs: number | null = null;
  let isErrorFlag = false;
  let claudeVersionSeen: string | null = null;
  let startedAt = Date.now();

  const parseLine = (line: string): void => {
    if (!line) return;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // Non-JSON lines shouldn't happen in stream-json mode, but if they do
      // we surface them as token so the caller sees *something*.
      emit({ kind: 'token', text: line });
      return;
    }
    const type = typeof obj.type === 'string' ? obj.type : '';

    if (type === 'system') {
      const subtype = typeof obj.subtype === 'string' ? obj.subtype : '';
      if (subtype === 'init' && typeof obj.session_id === 'string') {
        finalSessionId = obj.session_id;
      }
      if (subtype === 'init' && typeof obj.claude_code_version === 'string') {
        claudeVersionSeen = obj.claude_code_version;
      }
      // `hook_started`, `hook_response`, `status` -> ignore for now.
      return;
    }

    if (type === 'stream_event') {
      const ev = obj.event as
        | { type?: string; delta?: { type?: string; text?: string } }
        | undefined;
      if (!ev) return;
      if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
        const t = typeof ev.delta.text === 'string' ? ev.delta.text : '';
        if (t) emit({ kind: 'token', text: t });
      }
      return;
    }

    if (type === 'assistant') {
      // Non-partial assistant frame — contains tool_use blocks. Text is
      // already streamed via stream_event deltas, so we only extract tool_use.
      const msg = obj.message as
        | { content?: Array<{ type?: string; id?: string; name?: string; input?: unknown }> }
        | undefined;
      if (!msg || !Array.isArray(msg.content)) return;
      for (const b of msg.content) {
        if (b && typeof b === 'object' && b.type === 'tool_use' && typeof b.name === 'string') {
          emit({
            kind: 'tool_call',
            id: typeof b.id === 'string' ? b.id : null,
            name: b.name,
            inputPreview: previewJson(b.input),
          });
        }
      }
      return;
    }

    if (type === 'user') {
      // Tool-results come back as user-role messages with tool_result blocks.
      const msg = obj.message as
        | {
            content?: Array<{
              type?: string;
              tool_use_id?: string;
              content?: unknown;
              is_error?: boolean;
            }>;
          }
        | undefined;
      if (!msg || !Array.isArray(msg.content)) return;
      for (const b of msg.content) {
        if (b && typeof b === 'object' && b.type === 'tool_result') {
          emit({
            kind: 'tool_result',
            toolUseId: typeof b.tool_use_id === 'string' ? b.tool_use_id : null,
            isError: Boolean(b.is_error),
            outputPreview: previewToolOutput(b.content),
          });
        }
      }
      return;
    }

    if (type === 'result') {
      resultSeen = true;
      lastResultSubtype = typeof obj.subtype === 'string' ? obj.subtype : null;
      finalResultText = typeof obj.result === 'string' ? obj.result : null;
      numTurns = typeof obj.num_turns === 'number' ? obj.num_turns : null;
      durationMs = typeof obj.duration_ms === 'number' ? obj.duration_ms : null;
      isErrorFlag = obj.is_error === true;
      if (typeof obj.session_id === 'string') finalSessionId = obj.session_id;
      if (lastResultSubtype === 'error_max_turns') tooManyTurns = true;
      return;
    }

    if (type === 'error' || type === 'api_error') {
      const message = typeof obj.message === 'string' ? obj.message : JSON.stringify(obj);
      emit({ kind: 'error', message: message.slice(0, 500) });
      return;
    }

    if (type === 'permission_denial') {
      const tool = typeof obj.tool === 'string' ? obj.tool : null;
      const reason = typeof obj.reason === 'string' ? obj.reason : null;
      emit({ kind: 'permission_denied', tool, reason });
      return;
    }
    // Unknown types: drop silently. We can surface them later if needed.
  };

  const flushBuffer = (): void => {
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) parseLine(trimmed);
    }
  };

  // Collect stderr for diagnostics (but don't surface it verbatim).
  let stderrBuf = '';

  return await new Promise<void>((resolve, reject) => {
    let childExited = false;

    child.stdout.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        emit({ kind: 'error', message: `output_capped at ${maxBytes} bytes` });
        onAbort();
        return;
      }
      buffer += chunk.toString('utf8');
      flushBuffer();
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf8');
      // Cap the buffer so a screaming stderr can't OOM us.
      if (stderrBuf.length > 32 * 1024) {
        stderrBuf = stderrBuf.slice(-32 * 1024);
      }
    });

    child.on('error', (err) => {
      if (childExited) return;
      childExited = true;
      opts.signal.removeEventListener('abort', onAbort);
      // Streaming recovery: stop the periodic timer (otherwise a dangling
      // setInterval). Deliberately do not delete the snapshot row — the
      // history endpoint marks it as 'aborted' after 10 s.
      if (snapshotWriter) {
        try {
          snapshotWriter.cancel();
        } catch {
          /* swallow */
        }
      }
      reject(err);
    });

    child.on('close', (code, _sig) => {
      if (childExited) return;
      childExited = true;
      opts.signal.removeEventListener('abort', onAbort);

      // Flush trailing buffer.
      if (buffer.trim()) {
        const last = buffer.trim();
        buffer = '';
        try {
          parseLine(last);
        } catch {
          /* swallow */
        }
      }

      // Persist session metadata back to DB.
      const resultLabel = opts.signal.aborted
        ? 'aborted'
        : tooManyTurns
          ? 'too_many_turns'
          : isErrorFlag || code !== 0
            ? 'error'
            : 'success';
      try {
        const counted = resultLabel === 'success' || resultLabel === 'too_many_turns';
        upsertClaudeSession({
          workspaceId: opts.workspaceId,
          sessionId: finalSessionId ?? handle.sessionId,
          claudeVersion: claudeVersionSeen,
          lastResult: resultLabel,
          turnIncrement: counted ? 1 : 0,
          // Cumulative token proxy (prompt+output chars/4) for the
          // degradation detector; only accumulate on counted turns.
          tokenIncrement: counted
            ? Math.ceil((opts.prompt.length + totalBytes) / 4)
            : 0,
        });
      } catch (err) {
        // DB write failures shouldn't tank the response.
        console.warn(
          `[workspace-session] upsertClaudeSession failed:`,
          err instanceof Error ? err.message : err,
        );
      }

      // Fire terminal done event. 'done' is NOT fed to the transcript via
      // emit() — we write a dedicated footer via transcript.turnEnd() with
      // aggregated meta instead.
      const finalDurMs = durationMs ?? Date.now() - startedAt;
      const finalIsError = isErrorFlag || code !== 0;
      try {
        opts.onEvent({
          kind: 'done',
          subtype: lastResultSubtype,
          durationMs: finalDurMs,
          numTurns,
          isError: finalIsError,
          tooManyTurns,
          resultText: finalResultText,
          sessionId: finalSessionId,
        });
      } catch {
        /* ignore */
      }

      // If Claude exited non-zero with no `result` frame, surface stderr
      // (goes through emit so transcript picks it up too).
      if (!resultSeen && code !== 0) {
        emit({
          kind: 'error',
          message: `claude_cli_exit_${code}: ${stderrBuf.slice(0, 400) || 'no stderr'}`,
        });
      }

      // Close out the transcript block for this turn.
      if (transcript) {
        try {
          transcript.turnEnd({
            durationMs: finalDurMs,
            charsOut,
            toolCalls,
            tooManyTurns,
            aborted: opts.signal.aborted,
            error: finalIsError,
          });
        } catch {
          /* ignore */
        }
        // Fire-and-forget close — we don't await it because the promise must
        // resolve *now* so the SSE caller can clean up.
        transcript.close().catch(() => {
          /* stream already closed */
        });
      }

      // Persistiere die Assistant-Response im Event-Log (Cross-Device, Replay).
      logResponseReceived({
        reqId: logReqId,
        workspaceId: opts.workspaceId,
        sessionId: handle.sessionId,
        text: piiDetok(responseText),
        tool_calls: toolCalls,
        duration_ms: finalDurMs,
        subtype: tooManyTurns ? 'too_many_turns' : finalIsError ? 'error' : 'success',
        aborted: opts.signal.aborted,
      });

      // N8-Trace · chat_ledger Assistant-Response (BACKPORT-01 · 2026-05-24)
      // Best-effort — ein Ledger-Fehler darf den Chat-Stream NIEMALS killen.
      // contentFull = completionContent (vollständiger responseText verbatim, N1).
      // coordKey = workspaceId (minimaler ManifestCoord, N9).
      // conversationThreadId = pendingPromptId falls mitgegeben (bindet an den
      // User-Message-Ledger-Eintrag); Fallback auf logReqId (immer non-empty).
      // Berechnet nach completionContent, weil finalResultText vs. responseText
      // erst an dieser Stelle final feststeht.
      {
        const ledgerCompletionContent =
          finalResultText && finalResultText.trim().length > 0
            ? finalResultText
            : responseText;
        try {
          appendLedgerRow(getAgentDb(), {
            coordKey: opts.workspaceId,
            role: 'assistant',
            contentFull: piiDetok(ledgerCompletionContent),
            conversationThreadId: opts.pendingPromptId ?? logReqId,
          });
        } catch (err) {
          console.warn(
            '[workspace-session] appendLedgerRow(assistant) failed (non-fatal):',
            err instanceof Error ? err.message : String(err),
          );
        }
      }

      // Phase MS · 2026-04-26: emit chat_message_completed as a first-class
      // event. Cross-device visibility, realtime push via the event
      // stream, migration source. Complementary to the chat_turn audit above:
      //   chat_turn               → audit log (entity_type=chat_turn)
      //   chat_message_completed  → UI history source (entity_type=chat_message)
      //
      // 2026-04-26 (P1-2): persist AWAITED — then `result_event_id`
      // to the caller via onResultEventId. Only then resolve(). The
      // agent server can then write the `result_event_id` SSE frame
      // BEFORE it closes the stream → the client knows the real event.id
      // and can cleanly dedupe its echo from the live event stream.
      const completionEntityId = ulid();
      const completionContent =
        finalResultText && finalResultText.trim().length > 0
          ? finalResultText
          : responseText;
      const outcome: 'ok' | 'aborted' | 'error' = opts.signal.aborted
        ? 'aborted'
        : finalIsError
          ? 'error'
          : 'ok';

      // Streaming recovery V2: before the completed persist, write the
      // latest state once more (edge case: the last tokens arrived just before
      // close, the 1500-ms timer hasn't captured them yet). After that
      // we stop the periodic timer; the DELETE of the row happens only after
      // a successful `emitChatMessageCompleted` (see the `.then` block).
      if (snapshotWriter) {
        try {
          snapshotWriter.flushFinal();
        } catch {
          /* swallow — completion path must not fail on snapshot write */
        }
        snapshotWriter.cancel();
      }

      emitChatMessageCompleted({
        workspaceId: opts.workspaceId,
        entityId: completionEntityId,
        // PII vault: persist the REAL text (history/reload source); the cloud
        // only ever saw tokens, the model echoes them back, we rehydrate here.
        content: piiDetok(completionContent),
        durationMs: finalDurMs,
        outcome,
        partial: outcome !== 'ok',
        toolCalls: toolCallSummaries,
        sessionId: handle.sessionId,
        // Explicit: ChatShell renders assistant bubbles independent of the
        // actor (all agents are shown as "response"), but we
        // mark the sender in the payload so audits / later multi-
        // agent setups (sub-agent spawns) see the origin.
        actor: 'agent:claude',
      })
        .then((event) => {
          // P1-2: the caller (agent-server) gets the real event.id
          // (ULID). Passed on as the SSE frame `result_event_id`.
          if (opts.onResultEventId) {
            try {
              opts.onResultEventId(event.id);
            } catch {
              /* user-callback errors are not our problem */
            }
          }

          // Streaming recovery V2: chat_message_completed is persisted
          // — clean up the snapshot row. Idempotent (DELETE on a non-
          // existent row is a no-op). If this step fails,
          // the row stays and is delivered as 'aborted' on the next history
          // read — not ideal, but no data loss.
          if (snapshotWriter) {
            try {
              snapshotWriter.deleteRow();
            } catch {
              /* swallow — leftover row will age out via 10s heuristic */
            }
          }

          // Push trigger only on a successful persist — otherwise the
          // push could potentially reference a message that is not in the DB
          // and is missing there on reopen.
          // Best-effort: niemals den emitter werfen lassen.
          try {
            onChatMessageCompleted({
              workspaceId: opts.workspaceId,
              workspaceLabel: getWorkspace(opts.workspaceId)?.label ?? opts.workspaceId,
              content: completionContent,
              outcome,
            });
          } catch (err) {
            console.warn(
              '[workspace-session] onChatMessageCompleted failed:',
              err instanceof Error ? err.message : err,
            );
          }

          // Phase QA (2026-04-28): persist token consumption in the rolling
          // window. Estimate via content-chars/4 because the exact
          // token counts do not come inline from the stream. Input is
          // roughly derived from prompt+system-prompt length.
          try {
            const inputChars = opts.prompt.length;
            const outputChars = completionContent.length;
            recordTokens(
              `workspace-session`,
              opts.workspaceId,
              {
                input: Math.floor(inputChars / 4),
                output: Math.floor(outputChars / 4),
                cacheRead: 0,
              },
              0,
            );
          } catch {
            /* swallow — TPM tracking is best-effort */
          }

          // 2026-04-30: also for bare chat responses (no iterate workstream)
          // convert [?] questions into a <surface:open-questions> card with QuickChoice.
          // Otherwise the user has to type instead of click.
          (async () => {
            try {
              const { parsePlanQuestions } = await import(
                '../lib/workstreams/parse-plan-questions'
              );
              const qs = parsePlanQuestions(completionContent);
              if (qs.length === 0) return;
              const { emitOrUpdateCard } = await import(
                '../lib/events/emit-or-update-card'
              );
              const surfacePayload = {
                workstreamId: 'chat:' + opts.workspaceId,
                version: 0,
                questions: qs.map((q) => ({
                  id: q.id,
                  q: q.text,
                  ...(q.options && q.options.length > 0
                    ? { options: q.options }
                    : {}),
                })),
              };
              const text = `<surface:open-questions>${JSON.stringify(surfacePayload)}</surface:open-questions>`;
              await emitOrUpdateCard({
                coords: {
                  workspaceId: opts.workspaceId,
                  workstreamId: 'chat:' + opts.workspaceId,
                  surfaceKind: 'open-questions',
                },
                content: text,
                actor: 'system',
              });
            } catch (err) {
              console.warn(
                '[workspace-session] emitOpenQuestionsForChat failed:',
                err instanceof Error ? err.message : err,
              );
            }
          })().catch(() => undefined);
        })
        .catch((err) => {
          console.warn(
            '[workspace-session] emitChatMessageCompleted failed:',
            err instanceof Error ? err.message : err,
          );
        })
        .finally(() => {
          // resolve() now — not right after `done`. This blocks the
          // SSE stream close minimally (DB INSERT + ULID), but guarantees
          // that `result_event_id` goes out BEFORE the stream end.
          resolve();
        });
    });
  });
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function previewJson(input: unknown): string {
  try {
    const raw = JSON.stringify(input ?? {});
    return raw.length > 2048 ? raw.slice(0, 2045) + '...' : raw;
  } catch {
    return '"<unserialisable>"';
  }
}

function previewToolOutput(content: unknown): string {
  let raw = '';
  if (typeof content === 'string') {
    raw = content;
  } else if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const b of content as Array<{ type?: string; text?: string }>) {
      if (b && typeof b === 'object' && typeof b.text === 'string') parts.push(b.text);
    }
    raw = parts.join('\n');
  } else {
    try {
      raw = JSON.stringify(content);
    } catch {
      raw = '<unserialisable>';
    }
  }
  return raw.length > 1024 ? raw.slice(0, 1021) + '...' : raw;
}

// ---------------------------------------------------------------------------
// Discovery for /health + /session/list.
// ---------------------------------------------------------------------------

export interface ActiveSessionSummary {
  workspaceId: string;
  workspaceLabel: string | null;
  sessionId: string;
  lastPromptAt: number;
  turnCount: number;
  lastResult: string | null;
  tmuxSession: string;
  tmuxAttached: boolean;
}

export async function listActiveSessions(): Promise<ActiveSessionSummary[]> {
  const db = getAgentDb();
  const rows = db
    .prepare(
      `SELECT cs.workspace_id AS workspaceId,
              cs.session_id    AS sessionId,
              cs.last_prompt_at AS lastPromptAt,
              cs.turn_count    AS turnCount,
              cs.last_result   AS lastResult,
              w.label          AS workspaceLabel
         FROM claude_sessions cs
         LEFT JOIN workspaces w ON w.id = cs.workspace_id
        ORDER BY cs.last_prompt_at DESC`,
    )
    .all() as Array<{
      workspaceId: string;
      sessionId: string;
      lastPromptAt: number;
      turnCount: number;
      lastResult: string | null;
      workspaceLabel: string | null;
    }>;

  // Cross-reference tmux presence.
  const { listSessions } = await import('./tmux-controller');
  let tmuxSessions: Array<{ name: string; attached: boolean }> = [];
  try {
    tmuxSessions = (await listSessions(TMUX_PREFIX)).map((s) => ({
      name: s.name,
      attached: s.attached,
    }));
  } catch {
    /* tmux unavailable → leave tmux flags false */
  }
  const tmuxByName = new Map(tmuxSessions.map((t) => [t.name, t.attached]));

  return rows.map((r) => {
    const name = tmuxSessionName(r.workspaceId);
    return {
      workspaceId: r.workspaceId,
      workspaceLabel: r.workspaceLabel,
      sessionId: r.sessionId,
      lastPromptAt: r.lastPromptAt,
      turnCount: r.turnCount,
      lastResult: r.lastResult,
      tmuxSession: name,
      tmuxAttached: tmuxByName.get(name) ?? false,
    };
  });
}
