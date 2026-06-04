/**
 * lib/chat/slash-commands.ts
 * --------------------------
 * Sub-Plan B (2026-04-29) — Slash-Commands /clear, /compact, /help.
 *
 * Architektur:
 *   - REGISTRY: Map<command-name, SlashCommand>. Alle eingebauten Commands
 *     registrieren sich am Modul-Ende statisch.
 *   - parseSlashCommand(input): erkennt `/<name> [args]` am Beginn der
 *     Eingabe und liefert das passende SlashCommand-Objekt zurueck. Match
 *     ist case-insensitive (`/clear`, `/CLEAR`, `/Clear` -> selbe Command).
 *     Tail-Args werden NICHT geparst — Commands behandeln ihren eigenen
 *     Tail in der Handler-Implementierung.
 *   - SlashCommand.handler(ctx) liefert `'consumed'` (LLM-Roundtrip
 *     ueberspringen) oder `'pass-through'` (LLM weiter ausfuehren). Aktuell
 *     consumen alle eingebauten Commands.
 *
 * Pure-Logik. Kein React, kein DOM. Wird via SlashContext mit IO-Helpern
 * (setHistory, pushSystemToast, fetch, clearHistoryFor) versorgt — so
 * bleibt parseSlashCommand und die Handler-Logik unit-testbar ohne ChatShell.
 */

import type { Dispatch, SetStateAction } from "react";

import type { HistoryItem } from "./ChatShell";
import { clearHistoryFor } from "./storage";
import { extractWorkstreamCoords } from "./surface-parser";
import type { MediaStyleChoicePayload } from "@/lib/flow/media-styles";

/**
 * Lokales Spiegel-Interface fuer SystemItem (in ChatShell.tsx privat
 * deklariert). Wird in der ctx-Schnittstelle verwendet damit Slash-Commands
 * Toasts ohne Zirkular-Import generieren koennen. Felder MUESSEN identisch
 * zur ChatShell-internen `SystemItem` bleiben — wenn dort ein Feld
 * dazukommt, hier nachziehen.
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
  /** Aktive Workspace-ID. Wird fuer /clear (localStorage-Key) + /compact
   *  (Server-Snapshot-Endpoint) gebraucht. */
  workspaceId: string;
  /** Aktueller History-Snapshot (read-only). */
  history: HistoryItem[];
  /** Setter wie aus useState — Commands schreiben damit den neuen Verlauf. */
  setHistory: Dispatch<SetStateAction<HistoryItem[]>>;
  /** Toast-Helper. Wird fuer das User-Feedback nach jedem Command genutzt. */
  pushSystemToast: (item: SystemItem) => void;
  /** Optional: alle SystemMessages (transient Toasts) leeren. Wird von
   *  `/clear` benutzt, damit auch die Workstream-Toasts mit verschwinden. */
  clearSystemMessages?: () => void;
  /** Fetch-Impl. Default = global fetch, Tests koennen mocken. */
  fetch: typeof fetch;
  /**
   * Track-D · 2026-05-27 (Flow Studio). Tail-Args NACH dem Command-Namen,
   * getrimmt. Beispiel: `/flow erstelle eine webseite` -> `args` =
   * `"erstelle eine webseite"`. Leerer String wenn kein Tail. Commands die
   * keine Args brauchen (clear/compact/help/session) ignorieren das Feld.
   * Optional, damit bestehende Aufrufer (und Tests) ohne Args weiterlaufen.
   */
  args?: string;
  /**
   * Track-D · 2026-05-27 (Flow Studio). Postet eine ASSISTANT-Chat-Nachricht
   * in den Verlauf (im Gegensatz zu `pushSystemToast`, das nur einen
   * transienten Toast erzeugt). Nur Assistant-Items laufen in ChatShell durch
   * den surface-aware Renderer (SurfaceRenderer), d.h. `<surface:...>`-Markup
   * wird hier zu einer Card gerendert — bei System-Toasts NICHT (die zeigen
   * Rohtext). `/flow` nutzt das fuer die Lauf-Bestaetigung und das
   * `<surface:flow-coupling>`-Markup. Optional fuer Rueckwaerts-Kompatibilitaet;
   * faellt ein Aufrufer ohne diese Methode an, degradiert `/flow` auf einen
   * System-Toast (siehe Handler).
   */
  postAssistantMessage?: (content: string) => void;
  /**
   * Track-D · Stream-B2-Verdrahtung · 2026-05-27 (Flow Studio). Übergibt der
   * ChatShell-Schicht eine `needs-style-choice`-Antwort: pro offenem Medien-
   * Schritt ein quickchoice-Payload + der ursprüngliche Intent. ChatShell
   * EMITTIERT die quickchoice-Surface(s), HÖRT auf die Owner-Wahl
   * (`lazyos:quickchoice`-Event), bildet daraus die `styleChoices`-Map (keyed
   * auf String(step.idx) — stabil über den deterministischen Re-Compose) und
   * RE-POSTet `/api/flow/compose-and-run` MIT styleChoices. Der Folge-Status
   * (running / needs-coupling / weitere needs-style-choice) wird dort wieder
   * durch handleFlowComposeResult geschickt.
   *
   * Warum nicht im pure-Handler? Surface-Emission + globaler Window-Event-
   * Listener brauchen React-State/DOM (ChatShell-Territorium). Der pure Handler
   * baut nur das Markup + delegiert die Interaktion. Optional + fail-soft:
   * fehlt der Callback, degradiert `/flow` auf einen Hinweis-Toast (die
   * Stil-Wahl kann dann nicht interaktiv erfolgen).
   */
  onFlowStyleChoice?: (req: FlowStyleChoiceRequest) => void;
}

