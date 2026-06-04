/**
 * Lane C — Role Reverse Engineering · DER KERN (reverseEngineerRoles)
 * ════════════════════════════════════════════════════════════════════════
 *
 * Phase 2 W2.3 · 2026-05-29 · Lanes-C/E/F-Engines.
 *
 * Master-Kontext §5 Lane C (verbatim, N1):
 *   „Ziel: Rollen nicht nur beschreiben, sondern auf Notwendigkeit,
 *    Entscheidungen und Automatisierbarkeit pruefen.
 *    Output: Role model · Decision map · Dependency map · Automation boundary ·
 *    kill / keep / augment criteria"
 * Master-Kontext §3 (verbatim, Autoritaets-Prinzip):
 *   „Bestehende Prozesse sind Evidenz, aber keine Autoritaet. Jede Rolle,
 *    Entscheidung und Tool-Abhaengigkeit wird reverse-engineered: behalten,
 *    automatisieren, augmentieren oder eliminieren."
 *
 * ── ARCHITEKTUR ───────────────────────────────────────────────────────────
 *
 *   rawText (Prozess-/Rollen-Beschreibung)
 *        │  (callEngine — injizierbar, Test stubt das LLM)
 *        ▼
 *   LLM liefert STRUKTURIERTES JSON
 *     ({ roles: [{ name, purpose, output, decisions[], dependencies[],
 *                  automationBoundary, classification }] })
 *        │  N6: deterministischer Parse + Validierung VOR Vertrauen.
 *        │      malformed → fail-soft (0 Rollen, kein Crash).
 *        ▼
 *   pro valider Rolle: bis zu 4 lane_artifacts-Rows:
 *     - role-model           (immer)
 *     - decision-map         (wenn decisions[] nicht leer)
 *     - dependency-map       (wenn dependencies[] nicht leer)
 *     - automation-boundary  (immer — traegt die kill/keep/augment-Klassifikation)
 *
 * ── DISZIPLIN ─────────────────────────────────────────────────────────────
 *   - N1:  purpose / output / decisions / dependencies / automationBoundary
 *          werden VERBATIM uebernommen (kein .slice). Der Prompt instruiert
 *          das LLM, den Owner-Wortlaut zu zitieren.
 *   - N6:  Deterministischer Parse + Schema-Validierung VOR LLM-Vertrauen.
 *          Unbekannte classification / leerer name → fail-soft.
 *   - N8:  append-only (0122-Trigger). Insert-only.
 *   - N9:  workspace_id-Scope auf jeder Row.
 *   - N10: content_hash pro Row (via insertLaneArtifact).
 */

import {
  insertLaneArtifact,
  type LaneArtifact,
} from "../lane-artifacts-repo";

type RawDb = import("better-sqlite3").Database;

// ───────────────────────────────────────────────────────────────────────────
// kill / keep / augment — die §5-Klassifikation
// ───────────────────────────────────────────────────────────────────────────

export type RoleClassification = "kill" | "keep" | "augment" | "automate";

export const ROLE_CLASSIFICATIONS: readonly RoleClassification[] = [
  "kill",
  "keep",
  "augment",
  "automate",
] as const;

const CLASS_SET = new Set<string>(ROLE_CLASSIFICATIONS);

// ───────────────────────────────────────────────────────────────────────────
// callEngine — injizierbarer LLM-Aufruf (Test stubt das)
// ───────────────────────────────────────────────────────────────────────────

export type CallEngineFn = (args: {
  system: string;
  user: string;
}) => Promise<string>;

// ───────────────────────────────────────────────────────────────────────────
// Result-Typen
// ───────────────────────────────────────────────────────────────────────────

export interface ReverseEngineerResult {
  /** Alle persistierten Artefakt-Rows (role-model/decision-map/dependency-map/automation-boundary). */
  readonly artifacts: readonly LaneArtifact[];
  /** Anzahl der vom LLM gelieferten, aber VERWORFENEN Roh-Rollen (N6 fail-soft). */
  readonly rejectedCount: number;
  /** Anzahl der erfolgreich verarbeiteten Rollen. */
  readonly roleCount: number;
}

// ───────────────────────────────────────────────────────────────────────────
// Prompt-Bau (§5 — Reverse-Engineering der Rollen)
// ───────────────────────────────────────────────────────────────────────────

