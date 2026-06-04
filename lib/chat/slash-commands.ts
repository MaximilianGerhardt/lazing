/**
 * lib/chat/slash-commands.ts
 * --------------------------
 * Sub-Plan B (2026-04-29) — Slash commands /clear, /compact, /help.
 *
 * Architecture:
 *   - REGISTRY: Map<command-name, SlashCommand>. All built-in commands
 *     register themselves statically at the end of the module.
 *   - parseSlashCommand(input): recognizes `/<name> [args]` at the start of the
 *     input and returns the matching SlashCommand object. Match
 *     is case-insensitive (`/clear`, `/CLEAR`, `/Clear` -> same command).
 *     Tail args are NOT parsed — commands handle their own
 *     tail in the handler implementation.
 *   - SlashCommand.handler(ctx) returns `'consumed'` (skip the LLM
 *     roundtrip) or `'pass-through'` (run the LLM further). Currently
 *     all built-in commands consume.
 *
 * Pure logic. No React, no DOM. Supplied via SlashContext with IO helpers
 * (setHistory, pushSystemToast, fetch, clearHistoryFor) — so
 * parseSlashCommand and the handler logic stay unit-testable without ChatShell.
 */

import type { Dispatch, SetStateAction } from "react";

import type { HistoryItem } from "./ChatShell";
import { clearHistoryFor } from "./storage";
import { extractWorkstreamCoords } from "./surface-parser";
import type { MediaStyleChoicePayload } from "@/lib/flow/media-styles";

/**
 * Local mirror interface for SystemItem (declared privately in
 * ChatShell.tsx). Used in the ctx interface so that slash commands
 * can generate toasts without a circular import. Fields MUST stay identical
 * to the ChatShell-internal `SystemItem` — when a field
 * is added there, follow up here.
 */
export interface SystemItem {
  id: string;
  role: "system";
  kind: string;
  content: string;
  severity: "info" | "warn" | "critical";
  href?: string;
  ts: string;
}

export interface SlashContext {
  /** Active workspace ID. Needed for /clear (localStorage key) + /compact
   *  (server snapshot endpoint). */
  workspaceId: string;
  /** Current history snapshot (read-only). */
  history: HistoryItem[];
  /** Setter as from useState — commands write the new history with it. */
  setHistory: Dispatch<SetStateAction<HistoryItem[]>>;
  /** Toast helper. Used for the user feedback after each command. */
  pushSystemToast: (item: SystemItem) => void;
  /** Optional: clear all SystemMessages (transient toasts). Used by
   *  `/clear`, so that the workstream toasts disappear too. */
  clearSystemMessages?: () => void;
  /** Fetch impl. Default = global fetch, tests can mock. */
  fetch: typeof fetch;
  /**
   * Track-D · 2026-05-27 (Flow Studio). Tail args AFTER the command name,
   * trimmed. Example: `/flow erstelle eine webseite` -> `args` =
   * `"erstelle eine webseite"`. Empty string if no tail. Commands that
   * need no args (clear/compact/help/session) ignore the field.
   * Optional, so existing callers (and tests) keep running without args.
   */
  args?: string;
  /**
   * Track-D · 2026-05-27 (Flow Studio). Posts an ASSISTANT chat message
   * into the history (in contrast to `pushSystemToast`, which only creates a
   * transient toast). Only assistant items run through the surface-aware
   * renderer (SurfaceRenderer) in ChatShell, i.e. `<surface:...>` markup
   * is rendered into a card here — with system toasts NOT (those show
   * raw text). `/flow` uses this for the run confirmation and the
   * `<surface:flow-coupling>` markup. Optional for backwards compatibility;
   * if a caller without this method comes in, `/flow` degrades to a
   * system toast (see handler).
   */
  postAssistantMessage?: (content: string) => void;
  /**
   * Track-D · Stream-B2 wiring · 2026-05-27 (Flow Studio). Hands the
   * ChatShell layer a `needs-style-choice` response: per open media
   * step a quickchoice payload + the original intent. ChatShell
   * EMITS the quickchoice surface(s), LISTENS for the owner choice
   * (`lazyos:quickchoice` event), forms the `styleChoices` map from it (keyed
   * on String(step.idx) — stable across the deterministic re-compose) and
   * RE-POSTs `/api/flow/compose-and-run` WITH styleChoices. The follow-up status
   * (running / needs-coupling / further needs-style-choice) is sent through
   * handleFlowComposeResult there again.
   *
   * Why not in the pure handler? Surface emission + global window event
   * listener need React state/DOM (ChatShell territory). The pure handler
   * only builds the markup + delegates the interaction. Optional + fail-soft:
   * if the callback is missing, `/flow` degrades to a hint toast (the
   * style choice then cannot happen interactively).
   */
  onFlowStyleChoice?: (req: FlowStyleChoiceRequest) => void;
}

