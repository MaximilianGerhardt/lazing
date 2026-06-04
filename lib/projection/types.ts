/**
 * Phase 1 Track E — State-Projection-Spine.
 *
 * Diese Typen definieren das Schema des operativen Workspace-Zustandes,
 * den `projectWorkspaceState` aus den DB-Truth-Tabellen ableitet
 * (Workstreams · FlowRuns · Plan-Steps · Events · question_answers).
 *
 * VERTRAG (verbatim aus Befund D §10):
 *   - Quelle der Wahrheit: DB/Event-State, NICHT sichtbare Chat-Surfaces.
 *   - Alte Surfaces im Verlauf bleiben Historie; sie blockieren niemals
 *     den aktuellen Run und sind kein State-Beweis.
 *   - Nach Reload muss der aktuelle operative Zustand exakt aus diesen
 *     Feldern rekonstruierbar sein.
 *
 * Diese Datei ist rein deklarativ — KEINE Imports, KEINE Implementierung.
 */

/**
 * Status eines aktiven FlowRuns.
 *
 * Vokabular ist absichtlich klein und disjunkt:
 *   - `pending` — flow_run angelegt, noch nicht gestartet
 *   - `running` — Steps laufen (mindestens einer active)
 *   - `needs-coupling` — ein Gate (z.B. Coupling-Choice) blockiert Fortschritt
 *   - `needs-style-choice` — ein Gate fragt nach Style-Wahl
 *   - `done`     — alle Steps erfolgreich abgeschlossen
 *   - `failed`   — Fehler im aktuellen Run
 *
 * Mapping in `state-projector.ts`:
 *   - flow_runs.status='pending'   → 'pending'
 *   - flow_runs.status='running'   → 'running' | 'needs-coupling' | 'needs-style-choice'
 *     (Verfeinerung via Gate-Suche)
 *   - flow_runs.status='done'      → 'done'
 *   - flow_runs.status='failed'    → 'failed'
 *   - flow_runs.status='cancelled' → 'failed'
 */
export type ActiveFlowRunStatus =
  | 'pending'
  | 'running'
  | 'needs-coupling'
  | 'needs-style-choice'
  | 'done'
  | 'failed';

export interface ActiveFlowRunState {
  flowRunId: string;
  /** Brücke zum tier-orchestrator. */
  workstreamId: string;
  status: ActiveFlowRunStatus;
  /** Phase aus run-cockpit-Vokabular — optional, abgeleitet aus aktivem Step-Title. */
  currentPhase?: string;
  /** ms epoch — flow_runs.created_at. */
  startedAt: number;
  /** ms epoch — max(flow_runs.updated_at, jüngster Step-Update). */
  lastEventAt: number;
}

export interface ActiveWorkstreamState {
  workstreamId: string;
  /** parent_workstream_id (NULL für Master-Streams). */
  parent?: string;
  /** workstreams.name — N1: verbatim aus DB. */
  name: string;
  /** workstreams.status — z.B. 'active' | 'paused' | 'done' | 'stuck'. */
  status: string;
  /** workstreams.role — z.B. 'lead' | 'roaster-1' | 'critic'. */
  role?: string;
}

export interface OpenQuestionState {
  /** Question-Set, das mehrere zusammengehörige Fragen bündelt. */
  questionSetId: string;
  /** Stabile ID innerhalb des Question-Sets. */
  questionId: string;
  /** Optionaler Workstream-Bezug (NULL = Workspace-weit). */
  workstreamId?: string;
  /** N1: verbatim aus payload.text — kein .slice. */
  text: string;
  /** Multiple-Choice-Optionen, NULL wenn freie Antwort. */
  options?: string[];
  /** ms epoch des emit. */
  askedAt: number;
  /**
   * true wenn in `question_answers` ein Eintrag mit gleicher (set,id) existiert.
   * P1.AB-Track schreibt das; fehlt die Tabelle → immer false (fail-soft).
   */
  answered: boolean;
}

