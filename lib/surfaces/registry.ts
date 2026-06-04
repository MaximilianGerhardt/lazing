/**
 * Surface Library · Registry (Flow Studio P4 · 2026-05-27)
 * =======================================================
 * Single source of truth for surface *metadata*. Surface knowledge was
 * scattered until now: `lib/chat/surface-parser.ts` (`SURFACE_KINDS` array) +
 * `lib/chat/SurfaceRenderer.tsx` (one `case` per kind) + many
 * `lib/chat/*Card.tsx`. There was NO central description of what a surface
 * actually *is* — only how it is rendered.
 *
 * This file is the "Surface Library" from
 * `docs/plans/2026-05-27_flow-studio-architecture.md` §4 — PURELY ADDITIVE:
 *
 *   • NO render logic. Imports NOTHING from SurfaceRenderer/*Card.
 *   • Changes NOTHING in the parser, renderer or any card.
 *   • Describes each `SurfaceKind` with human-readable metadata
 *     (category, label, description, interactivity, secret flag).
 *
 * Completeness is enforced at *compile-time*: `SURFACE_LIBRARY` is a
 * `Record<SurfaceKind, SurfaceMeta>`. If ONE kind is missing, `tsc` breaks. That
 * is exactly the intent — new surface kinds cannot slip through silently
 * without the library knowing them.
 *
 * Security docs (N2/ACL5): secret-carrying surfaces (`credential-request`,
 * `connector-call-preview`, `credential-prompt`, `prompt` with
 * variant=credential) NEVER carry a secret in the chat/SSE/ledger. The
 * `emitsSecret` flag documents this invariant explicitly as `false` —
 * it is NOT a permission to ever emit secrets, but a
 * verifiable statement "this surface drives a secret interaction,
 * but the secret never leaves the out-of-chat path".
 */

import { SURFACE_KINDS, type SurfaceKind } from '../chat/surface-parser';

/**
 * Surface categories (Flow Studio P4 §4). Coarse domain classification — NO
 * render axis, but "what the surface is for in the flow":
 *
 *   progress  — ongoing, multi-step operations with progress (pipelines,
 *               loops, swarm phases).
 *   prompt    — demands a decision/input from the user (form, decision,
 *               open-questions, permission/credential entry).
 *   tool      — tool/connector call preview & coupling.
 *   media     — embedded media (reserved for P5: imagegen2/Higgsfield/
 *               Heygen outputs).
 *   status    — state/event display without a user action (toast,
 *               milestone, heartbeat, preview link).
 *   flow      — flow/plan topology (flow graph, subplan, sub-workstreams).
 *   data      — data/file artifacts (documents, folders, cloud browser,
 *               charts, tickets, invoices).
 */
export type SurfaceCategory =
  | 'progress'
  | 'prompt'
  | 'tool'
  | 'media'
  | 'status'
  | 'flow'
  | 'data';

export const SURFACE_CATEGORIES: readonly SurfaceCategory[] = [
  'progress',
  'prompt',
  'tool',
  'media',
  'status',
  'flow',
  'data',
] as const;

/**
 * R7 lifecycle phases (Surface Manifestation Strategy §9 "Every Surface has
 * a lifecycle"). Describes the *possible* states a surface can take over
 * its lifetime — NOT the current state of a
 * concrete instance (that lives in the payload). The `lifecycle` field in
 * `SurfaceMeta` is additive and documents which of these states a
 * surface class can ever reach:
 *
 *   created     — just emitted, still without any further change.
 *   updated     — coord-upsert updated the same card.
 *   needs-input — waiting for a user decision/input (human gate).
 *   resolved    — completed / confirmed / merged (end state "done").
 *   archived    — displaced by a peer / moved into the artifact rail.
 *   superseded  — replaced by a newer truth (belief/decision update).
 */
export type SurfaceLifecyclePhase =
  | 'created'
  | 'updated'
  | 'needs-input'
  | 'resolved'
  | 'archived'
  | 'superseded';

