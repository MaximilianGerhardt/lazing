/**
 * lazyos event-sourced truth layer
 * -----------------------------------------
 * All entities (tickets, decisions, invoices, routines, notes) are
 * projections from this event log. Append-only, no mutations.
 *
 * See the plan file section 3.1 for the architecture core.
 *
 * Sprint 2 · Section 7C: switch from hard segment enums (@north,
 * @clientb, @own, @private, @system) to dynamic workspace IDs
 * (string, e.g. 'lazyos', 'demo-client', 'tap', 'private'). The IDs are
 * discovered from the projects directory (scripts/discover-workspaces.ts).
 *
 * Compatibility:
 *   - `SegmentId` stays as a string alias so existing code keeps typing.
 *     Runtime guards were switched to a string check (see `isWorkspaceId`).
 *   - `migrateSegmentToWorkspace()` translates old demo events to the new
 *     workspace IDs so existing event rows stay readable.
 */

export type WorkspaceId = string;

/**
 * @deprecated Alias of `WorkspaceId`. New code uses `WorkspaceId`.
 *             Existing call sites stay compilable.
 */
export type SegmentId = WorkspaceId;

/**
 * Old hardcoded segment IDs that may appear in the event log.
 * NOT for new code — only for migration.
 */
export const LEGACY_SEGMENT_IDS = [
  "@north",
  "@clientb",
  "@own",
  "@private",
  "@system",
] as const;

export type LegacySegmentId = (typeof LEGACY_SEGMENT_IDS)[number];

/**
 * Translates legacy segment IDs to workspace IDs.
 *   @north   → example-workspace-a   (placeholder workspace — primary = marketing site)
 *   @clientb → demo-client           (placeholder for the Demo PV client)
 *   @own     → lazyos                 (own area → lazyos dogfooding)
 *   @private → private                (synthetic workspace stays)
 *   @system  → lazyos                 (system events land in the lazyos workspace)
 *
 *   The legacy alias `tap` (a ghost ID, no DB workspace) is also mapped to
 *   `example-workspace-a` so old records do not point into the void.
 *
 * Values that are already workspace IDs (no `@` prefix) are returned
 * unchanged.
 */
export function migrateSegmentToWorkspace(segment: string): WorkspaceId {
  switch (segment) {
    case "@north":
    case "tap": // legacy alias — never existed as a real workspace id
      return "example-workspace-a";
    case "@clientb":
      return "demo-client";
    case "@own":
      return "lazyos";
    case "@private":
      return "private";
    case "@system":
      return "lazyos";
    default:
      return segment;
  }
}

// `clientb` and `north` are legacy accent slot names, not client references.
export type WorkspaceAccent = "own" | "clientb" | "north" | "private";

/**
 * Known, hardcoded accent variants (colors/pill styles).
 * Unknown accents fall back to 'own' in the UI.
 */
export const WORKSPACE_ACCENTS: readonly WorkspaceAccent[] = [
  "own",
  "clientb",
  "north",
  "private",
] as const;

/**
 * Synchronous accent fallback when no DB lookup is available
 * (e.g. in edge-runtime code). Fallback = 'own'.
 *
 * For dynamic accents from the DB use `workspaceAccent()` from
 * `lib/workspaces/index.ts`.
 */
export function workspaceAccentFallback(id: WorkspaceId): WorkspaceAccent {
  if (id === "private") return "private";
  if (id === "demo-private") return "private";
  if (id === "demo-client") return "clientb";
  if (id.startsWith("example-workspace-a") || id === "tap") return "north";
  return "own";
}

/**
 * Legacy helper (SegmentId -> accent). New callers use
 * `workspaceAccentFallback` or the DB-based `workspaceAccent`.
 *
 * @deprecated since Sprint 2 · 7C
 */
export function segmentAccent(id: WorkspaceId): WorkspaceAccent {
  return workspaceAccentFallback(migrateSegmentToWorkspace(id));
}

/**
 * Runtime guard for workspace IDs. Accepts any non-empty string without
 * whitespace and without a leading `@` (legacy segments are deliberately
 * rejected so they are explicitly converted via `migrateSegmentToWorkspace`).
 */
export function isWorkspaceId(v: unknown): v is WorkspaceId {
  return (
    typeof v === "string" &&
    v.length > 0 &&
    v.length <= 64 &&
    !v.startsWith("@") &&
    !/\s/.test(v)
  );
}

