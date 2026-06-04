/**
 * Phase IN — Innovation-Button contract.
 *
 * The implementation is deliberately not in this session — we ship
 * only the mockup page + 501 skeleton + documented contract, so that
 * marketing screenshots + the future implementation are clear.
 *
 * Contract (future, Phase IN-Implement after the OSS launch):
 *
 *   POST /api/innovate
 *
 *   Request:
 *   {
 *     scope: 'org' | 'workspace' | 'ticket' | 'tickets-list' | 'workstream',
 *     scopeId: string,                      // org/workspace/ticket/workstream ID
 *     personas: Array<'ux-analyst' | 'motion-director' | 'design-thinking'
 *                     | 'critic' | 'product-owner'>,
 *     hint?: string                         // Optional: user hint
 *                                           // ("ich will mehr Whitespace", "darks first")
 *   }
 *
 *   Response (202 Accepted, once implemented):
 *   {
 *     innovationId: string,                 // ULID — tracking for polling
 *     status: 'queued',
 *     pollUrl: '/api/innovate/<innovationId>',
 *     etaSeconds: number                    // rough estimate
 *   }
 *
 *   Workflow (future):
 *   1. spawn n designer agents in parallel with the current UI snapshot + brief
 *   2. each writes 1 alternative mockup spec (Apple-Keynote markdown +
 *      possibly screenshotable component specs)
 *   3. Cross-Roast phase analogous to Phase RA — designs attack each other
 *   4. V_final mockups returned to the UI as 3-5 cards
 *   5. the user picks one, tickets are generated from it
 *
 *   Today (501 Not Implemented): the endpoint exists, documents the
 *   contract, states the future phase in the body.
 */

export type InnovateScope =
  | 'org'
  | 'workspace'
  | 'ticket'
  | 'tickets-list'
  | 'workstream';

export type InnovatePersona =
  | 'ux-analyst'
  | 'motion-director'
  | 'design-thinking'
  | 'critic'
  | 'product-owner';

export interface InnovateRequest {
  scope: InnovateScope;
  scopeId: string;
  personas: InnovatePersona[];
  hint?: string;
}

export interface InnovatePending {
  ok: false;
  planned: true;
  status: 501;
  etaPhase: 'post-OSS-Launch';
  contract: 'see lib/innovate/contract.ts';
  message: string;
}

export const PERSONA_DESCRIPTIONS: Record<InnovatePersona, string> = {
  'ux-analyst':
    'Stellt User-Flows in Frage, sucht Reibung, schlägt minimalere Pfade vor.',
  'motion-director':
    'Definiert Spring-Parameter, Stagger, Choreografie, Reveal-Timing.',
  'design-thinking':
    'Hinterfragt das Mental-Modell — wären andere Metaphern besser?',
  critic:
    'Advocatus Diaboli — was übersieht das Design? Wo ist der Bullshit?',
  'product-owner':
    'Schützt vor Scope-Creep, fragt: bringt das wirklich User-Value?',
};

export const SCOPE_LABELS: Record<InnovateScope, string> = {
  org: 'Organisation',
  workspace: 'Workspace',
  ticket: 'Ticket',
  'tickets-list': 'Tickets-Liste',
  workstream: 'Workstream',
};

// ===========================================================================
// Phase IN-Implement (Lane D · 2026-05-29 · Opus 4.8) — real engine.
//
// The contract above (POST /api/innovate, 501 marketing surface, personas/
// scopes) remains UNCHANGED (app/api/innovate/route.ts + the
// mockup page depend on it). What FOLLOWS here is the actual, locally
// callable innovation engine — the „echte Inhalt" behind the button.
//
// It fulfills §10.2 mechanics (surface assumptions → reverse → roast) on
// EXISTING substrate (N4):
//   - assumption-map.ts  (assumptions, §10.2.3)
//   - reframe.ts         (reframes,    §10.2.4)
//   - contrarian-roast.ts(roast,       §10.2.7 — counter-evidence surface like
//                         lib/reasoning/reconcile.ts)
//   - innovation_artifacts (0121, append-only evidence, N8/N10)
//
// callEngine is injectable (the test stubs the LLM). The main agent calls
// runInnovate with the $raw handle + an engine adapter (mode-detection
// suggestion in the Lane-D report).
// ===========================================================================

