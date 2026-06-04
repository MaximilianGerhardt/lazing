/**
 * Contrarian-Roast (Master-Briefing §10.2.7 + §10.4 „Roast Report").
 *
 * Mechanik §10.2.7 (verbatim): „Varianten roasten."
 * Swarm-Rolle §10.3 (verbatim): „Contrarian: Welche Annahmen sind falsch?"
 *
 * WARUM dieses Modul auf BESTEHENDEM Substrat aufsetzt (N4):
 *   Die counter-evidence-Surface existiert bereits — lib/reasoning/reconcile.ts
 *   `buildWhyQuestion` emittiert seit 2026-05-29 (Opus 4.8) Selbst-Reflexionen
 *   NICHT mehr als `<surface:open-questions>` (Antwort-Zwang, falsch), sondern
 *   als `<surface:counter-evidence>{ text, verdict, counterEvidenceCount }`
 *   (E4 Devil's-Advocate, R5: visuell getrennt, KEIN Antwort-Zwang,
 *   Anti-Echo-Chamber). Der Contrarian-Roast ist exakt derselbe Kanal: er
 *   attackiert einen Vorschlag und gibt EINE counter-evidence-Surface zurueck.
 *   Wir reimplementieren das Payload-Format NICHT neu — wir spiegeln das in
 *   reconcile.ts etablierte Shape (single source of shape: COUNTER_EVIDENCE_TAG
 *   + die drei Felder).
 *
 * Disziplin:
 *   - N1:  jedes Gegenargument VERBATIM aus der LLM-Antwort; der attackierte
 *          Vorschlag VERBATIM im source_json.
 *   - N4:  counter-evidence-Surface wiederverwendet (Format wie reconcile.ts).
 *   - N6:  deterministischer JSON-Parse — malformt → 0 Roasts, verdict='ok',
 *          KEINE Surface (fail-soft).
 *   - N9:  workspace_id-scoped.
 *   - N10: content_hash pro Row (Repo) — eine Roast-Row je Vorschlag.
 */

import { insertArtifact, type InnovationArtifact } from "./artifacts-repo";
import { parseStringList } from "./parse";

type RawDb = import("better-sqlite3").Database;

/**
 * Der Surface-Tag-Name. Bewusst identisch zu dem in lib/reasoning/reconcile.ts
 * verwendeten `<surface:counter-evidence>` (N4: ein Kanal, kein zweiter).
 */
export const COUNTER_EVIDENCE_TAG = "counter-evidence";

/**
 * Verdict-Vokabular der counter-evidence-Surface (spiegelt reconcile.ts:
 * dort 'falsifiable' wenn es Gegen-Evidenz gibt). 'ok' = nichts gefunden /
 * keine Surface.
 */
export type RoastVerdict = "ok" | "falsifiable";

/** Das parsbare Payload-Objekt der counter-evidence-Surface (Format wie reconcile.ts). */
export interface CounterEvidencePayload {
  /** Bullet-Liste der Gegenargumente (verbatim, je Zeile `• …`). */
  readonly text: string;
  readonly verdict: RoastVerdict;
  readonly counterEvidenceCount: number;
}

export interface ContrarianRoastArgs {
  readonly workspaceId: string;
  /** Der attackierte Vorschlag / die attackierte Variante (VERBATIM, N1). */
  readonly proposal: string;
  readonly callEngine: (prompt: string) => Promise<string>;
}

export interface ContrarianRoastResult {
  /** Die persistierte Roast-Row (oder null, wenn nichts gefunden). */
  readonly artifact: InnovationArtifact | null;
  /** Die parsbaren Gegenargumente (verbatim, in LLM-Reihenfolge). */
  readonly counters: readonly string[];
  /** Das counter-evidence-Surface-Payload (Format wie reconcile.ts). */
  readonly payload: CounterEvidencePayload;
  /**
   * Der serialisierte Surface-String:
   *   `<surface:counter-evidence>{json}</surface:counter-evidence>`
   * Identisches Format wie lib/reasoning/reconcile.ts. null, wenn keine
   * Gegen-Evidenz gefunden wurde (verdict='ok').
   */
  readonly surface: string | null;
}

