/**
 * Reciprocal Rank Fusion (RRF) — pure, deterministic, side-effect-free.
 *
 * N6: no randomness, no external I/O. Given the same ranked lists, always
 * produces the same merged ranking.
 *
 * Reference: Cormack, Clarke, Buettcher (2009) — "Reciprocal Rank Fusion
 * outperforms Condorcet and individual Rank Learning Methods."
 *
 *   RRF score of document d =  Σ  1 / (k + rank_i(d))
 *                              i∈lists
 *
 * where rank_i(d) is the 1-based position of d in ranked list i.
 * Documents missing from a list contribute nothing to the sum.
 *
 * Why k=60 as default? Cormack et al. found k=60 to be robust across
 * fusion pairs. Values in [40, 80] all perform within noise; 60 is the
 * conventional default.
 *
 * Usage in the retriever:
 *   const merged = reciprocalRankFusion(
 *     [lexicalRanking, vectorRanking],  // two or more sorted id-arrays
 *     60                                // k (optional, default=60)
 *   );
 *   // merged is sorted by descending RRF score.
 */

export interface RrfCandidate {
  /** Stable document identifier (rag_chunks.id). */
  id: string;
  /** Final merged RRF score — higher is better. */
  rrfScore: number;
  /**
   * Per-list contribution breakdown for observability.
   * Key is the list index (0 = first list, 1 = second list, …).
   * Value is  1 / (k + rank)  contributed by that list, or 0 if absent.
   */
  contributions: Record<number, number>;
}

/**
 * Merge two or more pre-sorted ranked lists using Reciprocal Rank Fusion.
 *
 * @param rankedLists  Each element is a list of document IDs sorted from
 *                     best (index 0) to worst. IDs not present in a list
 *                     contribute nothing from that list.
 * @param k            The constant that dampens the impact of high ranks
 *                     (default: 60, as per the original RRF paper).
 * @returns            Sorted array of RrfCandidates, highest score first.
 *                     Deterministic: ties are broken by document ID
 *                     lexicographic order (ascending) for stability.
 */
export function reciprocalRankFusion(
  rankedLists: ReadonlyArray<ReadonlyArray<string>>,
  k = 60,
): RrfCandidate[] {
  if (rankedLists.length === 0) return [];

  // Accumulate per-document scores.
  const scores = new Map<string, { total: number; contributions: Record<number, number> }>();

  for (let listIdx = 0; listIdx < rankedLists.length; listIdx++) {
    const list = rankedLists[listIdx];
    for (let rankZeroBased = 0; rankZeroBased < list.length; rankZeroBased++) {
      const id = list[rankZeroBased];
      if (!id) continue;                       // skip empty strings defensively
      const rank = rankZeroBased + 1;          // 1-based rank
      const contribution = 1 / (k + rank);

      const existing = scores.get(id);
      if (existing) {
        existing.total += contribution;
        existing.contributions[listIdx] = (existing.contributions[listIdx] ?? 0) + contribution;
      } else {
        scores.set(id, {
          total: contribution,
          contributions: { [listIdx]: contribution },
        });
      }
    }
  }

  // Build result array.
  const result: RrfCandidate[] = [];
  for (const [id, { total, contributions }] of scores) {
    result.push({ id, rrfScore: total, contributions });
  }

  // Sort by descending RRF score; tie-break by id ascending for determinism.
  result.sort((a, b) => {
    if (b.rrfScore !== a.rrfScore) return b.rrfScore - a.rrfScore;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  return result;
}
