/**
 * lazyOS — Agent Backend (runs on Hetzner VPS as `lazyos-agent.service`,
 * port 4201). Exposed internally via cloudflared tunnel or direct loopback
 * from the Next.js process.
 *
 * ## Architecture (Stream A', 2026-04-24)
 *
 * The **v1** of this server embedded `@anthropic-ai/claude-agent-sdk`
 * directly and talked to `api.anthropic.com` using an API key. That meant
 * every lazyOS turn burned credits — even though Max is on the MAX-Plan
 * which already pays for Claude-Code terminal use. That was wrong.
 *
 * **v2** (this file) orchestrates the `claude` CLI per workspace instead.
 * Max runs Claude-Code on this VPS via his MAX-Plan; lazyOS spawns
 * `claude --print --input-format=stream-json --output-format=stream-json
 *         --include-partial-messages --resume <session-id>` per turn,
 * reusing a per-workspace session UUID so context persists across
 * invocations.
 *
 * See `workspace-session.ts` for the spawn + streaming logic and
 * `tmux-controller.ts` for the parallel human-attach surface. DB schema
 * extension lives in `db/migrations/0006_claude_sessions.sql`.
 *
 * ## Endpoints
 *
 *   POST /chat              Authenticated SSE. Body:
 *                             { messages: [{role, content}, ...],
 *                               workspaceId: string }
 *                           Emits events: ready | token | tool_call |
 *                             tool_result | permission_denied | error |
 *                             too_many_turns | done
 *
 *   POST /session/restart   Authenticated. Body: { workspaceId }. Nukes the
 *                           stored session-id (and tmux pane) so the next
 *                           /chat starts fresh.
 *
 *   GET  /session/list      Authenticated. Lists all known workspace
 *                           sessions with metadata.
 *
 *   GET  /health            Unauthenticated. Liveness + environment probe.
 *
 *   OPTIONS *               CORS preflight.
 *
 * ## Auth
 *
 *   `Authorization: Bearer <LAZYOS_CHAT_KEY>` OR
 *   `x-lazyos-key: <LAZYOS_CHAT_KEY>`. Timing-safe compare.
 *
 * ## CORS
 *
 *   `LAZYOS_CORS_ORIGINS` (comma-separated) is a strict allow-list. Server-
 *   to-server callers without Origin pass.
 *
 * ## Graceful shutdown
 *
 *   SIGTERM/SIGINT → abort in-flight streams, close server. Hard-exit after
 *   15s. systemd sends SIGTERM on `systemctl stop`.
 */

import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import {
  ensureSession,
  restartSession,
  sendPrompt,
  listActiveSessions,
  getWorkspace,
  type ParsedEvent,
} from './workspace-session';
import { tmuxAvailable, listSessions as tmuxListSessions } from './tmux-controller';

// ---------------------------------------------------------------------------
// Config.
// ---------------------------------------------------------------------------

const PORT = Number(process.env.LAZYOS_AGENT_PORT ?? 4201);
const HOST = process.env.LAZYOS_AGENT_HOST ?? '127.0.0.1';

const LAZYOS_CHAT_KEY = (process.env.LAZYOS_CHAT_KEY ?? '').trim();

const DEFAULT_ALLOW_ORIGINS = ['http://127.0.0.1:4200', 'http://localhost:4200'];
const ALLOW_ORIGINS = process.env.LAZYOS_CORS_ORIGINS
  ? process.env.LAZYOS_CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
  : DEFAULT_ALLOW_ORIGINS;

/** Max body size for /chat (256 KiB). */
const MAX_BODY_BYTES = 256 * 1024;

// ---------------------------------------------------------------------------
// Structured logging.
// ---------------------------------------------------------------------------

type LogLevel = 'info' | 'warn' | 'error';

function log(level: LogLevel, msg: string, extra?: Record<string, unknown>): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...(extra ?? {}),
  });
  if (level === 'error') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

// ---------------------------------------------------------------------------
// Small helpers — lifted from v1 server where still applicable.
// ---------------------------------------------------------------------------

function constantTimeEquals(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length === 0 || b.length === 0) return false;
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  const len = Math.max(ab.length, bb.length);
  const ap = Buffer.alloc(len);
  const bp = Buffer.alloc(len);
  ab.copy(ap);
  bb.copy(bp);
  const lenDiff = ab.length ^ bb.length;
  return timingSafeEqual(ap, bp) && lenDiff === 0;
}

