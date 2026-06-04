/**
 * lib/discovery-mode/continuity.ts
 * ----------------------------------------------------------------------------
 * 2026-05-29 — Continuity-Check beim Discovery-Mode-Wechsel — Opus 4.8.
 *
 * Quelle: Master-Brief §6 + §20.3. Verbatim §6:
 *
 *   > „Jeder Reframe muss eine Continuity Checkpoint erzeugen: Welche
 *   >  bisherigen Informationen bleiben gueltig, welche werden ersetzt,
 *   >  welche fehlen noch?"
 *
 * Das in §6 beschriebene LLM-Problem: „Das Modell wechselt die
 * Abstraktionsebene, ohne die vorherigen Wissensbausteine sauber
 * weiterzutragen." → Beim Wechsel von priorMode → nextMode prüfen wir
 * DETERMINISTISCH (N6), welche bisher gesammelten Beliefs/Entscheidungen
 *   - gültig bleiben (stillValid),
 *   - durch den neuen Modus ersetzt/überholt werden (superseded),
 *   - jetzt fehlen, um den neuen Modus sinnvoll zu betreiben (missing).
 *
 * Reine Funktion. Kein I/O. Optionale Persistenz NICHT hier (siehe README:
 * der Haupt-Agent ruft `writeDecision` aus `lib/workstreams/trace-repo.ts`).
 *
 * Constraints:
 *   - N6 deterministisch — feste Regelmatrix, keine LLM-Heuristik.
 *   - N1 — Beliefs/Decisions werden verbatim übernommen, kein `.slice`.
 *   - N8 — der Checkpoint ist Evidenz ("warum bleibt X gültig"), kein Log.
 */

import type { DiscoveryMode } from './detect';

// ---------------------------------------------------------------------------
// Public Types
// ---------------------------------------------------------------------------

/** Ein bisher gesammelter Wissensbaustein (Belief oder Entscheidung). */
export interface PriorKnowledge {
  /** Stabile ID (z. B. reasoning_bank-Belief-ID oder workstream_decision-ID). */
  id: string;
  /** Verbatim-Text (N1 — nicht kürzen). */
  text: string;
  /**
   * In welchem Modus dieser Baustein entstand. Bestimmt, ob ein Mode-Wechsel
   * ihn überholt. Optional — wenn unbekannt, gilt er als modus-neutral und
   * bleibt per Default gültig.
   */
  originMode?: DiscoveryMode;
  /** Optionale Kategorie für Lücken-Erkennung (s. missing). */
  kind?: KnowledgeKind;
}

/**
 * Grobe Wissens-Kategorien — genutzt, um zu erkennen, was dem nextMode FEHLT.
 * Bewusst klein gehalten (deterministisch, kuratierbar).
 */
export type KnowledgeKind =
  | 'term' // geklärter Begriff (clarify)
  | 'rule' // Regel/SOP/Prinzip (extract_expertise)
  | 'role' // Rolle/Persona (role_reverse_engineer)
  | 'idea' // offene Idee (brainstorm/innovate)
  | 'scenario' // durchgespieltes Szenario (simulate)
  | 'plan' // Plan-Baustein (plan_graph)
  | 'artifact' // gebautes Artefakt (build)
  | 'finding' // Review-Befund (review)
  | 'vision'; // Vision/Erwartung (reconcile)

export interface ContinuityCheckInput {
  priorMode: DiscoveryMode;
  nextMode: DiscoveryMode;
  /** Bisher gesammelte Beliefs (z. B. aus der ReasoningBank). */
  priorBeliefs?: PriorKnowledge[];
  /** Bisher getroffene Entscheidungen (z. B. workstream_decisions). */
  priorDecisions?: PriorKnowledge[];
}

export interface ContinuityItem {
  id: string;
  text: string;
  /** Warum gültig / warum überholt — verbatim Begründung (N8). */
  reason: string;
}

export interface MissingItem {
  /** Welche Wissensart der nextMode braucht, aber nicht vorliegt. */
  kind: KnowledgeKind;
  /** Klartext-Hinweis, was gesammelt werden sollte. */
  prompt: string;
}

export interface ContinuityCheckpoint {
  priorMode: DiscoveryMode;
  nextMode: DiscoveryMode;
  /** Bausteine, die im neuen Modus gültig bleiben. */
  stillValid: ContinuityItem[];
  /** Bausteine, die der neue Modus überholt/ersetzt. */
  superseded: ContinuityItem[];
  /** Wissenslücken, die der neue Modus benötigt. */
  missing: MissingItem[];
  /**
   * §20.3 Frage 5: „Darf geplant werden?" — false, solange der nextMode ein
   * No-Direct-Plan-Modus ist ODER kritische Lücken bestehen.
   */
  mayPlan: boolean;
  /** Verbatim-Zusammenfassung für den Audit/Decision-Row (N8). */
  summary: string;
}