/**
 * @deprecated Historical segment array. New callers load workspaces
 *             dynamically from the DB (`listWorkspaces()`). Here only as a
 *             default list for older code paths (ChatShell.SEGMENTS).
 *             Matches the migration mapping table.
 *
 *             Correction 2026-04-27: "tap" was a ghost ID — replaced by the
 *             real marketing workspace `example-workspace-a`.
 */
export const SEGMENTS: readonly WorkspaceId[] = [
  "lazyos",
  "demo-client",
  "example-workspace-a",
  "private",
] as const;

export type EntityType =
  | "ticket"
  | "decision"
  | "invoice"
  | "routine"
  | "note"
  | "phase"
  | "workspace"
  // Pattern 6a Push-Telemetrie (2026-05-01) — Entity = Push-Rule-Definition.
  // Events vom SW + Decay-Job tragen rule_id im entityId.
  | "push_rule"
  // Chat messages as first-class events (Phase MS — 2026-04-26).
  // Cross-device visibility + audit. Used complementarily to the localStorage
  // history (server wins on conflict).
  | "chat_message"
  // Pattern 4 foundation (2026-05-01) — codified domain workflows.
  // Entity-ID = workflow_run.id ('wfr_*'). Audit trail over all transitions.
  | "workflow_run"
  // Sub-chats (2026-06-02, P2) — group-chat message event (external/internal).
  // entityId = subchatId, segmentId = workspaceId. Drives realtime + push.
  | "subchat";

export type EventType =
  // Generic lifecycle
  | "created"
  | "updated"
  | "closed"
  | "reopened"
  // Decision-specific
  | "decision_made"
  | "decision_reverted"
  // Ticket-specific
  | "assigned"
  | "commented"
  | "status_changed"
  | "test_result"
  // Approval (Sprint 2 · Stream H)
  | "approval_requested"
  | "approved"
  | "rejected"
  | "executed"
  // Feedback (Phase 4)
  | "review_request"
  | "user_feedback"
  | "fix_agent_triggered"
  // Workspace-discovery (Sprint 2)
  | "workspace_discovered"
  // Workspace-heartbeat (Sprint 2 · 7D)
  | "heartbeat_swept"
  | "workspace_heartbeat"
  // Routines (Sprint 2 · Stream E)
  | "routine_run"
  // Work-Products (Sprint 2 · 7I)
  | "work_product_attached"
  | "work_product_status_changed"
  | "work_product_superseded"
  // Tickets (Sprint 2 · Stream C)
  | "ticket_created"
  | "ticket_deleted"
  // Chat messages (Phase MS · multi-client chat sync, 2026-04-26)
  | "chat_message_sent"
  | "chat_message_completed"
  // Chat-history migration (B2-fix 2026-04-26): one-shot marker per
  // workspace that the localStorage→events migration succeeded.
  // Cross-device source of truth — if this event exists, every new browser
  // skips the re-import. Skipped by the push dispatcher.
  | "chat_history_migrated"
  // Chat-history clear (2026-06-02): server-side „Verlauf leeren" ("clear history")
  // marker per workspace. Append-only — does not delete events, but sets a
  // cutoff: the history projection hides `chat_message` events BEFORE the
  // most recent clear marker. Reversible (remove marker ⇒ history back).
  | "chat_history_cleared"
  // System
  | "push_sent"
  | "error_logged"
  // Pattern 6a push telemetry (2026-05-01) — collects 7d of lead time before
  // Phase 6b (decay algorithm) adaptively down-/up-grades rules based on the
  // data. The SW emits dismissed/clicked, the decay job emits
  // decayed/restored.
  | "notification_dismissed_without_action"
  | "notification_clicked"
  | "rule_decayed"
  | "rule_restored"
  // Pattern 5 wave 3 (2026-05-01) — the drift-verification cron emits a
  // summary after each batch (ok/drift/fabricated/errors/total).
  | "drift_verify_batch"
  // Pattern 4 foundation (2026-05-01) — workflow lifecycle.
  //   workflow.started      = new run via store.createRun()
  //   workflow.transitioned = state change via Runner.transitionTo()
  //   workflow.stuck        = pre/postCondition fail or no-transition-fits
  //   workflow.completed    = transition to '__terminal__'
  | "workflow.started"
  | "workflow.transitioned"
  | "workflow.stuck"
  | "workflow.completed"
  // P13 Devil's Advocate (2026-05-01) — confirmation-bias counter in the
  // sniper loop. counter_evidence_card is the separate surface card in the
  // chat (NOT mixed into the synthesis). synthesis_unfalsifiable
  // triggers a p1 push notification for active user review.
  | "counter_evidence_card"
  | "synthesis_unfalsifiable"
  // B1 answer-required push (2026-05-25): emitted by plan-dispatch
  // (subplan awaitingApproval) and auto-connect (connector-call-preview).
  // Payload: { kind, preview, url, workspaceId }. Sensitivity: medium.
  | "answer_required"
  // Sub-chats (2026-06-02, P2) — new message in a workspace sub-chat.
  // Payload: { subchatId, workspaceId, authorKind, authorName, preview, title }.
  // The push rule fires only for authorKind='external' (new customer message).
  | "subchat_message"
  // Sub-chats (2026-06-02, bundle 1) — TRANSIENT typing indicator. EPHEMERAL:
  // NOT persisted to the event log (no db.insert), ONLY distributed via broadcast
  // to SSE subscribers. Payload: { subchatId, workspaceId, who }.
  | "subchat_typing"
  // Question-spinning (2026-06-03) — a question was spun up in a sub-chat.
  // Payload: { subchatId, workspaceId, questionId, authorKind, preview }.
  // Realtime trigger for the sequential question pill (client refetches).
  | "subchat_question"
  // Question-spinning (2026-06-03) — a spun-up question was answered.
  // Payload: { subchatId, workspaceId, questionId, answererKind }.
  | "subchat_question_answer";