/**
 * Track-D · Stream-B2. Eine `needs-style-choice`-Übergabe an ChatShell: der
 * verbatim Intent + die offenen Stil-Fragen (1 pro Medien-Schritt ohne Wahl).
 */
export interface FlowStyleChoiceRequest {
  /** Der verbatim Operator-Intent (für das Re-POST). N1. */
  readonly intent: string;
  /** Workspace-Scope (für das Re-POST). N9. */
  readonly workspaceId: string;
  /** Die flowId des (ersten) Compose-Laufs — Kontext/Audit. */
  readonly flowId: string;
  /** Pro offenem Medien-Schritt: stabiler idx-Schlüssel + quickchoice-Payload. */
  readonly prompts: readonly FlowStyleChoicePrompt[];
}

/**
 * Ein offener Medien-Schritt: der stabile styleChoices-Schlüssel (String(idx))
 * + der quickchoice-Payload (Renderer-Format, von media-styles.ts gebaut).
 */
export interface FlowStyleChoicePrompt {
  /**
   * Der stabile styleChoices-Schlüssel. = String(step.idx) — stabil über den
   * deterministischen Re-Compose hinweg (die ULID-stepId wäre beim zweiten
   * Compose neu). composeAndRun::lookupStyleChoice probiert stepId ODER idx.
   */
  readonly choiceKey: string;
  /** Die Option-ids dieses Schritts (zum Korrelieren der lazyos:quickchoice-id). */
  readonly optionIds: readonly string[];
  /** Der quickchoice-Surface-Payload (Renderer-Format). */
  readonly payload: MediaStyleChoicePayload;
}

/**
 * Track-D · Stream-B2. Eine aktive Stil-Wahl-Session in der Chat-Schicht: der
 * verbatim Intent + Scope (für das Re-POST), die noch OFFENEN Prompts und die
 * bisher GESAMMELTEN Wahlen. Mutierbar (ChatShell hält sie in einem Ref).
 */
export interface FlowStyleSession {
  readonly intent: string;
  readonly workspaceId: string;
  /** Noch offene Prompts (beantwortete werden entfernt). */
  pending: Array<{ readonly choiceKey: string; readonly optionIds: readonly string[] }>;
  /** Gesammelte Wahlen: choiceKey → optionId. */
  readonly choices: Record<string, string>;
}

