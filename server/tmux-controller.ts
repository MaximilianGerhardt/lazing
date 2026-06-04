/**
 * lazyOS — tmux controller
 *
 * Thin pure-bash wrapper around the `tmux` CLI. The public API mirrors the
 * spec in the Stream A' brief (2026-04-24). These helpers are intentionally
 * leaf utilities — no business logic, no DB touches, no Claude-CLI glue.
 *
 * ## Why tmux at all?
 *
 * The agent transport itself runs through `claude --print --output-format
 * stream-json` spawned directly from Node (see `workspace-session.ts`).
 * That removes the need for ANSI parsing and gives us a proper JSONL stream.
 *
 * tmux is still useful for TWO reasons:
 *
 *   1. **Human attach.** Max can `tmux attach -t lazyos-ws-<id>` on the VPS
 *      to manually drop into a workspace shell that shares cwd + env with
 *      the agent. This is the "persistent per-workspace surface" that the
 *      memory pin (project_lazyos_architecture_tmux_claude_code.md) asks for.
 *
 *   2. **Background shell.** A long-running interactive shell pinned to the
 *      workspace cwd for future Stream A'+1 features (live terminal in the
 *      PWA via pipe-pane). The agent itself does NOT need the tmux pane —
 *      it talks to Claude via its own spawn — but the tmux session exists
 *      so the workspace always has a "home" on the VPS.
 *
 * Session names are always `lazyos-ws-<workspaceId>` with workspaceId
 * validated as `[a-z0-9][a-z0-9_-]{0,63}` upstream, but we also sanity-check
 * here in case a caller bypasses the API layer.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { Writable } from 'node:stream';

// ---------------------------------------------------------------------------
// Session-name validation + helpers.
// ---------------------------------------------------------------------------

const SESSION_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,127}$/;

export function assertSafeSessionName(name: string): void {
  if (!SESSION_NAME_RE.test(name)) {
    throw new Error(`tmux_controller: unsafe session name "${name}"`);
  }
}

function execTmux(
  args: string[],
  opts: { input?: string; timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn('tmux', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const to = opts.timeoutMs
      ? setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            /* ignore */
          }
          reject(new Error(`tmux timeout after ${opts.timeoutMs}ms: tmux ${args.join(' ')}`));
        }, opts.timeoutMs)
      : null;
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    child.on('error', (err) => {
      if (to) clearTimeout(to);
      reject(err);
    });
    child.on('close', (code) => {
      if (to) clearTimeout(to);
      resolve({ stdout, stderr, code: code ?? -1 });
    });
    if (opts.input !== undefined) {
      child.stdin.end(opts.input);
    } else {
      child.stdin.end();
    }
  });
}

// ---------------------------------------------------------------------------
// Session lifecycle.
// ---------------------------------------------------------------------------

export async function tmuxAvailable(): Promise<boolean> {
  try {
    const r = await execTmux(['-V'], { timeoutMs: 2000 });
    return r.code === 0;
  } catch {
    return false;
  }
}

export async function sessionExists(name: string): Promise<boolean> {
  assertSafeSessionName(name);
  try {
    const r = await execTmux(['has-session', '-t', name], { timeoutMs: 2000 });
    return r.code === 0;
  } catch {
    return false;
  }
}

export interface CreateSessionOpts {
  name: string;
  cwd: string;
  /** Shell command to run as the initial pane. Defaults to `$SHELL || /bin/bash`. */
  command?: string;
  /** Initial pane width/height — affects `capture-pane -e` output. */
  width?: number;
  height?: number;
  /** Extra environment variables set on the pane (e.g. `HOME=/root`). */
  env?: Record<string, string>;
}

export async function createSession(opts: CreateSessionOpts): Promise<void> {
  assertSafeSessionName(opts.name);
  const cmd = opts.command ?? process.env.SHELL ?? '/bin/bash';
  const args = [
    'new-session',
    '-d',
    '-s',
    opts.name,
    '-c',
    opts.cwd,
    '-x',
    String(opts.width ?? 200),
    '-y',
    String(opts.height ?? 50),
  ];
  if (opts.env) {
    for (const [k, v] of Object.entries(opts.env)) {
      if (!/^[A-Z_][A-Z0-9_]*$/.test(k)) continue;
      args.push('-e', `${k}=${v}`);
    }
  }
  // `--` ends tmux option parsing; everything after is the literal command+args.
  args.push('--', cmd);
  const r = await execTmux(args, { timeoutMs: 5000 });
  if (r.code !== 0) {
    throw new Error(`tmux create-session "${opts.name}" failed: ${r.stderr || r.stdout}`);
  }
}