/**
 * Baut den Contrarian-Roast-Prompt. REIN (testbar ohne LLM). Fordert ein
 * striktes JSON-Array von Gegenargumenten (N6) und uebergibt den Vorschlag
 * VERBATIM (N1).
 */
export function buildContrarianPrompt(proposal: string): string {
  return [
    "Du bist der Contrarian + Critic eines Innovation-Swarms (E4 Devil's-",
    "Advocate, Anti-Echo-Chamber). Aufgabe (Master-Briefing §10.2.7 + §10.3):",
    "ROASTE den folgenden Vorschlag. Welche Annahmen sind falsch? Wo ist der",
    "Bullshit? Was uebersieht er? Was ist Pseudo-Innovation? Liefere KONKRETE,",
    "falsifizierbare Gegenargumente — keine hoeflichen Relativierungen.",
    "",
    "Antworte AUSSCHLIESSLICH mit einem JSON-Array von Strings, je ein",
    "Gegenargument:",
    '  ["Gegenargument 1", "Gegenargument 2", ...]',
    "Findest du KEINEN ernsthaften Einwand, gib das leere Array [] zurueck.",
    "Kein Fliesstext, kein Markdown ausserhalb des Arrays.",
    "",
    "--- VORSCHLAG (verbatim) ---",
    proposal,
    "--- ENDE ---",
  ].join("\n");
}

/**
 * Serialisiert ein counter-evidence-Payload in den Surface-String — Format
 * 1:1 wie lib/reasoning/reconcile.ts (N4: kein zweites Format). REIN.
 */
export function renderCounterEvidenceSurface(
  payload: CounterEvidencePayload,
): string {
  return `<surface:${COUNTER_EVIDENCE_TAG}>${JSON.stringify(
    payload,
  )}</surface:${COUNTER_EVIDENCE_TAG}>`;
}

/**
 * Baut das counter-evidence-Payload aus einer Liste von Gegenargumenten. REIN.
 * Leere Liste → verdict='ok', text=''. Bei ≥1 Gegenargument → verdict=
 * 'falsifiable' (gleiches Vokabular wie reconcile.ts).
 */
export function buildCounterEvidencePayload(
  counters: readonly string[],
): CounterEvidencePayload {
  const text = counters.map((c) => `• ${c}`).join("\n");
  return {
    text,
    verdict: counters.length > 0 ? "falsifiable" : "ok",
    counterEvidenceCount: counters.length,
  };
}

/**
 * Generiert Gegenargumente zu `proposal`, gibt ein valides counter-evidence-
 * Payload zurueck und persistiert (bei ≥1 Gegenargument) EINE Roast-Row.
 *
 * Fail-soft (N6): wirft die callEngine ODER ist die Antwort malformt, gibt es
 * 0 Gegenargumente → verdict='ok', surface=null, artifact=null. Wirft NICHT.
 */
export async function contrarianRoast(
  raw: RawDb,
  args: ContrarianRoastArgs,
): Promise<ContrarianRoastResult> {
  if (typeof args.workspaceId !== "string" || args.workspaceId.length === 0) {
    throw new Error("contrarianRoast: workspaceId required (N9)");
  }

  const empty = (): ContrarianRoastResult => {
    const payload = buildCounterEvidencePayload([]);
    return { artifact: null, counters: [], payload, surface: null };
  };

  if (typeof args.proposal !== "string" || args.proposal.trim().length === 0) {
    return empty();
  }

  let reply = "";
  try {
    reply = await args.callEngine(buildContrarianPrompt(args.proposal));
  } catch {
    return empty(); // fail-soft (N6)
  }

  const counters = parseStringList(reply, ["counters", "objections"]);
  const payload = buildCounterEvidencePayload(counters);

  if (counters.length === 0) {
    return { artifact: null, counters, payload, surface: null };
  }

  // Eine Roast-Row je Vorschlag: content = die Gegenargumente VERBATIM (N1),
  // verkettet; source_json haelt den attackierten Vorschlag + verdict.
  const artifact = insertArtifact(raw, {
    workspaceId: args.workspaceId,
    kind: "contrarian-roast",
    content: counters.join("\n"), // N1: verbatim, kein .slice
    source: { proposal: args.proposal, verdict: payload.verdict },
  });

  return {
    artifact,
    counters,
    payload,
    surface: renderCounterEvidenceSurface(payload),
  };
}
