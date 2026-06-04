/**
 * Intent → flow-template composition — Flow Studio P2 · 2026-05-27.
 *
 * Source: docs/plans/2026-05-27_flow-studio-architecture.md §2 (chat composition).
 *
 * `composeFlowFromIntent` is the step BEFORE execution: from a raw
 * operator intent ("Erstelle eine Webseite …") a reusable
 * `flow_template` + its `flow_steps` is composed + PERSISTED. The output is
 * directly `dispatchFlow`-capable (P2, lib/flow/execute.ts) — NO execution here.
 *
 * Pipeline (§2.1–§2.4):
 *   1. Intent → step list. Via an INJECTABLE `decompose` parameter
 *      (intent → {title,rationale}[]) — so testable WITHOUT a real LLM. The
 *      default delegates to the existing recursive-plan decompose
 *      (lib/plan-first/orchestrate-plan.ts: proposePlan/parseProposedPlan),
 *      wrapped via makeRecursivePlanDecompose(callEngine).
 *   2. Per step: assign a skill (heuristic on title/intent keywords, against
 *      lib/agents/role-skill-map.ts keys + the domain Flow-Studio skills).
 *   3. Detect tool need: check steps with a tool need (skill = 'tool:*') against
 *      the connector catalog (connector_catalog/connector_capabilities) +
 *      credential existence (api_credentials) → collect `missingTools`
 *      (lib/connectors/coverage.ts:validateCoverage is reused).
 *   4. Persist: createFlowTemplate + addFlowStep per step (depends_on
 *      = linear chain from the decompose order).
 *
 * ── Why a raw better-sqlite3 handle (instead of detectConnector/getDb)? ──────
 *   The entire flow surface (templates-repo.ts, execute.ts) works on a
 *   raw Database handle (analogous to lib/rag/retriever.ts) → directly in-memory
 *   testable. lib/connectors/detect.ts, by contrast, is HARD-wired to the getDb()
 *   singleton (loadCatalogSafe → listConnectors → getDb). We therefore do
 *   NOT replicate the engine, but read the catalog + the credential existence directly
 *   from the passed handle and apply the PURE validator validateCoverage.
 *   This way the composition stays usable without a singleton dependency + without a vault mock
 *   in tests (same discipline as execute.ts).
 *
 * Discipline:
 *   - N1: title/rationale/intent persisted verbatim (no .slice/.substring).
 *   - N6: skill heuristic + coverage check are deterministic. The only
 *         non-deterministic element (LLM decompose) is factored out as an injectable
 *         parameter; the default wrapper gates the LLM output via
 *         the deterministic parseProposedPlan validator (N6).
 *   - N2 (fail-closed): an unknown/unconnected tool connector ALWAYS lands in
 *         missingTools (never silently waved through as "ok"). No hasCredential
 *         callback ⇒ conservatively treated as unconnected.
 *   - N9: workspaceId is passed through as the scope on the flow_template.
 *   - NO net I/O, NO real connector call (that is P5 + LAZYOS_CONNECTOR_LIVE).
 */

import {
  proposePlan,
  type ProposedPlan,
} from "@/lib/plan-first/orchestrate-plan";
import { validateCoverage } from "@/lib/connectors/coverage";
import {
  addFlowStep,
  createFlowTemplate,
  type FlowStep,
  type FlowTemplate,
} from "./templates-repo";
import {
  mediaStepKindFromSkill,
  type MediaStepKind,
} from "./media-styles";

type RawDb = import("better-sqlite3").Database;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A decomposed step — the minimum the composition needs.
 * title/rationale are VERBATIM (N1) — the default decompose passes them 1:1 from
 * the recursive-plan emission (PlanStep.title/rationale).
 */
export interface DecomposedStep {
  /** Verbatim step title (N1). */
  readonly title: string;
  /** Verbatim 1-sentence rationale (N1). */
  readonly rationale: string;
}

/**
 * Injectable decompose function: intent → ordered step list.
 *
 * Synchronous OR async allowed (tests pass a synchronous stub; the
 * default LLM wrapper is async). composeFlowFromIntent `await`s the result
 * in both cases.
 */
export type DecomposeFn = (
  intent: string,
) => DecomposedStep[] | Promise<DecomposedStep[]>;

