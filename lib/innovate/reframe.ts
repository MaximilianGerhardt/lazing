/**
 * Reframe-Set (Master-Briefing §10.2.4 + §10.4 „Reframe Set").
 *
 * Mechanik §10.2.4 (verbatim): „Annahmen umkehren."
 *
 * generateReframes nimmt die offengelegten Annahmen (aus extractAssumptions)
 * und erzeugt LLM-gestuetzt First-Principles-Reframes: jede Annahme wird
 * umgekehrt / radikal anders gedacht. Jeder Reframe wird als eigene Row
 * (kind='reframe') persistiert, mit Rueck-FK auf die Quell-Annahme
 * (source_json.fromAssumptionId).
 *
 * Disziplin:
 *   - N1:  Reframe-Text VERBATIM aus der LLM-Antwort.
 *   - N6:  deterministischer JSON-Parse — malformt → 0 Reframes (fail-soft).
 *   - N9:  workspace_id-scoped.
 *   - N10: content_hash pro Row (Repo).
 */

import {
  insertArtifact,
  type InnovationArtifact,
} from "./artifacts-repo";
import { parseStringList } from "./parse";

type RawDb = import("better-sqlite3").Database;

export interface GenerateReframesArgs {
  readonly workspaceId: string;
  /**
   * Die Quell-Annahmen (typischerweise das `assumptions`-Ergebnis von
   * extractAssumptions). Jede traegt `id` (Rueck-FK) + `content` (Annahme-Text).
   */
  readonly assumptions: readonly Pick<
    InnovationArtifact,
    "id" | "content"
  >[];
  readonly callEngine: (prompt: string) => Promise<string>;
}

export interface GenerateReframesResult {
  readonly reframes: readonly InnovationArtifact[];
  readonly count: number;
}

/**
 * Baut den Reframe-Prompt fuer EINE Annahme. REIN (testbar ohne LLM). Fordert
 * ein striktes JSON-Array von Strings (N6) und uebergibt die Annahme VERBATIM.
 */
export function buildReframePrompt(assumption: string): string {
  return [
    "Du bist der Contrarian + Systems-Architect eines Innovation-Swarms.",
    "Aufgabe (Master-Briefing §10.2.4): KEHRE die folgende Annahme UM bzw.",
    "denke sie von First Principles neu. Was waere, wenn das GEGENTEIL wahr",
    "waere? Welcher radikal andere Zielzustand wird denkbar? Gib 1-3 konkrete,",
    "praktikabel-klingende Reframes — keine Plattitueden.",
    "",
    "Antworte AUSSCHLIESSLICH mit einem JSON-Array von Strings:",
    '  ["Reframe 1", "Reframe 2", ...]',
    "Kein Fliesstext, kein Markdown ausserhalb des Arrays.",
    "",
    "--- ANNAHME (verbatim) ---",
    assumption,
    "--- ENDE ---",
  ].join("\n");
}

/**
 * Erzeugt Reframes je Annahme und persistiert jeden als eigene Row.
 *
 * Fail-soft je Annahme (N6): scheitert die callEngine fuer EINE Annahme oder
 * ist ihre Antwort malformt, werden fuer diese Annahme 0 Reframes erzeugt — die
 * uebrigen Annahmen werden trotzdem verarbeitet. Wirft NICHT.
 */
export async function generateReframes(
  raw: RawDb,
  args: GenerateReframesArgs,
): Promise<GenerateReframesResult> {
  if (typeof args.workspaceId !== "string" || args.workspaceId.length === 0) {
    throw new Error("generateReframes: workspaceId required (N9)");
  }

  const reframes: InnovationArtifact[] = [];

  for (const assumption of args.assumptions) {
    if (
      typeof assumption.content !== "string" ||
      assumption.content.trim().length === 0
    ) {
      continue;
    }

    let reply = "";
    try {
      reply = await args.callEngine(buildReframePrompt(assumption.content));
    } catch {
      continue; // fail-soft je Annahme (N6)
    }

    const texts = parseStringList(reply, ["reframes"]);
    for (const text of texts) {
      reframes.push(
        insertArtifact(raw, {
          workspaceId: args.workspaceId,
          kind: "reframe",
          content: text, // N1: verbatim
          source: { fromAssumptionId: assumption.id },
        }),
      );
    }
  }

  return { reframes, count: reframes.length };
}
