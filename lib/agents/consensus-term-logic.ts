/**
 * Quadruple-form aggregator (Wave 3c, 2026-05-03).
 *
 * Consumed by the sniper-roaster pipeline: N roasters each produce a
 * list of terms (claim+basis+confidence). The aggregator groups by
 * string similarity, averages confidence, builds conflict clusters + outlier
 * detection. Pure logic, no LLM.
 *
 * Addresses the "symbolic AI" pillar: consensus formation between agents is
 * computed deterministically, not "the lead agent summarizes and we
 * hope". Wave 2 (spawnPlanRoaster) has its own fallback aggregator —
 * this one is the formal variant for merging.
 */

export interface Term {
  /** Numeric ID within the list — for conflictsWith references. */
  id?: string;
  claim: string;
  basis: string;
  confidence: number; // 0..1
  conflictsWith?: string[]; // IDs of other terms that contradict
}

export interface ConsensusGroup {
  representativeClaim: string;
  basisMerged: string[];
  avgConfidence: number;
  voteCount: number;
  termIds: string[];
}

export interface ConflictCluster {
  terms: Term[];
  reason: string;
}

export interface ConsensusOutput {
  agreedTerms: ConsensusGroup[];
  conflictClusters: ConflictCluster[];
  outliers: Term[];
}

const SIMILARITY_THRESHOLD = 0.7;
const OUTLIER_CONFIDENCE = 0.5;

/**
 * Levenshtein-based normalized similarity. 1 = identical, 0 = completely
 * different. Without stemming/stopwords — this heuristic suffices for
 * roaster outputs that typically share the same word stem.
 */
export function similarity(a: string, b: string): number {
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  if (x.length === 0 && y.length === 0) return 1;
  if (x.length === 0 || y.length === 0) return 0;
  if (x === y) return 1;
  const dist = levenshtein(x, y);
  const maxLen = Math.max(x.length, y.length);
  return 1 - dist / maxLen;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp: number[] = new Array(n + 1);
  for (let j = 0; j <= n; j += 1) dp[j] = j;
  for (let i = 1; i <= m; i += 1) {
    let prev = i - 1;
    dp[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const tmp = dp[j];
      if (a[i - 1] === b[j - 1]) {
        dp[j] = prev;
      } else {
        dp[j] = 1 + Math.min(prev, dp[j], dp[j - 1]);
      }
      prev = tmp;
    }
  }
  return dp[n];
}

/**
 * Aggregates N lists of terms (one per roaster) into a consensus.
 *
 * - Group by `claim` similarity ≥ 0.7 → same claim.
 * - agreedTerms: ≥ 2 roaster votes for the group.
 * - conflictClusters: two groups where at least one term from A has a
 *   conflictsWith entry that occurs in B (by ID).
 * - outliers: groups with < 2 votes AND avgConfidence < 0.5.
 */
export function aggregateTerms(termsByRoaster: Term[][]): ConsensusOutput {
  // 1. Flatten + assign IDs (if missing) — IDs unique per call.
  const flat: Term[] = [];
  termsByRoaster.forEach((list, roasterIdx) => {
    list.forEach((t, termIdx) => {
      flat.push({
        ...t,
        id: t.id ?? `r${roasterIdx}_t${termIdx}`,
      });
    });
  });

  if (flat.length === 0) {
    return { agreedTerms: [], conflictClusters: [], outliers: [] };
  }

  // 2. Greedy clustering: each term into the first matching group or a new one.
  const groups: Array<{
    representative: Term;
    members: Term[];
  }> = [];

  for (const t of flat) {
    let placed = false;
    for (const g of groups) {
      if (similarity(g.representative.claim, t.claim) >= SIMILARITY_THRESHOLD) {
        g.members.push(t);
        placed = true;
        break;
      }
    }
    if (!placed) {
      groups.push({ representative: t, members: [t] });
    }
  }

  // 3. Build groups + classify.
  const agreedTerms: ConsensusGroup[] = [];
  const outliers: Term[] = [];

  for (const g of groups) {
    const voteCount = g.members.length;
    const avgConfidence =
      g.members.reduce((acc, m) => acc + m.confidence, 0) / voteCount;
    const basisMerged = Array.from(
      new Set(g.members.map((m) => m.basis).filter((b) => b && b.length > 0)),
    );
    if (voteCount >= 2) {
      agreedTerms.push({
        representativeClaim: g.representative.claim,
        basisMerged,
        avgConfidence,
        voteCount,
        termIds: g.members.map((m) => m.id!),
      });
    } else if (avgConfidence < OUTLIER_CONFIDENCE) {
      outliers.push(g.representative);
    } else {
      // Single-vote-but-confident: not an agreedTerm (no consensus) and not an
      // outlier (roaster is sure) — we do NOT add it to agreedTerms
      // with voteCount=1, instead it enters conflictClusters if
      // it is contradicted, or simply stays invisible (caller
      // decides whether single-confident claims are queried again).
      // For symmetry: we don't put it in outliers either. Drop.
    }
  }

  // 4. Conflict cluster: group A contains a term with conflictsWith=[X],
  //    and group B contains a term with ID X (or claim-similar).
  const idToGroupIdx = new Map<string, number>();
  groups.forEach((g, idx) => {
    g.members.forEach((m) => idToGroupIdx.set(m.id!, idx));
  });

  const conflictClusters: ConflictCluster[] = [];
  const seenPairs = new Set<string>();
  for (let i = 0; i < groups.length; i += 1) {
    const g = groups[i];
    for (const m of g.members) {
      if (!m.conflictsWith || m.conflictsWith.length === 0) continue;
      for (const otherId of m.conflictsWith) {
        const otherIdx = idToGroupIdx.get(otherId);
        if (otherIdx === undefined || otherIdx === i) continue;
        const pairKey = i < otherIdx ? `${i}_${otherIdx}` : `${otherIdx}_${i}`;
        if (seenPairs.has(pairKey)) continue;
        seenPairs.add(pairKey);
        conflictClusters.push({
          terms: [...g.members, ...groups[otherIdx].members],
          reason: `conflict declared: '${m.claim}' vs. '${groups[otherIdx].representative.claim}'`,
        });
      }
    }
  }

  return { agreedTerms, conflictClusters, outliers };
}
