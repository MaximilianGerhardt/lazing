/**
 * Lane E — Toolstack Replacement · DER KERN (buildReplacementMatrix)
 * ════════════════════════════════════════════════════════════════════════
 *
 * Phase 2 W2.3 · 2026-05-29 · Lanes-C/E/F-Engines.
 *
 * Master-Kontext §5 Lane E (verbatim, N1):
 *   „Ziel: nicht ein Tool durch ein Tool ersetzen, sondern Prozess- und
 *    Domainvollstaendigkeit pruefen.
 *    Output: replace / integrate / eliminate matrix · minimum replacement
 *    scope · domain-depth requirements · integration boundaries ·
 *    migration/deployment gates"
 * Master-Kontext §3 (verbatim):
 *   „Tool-Replacement braucht Domainlogik, Entscheidungslogik und
 *    Automationsgrenzen."
 *
 * Anti-MVP reference (Demo PV eval, lib/eval/demo-pv/domain-model.ts):
 *   A tool replacement that defers domain depth (e.g. PV: stringing/
 *   inverter/storage) to later fails the gate. That is why every replacement
 *   row carries a `domainDepthFlag` (true = the tool covers domain depth that
 *   a generic replacement does NOT capture -> handle with care).
 *
 * ── ARCHITEKTUR ───────────────────────────────────────────────────────────
 *
 *   tools (Liste aktueller Tools + ihrer Rolle im Prozess)
 *        │  (callEngine — injizierbar, Test stubt das LLM)
 *        ▼
 *   LLM liefert STRUKTURIERTES JSON
 *     ({ matrix: [{ tool, decision, minimumReplacementScope,
 *                   domainDepthRequired, integrationBoundaries[], rationale }] })
 *        │  N6: deterministischer Parse + Validierung VOR Vertrauen.
 *        ▼
 *   pro valider Tool-Entscheidung: EINE lane_artifacts(kind='tool-replacement').
 *
 * ── DISZIPLIN ─────────────────────────────────────────────────────────────
 *   - N1:  minimumReplacementScope / integrationBoundaries / rationale verbatim.
 *   - N6:  deterministischer Parse; unbekannte decision / leeres tool → reject.
 *   - N8/N9/N10: via insertLaneArtifact.
 */

import {
  insertLaneArtifact,
  type LaneArtifact,
} from "../lane-artifacts-repo";

type RawDb = import("better-sqlite3").Database;

// ───────────────────────────────────────────────────────────────────────────
// replace / integrate / eliminate — die §5-Entscheidung
// ───────────────────────────────────────────────────────────────────────────

export type ToolDecision = "replace" | "integrate" | "eliminate";

export const TOOL_DECISIONS: readonly ToolDecision[] = [
  "replace",
  "integrate",
  "eliminate",
] as const;

const DECISION_SET = new Set<string>(TOOL_DECISIONS);

// ───────────────────────────────────────────────────────────────────────────
// callEngine — injizierbar
// ───────────────────────────────────────────────────────────────────────────

export type CallEngineFn = (args: {
  system: string;
  user: string;
}) => Promise<string>;

// ───────────────────────────────────────────────────────────────────────────
// Result
// ───────────────────────────────────────────────────────────────────────────

export interface ReplacementMatrixResult {
  readonly artifacts: readonly LaneArtifact[];
  readonly rejectedCount: number;
  readonly toolCount: number;
}

// ───────────────────────────────────────────────────────────────────────────
// Prompt
// ───────────────────────────────────────────────────────────────────────────

export function buildToolstackSystemPrompt(): string {
  return [
    "Du bist der Toolstack-Replacement-Analyst von laz.ing (Discovery Lane E).",
    "Du ersetzt NICHT ein Tool durch ein Tool, sondern pruefst Prozess- und",
    "Domain-Vollstaendigkeit. Pro Tool entscheidest du: replace | integrate |",
    "eliminate, und legst den minimalen Ersatz-Scope + die noetige Domain-Tiefe +",
    "die Integrations-Grenzen fest.",
    "",
    "REGELN (nicht verhandelbar):",
    "1. VERBATIM (N1): 'minimumReplacementScope', 'integrationBoundaries' und",
    "   'rationale' im Owner-Wortlaut. Kuerze NICHT, paraphrasiere NICHT.",
    "2. 'decision' = genau eines von: replace | integrate | eliminate.",
    "3. 'minimumReplacementScope' = was ein Ersatz MINDESTENS koennen muss,",
    "   damit der Prozess nicht abreisst (Anti-MVP).",
    "4. 'domainDepthRequired' = boolean. true, wenn das Tool fachliche Tiefe",
    "   abdeckt, die ein generischer Ersatz NICHT abbildet (z.B. PV-Stringing,",
    "   Wechselrichter-Auswahl, Speicher-Sizing). false sonst.",
    "5. 'integrationBoundaries' = String-Array der harten Schnittstellen-Grenzen.",
    "",
    "AUSGABE: NUR ein JSON-Objekt, KEIN Markdown:",
    '{ "matrix": [ {',
    '    "tool": <Tool-Name>,',
    '    "decision": <replace|integrate|eliminate>,',
    '    "minimumReplacementScope": <verbatim|null>,',
    '    "domainDepthRequired": <boolean>,',
    '    "integrationBoundaries": [<verbatim>...],',
    '    "rationale": <verbatim|null>',
    "} ] }",
  ].join("\n");
}

export function buildToolstackUserPrompt(tools: readonly string[]): string {
  const list = tools.map((t, i) => `${i + 1}. ${t}`).join("\n");
  return [
    "Hier sind die aktuellen Tools (je Tool: Name + Rolle im Prozess).",
    "Erstelle die replace/integrate/eliminate-Matrix:",
    "",
    "----- TOOLS (verbatim) -----",
    list,
    "----- ENDE TOOLS -----",
  ].join("\n");
}

