/**
 * A5 + A4 — Post-Prozess-IST/SOLL-Reconciliation + optionales WARUM-Nachfragen.
 * Self-Learning / WARUM-Engine · Stream A · 2026-05-27.
 *
 * Quelle: GOAL-lazyos-self-learning-why-engine (Punkt 5 + 4) +
 *         docs/plans/2026-05-27_self-learning-and-flow-completion-plan.md (A5/A4).
 *
 * WARUM dieses Modul (PA-Chat-Befund, verbatim):
 *   Das heygen-Dead-End wurde NUR als orphan aufgeräumt — es entstand KEIN
 *   Lern-Eintrag. Niemand verglich die ursprüngliche Vision/Erwartung (die
 *   rationales des Runs) gegen das tatsächliche Ergebnis; das System konnte
 *   denselben Connector-Drift beim nächsten Mal wieder wählen. A5 schließt
 *   diese Lücke: NACH Workstream-Abschluss ein Reconciliation-Schritt, der das
 *   Gesamt-Outcome bestimmt, es per recordOutcome festhält und — bei Drift
 *   zwischen einer getroffenen Entscheidung und einer aktiven Überzeugung —
 *   einen BEGRÜNDETEN Belief-Update schreibt (upsertBelief mit supersedesId →
 *   die alte Belief bleibt als Historie, „nicht vergessen", N1-Geist).
 *
 *   A4 ergänzt die OPTIONALE WARUM-Frage: wurde eine Entscheidung ohne klare
 *   Begründung getroffen ODER weicht sie von einer früheren Überzeugung ab, so
 *   wird eine open-question im Format erzeugt, das der bestehende
 *   Open-Questions-Pill liest (`extractOpenQuestionsFromContent` →
 *   `<surface:open-questions>{json}</surface:open-questions>`). Wir EMITTIEREN
 *   diese Frage nur — wir blockieren NIE den Run-Abschluss.
 *
 * Arbeitsweise (analog lib/reasoning/beliefs-repo.ts + decisions-read.ts):
 *   - Nimmt ein ROHES better-sqlite3-Handle entgegen — kein getDb()-Singleton,
 *     direkt in-memory testbar. Der Caller (plan-executor) löst das Handle via
 *     `(await import('@/db/client')).getDb().$raw` auf (wie an plan-executor.ts
 *     L461/L943 belegt) und ruft das hier fail-soft (try/catch).
 *   - PURE/IO-arm: nur DB-Read/Write über die A1/A2-Repos, KEIN LLM, KEINE
 *     Netz-I/O. `buildWhyQuestion` ist eine REINE Funktion (kein DB).
 *   - N1:  rationale / note / belief werden VERBATIM weitergereicht (kein .slice).
 *   - Idempotent: ein Run wird nur EINMAL reconciled (Marker im outcome.note,
 *     siehe RECONCILE_MARKER — kein Migrations-Eingriff nötig, N4 additiv).
 */

import {
  recordOutcome,
  recallRelevant,
  upsertBelief,
  reinforceBelief,
  listOutcomes,
  beliefHistory,
  type OutcomeKind,
  type Belief,
} from "@/lib/reasoning/beliefs-repo";
import { listDecisions, type DecisionRow } from "@/lib/reasoning/decisions-read";

type RawDb = import("better-sqlite3").Database;

// ---------------------------------------------------------------------------
// Idempotenz-Marker
// ---------------------------------------------------------------------------

/**
 * Deterministischer Marker, der in den note-Text der Workstream-Outcome-Row
 * eingebettet wird. `decision_outcomes` (0113) hat keine eigene unique/hash-
 * Spalte; der Marker macht den Workstream-Reconcile dennoch idempotent ohne
 * Schema-Eingriff (N4). reconcileWorkstream prüft per listOutcomes(workstreamId),
 * ob bereits eine Row mit diesem Marker existiert → zweiter Aufruf ist No-Op.
 */
export const RECONCILE_MARKER_PREFIX = "[reconcile-v1";

function reconcileMarker(workstreamId: string): string {
  return `${RECONCILE_MARKER_PREFIX}:${workstreamId}]`;
}

// ---------------------------------------------------------------------------
// Outcome-Bestimmung
// ---------------------------------------------------------------------------

