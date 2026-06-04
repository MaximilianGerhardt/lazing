/**
 * Push-trigger engine — event listener → rule match → push send.
 *
 * Caller: `lib/events/emit.ts` calls `dispatchPushTriggers(event)`
 * via `queueMicrotask` AFTER the broadcast. This makes the push dispatch
 * non-blocking for the event write.
 *
 * Errors are CAUGHT and logged as push_audit 'error' — they
 * must never crash the emitter.
 */

import type { LazyEvent } from "../events/types";
import { isAnyClientVisible } from "../chat/visibility-tracker";
import { getDb } from "../../db/client";
import { ROOT_WORKSPACE_ID } from "../nav/workspaces-data";
import {
  shouldSuppressPushInSandbox,
  workspaceIsSandbox,
} from "../workspaces/sandbox";

import {
  DEDUP_WINDOW_MS,
  checkAndRegisterDedup,
  checkGlobalCap,
  checkRuleRateLimit,
  recordAudit,
  recordPush,
} from "./dedup";
import {
  PUSH_RULES,
  windowMsForRateLimit,
  type PushRule,
} from "./rules";

/**
 * Burst-counter state: per-bucket in-memory map with timestamps of the last
 * N events. Single-user MVP, single Lambda: in-memory is enough. Phase 6 migrate
 * to SQLite if errors occur on other instances.
 */
const burstState = new Map<string, number[]>();

function checkBurst(
  rule: PushRule,
  event: LazyEvent,
  now: number,
): boolean {
  if (!rule.burst) return true; // no burst requirement → always allow
  const key = rule.burst.bucketKey(event);
  const win = rule.burst.windowMs;

  const list = burstState.get(key) ?? [];
  // Filter out entries outside the window.
  const fresh = list.filter((ts) => now - ts <= win);
  fresh.push(now);
  burstState.set(key, fresh);

  return fresh.length >= rule.burst.count;
}

// ---------------------------------------------------------------------------
// Push sender
// ---------------------------------------------------------------------------

interface SendOptions {
  title: string;
  body: string;
  url: string;
  tag?: string;
  /**
   * Pattern 6a telemetry (2026-05-01): ruleId is appended to the push-send body
   * and returned by the SW via `event.notification.data.ruleId` back
   * to /api/push/feedback. Optional, because the `chat-message-*`
   * path and the `notify-review` path hook in only step by step
   * — a missing ruleId = no telemetry for the push.
   */
  ruleId?: string;
}

function sendPushBaseUrl(): string {
  // Vercel serverless: fetch to self must use absolute URL. We read the
  // same baseURL the middleware sees. Falls back to localhost:4200 for
  // local dev (systemd service).
  if (process.env.LAZYOS_BASE_URL) return process.env.LAZYOS_BASE_URL;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "http://127.0.0.1:4200";
}

