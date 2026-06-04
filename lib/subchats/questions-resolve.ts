/**
 * lib/subchats/questions-resolve.ts — Question-Spinning Auto-Resolve (2026-06-03).
 *
 * Design: docs/plans/2026-06-03_group-chat-question-spinning-design.md §5.2.
 *
 * Automatically sets open sub-chat questions to 'resolved' when they have already
 * been (lexically) answered/superseded in the chat history — via the EXISTING
 * deterministic resolver `detectResolvedAndStaleQuestions` (N6/N7, no LLM).
 * That way answered questions do not „get lost" forever in the pill.
 *
 * Called by the rag-auto-indexer sweep (boot + interval) — no separate
 * timer. Best-effort, does not throw. resolved_by='auto:stale'.
 */

import { getDb } from '@/db/client';
import {
  detectResolvedAndStaleQuestions,
  type OpenQuestion,
  type OpenQuestionsSourceItem,
} from '@/lib/chat/open-questions-lifecycle';
import { resolveQuestion } from './questions-service';

export interface SweepResult {
  scanned: number;
  resolved: number;
}

/**
 * Sweep over all sub-chats with open questions. Per sub-chat, the open
 * questions + the most recent message history are given to the lexical resolver; the
 * returned IDs are set to 'resolved'.
 *
 * @param opts.nowMs Test injection for „now".
 */
export function sweepStaleSubchatQuestions(opts: { nowMs?: number } = {}): SweepResult {
  const raw = getDb().$raw;
  let subchatIds: string[] = [];
  try {
    subchatIds = (
      raw
        .prepare(`SELECT DISTINCT subchat_id FROM subchat_questions WHERE status = 'open'`)
        .all() as { subchat_id: string }[]
    ).map((r) => r.subchat_id);
  } catch {
    return { scanned: 0, resolved: 0 };
  }

  let scanned = 0;
  let resolved = 0;
  for (const sc of subchatIds) {
    let qs: { id: string; text: string }[];
    let msgs: { content: string }[];
    try {
      qs = raw
        .prepare(
          `SELECT id, text FROM subchat_questions WHERE subchat_id = ? AND status = 'open' ORDER BY seq ASC`,
        )
        .all(sc) as { id: string; text: string }[];
      msgs = raw
        .prepare(
          `SELECT content FROM subchat_messages
             WHERE subchat_id = ? AND author_kind != 'system'
             ORDER BY created_at ASC LIMIT 40`,
        )
        .all(sc) as { content: string }[];
    } catch {
      continue;
    }
    if (qs.length === 0) continue;
    scanned += qs.length;

    // Mapping: subchat_question → OpenQuestion (enrichment optional);
    // subchat_message → SourceItem (all participants as 'user' — the resolver
    // checks lexically, independent of the role).
    const questions = qs.map((q) => ({ id: q.id, text: q.text }) as OpenQuestion);
    const history: OpenQuestionsSourceItem[] = msgs.map((m) => ({
      role: 'user' as const,
      content: m.content,
    }));

    const toResolve = detectResolvedAndStaleQuestions(
      questions,
      history,
      opts.nowMs !== undefined ? { nowMs: opts.nowMs } : {},
    );
    for (const id of toResolve) {
      try {
        resolveQuestion(id, 'auto:stale');
        resolved += 1;
      } catch {
        /* fail-soft */
      }
    }
  }
  return { scanned, resolved };
}
