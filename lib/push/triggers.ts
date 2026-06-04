/**
 * Push-Trigger-Engine — Event-Listener → Rule-Match → Push-Send.
 *
 * Aufrufer: `lib/events/emit.ts` ruft `dispatchPushTriggers(event)`
 * via `queueMicrotask` NACH dem Broadcast. Damit ist der Push-Dispatch
 * nicht blockierend für den Event-Write.
 *
 * Fehler werden GEFANGEN und als push_audit 'error' geloggt — sie
 * dürfen den Emitter niemals crashen.
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
 * Burst-Counter State: per-Bucket in-memory map mit Timestamps der letzten
 * N Events. Single-User-MVP, single-Lambda: in-memory reicht. Phase 6 auf
 * SQLite migrieren, falls Errors auf anderen Instances auftreten.
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
   * Pattern 6a Telemetrie (2026-05-01): ruleId wird ans Push-Send-Body
   * angehaengt und vom SW über `event.notification.data.ruleId` zurück
   * an /api/push/feedback gegeben. Optional, weil der `chat-message-*`
   * Pfad und der `notify-review` Pfad sich erst Schritt-für-Schritt
   * einklinken — fehlende ruleId = keine Telemetrie für den Push.
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

    // V3 Wire-Punkt 2 (2026-05-01) — Sandbox-Push-Suppress.
    // Wenn der Workspace im Sandbox-Mode ist UND die Rule auf der Routine-
    // Suppress-Liste steht: Push droppen, Audit-Eintrag schreiben.
    // Kritische Rules (credential-violation, loop-guard-tripped,
    // security-alert, errors-burst, ticket-p0-created) sind in
    // SANDBOX_SUPPRESSED_PUSH_RULES BEWUSST NICHT enthalten und feuern
    // weiter. Der Helper-Set ist Single-Source-of-Truth.
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
        // workspaceIsSandbox ist defensiv und wirft normalerweise nicht;
        // bei DB-Edge-Fehler weiterlaufen (lieber 1 Push zu viel als
        // schwer auffindbarer Audit-Loch).
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

    // Send (Pattern 6a: ruleId mitschicken für SW-Telemetrie)
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
 * Test-Hook — leert den In-Memory-Burst-Counter. Dedup/Counters werden über
 * `__resetPushStateForTests` in dedup.ts geleert.
 */
export function __resetBurstStateForTests(): void {
  burstState.clear();
}

/**
 * Wird von `emit.ts` via queueMicrotask aufgerufen. Fehler hier dürfen nicht
 * propagieren — wir fangen alles und loggen nach stderr als last-resort.
 */
export function schedulePushDispatch(event: LazyEvent): void {
  // Skip push-triggers when the emit itself is inside a test (LAZYOS_DISABLE_PUSH=1)
  // or when we are processing a push_sent event (prevent recursion).
  if (process.env.LAZYOS_DISABLE_PUSH === "1") return;
  if (event.eventType === "push_sent") return;
  // B2-fix 2026-04-26: chat_history_migrated ist ein internes Marker-Event
  // (one-shot pro Workspace), NICHT user-facing. Nie pushen.
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
   * Kurzer Preview-Text (max 100 Zeichen). KEIN Secret/PII — landet im
   * Lock-Screen-Banner. Intern auf 100 Zeichen gekappt.
   */
  preview: string;
  /**
   * Deep-Link-URL zum Workspace / zur Card. Darf KEINEN Auth-Token enthalten.
   * Typisch: `/?workspace=<wsId>` oder `/workstreams/<wsId>`.
   */
  url: string;
}

/**
 * Sendet einen "Antwort erforderlich"-Push via das Push-Rules-System.
 *
 * Visibility-Gate: wenn mindestens ein Client den Workspace gerade sieht,
 * wird KEIN Push gesendet (analog onChatMessageCompleted).
 *
 * Best-effort / non-fatal: wirft nie. Fehler werden per console.warn geloggt.
 * Sollte nach `emitOrUpdateCard`-Calls in plan-dispatch.ts / auto-connect.ts
 * aufgerufen werden — NICHT den Render/Emit blockieren.
 *
 * Sicherheit: preview wird auf 100 Zeichen gekappt, LAZYOS_DISABLE_PUSH
 * wird respektiert.
 */
