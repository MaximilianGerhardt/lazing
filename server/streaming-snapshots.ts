/**
 * lazyOS · Agent-Server · streaming_snapshots writer
 * ---------------------------------------------------
 *
 * Ephemeral UPSERT/DELETE helpers for the `streaming_snapshots` table
 * (migration `0018_streaming_snapshots.sql`). Used by
 * `workspace-session.ts:sendPrompt` to persist the partial state every 1500 ms
 * during a streaming Anthropic response — reload
 * recovery V2 (see `/tmp/recovery-syn.txt` points 1-3).
 *
 * Lifecycle per pendingPromptId:
 *   1. `createSnapshotWriter({pendingPromptId, workspaceId})` →
 *      starts a 1500 ms timer.
 *   2. On each token: `writer.appendToken(text)` (accumulates locally).
 *   3. On tool_call/tool_result: `writer.setToolState({...})` /
 *      `writer.clearToolState()`.
 *   4. On the timer: UPSERT with the current state. The backtick counter counts
 *      an odd number of ``` as `in_code_block=1`.
 *   5. Before `chat_message_completed`: `writer.flushFinal()` writes the
 *      last state synchronously, then `writer.deleteRow()` cleans up.
 *   6. On crash/shutdown: `writer.cancel()` stops the timer but
 *      leaves the row — the history endpoint shows it after 10 s
 *      as `state='aborted'`.
 *
 * Best-effort: all DB calls are in try/catch — if the DB fails,
 * we log and the stream continues anyway.
 */

import type Database from 'better-sqlite3';

import { getAgentDb } from './db';

/** Active tool call during the stream. */
export interface SnapshotToolState {
  /** Tool name from the Anthropic frame (e.g. 'Bash', 'Read'). */
  name: string;
  /** 'pending' as long as no tool_result came, 'done' after the result frame. */
  status: 'pending' | 'done';
  /** Optional tool-use ID for tracker matching. */
  id?: string | null;
}

export interface SnapshotWriterOptions {
  pendingPromptId: string;
  workspaceId: string;
  /** Override for tests. Default 1500 ms. */
  intervalMs?: number;
  /** Override for tests. Default Date.now. */
  now?: () => number;
}

export interface SnapshotWriter {
  /** Append a new token chunk to `partial_content`. */
  appendToken: (text: string) => void;
  /** Active tool call (pending). Serialized into `tool_state` JSON. */
  setToolState: (state: SnapshotToolState) => void;
  /** Clear the current tool state (e.g. after tool_result). */
  clearToolState: () => void;
  /**
   * Last UPSERT before `chat_message_completed`. Synchronous. Idempotent —
   * if the timer already wrote the same thing, the row is simply
   * overwritten with `updated_at = now`.
   */
  flushFinal: () => void;
  /**
   * DELETE the row. Call after a successful `chat_message_completed`
   * persist. Idempotent — DELETE on a non-existent row is a no-op.
   */
  deleteRow: () => void;
  /**
   * Stops the periodic writer. Leaves the DB row untouched (crash
   * path — the history endpoint marks it as `aborted` after 10 s).
   */
  cancel: () => void;
}

/**
 * Counts the number of unclosed markdown code-block fences in `text`.
 * Naive but sufficient heuristic (see Synthesis point 1):
 * `` ``` `` (three backticks at the start of a line or mid-text) -> toggle.
 * We simply count all occurrences — on an odd number the
 * stream is inside a code block.
 */
export function detectInCodeBlock(text: string): boolean {
  if (!text) return false;
  // Greedy match on "```" (three backticks). Inline backticks (`code`)
  // are NOT counted as a block — acceptable for the heuristic.
  const matches = text.match(/```/g);
  if (!matches) return false;
  return matches.length % 2 === 1;
}

/**
 * Creates a writer that UPSERTs its state every `intervalMs`.
 *
 * The writer is NOT thread-safe — `sendPrompt` is single-event-loop,
 * so OK. The periodic timer and `flushFinal()` are the only
 * write paths; both use the same prepared statement.
 */
export function createSnapshotWriter(
  opts: SnapshotWriterOptions,
): SnapshotWriter {
  const intervalMs = opts.intervalMs ?? 1500;
  const now = opts.now ?? (() => Date.now());

  let partialContent = '';
  let toolState: SnapshotToolState | null = null;
  const startedAt = now();

  let upsertStmt: Database.Statement | null = null;
  let deleteStmt: Database.Statement | null = null;
  try {
    const db = getAgentDb();
    upsertStmt = db.prepare(
      `INSERT INTO streaming_snapshots
         (pending_prompt_id, workspace_id, partial_content, tool_state,
          in_code_block, started_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(pending_prompt_id) DO UPDATE SET
         partial_content = excluded.partial_content,
         tool_state      = excluded.tool_state,
         in_code_block   = excluded.in_code_block,
         updated_at      = excluded.updated_at`,
    );
    deleteStmt = db.prepare(
      `DELETE FROM streaming_snapshots WHERE pending_prompt_id = ?`,
    );
  } catch (err) {
    console.warn(
      '[streaming-snapshots] DB prepare failed:',
      err instanceof Error ? err.message : err,
    );
  }

  const writeOnce = (): void => {
    if (!upsertStmt) return;
    try {
      const ts = now();
      const inCode = detectInCodeBlock(partialContent) ? 1 : 0;
      const toolJson = toolState ? JSON.stringify(toolState) : null;
      upsertStmt.run(
        opts.pendingPromptId,
        opts.workspaceId,
        partialContent,
        toolJson,
        inCode,
        startedAt,
        ts,
      );
    } catch (err) {
      // Best-effort: the snapshot write is NOT critical for the stream.
      console.warn(
        '[streaming-snapshots] upsert failed:',
        err instanceof Error ? err.message : err,
      );
    }
  };

  let timer: NodeJS.Timeout | null = setInterval(writeOnce, intervalMs);
  // So the Node process does not hang on the timer when everything
  // else is finished (crash cleanup).
  if (timer && typeof timer.unref === 'function') timer.unref();

  return {
    appendToken: (text: string): void => {
      if (text) partialContent += text;
    },
    setToolState: (state: SnapshotToolState): void => {
      toolState = state;
    },
    clearToolState: (): void => {
      toolState = null;
    },
    flushFinal: (): void => {
      writeOnce();
    },
    deleteRow: (): void => {
      if (!deleteStmt) return;
      try {
        deleteStmt.run(opts.pendingPromptId);
      } catch (err) {
        console.warn(
          '[streaming-snapshots] delete failed:',
          err instanceof Error ? err.message : err,
        );
      }
    },
    cancel: (): void => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
