/**
 * lazyOS — transcript writer
 *
 * Writes a human-readable, ANSI-coloured chat transcript to a per-workspace
 * log file (`/tmp/lazyos-transcript-<workspaceId>.log`). That file is
 * `tail -f`-ed in the top pane of the workspace's tmux session
 * (`lazyos-ws-<workspaceId>`), so when Max runs
 *
 *     tmux attach -t lazyos-ws-lazyos
 *
 * he sees the live chat stream in the top pane while the bottom pane stays
 * a plain Bash in the workspace cwd.
 *
 * ## Design (Option C1)
 *
 * - The JSONL transport between Node and Claude-CLI stays unchanged (see
 *   `workspace-session.ts`). That's the authoritative, SSE-generating path.
 * - This writer is a *secondary observer*: every onEvent callback also
 *   formats a coloured line and appends it to the transcript file.
 * - `tail -f` inside the tmux pane renders those lines with ANSI codes
 *   resolved (tmux is a VT100/xterm terminal, so \e[ sequences work).
 * - The file is append-only per session; on openTranscript we trim to the
 *   last MAX_LINES lines so it cannot grow unbounded across many turns.
 *
 * ## Why not send-keys?
 *
 * Writing to a log file + tail -f avoids needing send-keys for every token
 * (which would shell-escape, fight the prompt, and can't render partial
 * tokens smoothly). The file is also available for debugging even when the
 * tmux session isn't attached.
 */

import { createWriteStream, existsSync, readFileSync, writeFileSync, type WriteStream } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// ---------------------------------------------------------------------------
// Constants.
// ---------------------------------------------------------------------------

const LOG_DIR = '/tmp';
const MAX_LINES_ON_OPEN = 10_000;
const TOOL_RESULT_PREVIEW = 200;
const INPUT_PREVIEW = 200;

// ANSI colour codes — tmux renders these via its built-in terminal emulator.
const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  italic: '\x1b[3m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
  gray: '\x1b[90m',
} as const;

// ---------------------------------------------------------------------------
// Path helpers.
// ---------------------------------------------------------------------------

