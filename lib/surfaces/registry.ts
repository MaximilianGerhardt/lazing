/**
 * Surface Library · Registry (Flow Studio P4 · 2026-05-27)
 * =======================================================
 * Single-source-of-truth fuer Surface-*Metadaten*. Das Surface-Wissen war
 * bisher verstreut: `lib/chat/surface-parser.ts` (`SURFACE_KINDS`-Array) +
 * `lib/chat/SurfaceRenderer.tsx` (ein `case` je kind) + viele
 * `lib/chat/*Card.tsx`. Es gab KEINE zentrale Beschreibung, was eine Surface
 * eigentlich *ist* — nur, wie sie gerendert wird.
 *
 * Diese Datei ist die „Surface Library" aus
 * `docs/plans/2026-05-27_flow-studio-architecture.md` §4 — REIN ADDITIV:
 *
 *   • KEINE Render-Logik. Importiert NICHTS aus SurfaceRenderer/*Card.
 *   • Aendert NICHTS am Parser, Renderer oder an einer Card.
 *   • Beschreibt jeden `SurfaceKind` mit menschenlesbaren Metadaten
 *     (Kategorie, Label, Beschreibung, Interaktivitaet, Secret-Flag).
 *
 * Vollstaendigkeit ist *compile-time* erzwungen: `SURFACE_LIBRARY` ist ein
 * `Record<SurfaceKind, SurfaceMeta>`. Fehlt EIN Kind, bricht `tsc`. Genau
 * das ist gewollt — neue Surface-Kinds koennen nicht still durchrutschen,
 * ohne dass die Library sie kennt.
 *
 * Security-Doku (N2/ACL5): Secret-tragende Surfaces (`credential-request`,
 * `connector-call-preview`, `credential-prompt`, `prompt` mit
 * variant=credential) tragen NIE ein Secret im Chat/SSE/Ledger. Das
 * `emitsSecret`-Flag dokumentiert diese Invariante explizit als `false` —
 * es ist KEINE Erlaubnis, jemals Secrets zu emittieren, sondern eine
 * verifizierbare Aussage „diese Surface fuehrt eine Secret-Interaktion,
 * aber das Secret verlaesst niemals den Out-of-Chat-Pfad".
 */

import { SURFACE_KINDS, type SurfaceKind } from '../chat/surface-parser';

/**
 * Surface-Kategorien (Flow Studio P4 §4). Grobe fachliche Einordnung — KEINE
 * Render-Achse, sondern „wozu dient die Surface im Flow":
 *
 *   progress  — laufende, mehrstufige Vorgaenge mit Fortschritt (Pipelines,
 *               Loops, Swarm-Phasen).
 *   prompt    — fordert eine Entscheidung/Eingabe vom User (Form, Decision,
 *               Open-Questions, Permission/Credential-Eingabe).
 *   tool      — Tool-/Connector-Aufruf-Vorschau & -Kopplung.
 *   media     — eingebettete Medien (reserviert fuer P5: imagegen2/Higgsfield/
 *               Heygen-Ausgaben).
 *   status    — Zustands-/Ereignis-Anzeige ohne User-Aktion (Toast,
 *               Milestone, Heartbeat, Preview-Link).
 *   flow      — Flow-/Plan-Topologie (Flow-Graph, Subplan, Sub-Workstreams).
 *   data      — Daten-/Datei-Artefakte (Dokumente, Ordner, Cloud-Browser,
 *               Charts, Tickets, Rechnungen).
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
 * R7 Lifecycle-Phasen (Surface-Manifestation-Strategie §9 „Every Surface has
 * a lifecycle"). Beschreibt die *möglichen* Zustände, die eine Surface über
 * ihre Lebensdauer einnehmen kann — NICHT den aktuellen Zustand einer
 * konkreten Instanz (der lebt in der Payload). Das `lifecycle`-Feld in
 * `SurfaceMeta` ist additiv und dokumentiert, welche dieser Zustände eine
 * Surface-Klasse überhaupt erreichen kann:
 *
 *   created     — gerade emittiert, noch ohne weitere Veränderung.
 *   updated     — coord-upsert hat dieselbe Card aktualisiert.
 *   needs-input — wartet auf eine User-Entscheidung/-Eingabe (Human-Gate).
 *   resolved    — abgeschlossen / bestätigt / gemergt (Endzustand „erledigt").
 *   archived    — durch einen Peer verdrängt / in die Artifact-Rail gewandert.
 *   superseded  — durch eine neuere Wahrheit ersetzt (Belief/Decision-Update).
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
 * Metadaten-Beschreibung einer einzelnen Surface. Bewusst klein gehalten —
 * keine Render-Props, kein Schema-Validator (das bleibt bei Parser/Card).
 */
