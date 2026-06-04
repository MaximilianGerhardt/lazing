/**
 * Lane B — Expertise Compiler · THE CORE (compileKnowledgeForms)
 * ════════════════════════════════════════════════════════════════════════
 *
 * Phase 2 W2.2 · 2026-05-29 · CORE remediation.
 *
 * Current/target finding (2 Opus analyses): the 0120 schema `knowledge_forms` + the
 * N4 seam `mirrorApprovedKnowledgeFormToBelief` were built — BUT the
 * eponymous CORE was missing: NO code ever produced a knowledge_forms row.
 * This file IS that core.
 *
 * Master-Briefing §8.1 (verbatim, N1):
 *   „Experte erklaert oder handelt, System extrahiert Begriffe, Regeln,
 *    Ausnahmen, Entscheidungen und Qualitaetskriterien."
 * Master-Briefing §8.2 (verbatim, N1) — the 12 knowledge forms:
 *   „Glossary Entry · Principle · If-Then Rule · Exception · Tactic ·
 *    Role Judgment · Handoff Dependency · Quality Criterion ·
 *    Simulation Case · Eval Question · SOP Step · Open Unknown."
 * Master-Briefing §8.3 review gate (owner directive):
 *   Lane-B outputs ALWAYS land with review_state='pending-review'; nothing
 *   becomes a belief without human review.
 *
 * ── ARCHITECTURE ───────────────────────────────────────────────────────────
 *
 *   rawText / intakeEventId
 *        │  (callEngine — injectable, the test stubs the LLM)
 *        ▼
 *   the LLM delivers STRUCTURED JSON ({ forms: [{kind, term?, statement, …}] })
 *        │  N6: deterministic parse + validation BEFORE trust.
 *        │      malformed → fail-soft (0 forms, no crash).
 *        ▼
 *   per valid form: insertKnowledgeForm(...) → ONE knowledge_forms row,
 *        review_state='pending-review' (§8 gate), content_hash (N10),
 *        source_json with intakeEventId provenance.
 *        ▼
 *   (owner approves manually) → mirrorApprovedKnowledgeFormToBelief (N4 seam,
 *        NOT here; existing module).
 *
 * ── DISCIPLINE ─────────────────────────────────────────────────────────────
 *   - N1:  statement / rationale / term / example_cases / counter_cases are
 *          taken VERBATIM from the LLM JSON (no .slice/.substring). The
 *          prompt explicitly instructs the LLM to quote the owner's wording.
 *   - N4:  NO second belief writer. The output flows into the existing
 *          mirrorApprovedKnowledgeFormToBelief. This file writes ONLY
 *          knowledge_forms.
 *   - N6:  deterministic parse + schema validation BEFORE trusting the LLM.
 *          Unknown kind / empty statement / broken JSON → fail-soft.
 *   - N8:  append-only-compliant (0120 trigger). Insert-only; no UPDATE/DELETE.
 *   - N9:  workspace_id scope on every row.
 *   - N10: content_hash (sha256 over canonical JSON) per row.
 *
 * Pure module with an injected LLM function: `callEngine` is the only
 * side-effect path. Tests stub it. No getDb() singleton — raw
 * better-sqlite3 handle (analogous to beliefs-repo.ts / mirror-to-beliefs.ts).
 */

import { createHash } from "node:crypto";

import { ulid } from "@/lib/ulid";

type RawDb = import("better-sqlite3").Database;

// ───────────────────────────────────────────────────────────────────────────
// The 12 knowledge forms (§8.2) — single source of truth for the CHECK + parse
// ───────────────────────────────────────────────────────────────────────────

export type KnowledgeFormKind =
  | "glossary"
  | "principle"
  | "if-then-rule"
  | "exception"
  | "tactic"
  | "role-judgment"
  | "handoff-dependency"
  | "quality-criterion"
  | "simulation-case"
  | "eval-question"
  | "sop-step"
  | "open-unknown";

