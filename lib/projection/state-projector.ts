/**
 * Phase 1 Track E — state-projection spine
 * ════════════════════════════════════════════════════════════════════════
 *
 * WHAT THIS MODULE DOES
 * ────────────────────
 * `projectWorkspaceState(raw, workspaceId)` aggregates the OPERATIONAL
 * state of a workspace deterministically from the DB (N6: SQL queries,
 * no LLM reasoning) and returns it as a `WorkspaceState`:
 *
 *   • activeFlowRun          — most recent non-final flow_runs entry
 *   • activeWorkstreams      — workstreams with status='active' in the workspace
 *   • openQuestions          — chat_message events with an open-questions surface,
 *                              joined with question_answers (if the table exists)
 *   • blockingGates          — chat_message events with credential-request /
 *                              connector-call-preview / live-warn /
 *                              counter-evidence / human-decision surfaces
 *   • lastSuccessfulAction   — most recent lifecycle event with a positive outcome
 *   • nextAllowedUserInput   — derived deterministically from the other fields
 *
 * The function works on a raw `better-sqlite3` database handle —
 * which makes it test-friendly (in-memory DB) and avoids the coupling
 * to the getDb() singleton (analogous to lib/reasoning/beliefs-repo.ts).
 *
 * WHAT THIS MODULE DOES NOT DO
 * ──────────────────────────
 * It does NOT read from visible chat cards / the rendered DOM / from
 * client-side state. Visible surfaces in the chat are ONLY history —
 * they are no proof of the current state.
 *
 * Owner directive (verbatim from finding D handoff §10):
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
 * This makes this module the CONTRACT for future UI consumers:
 *   - state header / status pill / „Aktueller Run" indicator
 *   - open-questions inbox
 *   - blocking-gate surfaces (which gate is STILL OPEN?)
 *   - composer auto-switch (free-prompt vs. answer mode)
 *
 * They all MUST orient themselves on this projection output — not
 * on the rendered history or on locally held React state.
 *
 * SAFETY PROPERTIES
 * ────────────────────────
 *   • Deterministic (N6): only SQL, no LLM calls.
 *   • Fail-soft: every query in try/catch; on error → minimal state
 *     (workspaceId + generatedAt + nextAllowedUserInput='free-prompt',
 *      lists empty, single fields null).
 *   • Latency budget: <100ms for realistic load (measured in the performance
 *     smoke test with 1000 events + 50 workstreams).
 *   • Read-only: NEVER runs INSERTs / UPDATEs. The append-only discipline
 *     of the truth tables is left untouched.
 *
 * TRUTH TABLES (as of 2026-05-29)
 * ─────────────────────────────────
 *   • workstreams                — migration 0009 + 0040 (parent/role/tokens)
 *   • flow_runs                  — migration 0112 (Flow Studio P1)
 *   • workstream_plan_steps      — migration 0094 + 0107 + 0110
 *   • events                     — migration 0001 (entity_type + payload JSON)
 *   • question_answers           — NOT YET PRESENT; the P1.AB track writes
 *                                  this table. We read with
 *                                  `try { … } catch` — missing table → all
 *                                  questions.answered = false (fail-soft).
 *
 * As of: 2026-05-29
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
 * Safe JSON.parse for event.payload. Returns `{}` on any error.
 * Never throws — projection must be fail-soft.
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
 * Map flow_runs.status → ActiveFlowRunStatus. On an unknown value
 * defaults to 'pending' (safe: doesn't block and breaks nothing).
 */