function extractChatKey(req: http.IncomingMessage): string {
  const auth = (req.headers['authorization'] as string | undefined) ?? '';
  if (auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }
  const xKey = (req.headers['x-lazyos-key'] as string | undefined) ?? '';
  return xKey.trim();
}

function getClientIp(req: http.IncomingMessage): string {
  const xff = (req.headers['x-forwarded-for'] as string | undefined) ?? '';
  const first = xff.split(',')[0]?.trim();
  if (first) return first;
  const realIp = req.headers['x-real-ip'];
  if (typeof realIp === 'string' && realIp) return realIp;
  return req.socket.remoteAddress ?? 'unknown';
}

function resolveCorsOrigin(reqOrigin: string | undefined): string | null {
  if (!reqOrigin) return null;
  return ALLOW_ORIGINS.includes(reqOrigin) ? reqOrigin : null;
}

function applyCorsHeaders(res: http.ServerResponse, reqOrigin: string | undefined): void {
  const allow = resolveCorsOrigin(reqOrigin);
  if (allow) {
    res.setHeader('access-control-allow-origin', allow);
    res.setHeader('vary', 'origin');
  }
  res.setHeader('access-control-allow-methods', 'POST, OPTIONS, GET');
  res.setHeader('access-control-allow-headers', 'content-type, authorization, x-lazyos-key, accept');
  res.setHeader('access-control-max-age', '86400');
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  reqOrigin?: string,
): void {
  applyCorsHeaders(res, reqOrigin);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: http.IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    let total = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('payload_too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (!raw) return resolve({});
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('invalid_json'));
      }
    });
    req.on('error', reject);
  });
}

function scrubErrorMessage(raw: string): string {
  const trimmed = raw.split('\n')[0] ?? raw;
  return trimmed
    .replace(/\/(?:home|root|etc|var|tmp|usr)\/[\w./-]+/g, '<path>')
    .replace(/at\s+[\w.<>]+\s*\(?[^)]*\)?/g, '<frame>')
    .replace(/sk-[\w-]{20,}/g, '<secret>')
    .replace(/xoxb-[\w-]{10,}/g, '<secret>')
    .slice(0, 300);
}

// ---------------------------------------------------------------------------
// Input sanitisers.
// ---------------------------------------------------------------------------

type ChatMessage = { role: 'user' | 'assistant'; content: string };

function sanitizeMessages(raw: unknown): ChatMessage[] | null {
  if (!Array.isArray(raw)) return null;
  const out: ChatMessage[] = [];
  for (const m of raw) {
    if (!m || typeof m !== 'object') continue;
    const mm = m as Record<string, unknown>;
    const role: 'user' | 'assistant' | null =
      mm.role === 'assistant' ? 'assistant' : mm.role === 'user' ? 'user' : null;
    const content = typeof mm.content === 'string' ? mm.content : null;
    if (!role || !content) continue;
    if (content.length > 32_000) continue;
    out.push({ role, content });
  }
  while (out.length && out[0]!.role !== 'user') out.shift();
  return out;
}

function sanitizeWorkspaceId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;
  // Allowed: a-z, 0-9, _, -, (, ). The first character may also be _ or (,
  // so special workspaces like `__root__` pass. Optional prefix
  // `__org_root__:` for the org-root scope (Phase IA.1). Identical to the
  // pattern in the web routes (chat/stream, history, visibility) —
  // single source of the validation rule.
  if (!/^(?:__org_root__:)?[a-z0-9_(][a-z0-9_()-]{0,63}$/i.test(s)) return null;
  return s;
}

// ---------------------------------------------------------------------------
// Preflight probes. Run once at startup, cached for /health.
// ---------------------------------------------------------------------------

interface PreflightSnapshot {
  tmuxAvailable: boolean;
  tmuxVersion: string | null;
  claudeAvailable: boolean;
  claudeVersion: string | null;
  claudeAuthHint: 'max-plan' | 'api-key' | 'unknown' | 'not-authenticated';
  checkedAt: number;
}

let preflightSnapshot: PreflightSnapshot | null = null;