async function sendPush(
  opts: SendOptions,
): Promise<{ ok: boolean; status: number; detail?: string }> {
  const secret = process.env.LAZYOS_PUSH_SECRET;
  if (!secret) {
    return {
      ok: false,
      status: 0,
      detail: "LAZYOS_PUSH_SECRET not configured",
    };
  }

  const url = `${sendPushBaseUrl()}/api/push/send`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(opts),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return {
        ok: false,
        status: res.status,
        detail: text.slice(0, 200),
      };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Main dispatch
// ---------------------------------------------------------------------------

export async function dispatchPushTriggers(
  event: LazyEvent,
): Promise<void> {
  const now = Date.now();

  for (const rule of PUSH_RULES) {
    let matched: boolean;
    try {
      matched = rule.when(event);
    } catch (err) {
      recordAudit({
        ruleId: rule.id,
        eventId: event.id,
        outcome: "error",
        detail: `when() threw: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    if (!matched) continue;

    // V3 wire-point 2 (2026-05-01) — sandbox push suppress.
    // When the workspace is in sandbox mode AND the rule is on the routine
    // suppress list: drop the push, write an audit entry.
    // Critical rules (credential-violation, loop-guard-tripped,
    // security-alert, errors-burst, ticket-p0-created) are DELIBERATELY NOT
    // contained in SANDBOX_SUPPRESSED_PUSH_RULES and keep firing.
    // The helper set is the single source of truth.
    if (shouldSuppressPushInSandbox(rule.id)) {
      try {
        const inSandbox = await workspaceIsSandbox(event.segmentId);
        if (inSandbox) {
          recordAudit({
            ruleId: rule.id,
            eventId: event.id,
            outcome: "cap",
            detail: `sandbox-suppress (workspace=${event.segmentId})`,
          });
          continue;
        }
      } catch {
        // workspaceIsSandbox is defensive and normally does not throw;
        // on a DB edge error, keep going (better 1 push too many than a
        // hard-to-find audit gap).
      }
    }

    // Burst-Counter (for rules with burst-state, only fires when threshold hit)
    if (!checkBurst(rule, event, now)) {
      // silent skip — not an audit-worthy event (noise would be huge)
      continue;
    }

    // Dedup check
    const dedupKey =
      (rule.dedupKey && tryCallDedupKey(rule, event)) ??
      `${rule.id}:${event.entityId}`;
    const dedup = checkAndRegisterDedup(dedupKey, rule.id, now);
    if (dedup.isDuplicate) {
      recordAudit({
        ruleId: rule.id,
        eventId: event.id,
        outcome: "dedup",
        detail: `firstSeenAt=${dedup.firstSeenAt}`,
      });
      continue;
    }

    // Per-rule rate-limit
    if (rule.rateLimit) {
      const windowMs = windowMsForRateLimit(rule.rateLimit);
      const rl = checkRuleRateLimit(rule.id, windowMs, rule.rateLimit.max, now);
      if (!rl.allowed) {
        recordAudit({
          ruleId: rule.id,
          eventId: event.id,
          outcome: "cap",
          detail: `rule-cap exceeded (${rl.count}/${rule.rateLimit.max} per ${rule.rateLimit.per})`,
        });
        continue;
      }
    }

    // Global daily cap
    const globalCap = checkGlobalCap(now);
    if (!globalCap.allowed) {
      recordAudit({
        ruleId: rule.id,
        eventId: event.id,
        outcome: "cap",
        detail: `global daily cap hit (${globalCap.count}/${globalCap.max})`,
      });
      continue;
    }

    // Build notification
    let notif: ReturnType<PushRule["build"]>;
    try {
      notif = rule.build(event);
    } catch (err) {
      recordAudit({
        ruleId: rule.id,
        eventId: event.id,
        outcome: "error",
        detail: `build() threw: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    // Send (Pattern 6a: pass ruleId along for SW telemetry)
    const send = await sendPush({ ...notif, ruleId: rule.id });
    if (send.ok) {
      const windowMs = rule.rateLimit
        ? windowMsForRateLimit(rule.rateLimit)
        : undefined;
      recordPush(rule.id, windowMs, now);
      recordAudit({
        ruleId: rule.id,
        eventId: event.id,
        outcome: "sent",
        detail: `tag=${notif.tag ?? "-"}`,
      });
    } else {
      recordAudit({
        ruleId: rule.id,
        eventId: event.id,
        outcome: "error",
        detail: `send failed status=${send.status} ${send.detail ?? ""}`.trim(),
      });
    }
  }
}

function tryCallDedupKey(rule: PushRule, event: LazyEvent): string | undefined {
  if (!rule.dedupKey) return undefined;
  try {
    return rule.dedupKey(event);
  } catch {
    return undefined;
  }
}

/**
 * Test hook — clears the in-memory burst counter. Dedup/counters are cleared via
 * `__resetPushStateForTests` in dedup.ts.
 */
export function __resetBurstStateForTests(): void {
  burstState.clear();
}

/**
 * Called by `emit.ts` via queueMicrotask. Errors here must not
 * propagate — we catch everything and log to stderr as a last resort.
 */
export function schedulePushDispatch(event: LazyEvent): void {
  // Skip push-triggers when the emit itself is inside a test (LAZYOS_DISABLE_PUSH=1)
  // or when we are processing a push_sent event (prevent recursion).
  if (process.env.LAZYOS_DISABLE_PUSH === "1") return;
  if (event.eventType === "push_sent") return;
  // B2-fix 2026-04-26: chat_history_migrated is an internal marker event
  // (one-shot per workspace), NOT user-facing. Never push.
  if (event.eventType === "chat_history_migrated") return;

  queueMicrotask(() => {
    void dispatchPushTriggers(event).catch((err) => {
      console.error(
        "[lazyos] push-dispatch failed (non-fatal):",
        err instanceof Error ? err.message : err,
      );
    });
  });
}

// Re-export for convenience
export { DEDUP_WINDOW_MS };

// ---------------------------------------------------------------------------
// B2 — answer_required Push-Helper (2026-05-25)
// ---------------------------------------------------------------------------

export interface EmitAnswerRequiredInput {
  workspaceId: string;
  entityId: string;
  kind: 'approval' | 'connector-preview' | 'open-questions' | 'run-stuck';
  /**
   * Short preview text (max 100 chars). NO secret/PII — lands in the
   * lock-screen banner. Internally capped to 100 chars.
   */
  preview: string;
  /**
   * Deep-link URL to the workspace / to the card. Must contain NO auth token.
   * Typically: `/?workspace=<wsId>` or `/workstreams/<wsId>`.
   */
  url: string;
}

/**
 * Sends an "answer required" push via the push-rules system.
 *
 * Visibility gate: if at least one client is currently viewing the workspace,
 * NO push is sent (analogous to onChatMessageCompleted).
 *
 * Best-effort / non-fatal: never throws. Errors are logged via console.warn.
 * Should be called after `emitOrUpdateCard` calls in plan-dispatch.ts / auto-connect.ts
 * — does NOT block the render/emit.
 *
 * Security: preview is capped to 100 chars, LAZYOS_DISABLE_PUSH
 * is respected.
 */
export function emitAnswerRequired(input: EmitAnswerRequiredInput): void {
  if (process.env.LAZYOS_DISABLE_PUSH === '1') return;

  // Visibility gate: no push when a client is visible.
  if (isAnyClientVisible(input.workspaceId)) return;

  // Lazy import via queueMicrotask + dynamic require, so this helper
  // does not build a cycle to emitEvent (push/triggers → events/emit → push/triggers).
  // We use schedulePushDispatch to apply all rules + dedup + cap.
  queueMicrotask(() => {
    void (async () => {
      try {
        // Dynamic import breaks the module cycle (push/triggers ↔ events/emit).
        const { emitEvent } = await import('../events/emit');
        const safePreview = input.preview.trim().slice(0, 100);
        await emitEvent({
          segmentId: input.workspaceId,
          entityType: 'note',
          entityId: input.entityId,
          eventType: 'answer_required',
          actor: 'system',
          payload: {
            kind: input.kind,
            preview: safePreview,
            url: input.url,
            workspaceId: input.workspaceId,
          },
          sensitivity: 'medium',
        });
      } catch (err) {
        console.warn(
          '[push/triggers] emitAnswerRequired failed (non-fatal):',
          err instanceof Error ? err.message : String(err),
        );
      }
    })();
  });
}

// ---------------------------------------------------------------------------
// Phase MS · Chat-Message-Completion-Push (2026-04-26)
// ---------------------------------------------------------------------------

export interface OnChatMessageCompletedInput {
  workspaceId: string;
  workspaceLabel: string;
  content: string;
  outcome: "ok" | "aborted" | "error";
}

/**
 * Reads the persisted sensitivity of a workspace. Returns 'high' for
 * private/example-app-* (by convention) and workspaces whose `sensitivity` column
 * is 'high'; otherwise 'low'. On a DB error, conservatively 'high' (better to omit
 * the body than to accidentally leak).
 */
function readWorkspaceSensitivity(workspaceId: string): "low" | "medium" | "high" {
  if (workspaceId === "private" || workspaceId === "@private") return "high";
  if (workspaceId.startsWith("example-app-")) return "high";
  // B6-fix 2026-04-26: __root__ is the cross-workspace root and can contain
  // replies from PRIVATE workspaces. The push body MUST avoid plaintext.
  // Treat conservatively as 'high' — the lock screen sees only the generic
  // title, no plaintext leak across workspace boundaries.
  if (workspaceId === ROOT_WORKSPACE_ID) return "high";
  try {
    const db = getDb();
    const row = db.$raw
      .prepare(`SELECT sensitivity FROM workspaces WHERE id = ?`)
      .get(workspaceId) as { sensitivity?: string | null } | undefined;
    const v = row?.sensitivity;
    if (v === "high") return "high";
    if (v === "medium" || v === "normal") return "medium";
    return "low";
  } catch {
    return "high";
  }
}

/**
 * Content-scanner mirror for the push path. The pattern set is identical to
 * `scanContentSensitivity` in lib/events/emit.ts (same rules, different
 * process boundary). If the agent's reply contains keys/tokens,
 * we omit the body preview in the push.
 */
function pushContentLooksSensitive(content: string): boolean {
  if (!content || content.length === 0) return false;
  const patterns: RegExp[] = [
    /sk-[A-Za-z0-9]{20,}/,
    /sk_(?:live|test)_[A-Za-z0-9]{16,}/,
    /gh[ps]_[A-Za-z0-9]{30,}/,
    /AKIA[A-Z0-9]{16}/,
    /eyJ[A-Za-z0-9+/=_-]{20,}\.[A-Za-z0-9+/=_-]{20,}\.[A-Za-z0-9+/=_-]{10,}/,
    /-----BEGIN [A-Z ]+PRIVATE KEY-----/,
    /(?:api[_-]?key|secret|password|token|bearer)\s*[=:]\s*['"]?[A-Za-z0-9+/]{16,}/i,
    /LAZYOS_[A-Z_]+\s*=\s*\S+/,
  ];
  return patterns.some((re) => re.test(content));
}

/**
 * Per-workspace rate-limit bucket window. 60s window, max 3 pushes.
 * Reuses the existing push_counters table via checkRuleRateLimit/
 * recordPush. The bucket key includes the wsId, so the rate limit counts
 * per workspace separately (a burst in workspace A does not block
 * workspace B).
 */
const CHAT_MESSAGE_RATE_WINDOW_MS = 60_000;
const CHAT_MESSAGE_RATE_MAX = 3;

/**
 * Called by the agent server AFTER `emitChatMessageCompleted`. Sends
 * a web push when NO client currently reports the workspace as visible.
 *
 * - `tag: 'chat-<wsId>'` with `renotify: true` -> replace behaviour
 * - URL deep-links into the workspace
 * - body is shortened to 80 chars
 *
 * Fire-and-forget. Never throws.
 */
export function onChatMessageCompleted(
  input: OnChatMessageCompletedInput,
): void {
  // Aborted/error replies produce no push — the operator wants no
  // notification when the stream was aborted anyway.
  if (input.outcome !== "ok") return;

  // Visibility gate
  if (isAnyClientVisible(input.workspaceId)) return;

  if (process.env.LAZYOS_DISABLE_PUSH === "1") return;

  const trimmed = input.content.trim();
  if (!trimmed) return;

  const now = Date.now();
  const ruleId = `chat-message-${input.workspaceId}`;

  // P0-4: per-workspace rate limit (3/min) AND global daily cap.
  // Power-user burst → max 3 pushes/min. Routine loop → the global cap
  // applies (default 20/day, ENV override).
  //
  // B4-fix 2026-04-26: a cap-check failure is FAIL-CLOSED. Under DB stress
  // (SQLITE_BUSY after 5s timeout, disk-full, locked-by-checkpoint)
  // ALL caps dropped out → a routine loop could fire unbounded. Conservative
  // tradeoff: better 1 lost push than 50 uncontrolled pushes.
  // Audit entry with reason "cap-check-error" so it appears in the audit.
  try {
    const rl = checkRuleRateLimit(
      ruleId,
      CHAT_MESSAGE_RATE_WINDOW_MS,
      CHAT_MESSAGE_RATE_MAX,
      now,
    );
    if (!rl.allowed) {
      recordAudit({
        ruleId,
        outcome: "cap",
        detail: `chat-message rate-limit hit (${rl.count}/${CHAT_MESSAGE_RATE_MAX} per ${CHAT_MESSAGE_RATE_WINDOW_MS}ms)`,
        now,
      });
      return;
    }
    const cap = checkGlobalCap(now);
    if (!cap.allowed) {
      recordAudit({
        ruleId,
        outcome: "cap",
        detail: `global daily cap hit (${cap.count}/${cap.max})`,
        now,
      });
      return;
    }
  } catch (err) {
    // B4-fix: FAIL-CLOSED. DROP the push, do not send.
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      "[push/triggers] onChatMessageCompleted cap-check failed (DROPPING push):",
      msg,
    );
    try {
      recordAudit({
        ruleId,
        outcome: "error",
        detail: `cap-check-error (push dropped): ${msg}`,
        now,
      });
    } catch {
      /* audit-write failure is cosmetic */
    }
    return;
  }

  // P0-3b: privacy gate. For sensitive workspaces OR content that looks like a
  // key/token: no body preview, generic title. The lock-screen
  // preview should leak no plaintext.
  const wsSensitivity = readWorkspaceSensitivity(input.workspaceId);
  const contentLooksSensitive = pushContentLooksSensitive(trimmed);
  const sensitive = wsSensitivity === "high" || contentLooksSensitive;

  const title = sensitive
    ? "Privater Workspace"
    : input.workspaceLabel || input.workspaceId;
  // TD-5 fix 2026-04-26: markdown strip before the 80-char trim. Otherwise
  // code fences (```bash ... ```) landed crudely cut off in the notification:
  // "```bash\nrm -rf…". Pragmatic mini-stripper:
  //   - fenced code blocks removed entirely
  //   - inline-code backticks to plain text
  //   - heading markers (#, ##, ...) removed
  //   - bullet markers (- / *) removed
  //   - normalize whitespace runs to a single space
  const cleanBody = trimmed
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^[-*]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  const body = sensitive
    ? "Neue Antwort verfügbar"
    : cleanBody.length === 0
      ? "Neue Antwort verfügbar"
      : cleanBody.length > 80
        ? `${cleanBody.slice(0, 77)}…`
        : cleanBody;
  // 2026-04-26 fix: tag with a timestamp suffix. Plain `chat-<wsId>` replace tags
  // were silently treated on iOS PWA as an update of the existing notification
  // — no new banner visible. The rate limit (3/min/wsId) prevents spam anyway.
  // Per-push unique tag → the user sees every reply.
  const tag = `chat-${input.workspaceId}-${now}`;
  // The chat page lives at `/` (root), not `/chat` — `/chat` would throw a 404.
  // The workspace switch happens client-side in ChatShell on mount,
  // provided the query param is recognized.
  const url = `/?workspace=${encodeURIComponent(input.workspaceId)}`;

  void sendPush({
    title,
    body,
    url,
    tag,
    ruleId,
  })
    .then((res) => {
      if (res.ok) {
        // P0-4: register the successful push with the rate limit + daily cap.
        try {
          recordPush(ruleId, CHAT_MESSAGE_RATE_WINDOW_MS, now);
          recordAudit({
            ruleId,
            outcome: "sent",
            detail: `tag=${tag}${sensitive ? " (sensitive)" : ""}`,
            now,
          });
        } catch {
          /* counter-write failure is cosmetic */
        }
      } else {
        console.warn(
          "[push/triggers] onChatMessageCompleted send failed:",
          res.status,
          res.detail ?? "",
        );
        try {
          recordAudit({
            ruleId,
            outcome: "error",
            detail: `send failed status=${res.status} ${res.detail ?? ""}`.trim(),
            now,
          });
        } catch {
          /* ignore */
        }
      }
    })
    .catch((err) => {
      console.warn(
        "[push/triggers] onChatMessageCompleted threw:",
        err instanceof Error ? err.message : String(err),
      );
    });
}