import { extractAssumptions } from './assumption-map';
import { generateReframes } from './reframe';
import { contrarianRoast } from './contrarian-roast';
import type { InnovationArtifact } from './artifacts-repo';

type RawDb = import('better-sqlite3').Database;

/**
 * The 8 innovation-swarm roles (Master-Briefing §10.3, verbatim N1). Exposed
 * as a data constant (analogous to DIVERSITY_ROLES in
 * lib/agents/diversity-roles.ts) so that the tier-spawn / the UI can
 * enumerate the roles deterministically. Which role carries which engine call
 * is decided by the orchestrator; runInnovate today covers the Historian/First-
 * Principles/Contrarian/Critic shares via the LLM pipeline.
 */
export interface InnovationSwarmRole {
  readonly name: string;
  /** The role's guiding question, VERBATIM from §10.3 (N1). */
  readonly question: string;
}

export const INNOVATION_SWARM_ROLES: readonly InnovationSwarmRole[] = [
  { name: 'Historian', question: 'Was laeuft heute wirklich?' },
  { name: 'First-Principles Analyst', question: 'Was ist der eigentliche Zweck?' },
  { name: 'Cross-Domain Scout', question: 'Welche analogen Loesungen gibt es anderswo?' },
  { name: 'Contrarian', question: 'Welche Annahmen sind falsch?' },
  { name: 'Systems Architect', question: 'Wie wuerde man es neu schneiden?' },
  { name: 'Domain Expert', question: 'Was ist fachlich zwingend?' },
  { name: 'Operator', question: 'Was funktioniert im Alltag?' },
  { name: 'Critic', question: 'Was ist Pseudo-Innovation?' },
] as const;

export interface RunInnovateArgs {
  readonly workspaceId: string;
  /** The current state / plan that goes through the innovation mode (VERBATIM, N1). */
  readonly rawText: string;
  /** Engine adapter (injectable; the test stubs the LLM). */
  readonly callEngine: (prompt: string) => Promise<string>;
}

export interface RunInnovateResult {
  readonly assumptions: readonly InnovationArtifact[];
  readonly reframes: readonly InnovationArtifact[];
  /** One contrarian roast per reframe (only those with counter-evidence). */
  readonly roasts: readonly InnovationArtifact[];
  /**
   * The counter-evidence surface strings per roasted reframe (format like
   * reconcile.ts). The main agent emits them into the chat (R5: visually
   * separated, NO forced reply).
   */
  readonly counterEvidenceSurfaces: readonly string[];
}

/**
 * The innovation-mode pass (§10.2 steps 3 → 4 → 7):
 *   1. Surface assumptions (extractAssumptions).
 *   2. Reverse assumptions (generateReframes).
 *   3. Roast reframes      (contrarianRoast per reframe — counter-evidence).
 *
 * All artefacts land append-only in innovation_artifacts (N8/N10), every
 * stage verbatim (N1), deterministically parsed (N6), workspace-scoped (N9).
 * Fail-soft at every stage (a malformed LLM response does not topple the run).
 */
export async function runInnovate(
  raw: RawDb,
  args: RunInnovateArgs,
): Promise<RunInnovateResult> {
  const { assumptions } = await extractAssumptions(raw, {
    workspaceId: args.workspaceId,
    rawText: args.rawText,
    callEngine: args.callEngine,
  });

  const { reframes } = await generateReframes(raw, {
    workspaceId: args.workspaceId,
    assumptions,
    callEngine: args.callEngine,
  });

  const roasts: InnovationArtifact[] = [];
  const counterEvidenceSurfaces: string[] = [];
  for (const reframe of reframes) {
    const r = await contrarianRoast(raw, {
      workspaceId: args.workspaceId,
      proposal: reframe.content,
      callEngine: args.callEngine,
    });
    if (r.artifact) roasts.push(r.artifact);
    if (r.surface) counterEvidenceSurfaces.push(r.surface);
  }

  return { assumptions, reframes, roasts, counterEvidenceSurfaces };
}