/**
 * Leitet das Gesamt-Outcome eines Runs aus den finalen Step-Status ab:
 *   - alle done                         → 'success'
 *   - alle failed                       → 'failure'
 *   - mind. ein done UND mind. ein failed (oder gemischt mit non-terminal)
 *                                       → 'partial'
 *   - keine Steps / nur unbekannte Status → 'unknown'
 *
 * Non-terminal-Status (pending/active) sollten am Reconcile-Punkt nicht mehr
 * vorkommen (der Executor markiert blockierte Steps vorher als failed); falls
 * doch, zählen sie als „nicht erfolgreich" → drücken success Richtung partial.
 */
export function determineOutcome(
  stepStatuses: Record<string, string>,
): OutcomeKind {
  const values = Object.values(stepStatuses);
  if (values.length === 0) return "unknown";

  let done = 0;
  let failed = 0;
  let other = 0;
  for (const v of values) {
    if (v === "done") done += 1;
    else if (v === "failed") failed += 1;
    else other += 1; // pending/active/unbekannt
  }

  if (done === values.length) return "success";
  if (failed === values.length) return "failure";
  if (done === 0 && failed === 0) return "unknown";
  // Gemischt: irgendwas ging, irgendwas nicht.
  return "partial";
}

// ---------------------------------------------------------------------------
// Drift-Erkennung Decision ↔ Belief
// ---------------------------------------------------------------------------

/**
 * Ein einzelner erkannter Drift: eine getroffene Entscheidung weicht von einer
 * aktiven Überzeugung desselben Workspace zum selben Topic ab.
 */
export interface BeliefDrift {
  readonly topic: string;
  readonly decision: DecisionRow;
  /** Die abzulösende aktive Belief (deren WARUM jetzt überholt scheint). */
  readonly priorBelief: Belief;
}

/**
 * Reine Topic-Heuristik: der decision_kind ist der Topic-Schlüssel, unter dem
 * Beliefs für diese Art Entscheidung in der ReasoningBank liegen. (Start-
 * Heuristik analog recallRelevant — bewusst lexikalisch/deterministisch, N6/N7.
 * Embedding-basiertes Topic-Matching ist der dokumentierte Follow-up in
 * beliefs-repo.ts.)
 */
function topicForDecision(d: DecisionRow): string {
  return d.decisionKind;
}

/**
 * Heuristik „Entscheidung weicht von Belief ab": die rationale der Entscheidung
 * enthält den Belief-Text NICHT als Substring (case-insensitiv). Das ist eine
 * bewusst KONSERVATIVE, deterministische Annäherung — sie erkennt den klaren
 * Fall „Run hat etwas anderes getan als die aktive Überzeugung besagt" und
 * vermeidet LLM-Abhängigkeit am fail-soft Abschluss-Pfad. Verfeinerung
 * (semantischer Abgleich) ist Follow-up.
 */
function decisionContradictsBelief(d: DecisionRow, b: Belief): boolean {
  const rationale = d.rationale.toLowerCase();
  const belief = b.belief.trim().toLowerCase();
  if (belief.length === 0) return false;
  return !rationale.includes(belief);
}

/**
 * Findet alle Drifts zwischen den Decisions eines Runs und den aktiven Beliefs
 * desselben Workspace. Pro (Decision × passende aktive Belief) ein Drift, wenn
 * `decisionContradictsBelief`. Pure-Read (recallRelevant + listDecisions sind
 * read-only).
 */
export function detectBeliefDrift(
  raw: RawDb,
  workspaceId: string,
  decisions: readonly DecisionRow[],
): BeliefDrift[] {
  const drifts: BeliefDrift[] = [];
  for (const d of decisions) {
    const topic = topicForDecision(d);
    const beliefs = recallRelevant(raw, workspaceId, topic);
    for (const b of beliefs) {
      if (decisionContradictsBelief(d, b)) {
        drifts.push({ topic, decision: d, priorBelief: b });
      }
    }
  }
  return drifts;
}

// ---------------------------------------------------------------------------
// P0.1 — Outcome-getriebenes Lernen (ReasoningBank-Kernidee)
// ---------------------------------------------------------------------------

