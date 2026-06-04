/**
 * lib/discovery-mode/continuity.ts
 * ----------------------------------------------------------------------------
 * 2026-05-29 — Continuity check on a discovery-mode switch — Opus 4.8.
 *
 * Source: master brief §6 + §20.3. Verbatim §6:
 *
 *   > „Jeder Reframe muss eine Continuity Checkpoint erzeugen: Welche
 *   >  bisherigen Informationen bleiben gueltig, welche werden ersetzt,
 *   >  welche fehlen noch?"
 *
 * The LLM problem described in §6: „Das Modell wechselt die
 * Abstraktionsebene, ohne die vorherigen Wissensbausteine sauber
 * weiterzutragen." → On a switch from priorMode → nextMode we check
 * DETERMINISTICALLY (N6) which of the so-far collected beliefs/decisions
 *   - stay valid (stillValid),
 *   - get replaced/superseded by the new mode (superseded),
 *   - are now missing to run the new mode sensibly (missing).
 *
 * Pure function. No I/O. Optional persistence NOT here (see README:
 * the main agent calls `writeDecision` from `lib/workstreams/trace-repo.ts`).
 *
 * Constraints:
 *   - N6 deterministic — fixed rule matrix, no LLM heuristic.
 *   - N1 — beliefs/decisions are taken over verbatim, no `.slice`.
 *   - N8 — the checkpoint is evidence ("why does X stay valid"), not a log.
 */

import type { DiscoveryMode } from './detect';

// ---------------------------------------------------------------------------
// Public Types
// ---------------------------------------------------------------------------

/** A so-far collected knowledge piece (belief or decision). */
export interface PriorKnowledge {
  /** Stable ID (e.g. reasoning_bank belief ID or workstream_decision ID). */
  id: string;
  /** Verbatim text (N1 — do not truncate). */
  text: string;
  /**
   * In which mode this piece arose. Determines whether a mode switch
   * supersedes it. Optional — if unknown, it counts as mode-neutral and
   * stays valid by default.
   */
  originMode?: DiscoveryMode;
  /** Optional category for gap detection (see missing). */
  kind?: KnowledgeKind;
}

/**
 * Coarse knowledge categories — used to detect what the nextMode is MISSING.
 * Deliberately kept small (deterministic, curatable).
 */
export type KnowledgeKind =
  | 'term' // clarified term (clarify)
  | 'rule' // rule/SOP/principle (extract_expertise)
  | 'role' // role/persona (role_reverse_engineer)
  | 'idea' // open idea (brainstorm/innovate)
  | 'scenario' // played-through scenario (simulate)
  | 'plan' // plan piece (plan_graph)
  | 'artifact' // built artifact (build)
  | 'finding' // review finding (review)
  | 'vision'; // vision/expectation (reconcile)

export interface ContinuityCheckInput {
  priorMode: DiscoveryMode;
  nextMode: DiscoveryMode;
  /** So-far collected beliefs (e.g. from the ReasoningBank). */
  priorBeliefs?: PriorKnowledge[];
  /** So-far made decisions (e.g. workstream_decisions). */
  priorDecisions?: PriorKnowledge[];
}

export interface ContinuityItem {
  id: string;
  text: string;
  /** Why valid / why superseded — verbatim justification (N8). */
  reason: string;
}

export interface MissingItem {
  /** Which knowledge kind the nextMode needs but is not present. */
  kind: KnowledgeKind;
  /** Plain-text hint of what should be collected. */
  prompt: string;
}

export interface ContinuityCheckpoint {
  priorMode: DiscoveryMode;
  nextMode: DiscoveryMode;
  /** Pieces that stay valid in the new mode. */
  stillValid: ContinuityItem[];
  /** Pieces that the new mode supersedes/replaces. */
  superseded: ContinuityItem[];
  /** Knowledge gaps that the new mode needs. */
  missing: MissingItem[];
  /**
   * §20.3 question 5: „Darf geplant werden?" — false as long as the nextMode is a
   * no-direct-plan mode OR critical gaps exist.
   */
  mayPlan: boolean;
  /** Verbatim summary for the audit/decision row (N8). */
  summary: string;
}

