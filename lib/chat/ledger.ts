/**
 * lib/chat/ledger.ts — chat_ledger append-only writer + reader
 * (BACKPORT-01 · 2026-05-23, source: Lazing-V2 packages/runtime/src/streaming/snapshots.ts)
 *
 * The only sanctioned insert path into `chat_ledger`. API routes,
 * stream writers and tests MUST use `appendLedgerRow` — direct
 * INSERTs are forbidden because then content_hash + N1 are not enforced.
 *
 * Service guarantees:
 *   1. N1 — `contentFull` is passed through unchanged. There is NO
 *           code path in this file that calls `.slice()` / `.substring()` /
 *           `.substr()`.
 *   2. N9 — `coordKey` MUST be a non-empty string (at least workspace_id).
 *           Empty coord keys are rejected with an error (fail-closed).
 *   3. N10 — `contentHash` is ALWAYS computed server-side, never trusted
 *           from the client. Caller-supplied hashes are ignored.
 *   4. Idempotency — an insert with an existing (conversation_thread_id, content_hash)
 *           pair returns the existing row instead of duplicating.
 *
 * Note: the function is NOT in a transaction with other writes —
 * the caller is responsible for TX boundaries. For critical flows
 * (e.g. workstream_trace + chat_ledger same-TX) the caller must open a
 * SQLite transaction and call appendLedgerRow within it.
 */

import type { Database as BetterSqliteDatabase } from 'better-sqlite3';

import { contentHash } from './canonical';
import {
  CHAT_LEDGER_ROLES,
  type ChatLedgerRole,
  type ChatLedgerRow,
} from '../../db/schema/chat_ledger';

/** Append payload — the caller provides everything except id+content_hash+created_at. */
export interface AppendLedgerInput {
  /** ManifestCoord encoded — mindestens workspace_id. */
  readonly coordKey: string;
  /** Closed enum, validated. */
  readonly role: ChatLedgerRole;
  /** N1: VERBATIM string, NEVER truncate before the call. */
  readonly contentFull: string;
  /** Conversation group — for a new thread = new ULID. */
  readonly conversationThreadId: string;
  /** Optional: workstream attachment, can be set later via UPDATE. */
  readonly workstreamId?: string | null;
  /** Optional: tool-call array (JSON string or structured object). */
  readonly toolCalls?: unknown | null;
  /** Optional: parent for branched conversations. */
  readonly parentMessageId?: string | null;
  /** Optional: override for tests (default Date.now()). */
  readonly now?: number;
  /** Optional: override id (Tests). Default ULID. */
  readonly id?: string;
}

/** Result discriminator — wrote=true on a new insert, false on a dup hash. */
export type AppendLedgerResult =
  | { readonly wrote: true; readonly row: ChatLedgerRow }
  | { readonly wrote: false; readonly reason: 'duplicate'; readonly row: ChatLedgerRow };

/**
 * Generate a ULID-like ID. We do not want an additional dependency
 * for a single-user MVP — `${prefix}-${time36}-${rand62}` is sort-
 * stable and collision-resistant for our scale.
 */
export function newLedgerId(now: number = Date.now()): string {
  const t = now.toString(36).padStart(9, '0');
  const r = Math.random().toString(36).slice(2, 12).padEnd(10, '0');
  return `CL-${t}-${r}`;
}

interface ExistingRow {
  readonly id: string;
  readonly coord_key: string;
  readonly workstream_id: string | null;
  readonly role: string;
  readonly content_full: string;
  readonly content_hash: string;
  readonly tool_calls_json: string | null;
  readonly parent_message_id: string | null;
  readonly conversation_thread_id: string;
  readonly created_at: number;
}

/**
 * Append a new row into chat_ledger. content_hash is ALWAYS recomputed.
 * On a dup hash within the same conversation_thread_id, the existing
 * row is returned (idempotency — retry-safe).
 */