export const SURFACE_LIFECYCLE_PHASES: readonly SurfaceLifecyclePhase[] = [
  'created',
  'updated',
  'needs-input',
  'resolved',
  'archived',
  'superseded',
] as const;

/**
 * Metadata description of a single surface. Deliberately kept small —
 * no render props, no schema validator (that stays with parser/card).
 */
export interface SurfaceMeta {
  /** The canonical SurfaceKind from `surface-parser` SURFACE_KINDS. */
  kind: SurfaceKind;
  /** Domain classification in the flow. */
  category: SurfaceCategory;
  /** Human-readable display name (catalog / Flow Studio palette). */
  label: string;
  /** What the surface is for — a brief description. */
  description: string;
  /** Does the user have real actions (buttons/inputs/approve)? */
  interactive: boolean;
  /**
   * Docs flag: surfaces that TRIGGER a secret interaction (credential entry/
   * preview) NEVER carry the secret in the chat payload. Always
   * `false` (or omitted). Never `true` — the type only allows `false`,
   * so no build ever promises a secret emission over chat.
   */
  emitsSecret?: false;
  /**
   * R7 (Surface Manifestation Strategy §9) — the lifecycle phases this
   * surface class can ever go through. ADDITIVE + optional: if the
   * field is missing, the minimal default `['created']` applies (purely display-oriented).
   * Used by coord-upsert / artifact-rail to know whether a surface
   * can ever become `resolved`/`superseded` (e.g. merge-offer →resolved,
   * project-truth →updated/superseded). NO render axis; pure metadata.
   */
  lifecycle?: readonly SurfaceLifecyclePhase[];
}

/**
 * The registry. `Record<SurfaceKind, SurfaceMeta>` enforces completeness
 * at compile time: if a kind from SURFACE_KINDS is missing, `tsc` fails.
 */
