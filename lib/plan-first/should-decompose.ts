// N6 entry gate — deterministic pre-screen for plan decomposition.
//
// BACKPORT-03 (2026-05-23 · agent phase C-1).
//
// This function is the N6 pre-screen that decides BEFORE the expensive
// `proposeRecursivePlan` LLM call whether a user intent should be
// decomposed into a plan.
//
// Discipline:
//   - N6: strictly deterministic — no LLM, no I/O, no async.
//         Same input → always the same output.
//   - N1: `reason` is verbatim, no truncation of the signal descriptions.
//   - Bilingual: all regex signals cover German and English prompts.
//   - Conservative: when in doubt, prefer a false negative (no decompose),
//     to avoid unnecessary LLM cost.
//
// Decompose threshold: total score ≥ 2.
//
// Brand: laz.ing · Stack: TypeScript · Node ≥ 20

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A single detected signal that argues for or against decompose.
 *
 * - `name`    : signal ID (e.g. "S1 multi-step-verb-de").
 * - `matched` : the concrete location found in the prompt (for debugging).
 * - `weight`  : contribution to the total score (negative = veto/guard signal).
 */
export interface DecomposeSignal {
  readonly name: string;
  readonly matched: string;
  readonly weight: number;
}

/**
 * Return type of `shouldDecompose`.
 *
 * - `decompose` : true when the score reaches the threshold ≥ 2.
 * - `score`     : numeric total score.
 * - `reason`    : human-readable rationale with the top signals.
 * - `signals`   : all detected individual signals (incl. veto/guards).
 */
export interface ShouldDecomposeResult {
  readonly decompose: boolean;
  readonly score: number;
  readonly reason: string;
  readonly signals: DecomposeSignal[];
}

// ---------------------------------------------------------------------------
// Threshold
// ---------------------------------------------------------------------------

/**
 * Minimum score for decompose = true.
 *
 * Raised 2→3 (2026-06-02, Codex parity): at 2 a SINGLE bare
 * step verb ("Erstelle …", "Refactor", "Deploy") was enough to pop a plan card into the
 * chat — un-Codex (Codex/Claude Code answer/handle simple
 * requests directly, instead of planning for every „erstelle" request). From 3 on it needs
 * a verb PLUS a corroborating complexity signal (project keyword,
 * list, „und" chaining, length, multiple sentences) — i.e. a genuine multi-step
 * undertaking. Plan dispatch remains as a flow but now only fires
 * on genuine complexity instead of on every action.
 */
const DECOMPOSE_THRESHOLD = 3;

// ---------------------------------------------------------------------------
// Helper: count regex matches
// ---------------------------------------------------------------------------

/**
 * Returns all non-overlapping matches of a pattern in the prompt.
 * Flags are ignored — internally `gi` is always used.
 */