/**
 * Existence check for a credential (do NOT decrypt — only check).
 * Default (see defaultHasCredential) is a COUNT query on api_credentials.
 * Tests can inject a pure in-memory callback.
 *
 * N2 fail-closed: if NO callback is passed AND the api_credentials
 * table does not exist (e.g. a minimal test DB), `false` (= unconnected) is
 * conservatively assumed — a tool step then lands in missingTools.
 */
export type HasCredentialFn = (provider: string) => boolean;

export interface ComposeFlowInput {
  /** Raw operator intent (verbatim, N1). DE or EN. */
  readonly intent: string;
  /** ManifestCoord scope (N9). Set on the flow_template. */
  readonly workspaceId: string;
  /**
   * Intent → step list. INJECTABLE for tests (stub without a real LLM).
   * Default: makeRecursivePlanDecompose(callEngine) — requires a
   * callEngine (otherwise composeFlowFromIntent throws a clear error).
   */
  readonly decompose?: DecomposeFn;
  /**
   * Routing LLM adapter for the default decompose. Only relevant when NO
   * own `decompose` is passed. Passed via makeRecursivePlanDecompose to
   * proposePlan (engine-agnostic, N11: the caller chooses the model).
   */
  readonly callEngine?: (prompt: string) => Promise<string>;
  /**
   * Optional org scope (passed through to the flow_template).
   */
  readonly orgId?: string | null;
  /**
   * Optional existence check for credentials. Default: COUNT on
   * api_credentials (scope_kind='workspace', scope_id=workspaceId, provider).
   */
  readonly hasCredential?: HasCredentialFn;
  /**
   * A3 (WHY injection · 2026-05-27): an optional, already-rendered
   * WHY block (renderWhyContextForPrompt from lib/reasoning/why-context.ts).
   * Is — ONLY for the default decompose (makeRecursivePlanDecompose) — PREPENDED
   * to the proposePlan prompt so the decompose knows earlier rationales
   * + active beliefs of the workspace and recommends consistently and justified.
   *
   * Backwards-compatible: without this field (and without `withWhyContext`) the
   * composition is BIT-IDENTICAL to before — no caller/test changes its
   * behavior. An own (injected) `decompose` deliberately ignores the field:
   * then the caller is itself responsible for the context injection.
   *
   * N6: the WHY block is ONLY context for the LLM — the deterministic
   * parseProposedPlan validator (in proposePlan) stays before it.
   */
  readonly whyContext?: string;
}

/**
 * A missing tool: a tool step whose connector is NOT (fully)
 * connected. This is exactly the payload that the credential-coupling
 * surface (Track-D) needs to offer an OAuth/API-key coupling per step.
 */
export interface MissingTool {
  /** flow_steps.id of the affected step. */
  readonly stepId: string;
  /** Step title (N1 verbatim) — for the human-readable surface. */
  readonly stepTitle: string;
  /** Skill key of the step (e.g. 'tool:image'). */
  readonly skill: string;
  /**
   * Connector/provider slug that is needed (e.g. 'imagegen2', 'heygen').
   * null when the heuristic could not assign a concrete provider (then
   * the surface is a generic "connect a tool for X" prompt).
   */
  readonly provider: string | null;
  /** Needed capability names (heuristic, for validateCoverage). */
  readonly neededCapabilities: readonly string[];
  /**
   * Why unconnected:
   *   'profile'    — no catalog entry for the provider.
   *   'capability' — catalog entry present, but capabilities don't cover the need.
   *   'credential' — profile + capabilities ok, but no credential in the vault.
   *   'unknown'    — no concrete provider assignable (heuristic without a hint).
   */
  readonly reason: "profile" | "capability" | "credential" | "unknown";
}

/**
 * A media step (tool:image|video|avatar) for which the owner should make a
 * STYLE choice (Stream B2), INSTEAD of the system unilaterally assuming ONE
 * provider (PA-Chat finding hero video → wrong heygen type → stuck).
 *
 * Carries NO provider pre-decision — the concrete approach/provider is determined
 * only after the style choice (applyStyleChoice in compose-and-run.ts).
 */
export interface MediaStep {
  /** flow_steps.id of the media step. */
  readonly stepId: string;
  /**
   * flow_steps.idx (position in the decompose order). Stable across a
   * re-compose of the same (deterministic) decompose — the random
   * stepId (ULID) is NOT. Serves as a fallback key for styleChoices,
   * so the owner choice also applies when the /flow front door re-composes
   * the flow instead of reusing the persisted one.
   */
  readonly idx: number;
  /** Step title (N1 verbatim). */
  readonly stepTitle: string;
  /** Skill key ('tool:image'|'tool:video'|'tool:avatar'). */
  readonly skill: string;
  /** Media-step type ('image'|'video'|'avatar') — selector for media-styles. */
  readonly kind: MediaStepKind;
}

