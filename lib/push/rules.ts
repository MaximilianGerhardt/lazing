/**
 * Push-Rules — declarative.
 *
 * Each rule has:
 *   - id: stable, visible in the push_audit log
 *   - when: match predicate against a LazyEvent
 *   - build: notification body + URL
 *   - dedupKey: optional key for dedup (same key within
 *               DEDUP_WINDOW_MS → skip). Default: `${ruleId}:${entityId}`.
 *   - rateLimit: per-rule window+max (in addition to the global cap).
 *   - stateful: optional, lets the rule maintain an internal counter state
 *               (e.g. "5 errors in 5min"). For that there is a
 *               separate countWindow helper function that counts in-memory or
 *               via the dedup table.
 *
 * New rules: add here, extend tests in rules.test.ts.
 * No rule may `throw` — errors in `when`/`build` are caught by the
 * trigger and logged as a push_audit 'error' entry.
 */

import type { LazyEvent } from "../events/types";

export interface PushNotification {
  title: string;
  body: string;
  url: string;
  tag?: string;
}

export interface RuleRateLimit {
  per: "minute" | "hour" | "day";
  max: number;
}

export function windowMsForRateLimit(rl: RuleRateLimit): number {
  switch (rl.per) {
    case "minute":
      return 60_000;
    case "hour":
      return 3_600_000;
    case "day":
      return 86_400_000;
  }
}

/**
 * Sub-Plan 03 — Pattern 4d: Priority floor per rule (2026-04-30).
 *
 * Default priority per rule, consistent with the user floor:
 *   - 'p0' / 'p1' = deliver immediately (default)
 *   - 'p2' = digest-eligible (batched push 1×/h, implemented in Sprint 1.1)
 *
 * A payload override (event.payload.pushPriority) is possible, but only
 * via a whitelist (see `resolvePriority`) — no arbitrary
 * escalation by sub-agents.
 */
export type PushPriority = 'p0' | 'p1' | 'p2';

export interface PushRule {
  id: string;
  when: (event: LazyEvent) => boolean;
  build: (event: LazyEvent) => PushNotification;
  dedupKey?: (event: LazyEvent) => string;
  rateLimit?: RuleRateLimit;
  /**
   * Sub-Plan 03 — Pattern 4d: Default priority of the rule. If not
   * set, 'p1' applies (standard push). 'p2' = digest-eligible.
   */
  priority?: PushPriority;
  /**
   * When set, the rule is only triggered if `countRecentEvents`
   * reports a burst match. This is our way to implement "5 errors in 5 min"
   * without building a separate stateful agent.
   */
  burst?: {
    count: number;
    windowMs: number;
    /** Key for the burst counter (e.g. the segment or 'global'). */
    bucketKey: (event: LazyEvent) => string;
  };
}

/**
 * Resolve final priority for a (rule, event)-pair.
 *
 * Whitelist logic:
 *   - The rule default always applies.
 *   - The event payload can LOWER (never escalate) — prevents
 *     sub-agents from bumping quiet rules up to P0.
 */
export function resolvePriority(rule: PushRule, event: LazyEvent): PushPriority {
  const ruleDefault: PushPriority = rule.priority ?? 'p1';
  const overrideRaw =
    typeof event.payload['pushPriority'] === 'string'
      ? (event.payload['pushPriority'] as string).toLowerCase()
      : undefined;
  if (overrideRaw === 'p0' || overrideRaw === 'p1' || overrideRaw === 'p2') {
    // Lowers when the default is higher (e.g. P0-default + p2-override = p2),
    // but allows no escalation (e.g. P2-default + p0-override = stays p2).
    const order: Record<PushPriority, number> = { p0: 0, p1: 1, p2: 2 };
    return order[overrideRaw] >= order[ruleDefault] ? overrideRaw : ruleDefault;
  }
  return ruleDefault;
}