export const KNOWLEDGE_FORM_KINDS: readonly KnowledgeFormKind[] = [
  "glossary",
  "principle",
  "if-then-rule",
  "exception",
  "tactic",
  "role-judgment",
  "handoff-dependency",
  "quality-criterion",
  "simulation-case",
  "eval-question",
  "sop-step",
  "open-unknown",
] as const;

const KIND_SET = new Set<string>(KNOWLEDGE_FORM_KINDS);

/**
 * Short definition per form (verbatim from the §8.2 spirit), passed along in
 * the LLM prompt as the extraction schema. Deliberately terse + DE+EN-capable.
 */
export const KNOWLEDGE_FORM_GUIDE: Readonly<Record<KnowledgeFormKind, string>> =
  Object.freeze({
    glossary:
      "Begriffsdefinition. 'term' = der Fachbegriff, 'statement' = was er bedeutet.",
    principle:
      "Ein generelles Leitprinzip/Grundsatz, der im Fach immer gilt.",
    "if-then-rule":
      "Eine WENN-DANN-Regel (Bedingung → Konsequenz/Handlung).",
    exception:
      "Eine Ausnahme von einer Regel/einem Prinzip (wann es NICHT gilt).",
    tactic: "Eine konkrete Taktik/Vorgehensweise, um ein Ziel zu erreichen.",
    "role-judgment":
      "Ein rollen-/personen-spezifisches Urteil (wer entscheidet was, wie tickt eine Rolle).",
    "handoff-dependency":
      "Eine Abhaengigkeit/Uebergabe zwischen Schritten oder Personen (X braucht Y vorher).",
    "quality-criterion":
      "Ein Qualitaetskriterium / eine Definition-of-Done / ein Akzeptanz-Standard.",
    "simulation-case":
      "Ein durchgespieltes Szenario/Fallbeispiel zum Lernen oder Testen.",
    "eval-question":
      "Eine pruefende Frage, mit der man die Korrektheit eines Outputs evaluieren kann.",
    "sop-step":
      "Ein einzelner Schritt einer Standard-Operating-Procedure (Prozess-Schritt).",
    "open-unknown":
      "Eine offene Unbekannte / ungeklaerte Frage, die noch Recherche/Owner-Input braucht.",
  });

// ───────────────────────────────────────────────────────────────────────────
// Result types
// ───────────────────────────────────────────────────────────────────────────

/** An extracted (and persisted) knowledge form. */
export interface CompiledKnowledgeForm {
  readonly id: string;
  readonly workspaceId: string;
  readonly kind: KnowledgeFormKind;
  readonly term: string | null;
  readonly statement: string;
  readonly rationale: string | null;
  readonly exampleCases: readonly string[];
  readonly counterCases: readonly string[];
  readonly domain: string | null;
  readonly confidence: number | null;
  readonly reviewState: "pending-review";
  readonly contentHash: string;
}

export interface CompileResult {
  /** The persisted forms — ALL with review_state='pending-review' (§8 gate). */
  readonly forms: readonly CompiledKnowledgeForm[];
  /**
   * Number of raw forms delivered by the LLM but DISCARDED (N6: malformed/
   * unknown kind/empty statement). >0 is not an error — fail-soft.
   */
  readonly rejectedCount: number;
  /** Provenance: the intake_events row that was compiled from (or null for rawText). */
  readonly intakeEventId: string | null;
}

// ───────────────────────────────────────────────────────────────────────────
// callEngine — injectable LLM call (the test stubs it)
// ───────────────────────────────────────────────────────────────────────────

/**
 * The only LLM side-effect path. In production it is fulfilled by a thin
 * adapter function that uses `detectEngines()/pickEngine()` (lib/llm/engines/
 * selector.ts) and calls `engine.chat({ messages })`; in the test a
 * stub is passed that returns a fixed JSON.
 *
 * Contract: takes system + user prompt, returns the RAW text of the LLM
 * response (expects JSON in it; the parser is defensive).
 */
