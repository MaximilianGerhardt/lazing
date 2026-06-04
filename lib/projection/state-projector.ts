/**
 * Phase 1 Track E — State-Projection-Spine
 * ════════════════════════════════════════════════════════════════════════
 *
 * WAS DIESES MODUL TUT
 * ────────────────────
 * `projectWorkspaceState(raw, workspaceId)` aggregiert den OPERATIVEN
 * Zustand eines Workspace deterministisch aus der DB (N6: SQL-Queries,
 * keine LLM-Reasoning) und liefert ihn als `WorkspaceState` zurück:
 *
 *   • activeFlowRun          — jüngster nicht-finaler flow_runs-Eintrag
 *   • activeWorkstreams      — workstreams mit status='active' im Workspace
 *   • openQuestions          — chat_message-Events mit open-questions-Surface,
 *                              joint mit question_answers (falls Tabelle existiert)
 *   • blockingGates          — chat_message-Events mit credential-request /
 *                              connector-call-preview / live-warn /
 *                              counter-evidence / human-decision Surfaces
 *   • lastSuccessfulAction   — jüngstes lifecycle-Event mit positivem Outcome
 *   • nextAllowedUserInput   — deterministisch aus den anderen Feldern abgeleitet
 *
 * Die Funktion arbeitet auf einem rohen `better-sqlite3` Database-Handle —
 * das macht sie test-freundlich (in-memory DB) und vermeidet die Kopplung
 * an den getDb()-Singleton (analog zu lib/reasoning/beliefs-repo.ts).
 *
 * WAS DIESES MODUL NICHT TUT
 * ──────────────────────────
 * Es liest NICHT aus sichtbaren Chat-Karten / dem rendered DOM / aus
 * client-side state. Sichtbare Surfaces im Chat sind NUR Historie —
 * sie sind kein Beweis für den aktuellen Zustand.
 *
 * Owner-Direktive (verbatim aus Befund D Handoff §10):
 *
 *   „Operativer Zustand steckt im Chat-Verlauf. Beobachtung im aktiven
 *    PA-Workspace: alte Quickchoices · alte Subplan-Karten · alte
 *    Open-Questions · vergangene Recovery-Meldungen · Permission-/Tool-
 *    Probleme · laufende und obsolete Zustände gleichzeitig. […]
 *    Es braucht eine State Projection aus DB/Event-State: aktueller
 *    FlowRun · aktive Workstreams · offene Questions · blockierende Gates
 *    · letzte erfolgreiche Lane/Subagent-Aktion · nächster erlaubter
 *    User-Input. Sichtbare historische Chat-Surfaces dürfen nicht die
 *    Quelle der Wahrheit sein."
 *
 * Damit ist dieses Modul der VERTRAG für künftige UI-Konsumenten:
 *   - State Header / Status Pill / „Aktueller Run"-Indikator
 *   - Open-Questions-Inbox
 *   - Blocking-Gate-Surfaces (welches Gate ist NOCH OFFEN?)
 *   - Composer-Auto-Switch (free-prompt vs. answer-Mode)
 *
 * Sie alle MÜSSEN sich an diesem Projection-Output orientieren — nicht
 * an der gerenderten History oder an lokal gehaltenem React-State.
 *
 * SICHERHEITSEIGENSCHAFTEN
 * ────────────────────────
 *   • Deterministisch (N6): nur SQL, keine LLM-Aufrufe.
 *   • Fail-soft: jeder Query in try/catch; bei Fehler → minimaler State
 *     (workspaceId + generatedAt + nextAllowedUserInput='free-prompt',
 *      Listen leer, Single-Felder null).
 *   • Latenz-Budget: <100ms für realistische Last (gemessen im Performance-
 *     Smoke-Test mit 1000 events + 50 workstreams).
 *   • Read-only: führt NIE INSERTs / UPDATEs aus. Append-only-Disziplin
 *     der Truth-Tabellen wird nicht angetastet.
 *
 * TRUTH-TABELLEN (Stand 2026-05-29)
 * ─────────────────────────────────
 *   • workstreams                — Migration 0009 + 0040 (parent/role/tokens)
 *   • flow_runs                  — Migration 0112 (Flow Studio P1)
 *   • workstream_plan_steps      — Migration 0094 + 0107 + 0110
 *   • events                     — Migration 0001 (entity_type + payload JSON)
 *   • question_answers           — NOCH NICHT VORHANDEN; P1.AB-Track schreibt
 *                                  diese Tabelle. Wir lesen mit
 *                                  `try { … } catch` — fehlende Tabelle → all
 *                                  questions.answered = false (fail-soft).
 *
 * Stand: 2026-05-29
 */