/**
 * Vokabular der blockierenden Gates aus der ACL5-/Owner-Direktive:
 *   - `credential-request`     — Credential fehlt, Surface erbittet User-Input
 *   - `connector-call-preview` — Live-Call wartet auf User-Approve
 *   - `live-warn`              — Erstaufruf in LIVE-Mode (S6 trust-ask)
 *   - `counter-evidence`       — P13 Devil's Advocate Counter-Evidence-Card
 *   - `human-decision`         — explizite human-decision (z.B. Cross-Roast)
 *   - `decision`               — F18 (2026-05-30): eine offene Decision /
 *                                quickchoice / tier-choice-Surface. Bisher blieb
 *                                sie als Karte MITTEN im Feed (Critic: „nicht
 *                                gepinnt, ohne Aktions-Hierarchie, 4 gleichwertige
 *                                Optionen"). Jetzt erfasst sie die Projektion als
 *                                blockingGate → der ActionDeck pinnt sie unten
 *                                über dem Chat mit EINER empfohlenen Primär-Aktion.
 */
export type BlockingGateKind =
  | 'credential-request'
  | 'connector-call-preview'
  | 'live-warn'
  | 'counter-evidence'
  | 'human-decision'
  | 'decision';

/**
 * Eine Option einer gepinnten Decision/quickchoice (F18). Trägt das verbatim
 * Label (N1) + Sub-Label + ob sie die empfohlene Primär-Aktion ist. Der
 * ActionDeck rendert genau EINE empfohlene Option gefüllt/Akzent, die übrigen
 * als ruhige Liste (progressive disclosure) — statt 4 gleichlauter Buttons.
 */
export interface GateOption {
  /** Stabile ID innerhalb der Surface (für data-recommended-Klick-Routing). */
  id: string;
  /** N1: verbatim Label aus payload — kein .slice. */
  label: string;
  /** Optionales Sub-Label (verbatim). */
  sublabel?: string;
  /** true → empfohlene Primär-Aktion (gefüllt/Akzent). Genau eine pro Gate. */
  recommended?: boolean;
}

export interface BlockingGateState {
  kind: BlockingGateKind;
  workstreamId?: string;
  /** N1: verbatim Beschreibung aus payload (Surface/Reason). */
  description: string;
  /** ms epoch — events.created_at. */
  createdAt: number;
  /**
   * F18 (2026-05-30): die Optionen einer gepinnten Decision/quickchoice/
   * tier-choice. Nur für kind='decision' gesetzt (sonst undefined). Genau eine
   * Option trägt `recommended:true` (vom Server markiert oder — fehlt die
   * Markierung — die erste Option als deterministischer Default). Verbatim (N1).
   */
  options?: GateOption[];
}

export interface LastSuccessfulActionState {
  /** Vokabular-frei (z.B. 'lead-v1-done', 'roaster-converged', 'workflow.completed'). */
  kind: string;
  /** ms epoch. */
  at: number;
  /** Optionale Kurzbeschreibung (N1: verbatim aus payload, max 280 Zeichen). */
  summary?: string;
}

/**
 * Worauf das System aktuell wartet:
 *   - `free-prompt`     — User darf alles eingeben (Default).
 *   - `answer-question` — eine offene Frage blockiert; UI sollte answer-Surface zeigen.
 *   - `approve-gate`    — ein blocking Gate (Credential/Preview) wartet auf User-Approve.
 *   - `wait`            — Run läuft, kein User-Input erwartet.
 */
export type NextAllowedUserInput =
  | 'free-prompt'
  | 'answer-question'
  | 'approve-gate'
  | 'wait';

export interface WorkspaceState {
  workspaceId: string;
  /** ms epoch — Generierungszeitpunkt. Nicht-cachebar. */
  generatedAt: number;

  /** NULL wenn kein flow_run in diesem Workspace aktiv. */
  activeFlowRun: ActiveFlowRunState | null;

  /**
   * Alle Workstreams mit status='active' im Workspace.
   * Sortiert nach updated_at DESC.
   */
  activeWorkstreams: ActiveWorkstreamState[];

  /**
   * Alle offenen Fragen (chat_message-Events mit Surface 'open-questions'
   * oder 'plan-open-questions'), joint mit question_answers.
   * Sortiert nach askedAt DESC.
   */
  openQuestions: OpenQuestionState[];

  /**
   * Blockierende Gates aus chat_message-Surfaces:
   * credential-request · connector-call-preview · live-warn ·
   * counter-evidence · human-decision.
   */
  blockingGates: BlockingGateState[];

  /** Jüngstes lifecycle-Event mit positivem Outcome im Workspace. */
  lastSuccessfulAction: LastSuccessfulActionState | null;

  /** Deterministisch abgeleitet aus den anderen Feldern. */
  nextAllowedUserInput: NextAllowedUserInput;
}