/**
 * Deterministischer Marker-Präfix im belief-Text einer P0.1-Lehr-Belief. Macht
 * Lehr-Beliefs (a) idempotent pro Run identifizierbar und (b) für P0.2 deterministisch
 * gruppierbar OHNE Schema-Eingriff — beliefHistory(topic) filtert auf diesen Präfix.
 *
 * Format:  `[teach-v1:<workstreamId>:<outcome>]`
 * Der workstreamId-Teil garantiert: derselbe Run schreibt pro (topic) GENAU eine
 * Lehr-Belief (Idempotenz, RECONCILE_MARKER-Geist auf belief-Ebene).
 */
export const TEACH_MARKER_PREFIX = "[teach-v1";

function teachMarker(workstreamId: string, outcome: OutcomeKind): string {
  return `${TEACH_MARKER_PREFIX}:${workstreamId}:${outcome}]`;
}

/** Erkennt eine P0.1-Lehr-Belief am Marker-Präfix (für P0.2-Gruppierung). */
function isTeachBelief(b: Belief): boolean {
  return b.belief.startsWith(TEACH_MARKER_PREFIX);
}

/**
 * Leitet die Topics ab, unter denen für diesen Run Lehr-Beliefs entstehen
 * sollen — deterministisch aus den failure-relevanten Decisions. Heuristik
 * (N6, lexikalisch, KEINE Schema-Änderung): pro Decision der Topic = decisionKind
 * (gleicher Schlüssel wie Drift-Erkennung + recallRelevant). Gibt EINEN Eintrag
 * je distinct topic zurück, mit den VERBATIM zusammengefügten rationales +
 * Step-Reason-Kontext für genau diesen topic.
 *
 * Wenn der Run KEINE Decisions hat (z.B. reiner Step-Fehler ohne Decision-Row —
 * der PA-Chat-heygen-Fall, bei dem nur ein Connector-Step scheiterte), fällt der
 * topic auf einen synthetischen Step-basierten Schlüssel zurück, damit dennoch
 * gelernt wird: `step:<sortierte-failed-step-keys>`.
 */
interface TeachTopic {
  readonly topic: string;
  /** VERBATIM zusammengefügte Begründungen (N1, kein .slice). */
  readonly rationale: string;
  /** Menschenlesbarer Kurz-Bezeichner des gescheiterten Ansatzes (topic). */
  readonly subject: string;
}

function deriveTeachTopics(
  decisions: readonly DecisionRow[],
  stepStatuses: Record<string, string>,
): TeachTopic[] {
  const failedSteps = Object.entries(stepStatuses)
    .filter(([, v]) => v === "failed")
    .map(([k]) => k)
    .sort();
  const stepReason =
    failedSteps.length > 0
      ? `Gescheiterte Steps: ${failedSteps.join(", ")}.`
      : "Kein einzelner failed-Step markiert.";

  if (decisions.length === 0) {
    // Keine Decision-Row — lerne trotzdem aus den Step-Status (heygen-Fall).
    const topic =
      failedSteps.length > 0 ? `step:${failedSteps.join("+")}` : "run";
    return [
      {
        topic,
        subject: topic,
        rationale: stepReason,
      },
    ];
  }

  // Pro distinct decisionKind die rationales VERBATIM zusammenfassen.
  const byTopic = new Map<string, string[]>();
  for (const d of decisions) {
    const topic = topicForDecision(d);
    const arr = byTopic.get(topic) ?? [];
    // Auch leere rationales mitnehmen (Marker statt verbatim-Lücke) — N1: nicht kürzen.
    arr.push(
      d.rationale.trim().length === 0
        ? `(Decision ${d.id}: ohne Begründung)`
        : `Decision ${d.id} (verbatim): ${d.rationale}`,
    );
    byTopic.set(topic, arr);
  }

  const out: TeachTopic[] = [];
  for (const [topic, rationales] of byTopic) {
    out.push({
      topic,
      subject: topic,
      rationale: `${rationales.join(" || ")} || ${stepReason}`,
    });
  }
  return out;
}

/**
 * P0.1 — schreibt bei outcome 'failure'|'partial' eine VERALLGEMEINERTE
 * Lehr-Belief pro betroffenem topic, AUCH wenn keine vorbestehende Belief
 * existiert (der entscheidende Unterschied zum Drift-Zweig: detectBeliefDrift
 * braucht eine Vor-Belief; P0.1 nicht). Das schließt die PA-Chat-Lücke: ein
 * Run, der einen Connector/Step erstmals scheitern sieht, erzeugt jetzt einen
 * Lern-Eintrag statt NULL.
 *
 * Idempotent pro Run: der teachMarker(workstreamId, outcome) im belief-Text
 * verhindert Doppel-Writes bei Re-Trigger — ist bereits eine Lehr-Belief mit
 * exakt diesem Marker für den topic da, wird übersprungen. source='ai'.
 *
 * Gibt die Anzahl NEU geschriebener Lehr-Beliefs zurück (für ReconcileResult).
 * Fail-soft beim Caller; hier kein eigenes try/catch (deterministisch).
 */