// ───────────────────────────────────────────────────────────────────────────
// Deterministischer Parser (N6)
// ───────────────────────────────────────────────────────────────────────────

export interface ParsedToolEntry {
  tool: string;
  decision: ToolDecision;
  minimumReplacementScope: string | null;
  domainDepthRequired: boolean;
  integrationBoundaries: string[];
  rationale: string | null;
}

export interface ParseMatrixOutcome {
  readonly entries: readonly ParsedToolEntry[];
  readonly rejectedCount: number;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.length > 0);
}

function asNullableString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** N6: defensiver Boolean-Parse — nur echtes true gilt; alles andere false. */
function asBool(v: unknown): boolean {
  return v === true;
}

export function extractJsonObject(text: string): unknown | null {
  if (typeof text !== "string" || text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    // weiter
  }
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * Deterministischer Parser (N6): valide Entry gdw. tool ist nicht-leerer String
 * und decision ∈ {replace,integrate,eliminate}. Wirft NIE.
 */
export function parseMatrixOutput(rawLlmText: string): ParseMatrixOutcome {
  const obj = extractJsonObject(rawLlmText);
  if (!obj || typeof obj !== "object") {
    return { entries: [], rejectedCount: 0 };
  }
  const matrixRaw = (obj as Record<string, unknown>).matrix;
  if (!Array.isArray(matrixRaw)) {
    return { entries: [], rejectedCount: 0 };
  }

  const entries: ParsedToolEntry[] = [];
  let rejected = 0;

  for (const raw of matrixRaw) {
    if (!raw || typeof raw !== "object") {
      rejected++;
      continue;
    }
    const r = raw as Record<string, unknown>;
    const tool = r.tool;
    if (typeof tool !== "string" || tool.length === 0) {
      rejected++;
      continue;
    }
    const decision = r.decision;
    if (typeof decision !== "string" || !DECISION_SET.has(decision)) {
      rejected++;
      continue;
    }

    entries.push({
      tool,
      decision: decision as ToolDecision,
      minimumReplacementScope: asNullableString(r.minimumReplacementScope),
      domainDepthRequired: asBool(r.domainDepthRequired),
      integrationBoundaries: asStringArray(r.integrationBoundaries),
      rationale: asNullableString(r.rationale),
    });
  }

  return { entries, rejectedCount: rejected };
}

// ───────────────────────────────────────────────────────────────────────────
// buildReplacementMatrix — DER KERN
// ───────────────────────────────────────────────────────────────────────────

export interface BuildReplacementMatrixArgs {
  readonly db: RawDb;
  /** Aktuelle Tools (je Eintrag: Name + Rolle im Prozess, frei-text). */
  readonly tools: readonly string[];
  readonly workspaceId: string;
  readonly callEngine: CallEngineFn;
  readonly nowMs?: number;
}

/**
 * DER KERN: erzeugt pro Tool eine replace/integrate/eliminate-Entscheidung als
 * EINE lane_artifacts(kind='tool-replacement')-Row, inklusive
 * minimum-replacement-scope, domain-depth-Flag und Integrations-Grenzen.
 *
 * Flow:
 *   1. callEngine → roher LLM-Text.
 *   2. parseMatrixOutput (N6) → valide Entries (+ rejectedCount). Malformed /
 *      LLM-Crash → fail-soft (0 Artefakte).
 *   3. pro Entry insertLaneArtifact(...) (idempotent, content_hash, append-only).
 */
export async function buildReplacementMatrix(
  args: BuildReplacementMatrixArgs,
): Promise<ReplacementMatrixResult> {
  const { db, workspaceId, callEngine } = args;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("buildReplacementMatrix: workspaceId required (N9)");
  }
  if (!Array.isArray(args.tools) || args.tools.length === 0) {
    throw new Error("buildReplacementMatrix: non-empty tools[] required");
  }
  if (typeof callEngine !== "function") {
    throw new Error("buildReplacementMatrix: callEngine fn required");
  }

  // N6: nur nicht-leere Tool-Strings durchreichen (defensiv).
  const tools = args.tools.filter(
    (t): t is string => typeof t === "string" && t.length > 0,
  );
  if (tools.length === 0) {
    throw new Error("buildReplacementMatrix: tools[] had no valid entries");
  }

  let llmText: string;
  try {
    llmText = await callEngine({
      system: buildToolstackSystemPrompt(),
      user: buildToolstackUserPrompt(tools),
    });
  } catch {
    return { artifacts: [], rejectedCount: 0, toolCount: 0 }; // fail-soft (N6)
  }

  const parsed = parseMatrixOutput(llmText);
  if (parsed.entries.length === 0) {
    return {
      artifacts: [],
      rejectedCount: parsed.rejectedCount,
      toolCount: 0,
    };
  }

  const artifacts: LaneArtifact[] = [];
  for (const e of parsed.entries) {
    artifacts.push(
      insertLaneArtifact(db, {
        workspaceId,
        kind: "tool-replacement",
        content:
          e.minimumReplacementScope ??
          `${e.tool}: ${e.decision}`, // N1 verbatim falls vorhanden
        source: {
          tool: e.tool,
          decision: e.decision,
          minimumReplacementScope: e.minimumReplacementScope,
          domainDepthRequired: e.domainDepthRequired,
          integrationBoundaries: e.integrationBoundaries,
          rationale: e.rationale,
        },
        nowMs: args.nowMs,
      }),
    );
  }

  return {
    artifacts,
    rejectedCount: parsed.rejectedCount,
    toolCount: parsed.entries.length,
  };
}