/**
 * Track-D · Stream-B2. Pure Korrelation eines quickchoice-Klicks (NUR die
 * Option-id reist im `lazyos:quickchoice`-Event) zu seiner offenen Stil-Frage.
 *
 * Strategie: erste Session mit einem noch-offenen Prompt, dessen optionIds die
 * geklickte id enthält (Anzeige-Reihenfolge → deterministisch). Bei identischen
 * Option-Mengen (z.B. zwei Video-Steps) ordnet der Owner sie der Reihe nach zu
 * (fail-soft, kein hartes Eindeutigkeits-Constraint).
 *
 * MUTIERT die getroffene Session (choices += , pending -=). Liefert:
 *   - matched: ob die id einer offenen Frage zugeordnet wurde,
 *   - completedSession: die Session, FALLS sie damit vollständig wurde (→ der
 *     Caller RE-POSTet + entfernt sie aus der aktiven Liste), sonst null,
 *   - sessionIndex: Index der getroffenen Session (zum Entfernen), oder -1.
 *
 * Reine Logik: KEIN fetch, KEIN DOM, KEINE Seiteneffekte außer der Session-Mutation.
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
  /** Inkl. fuehrendem Slash, lowercase. Beispiel: `/clear`. */
  name: string;
  /** Kurzbeschreibung fuer den /help-Output. */
  description: string;
  /** Handler-Implementierung. Returnt `'consumed'` -> LLM-Roundtrip
   *  ueberspringen, `'pass-through'` -> Eingabe wie eine normale Message
   *  weiterreichen. */
  handler(ctx: SlashContext): Promise<SlashCommandResult>;
}

export const REGISTRY = new Map<string, SlashCommand>();

/**
 * Erkennt einen Slash-Command-Aufruf an Beginn von `input` und liefert
 * das passende Command-Objekt zurueck. Liefert `null` wenn:
 *   - Eingabe leer / nicht mit `/` beginnt
 *   - Command-Name nicht in der REGISTRY
 *
 * Case-insensitive: `/CLEAR`, `/Clear`, `/clear` matchen alle.
 * Tail-Args (`/clear extra junk`) werden ignoriert — der Match laeuft
 * nur ueber den Command-Namen.
 */
export function parseSlashCommand(input: string): SlashCommand | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  // Akzeptiere mit ODER ohne fuehrendes `/`. User-Wunsch 2026-04-30:
  // bare-word command exact match (z.B. `clear`, `compact`, `help`)
  // soll genauso wie `/clear` direkt ausfuehren.
  const firstWord = trimmed.split(/\s+/)[0].toLowerCase();
  const withSlash = firstWord.startsWith("/") ? firstWord : `/${firstWord}`;
  return REGISTRY.get(withSlash) ?? null;
}

/**
 * Track-D · 2026-05-27 (Flow Studio). Liefert den getrimmten Tail NACH dem
 * Command-Namen. `extractSlashArgs('/flow  erstelle eine webseite')` ->
 * `'erstelle eine webseite'`. Leerer String wenn kein Tail vorhanden ist
 * oder die Eingabe kein String / leer ist. Spiegelt die Match-Semantik von
 * `parseSlashCommand` (erstes Wort = Command, Rest = Args), behält im Tail
 * aber die Original-Schreibweise (N1: intent verbatim, nur außen getrimmt).
 */
export function extractSlashArgs(input: string): string {
  if (typeof input !== "string") return "";
  const trimmed = input.trim();
  if (trimmed.length === 0) return "";
  // Schneide das erste Whitespace-getrennte Token (= Command-Name) ab.
  const firstSpace = trimmed.search(/\s/);
  if (firstSpace === -1) return "";
  return trimmed.slice(firstSpace + 1).trim();
}

// ---------------------------------------------------------------------------
// Trim-Helper fuer /compact
// ---------------------------------------------------------------------------

/**
 * Trim-Logik fuer `/compact`:
 *   1. Gruppiere Items nach `(workstreamId, surfaceKind)`-Coord.
 *      Pro Gruppe behalte nur das CHRONOLOGISCH JUENGSTE Item.
 *   2. Items ohne `workstreamId` (= freie User/Assistant-Bubbles) -> behalte
 *      die letzten `freeMessageLimit`.
 *
 * Reihenfolge bleibt erhalten (Items werden nicht umsortiert). Pure —
 * kein State, kein IO.
 *
 * Edge-Cases:
 *   - Items deren workstreamId-Feld fehlt aber im Content `<surface:*>`
 *     mit workstreamId vorhanden ist: ziehen wir per
 *     `extractWorkstreamCoords` nach. Damit bleibt das Verhalten konsistent
 *     mit `applyReplacePass` aus storage.ts.
 *   - Wenn zwei Items dieselbe Coord, gleichen ts haben: Tiebreaker = id-
 *     Reihenfolge im Array (das letzte gewinnt). Kein Try-zu-Parsen-Risiko.
 */