function learnFromOutcome(
  raw: RawDb,
  workspaceId: string,
  workstreamId: string,
  outcome: OutcomeKind,
  decisions: readonly DecisionRow[],
  stepStatuses: Record<string, string>,
): number {
  if (outcome !== "failure" && outcome !== "partial") return 0;

  const marker = teachMarker(workstreamId, outcome);
  const topics = deriveTeachTopics(decisions, stepStatuses);
  let written = 0;

  for (const t of topics) {
    // Idempotenz: existiert für (topic) bereits eine Lehr-Belief mit DIESEM
    // Run-Marker? Dann nicht erneut schreiben. beliefHistory liefert aktiv+abgelöst.
    const existing = beliefHistory(raw, workspaceId, t.topic);
    if (existing.some((b) => b.belief.includes(marker))) continue;

    upsertBelief(raw, {
      workspaceId,
      topic: t.topic,
      // belief beginnt mit dem Marker (P0.2-gruppierbar) + verallgemeinerter Lehre.
      belief:
        `${marker} „${t.subject}" führte zu outcome=${outcome} ` +
        `(Run ${workstreamId}).`,
      // rationale = VERBATIM die failure-bezogenen Decision-rationales + Step-Reason (N1).
      rationale:
        `Outcome-getriebenes Lernen (P0.1, outcome=${outcome}). ` +
        `WARUM (verbatim zusammengefügt): ${t.rationale}`,
      source: "ai",
      // bewusst KEIN supersedesId: eine Lehr-Belief löst NICHTS ab — sie ergänzt.
      // Start-confidence moderat; P0.2 hebt sie bei Wiederholung an.
      confidence: outcome === "failure" ? 0.5 : 0.4,
    });
    written += 1;
  }
  return written;
}

// ---------------------------------------------------------------------------
// P0.2 — Reflexion bei WIEDERHOLTEN Fehlern (Reflexion + ExpeL)
// ---------------------------------------------------------------------------

/**
 * Schwelle: ab so vielen gleichartigen Fehler-Signalen zum selben topic entsteht
 * eine verbal-self-feedback-Meta-Belief (Reflexion + ExpeL). N6: deterministisch.
 */
export const REFLECTION_THRESHOLD = 3;

/** Marker-Präfix einer Meta-Reflexions-Belief (damit sie nicht selbst wieder als
 * Fehler-Signal mitgezählt wird und idempotent erkennbar ist). */
export const REFLECTION_MARKER_PREFIX = "[reflect-v1";

/**
 * P0.2 — zählt gleichartige Fehler-Signale zu einem topic (über die
 * P0.1-Lehr-Beliefs desselben topics) und schreibt ab REFLECTION_THRESHOLD eine
 * verbal-self-feedback-Meta-Belief mit HOHER confidence. Vorbild-GEIST (nicht
 * der Cron): scripts/weekly-reflection-sniper.ts — eine reflektierende Frage,
 * hier als Lehr-Satz formuliert („Nach N Fehlversuchen mit X: bevorzuge/prüfe …").
 *
 * Gruppierung (Research-Entscheidung): die saubere deterministische Quelle OHNE
 * Schema-Änderung sind die P0.1-Lehr-Beliefs (TEACH_MARKER_PREFIX) zum topic —
 * decision_outcomes trägt KEINEN topic und keine decision_id-Verknüpfung im
 * Workstream-Reconcile, ein Outcome→Decision→Kind-Join wäre also nicht
 * deterministisch auflösbar. beliefHistory(topic) liefert alle (aktiven +
 * abgelösten) Lehr-Beliefs des topics → ihre Anzahl IST der Fehler-Zähler.
 *
 * Idempotent: existiert bereits eine Reflexions-Meta-Belief für genau diesen
 * Schwellen-Stand (Count im Marker kodiert), wird sie nicht doppelt geschrieben.
 * Fail-soft beim Caller. Gibt true zurück, wenn eine Meta-Belief geschrieben wurde.
 */