export interface SurfaceMeta {
  /** Der kanonische SurfaceKind aus `surface-parser` SURFACE_KINDS. */
  kind: SurfaceKind;
  /** Fachliche Einordnung im Flow. */
  category: SurfaceCategory;
  /** Menschenlesbarer Anzeigename (Katalog / Flow-Studio-Palette). */
  label: string;
  /** Wofuer die Surface da ist — eine knappe Beschreibung. */
  description: string;
  /** Hat der User echte Aktionen (Buttons/Inputs/Approve)? */
  interactive: boolean;
  /**
   * Doku-Flag: Surfaces, die eine Secret-Interaktion (Credential-Eingabe/
   * -Vorschau) ANSTOSSEN, tragen das Secret NIE im Chat-Payload. Immer
   * `false` (oder weggelassen). Niemals `true` — der Typ laesst nur `false`
   * zu, damit kein Build jemals eine Secret-Emission ueber Chat zusagt.
   */
  emitsSecret?: false;
  /**
   * R7 (Surface-Manifestation-Strategie §9) — die Lifecycle-Phasen, die diese
   * Surface-Klasse überhaupt durchlaufen kann. ADDITIV + optional: fehlt das
   * Feld, gilt der minimale Default `['created']` (rein anzeige-orientiert).
   * Genutzt von Coord-Upsert / Artifact-Rail, um zu wissen, ob eine Surface
   * jemals `resolved`/`superseded` werden kann (z.B. merge-offer →resolved,
   * project-truth →updated/superseded). KEINE Render-Achse; reine Metadaten.
   */
  lifecycle?: readonly SurfaceLifecyclePhase[];
}

/**
 * Das Registry. `Record<SurfaceKind, SurfaceMeta>` erzwingt Vollstaendigkeit
 * zur Compile-Zeit: fehlt ein Kind aus SURFACE_KINDS, schlaegt `tsc` fehl.
 */
export const SURFACE_LIBRARY: Record<SurfaceKind, SurfaceMeta> = {
  // --- data: Daten-/Artefakt-Surfaces ------------------------------------
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

  // --- progress: laufende mehrstufige Vorgaenge --------------------------
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

  // --- prompt: fordert User-Entscheidung/-Eingabe -----------------------
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

  // --- tool: Tool-/Connector-Kopplung -----------------------------------
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

  // --- flow: Flow-/Plan-Topologie ---------------------------------------
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

  // --- agent/swarm: parallele Agent-Laeufe ------------------------------
  // (kategorisiert als progress — mehrstufige laufende Vorgaenge)
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

  // --- iterate-family: Roast/Version/Correction -------------------------
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

  // --- status: Zustands-/Ereignis-Anzeige -------------------------------
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
  // Owner-Fix Run-Cockpit (2026-05-28) — Master-Cockpit-Surface, die die
  // bisherigen 3 simultanen Emit-Stellen (sub-workstreams + iterate-pipeline
  // + iterate-version) zu EINER verfolgbaren Card aggregiert. Phase-Stepper
  // (Decompose → Tier-Spawn → Lead → Roaster → Consensus → Done), Sub-WS-
  // Liste collapsed-default, „nächste Phase"-Hint, Token/Cost-Counter. Die
  // 3 alten Cards bleiben emittiert (Back-Compat), werden aber im Renderer
  // suppressed, sobald eine run-cockpit-Surface für denselben Workstream
  // aktiv ist. SECURITY: kein Secret in der Payload.
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
  // Slice C (2026-05-29) — Discovery-Phase VOR Plan-Decompose. Eine Card pro
  // Workstream (subKey='discovery'), idempotent pre-emit „running" +
  // post-emit „done". Listet vom Owner referenzierte URLs (fail-soft
  // gefetcht, mit Title + Snapshot) und vom Owner angekündigte Dokumente,
  // die das System gezielt anfordern sollte. Status-Surface aus der Sicht
  // des Flows („vor der Tier-Wahl"), interaktiv nur für Doku-Anforderungen.
  // SECURITY: kein Secret in der Payload — WebFetch zielt nur auf vom Owner
  // explizit genannte öffentliche URLs (N2: kein cross-workspace-Read, keine
  // Audit-Row für reguläre Public-URLs).
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
  // A4 (2026-05-29) — Merge-Offer-Surface (klickbarer Operator-Merge-Gate).
  // EINZIGE Schreib-Aktion: „In Live mergen" → POST /api/workstreams/[id]/
  // merge-run {} (R3 Human-Gate). „Diff ansehen" ist read-only (preview:true).
  // SECURITY: kein Secret in der Payload.
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
  // A3/R7 (2026-05-29) — Project-Truth-Surface (langlebiger Lese-Anker).
  // EINE Card pro Workspace (subKey='project-truth'), bündelt Vision/Decisions/
  // Beliefs/Open-Unknowns/Widersprüche ÜBER Runs hinweg. NICHT-interaktiv.
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
 * Liefert die Metadaten fuer einen kind-String oder `null`, wenn der String
 * kein bekannter SurfaceKind ist. Tolerant gegenueber beliebigem Input
 * (z.B. halluzinierte Tags) — wirft nie.
 */
export function getSurfaceMeta(kind: string): SurfaceMeta | null {
  return Object.prototype.hasOwnProperty.call(SURFACE_LIBRARY, kind)
    ? SURFACE_LIBRARY[kind as SurfaceKind]
    : null;
}

/**
 * Alle Surfaces einer Kategorie. Reihenfolge entspricht SURFACE_KINDS
 * (kanonische Parser-Reihenfolge), damit der Output stabil ist.
 */
export function listSurfacesByCategory(cat: SurfaceCategory): SurfaceMeta[] {
  return SURFACE_KINDS.map((k) => SURFACE_LIBRARY[k]).filter(
    (m) => m.category === cat,
  );
}

/** Alle Metadaten in kanonischer SURFACE_KINDS-Reihenfolge. */
export function listAllSurfaces(): SurfaceMeta[] {
  return SURFACE_KINDS.map((k) => SURFACE_LIBRARY[k]);
}