// ---------------------------------------------------------------------------
// Regelmatrix: welcher Mode-Wechsel überholt welche Wissensart
// ---------------------------------------------------------------------------
//
// Kernfall aus §6: Wechsel auf eine ABSTRAKTERE Ebene (z. B. build → innovate
// oder plan_graph → brainstorm) darf KONKRETE Bausteine nicht still fallen
// lassen — sie bleiben gültig, werden aber als "Kontext" markiert. Umgekehrt
// überholt ein KONKRETERER/REVIDIERENDER Modus offene/spekulative Bausteine:
//   - innovate überholt frühere `idea`-Bausteine (Reframe ersetzt alte Idee).
//   - reconcile/review überholen `artifact`-Bausteine NICHT, sondern bewerten
//     sie (bleiben gültig).
//   - clarify überholt nichts — es ergänzt nur.
//
// Wir kodieren das als: pro nextMode eine Menge von originMode/kind, deren
// Bausteine als `superseded` gelten. Alles andere bleibt `stillValid`.

interface SupersedeRule {
  /** Trifft zu, wenn der Baustein aus einem dieser Modi stammt … */
  originModes?: DiscoveryMode[];
  /** … oder von einer dieser Wissensarten ist. */
  kinds?: KnowledgeKind[];
}

const SUPERSEDE_RULES: Partial<Record<DiscoveryMode, SupersedeRule>> = {
  // Innovate ist ein Reframe → frühere offene Ideen werden ersetzt, neue Sicht
  // gewinnt. Geklärte Begriffe/Regeln/Rollen bleiben (sie sind Fundament).
  innovate: { originModes: ['brainstorm'], kinds: ['idea'] },
  // Ein neuer Brainstorm öffnet den Raum erneut → ein bereits fixierter Plan
  // ist nicht mehr bindend (wird als überholt markiert, Idee neu).
  brainstorm: { originModes: ['plan_graph'], kinds: ['plan'] },
  // plan_graph ersetzt frühere lose Ideen durch konkrete Schritte: die Ideen
  // werden in den Plan überführt → als überholt markiert (im Plan aufgegangen).
  plan_graph: { originModes: ['brainstorm', 'innovate'], kinds: ['idea'] },
  // build überholt nichts inhaltlich — es konsumiert den Plan. Plan bleibt
  // gültig (Referenz). Daher KEINE Regel → alles stillValid.
  // review/reconcile bewerten, ersetzen nicht → keine Regel.
  // clarify/extract_expertise/role_reverse_engineer/simulate ergänzen → keine.
};

// ---------------------------------------------------------------------------
// Voraussetzungen pro nextMode → was MUSS vorliegen (sonst `missing`)
// ---------------------------------------------------------------------------
//
// §20.3 Frage 4: „Welche Wissensluecken bleiben?" — pro nextMode definieren
// wir, welche Wissensart erwartet wird. Fehlt sie unter den (gültig
// bleibenden) Bausteinen, erzeugen wir ein `missing`-Item.

interface ModeRequirement {
  kind: KnowledgeKind;
  prompt: string;
  /** true = harte Lücke → blockiert mayPlan. */
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

// Modi, in denen NICHT direkt geplant werden darf — gespiegelt aus detect.ts,
// hier lokal gehalten, um Import-Zyklus-Risiko zu vermeiden (rein additiv).
const NO_PLAN_MODES: readonly DiscoveryMode[] = [
  'brainstorm',
  'clarify',
  'extract_expertise',
  'innovate',
];

// ---------------------------------------------------------------------------
// continuityCheck — Haupt-Entry
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
 * Erzeugt einen Continuity-Checkpoint für den Wechsel priorMode → nextMode.
 *
 * Deterministisch (N6):
 *   - stillValid/superseded: pro Baustein gegen SUPERSEDE_RULES[nextMode].
 *   - missing: MODE_REQUIREMENTS[nextMode] minus vorhandene (gültige) kinds.
 *   - mayPlan: false wenn nextMode ein No-Plan-Modus ist ODER eine kritische
 *     Lücke besteht (§20.3 Frage 5).
 *
 * Idempotenz/Same-Mode: priorMode === nextMode → kein Reframe → alles gültig,
 * nichts überholt, Lücken trotzdem geprüft (der Modus könnte erstmals aktiv
 * werden ohne Vorwissen).
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
    // Bei Same-Mode gibt es keinen Reframe → nichts wird überholt.
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

  // Lücken-Erkennung: welche geforderten kinds fehlen unter den gültigen?
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
