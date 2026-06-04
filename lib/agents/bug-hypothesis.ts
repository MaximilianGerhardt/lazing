/**
 * lib/agents/bug-hypothesis.ts
 * ----------------------------
 * Sprint H+ · 2026-05-01 — Bug-fix pipeline phase 3 (hypothesize) + phase 4 (plan).
 *
 * 3 independent root-cause hypotheses via 3-tier sub-spawn:
 *   - syntactic-perspective   (surface symptom: what crashed, which type mismatch)
 *   - semantic-perspective    (logic bug: which control flow/data flow is wrong)
 *   - environmental-perspective (side effect: race, build cache, env var, dep version)
 *
 * Pure compose logic. Caller injects the `spawn` function (usually
 * spawnInTmux) so the module is testable without side effects.
 *
 * Phase 4 (plan) synthesizes the 3 hypotheses into a fix approach:
 *   - highest confidence + most matching file hints wins
 *   - on tie: syntactic > semantic > environmental (closest first)
 *   - output: { winningHypothesis, fixApproach, scopeFiles }
 */

export type HypothesisPerspective =
  | 'syntactic-perspective'
  | 'semantic-perspective'
  | 'environmental-perspective';

export interface Hypothesis {
  perspective: HypothesisPerspective;
  /** 1-sentence summary of the suspected root cause. */
  summary: string;
  /** List of files (with optional line) that the hypothesis spawn names as a source. */
  files: ReadonlyArray<{ file: string; line?: number }>;
  /** 0..1 — how confident the spawn is. */
  confidence: number;
  /** Optional: reproducer steps that the spawn suggests. */
  reproducer?: string;
  /** Raw output for the audit trail. */
  raw: string;
}

export interface SpawnHypothesisInput {
  perspective: HypothesisPerspective;
  bugDescription: string;
  codeContext: string;
  workspacePath: string;
  workstreamId: string;
}

/**
 * Caller-injected spawn function. In production: wraps spawnInTmux.
 * In tests: returns structured mock hypotheses without an LLM call.
 */
export type HypothesisSpawnFn = (input: SpawnHypothesisInput) => Promise<Hypothesis>;

/**
 * Phase 3: spawn 3 hypotheses in parallel.
 *
 * Each spawn is isolated + read-only. Failure of one perspective does NOT
 * block the others — we return failure hypotheses with confidence=0.
 */
export async function spawnHypothesesParallel(
  spawn: HypothesisSpawnFn,
  shared: Omit<SpawnHypothesisInput, 'perspective'>,
): Promise<Hypothesis[]> {
  const perspectives: HypothesisPerspective[] = [
    'syntactic-perspective',
    'semantic-perspective',
    'environmental-perspective',
  ];

  const results = await Promise.allSettled(
    perspectives.map((p) => spawn({ ...shared, perspective: p })),
  );

  return results.map((r, i) => {
    const perspective = perspectives[i]!;
    if (r.status === 'fulfilled') return r.value;
    return {
      perspective,
      summary: `Hypothesis-Spawn fehlgeschlagen: ${truncErr(r.reason)}`,
      files: [],
      confidence: 0,
      raw: String(r.reason ?? ''),
    } as Hypothesis;
  });
}

export interface FixPlan {
  /** The "winning" hypothesis that will be fixed. */
  winningHypothesis: Hypothesis;
  /** All hypotheses with score contribution (for audit). */
  rankedHypotheses: ReadonlyArray<{ hyp: Hypothesis; score: number }>;
  /** Proposed fix approach (1-2 sentences). */
  fixApproach: string;
  /** Scope files the fix will touch. */
  scopeFiles: ReadonlyArray<{ file: string; line?: number }>;
  /** Is the plan product trustworthy or too weak? */
  planQuality: 'strong' | 'weak' | 'no-consensus';
}

/**
 * Phase 4: synthesis — which hypothesis wins + which fix approach.
 *
 * Ranking (in order of priority):
 *   1. Confidence of the hypothesis spawn (higher wins)
 *   2. File overlap with other hypotheses (shared diagnosis = stronger)
 *   3. Perspective tie-breaker: syntactic > semantic > environmental
 *
 * Edge cases:
 *   - all 3 with confidence < 0.3 -> planQuality='weak'
 *   - all 3 different files without overlap -> planQuality='no-consensus'
 */
export function synthesizeFixPlan(hypotheses: ReadonlyArray<Hypothesis>): FixPlan {
  if (hypotheses.length === 0) {
    throw new Error('synthesizeFixPlan: empty hypotheses');
  }

  // Build file-overlap map: per file, count how many hypotheses name it.
  const fileToCount = new Map<string, number>();
  for (const h of hypotheses) {
    const seen = new Set<string>();
    for (const f of h.files) {
      if (seen.has(f.file)) continue;
      seen.add(f.file);
      fileToCount.set(f.file, (fileToCount.get(f.file) ?? 0) + 1);
    }
  }

  const tieBreak: Record<HypothesisPerspective, number> = {
    'syntactic-perspective': 3,
    'semantic-perspective': 2,
    'environmental-perspective': 1,
  };

  // Score = confidence + 0.15 * max overlap of the named files + 0.05 * tieBreak
  const ranked = hypotheses
    .map((h) => {
      const maxOverlap = h.files.reduce(
        (acc, f) => Math.max(acc, fileToCount.get(f.file) ?? 1),
        1,
      );
      const overlapBonus = (maxOverlap - 1) * 0.15; // 0 if only this hyp names it
      const tbBonus = tieBreak[h.perspective] * 0.05;
      const score = h.confidence + overlapBonus + tbBonus;
      return { hyp: h, score: Number(score.toFixed(3)) };
    })
    .sort((a, b) => b.score - a.score);

  const winning = ranked[0]!.hyp;

  // Assess plan quality
  const allWeak = hypotheses.every((h) => h.confidence < 0.3);
  const hasFileOverlap = Array.from(fileToCount.values()).some((c) => c >= 2);
  let planQuality: FixPlan['planQuality'];
  if (allWeak) {
    planQuality = 'weak';
  } else if (!hasFileOverlap && hypotheses.length > 1) {
    planQuality = 'no-consensus';
  } else {
    planQuality = 'strong';
  }

  // Scope files: union of the winning files + all files with overlap >= 2
  const scope = new Map<string, { file: string; line?: number }>();
  for (const f of winning.files) {
    scope.set(f.file, f);
  }
  for (const [file, count] of fileToCount.entries()) {
    if (count >= 2 && !scope.has(file)) {
      scope.set(file, { file });
    }
  }

  const fixApproach = buildFixApproach(winning, planQuality);

  return {
    winningHypothesis: winning,
    rankedHypotheses: ranked,
    fixApproach,
    scopeFiles: Array.from(scope.values()),
    planQuality,
  };
}

function buildFixApproach(winning: Hypothesis, quality: FixPlan['planQuality']): string {
  const head =
    quality === 'strong'
      ? 'Fix-Approach (konsens-basiert):'
      : quality === 'no-consensus'
      ? 'Fix-Approach (kein Konsens — best-guess):'
      : 'Fix-Approach (schwache Evidenz — Vorsicht):';
  return `${head} ${winning.summary} (Perspektive: ${winning.perspective})`;
}

function truncErr(reason: unknown): string {
  const s = String(reason ?? '');
  return s.length > 200 ? s.slice(0, 200) + '…' : s;
}
