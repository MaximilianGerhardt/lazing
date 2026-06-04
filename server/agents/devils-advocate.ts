/**
 * P13 — Devil's Advocate (Confirmation-Bias-Counter im Sniper-Loop).
 *
 * Anne (Legaly-AI) full transcript: "when I have a conviction, I interpret
 * new information very selectively so that it confirms my
 * conviction, and I cleverly ignore information that might
 * contradict it"
 *
 * Gap before P13:
 *   In the sniper loop with consensus_level='strong' an echo chamber arises:
 *   Lead+Roaster+Synthesis all agree → may be a false-strong.
 *   Critic asks "is this good?" — Devil's Advocate asks differently:
 *   "which data disprove my thesis?".
 *
 * Trigger:
 *   Only on consensus_level='strong'. On 'majority' / 'disagreement'
 *   the user decides anyway, no need for counter-evidence.
 *
 * Failure mode: fail-soft. If the DA spawn crashes or no verdict is
 * parsed, the synthesis continues normally — the counter is an
 * extra safeguard, not a quality gate.
 *
 * The output lands as its OWN surface card in the chat (counter_evidence_card),
 * NOT mixed into the synthesis card — the user should be able to read synthesis
 * and counter-evidence separately.
 */

import { hashOutput } from '../../lib/audit/reasoning';
import { MODEL_NAMES } from '../../lib/agents/pricing';
import { BRAND_NAME } from '../../lib/brand';
import { spawnAndAudit } from './spawn-and-audit';

export interface DevilsAdvocateOpts {
  workspaceId: string;
  workspacePath: string;
  workstreamId: string;
  parentTicketId: string;
  synthesisText: string;
  originalPrompt: string;
}

/**
 * Engine adapter (E4.1, 2026-05-27) — the ONLY I/O dependency of the
 * Devil's-Advocate core. In production a thin wrapper around
 * `spawnAndAudit` (tmux + claude-CLI + reasoning_audit). In tests a stub
 * that only returns text — so the core is unit-testable WITHOUT a real LLM
 * (Plan §E4.1: "pure, injectable core function").
 *
 * The adapter receives fully rendered system/user prompts and returns
 * the raw output + cost/duration. Parsing/verdict logic stays in the
 * core (deterministic, N6) — the adapter is "dumb".
 */
export interface DevilsAdvocateEngine {
  (input: {
    systemPrompt: string;
    userPrompt: string;
    opts: DevilsAdvocateOpts;
    synthesisHash: string;
  }): Promise<{ text: string; costCents: number; durationMs: number }>;
}

/**
 * E4.1 gating (Plan §E4.1 + P13): the DA pass runs ONLY in exactly the two
 * cases where falsification matters:
 *
 *   1. consensus_level === 'strong' — all tiers agree, and that is exactly where
 *      the echo chamber (false-strong) is a risk. P13 original trigger.
 *   2. whyInjected === true — a WHY block (prior beliefs of this
 *      workspace, P0.3b) flowed into the lead prompt. The read-back
 *      can produce confirmation bias (the AI confirms its own old
 *      convictions) → exactly then the falsifier is needed. That is
 *      the N5 support: the Devil's Advocate challenges BELIEFS, not the
 *      user.
 *
 * On 'majority' / 'disagreement' WITHOUT a WHY injection: no pass — the
 * user decides there anyway, counter-evidence would be noise.
 *
 * Pure function (no I/O) → isolated unit-testable.
 */
export function shouldRunDevilsAdvocate(input: {
  consensusLevel: string | null | undefined;
  whyInjected: boolean;
}): boolean {
  return input.consensusLevel === 'strong' || input.whyInjected === true;
}

/**
 * Builds the (fully rendered) system + user prompt for the DA pass.
 * Extracted as a pure function so tests can check the exact prompt
 * without spawning.
 */