/**
 * Track-D · Stream-B2. A `needs-style-choice` handover to ChatShell: the
 * verbatim intent + the open style questions (1 per media step without a choice).
 */
export interface FlowStyleChoiceRequest {
  /** The verbatim operator intent (for the re-POST). N1. */
  readonly intent: string;
  /** Workspace scope (for the re-POST). N9. */
  readonly workspaceId: string;
  /** The flowId of the (first) compose run — context/audit. */
  readonly flowId: string;
  /** Per open media step: stable idx key + quickchoice payload. */
  readonly prompts: readonly FlowStyleChoicePrompt[];
}

/**
 * An open media step: the stable styleChoices key (String(idx))
 * + the quickchoice payload (renderer format, built by media-styles.ts).
 */
export interface FlowStyleChoicePrompt {
  /**
   * The stable styleChoices key. = String(step.idx) — stable across the
   * deterministic re-compose (the ULID stepId would be new on the second
   * compose). composeAndRun::lookupStyleChoice tries stepId OR idx.
   */
  readonly choiceKey: string;
  /** The option ids of this step (to correlate the lazyos:quickchoice id). */
  readonly optionIds: readonly string[];
  /** The quickchoice surface payload (renderer format). */
  readonly payload: MediaStyleChoicePayload;
}

/**
 * Track-D · Stream-B2. An active style-choice session in the chat layer: the
 * verbatim intent + scope (for the re-POST), the still OPEN prompts and the
 * choices COLLECTED so far. Mutable (ChatShell keeps it in a ref).
 */
export interface FlowStyleSession {
  readonly intent: string;
  readonly workspaceId: string;
  /** Still-open prompts (answered ones are removed). */
  pending: Array<{ readonly choiceKey: string; readonly optionIds: readonly string[] }>;
  /** Collected choices: choiceKey → optionId. */
  readonly choices: Record<string, string>;
}

/**
 * Track-D · Stream-B2. Pure correlation of a quickchoice click (ONLY the
 * option id travels in the `lazyos:quickchoice` event) to its open style question.
 *
 * Strategy: first session with a still-open prompt whose optionIds contain the
 * clicked id (display order → deterministic). With identical
 * option sets (e.g. two video steps), the owner assigns them in order
 * (fail-soft, no hard uniqueness constraint).
 *
 * MUTATES the matched session (choices += , pending -=). Returns:
 *   - matched: whether the id was assigned to an open question,
 *   - completedSession: the session, IF it became complete with it (→ the
 *     caller RE-POSTs + removes it from the active list), otherwise null,
 *   - sessionIndex: index of the matched session (for removal), or -1.
 *
 * Pure logic: NO fetch, NO DOM, NO side effects other than the session mutation.
 */
export function correlateQuickChoice(
  sessions: readonly FlowStyleSession[],
  clickedId: string,
): {
  readonly matched: boolean;
  readonly completedSession: FlowStyleSession | null;
  readonly sessionIndex: number;
} {
  if (typeof clickedId !== "string" || clickedId.length === 0) {
    return { matched: false, completedSession: null, sessionIndex: -1 };
  }
  for (let s = 0; s < sessions.length; s += 1) {
    const session = sessions[s]!;
    const promptIdx = session.pending.findIndex((p) =>
      p.optionIds.includes(clickedId),
    );
    if (promptIdx === -1) continue;
    const prompt = session.pending[promptIdx]!;
    session.choices[prompt.choiceKey] = clickedId;
    session.pending.splice(promptIdx, 1);
    const completedSession = session.pending.length === 0 ? session : null;
    return { matched: true, completedSession, sessionIndex: s };
  }
  return { matched: false, completedSession: null, sessionIndex: -1 };
}

export type SlashCommandResult = "consumed" | "pass-through";

export interface SlashCommand {
  /** Incl. leading slash, lowercase. Example: `/clear`. */
  name: string;
  /** Short description for the /help output. */
  description: string;
  /** Handler implementation. Returns `'consumed'` -> skip the LLM
   *  roundtrip, `'pass-through'` -> forward the input like a normal
   *  message. */
  handler(ctx: SlashContext): Promise<SlashCommandResult>;
}

