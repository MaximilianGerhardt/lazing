'use client';

/**
 * Client-side SSE consumer for `/api/chat/stream`.
 *
 * Parses the named-event `text/event-stream` emitted by the agent-server
 * (`ready | token | tool_call | tool_result | permission_denied |
 * error | too_many_turns | done`) into an evolving `AssistantTurn`
 * the UI can render incrementally — interleaving streaming text with
 * live tool-cards.
 *
 * Parser is a tiny hand-rolled SSE frame splitter. We intentionally
 * don't use `EventSource` because (a) `EventSource` is GET-only, and
 * (b) we need abort-on-demand and per-request headers.
 */

import { useCallback, useRef, useState } from 'react';

import type {
  AgentDonePayload,
  AgentErrorPayload,
  AgentEvent,
  AgentPermissionDeniedPayload,
  AgentReadyPayload,
  AgentSseEventName,
  AgentTokenPayload,
  AgentToolCallPayload,
  AgentToolResultPayload,
  AgentTooManyTurnsPayload,
  AssistantTurn,
  ToolStep,
} from './types';

export type AgentStreamStatus =
  | 'idle'
  | 'connecting'
  | 'streaming'
  | 'error'
  | 'not_configured';

export type AgentSendResult =
  | { outcome: 'ok'; turn: AssistantTurn; sessionId?: string }
  | { outcome: 'not_configured'; reason: string }
  | { outcome: 'error'; reason: string }
  | { outcome: 'aborted' };

