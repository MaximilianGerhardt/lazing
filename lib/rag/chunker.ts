/**
 * Text chunker for the RAG index (Sprint 2 / strand B, 2026-04-30).
 *
 * Sliding-window strategy with word-boundary respect:
 *   - default chunk size: 600 characters (~150 tokens).
 *   - overlap: 80 characters (avoids topic splits at chunk boundaries).
 *   - breaks at `\n\n` or sentence end when possible.
 *
 * Approx token count: 4 characters ≈ 1 token (English+code mix).
 * Exact BPE counting is overkill here — the indexer uses it only for
 * budget caps, not for a hard token-limit match.
 */

export interface Chunk {
  index: number;
  text: string;
  approxTokens: number;
}

const DEFAULT_CHUNK_CHARS = 600;
const DEFAULT_OVERLAP_CHARS = 80;

export function chunkText(
  raw: string,
  opts: { chunkChars?: number; overlapChars?: number } = {},
): Chunk[] {
  const chunkChars = opts.chunkChars ?? DEFAULT_CHUNK_CHARS;
  const overlapChars = opts.overlapChars ?? DEFAULT_OVERLAP_CHARS;
  const text = raw.trim();
  if (text.length === 0) return [];
  if (text.length <= chunkChars) {
    return [{ index: 0, text, approxTokens: Math.ceil(text.length / 4) }];
  }

  const chunks: Chunk[] = [];
  let pos = 0;
  let idx = 0;
  while (pos < text.length) {
    let end = Math.min(pos + chunkChars, text.length);
    // Break hint: at last `\n\n`, otherwise last `.` or whitespace.
    if (end < text.length) {
      const slice = text.slice(pos, end);
      const paragraphBreak = slice.lastIndexOf('\n\n');
      const sentenceBreak = slice.lastIndexOf('. ');
      const wordBreak = slice.lastIndexOf(' ');
      const hint =
        paragraphBreak > chunkChars * 0.5
          ? paragraphBreak + 2
          : sentenceBreak > chunkChars * 0.5
            ? sentenceBreak + 2
            : wordBreak > chunkChars * 0.5
              ? wordBreak + 1
              : -1;
      if (hint > 0) end = pos + hint;
    }
    const piece = text.slice(pos, end).trim();
    if (piece.length > 0) {
      chunks.push({
        index: idx,
        text: piece,
        approxTokens: Math.ceil(piece.length / 4),
      });
      idx += 1;
    }
    if (end >= text.length) break;
    pos = Math.max(pos + 1, end - overlapChars);
  }
  return chunks;
}
