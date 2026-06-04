/**
 * lib/workstreams/intent-classifier.ts
 * -------------------------------------
 * 2026-05-01 — Workstream-Intent-Klassifikation.
 *
 * Adressiert User-Befund "der unterschied zwischen der implementierung der
 * ideen noch immer nicht klar". Wir klassifizieren beim Workstream-Spawn
 * den Intent des User-Prompts und persistieren das Ergebnis am Workstream.
 *
 * Strategie:
 *   1. Regex+Keyword-Heuristik — schnell, deterministisch, free.
 *   2. Confidence-Score: keyword-hits / weighted scoring.
 *   3. Bei low-confidence (<0.35) optional LLM-Fallback (eigener Tier-Spawn).
 *      Default: deaktiviert. Aktiviert via opts.llmFallback=true. Test-Mode
 *      (NODE_ENV=test) skippt den Fallback IMMER, damit Unit-Tests
 *      deterministisch bleiben.
 *
 * Pure module — keine DB-Schreibzugriffe, keine fetches im Default-Pfad.
 * spawnTier wird via dependency-injection als optionaler Hook eingehängt
 * (Tests können trivial mocken).
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
 * Sekundäre Intents — werden NICHT in workstream.intent persistiert (das
 * bleibt single-valued), aber als Hint im UI nutzbar (z.B. retro-Tag,
 * discussion-Kontext). Aktuell nicht im DB-Pfad, exportiert für Tests.
 */
export type SecondaryIntent = 'retro' | 'discussion';

export interface ClassifyResult {
  intent: WorkstreamIntent;
  confidence: number;
  /** Welche Regex-Familien haben gefeuert. Debug-Hilfe für UI/Tests. */
  matched: WorkstreamIntent[];
  /** Wahrer Sentinel-Wert: hat der LLM-Fallback (falls erlaubt) entschieden? */
  fallbackUsed: boolean;
}

export interface ClassifyOptions {
  /** Schwelle, ab der NICHT mehr fallback wird. Default 0.35. */
  fallbackThreshold?: number;
  /** Wenn true UND Confidence unter Threshold UND Hook gesetzt → LLM-Spawn. */
  llmFallback?: boolean;
  /**
   * Optionaler LLM-Hook. Liefert eine kanonische Intent-String oder null.
   * Wird in Production via spawnTier eingehängt; in Tests gemockt oder
   * weggelassen.
   */
  llmHook?: (prompt: string) => Promise<WorkstreamIntent | null>;
}

// --- Regex-Patterns --------------------------------------------------------
//
// Pattern-Bibliothek: case-insensitive Wort-Boundaries. Jede Familie hat
// ein Score-Gewicht — multi-keyword-Treffer sind stärker als ein einzelner.
// Der Regex nutzt absichtlich Unicode-Word-Boundaries (\b) UND deutsche
// Umlaute/Zusammensetzungen werden über Substrings statt strikter
// Wort-Grenze gefangen (z.B. "stürzt" matcht "stürz").