export function trimByWorkstream(
  items: HistoryItem[],
  freeMessageLimit = 6,
): HistoryItem[] {
  if (items.length === 0) return items;

  // Coord pro Item (nutze workstreamId+surfaceKind, mit Content-Fallback).
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

  // Pro Coord-Key: Index des juengsten Items finden (groesster idx in
  // Eingabereihenfolge — Items kommen chrono ASC an).
  const youngestPerCoord = new Map<string, number>();
  for (const c of coords) {
    if (c.key === null) continue;
    youngestPerCoord.set(c.key, c.idx);
  }

  // Free-Items: alle Items ohne Coord-Key. Behalte die letzten N.
  const freeIndices = coords
    .filter((c) => c.key === null)
    .map((c) => c.idx);
  const freeKeep = new Set(freeIndices.slice(-freeMessageLimit));

  // Coord-Items: behalte nur das juengste pro Coord.
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
// Session-Commands (2026-05-03)
// User-Wunsch: "session als command für new session oder sonstige Möglichkeiten".
// `/session-new`  = Verlauf leeren + alle aktiven Workstreams im Workspace canceln
// `/session-stop` = nur aktive Workstreams canceln, Verlauf bleibt
// `/session`      = Alias auf /session-new
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
    // 2. Local history clear (analog /clear-Command).
    ctx.setHistory([]);
    clearHistoryFor(ctx.workspaceId);
    if (ctx.clearSystemMessages) ctx.clearSystemMessages();
    // 3. Toast mit Kombi-Status.
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
// Flow-Command (Track-D · 2026-05-27) — Flow Studio Chat-Front-Door.
//
// `/flow <intent>` POSTet den Intent an POST /api/flow/compose-and-run und
// reagiert auf die zwei Erfolgs-Status:
//   - status:'running'        -> kurze Lauf-Bestaetigung als Assistant-Bubble.
//                                Der Flow-Graph selbst emittiert der Orchestrator
//                                separat (nicht hier).
//   - status:'needs-coupling' -> Assistant-Bubble mit dem Surface-Markup
//                                `<surface:flow-coupling>{...}</surface:flow-coupling>`.
//                                Die Surface (flowId, workspaceId, missingTools)
//                                rendert der parallele Coupling-Agent — hier
//                                erzeugen wir NUR das Contract-getreue Markup.
//   - 401 / Fehler            -> klare Fehler-Bubble bzw. -Toast.
//
// Posting laeuft ueber ctx.postAssistantMessage (Assistant-Item -> surface-aware
// Renderer). Faellt ein Aufrufer ohne diese Methode an, degradiert der Command
// auf pushSystemToast (System-Toast rendert KEIN Surface, ist aber als reiner
// Status-Fallback ok). Der Surface-Pfad braucht aber ein Assistant-Item.
// ---------------------------------------------------------------------------

/** Felder die `/flow` aus der needs-coupling-Antwort in das Surface-Markup
 *  durchreicht. Spiegelt MissingTool aus lib/flow/compose.ts — bei Drift dort
 *  nachziehen. */
interface FlowMissingTool {
  stepId: string;
  stepTitle: string;
  provider: string | null;
  neededCapabilities: readonly string[];
  reason: string;
}

/**
 * Stream B2: ein einzelner needs-style-choice-Prompt aus der Route. Spiegelt
 * lib/flow/compose-and-run.ts::MediaStyleChoicePrompt — `step` trägt den
 * stabilen `idx` (styleChoices-Schlüssel über Re-Compose), `payload` ist der
 * quickchoice-Surface-Payload (Renderer-Format).
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
  /** Stream B2: pro offenem Medien-Schritt ein quickchoice-Prompt. */
  styleChoices?: FlowStyleChoiceResponsePrompt[];
  error?: string;
  message?: string;
}

