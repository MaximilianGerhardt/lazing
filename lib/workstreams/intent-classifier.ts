/**
 * lib/workstreams/intent-classifier.ts
 * -------------------------------------
 * 2026-05-01 — workstream intent classification.
 *
 * Addresses the user finding "der unterschied zwischen der implementierung der
 * ideen noch immer nicht klar". On workstream spawn we classify
 * the intent of the user prompt and persist the result on the workstream.
 *
 * Strategy:
 *   1. Regex+keyword heuristic — fast, deterministic, free.
 *   2. Confidence score: keyword hits / weighted scoring.
 *   3. On low confidence (<0.35), an optional LLM fallback (its own tier spawn).
 *      Default: disabled. Enabled via opts.llmFallback=true. Test mode
 *      (NODE_ENV=test) ALWAYS skips the fallback so unit tests
 *      stay deterministic.
 *
 * Pure module — no DB writes, no fetches in the default path.
 * spawnTier is injected via dependency injection as an optional hook
 * (tests can mock it trivially).
 */
import type { ActorType } from '../events/types';

// --- Public Types ----------------------------------------------------------

export type WorkstreamIntent =
  | 'idea'
  | 'implementation'
  | 'bug-fix'
  | 'question'
  | 'discussion';

/**
 * Secondary intents — NOT persisted in workstream.intent (that
 * stays single-valued), but usable as a hint in the UI (e.g. retro tag,
 * discussion context). Currently not in the DB path; exported for tests.
 */
export type SecondaryIntent = 'retro' | 'discussion';

export interface ClassifyResult {
  intent: WorkstreamIntent;
  confidence: number;
  /** Which regex families fired. Debug aid for UI/tests. */
  matched: WorkstreamIntent[];
  /** Truthy sentinel value: did the LLM fallback (if allowed) decide? */
  fallbackUsed: boolean;
}

export interface ClassifyOptions {
  /** Threshold above which there is NO more fallback. Default 0.35. */
  fallbackThreshold?: number;
  /** When true AND confidence below threshold AND hook set → LLM spawn. */
  llmFallback?: boolean;
  /**
   * Optional LLM hook. Returns a canonical intent string or null.
   * Wired in production via spawnTier; in tests it's mocked or
   * omitted.
   */
  llmHook?: (prompt: string) => Promise<WorkstreamIntent | null>;
}

// --- Regex patterns --------------------------------------------------------
//
// Pattern library: case-insensitive word boundaries. Each family has
// a score weight — multi-keyword matches are stronger than a single one.
// The regex deliberately uses Unicode word boundaries (\b), AND German
// umlauts/compounds are caught via substrings rather than a strict
// word boundary (e.g. "stürzt" matches "stürz").

interface PatternFamily {
  intent: WorkstreamIntent;
  patterns: RegExp[];
  /** Per-match score weight. */
  weight: number;
}