export const REGISTRY = new Map<string, SlashCommand>();

/**
 * Recognizes a slash-command invocation at the start of `input` and returns
 * the matching command object. Returns `null` when:
 *   - input empty / does not start with `/`
 *   - command name not in the REGISTRY
 *
 * Case-insensitive: `/CLEAR`, `/Clear`, `/clear` all match.
 * Tail args (`/clear extra junk`) are ignored — the match runs
 * only over the command name.
 */
export function parseSlashCommand(input: string): SlashCommand | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  // Accept WITH OR without a leading `/`. User request 2026-04-30:
  // bare-word command exact match (e.g. `clear`, `compact`, `help`)
  // should execute directly just like `/clear`.
  const firstWord = trimmed.split(/\s+/)[0].toLowerCase();
  const withSlash = firstWord.startsWith("/") ? firstWord : `/${firstWord}`;
  return REGISTRY.get(withSlash) ?? null;
}

/**
 * Track-D · 2026-05-27 (Flow Studio). Returns the trimmed tail AFTER the
 * command name. `extractSlashArgs('/flow  erstelle eine webseite')` ->
 * `'erstelle eine webseite'`. Empty string if no tail is present
 * or the input is not a string / empty. Mirrors the match semantics of
 * `parseSlashCommand` (first word = command, rest = args), but keeps the
 * original spelling in the tail (N1: intent verbatim, only trimmed on the outside).
 */
export function extractSlashArgs(input: string): string {
  if (typeof input !== "string") return "";
  const trimmed = input.trim();
  if (trimmed.length === 0) return "";
  // Cut off the first whitespace-separated token (= command name).
  const firstSpace = trimmed.search(/\s/);
  if (firstSpace === -1) return "";
  return trimmed.slice(firstSpace + 1).trim();
}

// ---------------------------------------------------------------------------
// Trim helper for /compact
// ---------------------------------------------------------------------------

/**
 * Trim logic for `/compact`:
 *   1. Group items by `(workstreamId, surfaceKind)` coord.
 *      Per group keep only the CHRONOLOGICALLY MOST RECENT item.
 *   2. Items without `workstreamId` (= free user/assistant bubbles) -> keep
 *      the last `freeMessageLimit`.
 *
 * Order is preserved (items are not re-sorted). Pure —
 * no state, no IO.
 *
 * Edge cases:
 *   - Items whose workstreamId field is missing but whose content has
 *     `<surface:*>` with a workstreamId: we recover it via
 *     `extractWorkstreamCoords`. This keeps the behavior consistent
 *     with `applyReplacePass` from storage.ts.
 *   - When two items have the same coord, the same ts: tiebreaker = id
 *     order in the array (the last one wins). No try-to-parse risk.
 */