interface PatternFamily {
  intent: WorkstreamIntent;
  patterns: RegExp[];
  /** Pro-Treffer-Score-Gewicht. */
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
      // bau / baue / baust / bauen — auch "Bau mir die API"
      /\bbau(e|en|st|t)?\b/i,
      // build / builde / building / built / Build (Substantiv) — vermeidet
      // false-positive bei "Build ist langsam" über Wort-Boundary "Build"
      // (nur als Verb/Imperativ akzeptieren)
      /\b(builde|building|built)\b/i,
      /\bbuild\b\s+(mir|den|die|das|me|the)\b/i,
      // "setze ... um" + "umsetzen"
      /\bsetze?\b.{0,40}\b(um)\b/i,
      /\bumsetz(en|ung|t|e)?\b/i,
      /\bdeploy(e|t|en|ed|ing)?\b/i,
      /\brelease(n|t|s|d)?\b/i,
      /\bship(pen|t|s|ped|ping)?\b/i,
      // Schiffe / Schiff (deutsch Imperativ)
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

// Discussion ist Default (keine eigenen Trigger). Retro/discussion als
// secondary könnten später eigene Pattern-Familien bekommen (z.B. "retro",
// "lessons learned", "rückblick"). Vorerst nicht im DB-Schema persistiert.

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
 * Normalisiert Score → Confidence im Bereich [0, 1]. Heuristik:
 *   - 0 hits   → 0.0
 *   - 1 hit    → 0.45 (knapp unter Default-Threshold 0.35 → kein Fallback bei 1 hit, aber nahe dran)
 *   - 2 hits   → 0.7
 *   - 3+ hits  → 0.85
 *   - 5+ hits  → 0.95
 *
 * Top-Score relativ zur Summe aller Scores fließt zusätzlich ein als
 * "Eindeutigkeit" — wenn mehrere Familien feuern (bug-fix UND
 * implementation), sinkt das Vertrauen leicht.
 */
function computeConfidence(top: RawScore, totalScore: number): number {
  if (top.matchCount === 0) return 0;
  let base: number;
  if (top.matchCount === 1) base = 0.45;
  else if (top.matchCount === 2) base = 0.7;
  else if (top.matchCount === 3) base = 0.85;
  else if (top.matchCount === 4) base = 0.9;
  else base = 0.95;

  // Eindeutigkeit: top.score / totalScore in [topShare ∈ 0..1]. 1 = nur eine
  // Familie hat gefeuert. <0.7 = mehrere konkurrierende Familien. Wir senken
  // die Confidence linear bis zu max -0.15.
  const topShare = totalScore > 0 ? top.score / totalScore : 1;
  const ambiguityPenalty = (1 - topShare) * 0.2;
  const adjusted = Math.max(0, Math.min(1, base - ambiguityPenalty));
  return Math.round(adjusted * 1000) / 1000;
}

// --- Public API ------------------------------------------------------------

/**
 * Synchroner Classifier (regex-only, kein LLM-Fallback). Reine Funktion,
 * deterministisch, kein I/O.
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

  // Kein Pattern getroffen → discussion mit confidence 0 (für Fallback-Trigger).
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

  // Tie-Breaker: bei gleichem Score gewinnt die spezifischste Familie:
  // bug-fix > implementation > question > idea > discussion. Hilft bei
  // Mischsätzen wie "implementier den bugfix" — bug-fix gewinnt.
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
 * Async Classifier mit optionalem LLM-Fallback bei low-confidence.
 *
 * Vertragsregeln:
 *   - In Tests (NODE_ENV=test) wird der Fallback NIE getriggert, auch wenn
 *     llmHook gesetzt ist — Tests laufen dann gegen die reine Heuristik.
 *   - Wenn der Fallback einen ungültigen Wert liefert (oder null), behält
 *     der Sync-Result den Vortritt.
 *   - fallbackUsed:true wird nur gesetzt, wenn der Fallback DEN finalen
 *     Intent verändert hat.
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
        // LLM-Fallback bekommt eine Confidence von 0.5 (unterhalb des
        // typischen Heuristik-2-Hits-Niveaus, oberhalb von Random).
        confidence: 0.5,
        matched: sync.matched,
        fallbackUsed: true,
      };
    }
  } catch {
    /* Fallback fail-open — Heuristik gewinnt. */
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
 * Normalisiert NULL / Garbage / Legacy-Werte aus der DB auf einen gültigen
 * Intent. Wird beim Read im Service-Layer benutzt.
 */
export function normalizeIntent(
  value: string | null | undefined,
): WorkstreamIntent {
  if (!value) return 'discussion';
  if (isValidIntent(value)) return value;
  return 'discussion';
}

/**
 * UI-Mapping — Icon + sichtbares Label + CSS-Class-Suffix. Wird von der
 * IntentPill genutzt; isoliert hier damit Server-Side-Renderer dasselbe
 * Mapping nutzen kann.
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
 * Default-Strategie pro Intent. Wird vom Tier-Orchestrator als Hint genutzt:
 *   - bug-fix         → BugFixSwarm + Critic-First
 *   - implementation  → Standard senior-dev → reviewer → critic
 *   - idea            → 2-Roaster + Synthesis ohne Auto-Dispatch
 *   - question        → einfaches Q&A, kein Sniper
 *   - discussion      → Standard
 *
 * Reine Mapping-Funktion. Tier-Orchestrator entscheidet selbst, ob er den
 * Hint nutzt (Override durch User-Tier-Wahl bleibt jederzeit möglich).
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
          // Welle 2 (2026-05-03): Pipeline mit 3-Tier-Roastern in Plan/
          // Critic/Fix. sniperLoop=true triggert NACH erfolgreicher Pipeline
          // (phase='done') zusätzlich V1→V2 für Quality-Gate auf den
          // finalen Fix-Output. Konsumenten: tier-orchestrator → runIterate
          // liest die Strategy via resolveIntentStrategy() und respektiert
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
 * Convenience für Service-Layer: aus name + description einen Intent
 * ableiten. Description hat die höhere Information, wird stärker gewichtet
 * indem wir sie zuerst stellen.
 */
export function classifyFromInput(input: {
  name?: string | null;
  description?: string | null;
}): ClassifyResult {
  const text = `${(input.description ?? '').trim()}\n${(input.name ?? '').trim()}`;
  return classifyIntentSync(text);
}

/** Type-Helper für andere Module. */
export type WorkstreamIntentOrNull = WorkstreamIntent | null;

// `_actor` ist exportiert nur damit dieser Type-Import nicht aus
// Service-Layer entfernt wird, falls Tests nur den Classifier ziehen. Nicht
// public.
export type _internalActor = ActorType;