export interface ComposeFlowResult {
  /** The persisted flow_template. */
  readonly template: FlowTemplate;
  /** The persisted flow_steps (in decompose order). */
  readonly steps: readonly FlowStep[];
  /** Steps with a tool need whose connector is not (fully) connected. */
  readonly missingTools: readonly MissingTool[];
  /**
   * Media steps (tool:image|video|avatar) that require an owner style choice
   * (Stream B2). Additive — existing consumers ignore the field.
   */
  readonly mediaSteps: readonly MediaStep[];
}

export class FlowComposeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "FlowComposeError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Default decompose: recursive-plan wrapper (§2.1)
//
// Wraps proposePlan (lib/plan-first/orchestrate-plan.ts) as a DecomposeFn. The
// LLM output is gated by the deterministic parseProposedPlan validator
// (N6, happens IN proposePlan). title/rationale are taken VERBATIM (N1)
// from the parsed PlanSteps.
// ---------------------------------------------------------------------------

/**
 * Builds the default decompose: a DecomposeFn that calls the existing
 * recursive-plan proposer (proposePlan) and reduces its steps to
 * {title, rationale}.
 *
 * @param callEngine engine-agnostic LLM adapter (Ollama/Codex/claude-cli).
 *                   N11: the caller chooses the model (llama3 for small,
 *                   deepseek-r1:14b for XL).
 * @param whyContext A3 (optional): an already-rendered WHY block
 *                   (renderWhyContextForPrompt). If set + not empty, it is
 *                   PREPENDED to EVERY proposePlan prompt (via wrapping of the
 *                   callEngine — proposePlan itself stays untouched, N4). The
 *                   deterministic parseProposedPlan validator then runs
 *                   unchanged (N6). Without the parameter the prompt passed to
 *                   proposePlan is BIT-IDENTICAL to before.
 */
export function makeRecursivePlanDecompose(
  callEngine: (prompt: string) => Promise<string>,
  whyContext?: string,
): DecomposeFn {
  // A3: prepend the WHY block to the plan prompt WITHOUT touching proposePlan/buildPlanPrompt
  // — we wrap the engine adapter. proposePlan builds its prompt,
  // this wrapper prefixes the WHY block before it reaches the engine. Empty/
  // missing whyContext ⇒ identity wrapper (bit-identical prompt).
  const why = typeof whyContext === "string" ? whyContext.trim() : "";
  const engine =
    why.length === 0
      ? callEngine
      : (prompt: string): Promise<string> => callEngine(`${why}\n\n${prompt}`);

  return async (intent: string): Promise<DecomposedStep[]> => {
    const plan: ProposedPlan = await proposePlan(intent, engine);
    return plan.steps.map((s) => ({
      title: s.title, // N1: verbatim
      rationale: s.rationale, // N1: verbatim
    }));
  };
}

// ---------------------------------------------------------------------------
// Skill heuristic (§2.2)
//
// Maps a step title (+ intent as context) to a skill key. The
// skill keys are EITHER role-skill-map keys (architecture→architect is the
// domain variant; see compile.ts SKILL_ROLE_MAP) OR domain
// Flow-Studio skills that compile.ts understands ('design'/'copy'/'aufbau'),
// OR tool skills ('tool:image'/'tool:video'/'tool:avatar') that signal a
// connector need.
//
// Heuristic table (documented, deterministic, DE + EN; more specific
// patterns first — the first hit wins):
//   "Aufbau"/"Struktur"/"Architektur"/"Setup"/"Layout"  → architecture
//   "Copy"/"Text"/"Caption"/"Headline"/"Slogan"          → copywriting
//   "Design"/"Style"/"Visual"/"Mockup"/"Branding"        → design
//   "Foto"/"Bild"/"Photo"/"Image"/"Grafik"/"Thumbnail"   → tool:image  (provider hint: imagegen2)
//   "Video"/"Motion"/"Clip"/"Reel"/"Animation"           → tool:video  (provider hint: higgsfield)
//   "Avatar"/"Talking Head"/"Presenter"/"Sprecher"       → tool:avatar (provider hint: heygen)
//   otherwise                                             → coder (generic worker)
//
// Note on the order: avatar BEFORE video (an "avatar video" is primarily
// an avatar step), and tool:image/video/avatar BEFORE design/copy, so that a
// "Design der Foto-Assets" title is recognized as a photo tool (connector need),
// not as a pure design skill. This is the pragmatic owner heuristic from §2.
// ---------------------------------------------------------------------------