export async function killSession(name: string): Promise<void> {
  assertSafeSessionName(name);
  const r = await execTmux(['kill-session', '-t', name], { timeoutMs: 5000 });
  // rc=1 means session didn't exist — that's fine.
  if (r.code !== 0 && !/session not found|can't find session/i.test(r.stderr)) {
    throw new Error(`tmux kill-session "${name}" failed: ${r.stderr || r.stdout}`);
  }
}

// ---------------------------------------------------------------------------
// Send / capture / pipe.
// ---------------------------------------------------------------------------

/**
 * Send literal text to a tmux pane. `pressEnter` appends a newline (Enter).
 * `text` goes through `send-keys -l` (literal) so special shell characters
 * are preserved verbatim. The newline is sent as the named key `Enter` in a
 * separate call so it's reliably registered as a line-submit.
 */
export async function sendKeys(
  name: string,
  text: string,
  pressEnter: boolean = false,
): Promise<void> {
  assertSafeSessionName(name);
  // Split on newlines — each line sent literally, Enter between them.
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.length > 0) {
      const r = await execTmux(['send-keys', '-t', name, '-l', '--', line], { timeoutMs: 5000 });
      if (r.code !== 0) {
        throw new Error(`tmux send-keys (literal) failed: ${r.stderr || r.stdout}`);
      }
    }
    if (i < lines.length - 1) {
      const r = await execTmux(['send-keys', '-t', name, 'Enter'], { timeoutMs: 5000 });
      if (r.code !== 0) {
        throw new Error(`tmux send-keys (Enter between) failed: ${r.stderr || r.stdout}`);
      }
    }
  }
  if (pressEnter) {
    const r = await execTmux(['send-keys', '-t', name, 'Enter'], { timeoutMs: 5000 });
    if (r.code !== 0) {
      throw new Error(`tmux send-keys (final Enter) failed: ${r.stderr || r.stdout}`);
    }
  }
}

/** Send a literal control key, e.g. `C-c` to SIGINT, `C-d` for EOF. */
export async function sendControl(name: string, key: string): Promise<void> {
  assertSafeSessionName(name);
  if (!/^[A-Z]-[a-zA-Z]$/.test(key)) {
    throw new Error(`tmux_controller: unsafe control sequence "${key}"`);
  }
  const r = await execTmux(['send-keys', '-t', name, key], { timeoutMs: 5000 });
  if (r.code !== 0) {
    throw new Error(`tmux send-control ${key} failed: ${r.stderr || r.stdout}`);
  }
}

/**
 * Send a tmux-named key (Enter, Up, Down, Tab, Escape, ...) into a specific
 * pane. Whitelisted in caller — this helper trusts that `key` is already
 * validated. `paneIndex` constraint identical to `sendKeysToPane`.
 */
export async function sendNamedKeyToPane(
  name: string,
  paneIndex: number,
  key: string,
): Promise<void> {
  assertSafeSessionName(name);
  if (!Number.isInteger(paneIndex) || paneIndex < 0 || paneIndex > 99) {
    throw new Error(`tmux_controller: unsafe pane index ${paneIndex}`);
  }
  if (!/^[A-Za-z][A-Za-z0-9]{0,15}$/.test(key)) {
    throw new Error(`tmux_controller: unsafe named key "${key}"`);
  }
  const target = `${name}.${paneIndex}`;
  const r = await execTmux(['send-keys', '-t', target, key], { timeoutMs: 5000 });
  if (r.code !== 0) {
    throw new Error(`tmux send-named-key ${key} failed: ${r.stderr || r.stdout}`);
  }
}

export interface CaptureOpts {
  /** Capture history start (negative = lines back from current). Default: visible pane only. */
  start?: number;
  /** Capture history end. Defaults to bottom of pane. */
  end?: number;
  /** Keep ANSI escape codes (default false — plain text). */
  ansi?: boolean;
  /** Include pane history (`-p -S start -E end`). */
  history?: boolean;
}

export async function capturePane(name: string, opts: CaptureOpts = {}): Promise<string> {
  assertSafeSessionName(name);
  const args = ['capture-pane', '-p', '-t', name];
  if (opts.ansi) args.push('-e');
  if (opts.history && typeof opts.start === 'number') {
    args.push('-S', String(opts.start));
    if (typeof opts.end === 'number') args.push('-E', String(opts.end));
  }
  const r = await execTmux(args, { timeoutMs: 5000 });
  if (r.code !== 0) {
    throw new Error(`tmux capture-pane "${name}" failed: ${r.stderr || r.stdout}`);
  }
  return r.stdout;
}