// ---------------------------------------------------------------------------
// Rule matrix: which mode switch supersedes which knowledge kind
// ---------------------------------------------------------------------------
//
// Core case from §6: a switch to a MORE ABSTRACT level (e.g. build → innovate
// or plan_graph → brainstorm) must not silently drop CONCRETE pieces —
// they stay valid but are marked as "context". Conversely a
// MORE CONCRETE/REVISING mode supersedes open/speculative pieces:
//   - innovate supersedes earlier `idea` pieces (a reframe replaces the old idea).
//   - reconcile/review do NOT supersede `artifact` pieces but evaluate
//     them (they stay valid).
//   - clarify supersedes nothing — it only adds.
//
// We encode this as: per nextMode a set of originMode/kind whose
// pieces count as `superseded`. Everything else stays `stillValid`.

interface SupersedeRule {
  /** Applies if the piece comes from one of these modes … */
  originModes?: DiscoveryMode[];
  /** … or is of one of these knowledge kinds. */
  kinds?: KnowledgeKind[];
}

const SUPERSEDE_RULES: Partial<Record<DiscoveryMode, SupersedeRule>> = {
  // Innovate is a reframe → earlier open ideas are replaced, the new view
  // wins. Clarified terms/rules/roles stay (they are the foundation).
  innovate: { originModes: ['brainstorm'], kinds: ['idea'] },
  // A new brainstorm reopens the space → an already fixed plan
  // is no longer binding (marked as superseded, idea anew).
  brainstorm: { originModes: ['plan_graph'], kinds: ['plan'] },
  // plan_graph replaces earlier loose ideas with concrete steps: the ideas
  // are carried into the plan → marked as superseded (absorbed into the plan).
  plan_graph: { originModes: ['brainstorm', 'innovate'], kinds: ['idea'] },
  // build supersedes nothing in substance — it consumes the plan. The plan stays
  // valid (reference). Therefore NO rule → everything stillValid.
  // review/reconcile evaluate, do not replace → no rule.
  // clarify/extract_expertise/role_reverse_engineer/simulate add → none.
};

// ---------------------------------------------------------------------------
// Requirements per nextMode → what MUST be present (otherwise `missing`)
// ---------------------------------------------------------------------------
//
// §20.3 question 4: „Welche Wissensluecken bleiben?" — per nextMode we define
// which knowledge kind is expected. If it is missing among the (still-valid)
// pieces, we generate a `missing` item.

interface ModeRequirement {
  kind: KnowledgeKind;
  prompt: string;
  /** true = hard gap → blocks mayPlan. */
  critical: boolean;
}

const MODE_REQUIREMENTS: Partial<Record<DiscoveryMode, ModeRequirement[]>> = {
  plan_graph: [
    { kind: 'rule', prompt: 'Regeln/SOPs, an denen sich der Plan ausrichten muss.', critical: false },
    { kind: 'vision', prompt: 'Vision/Erwartung, gegen die geplant wird.', critical: true },
  ],
  build: [
    { kind: 'plan', prompt: 'Ein freigegebener Plan-Graph, bevor gebaut wird.', critical: true },
    { kind: 'role', prompt: 'Zuständige Rolle/Skills für die Umsetzung.', critical: false },
  ],
  simulate: [
    { kind: 'role', prompt: 'Eine Rolle/Persona, die im Szenario handelt.', critical: false },
    { kind: 'scenario', prompt: 'Ein konkretes Szenario/Fall zum Durchspielen.', critical: false },
  ],
  role_reverse_engineer: [
    { kind: 'rule', prompt: 'Beobachtetes Verhalten/Regeln, aus denen die Rolle abgeleitet wird.', critical: false },
  ],
  reconcile: [
    { kind: 'vision', prompt: 'Vision/Regeln/Erwartung als Abgleich-Referenz.', critical: true },
    { kind: 'artifact', prompt: 'Ein Ergebnis/Artefakt, das abgeglichen wird.', critical: false },
  ],
  review: [
    { kind: 'artifact', prompt: 'Ein Output/Artefakt, das reviewt werden soll.', critical: false },
  ],
  innovate: [
    { kind: 'term', prompt: 'Geklärte Begriffe als Fundament für den Reframe.', critical: false },
  ],
};