export function reflectOnRepeatedFailures(
  raw: RawDb,
  workspaceId: string,
  topic: string,
): boolean {
  if (typeof workspaceId !== "string" || workspaceId.length === 0) return false;
  if (typeof topic !== "string" || topic.length === 0) return false;

  const history = beliefHistory(raw, workspaceId, topic);
  const failureSignals = history.filter(isTeachBelief);
  const count = failureSignals.length;
  if (count < REFLECTION_THRESHOLD) return false;

  // Idempotenz: Marker kodiert den Schwellen-Count → pro Count nur einmal.
  const marker = `${REFLECTION_MARKER_PREFIX}:${topic}:${count}]`;
  if (history.some((b) => b.belief.includes(marker))) return false;

  // VERBATIM die WARUMs der gezählten Fehlversuche zusammenfügen (N1, kein .slice).
  const joinedWhy = failureSignals.map((b) => b.rationale).join(" || ");

  upsertBelief(raw, {
    workspaceId,
    topic,
    belief:
      `${marker} Nach ${count} Fehlversuchen mit „${topic}": Ansatz prüfen — ` +
      `bevorzuge eine verifizierte Alternative ODER kläre die Grundursache, ` +
      `bevor „${topic}" erneut gewählt wird.`,
    rationale:
      `Reflexion (P0.2, ${count} ≥ Schwelle ${REFLECTION_THRESHOLD}). ` +
      `Verbal self-feedback über die gesammelten Fehlversuche (verbatim): ${joinedWhy}`,
    source: "ai",
    confidence: 0.85, // HOHE confidence — Meta-Lehre aus wiederholter Evidenz.
  });
  return true;
}

// ---------------------------------------------------------------------------
// A4 — optionale WARUM-Frage (REINE Funktion, pill-lesbares Format)
// ---------------------------------------------------------------------------

export interface WhyQuestionInput {
  readonly workstreamId: string;
  /** Begründungslose Entscheidungen (rationale leer/whitespace). */
  readonly unjustified: readonly DecisionRow[];
  /** Decisions, die von einer aktiven Belief abweichen. */
  readonly drifts: readonly BeliefDrift[];
}

/**
 * Erkennt, ob eine Entscheidung „ohne klare Begründung" getroffen wurde: leere
 * oder rein-whitespace rationale. (Verbatim-Erhalt N1 sonst — wir lesen nur,
 * wir kürzen nichts.)
 */
export function isUnjustified(d: DecisionRow): boolean {
  return d.rationale.trim().length === 0;
}

/**
 * Baut den optionalen WARUM-Frage-Text im Format, das der bestehende
 * Open-Questions-Pill liest:
 *   `<surface:open-questions>{ "questions": [ { "id", "q" }, ... ] }</surface:open-questions>`
 * (Feld-Shape exakt wie `parseSurfaceQuestions` in
 * lib/chat/open-questions-lifecycle.ts: `q.q ?? q.text`, `id`+`q` non-empty.)
 *
 * Gibt `null` zurück, wenn es nichts zu fragen gibt (keine begründungslose und
 * keine abweichende Entscheidung) — der Caller hängt dann NICHTS an die
 * Abschluss-Card. REIN: kein DB, kein Seiteneffekt. Idempotente, stabile IDs
 * (workstreamId-präfixiert) damit der Pill dasselbe Set nicht doppelt pinnt.
 */
