/**
 * chat-event-log.ts
 * -----------------
 * Server-side helper: writes chat turns as events into the event log
 * (SQLite `events` table). This makes the chat history cross-device,
 * searchable and traceable — no more localStorage patching.
 *
 * Event schema:
 *   entity_type='chat_turn', entity_id=<reqId>, event_type='prompt_sent'|'response_received'
 *   segment_id = workspaceId (for query compatibility with the events stream)
 *   payload   = { prompt? | text?, tool_calls?, chars_out?, duration_ms?, session_id }
 *
 * Write errors are NEVER fatal for the chat pipeline — the stream
 * must keep working even if the DB row does not come out.
 */

import { getAgentDb } from './db';

function randomId(): string {
  // Very simple — reuses time-prefix + random; enough for local event-log scope.
  const rnd = Math.random().toString(36).slice(2, 10);
  return `EVT-${Date.now().toString(36)}-${rnd}`;
}

export function logPromptSent(args: {
  reqId: string;
  workspaceId: string;
  sessionId: string;
  prompt: string;
  /** Phase ORG SP-2: optional verified subject. */
  actor?: string;
}): void {
  try {
    const db = getAgentDb();
    const stmt = db.prepare(
      `INSERT INTO events (id, created_at, segment_id, entity_type, entity_id, event_type, actor, payload, sensitivity)
       VALUES (@id, @createdAt, @segmentId, 'chat_turn', @entityId, 'prompt_sent', @actor, @payload, 'low')`,
    );
    stmt.run({
      id: randomId(),
      createdAt: Date.now(),
      segmentId: args.workspaceId,
      entityId: args.reqId,
      // The default `user:max-bootstrap` is replaced by the real
      // user ID by the SP-9 backfill; callers who already know a subject should
      // pass it explicitly.
      actor: args.actor ?? 'user:max-bootstrap',
      payload: JSON.stringify({
        workspaceId: args.workspaceId,
        sessionId: args.sessionId,
        prompt: args.prompt.slice(0, 4000),
        prompt_length: args.prompt.length,
      }),
    });
  } catch (err) {
    // Event-log is best-effort; never break chat for logging failure.
    console.warn(
      '[chat-event-log] logPromptSent failed:',
      err instanceof Error ? err.message : err,
    );
  }
}

export function logResponseReceived(args: {
  reqId: string;
  workspaceId: string;
  sessionId: string;
  text: string;
  tool_calls: number;
  duration_ms: number;
  subtype?: string;
  aborted?: boolean;
}): void {
  try {
    const db = getAgentDb();
    const stmt = db.prepare(
      `INSERT INTO events (id, created_at, segment_id, entity_type, entity_id, event_type, actor, payload, sensitivity)
       VALUES (@id, @createdAt, @segmentId, 'chat_turn', @entityId, 'response_received', 'agent:claude', @payload, 'low')`,
    );
    stmt.run({
      id: randomId(),
      createdAt: Date.now(),
      segmentId: args.workspaceId,
      entityId: args.reqId,
      payload: JSON.stringify({
        workspaceId: args.workspaceId,
        sessionId: args.sessionId,
        text: args.text.slice(0, 16000),
        text_length: args.text.length,
        tool_calls: args.tool_calls,
        duration_ms: args.duration_ms,
        subtype: args.subtype,
        aborted: args.aborted ?? false,
      }),
    });
  } catch (err) {
    console.warn(
      '[chat-event-log] logResponseReceived failed:',
      err instanceof Error ? err.message : err,
    );
  }
}