/**
 * Track-D · Stream-B2. Pure-Übersetzung einer compose-and-run-Antwort in die
 * Chat-Aktionen — geteilt vom Erst-`/flow`-Handler UND vom ChatShell-Re-POST
 * nach der Stil-Wahl (kein dupliziertes Status-Switch). Reine Logik: KEIN fetch,
 * KEIN DOM. Die IO-Wirkungen reisen als Callbacks rein.
 *
 *   - 'running'           → onRunning() (Lauf-Bestätigung).
 *   - 'needs-coupling'    → onCoupling(<surface:flow-coupling>-Markup).
 *   - 'needs-style-choice'→ onStyleChoice(FlowStyleChoiceRequest) (ChatShell
 *                           emittiert die Surfaces + verdrahtet die Wahl).
 *   - sonst               → onError(detail) (unbekannter/fehlender Status).
 *
 * Liefert true, wenn ein bekannter Status behandelt wurde (für den Caller).
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
        // Stabiler Schlüssel = String(step.idx). Fallback auf payload.stepId nur,
        // wenn idx (unerwartet) fehlt — composeAndRun probiert ohnehin beide.
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
      // needs-style-choice ohne brauchbare Prompts (defensiv) → Fehler.
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

/** Baut das `<surface:flow-coupling>`-Markup mit dem Contract aus der Aufgabe:
 *  { flowId, workspaceId, missingTools }. JSON ist die einzige Nutzlast. */
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

    // Assistant-Bubble bevorzugen (surface-aware Renderer). Ohne diese Methode
    // auf einen System-Toast degradieren (zeigt Status, aber KEIN Surface).
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

    // 401 + sonstige Fehler -> klarer Toast (kein Surface).
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

    // Gemeinsame Status-Übersetzung (geteilt mit dem ChatShell-Re-POST nach der
    // Stil-Wahl). Die IO-Wirkungen reisen als Callbacks rein.
    handleFlowComposeResult(body, {
      intent,
      workspaceId: ctx.workspaceId,
      onRunning: () =>
        postChat("Flow gestartet — der Graph erscheint gleich."),
      onCoupling: (markup) => {
        // Surface MUSS in einem Assistant-Item landen (System-Toast rendert
        // keine Surface). Direkt postAssistantMessage statt postChat-Fallback.
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
        // ChatShell emittiert die quickchoice-Surface(s) + verdrahtet die
        // Owner-Wahl → Re-POST. Ohne den Callback (Test/Headless) degradieren
        // wir auf einen Hinweis-Toast + posten die Surfaces wenigstens (damit
        // der Owner die Optionen sieht, auch wenn der Klick nicht greift).
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
// /image — Bild-Generierung über die Codex-MCP-Brücke (2026-06-03, Owner-Wahl)
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

    // SOFORT ein selbst-fahrendes, animiertes Bild-Surface posten (kein
    // blockierender Fetch mehr — die Karte startet den async Job + pollt +
    // swappt das Bild ein, wie Codex). Kein Proxy-Timeout, kein statischer Toast.
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
// /learn — Self-Learning expliziter Trigger (2026-06-03, Owner-Vision)
// ---------------------------------------------------------------------------

interface LearnResponse {
  flowId?: string;
  stepCount?: number;
  sourceTitle?: string | null;
  params?: { key: string; observed: string[] }[];
  /** true = 1-Lauf-Heuristik-Vorschläge (2b-4), noch nicht aufs Template angewendet. */
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
    // Auto-Param-Extraktion (2b-3): bei ≥2 erfassten Läufen erkannte Parameter
    // verbatim auflisten (N1, kein Abschneiden der Schlüssel).
    const params = body?.params ?? [];
    const paramKeys = params.map((p) => p.key).join(", ");
    const paramSuffix =
      params.length === 0
        ? ""
        : body?.paramsHeuristic
          ? // 1-Lauf-Heuristik (2b-4): Vorschlag, noch nicht angewendet.
            ` ${params.length} mögliche${params.length === 1 ? "r" : ""} Parameter aus 1 Lauf vorgeschlagen: ${paramKeys} — beim 2. Lauf bestätigt sich's automatisch.`
          : // ≥2-Lauf-Diff: erkannt + angewendet.
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
// Static-Registration
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