interface SkillAssignment {
  /** The assigned skill key (compile.ts-compatible). */
  readonly skill: string;
  /** null | 'connector' — 'connector' signals a tool need (coverage check). */
  readonly toolKind: string | null;
  /** Provider hint for the connector search (only for tool:*). */
  readonly providerHint: string | null;
  /** Needed capabilities (heuristic) for validateCoverage (only for tool:*). */
  readonly neededCapabilities: readonly string[];
}

interface SkillRule {
  readonly pattern: RegExp;
  readonly skill: string;
  readonly toolKind: string | null;
  readonly providerHint: string | null;
  readonly neededCapabilities: readonly string[];
}

const SKILL_RULES: readonly SkillRule[] = [
  // W1.2 (2026-05-30): assembly — the final assembly into ONE index.html.
  // BEFORE all other rules, so a "Zusammenbau/Assembly" title is not
  // misclassified as coder/design. compile.ts maps 'assembly' → coder.
  {
    pattern: /\b(assembl|zusammenbau|zusammensetz|finale.+seite|index\.html|gesamtseite)\b/i,
    skill: "assembly",
    toolKind: null,
    providerHint: null,
    neededCapabilities: [],
  },
  // Avatar BEFORE video (an avatar step is primarily avatar).
  // DRIFT FIX (2026-05-27): provider slug + capability names MUST match
  // lib/connectors/p5-tool-connectors.ts (P5_CAPABILITY_KEYS) exactly — otherwise
  // validateCoverage is ALWAYS ok:false and the connectors are never reachable
  // (finding: Higgsfield was 0× reachable). Provider: heygen-avatar/higgsfield/
  // imagegen2; capabilities: video.avatar/video.motion/image.generate.
  {
    pattern: /\b(avatar|talking.?head|presenter|sprecher|moderator|spokesperson)\b/i,
    skill: "tool:avatar",
    toolKind: "connector",
    providerHint: "heygen-avatar",
    neededCapabilities: ["video.avatar"],
  },
  // Video / motion.
  {
    pattern: /\b(video|motion|clip|reel|animation|animier|footage)\b/i,
    skill: "tool:video",
    toolKind: "connector",
    providerHint: "higgsfield",
    neededCapabilities: ["video.motion"],
  },
  // Photo / image / graphic.
  {
    pattern:
      /\b(foto|fotos|photo|photos|bild|bilder|image|images|grafik|thumbnail|illustration)\b/i,
    skill: "tool:image",
    toolKind: "connector",
    providerHint: "imagegen2",
    neededCapabilities: ["image.generate"],
  },
  // PV stringing / photovoltaic layout (BAHN-2 · 2026-05-30).
  // BEFORE aufbau/architektur + design, so a "PV-Auslegung"/"Modulbelegung"/
  // "Wechselrichter-Stringing" step is NOT misclassified as generic layout/design.
  // compile.ts maps 'pv-stringing' → coder; the
  // plan-executor intercepts this skill BEFORE the generic coder spawn and
  // calls the deterministic producer (lib/eval/demo-pv/producer.ts).
  // NO connector need (purely arithmetic solver, N6) → toolKind null.
  {
    pattern: /\b(string|stringing|wechselrichter|inverter|pv-?auslegung|modulbelegung|photovoltaik|dachbelegung)\b/i,
    skill: "pv-stringing",
    toolKind: null,
    providerHint: null,
    neededCapabilities: [],
  },
  // Structure / setup / architecture.
  {
    pattern: /\b(aufbau|struktur|architektur|architecture|setup|layout|gerüst|scaffold|grundger)\b/i,
    skill: "architecture",
    toolKind: null,
    providerHint: null,
    neededCapabilities: [],
  },
  // Copy / text.
  {
    pattern: /\b(copy|copywriting|text|texte|caption|headline|slogan|wording|inhalt.schreib|content.writ)\b/i,
    skill: "copywriting",
    toolKind: null,
    providerHint: null,
    neededCapabilities: [],
  },
  // Design / style / branding.
  {
    pattern: /\b(design|style|styling|visual|mockup|branding|farb|theme|gestalt)\b/i,
    skill: "design",
    toolKind: null,
    providerHint: null,
    neededCapabilities: [],
  },
];