export type CallEngineFn = (args: {
  system: string;
  user: string;
}) => Promise<string>;

// ───────────────────────────────────────────────────────────────────────────
// Prompt construction (§8 — structured extraction of the 12 forms)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Builds the system prompt. It (a) explains the 12 forms, (b) enforces
 * VERBATIM quotes of the owner's wording (N1), (c) enforces a strict JSON schema.
 */
export function buildCompileSystemPrompt(): string {
  const kindLines = KNOWLEDGE_FORM_KINDS.map(
    (k) => `  - "${k}": ${KNOWLEDGE_FORM_GUIDE[k]}`,
  ).join("\n");

  return [
    "Du bist der Expertise-Compiler von laz.ing. Aus einem Owner-/Experten-Input",
    "extrahierst du strukturiertes, typisiertes Fachwissen in genau diese 12",
    "Wissensformen (kind):",
    kindLines,
    "",
    "REGELN (nicht verhandelbar):",
    "1. VERBATIM (N1): Übernimm den Wortlaut des Owners WÖRTLICH in 'statement'",
    "   und (falls vorhanden) 'rationale'. Kürze NICHT, paraphrasiere NICHT,",
    "   fasse NICHT zusammen. Wenn der Owner einen Satz sagt, steht dieser Satz",
    "   wörtlich im statement.",
    "2. Erfinde NICHTS. Extrahiere nur, was im Input tatsächlich steht. Wenn der",
    "   Input nur einen Begriff erklärt, liefere nur diese eine glossary-Form.",
    "3. 'term' NUR bei kind='glossary' (der definierte Fachbegriff), sonst null.",
    "4. 'example_cases' / 'counter_cases' sind String-Arrays mit verbatim Zitaten",
    "   (illustrative Fälle bzw. Ausnahmen/Gegenbeispiele). Leer = [].",
    "5. 'domain' = die Fach-Domäne als kurzer slug, z.B. 'pv-planning', 'crm'.",
    "6. 'confidence' = 0..1, wie sicher die Extraktion ist.",
    "",
    "AUSGABE: NUR ein JSON-Objekt, KEIN Markdown, KEIN Fließtext drumherum:",
    '{ "forms": [ {',
    '    "kind": <eine der 12>,',
    '    "term": <string|null>,',
    '    "statement": <verbatim Owner-Wortlaut>,',
    '    "rationale": <verbatim Begründung|null>,',
    '    "example_cases": [<verbatim>...],',
    '    "counter_cases": [<verbatim>...],',
    '    "domain": <slug|null>,',
    '    "confidence": <0..1|null>',
    "} ] }",
  ].join("\n");
}

/** Builds the user prompt — the verbatim input. NO slice (N1). */
export function buildCompileUserPrompt(rawText: string): string {
  return [
    "Hier ist der Owner-/Experten-Input. Extrahiere die Wissensformen daraus:",
    "",
    "----- INPUT (verbatim) -----",
    rawText, // N1: no slice
    "----- ENDE INPUT -----",
  ].join("\n");
}

// ───────────────────────────────────────────────────────────────────────────
// Deterministic parser (N6 — BEFORE trusting the LLM)
// ───────────────────────────────────────────────────────────────────────────

/** A validated raw form, ready for insert. */
interface ParsedForm {
  kind: KnowledgeFormKind;
  term: string | null;
  statement: string;
  rationale: string | null;
  exampleCases: string[];
  counterCases: string[];
  domain: string | null;
  confidence: number | null;
}

export interface ParseOutcome {
  readonly forms: readonly ParsedForm[];
  readonly rejectedCount: number;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  // N1: take every element verbatim (no slice/trim loss); only
  // non-strings are discarded.
  return v.filter((x): x is string => typeof x === "string");
}