export function buildWhyQuestion(input: WhyQuestionInput): string | null {
  const questions: Array<{ id: string; q: string }> = [];

  for (const d of input.unjustified) {
    questions.push({
      id: `why-${input.workstreamId}-unjustified-${d.id}`,
      q:
        `Diese Entscheidung (${d.decisionKind}) wurde ohne erkennbare Begründung getroffen. ` +
        `Warum wurde so entschieden? (Decision ${d.id})`,
    });
  }

  for (const drift of input.drifts) {
    questions.push({
      id: `why-${input.workstreamId}-drift-${drift.decision.id}`,
      q:
        `Diese Entscheidung (${drift.decision.decisionKind}) weicht von der bisherigen ` +
        `Überzeugung ab: „${drift.priorBelief.belief}". ` +
        `Warum diesmal anders? (Decision ${drift.decision.id})`,
    });
  }

  if (questions.length === 0) return null;

  // De-Dup über die ID (eine Decision kann theoretisch zugleich unjustified UND
  // drift sein → erstes Vorkommen gewinnt, wie collectOpenQuestionsFromHistory).
  const seen = new Set<string>();
  const dedupedById = questions.filter((q) => {
    if (seen.has(q.id)) return false;
    seen.add(q.id);
    return true;
  });

  // 2026-05-29 (Opus 4.8) — Owner-Befund: 5× DERSELBE Drift-Satz (nur andere
  // Decision-ID) = Lärm. Zusätzlich nach KERN-TEXT kollabieren (Suffix
  // „(Decision …)" abstreifen): identische Reflexionen → EIN Eintrag, mit
  // „(×N Entscheidungen)" wenn mehrfach. So bleibt die Erkenntnis sichtbar,
  // ohne dieselbe Aussage zu wiederholen.
  const coreOf = (q: string): string => q.replace(/\s*\(Decision [^)]+\)\s*$/, '').trim();
  const byCore = new Map<string, { core: string; count: number }>();
  for (const q of dedupedById) {
    const core = coreOf(q.q);
    const e = byCore.get(core);
    if (e) e.count += 1;
    else byCore.set(core, { core, count: 1 });
  }
  const deduped = Array.from(byCore.values()).map((e) => ({
    q: e.count > 1 ? `${e.core} (×${e.count} Entscheidungen)` : e.core,
  }));

  // 2026-05-29 (Opus 4.8) — Owner-Befund: diese Selbst-Reflexionen des Systems
  // (Decision weicht von Belief ab / Decision ohne Begründung) wurden bis hier
  // als `<surface:open-questions>` ausgegeben → sie landeten in der
  // user-sichtbaren „Offene Fragen"-Pille und verlangten eine ANTWORT. Das ist
  // falsch (R3: prompts only for DECISIONS; R4: evidence ≠ decision): es sind
  // KEINE Entscheidungen, die der User treffen muss, sondern interne
  // Drift-/Begründungs-Reflexionen der WARUM-Engine. Sie gehören in den
  // Counter-Evidence-Kanal (E4 Devil's-Advocate, R5: visuell getrennt, kein
  // Antwort-Zwang) — die eigentliche Lern-Wirkung (Drift-Beliefs) schreibt
  // reconcile ohnehin bereits in den Trace. Hier nur noch sichtbar machen.
  const text = deduped.map((q) => `• ${q.q}`).join('\n');
  const json = JSON.stringify({
    text,
    verdict: 'falsifiable',
    counterEvidenceCount: deduped.length,
  });
  return `<surface:counter-evidence>${json}</surface:counter-evidence>`;
}

// ---------------------------------------------------------------------------
// A5 — reconcileWorkstream
// ---------------------------------------------------------------------------

export interface ReconcileArgs {
  readonly workspaceId: string;
  readonly workstreamId: string;
  /** ManifestCoord-Key (N9), Format `<workspaceId>/<workstreamId>`. */
  readonly coordKey: string;
  /** Finale Step-Status-Map des Runs (pending/active/done/failed). */
  readonly stepStatuses: Record<string, string>;
}

export interface ReconcileResult {
  /** Wurde der Run bereits zuvor reconciled? Dann No-Op (alle Felder „leer"). */
  readonly alreadyReconciled: boolean;
  /** Bestimmtes Gesamt-Outcome (auch bei alreadyReconciled: das frische Urteil). */
  readonly outcome: OutcomeKind;
  /** Anzahl geschriebener Belief-Updates (supersede, Drift-Zweig). */
  readonly beliefUpdates: number;
  /** P0.1: Anzahl NEU geschriebener Outcome-Lehr-Beliefs (failure/partial). */
  readonly outcomeLessons: number;
  /** P0.2: Anzahl geschriebener Reflexions-Meta-Beliefs (≥ Schwelle). */
  readonly reflections: number;
  /** P1.1: Anzahl durch Erfolg verstärkter Beliefs (reinforce/supersede). */
  readonly reinforcements: number;
  /** Erkannte Drifts (Decision ↔ Belief). */
  readonly drifts: readonly BeliefDrift[];
  /** Decisions ohne erkennbare Begründung. */
  readonly unjustified: readonly DecisionRow[];
  /**
   * Optionaler WARUM-Frage-Text im pill-lesbaren Format (oder null). Der Caller
   * hängt ihn an die Abschluss-Card an — er blockiert NIE.
   */
  readonly whyQuestion: string | null;
}

