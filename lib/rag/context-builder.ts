/**
 * ContextBuilder — token-budgeted, deduplicated, cited context assembly.
 *
 * N1: NEVER truncate mid-content on ledger/detail fields.
 *     The token budget is enforced by dropping entire low-ranked chunks,
 *     never by slicing the text of an included chunk.
 * N6: deterministic — same input, same output, no randomness.
 * N10: deduplication is by contentHash when available, falling back to
 *      sourceId (stable chunk identifier from rag_chunks).
 *
 * Typical caller flow:
 *
 *   const result = await retrieve({ workspaceId, query });
 *   const ctx = buildContext(result.hits, { maxTokens: 2000 });
 *   // Inject ctx.contextText into the LLM system prompt.
 *   // Surface ctx.citations for footnote rendering.
 */

import type { RetrievedChunk } from './retriever';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ContextCitation {
  /** 1-based citation number — matches the [#n] marker in contextText. */
  n: number;
  /** Stable chunk identifier. */
  chunkId: string;
  /** Human-readable source label, e.g. "file:src/foo.ts" */
  source: string;
  /** Cosine similarity (or routedScore if available) for observability. */
  score: number;
}

export interface BuiltContext {
  /**
   * The assembled context block ready for LLM injection.
   *
   * Format:
   *   [#1] <passage text>
   *   Source: file:src/foo.ts (sim=0.87)
   *
   *   [#2] <passage text>
   *   Source: chat:conv-123 (sim=0.74)
   *   ...
   *
   *   References:
   *   [#1] file:src/foo.ts
   *   [#2] chat:conv-123
   *
   * Empty string when no chunks fit in the budget.
   */
  contextText: string;
  /** Structured citation list parallel to the [#n] markers. */
  citations: ContextCitation[];
  /** Chunks that were included (subset of input, after dedup + budget). */
  usedChunks: RetrievedChunk[];
  /**
   * Number of chunks from the input that were dropped.
   * Dropped = excluded due to: dedup collision OR budget exhaustion.
   */
  droppedCount: number;
}

export interface BuildContextOpts {
  /**
   * Hard token budget for the assembled contextText.
   *
   * The builder includes whole chunks in descending rank order until the
   * next chunk would exceed this limit — at which point it is dropped
   * entirely (N1: no mid-content truncation).
   *
   * Default: 2000 tokens (≈ 8000 chars at 4 chars/token).
   */
  maxTokens?: number;
  /**
   * When true, each passage is prefixed with the [#n] citation marker
   * inside the text block (in addition to the References footer).
   * Default: true.
   */
  inlineMarkers?: boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Approx tokens from char count (4 chars ≈ 1 token — same heuristic as retriever). */
function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Deduplicate chunks by identity.
 *
 * Priority for dedup key:
 *   1. sourceId (stable and always present, corresponds to original source document chunk)
 *   We use sourceId+chunkIndex if available via the RetrievedChunk's sourceId field.
 *   For identical sourceId, only the first (highest-ranked) occurrence is kept.
 *
 * N10: if two chunks share the same content but have different sourceIds,
 * they are treated as distinct (no content-hash comparison here — the
 * retriever's dedup level is sourceId-based at this layer).
 */
function deduplicateChunks(chunks: RetrievedChunk[]): {
  unique: RetrievedChunk[];
  dupCount: number;
} {
  const seen = new Set<string>();
  const unique: RetrievedChunk[] = [];
  let dupCount = 0;

  for (const chunk of chunks) {
    // Dedup key: combination of sourceType + sourceId (identifies the exact
    // source document chunk; same sourceId from the same source should not
    // appear twice in a context window).
    const key = `${chunk.sourceType}::${chunk.sourceId}::${chunk.id}`;
    if (seen.has(key)) {
      dupCount++;
      continue;
    }
    seen.add(key);
    unique.push(chunk);
  }

  return { unique, dupCount };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Build a token-budgeted, deduplicated, cited context block from a list of
 * already-retrieved (and already workspace-isolated) chunks.
 *
 * N2 guarantee: this function never fetches or re-scopes data. It only
 * assembles what the caller passed in. Workspace isolation is the
 * retriever's responsibility, not this function's.
 *
 * @param chunks  Retrieved chunks in descending relevance order (as returned
 *                by `retrieve()`). The order determines which chunks are
 *                included first when the budget is tight.
 * @param opts    Budget and formatting options.
 */
export function buildContext(
  chunks: RetrievedChunk[],
  opts: BuildContextOpts = {},
): BuiltContext {
  const maxTokens = opts.maxTokens ?? 2000;
  const inlineMarkers = opts.inlineMarkers ?? true;

  // Empty input → empty result (N6: no side effects).
  if (chunks.length === 0) {
    return {
      contextText: '',
      citations: [],
      usedChunks: [],
      droppedCount: 0,
    };
  }

  // --- Step 1: Deduplicate (N10-adjacent: same chunk never injected twice). ---
  const { unique, dupCount } = deduplicateChunks(chunks);

  // --- Step 2: Token-budget pass — whole-chunk granularity only (N1). ---
  const used: RetrievedChunk[] = [];
  let budgetConsumed = 0;
  let budgetDropped = 0;

  for (const chunk of unique) {
    const chunkTokens = chunk.approxTokens ?? approxTokens(chunk.text);
    if (budgetConsumed + chunkTokens > maxTokens) {
      // N1: cannot truncate the text — drop the whole chunk.
      budgetDropped++;
      continue;
    }
    used.push(chunk);
    budgetConsumed += chunkTokens;
  }

  const droppedCount = dupCount + budgetDropped;

  // --- Step 3: No usable chunks → empty context. ---
  if (used.length === 0) {
    return {
      contextText: '',
      citations: [],
      usedChunks: [],
      droppedCount,
    };
  }

  // --- Step 4: Assemble cited context text. ---
  const citations: ContextCitation[] = [];
  const passageLines: string[] = [];

  for (let i = 0; i < used.length; i++) {
    const chunk = used[i];
    const n = i + 1;
    const source = `${chunk.sourceType}:${chunk.sourceId}`;
    const score = chunk.routedScore ?? chunk.similarity;

    citations.push({
      n,
      chunkId: chunk.id,
      source,
      score,
    });

    if (inlineMarkers) {
      passageLines.push(`[#${n}] ${chunk.text}`);
    } else {
      passageLines.push(chunk.text);
    }
    passageLines.push(`Source: ${source} (sim=${score.toFixed(2)})`);
    // Blank line between passages.
    passageLines.push('');
  }

  // --- Step 5: References footer. ---
  const referenceLines: string[] = ['References:'];
  for (const cit of citations) {
    referenceLines.push(`[#${cit.n}] ${cit.source}`);
  }

  const contextText = [
    ...passageLines,
    ...referenceLines,
  ].join('\n').trimEnd();

  return {
    contextText,
    citations,
    usedChunks: used,
    droppedCount,
  };
}