function asNullableString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function asNullableConfidence(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  if (v < 0 || v > 1) return null; // 0120 CHECK enforces [0,1]; out-of-range → null
  return v;
}

/**
 * Robust JSON extraction: the LLM might deliver markdown fences or pre-/post-text.
 * We try (1) direct JSON.parse, (2) the first balanced
 * {...} block. If both fail → null (fail-soft, N6).
 */
function extractJsonObject(text: string): unknown | null {
  if (typeof text !== "string" || text.length === 0) return null;
  // (1) direct.
  try {
    return JSON.parse(text);
  } catch {
    // continue to (2)
  }
  // (2) first balanced top-level {...} block.
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
        const candidate = text.slice(start, i + 1);
        try {
          return JSON.parse(candidate);
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * Deterministic parser (N6): takes the raw LLM text, validates it against
 * the knowledge_forms schema and returns only the VALID forms. NEVER throws —
 * malformed output → { forms: [], rejectedCount: <#raw> } (fail-soft).
 *
 * A raw form is valid iff:
 *   - kind ∈ the 12 (otherwise discarded),
 *   - statement is a non-empty string (N1 — we do not persist an empty
 *     statement),
 *   - (all other fields are defensively normalized).
 */
export function parseCompilerOutput(rawLlmText: string): ParseOutcome {
  const obj = extractJsonObject(rawLlmText);
  if (!obj || typeof obj !== "object") {
    return { forms: [], rejectedCount: 0 };
  }
  const formsRaw = (obj as Record<string, unknown>).forms;
  if (!Array.isArray(formsRaw)) {
    return { forms: [], rejectedCount: 0 };
  }

  const forms: ParsedForm[] = [];
  let rejected = 0;

  for (const raw of formsRaw) {
    if (!raw || typeof raw !== "object") {
      rejected++;
      continue;
    }
    const r = raw as Record<string, unknown>;
    const kind = r.kind;
    if (typeof kind !== "string" || !KIND_SET.has(kind)) {
      rejected++;
      continue;
    }
    const statement = r.statement;
    if (typeof statement !== "string" || statement.length === 0) {
      rejected++;
      continue;
    }

    // glossary expects term; if it is empty, it stays null (no reject —
    // the code layer may tolerate a term-less glossary, the UI marks it).
    const term =
      kind === "glossary" ? asNullableString(r.term) : asNullableString(r.term);

    forms.push({
      kind: kind as KnowledgeFormKind,
      term: kind === "glossary" ? term : null, // term ONLY for glossary (schema discipline)
      statement, // N1: verbatim
      rationale: asNullableString(r.rationale), // N1: verbatim
      exampleCases: asStringArray(r.example_cases), // N1: verbatim
      counterCases: asStringArray(r.counter_cases), // N1: verbatim
      domain: asNullableString(r.domain),
      confidence: asNullableConfidence(r.confidence),
    });
  }

  return { forms, rejectedCount: rejected };
}

// ───────────────────────────────────────────────────────────────────────────
// insertKnowledgeForm — the knowledge_forms writer (N10 + provenance)
// ───────────────────────────────────────────────────────────────────────────

export interface InsertKnowledgeFormInput {
  readonly workspaceId: string;
  readonly kind: KnowledgeFormKind;
  readonly term?: string | null;
  readonly statement: string;
  readonly rationale?: string | null;
  readonly exampleCases?: readonly string[];
  readonly counterCases?: readonly string[];
  readonly domain?: string | null;
  readonly confidence?: number | null;
  /** Provenance (§7.3 Lane-A source 0119). */
  readonly intakeEventId?: string | null;
  /** Provenance: owner chat-turn source. */
  readonly userInputTurnId?: string | null;
  readonly nowMs?: number;
}

/**
 * Writes ONE knowledge_forms row (0120) with review_state='pending-review'
 * (§8 gate — the compiler NEVER produces approved). content_hash (N10) covers
 * the core identity; source_json carries the provenance (intakeEventId /
 * userInputTurnId), to which mirrorApprovedKnowledgeFormToBelief later appends
 * the beliefId (N4 back-FK).
 */
export function insertKnowledgeForm(
  raw: RawDb,
  input: InsertKnowledgeFormInput,
): CompiledKnowledgeForm {
  if (typeof input.workspaceId !== "string" || input.workspaceId.length === 0) {
    throw new Error("insertKnowledgeForm: workspaceId required (N9)");
  }
  if (typeof input.kind !== "string" || !KIND_SET.has(input.kind)) {
    throw new Error(`insertKnowledgeForm: invalid kind '${String(input.kind)}'`);
  }
  if (typeof input.statement !== "string" || input.statement.length === 0) {
    throw new Error("insertKnowledgeForm: statement required (N1 verbatim)");
  }

  const term = input.kind === "glossary" ? input.term ?? null : null;
  const rationale = input.rationale ?? null;
  const exampleCases = input.exampleCases ? [...input.exampleCases] : [];
  const counterCases = input.counterCases ? [...input.counterCases] : [];
  const domain = input.domain ?? null;
  const confidence = asNullableConfidence(input.confidence);

  // source_json — provenance. Only set fields, so that the back-FK (beliefId)
  // can be cleanly added later.
  const source: Record<string, unknown> = {};
  if (input.intakeEventId) source.intakeEventId = input.intakeEventId;
  if (input.userInputTurnId) source.userInputTurnId = input.userInputTurnId;
  const sourceJson = JSON.stringify(source);

  const id = `KFM-${ulid()}`;
  const ts = Number.isFinite(input.nowMs) ? (input.nowMs as number) : Date.now();

  // N10: content_hash over canonical JSON of the core identity (deterministic,
  // keys alphabetical). example/counter are co-hashed (tamper evidence on
  // the full knowledge content).
  const contentHash = sha256hex({
    confidence,
    counter_cases: counterCases,
    domain,
    example_cases: exampleCases,
    kind: input.kind,
    rationale,
    statement: input.statement,
    term,
    workspace_id: input.workspaceId,
  });

  raw
    .prepare(
      `INSERT INTO knowledge_forms
         (id, workspace_id, kind, term, statement, rationale,
          example_cases_json, counter_cases_json, domain, source_json,
          confidence, review_state, supersedes_id, content_hash,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending-review', NULL, ?, ?, ?)`,
    )
    .run(
      id,
      input.workspaceId,
      input.kind,
      term,
      input.statement,
      rationale,
      exampleCases.length > 0 ? JSON.stringify(exampleCases) : null,
      counterCases.length > 0 ? JSON.stringify(counterCases) : null,
      domain,
      sourceJson,
      confidence,
      contentHash,
      ts,
      ts,
    );

  return {
    id,
    workspaceId: input.workspaceId,
    kind: input.kind,
    term,
    statement: input.statement,
    rationale,
    exampleCases,
    counterCases,
    domain,
    confidence,
    reviewState: "pending-review",
    contentHash,
  };
}

/** N10: sha256 hex over canonical JSON (keys sorted alphabetically). */
function sha256hex(payload: Record<string, unknown>): string {
  const keys = Object.keys(payload).sort();
  const canonical: Record<string, unknown> = {};
  for (const k of keys) canonical[k] = payload[k];
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

// ───────────────────────────────────────────────────────────────────────────
// compileKnowledgeForms — THE CORE
// ───────────────────────────────────────────────────────────────────────────

export interface CompileKnowledgeFormsArgs {
  readonly db: RawDb;
  /** EITHER an existing intake_events row (Lane-A source) … */
  readonly intakeEventId?: string;
  /** … OR direct raw text (e.g. an owner chat turn). Exactly one of the two. */
  readonly rawText?: string;
  readonly workspaceId: string;
  /** Injected LLM call (the test stubs it). */
  readonly callEngine: CallEngineFn;
  /** Provenance override for the rawText path. */
  readonly userInputTurnId?: string;
  readonly nowMs?: number;
}

/**
 * THE CORE: extracts typed knowledge_forms rows from an owner/expert input.
 *
 * Flow:
 *   1. Resolve the source — intakeEventId → read raw_content from intake_events
 *      (0119, in the same workspace; N9 scope); OR rawText directly.
 *   2. callEngine(system, user) → raw LLM text.
 *   3. parseCompilerOutput (N6, deterministic) → valid forms (+ rejectedCount).
 *      Malformed → fail-soft (0 forms, no crash).
 *   4. per form insertKnowledgeForm(...) → review_state='pending-review' (§8 gate).
 *
 * Throws ONLY on a usage error (no/duplicate source argument, missing
 * workspace, intakeEventId not found). LLM/parse errors are fail-soft.
 */
export async function compileKnowledgeForms(
  args: CompileKnowledgeFormsArgs,
): Promise<CompileResult> {
  const { db, workspaceId, callEngine } = args;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("compileKnowledgeForms: workspaceId required (N9)");
  }
  if (typeof callEngine !== "function") {
    throw new Error("compileKnowledgeForms: callEngine fn required");
  }

  const hasIntake =
    typeof args.intakeEventId === "string" && args.intakeEventId.length > 0;
  const hasRaw = typeof args.rawText === "string" && args.rawText.length > 0;
  if (hasIntake === hasRaw) {
    throw new Error(
      "compileKnowledgeForms: provide exactly ONE of intakeEventId | rawText",
    );
  }

  // (1) Resolve the source — verbatim (N1).
  let rawText: string;
  let intakeEventId: string | null = null;
  if (hasIntake) {
    const row = db
      .prepare(
        `SELECT raw_content FROM intake_events
          WHERE id = ? AND workspace_id = ?
          LIMIT 1`,
      )
      .get(args.intakeEventId, workspaceId) as
      | { raw_content: string }
      | undefined;
    if (!row) {
      throw new Error(
        `compileKnowledgeForms: intake_event '${args.intakeEventId}' not found in workspace '${workspaceId}'`,
      );
    }
    rawText = row.raw_content; // N1: verbatim, no slice
    intakeEventId = args.intakeEventId as string;
  } else {
    rawText = args.rawText as string; // N1: verbatim
  }

  // (2) LLM call.
  let llmText: string;
  try {
    llmText = await callEngine({
      system: buildCompileSystemPrompt(),
      user: buildCompileUserPrompt(rawText),
    });
  } catch {
    // LLM crash → fail-soft: 0 forms (N6 — we only trust after the parse).
    return { forms: [], rejectedCount: 0, intakeEventId };
  }

  // (3) Deterministic parse (N6) BEFORE trust.
  const parsed = parseCompilerOutput(llmText);
  if (parsed.forms.length === 0) {
    return { forms: [], rejectedCount: parsed.rejectedCount, intakeEventId };
  }

  // (4) Persist — all as pending-review (§8 gate).
  const inserted: CompiledKnowledgeForm[] = [];
  for (const f of parsed.forms) {
    const form = insertKnowledgeForm(db, {
      workspaceId,
      kind: f.kind,
      term: f.term,
      statement: f.statement, // N1: verbatim
      rationale: f.rationale, // N1: verbatim
      exampleCases: f.exampleCases, // N1: verbatim
      counterCases: f.counterCases, // N1: verbatim
      domain: f.domain,
      confidence: f.confidence,
      intakeEventId,
      userInputTurnId: args.userInputTurnId ?? null,
      nowMs: args.nowMs,
    });
    inserted.push(form);
  }

  return {
    forms: inserted,
    rejectedCount: parsed.rejectedCount,
    intakeEventId,
  };
}
