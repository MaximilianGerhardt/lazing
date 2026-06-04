import type { ReactNode } from 'react';

/**
 * Discriminated union for a parsed chat message stream.
 *
 * Used by the future Phase 3 chat-shell parser which ingests
 * LLM output and produces a typed message list that can be
 * rendered via <MsgUser>, <MsgAssistant>, <MsgCard>.
 *
 * - `user`: plain string content (typed by the user)
 * - `assistant`: rich ReactNode (may contain <b> highlights)
 * - `card`: a pre-rendered Surface-Block node (Chart, Decision,
 *   Ticket, Invoice, ...)
 */
export type ChatMessage =
  | { type: 'user'; content: string; timestamp?: string }
  | { type: 'assistant'; content: ReactNode }
  | { type: 'card'; node: ReactNode; ariaLabel?: string };
