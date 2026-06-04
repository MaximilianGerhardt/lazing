/**
 * RAG Source-Router (Pattern 3 MVP, 2026-05-01).
 *
 * Addresses Anne's main critique: "Plain-Vektor-Search ist die schwächste
 * Form von RAG". Without source-type differentiation, code files,
 * chat logs, tickets and work-products compete in the same flat cosine pool.
 *
 * MVP approach (single-user, no cross-encoder needed):
 *   1. Classify the query via regex → intent (code | status | history | unknown)
 *   2. Multiply source-type weights per intent onto the similarity score
 *   3. Re-sort — Top-K now takes routedScore instead of raw cosine
 *
 * Wave 2 (TBD): source-type preprocessors (transcript/code/markdown/pdf)
 * + token-overlap rerank. Cross-encoder only with a multi-user setup.
 */

export type QueryIntent = 'code' | 'status' | 'history' | 'unknown';
export type SourceWeights = Record<'file' | 'chat' | 'ticket' | 'work-product', number>;

const PATTERNS: { intent: QueryIntent; re: RegExp }[] = [
  {
    intent: 'code',
    re: /\b(function|class|import|export|bug|error|TypeError|fix|refactor|implement|wie\s+(funktioniert|implementiert))\b/i,
  },
  { intent: 'code', re: /\.(ts|tsx|js|py|sql)\b|`[A-Za-z_]+\(\)`/ },
  {
    intent: 'status',
    re: /\b(status|fortschritt|wo\s+stehen|done|offen|blocked|deadline|sprint|ticket|work[- ]?product)\b/i,
  },
  {
    intent: 'history',
    re: /\b(entscheidung|warum|damals|gestern|letzte\s+woche|haben\s+wir\s+besprochen|chat|gesagt)\b/i,
  },
];

const WEIGHTS: Record<QueryIntent, SourceWeights> = {
  code: { file: 1.3, chat: 0.85, ticket: 0.9, 'work-product': 1.05 },
  status: { file: 0.8, chat: 0.95, ticket: 1.3, 'work-product': 1.25 },
  history: { file: 0.85, chat: 1.3, ticket: 1.0, 'work-product': 1.15 },
  unknown: { file: 1.0, chat: 1.0, ticket: 1.0, 'work-product': 1.0 },
};

export function classify(query: string): QueryIntent {
  for (const p of PATTERNS) if (p.re.test(query)) return p.intent;
  return 'unknown';
}

export interface RouterHit {
  sourceType: string;
  similarity: number;
}

export function applyRouting<T extends RouterHit>(
  hits: T[],
  intent: QueryIntent,
): Array<T & { routedScore: number }> {
  const w = WEIGHTS[intent];
  return hits.map((h) => ({
    ...h,
    routedScore: h.similarity * (w[h.sourceType as keyof SourceWeights] ?? 1.0),
  }));
}