export function buildRoleSystemPrompt(): string {
  return [
    "Du bist der Role-Reverse-Engineering-Analyst von laz.ing (Discovery Lane C).",
    "Aus einer Prozess-/Rollen-Beschreibung extrahierst du JEDE Rolle und",
    "pruefst sie auf Notwendigkeit, Entscheidungen, Abhaengigkeiten und",
    "Automatisierbarkeit. Bestehende Rollen sind EVIDENZ, nicht Autoritaet —",
    "du klassifizierst jede Rolle als kill | keep | augment | automate.",
    "",
    "REGELN (nicht verhandelbar):",
    "1. VERBATIM (N1): Uebernimm den Owner-Wortlaut WOERTLICH in 'purpose',",
    "   'output', 'decisions', 'dependencies', 'automationBoundary'. Kuerze",
    "   NICHT, paraphrasiere NICHT, fasse NICHT zusammen.",
    "2. Erfinde NICHTS. Extrahiere nur Rollen, die im Input tatsaechlich",
    "   vorkommen.",
    "3. 'decisions' = String-Array der Entscheidungen, die die Rolle trifft.",
    "4. 'dependencies' = String-Array der Handoffs/Abhaengigkeiten (X braucht",
    "   Y vorher) dieser Rolle.",
    "5. 'automationBoundary' = wo die menschliche Grenze liegt (was darf NIE",
    "   automatisiert werden — Consent, Trust, Experten-Korrektur, Live-Calls).",
    "6. 'classification' = genau eines von: kill | keep | augment | automate.",
    "7. 'rationale' = die Begruendung der Klassifikation (verbatim falls im Input).",
    "",
    "AUSGABE: NUR ein JSON-Objekt, KEIN Markdown drumherum:",
    '{ "roles": [ {',
    '    "name": <Rollen-Name>,',
    '    "purpose": <verbatim Zweck>,',
    '    "output": <verbatim Output|null>,',
    '    "decisions": [<verbatim>...],',
    '    "dependencies": [<verbatim>...],',
    '    "automationBoundary": <verbatim|null>,',
    '    "classification": <kill|keep|augment|automate>,',
    '    "rationale": <verbatim|null>',
    "} ] }",
  ].join("\n");
}

export function buildRoleUserPrompt(rawText: string): string {
  return [
    "Hier ist die Prozess-/Rollen-Beschreibung. Reverse-engineere die Rollen:",
    "",
    "----- INPUT (verbatim) -----",
    rawText, // N1: kein slice
    "----- ENDE INPUT -----",
  ].join("\n");
}

// ───────────────────────────────────────────────────────────────────────────
// Deterministischer Parser (N6 — VOR LLM-Vertrauen)
// ───────────────────────────────────────────────────────────────────────────

export interface ParsedRole {
  name: string;
  purpose: string;
  output: string | null;
  decisions: string[];
  dependencies: string[];
  automationBoundary: string | null;
  classification: RoleClassification;
  rationale: string | null;
}

export interface ParseRolesOutcome {
  readonly roles: readonly ParsedRole[];
  readonly rejectedCount: number;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.length > 0);
}

function asNullableString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Robuste JSON-Extraktion (LLM koennte Markdown-Fences / Vor-/Nachtext liefern).
 * Versucht (1) direktes JSON.parse, (2) ersten balancierten {...}-Block.
 * Schlaegt beides fehl → null (fail-soft, N6).
 */