/**
 * Deterministically assigns a skill to a step title. The intent is
 * NOT co-matched (only the title) — a single global intent term
 * would otherwise overcolor EVERY step. Fallback: 'coder' (generic worker),
 * matching compile.ts (unknown, set skill → 'coder').
 *
 * Exported for the compose test (skill mapping is part of the gate).
 */
/**
 * W1.2 (2026-05-30): recognizes website-like intents (keywords website|webseite|
 * landing|page|site). Only then does composeFlowFromIntent append a final
 * assembly step. Deterministic (N6). Exported for the compose test.
 */
export function isWebsiteLikeIntent(intent: string): boolean {
  return /\b(website|webseite|web-?site|landing|landingpage|landing-page|homepage|home-?page|page|site|seite)\b/i.test(
    intent ?? "",
  );
}

export function assignSkill(title: string): SkillAssignment {
  const haystack = title.toLowerCase();
  for (const rule of SKILL_RULES) {
    if (new RegExp(rule.pattern.source, "i").test(haystack)) {
      return {
        skill: rule.skill,
        toolKind: rule.toolKind,
        providerHint: rule.providerHint,
        neededCapabilities: rule.neededCapabilities,
      };
    }
  }
  return {
    skill: "coder",
    toolKind: null,
    providerHint: null,
    neededCapabilities: [],
  };
}

// ---------------------------------------------------------------------------
// Connector coverage on the raw handle (§2.3)
//
// Reads the catalog (connector_catalog/connector_capabilities) directly from the
// passed handle (NOT via getDb()-bound detect.ts) and applies the
// PURE validator validateCoverage (lib/connectors/coverage.ts). Then
// credential existence via hasCredential. Fail-closed (N2): every defect → one
// MissingTool entry.
// ---------------------------------------------------------------------------

interface CatalogLookup {
  /** connector_catalog row present? */
  readonly profile: { provider: string; apiVersion: string | null } | null;
  /** Capabilities (names) of the provider in the catalog. */
  readonly capabilities: readonly { name: string }[];
}

/**
 * Reads the profile + capabilities of a provider from the raw handle. Fail-safe:
 * if a table is missing (minimal test DB), {profile:null, capabilities:[]}
 * is returned (→ fail-closed: the step lands in missingTools with reason='profile').
 */
function lookupConnector(db: RawDb, provider: string): CatalogLookup {
  let profileRow: Record<string, unknown> | undefined;
  try {
    profileRow = db
      .prepare(
        `SELECT id, provider, api_version FROM connector_catalog WHERE provider = ?`,
      )
      .get(provider) as Record<string, unknown> | undefined;
  } catch {
    return { profile: null, capabilities: [] };
  }
  if (!profileRow) return { profile: null, capabilities: [] };

  let caps: { name: string }[] = [];
  try {
    const rows = db
      .prepare(
        `SELECT name FROM connector_capabilities WHERE connector_id = ?`,
      )
      .all(String(profileRow.id)) as Array<{ name: string }>;
    caps = rows.map((r) => ({ name: String(r.name) }));
  } catch {
    caps = [];
  }

  return {
    profile: {
      provider: String(profileRow.provider),
      apiVersion: (profileRow.api_version as string | null) ?? null,
    },
    capabilities: caps,
  };
}

/**
 * Default credential existence check: COUNT on api_credentials for the
 * workspace scope. Fail-safe: if the table is missing, false (→ fail-closed).
 * Decrypts NOTHING — pure existence check (security posture like detect.ts).
 */
function makeDefaultHasCredential(
  db: RawDb,
  workspaceId: string,
): HasCredentialFn {
  return (provider: string): boolean => {
    try {
      const row = db
        .prepare(
          `SELECT COUNT(*) AS n FROM api_credentials
             WHERE scope_kind = 'workspace' AND scope_id = ? AND provider = ?`,
        )
        .get(workspaceId, provider) as { n: number } | undefined;
      return (row?.n ?? 0) > 0;
    } catch {
      return false;
    }
  };
}

/**
 * Decides for a tool step whether its connector is connected. Returns
 * `null` if everything is connected, otherwise a MissingTool entry (N2: every
 * defect is visible).
 */