export type ActorType =
  | `user:${string}` // e.g. "user:max"
  | `agent:${string}` // e.g. "agent:senior-dev"
  | "system";

export type Sensitivity = "low" | "medium" | "high";

export type QuickAction = "ok" | "adjust" | "reject";

export interface LazyEvent {
  id: string; // ULID
  createdAt: number; // ms epoch
  /**
   * Workspace ID (e.g. 'lazyos', 'demo-client', 'tap', 'private'). The field
   * name stays `segmentId` for backward compatibility — a later rename would
   * break the event-log schema.
   */
  segmentId: WorkspaceId;
  entityType: EntityType;
  entityId: string;
  eventType: EventType;
  actor: ActorType;
  payload: Record<string, unknown>; // JSON, free-form
  sensitivity: Sensitivity;
  signature?: string; // HMAC — Phase 6 hardening
  replayedFrom?: string; // parent event ID on re-actions
}

// ---------------------------------------------------------------------------
// Projection types — derived from events
// ---------------------------------------------------------------------------

export type TicketStatus = "open" | "done" | "danger" | "wait";

/**
 * Free-text workflow state (e.g. "in_review", "ready_to_deploy").
 * Independent of `status` — `status` is the color signal (open/done/danger/wait),
 * `workflowState` describes the product step. Optional.
 */
export type TicketWorkflowState = string;

export interface TicketProjection {
  id: string;
  segmentId: WorkspaceId;
  title: string;
  body?: string;
  status: TicketStatus;
  workflowState?: TicketWorkflowState;
  prio?: string;
  assignee?: string;
  due?: string;
  createdAt: number;
  updatedAt: number;
  closedAt?: number;
  reviewRequest?: ReviewRequestData;
  feedback?: UserFeedbackData[];
  tags: string[];
  /**
   * Unique Claude-Code session UUIDs that emitted events for this ticket.
   * Aggregated from `ev.payload.sessionId`. Empty list = ticket
   * exists only via UI/API without chat context (handoff point 5).
   */
  sessionRefs?: string[];
  /**
   * Workstream ID if the ticket is part of a multi-agent workstream.
   * Taken from `ev.payload.workstreamId` (Phase W).
   */
  workstreamId?: string;
  /**
   * Parent ticket ID for hierarchical plans (master → feature → segment).
   * From `ev.payload.parentTicketId` (Phase H).
   */
  parentTicketId?: string;
  /**
   * Sub-tickets that have `parentTicketId === this.id`. Aggregated from
   * the global ticket list — empty on the projectTicket single read (only
   * projectTickets maintains this list).
   */
  subTicketIds?: string[];
}

