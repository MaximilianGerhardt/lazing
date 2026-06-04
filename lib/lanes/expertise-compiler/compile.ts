/**
 * Lane B — Expertise Compiler · DER KERN (compileKnowledgeForms)
 * ════════════════════════════════════════════════════════════════════════
 *
 * Phase 2 W2.2 · 2026-05-29 · KERN-Remediation.
 *
 * IST/SOLL-Befund (2 Opus-Analysen): Das 0120-Schema `knowledge_forms` + die
 * N4-Naht `mirrorApprovedKnowledgeFormToBelief` waren gebaut — ABER der
 * namensgebende KERN fehlte: KEIN Code erzeugte je eine knowledge_forms-Row.
 * Diese Datei IST dieser Kern.
 *
 * Master-Briefing §8.1 (verbatim, N1):
 *   „Experte erklaert oder handelt, System extrahiert Begriffe, Regeln,
 *    Ausnahmen, Entscheidungen und Qualitaetskriterien."
 * Master-Briefing §8.2 (verbatim, N1) — die 12 Wissensformen:
 *   „Glossary Entry · Principle · If-Then Rule · Exception · Tactic ·
 *    Role Judgment · Handoff Dependency · Quality Criterion ·
 *    Simulation Case · Eval Question · SOP Step · Open Unknown."
 * Master-Briefing §8.3 review-gate (Owner-Direktive):
 *   Lane-B-Outputs landen IMMER mit review_state='pending-review'; nichts
 *   wird ohne human-review zu einer Belief.
 *
 * ── ARCHITEKTUR ───────────────────────────────────────────────────────────
 *
 *   rawText / intakeEventId
 *        │  (callEngine — injizierbar, Test stubt das LLM)
 *        ▼
 *   LLM liefert STRUKTURIERTES JSON ({ forms: [{kind, term?, statement, …}] })
 *        │  N6: deterministischer Parse + Validierung VOR Vertrauen.
 *        │      malformed → fail-soft (0 Formen, kein Crash).
 *        ▼
 *   pro valider Form: insertKnowledgeForm(...) → EINE knowledge_forms-Row,
 *        review_state='pending-review' (§8 Gate), content_hash (N10),
 *        source_json mit intakeEventId-Provenienz.
 *        ▼
 *   (Owner approved manuell) → mirrorApprovedKnowledgeFormToBelief (N4-Naht,
 *        NICHT hier; bestehendes Modul).
 *
 * ── DISZIPLIN ─────────────────────────────────────────────────────────────
 *   - N1:  statement / rationale / term / example_cases / counter_cases werden
 *          VERBATIM aus dem LLM-JSON uebernommen (kein .slice/.substring). Der
 *          Prompt instruiert das LLM explizit, den Owner-Wortlaut zu zitieren.
 *   - N4:  KEIN zweiter Belief-Writer. Der Ausgang fliesst in das bestehende
 *          mirrorApprovedKnowledgeFormToBelief. Diese Datei schreibt NUR
 *          knowledge_forms.
 *   - N6:  Deterministischer Parse + Schema-Validierung VOR LLM-Vertrauen.
 *          Unbekannter kind / leeres statement / kaputtes JSON → fail-soft.
 *   - N8:  append-only-konform (0120-Trigger). Insert-only; kein UPDATE/DELETE.
 *   - N9:  workspace_id-Scope auf jeder Row.
 *   - N10: content_hash (sha256 ueber kanonisches JSON) pro Row.
 *
 * Reines Modul mit injizierter LLM-Funktion: `callEngine` ist der einzige
 * Seiteneffekt-Pfad. Tests stubben es. Kein getDb()-Singleton — rohes
 * better-sqlite3-Handle (analog beliefs-repo.ts / mirror-to-beliefs.ts).
 */

import { createHash } from "node:crypto";

import { ulid } from "@/lib/ulid";

type RawDb = import("better-sqlite3").Database;

// ───────────────────────────────────────────────────────────────────────────
// Die 12 Wissensformen (§8.2) — Single Source of Truth für den CHECK + Parse
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
 * Kurz-Definition je Form (verbatim aus §8.2-Geist), die im LLM-Prompt als
 * Extraktions-Schema mitgegeben wird. Bewusst knapp + DE+EN-tauglich.
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
// Result-Typen
// ───────────────────────────────────────────────────────────────────────────

