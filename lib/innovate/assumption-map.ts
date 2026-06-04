/**
 * Assumption-Map (Master-Briefing §10.2.3 + §10.4 „Assumption Map").
 *
 * Mechanik §10.2.3 (verbatim): „Annahmen offenlegen."
 *
 * extractAssumptions zerlegt einen Ist-Zustand / Plan-Text LLM-gestuetzt in
 * EXPLIZITE Annahmen. Jede Annahme wird als eigene Row (kind='assumption') in
 * innovation_artifacts persistiert.
 *
 * Disziplin:
 *   - N1:  jede Annahme wird VERBATIM aus der LLM-Antwort uebernommen (nur
 *          getrimmt, nicht gekuerzt) und verbatim persistiert.
 *   - N6:  deterministischer JSON-Parse (parseStringList) — malformte Antwort
 *          → 0 Rows, kein Crash (fail-soft).
 *   - N9:  workspace_id-scoped.
 *   - N10: content_hash pro Row (im Repo) — Idempotenz bei Re-Run.
 *
 * callEngine ist injizierbar (Test stubt das LLM). Konvention im Repo:
 *   `callEngine: (prompt: string) => Promise<string>`.
 */

import { createHash } from "node:crypto";

import {
  insertArtifact,
  type InnovationArtifact,
} from "./artifacts-repo";
import { parseStringList } from "./parse";

type RawDb = import("better-sqlite3").Database;

export interface ExtractAssumptionsArgs {
  readonly workspaceId: string;
  /** Der Ist-Zustand / Plan, dessen Annahmen offengelegt werden (VERBATIM, N1). */
  readonly rawText: string;
  /** Engine-Adapter (injizierbar; Test stubt das LLM). */
  readonly callEngine: (prompt: string) => Promise<string>;
}

export interface ExtractAssumptionsResult {
  /** Die persistierten Assumption-Rows (in LLM-Reihenfolge). */
  readonly assumptions: readonly InnovationArtifact[];
  /** Anzahl tatsaechlich extrahierter Annahmen (= assumptions.length). */
  readonly count: number;
}

/**
 * Baut den Annahme-Extraktions-Prompt. REIN (testbar ohne LLM). Fordert ein
 * STRIKTES JSON-Array von Strings (N6 deterministischer Parse-Vertrag) und
 * uebergibt den Ist-Zustand VERBATIM (N1).
 */
export function buildAssumptionPrompt(rawText: string): string {
  return [
    "Du bist der First-Principles-Analyst eines Innovation-Swarms.",
    "Aufgabe (Master-Briefing §10.2.3): lege die IMPLIZITEN ANNAHMEN offen,",
    "die dem folgenden Ist-Zustand / Plan zugrunde liegen. Eine Annahme ist",
    "etwas, das stillschweigend fuer wahr gehalten wird und das man umkehren",
    "koennte. Sei konkret, keine Plattitueden.",
    "",
    "Antworte AUSSCHLIESSLICH mit einem JSON-Array von Strings, je eine Annahme:",
    '  ["Annahme 1", "Annahme 2", ...]',
    "Kein Fliesstext, kein Markdown ausserhalb des Arrays.",
    "",
    "--- IST-ZUSTAND / PLAN (verbatim) ---",
    rawText,
    "--- ENDE ---",
  ].join("\n");
}

/**
 * Zerlegt `rawText` in explizite Annahmen und persistiert jede als eigene Row.
 *
 * Fail-soft (N6): wirft der callEngine ODER ist die Antwort malformt, werden 0
 * Annahmen extrahiert (count=0) statt einen Fehler zu werfen — der Innovation-
 * Run bleibt steuerbar. (Der Caller kann count===0 als „nichts gefunden"
 * behandeln.)
 */
export async function extractAssumptions(
  raw: RawDb,
  args: ExtractAssumptionsArgs,
): Promise<ExtractAssumptionsResult> {
  if (typeof args.workspaceId !== "string" || args.workspaceId.length === 0) {
    throw new Error("extractAssumptions: workspaceId required (N9)");
  }
  if (typeof args.rawText !== "string" || args.rawText.trim().length === 0) {
    return { assumptions: [], count: 0 };
  }

  let reply = "";
  try {
    reply = await args.callEngine(buildAssumptionPrompt(args.rawText));
  } catch {
    return { assumptions: [], count: 0 }; // fail-soft (N6)
  }

  const statements = parseStringList(reply, ["assumptions"]);
  const rawTextHash = hashText(args.rawText);

  const assumptions: InnovationArtifact[] = [];
  for (const statement of statements) {
    assumptions.push(
      insertArtifact(raw, {
        workspaceId: args.workspaceId,
        kind: "assumption",
        content: statement, // N1: verbatim
        source: { rawTextHash },
      }),
    );
  }

  return { assumptions, count: assumptions.length };
}

/** Stabiler Quell-Hash, damit alle Annahmen eines Ist-Zustands verkettbar sind. */
function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
