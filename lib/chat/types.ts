/**
 * SSE event types emitted by the lazyOS agent-server (`/chat` endpoint).
 *
 * The agent-server is the source of truth for this shape —
 * see `server/agent-server.ts` → `SseEvent` union and the per-event
 * payload shapes in `handleChat()`.
 *
 * This module is consumed by:
 *  - `app/api/chat/stream/route.ts` (proxy, opaque pass-through of raw bytes)
 *  - `lib/chat/useAgentStream.ts`   (client-side parser)
 *  - `lib/chat/ToolStepCard.tsx`    (rendering)
 */

export type AgentSseEventName =
  | 'ready'
  | 'token'
  | 'tool_call'
  | 'tool_result'
  | 'permission_denied'
  | 'done'
  | 'error'
  | 'too_many_turns';

export interface AgentReadyPayload {
  reqId: string;
  sessionId: string;
  workspaceId: string;
}

export interface AgentTokenPayload {
  reqId: string;
  workspaceId: string;
  /** Incremental text chunk. May be empty string — ignore if so. */
  delta: string;
}

export interface AgentToolCallPayload {
  reqId: string;
  workspaceId: string;
  /** Stable id emitted by the Claude CLI — ties `tool_call` → `tool_result`. */
  id: string;
  /** Tool name, e.g. "Read", "Bash", "Write", "Edit", "Grep", "Glob", "WebFetch". */
  name: string;
  /** Short preview of the tool input (already scrubbed server-side). */
  input_preview: string;
}

export interface AgentToolResultPayload {
  reqId: string;
  workspaceId: string;
  /** Matches `AgentToolCallPayload.id`. */
  tool_use_id: string;
  is_error: boolean;
  output_preview: string;
}

export interface AgentPermissionDeniedPayload {
  reqId: string;
  workspaceId: string;
  tool: string;
  reason: string;
}

export interface AgentErrorPayload {
  reqId: string;
  workspaceId?: string;
  message: string;
}

export interface AgentDonePayload {
  reqId: string;
  workspaceId: string;
  sessionId?: string;
  subtype?: string;
  /** Total wall-clock duration (ms). */
  duration_ms?: number;
  num_turns?: number;
  is_error?: boolean;
  chars_out?: number;
  tool_calls?: number;
  /** Final assistant text as seen by the CLI (often duplicates token stream). */
  result_text?: string;
  aborted?: boolean;
  /** Error signal when `done` is emitted after a crash. */
  error?: boolean;
}

export interface AgentTooManyTurnsPayload {
  reqId: string;
  workspaceId: string;
  note: string;
}

/**
 * Discriminated union used by the client-side parser to hand off
 * events to the UI reducer.
 */
export type AgentEvent =
  | { kind: 'ready'; payload: AgentReadyPayload }
  | { kind: 'token'; payload: AgentTokenPayload }
  | { kind: 'tool_call'; payload: AgentToolCallPayload }
  | { kind: 'tool_result'; payload: AgentToolResultPayload }
  | { kind: 'permission_denied'; payload: AgentPermissionDeniedPayload }
  | { kind: 'error'; payload: AgentErrorPayload }
  | { kind: 'done'; payload: AgentDonePayload }
  | { kind: 'too_many_turns'; payload: AgentTooManyTurnsPayload };

// ---------------------------------------------------------------------------
// Client-side shapes — what ChatShell stores in history for an agent turn.
// ---------------------------------------------------------------------------

export type ToolStatus = 'running' | 'done' | 'error' | 'denied';

export interface ToolStep {
  /** Stable id = `tool_use_id` from the agent-server. */
  id: string;
  /** Tool name (e.g. "Read", "Bash"). */
  name: string;
  /** Short preview of the input. */
  inputPreview: string;
  status: ToolStatus;
  /** Populated once the matching `tool_result` arrives. */
  outputPreview?: string;
  /** True when the matching `tool_result` was is_error=true. */
  isError?: boolean;
  /** Populated on `permission_denied`. */
  denialReason?: string;
  /** ms since stream start when the call began. */
  startedAt: number;
  /** ms since stream start when the tool completed (or got denied). */
  endedAt?: number;
}

/**
 * One turn = a user prompt followed by the assistant's full response
 * including interleaved tool-calls. The `events` array preserves order
 * so rendering can interleave tool-cards with text chunks.
 */
export interface AssistantTurn {
  /** Incrementally-built text (union of all `token.delta` events). */
  text: string;
  /** Tool invocations in order, keyed by tool_use_id. */
  tools: ToolStep[];
  /** Final status after `done`/`error`/`aborted`. */
  status: 'streaming' | 'ok' | 'error' | 'aborted' | 'denied' | 'too_many_turns';
  /** Error message if status='error'. */
  errorMessage?: string;
  /** Timings populated on `done`. */
  durationMs?: number;
  numTurns?: number;
  /**
   * Optional workstream context. Propagated by the agent server when
   * the chat stream is assigned to a workstream (e.g. /workstreams/[id]/chat).
   * Undefined in the root chat. Consumers (InlineWorkerStatus, BackgroundActivityIndicator)
   * use it to filter out their own stream. Wave 1 · 2026-05-03.
   */
  workstreamId?: string;
}

// ---------------------------------------------------------------------------
// Phase Reload-Recovery V2 · 2026-04-27
// Streaming-snapshot wire format (delivered by the history endpoint).
//
// TODO(backend): the backend agent must join `streaming_snapshots` rows and
// deliver, per pendingPromptId without a `chat_message_completed` event, a
// `StreamingSnapshotItem` as a HistoryItem. Schema definition
// see /tmp/recovery-syn.txt points 1+4.
// ---------------------------------------------------------------------------

/**
 * Tool state of a pending tool call at snapshot time. Updated by the
 * snapshot writer in the agent server every 1500ms. On a crash, the
 * last seen tool has this status.
 */
export interface StreamingToolState {
  /** Tool name (e.g. "Bash", "Read"). */
  name: string;
  /** 'pending' = still running, 'done' = finished. No spinner state,
   *  since the bubble shows 'aborted' only on a real crash. */
  status: 'pending' | 'done';
  /** Optional: tool_use_id if present. */
  id?: string;
}

/**
 * State of a streaming HistoryItem:
 *   - `streaming` = snapshot younger than 10s, writer still active
 *   - `aborted`   = snapshot older than 10s, writer probably dead
 *
 * Heuristic in the backend (see Recovery-Syn point 4).
 */
export type StreamingState = 'streaming' | 'aborted';