interface SendOpts {
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  workspaceId: string;
  sensitivityFloor?: 'low' | 'med' | 'high';
  /**
   * Bug-C-RACE Fix 2026-04-26: the client can supply pendingPromptId
   * itself. Sent as the header `X-LazyOS-Pending-Id` to the server
   * — the server uses it instead of generating its own. This way
   * the client can fill `ownPendingIdsRef` BEFORE the submit, and
   * the echo filter takes effect even when the chat_message_sent event
   * arrives via useEventStream faster than the response header
   * (race condition: the server emits the event immediately, the header only after the
   * agent-server connect).
   */
  pendingPromptId?: string;
  /**
   * Phase MS · 2026-04-26: the server returns the `pendingPromptId` in the very
   * first SSE frame (event name `pending_id`). This way
   * the client can recognize its own `chat_message_sent` echo from the live
   * event stream and not render it twice. Optional — if
   * not set, the ID is simply swallowed.
   */
  onPendingId?: (id: string) => void;
  /**
   * Phase MS · 2026-04-26 (P1-2): AFTER the last `done` event the
   * server stream sends a frame `result_event_id` with the real ULID
   * of the persisted `chat_message_completed` event. The caller sets
   * this ID as the HistoryItem.id of its assistant message → dedup against
   * the live-event-stream echo matched (echo filter sender-device double).
   */
  onResultEventId?: (eventId: string) => void;
  /**
   * 2-stage model (owner 2026-06-03): normal chat responds fast (Opus,
   * no `--effort`). If the deterministic N6 pre-screen
   * (`shouldDecompose`) detects a multi-step endeavor, the caller sets `thinking:
   * true` → the claude spawn gets `--effort` for this turn (deeper thinking).
   * Default false = today's fast behavior (no regression on small talk).
   */
  thinking?: boolean;
  /** `--effort` level when thinking is set. Default 'high' in the server. */
  thinkingBudget?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

export interface UseAgentStreamResult {
  status: AgentStreamStatus;
  error: string | null;
  /** The current in-flight turn (or the last one once done). */
  turn: AssistantTurn;
  send: (opts: SendOpts) => Promise<AgentSendResult>;
  abort: () => void;
  reset: () => void;
}

const EMPTY_TURN: AssistantTurn = {
  text: '',
  tools: [],
  status: 'streaming',
};

export function useAgentStream(): UseAgentStreamResult {
  const [status, setStatus] = useState<AgentStreamStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [turn, setTurn] = useState<AssistantTurn>(EMPTY_TURN);
  const abortRef = useRef<AbortController | null>(null);

  const abort = useCallback((): void => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const reset = useCallback((): void => {
    abort();
    setStatus('idle');
    setError(null);
    setTurn(EMPTY_TURN);
  }, [abort]);

  const send = useCallback(
    async (opts: SendOpts): Promise<AgentSendResult> => {
      abortRef.current?.abort();
      const ctl = new AbortController();
      abortRef.current = ctl;

      setStatus('connecting');
      setError(null);

      const startedAt = Date.now();
      // Mutable working turn — we rebuild the immutable snapshot on each
      // setState so React renders deterministically.
      const working: AssistantTurn = {
        text: '',
        tools: [],
        status: 'streaming',
      };
      const toolsById = new Map<string, ToolStep>();
      setTurn(working);

      let sessionId: string | undefined;

      const commit = (): void => {
        setTurn({
          text: working.text,
          tools: [...working.tools],
          status: working.status,
          errorMessage: working.errorMessage,
          durationMs: working.durationMs,
          numTurns: working.numTurns,
          workstreamId: working.workstreamId,
        });
      };

      try {
        // Bug-C-RACE Fix: pass opts.pendingPromptId to the server if the client
        // already generated it — otherwise the live event runs off
        // faster than the response header comes back.
        const reqHeaders: Record<string, string> = {
          'content-type': 'application/json',
          accept: 'text/event-stream',
        };
        if (opts.pendingPromptId) {
          reqHeaders['x-lazyos-pending-id'] = opts.pendingPromptId;
        }
        // Engine mode: read synchronously from localStorage (no async needed).
        // The key must be in sync with ChatTopBar.tsx LS_ENGINE_KEY ('lazyos.engine.mode').
        //
        // All 4 modes are now safe for the chat path (C6 un-gate · 2026-05-25):
        //   'claude-cli'   — agent-server forward (default, destructive-safe via server).
        //   'ollama'       — HTTP text chat, no spawn, tool-less.
        //   'parallel-all' — race, codex runs internally with codexMode:'read' (server-side enforced).
        //   'codex-cli'    — read-only sandbox (-s read-only -a never), server enforces codexMode:'read'.
        //
        // write-codex is physically unreachable via this path: route.ts sets
        // codexMode:'read' EXPLICITLY, independent of what is set here.
        const rawEngineMode =
          typeof window !== 'undefined'
            ? (window.localStorage.getItem('lazyos.engine.mode') ?? '')
            : '';
        const safeEngineMode:
          | 'claude-cli'
          | 'ollama'
          | 'parallel-all'
          | 'codex-cli'
          | 'ultracoding'
          | undefined =
          rawEngineMode === 'claude-cli' ||
          rawEngineMode === 'ollama' ||
          rawEngineMode === 'parallel-all' ||
          rawEngineMode === 'codex-cli' ||
          rawEngineMode === 'ultracoding'
            ? rawEngineMode
            : undefined; // default case → the server chooses claude-cli

        const res = await fetch('/api/chat/stream', {
          method: 'POST',
          headers: reqHeaders,
          body: JSON.stringify({
            messages: opts.messages,
            workspaceId: opts.workspaceId,
            sensitivityFloor: opts.sensitivityFloor,
            // Only send if explicitly set — otherwise server-default (claude-cli).
            ...(safeEngineMode !== undefined ? { engineMode: safeEngineMode } : {}),
            // 2-stage model: only send thinking when the caller has detected
            // intent. If the field is missing → server-default = fast turn.
            ...(opts.thinking
              ? {
                  thinking: true,
                  ...(opts.thinkingBudget ? { thinkingBudget: opts.thinkingBudget } : {}),
                }
              : {}),
          }),
          signal: ctl.signal,
        });

        // Phase MS (P1-4): pendingPromptId also as an HTTP header — recovery
        // path for 5xx where the SSE pending_id frame never comes. The header value
        // does not take precedence over the SSE frame, but ensures that
        // we see the ID in any case as soon as the response is available.
        try {
          const headerPid = res.headers.get('x-lazyos-pending-id');
          if (headerPid) {
            try {
              opts.onPendingId?.(headerPid);
            } catch {
              /* user callback errors are not our problem */
            }
          }
        } catch {
          /* a headers.get throw would be unusual, but defensive */
        }

        if (res.status === 503) {
          const payload = await safeJson(res);
          const reason = extractErrorMessage(payload) ?? 'Agent nicht konfiguriert';
          setStatus('not_configured');
          setError(reason);
          return { outcome: 'not_configured', reason };
        }

        if (!res.ok || !res.body) {
          const payload = await safeJson(res);
          const reason =
            extractErrorMessage(payload) ?? `HTTP ${res.status}`;
          working.status = 'error';
          working.errorMessage = reason;
          commit();
          setStatus('error');
          setError(reason);
          return { outcome: 'error', reason };
        }

        setStatus('streaming');

        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = '';

        // Standard SSE frame splitter: frames end on `\n\n` (or `\r\n\r\n`).
        // Inside a frame each line is one of: `event: <name>`, `data: <chunk>`,
        // `id: <x>`, `retry: <ms>`, `: comment`.
        outer: for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += value;

          for (;;) {
            const idx = findFrameBoundary(buffer);
            if (idx === -1) break;
            const frame = buffer.slice(0, idx);
            buffer = buffer.slice(idx).replace(/^(?:\r?\n){1,2}/, '');

            // Phase MS: pending_id is an out-of-band event from the
            // /api/chat/stream proxy (NOT from the agent-server). It is
            // passed directly to the onPendingId callback and
            // does not appear in the AgentEvent union.
            const pendingId = tryParsePendingIdFrame(frame);
            if (pendingId) {
              try {
                opts.onPendingId?.(pendingId);
              } catch {
                /* user callback errors are not our problem */
              }
              continue;
            }

            // Phase MS (P1-2): result_event_id is also out-of-band —
            // comes AFTER the `done` event and provides the real ULID
            // of the persisted chat_message_completed event. The caller
            // uses it as the HistoryItem.id, so the live-event echo
            // dedupes.
            const resultEventId = tryParseResultEventIdFrame(frame);
            if (resultEventId) {
              try {
                opts.onResultEventId?.(resultEventId);
              } catch {
                /* user callback errors are not our problem */
              }
              continue;
            }

            // 2026-05-01: heartbeat frames are out-of-band keep-alives from
            // the /api/chat/stream proxy. They carry no UI update (the
            // existing status="streaming" is enough), but they keep the
            // connection alive and ensure the first byte flush.
            if (isHeartbeatFrame(frame)) continue;

            const ev = parseSseFrame(frame);
            if (!ev) continue;

            const handled = dispatchEvent(ev, working, toolsById, startedAt);
            commit();

            if (handled === 'ready') {
              if (ev.kind === 'ready') sessionId = ev.payload.sessionId;
            }
            // Phase MS (P1-2): `done` is NO longer terminal — we
            // wait for the following `result_event_id` frame
            // (or stream close, whichever comes first). The
            // reducer has already set working.status; we now
            // only collect the result-event-id frame if any.
            if (handled === 'terminal') {
              // Set a soft terminal flag — we keep reading until the
              // server really closes the stream. For error paths
              // where no result_event_id comes anymore, we have the
              // ID-fallback logic in the caller (nextId).
              // No break — we let the outer loop keep
              // running until reader.done.
            }
          }
        }

        // Normalise final status.
        if (working.status === 'streaming') {
          working.status = 'ok';
        }
        commit();

        if (working.status === 'ok') {
          setStatus('idle');
          abortRef.current = null;
          return {
            outcome: 'ok',
            turn: snapshot(working),
            sessionId,
          };
        }
        if (working.status === 'error') {
          setStatus('error');
          setError(working.errorMessage ?? 'Unbekannter Fehler');
          abortRef.current = null;
          return {
            outcome: 'error',
            reason: working.errorMessage ?? 'Unbekannter Fehler',
          };
        }
        if (working.status === 'aborted') {
          setStatus('idle');
          abortRef.current = null;
          return { outcome: 'aborted' };
        }
        // denied / too_many_turns counted as "ok" (the turn completed with a
        // terminal UX state the user can act on).
        setStatus('idle');
        abortRef.current = null;
        return { outcome: 'ok', turn: snapshot(working), sessionId };
      } catch (err) {
        if (ctl.signal.aborted) {
          working.status = 'aborted';
          commit();
          setStatus('idle');
          abortRef.current = null;
          return { outcome: 'aborted' };
        }
        const msg = err instanceof Error ? err.message : String(err);
        working.status = 'error';
        working.errorMessage = msg;
        commit();
        setError(msg);
        setStatus('error');
        abortRef.current = null;
        return { outcome: 'error', reason: msg };
      }
    },
    [],
  );

  return { status, error, turn, send, abort, reset };
}

// ---------------------------------------------------------------------------
// SSE parsing
// ---------------------------------------------------------------------------

function findFrameBoundary(buf: string): number {
  const a = buf.indexOf('\n\n');
  const b = buf.indexOf('\r\n\r\n');
  if (a === -1) return b;
  if (b === -1) return a;
  return Math.min(a, b);
}

/**
 * Phase MS: parse `event: pending_id` frame out-of-band (not part of the
 * AgentEvent union). Returns the pendingPromptId on hit, null otherwise.
 */
function tryParsePendingIdFrame(frame: string): string | null {
  const lines = frame.split(/\r?\n/);
  let isPendingId = false;
  let dataLine = '';
  for (const line of lines) {
    if (line.startsWith('event:')) {
      const v = line.slice('event:'.length).trimStart();
      if (v === 'pending_id') isPendingId = true;
      continue;
    }
    if (line.startsWith('data:')) {
      dataLine = line.slice('data:'.length).trimStart();
    }
  }
  if (!isPendingId || !dataLine) return null;
  try {
    const parsed = JSON.parse(dataLine) as { pendingPromptId?: unknown };
    if (typeof parsed.pendingPromptId === 'string' && parsed.pendingPromptId) {
      return parsed.pendingPromptId;
    }
  } catch {
    /* malformed */
  }
  return null;
}

/**
 * Phase MS (P1-2): parse `event: result_event_id` frame out-of-band.
 * Returns the eventId (ULID) on hit, null otherwise.
 */
/**
 * 2026-05-01: recognizes `event: heartbeat` frames from the /api/chat/stream
 * proxy. These are keep-alives — the UI must do nothing, the status stays
 * `streaming`.
 */
function isHeartbeatFrame(frame: string): boolean {
  const lines = frame.split(/\r?\n/);
  for (const line of lines) {
    if (line.startsWith('event:')) {
      const v = line.slice('event:'.length).trimStart();
      return v === 'heartbeat';
    }
  }
  return false;
}

function tryParseResultEventIdFrame(frame: string): string | null {
  const lines = frame.split(/\r?\n/);
  let isMatch = false;
  let dataLine = '';
  for (const line of lines) {
    if (line.startsWith('event:')) {
      const v = line.slice('event:'.length).trimStart();
      if (v === 'result_event_id') isMatch = true;
      continue;
    }
    if (line.startsWith('data:')) {
      dataLine = line.slice('data:'.length).trimStart();
    }
  }
  if (!isMatch || !dataLine) return null;
  try {
    const parsed = JSON.parse(dataLine) as { eventId?: unknown };
    if (typeof parsed.eventId === 'string' && parsed.eventId) {
      return parsed.eventId;
    }
  } catch {
    /* malformed */
  }
  return null;
}

function parseSseFrame(frame: string): AgentEvent | null {
  const lines = frame.split(/\r?\n/);
  let name: string | null = null;
  const dataParts: string[] = [];

  for (const line of lines) {
    if (!line || line.startsWith(':')) continue;
    const colonIdx = line.indexOf(':');
    const field = colonIdx === -1 ? line : line.slice(0, colonIdx);
    let value = colonIdx === -1 ? '' : line.slice(colonIdx + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'event') name = value;
    else if (field === 'data') dataParts.push(value);
    // ignore id / retry — we don't reconnect
  }

  if (!name || dataParts.length === 0) return null;
  const raw = dataParts.join('\n');

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    // Non-JSON data blocks are a protocol violation for our agent-server.
    return null;
  }