export interface ReviewRequestData {
  checklist: Array<{ id: string; label: string; detail?: string }>;
  testTargetUrl?: string;
  testTargetLabel?: string;
  description?: string;
}

export interface UserFeedbackData {
  quickAction?: QuickAction;
  text?: string;
  checkedItems?: string[];
  submittedAt: number;
}

export interface DecisionProjection {
  id: string;
  segmentId: WorkspaceId;
  headline: string;
  sub?: string;
  options: Array<{
    id: string;
    label: string;
    sublabel?: string;
    counter?: string;
    recommended?: boolean;
  }>;
  chosenOptionId?: string;
  createdAt: number;
  decidedAt?: number;
  decidedBy?: ActorType;
}

// ---------------------------------------------------------------------------
// API Shapes — POST /api/events/emit, POST /api/feedback
// ---------------------------------------------------------------------------

export interface EmitEventRequest {
  segmentId: WorkspaceId;
  entityType: EntityType;
  entityId: string;
  eventType: EventType;
  actor: ActorType;
  payload?: Record<string, unknown>;
  sensitivity?: Sensitivity;
  replayedFrom?: string;
}

export interface FeedbackRequest {
  ticketId: string;
  segmentId?: WorkspaceId;
  quickAction?: QuickAction;
  text?: string;
  checkedItems?: string[];
  triggerFixAgent?: boolean;
}

// ---------------------------------------------------------------------------
// Workspace projection — from the `workspaces` table
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Chat-message payload — Phase MS (2026-04-26)
// ---------------------------------------------------------------------------

/**
 * Tool-call summary in a `chat_message` event. Deliberately minimal:
 * the UI history only needs the name + a one-liner summary, NOT
 * the full input/output (that stays in the chat_turn audit + transcript).
 */
export interface ChatMessageToolCallSummary {
  name: string;
  summary: string;
  durationMs?: number;
}

/**
 * Payload of a `chat_message_sent` (role=user) or
 * `chat_message_completed` (role=assistant) event.
 *
 * `partial=true` marks an assistant message that did NOT finish
 * cleanly (abort, error). The `outcome` field describes the
 * detail. `durationMs` counts from prompt receive to CLI close.
 *
 * `pendingPromptId` is set only in `chat_message_sent`: the
 * client that sent the prompt gets this ID back in the SSE stream
 * — so it does not render its own echo twice
 * when the event comes back via `/api/events/stream`.
 *
 * `legacyId` marks imported items from the MS.6 migration path.
 * Used for idempotency.
 */
export interface ChatMessagePayload {
  workspaceId: WorkspaceId;
  role: "user" | "assistant";
  content: string;
  intent?: string;
  toolCalls?: ChatMessageToolCallSummary[];
  durationMs?: number;
  outcome?: "ok" | "aborted" | "error";
  partial?: boolean;
  /** Client-echo filter: set only for `chat_message_sent`. */
  pendingPromptId?: string;
  /** Migration marker (MS.6). */
  legacyId?: string;
  /** On completed: optional sessionId for debugging. */
  sessionId?: string;
  /**
   * Who triggered the event.
   *   `user:max`           — cookie-auth user prompt from the browser (default for role=user).
   *   `agent:api`          — bearer-auth call without an explicit X-LazyOS-Caller header.
   *   `agent:terminal-claude` — bearer call with X-LazyOS-Caller override (terminal Claude / test script).
   *   `agent:claude`       — default for role=assistant (CLI answer from Claude Code).
   *   `system`             — routines / migrations.
   *
   * The UI renders user bubbles differently depending on the actor (see ChatShell).
   * Default fallback in the renderer if absent:
   *   role=user      -> 'user:max'
   *   role=assistant -> 'agent:claude'
   */
  actor?: string;
}

export interface Workspace {
  id: WorkspaceId;
  label: string;
  accent: WorkspaceAccent;
  path: string;
  sensitivity: Sensitivity;
  archived: boolean;
  credentialOwner: string | null;
  description: string | null;
  orgChart: string | null;
  /**
   * P16 (2026-05-01): sandbox mode. 0 = strict, 1 = sandbox.
   * Optional, so older reads without the column stay tolerant.
   */
  sandboxMode?: number;
  createdAt: number;
  updatedAt: number;
}