export const SURFACE_LIBRARY: Record<SurfaceKind, SurfaceMeta> = {
  // --- data: data/artifact surfaces ------------------------------------
  chart: {
    kind: 'chart',
    category: 'data',
    label: 'Chart',
    description: 'Eingebettetes Diagramm (Titel, Wert, Datenreihe).',
    interactive: false,
  },
  ticket: {
    kind: 'ticket',
    category: 'data',
    label: 'Ticket',
    description: 'Ticket-Karte mit ID, Titel und Status.',
    interactive: false,
  },
  invoice: {
    kind: 'invoice',
    category: 'data',
    label: 'Rechnung',
    description: 'Rechnungs-Karte mit Nummer, Titel und Gesamtbetrag.',
    interactive: false,
  },
  document: {
    kind: 'document',
    category: 'data',
    label: 'Dokument',
    description: 'Einzelnes Workspace-Cloud-Dokument.',
    interactive: false,
  },
  folder: {
    kind: 'folder',
    category: 'data',
    label: 'Ordner',
    description: 'Workspace-Cloud-Ordner als Container-Karte.',
    interactive: false,
  },
  'cloud-browser': {
    kind: 'cloud-browser',
    category: 'data',
    label: 'Cloud-Browser',
    description: 'Navigierbare Workspace-Cloud-Dateiansicht.',
    interactive: true,
  },

  // --- progress: ongoing multi-step operations --------------------------
  pipeline: {
    kind: 'pipeline',
    category: 'progress',
    label: 'Pipeline',
    description: 'Schritt-Liste mit Status je Schritt (legacy, → workflow).',
    interactive: false,
  },
  'live-pipeline': {
    kind: 'live-pipeline',
    category: 'progress',
    label: 'Live-Pipeline',
    description: 'Live-aktualisierte Pipeline-Schritte (legacy, → workflow).',
    interactive: false,
  },
  'workflow-pipeline': {
    kind: 'workflow-pipeline',
    category: 'progress',
    label: 'Workflow-Pipeline',
    description: 'Workflow-orientierte Pipeline (legacy, → workflow).',
    interactive: false,
  },
  'iterate-pipeline': {
    kind: 'iterate-pipeline',
    category: 'progress',
    label: 'Iterate-Pipeline',
    description: 'Iterations-Pipeline (Sub-Plan 04 Welle 2; legacy, → workflow).',
    interactive: false,
  },
  workflow: {
    kind: 'workflow',
    category: 'progress',
    label: 'Workflow',
    description:
      'Kanonische Pipeline-Surface (Phase-State: intake|plan|dispatch|' +
      'execute|iterate|review|done). Loest die Pipeline-Family ab.',
    interactive: false,
  },
  'loop-phase': {
    kind: 'loop-phase',
    category: 'progress',
    label: 'Loop-Phase',
    description: 'Demo Fitness-/Coding-Loop-Phasen-Ereignis (Welle 7).',
    interactive: false,
  },
  'consensus-action': {
    kind: 'consensus-action',
    category: 'progress',
    label: 'Konsens-Aktion',
    description: 'Schritt einer Schwarm-Konsens-Synthese.',
    interactive: false,
  },
  'rate-limit-retry': {
    kind: 'rate-limit-retry',
    category: 'progress',
    label: 'Rate-Limit-Retry',
    description: 'Backoff-/Retry-Fortschritt bei Rate-Limit (Phase RL.2).',
    interactive: false,
  },
  'onboarding-progress': {
    kind: 'onboarding-progress',
    category: 'progress',
    label: 'Onboarding-Fortschritt',
    description:
      'Fortschritt des Connector-Onboarding-Laufs (SOP→Plan-Dispatch). ' +
      'Traegt nur Plan-Metadaten, kein Secret.',
    interactive: false,
    emitsSecret: false,
  },

  // --- prompt: demands a user decision/input -----------------------
  decision: {
    kind: 'decision',
    category: 'prompt',
    label: 'Entscheidung',
    description: 'Entscheidungs-Karte mit Headline und Optionen.',
    interactive: true,
  },
  quickchoice: {
    kind: 'quickchoice',
    category: 'prompt',
    label: 'Quick-Choice',
    description: 'Schnellauswahl-Buttons fuer eine Frage.',
    interactive: true,
  },
  approval: {
    kind: 'approval',
    category: 'prompt',
    label: 'Freigabe',
    description: 'Approve/Decline-Karte fuer eine vorgeschlagene Aktion.',
    interactive: true,
  },
  'tier-choice': {
    kind: 'tier-choice',
    category: 'prompt',
    label: 'Tier-Wahl',
    description: 'Auswahl der Modell-/Aufwands-Stufe fuer einen Lauf.',
    interactive: true,
  },
  form: {
    kind: 'form',
    category: 'prompt',
    label: 'Formular',
    description:
      'Generisches strukturiertes Eingabe-Formular (Org-Daten, Briefing, ' +
      'schema-getragener Patch-API-Call). Legacy, → prompt(variant=form).',
    interactive: true,
  },
  'open-questions': {
    kind: 'open-questions',
    category: 'prompt',
    label: 'Offene Fragen',
    description:
      'Open-Questions-Karte mit QuickChoice-Buttons (Sub-Plan D; legacy, ' +
      '→ prompt(variant=open-questions)).',
    interactive: true,
  },
  'plan-open-questions': {
    kind: 'plan-open-questions',
    category: 'prompt',
    label: 'Plan-Fragen',
    description:
      'Plan-Open-Questions-Karte als persistenter QuickChoice-Anker ' +
      '(legacy, → prompt(variant=plan-questions)).',
    interactive: true,
  },
  prompt: {
    kind: 'prompt',
    category: 'prompt',
    label: 'Prompt',
    description:
      'Kanonische Prompt-Surface (variant: form|credential|open-questions|' +
      'plan-questions|quickchoice|decision). Loest die Prompt-Family ab.',
    interactive: true,
  },
  'credential-prompt': {
    kind: 'credential-prompt',
    category: 'prompt',
    label: 'Credential-Prompt',
    description:
      'Aeltere Credential-Eingabe-Karte. Secret verlaesst NIE den ' +
      'Out-of-Chat-Pfad (legacy, → prompt(variant=credential)).',
    interactive: true,
    emitsSecret: false,
  },
  'credential-request': {
    kind: 'credential-request',
    category: 'prompt',
    label: 'Credential-Anfrage',
    description:
      'Out-of-Chat Credential-Eingabe (ACL5-B). Payload traegt nur ' +
      'provider/scope/why — das Secret geht AUSSCHLIESSLICH per POST an ' +
      '/api/connectors/[provider]/credential, NIE in Chat/SSE/Ledger.',
    interactive: true,
    emitsSecret: false,
  },
  'permission-setup': {
    kind: 'permission-setup',
    category: 'prompt',
    label: 'Permission-Setup',
    description:
      'Einmalige Agent-Modus-Wahl (freerein|lane|ask) je Workspace (A1). ' +
      'PATCH auf /api/permission/[workspaceId]/mode ist auth-gated.',
    interactive: true,
    emitsSecret: false,
  },

  // --- tool: tool/connector coupling -----------------------------------
  terminal: {
    kind: 'terminal',
    category: 'tool',
    label: 'Terminal',
    description: 'Terminal-/Shell-Ausgabe eines Tool-Laufs.',
    interactive: false,
  },
  'connector-call-preview': {
    kind: 'connector-call-preview',
    category: 'tool',
    label: 'Connector-Call-Preview',
    description:
      'S5-Vorschau eines Connector-Aufrufs mit Approve-Action (ACL5-E). ' +
      'PayloadSummary = Keys+Typen (keine Werte), credentialPreview ' +
      'maskiert. Kein Secret-Feld in der Payload.',
    interactive: true,
    emitsSecret: false,
  },

  // --- flow: flow/plan topology ---------------------------------------
  'flow-graph': {
    kind: 'flow-graph',
    category: 'flow',
    label: 'Flow-Graph',
    description:
      'Visueller DAG aus Skill/Tool-Nodes (custom-SVG, Flow Studio P3). ' +
      'Topologisches Schicht-Layout + SVG-Edges + Status-Dots, mobil-tauglich. ' +
      'Nodes tappbar → Detail-Panel (label/skill/tool/status, koppeln-Hinweis).',
    interactive: true,
  },
  'flow-recurrence': {
    kind: 'flow-recurrence',
    category: 'flow',
    label: 'Workflow-Wiederholung',
    description:
      'Self-Learning-Nudge (Slice 1): erkennt der Detektor, dass dieser Ablauf ' +
      'strukturell schon ≥3× so lief, schlägt diese Karte vor, ihn als ' +
      'wiederverwendbaren Workflow zu speichern (C3-Pfad, Owner-gated, kein Auto-Save).',
    interactive: true,
  },
  'image-gen': {
    kind: 'image-gen',
    category: 'media',
    label: 'Bild-Generierung',
    description:
      'Selbst-fahrendes, animiertes Lade-Surface für Bild-Generierung (Codex/' +
      'ImageGen2). Erscheint sofort, startet den async Job, pollt den Status, ' +
      'swappt das fertige Bild ein (wie Codex/ChatGPT). Bei Fehler → Retry inline.',
    interactive: true,
  },
  'flow-coupling': {
    kind: 'flow-coupling',
    category: 'flow',
    label: 'Tool-Kopplung',
    description:
      'Tool-Kopplungs-Surface (Flow Studio P-now): pro ungekoppeltem Tool eine ' +
      'Zeile mit „Koppeln" (öffnet die bestehende Credential-Eingabe, ACL5-B) ' +
      'plus „Flow starten" → POST /api/flow/[flowId]/run. SECURITY: kein Secret ' +
      'in der Payload; Secret nur via POST /api/connectors/[provider]/credential.',
    interactive: true,
    emitsSecret: false,
  },
  'live-warn': {
    kind: 'live-warn',
    category: 'flow',
    label: 'LIVE-Mode-Warnung',
    description:
      'Einmaliger LIVE-Mode-Warn-Surface (Stream X1, 2026-05-28). Erscheint pro ' +
      'Workspace nur beim ersten LIVE-Lauf (LAZYOS_CONNECTOR_LIVE=on UND noch nicht ' +
      'in workspace_beliefs/topic=live-warn-acked quittiert). Owner-Entscheidung ' +
      'wird via POST /api/workspaces/[id]/live-warn-ack persistiert. SECURITY: kein ' +
      'Secret in der Payload — nur { workspaceId }.',
    interactive: true,
    emitsSecret: false,
  },
  subplan: {
    kind: 'subplan',
    category: 'flow',
    label: 'Subplan',
    description:
      'ProposedPlan-Karte mit Approve/Edit/Decline; collapse-to-pill bei ' +
      'depth >= 2 (Plan-First V2, BACKPORT-03).',
    interactive: true,
  },
  'sub-workstreams': {
    kind: 'sub-workstreams',
    category: 'flow',
    label: 'Sub-Workstreams',
    description: 'Sub-Workstreams als first-class Entity (Sprint C).',
    interactive: false,
  },

  // --- agent/swarm: parallel agent runs ------------------------------
  // (categorized as progress — multi-step ongoing operations)
  agent: {
    kind: 'agent',
    category: 'progress',
    label: 'Agent',
    description: 'Status eines einzelnen Agent-Laufs.',
    interactive: false,
  },
  swarm: {
    kind: 'swarm',
    category: 'progress',
    label: 'Swarm',
    description: 'Uebersicht eines Multi-Agent-Schwarms.',
    interactive: false,
  },
  'live-swarm': {
    kind: 'live-swarm',
    category: 'progress',
    label: 'Live-Swarm',
    description: 'Live-aktualisierter Schwarm-Lauf.',
    interactive: false,
  },
  'bug-fix-swarm': {
    kind: 'bug-fix-swarm',
    category: 'progress',
    label: 'Bug-Fix-Swarm',
    description:
      '3 parallele Diagnose-Spawns (senior-dev + code-reviewer + critic) ' +
      'mit Konsens-Synthese + Fix-Spawn (Sprint H).',
    interactive: false,
  },
  'bug-fix-pipeline': {
    kind: 'bug-fix-pipeline',
    category: 'progress',
    label: 'Bug-Fix-Pipeline',
    description: '3-Tier-Roaster-Pipeline (Plan + Critic + Fix), 8 Phasen.',
    interactive: false,
  },
  'agent-step': {
    kind: 'agent-step',
    category: 'progress',
    label: 'Agent-Step',
    description:
      'Kanonische Tool/Step-Surface (mode: agent|swarm|live-swarm|' +
      'bug-fix-swarm|loop-phase|tier-choice). Loest die Tool/Step-Family ab.',
    interactive: false,
  },
  'subagent-fleet': {
    kind: 'subagent-fleet',
    category: 'progress',
    label: 'Subagent-Fleet',
    description:
      'Bis zu 5 parallele Subagent-Panes mit Status-Pills, Abort- und ' +
      'Diff-Buttons (BACKPORT-02).',
    interactive: true,
  },

  // --- iterate-family: roast/version/correction -------------------------
  'iterate-roast': {
    kind: 'iterate-roast',
    category: 'progress',
    label: 'Iterate-Roast',
    description: '4-5 Roaster-Rollen mit Avatars, einer pro roasterIdx.',
    interactive: false,
  },
  'iterate-version': {
    kind: 'iterate-version',
    category: 'progress',
    label: 'Iterate-Version',
    description: 'V1→V2→V3 Version-Diff mit Headline + Diff-Snippet je Version.',
    interactive: false,
  },
  'user-correction': {
    kind: 'user-correction',
    category: 'status',
    label: 'User-Korrektur',
    description: 'Anzeige eines User-Inject waehrend einer Sniper-Pause.',
    interactive: false,
  },

  // --- status: state/event display -------------------------------
  toast: {
    kind: 'toast',
    category: 'status',
    label: 'Toast',
    description: 'Kurze, fluechtige Status-Meldung.',
    interactive: false,
  },
  milestone: {
    kind: 'milestone',
    category: 'status',
    label: 'Meilenstein',
    description: 'Erreichter Meilenstein in einem Lauf.',
    interactive: false,
  },
  heartbeat: {
    kind: 'heartbeat',
    category: 'status',
    label: 'Heartbeat',
    description: 'Workstream-Heartbeat / Lebenszeichen eines laufenden Streams.',
    interactive: false,
  },
  workspace: {
    kind: 'workspace',
    category: 'status',
    label: 'Workspace',
    description: 'Workspace-Uebersichts-Karte.',
    interactive: false,
  },
  routine: {
    kind: 'routine',
    category: 'status',
    label: 'Routine',
    description: 'Geplante/wiederkehrende Routine-Anzeige.',
    interactive: false,
  },
  preview: {
    kind: 'preview',
    category: 'status',
    label: 'Preview',
    description:
      'Fertigstellungs-Surface mit tippbarem (Tailscale-)URL, damit Builds ' +
      'direkt am Handy testbar sind (2026-05-27).',
    interactive: true,
  },
  'counter-evidence': {
    kind: 'counter-evidence',
    category: 'status',
    label: 'Gegen-Evidenz',
    description:
      'Devil\'s-Advocate-Falsifikations-Pass (P13, Anti-Confirmation-Bias): ' +
      'eigene Card NACH der Synthesis (gated auf consensus „strong" ODER ' +
      'WHY-Einspeisung), NICHT in den Synthesis-Stream gemischt. Listet ' +
      'widerlegende Beobachtungen; rotes Flag wenn die These nicht ' +
      'falsifizierbar ist. SECURITY: kein Secret in der Payload.',
    interactive: false,
    emitsSecret: false,
  },
  // Owner-fix run-cockpit (2026-05-28) — master cockpit surface that
  // aggregates the previous 3 simultaneous emit sites (sub-workstreams + iterate-pipeline
  // + iterate-version) into ONE trackable card. Phase stepper
  // (Decompose → Tier-Spawn → Lead → Roaster → Consensus → Done), sub-WS
  // list collapsed-default, "next phase" hint, token/cost counter. The
  // 3 old cards remain emitted (back-compat), but are
  // suppressed in the renderer as soon as a run-cockpit surface for the same workstream
  // is active. SECURITY: no secret in the payload.
  'run-cockpit': {
    kind: 'run-cockpit',
    category: 'progress',
    label: 'Run-Cockpit',
    description:
      'Aggregierte Master-Surface eines Tier-/Iterate-Laufs: Phase-Stepper ' +
      '(Decompose → Tier-Spawn → Lead → Roaster → Consensus → Done), Sub-' +
      'Workstream-Liste collapsed-default, „nächste Phase"-Hint und Token/' +
      'Cost-Counter. Ersetzt die simultane Emission von sub-workstreams + ' +
      'iterate-pipeline + iterate-version als ein einziger verfolgbarer Flow.',
    interactive: true,
    emitsSecret: false,
  },
  // Slice C (2026-05-29) — discovery phase BEFORE plan-decompose. One card per
  // workstream (subKey='discovery'), idempotent pre-emit "running" +
  // post-emit "done". Lists owner-referenced URLs (fail-soft
  // fetched, with title + snapshot) and owner-announced documents
  // that the system should specifically request. Status surface from the flow's
  // perspective ("before the tier choice"), interactive only for doc requests.
  // SECURITY: no secret in the payload — WebFetch targets only owner-
  // explicitly-named public URLs (N2: no cross-workspace read, no
  // audit row for regular public URLs).
  discovery: {
    kind: 'discovery',
    category: 'status',
    label: 'Discovery',
    description:
      'Recherche-Vorphase VOR dem Plan-Decompose: extrahiert URLs/Domains/' +
      'Doku-Mentions aus dem Owner-Prompt, fetcht die URLs fail-soft (max 8 ' +
      'parallel, 12s je URL) und listet das Ergebnis (Title + Snapshot oder ' +
      'fail-Hinweis). Erscheint VOR der Tier-Wahl-Karte; eine Card pro ' +
      'Workstream (subKey=\'discovery\', idempotent). Kein Secret in der Payload.',
    interactive: true,
    emitsSecret: false,
    lifecycle: ['created', 'updated', 'resolved'],
  },
  // A4 (2026-05-29) — merge-offer surface (clickable operator merge gate).
  // ONLY write action: "merge into Live" → POST /api/workstreams/[id]/
  // merge-run {} (R3 human gate). "view diff" is read-only (preview:true).
  // SECURITY: no secret in the payload.
  'merge-offer': {
    kind: 'merge-offer',
    category: 'prompt',
    label: 'Merge-Offer',
    description:
      'Klickbarer Operator-Merge-Gate (A4): zeigt die fertige Run-Branch-Arbeit ' +
      '(N Dateien) und bietet „Diff ansehen" (read-only preview) + „In Live ' +
      'mergen" (die EINZIGE Schreib-Aktion, POST /api/workstreams/[id]/merge-run) ' +
      '+ „Verwerfen" (rein lokal). Nach erfolgreichem Merge → resolved. Kein ' +
      'Secret in der Payload — nur Run-/Datei-Metadaten.',
    interactive: true,
    emitsSecret: false,
    lifecycle: ['created', 'needs-input', 'resolved', 'archived'],
  },
  // A3/R7 (2026-05-29) — project-truth surface (long-lived read anchor).
  // ONE card per workspace (subKey='project-truth'), bundles vision/decisions/
  // beliefs/open-unknowns/contradictions ACROSS runs. NON-interactive.
  'project-truth': {
    kind: 'project-truth',
    category: 'flow',
    label: 'Projekt-Wahrheit',
    description:
      'Langlebiger Lese-Anker (Surface-Manifestation-Strategie §7.2): bündelt ' +
      'die gesicherte Projektwahrheit ÜBER Runs hinweg — Vision, Decisions, ' +
      'Beliefs, Open-Unknowns und Widersprüche. EINE Card pro Workspace ' +
      '(subKey=\'project-truth\', idempotent), collapsibel. Lese-Anker, daher ' +
      'NICHT interaktiv. Kein Secret in der Payload.',
    interactive: false,
    emitsSecret: false,
    lifecycle: ['created', 'updated', 'superseded'],
  },
};

/**
 * Returns the metadata for a kind string or `null` if the string
 * is not a known SurfaceKind. Tolerant of arbitrary input
 * (e.g. hallucinated tags) — never throws.
 */
export function getSurfaceMeta(kind: string): SurfaceMeta | null {
  return Object.prototype.hasOwnProperty.call(SURFACE_LIBRARY, kind)
    ? SURFACE_LIBRARY[kind as SurfaceKind]
    : null;
}

/**
 * All surfaces of a category. Order matches SURFACE_KINDS
 * (canonical parser order), so the output is stable.
 */
export function listSurfacesByCategory(cat: SurfaceCategory): SurfaceMeta[] {
  return SURFACE_KINDS.map((k) => SURFACE_LIBRARY[k]).filter(
    (m) => m.category === cat,
  );
}

/** All metadata in canonical SURFACE_KINDS order. */
export function listAllSurfaces(): SurfaceMeta[] {
  return SURFACE_KINDS.map((k) => SURFACE_LIBRARY[k]);
}