const PATTERNS: PatternFamily[] = [
  {
    intent: 'bug-fix',
    weight: 1.2,
    patterns: [
      /\bbug(s)?\b/i,
      /\berror(s|n)?\b/i,
      /\bfehler\b/i,
      /\bkaputt\b/i,
      /\bdefekt\b/i,
      /\babsturz\b/i,
      /\bstürz/i,
      /\bcrash(es|t|ed)?\b/i,
      /\bbroken\b/i,
      /\bgeht nicht\b/i,
      /\bfunktioniert nicht\b/i,
      /\bworks( |t)? nicht\b/i,
      /\bregression\b/i,
      /\bhotfix\b/i,
      /\bquickfix\b/i,
      /\bnpe\b/i,
      /\bstack[- ]?trace\b/i,
      /\bexception\b/i,
      /\b500( |-)?error\b/i,
      /\b404( |-)?error\b/i,
    ],
  },
  {
    intent: 'implementation',
    weight: 1.0,
    patterns: [
      /\bimplementier/i,
      // bau / baue / baust / bauen — also "Bau mir die API"
      /\bbau(e|en|st|t)?\b/i,
      // build / builde / building / built / Build (noun) — avoids a
      // false positive on "Build ist langsam" via the word boundary "Build"
      // (only accept as verb/imperative)
      /\b(builde|building|built)\b/i,
      /\bbuild\b\s+(mir|den|die|das|me|the)\b/i,
      // "setze ... um" + "umsetzen"
      /\bsetze?\b.{0,40}\b(um)\b/i,
      /\bumsetz(en|ung|t|e)?\b/i,
      /\bdeploy(e|t|en|ed|ing)?\b/i,
      /\brelease(n|t|s|d)?\b/i,
      /\bship(pen|t|s|ped|ping)?\b/i,
      // Schiffe / Schiff (German imperative)
      /\bschiff(e|t|en)?\b/i,
      /\bcommit(t|ten|en|s|ted|ting)?\b/i,
      /\brefactor(e|ing|ed|s)?\b/i,
      /\bmigrat(ion|e|ieren|ed|ing)?\b/i,
      /\bschreib(e|en|t)?\b.{0,30}\bcode\b/i,
      /\bfeature\b.{0,30}\b(bauen|implementieren|liefern|umsetzen)\b/i,
      /\bschema\b.{0,30}\b(erweitern|ändern|migration)\b/i,
      /\bendpoint\b/i,
      /\bAPI\b.{0,30}\b(bauen|bau|implementier|hinzufügen|hinzufuegen)\b/i,
    ],
  },
  {
    intent: 'idea',
    weight: 1.0,
    patterns: [
      /\bidee(n)?\b/i,
      /\bbrainstorm/i,
      /\bdenk(e|en|st)?\s+(dir|wir)\b/i,
      /\bwas wäre wenn\b/i,
      /\bwhat if\b/i,
      /\bkönnte? man\b/i,
      /\bvielleicht\b.*\b(könnten|sollten)\b/i,
      /\bvision\b/i,
      /\bkonzept\b/i,
      /\bspinnen\b/i,
      /\bspinn(t|en) wir\b/i,
      /\bideenfindung\b/i,
      /\bblue[- ]sky\b/i,
      /\bmoonshot\b/i,
      /\bpie[- ]in[- ]the[- ]sky\b/i,
    ],
  },
  {
    intent: 'question',
    weight: 0.9,
    patterns: [
      /\bfrage\b/i,
      /\bwie geht\b/i,
      /\bwie funktioniert\b/i,
      /\bwarum\b/i,
      /\bweshalb\b/i,
      /\bwieso\b/i,
      /\bverstehe nicht\b/i,
      /\bkapier(e|st)? nicht\b/i,
      /\bcheck(e|st)? nicht\b/i,
      /\bwhat does\b/i,
      /\bhow do(es)?\b/i,
      /\bcan you explain\b/i,
      /\berkläre? mir\b/i,
      /\bwas (ist|macht|bedeutet)\b/i,
      /\?\s*$/,
    ],
  },
];

// Discussion is the default (no triggers of its own). Retro/discussion as
// secondary could later get their own pattern families (e.g. "retro",
// "lessons learned", "rückblick"). For now not persisted in the DB schema.

// --- Internals -------------------------------------------------------------

interface RawScore {
  intent: WorkstreamIntent;
  score: number;
  matchCount: number;
}

function scorePrompt(prompt: string): RawScore[] {
  const result: Record<WorkstreamIntent, RawScore> = {
    idea: { intent: 'idea', score: 0, matchCount: 0 },
    implementation: { intent: 'implementation', score: 0, matchCount: 0 },
    'bug-fix': { intent: 'bug-fix', score: 0, matchCount: 0 },
    question: { intent: 'question', score: 0, matchCount: 0 },
    discussion: { intent: 'discussion', score: 0, matchCount: 0 },
  };

  for (const family of PATTERNS) {
    for (const re of family.patterns) {
      if (re.test(prompt)) {
        result[family.intent].matchCount += 1;
        result[family.intent].score += family.weight;
      }
    }
  }

  return Object.values(result);
}

/**
 * Normalizes score → confidence in the range [0, 1]. Heuristic:
 *   - 0 hits   → 0.0
 *   - 1 hit    → 0.45 (just above the default threshold 0.35 → no fallback at 1 hit, but close)
 *   - 2 hits   → 0.7
 *   - 3+ hits  → 0.85
 *   - 5+ hits  → 0.95
 *
 * The top score relative to the sum of all scores additionally enters as
 * "distinctness" — when several families fire (bug-fix AND
 * implementation), confidence drops slightly.
 */