const EMPTY_RESULT = (outcome: OutcomeKind): ReconcileResult => ({
  alreadyReconciled: true,
  outcome,
  beliefUpdates: 0,
  outcomeLessons: 0,
  reflections: 0,
  reinforcements: 0,
  drifts: [],
  unjustified: [],
  whyQuestion: null,
});

/**
 * Der Post-Prozess-IST/SOLL-Abgleich nach Workstream-Abschluss (A5 + A4).
 *
 * Ablauf:
 *  1. Idempotenz-Guard: existiert bereits ein Workstream-Outcome mit dem
 *     Reconcile-Marker → No-Op (verhindert Doppel-Schreiben bei Re-Trigger).
 *  2. Gesamt-Outcome bestimmen (determineOutcome) + recordOutcome (workstream-
 *     weit, mit Marker im note für Idempotenz).
 *  3. Decisions des Runs lesen (listDecisions, coordKey-scoped) → Drift gegen
 *     aktive Beliefs (detectBeliefDrift). Pro Drift ein BEGRÜNDETER Belief-
 *     Update via upsertBelief(supersedesId) — die alte Belief bleibt Historie.
 *  4. A4: begründungslose + abweichende Decisions → optionale WARUM-Frage
 *     (buildWhyQuestion). Nur erzeugen, NICHT blockieren.
 *
 * Wirft NICHT bei „nichts zu tun" (leere Steps → outcome 'unknown', schreibt
 * trotzdem die Marker-Row, damit der Run als reconciled gilt). Der Caller ruft
 * das fail-soft (try/catch) — ein Fehler hier darf den Run-Abschluss NIE kippen.
 */