  return coerceEvent(name, data);
}

function coerceEvent(name: string, data: unknown): AgentEvent | null {
  if (!data || typeof data !== 'object') return null;
  const n = name as AgentSseEventName;
  switch (n) {
    case 'ready':
      return { kind: 'ready', payload: data as AgentReadyPayload };
    case 'token':
      return { kind: 'token', payload: data as AgentTokenPayload };
    case 'tool_call':
      return { kind: 'tool_call', payload: data as AgentToolCallPayload };
    case 'tool_result':
      return { kind: 'tool_result', payload: data as AgentToolResultPayload };
    case 'permission_denied':
      return {
        kind: 'permission_denied',
        payload: data as AgentPermissionDeniedPayload,
      };
    case 'error':
      return { kind: 'error', payload: data as AgentErrorPayload };
    case 'done':
      return { kind: 'done', payload: data as AgentDonePayload };
    case 'too_many_turns':
      return {
        kind: 'too_many_turns',
        payload: data as AgentTooManyTurnsPayload,
      };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Event → turn reducer. Mutates `working` in-place; caller commits a
// snapshot after. Returns a string hint:
//   'terminal' — stream is effectively over (done/error)
//   'ready'    — stream handshake complete
//   ''         — regular update
// ---------------------------------------------------------------------------

function dispatchEvent(
  ev: AgentEvent,
  working: AssistantTurn,
  toolsById: Map<string, ToolStep>,
  startedAt: number,
): 'terminal' | 'ready' | '' {
  switch (ev.kind) {
    case 'ready':
      return 'ready';
    case 'token': {
      if (ev.payload.delta) working.text += ev.payload.delta;
      return '';
    }
    case 'tool_call': {
      const p = ev.payload;
      const step: ToolStep = {
        id: p.id,
        name: p.name,
        inputPreview: p.input_preview ?? '',
        status: 'running',
        startedAt: Date.now() - startedAt,
      };
      toolsById.set(p.id, step);
      working.tools.push(step);
      return '';
    }
    case 'tool_result': {
      const p = ev.payload;
      const existing = toolsById.get(p.tool_use_id);
      if (!existing) return '';
      existing.status = 'done';
      existing.isError = p.is_error;
      existing.outputPreview = p.output_preview;
      existing.endedAt = Date.now() - startedAt;
      // Mutation is visible because we spread `tools` on commit.
      return '';
    }
    case 'permission_denied': {
      const p = ev.payload;
      // Match by tool name — denial arrives without the tool_use_id.
      // Find the most recent running call for that tool.
      for (let i = working.tools.length - 1; i >= 0; i -= 1) {
        const t = working.tools[i]!;
        if (t.name === p.tool && t.status === 'running') {
          t.status = 'denied';
          t.denialReason = p.reason;
          t.endedAt = Date.now() - startedAt;
          break;
        }
      }
      // A denied tool doesn't end the turn by itself — Claude often
      // course-corrects. Only `done` is terminal.
      return '';
    }
    case 'too_many_turns': {
      working.status = 'too_many_turns';
      // Non-terminal — server also emits `done` right after.
      return '';
    }
    case 'error': {
      working.status = 'error';
      working.errorMessage = ev.payload.message;
      return '';
    }
    case 'done': {
      const p = ev.payload;
      working.durationMs = p.duration_ms;
      working.numTurns = p.num_turns;
      if (working.status === 'streaming') {
        if (p.is_error || p.error) {
          working.status = 'error';
          // Bug 1 Fix (2026-05-30, owner „Stream-Fehler: Agent-Fehler"):
          // NO longer a generic 'Agent-Fehler'. We try to pull the REAL
          // cause from the done payload — order:
          //   1. an already-set errorMessage (from an `error` frame),
          //   2. the streamed text (Claude often explains the error itself),
          //   3. the `result_text` (CLI final text on crash),
          //   4. the `subtype` (e.g. 'error_max_turns'),
          //   5. only as the very last fallback a human-readable hint.
          working.errorMessage =
            working.errorMessage ??
            extractDoneErrorReason(p) ??
            'Der Agent konnte diese Antwort nicht abschließen. Tipp einfach erneut — der Kontext bleibt erhalten.';
        } else {
          working.status = 'ok';
        }
      }
      // If Claude never emitted a token but `result_text` was set,
      // use it so the user doesn't see a blank bubble.
      if (!working.text && p.result_text) {
        working.text = p.result_text;
      }
      return 'terminal';
    }
  }
}

// ---------------------------------------------------------------------------
// Small utils
// ---------------------------------------------------------------------------

/**
 * Bug 1 Fix (2026-05-30): pulls a HUMAN-READABLE error cause from the
 * `done` payload when the server reports `is_error`/`error` without a separate
 * `error` frame. Previously this led to the meaningless 'Agent-Fehler'. We
 * prefer the final text delivered by the CLI (`result_text`), otherwise the
 * `subtype` (e.g. 'error_max_turns', 'error_during_execution') translated into a
 * comprehensible line. Exported for unit tests.
 */
export function extractDoneErrorReason(p: {
  result_text?: string;
  subtype?: string;
}): string | null {
  const rt = typeof p.result_text === 'string' ? p.result_text.trim() : '';
  if (rt.length > 0) return rt;
  const sub = typeof p.subtype === 'string' ? p.subtype.trim() : '';
  if (sub.length > 0) {
    switch (sub) {
      case 'error_max_turns':
        return 'Der Agent hat die maximale Anzahl an Schritten erreicht.';
      case 'error_during_execution':
        return 'Während der Ausführung trat ein Fehler auf.';
      default:
        // Unknown subtype → pass through raw (better than 'Agent-Fehler').
        return `Agent-Abbruch (${sub})`;
    }
  }
  return null;
}

function snapshot(t: AssistantTurn): AssistantTurn {
  return {
    text: t.text,
    tools: t.tools.map((s) => ({ ...s })),
    status: t.status,
    errorMessage: t.errorMessage,
    durationMs: t.durationMs,
    numTurns: t.numTurns,
    workstreamId: t.workstreamId,
  };
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function extractErrorMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const o = payload as Record<string, unknown>;
  if (typeof o.hint === 'string' && o.hint.length > 0) return o.hint;
  if (typeof o.error === 'string' && o.error.length > 0) return o.error;
  if (typeof o.detail === 'string' && o.detail.length > 0) return o.detail;
  return null;
}