// Modes in which direct planning is NOT allowed — mirrored from detect.ts,
// kept locally here to avoid import-cycle risk (purely additive).
const NO_PLAN_MODES: readonly DiscoveryMode[] = [
  'brainstorm',
  'clarify',
  'extract_expertise',
  'innovate',
];

// ---------------------------------------------------------------------------
// continuityCheck — main entry
// ---------------------------------------------------------------------------

function matchesSupersede(item: PriorKnowledge, rule: SupersedeRule | undefined): boolean {
  if (!rule) return false;
  if (rule.originModes && item.originMode && rule.originModes.includes(item.originMode)) {
    return true;
  }
  if (rule.kinds && item.kind && rule.kinds.includes(item.kind)) return true;
  return false;
}

/**
 * Generates a continuity checkpoint for the switch priorMode → nextMode.
 *
 * Deterministic (N6):
 *   - stillValid/superseded: per piece against SUPERSEDE_RULES[nextMode].
 *   - missing: MODE_REQUIREMENTS[nextMode] minus the present (valid) kinds.
 *   - mayPlan: false when nextMode is a no-plan mode OR a critical
 *     gap exists (§20.3 question 5).
 *
 * Idempotency/same-mode: priorMode === nextMode → no reframe → everything valid,
 * nothing superseded, gaps still checked (the mode could become active for the
 * first time without prior knowledge).
 */
export function continuityCheck(input: ContinuityCheckInput): ContinuityCheckpoint {
  const { priorMode, nextMode } = input;
  const beliefs = input.priorBeliefs ?? [];
  const decisions = input.priorDecisions ?? [];
  const all: PriorKnowledge[] = [...beliefs, ...decisions];

  const rule = SUPERSEDE_RULES[nextMode];
  const sameMode = priorMode === nextMode;

  const stillValid: ContinuityItem[] = [];
  const superseded: ContinuityItem[] = [];

  for (const item of all) {
    // On same-mode there is no reframe → nothing is superseded.
    const overridden = !sameMode && matchesSupersede(item, rule);
    if (overridden) {
      superseded.push({
        id: item.id,
        text: item.text, // verbatim, N1
        reason:
          `Modus-Wechsel ${priorMode}→${nextMode} überholt diesen ` +
          `${item.kind ?? 'baustein'} (Ursprung: ${item.originMode ?? 'unbekannt'}).`,
      });
    } else {
      stillValid.push({
        id: item.id,
        text: item.text, // verbatim, N1
        reason:
          `Bleibt gültig: ${item.kind ?? 'baustein'} ` +
          `(Ursprung: ${item.originMode ?? 'modus-neutral'}) wird von ` +
          `${nextMode} nicht ersetzt.`,
      });
    }
  }

  // Gap detection: which required kinds are missing among the valid ones?
  const presentKinds = new Set<KnowledgeKind>(
    stillValid
      .map((v) => all.find((a) => a.id === v.id)?.kind)
      .filter((k): k is KnowledgeKind => Boolean(k)),
  );
  const requirements = MODE_REQUIREMENTS[nextMode] ?? [];
  const missing: MissingItem[] = [];
  let criticalGap = false;
  for (const req of requirements) {
    if (!presentKinds.has(req.kind)) {
      missing.push({ kind: req.kind, prompt: req.prompt });
      if (req.critical) criticalGap = true;
    }
  }

  const isNoPlanMode = NO_PLAN_MODES.includes(nextMode);
  const mayPlan = !isNoPlanMode && !criticalGap;

  const summary =
    `Continuity ${priorMode}→${nextMode}: ` +
    `${stillValid.length} gültig, ${superseded.length} überholt, ` +
    `${missing.length} Lücke(n). ` +
    (mayPlan
      ? 'Planen erlaubt.'
      : isNoPlanMode
        ? `Planen blockiert — ${nextMode} ist ein Klär-/Sammel-Modus (§20.1).`
        : 'Planen blockiert — kritische Wissenslücke offen (§20.3).');

  return {
    priorMode,
    nextMode,
    stillValid,
    superseded,
    missing,
    mayPlan,
    summary,
  };
}