/** Eine extrahierte (und persistierte) Wissensform. */
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
  /** Die persistierten Formen — ALLE mit review_state='pending-review' (§8 Gate). */
  readonly forms: readonly CompiledKnowledgeForm[];
  /**
   * Anzahl der vom LLM gelieferten, aber VERWORFENEN Roh-Formen (N6: malformed/
   * unbekannter kind/leeres statement). >0 ist kein Fehler — fail-soft.
   */
  readonly rejectedCount: number;
  /** Provenienz: der intake_events-Row, aus dem kompiliert wurde (oder null bei rawText). */
  readonly intakeEventId: string | null;
}

// ───────────────────────────────────────────────────────────────────────────
// callEngine — injizierbarer LLM-Aufruf (Test stubt das)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Der einzige LLM-Seiteneffekt-Pfad. In Produktion wird das von einer dünnen
 * Adapter-Funktion erfüllt, die `detectEngines()/pickEngine()` (lib/llm/engines/
 * selector.ts) nutzt und `engine.chat({ messages })` aufruft; im Test wird ein
 * Stub übergeben, der ein fixes JSON liefert.
 *
 * Vertrag: nimmt System- + User-Prompt, gibt den ROHEN Text der LLM-Antwort
 * zurück (erwartet darin JSON; der Parser ist defensiv).
 */
export type CallEngineFn = (args: {
  system: string;
  user: string;
}) => Promise<string>;

// ───────────────────────────────────────────────────────────────────────────
// Prompt-Bau (§8 — strukturierte Extraktion der 12 Formen)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Baut den System-Prompt. Er (a) erklärt die 12 Formen, (b) erzwingt
 * VERBATIM-Zitate des Owner-Wortlauts (N1), (c) erzwingt striktes JSON-Schema.
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

/** Baut den User-Prompt — der verbatim Input. KEIN slice (N1). */
export function buildCompileUserPrompt(rawText: string): string {
  return [
    "Hier ist der Owner-/Experten-Input. Extrahiere die Wissensformen daraus:",
    "",
    "----- INPUT (verbatim) -----",
    rawText, // N1: kein slice
    "----- ENDE INPUT -----",
  ].join("\n");
}

// ───────────────────────────────────────────────────────────────────────────
// Deterministischer Parser (N6 — VOR LLM-Vertrauen)
// ───────────────────────────────────────────────────────────────────────────

/** Eine validierte Roh-Form, bereit zum Insert. */
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
  // N1: jedes Element verbatim übernehmen (kein slice/trim-Verlust); nur
  // Nicht-Strings werden verworfen.
  return v.filter((x): x is string => typeof x === "string");
}

function asNullableString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function asNullableConfidence(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  if (v < 0 || v > 1) return null; // 0120 CHECK erzwingt [0,1]; out-of-range → null
  return v;
}

/**
 * Robuste JSON-Extraktion: das LLM könnte Markdown-Fences oder Vor-/Nachtext
 * liefern. Wir versuchen (1) direktes JSON.parse, (2) den ersten balancierten
 * {...}-Block. Schlägt beides fehl → null (fail-soft, N6).
 */
