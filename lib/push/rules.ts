/**
 * Push-Rules — deklarativ.
 *
 * Jede Regel hat:
 *   - id: stabil, im push_audit-Log sichtbar
 *   - when: Match-Predicate gegen ein LazyEvent
 *   - build: Notification-Body + URL
 *   - dedupKey: optionaler Schlüssel für Dedup (gleicher Key innerhalb
 *               DEDUP_WINDOW_MS → skip). Default: `${ruleId}:${entityId}`.
 *   - rateLimit: per-rule Fenster+Max (zusätzlich zum Global-Cap).
 *   - stateful: optional, erlaubt der Regel einen internen Counter-State
 *               zu pflegen (z.B. "5 Errors in 5min"). Dafür gibt es eine
 *               separate countWindow-Helper-Function, die in-memory oder
 *               via dedup-Tabelle zählt.
 *
 * Neue Regeln: hier hinzufügen, tests in rules.test.ts erweitern.
 * Keine Regel darf `throw`en — Fehler im `when`/`build` werden vom
 * Trigger gefangen und als push_audit 'error'-Entry protokolliert.
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
 * Sub-Plan 03 — Pattern 4d: Priority-Floor pro Rule (2026-04-30).
 *
 * Default-Priority pro Rule, konsistent mit dem User-Floor:
 *   - 'p0' / 'p1' = deliver immediately (default)
 *   - 'p2' = digest-eligible (Sammel-Push 1×/h, in Sprint 1.1 implementiert)
 *
 * Payload-Override (event.payload.pushPriority) ist möglich, aber nur
 * über Whitelist (siehe `resolvePriority`) — keine willkürliche
 * Eskalation durch Sub-Agents.
 */
export type PushPriority = 'p0' | 'p1' | 'p2';

export interface PushRule {
  id: string;
  when: (event: LazyEvent) => boolean;
  build: (event: LazyEvent) => PushNotification;
  dedupKey?: (event: LazyEvent) => string;
  rateLimit?: RuleRateLimit;
  /**
   * Sub-Plan 03 — Pattern 4d: Default-Priority der Rule. Falls nicht
   * gesetzt, gilt 'p1' (Standard-Push). 'p2' = digest-eligible.
   */
  priority?: PushPriority;
  /**
   * Wenn gesetzt, wird die Regel nur ausgelöst wenn `countRecentEvents`
   * einen Burst-Match meldet. Das ist unser Weg, "5 Errors in 5 Min" zu
   * implementieren, ohne einen separaten Stateful-Agent zu bauen.
   */
  burst?: {
    count: number;
    windowMs: number;
    /** Key für den Burst-Counter (z.B. der Segment oder 'global'). */
    bucketKey: (event: LazyEvent) => string;
  };
}

/**
 * Resolve final priority for a (rule, event)-pair.
 *
 * Whitelist-Logik:
 *   - Rule-default greift immer.
 *   - Event-payload kann SENKEN (nie eskalieren) — verhindert dass
 *     Sub-Agents stille Rules zu P0 aufmotzen.
 */
export function resolvePriority(rule: PushRule, event: LazyEvent): PushPriority {
  const ruleDefault: PushPriority = rule.priority ?? 'p1';
  const overrideRaw =
    typeof event.payload['pushPriority'] === 'string'
      ? (event.payload['pushPriority'] as string).toLowerCase()
      : undefined;
  if (overrideRaw === 'p0' || overrideRaw === 'p1' || overrideRaw === 'p2') {
    // Senkt bei höherer Default-Stufe (z.B. P0-Default + p2-Override = p2),
    // lässt aber keine Eskalation zu (z.B. P2-Default + p0-Override = bleibt p2).
    const order: Record<PushPriority, number> = { p0: 0, p1: 1, p2: 2 };
    return order[overrideRaw] >= order[ruleDefault] ? overrideRaw : ruleDefault;
  }
  return ruleDefault;
}