function assessTool(
  db: RawDb,
  step: FlowStep,
  assignment: SkillAssignment,
  hasCredential: HasCredentialFn,
): MissingTool | null {
  const stepTitle = step.label ?? step.skill ?? step.id;

  // No concrete provider hint → generic "connect a tool" need.
  if (assignment.providerHint == null) {
    return {
      stepId: step.id,
      stepTitle,
      skill: assignment.skill,
      provider: null,
      neededCapabilities: assignment.neededCapabilities,
      reason: "unknown",
    };
  }

  const provider = assignment.providerHint;
  const lookup = lookupConnector(db, provider);

  // 1. No catalog profile → missing='profile' (fail-closed).
  if (lookup.profile == null) {
    return {
      stepId: step.id,
      stepTitle,
      skill: assignment.skill,
      provider,
      neededCapabilities: assignment.neededCapabilities,
      reason: "profile",
    };
  }

  // 2. Coverage check (PURE validator reused, N6/N2 fail-closed).
  const coverage = validateCoverage(assignment.neededCapabilities, {
    provider,
    apiVersion: lookup.profile.apiVersion,
    capabilities: lookup.capabilities,
  });
  if (!coverage.ok) {
    return {
      stepId: step.id,
      stepTitle,
      skill: assignment.skill,
      provider,
      neededCapabilities: assignment.neededCapabilities,
      reason: "capability",
    };
  }

  // 3. Credential existence (no decrypt). Missing → missing='credential'.
  if (!hasCredential(provider)) {
    return {
      stepId: step.id,
      stepTitle,
      skill: assignment.skill,
      provider,
      neededCapabilities: assignment.neededCapabilities,
      reason: "credential",
    };
  }

  // Connected: profile + capabilities + credential present → NOT missing.
  return null;
}

// ---------------------------------------------------------------------------
// Media-step detection (Stream B2)
//
// Finds the tool:image|video|avatar steps in the PERSISTED steps and
// returns them as MediaStep[] — WITHOUT a provider pre-decision. The style choice
// (which provider/approach?) follows only in compose-and-run.ts::applyStyleChoice.
//
// Exported for the compose test (media detection is part of the gate).
// ---------------------------------------------------------------------------