export function appendLedgerRow(
  db: BetterSqliteDatabase,
  input: AppendLedgerInput,
): AppendLedgerResult {
  // N9: fail-closed on an empty coord_key.
  if (!input.coordKey || input.coordKey.length === 0) {
    throw new Error('appendLedgerRow: coordKey is required (N9)');
  }
  // Closed-enum validation.
  if (!CHAT_LEDGER_ROLES.includes(input.role)) {
    throw new Error(
      `appendLedgerRow: role "${input.role}" not in [${CHAT_LEDGER_ROLES.join(', ')}]`,
    );
  }
  // N1: contentFull may be empty (e.g. tool-only assistant turn), but
  // must explicitly be a string — null/undefined would be data loss.
  if (typeof input.contentFull !== 'string') {
    throw new Error('appendLedgerRow: contentFull must be a string (N1)');
  }

  const now = input.now ?? Date.now();
  const id = input.id ?? newLedgerId(now);
  // tool_calls are stored as canonical JSON; null if undefined.
  const toolCallsJson =
    input.toolCalls === undefined || input.toolCalls === null
      ? null
      : JSON.stringify(input.toolCalls);

  // N10: content_hash over THE PAYLOAD, NOT incl. id/hash itself.
  const hashPayload = {
    coordKey: input.coordKey,
    role: input.role,
    contentFull: input.contentFull,
    toolCallsJson,
    parentMessageId: input.parentMessageId ?? null,
    conversationThreadId: input.conversationThreadId,
    // created_at NICHT in den Hash, damit Idempotency-Replay denselben Hash gibt.
  };
  const hash = contentHash(hashPayload);

  // Idempotency: gleiches thread + gleicher hash = no-op.
  const dup = db
    .prepare(
      `SELECT id, coord_key, workstream_id, role, content_full, content_hash,
              tool_calls_json, parent_message_id, conversation_thread_id, created_at
         FROM chat_ledger
        WHERE conversation_thread_id = ? AND content_hash = ?
        LIMIT 1`,
    )
    .get(input.conversationThreadId, hash) as ExistingRow | undefined;

  if (dup) {
    return {
      wrote: false,
      reason: 'duplicate',
      row: rowFromSql(dup),
    };
  }

  db.prepare(
    `INSERT INTO chat_ledger
       (id, coord_key, workstream_id, role, content_full, content_hash,
        tool_calls_json, parent_message_id, conversation_thread_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.coordKey,
    input.workstreamId ?? null,
    input.role,
    input.contentFull,
    hash,
    toolCallsJson,
    input.parentMessageId ?? null,
    input.conversationThreadId,
    now,
  );

  return {
    wrote: true,
    row: {
      id,
      coordKey: input.coordKey,
      workstreamId: input.workstreamId ?? null,
      role: input.role,
      contentFull: input.contentFull,
      contentHash: hash,
      toolCallsJson,
      parentMessageId: input.parentMessageId ?? null,
      conversationThreadId: input.conversationThreadId,
      createdAt: now,
    },
  };
}

/**
 * Lies eine ganze Konversation in created_at-Order. Read-only — kein .slice
 * auf content_full (N1).
 */
export function readLedgerThread(
  db: BetterSqliteDatabase,
  conversationThreadId: string,
  limit: number = 1000,
): readonly ChatLedgerRow[] {
  const rows = db
    .prepare(
      `SELECT id, coord_key, workstream_id, role, content_full, content_hash,
              tool_calls_json, parent_message_id, conversation_thread_id, created_at
         FROM chat_ledger
        WHERE conversation_thread_id = ?
        ORDER BY created_at ASC
        LIMIT ?`,
    )
    .all(conversationThreadId, limit) as ExistingRow[];
  return rows.map(rowFromSql);
}

/**
 * Read by-id — z.B. für surface-hydration eines spezifischen messages.
 */
export function readLedgerById(
  db: BetterSqliteDatabase,
  id: string,
): ChatLedgerRow | null {
  const row = db
    .prepare(
      `SELECT id, coord_key, workstream_id, role, content_full, content_hash,
              tool_calls_json, parent_message_id, conversation_thread_id, created_at
         FROM chat_ledger
        WHERE id = ?`,
    )
    .get(id) as ExistingRow | undefined;
  return row ? rowFromSql(row) : null;
}

function rowFromSql(r: ExistingRow): ChatLedgerRow {
  return {
    id: r.id,
    coordKey: r.coord_key,
    workstreamId: r.workstream_id,
    role: r.role,
    contentFull: r.content_full,
    contentHash: r.content_hash,
    toolCallsJson: r.tool_calls_json,
    parentMessageId: r.parent_message_id,
    conversationThreadId: r.conversation_thread_id,
    createdAt: r.created_at,
  };
}