export function trimByWorkstream(
  items: HistoryItem[],
  freeMessageLimit = 6,
): HistoryItem[] {
  if (items.length === 0) return items;

  // Coord per item (uses workstreamId+surfaceKind, with content fallback).
  const coords: Array<{ key: string | null; idx: number }> = items.map(
    (it, idx) => {
      let wsId = it.workstreamId;
      let kind = it.surfaceKind;
      if (!wsId || !kind) {
        const extracted = extractWorkstreamCoords(it.content ?? "");
        if (extracted) {
          wsId = wsId ?? extracted.workstreamId;
          kind = kind ?? extracted.surfaceKind;
        }
      }
      const key = wsId && kind ? `${kind}::${wsId}` : null;
      return { key, idx };
    },
  );

  // Per coord key: find the index of the most recent item (largest idx in
  // input order — items arrive chronologically ASC).
  const youngestPerCoord = new Map<string, number>();
  for (const c of coords) {
    if (c.key === null) continue;
    youngestPerCoord.set(c.key, c.idx);
  }

  // Free items: all items without a coord key. Keep the last N.
  const freeIndices = coords
    .filter((c) => c.key === null)
    .map((c) => c.idx);
  const freeKeep = new Set(freeIndices.slice(-freeMessageLimit));

  // Coord items: keep only the most recent per coord.
  const coordKeep = new Set(youngestPerCoord.values());

  const out: HistoryItem[] = [];
  for (let i = 0; i < items.length; i += 1) {
    if (coordKeep.has(i) || freeKeep.has(i)) {
      out.push(items[i]);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Toast-Helper
// ---------------------------------------------------------------------------

function makeToast(
  kind: string,
  title: string,
  body: string,
  variant: "default" | "ok" | "warn" | "err" = "default",
  iconGlyph = "i",
): SystemItem {
  const id = `sys-${kind}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  return {
    id,
    role: "system",
    kind,
    content:
      "<surface:toast>" +
      JSON.stringify({ variant, title, body, iconGlyph }) +
      "</surface:toast>",
    severity: variant === "err" ? "critical" : variant === "warn" ? "warn" : "info",
    ts: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Built-In Commands
// ---------------------------------------------------------------------------

const clearCommand: SlashCommand = {
  name: "/clear",
  description: "Leert den Chat-Verlauf lokal. DB-Events bleiben erhalten.",
  async handler(ctx: SlashContext): Promise<SlashCommandResult> {
    ctx.setHistory([]);
    clearHistoryFor(ctx.workspaceId);
    if (ctx.clearSystemMessages) ctx.clearSystemMessages();
    ctx.pushSystemToast(
      makeToast(
        "slash-clear",
        "Chat-Verlauf geleert",
        "DB-Daten bleiben.",
        "default",
        "•",
      ),
    );
    return "consumed";
  },
};

const compactCommand: SlashCommand = {
  name: "/compact",
  description:
    "Komprimiert lokal (jüngste Card pro Workstream + letzte 6 freie Messages) und speichert einen Server-Snapshot.",
  async handler(ctx: SlashContext): Promise<SlashCommandResult> {
    // 1. Lokal trimmen.
    const trimmed = trimByWorkstream(ctx.history, 6);
    ctx.setHistory(trimmed);

    // 2. Server-Snapshot. Endpoint = identisch zu lib/nav/CompactButton.tsx.
    let snapshotOk = false;
    let serverHint: string | null = null;
    try {
      const res = await ctx.fetch("/api/ctx/compact-snapshot", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ workspaceId: ctx.workspaceId }),
      });
      if (res.ok) {
        snapshotOk = true;
      } else {
        const body = (await res.json().catch(() => ({}))) as { hint?: string };
        serverHint = body.hint ?? `HTTP ${res.status}`;
      }
    } catch (err) {
      serverHint = err instanceof Error ? err.message : String(err);
    }

    if (snapshotOk) {
      ctx.pushSystemToast(
        makeToast(
          "slash-compact",
          "Verlauf kompakt",
          "Server-Snapshot gespeichert.",
          "ok",
          "•",
        ),
      );
    } else {
      ctx.pushSystemToast(
        makeToast(
          "slash-compact-partial",
          "Verlauf kompakt",
          `Lokal getrimmt — Server-Snapshot fehlgeschlagen: ${serverHint ?? "unbekannt"}`,
          "warn",
          "!",
        ),
      );
    }
    return "consumed";
  },
};

const helpCommand: SlashCommand = {
  name: "/help",
  description: "Listet alle verfügbaren Commands.",
  async handler(ctx: SlashContext): Promise<SlashCommandResult> {
    const names = Array.from(REGISTRY.values())
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name));
    const body = names
      .map((c) => `${c.name} — ${c.description}`)
      .join("\n");
    ctx.pushSystemToast(
      makeToast("slash-help", "Commands", body, "default", "?"),
    );
    return "consumed";
  },
};

// ---------------------------------------------------------------------------
// Session commands (2026-05-03)
// User request: "session als command für new session oder sonstige Möglichkeiten".
// `/session-new`  = clear history + cancel all active workstreams in the workspace
// `/session-stop` = cancel only active workstreams, history stays
// `/session`      = alias for /session-new
// ---------------------------------------------------------------------------

async function cancelActiveWorkstreams(
  ctx: SlashContext,
): Promise<{ ok: number; total: number; error?: string }> {
  try {
    const listRes = await ctx.fetch(
      `/api/workstreams?workspaceId=${encodeURIComponent(ctx.workspaceId)}&status=active`,
      { cache: "no-store" },
    );
    if (!listRes.ok) return { ok: 0, total: 0, error: `HTTP ${listRes.status}` };
    const body = (await listRes.json().catch(() => ({}))) as {
      items?: Array<{ id: string }>;
    };
    const ids = (body.items ?? []).map((i) => i.id);
    if (ids.length === 0) return { ok: 0, total: 0 };
    let okCount = 0;
    await Promise.all(
      ids.map(async (id) => {
        try {
          const r = await ctx.fetch(
            `/api/workstreams/${encodeURIComponent(id)}/cancel`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ reason: "session-command" }),
            },
          );
          if (r.ok) okCount += 1;
        } catch {
          /* noop */
        }
      }),
    );
    return { ok: okCount, total: ids.length };
  } catch (err) {
    return { ok: 0, total: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

const sessionStopCommand: SlashCommand = {
  name: "/session-stop",
  description: "Stoppt alle aktiven Workstreams im Workspace (Verlauf bleibt).",
  async handler(ctx: SlashContext): Promise<SlashCommandResult> {
    const res = await cancelActiveWorkstreams(ctx);
    if (res.error) {
      ctx.pushSystemToast(
        makeToast(
          "slash-session-stop",
          "Stoppen fehlgeschlagen",
          res.error,
          "warn",
          "!",
        ),
      );
    } else if (res.total === 0) {
      ctx.pushSystemToast(
        makeToast(
          "slash-session-stop",
          "Nichts zu stoppen",
          "Keine aktiven Workstreams in diesem Workspace.",
          "default",
          "i",
        ),
      );
    } else {
      ctx.pushSystemToast(
        makeToast(
          "slash-session-stop",
          "Workstreams gestoppt",
          `${res.ok}/${res.total} cancelled.`,
          res.ok === res.total ? "ok" : "warn",
          "•",
        ),
      );
    }
    return "consumed";
  },
};

const sessionNewCommand: SlashCommand = {
  name: "/session-new",
  description:
    "Neue Session: aktive Workstreams stoppen + Chat-Verlauf lokal leeren.",
  async handler(ctx: SlashContext): Promise<SlashCommandResult> {
    // 1. Cancel active workstreams.
    const cancel = await cancelActiveWorkstreams(ctx);
    // 2. Local history clear (analogous to the /clear command).
    ctx.setHistory([]);
    clearHistoryFor(ctx.workspaceId);
    if (ctx.clearSystemMessages) ctx.clearSystemMessages();
    // 3. Toast with combined status.
    const cancelMsg =
      cancel.error
        ? `Stop-Fehler: ${cancel.error}`
        : cancel.total === 0
          ? "Keine aktiven Workstreams."
          : `${cancel.ok}/${cancel.total} Workstreams gestoppt.`;
    ctx.pushSystemToast(
      makeToast(
        "slash-session-new",
        "Neue Session",
        `Verlauf geleert · ${cancelMsg}`,
        "ok",
        "•",
      ),
    );
    return "consumed";
  },
};

const sessionAliasCommand: SlashCommand = {
  name: "/session",
  description: "Alias für /session-new (neue Session starten).",
  async handler(ctx: SlashContext): Promise<SlashCommandResult> {
    return sessionNewCommand.handler(ctx);
  },
};

// ---------------------------------------------------------------------------
// Flow command (Track-D · 2026-05-27) — Flow Studio chat front door.
//
// `/flow <intent>` POSTs the intent to POST /api/flow/compose-and-run and
// reacts to the two success statuses:
//   - status:'running'        -> short run confirmation as an assistant bubble.
//                                The flow graph itself is emitted by the orchestrator
//                                separately (not here).
//   - status:'needs-coupling' -> assistant bubble with the surface markup
//                                `<surface:flow-coupling>{...}</surface:flow-coupling>`.
//                                The surface (flowId, workspaceId, missingTools)
//                                is rendered by the parallel coupling agent — here
//                                we only produce the contract-faithful markup.
//   - 401 / error             -> clear error bubble or toast.
//
// Posting runs via ctx.postAssistantMessage (assistant item -> surface-aware
// renderer). If a caller without this method comes in, the command degrades
// to pushSystemToast (a system toast renders NO surface, but is ok as a pure
// status fallback). The surface path needs an assistant item, though.
// ---------------------------------------------------------------------------

/** Fields that `/flow` passes through from the needs-coupling response into the
 *  surface markup. Mirrors MissingTool from lib/flow/compose.ts — follow up there
 *  on drift. */
interface FlowMissingTool {
  stepId: string;
  stepTitle: string;
  provider: string | null;
  neededCapabilities: readonly string[];
  reason: string;
}

/**
 * Stream B2: a single needs-style-choice prompt from the route. Mirrors
 * lib/flow/compose-and-run.ts::MediaStyleChoicePrompt — `step` carries the
 * stable `idx` (styleChoices key across re-compose), `payload` is the
 * quickchoice surface payload (renderer format).
 */
interface FlowStyleChoiceResponsePrompt {
  step?: { stepId?: string; idx?: number; stepTitle?: string; kind?: string };
  payload?: MediaStyleChoicePayload;
}

interface FlowComposeResponse {
  status?: "running" | "needs-coupling" | "needs-style-choice";
  flowId?: string;
  runId?: string;
  workstreamId?: string;
  missingTools?: FlowMissingTool[];
  /** Stream B2: one quickchoice prompt per open media step. */
  styleChoices?: FlowStyleChoiceResponsePrompt[];
  error?: string;
  message?: string;
}

/**
 * Track-D · Stream-B2. Pure translation of a compose-and-run response into the
 * chat actions — shared by the initial `/flow` handler AND the ChatShell re-POST
 * after the style choice (no duplicated status switch). Pure logic: NO fetch,
 * NO DOM. The IO effects travel in as callbacks.
 *
 *   - 'running'           → onRunning() (run confirmation).
 *   - 'needs-coupling'    → onCoupling(<surface:flow-coupling> markup).
 *   - 'needs-style-choice'→ onStyleChoice(FlowStyleChoiceRequest) (ChatShell
 *                           emits the surfaces + wires the choice).
 *   - otherwise           → onError(detail) (unknown/missing status).
 *
 * Returns true when a known status was handled (for the caller).
 */
export function handleFlowComposeResult(
  body: FlowComposeResponse | null,
  ctx: {
    readonly intent: string;
    readonly workspaceId: string;
    readonly onRunning: () => void;
    readonly onCoupling: (markup: string) => void;
    readonly onStyleChoice: (req: FlowStyleChoiceRequest) => void;
    readonly onError: (detail: string) => void;
  },
): boolean {
  if (!body || !body.status) {
    ctx.onError("Unerwartete Server-Antwort.");
    return false;
  }

  if (body.status === "running") {
    ctx.onRunning();
    return true;
  }

  if (body.status === "needs-style-choice") {
    const prompts = (body.styleChoices ?? []).flatMap(
      (p): FlowStyleChoicePrompt[] => {
        const payload = p.payload;
        if (!payload || !Array.isArray(payload.options)) return [];
        // Stable key = String(step.idx). Fallback to payload.stepId only
        // if idx is (unexpectedly) missing — composeAndRun tries both anyway.
        const idx = p.step?.idx;
        const choiceKey =
          typeof idx === "number"
            ? String(idx)
            : (payload.stepId ?? "");
        if (choiceKey.length === 0) return [];
        return [
          {
            choiceKey,
            optionIds: payload.options.map((o) => o.id),
            payload,
          },
        ];
      },
    );
    if (prompts.length === 0) {
      // needs-style-choice without usable prompts (defensive) → error.
      ctx.onError("Stil-Wahl nötig, aber keine Optionen erhalten.");
      return false;
    }
    ctx.onStyleChoice({
      intent: ctx.intent,
      workspaceId: ctx.workspaceId,
      flowId: body.flowId ?? "",
      prompts,
    });
    return true;
  }

  if (body.status === "needs-coupling") {
    const markup = buildFlowCouplingMarkup({
      flowId: body.flowId ?? "",
      workspaceId: ctx.workspaceId,
      missingTools: body.missingTools ?? [],
    });
    ctx.onCoupling(markup);
    return true;
  }

  ctx.onError(`Unbekannter Status: ${String(body.status)}.`);
  return false;
}

/** Builds the `<surface:flow-coupling>` markup with the contract from the task:
 *  { flowId, workspaceId, missingTools }. JSON is the only payload. */
function buildFlowCouplingMarkup(payload: {
  flowId: string;
  workspaceId: string;
  missingTools: FlowMissingTool[];
}): string {
  return (
    "<surface:flow-coupling>" +
    JSON.stringify(payload) +
    "</surface:flow-coupling>"
  );
}

const flowCommand: SlashCommand = {
  name: "/flow",
  description:
    "Startet Flow Studio: erzeugt aus deinem Intent einen Flow und führt ihn aus (fehlt ein Tool, fragt eine Kopplungs-Karte nach).",
  async handler(ctx: SlashContext): Promise<SlashCommandResult> {
    const intent = (ctx.args ?? "").trim();

    // Prefer the assistant bubble (surface-aware renderer). Without this method
    // degrade to a system toast (shows status, but NO surface).
    const postChat =
      ctx.postAssistantMessage ??
      ((content: string) =>
        ctx.pushSystemToast(
          makeToast("slash-flow", "Flow Studio", content, "default", "›"),
        ));

    if (intent.length === 0) {
      ctx.pushSystemToast(
        makeToast(
          "slash-flow",
          "Flow Studio",
          "Nutze `/flow <was-soll-passieren>` — z.B. `/flow erstelle eine Webseite`.",
          "warn",
          "!",
        ),
      );
      return "consumed";
    }

    let res: Response;
    try {
      res = await ctx.fetch("/api/flow/compose-and-run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ intent, workspaceId: ctx.workspaceId }),
      });
    } catch (err) {
      ctx.pushSystemToast(
        makeToast(
          "slash-flow",
          "Flow fehlgeschlagen",
          `Verbindung fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`,
          "err",
          "×",
        ),
      );
      return "consumed";
    }

    // 401 + other errors -> clear toast (no surface).
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      const body = (await res.json().catch(() => null)) as FlowComposeResponse | null;
      if (res.status === 401) {
        detail = "Nicht eingeloggt — bitte anmelden und erneut versuchen.";
      } else if (body && (body.message || body.error)) {
        detail = body.message ?? body.error ?? detail;
      }
      ctx.pushSystemToast(
        makeToast(
          "slash-flow",
          "Flow fehlgeschlagen",
          detail,
          "err",
          "×",
        ),
      );
      return "consumed";
    }

    const body = (await res.json().catch(() => null)) as FlowComposeResponse | null;

    // Shared status translation (shared with the ChatShell re-POST after the
    // style choice). The IO effects travel in as callbacks.
    handleFlowComposeResult(body, {
      intent,
      workspaceId: ctx.workspaceId,
      onRunning: () =>
        postChat("Flow gestartet — der Graph erscheint gleich."),
      onCoupling: (markup) => {
        // Surface MUST land in an assistant item (a system toast renders
        // no surface). Direct postAssistantMessage instead of the postChat fallback.
        if (ctx.postAssistantMessage) {
          ctx.postAssistantMessage(markup);
        } else {
          const missing = (body?.missingTools ?? [])
            .map((m) => m.provider ?? m.stepTitle)
            .join(", ");
          ctx.pushSystemToast(
            makeToast(
              "slash-flow",
              "Tool-Kopplung nötig",
              `Vor dem Start muss ein Tool verbunden werden: ${missing || "unbekannt"}.`,
              "warn",
              "!",
            ),
          );
        }
      },
      onStyleChoice: (req) => {
        // ChatShell emits the quickchoice surface(s) + wires the
        // owner choice → re-POST. Without the callback (test/headless) we
        // degrade to a hint toast + at least post the surfaces (so
        // the owner sees the options, even if the click does not take effect).
        if (ctx.onFlowStyleChoice) {
          ctx.onFlowStyleChoice(req);
        } else if (ctx.postAssistantMessage) {
          for (const p of req.prompts) {
            ctx.postAssistantMessage(
              `<surface:prompt>${JSON.stringify(p.payload)}</surface:prompt>`,
            );
          }
        } else {
          ctx.pushSystemToast(
            makeToast(
              "slash-flow",
              "Stil-Wahl nötig",
              "Bitte wähle für die Medien-Schritte einen Stil.",
              "warn",
              "!",
            ),
          );
        }
      },
      onError: (detail) =>
        ctx.pushSystemToast(
          makeToast("slash-flow", "Flow fehlgeschlagen", detail, "err", "×"),
        ),
    });
    return "consumed";
  },
};

// ---------------------------------------------------------------------------
// /image — image generation via the Codex MCP bridge (2026-06-03, owner choice)
// ---------------------------------------------------------------------------

interface ImagenResponse {
  surfaceMarkup?: string;
  error?: string;
  message?: string;
}

const imageCommand: SlashCommand = {
  name: "/image",
  description:
    "Erzeugt ein Bild aus deiner Beschreibung (Codex · image_gen) und sendet es als Bild-Bubble in den Chat. Dauert ~1 Minute.",
  async handler(ctx: SlashContext): Promise<SlashCommandResult> {
    const prompt = (ctx.args ?? "").trim();
    if (prompt.length === 0) {
      ctx.pushSystemToast(
        makeToast(
          "slash-image",
          "Bild erzeugen",
          "Nutze `/image <beschreibung>` — z.B. `/image ein minimalistisches Logo, pitch-black mit grünem Glow`.",
          "warn",
          "!",
        ),
      );
      return "consumed";
    }

    // IMMEDIATELY post a self-driving, animated image surface (no more
    // blocking fetch — the card starts the async job + polls +
    // swaps the image in, like Codex). No proxy timeout, no static toast.
    const token = `img-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const surface =
      "<surface:image-gen>" +
      JSON.stringify({ prompt, workspace: ctx.workspaceId, token }) +
      "</surface:image-gen>";
    if (ctx.postAssistantMessage) {
      ctx.postAssistantMessage(surface);
    } else {
      ctx.pushSystemToast(
        makeToast(
          "slash-image",
          "Bild",
          "Bild-Surface kann hier nicht gerendert werden.",
          "warn",
          "!",
        ),
      );
    }
    return "consumed";
  },
};

// ---------------------------------------------------------------------------
// /learn — self-learning explicit trigger (2026-06-03, owner vision)
// ---------------------------------------------------------------------------

interface LearnResponse {
  flowId?: string;
  stepCount?: number;
  sourceTitle?: string | null;
  params?: { key: string; observed: string[] }[];
  /** true = 1-run heuristic suggestions (2b-4), not yet applied to the template. */
  paramsHeuristic?: boolean;
  error?: string;
  message?: string;
}

const learnCommand: SlashCommand = {
  name: "/learn",
  description:
    "Merkt sich den zuletzt gelaufenen Ablauf dieses Workspaces als wiederverwendbaren Workflow (expliziter Self-Learning-Trigger). Optional ein Name: `/learn Reel-Pipeline`.",
  async handler(ctx: SlashContext): Promise<SlashCommandResult> {
    const name = (ctx.args ?? "").trim();
    let res: Response;
    try {
      res = await ctx.fetch("/api/flow/learn-latest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          workspaceId: ctx.workspaceId,
          ...(name ? { name } : {}),
        }),
      });
    } catch (err) {
      ctx.pushSystemToast(
        makeToast(
          "slash-learn",
          "Merken fehlgeschlagen",
          `Verbindung fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`,
          "err",
          "×",
        ),
      );
      return "consumed";
    }
    const body = (await res.json().catch(() => null)) as LearnResponse | null;
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      if (res.status === 401) detail = "Nicht eingeloggt.";
      else if (res.status === 404) detail = body?.message ?? "Kein Ablauf in diesem Workspace zum Merken.";
      else if (body && (body.message || body.error)) detail = body.message ?? body.error ?? detail;
      ctx.pushSystemToast(makeToast("slash-learn", "Nichts zu merken", detail, "warn", "!"));
      return "consumed";
    }
    const label = body?.sourceTitle ? `„${body.sourceTitle}"` : "der letzte Ablauf";
    // Auto param extraction (2b-3): with ≥2 captured runs, list detected parameters
    // verbatim (N1, no truncation of the keys).
    const params = body?.params ?? [];
    const paramKeys = params.map((p) => p.key).join(", ");
    const paramSuffix =
      params.length === 0
        ? ""
        : body?.paramsHeuristic
          ? // 1-run heuristic (2b-4): suggestion, not yet applied.
            ` ${params.length} mögliche${params.length === 1 ? "r" : ""} Parameter aus 1 Lauf vorgeschlagen: ${paramKeys} — beim 2. Lauf bestätigt sich's automatisch.`
          : // ≥2-run diff: detected + applied.
            ` ${params.length} Parameter erkannt: ${paramKeys} — beim Wiederholen abfragbar.`;
    ctx.pushSystemToast(
      makeToast(
        "slash-learn",
        "Als Workflow gemerkt",
        `${label} (${body?.stepCount ?? 0} Schritte) ist jetzt ein wiederverwendbarer Workflow${name ? ` „${name}"` : ""}. Wiederholbar via Flow-Run.${paramSuffix}`,
        "ok",
        "✓",
      ),
    );
    return "consumed";
  },
};

// ---------------------------------------------------------------------------
// Static registration
// ---------------------------------------------------------------------------

export function registerSlashCommand(cmd: SlashCommand): void {
  REGISTRY.set(cmd.name.toLowerCase(), cmd);
}

registerSlashCommand(clearCommand);
registerSlashCommand(compactCommand);
registerSlashCommand(helpCommand);
registerSlashCommand(sessionStopCommand);
registerSlashCommand(sessionNewCommand);
registerSlashCommand(sessionAliasCommand);
registerSlashCommand(flowCommand);
registerSlashCommand(imageCommand);
registerSlashCommand(learnCommand);