/**
 * Start `tmux pipe-pane -o` streaming the live pane output to the given
 * writable stream. The returned ChildProcess is the `cat` that reads from
 * the tmux-managed FIFO. Kill it (or call `pipePaneStop`) to stop.
 *
 * Implementation note: tmux's `pipe-pane -t <name> 'cat >> /tmp/x'` opens
 * the target command with the pane stdout piped into it. We use a named
 * pipe (FIFO) so we can stream from Node without a disk round-trip.
 *
 * NOT used by the current chat path (we talk to Claude directly via
 * child_process.spawn). Kept here for future "live terminal mirror in PWA"
 * features.
 */
export async function pipePaneStart(
  name: string,
  output: Writable,
): Promise<ChildProcess> {
  assertSafeSessionName(name);
  const fifoPath = `/tmp/lazyos-pipe-${name}-${process.pid}-${Date.now()}.fifo`;
  // Create FIFO
  const mkfifo = spawn('mkfifo', [fifoPath]);
  await new Promise<void>((resolve, reject) => {
    mkfifo.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`mkfifo rc=${c}`))));
    mkfifo.on('error', reject);
  });
  // Start a cat that reads from the FIFO into the provided writable.
  const reader = spawn('cat', [fifoPath]);
  reader.stdout.pipe(output, { end: false });
  reader.on('close', () => {
    try {
      spawn('rm', ['-f', fifoPath]);
    } catch {
      /* ignore */
    }
  });
  // Tell tmux to pipe the pane into the FIFO.
  const pipeCmd = `cat > ${fifoPath}`;
  const r = await execTmux(['pipe-pane', '-o', '-t', name, pipeCmd], { timeoutMs: 5000 });
  if (r.code !== 0) {
    try {
      reader.kill('SIGKILL');
    } catch {
      /* ignore */
    }
    throw new Error(`tmux pipe-pane start failed: ${r.stderr || r.stdout}`);
  }
  return reader;
}

export async function pipePaneStop(name: string): Promise<void> {
  assertSafeSessionName(name);
  // `pipe-pane` with no command toggles it off.
  const r = await execTmux(['pipe-pane', '-t', name], { timeoutMs: 5000 });
  if (r.code !== 0) {
    throw new Error(`tmux pipe-pane stop "${name}" failed: ${r.stderr || r.stdout}`);
  }
}

// ---------------------------------------------------------------------------
// Pane management — split-window / list-panes / select-pane.
// Used by the "transcript mirror" layout where pane 0 tails the chat log
// and pane 1 is an interactive Bash in the workspace cwd.
// ---------------------------------------------------------------------------

export interface SplitWindowOpts {
  /** Target session (no `:window.pane` suffix — we operate on the base). */
  name: string;
  /** `-v` horizontal split (stacked), `-h` vertical split (side-by-side). */
  direction: 'v' | 'h';
  /**
   * Percentage size of the NEW pane (the one the command will run in).
   * tmux `-p <pct>` — e.g. 70 means the new pane takes 70% of the space.
   */
  percent?: number;
  /** cwd for the new pane. */
  cwd?: string;
  /** Command for the new pane (defaults to $SHELL). */
  command?: string;
}

/**
 * Split the current/only window of the named session. Returns nothing —
 * caller is expected to know the resulting pane layout (pane 0 is the
 * original, pane 1 is the new one for a single split; further splits shift
 * indices).
 */
export async function splitWindow(opts: SplitWindowOpts): Promise<void> {
  assertSafeSessionName(opts.name);
  const args = ['split-window', `-${opts.direction}`, '-t', opts.name];
  if (typeof opts.percent === 'number') {
    // tmux 3.1+ prefers `-l <size>[%]`; `-p <pct>` was removed in 3.4.
    const pct = Math.max(10, Math.min(90, Math.trunc(opts.percent)));
    args.push('-l', `${pct}%`);
  }
  if (opts.cwd) {
    args.push('-c', opts.cwd);
  }
  if (opts.command) {
    args.push('--', opts.command);
  }
  const r = await execTmux(args, { timeoutMs: 5000 });
  if (r.code !== 0) {
    throw new Error(`tmux split-window "${opts.name}" failed: ${r.stderr || r.stdout}`);
  }
}