/**
 * Sub-Plan 03 — Pattern 4d: Dedup-key suffix with priority.
 * P0 and P2 pushes for the same entity should NOT share the same dedup key
 * — the P0 may come through despite a P2 predecessor.
 */
export function dedupKeyWithPriority(
  rule: PushRule,
  event: LazyEvent,
): string | undefined {
  if (!rule.dedupKey) return undefined;
  const base = rule.dedupKey(event);
  const prio = resolvePriority(rule, event);
  return `${base}:${prio}`;
}

// ---------------------------------------------------------------------------
// Helpers — typed payload-reads (LazyEvent.payload is Record<string,unknown>)
// ---------------------------------------------------------------------------

function asStr(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asNum(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function firstLine(s: string | undefined, max = 80): string {
  if (!s) return "";
  const line = s.split("\n")[0];
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/**
 * Rule 1: new P0 ticket → immediate push.
 * Event type 'ticket_created' is emitted by Stream C. Fallback
 * to 'created' with entityType='ticket' in case Stream C has not yet switched
 * to the new event type (defensive).
 */
const ticketP0Created: PushRule = {
  id: "ticket-p0-created",
  when: (e) => {
    const isTicketCreate =
      e.eventType === "ticket_created" ||
      (e.eventType === "created" && e.entityType === "ticket");
    if (!isTicketCreate) return false;
    const prio = asStr(e.payload.prio) ?? asStr(e.payload.priority);
    if (!prio) return false;
    return prio.toUpperCase().startsWith("P0");
  },
  build: (e) => {
    const title = asStr(e.payload.title) ?? "Neues Ticket";
    return {
      title: "Neues P0-Ticket",
      body: firstLine(title, 120),
      url: `/tickets/${encodeURIComponent(e.entityId)}`,
      tag: `ticket-${e.entityId}`,
    };
  },
  dedupKey: (e) => `ticket-p0:${e.entityId}`,
  rateLimit: { per: "hour", max: 10 },
  priority: 'p0',
};

/**
 * Rule 2: approval request → push (the operator is the approver).
 */
const approvalRequested: PushRule = {
  id: "approval-requested",
  when: (e) => e.eventType === "approval_requested",
  build: (e) => {
    const from = asStr(e.payload.from);
    return {
      title: "Freigabe erforderlich",
      body: `${e.entityId}${from ? ` (aus ${from})` : ""} wartet auf deine Freigabe`,
      url: `/tickets/${encodeURIComponent(e.entityId)}`,
      tag: `approval-${e.entityId}`,
    };
  },
  dedupKey: (e) => `approval:${e.entityId}`,
  rateLimit: { per: "hour", max: 20 },
  priority: 'p1',
};

/**
 * Rule 3: workspace is stale > 1h.
 * Event payload: { status: 'stale', lag_sec: number, workspaceId?: string }
 */
const workspaceStale: PushRule = {
  id: "workspace-stale",
  when: (e) => {
    if (e.eventType !== "workspace_heartbeat") return false;
    if (e.payload.status !== "stale") return false;
    const lag = asNum(e.payload.lag_sec);
    return typeof lag === "number" && lag > 3600;
  },
  build: (e) => {
    const lag = asNum(e.payload.lag_sec) ?? 0;
    const hrs = Math.round(lag / 3600);
    const ws =
      asStr(e.payload.workspaceId) ?? e.segmentId ?? "unknown";
    return {
      title: "Workspace schläft",
      body: `${ws} ist seit ${hrs}h stale`,
      url: `/observatory#workspaces`,
      tag: `stale-${ws}`,
    };
  },
  dedupKey: (e) => `stale:${asStr(e.payload.workspaceId) ?? e.segmentId}`,
  // Cap: max 1 stale push per workspace per day — the basic
  // dedup (5min) would be too tight, the status is emitted every minute.
  rateLimit: { per: "day", max: 1 },
  priority: 'p2',
};

/**
 * Rule 4: error burst — 5 error_logged in 5 min.
 */
const errorsBurst: PushRule = {
  id: "errors-burst",
  when: (e) => e.eventType === "error_logged",
  build: () => ({
    title: "Error-Burst",
    body: "5 Errors in 5 Min — check Observatory",
    url: `/observatory#errors`,
    tag: "errors-burst",
  }),
  dedupKey: () => `errors-burst:global`,
  rateLimit: { per: "hour", max: 4 },
  burst: {
    count: 5,
    windowMs: 5 * 60 * 1000,
    bucketKey: () => `errors-burst:global`,
  },
  priority: 'p0',
};

/**
 * Rule 5: routine failure.
 * Event payload: { status: 'success' | 'failure', name?: string, routineId?: string }
 */
const routineFailed: PushRule = {
  id: "routine-failed",
  when: (e) => {
    if (e.eventType !== "routine_run") return false;
    return e.payload.status === "failure";
  },
  build: (e) => {
    const name = asStr(e.payload.name) ?? asStr(e.payload.routineId) ?? e.entityId;
    const err = asStr(e.payload.error);
    return {
      title: "Routine fehlgeschlagen",
      body: err ? `${name}: ${firstLine(err, 100)}` : name,
      url: `/routines`,
      tag: `routine-${e.entityId}`,
    };
  },
  dedupKey: (e) => `routine-failed:${e.entityId}`,
  rateLimit: { per: "hour", max: 10 },
  priority: 'p1',
};

/**
 * Rule 6: Phase AD · master auto-close after all sub-tickets done.
 * Event: updated with transition='auto_close_after_subs'
 */
const masterAutoClosed: PushRule = {
  id: "master-auto-closed",
  when: (e) => {
    if (e.eventType !== "updated") return false;
    return asStr(e.payload.transition) === "auto_close_after_subs";
  },
  build: (e) => {
    const total = asNum(e.payload.subTicketsTotal);
    const totalStr = total ? ` · ${total} Sub-Tickets erledigt` : "";
    return {
      title: "Master fertig",
      body: `${e.entityId}${totalStr}`,
      url: `/tickets/${encodeURIComponent(e.entityId)}`,
      tag: `master-closed-${e.entityId}-${Date.now()}`,
    };
  },
  dedupKey: (e) => `master-closed:${e.entityId}`,
  rateLimit: { per: "hour", max: 30 },
  priority: 'p2',
};

/**
 * Rule 7: Phase AD · sub-pipeline finally failed (after retries).
 * Event: updated with transition='auto_dispatch_failed'
 */
const subDispatchFailed: PushRule = {
  id: "sub-dispatch-failed",
  when: (e) => {
    if (e.eventType !== "updated") return false;
    return asStr(e.payload.transition) === "auto_dispatch_failed";
  },
  build: (e) => {
    const stage = asStr(e.payload.failedStage) ?? "unknown";
    const reason = asStr(e.payload.error) ?? "fehlgeschlagen";
    return {
      title: "Sub-Pipeline fehlgeschlagen",
      body: `${e.entityId} · Stage ${stage}: ${reason.slice(0, 60)}`,
      url: `/tickets/${encodeURIComponent(e.entityId)}`,
      tag: `dispatch-failed-${e.entityId}-${Date.now()}`,
    };
  },
  dedupKey: (e) => `dispatch-failed:${e.entityId}`,
  rateLimit: { per: "hour", max: 20 },
  priority: 'p1',
};

// ---------------------------------------------------------------------------
// Sniper-Pause-Window (Phase Sniper, 2026-04-28)
// ---------------------------------------------------------------------------

const sniperPauseStart: PushRule = {
  id: "sniper-pause-start",
  when: (e) => {
    if (e.eventType !== "commented") return false;
    const p = (e.payload ?? {}) as { kind?: string };
    return p.kind === "sniper-pause-start";
  },
  build: (e) => {
    const p = (e.payload ?? {}) as {
      after?: string;
      durationMs?: number;
      workstreamId?: string;
    };
    const seconds = Math.round((p.durationMs ?? 25000) / 1000);
    const phase =
      p.after === "synthesis"
        ? "Synthesis"
        : p.after?.startsWith("v")
          ? p.after.toUpperCase()
          : "Roast";
    return {
      title: `Sniper-Window offen · ${seconds}s`,
      body: `Nach ${phase} kannst du jetzt korrigieren — ${seconds}s bis zur nächsten Iteration.`,
      url: p.workstreamId
        ? `/workstreams/${encodeURIComponent(p.workstreamId)}`
        : "/workstreams",
      // Tag per workstream — replace behaviour, no stacks when there are
      // multiple pauses in the same workstream.
      tag: `sniper-${p.workstreamId ?? e.entityId}`,
    };
  },
  dedupKey: (e) => {
    const p = (e.payload ?? {}) as { workstreamId?: string; after?: string };
    // One push per workstream + phase (so one after Roast, one after V2,
    // ...) — otherwise all 4 pauses would each send a push,
    // which is too much.
    return `sniper-pause:${p.workstreamId ?? e.entityId}:${p.after ?? "roast"}`;
  },
  rateLimit: { per: "minute", max: 5 },
  priority: 'p1',
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Rule (2026-04-29): workstream stuck → push. The stuck detector emits
 * a `workstream-stuck` event when an active WS has no new events for > 2 min.
 */
const workstreamStuck: PushRule = {
  id: 'workstream-stuck',
  when: (e) => {
    if (e.eventType !== 'commented') return false;
    const p = e.payload as { kind?: string };
    return p.kind === 'workstream-stuck';
  },
  build: (e) => {
    const wsId = asStr(e.payload.workstreamId) ?? '';
    const minSince = asNum(e.payload.minutesSinceLastEvent) ?? 0;
    return {
      title: 'Workstream hängt',
      body: `Kein Fortschritt seit ${Math.round(minSince)} min · Resume oder Cancel?`,
      url: wsId ? `/workstreams/${encodeURIComponent(wsId)}` : '/workstreams',
      tag: `stuck-${wsId}`,
    };
  },
  dedupKey: (e) => `stuck:${asStr(e.payload.workstreamId) ?? e.entityId}`,
  rateLimit: { per: 'hour', max: 4 },
  priority: 'p1',
};

/**
 * Rule (2026-04-29): open questions in the plan → push. When V_n has an
 * `## Offene Fragen` section with ≥ 1 bullet, emit the push trigger.
 */
const planHasOpenQuestions: PushRule = {
  id: 'plan-open-questions',
  when: (e) => {
    if (e.eventType !== 'commented') return false;
    const p = e.payload as { kind?: string };
    return p.kind === 'plan-open-questions';
  },
  build: (e) => {
    const wsId = asStr(e.payload.workstreamId) ?? '';
    const count = asNum(e.payload.questionCount) ?? 0;
    const v = asNum(e.payload.version) ?? 0;
    return {
      title: 'Plan fragt dich',
      body: `${count} ${count === 1 ? 'offene Frage' : 'offene Fragen'} in V${v} · Antwort im Chat möglich`,
      url: '/',
      tag: `q-${wsId}-v${v}`,
    };
  },
  dedupKey: (e) =>
    `q:${asStr(e.payload.workstreamId) ?? e.entityId}:v${asNum(e.payload.version) ?? 0}`,
  rateLimit: { per: 'hour', max: 6 },
  priority: 'p1',
};

// ---------------------------------------------------------------------------
// Answer-Required Rules (B1, 2026-05-25)
// ---------------------------------------------------------------------------

/**
 * Rule: subplan is awaiting approval (awaitingApproval:true).
 * Event: answer_required with kind='approval'.
 *
 * The visibility gate does NOT apply automatically in the dispatchPushTriggers path
 * — the emitter must check it up front via isAnyClientVisible (like onChatMessageCompleted).
 * Here: dedup per workstreamId + rateLimit prevents spam.
 */
const answerRequiredApproval: PushRule = {
  id: 'answer-required-approval',
  when: (e) => {
    if (e.eventType !== 'answer_required') return false;
    return asStr(e.payload.kind) === 'approval';
  },
  build: (e) => {
    const preview = asStr(e.payload.preview) ?? 'Plan wartet auf deine Freigabe';
    const url = asStr(e.payload.url) ?? '/';
    return {
      title: 'Antwort erforderlich — Freigabe',
      body: firstLine(preview, 100),
      url,
      tag: `answer-approval-${e.entityId}`,
    };
  },
  dedupKey: (e) => `answer-approval:${asStr(e.payload.workspaceId) ?? e.segmentId}:${e.entityId}`,
  rateLimit: { per: 'hour', max: 10 },
  priority: 'p1',
};

/**
 * Rule: connector-call preview is awaiting approval.
 * Event: answer_required with kind='connector-preview'.
 */
const answerRequiredConnectorPreview: PushRule = {
  id: 'answer-required-connector-preview',
  when: (e) => {
    if (e.eventType !== 'answer_required') return false;
    return asStr(e.payload.kind) === 'connector-preview';
  },
  build: (e) => {
    const preview = asStr(e.payload.preview) ?? 'Connector-Aufruf wartet auf Freigabe';
    const url = asStr(e.payload.url) ?? '/';
    return {
      title: 'Antwort erforderlich — Connector',
      body: firstLine(preview, 100),
      url,
      tag: `answer-connector-${e.entityId}`,
    };
  },
  dedupKey: (e) => `answer-connector:${asStr(e.payload.workspaceId) ?? e.segmentId}:${e.entityId}`,
  rateLimit: { per: 'hour', max: 10 },
  priority: 'p1',
};

/**
 * Rule: open questions in a chat reply (inline open-questions card).
 * Triggered via answer_required with kind='open-questions'.
 * Emitted by plan-dispatch / surface-emit as soon as an
 * open-questions section is detected.
 */
const answerRequiredOpenQuestions: PushRule = {
  id: 'answer-required-open-questions',
  when: (e) => {
    if (e.eventType !== 'answer_required') return false;
    return asStr(e.payload.kind) === 'open-questions';
  },
  build: (e) => {
    const preview = asStr(e.payload.preview) ?? 'Offene Fragen warten auf deine Antwort';
    const url = asStr(e.payload.url) ?? '/';
    return {
      title: 'Antwort erforderlich — Offene Fragen',
      body: firstLine(preview, 100),
      url,
      tag: `answer-oq-${e.entityId}`,
    };
  },
  dedupKey: (e) => `answer-oq:${asStr(e.payload.workspaceId) ?? e.segmentId}:${e.entityId}`,
  rateLimit: { per: 'hour', max: 6 },
  priority: 'p1',
};

/**
 * Rule (2026-05-25): the recovery sweep set a workstream to stuck.
 * Event: answer_required with kind='run-stuck'.
 *
 * Emitted by lib/workstreams/recovery.ts via emitAnswerRequired.
 * The visibility gate already applies in the emitAnswerRequired body (no push when
 * the tab is visible). Dedup per workstream ID: max 1 stuck push every 2h.
 */
const runStuck: PushRule = {
  id: 'run-stuck',
  when: (e) => {
    if (e.eventType !== 'answer_required') return false;
    return asStr(e.payload.kind) === 'run-stuck';
  },
  build: (e) => {
    const preview = asStr(e.payload.preview) ?? 'Workstream ohne Fortschritt gestoppt';
    const url = asStr(e.payload.url) ?? '/workstreams';
    return {
      title: 'Lauf gestoppt — Neu starten?',
      body: firstLine(preview, 100),
      url,
      tag: `run-stuck-${e.entityId}`,
    };
  },
  dedupKey: (e) => `run-stuck:${e.entityId}`,
  // Max 1 stuck push per workstream per 2 hours — prevents spam when
  // the recovery runs multiple times before the user replies.
  rateLimit: { per: 'hour', max: 1 },
  priority: 'p1',
};

/**
 * Rule (P13, 2026-05-01): synthesis non-falsifiable →
 * the Devil's Advocate could find no counter-evidence, the thesis is
 * possibly tautological. The user should actively re-formulate.
 */
const synthesisUnfalsifiable: PushRule = {
  id: 'synthesis-unfalsifiable',
  when: (e) => e.eventType === 'synthesis_unfalsifiable',
  build: (e) => {
    const wsId = asStr(e.payload.workstreamId) ?? '';
    return {
      title: 'Synthesis nicht-falsifizierbar — review',
      body: 'Devil\'s Advocate konnte keine Counter-Evidence finden. These möglicherweise tautologisch.',
      url: wsId
        ? `/workstreams/${encodeURIComponent(wsId)}`
        : `/tickets/${encodeURIComponent(e.entityId)}`,
      tag: `unfalsifiable-${e.entityId}`,
    };
  },
  dedupKey: (e) =>
    `unfalsifiable:${asStr(e.payload.workstreamId) ?? e.entityId}:${asStr(e.payload.synthesisHash) ?? 'no-hash'}`,
  rateLimit: { per: 'hour', max: 6 },
  priority: 'p1',
};

/**
 * Rule (P2, 2026-06-02): new customer message in a workspace sub-chat.
 * Event: subchat_message with authorKind='external' (internal/system messages
 * do NOT trigger a push — only genuine incoming customer messages). The title of
 * the sub-chat comes from the payload (title). Dedup per sub-chat: one push per
 * sub-chat in the dedup window, so a rapid sequence of customer messages does not
 * produce 10 pushes.
 */
const subchatExternalMessage: PushRule = {
  id: 'subchat-external-message',
  when: (e) => {
    if (e.eventType !== 'subchat_message') return false;
    return asStr(e.payload.authorKind) === 'external';
  },
  build: (e) => {
    const title = asStr(e.payload.title) ?? 'Kundenchat';
    const preview = asStr(e.payload.preview) ?? '';
    const subchatId = asStr(e.payload.subchatId) ?? e.entityId;
    const workspaceId = asStr(e.payload.workspaceId) ?? e.segmentId;
    return {
      title: `Neue Kundennachricht in ${title}`,
      body: preview ? firstLine(preview, 100) : 'Neue Nachricht im Kundenchat',
      // Deep-link directly into the customer-chat thread (like a WhatsApp tap) — the
      // operator lands in the conversation to reply immediately. The P1 nav fix keeps this
      // URL stable (no redirect to __org_root__). The earlier `/?workspace=` URL
      // was ignored by Home (which reads `?ws=`) → landed unscoped.
      url: `/workspaces/${encodeURIComponent(workspaceId)}/subchats/${encodeURIComponent(subchatId)}`,
      tag: `subchat-${subchatId}`,
    };
  },
  dedupKey: (e) => `subchat-msg:${asStr(e.payload.subchatId) ?? e.entityId}`,
  rateLimit: { per: 'hour', max: 20 },
  priority: 'p1',
};

export const PUSH_RULES: readonly PushRule[] = [
  ticketP0Created,
  approvalRequested,
  workspaceStale,
  errorsBurst,
  routineFailed,
  masterAutoClosed,
  subDispatchFailed,
  sniperPauseStart,
  workstreamStuck,
  planHasOpenQuestions,
  synthesisUnfalsifiable,
  // Sub-Chats (2026-06-02, P2) — new external customer message.
  subchatExternalMessage,
  // B1 Answer-Required (2026-05-25)
  answerRequiredApproval,
  answerRequiredConnectorPreview,
  answerRequiredOpenQuestions,
  // Recovery (2026-05-25)
  runStuck,
];

/**
 * Test hook: returns a rule by id — only for rules.test.ts.
 */
export function findRuleById(id: string): PushRule | undefined {
  return PUSH_RULES.find((r) => r.id === id);
}