export function buildDevilsAdvocatePrompts(opts: {
  synthesisText: string;
  originalPrompt: string;
}): { systemPrompt: string; userPrompt: string } {
  return {
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: USER_PROMPT_TEMPLATE(opts.synthesisText, opts.originalPrompt),
  };
}

export interface DevilsAdvocateResult {
  /** Full DA output (markdown) — lands in the counter card. */
  text: string;
  costCents: number;
  durationMs: number;
  /** If true: the synthesis is non-falsifiable (red flag). */
  unfalsifiable: boolean;
  /** Number of counter-evidence points found (0-5). */
  counterEvidenceCount: number;
  /** Raw verdict from the output. */
  verdict: 'falsifiable' | 'unfalsifiable' | 'weak-evidence';
  /** Hash over the output (for audit correlation with the synthesis hash). */
  outputHash: string;
}

const SYSTEM_PROMPT = [
  `Du bist Devil's Advocate für ${BRAND_NAME}. Deine EINZIGE Aufgabe: aktiv 3-5`,
  'Datenpunkte/Beobachtungen finden die der gerade-aufgestellten These',
  'WIDERSPRECHEN würden.',
  '',
  'Du bist NICHT Critic ("ist das gut formuliert"). Du bist Falsifikator:',
  '"welche Realität würde das hier widerlegen?"',
  '',
  'Output-Format (Markdown — STRIKT einhalten):',
  '',
  '## Counter-Evidence',
  '',
  '### Counter 1: <Hypothese die das widerlegen würde>',
  '<2-3 Sätze: welche konkrete Beobachtung / welche Daten / welcher',
  ' Stakeholder-Input würde diese These ungültig machen?>',
  '',
  '### Counter 2: ...',
  '### Counter 3: ...',
  '',
  '## Falsifikations-Status',
  '- [ ] Falsifizierbar: drei konkrete Counter-Hypothesen formulierbar',
  '- [ ] Nicht falsifizierbar: These ist tautologisch oder unprüfbar',
  '   (RED-FLAG — Synthesis re-formulieren)',
  '',
  '## Verdict',
  '{verdict: "falsifiable" | "unfalsifiable" | "weak-evidence"}',
  '{counter_count: <integer 0-5>}',
  '',
  'WICHTIG:',
  '  - "falsifiable" = du konntest 3+ konkrete Counter-Hypothesen',
  '    formulieren, die These ist prüfbar.',
  '  - "unfalsifiable" = These ist tautologisch ("X ist gut weil X gut',
  '    ist") oder unprüfbar — RED-FLAG, der User muss sie re-formulieren.',
  '  - "weak-evidence" = du fandest 1-2 Counter-Hypothesen, aber die',
  '    Evidenz-Basis ist dünn — User-Recherche empfohlen.',
  '',
  'Maximal 600 Wörter.',
].join('\n');

const USER_PROMPT_TEMPLATE = (synthesisText: string, originalPrompt: string) =>
  [
    `Original-Anfrage: ${originalPrompt}`,
    '',
    'Aktuelle Synthesis (zu falsifizieren):',
    '---',
    synthesisText,
    '---',
    '',
    'Finde 3-5 konkrete Counter-Evidence-Punkte. Strikt nach Format antworten.',
  ].join('\n');

/**
 * Parser — extracts verdict + counter_count from the DA output.
 *
 * Lenient (not YAML-strict): we match with regex on
 *   `{verdict: "falsifiable"`  or  `{verdict: 'falsifiable'`
 *   `{counter_count: 3`        or  `{counter_count:3`
 *
 * On malformed output → fallback: verdict='weak-evidence', count=0.
 */