export function detectMediaSteps(
  steps: readonly FlowStep[],
): readonly MediaStep[] {
  const out: MediaStep[] = [];
  for (const step of steps) {
    const kind = mediaStepKindFromSkill(step.skill);
    if (kind == null) continue; // not a media tool step
    out.push({
      stepId: step.id,
      idx: step.idx,
      stepTitle: step.label ?? step.skill ?? step.id, // N1 verbatim
      skill: step.skill as string,
      kind,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main API
// ---------------------------------------------------------------------------

/**
 * Composes a persisted flow_template + flow_steps from an intent and
 * reports the unconnected tools. The output is directly dispatchFlow-capable.
 *
 * @throws FlowComposeError('invalid_intent')  — empty intent.
 * @throws FlowComposeError('invalid_scope')    — empty workspaceId (N9).
 * @throws FlowComposeError('no_decompose')     — neither decompose nor callEngine.
 * @throws FlowComposeError('empty_decompose')  — decompose produced 0 steps.
 */
export async function composeFlowFromIntent(
  db: RawDb,
  input: ComposeFlowInput,
): Promise<ComposeFlowResult> {
  if (typeof input.intent !== "string" || input.intent.trim().length === 0) {
    throw new FlowComposeError(
      "invalid_intent",
      "composeFlowFromIntent: intent required (non-empty)",
    );
  }
  if (
    typeof input.workspaceId !== "string" ||
    input.workspaceId.trim().length === 0
  ) {
    throw new FlowComposeError(
      "invalid_scope",
      "composeFlowFromIntent: workspaceId required (N9 ManifestCoord scope)",
    );
  }

  // ── 1. Choose the decompose (injected OR default LLM wrapper) ─────────────
  let decompose: DecomposeFn;
  if (input.decompose) {
    // Own (injected) decompose: the caller is itself responsible for the
    // WHY injection — input.whyContext is deliberately NOT
    // applied here (the stub knows its own prompt construction).
    decompose = input.decompose;
  } else if (input.callEngine) {
    // Default decompose: prepend the A3 WHY block (if set) to the plan
    // prompt. Without whyContext the prompt stays bit-identical to before.
    decompose = makeRecursivePlanDecompose(input.callEngine, input.whyContext);
  } else {
    throw new FlowComposeError(
      "no_decompose",
      "composeFlowFromIntent: pass either `decompose` (test stub) or `callEngine` (default Recursive-Plan-Decompose)",
    );
  }

  const decomposed = await decompose(input.intent);
  if (!Array.isArray(decomposed) || decomposed.length === 0) {
    throw new FlowComposeError(
      "empty_decompose",
      `composeFlowFromIntent: decompose produced no steps for intent "${input.intent}"`,
    );
  }

  // ── 2. Skill assignment per step (deterministic) ─────────────────────────
  const assignments = decomposed.map((d) => ({
    decomposed: d,
    assignment: assignSkill(d.title),
  }));

  // ── 4 (persistence before 3, because missingTools needs the persisted step.id):
  //    create flow_template + flow_steps. depends_on = linear chain from the
  //    decompose order (each step hangs on the direct predecessor). ──────────
  const template = createFlowTemplate(db, {
    workspaceId: input.workspaceId,
    orgId: input.orgId ?? null,
    name: input.intent, // N1: the intent is the template name (verbatim)
    description: input.intent, // N1: verbatim (no .slice)
    graphJson: JSON.stringify({ source: "composeFlowFromIntent" }),
  });

  const steps: FlowStep[] = [];
  let prevId: string | null = null;
  for (let i = 0; i < assignments.length; i += 1) {
    const { decomposed: d, assignment } = assignments[i];
    const step = addFlowStep(db, {
      flowId: template.id,
      idx: i,
      label: d.title, // N1: verbatim
      skill: assignment.skill,
      toolKind: assignment.toolKind,
      // connectorId stays NULL: the binding to a concrete connectors row
      // happens only at the credential coupling (Track-D) or P5 live wiring.
      connectorId: null,
      configJson: JSON.stringify({ rationale: d.rationale }), // N1: rationale verbatim
      dependsOn: prevId ? [prevId] : null,
    });
    steps.push(step);
    prevId = step.id;
  }

  // ── 4b. W1.2 (2026-05-30): assembly step for website-like intents ──────────
  //    For a website/landing/page intent we ALWAYS append a final
  //    `assembly` step (dependsOn = last step) that reads all fragments
  //    (design/tokens.css, content/site.config.json, section files) and
  //    builds ONE viewable index.html in the workspace root. This guarantees
  //    a viewable result (the W1.1 diff gate enforces the file). Idempotency:
  //    if the decompose already delivered an assembly/index.html step,
  //    NO second one is appended (assignSkill === 'assembly').
  if (isWebsiteLikeIntent(input.intent)) {
    const alreadyHasAssembly = assignments.some(
      (a) => a.assignment.skill === "assembly",
    );
    if (!alreadyHasAssembly && steps.length > 0) {
      const last = steps[steps.length - 1];
      const assemblyStep = addFlowStep(db, {
        flowId: template.id,
        idx: steps.length,
        label: "Assembly: alle Fragmente zu einer ansehbaren index.html zusammenbauen",
        skill: "assembly",
        toolKind: null,
        connectorId: null,
        configJson: JSON.stringify({
          rationale:
            "W1.2: liest design/tokens.css + content/site.config.json + Sektions-" +
            "Dateien und baut EINE plain-HTML/CSS index.html (im Browser ohne Build " +
            "ansehbar). Platzhalter-Bilder = CSS-Gradient/SVG, keine Connector-Assets.",
        }),
        dependsOn: [last.id],
      });
      steps.push(assemblyStep);
    }
  }

  // ── 3. Check tool need (on the PERSISTED steps, for a stable step.id) ──────
  const hasCredential =
    input.hasCredential ?? makeDefaultHasCredential(db, input.workspaceId);
  const missingTools: MissingTool[] = [];
  // Only the DECOMPOSE steps have an `assignments[i]` — the possibly appended
  // assembly step (W1.2) has no tool need (toolKind=null) and is
  // deliberately skipped here (i limited to assignments.length).
  for (let i = 0; i < assignments.length; i += 1) {
    const { assignment } = assignments[i];
    if (assignment.toolKind !== "connector") continue; // no tool need
    const missing = assessTool(db, steps[i], assignment, hasCredential);
    if (missing) missingTools.push(missing);
  }

  // ── 5. Detect media steps (Stream B2) — for the owner style choice. ───────
  //    Pure derivation from the persisted steps, no provider pre-selection.
  const mediaSteps = detectMediaSteps(steps);

  return { template, steps, missingTools, mediaSteps };
}