export function extractJsonObject(text: string): unknown | null {
  if (typeof text !== "string" || text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    // weiter zu (2)
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
 * Deterministischer Parser (N6): valide Rolle gdw. name ist nicht-leerer String,
 * purpose ist nicht-leerer String, classification ∈ {kill,keep,augment,automate}.
 * Unbekannte classification → fallback 'keep' wird NICHT gemacht; die Rolle wird
 * verworfen (N6: kein Raten bei sicherheits-/governance-relevantem Feld).
 * Wirft NIE — malformed → { roles: [], rejectedCount }.
 */
export function parseRolesOutput(rawLlmText: string): ParseRolesOutcome {
  const obj = extractJsonObject(rawLlmText);
  if (!obj || typeof obj !== "object") {
    return { roles: [], rejectedCount: 0 };
  }
  const rolesRaw = (obj as Record<string, unknown>).roles;
  if (!Array.isArray(rolesRaw)) {
    return { roles: [], rejectedCount: 0 };
  }

  const roles: ParsedRole[] = [];
  let rejected = 0;

  for (const raw of rolesRaw) {
    if (!raw || typeof raw !== "object") {
      rejected++;
      continue;
    }
    const r = raw as Record<string, unknown>;
    const name = r.name;
    if (typeof name !== "string" || name.length === 0) {
      rejected++;
      continue;
    }
    const purpose = r.purpose;
    if (typeof purpose !== "string" || purpose.length === 0) {
      rejected++;
      continue;
    }
    const classification = r.classification;
    if (typeof classification !== "string" || !CLASS_SET.has(classification)) {
      rejected++;
      continue;
    }

    roles.push({
      name,
      purpose, // N1 verbatim
      output: asNullableString(r.output),
      decisions: asStringArray(r.decisions), // N1 verbatim
      dependencies: asStringArray(r.dependencies), // N1 verbatim
      automationBoundary: asNullableString(r.automationBoundary),
      classification: classification as RoleClassification,
      rationale: asNullableString(r.rationale),
    });
  }

  return { roles, rejectedCount: rejected };
}

// ───────────────────────────────────────────────────────────────────────────
// reverseEngineerRoles — DER KERN
// ───────────────────────────────────────────────────────────────────────────

export interface ReverseEngineerRolesArgs {
  readonly db: RawDb;
  /** Roh-Text der Prozess-/Rollen-Beschreibung. */
  readonly rawText: string;
  readonly workspaceId: string;
  /** Injizierter LLM-Aufruf (Test stubt). */
  readonly callEngine: CallEngineFn;
  readonly nowMs?: number;
}

/**
 * DER KERN: reverse-engineered aus einer Prozess-/Rollen-Beschreibung pro Rolle
 * bis zu 4 lane_artifacts-Rows (role-model + automation-boundary immer;
 * decision-map / dependency-map nur wenn nicht leer).
 *
 * Flow:
 *   1. callEngine(system, user) → roher LLM-Text.
 *   2. parseRolesOutput (N6, deterministisch) → valide Rollen (+ rejectedCount).
 *      Malformed / LLM-Crash → fail-soft (0 Artefakte, kein Crash).
 *   3. pro Rolle insertLaneArtifact(...) (idempotent, content_hash, append-only).
 *
 * Wirft NUR bei Bedienfehler (fehlender Workspace/rawText/callEngine).
 */
export async function reverseEngineerRoles(
  args: ReverseEngineerRolesArgs,
): Promise<ReverseEngineerResult> {
  const { db, workspaceId, callEngine } = args;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("reverseEngineerRoles: workspaceId required (N9)");
  }
  if (typeof args.rawText !== "string" || args.rawText.length === 0) {
    throw new Error("reverseEngineerRoles: rawText required");
  }
  if (typeof callEngine !== "function") {
    throw new Error("reverseEngineerRoles: callEngine fn required");
  }

  let llmText: string;
  try {
    llmText = await callEngine({
      system: buildRoleSystemPrompt(),
      user: buildRoleUserPrompt(args.rawText),
    });
  } catch {
    return { artifacts: [], rejectedCount: 0, roleCount: 0 }; // fail-soft (N6)
  }

  const parsed = parseRolesOutput(llmText);
  if (parsed.roles.length === 0) {
    return {
      artifacts: [],
      rejectedCount: parsed.rejectedCount,
      roleCount: 0,
    };
  }

  const artifacts: LaneArtifact[] = [];
  for (const role of parsed.roles) {
    // role-model (immer) — Zweck + Output + Notwendigkeit.
    artifacts.push(
      insertLaneArtifact(db, {
        workspaceId,
        kind: "role-model",
        content: role.purpose, // N1 verbatim
        source: {
          name: role.name,
          output: role.output,
          classification: role.classification,
          rationale: role.rationale,
        },
        nowMs: args.nowMs,
      }),
    );

    // decision-map (nur wenn Entscheidungen vorhanden).
    if (role.decisions.length > 0) {
      artifacts.push(
        insertLaneArtifact(db, {
          workspaceId,
          kind: "decision-map",
          content: role.decisions.join("\n"), // N1 verbatim je Zeile
          source: { name: role.name, decisions: role.decisions },
          nowMs: args.nowMs,
        }),
      );
    }

    // dependency-map (nur wenn Abhaengigkeiten vorhanden).
    if (role.dependencies.length > 0) {
      artifacts.push(
        insertLaneArtifact(db, {
          workspaceId,
          kind: "dependency-map",
          content: role.dependencies.join("\n"), // N1 verbatim je Zeile
          source: { name: role.name, dependencies: role.dependencies },
          nowMs: args.nowMs,
        }),
      );
    }

    // automation-boundary (immer) — traegt die kill/keep/augment-Klassifikation.
    artifacts.push(
      insertLaneArtifact(db, {
        workspaceId,
        kind: "automation-boundary",
        content:
          role.automationBoundary ??
          `classification=${role.classification}`, // N1 verbatim falls vorhanden
        source: {
          name: role.name,
          classification: role.classification,
          automationBoundary: role.automationBoundary,
          rationale: role.rationale,
        },
        nowMs: args.nowMs,
      }),
    );
  }

  return {
    artifacts,
    rejectedCount: parsed.rejectedCount,
    roleCount: parsed.roles.length,
  };
}