function extractJsonObject(text: string): unknown | null {
  if (typeof text !== "string" || text.length === 0) return null;
  // (1) direkt.
  try {
    return JSON.parse(text);
  } catch {
    // weiter zu (2)
  }
  // (2) erster balancierter Top-Level-{...}-Block.
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
 * Deterministischer Parser (N6): nimmt den rohen LLM-Text, validiert ihn gegen
 * das knowledge_forms-Schema und gibt nur die VALIDEN Formen zurück. Wirft NIE —
 * malformed Output → { forms: [], rejectedCount: <#roh> } (fail-soft).
 *
 * Eine Roh-Form ist valide gdw.:
 *   - kind ∈ den 12 (sonst verworfen),
 *   - statement ist ein nicht-leerer String (N1 — wir persistieren keine leere
 *     Aussage),
 *   - (alle anderen Felder werden defensiv normalisiert).
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

    // glossary erwartet term; ist es leer, bleibt es null (kein Reject —
    // der Code-Layer darf ein term-loses glossary tolerieren, die UI markiert).
    const term =
      kind === "glossary" ? asNullableString(r.term) : asNullableString(r.term);

    forms.push({
      kind: kind as KnowledgeFormKind,
      term: kind === "glossary" ? term : null, // term NUR bei glossary (Schema-Disziplin)
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
// insertKnowledgeForm — der knowledge_forms-Writer (N10 + Provenienz)
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
  /** Provenienz (§7.3 Lane-A-Quelle 0119). */
  readonly intakeEventId?: string | null;
  /** Provenienz: Owner-Chat-Turn-Quelle. */
  readonly userInputTurnId?: string | null;
  readonly nowMs?: number;
}

/**
 * Schreibt EINE knowledge_forms-Row (0120) mit review_state='pending-review'
 * (§8 Gate — der Compiler erzeugt NIEMALS approved). content_hash (N10) deckt
 * die Kern-Identität ab; source_json trägt die Provenienz (intakeEventId /
 * userInputTurnId), an die später mirrorApprovedKnowledgeFormToBelief die
 * beliefId anhängt (N4-Rück-FK).
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

  // source_json — Provenienz. Nur gesetzte Felder, damit der Rück-FK (beliefId)
  // später sauber ergänzt werden kann.
  const source: Record<string, unknown> = {};
  if (input.intakeEventId) source.intakeEventId = input.intakeEventId;
  if (input.userInputTurnId) source.userInputTurnId = input.userInputTurnId;
  const sourceJson = JSON.stringify(source);

  const id = `KFM-${ulid()}`;
  const ts = Number.isFinite(input.nowMs) ? (input.nowMs as number) : Date.now();

  // N10: content_hash über kanonisches JSON der Kern-Identität (deterministisch,
  // Keys alphabetisch). example/counter werden mit-gehasht (Tamper-Evidenz auf
  // den vollen Wissens-Inhalt).
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

/** N10: sha256 hex über kanonisches JSON (Keys alphabetisch sortiert). */
function sha256hex(payload: Record<string, unknown>): string {
  const keys = Object.keys(payload).sort();
  const canonical: Record<string, unknown> = {};
  for (const k of keys) canonical[k] = payload[k];
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

// ───────────────────────────────────────────────────────────────────────────
// compileKnowledgeForms — DER KERN
// ───────────────────────────────────────────────────────────────────────────

export interface CompileKnowledgeFormsArgs {
  readonly db: RawDb;
  /** ENTWEDER ein bestehender intake_events-Row (Lane-A-Quelle) … */
  readonly intakeEventId?: string;
  /** … ODER direkter Roh-Text (z.B. Owner-Chat-Turn). Genau eines von beiden. */
  readonly rawText?: string;
  readonly workspaceId: string;
  /** Injizierter LLM-Aufruf (Test stubt). */
  readonly callEngine: CallEngineFn;
  /** Provenienz-Override für rawText-Pfad. */
  readonly userInputTurnId?: string;
  readonly nowMs?: number;
}

/**
 * DER KERN: extrahiert aus einem Owner-/Experten-Input typisierte
 * knowledge_forms-Rows.
 *
 * Flow:
 *   1. Quelle auflösen — intakeEventId → lese raw_content aus intake_events
 *      (0119, im selben Workspace; N9-Scope); ODER rawText direkt.
 *   2. callEngine(system, user) → roher LLM-Text.
 *   3. parseCompilerOutput (N6, deterministisch) → valide Formen (+ rejectedCount).
 *      Malformed → fail-soft (0 Formen, kein Crash).
 *   4. pro Form insertKnowledgeForm(...) → review_state='pending-review' (§8 Gate).
 *
 * Wirft NUR bei Bedienfehler (kein/doppeltes Quellen-Argument, fehlender
 * Workspace, intakeEventId nicht gefunden). LLM-/Parse-Fehler sind fail-soft.
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

  // (1) Quelle auflösen — verbatim (N1).
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
    rawText = row.raw_content; // N1: verbatim, kein slice
    intakeEventId = args.intakeEventId as string;
  } else {
    rawText = args.rawText as string; // N1: verbatim
  }

  // (2) LLM-Aufruf.
  let llmText: string;
  try {
    llmText = await callEngine({
      system: buildCompileSystemPrompt(),
      user: buildCompileUserPrompt(rawText),
    });
  } catch {
    // LLM-Crash → fail-soft: 0 Formen (N6 — wir vertrauen erst nach Parse).
    return { forms: [], rejectedCount: 0, intakeEventId };
  }

  // (3) Deterministischer Parse (N6) VOR Vertrauen.
  const parsed = parseCompilerOutput(llmText);
  if (parsed.forms.length === 0) {
    return { forms: [], rejectedCount: parsed.rejectedCount, intakeEventId };
  }

  // (4) Persistieren — alle als pending-review (§8 Gate).
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