/**
 * Sub-Plan 03 — Pattern 4d: Dedup-Key Suffix mit Priority.
 * P0 und P2 Pushes für gleiche Entity sollen NICHT denselben Dedup-Key
 * teilen — der P0 darf trotz P2-Vorgänger durchkommen.
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
// Helpers — typed payload-reads (LazyEvent.payload ist Record<string,unknown>)
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
 * Rule 1: neues P0-Ticket → sofortiger Push.
 * Event-Type 'ticket_created' wird von Stream C emittiert. Fallback
 * auf 'created' mit entityType='ticket' falls Stream C noch nicht auf
 * den neuen Event-Type gewechselt ist (defensive).
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
 * Rule 2: Freigabe-Anfrage → Push (Max ist der Approver).
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
 * Rule 3: Workspace ist stale > 1h.
 * Event-Payload: { status: 'stale', lag_sec: number, workspaceId?: string }
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
  // Cap: max 1 stale-Push pro Workspace pro Tag — der grundsätzliche
  // Dedup (5min) wäre zu eng, der Status wird minütlich emittiert.
  rateLimit: { per: "day", max: 1 },
  priority: 'p2',
};

/**
 * Rule 4: Error-Burst — 5 error_logged in 5 Min.
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
 * Rule 5: Routine-Failure.
 * Event-Payload: { status: 'success' | 'failure', name?: string, routineId?: string }
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
 * Rule 6: Phase AD · Master-Auto-Close nach allen Sub-Tickets done.
 * Event: updated mit transition='auto_close_after_subs'
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
 * Rule 7: Phase AD · Sub-Pipeline endgültig fehlgeschlagen (nach Retries).
 * Event: updated mit transition='auto_dispatch_failed'
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
      // Tag pro Workstream — replace-Verhalten, keine Stacks bei
      // mehreren Pausen im selben Workstream.
      tag: `sniper-${p.workstreamId ?? e.entityId}`,
    };
  },
  dedupKey: (e) => {
    const p = (e.payload ?? {}) as { workstreamId?: string; after?: string };
    // Pro Workstream + Phase ein Push (also nach Roast einer, nach V2
    // einer, ...) — sonst würden alle 4 Pausen einen Push schicken,
    // was zu viel ist.
    return `sniper-pause:${p.workstreamId ?? e.entityId}:${p.after ?? "roast"}`;
  },
  rateLimit: { per: "minute", max: 5 },
  priority: 'p1',
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Rule (2026-04-29): Workstream-Stuck → Push. Stuck-Detector emittiert
 * `workstream-stuck`-Event wenn ein active-WS > 2 min keine neuen Events.
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
 * Rule (2026-04-29): Open-Questions im Plan → Push. Wenn V_n eine
 * `## Offene Fragen`-Section mit ≥ 1 Bullet hat, emit den Push-Trigger.
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
 * Rule: Subplan wartet auf Freigabe (awaitingApproval:true).
 * Event: answer_required mit kind='approval'.
 *
 * Visibility-Gate greift im dispatchPushTriggers-Pfad NICHT automatisch
 * — muss der Emitter via isAnyClientVisible vorab prüfen (wie onChatMessageCompleted).
 * Hier: Dedup pro workstreamId + rateLimit verhindert Spam.
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
 * Rule: Connector-Call-Preview wartet auf Freigabe.
 * Event: answer_required mit kind='connector-preview'.
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
 * Rule: Offene Fragen in einer Chat-Antwort (Inline-Open-Questions-Card).
 * Wird via answer_required mit kind='open-questions' getriggert.
 * Emittiert von plan-dispatch / surface-emit sobald eine
 * Offene-Fragen-Section erkannt wird.
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
 * Rule (2026-05-25): Recovery-Sweep hat einen Workstream auf stuck gesetzt.
 * Event: answer_required mit kind='run-stuck'.
 *
 * Emittiert von lib/workstreams/recovery.ts via emitAnswerRequired.
 * Visibility-Gate greift bereits im emitAnswerRequired-Body (kein Push wenn
 * Tab sichtbar). Dedup pro Workstream-ID: max 1 stuck-Push alle 2h.
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
  // Max 1 stuck-Push pro Workstream pro 2 Stunden — verhindert Spam wenn
  // die Recovery mehrfach läuft bevor der User antwortet.
  rateLimit: { per: 'hour', max: 1 },
  priority: 'p1',
};

/**
 * Rule (P13, 2026-05-01): Synthesis nicht-falsifizierbar →
 * Devil's Advocate konnte keine Counter-Evidence finden, These ist
 * möglicherweise tautologisch. User soll aktiv re-formulieren.
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
 * Rule (P2, 2026-06-02): Neue Kundennachricht in einem Workspace-Sub-Chat.
 * Event: subchat_message mit authorKind='external' (interne/system Nachrichten
 * lösen KEINEN Push aus — nur echte eingehende Kundennachrichten). Der Titel des
 * Sub-Chats kommt aus dem Payload (title). Dedup pro Sub-Chat: ein Push pro
 * Sub-Chat im Dedup-Fenster, damit eine schnelle Kunden-Nachrichtenfolge nicht
 * 10 Pushs erzeugt.
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
      // Deep-Link direkt in den Kundenchat-Thread (wie ein WhatsApp-Tap) — der
      // Operator landet sofort im Gespräch zum Antworten. P1-Nav-Fix hält diese
      // URL stabil (kein Redirect zu __org_root__). Frühere `/?workspace=`-URL
      // wurde vom Home (liest `?ws=`) ignoriert → landete unscoped.
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
  // Sub-Chats (2026-06-02, P2) — neue externe Kundennachricht.
  subchatExternalMessage,
  // B1 Answer-Required (2026-05-25)
  answerRequiredApproval,
  answerRequiredConnectorPreview,
  answerRequiredOpenQuestions,
  // Recovery (2026-05-25)
  runStuck,
];

/**
 * Test-Hook: liefert eine Regel nach id — nur für rules.test.ts.
 */
export function findRuleById(id: string): PushRule | undefined {
  return PUSH_RULES.find((r) => r.id === id);
}