function computeConfidence(top: RawScore, totalScore: number): number {
  if (top.matchCount === 0) return 0;
  let base: number;
  if (top.matchCount === 1) base = 0.45;
  else if (top.matchCount === 2) base = 0.7;
  else if (top.matchCount === 3) base = 0.85;
  else if (top.matchCount === 4) base = 0.9;
  else base = 0.95;

  // Distinctness: top.score / totalScore in [topShare ∈ 0..1]. 1 = only one
  // family fired. <0.7 = several competing families. We lower
  // confidence linearly by up to -0.15.
  const topShare = totalScore > 0 ? top.score / totalScore : 1;
  const ambiguityPenalty = (1 - topShare) * 0.2;
  const adjusted = Math.max(0, Math.min(1, base - ambiguityPenalty));
  return Math.round(adjusted * 1000) / 1000;
}

// --- Public API ------------------------------------------------------------

/**
 * Synchronous classifier (regex-only, no LLM fallback). Pure function,
 * deterministic, no I/O.
 */
export function classifyIntentSync(prompt: string): ClassifyResult {
  const safe = (prompt ?? '').trim();
  if (!safe) {
    return {
      intent: 'discussion',
      confidence: 0,
      matched: [],
      fallbackUsed: false,
    };
  }

  const scored = scorePrompt(safe);
  const totalScore = scored.reduce((sum, s) => sum + s.score, 0);
  const matched = scored
    .filter((s) => s.matchCount > 0)
    .map((s) => s.intent);

  // No pattern matched → discussion with confidence 0 (for fallback trigger).
  const top = scored
    .slice()
    .sort((a, b) => b.score - a.score)[0];

  if (!top || top.score === 0) {
    return {
      intent: 'discussion',
      confidence: 0,
      matched: [],
      fallbackUsed: false,
    };
  }

  // Tie-breaker: on equal score the most specific family wins:
  // bug-fix > implementation > question > idea > discussion. Helps with
  // mixed sentences like "implementier den bugfix" — bug-fix wins.
  const tied = scored.filter((s) => s.score === top.score && s.score > 0);
  let winner = top;
  if (tied.length > 1) {
    const order: WorkstreamIntent[] = [
      'bug-fix',
      'implementation',
      'question',
      'idea',
      'discussion',
    ];
    for (const cand of order) {
      const m = tied.find((s) => s.intent === cand);
      if (m) {
        winner = m;
        break;
      }
    }
  }

  const confidence = computeConfidence(winner, totalScore);
  return {
    intent: winner.intent,
    confidence,
    matched,
    fallbackUsed: false,
  };
}

/**
 * Async classifier with an optional LLM fallback on low confidence.
 *
 * Contract rules:
 *   - In tests (NODE_ENV=test) the fallback is NEVER triggered, even when
 *     llmHook is set — tests then run against the pure heuristic.
 *   - When the fallback returns an invalid value (or null), the
 *     sync result keeps precedence.
 *   - fallbackUsed:true is only set when the fallback actually changed
 *     THE final intent.
 */
export async function classifyIntent(
  prompt: string,
  opts: ClassifyOptions = {},
): Promise<ClassifyResult> {
  const sync = classifyIntentSync(prompt);
  const threshold = opts.fallbackThreshold ?? 0.35;
  const isTest = process.env.NODE_ENV === 'test';
  const wantFallback =
    opts.llmFallback === true &&
    !isTest &&
    typeof opts.llmHook === 'function' &&
    sync.confidence < threshold;

  if (!wantFallback) return sync;

  try {
    const fb = await opts.llmHook!(prompt);
    if (fb && isValidIntent(fb) && fb !== sync.intent) {
      return {
        intent: fb,
        // The LLM fallback gets a confidence of 0.5 (below the
        // typical heuristic 2-hit level, above random).
        confidence: 0.5,
        matched: sync.matched,
        fallbackUsed: true,
      };
    }
  } catch {
    /* Fallback fail-open — the heuristic wins. */
  }
  return sync;
}

export function isValidIntent(value: unknown): value is WorkstreamIntent {
  return (
    value === 'idea' ||
    value === 'implementation' ||
    value === 'bug-fix' ||
    value === 'question' ||
    value === 'discussion'
  );
}

/**
 * Normalizes NULL / garbage / legacy values from the DB to a valid
 * intent. Used on read in the service layer.
 */
export function normalizeIntent(
  value: string | null | undefined,
): WorkstreamIntent {
  if (!value) return 'discussion';
  if (isValidIntent(value)) return value;
  return 'discussion';
}

