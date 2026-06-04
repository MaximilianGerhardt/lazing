/**
 * Phase IN — Innovation-Button-Vertrag.
 *
 * Die Implementation ist bewusst nicht in dieser Session — wir liefern
 * nur Mockup-Page + 501-Skeleton + dokumentierten Vertrag, damit
 * Marketing-Screenshots + Future-Implementation klar sind.
 *
 * Vertrag (Future, Phase IN-Implement nach OSS-Launch):
 *
 *   POST /api/innovate
 *
 *   Request:
 *   {
 *     scope: 'org' | 'workspace' | 'ticket' | 'tickets-list' | 'workstream',
 *     scopeId: string,                      // Org-/Workspace-/Ticket-/Workstream-ID
 *     personas: Array<'ux-analyst' | 'motion-director' | 'design-thinking'
 *                     | 'critic' | 'product-owner'>,
 *     hint?: string                         // Optional: User-Vorgabe
 *                                           // ("ich will mehr Whitespace", "darks first")
 *   }
 *
 *   Response (202 Accepted, sobald implementiert):
 *   {
 *     innovationId: string,                 // ULID — Tracking für Polling
 *     status: 'queued',
 *     pollUrl: '/api/innovate/<innovationId>',
 *     etaSeconds: number                    // grobe Schätzung
 *   }
 *
 *   Workflow (Future):
 *   1. n Designer-Agents spawnen parallel mit aktuellem UI-Snapshot + Brief
 *   2. Jeder schreibt 1 alternative Mockup-Spec (Apple-Keynote-Markdown +
 *      ggf. screenshotbare Komponenten-Specs)
 *   3. Cross-Roast-Phase analog Phase RA — Designs attackieren sich
 *   4. V_final-Mockups in 3-5 Karten an UI zurück
 *   5. User pickt eine, daraus werden Tickets generiert
 *
 *   Heute (501 Not Implemented): Endpoint existiert, dokumentiert den
 *   Vertrag, gibt Future-Phase im Body an.
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
// Phase IN-Implement (Lane D · 2026-05-29 · Opus 4.8) — echte Engine.
//
// Der obige Vertrag (POST /api/innovate, 501-Marketing-Surface, Personas/
// Scopes) bleibt UNVERAENDERT bestehen (app/api/innovate/route.ts + die
// Mockup-Page haengen daran). Was hier FOLGT ist die tatsaechliche, lokal
// aufrufbare Innovation-Engine — der „echte Inhalt" hinter dem Button.
//
// Sie erfuellt §10.2 Mechaniken (Annahmen offenlegen → umkehren → roasten) auf
// BESTEHENDEM Substrat (N4):
//   - assumption-map.ts  (Annahmen, §10.2.3)
//   - reframe.ts         (Reframes,  §10.2.4)
//   - contrarian-roast.ts(Roast,     §10.2.7 — counter-evidence-Surface wie
//                         lib/reasoning/reconcile.ts)
//   - innovation_artifacts (0121, append-only Evidenz, N8/N10)
//
// callEngine ist injizierbar (Test stubt das LLM). Der Haupt-Agent ruft
// runInnovate mit dem $raw-Handle + einem Engine-Adapter auf (Mode-Detection-
// Vorschlag im Lane-D-Bericht).
// ===========================================================================

import { extractAssumptions } from './assumption-map';
import { generateReframes } from './reframe';
import { contrarianRoast } from './contrarian-roast';
import type { InnovationArtifact } from './artifacts-repo';

type RawDb = import('better-sqlite3').Database;

/**
 * Die 8 Innovation-Swarm-Rollen (Master-Briefing §10.3, verbatim N1). Als
 * Daten-Konstante exponiert (analog DIVERSITY_ROLES in
 * lib/agents/diversity-roles.ts), damit der Tier-Spawn / die UI die Rollen
 * deterministisch aufzaehlen kann. Welche Rolle welchen Engine-Call traegt,
 * entscheidet der Orchestrator; runInnovate deckt heute Historian-/First-
 * Principles-/Contrarian-/Critic-Anteile per LLM-Pipeline ab.
 */
export interface InnovationSwarmRole {
  readonly name: string;
  /** Die Leitfrage der Rolle, VERBATIM aus §10.3 (N1). */
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
  /** Der Ist-Zustand / Plan, der durch den Innovation-Mode geht (VERBATIM, N1). */
  readonly rawText: string;
  /** Engine-Adapter (injizierbar; Test stubt das LLM). */
  readonly callEngine: (prompt: string) => Promise<string>;
}

export interface RunInnovateResult {
  readonly assumptions: readonly InnovationArtifact[];
  readonly reframes: readonly InnovationArtifact[];
  /** Ein contrarian-roast je Reframe (nur die mit Gegen-Evidenz). */
  readonly roasts: readonly InnovationArtifact[];
  /**
   * Die counter-evidence-Surface-Strings je geroastetem Reframe (Format wie
   * reconcile.ts). Der Haupt-Agent emittiert sie in den Chat (R5: visuell
   * getrennt, KEIN Antwort-Zwang).
   */
  readonly counterEvidenceSurfaces: readonly string[];
}

/**
 * Der Innovation-Mode-Durchlauf (§10.2 Schritte 3 → 4 → 7):
 *   1. Annahmen offenlegen (extractAssumptions).
 *   2. Annahmen umkehren  (generateReframes).
 *   3. Reframes roasten   (contrarianRoast je Reframe — counter-evidence).
 *
 * Alle Artefakte landen append-only in innovation_artifacts (N8/N10), jede
 * Stufe verbatim (N1), deterministisch geparst (N6), workspace-scoped (N9).
 * Fail-soft auf jeder Stufe (eine malformte LLM-Antwort kippt den Run nicht).
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