async function runPreflight(): Promise<PreflightSnapshot> {
  // tmux
  let tmuxOk = false;
  let tmuxVersion: string | null = null;
  try {
    tmuxOk = await tmuxAvailable();
    if (tmuxOk) {
      const r = spawnSync('tmux', ['-V'], { encoding: 'utf8', timeout: 2000 });
      tmuxVersion = r.stdout.trim() || null;
    }
  } catch {
    tmuxOk = false;
  }

  // claude CLI
  let claudeOk = false;
  let claudeVersion: string | null = null;
  try {
    const r = spawnSync('claude', ['--version'], { encoding: 'utf8', timeout: 3000 });
    if (r.status === 0) {
      claudeOk = true;
      claudeVersion = r.stdout.trim() || null;
    }
  } catch {
    claudeOk = false;
  }

  // Auth hint — Claude-CLI picks ANTHROPIC_API_KEY over the stored MAX-Plan
  // credentials. We strip the env var in the child spawn (see
  // workspace-session.ts), so the effective auth path is MAX-Plan as long as
  // the credential files exist. Preflight reports both so we can warn if
  // the env var is lingering AND if the credential files are missing.
  let authHint: PreflightSnapshot['claudeAuthHint'] = 'unknown';
  try {
    const fs = await import('node:fs');
    const candidates = [
      `${process.env.HOME ?? '/root'}/.claude/.credentials.json`,
      `${process.env.HOME ?? '/root'}/.config/claude-code/auth.json`,
      `${process.env.HOME ?? '/root'}/.claude/auth.json`,
    ];
    const hit = candidates.find((p) => {
      try {
        return fs.statSync(p).isFile();
      } catch {
        return false;
      }
    });
    // macOS keychain check (Claude Code stores credentials there on darwin)
    let keychainOk = false;
    if (!hit && process.platform === 'darwin') {
      try {
        const { execSync } = await import('node:child_process');
        execSync('security find-generic-password -s "Claude Code-credentials"', {
          stdio: 'ignore',
          timeout: 2000,
        });
        keychainOk = true;
      } catch {
        keychainOk = false;
      }
    }
    if (hit || keychainOk) {
      authHint = 'max-plan';
    } else if ((process.env.ANTHROPIC_API_KEY ?? '').trim().length > 10) {
      // No MAX-Plan creds but the API key is available — we'll fall back to it
      // if the caller sets LAZYOS_USE_API_KEY=1 in the child env. Surface
      // as `api-key` so the operator knows MAX-Plan isn't active.
      authHint = 'api-key';
    } else {
      authHint = 'not-authenticated';
    }
  } catch {
    authHint = 'unknown';
  }

  const snap: PreflightSnapshot = {
    tmuxAvailable: tmuxOk,
    tmuxVersion,
    claudeAvailable: claudeOk,
    claudeVersion,
    claudeAuthHint: authHint,
    checkedAt: Date.now(),
  };
  preflightSnapshot = snap;
  return snap;
}

// ---------------------------------------------------------------------------
// /chat handler.
// ---------------------------------------------------------------------------

type SseEvent =
  | 'ready'
  | 'token'
  | 'tool_call'
  | 'tool_result'
  | 'permission_denied'
  | 'done'
  | 'error'
  | 'too_many_turns'
  | 'result_event_id';

interface ChatBody {
  messages: ChatMessage[];
  workspaceId: string;
  /**
   * Streaming recovery V2 (2026-04-27). Optional. If the caller
   * (Next.js proxy) passes along the `pendingPromptId`, the
   * snapshot writer in workspace-session.ts writes the partial state
   * of the response into `streaming_snapshots` every 1500 ms. Reload recovery
   * otherwise does not run — no crash, just no recovery possible.
   */
  pendingPromptId?: string;
  /**
   * 2-stage model (owner 2026-06-03). Optional. If the Next.js proxy
   * passes `thinking:true` through (the client detected a multi-step intent),
   * the claude spawn gets `--effort` this turn (deeper thinking).
   * Missing field → fast turn (no --effort = today's behavior).
   */
  thinking?: boolean;
  thinkingBudget?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

/**
 * Validation for pendingPromptId — same rule as the
 * X-LazyOS-Pending-Id header in `app/api/chat/stream/route.ts`:
 * 1..64 chars, ASCII-safe. Both ULID/UUID formats allowed.
 */
function sanitizePendingPromptId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s || s.length > 64) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
  return s;
}