/**
 * UI mapping — icon + visible label + CSS class suffix. Used by the
 * IntentPill; isolated here so server-side renderers can use the same
 * mapping.
 */
export function getIntentMeta(
  intent: WorkstreamIntent,
): { icon: string; label: string; cssSuffix: string } {
  switch (intent) {
    case 'idea':
      return { icon: '◇', label: 'Idee', cssSuffix: 'idea' };
    case 'implementation':
      return { icon: '◆', label: 'Implementierung', cssSuffix: 'implementation' };
    case 'bug-fix':
      return { icon: '◎', label: 'Bug-Fix', cssSuffix: 'bug-fix' };
    case 'question':
      return { icon: '?', label: 'Frage', cssSuffix: 'question' };
    case 'discussion':
    default:
      return { icon: '▤', label: 'Diskussion', cssSuffix: 'discussion' };
  }
}

/**
 * Default strategy per intent. Used by the tier orchestrator as a hint:
 *   - bug-fix         → BugFixSwarm + critic-first
 *   - implementation  → standard senior-dev → reviewer → critic
 *   - idea            → 2 roasters + synthesis without auto-dispatch
 *   - question        → simple Q&A, no sniper
 *   - discussion      → standard
 *
 * Pure mapping function. The tier orchestrator decides itself whether to use
 * the hint (an override via the user's tier choice remains possible at any time).
 */
export interface IntentStrategyHint {
  preset: 'bugfix-swarm' | 'standard' | 'idea-roaster' | 'qa-light' | 'standard-discussion';
  autoDispatch: boolean;
  sniperLoop: boolean;
  criticFirst: boolean;
  description: string;
}

export function getIntentStrategy(intent: WorkstreamIntent): IntentStrategyHint {
  switch (intent) {
    case 'bug-fix':
      return {
        preset: 'bugfix-swarm',
        autoDispatch: true,
        sniperLoop: true,
        criticFirst: true,
        description:
          // Wave 2 (2026-05-03): pipeline with 3-tier roasters in plan/
          // critic/fix. sniperLoop=true additionally triggers V1→V2 AFTER a
          // successful pipeline (phase='done') for a quality gate on the
          // final fix output. Consumers: tier-orchestrator → runIterate
          // reads the strategy via resolveIntentStrategy() and respects
          // sniperLoop=true.
          'Bug-Fix-Pipeline: Detect → Hypothesize (3×) → Plan-Roaster (3×) → Critic-Swarm (3×) → Fix-Roaster (3× Opus) → Verify → Sniper V1→V2 für Quality-Gate.',
      };
    case 'implementation':
      return {
        preset: 'standard',
        autoDispatch: true,
        sniperLoop: true,
        criticFirst: false,
        description:
          'Standard-Pipeline: senior-dev → reviewer → critic mit Sniper-Pause.',
      };
    case 'idea':
      return {
        preset: 'idea-roaster',
        autoDispatch: false,
        sniperLoop: false,
        criticFirst: false,
        description:
          '2 Roaster + Synthesis. Kein Auto-Dispatch — Idee bleibt offen für Iteration.',
      };
    case 'question':
      return {
        preset: 'qa-light',
        autoDispatch: false,
        sniperLoop: false,
        criticFirst: false,
        description: 'Q&A leicht: ein Lead-Agent ohne Sniper / Critic.',
      };
    case 'discussion':
    default:
      return {
        preset: 'standard-discussion',
        autoDispatch: false,
        sniperLoop: true,
        criticFirst: false,
        description:
          'Standard-Diskussion mit Sniper-Pause. Kein Auto-Dispatch.',
      };
  }
}

/**
 * Convenience for the service layer: derive an intent from name +
 * description. The description carries more information and is weighted
 * more heavily by placing it first.
 */
export function classifyFromInput(input: {
  name?: string | null;
  description?: string | null;
}): ClassifyResult {
  const text = `${(input.description ?? '').trim()}\n${(input.name ?? '').trim()}`;
  return classifyIntentSync(text);
}

/** Type helper for other modules. */
export type WorkstreamIntentOrNull = WorkstreamIntent | null;

// `_actor` is exported only so this type import isn't removed from the
// service layer if tests pull just the classifier. Not
// public.
export type _internalActor = ActorType;
