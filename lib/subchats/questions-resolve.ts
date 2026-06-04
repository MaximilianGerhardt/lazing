/**
 * lib/subchats/questions-resolve.ts — Question-Spinning Auto-Resolve (2026-06-03).
 *
 * Design: docs/plans/2026-06-03_group-chat-question-spinning-design.md §5.2.
 *
 * Setzt offene Sub-Chat-Fragen automatisch auf 'resolved', wenn sie im Chat-
 * Verlauf bereits (lexical) beantwortet/überholt wurden — über den BESTEHENDEN
 * deterministischen Resolver `detectResolvedAndStaleQuestions` (N6/N7, kein LLM).
 * So „untergehen" beantwortete Fragen nicht ewig in der Pille.
 *
 * Wird vom rag-auto-indexer-Sweep aufgerufen (boot + Intervall) — kein eigener
 * Timer. Best-effort, wirft nicht. resolved_by='auto:stale'.
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
 * Sweep über alle Sub-Chats mit offenen Fragen. Pro Sub-Chat werden die offenen
 * Fragen + die jüngste Nachrichten-History an den lexical Resolver gegeben; die
 * zurückgemeldeten IDs werden auf 'resolved' gesetzt.
 *
 * @param opts.nowMs Test-Injektion für „jetzt".
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

    // Mapping: subchat_question → OpenQuestion (Enrichment optional);
    // subchat_message → SourceItem (alle Teilnehmer als 'user' — der Resolver
    // prüft lexical, unabhängig von der Rolle).
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