export interface PaneInfo {
  index: number;
  command: string;
  width: number;
  height: number;
  active: boolean;
}

/**
 * List panes in the (first window of the) named session. Returns an empty
 * array if the session doesn't exist.
 */
export async function listPanes(name: string): Promise<PaneInfo[]> {
  assertSafeSessionName(name);
  const r = await execTmux(
    [
      'list-panes',
      '-t',
      name,
      '-F',
      '#{pane_index}\t#{pane_current_command}\t#{pane_width}\t#{pane_height}\t#{pane_active}',
    ],
    { timeoutMs: 5000 },
  );
  if (r.code !== 0) {
    // Session gone → treat as empty. Upstream decides whether to recreate.
    if (/can't find session|session not found|no server running/i.test(r.stderr)) {
      return [];
    }
    throw new Error(`tmux list-panes "${name}" failed: ${r.stderr || r.stdout}`);
  }
  const out: PaneInfo[] = [];
  for (const line of r.stdout.split('\n')) {
    if (!line.trim()) continue;
    const [idx, cmd, w, h, active] = line.split('\t');
    if (idx === undefined) continue;
    out.push({
      index: Number(idx),
      command: cmd ?? '',
      width: Number(w) || 0,
      height: Number(h) || 0,
      active: active === '1',
    });
  }
  return out;
}

export async function selectPane(name: string, paneIndex: number): Promise<void> {
  assertSafeSessionName(name);
  if (!Number.isInteger(paneIndex) || paneIndex < 0 || paneIndex > 99) {
    throw new Error(`tmux_controller: unsafe pane index ${paneIndex}`);
  }
  const r = await execTmux(['select-pane', '-t', `${name}.${paneIndex}`], { timeoutMs: 5000 });
  if (r.code !== 0) {
    throw new Error(`tmux select-pane ${name}.${paneIndex} failed: ${r.stderr || r.stdout}`);
  }
}

/**
 * Send keys to a specific pane (not just the session's active pane).
 * Used to bootstrap `tail -f` inside pane 0 without disturbing pane 1.
 */
export async function sendKeysToPane(
  name: string,
  paneIndex: number,
  text: string,
  pressEnter: boolean = false,
): Promise<void> {
  assertSafeSessionName(name);
  if (!Number.isInteger(paneIndex) || paneIndex < 0 || paneIndex > 99) {
    throw new Error(`tmux_controller: unsafe pane index ${paneIndex}`);
  }
  const target = `${name}.${paneIndex}`;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.length > 0) {
      const r = await execTmux(['send-keys', '-t', target, '-l', '--', line], { timeoutMs: 5000 });
      if (r.code !== 0) {
        throw new Error(`tmux send-keys (pane) failed: ${r.stderr || r.stdout}`);
      }
    }
    if (i < lines.length - 1) {
      const r = await execTmux(['send-keys', '-t', target, 'Enter'], { timeoutMs: 5000 });
      if (r.code !== 0) {
        throw new Error(`tmux send-keys (pane Enter between) failed: ${r.stderr || r.stdout}`);
      }
    }
  }
  if (pressEnter) {
    const r = await execTmux(['send-keys', '-t', target, 'Enter'], { timeoutMs: 5000 });
    if (r.code !== 0) {
      throw new Error(`tmux send-keys (pane final Enter) failed: ${r.stderr || r.stdout}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Listing.
// ---------------------------------------------------------------------------

export interface SessionInfo {
  name: string;
  created: number; // unix seconds
  windows: number;
  attached: boolean;
}

export async function listSessions(prefix?: string): Promise<SessionInfo[]> {
  const r = await execTmux(
    ['list-sessions', '-F', '#{session_name}\t#{session_created}\t#{session_windows}\t#{session_attached}'],
    { timeoutMs: 5000 },
  );
  // `list-sessions` exits 1 if no sessions — that's not an error.
  if (r.code !== 0) {
    if (/no server running|no sessions/i.test(r.stderr)) return [];
    throw new Error(`tmux list-sessions failed: ${r.stderr || r.stdout}`);
  }
  const out: SessionInfo[] = [];
  for (const line of r.stdout.split('\n')) {
    if (!line.trim()) continue;
    const [name, created, windows, attached] = line.split('\t');
    if (!name) continue;
    if (prefix && !name.startsWith(prefix)) continue;
    out.push({
      name,
      created: Number(created) || 0,
      windows: Number(windows) || 1,
      attached: attached === '1',
    });
  }
  return out;
}