import type { Database as Sqlite } from 'better-sqlite3';

import type {
  ActiveFlowRunState,
  ActiveFlowRunStatus,
  ActiveWorkstreamState,
  BlockingGateKind,
  BlockingGateState,
  GateOption,
  LastSuccessfulActionState,
  NextAllowedUserInput,
  OpenQuestionState,
  WorkspaceState,
} from './types';

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

/**
 * Sicheres JSON.parse für event.payload. Liefert `{}` bei jedem Fehler.
 * Niemals werfen — projection darf fail-soft sein.
 */
function safeParseJson(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * Map flow_runs.status → ActiveFlowRunStatus. Bei unbekanntem Wert
 * defaulted auf 'pending' (sicher: blockiert nicht und macht nichts kaputt).
 */
function mapFlowRunStatus(
  raw: string | null | undefined,
  hasBlockingGate: boolean,
): ActiveFlowRunStatus {
  switch ((raw ?? '').toLowerCase()) {
    case 'pending':
      return 'pending';
    case 'running': {
      // Wenn ein blocking Gate offen ist, verfeinern wir später (s. caller).
      return hasBlockingGate ? 'needs-coupling' : 'running';
    }
    case 'done':
      return 'done';
    case 'failed':
    case 'cancelled':
      return 'failed';
    default:
      return 'pending';
  }
}

/**
 * Liest verbatim die Frage-Texte (N1: kein .slice). Liefert eine Liste von
 * (workstreamId?, questionSetId, questionId, text, options?, askedAt).
 *
 * Eingabe: ein chat_message-Event mit payload.kind='open-questions' oder
 * 'plan-open-questions'. Payload-Form gemäß lib/chat/surface-parser.ts:
 *   { kind, questionSetId, workstreamId?, questions: [{id, text, options?}, …] }
 */
interface RawQuestion {
  questionSetId: string;
  questionId: string;
  workstreamId?: string;
  text: string;
  options?: string[];
  askedAt: number;
}

function extractQuestions(
  payload: Record<string, unknown>,
  fallbackSetId: string,
  fallbackWorkstreamId: string | undefined,
  askedAt: number,
): RawQuestion[] {
  const setIdRaw = payload.questionSetId;
  const questionSetId =
    typeof setIdRaw === 'string' && setIdRaw.length > 0
      ? setIdRaw
      : fallbackSetId;
  const wsRaw = payload.workstreamId;
  const workstreamId =
    typeof wsRaw === 'string' && wsRaw.length > 0
      ? wsRaw
      : fallbackWorkstreamId;
  const list = Array.isArray(payload.questions) ? payload.questions : [];
  const out: RawQuestion[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const id = r.id;
    const text = r.text;
    if (typeof id !== 'string' || typeof text !== 'string') continue;
    let options: string[] | undefined;
    if (Array.isArray(r.options)) {
      const arr = r.options.filter((o): o is string => typeof o === 'string');
      if (arr.length > 0) options = arr;
    }
    out.push({
      questionSetId,
      questionId: id,
      workstreamId,
      text, // N1: verbatim
      options,
      askedAt,
    });
  }
  return out;
}

/**
 * Map Surface-kind → BlockingGateKind. Liefert null wenn kein Gate.
 */
function mapBlockingGateKind(kind: unknown): BlockingGateKind | null {
  if (typeof kind !== 'string') return null;
  switch (kind) {
    case 'credential-request':
    case 'credential-prompt':
      return 'credential-request';
    case 'connector-call-preview':
      return 'connector-call-preview';
    case 'live-warn':
      return 'live-warn';
    case 'counter-evidence':
    case 'counter_evidence_card':
      return 'counter-evidence';
    case 'human-decision':
      return 'human-decision';
    // F18 (2026-05-30): offene Decision/quickchoice/tier-choice → 'decision'.
    // Bisher fielen diese durch `default → null` und blieben als Karte MITTEN
    // im Feed (Critic). Jetzt erfasst die Projektion sie als blockingGate, der
    // ActionDeck pinnt sie unten über dem Chat mit EINER empfohlenen Aktion.
    case 'decision':
    case 'quickchoice':
    case 'tier-choice':
      return 'decision';
    default:
      return null;
  }
}

/**
 * F18 — extrahiert die Optionen einer Decision/quickchoice/tier-choice aus dem
 * payload (N1: verbatim Labels). Genau eine Option wird als `recommended`
 * markiert: bevorzugt die vom Server gesetzte (`recommended`/`primary`/
 * `recommended_basis`-Flag), sonst die erste Option (deterministischer Default).
 *
 * Decision-Payload (renderDecision): { headline, options:[{id,label,sublabel?,
 *   recommended?}] }
 * QuickChoice-Payload (renderQuickChoice): { options:[{id,label,sublabel?,
 *   primary?}] }
 * Tier-Choice-Payload: serverseitige presets ODER aus tier-presets.ts gebaut;
 *   die Projektion liest defensiv `options`/`presets` falls vorhanden.
 *
 * Liefert undefined wenn keine validen Optionen vorhanden (dann rendert der Deck
 * die Decision wie ein generisches Gate: nur Verweis auf die Stream-Card).
 */
function extractGateOptions(
  payload: Record<string, unknown>,
): GateOption[] | undefined {
  const rawList =
    (Array.isArray(payload.options) && payload.options) ||
    (Array.isArray(payload.presets) && payload.presets) ||
    null;
  if (!rawList) return undefined;

  const out: GateOption[] = [];
  let idx = 0;
  for (const raw of rawList) {
    if (!raw || typeof raw !== 'object') {
      idx += 1;
      continue;
    }
    const r = raw as Record<string, unknown>;
    const label =
      typeof r.label === 'string' && r.label.length > 0 ? r.label : undefined;
    if (!label) {
      idx += 1;
      continue;
    }
    const id =
      typeof r.id === 'string' && r.id.length > 0 ? r.id : `opt-${idx}`;
    const sublabel =
      typeof r.sublabel === 'string' && r.sublabel.length > 0
        ? r.sublabel
        : typeof r.cost === 'string' && r.cost.length > 0
          ? r.cost
          : undefined;
    const recommended = r.recommended === true || r.primary === true;
    out.push({ id, label, sublabel, recommended });
    idx += 1;
  }
  if (out.length === 0) return undefined;

  // Genau EINE empfohlene Option: gibt es keine server-markierte, wird die erste
  // zur Primär-Aktion (deterministischer Default). Gibt es mehrere, gewinnt die
  // erste markierte — alle weiteren werden auf nicht-empfohlen zurückgesetzt,
  // damit der Deck nie zwei „Primär"-Aktionen rendert.
  let primarySeen = false;
  for (const o of out) {
    if (o.recommended && !primarySeen) {
      primarySeen = true;
    } else {
      o.recommended = false;
    }
  }
  if (!primarySeen && out.length > 0) out[0]!.recommended = true;

  return out;
}

/**
 * Liest eine Beschreibung aus dem payload (N1: verbatim). Mehrere Pfade
 * werden probiert (description, reason, message, preview), das erste
 * String-Feld gewinnt. Fallback: leerer String — der Konsument muss damit
 * umgehen (Surface zeigt z.B. den kind als Label).
 */
function extractGateDescription(payload: Record<string, unknown>): string {
  const candidates = ['description', 'reason', 'message', 'preview', 'text'];
  for (const k of candidates) {
    const v = payload[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return '';
}

/**
 * Liest den Provider-Slug aus einer credential-request-Gate-Payload. Wird für
 * die Resolution gegen `api_credentials` gebraucht (ist der Key inzwischen im
 * Vault hinterlegt?). Mehrere Pfade, erstes String-Feld gewinnt. '' wenn keiner.
 */
function extractGateProvider(payload: Record<string, unknown>): string {
  const candidates = ['provider', 'providerSlug', 'connector'];
  for (const k of candidates) {
    const v = payload[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return '';
}

/**
 * ── Gate-Resolution ──────────────────────────────────────────────────────────
 *
 * BLOCKER 2 (Critic, 2026-05-30): `blockingGates` wurde NIE gegen die
 * Approve/Deny-/Consume-Entscheidung gefiltert. Folge: nach „OK weiter" bleibt
 * das Gate im Deck gepinnt, bis das Event aus dem LIMIT-200-Fenster rollt — der
 * Deck pinnt ein bereits beantwortetes Gate dauerhaft. „Die Region lügt."
 *
 * Es gibt KEINE einzelne Gate-Resolution-Tabelle. Die echten Approve-Pfade
 * schreiben in unterschiedliche Truth-Stores (file:line je Card-Handler):
 *
 *   • live-warn          → POST /api/workspaces/[id]/live-warn-ack
 *                          → `recordLiveWarnAck` (lib/connectors/live-warn.ts:88)
 *                          → workspace_beliefs row, topic='live-warn-acked',
 *                            belief 'ack:…' | 'decline:…'. BEIDE Entscheidungen
 *                            lösen das *aktuelle* one-shot-Gate auf (der Owner
 *                            HAT geantwortet); ein 'decline' lässt die Warnung
 *                            beim nächsten LIVE-Lauf neu erscheinen, das ist ein
 *                            NEUES Gate-Event mit höherem created_at.
 *
 *   • credential-request → CredentialRequestCard → POST
 *                          /api/connectors/[provider]/credential → `putApiCredential`
 *                          (lib/credentials/vault.ts:414) → api_credentials row
 *                          (scope_kind, scope_id=workspaceId|orgId, provider).
 *                          Liegt für den Provider ein Credential vor, das NACH
 *                          dem Gate angelegt wurde → Gate erledigt.
 *
 *   • connector-call-preview / counter-evidence / human-decision (decision-brief)
 *                        → KEIN server-seitiger Resolution-Write heute.
 *                          connector-invoke pusht nur eine assistant-Bestätigung;
 *                          decision-brief ist EVENT-ONLY (lokaler State,
 *                          SurfaceRenderer.tsx:5843) → schreibt NICHTS in die DB.
 *                          Für diese Kinds gibt es serverseitig nichts zu joinen;
 *                          die optimistische Consume-Markierung passiert
 *                          client-seitig (useWorkspaceState consumedGateKey) bis
 *                          ein echter Resolution-Write existiert. Ehrlich:
 *                          das ist die Grenze des heutigen Substrats.
 *
 * Diese Funktion liefert ein Prädikat `(gate) → resolved`, das die zwei ECHTEN
 * DB-Mechanismen joint. Alles fail-soft: fehlende Tabelle / DB-Fehler →
 * Gate gilt als NICHT resolved (lieber over-pin als ein stilles Verschwinden).
 */
interface GateResolutionIndex {
  /** Jüngster live-warn-acked-Belief-Timestamp (oder -1). */
  liveWarnAckedAt: number;
  /** provider(lowercased) → jüngster api_credentials.created_at für diesen WS/Org. */
  credentialCreatedAt: Map<string, number>;
  /**
   * F18 (2026-05-30): jüngster User-Reply-Timestamp (chat_message_sent mit
   * payload.role='user') im Workspace, oder -1. Eine gepinnte Decision/
   * quickchoice gilt als beantwortet, sobald der User NACH dem Gate eine
   * Nachricht geschickt hat — der `reply(label)`-Pfad jeder Decision-/
   * QuickChoice-Card postet genau so eine User-Nachricht. Das ist der EINZIGE
   * ehrliche DB-Resolution-Mechanismus für Decisions (es gibt keine eigene
   * decision_answers-Tabelle); analog `readAnsweredKeys` für Fragen.
   */
  lastUserReplyAt: number;
}

function buildGateResolutionIndex(
  raw: Sqlite,
  workspaceId: string,
): GateResolutionIndex {
  const index: GateResolutionIndex = {
    liveWarnAckedAt: -1,
    credentialCreatedAt: new Map<string, number>(),
    lastUserReplyAt: -1,
  };

  // ── decision/quickchoice → jüngste User-Reply (chat_message_sent role=user) ──
  // Eine gepinnte Decision wird beantwortet, indem der User eine Nachricht
  // schickt (der reply(label)-Pfad der Card). Wir lesen das jüngste solche
  // Event; jede Decision mit createdAt <= lastUserReplyAt gilt als beantwortet.
  // payload.role='user' filtert robust auch dann, wenn der actor-String variiert.
  try {
    const rows = raw
      .prepare(
        `SELECT payload, created_at FROM events
          WHERE segment_id = ?
            AND entity_type = 'chat_message'
            AND event_type = 'chat_message_sent'
          ORDER BY created_at DESC
          LIMIT 50`,
      )
      .all(workspaceId) as Array<{ payload: string | null; created_at: number }>;
    for (const r of rows) {
      const p = safeParseJson(r.payload);
      if (p.role === 'user') {
        index.lastUserReplyAt = r.created_at;
        break; // DESC sortiert → erstes user-Event ist das jüngste.
      }
    }
  } catch {
    /* fail-soft: keine Reply-Info → Decision bleibt sichtbar. */
  }

  // ── live-warn → workspace_beliefs(topic='live-warn-acked') ────────────────
  try {
    const probe = raw
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='workspace_beliefs'`,
      )
      .get() as { name?: string } | undefined;
    if (probe?.name) {
      const row = raw
        .prepare(
          `SELECT MAX(created_at) AS m FROM workspace_beliefs
            WHERE workspace_id = ? AND topic = 'live-warn-acked'`,
        )
        .get(workspaceId) as { m?: number } | undefined;
      if (typeof row?.m === 'number') index.liveWarnAckedAt = row.m;
    }
  } catch {
    /* fail-soft: keine Resolution-Info → Gate bleibt sichtbar. */
  }

  // ── credential-request → api_credentials(provider, scope) ─────────────────
  // scope_id ist der workspaceId (workspace-scope) ODER eine orgId (org-scope).
  // Wir joinen defensiv über BEIDE: ein Credential im Workspace-Scope für den
  // Provider zählt sicher; org-scope können wir ohne org-Lookup nicht exakt
  // dem Workspace zuordnen → wir nehmen workspace-scope (der häufige Fall der
  // CredentialRequestCard, scopeKind default 'workspace').
  try {
    const probe = raw
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='api_credentials'`,
      )
      .get() as { name?: string } | undefined;
    if (probe?.name) {
      const rows = raw
        .prepare(
          `SELECT provider, MAX(created_at) AS m FROM api_credentials
            WHERE scope_kind = 'workspace' AND scope_id = ?
            GROUP BY provider`,
        )
        .all(workspaceId) as Array<{ provider?: string; m?: number }>;
      for (const r of rows) {
        if (typeof r.provider === 'string' && typeof r.m === 'number') {
          index.credentialCreatedAt.set(r.provider.toLowerCase(), r.m);
        }
      }
    }
  } catch {
    /* fail-soft. */
  }

  return index;
}

/**
 * Prädikat: ist dieses Gate durch einen ECHTEN DB-Write aufgelöst? Nur die zwei
 * Kinds mit Resolution-Store werden hier positiv beantwortet — die übrigen
 * geben false zurück (kein serverseitiger Mechanismus; s. Doku oben).
 */
function isGateResolved(
  gate: { kind: BlockingGateKind; createdAt: number; provider: string },
  index: GateResolutionIndex,
): boolean {
  switch (gate.kind) {
    case 'live-warn':
      // Der Owner hat geantwortet, NACHDEM das Gate emittiert wurde.
      return index.liveWarnAckedAt >= gate.createdAt;
    case 'credential-request': {
      if (gate.provider.length === 0) return false;
      const at = index.credentialCreatedAt.get(gate.provider.toLowerCase());
      return typeof at === 'number' && at >= gate.createdAt;
    }
    case 'decision':
      // F18: Decision/quickchoice gilt als beantwortet, sobald der User NACH
      // dem Gate eine Nachricht geschickt hat (reply(label)-Pfad der Card).
      // Strikt `>` — eine Reply mit gleichem Timestamp wäre dieselbe Surface-
      // Emission, nicht die Antwort darauf.
      return index.lastUserReplyAt > gate.createdAt;
    default:
      // connector-call-preview / counter-evidence / human-decision:
      // kein serverseitiger Resolution-Write → hier nie als resolved markiert.
      return false;
  }
}

/**
 * Liest die Phase aus einem aktiven Plan-Step für currentPhase.
 * SQL-only. Wenn workstream_plan_steps-Tabelle fehlt → undefined.
 */
function readCurrentPhase(
  raw: Sqlite,
  workstreamId: string,
): string | undefined {
  try {
    const row = raw
      .prepare(
        `SELECT title FROM workstream_plan_steps
          WHERE workstream_id = ? AND status = 'active'
          ORDER BY depth ASC, step_index ASC LIMIT 1`,
      )
      .get(workstreamId) as { title?: string } | undefined;
    return row?.title;
  } catch {
    return undefined;
  }
}

/**
 * Liest die letzte updated_at eines Plan-Steps im Workstream — wird
 * verwendet, um den lastEventAt eines flow_runs zu verfeinern.
 */
function readWorkstreamLastUpdate(
  raw: Sqlite,
  workstreamId: string,
): number | undefined {
  try {
    const row = raw
      .prepare(
        `SELECT MAX(updated_at) AS m FROM workstream_plan_steps WHERE workstream_id = ?`,
      )
      .get(workstreamId) as { m?: number } | undefined;
    return typeof row?.m === 'number' ? row.m : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Liest die Antworten aus question_answers (P1.AB-Track). Wenn die Tabelle
 * nicht existiert, ist das nicht-fatal — die Funktion gibt ein leeres Set
 * zurück. Schema wird minimal angenommen:
 *   question_answers(question_set_id TEXT, question_id TEXT, …)
 * (Kombi-Key ist der join-Schlüssel — exotische Felder werden ignoriert.)
 */
function readAnsweredKeys(
  raw: Sqlite,
  workspaceId: string,
): Set<string> {
  const answered = new Set<string>();
  try {
    // Probe: Existiert die Tabelle?
    const probe = raw
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='question_answers'`,
      )
      .get() as { name?: string } | undefined;
    if (!probe?.name) return answered;

    // P1.AB darf das Schema selbst definieren. Wir lesen defensiv: wenn
    // workspace_id existiert, filtern wir, sonst nehmen wir alle Antworten.
    let rows: Array<{ question_set_id?: string; question_id?: string }> = [];
    try {
      rows = raw
        .prepare(
          `SELECT question_set_id, question_id FROM question_answers
            WHERE workspace_id = ?`,
        )
        .all(workspaceId) as Array<{
        question_set_id?: string;
        question_id?: string;
      }>;
    } catch {
      // Fallback: kein workspace_id-Spalt → ungeflitert.
      try {
        rows = raw
          .prepare(`SELECT question_set_id, question_id FROM question_answers`)
          .all() as Array<{ question_set_id?: string; question_id?: string }>;
      } catch {
        return answered;
      }
    }
    for (const r of rows) {
      if (
        typeof r.question_set_id === 'string' &&
        typeof r.question_id === 'string'
      ) {
        answered.add(`${r.question_set_id}::${r.question_id}`);
      }
    }
  } catch {
    /* fail-soft: missing table = no answered marks. */
  }
  return answered;
}

/**
 * Liefert die jüngste lifecycle-Event-Row mit positivem Outcome für den
 * Workspace, oder null. Vokabular:
 *   - eventType = 'workflow.completed'
 *   - eventType = 'workflow.transitioned' UND payload.outcome === 'success'
 *   - eventType = 'chat_message_completed'
 *
 * Aus payload.summary / payload.text werden bis zu 280 Zeichen verbatim
 * übernommen (N1: kein .slice auf Ledger-Felder — die 280 ist eine UI-Hint,
 * kein truncation des Wahrheits-Logs).
 */
function readLastSuccessfulAction(
  raw: Sqlite,
  workspaceId: string,
): LastSuccessfulActionState | null {
  try {
    const row = raw
      .prepare(
        `SELECT event_type, payload, created_at
           FROM events
          WHERE segment_id = ?
            AND event_type IN (
              'workflow.completed',
              'workflow.transitioned',
              'chat_message_completed'
            )
          ORDER BY created_at DESC
          LIMIT 8`,
      )
      .all(workspaceId) as Array<{
      event_type: string;
      payload: string | null;
      created_at: number;
    }>;
    for (const r of row) {
      const payload = safeParseJson(r.payload);
      if (r.event_type === 'workflow.transitioned') {
        // Nur als success zählen, wenn payload.outcome explizit success ist.
        const out = payload.outcome;
        if (typeof out !== 'string' || out.toLowerCase() !== 'success') continue;
      }
      let summary: string | undefined;
      const s = payload.summary;
      const t = payload.text;
      if (typeof s === 'string' && s.length > 0) summary = s;
      else if (typeof t === 'string' && t.length > 0) summary = t;
      return {
        kind: r.event_type,
        at: r.created_at,
        summary,
      };
    }
    return null;
  } catch {
    return null;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Hauptfunktion
// ───────────────────────────────────────────────────────────────────────────

/**
 * Aggregiert den operativen Zustand eines Workspace deterministisch aus DB.
 *
 * @param raw         rohes better-sqlite3 Handle (Test: :memory: · Prod: getDb().$raw)
 * @param workspaceId ManifestCoord workspace_id (entspricht events.segment_id)
 * @returns           ein vollständiger WorkspaceState. Niemals throw — bei
 *                    DB-Fehlern wird ein minimaler State zurückgegeben.
 *
 * Latenz-Budget: <100ms für 1000 events + 50 workstreams (Performance-Smoke).
 */
export function projectWorkspaceState(
  raw: Sqlite,
  workspaceId: string,
): WorkspaceState {
  const generatedAt = Date.now();

  // Defensive minimal-State-Builder: jeder einzelne SELECT in try/catch.
  const minimal = (): WorkspaceState => ({
    workspaceId,
    generatedAt,
    activeFlowRun: null,
    activeWorkstreams: [],
    openQuestions: [],
    blockingGates: [],
    lastSuccessfulAction: null,
    nextAllowedUserInput: 'free-prompt',
  });

  if (typeof workspaceId !== 'string' || workspaceId.length === 0) {
    return minimal();
  }

  // ── 1. Active Workstreams ────────────────────────────────────────────────
  let activeWorkstreams: ActiveWorkstreamState[] = [];
  try {
    const rows = raw
      .prepare(
        `SELECT id, parent_workstream_id, name, status, role
           FROM workstreams
          WHERE workspace_id = ?
            AND status = 'active'
          ORDER BY updated_at DESC
          LIMIT 100`,
      )
      .all(workspaceId) as Array<{
      id: string;
      parent_workstream_id: string | null;
      name: string;
      status: string;
      role: string | null;
    }>;
    activeWorkstreams = rows.map((r) => ({
      workstreamId: r.id,
      parent: r.parent_workstream_id ?? undefined,
      name: r.name, // N1: verbatim
      status: r.status,
      role: r.role ?? undefined,
    }));
  } catch {
    activeWorkstreams = [];
  }

  // ── 2. Active FlowRun ────────────────────────────────────────────────────
  // Jüngster flow_run mit status ∈ {pending, running} im Workspace.
  let flowRunRaw:
    | {
        id: string;
        workstream_id: string | null;
        status: string;
        created_at: number;
        updated_at: number;
      }
    | undefined;
  try {
    flowRunRaw = raw
      .prepare(
        `SELECT id, workstream_id, status, created_at, updated_at
           FROM flow_runs
          WHERE workspace_id = ?
            AND status IN ('pending','running')
          ORDER BY updated_at DESC
          LIMIT 1`,
      )
      .get(workspaceId) as
      | {
          id: string;
          workstream_id: string | null;
          status: string;
          created_at: number;
          updated_at: number;
        }
      | undefined;
  } catch {
    flowRunRaw = undefined;
  }

  // Wenn kein non-final flow_run: nimm den jüngsten überhaupt (für lastEventAt-
  // Anzeige im UI). Wir geben ihn ABER nicht als activeFlowRun zurück, wenn er
  // schon 'done' / 'failed' / 'cancelled' ist — das wäre History, nicht State.
  // → activeFlowRun bleibt null.

  // ── 3. Open Questions ────────────────────────────────────────────────────
  // Suche chat_message-Events mit payload.kind ∈ {open-questions,plan-open-questions}
  // im Workspace, jüngste zuerst, dedupe per (set,id).
  let openQuestions: OpenQuestionState[] = [];
  try {
    const rows = raw
      .prepare(
        `SELECT id, entity_id, payload, created_at
           FROM events
          WHERE segment_id = ?
            AND entity_type = 'chat_message'
          ORDER BY created_at DESC
          LIMIT 200`,
      )
      .all(workspaceId) as Array<{
      id: string;
      entity_id: string;
      payload: string | null;
      created_at: number;
    }>;
    const answeredKeys = readAnsweredKeys(raw, workspaceId);
    const seen = new Set<string>();
    const collected: OpenQuestionState[] = [];
    for (const r of rows) {
      const payload = safeParseJson(r.payload);
      const kind = payload.kind;
      if (
        kind !== 'open-questions' &&
        kind !== 'plan-open-questions'
      ) {
        continue;
      }
      const fallbackSet = typeof r.entity_id === 'string' ? r.entity_id : r.id;
      const wsRaw = payload.workstreamId;
      const fallbackWs =
        typeof wsRaw === 'string' && wsRaw.length > 0 ? wsRaw : undefined;
      const qs = extractQuestions(payload, fallbackSet, fallbackWs, r.created_at);
      for (const q of qs) {
        const dedupeKey = `${q.questionSetId}::${q.questionId}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        collected.push({
          questionSetId: q.questionSetId,
          questionId: q.questionId,
          workstreamId: q.workstreamId,
          text: q.text, // N1: verbatim
          options: q.options,
          askedAt: q.askedAt,
          answered: answeredKeys.has(dedupeKey),
        });
      }
    }
    // Bereits sortiert nach DESC (durch SQL ORDER BY).
    openQuestions = collected;
  } catch {
    openQuestions = [];
  }

  // ── 4. Blocking Gates ────────────────────────────────────────────────────
  // chat_message-Surfaces mit Gate-Vokabular. Dedupe per (kind, workstreamId,
  // description) — gleicher Gate-Surface mehrfach im Verlauf zählt einmal.
  let blockingGates: BlockingGateState[] = [];
  try {
    const rows = raw
      .prepare(
        `SELECT payload, created_at
           FROM events
          WHERE segment_id = ?
            AND entity_type = 'chat_message'
          ORDER BY created_at DESC
          LIMIT 200`,
      )
      .all(workspaceId) as Array<{
      payload: string | null;
      created_at: number;
    }>;
    // BLOCKER 2 (2026-05-30): Resolution-Index EINMAL bauen (zwei kleine
    // indexierte Queries) und jedes Gate gegen den echten Approve-Write
    // filtern, analog `readAnsweredKeys` für Fragen. Ohne das pinnt der Deck
    // ein bereits beantwortetes Gate dauerhaft.
    const resolution = buildGateResolutionIndex(raw, workspaceId);
    const seen = new Set<string>();
    const collected: BlockingGateState[] = [];
    for (const r of rows) {
      const payload = safeParseJson(r.payload);
      const kind = mapBlockingGateKind(payload.kind);
      if (!kind) continue;
      const wsRaw = payload.workstreamId;
      const ws =
        typeof wsRaw === 'string' && wsRaw.length > 0 ? wsRaw : undefined;
      const description = extractGateDescription(payload);
      const provider = extractGateProvider(payload);
      // F18: für decision/quickchoice/tier-choice die Optionen verbatim mitziehen
      // (genau eine wird als recommended markiert). Andere Gate-Kinds → undefined.
      const options =
        kind === 'decision' ? extractGateOptions(payload) : undefined;
      // Headline-Fallback für Decisions: wenn keine description, nimm die
      // verbatim headline (renderDecision verlangt sie); fehlt auch die
      // (quickchoice ist option-only), synthetisiere eine stabile Signatur aus
      // den Option-Labels — damit ActionDeck-Pin und in-feed-Karte über
      // dieselbe Signatur matchen (Suppression) und der Dedupe greift.
      const effectiveDescription =
        description.length > 0
          ? description
          : kind === 'decision' && typeof payload.headline === 'string'
            ? (payload.headline as string)
            : kind === 'decision' && options && options.length > 0
              ? options.map((o) => o.label).join(' · ')
              : description;
      const dedupeKey = `${kind}::${ws ?? ''}::${effectiveDescription}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      // Resolved-Gate (echter DB-Approve / User-Reply nach dem Gate) → NICHT pinnen.
      if (isGateResolved({ kind, createdAt: r.created_at, provider }, resolution)) {
        continue;
      }
      collected.push({
        kind,
        workstreamId: ws,
        description: effectiveDescription, // N1: verbatim aus payload
        createdAt: r.created_at,
        ...(options ? { options } : {}),
      });
    }
    blockingGates = collected;
  } catch {
    blockingGates = [];
  }

  // ── 5. Active FlowRun zusammensetzen ─────────────────────────────────────
  let activeFlowRun: ActiveFlowRunState | null = null;
  if (flowRunRaw) {
    const hasGate = blockingGates.length > 0;
    const status = mapFlowRunStatus(flowRunRaw.status, hasGate);
    const wsId = flowRunRaw.workstream_id ?? '';
    let currentPhase: string | undefined;
    let lastEventAt = flowRunRaw.updated_at;
    if (wsId.length > 0) {
      currentPhase = readCurrentPhase(raw, wsId);
      const stepUpdate = readWorkstreamLastUpdate(raw, wsId);
      if (typeof stepUpdate === 'number' && stepUpdate > lastEventAt) {
        lastEventAt = stepUpdate;
      }
    }
    activeFlowRun = {
      flowRunId: flowRunRaw.id,
      workstreamId: wsId,
      status,
      currentPhase,
      startedAt: flowRunRaw.created_at,
      lastEventAt,
    };
  }

  // ── 6. Last Successful Action ────────────────────────────────────────────
  const lastSuccessfulAction = readLastSuccessfulAction(raw, workspaceId);

  // ── 7. Next Allowed User Input — deterministisch abgeleitet ──────────────
  const next: NextAllowedUserInput = deriveNextAllowedUserInput({
    activeFlowRun,
    activeWorkstreams,
    openQuestions,
    blockingGates,
  });

  return {
    workspaceId,
    generatedAt,
    activeFlowRun,
    activeWorkstreams,
    openQuestions,
    blockingGates,
    lastSuccessfulAction,
    nextAllowedUserInput: next,
  };
}

/**
 * Deterministische Ableitung von `nextAllowedUserInput`:
 *
 *   1. Wenn ein blocking Gate offen ist          → 'approve-gate'
 *   2. Sonst, wenn eine unbeantwortete Frage     → 'answer-question'
 *   3. Sonst, wenn FlowRun läuft ODER Workstreams aktiv → 'wait'
 *   4. Sonst                                     → 'free-prompt'
 *
 * Diese Reihenfolge ist absichtlich — Gates haben Vorrang vor Fragen,
 * weil ein Gate (z.B. credential-request) blockiert den Run komplett,
 * eine Frage ist lediglich eine Klarstellung.
 *
 * Exportiert für Tests + UI-Konsumenten, die das gleiche Vokabular
 * client-seitig wiederbenutzen wollen.
 */
export function deriveNextAllowedUserInput(input: {
  activeFlowRun: ActiveFlowRunState | null;
  activeWorkstreams: ActiveWorkstreamState[];
  openQuestions: OpenQuestionState[];
  blockingGates: BlockingGateState[];
}): NextAllowedUserInput {
  if (input.blockingGates.length > 0) return 'approve-gate';
  const hasUnanswered = input.openQuestions.some((q) => !q.answered);
  if (hasUnanswered) return 'answer-question';
  const runActive =
    input.activeFlowRun?.status === 'running' ||
    input.activeFlowRun?.status === 'pending' ||
    input.activeWorkstreams.length > 0;
  if (runActive) return 'wait';
  return 'free-prompt';
}