// Identical pattern to agent-server.ts sanitizeWorkspaceId — allows
// _ and ( as the first character so special workspaces like __root__ pass.
const WS_SAFE_RE = /^[a-z0-9_(][a-z0-9_()-]{0,63}$/i;

export function transcriptPath(workspaceId: string): string {
  if (!WS_SAFE_RE.test(workspaceId)) {
    throw new Error(`transcript-writer: unsafe workspace id "${workspaceId}"`);
  }
  return `${LOG_DIR}/lazyos-transcript-${workspaceId}.log`;
}

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------

export interface TurnEndMeta {
  durationMs: number;
  charsOut: number;
  toolCalls: number;
  tooManyTurns?: boolean;
  aborted?: boolean;
  error?: boolean;
}

export interface TranscriptWriter {
  /** The on-disk path being written to. */
  path: string;
  /** Begin a turn block (header + prompt echo). */
  turnStart(turn: number, prompt: string): void;
  /** Stream a text token (no newline appended). */
  token(text: string): void;
  /** Record a tool-call invocation. */
  toolCall(name: string, inputPreview: string): void;
  /** Record a tool-result (first N chars, indented). */
  toolResult(outputPreview: string, isError?: boolean): void;
  /** Record a permission denial event. */
  permissionDenied(tool: string | null, reason: string | null): void;
  /** Record a non-fatal error event. */
  error(message: string): void;
  /** Close the turn block with a footer. Does not close the file. */
  turnEnd(meta: TurnEndMeta): void;
  /** Flush + close the underlying stream. */
  close(): Promise<void>;
}

/**
 * Open (create if missing) a transcript writer for a workspace. On open, if
 * the existing log has more than MAX_LINES_ON_OPEN lines it is trimmed in
 * place before the stream is attached. This caps disk usage without losing
 * the most recent context that Max may want to scroll back through.
 */
export function openTranscript(workspaceId: string): TranscriptWriter {
  const path = transcriptPath(workspaceId);

  // Ensure directory exists (almost always /tmp, but let's not assume).
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    /* directory exists */
  }

  // Trim existing file to last N lines so tail -f in the pane doesn't show
  // a multi-MB history on reconnect. Cheap: read, slice, rewrite.
  try {
    if (existsSync(path)) {
      const buf = readFileSync(path, 'utf8');
      const lines = buf.split('\n');
      if (lines.length > MAX_LINES_ON_OPEN) {
        const trimmed = lines.slice(-MAX_LINES_ON_OPEN).join('\n');
        writeFileSync(path, trimmed);
      }
    }
  } catch (err) {
    // Trim failure is non-fatal — we still open the stream.
    console.warn(
      `[transcript-writer] trim failed for ${path}:`,
      err instanceof Error ? err.message : err,
    );
  }

  const stream: WriteStream = createWriteStream(path, { flags: 'a' });
  // Mid-turn backpressure is irrelevant for human-readable logs; keep writes
  // fire-and-forget.
  stream.on('error', (err) => {
    console.warn(
      `[transcript-writer] stream error on ${path}:`,
      err instanceof Error ? err.message : err,
    );
  });

  const write = (s: string): void => {
    try {
      stream.write(s);
    } catch {
      /* swallow — we never want transcript I/O to break the chat path */
    }
  };

  // Track token chunks so we can force a newline before non-token events.
  let midLine = false;

  const endLine = (): void => {
    if (midLine) {
      write('\n');
      midLine = false;
    }
  };

  const writer: TranscriptWriter = {
    path,

    turnStart(turn: number, prompt: string): void {
      endLine();
      const time = new Date().toLocaleTimeString('de-DE', { hour12: false });
      const header = `\n${C.dim}─── Turn ${turn} · ${time} ───${C.reset}\n`;
      const promptLine = `${C.bold}${C.green}>${C.reset} ${prompt.trim().replace(/\r?\n/g, ' ')}\n\n`;
      write(header);
      write(promptLine);
    },

    token(text: string): void {
      if (!text) return;
      write(text);
      midLine = !text.endsWith('\n');
    },

    toolCall(name: string, inputPreview: string): void {
      endLine();
      const preview = truncate(inputPreview, INPUT_PREVIEW);
      write(`${C.cyan}[${name}]${C.reset} ${C.dim}${preview}${C.reset}\n`);
    },

    toolResult(outputPreview: string, isError?: boolean): void {
      endLine();
      const preview = truncate(outputPreview.replace(/\r?\n/g, ' '), TOOL_RESULT_PREVIEW);
      const arrow = isError ? `${C.red}↳${C.reset}` : `${C.gray}↳${C.reset}`;
      const body = isError ? `${C.red}${preview}${C.reset}` : `${C.dim}${C.italic}${preview}${C.reset}`;
      write(`  ${arrow} ${body}\n`);
    },

    permissionDenied(tool: string | null, reason: string | null): void {
      endLine();
      const t = tool ?? 'unknown-tool';
      const r = reason ? ` — ${reason}` : '';
      write(`${C.yellow}[permission_denied]${C.reset} ${t}${r}\n`);
    },

    error(message: string): void {
      endLine();
      write(`${C.red}[error]${C.reset} ${truncate(message, 400)}\n`);
    },

    turnEnd(meta: TurnEndMeta): void {
      endLine();
      const parts: string[] = [];
      parts.push(`${meta.durationMs}ms`);
      parts.push(`${meta.charsOut} chars`);
      parts.push(`${meta.toolCalls} tools`);
      if (meta.tooManyTurns) parts.push('too_many_turns');
      if (meta.aborted) parts.push('aborted');
      if (meta.error) parts.push('error');
      write(`\n${C.dim}──── end · ${parts.join(' · ')} ────${C.reset}\n`);
    },

    async close(): Promise<void> {
      return await new Promise<void>((resolve) => {
        stream.end(() => resolve());
      });
    },
  };

  return writer;
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}