function parseChatBody(raw: unknown): ChatBody | { error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'invalid_body' };
  }
  const obj = raw as Record<string, unknown>;
  const messages = sanitizeMessages(obj.messages);
  if (!messages || messages.length === 0) return { error: 'missing_messages' };
  const workspaceId = sanitizeWorkspaceId(obj.workspaceId);
  if (!workspaceId) return { error: 'missing_workspaceId' };
  const pendingPromptId = sanitizePendingPromptId(obj.pendingPromptId) ?? undefined;
  const out: ChatBody = { messages, workspaceId };
  if (pendingPromptId) out.pendingPromptId = pendingPromptId;
  // 2-stage model: read thinking + thinkingBudget from the proxy body.
  // Strictly sanitized — thinking only true when boolean true; thinkingBudget
  // only from the allowed --effort enum. Missing/invalid → no --effort.
  if (obj.thinking === true) {
    out.thinking = true;
    const tb = obj.thinkingBudget;
    if (tb === 'low' || tb === 'medium' || tb === 'high' || tb === 'xhigh' || tb === 'max') {
      out.thinkingBudget = tb;
    }
  }
  return out;
}

async function handleChat(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  reqId: string,
): Promise<void> {
  const reqOrigin = (req.headers.origin as string | undefined) ?? undefined;

  // --- Auth
  const provided = extractChatKey(req);
  if (!LAZYOS_CHAT_KEY || !constantTimeEquals(provided, LAZYOS_CHAT_KEY)) {
    log('warn', 'unauthorized', { reqId, ip: getClientIp(req) });
    sendJson(res, 401, { error: 'unauthorized' }, reqOrigin);
    return;
  }

  // --- Body
  let rawBody: unknown;
  try {
    rawBody = await readJsonBody(req);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'invalid_json';
    sendJson(res, 400, { error: msg }, reqOrigin);
    return;
  }
  const parsed = parseChatBody(rawBody);
  if ('error' in parsed) {
    sendJson(res, 400, { error: parsed.error }, reqOrigin);
    return;
  }

  // Ensure workspace exists before opening the stream — saves us from
  // SSE'ing an error back to the client for a 404 case.
  const ws = getWorkspace(parsed.workspaceId);
  if (!ws) {
    sendJson(res, 404, { error: 'workspace_not_found' }, reqOrigin);
    return;
  }

  // --- Preflight required tools
  const pf = preflightSnapshot ?? (await runPreflight());
  if (!pf.claudeAvailable) {
    sendJson(res, 500, { error: 'claude_cli_unavailable' }, reqOrigin);
    return;
  }
  if (pf.claudeAuthHint === 'not-authenticated') {
    sendJson(
      res,
      500,
      {
        error: 'claude_not_authenticated',
        hint: 'Run `claude login` on the VPS as the same user as lazyos-agent (root).',
      },
      reqOrigin,
    );
    return;
  }

  // --- SSE setup
  //
  // Streaming recovery V2 (Synthesis #3, 2026-04-27): a client disconnect
  // no longer aborts the Anthropic stream. The subprocess runs to
  // the end, `chat_message_completed` is always written, the snapshot
  // writer flushes final + cleans up its row. This removes the
  // special case "response lost because F5 was pressed mid-stream".
  //
  // The AbortController stays — it is triggered exclusively by `shutdown()`
  // (SIGTERM/SIGINT). On a real crash the snapshot row stays
  // and the history endpoint shows it as 'aborted' after 10 s.
  const abortController = new AbortController();
  req.on('close', () => {
    if (!res.writableEnded) {
      log('info', 'client_disconnected_streaming_continues', { reqId });
      // NO abortController.abort() — the stream runs to the end server-side.
    }
  });

  applyCorsHeaders(res, reqOrigin);
  res.statusCode = 200;
  res.setHeader('content-type', 'text/event-stream; charset=utf-8');
  res.setHeader('cache-control', 'no-store, no-transform');
  res.setHeader('connection', 'keep-alive');
  res.setHeader('x-accel-buffering', 'no');
  res.flushHeaders?.();

  const started = Date.now();
  lastRequestTs = started;

  log('info', 'chat_start', {
    reqId,
    ip: getClientIp(req),
    messages: parsed.messages.length,
    workspaceId: parsed.workspaceId,
  });

  const writeSse = (event: SseEvent, payload: unknown): void => {
    if (res.writableEnded) return;
    try {
      const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
      res.write(`event: ${event}\ndata: ${data}\n\n`);
    } catch {
      /* socket gone */
    }
  };

  // ChatShell sends the full message list per turn, but Claude-CLI holds
  // the transcript server-side (via --resume). We only forward the LAST
  // user message to avoid re-injecting the history twice.
  const lastUserMsg = [...parsed.messages].reverse().find((m) => m.role === 'user');
  if (!lastUserMsg) {
    writeSse('error', { reqId, message: 'no user message in payload' });
    writeSse('done', { reqId, error: true });
    res.end();
    return;
  }

  let charsOut = 0;
  let toolCalls = 0;
  let tooManyTurns = false;

  try {
    inFlight += 1;
    active.add(abortController);

    // Phase MU.3 (activate switch) — read the user ID from the chat-stream-proxy
    // header and pass it on to sendPrompt. workspace-session.ts
    // switches HOME to the sandbox path automatically when `claudeMaxStatus='own'`.
    // The header is informational, not an auth bypass — the
    // actual bearer is already validated.
    const actingUserHeader = req.headers['x-lazyos-acting-user-id'];
    const actingUserId =
      typeof actingUserHeader === 'string' && actingUserHeader.length > 0
        ? actingUserHeader
        : Array.isArray(actingUserHeader) && actingUserHeader[0]
          ? actingUserHeader[0]
          : undefined;

    await sendPrompt({
      workspaceId: parsed.workspaceId,
      prompt: lastUserMsg.content,
      signal: abortController.signal,
      reqId,
      ...(actingUserId ? { userId: actingUserId } : {}),
      // Streaming recovery V2 — if the proxy passed the pendingPromptId
      // along, sendPrompt persists the partial stream state
      // into `streaming_snapshots` every 1500 ms (migration 0018).
      ...(parsed.pendingPromptId
        ? { pendingPromptId: parsed.pendingPromptId }
        : {}),
      // 2-stage model — pass intent-driven deep thinking on to sendPrompt.
      // Default (no thinking) = fast turn without --effort.
      ...(parsed.thinking
        ? {
            thinking: true,
            ...(parsed.thinkingBudget ? { thinkingBudget: parsed.thinkingBudget } : {}),
          }
        : {}),
      // Phase MS (P1-2): event.id from chat_message_completed → SSE frame
      // result_event_id. The client sets this ID as HistoryItem.id and
      // dedupes with it against its own echo from the live event stream.
      onResultEventId: (eventId: string) => {
        writeSse('result_event_id', {
          reqId,
          workspaceId: parsed.workspaceId,
          eventId,
        });
      },
      onEvent: (ev: ParsedEvent) => {
        switch (ev.kind) {
          case 'ready':
            writeSse('ready', { reqId, sessionId: ev.sessionId, workspaceId: parsed.workspaceId });
            break;
          case 'token':
            charsOut += ev.text.length;
            writeSse('token', { reqId, workspaceId: parsed.workspaceId, delta: ev.text });
            break;
          case 'tool_call':
            toolCalls += 1;
            writeSse('tool_call', {
              reqId,
              workspaceId: parsed.workspaceId,
              id: ev.id,
              name: ev.name,
              input_preview: ev.inputPreview,
            });
            break;
          case 'tool_result':
            writeSse('tool_result', {
              reqId,
              workspaceId: parsed.workspaceId,
              tool_use_id: ev.toolUseId,
              is_error: ev.isError,
              output_preview: ev.outputPreview,
            });
            break;
          case 'permission_denied':
            writeSse('permission_denied', {
              reqId,
              workspaceId: parsed.workspaceId,
              tool: ev.tool,
              reason: ev.reason,
            });
            break;
          case 'error':
            writeSse('error', {
              reqId,
              workspaceId: parsed.workspaceId,
              message: scrubErrorMessage(ev.message),
            });
            break;
          case 'done':
            if (ev.tooManyTurns) tooManyTurns = true;
            if (ev.tooManyTurns) {
              writeSse('too_many_turns', {
                reqId,
                workspaceId: parsed.workspaceId,
                note: 'Turn-Budget erschöpft — neu prompten mit klarerem Scope.',
              });
            }
            writeSse('done', {
              reqId,
              workspaceId: parsed.workspaceId,
              sessionId: ev.sessionId,
              subtype: ev.subtype,
              duration_ms: ev.durationMs ?? Date.now() - started,
              num_turns: ev.numTurns,
              is_error: ev.isError,
              chars_out: charsOut,
              tool_calls: toolCalls,
              result_text: ev.resultText,
              aborted: abortController.signal.aborted,
            });
            break;
        }
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log('error', 'agent_error', {
      reqId,
      error: message.slice(0, 500),
      stack: err instanceof Error ? (err.stack ?? '').slice(0, 2000) : undefined,
    });
    if (!res.writableEnded) {
      writeSse('error', { reqId, workspaceId: parsed.workspaceId, message: scrubErrorMessage(message) });
      writeSse('done', { reqId, workspaceId: parsed.workspaceId, error: true });
    }
  } finally {
    inFlight = Math.max(0, inFlight - 1);
    active.delete(abortController);
    log('info', 'chat_end', {
      reqId,
      dur_ms: Date.now() - started,
      chars_out: charsOut,
      tool_calls: toolCalls,
      too_many_turns: tooManyTurns,
      aborted: abortController.signal.aborted,
    });
    if (!res.writableEnded) res.end();
  }
}

// ---------------------------------------------------------------------------
// /session/restart and /session/list
// ---------------------------------------------------------------------------

async function handleSessionRestart(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  reqId: string,
): Promise<void> {
  const reqOrigin = (req.headers.origin as string | undefined) ?? undefined;

  const provided = extractChatKey(req);
  if (!LAZYOS_CHAT_KEY || !constantTimeEquals(provided, LAZYOS_CHAT_KEY)) {
    log('warn', 'unauthorized_restart', { reqId, ip: getClientIp(req) });
    sendJson(res, 401, { error: 'unauthorized' }, reqOrigin);
    return;
  }

  let rawBody: unknown;
  try {
    rawBody = await readJsonBody(req);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'invalid_json';
    sendJson(res, 400, { error: msg }, reqOrigin);
    return;
  }
  const obj = (rawBody && typeof rawBody === 'object' ? rawBody : {}) as Record<string, unknown>;
  const workspaceId = sanitizeWorkspaceId(obj.workspaceId);
  if (!workspaceId) {
    sendJson(res, 400, { error: 'missing_workspaceId' }, reqOrigin);
    return;
  }
  if (!getWorkspace(workspaceId)) {
    sendJson(res, 404, { error: 'workspace_not_found' }, reqOrigin);
    return;
  }

  try {
    const handle = await restartSession(workspaceId);
    log('info', 'session_restarted', { reqId, workspaceId, newSessionId: handle.sessionId });
    sendJson(
      res,
      200,
      {
        ok: true,
        workspaceId,
        sessionId: handle.sessionId,
        tmuxAttachable: handle.tmuxAttachable,
      },
      reqOrigin,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log('error', 'session_restart_failed', { reqId, workspaceId, error: msg });
    sendJson(res, 500, { error: 'restart_failed', message: scrubErrorMessage(msg) }, reqOrigin);
  }
}

async function handleSessionList(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  reqId: string,
): Promise<void> {
  const reqOrigin = (req.headers.origin as string | undefined) ?? undefined;

  const provided = extractChatKey(req);
  if (!LAZYOS_CHAT_KEY || !constantTimeEquals(provided, LAZYOS_CHAT_KEY)) {
    log('warn', 'unauthorized_list', { reqId, ip: getClientIp(req) });
    sendJson(res, 401, { error: 'unauthorized' }, reqOrigin);
    return;
  }

  try {
    const sessions = await listActiveSessions();
    sendJson(res, 200, { sessions }, reqOrigin);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log('error', 'session_list_failed', { reqId, error: msg });
    sendJson(res, 500, { error: 'list_failed', message: scrubErrorMessage(msg) }, reqOrigin);
  }
}

// ---------------------------------------------------------------------------
// /health
// ---------------------------------------------------------------------------

async function handleHealth(res: http.ServerResponse, reqOrigin: string | undefined): Promise<void> {
  const pf = preflightSnapshot ?? (await runPreflight());
  let activeSessions: Array<{
    workspaceId: string;
    lastPromptAt: number;
    turnCount: number;
    tmuxAttached: boolean;
  }> = [];
  try {
    const all = await listActiveSessions();
    activeSessions = all.map((a) => ({
      workspaceId: a.workspaceId,
      lastPromptAt: a.lastPromptAt,
      turnCount: a.turnCount,
      tmuxAttached: a.tmuxAttached,
    }));
  } catch {
    /* non-fatal */
  }

  let tmuxPanes: number = 0;
  if (pf.tmuxAvailable) {
    try {
      tmuxPanes = (await tmuxListSessions('lazyos-ws-')).length;
    } catch {
      tmuxPanes = 0;
    }
  }

  sendJson(
    res,
    200,
    {
      status: 'healthy',
      version: '0.2.0',
      transport: 'claude-code-cli',
      tmuxAvailable: pf.tmuxAvailable,
      tmuxVersion: pf.tmuxVersion,
      claudeAvailable: pf.claudeAvailable,
      claudeVersion: pf.claudeVersion,
      claudeAuthHint: pf.claudeAuthHint,
      maxPlan: pf.claudeAuthHint === 'max-plan',
      inFlight,
      activeSessions,
      activeTmuxPanes: tmuxPanes,
      uptime_s: Math.floor((Date.now() - startedAt) / 1000),
      last_request_ts: lastRequestTs || null,
      allow_origins: ALLOW_ORIGINS,
    },
    reqOrigin,
  );
}

// ---------------------------------------------------------------------------
// HTTP plumbing.
// ---------------------------------------------------------------------------

const startedAt = Date.now();
let lastRequestTs = 0;
let inFlight = 0;
const active = new Set<AbortController>();

function preflightEnv(): void {
  const errs: string[] = [];
  if (!LAZYOS_CHAT_KEY) errs.push('LAZYOS_CHAT_KEY is not set');
  if (errs.length) {
    log('error', 'preflight_failed', { errors: errs });
    throw new Error(errs.join('; '));
  }
}

/**
 * TD-3 fix 2026-04-26: boot-time env audit. If `LAZYOS_PUSH_SECRET` was missing in
 * agent.env, Phase-MS pushes failed silently — the user only noticed it
 * on the first collapsed tab. The audit prints a clearly visible block
 * right after listening, without blocking the boot (push is optional).
 *
 * Required vars are in `preflightEnv()` (= boot-fail). Optional vars are
 * warned about here: `LAZYOS_PUSH_SECRET`, `LAZYOS_BASE_URL`, `LAZYOS_DB_PATH`.
 */
function auditEnvAtBoot(): void {
  const checks: Array<{
    name: string;
    value: string | undefined;
    feature: string;
    ok: (v: string | undefined) => boolean;
    okHint?: (v: string) => string;
    missingHint: string;
  }> = [
    {
      name: 'LAZYOS_PUSH_SECRET',
      value: process.env.LAZYOS_PUSH_SECRET,
      feature: 'Phase MS push-on-complete',
      ok: (v) => Boolean(v && v.length > 0),
      missingHint: 'push-on-complete disabled — chat_message_completed events do not notify',
    },
    {
      name: 'LAZYOS_BASE_URL',
      value: process.env.LAZYOS_BASE_URL,
      feature: 'Push-Send target URL',
      ok: (v) => Boolean(v && v.length > 0),
      okHint: (v) => v,
      missingHint: 'fallback http://127.0.0.1:4200 — OK for local, set explicitly in prod',
    },
    {
      name: 'LAZYOS_DB_PATH',
      value: process.env.LAZYOS_DB_PATH,
      feature: 'Shared SQLite path',
      ok: (v) => Boolean(v && v.length > 0),
      okHint: (v) => v,
      missingHint: 'fallback ~/.lazyos/lazyos.db — OK if Next.js side uses the same default',
    },
    {
      name: 'LAZYOS_CHAT_KEY',
      value: process.env.LAZYOS_CHAT_KEY,
      feature: 'Bridge auth (Bearer)',
      ok: (v) => Boolean(v && v.trim().length > 0),
      missingHint: 'CRITICAL — preflight should have failed; investigate boot order',
    },
  ];

  const lines: string[] = ['[lazyos-agent] boot env audit:'];
  let anyMissing = false;
  for (const c of checks) {
    const ok = c.ok(c.value);
    const padded = c.name.padEnd(22, ' ');
    if (ok) {
      const detail = c.okHint && c.value ? ` (${c.okHint(c.value)})` : '';
      lines.push(`  ${padded} ok${detail}`);
    } else {
      anyMissing = true;
      lines.push(`  ${padded} MISSING ⚠ — ${c.feature}: ${c.missingHint}`);
    }
  }

  // Single-block stderr write, prefixed and aligned. Visible in journalctl.
  if (anyMissing) {
    process.stderr.write(lines.join('\n') + '\n');
  } else {
    log('info', 'env_audit_ok', {
      checked: checks.map((c) => c.name),
    });
  }
}

const server = http.createServer((req, res) => {
  const reqId = randomUUID();
  const method = req.method ?? 'GET';
  const url = req.url ?? '/';
  const reqOrigin = (req.headers.origin as string | undefined) ?? undefined;

  if (method === 'OPTIONS') {
    applyCorsHeaders(res, reqOrigin);
    res.statusCode = 204;
    res.end();
    return;
  }

  if (method === 'GET' && (url === '/health' || url === '/healthz')) {
    handleHealth(res, reqOrigin).catch((err) => {
      log('error', 'health_handler_crashed', {
        error: err instanceof Error ? err.message : String(err),
      });
      if (!res.writableEnded) sendJson(res, 500, { error: 'health_probe_failed' }, reqOrigin);
    });
    return;
  }

  if (method === 'POST' && url === '/chat') {
    handleChat(req, res, reqId).catch((err) => {
      log('error', 'chat_handler_crashed', {
        reqId,
        error: err instanceof Error ? err.message : String(err),
      });
      if (!res.writableEnded) sendJson(res, 500, { error: 'internal_error' }, reqOrigin);
    });
    return;
  }

  if (method === 'POST' && url === '/session/restart') {
    handleSessionRestart(req, res, reqId).catch((err) => {
      log('error', 'session_restart_handler_crashed', {
        reqId,
        error: err instanceof Error ? err.message : String(err),
      });
      if (!res.writableEnded) sendJson(res, 500, { error: 'internal_error' }, reqOrigin);
    });
    return;
  }

  if (method === 'GET' && url === '/session/list') {
    handleSessionList(req, res, reqId).catch((err) => {
      log('error', 'session_list_handler_crashed', {
        reqId,
        error: err instanceof Error ? err.message : String(err),
      });
      if (!res.writableEnded) sendJson(res, 500, { error: 'internal_error' }, reqOrigin);
    });
    return;
  }

  sendJson(res, 404, { error: 'not_found' }, reqOrigin);
});

server.on('clientError', (err, socket) => {
  try {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  } catch {
    /* already dead */
  }
  log('warn', 'client_error', { error: err instanceof Error ? err.message : String(err) });
});

function shutdown(signal: string): void {
  log('info', 'shutdown_initiated', {
    signal,
    in_flight: inFlight,
    active_streams: active.size,
  });
  for (const ctl of active) {
    try {
      ctl.abort();
    } catch {
      /* already aborted */
    }
  }
  server.close(() => {
    log('info', 'shutdown_complete');
    process.exit(0);
  });
  setTimeout(() => {
    log('warn', 'shutdown_hard_exit');
    process.exit(1);
  }, 15_000).unref();
}

// ---------------------------------------------------------------------------
// Boot.
// ---------------------------------------------------------------------------

if (process.env.LAZYOS_AGENT_TEST_MODE === '1') {
  // import-for-test no-op
} else {
  preflightEnv();
  auditEnvAtBoot();
  // Kick off the preflight probe; don't block the listen() call on it.
  runPreflight().then((snap) => {
    log('info', 'preflight_probed', snap as unknown as Record<string, unknown>);
    if (!snap.claudeAvailable) {
      log('error', 'claude_cli_missing', {
        hint: 'Install Claude Code CLI or add it to PATH. `claude --version` failed.',
      });
    }
    if (snap.claudeAuthHint === 'not-authenticated') {
      log('warn', 'claude_not_authenticated', {
        hint: 'Run `claude login` as the same user the agent runs as (root). Otherwise /chat will 500.',
      });
    }
    if (snap.claudeAuthHint === 'api-key') {
      log('warn', 'claude_using_api_key', {
        hint: 'ANTHROPIC_API_KEY env is set — Claude CLI will consume API credits instead of the MAX-Plan subscription. Unset it in agent.env for MAX-Plan routing.',
      });
    }
  });

  server.listen(PORT, HOST, () => {
    const addr = server.address() as AddressInfo;
    log('info', 'lazyos_agent_server_listening', {
      host: addr.address,
      port: addr.port,
      transport: 'claude-code-cli',
      allow_origins: ALLOW_ORIGINS,
    });
  });

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // 2026-04-27 stability fix: top-level error handler. Without it
  // Node 20+ kills the process on ANY unhandled promise rejection — and
  // an 8-min stream with 30+ tool calls is enough for 1 unhandled reject.
  // We log instead of dying. Restart=always in systemd would otherwise
  // catch it, but the stream interruption still happens mid-flight.
  process.on('unhandledRejection', (reason, promise) => {
    log('error', 'unhandled_promise_rejection', {
      reason:
        reason instanceof Error
          ? { message: reason.message, stack: reason.stack }
          : String(reason),
      promise: String(promise),
    });
  });
  process.on('uncaughtException', (err) => {
    log('error', 'uncaught_exception', {
      message: err.message,
      stack: err.stack,
    });
    // On an uncaught exception the heap is potentially corrupt — graceful
    // shutdown instead of carrying on. systemd Restart=always restarts.
    shutdown('uncaughtException');
  });
}

export {
  constantTimeEquals,
  extractChatKey,
  sanitizeMessages,
  sanitizeWorkspaceId,
  scrubErrorMessage,
};