export function emitAnswerRequired(input: EmitAnswerRequiredInput): void {
  if (process.env.LAZYOS_DISABLE_PUSH === '1') return;

  // Visibility-Gate: kein Push wenn Client sichtbar.
  if (isAnyClientVisible(input.workspaceId)) return;

  // Lazy import via queueMicrotask + dynamic require, damit dieser Helper
  // keinen Zyklus zu emitEvent aufbaut (push/triggers → events/emit → push/triggers).
  // Wir nutzen schedulePushDispatch um alle Rules + Dedup + Cap anzuwenden.
  queueMicrotask(() => {
    void (async () => {
      try {
        // Dynamic import bricht den Modul-Zirkel (push/triggers ↔ events/emit).
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
 * Liest die persisted-sensitivity eines Workspaces. Liefert 'high' fuer
 * private/example-app-* (per Konvention) und Workspaces deren `sensitivity`-Spalte
 * 'high' ist; sonst 'low'. Bei DB-Fehler konservativ 'high' (lieber Body
 * weglassen als versehentlich leaken).
 */
function readWorkspaceSensitivity(workspaceId: string): "low" | "medium" | "high" {
  if (workspaceId === "private" || workspaceId === "@private") return "high";
  if (workspaceId.startsWith("example-app-")) return "high";
  // B6-fix 2026-04-26: __root__ ist Cross-Workspace-Root und kann Antworten
  // aus PRIVATEN Workspaces enthalten. Push-Body MUSS Klartext vermeiden.
  // Konservativ als 'high' behandeln — Lock-Screen sieht nur den generischen
  // Titel, kein Klartext-Leak ueber Workspace-Grenzen hinweg.
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
 * Content-Scanner-Spiegel fuer den Push-Pfad. Pattern-Set identisch zum
 * `scanContentSensitivity` in lib/events/emit.ts (gleiche Regeln, andere
 * Process-Boundary). Wenn die Antwort des Agenten Keys/Tokens enthaelt,
 * verzichten wir auf den Body-Preview im Push.
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
 * Per-Workspace Rate-Limit Bucket-Window. 60s Fenster, max 3 Pushs.
 * Reuse der bestehenden push_counters-Tabelle via checkRuleRateLimit/
 * recordPush. Bucket-Key inkludiert die wsId, sodass Rate-Limit pro
 * Workspace separat zaehlt (Burst in Workspace A blockiert nicht
 * Workspace B).
 */
const CHAT_MESSAGE_RATE_WINDOW_MS = 60_000;
const CHAT_MESSAGE_RATE_MAX = 3;

/**
 * Wird vom Agent-Server NACH `emitChatMessageCompleted` aufgerufen. Sendet
 * eine Web-Push wenn KEIN Client den Workspace gerade als visible meldet.
 *
 * - `tag: 'chat-<wsId>'` mit `renotify: true` -> Replace-Verhalten
 * - URL deeplinkt in den Workspace
 * - Body wird auf 80 Zeichen gekuerzt
 *
 * Fire-and-forget. Niemals werfen.
 */
export function onChatMessageCompleted(
  input: OnChatMessageCompletedInput,
): void {
  // Aborted/error-Antworten erzeugen keinen Push — Max will keine
  // Notification wenn der Stream eh abgebrochen ist.
  if (input.outcome !== "ok") return;

  // Visibility-Gate
  if (isAnyClientVisible(input.workspaceId)) return;

  if (process.env.LAZYOS_DISABLE_PUSH === "1") return;

  const trimmed = input.content.trim();
  if (!trimmed) return;

  const now = Date.now();
  const ruleId = `chat-message-${input.workspaceId}`;

  // P0-4: Per-Workspace Rate-Limit (3/min) UND Global-Daily-Cap.
  // Power-User-Burst → max 3 Pushs/Min. Routine-Loop → globaler Cap
  // greift (default 20/Tag, ENV-override).
  //
  // B4-fix 2026-04-26: Cap-Check-Failure ist FAIL-CLOSED. Bei DB-Stress
  // (SQLITE_BUSY nach 5s timeout, Disk-Full, locked-by-checkpoint) fielen
  // ALLE Caps aus → Routine-Loop konnte unbegrenzt feuern. Konservativer
  // Tradeoff: lieber 1 verlorener Push als 50 unkontrollierte Pushs.
  // Audit-Eintrag mit reason "cap-check-error" damit es im Audit erscheint.
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
    // B4-fix: FAIL-CLOSED. Push DROPPEN, nicht senden.
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
      /* audit-write-failure ist kosmetisch */
    }
    return;
  }

  // P0-3b: Privacy-Gate. Bei sensitive Workspaces ODER Content der wie ein
  // Key/Token aussieht: kein Body-Preview, generischer Titel. Lock-Screen-
  // Preview soll keinen Klartext leaken.
  const wsSensitivity = readWorkspaceSensitivity(input.workspaceId);
  const contentLooksSensitive = pushContentLooksSensitive(trimmed);
  const sensitive = wsSensitivity === "high" || contentLooksSensitive;

  const title = sensitive
    ? "Privater Workspace"
    : input.workspaceLabel || input.workspaceId;
  // TD-5 fix 2026-04-26: Markdown-Strip vor 80-char-Trim. Sonst landeten
  // Code-Fences (```bash ... ```) plump abgeschnitten in der Notification:
  // "```bash\nrm -rf…". Pragmatischer Mini-Stripper:
  //   - Fenced code blocks komplett raus
  //   - Inline-Code-Backticks zum Plain-Text
  //   - Heading-Marker (#, ##, ...) raus
  //   - Bullet-Marker (- / *) raus
  //   - Whitespace-Runs auf ein Space normieren
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
  // 2026-04-26 fix: tag mit timestamp-suffix. Reine `chat-<wsId>`-Replace-tags
  // wurden auf iOS-PWA silent als Update der bestehenden Notification behandelt
  // — kein neuer Banner sichtbar. Rate-Limit (3/Min/wsId) verhindert eh Spam.
  // Per-Push unique tag → User sieht jede Antwort.
  const tag = `chat-${input.workspaceId}-${now}`;
  // Chat-Page liegt auf `/` (Root), nicht `/chat` — `/chat` würde 404
  // werfen. Workspace-Switch passiert client-side in ChatShell beim Mount,
  // sofern der Query-Param erkannt wird.
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
        // P0-4: erfolgreichen Push beim Rate-Limit + Daily-Cap registrieren.
        try {
          recordPush(ruleId, CHAT_MESSAGE_RATE_WINDOW_MS, now);
          recordAudit({
            ruleId,
            outcome: "sent",
            detail: `tag=${tag}${sensitive ? " (sensitive)" : ""}`,
            now,
          });
        } catch {
          /* counter-write-failure ist kosmetisch */
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