function mapFlowRunStatus(
  raw: string | null | undefined,
  hasBlockingGate: boolean,
): ActiveFlowRunStatus {
  switch ((raw ?? '').toLowerCase()) {
    case 'pending':
      return 'pending';
    case 'running': {
      // If a blocking gate is open, we refine later (see caller).
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
 * Reads the question texts verbatim (N1: no .slice). Returns a list of
 * (workstreamId?, questionSetId, questionId, text, options?, askedAt).
 *
 * Input: a chat_message event with payload.kind='open-questions' or
 * 'plan-open-questions'. Payload shape per lib/chat/surface-parser.ts:
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
 * Map surface kind → BlockingGateKind. Returns null when no gate.
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
    // F18 (2026-05-30): open decision/quickchoice/tier-choice → 'decision'.
    // Previously these fell through `default → null` and stayed as a card IN THE MIDDLE
    // of the feed (critic). Now the projection captures them as a blockingGate, the
    // ActionDeck pins them below over the chat with ONE recommended action.
    case 'decision':
    case 'quickchoice':
    case 'tier-choice':
      return 'decision';
    default:
      return null;
  }
}

/**
 * F18 — extracts the options of a decision/quickchoice/tier-choice from the
 * payload (N1: verbatim labels). Exactly one option is marked as `recommended`:
 * preferring the one set by the server (`recommended`/`primary`/
 * `recommended_basis` flag), otherwise the first option (deterministic default).
 *
 * Decision payload (renderDecision): { headline, options:[{id,label,sublabel?,
 *   recommended?}] }
 * QuickChoice payload (renderQuickChoice): { options:[{id,label,sublabel?,
 *   primary?}] }
 * Tier-choice payload: server-side presets OR built from tier-presets.ts;
 *   the projection reads `options`/`presets` defensively if present.
 *
 * Returns undefined when no valid options are present (then the deck renders
 * the decision like a generic gate: only a reference to the stream card).
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

  // Exactly ONE recommended option: if none is server-marked, the first
  // becomes the primary action (deterministic default). If there are several, the
  // first marked one wins — all others are reset to not-recommended,
  // so the deck never renders two „primary" actions.
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
 * Reads a description from the payload (N1: verbatim). Multiple paths
 * are tried (description, reason, message, preview), the first
 * string field wins. Fallback: empty string — the consumer must handle
 * it (the surface shows e.g. the kind as a label).
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
 * Reads the provider slug from a credential-request gate payload. Needed for
 * resolution against `api_credentials` (is the key now stored in the
 * vault?). Multiple paths, the first string field wins. '' if none.
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
 * ── Gate resolution ──────────────────────────────────────────────────────────
 *
 * BLOCKER 2 (critic, 2026-05-30): `blockingGates` was NEVER filtered against the
 * approve/deny/consume decision. Consequence: after „OK weiter" the
 * gate stays pinned in the deck until the event rolls out of the LIMIT-200 window — the
 * deck pins an already-answered gate permanently. „Die Region lügt."
 *
 * There is NO single gate-resolution table. The real approve paths
 * write into different truth stores (file:line per card handler):
 *
 *   • live-warn          → POST /api/workspaces/[id]/live-warn-ack
 *                          → `recordLiveWarnAck` (lib/connectors/live-warn.ts:88)
 *                          → workspace_beliefs row, topic='live-warn-acked',
 *                            belief 'ack:…' | 'decline:…'. BOTH decisions
 *                            resolve the *current* one-shot gate (the owner
 *                            HAS answered); a 'decline' makes the warning
 *                            reappear on the next LIVE run, that is a
 *                            NEW gate event with a higher created_at.
 *
 *   • credential-request → CredentialRequestCard → POST
 *                          /api/connectors/[provider]/credential → `putApiCredential`
 *                          (lib/credentials/vault.ts:414) → api_credentials row
 *                          (scope_kind, scope_id=workspaceId|orgId, provider).
 *                          If a credential for the provider exists that was created
 *                          AFTER the gate → gate done.
 *
 *   • connector-call-preview / counter-evidence / human-decision (decision-brief)
 *                        → NO server-side resolution write today.
 *                          connector-invoke only pushes an assistant confirmation;
 *                          decision-brief is EVENT-ONLY (local state,
 *                          SurfaceRenderer.tsx:5843) → writes NOTHING to the DB.
 *                          For these kinds there is nothing to join server-side;
 *                          the optimistic consume marking happens
 *                          client-side (useWorkspaceState consumedGateKey) until
 *                          a real resolution write exists. Honestly:
 *                          that is the limit of today's substrate.
 *
 * This function returns a predicate `(gate) → resolved` that joins the two REAL
 * DB mechanisms. Everything fail-soft: missing table / DB error →
 * the gate counts as NOT resolved (prefer over-pin to a silent disappearance).
 */
interface GateResolutionIndex {
  /** Most recent live-warn-acked belief timestamp (or -1). */
  liveWarnAckedAt: number;
  /** provider(lowercased) → most recent api_credentials.created_at for this WS/org. */
  credentialCreatedAt: Map<string, number>;
  /**
   * F18 (2026-05-30): most recent user-reply timestamp (chat_message_sent with
   * payload.role='user') in the workspace, or -1. A pinned decision/
   * quickchoice counts as answered once the user has sent a
   * message AFTER the gate — the `reply(label)` path of every decision/
   * quickchoice card posts exactly such a user message. This is the ONLY
   * honest DB resolution mechanism for decisions (there is no dedicated
   * decision_answers table); analogous to `readAnsweredKeys` for questions.
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

  // ── decision/quickchoice → most recent user reply (chat_message_sent role=user) ──
  // A pinned decision is answered when the user sends a message
  // (the reply(label) path of the card). We read the most recent such
  // event; every decision with createdAt <= lastUserReplyAt counts as answered.
  // payload.role='user' filters robustly even when the actor string varies.
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
        break; // DESC sorted → the first user event is the most recent.
      }
    }
  } catch {
    /* fail-soft: no reply info → decision stays visible. */
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
    /* fail-soft: no resolution info → gate stays visible. */
  }

  // ── credential-request → api_credentials(provider, scope) ─────────────────
  // scope_id is the workspaceId (workspace scope) OR an orgId (org scope).
  // We join defensively over BOTH: a credential in the workspace scope for the
  // provider counts for sure; org scope we cannot map exactly to the workspace
  // without an org lookup → we take workspace scope (the common case of the
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
 * Predicate: is this gate resolved by a REAL DB write? Only the two
 * kinds with a resolution store are answered positively here — the rest
 * return false (no server-side mechanism; see the docs above).
 */
function isGateResolved(
  gate: { kind: BlockingGateKind; createdAt: number; provider: string },
  index: GateResolutionIndex,
): boolean {
  switch (gate.kind) {
    case 'live-warn':
      // The owner answered AFTER the gate was emitted.
      return index.liveWarnAckedAt >= gate.createdAt;
    case 'credential-request': {
      if (gate.provider.length === 0) return false;
      const at = index.credentialCreatedAt.get(gate.provider.toLowerCase());
      return typeof at === 'number' && at >= gate.createdAt;
    }
    case 'decision':
      // F18: decision/quickchoice counts as answered once the user has sent a
      // message AFTER the gate (reply(label) path of the card).
      // Strictly `>` — a reply with the same timestamp would be the same surface
      // emission, not the answer to it.
      return index.lastUserReplyAt > gate.createdAt;
    default:
      // connector-call-preview / counter-evidence / human-decision:
      // no server-side resolution write → never marked as resolved here.
      return false;
  }
}

/**
 * Reads the phase from an active plan step for currentPhase.
 * SQL-only. If the workstream_plan_steps table is missing → undefined.
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
 * Reads the last updated_at of a plan step in the workstream — used
 * to refine the lastEventAt of a flow_run.
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
 * Reads the answers from question_answers (P1.AB track). If the table
 * does not exist, that is non-fatal — the function returns an empty set.
 * A minimal schema is assumed:
 *   question_answers(question_set_id TEXT, question_id TEXT, …)
 * (The combined key is the join key — exotic fields are ignored.)
 */
function readAnsweredKeys(
  raw: Sqlite,
  workspaceId: string,
): Set<string> {
  const answered = new Set<string>();
  try {
    // Probe: does the table exist?
    const probe = raw
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='question_answers'`,
      )
      .get() as { name?: string } | undefined;
    if (!probe?.name) return answered;

    // P1.AB may define the schema itself. We read defensively: if
    // workspace_id exists, we filter, otherwise we take all answers.
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
      // Fallback: no workspace_id column → unfiltered.
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
 * Returns the most recent lifecycle event row with a positive outcome for the
 * workspace, or null. Vocabulary:
 *   - eventType = 'workflow.completed'
 *   - eventType = 'workflow.transitioned' AND payload.outcome === 'success'
 *   - eventType = 'chat_message_completed'
 *
 * Up to 280 characters are taken verbatim from payload.summary / payload.text
 * (N1: no .slice on ledger fields — the 280 is a UI hint,
 * not a truncation of the truth log).
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
        // Only count as success when payload.outcome is explicitly success.
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
// Main function
// ───────────────────────────────────────────────────────────────────────────

/**
 * Aggregates the operational state of a workspace deterministically from the DB.
 *
 * @param raw         raw better-sqlite3 handle (test: :memory: · prod: getDb().$raw)
 * @param workspaceId ManifestCoord workspace_id (corresponds to events.segment_id)
 * @returns           a complete WorkspaceState. Never throws — on
 *                    DB errors a minimal state is returned.
 *
 * Latency budget: <100ms for 1000 events + 50 workstreams (performance smoke).
 */
export function projectWorkspaceState(
  raw: Sqlite,
  workspaceId: string,
): WorkspaceState {
  const generatedAt = Date.now();

  // Defensive minimal-state builder: every single SELECT in try/catch.
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
  // Most recent flow_run with status ∈ {pending, running} in the workspace.
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

  // If no non-final flow_run: take the most recent one at all (for the lastEventAt
  // display in the UI). BUT we don't return it as activeFlowRun if it
  // is already 'done' / 'failed' / 'cancelled' — that would be history, not state.
  // → activeFlowRun stays null.

  // ── 3. Open Questions ────────────────────────────────────────────────────
  // Search for chat_message events with payload.kind ∈ {open-questions,plan-open-questions}
  // in the workspace, most recent first, dedupe per (set,id).
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
    // Already sorted DESC (by the SQL ORDER BY).
    openQuestions = collected;
  } catch {
    openQuestions = [];
  }

  // ── 4. Blocking Gates ────────────────────────────────────────────────────
  // chat_message surfaces with gate vocabulary. Dedupe per (kind, workstreamId,
  // description) — the same gate surface multiple times in the history counts once.
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
    // BLOCKER 2 (2026-05-30): build the resolution index ONCE (two small
    // indexed queries) and filter every gate against the real approve write,
    // analogous to `readAnsweredKeys` for questions. Without this the deck pins
    // an already-answered gate permanently.
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
      // F18: for decision/quickchoice/tier-choice carry the options verbatim
      // (exactly one is marked as recommended). Other gate kinds → undefined.
      const options =
        kind === 'decision' ? extractGateOptions(payload) : undefined;
      // Headline fallback for decisions: if no description, take the
      // verbatim headline (renderDecision requires it); if that's missing too
      // (quickchoice is option-only), synthesize a stable signature from
      // the option labels — so the ActionDeck pin and the in-feed card match
      // over the same signature (suppression) and the dedupe applies.
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
      // Resolved gate (real DB approve / user reply after the gate) → do NOT pin.
      if (isGateResolved({ kind, createdAt: r.created_at, provider }, resolution)) {
        continue;
      }
      collected.push({
        kind,
        workstreamId: ws,
        description: effectiveDescription, // N1: verbatim from payload
        createdAt: r.created_at,
        ...(options ? { options } : {}),
      });
    }
    blockingGates = collected;
  } catch {
    blockingGates = [];
  }

  // ── 5. Assemble the active FlowRun ─────────────────────────────────────
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

  // ── 7. Next Allowed User Input — derived deterministically ──────────────
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
 * Deterministic derivation of `nextAllowedUserInput`:
 *
 *   1. If a blocking gate is open               → 'approve-gate'
 *   2. Otherwise, if an unanswered question     → 'answer-question'
 *   3. Otherwise, if a FlowRun runs OR workstreams are active → 'wait'
 *   4. Otherwise                                → 'free-prompt'
 *
 * This order is deliberate — gates take precedence over questions,
 * because a gate (e.g. credential-request) blocks the run completely,
 * a question is merely a clarification.
 *
 * Exported for tests + UI consumers that want to reuse the same
 * vocabulary client-side.
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