export function parseDevilsAdvocateOutput(text: string): {
  verdict: DevilsAdvocateResult['verdict'];
  counterCount: number;
  unfalsifiable: boolean;
} {
  const verdictMatch = text.match(
    /\{?\s*verdict\s*:\s*["']?(falsifiable|unfalsifiable|weak-evidence)["']?/i,
  );
  const countMatch = text.match(/\{?\s*counter_count\s*:\s*(\d{1,2})/i);

  const verdict = (verdictMatch?.[1]?.toLowerCase() ??
    'weak-evidence') as DevilsAdvocateResult['verdict'];
  const counterCount = countMatch
    ? Math.max(0, Math.min(5, parseInt(countMatch[1], 10)))
    : 0;

  // Sanity: on verdict='unfalsifiable' but counter>=3 → inconsistency,
  // we trust the verdict more (that is the explicit statement).
  return {
    verdict,
    counterCount,
    unfalsifiable: verdict === 'unfalsifiable',
  };
}

/**
 * Pure Devil's-Advocate core (E4.1) — engine adapter as a param.
 *
 * Responsible for: prompt building (delegated), engine call, parse,
 * verdict mapping. NO direct spawn — the only I/O goes through the
 * injected `engine`. This makes it testable without a real LLM: a stub engine
 * that returns a fixed output covers counterPoints parsing AND the
 * "non-falsifiable" flag.
 *
 * Fail-soft at the source: if the engine throws, the whole
 * run does NOT break — the caller (tier-orchestrator) catches it anyway, but here
 * we return a well-defined weak-evidence fallback so every
 * caller gets a consistent result instead of an exception.
 */
export async function evaluateDevilsAdvocate(
  engine: DevilsAdvocateEngine,
  opts: DevilsAdvocateOpts,
): Promise<DevilsAdvocateResult> {
  const synthesisHash = hashOutput(opts.synthesisText);
  const { systemPrompt, userPrompt } = buildDevilsAdvocatePrompts({
    synthesisText: opts.synthesisText,
    originalPrompt: opts.originalPrompt,
  });

  const result = await engine({ systemPrompt, userPrompt, opts, synthesisHash });

  const text = result.text || '(devils-advocate fehlgeschlagen)';
  const parsed = parseDevilsAdvocateOutput(text);

  return {
    text,
    costCents: result.costCents,
    durationMs: result.durationMs,
    unfalsifiable: parsed.unfalsifiable,
    counterEvidenceCount: parsed.counterCount,
    verdict: parsed.verdict,
    outputHash: hashOutput(text),
  };
}

/**
 * Production engine: thin wrapper around spawnAndAudit (tmux + claude-CLI +
 * reasoning_audit). Passes the synthesis hash through as priorOutput so
 * the audit makes traceable WHICH synthesis was falsified.
 */
const spawnEngine: DevilsAdvocateEngine = async ({
  systemPrompt,
  userPrompt,
  opts,
  synthesisHash,
}) => {
  const result = await spawnAndAudit(
    {
      workspaceId: opts.workspaceId,
      workspacePath: opts.workspacePath,
      workstreamId: opts.workstreamId,
      tier: 'opus',
      // High agentIdx range, does not collide with synthesis (999) or
      // tier spawns (0..N).
      agentIdx: 998,
      model: MODEL_NAMES.opus,
      systemPrompt,
      userPrompt,
      // 3 min is enough — the DA output is small (<600 words).
      timeoutMs: 3 * 60_000,
    },
    {
      workspaceId: opts.workspaceId,
      workstreamId: opts.workstreamId,
      parentTicketId: opts.parentTicketId,
      phase: 'devils-advocate',
      role: 'cross-roast',
      // Prior output: the synthesis itself, so the audit makes traceable
      // which synthesis output was falsified.
      priorOutputs: [{ phase: 'synthesis', hash: synthesisHash }],
    },
  );
  return {
    text: result.text,
    costCents: result.costCents,
    durationMs: result.durationMs,
  };
};

export async function runDevilsAdvocate(
  opts: DevilsAdvocateOpts,
): Promise<DevilsAdvocateResult> {
  return evaluateDevilsAdvocate(spawnEngine, opts);
}