export function reconcileWorkstream(
  raw: RawDb,
  args: ReconcileArgs,
): ReconcileResult {
  if (typeof args.workspaceId !== "string" || args.workspaceId.length === 0) {
    throw new Error("reconcileWorkstream: workspaceId required");
  }
  if (typeof args.workstreamId !== "string" || args.workstreamId.length === 0) {
    throw new Error("reconcileWorkstream: workstreamId required");
  }

  const outcome = determineOutcome(args.stepStatuses);
  const marker = reconcileMarker(args.workstreamId);

  // 1. Idempotenz-Guard — bereits reconciled?
  const prior = listOutcomes(raw, {
    workspaceId: args.workspaceId,
    workstreamId: args.workstreamId,
  });
  if (prior.some((o) => typeof o.note === "string" && o.note.includes(marker))) {
    return EMPTY_RESULT(outcome);
  }

  // 2. Gesamt-Outcome festhalten (workstream-weit). Marker im note für Idempotenz;
  //    danach folgt das menschenlesbare IST/SOLL-Urteil (N1 verbatim Detail).
  const doneCount = Object.values(args.stepStatuses).filter(
    (v) => v === "done",
  ).length;
  const totalCount = Object.keys(args.stepStatuses).length;
  recordOutcome(raw, {
    workspaceId: args.workspaceId,
    workstreamId: args.workstreamId,
    outcome,
    note:
      `${marker} IST/SOLL-Abgleich: outcome=${outcome} ` +
      `(${doneCount}/${totalCount} Steps done). ` +
      `Erwartung (SOLL) = die Decision-rationales dieses Runs; ` +
      `Ergebnis (IST) = finale Step-Status.`,
  });

  // 3. Drift Decision ↔ aktive Belief → begründeter Belief-Update.
  const decisions = listDecisions(raw, {
    workspaceId: args.workspaceId,
    coordKey: args.coordKey,
  });
  const drifts = detectBeliefDrift(raw, args.workspaceId, decisions);

  let beliefUpdates = 0;
  for (const drift of drifts) {
    // Begründeter Lern-Eintrag: die NEUE Überzeugung übernimmt verbatim das, was
    // der Run tatsächlich entschieden hat; das WARUM (rationale) zitiert die
    // Decision-rationale VERBATIM (N1) + den Outcome-Kontext. supersedesId hält
    // die alte Belief als Historie (nie vergessen).
    upsertBelief(raw, {
      workspaceId: args.workspaceId,
      topic: drift.topic,
      belief:
        `Run ${args.workstreamId} entschied (${drift.decision.decisionKind}) ` +
        `abweichend von „${drift.priorBelief.belief}".`,
      rationale:
        `Post-Prozess-Drift (outcome=${outcome}). ` +
        `Entscheidungs-WARUM (verbatim): ${drift.decision.rationale} ` +
        `| Abgelöste Überzeugung: ${drift.priorBelief.belief} ` +
        `(deren WARUM: ${drift.priorBelief.rationale})`,
      source: "ai",
      supersedesId: drift.priorBelief.id,
    });
    beliefUpdates += 1;
  }

  // 3b. P0.1 — Outcome-getriebenes Lernen (ReasoningBank-Kernidee): bei
  //     failure/partial eine VERALLGEMEINERTE Lehr-Belief schreiben, AUCH ohne
  //     vorbestehende Belief (schließt die PA-Chat-heygen-Lücke). Deterministisch,
  //     idempotent pro Run (teachMarker im belief-Text).
  const outcomeLessons = learnFromOutcome(
    raw,
    args.workspaceId,
    args.workstreamId,
    outcome,
    decisions,
    args.stepStatuses,
  );

  // 3c. P0.2 — Reflexion bei WIEDERHOLTEN Fehlern: pro betroffenem topic prüfen,
  //     ob ≥ Schwelle gleichartige Fehler-Signale vorliegen → Meta-Reflexions-
  //     Belief mit hoher confidence. Nur bei failure/partial relevant; bei success
  //     wird hier nichts neu gezählt. Fail-soft je topic.
  let reflections = 0;
  if (outcome === "failure" || outcome === "partial") {
    const reflectedTopics = new Set<string>();
    for (const t of deriveTeachTopics(decisions, args.stepStatuses)) {
      if (reflectedTopics.has(t.topic)) continue;
      reflectedTopics.add(t.topic);
      try {
        if (reflectOnRepeatedFailures(raw, args.workspaceId, t.topic)) {
          reflections += 1;
        }
      } catch {
        // fail-soft: Reflexion darf den Reconcile nie kippen.
      }
    }
  }

  // 3d. P1.1 — Erfolg verstärkt: bei outcome 'success' jede Decision, deren
  //     rationale eine AKTIVE Belief BESTÄTIGT (Belief-Text als Substring der
  //     rationale enthalten = das Gegenteil von decisionContradictsBelief),
  //     deren confidence anheben (reinforceBelief → supersede, Historie bleibt).
  //     Pro (beliefId) nur EINMAL verstärken, auch wenn mehrere Decisions passen.
  let reinforcements = 0;
  if (outcome === "success") {
    const reinforced = new Set<string>();
    for (const d of decisions) {
      const topic = topicForDecision(d);
      const beliefs = recallRelevant(raw, args.workspaceId, topic);
      for (const b of beliefs) {
        // Bestätigung = NICHT-Widerspruch + nicht-leere Belief + noch nicht verstärkt
        // + keine system-generierte Lehr-/Reflexions-Meta-Belief (die verstärken wir
        // nicht über Decision-Match — sie haben keinen Decision-Bezug).
        if (reinforced.has(b.id)) continue;
        if (isTeachBelief(b) || b.belief.startsWith(REFLECTION_MARKER_PREFIX)) {
          continue;
        }
        if (decisionContradictsBelief(d, b)) continue; // widerspricht → kein Reinforce
        try {
          const r = reinforceBelief(raw, {
            workspaceId: args.workspaceId,
            beliefId: b.id,
            rationale:
              `Run ${args.workstreamId} bestätigte (${d.decisionKind}) ` +
              `die Überzeugung. Entscheidungs-WARUM (verbatim): ${d.rationale}`,
          });
          if (r) {
            reinforced.add(b.id);
            reinforcements += 1;
          }
        } catch {
          // fail-soft: Reinforcement darf den Reconcile nie kippen.
        }
      }
    }
  }

  // 4. A4 — optionale WARUM-Frage (begründungslos ODER abweichend).
  const unjustified = decisions.filter(isUnjustified);
  const whyQuestion = buildWhyQuestion({
    workstreamId: args.workstreamId,
    unjustified,
    drifts,
  });

  return {
    alreadyReconciled: false,
    outcome,
    beliefUpdates,
    outcomeLessons,
    reflections,
    reinforcements,
    drifts,
    unjustified,
    whyQuestion,
  };
}