function allMatches(pattern: RegExp, text: string): RegExpMatchArray[] {
  // New RegExp object so lastIndex is always fresh.
  const re = new RegExp(pattern.source, 'gi');
  const results: RegExpMatchArray[] = [];
  let m: RegExpMatchArray | null;
  while ((m = re.exec(text)) !== null) {
    results.push(m);
    // Safety: for zero-length matches advance lastIndex manually.
    if (m[0].length === 0) re.lastIndex++;
  }
  return results;
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Decides deterministically whether a user prompt should be decomposed
 * into a multi-step plan (N6 gate).
 *
 * No LLM, no I/O, no async — pure regex + arithmetic.
 *
 * @param prompt - The raw user intent text (any length).
 * @returns      ShouldDecomposeResult with `decompose`, `score`, `reason`, `signals`.
 *
 * @example
 * const r = shouldDecompose('Implementiere einen Auth-Service mit JWT');
 * if (r.decompose) proposeRecursivePlan(prompt);
 */
export function shouldDecompose(prompt: string): ShouldDecomposeResult {
  const collected: DecomposeSignal[] = [];

  // -----------------------------------------------------------------------
  // S12 — negation guard (weight −1)
  //
  // "Schreib mir kurz …", "nur …", "einfach nur …" etc. in the first 40
  // characters indicate a simple request, no plan needed.
  // Only relevant at the FRONT of the prompt — later "nur" can legitimately
  // appear as context ("deploy nur auf Staging").
  // -----------------------------------------------------------------------
  {
    const prefix = prompt.slice(0, 40);
    const re = /\b(nur|only|just|lediglich|einfach\s+nur|kurz)\b/i;
    const m = re.exec(prefix);
    if (m !== null) {
      collected.push({
        name: 'S12 negation-guard',
        matched: m[0],
        weight: -1,
      });
    }
  }

  // -----------------------------------------------------------------------
  // S1 — multi-step verb German (weight +2)
  //
  // Strong action verbs that typically imply multiple steps.
  // A single occurrence is enough — the verb alone signals complexity.
  // -----------------------------------------------------------------------
  {
    const re =
      /\b(implementiere|erstelle|baue|migriere|refactor|refaktoriere|deploy|portiere|konvertiere|scaffolde)\b/i;
    const m = re.exec(prompt);
    if (m !== null) {
      collected.push({
        name: 'S1 multi-step-verb-de',
        matched: m[0],
        weight: 2,
      });
    }
  }

  // -----------------------------------------------------------------------
  // S2 — multi-step verb English (weight +2)
  //
  // English equivalents of S1. Word boundaries needed so "porting" or
  // "deployment" don't pass as standalone verbs.
  // -----------------------------------------------------------------------
  {
    const re =
      /\b(implement|create|build|migrate|refactor|deploy|port|convert|scaffold|bootstrap)\b/i;
    const m = re.exec(prompt);
    if (m !== null) {
      collected.push({
        name: 'S2 multi-step-verb-en',
        matched: m[0],
        weight: 2,
      });
    }
  }

  // -----------------------------------------------------------------------
  // Check whether S1 OR S2 matched (needed for the S10 veto condition).
  // -----------------------------------------------------------------------
  const hasStepVerb = collected.some(
    (s) => s.name === 'S1 multi-step-verb-de' || s.name === 'S2 multi-step-verb-en',
  );

  // -----------------------------------------------------------------------
  // S10 — pure-question VETO (weight −3)
  //
  // Prompt ends with `?`. The veto applies when EITHER no multi-step verb
  // was found OR the prompt begins with a question word
  // (wie/was/how/what/…). The latter beats the step verb: "Wie implementiere
  // ich ein Feature?" is a knowledge question, not a task — without this
  // tightening every how-to question would wrongly trigger the full (expensive)
  // decompose fan-out instead of an answer (critic fix M2, 2026-05-23).
  // -----------------------------------------------------------------------
  {
    const trimmed = prompt.trim();
    const endsWithQuestion = /\?\s*$/.test(trimmed);
    const startsWithQuestionWord =
      /^(wie|was|warum|wieso|weshalb|wann|wo|wer|welche[rs]?|how|what|why|when|where|who|which)\b/i.test(
        trimmed,
      );
    if (endsWithQuestion && (!hasStepVerb || startsWithQuestionWord)) {
      collected.push({
        name: 'S10 pure-question-veto',
        matched: startsWithQuestionWord ? '?+question-word' : '?',
        weight: -3,
      });
    }
  }

  // -----------------------------------------------------------------------
  // S3 — enum connector German (weight +1)
  //
  // Enumeration and sequence words in German.
  // -----------------------------------------------------------------------
  {
    const re =
      /\b(dann|danach|anschließend|außerdem|zusätzlich|sowie|zuerst|zuletzt)\b/i;
    const m = re.exec(prompt);
    if (m !== null) {
      collected.push({
        name: 'S3 enum-connector-de',
        matched: m[0],
        weight: 1,
      });
    }
  }

  // -----------------------------------------------------------------------
  // S4 — enum connector English (weight +1)
  //
  // "then", "next", "after that" etc. signal an explicit sequence.
  // "after that" is tested directly as a special case.
  // -----------------------------------------------------------------------
  {
    const re =
      /\b(then|next|afterwards|additionally|also|first|finally|lastly)\b|after\s+that/i;
    const m = re.exec(prompt);
    if (m !== null) {
      collected.push({
        name: 'S4 enum-connector-en',
        matched: m[0],
        weight: 1,
      });
    }
  }

  // -----------------------------------------------------------------------
  // S5 — list marker (weight +2)
  //
  // Numbered lists (`1.`, `2.` …) OR bullet lists (`- item`, `* item`)
  // from ≥ 2 occurrences. Two or more list items = clear multi-step structure.
  // -----------------------------------------------------------------------
  {
    // Numbered items: \b\d+\. (word boundary before the digit).
    const numberedMatches = allMatches(/\b\d+\./g, prompt);
    // Bullet items: line start (or newline) + optional whitespace + [-*] + whitespace.
    const bulletMatches = allMatches(/(^|\n)\s*[-*]\s/g, prompt);
    const total = numberedMatches.length + bulletMatches.length;
    if (total >= 2) {
      const sample = [...numberedMatches, ...bulletMatches]
        .slice(0, 2)
        .map((m) => m[0].trim())
        .join(', ');
      collected.push({
        name: 'S5 list-marker',
        matched: sample,
        weight: 2,
      });
    }
  }

  // -----------------------------------------------------------------------
  // S6 — and-chaining (weight +1)
  //
  // "und" or "and" ≥ 2 occurrences indicates an enumeration (not just
  // a binary conjunction). Whitespace flanks prevent matches inside
  // compound words like "fundamental".
  // -----------------------------------------------------------------------
  {
    // German "und" with whitespace flanks.
    const deMatches = allMatches(/\s+und\s+/g, prompt);
    // English "and" with whitespace flanks.
    const enMatches = allMatches(/\s+and\s+/g, prompt);
    const total = deMatches.length + enMatches.length;
    if (total >= 2) {
      const sample = [...deMatches, ...enMatches]
        .slice(0, 2)
        .map((m) => m[0].trim())
        .join(', ');
      collected.push({
        name: 'S6 and-chaining',
        matched: sample,
        weight: 1,
      });
    }
  }

  // -----------------------------------------------------------------------
  // S7 — project keyword German (weight +1)
  //
  // Domain nouns that point to a project/architecture undertaking.
  // -----------------------------------------------------------------------
  {
    const re =
      /\b(Projekt|Feature|System|Service|Modul|Architektur|Komponente|Pipeline|Datenbank|Schema|API|Backend|Frontend)\b/i;
    const m = re.exec(prompt);
    if (m !== null) {
      collected.push({
        name: 'S7 project-keyword-de',
        matched: m[0],
        weight: 1,
      });
    }
  }

  // -----------------------------------------------------------------------
  // S8 — project keyword English (weight +1)
  //
  // English equivalents of S7. Case-insensitive because of mixed casing
  // in technical texts ("the API", "a schema", "the backend").
  // -----------------------------------------------------------------------
  {
    const re =
      /\b(project|feature|system|service|module|architecture|component|pipeline|database|schema|api|backend|frontend)\b/i;
    const m = re.exec(prompt);
    if (m !== null) {
      collected.push({
        name: 'S8 project-keyword-en',
        matched: m[0],
        weight: 1,
      });
    }
  }

  // -----------------------------------------------------------------------
  // S9 — length (weight +1)
  //
  // Long prompts (> 200 characters after trim) as a rule describe
  // complex requirements — not a single simple command.
  // -----------------------------------------------------------------------
  {
    if (prompt.trim().length > 200) {
      collected.push({
        name: 'S9 length',
        matched: `${prompt.trim().length} chars`,
        weight: 1,
      });
    }
  }

  // -----------------------------------------------------------------------
  // S11 — multiple sentences (weight +1)
  //
  // Sentence ends (. ! ?) followed by whitespace + capital letter (incl. umlauts).
  // ≥ 3 such transitions = several independent requirement sentences.
  // -----------------------------------------------------------------------
  {
    const transitionMatches = allMatches(/[.!?]\s+[A-ZÜÄÖ]/g, prompt);
    if (transitionMatches.length >= 3) {
      collected.push({
        name: 'S11 multiple-sentences',
        matched: `${transitionMatches.length} transitions`,
        weight: 1,
      });
    }
  }

  // -----------------------------------------------------------------------
  // Compute the score and make the decision
  // -----------------------------------------------------------------------

  // The step verb counts ONCE (2026-06-02 fix): the DE (S1) and EN list (S2)
  // overlap on "refactor"/"deploy"/"migrate"/"port"/"convert" → a bare
  // "Deploy" fired both and thus reached +4 (instead of +2), which wrongly
  // pushed bare verbs over the threshold. We count the verb signal exactly once; the
  // individual S1/S2 signals stay in `collected` (for name assertions/reason).
  let score = 0;
  let stepVerbCounted = false;
  for (const s of collected) {
    const isStepVerb =
      s.name === 'S1 multi-step-verb-de' || s.name === 'S2 multi-step-verb-en';
    if (isStepVerb) {
      if (stepVerbCounted) continue; // a second verb signal contributes 0 to the score
      stepVerbCounted = true;
    }
    score += s.weight;
  }
  const decompose = score >= DECOMPOSE_THRESHOLD;

  // -----------------------------------------------------------------------
  // reason: human-readable top-signal description
  //
  // Positive signals first, then vetos/guards.
  // At most the 3 strongest signals are named — more would be unreadable.
  // -----------------------------------------------------------------------
  const positive = collected
    .filter((s) => s.weight > 0)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 3);
  const negative = collected.filter((s) => s.weight < 0);

  let reason: string;
  if (decompose) {
    const parts = positive.map((s) => `${s.name} (matched: "${s.matched}")`);
    reason = `Decompose: score ${score} ≥ ${DECOMPOSE_THRESHOLD}. Top signals: ${parts.join('; ')}.`;
  } else if (negative.length > 0) {
    const vetoParts = negative.map((s) => `${s.name} (weight ${s.weight})`);
    reason = `No decompose: score ${score} < ${DECOMPOSE_THRESHOLD}. Veto/guard signals: ${vetoParts.join('; ')}.`;
  } else {
    reason = `No decompose: score ${score} < ${DECOMPOSE_THRESHOLD}. Insufficient complexity signals.`;
  }

  return { decompose, score, reason, signals: collected };
}
