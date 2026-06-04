'use client';

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { Chat, MessageActions, MsgAssistant, MsgSystem, MsgUser, StreamingBubble } from '@/lib/ui/cht';
import type {
  DecisionProjection,
  TicketProjection,
} from '@/lib/events/types';
import { useCurrentWorkspace, setWorkspaceId } from '@/lib/nav/hooks';
import {
  IconChevronDown,
  IconChevronRight,
  IconClose,
} from '@/lib/nav/icons';
import { isVirtualWorkspaceId } from '@/lib/nav/workspaces-data';
import {
  looksLikeBuildIntent,
  deriveProjectLabel,
  stashPendingBuild,
  takePendingBuild,
} from './build-intent';
import { shouldDecompose } from '@/lib/plan-first/should-decompose';
import { detectImageIntent } from '@/lib/chat/image-intent';
import { ToolPipeline } from './ToolPipeline';
import { renderChatText } from './surface-text-render';
import { useAgentStream } from './useAgentStream';
import { useEventStream, type LazyEventLike } from './useEventStream';
import { eventToSurface } from './event-to-surface';
import {
  hydrateCoordsList,
  loadHistoryServerFirst,
  mergeServerWithLocal,
  readShowHistoryFor,
  writeShowHistoryFor,
} from './storage';
import { useStreamingPoll } from './useStreamingPoll';
import { clearDraftFor } from './draft';
import { chatMessageEventToHistoryItem, isChatMessageEvent } from './serializer';
import {
  archiveStalePeers,
  enforceActiveCap,
  hydrateWorkstreamCoords,
  parseHistoryItem,
  type ParsedHistoryItem,
} from './replace-logic';
import { useSpeechRecognition } from './useSpeechRecognition';
import { useMediaRecorderStt } from './useMediaRecorderStt';
import { useChatCloudUpload } from './useChatCloudUpload';
import {
  buildAgentPrompt,
  buildBubbleContent,
  canSendWithAttachments,
  type StagedAttachment,
} from './attachment-message';
import { StagedAttachmentsBar } from './StagedAttachmentsBar';
import { ChatComposer } from './ChatComposer';
// Gathering-Intelligence (2026-06-02): Sub-Chats in den Hauptchat holen —
// proaktive Karte bei neuer Kunden-Aktivität + dezenter Zugang an der Composer-
// Zeile. Nur für reale Workspaces (Org-Root/virtuell hat keine Sub-Chats).
import { SubchatPulse } from './SubchatPulse';
// UX-1 (2026-05-26): Q/A-Pill über dem Composer (Bottom-Action-UX, Codex-Stil).
import {
  ChatOpenQuestionsPill,
  routePillAnswer,
  dedupeQuestionIds,
} from './ChatOpenQuestionsPill';
import {
  splitOpenQuestionsSection,
  type PlanQuestion,
} from '../workstreams/parse-plan-questions';
// Slice 2 (2026-05-30, Apple-UX): ActionDeck — die EINE gepinnte Bottom-Region.
// Umschließt die Pille; pinnt blockierende Gates (Owner-Befund #1) per DB-
// Projektion (single submit path, Gate-Aktion an ChatShell delegiert).
import { ActionDeck, executeGateAction } from './ActionDeck';
import {
  useWorkspaceState,
  selectPinnedItem,
  pinnedDecisionSignature,
} from './useWorkspaceState';
import type { BlockingGateState } from '../projection/types';
// Workstream 4b (2026-05-27): Open-Questions-Lifecycle ausgelagert in einen
// puren, testbaren Helper. Population aus BEIDEN Quellen (Surface-Tag +
// Markdown-Section), über die GESAMTE History + den laufenden Turn — damit eine
// im ask-but-proceed-Modus emittierte Frage UNTEN gepinnt bleibt, statt mit dem
// Stream wegzuscrollen.
import {
  collectOpenQuestionsFromHistory,
  detectResolvedAndStaleQuestions,
  extractOpenQuestionsFromContent,
  mergeQuestionEnrichmentsById,
  type OpenQuestion,
  type OpenQuestionsSourceItem,
} from './open-questions-lifecycle';
// Engine-Pill (selector) lebt jetzt fusioniert in ChatTopBar — siehe Pill-Dedup
// 2026-05-23. Die alte EnginePill-Komponente bleibt im Repo als orphan, weil
// sie potenziell auf anderen Surfaces (Lab, Onboarding) referenziert werden
// könnte; sie wird in der Chat-Surface aber nicht mehr gemountet.
// import { EnginePill, type EngineMode } from './EnginePill';
// 2026-05-03: ChatHeaderToolbar + SessionControls entfernt — Chat ist
// Command-Center, Slash-Commands im Composer reichen. Imports archiviert
// für eventuelle Re-Aktivierung als reine Module ohne UI-Render.
// import { ChatHeaderToolbar } from './ChatHeaderToolbar';
// import { SessionControls } from './SessionControls';
import { ChatTopBar } from './ChatTopBar';
// All-Access-Toggle (2026-05-26): „Vollzugriff"-Pill NEBEN der Engine-Pill
// (ChatTopBar). Schaltet den Workspace-Permission-Mode freerein↔ask; der
// Live-Chat-Spawn (server/workspace-session.ts) liest diesen Mode.
import { AllAccessToggle } from './AllAccessToggle';
import { PushAutoPrompt } from '@/lib/pwa/PushAutoPrompt';
import { InlineWorkerStatus } from './InlineWorkerStatus';
// 2026-04-29: ActiveWorkstreamBanner / WorkflowProgressPanel /
// OpenQuestionsSurface waren parallel-Overlays — User-Veto: muss in
// existing Surface-Library (lib/ui/cht, lib/chat/SurfaceRenderer) rein.
// Imports + Mounts unten entfernt.
import { useChatSuggestions, type ChatSuggestion } from './useChatSuggestions';
import { SurfaceActionProvider } from './SurfaceActionContext';
// Owner-Fix Run-Cockpit (2026-05-28) — Provider, der die suppress-Logik
// fuer die 3 Legacy-Surfaces (sub-workstreams, iterate-pipeline, iterate-
// version) koordiniert, sobald eine `<surface:run-cockpit>`-Card aktiv ist.
import {
  RunCockpitRegistryProvider,
  PinnedDecisionRegistryProvider,
} from './SurfaceRenderer';
import {
  parseSlashCommand,
  extractSlashArgs,
  handleFlowComposeResult,
  correlateQuickChoice,
  type SlashContext,
  type SystemItem as SlashSystemItem,
  type FlowStyleChoiceRequest,
  type FlowStyleSession,
} from './slash-commands';
import { isAutoModeOn } from '@/lib/nav/AutoModeToggle';
import { detectBugReport } from './bug-swarm-detection';
import {
  classifyFlowIntent,
  buildSyntheticFlowCommand,
} from './intent-flow-classifier';
import type { AssistantTurn, ToolStep } from './types';
import { useTypingIndicator, type TypingPhase } from './useTypingIndicator';

/**
 * Chat — Apple-pure Redesign (2026-04-24).
 *
 * Struktur:
 *   [Chat-Stream oder Empty-State]          ← dominiert oben
 *   [ChatComposer: Input + Mic + Send]      ← großes Input-Feld
 *   [Stream-Stop-Fußzeile (optional)]
 *   [Banners (subtil, unter dem Composer)]
 *
 * Entfernt gegenüber der alten Shell:
 *   - ContextBand-Zeile
 *   - Segment-PillRow
 *   - Chat-Assistant-Icon im Empty-State
 *   - ChatWorkspaceInlineSwitcher (redundant zum Header-Switcher)
 *   - MicButton als separater Button neben dem Input
 *   - Bullet/Kicker über dem H2
 *
 * Bleibt:
 *   - Per-Workspace-History (historyKeyFor / read / write + Switch-Effect)
 *   - Mock-Fallback bei `not_configured`
 *   - Agent-Stream via useAgentStream
 *   - STT (Web Speech API) — jetzt inline im Composer
 *
 * Storage-Keys pro Workspace isoliert: `lazyos.chat.history.<wsId>`.
 * Legacy-Key `lazyos.chat.history` wird beim ersten Hydrate in den
 * aktuellen Workspace migriert.
 * `mock-mode` bleibt global (UI-Präferenz).
 */
const STORAGE_HISTORY_BASE = 'lazyos.chat.history';
const STORAGE_HISTORY_LEGACY = 'lazyos.chat.history';
const STORAGE_MOCK = 'lazyos.chat.mock-mode';
const STORAGE_LIVE_BASE = 'lazyos.chat.live';
const HISTORY_CAP = 60;

/**
 * Hängt ein HistoryItem an ODER merged es in ein vorhandenes Item mit derselben
 * id (P0-Fix 2026-06-02, Codex-Goal — Doppel-React-Key-Race).
 *
 * Die Stream-Result-Branches (ok / aborted / error / rate-limit) appenden die
 * Assistant-Message unter der Server-ULID `resultEventIdRef.current`. Parallel
 * fügt der Live-`/api/events/stream` ein `chat_message_completed`-HistoryItem
 * unter DERSELBEN ULID ein. Der Live-Pfad dedupt bereits per id; ohne den
 * symmetrischen Guard hier erzeugt der zuletzt laufende Pfad ein zweites Item
 * mit identischem `key={it.id}` → React-Warning + potentiell verschluckte/
 * duplizierte Messages. `upsertHistoryItem` macht beide Reihenfolgen idempotent:
 * existiert die id schon, wird gemerged (Content/Tools des Result-Branch
 * gewinnen), sonst regulär appended (HISTORY_CAP-bounded).
 */
function upsertHistoryItem(h: HistoryItem[], item: HistoryItem): HistoryItem[] {
  const idx = h.findIndex((m) => m.id === item.id);
  if (idx >= 0) {
    const next = h.slice();
    next[idx] = { ...next[idx], ...item };
    return next;
  }
  return [...h.slice(-(HISTORY_CAP - 1)), item];
}

/**
 * Phase AC Fallback (2026-04-26): Client-side Konsens-Detection wenn der
 * Server kein consensus_level im Synthesis-Payload mitgegeben hat (alte
 * Workstreams). Identische Heuristik wie tier-orchestrator.detectConsensusLevel,
 * damit alte Bubbles dieselbe Card-Logik bekommen wie neue.
 */
function detectConsensusLevelClient(
  text: string,
): 'strong' | 'majority' | 'disagreement' {
  const t = text.toLowerCase();
  if (/(^|\s)@max(\b|\s)/.test(text)) return 'disagreement';
  if (t.includes('disagreement')) return 'disagreement';
  if (t.includes('unvereinbar')) return 'disagreement';
  const clusterSection = text.match(
    /##\s+Cluster-(?:Übersicht|Uebersicht|Overview)([\s\S]*?)(?:\n##\s|$)/i,
  );
  if (clusterSection) {
    const bullets = clusterSection[1].match(/^[\s]*[-*]\s+/gm) ?? [];
    if (bullets.length >= 3) return 'disagreement';
    if (bullets.length >= 2) return 'majority';
  }
  if (t.includes('outlier') || t.includes('ausreißer') || t.includes('ausreisser')) {
    return 'majority';
  }
  const openQuestions = text.match(/\[\?\]/g) ?? [];
  if (openQuestions.length >= 2) return 'majority';
  return 'strong';
}
/**
 * UX-1 (2026-05-26): Q&A-Reply-Text aus beantworteten Fragen bauen.
 * Identisches Format wie der inline-Stepper (ChatInlineOpenQuestions) — der
 * Agent sieht die Antworten als kompakte „Frage: … / Antwort: …"-Liste.
 * Unbeantwortete Fragen werden weggelassen (sauberer als „—"-Platzhalter).
 */
function buildQAReply(
  questions: ReadonlyArray<{ id: string; text: string }>,
  answers: Record<string, string>,
): string {
  const lines: string[] = [];
  for (const q of questions) {
    const ans = answers[q.id];
    if (ans !== undefined) {
      lines.push(`Frage: ${q.text}\nAntwort: ${ans}`);
    }
  }
  return lines.join('\n\n');
}

// ---------------------------------------------------------------------------
// Bug-5-Fix · Frage-3×-im-DOM-Dedup · 2026-05-30
// ---------------------------------------------------------------------------
// Live-Browser-Befund (verbatim): Dieselbe offene Frage erscheint DREIMAL —
//   (1) als Markdown-Section in der Assistant-Bubble (`## Offene Fragen`),
//   (2) als inline interaktive Surface (`<surface:open-questions>` /
//       `<surface:prompt variant=…>`),
//   (3) gepinnt in der Pille über dem Composer.
// Die Pille ist die KANONISCHE interaktive Quelle (Apple-UX: eine primäre
// Aktion, unten angepinnt). Sobald eine Frage dort gepinnt ist, ist ihr inline-
// Zwilling in der Bubble redundant.
//
// FIX (innerhalb der erlaubten Dateien, ohne replace-logic/surface-text-render
// anzufassen): Wir entfernen die zu den gepinnten Fragen gehörenden Surface-/
// Markdown-Spans aus dem Assistant-CONTENT-String, bevor er gerendert wird.
// Der Renderer re-scannt den modifizierten String (Cache wird bewusst NICHT
// mitgegeben, sonst leakten die `startIdx/endIdx` den rohen Tag-Text). Nur
// frage-tragende Surfaces, deren Fragen-IDs ALLE gepinnt sind, fallen weg —
// fremde Surfaces (charts, tier-choice, etc.) bleiben unberührt.
//
// Reine String-Operation, side-effect-frei, idempotent.
const OQ_SURFACE_STRIP_RE =
  /<surface:open-questions>[\s\S]*?<\/surface:open-questions>/gi;
const PROMPT_SURFACE_STRIP_RE =
  /<surface:prompt>([\s\S]*?)<\/surface:prompt>/gi;
const OQ_MARKDOWN_HEADER_STRIP_RE =
  /^##[ \t]+(?:Offene[ \t]+Fragen|Open[ \t]+Questions|Fragen|Questions)\b[^\n]*$/im;

function questionIdsCoveredByPin(
  questions: ReadonlyArray<{ id: string }>,
  pinnedIds: ReadonlySet<string>,
): boolean {
  if (questions.length === 0) return false;
  for (const q of questions) {
    if (!pinnedIds.has(q.id)) return false;
  }
  return true;
}

/**
 * Entfernt aus `content` jene frage-tragenden Surface-/Markdown-Spans, deren
 * Fragen vollständig in `pinnedIds` (= aktuell in der Pille) liegen. Liefert den
 * (ggf. modifizierten) String + ein `changed`-Flag. Wenn nichts gestript wurde,
 * ist `content` referentiell identisch.
 */
export function stripPinnedQuestionSurfaces(
  content: string,
  pinnedIds: ReadonlySet<string>,
): { content: string; changed: boolean } {
  if (
    typeof content !== 'string' ||
    content.length === 0 ||
    pinnedIds.size === 0 ||
    (content.indexOf('<surface:') < 0 && content.indexOf('#') < 0)
  ) {
    return { content, changed: false };
  }
  let changed = false;
  let out = content;

  // (a) `<surface:open-questions>` — strippen, wenn alle Fragen gepinnt sind.
  out = out.replace(OQ_SURFACE_STRIP_RE, (full) => {
    const qs = extractOpenQuestionsFromContent(full);
    if (questionIdsCoveredByPin(qs, pinnedIds)) {
      changed = true;
      return '';
    }
    return full;
  });

  // (b) `<surface:prompt variant=open-questions|plan-questions>` — dito. Nur
  //     frage-tragende Prompt-Varianten; quickchoice/credential/form bleiben.
  out = out.replace(PROMPT_SURFACE_STRIP_RE, (full, body: string) => {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(body);
    } catch {
      return full;
    }
    const variant =
      parsed && typeof parsed === 'object'
        ? (parsed as { variant?: unknown }).variant
        : undefined;
    if (variant !== 'open-questions' && variant !== 'plan-questions') {
      return full;
    }
    // Fragen direkt aus dem Prompt-Payload lesen (extractOpenQuestionsFromContent
    // matcht nur `<surface:open-questions>`, nicht den prompt-Wrapper).
    const rawQs =
      parsed && typeof parsed === 'object' && Array.isArray((parsed as { questions?: unknown }).questions)
        ? ((parsed as { questions: unknown[] }).questions)
        : [];
    const qs = rawQs.flatMap((q): Array<{ id: string }> => {
      if (!q || typeof q !== 'object') return [];
      const id = (q as { id?: unknown }).id;
      return typeof id === 'string' && id.length > 0 ? [{ id }] : [];
    });
    if (questionIdsCoveredByPin(qs, pinnedIds)) {
      changed = true;
      return '';
    }
    return full;
  });

  // (c) Markdown-`## Offene Fragen`-Section — nur strippen, wenn die geparsten
  //     Fragen alle gepinnt sind. splitOpenQuestionsSection liefert before/after
  //     drumherum; wir kleben before+after wieder zusammen.
  if (OQ_MARKDOWN_HEADER_STRIP_RE.test(out)) {
    const split = splitOpenQuestionsSection(out);
    if (split && questionIdsCoveredByPin(split.questions, pinnedIds)) {
      const before = split.before.replace(/\s+$/, '');
      const after = split.after.replace(/^\s+/, '');
      out = before && after ? `${before}\n\n${after}` : `${before}${after}`;
      changed = true;
    }
  }

  if (!changed) return { content, changed: false };
  return { content: out.trim(), changed: true };
}

// ---------------------------------------------------------------------------
// Bug-2-Fix · Free-Text-Antwort-Kopplung · 2026-05-30
// ---------------------------------------------------------------------------
// Live-Browser-Befund: Tippt der User FREI „Eigenes Video" statt eine offene
// Choice anzuklicken, fällt der Text durch classifyFlowIntent (min 3 Wörter +
// Imperativ → sonst 'unknown') in den normalen Chat-Stream → der Agent wirft
// einen DRITTEN Picker statt es als Antwort zu verstehen.
//
// Predicate: Free-Text wird an die offene Frage gekoppelt, wenn …
//   - keine Anhänge gestaged sind,
//   - die Pille NICHT ausgeklappt ist (der pillExpanded-Pfad hat Vorrang),
//   - mindestens eine Frage offen/gepinnt ist,
//   - der Input KEIN Slash-Command ist,
//   - der Input NICHT als confident Flow klassifiziert (ein bewusst neuer
//     Build wie „erstelle eine Webseite" startet weiter einen Flow).
// Pur + side-effect-frei → direkt testbar (kein ChatShell-Mount nötig).
export function shouldRouteFreeTextAsAnswer(args: {
  value: string;
  hasStaged: boolean;
  pillExpanded: boolean;
  openQuestionCount: number;
  classify: (v: string) => { kind: 'flow' | 'unknown' };
}): boolean {
  const { value, hasStaged, pillExpanded, openQuestionCount, classify } = args;
  if (hasStaged) return false;
  if (pillExpanded) return false;
  if (openQuestionCount <= 0) return false;
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (trimmed.length === 0) return false;
  if (trimmed.startsWith('/')) return false;
  if (classify(trimmed).kind === 'flow') return false;
  return true;
}

/**
 * 2026-05-28 (W1/W2 — Open-Questions-Wiring). Schmaler array-Equality-Helper
 * für den Re-Render-Bail-Out im Pill-Enrichment-Merge. Pure, inline-tauglich.
 */
function arrEq(
  a: ReadonlyArray<string> | undefined,
  b: ReadonlyArray<string> | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/** How many past messages we ship to the model on each turn. */
const CONTEXT_WINDOW = 12;
/** Live-state >60min wird verworfen (vermutlich nicht mehr relevant). */
const LIVE_TTL_MS = 60 * 60 * 1000;

function historyKeyFor(workspaceId: string): string {
  return `${STORAGE_HISTORY_BASE}.${workspaceId}`;
}

function liveKeyFor(workspaceId: string): string {
  return `${STORAGE_LIVE_BASE}.${workspaceId}`;
}

interface LiveSnapshot {
  /** ISO timestamp wann der Stream gestartet wurde (fuer TTL). */
  startedAt: string;
  text: string;
  tools: ToolStep[];
}

function readLiveFor(workspaceId: string): LiveSnapshot | null {
  try {
    const raw = window.localStorage.getItem(liveKeyFor(workspaceId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LiveSnapshot>;
    if (typeof parsed.startedAt !== 'string') return null;
    if (typeof parsed.text !== 'string') return null;
    if (!Array.isArray(parsed.tools)) return null;
    const age = Date.now() - new Date(parsed.startedAt).getTime();
    if (age > LIVE_TTL_MS) return null;
    return parsed as LiveSnapshot;
  } catch {
    return null;
  }
}

function writeLiveFor(workspaceId: string, snap: LiveSnapshot): void {
  try {
    window.localStorage.setItem(liveKeyFor(workspaceId), JSON.stringify(snap));
  } catch {
    /* quota / private-mode */
  }
}

function clearLiveFor(workspaceId: string): void {
  try {
    window.localStorage.removeItem(liveKeyFor(workspaceId));
  } catch {
    /* ignore */
  }
}

function readHistoryFor(workspaceId: string): HistoryItem[] | null {
  try {
    const raw = window.localStorage.getItem(historyKeyFor(workspaceId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const items = parsed.filter(isHistoryItem).slice(-HISTORY_CAP);
    // Sub-Plan A · 2026-04-29: Hydrate-Migration. Alte persistierte Items
    // haben kein workstreamId/surfaceKind-Feld. Wenn der Content einen
    // Surface-Tag mit workstreamId enthaelt, ziehen wir die Coord nach.
    // Hint 1 (Sub-Plan A): nutzt den exportierten Helper aus storage.ts
    // — ein und derselbe Code-Pfad fuer Single-Read und Server-Merge.
    return hydrateCoordsList(items);
  } catch {
    return null;
  }
}

function writeHistoryFor(workspaceId: string, items: HistoryItem[]): void {
  try {
    window.localStorage.setItem(
      historyKeyFor(workspaceId),
      JSON.stringify(items.slice(-HISTORY_CAP)),
    );
  } catch {
    // quota / private-mode — ignore
  }
}

/**
 * Merge Server-systemItems mit bereits live-eingetroffenen SystemItems.
 * Dedup per id (server liefert `sys-<event-id>`, live-Stream baut die
 * gleiche id ueber `sys-${ev.id}`). Cap bei 30 damit unbounded growth
 * nicht passiert.
 */
/**
 * Phase Reload-Recovery V2 · 2026-04-27.
 * Erzeugt einen primitiven Fingerprint ueber alle Streaming-relevanten
 * Felder im History-Array. Wird im Polling-Update genutzt um Re-Renders
 * zu vermeiden wenn sich nichts streaming-spezifisches geaendert hat
 * (Polling-Tick ohne neuen Token landet sonst trotzdem als setHistory →
 * Re-Render der ganzen Liste).
 */
function streamSignature(items: { id: string; streamState?: 'streaming' | 'aborted'; partialContent?: string; toolState?: { name: string; status: 'pending' | 'done' } | null; inCodeBlock?: boolean }[]): string {
  return items
    .filter((it) => it.streamState !== undefined)
    .map(
      (it) =>
        `${it.id}|${it.streamState}|${it.partialContent?.length ?? 0}|${it.inCodeBlock ? 1 : 0}|${it.toolState?.name ?? ''}-${it.toolState?.status ?? ''}`,
    )
    .join(';');
}

function mergeSystemItems<T extends { id: string }>(prev: T[], incoming: T[]): T[] {
  if (incoming.length === 0) return prev;
  const known = new Set(prev.map((s) => s.id));
  const fresh = incoming.filter((s) => !known.has(s.id));
  if (fresh.length === 0) return prev;
  const next = [...prev, ...fresh];
  return next.length > 30 ? next.slice(-30) : next;
}

export interface HistoryItem {
  id: string;
  role: 'user' | 'assistant';
  /** Raw text content. */
  content: string;
  /** Tool invocations that ran during this turn (agent path). */
  tools?: ToolStep[];
  /** ISO timestamp. */
  ts: string;
  /** Optional metadata for the footer. */
  durationMs?: number;
  /** Phase MS: marks an item that came from a chat_message_* event. */
  partial?: boolean;
  /**
   * Phase MS · 2026-04-26 (B1-fix). Server-Item: die pendingPromptId aus
   * dem `chat_message_sent`-Event-Payload. Wird von
   * `mergeServerWithLocal` benutzt um lokale User-Echo-Items mit ihrer
   * Server-ULID-Variante zu paaren — sonst sieht Max nach Replay zwei
   * User-Bubbles (lokale ID + ULID) statt einer.
   */
  pendingPromptId?: string;
  /**
   * Wer hat die Message verschickt. Default-Fallback im Renderer:
   *   role=user      -> 'user:max'
   *   role=assistant -> 'agent:claude'
   *
   * Wenn role=user UND actor NICHT mit 'user:' beginnt (z.B.
   * 'agent:terminal-claude', 'agent:api', 'system'), rendert ChatShell
   * eine spezielle Bubble mit Pill-Header — sonst wirkt eine Test-
   * /API-/Skript-Message wie eine eigene User-Eingabe.
   */
  actor?: string;

  // -------------------------------------------------------------------
  // Phase Reload-Recovery V2 · 2026-04-27
  // Felder die nur fuer "halb-fertige" Assistant-Items gesetzt sind, deren
  // Quelle ein streaming_snapshots-Row im Backend ist (nicht ein
  // chat_message_completed-Event). Solange `streamState` gesetzt ist,
  // pollt der Client diesen Endpoint alle 2s. Bei `aborted` wird statt
  // einer normalen Bubble die <StreamingBubble/> gerendert.
  //
  // TODO(backend): Backend-Agent muss diese Felder vom History-Endpoint
  // ausliefern, sobald die Streaming-Snapshot-Tabelle steht (siehe
  // /tmp/recovery-syn.txt Punkte 1, 4).
  // -------------------------------------------------------------------

  /** Wenn gesetzt: Item kommt aus einem snapshot, nicht aus completed-Event. */
  streamState?: 'streaming' | 'aborted';
  /** Bisheriger Streaming-Text (aus snapshot.partial_content). */
  partialContent?: string;
  /** True wenn Snapshot mid-```-Codeblock ist (snapshot.in_code_block). */
  inCodeBlock?: boolean;
  /** Pending Tool beim Snapshot (snapshot.tool_state). */
  toolState?: {
    name: string;
    status: 'pending' | 'done';
    id?: string;
  } | null;
  /** ISO-Timestamp des letzten Snapshot-Updates (fuer 10s-Heuristik client-side). */
  snapshotUpdatedAt?: string;

  // -------------------------------------------------------------------
  // Sub-Plan A · 2026-04-29 — One-Card-Pro-Workstream-Replace
  // -------------------------------------------------------------------
  // Wenn ein Surface-Block (z.B. <surface:consensus-action>) eine
  // workstreamId in seinem Payload traegt, wird dieser Wert + das
  // Surface-Kind hier mitgespeichert. Beim Append einer NEUEN Bubble
  // mit demselben (workstreamId, surfaceKind)-Paar werden alle vorigen
  // Items mit derselben Coord auf `archived=true` markiert. So bleibt
  // im Chat genau eine "lebende" Card pro Workstream + Kind sichtbar,
  // ohne dass alte Verlaufs-Bubbles geloescht werden (Sub-Plan B
  // bringt einen Verlaufs-Toggle der archivierte Items wieder zeigt).
  /** SurfaceKind des dominanten Surface-Blocks im content (falls einer existiert). */
  surfaceKind?: import('./surface-parser').SurfaceKind;
  /** workstreamId aus dem Surface-Payload (falls vorhanden). */
  workstreamId?: string;
  /** Soft-archive-Marker: durch eine neuere Card mit gleichem (workstreamId, surfaceKind) verdraengt. */
  archived?: boolean;
  /**
   * Sub-Plan A Finding 5 (2026-04-29). Marker, dass die Hydrate-Migration
   * (Coords aus dem Content nachziehen) bereits gelaufen ist. Verhindert,
   * dass jeder Read denselben Regex erneut faehrt.
   */
  _coordsHydrated?: boolean;
}

/**
 * Transient system-message that comes from the live event-stream.
 * Never persisted to localStorage — events re-replay on reconnect.
 */
interface SystemItem {
  id: string;
  role: 'system';
  kind: string;
  content: string;
  severity: 'info' | 'warn' | 'critical';
  href?: string;
  ts: string;
}

type ChatItem = HistoryItem | SystemItem;

function formatEventTs(tsMs?: number): string {
  const d = tsMs ? new Date(tsMs) : new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function eventKindLabel(ev: LazyEventLike): string {
  const t = ev.type ?? ev.entityType ?? 'event';
  return t.replace(/_/g, ' ');
}

/**
 * Mappt einen Actor-String (aus chat_message_sent.payload.actor) auf einen
 * UI-tauglichen Sender-Label fuer die User-Bubble. Gibt undefined zurueck
 * wenn die Bubble normal (ohne Pill) gerendert werden soll — d.h. fuer
 * Cookie-Auth-User-Prompts und auch fuer alte Events ohne actor-Field.
 *
 * Nicht-`user:*`-Actors fuehren zu spezial-Bubble:
 *   agent:terminal-claude -> 'Terminal-Claude'
 *   agent:api             -> 'API-Test'
 *   agent:senior-dev      -> 'Senior-Dev'
 *   system                -> 'System'
 */
function userActorLabel(actor: string | undefined): string | undefined {
  if (!actor) return undefined;
  if (actor.startsWith('user:')) return undefined;
  if (actor === 'agent:api') return 'API-Test';
  if (actor === 'agent:terminal-claude') return 'Terminal-Claude';
  if (actor === 'system') return 'System';
  if (actor.startsWith('agent:')) {
    const slug = actor.slice(6);
    return slug
      .split('-')
      .filter(Boolean)
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
      .join('-');
  }
  return actor;
}

export interface ChatShellProps {
  tickets: TicketProjection[];
  decisions: DecisionProjection[];
}

export function ChatShell({
  tickets,
  decisions,
}: ChatShellProps) {
  const [input, setInput] = useState('');
  const [history, setHistory] = useState<HistoryItem[]>([]);
  // Aktuelle History ohne Stale-Closure (für die Auto-Projekt-Naht: der
  // Brainstorm-Kontext muss in das neue Projekt-Workspace mitgenommen werden).
  const historyForHandoffRef = useRef<HistoryItem[]>([]);
  useEffect(() => {
    historyForHandoffRef.current = history;
  }, [history]);
  const [systemMessages, setSystemMessages] = useState<SystemItem[]>([]);
  // Sub-Plan E (2026-04-30) — Single-Pass-Coord-Cache. Pro item.id genau
  // EIN Surface-Scan. Wird unten an `renderChatText(text, surfaces)` als
  // Cache-Argument übergeben damit der Renderer nicht selbst nochmal
  // scannt. Map<id, ParsedHistoryItem> — neue history → komplett neu
  // gemappt, aber pro Item ist die Arbeit deterministisch single-pass.
  const parsedItems = useMemo<Map<string, ParsedHistoryItem>>(() => {
    const map = new Map<string, ParsedHistoryItem>();
    for (const item of history) {
      map.set(item.id, parseHistoryItem(item));
    }
    return map;
  }, [history]);
  // Sub-Plan B · 2026-04-29 — History-Toggle ("Nur Fokus" vs. "Verlauf an").
  // Default false (Fokus). Beim Mount aus localStorage hydraten,
  // beim Workspace-Switch auf false zurücksetzen, bei submit auto-reset.
  const [showHistory, setShowHistory] = useState<boolean>(false);
  // Inert seit 2026-06-03 (Mock-Subsystem entfernt): bleibt `false`, weil
  // `useTypingIndicator` das Flag noch im Live-Signal-Pfad liest.
  const isMockPending = false;
  // Phase RL.3 (2026-04-28): Server-Side Stream läuft noch — gesetzt wenn
  // beim Mount/Refresh erkannt wurde dass der letzte chat_message_sent
  // ohne korrespondierenden _completed dasteht (Stream nicht abgeschlossen).
  // Polling alle 5s bis ein assistant-Item nachkommt.
  const [serverStreamPending, setServerStreamPending] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  // Phase MS (P1-3): SSE-Subscription erst NACHDEM die einmalige
  // localStorage→DB-Migration durch ist (oder feststand dass es nichts
  // zu migrieren gibt). Sonst kommt der replay-Burst aus /api/events/
  // stream rein WAEHREND die Cache-IDs noch im State stehen — die
  // ULID-Echos matchen nicht und User-Message wird doppelt gerendert.
  const [migrationDone, setMigrationDone] = useState(false);
  // B3-fix 2026-04-26: Wenn die Migration fehlschlaegt (Server-500, Offline),
  // blockt useEventStream weiter (migrationDone bleibt false). Dieser Flag
  // signalisiert dem User dass etwas nicht stimmt + erlaubt manuellen Retry
  // oder Auto-Retry nach 30s.
  const [migrationFailed, setMigrationFailed] = useState(false);
  // Auto-Retry-Counter: jede Inkrement triggert den Migration-Effect
  // erneut (auch ohne Workspace-Switch).
  const [migrationRetryTick, setMigrationRetryTick] = useState(0);

  const currentWorkspace = useCurrentWorkspace();

  // Gathering-Intelligence (2026-06-02): „Im Hauptchat aufgreifen" aus der
  // proaktiven Sub-Chat-Karte seedet den Composer mit einem fertigen Prompt
  // (KI-Vorschlag-Stil) und fokussiert das Eingabefeld — der Operator sendet
  // mit einem Tap und der Hauptchat arbeitet das Anliegen mit RAG-Wissen aus.
  const handleSubchatPickUp = useCallback(
    (prompt: string, target?: { workspaceId: string; organizationId?: string }) => {
      // Re-scope the main chat into the customer's REAL workspace so the next
      // send runs with that workspace's RAG scope (N2). Graceful fallback: if no
      // resolvable target, seed at the current scope (today's behaviour).
      if (target?.workspaceId && target.workspaceId !== currentWorkspace.id) {
        try {
          setWorkspaceId(target.workspaceId, target.organizationId);
        } catch {
          /* non-fatal — fall through and seed at current scope */
        }
      }
      setInput(prompt);
      requestAnimationFrame(() => {
        const ta = document.querySelector(
          '.lazyos-composer__input',
        ) as HTMLTextAreaElement | null;
        if (ta) {
          ta.focus();
          try {
            ta.setSelectionRange(ta.value.length, ta.value.length);
          } catch {
            /* ignore */
          }
        }
      });
    },
    [currentWorkspace.id],
  );
  const subchatsEnabled = !isVirtualWorkspaceId(currentWorkspace.id);

  // P1 · One-Focal-Point (2026-06-02): Ob die proaktive SubchatPulse-Karte
  // gerade WIRKLICH eine Karte rendert (sie liefert sonst `null`). SubchatPulse
  // gehört nicht zu dieser Slice — statt sie zu koppeln, beobachten wir DOM-
  // seitig ihr `<section aria-label="Neues aus deinen Kundenchats">` im Stream-
  // Container. Liegt sie vor, wird der zentrierte Empty-State-Hero zur ruhigen
  // top-verankerten Intro herabgestuft (eine primäre Fläche pro Screen).
  const [pulseCardPresent, setPulseCardPresent] = useState(false);

  const {
    status: agentStatus,
    turn: agentTurn,
    error: agentError,
    send: sendAgent,
    abort: abortAgent,
    reset: resetAgent,
  } = useAgentStream();

  const streamRef = useRef<HTMLDivElement>(null);
  const streamEndRef = useRef<HTMLDivElement>(null);
  const idCounter = useRef(0);
  const baseId = useId();

  // Bug 1 Fix (2026-05-30): stabiler Ref auf den jüngsten agentError, damit der
  // async submit-Handler im Error-Branch die ECHTE Ursache (statt eines
  // stale-Closure-Werts) in die fail-soft Assistant-Karte schreiben kann.
  const agentErrorRef = useRef<string | null>(agentError);
  useEffect(() => {
    agentErrorRef.current = agentError;
  }, [agentError]);

  // ---- Phase MS · 2026-04-26: pendingPromptId-Set ---------------------
  // IDs die WIR gerade selbst gefeuert haben. Wenn das chat_message_sent-
  // Event ueber den Live-Event-Stream zurueckkommt mit einer dieser IDs
  // im payload, ignorieren wir es — sonst sehen wir unsere eigene User-
  // Message doppelt.
  const ownPendingIdsRef = useRef<Set<string>>(new Set());

  // Phase RL.2 (2026-04-28): Map<prompt → attempts> fuer Rate-Limit-Auto-Retry.
  // Nach erfolgreichem Stream-Outcome 'ok' wird der Eintrag gecleart.
  const lastRetryAttemptsRef = useRef<Map<string, number>>(new Map());

  // ---- Bug-2-Fix: Message-Queue + Interrupt · 2026-05-25 ---------------
  // FIFO-Queue für Nachrichten die während des Streamings eingetippt werden.
  // Wird geleert sobald agentStatus auf 'idle' wechselt.
  // Kein React-State (würde den Flush-Effect triggern) — nur Ref.
  const messageQueueRef = useRef<string[]>([]);
  // Anzahl der Queued-Nachrichten als React-State für die UI (Queue-Chip).
  const [queueLength, setQueueLength] = useState(0);

  // ---- UX-1: Q/A-Pill-State (über dem Composer) · 2026-05-26 -----------
  // Quelle: ein Assistant-Turn mit `## Offene Fragen`-Section → wir ziehen
  // die Fragen hier hoch und mounten sie als Pill ÜBER dem Composer (statt
  // sie nur inline im Stream als Stepper zu rendern). Der Chat-Input wird zur
  // Antwort, wenn die Pill ausgeklappt ist (Routing im submit-Handler).
  // 2026-05-28 (W1/W2): Type aufgeweicht auf `OpenQuestion` (PlanQuestion +
  // optionale Enrichment-Felder context/pros/cons/recommendation/evidence).
  // Backward-compat: PlanQuestion ohne Extras IST eine valide OpenQuestion.
  // Wird benutzt damit `enriched`-Updates die Extra-Felder in den State legen
  // können, ohne dass die Pill-Karte ihre Identität wechselt.
  const [openQuestions, setOpenQuestions] = useState<OpenQuestion[]>([]);
  const [qAnswers, setQAnswers] = useState<Record<string, string>>({});
  const [qIndex, setQIndex] = useState(0);
  const [pillExpanded, setPillExpanded] = useState(false);
  // Signatur des zuletzt in die Pill geladenen Fragen-Sets — verhindert
  // Re-Load (und damit Answer-Reset) bei jedem Re-Render desselben Turns.
  const lastQSignatureRef = useRef<string | null>(null);
  // Stabiler Ref auf qAnswers für den submit-Handler (kein Closure-Stale).
  const qAnswersRef = useRef(qAnswers);
  useEffect(() => {
    qAnswersRef.current = qAnswers;
  }, [qAnswers]);

  // Bug-5-Fix (2026-05-30): IDs der aktuell in der Pille gepinnten Fragen.
  // Wird an AssistantItem gereicht, damit der inline-Surface-/Markdown-Zwilling
  // derselben Frage in der Bubble unterdrückt wird (Frage erscheint sonst 3×:
  // Bubble-Markdown + inline-Surface + Pille). Stabil per Set, neu nur wenn sich
  // die Fragen-IDs ändern.
  const pinnedQuestionIds = useMemo(
    () => new Set(openQuestions.map((q) => q.id)),
    [openQuestions],
  );

  // Pill-State sauber zurücksetzen (nach finalem Submit oder Hard-Reset).
  // lastQSignatureRef behält die zuletzt geladene Signatur, damit derselbe
  // Turn nach dem Schließen nicht sofort wieder aufpoppt.
  const resetPillState = useCallback(() => {
    setOpenQuestions([]);
    setQAnswers({});
    setQIndex(0);
    setPillExpanded(false);
  }, []);

  // Phase RL.3 (2026-04-28): Polling-Fallback falls SSE den completed-Event
  // verpasst (z.B. PWA-Tab-Wechsel hat SSE-Subscription unterbrochen).
  // Refetch /api/chat/history alle 10s solange serverStreamPending=true.
  // Stop nach 10min Maximum (sonst Endlos-Polling bei stuck stream).
  // Ist ausserhalb der useEffect inline definiert weil cleanup-pattern.

  // ---- STT ------------------------------------------------------------
  // inputRef hält den aktuellen Input-Wert, damit der onFinal-Callback
  // Replace-vs-Append korrekt entscheidet, ohne die Stabilität des
  // Hooks zu brechen.
  const inputRefForStt = useRef(input);
  useEffect(() => {
    inputRefForStt.current = input;
  }, [input]);

  const handleSttFinal = useCallback((spoken: string) => {
    const clean = spoken.trim();
    if (clean.length === 0) return;
    const current = inputRefForStt.current;
    if (current.trim().length === 0) {
      setInput(clean);
    } else {
      const sep = current.endsWith(' ') ? '' : ' ';
      setInput(current + sep + clean);
    }
  }, []);

  // STT Dual-Path: Web-Speech-API (Safari-Tab, Chrome) wenn verfügbar,
  // sonst MediaRecorder + Server-Whisper (iOS-PWA, Firefox, Fallback).
  const ws = useSpeechRecognition({ lang: 'de-DE', onFinal: handleSttFinal });
  const mr = useMediaRecorderStt({ lang: 'de', onFinal: handleSttFinal });

  const useWebSpeech = ws.isSupported;
  const sttSupported = useWebSpeech ? ws.isSupported : mr.isSupported;
  const sttListening = useWebSpeech ? ws.isListening : mr.isListening;
  const sttInterim: string = useWebSpeech ? ws.interimText : mr.interimText;
  const sttError = useWebSpeech ? ws.error : mr.error;

  const toggleStt = useCallback(() => {
    // Wichtig: NICHT early-return wenn unsupported — der User hat geklickt,
    // er verdient eine sichtbare Reaktion (Error-State im Hook triggert Banner).
    // Web-Speech-Path: wenn tauglich, nehme ihn. Sonst immer MediaRecorder-Path
    // versuchen — MR geht praktisch überall wo getUserMedia geht (auch iOS-PWA).
    if (useWebSpeech && ws.isSupported) {
      if (ws.isListening) ws.stop();
      else ws.start();
      return;
    }
    if (mr.isListening) mr.stop();
    else mr.start();
  }, [useWebSpeech, ws, mr]);

  const nextId = useCallback(
    (role: HistoryItem['role']) => {
      idCounter.current += 1;
      return `${baseId}-${role}-${idCounter.current}`;
    },
    [baseId],
  );

  // ---- Track-D · Stream-B2 · Flow-Studio Stil-Wahl-Verdrahtung -------------
  // `/flow <intent>` → die compose-and-run-Route antwortet bei Medien-Schritten
  // (Hero-Video etc.) mit status 'needs-style-choice' + 1 quickchoice-Prompt je
  // Schritt. Hier: (1) die quickchoice-Surface(s) als Assistant-Messages
  // emittieren (laufen durch den surface-aware Renderer → renderQuickChoice),
  // (2) auf den Owner-Klick (window-Event 'lazyos:quickchoice' { id }) hören,
  // (3) die id ihrer offenen Frage zuordnen (gebündelt: alle Fragen werden
  //     gleichzeitig gezeigt, jede Wahl gesammelt), (4) sobald ALLE Fragen
  //     beantwortet → `/api/flow/compose-and-run` MIT styleChoices RE-POSTen
  //     (keyed auf String(step.idx)) → Folge-Status (running / needs-coupling /
  //     erneut needs-style-choice) wieder durch handleFlowComposeResult.
  //
  // Korrelation id→Frage: der quickchoice-Renderer feuert NUR { id } (keinen
  // step-Kontext). Wir nehmen den ERSTEN noch-offenen Prompt, dessen optionIds
  // die geklickte id enthält — deterministisch in Anzeige-Reihenfolge. Bei
  // identischen Option-Mengen (z.B. zwei Video-Steps) ordnet der Owner sie der
  // Reihe nach zu (fail-soft, kein hartes Eindeutigkeits-Constraint).
  const flowStyleSessionsRef = useRef<FlowStyleSession[]>([]);

  // Re-POST mit den gesammelten Stil-Wahlen, Folge-Status erneut übersetzen.
  const repostFlowWithStyleChoices = useCallback(
    async (session: FlowStyleSession) => {
      const doFetch =
        typeof window !== 'undefined' ? window.fetch.bind(window) : fetch;
      const postAssistant = (content: string) => {
        const item: HistoryItem = {
          id: nextId('assistant'),
          role: 'assistant',
          content,
          ts: new Date().toISOString(),
        };
        setHistory((h) => [...h, item]);
      };
      const pushToast = (
        title: string,
        bodyText: string,
        variant: 'warn' | 'err',
      ) => {
        const sysItem: SystemItem = {
          id: `sys-flow-style-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          role: 'system',
          kind: 'slash-flow',
          content:
            '<surface:toast>' +
            JSON.stringify({
              variant: variant === 'err' ? 'default' : 'warn',
              title,
              body: bodyText,
              iconGlyph: variant === 'err' ? '×' : '!',
            }) +
            '</surface:toast>',
          severity: variant === 'err' ? 'critical' : 'warn',
          ts: new Date().toISOString(),
        };
        setSystemMessages((prev) => {
          const next = [...prev, sysItem];
          return next.length > 30 ? next.slice(-30) : next;
        });
      };

      let body: unknown = null;
      try {
        const res = await doFetch('/api/flow/compose-and-run', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({
            intent: session.intent,
            workspaceId: session.workspaceId,
            styleChoices: session.choices,
          }),
        });
        if (!res.ok) {
          const detail =
            res.status === 401
              ? 'Nicht eingeloggt — bitte anmelden und erneut versuchen.'
              : `HTTP ${res.status}`;
          pushToast('Flow fehlgeschlagen', detail, 'err');
          return;
        }
        body = await res.json().catch(() => null);
      } catch (err) {
        pushToast(
          'Flow fehlgeschlagen',
          `Verbindung fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`,
          'err',
        );
        return;
      }

      handleFlowComposeResult(body as Parameters<typeof handleFlowComposeResult>[0], {
        intent: session.intent,
        workspaceId: session.workspaceId,
        onRunning: () => postAssistant('Flow gestartet — der Graph erscheint gleich.'),
        onCoupling: (markup) => postAssistant(markup),
        // Falls nach der Wahl WEITERE Medien-Schritte offen sind (z.B. der
        // Re-Compose hat sie erst jetzt erkannt): neue Session starten.
        onStyleChoice: (req) => startFlowStyleSessionRef.current?.(req),
        onError: (detail) => pushToast('Flow fehlgeschlagen', detail, 'err'),
      });
    },
    [nextId, setHistory],
  );

  // Stabiler Ref auf den Session-Starter (vermeidet Definitions-Reihenfolge-
  // Zirkel zwischen repost ↔ startFlowStyleSession).
  const startFlowStyleSessionRef = useRef<
    ((req: FlowStyleChoiceRequest) => void) | null
  >(null);

  const handleFlowStyleChoice = useCallback(
    (req: FlowStyleChoiceRequest) => {
      if (req.prompts.length === 0) return;
      // 1. Eine Session registrieren (offene Prompts + leere Wahlen).
      const session: FlowStyleSession = {
        intent: req.intent,
        workspaceId: req.workspaceId,
        pending: req.prompts.map((p) => ({
          choiceKey: p.choiceKey,
          optionIds: p.optionIds,
        })),
        choices: {},
      };
      flowStyleSessionsRef.current.push(session);

      // 2. Pro Prompt eine quickchoice-Surface als Assistant-Message emittieren
      //    (surface-aware Renderer → renderQuickChoice; Klick feuert reply +
      //    lazyos:quickchoice). Die Surface trägt das exakte Payload-Format aus
      //    media-styles.ts (variant 'quickchoice' + options).
      setHistory((h) => {
        const additions: HistoryItem[] = req.prompts.map((p) => ({
          id: nextId('assistant'),
          role: 'assistant',
          content: `<surface:prompt>${JSON.stringify(p.payload)}</surface:prompt>`,
          ts: new Date().toISOString(),
        }));
        return [...h, ...additions];
      });
    },
    [nextId, setHistory],
  );
  useEffect(() => {
    startFlowStyleSessionRef.current = handleFlowStyleChoice;
  }, [handleFlowStyleChoice]);

  // 3. Globaler Listener: ordnet eine geklickte Option-id ihrer offenen Frage
  //    zu, sammelt die Wahl, RE-POSTet sobald eine Session vollständig ist.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onQuickChoice = (ev: Event) => {
      const id = (ev as CustomEvent<{ id?: string }>).detail?.id;
      if (typeof id !== 'string' || id.length === 0) return;
      const sessions = flowStyleSessionsRef.current;
      // Pure Korrelation (id → offene Frage; mutiert die getroffene Session).
      const { completedSession, sessionIndex } = correlateQuickChoice(
        sessions,
        id,
      );
      // Session vollständig → re-post + aus der aktiven Liste entfernen.
      if (completedSession && sessionIndex >= 0) {
        sessions.splice(sessionIndex, 1);
        void repostFlowWithStyleChoices(completedSession);
      }
    };
    window.addEventListener('lazyos:quickchoice', onQuickChoice as EventListener);
    return () =>
      window.removeEventListener(
        'lazyos:quickchoice',
        onQuickChoice as EventListener,
      );
  }, [repostFlowWithStyleChoices]);

  // ---- Bild-Generierung: fertiges Bild persistieren (2026-06-03) ----------
  // Die ImageGenCard (Surface) dispatcht bei Erfolg `lazyos:image-gen-done`
  // {token, surfaceMarkup}. Wir ersetzen die <surface:image-gen>-Lade-Karte
  // (gematcht über den eindeutigen token im Content) durch die finale
  // <surface:document>-Bild-Bubble → bei Reload zeigt der Verlauf das echte
  // Bild (kein Re-Gen). Persistiert über writeHistoryFor.
  useEffect(() => {
    const onImageDone = (e: Event): void => {
      const detail = (e as CustomEvent).detail as
        | { token?: string; surfaceMarkup?: string }
        | undefined;
      if (!detail?.token || !detail.surfaceMarkup) return;
      const needle = `"token":"${detail.token}"`;
      setHistory((h) => {
        let changed = false;
        const next = h.map((it) => {
          if (
            it.role === 'assistant' &&
            typeof it.content === 'string' &&
            it.content.includes('surface:image-gen') &&
            it.content.includes(needle)
          ) {
            changed = true;
            return { ...it, content: detail.surfaceMarkup! };
          }
          return it;
        });
        if (changed) writeHistoryFor(currentWorkspace.id, next);
        return changed ? next : h;
      });
    };
    window.addEventListener('lazyos:image-gen-done', onImageDone as EventListener);
    return () =>
      window.removeEventListener('lazyos:image-gen-done', onImageDone as EventListener);
  }, [currentWorkspace.id]);

  // ---- Inline-File-Upload aus dem Composer ---------------------------
  // STAGING-MODELL (Owner-Hard-Requirement 2026-05-26):
  // Eine ausgewählte Datei wird hochgeladen, ABER NICHT sofort gesendet.
  // Sie landet in `stagedAttachments` und wird als fixierte Vorschau ÜBER
  // dem Composer angezeigt (WhatsApp/Telegram-Stil). Der User kann dazu
  // Text tippen; beim Absenden (submit) gehen Datei(en) + Text GEMEINSAM
  // als EINE Message raus (Bubble + Agent-Prompt enthalten beides).
  const cloudUpload = useChatCloudUpload();
  const [stagedAttachments, setStagedAttachments] = useState<StagedAttachment[]>(
    [],
  );
  const stagedAttachmentsRef = useRef<StagedAttachment[]>([]);
  useEffect(() => {
    stagedAttachmentsRef.current = stagedAttachments;
  }, [stagedAttachments]);

  const handleRemoveStaged = useCallback((id: string) => {
    setStagedAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const handleUploadFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      const result = await cloudUpload.upload(files, {
        workspaceId: currentWorkspace.id,
        workspaceLabel: currentWorkspace.label,
      });
      // Erfolgreiche Uploads → ins Staging (NICHT senden).
      if (result.ok.length > 0) {
        setStagedAttachments((prev) => [
          ...prev,
          ...result.ok.map((a) => ({ ...a, workspaceLabel: currentWorkspace.label })),
        ]);
      }
      // Fehlgeschlagene Uploads → Toast im Verlauf (kein Staging).
      if (result.fail.length > 0) {
        const ts = new Date().toISOString();
        const failItems: HistoryItem[] = result.fail.map((f) => ({
          id: nextId('assistant'),
          role: 'assistant',
          content: `<surface:toast>${JSON.stringify({
            variant: 'err',
            title: `Upload fehlgeschlagen: ${f.filename}`,
            body: f.error,
          })}</surface:toast>`,
          ts,
        }));
        setHistory((h) => [...h, ...failItems]);
      }
    },
    [cloudUpload, currentWorkspace.id, currentWorkspace.label, nextId],
  );

  // ---- hydrate from localStorage --------------------------------------
  // Beim ersten Mount:
  //  1) Legacy-Key (ohne Workspace-Suffix) in den aktuellen Workspace
  //     migrieren — nur wenn noch kein per-Workspace-Key existiert.
  //  2) History für currentWorkspace.id laden (instant aus localStorage).
  //  3) Mock-Mode global laden.
  //  4) Phase MS: parallel Server-History fetchen — Server gewinnt.
  useEffect(() => {
    const wsId = currentWorkspace.id;
    let storedHistory: HistoryItem[] | null = null;
    try {
      const legacyRaw = window.localStorage.getItem(STORAGE_HISTORY_LEGACY);
      const perWsRaw = window.localStorage.getItem(historyKeyFor(wsId));
      if (legacyRaw && !perWsRaw) {
        window.localStorage.setItem(historyKeyFor(wsId), legacyRaw);
      }
      if (legacyRaw) {
        window.localStorage.removeItem(STORAGE_HISTORY_LEGACY);
      }

      storedHistory = readHistoryFor(wsId);
      // Mock-Mode ist deprecated — alten Wert proaktiv löschen damit
      // existierende PWAs aus dem Mock-Mode raus kommen, auch wenn der
      // Agent kurzzeitig 503 hatte (z.B. während Deploy).
      window.localStorage.removeItem(STORAGE_MOCK);
    } catch {
      // ignore corrupt storage
    }
    queueMicrotask(() => {
      if (storedHistory) {
        setHistory(storedHistory);
        idCounter.current = storedHistory.length;
      }
      // 2026-05-03: showHistory ist IMMER collapsed beim Mount/Workspace-Switch
      // (User-Wunsch "Verlauf standardmäßig eingeklappt"). Persistierter
      // Wert wird ignoriert — User kann ihn pro Session via Pill aufklappen,
      // aber nach Reload/Switch ist er wieder zu.
      setShowHistory(false);
      setHydrated(true);
    });

    // Phase MS · Server-First-Refresh. Cached-History haengt schon im
    // State (instant), aber wir wollen die Wahrheit aus der DB. Bei
    // Erfolg: Server gewinnt, lokale in-flight-Items bleiben drin.
    // Bei Fehler/Offline: cached bleibt, kein User-facing Error.
    const ctl = new AbortController();
    void loadHistoryServerFirst(wsId, { limit: 60, signal: ctl.signal })
      .then((res) => {
        const localItems = readHistoryFor(wsId) ?? [];

        // Bug-Fix 2026-05-29 (Owner-Live-Test): Workspace-ID-Reuse durch
        // Label-Slug-Kollision konnte alte localStorage-History für einen
        // NEUEN Workspace mit gleichem slug restauriern. Wenn der Server
        // für diesen wsId ein LEERES Resultat liefert (frischer Workspace
        // ohne Chat-Verlauf in der DB), aber localStorage Inhalt hat →
        // localStorage stammt von einer früheren Workspace-Instanz mit
        // gleichem slug → zwingend purgen + State resetten, damit der
        // Owner einen wirklich leeren Chat sieht. (F2-Kollisions-Schutz
        // in der POST-Route verhindert das ab 12a73d8 für NEUE Workspaces,
        // aber dieser Mount-Guard räumt auch existierende Stale-Caches auf.)
        if (res.items.length === 0 && localItems.length > 0) {
          try {
            window.localStorage.removeItem(historyKeyFor(wsId));
            window.localStorage.removeItem(liveKeyFor(wsId));
          } catch {
            /* ignore corrupt storage */
          }
          setHistory([]);
          idCounter.current = 0;
          setServerStreamPending(false);
          return;
        }

        const merged = mergeServerWithLocal(res.items, localItems, res.cutoffMs);
        setHistory(merged);
        idCounter.current = merged.length;
        writeHistoryFor(wsId, merged);

        // Phase RL.3 (2026-04-28): Stream-Pending-Detect. Wenn das LETZTE
        // History-Item eine user-Message ist UND <10 min alt → Server-Stream
        // läuft vermutlich noch. Pending-Indicator anzeigen, Polling starten.
        const last = merged[merged.length - 1];
        if (
          last?.role === 'user' &&
          Date.now() - Date.parse(last.ts) < 10 * 60_000
        ) {
          setServerStreamPending(true);
        } else {
          setServerStreamPending(false);
        }

        // 2026-04-26: Workstream-Aktivitaet vom Server (auto_dispatch,
        // stage-comments, pipeline_complete, synthesis) als SystemItems
        // einspielen. So sieht der User nach Reload die Live-Toasts der
        // letzten N Events historisch im Verlauf, nicht nur live im SSE.
        if (res.systemItems.length > 0) {
          setSystemMessages((prev) => mergeSystemItems(prev, res.systemItems));
        }
      })
      .catch(() => {
        /* offline / 401 / etc — cached bleibt drin */
      });
    return () => ctl.abort();
    // Nur beim ersten Mount; Workspace-Switch läuft im Effect unten.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- workspace switch — isolate history ------------------------------
  // Siehe vorige Doku. Kern: alte History persistieren, neue laden,
  // Stream abortieren, Input leeren. `previousWorkspaceIdRef` verhindert,
  // dass der Persist-Effect beim Switch die frisch geladene Ziel-History
  // mit der alten überschreibt.
  const previousWorkspaceIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!hydrated) return;

    const prevId = previousWorkspaceIdRef.current;
    const nextId = currentWorkspace.id;

    if (prevId === null) {
      previousWorkspaceIdRef.current = nextId;
      return;
    }

    if (prevId === nextId) return;

    writeHistoryFor(prevId, history);
    abortAgent();
    setInput('');
    setSystemMessages([]);
    // Sub-Plan B · 2026-04-29: Beim Workspace-Switch IMMER zurück auf
    // Fokus-Mode. Persistierter Wert bleibt im localStorage liegen
    // (nächster Reload desselben Workspaces respektiert ihn wieder),
    // aber der gerade aktive Switch beginnt im Default.
    setShowHistory(false);
    writeShowHistoryFor(nextId, false);

    queueMicrotask(() => {
      const el = streamRef.current;
      if (el) el.scrollTop = 0;
    });

    const nextHistory = readHistoryFor(nextId);
    setHistory(nextHistory ?? []);
    idCounter.current = nextHistory?.length ?? 0;

    // Bug-3-Fix: Snapshot-Resume auf Workspace-Switch · 2026-05-25.
    // Wenn für den Ziel-Workspace ein laufender LiveSnapshot in localStorage
    // liegt (= Stream war aktiv als User weggeswitcht hat), den Partial-State
    // als in-progress-Indikator sofort anzeigen. Damit ist kein optischer
    // Abriss sichtbar — der User sieht "arbeitet" + bisherigen Text sofort.
    // Kein echtes Reconnect des Streams — der stream-Fetch läuft weiterhin im
    // Hintergrund (er ist an den agent-turn fetch bound, nicht an workspaceId).
    // serverStreamPending triggert den 10s-Polling-Fallback als Sicherheitsnetz.
    const resumeLive = readLiveFor(nextId);
    if (resumeLive) {
      const age = Date.now() - new Date(resumeLive.startedAt).getTime();
      if (age < LIVE_TTL_MS) {
        setServerStreamPending(true);
      } else {
        clearLiveFor(nextId);
      }
    }

    // Phase MS · Server-Refresh nach Workspace-Switch — analog zum Mount-
    // Effect. Cached rendert instant, Server gewinnt sobald die Antwort
    // da ist. AbortController verhindert race-conditions wenn der User
    // schnell nochmal switched.
    const ctl = new AbortController();
    void loadHistoryServerFirst(nextId, { limit: 60, signal: ctl.signal })
      .then((res) => {
        // Schutz: aus dem schnellen Switch-Pfad zurueck; nur anwenden
        // wenn der User immer noch auf nextId steht.
        if (previousWorkspaceIdRef.current !== nextId) return;
        const localItems = readHistoryFor(nextId) ?? [];
        const merged = mergeServerWithLocal(res.items, localItems, res.cutoffMs);
        setHistory(merged);
        idCounter.current = merged.length;
        writeHistoryFor(nextId, merged);

        // 2026-04-26: Workstream-System-Items aus Server fuer den neuen
        // Workspace einspielen. SystemMessages wurden oben geleert.
        if (res.systemItems.length > 0) {
          setSystemMessages(res.systemItems);
        }
      })
      .catch(() => {
        /* offline — cached bleibt */
      });

    // previousWorkspaceIdRef wird absichtlich erst vom Persist-Effect
    // synchronisiert — siehe Doku dort.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentWorkspace.id, hydrated, abortAgent]);

  // ---- persist history (per current workspace) -------------------------
  useEffect(() => {
    if (!hydrated) return;
    if (previousWorkspaceIdRef.current !== currentWorkspace.id) {
      previousWorkspaceIdRef.current = currentWorkspace.id;
      return;
    }
    writeHistoryFor(currentWorkspace.id, history);
  }, [history, hydrated, currentWorkspace.id]);


  // Sub-Plan B · 2026-04-29: showHistory pro Workspace persistieren.
  // Triggert bei jedem Toggle oder Auto-Reset (submit).
  useEffect(() => {
    if (!hydrated) return;
    writeShowHistoryFor(currentWorkspace.id, showHistory);
  }, [showHistory, hydrated, currentWorkspace.id]);

  const isStreaming =
    agentStatus === 'connecting' || agentStatus === 'streaming';

  // ── Slice 2 (2026-05-30, Apple-UX): ActionDeck-Datenquelle ────────────────
  // DB-Projektion (blockingGates/openQuestions/activeFlowRun) via member-auth-
  // gated Route. Poll 5s + Invalidierung sobald der Stream endet (isStreaming
  // ODER serverStreamPending fällt auf false → frischer State direkt nach der
  // Antwort, statt bis zum Poll-Tick zu warten). Ein monoton steigender
  // Zähler ist das Invalidierungs-Signal: er ändert sich genau dann, wenn der
  // Run-Aktiv-Zustand wechselt.
  const runActiveForDeck = isStreaming || serverStreamPending;
  // refreshSignal MUSS monoton steigen (Hook-Doc-Vertrag: „monoton steigender
  // Invalidierungs-Zähler"). Vorher binär 0/1 → ein zweiter Run-aktiv-Wechsel
  // in dieselbe Richtung triggerte kein Re-Fetch (Doku/Code-Drift). Wir zählen
  // jede Flanke (runActive ↔ idle) hoch — jeder Stream-Ende-Übergang löst so
  // verlässlich genau ein frisches Projektions-Fetch aus.
  const deckRefreshSignalRef = useRef(0);
  const prevRunActiveForDeckRef = useRef<boolean | null>(null);
  if (prevRunActiveForDeckRef.current !== runActiveForDeck) {
    prevRunActiveForDeckRef.current = runActiveForDeck;
    deckRefreshSignalRef.current += 1;
  }
  const deckRefreshSignal = deckRefreshSignalRef.current;
  const { state: workspaceState } = useWorkspaceState(currentWorkspace.id, {
    refreshSignal: deckRefreshSignal,
  });
  const pinnedItem = selectPinnedItem(workspaceState);
  // F18 (2026-05-30): die Headline der gepinnten Decision → der
  // PinnedDecisionRegistryProvider stellt die gleichnamige Feed-Karte ruhig
  // (keine zwei lauten Kopien). Null wenn kein Decision-Gate gepinnt.
  const pinnedDecisionSig = pinnedDecisionSignature(pinnedItem);

  // BLOCKER 1 (2026-05-30): sichtbares Feedback, wenn die Deck-Aktion ihre
  // Stream-Card (noch) nicht im DOM findet — statt stillem No-op. Trägt den
  // gate.kind kurz als data-Attribut an der Deck-Region (CSS-Pulse).
  const [deckActionMiss, setDeckActionMiss] = useState<string | null>(null);

  // Gate-Aktion → SINGLE SUBMIT PATH (Critic-Punkt 3). Der Deck delegiert
  // hierher — wie die Pille ihren Submit an ChatShell delegiert —, damit es
  // GENAU EINEN POST-Pfad gibt: den echten Button der Stream-Gate-Card. Der
  // Deck baut NIE einen zweiten fetch; er findet die Card und klickt deren
  // primäre Aktion programmatisch (bzw. fokussiert sie, wenn ein Secret nötig
  // ist). N8: die Card bleibt im Verlauf als Beleg.
  //
  // BLOCKER 1 (Critic, 2026-05-30): die alte Map `surface-${gate.kind}` traf
  // nur live-warn. Für human-decision (Card=surface-decision-brief),
  // credential-request (hatte kein data-test) + connector-call-preview (kein
  // data-test am Body) war es ein stiller No-op — Owner klickt „Entscheiden"/
  // „Zugang eingeben" und NICHTS passiert. Hier korrekt gemappt + sichtbares
  // Feedback statt stillem No-op, wenn das Scroll-Target fehlt.
  const handleGateAction = useCallback((gate: BlockingGateState): void => {
    try {
      // executeGateAction (ActionDeck.tsx) ist der EINE geteilte Aktions-Pfad:
      //   non-secret approve → klickt den echten Button der Stream-Card
      //                        (genau EIN POST; kein zweiter fetch im Deck).
      //   credential (secret) → fokussiert nur den isolierten Card-Input
      //                        (Vault-Regel; Secret landet NIE im Deck).
      //   counter-evidence    → scrollt die Beleg-Card in den Blick.
      //   Card fehlt im DOM    → 'missing' → sichtbares Pulse-Feedback statt
      //                          stillem No-op (BLOCKER 1).
      const outcome = executeGateAction(gate);
      if (outcome === 'missing') {
        setDeckActionMiss(gate.kind);
        window.setTimeout(() => setDeckActionMiss(null), 1600);
      }
    } catch {
      /* fail-soft: DOM nicht verfügbar (SSR) → no-op. */
    }
  }, []);

  // Resume-Aktion → unterbrochenen/pausierten Workstream fortsetzen (Owner-
  // Szenario „Connector-Onboarding heygen unterbrochen", Bug 1 Kontextverlust).
  // Statt eines generischen Klär-Menüs schickt „Fortsetzen" eine EXPLIZITE,
  // kontext-tragende Instruktion über den EINEN Submit-Pfad (submitRef → der
  // normale Agent-Turn mit vollem History-/Workspace-Kontext). Der Server/
  // Connector-Stack (lib/connectors/auto-connect.ts) erkennt daran den Resume
  // und stößt ggf. den Auth-/Onboarding-Surface-Pfad an.
  //
  // SERVER-NAHT (an Coordinator gemeldet): der EIGENTLICHE Onboarding-Resume +
  // das Auth-Surface liegen tiefer im Connector/Server-Stack. Dieser Handler
  // hält nur den Kontext und liefert den richtigen Trigger-Text; der
  // serverseitige disambiguation-/clarify-Pfad muss `activeWorkstreams`/
  // `blockingGates` aus state-projector berücksichtigen, bevor er generisch
  // klärt.
  const handleResume = useCallback(
    (workstreamId: string): void => {
      const item =
        Array.isArray(workspaceState?.activeWorkstreams)
          ? workspaceState!.activeWorkstreams.find(
              (w) => w.workstreamId === workstreamId,
            )
          : undefined;
      const name = item?.name ?? 'den unterbrochenen Vorgang';
      // Explizite, eindeutige Instruktion — KEIN kurzes „?"/„weiter" mehr, das
      // server-seitig generisch geklärt würde. Trägt den Workstream-Namen +
      // die ID als Kontext-Anker.
      const resumeText = `Setze den unterbrochenen Workstream „${name}" (Workstream-ID: ${workstreamId}) fort. Wenn dafür ein Onboarding-/Auth-Schritt offen ist, starte den Verbindungs-/Auth-Prozess.`;
      submitRef.current?.(resumeText);
    },
    [workspaceState],
  );

  // 2026-04-28 Hotfix: serverStreamPending darf den Input NICHT disablen.
  // Es ist ein passiver Indicator "Server arbeitet im Hintergrund weiter",
  // KEIN Submit-Block. Sonst kann User nicht tippen wenn z.B. claude
  // ohne completed-Event abstürzte (serverStreamPending bleibt 10min true).
  const isPending = isMockPending || isStreaming;

  // ---- Bug-2-Fix: Queue-Flush-Effect · 2026-05-25 ----------------------
  // Wenn agentStatus auf 'idle' wechselt UND die Queue nicht leer ist →
  // nächste Message aus der Queue automatisch senden ("fließt in die Lücke").
  // submitRef hält einen stabilen Callback-Ref um circular-deps zu vermeiden.
  const submitRef = useRef<((raw: string) => void) | null>(null);

  // Phase 1 Track AB · Befund B (2026-05-29): Stabiler Ref auf den
  // strukturierten-Antwort-POST (postStructuredAnswers), weil dieser unten
  // im File definiert wird (nach `submit`) und im Submit-Closure trotzdem
  // erreichbar sein muss. Wird per useEffect aktualisiert, sobald
  // postStructuredAnswers sich materialisiert.
  const postStructuredAnswersRef = useRef<
    | ((
        qs: ReadonlyArray<OpenQuestion>,
        answers: Record<string, string>,
        sourceTurnId: string,
      ) => void)
    | null
  >(null);

  // C2-Fix: Inflight-Lock. SurfaceAction-Caller (RateLimitRetry-Auto-Retry,
  // Cards via `reply`) rufen submit() ohne isStreaming-Wissen → konkurrierende
  // sendAgent-Calls. Dieser Ref serialisiert den Agent-Pfad: solange ein Turn
  // läuft, wird ein zweiter direkter submit() (nicht-enqueue-Pfad) verworfen.
  const submitInflightRef = useRef(false);

  // M1-Fix: history/agentTurn aus Refs lesen statt aus submit-Closure. Bei
  // SSE-Burst (häufige Re-Renders) wird submit sonst ständig neu erzeugt und
  // der submitRef-Update-Effect rennt gegen das Flush-Microtask. Refs sind
  // immer aktuell und nehmen history/agentTurn aus den submit-deps.
  const historyRef = useRef(history);
  const agentTurnRef = useRef(agentTurn);
  useEffect(() => {
    historyRef.current = history;
  }, [history]);
  useEffect(() => {
    agentTurnRef.current = agentTurn;
  }, [agentTurn]);

  useEffect(() => {
    if (agentStatus !== 'idle') return;
    const next = messageQueueRef.current.shift();
    if (!next) return;
    setQueueLength(messageQueueRef.current.length);
    // Kleines Microtask-Delay damit der State nach dem Stream-Ende vollständig
    // settled ist bevor wir den nächsten Turn einleiten.
    queueMicrotask(() => {
      submitRef.current?.(next);
    });
  }, [agentStatus]);

  // ---- UX-1: Open-Questions-Detection · 2026-05-26 ---------------------
  // ---- Workstream 4b: ask-but-proceed-Pinning · 2026-05-27 ------------
  // Wenn IRGENDEIN Assistant-Turn offene Fragen emittiert, ziehen wir sie in
  // die gepinnte Pill ÜBER dem Composer und klappen sie auf. Die Signatur
  // (Fragen-IDs joined) verhindert, dass derselbe Turn bei jedem Re-Render
  // erneut geladen wird (was die schon gegebenen Antworten resetten würde).
  //
  // FIX (Owner-Symptom „Frage scrollt weg"):
  //  1. Quelle = BEIDE: `<surface:open-questions>`-Tag UND `## Offene Fragen`-
  //     Markdown (vorher NUR Markdown → Surface-Fragen pinnten nie).
  //  2. Scan über die GANZE History (jüngstes Frage-Set gewinnt) PLUS den
  //     laufenden `agentTurn.text` — damit eine mitten im ask-but-proceed-Run
  //     emittierte Frage SOFORT unten erscheint, statt erst nach Stream-Ende.
  //  3. Läuft AUCH während `isStreaming` (kein early-return mehr) — parallel
  //     gearbeitet ⇒ Frage bleibt trotzdem gepinnt + beantwortbar.
  // Geclearet wird NICHT hier (kein Step-/Wellen-Clear) — nur im Answer-Pfad
  // (resetPillState) bzw. bei Workstream-Terminal (eigener Effect unten).
  useEffect(() => {
    // History-Items (jüngstes Assistant-Item mit Fragen gewinnt).
    // `collectOpenQuestionsFromHistory` ruft intern bereits
    // `mergeQuestionEnrichmentsById` auf — Doppel-Emissions desselben
    // Assistant-Items mit gleicher ID landen schon hier als EINE Karte.
    let collected: OpenQuestion[] = collectOpenQuestionsFromHistory(history);
    // … und der noch laufende Turn (während Streaming noch nicht in history).
    // Der Live-Turn ist „jünger" als jedes history-Item → hat Vorrang.
    if (typeof agentTurn.text === 'string' && agentTurn.text.length > 0) {
      const liveQs = extractOpenQuestionsFromContent(agentTurn.text);
      if (liveQs.length > 0) {
        // W1 (2026-05-28): EXPLIZIT durch den Merger — `extract` selbst tut das
        // nicht (zwei `<surface:open-questions>`-Tags im SELBEN Live-Turn mit
        // gleicher ID würden sonst zwei Einträge erzeugen, statt die zweite
        // Emission als Anreicherung auf die erste zu legen — Owner-Befund
        // „Empfehlung … etwas doppelt und ggf. redundant").
        collected = mergeQuestionEnrichmentsById(liveQs);
      }
    }
    if (collected.length === 0) return;

    // MAJOR 3a (2026-05-26): Duplikat-Fragetexte → kollidierende Hash-IDs.
    // Markdown-Fragen tragen `id = hashString(text)`; zwei textgleiche offene
    // Fragen bekommen so dieselbe ID. Folge wären: `allAnswered` fälschlich
    // true nach EINER Antwort, doppelte Antwort im reply, und der Options-Klick
    // springt immer auf die erste Bubble zurück (Navigations-Stuck). Surface-
    // Fragen haben i.d.R. stabile eigene IDs; dedupeQuestionIds ist idempotent.
    const uniqueQuestions = dedupeQuestionIds(collected) as OpenQuestion[];

    // MINOR 4a (2026-05-26): Signatur NUR aus den (dedupten) Fragen-IDs —
    // stabil über Re-Hydrate (PWA-Tab-Wechsel ändert Item-IDs, nicht Frage-IDs).
    const signature = uniqueQuestions.map((q) => q.id).join('|');
    if (signature === lastQSignatureRef.current) {
      // W2 (2026-05-28): Gleiche Signatur — KEIN voller Re-Load (würde die
      // gegebenen Antworten resetten und Pill-Expand-State stören). ABER: wenn
      // eine spätere Emission das gleiche Set MIT Enrichment-Feldern nachreicht
      // (context/pros/cons/recommendation/evidence/askedAt), wollen wir die
      // bestehenden Karten IN PLACE anreichern — das ist genau die Owner-Spec
      // „statt zweiter Surface die EINE bestehende Karte ergänzen".
      // Mergt den Vorhang-State mit den neuen Feldern; wenn sich nichts geändert
      // hat, ist `merged` referentiell identisch (kein Re-Render).
      setOpenQuestions((prev) => {
        if (prev.length === 0) return prev;
        const merged = mergeQuestionEnrichmentsById([...prev, ...uniqueQuestions]);
        // Cheap-Compare: ID-Reihenfolge UND Enrichment-Felder. Wenn nichts neu
        // ist, geben wir `prev` zurück (React bail-out, keine Re-Renders).
        let same = merged.length === prev.length;
        if (same) {
          for (let i = 0; i < prev.length; i += 1) {
            const p = prev[i]!;
            const m = merged[i]!;
            if (
              p.id !== m.id ||
              p.context !== m.context ||
              p.recommendation !== m.recommendation ||
              p.askedAt !== m.askedAt ||
              !arrEq(p.pros, m.pros) ||
              !arrEq(p.cons, m.cons) ||
              !arrEq(p.evidence, m.evidence)
            ) {
              same = false;
              break;
            }
          }
        }
        return same ? prev : merged;
      });
      return;
    }
    lastQSignatureRef.current = signature;

    setOpenQuestions(uniqueQuestions);
    setQAnswers({});
    setQIndex(0);
    setPillExpanded(true);
  }, [history, agentTurn.text]);

  // ---- W3 (2026-05-28): periodischer Stale-/Resolve-Scan -----------------
  // OWNER-SYMPTOM (verbatim, 2026-05-28): „Im PA Chat ist immer noch Offene
  // Fragen, obwohl die schon unfassbar alt sind und schon lange beantwortet."
  //
  // Wir scannen die aktuell gepinnten Fragen gegen die History mit dem reinen
  // `detectResolvedAndStaleQuestions`-Helper (lexical-Match einer USER-Reply +
  // 24h-Alters-Verfall + ≥20 Turns danach). Wenn er IDs zurückgibt, ziehen wir
  // sie aus dem Pill-State und passen die Signatur an die Restliste an.
  //
  // Trigger: jeder History-Update (deps: history.length). Wenn der User auf
  // eine alte Frage antwortet, ist die Antwort im nächsten Tick als history-
  // Item da → Scan greift und räumt die Frage weg. Kein Polling-Timer (Cost-
  // /Battery-frei).
  //
  // Persistenz-Note: dieser Scan ist REIN UI — wir ändern keine events-Rows.
  // Beim Reload re-derived der Population-Effect die Pill aus der unveränderten
  // assistant-message; danach räumt DIESER Scan sie wieder weg. Das ist der
  // honest path bis ein Worker die `markStaleOpenQuestionsResolved`-Maintenance
  // serverseitig fährt (eigener Slice).
  useEffect(() => {
    if (openQuestions.length === 0) return;
    // History → minimal-Shape (OpenQuestionsSourceItem) für den puren Helper.
    const source: OpenQuestionsSourceItem[] = history.map((h) => ({
      role: h.role,
      content: h.content,
    }));
    const toRemove = detectResolvedAndStaleQuestions(openQuestions, source);
    if (toRemove.length === 0) return;
    const removeSet = new Set(toRemove);
    setOpenQuestions((prev) => {
      const remaining = prev.filter((q) => !removeSet.has(q.id));
      if (remaining.length === prev.length) return prev;
      // Signatur muss an die verkürzte Liste angepasst werden, damit die
      // bestehende Signatur-Guard im Population-Effect nicht das Re-Load der
      // ECHTEN aktuellen Frage blockiert.
      lastQSignatureRef.current =
        remaining.length === 0 ? null : remaining.map((q) => q.id).join('|');
      return remaining;
    });
  }, [history, openQuestions]);

  // ---- Workstream 4b: Terminal-Clear (NICHT Step-Done-Clear) · 2026-05-27 --
  // Die gepinnte Frage wird NUR weggeräumt, wenn der GANZE Run terminal ist —
  // also: nicht mehr streaming (`!isStreaming`), kein Server-Stream mehr pending
  // (`!serverStreamPending`) UND die Frage taucht NIRGENDS mehr in der
  // Konversation auf (weder als Surface-Tag noch als Markdown-Section). Das ist
  // der Fall „Run gelaufen + abgeschlossen, ohne dass die Frage noch relevant
  // ist" (done/failed/cancelled, Frage obsolet).
  //
  // ABGRENZUNG zum Bug: Ein einzelnes Step-/Wellen-Ende clearet NICHT — denn im
  // ask-but-proceed-Modus bleibt der Run aktiv (`isStreaming`/`serverStreamPending`
  // true) ODER die Frage bleibt im jüngsten Content (collected.length>0). Beides
  // hält den Guard hier geschlossen → die Frage bleibt gepinnt + beantwortbar.
  //
  // Sobald der User bereits eine Antwort begonnen hat (qAnswers nicht leer),
  // räumen wir NICHT auf — der Antwort-Flow (resetPillState) übernimmt das.
  useEffect(() => {
    if (openQuestions.length === 0) return;
    if (isStreaming || serverStreamPending) return; // Run noch aktiv → halten.
    if (Object.keys(qAnswers).length > 0) return; // User antwortet gerade.
    // Steht die Frage noch irgendwo? Dann ist sie NICHT obsolet → halten.
    const stillPresent = collectOpenQuestionsFromHistory(history);
    if (stillPresent.length > 0) return;
    // Run terminal + Frage nirgends mehr → weg. Signatur-Ref freigeben, damit
    // ein neuer Run mit (zufällig) gleicher Signatur wieder pinnen kann.
    lastQSignatureRef.current = null;
    resetPillState();
  }, [
    openQuestions.length,
    isStreaming,
    serverStreamPending,
    qAnswers,
    history,
    resetPillState,
  ]);

  // ---- Phase 1 Track AB · Befund B (2026-05-29): Strukturierte-Antwort-Hydration
  //
  // Owner-Akzeptanz: „Re-Render nach Reload zeigt beantwortete Frage korrekt."
  //
  // Wenn die Pill für einen Workspace eine Open-Question lädt, checken wir
  // parallel `/api/chat/answer?wsId=&qid=` ob diese Frage schon strukturiert
  // beantwortet wurde (Migration 0117 `question_answers`). Wenn ja → räumen
  // wir sie aus dem Pill-State, weil sie de-facto „beantwortet" ist.
  //
  // Fail-soft: jeder Fehler (Network/401/500) ist ein no-op (die Frage
  // bleibt offen, der User kann sie ein zweites Mal beantworten — idempotent
  // im strukturierten Speicher via UNIQUE-content_hash).
  //
  // KEIN Polling, KEIN dauerhafter Listener: einmaliger Pass pro
  // Fragenset-Signatur (lastQSignatureRef), abortable beim Re-Render.
  const lastHydrationSigRef = useRef<string | null>(null);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (openQuestions.length === 0) return;
    const sig = openQuestions.map((q) => q.id).join('|');
    // Nur EINMAL pro Set-Signatur prüfen (sonst feuert es bei jedem History-
    // Tick erneut). Reset passiert automatisch wenn das Set sich ändert.
    if (lastHydrationSigRef.current === sig) return;
    lastHydrationSigRef.current = sig;

    const wsId = currentWorkspace.id;
    const controller = new AbortController();
    const answered: string[] = [];
    (async () => {
      // Pro Frage einen GET — parallel via Promise.all. Bei einer großen Pill
      // (4-5 Fragen typisch) ist das ein vernachlässigbarer Round-Trip-Cost.
      try {
        const results = await Promise.all(
          openQuestions.map(async (q) => {
            try {
              const res = await fetch(
                `/api/chat/answer?wsId=${encodeURIComponent(wsId)}&qid=${encodeURIComponent(q.id)}`,
                {
                  method: 'GET',
                  credentials: 'same-origin',
                  signal: controller.signal,
                },
              );
              if (!res.ok) return { id: q.id, answered: false };
              const body = (await res.json()) as { answered?: boolean };
              return { id: q.id, answered: Boolean(body?.answered) };
            } catch {
              return { id: q.id, answered: false };
            }
          }),
        );
        for (const r of results) if (r.answered) answered.push(r.id);
      } catch {
        /* fail-soft */
      }
      if (controller.signal.aborted) return;
      if (answered.length === 0) return;
      const removeSet = new Set(answered);
      setOpenQuestions((prev) => {
        const remaining = prev.filter((q) => !removeSet.has(q.id));
        if (remaining.length === prev.length) return prev;
        lastQSignatureRef.current =
          remaining.length === 0 ? null : remaining.map((q) => q.id).join('|');
        return remaining;
      });
    })();
    return () => {
      controller.abort();
    };
  }, [openQuestions, currentWorkspace.id]);

  // Phase RL.3: Polling-Fallback. Solange serverStreamPending=true,
  // alle 10s die History nachladen — falls die SSE-Subscription
  // unterbrochen war (PWA-Tab-Background, etc.) und ein
  // chat_message_completed-Event darum verpasst wurde.
  useEffect(() => {
    if (!serverStreamPending) return;
    if (!hydrated) return;
    const wsId = currentWorkspace.id;
    let cancelled = false;
    const startedAt = Date.now();
    const tick = async (): Promise<void> => {
      if (cancelled) return;
      // Hard-Stop nach 10min Polling.
      if (Date.now() - startedAt > 10 * 60_000) {
        if (!cancelled) setServerStreamPending(false);
        return;
      }
      try {
        const res = await loadHistoryServerFirst(wsId, { limit: 60 });
        if (cancelled) return;
        const localItems = readHistoryFor(wsId) ?? [];
        const merged = mergeServerWithLocal(res.items, localItems, res.cutoffMs);
        const last = merged[merged.length - 1];
        // Wenn jetzt eine assistant-Message als letztes Item da ist,
        // ist der Stream durch.
        if (last?.role === 'assistant') {
          setHistory(merged);
          writeHistoryFor(wsId, merged);
          setServerStreamPending(false);
          return;
        }
      } catch {
        /* offline / 401 — naechster Tick versucht es nochmal */
      }
      window.setTimeout(() => void tick(), 10_000);
    };
    const t = window.setTimeout(() => void tick(), 10_000);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [serverStreamPending, hydrated, currentWorkspace.id]);

  // ---- auto-scroll · konservativ 2026-04-27 ----------------------------
  // User-Beschwerde: "Cards springen sodass ich nicht klicken kann".
  // 30px-Threshold + 5s Cooldown nach Klick/Hover + nie wenn ein Element
  // im Stream Focus hat. Statt Sprung: Pfeil-Button.
  const nearBottomRef = useRef(true);
  const lastInteractionRef = useRef(0);
  const [showScrollDown, setShowScrollDown] = useState(false);

  // Sub-Plan 01 (2026-04-29 v3): Multi-Strategy Auto-Scroll-Bottom.
  // Vorherige Versuche (scrollTop = scrollHeight im useLayoutEffect)
  // haben nicht zuverlässig gegriffen — vermutlich weil DOM beim ersten
  // Paint noch keine echte Höhe hatte.
  //
  // Jetzt: scrollIntoView auf einem End-Marker + 4 Triggers:
  //   1. on-mount + Workspace-Switch (useLayoutEffect)
  //   2. nach jedem History-Update (useEffect mit history-deps)
  //   3. setTimeout(0) nach mount für „post-paint"-Scroll
  //   4. setTimeout(150) nach mount für „after-images-loaded"-Scroll
  const scrollToBottomNow = useCallback((opts?: { smooth?: boolean }) => {
    const end = streamEndRef.current;
    if (end) {
      end.scrollIntoView({
        block: 'end',
        behavior: opts?.smooth ? 'smooth' : 'instant' as ScrollBehavior,
      });
      return;
    }
    const el = streamRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  useLayoutEffect(() => {
    scrollToBottomNow();
    nearBottomRef.current = true;
    setShowScrollDown(false);
    // Doppelter Sicherheitsgurt: nach Layout + nach Image-Load
    const t1 = window.setTimeout(() => scrollToBottomNow(), 0);
    const t2 = window.setTimeout(() => scrollToBottomNow(), 150);
    const t3 = window.setTimeout(() => scrollToBottomNow(), 600);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      window.clearTimeout(t3);
    };
  }, [currentWorkspace.id, scrollToBottomNow]);

  useEffect(() => {
    const el = streamRef.current;
    if (!el) return;
    const NEAR_BOTTOM_PX = 30;
    const update = (): void => {
      const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
      const near = dist <= NEAR_BOTTOM_PX;
      nearBottomRef.current = near;
      setShowScrollDown((prev) => (near ? false : prev));
    };
    const markInteraction = (): void => {
      lastInteractionRef.current = Date.now();
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    el.addEventListener('pointerdown', markInteraction, { passive: true });
    el.addEventListener('mouseenter', markInteraction, { passive: true });
    el.addEventListener('focusin', markInteraction);
    const cleanup = (): void => {
      el.removeEventListener('scroll', update);
      el.removeEventListener('pointerdown', markInteraction);
      el.removeEventListener('mouseenter', markInteraction);
      el.removeEventListener('focusin', markInteraction);
    };
    return cleanup;
  }, []);

  // 2026-05-03 (Bug 2): nur scrollen wenn WIRKLICH neue Items am Ende
  // angefuegt wurden — NICHT wenn eine bestehende Surface-Card eine
  // neue Status-Payload bekommt (gleiche id, neuer JSON-Content).
  // Vorher feuerte der Effect bei jedem Surface-Card-Update und hat den
  // Scroll-Container mitten im Lesen weggerissen. Wir tracken jetzt eine
  // Signatur (length + lastId) und scrollen nur, wenn die sich aendert.
  const lastScrollSigRef = useRef<{ len: number; lastId: string | null }>({
    len: 0,
    lastId: null,
  });

  useEffect(() => {
    const el = streamRef.current;
    if (!el) return;
    // Sub-Plan 01 (2026-04-29 verstärkt): doppelter rAF damit der DOM
    // garantiert die neuen Messages gerendert hat bevor wir scrollHeight
    // lesen. Sonst race: history-Update triggert effect bevor neue Items
    // gemounted sind, scrollTop wird auf alten scrollHeight gesetzt.
    //
    // Bug 2 Fix (2026-05-03): Compute Signatur ueber ALLE im Stream
    // sichtbaren Items (history non-archived + systemMessages). Wenn die
    // Signatur identisch zur letzten ist → NICHT scrollen, weil das
    // bedeutet: nur eine bestehende Card wurde re-rendered (Status-Update,
    // neue Payload). Nur bei echtem Append (length wuchs ODER letzte ID
    // aenderte sich) folgen wir mit.
    const visible = history.filter((it) => !it.archived);
    const totalLen = visible.length + systemMessages.length;
    const tail =
      systemMessages.length > 0
        ? systemMessages[systemMessages.length - 1].id
        : visible.length > 0
          ? visible[visible.length - 1].id
          : null;
    const lastSig = lastScrollSigRef.current;
    const isNewAppend = totalLen > lastSig.len || tail !== lastSig.lastId;
    lastScrollSigRef.current = { len: totalLen, lastId: tail };
    // Streaming-Token-Stream: agentTurn.text waechst kontinuierlich, ohne
    // dass eine neue HistoryItem-Bubble entsteht. Damit der Live-Feed
    // smooth folgt, scrollen wir auch wenn isStreaming UND pinned.
    const isLiveStreamGrowth = isPending || agentTurn.text.length > 0;
    if (!isNewAppend && !isLiveStreamGrowth) return;

    const apply = (): void => {
      const focused = typeof document !== 'undefined' ? document.activeElement : null;
      const focusInStream = focused && el.contains(focused);
      // Lockerere Bedingung: wenn near-bottom UND nicht Stream-fokussiert,
      // scroll. Idle-Check entfernt — user klickt eh selten in den Stream
      // direkt.
      if (nearBottomRef.current && !focusInStream) {
        el.scrollTop = el.scrollHeight;
        setShowScrollDown(false);
      } else if (!nearBottomRef.current && isNewAppend) {
        // Nur „neue Item — bitte scrollen"-Pfeil zeigen wenn echtes
        // Append, nicht bei jedem Token-Tick.
        setShowScrollDown(true);
      }
    };
    if (typeof requestAnimationFrame !== 'undefined') {
      requestAnimationFrame(() => requestAnimationFrame(apply));
    } else {
      apply();
    }
  }, [history, agentTurn, isPending, systemMessages]);

  const scrollToBottom = useCallback(() => {
    const el = streamRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    setShowScrollDown(false);
  }, []);

  // Abort any in-flight stream when unmounting.
  useEffect(() => {
    return () => {
      abortAgent();
    };
  }, [abortAgent]);

  // ---- Live-State persistieren waehrend Stream laeuft -----------------
  // Wenn Max die PWA schliesst mid-stream, war frueher der ganze Tool-
  // Call-Verlauf + partial-Antwort weg. Wir snapshotten das alle ~600ms
  // in localStorage und rehydraten beim Mount als finale-Message in
  // der History (Stream selbst ist nach close natuerlich tot).
  const liveStartRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isStreaming) return;
    if (!liveStartRef.current) liveStartRef.current = new Date().toISOString();
    const snapshot = (): void => {
      if (!hydrated) return;
      writeLiveFor(currentWorkspace.id, {
        startedAt: liveStartRef.current ?? new Date().toISOString(),
        text: agentTurn.text,
        tools: agentTurn.tools,
      });
    };
    snapshot();
    const tick = window.setInterval(snapshot, 600);
    return () => {
      window.clearInterval(tick);
    };
  }, [isStreaming, agentTurn, hydrated, currentWorkspace.id]);

  // Wenn Stream sauber endet → live state wegwerfen (history hat es)
  useEffect(() => {
    if (!hydrated) return;
    if (agentStatus === 'idle' && !isStreaming) {
      liveStartRef.current = null;
      clearLiveFor(currentWorkspace.id);
    }
  }, [agentStatus, isStreaming, hydrated, currentWorkspace.id]);

  // Welle 1 · 2026-05-03 · active-workstream-broadcast
  // ----------------------------------------------------------------------
  // BackgroundActivityIndicator soll den eigenen aktiven Stream nicht
  // mitzaehlen — sonst sieht der User in der TopNav den Pulse-Pill und
  // hier in der Bubble den Phase-Text → 2× "läuft". Wir broadcasten via
  // Custom-Event, der TopNav-Indicator hoert mit + filtert via Query-Param.
  // Bei isStreaming-Start: workstreamId (oder null fuer Root-Chat).
  // Bei isStreaming-Ende: null → re-include alles.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const detail = {
      workstreamId: isStreaming ? agentTurn.workstreamId ?? null : null,
    };
    window.dispatchEvent(
      new CustomEvent('lazyos:active-workstream-changed', { detail }),
    );
  }, [isStreaming, agentTurn.workstreamId]);

  // ---- Live-State recovery on mount -----------------------------------
  // Beim ersten Hydrate (zusammen mit history-load): wenn ein live-state
  // im localStorage liegt der nicht mehr aktiv ist (PWA war zu), als
  // finale Assistant-Message in die History pushen.
  useEffect(() => {
    if (!hydrated) return;
    const live = readLiveFor(currentWorkspace.id);
    if (!live) return;
    // Wenn der user-Prompt der den Stream getriggert hatte schon das
    // letzte history-item ist und kein assistant-reply existiert, hängen
    // wir den live-state als assistant-reply an. Sonst (z.B. live-state
    // aelter als der letzte assistant-reply) ignorieren.
    setHistory((prev) => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1];
      if (last.role !== 'user') return prev;
      const restored: HistoryItem = {
        id: `${baseId}-recovered-${Date.now()}`,
        role: 'assistant',
        content: live.text || '(Stream wurde unterbrochen — Antwort wiederhergestellt)',
        tools: live.tools,
        ts: new Date().toISOString(),
      };
      return [...prev, restored];
    });
    clearLiveFor(currentWorkspace.id);
    // Nur einmal pro Workspace-Hydrate ausloesen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, currentWorkspace.id]);

  // ---- Visibility-Reset: PWA wieder sichtbar → connection-errors clearen ---
  // Wenn Max die App schliesst waehrend der Stream laeuft, brichte der fetch
  // mit "Load failed"/NetworkError/AbortError. Beim Re-Open sieht er den
  // Error-Banner. Wir clearen den Status automatisch wenn er offensichtlich
  // ein connection-Error war (Browser-disconnect, kein Bug).
  useEffect(() => {
    const onVisible = (): void => {
      if (document.hidden) return;
      if (agentStatus !== 'error' || !agentError) return;
      const msg = agentError.toLowerCase();
      const isConnectionLost =
        msg.includes('load failed') ||
        msg.includes('networkerror') ||
        msg.includes('failed to fetch') ||
        msg.includes('abort');
      if (isConnectionLost) resetAgent();
    };
    document.addEventListener('visibilitychange', onVisible);
    // Auch beim Mount einmal pruefen — falls Page direkt im error-state
    // remountet (cached vom SW).
    onVisible();
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [agentStatus, agentError, resetAgent]);

  // ---- Phase MS · Visibility-Heartbeat -------------------------------
  // Pingt /api/chat/visibility alle 15s und bei jedem visibilitychange.
  // Server entscheidet darueber dann ob ein Push beim chat_message_completed
  // raus geht (Push nur wenn KEIN Client visible ist).
  useEffect(() => {
    if (!hydrated) return;
    const wsId = currentWorkspace.id;
    const ping = (visible: boolean): void => {
      void fetch('/api/chat/visibility', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        cache: 'no-store',
        body: JSON.stringify({ wsId, visible }),
      }).catch(() => undefined);
    };

    // Sofort einen Ping mit dem aktuellen Status. Der erste 15s-Tick
    // kommt sonst spaet — User waere bis dahin "unbekannt" fuer Push.
    ping(document.visibilityState === 'visible');

    const interval = window.setInterval(() => {
      ping(document.visibilityState === 'visible');
    }, 15_000);

    const onVisibilityChange = (): void => {
      ping(document.visibilityState === 'visible');
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      // Beim Unmount: dem Server ausdruecklich sagen "ich bin weg".
      // Sonst zaehlt unser letzter visible-Ping noch bis zur TTL nach.
      ping(false);
    };
  }, [hydrated, currentWorkspace.id]);

  // ---- Phase MS · MS.6 Migration --------------------------------------
  // One-shot pro Workspace: localStorage-History als chat_message-Events
  // in die DB importieren, Marker setzen, fertig. Idempotent (server
  // skipped bekannte legacyIds).
  //
  // P1-3: Setzt `migrationDone` auf true wenn Migration durch ist
  // (oder nichts zu migrieren). useEventStream wartet darauf — sonst
  // kommt der Replay-Burst rein waehrend Cache-IDs ≠ ULID-IDs sind.
  useEffect(() => {
    if (!hydrated) return;
    // Workspace-Switch: zuruecksetzen, neu pruefen.
    setMigrationDone(false);
    setMigrationFailed(false);
    const wsId = currentWorkspace.id;
    const markerKey = `lazyos.chat.history.migrated.${wsId}`;
    let markerSet = false;
    try {
      markerSet = window.localStorage.getItem(markerKey) === '1';
    } catch {
      markerSet = true; // bei Storage-Failure NICHT migrieren
    }
    if (markerSet) {
      setMigrationDone(true);
      return;
    }

    const items = readHistoryFor(wsId) ?? [];
    // Auch bei items.length === 0 schicken wir den POST: der Server
    // setzt das chat_history_migrated-Event und antwortet 200, wir
    // setzen den Marker. Sonst pingen wir bei jedem leeren Workspace-
    // Wechsel den Server (Pre-Check ist O(1) per indexed lookup).
    // Aber wir koennen auch ohne Roundtrip auskommen — Server-Event
    // wird beim ersten echten Import angelegt. Optimization: wenn
    // 0 Items, lokalen Marker setzen aber Server ueberspringen.
    if (items.length === 0) {
      try {
        window.localStorage.setItem(markerKey, '1');
      } catch {
        /* ignore */
      }
      setMigrationDone(true);
      return;
    }

    let cancelled = false;
    let retryTimer: number | null = null;
    void fetch(
      `/api/chat/history/${encodeURIComponent(wsId)}/import`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ items }),
      },
    )
      .then(async (res) => {
        if (!res.ok) throw new Error(`status_${res.status}`);
        // B2-fix: Server signalisiert per `alreadyMigrated: true` dass
        // ein chat_history_migrated-Event existiert. Verhalten identisch
        // zum frischen Import — Marker setzen, fertig.
        let alreadyMigrated = false;
        try {
          const body = (await res.json().catch(() => null)) as
            | { alreadyMigrated?: unknown }
            | null;
          alreadyMigrated = body?.alreadyMigrated === true;
        } catch {
          /* ignore */
        }
        if (cancelled) return;
        try {
          window.localStorage.setItem(markerKey, '1');
        } catch {
          /* ignore */
        }
        setMigrationDone(true);
        setMigrationFailed(false);
        // alreadyMigrated wird hier nur fuer Telemetrie/Debug genutzt;
        // der Effect verhaelt sich identisch zum frischen Import.
        void alreadyMigrated;
      })
      .catch(() => {
        if (cancelled) return;
        // B3-fix 2026-04-26: Bei Server-Fail/Offline setzen wir
        // migrationDone NICHT auf true. Sonst feuert useEventStream
        // den Replay-Burst rein WAEHREND lokale items noch unter
        // ihrer client-id (nicht ULID) im State stehen — User-Message
        // wird doppelt gerendert. Stattdessen: migrationFailed=true,
        // UI zeigt dezenten Hinweis, Auto-Retry nach 30s.
        setMigrationFailed(true);
        // Auto-Retry: tick-counter triggert den Effect erneut.
        retryTimer = window.setTimeout(() => {
          if (cancelled) return;
          setMigrationRetryTick((n) => n + 1);
        }, 30_000);
      });

    return () => {
      cancelled = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
    };
  }, [hydrated, currentWorkspace.id, migrationRetryTick]);

  // Kein viewport-Hack mehr - mit interactiveWidget=resizes-content im
  // viewport-meta (app/layout.tsx) shrinkt iOS Safari das Layout-Viewport
  // beim Keyboard-Open automatisch. Unser flex-Layout (main als
  // position:fixed mit dvh) reagiert direkt drauf.

  // ---- live event-stream ----------------------------------------------
  // Events aus /api/events/stream landen als system-messages im Chat.
  // Nicht persistiert (transient, kommen bei Mount neu rein via replay).
  const handleEvent = useCallback((ev: LazyEventLike) => {
    // Phase MS · Realtime-Sync: chat_message_*-Events werden zu
    // HistoryItems gemerged statt zu System-Toasts.
    if (isChatMessageEvent(ev.type)) {
      // Phase RL.3 (2026-04-28): Bei chat_message_completed → Pending-
      // Indicator aus. Bei einem chat_message_sent zurueckkommend kann
      // ebenfalls ein laufender Stream auflaufen → Pending-Indicator EIN.
      if (ev.type === 'chat_message_completed') {
        setServerStreamPending(false);
      } else if (ev.type === 'chat_message_sent') {
        const role = (ev.payload?.role as string) ?? '';
        if (role === 'user') setServerStreamPending(true);
      }
      // Echo-Filter: Wenn das eigene chat_message_sent zurueckkommt,
      // nicht doppelt rendern (lokale History hat es schon).
      const payload = ev.payload ?? {};
      const pendingPromptId =
        typeof payload.pendingPromptId === 'string'
          ? payload.pendingPromptId
          : undefined;
      if (
        ev.type === 'chat_message_sent' &&
        pendingPromptId &&
        ownPendingIdsRef.current.has(pendingPromptId)
      ) {
        // Eigenes Echo — schlucken. Den Pending-Marker NICHT loeschen,
        // weil der Server beim Replay nochmal kommen kann.
        return;
      }

      // event.id (ULID) -> stable HistoryItem.id
      // Loop-Guard: keine eigenen Echo-Events; Dedup gegen vorhandene
      // History (per id) — wenn schon drin, skip.
      // ev wurde im useEventStream als LazyEventLike normalisiert; wir
      // brauchen den vollen LazyEvent. Der Wire-Wert hat alle Felder
      // bereits, wir bauen ihn zur Sicherheit defensiv zusammen.
      const fakeLazyEvent = {
        id: ev.id ?? '',
        createdAt: typeof ev.ts === 'number' ? ev.ts : Date.now(),
        segmentId: ev.workspaceId ?? '',
        entityType: 'chat_message' as const,
        entityId: ev.entityId ?? '',
        eventType: (ev.type ?? '') as
          | 'chat_message_sent'
          | 'chat_message_completed',
        actor: (ev.actor ?? 'system') as 'system' | `user:${string}` | `agent:${string}`,
        payload,
        sensitivity: (ev.sensitivity ?? 'low') as 'low' | 'medium' | 'high',
      };
      const itemRaw = chatMessageEventToHistoryItem(fakeLazyEvent);
      if (!itemRaw) return;
      // Sub-Plan A · 2026-04-29 — Coords aus Content nachziehen damit
      // server-emitted Cards (z.B. iterate-pipeline aus tier-orchestrator)
      // ihre vorigen Wellen verdraengen koennen.
      const item = hydrateWorkstreamCoords(itemRaw);

      setHistory((prev) => {
        // Dedup per HistoryItem.id (= event.id)
        if (prev.some((m) => m.id === item.id)) return prev;
        // Insert chronologically — events kommen meistens am Ende, aber
        // bei replay/ooo koennen sie auch in der Mitte landen.
        const itTs = Date.parse(item.ts);
        const insertIdx = (() => {
          for (let i = prev.length - 1; i >= 0; i -= 1) {
            const candidate = prev[i];
            if (!candidate) continue;
            const cTs = Date.parse(candidate.ts);
            if (Number.isFinite(cTs) && cTs <= itTs) return i + 1;
          }
          return 0;
        })();
        // Replace-Logik nur sinnvoll wenn das neue Item ans Ende kommt
        // (insertIdx === prev.length). Bei mid-insert (replay-ooo) waere
        // die Surface-Card chronologisch aelter als vorhandene Cards —
        // dann darf sie keine spaeteren archivieren.
        let workingPrev = prev;
        let workingItem = item;
        if (insertIdx === prev.length) {
          const replaced = archiveStalePeers(prev, item);
          // Sub-Plan 3 (2026-05-01): Max-3-Active-Cards-Cap.
          // Begrenzt die Anzahl gleichzeitig sichtbarer Surface-Cards
          // pro Workspace. Aelteste werden VOR dem Append archiviert.
          workingPrev = enforceActiveCap(replaced.prev, replaced.incoming, 3);
          workingItem = replaced.incoming;
        } else if (item.workstreamId && item.surfaceKind) {
          // Sub-Plan A Finding 4 (2026-04-29): Mid-insert-replay-Schutz.
          // Wenn der eingehende Eintrag chronologisch hinter ein bereits
          // existierendes, lebendes Item desselben (workstreamId,
          // surfaceKind)-Coords gehoert, wuerde er ohne Massnahme als
          // "lebende" Card erscheinen und dem User zwei aktuelle Cards
          // anzeigen. Wir markieren das incoming dann sofort als archiviert.
          const liveSamePeerNewer = prev.find((p) => {
            if (p.archived) return false;
            if (p.id === item.id) return false;
            if (p.workstreamId !== item.workstreamId) return false;
            if (p.surfaceKind !== item.surfaceKind) return false;
            const pTs = Date.parse(p.ts);
            return Number.isFinite(pTs) && Number.isFinite(itTs) && pTs >= itTs;
          });
          if (liveSamePeerNewer) {
            workingItem = { ...item, archived: true };
          }
        }
        const next = [
          ...workingPrev.slice(0, insertIdx),
          workingItem,
          ...workingPrev.slice(insertIdx),
        ].slice(-60);
        writeHistoryFor(currentWorkspace.id, next);
        return next;
      });
      return;
    }

    const mapped = eventToSurface(ev);
    if (!mapped) return;

    // PHASE I (User-Wunsch 2026-04-26): Synthesis-Cards als richtige
    // Assistant-Message in den Chat-Verlauf, NICHT nur als dezenter
    // System-Toast. Das ist die Fertigstellungs-Karte fuer einen
    // Workstream — sollte prominent + persistent sein.
    const isSynthesis =
      ev.type === 'commented' &&
      typeof ev.payload?.kind === 'string' &&
      ev.payload.kind === 'synthesis';
    if (isSynthesis) {
      // Phase IT (2026-04-27): Wenn der Synthesis-Output aus dem Iterate-
      // Modus kommt, prepend ein Diff-Score-Header damit User die
      // Verbesserung V1->V2 sofort sieht. Plus Token-Budget-Anzeige.
      const isIterate =
        typeof ev.payload?.mode === 'string' && ev.payload.mode === 'iterate';
      let iterateHeader = '';
      if (isIterate) {
        const diff = (ev.payload?.diffScore ?? {}) as Record<string, unknown>;
        const pct =
          typeof diff.improvementPct === 'number' ? diff.improvementPct : 0;
        const oqBefore =
          typeof diff.openQuestionsBefore === 'number'
            ? diff.openQuestionsBefore
            : 0;
        const oqAfter =
          typeof diff.openQuestionsAfter === 'number'
            ? diff.openQuestionsAfter
            : 0;
        const userFlowAdded = diff.userFlowSectionAdded === true;
        const totalCost =
          typeof ev.payload?.totalCostCents === 'number'
            ? ev.payload.totalCostCents
            : 0;
        const parts = ['**Iterate V2** · +' + String(pct) + '% Klarheit'];
        if (oqBefore > oqAfter) {
          parts.push(String(oqBefore - oqAfter) + ' Fragen weniger');
        }
        if (userFlowAdded) parts.push('User-Sicht ergaenzt');
        parts.push((totalCost / 100).toFixed(2) + ' EUR theor. API-Cost');
        iterateHeader = '> ' + parts.join(' · ') + '\n\n';
      }

      // Phase AC.3 (2026-04-26): Konsens-Level aus Synthesis-Payload
      // ableiten und eine consensus-action-Surface ANS ENDE der Bubble
      // haengen. Damit User bei strong-consensus 30s-Countdown sieht
      // statt Master-Approve klicken zu muessen.
      let consensusLevelRaw =
        typeof ev.payload?.consensus_level === 'string'
          ? ev.payload.consensus_level
          : undefined;

      // AC-Fallback (2026-04-26): Wenn Server-Payload kein consensus_level
      // hat (alte Workstreams pre-AC), client-side aus mapped.text ableiten.
      // Lokales Mapping mit derselben Heuristik wie tier-orchestrator.ts.
      if (!consensusLevelRaw) {
        consensusLevelRaw = detectConsensusLevelClient(mapped.text);
      }

      const validConsensus = ['strong', 'majority', 'disagreement'].includes(
        consensusLevelRaw ?? '',
      );
      const wsIdFromPayload =
        typeof ev.payload?.workstreamId === 'string'
          ? ev.payload.workstreamId
          : undefined;
      const masterTicketId =
        typeof ev.entityId === 'string' ? ev.entityId : undefined;

      let augmentedContent = iterateHeader + mapped.text;
      if (validConsensus && wsIdFromPayload) {
        const consensusTag = `<surface:consensus-action>${JSON.stringify({
          workstreamId: wsIdFromPayload,
          consensusLevel: consensusLevelRaw,
          masterTicketId,
        })}`;
        // Surface-Tag ans Ende anhaengen — surface-parser.parseChunks
        // findet ihn und SurfaceRenderer rendert die ConsensusActionCard.
        augmentedContent = augmentedContent + `\n\n${consensusTag}`;
      }

      const item: HistoryItem = {
        id: nextId('assistant'),
        role: 'assistant',
        content: augmentedContent,
        ts: new Date().toISOString(),
        // Sub-Plan A · 2026-04-29 — Coords explizit setzen damit der
        // Replace-Pass den Match findet, auch wenn der Surface-Tag im
        // Content syntaktisch unvollstaendig ist (synthesis-Branch
        // schliesst <surface:consensus-action> nicht — surface-text-render
        // toleriert das via Skeleton-Fallback).
        ...(validConsensus && wsIdFromPayload
          ? { workstreamId: wsIdFromPayload, surfaceKind: 'consensus-action' as const }
          : {}),
      };
      setHistory((h) => {
        // De-dupe falls Event doppelt ankommt (Replay + Live).
        // Match auf mapped.text (Original ohne Surface-Suffix), sonst
        // wuerden 2 Synthesis-Bubbles entstehen wenn nur eine den
        // consensus_level-Marker hat.
        const lastFew = h.slice(-3);
        if (lastFew.some((m) => m.content.startsWith(mapped.text))) return h;
        // Sub-Plan A — alle vorigen Cards mit derselben (workstreamId,
        // surfaceKind)-Coord auf archived=true setzen.
        const replaced = archiveStalePeers(h, item);
        // Sub-Plan 3 (2026-05-01): Max-3-Active-Cards-Cap einhalten.
        const capped = enforceActiveCap(replaced.prev, replaced.incoming, 3);
        const next = [
          ...capped.slice(-(HISTORY_CAP - 1)),
          replaced.incoming,
        ];
        writeHistoryFor(currentWorkspace.id, next);
        return next;
      });
      // Push-Benachrichtigung (best-effort, nur wenn Push-Subscription vorhanden)
      void fetch('/api/push/notify-review', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          title: 'Workstream-Synthese fertig',
          body: 'Plan + User-Sicht + offene Fragen warten auf dich.',
          url: mapped.href ?? '/',
        }),
      }).catch(() => undefined);
      return;
    }

    // Phase WSC.1 (2026-04-26): auto-dispatch-overview als prominente
    // Assistant-Message rendern (nicht als dezenter SystemToast). User
    // sieht die Live-Pipeline direkt im Chat-Verlauf, nicht versteckt
    // in einem Toast-Stapel.
    const isAutoDispatchOverview =
      ev.type === 'commented' &&
      typeof ev.payload?.kind === 'string' &&
      ev.payload.kind === 'auto-dispatch-overview';
    if (isAutoDispatchOverview) {
      // Sub-Plan E (2026-04-30) — Doppel-Scan eliminiert. Vorher liefen
      // hier `extractWorkstreamCoords(mapped.text)` UND später nochmal
      // der Renderer-Regex über denselben Content. Jetzt:
      //   1. archiveStalePeers (in replace-logic.ts) macht intern den
      //      Fallback-Scan via extractWorkstreamCoords WENN das Item keine
      //      Coords mitbringt — also exakt einmal pro neuer Bubble.
      //   2. Der useMemo<parsedItems>-Pass deckt den Render-Pfad ab; der
      //      Cache enthält Coords aus parseHistoryItem (single-pass).
      // Coords werden also nicht mehr hier vorgezogen.
      const item: HistoryItem = {
        id: ev.id ? `auto-dispatch-overview-${ev.id}` : nextId('assistant'),
        role: 'assistant',
        content: mapped.text,
        ts: new Date().toISOString(),
      };
      setHistory((h) => {
        if (h.some((m) => m.id === item.id)) return h;
        const replaced = archiveStalePeers(h, item);
        // Sub-Plan 3 (2026-05-01): Max-3-Active-Cards-Cap einhalten.
        const capped = enforceActiveCap(replaced.prev, replaced.incoming, 3);
        const next = [
          ...capped.slice(-(HISTORY_CAP - 1)),
          replaced.incoming,
        ];
        writeHistoryFor(currentWorkspace.id, next);
        return next;
      });
      return;
    }

    const id = ev.id ? `sys-${ev.id}` : `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const item: SystemItem = {
      id,
      role: 'system',
      kind: eventKindLabel(ev),
      content: mapped.text,
      severity:
        mapped.severity === 'critical'
          ? 'critical'
          : mapped.severity === 'warn'
            ? 'warn'
            : 'info',
      href: mapped.href,
      // Bug B Fix 2026-04-26: ISO-Timestamp damit ChatShell history+systemMessages
      // chronologisch interleaven kann. HH:MM-Format passiert beim Render.
      ts: new Date(typeof ev.ts === 'number' ? ev.ts : Date.now()).toISOString(),
    };

    setSystemMessages((prev) => {
      // De-dupe by id
      if (prev.some((s) => s.id === item.id)) return prev;
      // Cap at 30 to avoid growing unbounded
      const next = [...prev, item];
      return next.length > 30 ? next.slice(-30) : next;
    });
  }, [currentWorkspace.id, nextId]);

  useEventStream({
    workspaceId: currentWorkspace.id,
    onEvent: handleEvent,
    // P1-3: Erst nachdem die einmalige History-Migration durch ist.
    // Sonst Replay-Burst-Doppel weil cached cache-IDs ≠ ULID-IDs.
    enabled: hydrated && migrationDone,
  });

  // ---- Phase Reload-Recovery V2 · 2026-04-27 -------------------------
  // Polling fuer streaming_snapshots: solange ein HistoryItem mit
  // streamState='streaming' im State steht, alle 2s `/api/chat/history`
  // refreshen damit User sieht wie die Antwort weiterlaeuft. Stoppt
  // automatisch sobald keiner mehr streamt (completed-Event hat das
  // Snapshot-Item ersetzt, oder Heuristik kippt's auf 'aborted').
  //
  // Echo-Filter: ownPendingIdsRef enthaelt die IDs die wir gerade
  // selbst live streamen — Polling-Items zu diesen IDs werden
  // verworfen (Live-SSE in useAgentStream hat Vorrang).
  useStreamingPoll({
    workspaceId: currentWorkspace.id,
    history,
    enabled: hydrated && migrationDone,
    ownPendingIdsRef,
    onUpdate: (merged, systemItems) => {
      setHistory((prev) => {
        // Conservative apply: nur uebernehmen wenn sich etwas am
        // Streaming-Pfad geaendert hat. Sonst trampeln wir lokale
        // Surface-Cards / Mock-Items / etc. nicht unnoetig.
        const prevStreamSig = streamSignature(prev);
        const nextStreamSig = streamSignature(merged);
        if (prevStreamSig === nextStreamSig && prev.length === merged.length) {
          // Kein Streaming-Delta → Polling hat nichts neues, skip.
          return prev;
        }
        writeHistoryFor(currentWorkspace.id, merged);
        return merged;
      });
      if (systemItems.length > 0) {
        setSystemMessages((prev) => mergeSystemItems(prev, systemItems));
      }
    },
  });

  const dismissSystem = useCallback((id: string) => {
    setSystemMessages((prev) => prev.filter((s) => s.id !== id));
  }, []);

  // 2026-05-03: pushSystemToastTopLevel + clearSystemMessagesTopLevel
  // entfernt — wurden nur von SessionControls gebraucht. Slash-Commands
  // im Composer haben ihren eigenen ctx-Helper (slashCtx). Cleanup für
  // den unused-Linter — kein dangling code.

  // ---- inline auto-suggest (Punkt 1 handoff) -------------------------
  const suggestions = useChatSuggestions(input, {
    enabled: !sttListening,
    minLength: 2,
    // Sub-Plan B (2026-04-29) — Slash-Command-Suggestions schreiben den
    // Command-Namen ins Input-Feld, statt eine Aktion zu triggern. User
    // schickt dann mit Enter ab.
    setInput,
  });
  const [activeSuggestIndex, setActiveSuggestIndex] = useState(0);
  const [suggestDismissed, setSuggestDismissed] = useState(false);
  const effectiveSuggestions = suggestDismissed ? [] : suggestions;

  // Reset active index when suggestion list changes
  useEffect(() => {
    if (activeSuggestIndex >= effectiveSuggestions.length) {
      setActiveSuggestIndex(Math.max(0, effectiveSuggestions.length - 1));
    }
  }, [effectiveSuggestions.length, activeSuggestIndex]);

  // Reset dismiss whenever input changes — user may re-trigger by typing more
  useEffect(() => {
    setSuggestDismissed(false);
  }, [input]);

  const handleSuggestSelect = useCallback(
    (s: ChatSuggestion) => {
      s.onSelect();
      // Slash-Command-Suggestions schreiben den Command-Namen via
      // opts.setInput in das Composer-Feld zurueck — nicht clearen.
      // Sonst (nav/act/ws): Composer leeren, weil onSelect navigiert/wechselt.
      if (s.kind !== 'slash') {
        setInput('');
      }
      setSuggestDismissed(false);
    },
    [],
  );

  const handleSuggestNavigate = useCallback(
    (key: 'up' | 'down' | 'escape') => {
      if (key === 'escape') {
        setSuggestDismissed(true);
        return;
      }
      if (key === 'down') {
        setActiveSuggestIndex((i) =>
          Math.min(effectiveSuggestions.length - 1, i + 1),
        );
      } else if (key === 'up') {
        setActiveSuggestIndex((i) => Math.max(0, i - 1));
      }
    },
    [effectiveSuggestions.length],
  );

  // ---- Auto-Projekt-Naht (2026-06-02) ----------------------------------
  // Build-Intent im virtuellen Workspace (org-root/__root__/__org_root__:*) →
  // echtes Projekt-Workspace anlegen, org-bewusst reinwechseln, Build-Prompt
  // mitnehmen (stash) + auf der neuen Seite auto-submitten. So wird aus „bau
  // mir das" im Default-Chat nahtlos eine App, statt im virtuellen Root zu
  // hängen (dort kann der Agent keine Dateien schreiben). Best-effort.
  const pushAutoProjectNote = useCallback(
    (title: string, body: string, variant: 'warn' | 'err'): void => {
      setSystemMessages((prev) => {
        const sysItem: SystemItem = {
          id: `sys-autoproj-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          role: 'system',
          kind: 'slash-flow',
          content:
            '<surface:toast>' +
            JSON.stringify({
              variant: variant === 'err' ? 'err' : 'ok',
              title,
              body,
              iconGlyph: variant === 'err' ? '×' : '•',
            }) +
            '</surface:toast>',
          severity: variant === 'err' ? 'critical' : 'info',
          ts: new Date().toISOString(),
        };
        const next = [...prev, sysItem];
        return next.length > 30 ? next.slice(-30) : next;
      });
    },
    [],
  );

  const createProjectAndBuild = useCallback(
    async (prompt: string): Promise<void> => {
      const label = deriveProjectLabel(prompt);
      try {
        const res = await fetch('/api/workspaces', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ label }),
        });
        if (!res.ok) {
          pushAutoProjectNote(
            'Konnte kein Projekt anlegen',
            'Tipp deine Anfrage gern in einem Projekt-Workspace erneut.',
            'err',
          );
          return;
        }
        const data = (await res.json()) as {
          workspace?: { id: string; organizationId?: string | null; label?: string };
        };
        const ws = data.workspace;
        if (!ws?.id) {
          pushAutoProjectNote('Konnte kein Projekt anlegen', 'Unerwartete Server-Antwort.', 'err');
          return;
        }
        // Brainstorm-Kontext aus dem bisherigen Gespräch mitnehmen — sonst
        // weiß die frische Session im neuen Projekt bei „bau das / leg los"
        // nicht, WAS gebaut werden soll. Surface-Tags raus, letzte ~8 Messages.
        const recent = historyForHandoffRef.current
          .filter(
            (m) =>
              (m.role === 'user' || m.role === 'assistant') &&
              typeof m.content === 'string',
          )
          .slice(-8)
          .map((m) => {
            const text = m.content
              .replace(/<surface:[^>]*>[\s\S]*?<\/surface:[^>]*>/g, '')
              .replace(/<surface:[^>]*\/>/g, '')
              .replace(/\s+/g, ' ')
              .trim()
              .slice(0, 400);
            return text ? `${m.role === 'user' ? 'User' : 'Assistant'}: ${text}` : '';
          })
          .filter(Boolean)
          .join('\n');
        const composed = recent
          ? `Kontext aus unserem bisherigen Gespräch:\n${recent.slice(-1800)}\n\n---\nAuftrag: ${prompt}\n\nBau das jetzt konkret hier im Projekt — leg die Datei(en) an und zeig mir das Ergebnis.`
          : prompt;
        // Build-Prompt für die neue Seite stashen + org-bewusst wechseln, dann
        // hart in den neuen Workspace navigieren (kanonischer ?ws-Landepfad).
        stashPendingBuild(ws.id, composed);
        setWorkspaceId(ws.id, ws.organizationId ?? undefined);
        pushAutoProjectNote(
          `Projekt „${ws.label ?? label}" angelegt`,
          'Ich wechsle rein und baue dort …',
          'warn',
        );
        window.location.assign(`/?ws=${encodeURIComponent(ws.id)}`);
      } catch (err) {
        pushAutoProjectNote(
          'Konnte kein Projekt anlegen',
          err instanceof Error ? err.message.slice(0, 120) : 'Netzwerkfehler',
          'err',
        );
      }
    },
    [pushAutoProjectNote],
  );

  // ---- submit ----------------------------------------------------------
  const submit = useCallback(
    (raw: string) => {
      const value = raw.trim();

      // STAGING (Owner-Hard-Requirement 2026-05-26): gestagete Anhänge am
      // Submit-Start einlesen. Solange welche da sind, ist ein LEERER Text
      // erlaubt (reiner Anhang-Send, WhatsApp-Verhalten). Datei(en) + Text
      // gehen GEMEINSAM raus — siehe userMsg.content (Bubble) und
      // agentText (Agent-Prompt) weiter unten.
      const pendingAttachments = stagedAttachmentsRef.current;
      const hasStaged = pendingAttachments.length > 0;
      if (!canSendWithAttachments(pendingAttachments, value)) return;

      // Bug-2-Fix: Während Streaming → in Queue einreihen statt verwerfen.
      // Der Queue-Flush-Effect sendet die Message automatisch sobald
      // agentStatus auf 'idle' wechselt.
      //
      // C2-Fix: submitInflightRef schließt das Fenster zwischen submit-Start
      // und der agentStatus-Transition auf 'connecting' (in dem isStreaming
      // noch false ist). Ein konkurrierender direkter submit() (z.B.
      // SurfaceAction.reply / RateLimitRetry-Auto-Retry) wird so ebenfalls
      // enqueued statt einen zweiten sendAgent() zu starten. Wichtig: dieser
      // Guard steht VOR jeder History-Mutation, damit kein Doppel-User-Bubble
      // entsteht (re-enqueue mutiert die History nicht).
      // Anhänge umgehen die Text-Queue: die Queue speichert nur Strings,
      // ein enqueuter Text würde die gestagete Datei verwaisen lassen. Bei
      // echtem Inflight schützt submitInflightRef weiter unten gegen
      // Doppel-Send. Reiner Text wird wie gehabt enqueued.
      if (!hasStaged && (isStreaming || submitInflightRef.current)) {
        messageQueueRef.current.push(value);
        setQueueLength(messageQueueRef.current.length);
        setInput('');
        clearDraftFor(currentWorkspace.id);
        return;
      }

      // ---- Auto-Projekt-Naht (2026-06-02) ------------------------------
      // Im virtuellen Workspace (org-root etc.) kann der Agent nicht bauen
      // (kein Projekt-Pfad). Bei einem klaren Bau-Auftrag legen wir daher ein
      // echtes Projekt an, wechseln rein und bauen DORT — statt hier zu hängen.
      // Konservative Erkennung (looksLikeBuildIntent) + nicht während einer
      // offenen Pill-Frage. Reiner Text only (keine Staged-Attachments).
      // ---- Bild-Generierung aus natürlicher Sprache · 2026-06-03 ----------
      // Owner-Befund: „erstelle ein Bild von X" (ohne /image) ging an den
      // Agenten, der es per HTML/Bash fakete — ohne echte Generierung + ohne
      // Vorschau. Fix: VOR Build-/Flow-Routing erkennen (detectImageIntent) und
      // das echte <surface:image-gen>-Lade-Surface emittieren (ImageGen2 +
      // animierte Vorschau im Chat). Kein Agent-Roundtrip. Konservativ
      // (Generier-Verb + Bild-Nomen; Abruf-Phrasen ausgeschlossen).
      if (!hasStaged && !(pillExpanded && openQuestions.length > 0)) {
        const imgIntent = detectImageIntent(value);
        if (imgIntent.isImage) {
          setInput('');
          clearDraftFor(currentWorkspace.id);
          const token = `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          const userMsg: HistoryItem = {
            id: nextId('user'),
            role: 'user',
            content: value, // N1: verbatim Wunsch als User-Bubble
            ts: new Date().toISOString(),
          };
          const surfaceMsg: HistoryItem = {
            id: nextId('assistant'),
            role: 'assistant',
            content:
              '<surface:image-gen>' +
              JSON.stringify({ prompt: imgIntent.prompt, workspace: currentWorkspace.id, token }) +
              '</surface:image-gen>',
            ts: new Date().toISOString(),
          };
          setHistory((h) => {
            const next = [...h, userMsg, surfaceMsg];
            writeHistoryFor(currentWorkspace.id, next);
            return next;
          });
          return;
        }
      }

      if (
        !hasStaged &&
        !(pillExpanded && openQuestions.length > 0) &&
        isVirtualWorkspaceId(currentWorkspace.id) &&
        looksLikeBuildIntent(value)
      ) {
        setInput('');
        clearDraftFor(currentWorkspace.id);
        void createProjectAndBuild(value);
        return;
      }

      // ---- UX-1: Q/A-Pill-Antwort-Routing · 2026-05-26 -----------------
      // REIHENFOLGE: (1) streaming → Queue (oben, unverändert);
      // (2) sonst wenn die Pill ausgeklappt ist UND offene Fragen hat →
      //     die Eingabe als FREITEXT-Antwort auf die aktuelle Frage setzen,
      //     dann zur nächsten unbeantworteten Frage springen. Sind danach
      //     ALLE Fragen beantwortet → EIN finaler reply(<Q&A>) (über den
      //     normalen Send-Pfad weiter unten), Pill-State sauber zurücksetzen.
      // (3) sonst normaler Send (Code unten).
      //
      // Wichtig: nur wenn NICHT streaming (Guard oben greift zuerst). Damit
      // bleibt der claude-cli-Happy-Path + die Queue/Interrupt-Logik intakt.
      if (!hasStaged && pillExpanded && openQuestions.length > 0) {
        const qs = openQuestions;
        const idx = Math.min(Math.max(qIndex, 0), qs.length - 1);
        const currentQ = qs[idx]!;

        // routePillAnswer = identische Logik wie der Options-Klick (ein Pfad):
        // Antwort setzen → Vollständigkeit prüfen → nächste offene Frage.
        const route = routePillAnswer(qs, qAnswersRef.current, idx, currentQ.id, value);
        setQAnswers(route.nextAnswers);
        setInput('');
        clearDraftFor(currentWorkspace.id);

        if (route.allAnswered) {
          const qaText = buildQAReply(qs, route.nextAnswers);
          // Phase 1 Track AB · Befund B: strukturiertes Envelope PARALLEL
          // zum bestehenden Chat-Turn — fail-soft fire-and-forget POST an
          // /api/chat/answer. sourceTurnId = vorab erzeugter User-Turn-Anker
          // (Idempotenz-Schlüssel via UNIQUE(source_turn_id, question_id)).
          // Via Ref weil postStructuredAnswers WEITER unten im File definiert
          // wird (nach submit) — analog submitRef-Pattern oben.
          const turnAnchor = nextId('user');
          postStructuredAnswersRef.current?.(qs, route.nextAnswers, turnAnchor);
          // Pill-State VOR dem finalen Send zurücksetzen, damit der reply()
          // (= submit auf qaText) NICHT erneut ins Pill-Routing fällt.
          resetPillState();
          // Über den normalen Send-Pfad: submitRef ist stabil + prüft selbst
          // erneut isStreaming (kein Doppel-Send). Microtask damit das
          // State-Reset settled, bevor der finale Turn startet.
          queueMicrotask(() => {
            submitRef.current?.(qaText);
          });
          return;
        }

        // Sonst: zur nächsten noch unbeantworteten Frage — kein neuer Turn.
        setQIndex(route.nextIndex);
        return;
      }

      // ---- Bug-2-Fix · Free-Text-Antwort-Kopplung · 2026-05-30 ----------
      // Live-Browser-Befund (verbatim): Tippt der User FREI „Eigenes Video"
      // statt eine offene tier-choice/quickchoice-Card anzuklicken, fällt der
      // Text durch `classifyFlowIntent` (min 3 Wörter + Imperativ-Verb → sonst
      // 'unknown') in den normalen Chat-Stream. Der Agent versteht ihn NICHT
      // als Antwort auf die offene Frage, sondern wirft einen DRITTEN
      // Tiefe-/Choice-Picker → Kontextverlust.
      //
      // FIX: Wenn offene Fragen aktiv sind (openQuestions.length > 0) — egal ob
      // die Pill ein- oder ausgeklappt ist — wird Free-Text als Antwort auf die
      // aktuell sichtbare Frage geroutet, NICHT als neuer Plan. Das ist exakt
      // dieselbe routePillAnswer-Logik wie Options-Klick / Pill-Enter
      // (ein Code-Pfad) inkl. strukturiertem Envelope (Befund 4 / N8/N9).
      //
      // Abgrenzung (kein Hijack echter neuer Aufträge):
      //   - Slash-Command (`/…`) → NICHT abfangen (expliziter Befehl).
      //   - Confident Flow-Intent (classifyFlowIntent === 'flow', z.B.
      //     „erstelle eine Webseite") → NICHT abfangen; der User startet
      //     bewusst etwas Neues. Nur „unknown"-Input (= die typische kurze
      //     Antwort) wird an die Frage gekoppelt.
      //   - Der pillExpanded-Pfad oben hat bereits Vorrang (greift zuerst).
      const freeTextAnswerEligible = shouldRouteFreeTextAsAnswer({
        value,
        hasStaged,
        pillExpanded,
        openQuestionCount: openQuestions.length,
        classify: classifyFlowIntent,
      });
      if (freeTextAnswerEligible) {
        const qs = openQuestions;
        const idx = Math.min(Math.max(qIndex, 0), qs.length - 1);
        const currentQ = qs[idx]!;
        const route = routePillAnswer(
          qs,
          qAnswersRef.current,
          idx,
          currentQ.id,
          value,
        );
        setQAnswers(route.nextAnswers);
        setInput('');
        clearDraftFor(currentWorkspace.id);

        if (route.allAnswered) {
          const qaText = buildQAReply(qs, route.nextAnswers);
          // Strukturiertes Envelope PARALLEL (Befund 4) — Ausführung hängt am
          // Objekt, nicht an der lesbaren Chat-Bubble.
          const turnAnchor = nextId('user');
          postStructuredAnswersRef.current?.(qs, route.nextAnswers, turnAnchor);
          resetPillState();
          queueMicrotask(() => {
            submitRef.current?.(qaText);
          });
          return;
        }

        // Noch offene Fragen → zur nächsten springen, kein neuer Turn.
        setQIndex(route.nextIndex);
        return;
      }

      // Alter Mock-Pending-Guard bleibt erhalten (Mock-Pfad ist synchron,
      // kein Interrupt möglich).
      if (isMockPending) return;

      // Owner-Direktive 2026-05-28 (N1 verbatim): „Flow müsste doch aus
      // dem Context und Intent erkannt werden und ausgeführt. Das wäre ja
      // das Kernkonzept von dem lazing system."
      //
      // → Vor dem Slash-Parser klassifizieren wir den User-Input
      // deterministisch (lib/chat/intent-flow-classifier.ts). Bei
      // kind === 'flow' synthetisieren wir `"/flow " + value` und reichen
      // das in den bestehenden Slash-Pfad — gleicher Handler wie ein
      // explizites `/flow`, ein Code-Pfad, keine Duplikation.
      //
      // Guards (additiv, fail-soft):
      //   - hasStaged: wenn Anhänge gestaged sind, will der User explizit
      //     einen File-Send → nicht klassifizieren (Bug-Swarm-Pfad lässt
      //     das ebenfalls bewusst aus).
      //   - bereits `/`-Prefix: der Klassifizierer gibt selbst 'unknown'
      //     zurück, hier zusätzlich defensiv.
      //   - Backend-Fallback für Voice/Agent-API ist ein eigener Slice
      //     (s. lib/chat/intent-flow-classifier.ts Kopf-Kommentar).
      let effectiveSubmitValue = value;
      let autoFlowDetected = false;
      if (!hasStaged && !value.startsWith('/')) {
        const flowResult = classifyFlowIntent(value);
        if (flowResult.kind === 'flow') {
          effectiveSubmitValue = buildSyntheticFlowCommand(value);
          autoFlowDetected = true;
          // Optionaler dezenter Hinweis (≤14px, Token-only) als System-Toast.
          // Hilft dem Owner zu verstehen, warum eine Flow-Surface erscheint
          // statt einer LLM-Antwort. Opt-out implizit: bei `?` oder Lese-
          // Aufträgen feuert classifyFlowIntent gar nicht erst.
          const hintId = `sys-auto-flow-${Date.now()}-${Math.random()
            .toString(36)
            .slice(2, 8)}`;
          const hintItem: SystemItem = {
            id: hintId,
            role: 'system',
            kind: 'auto-flow-detected',
            content:
              '<surface:toast>' +
              JSON.stringify({
                variant: 'default',
                title: 'Auto-Flow erkannt',
                body: `Routing: ${flowResult.reason}`,
                iconGlyph: '⤳',
              }) +
              '</surface:toast>',
            severity: 'info',
            ts: new Date().toISOString(),
          };
          setSystemMessages((prev) => {
            const next = [...prev, hintItem];
            return next.length > 30 ? next.slice(-30) : next;
          });
        }
      }
      // Stille Lint-Annahme: autoFlowDetected wird unten (slash-Pfad) nicht
      // weiter benötigt — der Flag dient als Debug-/Test-Hook (vgl. Tests
      // in __tests__/chat-shell-flow-auto-detect.test.ts). React-Compiler
      // strippt das in Prod.
      void autoFlowDetected;

      // Sub-Plan B · 2026-04-29: Slash-Command-Interception.
      // VOR jedem LLM-Roundtrip pruefen wir ob `/clear`, `/compact`, `/help`
      // (oder ein anderes registriertes Command) am Anfang steht. Falls ja:
      // Handler ausfuehren, Composer-Input leeren, KEIN Server-Roundtrip.
      // Pass-through-Commands (aktuell keiner) wuerden weiter unten
      // wie eine normale Message behandelt.
      // Owner-Direktive 2026-05-28: effectiveSubmitValue enthält ggf. den
      // synthetisierten `/flow <intent>`-String aus der Auto-Detection oben.
      const slashCmd = hasStaged ? null : parseSlashCommand(effectiveSubmitValue);
      if (slashCmd) {
        const slashCtx: SlashContext = {
          workspaceId: currentWorkspace.id,
          // M1-Fix: aktuelle history aus Ref (submit ist jetzt stabil, der
          // Closure-Capture wäre sonst veraltet).
          history: historyRef.current,
          setHistory,
          pushSystemToast: (item: SlashSystemItem) => {
            // SlashSystemItem ist strukturidentisch zur internen SystemItem.
            const sysItem: SystemItem = {
              id: item.id,
              role: 'system',
              kind: item.kind,
              content: item.content,
              severity: item.severity,
              ts: item.ts,
              ...(item.href ? { href: item.href } : {}),
            };
            setSystemMessages((prev) => {
              const next = [...prev, sysItem];
              return next.length > 30 ? next.slice(-30) : next;
            });
          },
          fetch: typeof window !== 'undefined' ? window.fetch.bind(window) : fetch,
          clearSystemMessages: () => setSystemMessages([]),
          // Track-D · 2026-05-27 (Flow Studio): Tail-Args nach dem Command-
          // Namen (verbatim, nur außen getrimmt). `/flow` nutzt das als Intent.
          // Owner-Direktive 2026-05-28: bei Auto-Flow-Detect enthält
          // effectiveSubmitValue den synthetisierten Slash-Prefix → der Tail
          // ist der Original-User-Text (N1 verbatim).
          args: extractSlashArgs(effectiveSubmitValue),
          // Track-D · 2026-05-27 (Flow Studio): Assistant-Bubble in den Verlauf
          // posten. Nur Assistant-Items laufen durch den surface-aware Renderer,
          // d.h. `<surface:flow-coupling>`-Markup wird hier zur Card. System-
          // Toasts (pushSystemToast) zeigen dagegen Rohtext.
          postAssistantMessage: (content: string) => {
            const item: HistoryItem = {
              id: nextId('assistant'),
              role: 'assistant',
              content,
              ts: new Date().toISOString(),
            };
            setHistory((h) => [...h, item]);
          },
          // Track-D · Stream-B2: `/flow` delegiert needs-style-choice hierher —
          // ChatShell emittiert die quickchoice-Surface(s) + verdrahtet die
          // Owner-Wahl → Re-POST (siehe handleFlowStyleChoice oben).
          onFlowStyleChoice: handleFlowStyleChoice,
        };
        // Result-Type aktuell konstant 'consumed' — async fire-and-forget
        // mit defensivem catch. Composer hier sofort leeren + Draft droppen.
        setInput('');
        clearDraftFor(currentWorkspace.id);
        void slashCmd.handler(slashCtx).catch((err) => {
          // Sehr robust: wenn der Handler crasht, zeig wenigstens einen
          // Toast statt schweigend zu schlucken.
          // eslint-disable-next-line no-console
          console.error('[slash-command]', slashCmd.name, err);
        });
        return;
      }

      // ---- Sprint H · 2026-04-30: Bug-Fix-Swarm Detection -----------------
      // User-Beschwerde 2026-04-30: „Bug rein, der labert da rum, statt
      // selber zu fixen". Wir erkennen Error-/Bug-Posts heuristisch und
      // starten 3 parallele Diagnose-Spawns + Konsens + Fix.
      // Bypass via `/no-swarm <text>` möglich.
      // Mit gestagetem Anhang NIE den Bug-Swarm triggern — der User will
      // explizit eine Datei + Caption an den Agent geben, nicht eine Bug-
      // Diagnose-Pipeline starten.
      const bugDetect = hasStaged
        ? { isBug: false, bypassedByUser: false, cleanedMessage: value }
        : detectBugReport(value);
      let effectiveValue = value;
      if (bugDetect.bypassedByUser) {
        // User wollte explizit KEIN Swarm — Marker entfernen, normal weiter.
        effectiveValue = bugDetect.cleanedMessage.trim() || value;
      } else if (bugDetect.isBug) {
        // Bug erkannt → Swarm starten, aktuelle User-Message als History-
        // Item posten + System-Toast → KEIN normaler LLM-Roundtrip.
        const userMsg: HistoryItem = {
          id: nextId('user'),
          role: 'user',
          content: value,
          ts: new Date().toISOString(),
        };
        setHistory((h) => {
          const next = [...h.slice(-(HISTORY_CAP - 2)), userMsg];
          writeHistoryFor(currentWorkspace.id, next);
          return next;
        });
        setInput('');
        clearDraftFor(currentWorkspace.id);

        // Toast + silent POST.
        const toastId = `sys-bug-swarm-${Date.now()}-${Math.random()
          .toString(36)
          .slice(2, 8)}`;
        const toastItem: SystemItem = {
          id: toastId,
          role: 'system',
          kind: 'bug-swarm-started',
          content:
            '<surface:toast>' +
            JSON.stringify({
              variant: 'default',
              title: 'Bug-Swarm gestartet',
              body: '3 Modelle diagnostizieren parallel — Card erscheint gleich.',
              iconGlyph: '›',
            }) +
            '</surface:toast>',
          severity: 'info',
          ts: new Date().toISOString(),
        };
        setSystemMessages((prev) => {
          const next = [...prev, toastItem];
          return next.length > 30 ? next.slice(-30) : next;
        });

        void (async () => {
          try {
            const resp = await fetch('/api/bugs/swarm', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              credentials: 'same-origin',
              body: JSON.stringify({
                workspaceId: currentWorkspace.id,
                bugDescription: value,
              }),
            });
            if (!resp.ok) {
              // eslint-disable-next-line no-console
              console.warn('[bug-swarm] POST failed', resp.status);
            }
          } catch (err) {
            // eslint-disable-next-line no-console
            console.error('[bug-swarm] POST crashed', err);
          }
        })();

        return;
      }

      // Sub-Plan B · 2026-04-29: Auto-Reset bei jeder neuen User-Message.
      // User-Wunsch: Verlauf klappt nach Submit automatisch wieder ein,
      // damit der Fokus auf der frischen Antwort liegt und nicht im
      // historischen Kontext verloren geht. Ein dezenter System-Toast
      // weist darauf hin wie man ihn wieder öffnet.
      //
      // Kein Toast wenn showHistory bereits false war ODER wenn keine
      // archivierten Items vorhanden sind (= keine sichtbare Veränderung
      // für den User, wäre Geister-Toast). B-3 Review-Finding 2026-04-29.
      const hasArchived = historyRef.current.some((it) => it.archived === true);
      if (showHistory && hasArchived) {
        setShowHistory(false);
        // Eigene ID-Quelle für transient System-Toasts (nicht über nextId,
        // das ist HistoryItem-only). Random + Timestamp reicht für Dedup.
        const toastId = `sys-history-collapsed-${Date.now()}-${Math.random()
          .toString(36)
          .slice(2, 8)}`;
        const toastItem: SystemItem = {
          id: toastId,
          role: 'system',
          kind: 'history-collapsed',
          content:
            '<surface:toast>' +
            JSON.stringify({
              variant: 'default',
              title: 'Verlauf eingeklappt',
              body: 'Oben rechts wieder zeigen.',
              iconGlyph: '▾',
            }) +
            '</surface:toast>',
          severity: 'info',
          ts: new Date().toISOString(),
        };
        setSystemMessages((prev) => {
          const next = [...prev, toastItem];
          return next.length > 30 ? next.slice(-30) : next;
        });
      }

      // Auto-Mode: Marker im Prompt damit Agent erkennt "großer Plan
      // gewuenscht". UI zeigt nur den eigentlichen Text (Marker als
      // dezenter Suffix).
      // Sprint H · 2026-04-30: `effectiveValue` ist der user-input mit
      // ggf. entferntem `/no-swarm`-Bypass-Prefix. Bei normalem Pfad
      // identisch zu `value`.
      const autoOn = isAutoModeOn();

      // STAGING: Bubble vs. Agent-Text trennen.
      //  - bubbleContent: was die User-BUBBLE zeigt — Anhang-Card(s) oben,
      //    Caption darunter (`<surface:document>…\n\ncaption`). Persistiert
      //    in der History → nach Reload bleibt der Anhang sichtbar.
      //  - agentBaseText: was der AGENT bekommt — Datei-Pfad-Referenzen
      //    (`[Angehängt: …]`) + Caption, damit er BEIDES in EINEM Turn sieht.
      // Ohne Anhänge sind beide identisch zum reinen User-Text.
      const bubbleContent = hasStaged
        ? buildBubbleContent(pendingAttachments, effectiveValue)
        : effectiveValue;
      const agentBaseText = hasStaged
        ? buildAgentPrompt(pendingAttachments, effectiveValue)
        : effectiveValue;
      const augmentedValue = autoOn
        ? `${agentBaseText}\n\n[Auto-Mode aktiv]`
        : agentBaseText;

      // Bug-C-RACE Fix 2026-04-26: pendingPromptId clientseitig erzeugen
      // BEVOR der POST losgeht. Damit ist `ownPendingIdsRef` schon vor
      // dem ersten chat_message_sent-Event gefuellt und der Echo-Filter
      // greift auch bei langsamem Header-Roundtrip.
      const clientPendingId =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `pid-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      ownPendingIdsRef.current.add(clientPendingId);
      if (ownPendingIdsRef.current.size > 200) {
        const first = ownPendingIdsRef.current.values().next().value;
        if (first) ownPendingIdsRef.current.delete(first);
      }

      const userMsg: HistoryItem = {
        id: nextId('user'),
        role: 'user',
        // Bubble zeigt Anhang-Card(s) + Caption (WhatsApp/Telegram-Stil).
        content: bubbleContent,
        ts: new Date().toISOString(),
        pendingPromptId: clientPendingId,
      };
      setHistory((h) => {
        const next = [...h.slice(-(HISTORY_CAP - 2)), userMsg];
        writeHistoryFor(currentWorkspace.id, next);
        return next;
      });
      setInput('');
      // Staging leeren — die Datei(en) sind jetzt Teil der gesendeten Message.
      if (hasStaged) setStagedAttachments([]);
      // Phase Reload-Recovery V2 · 2026-04-27: Draft loeschen sobald
      // erfolgreich abgesendet (chat_message_sent ist hier "der lokale
      // Push" — falls der Server-Roundtrip scheitert, regeneriert der User
      // den Prompt eh manuell, und dann tippt er neu).
      clearDraftFor(currentWorkspace.id);

      // ---- real-agent path ----------------------------------------------
      // C2-Fix: Inflight-Lock setzen BEVOR der async-Pfad startet. Das
      // try/finally unten garantiert das Zurücksetzen in JEDEM Ausgang
      // (ok/error/aborted/throw) — kein hängender Lock.
      submitInflightRef.current = true;
      (async () => {
       try {
        // Sofort-Feedback 2026-04-30: Typing-Indicator soll direkt beim
        // Submit erscheinen, nicht erst nach Server-Roundtrip. User-
        // Beschwerde: lange Wartezeiten ohne Visual.
        setServerStreamPending(true);

        const baseHistory = [...historyRef.current, userMsg].slice(-CONTEXT_WINDOW);
        const messages = baseHistory.map((m, idx, arr) => ({
          role: m.role,
          // Letzte User-Message → an den Agent geht IMMER `augmentedValue`
          // (= agentBaseText + ggf. Auto-Mode-Marker), NICHT der Bubble-
          // Inhalt. Bei Anhängen enthält agentBaseText die Datei-Pfad-
          // Referenzen (`[Angehängt: …]`) + Caption — sonst würde der Agent
          // rohes `<surface:document>`-Markup sehen. Bei reinem Text ohne
          // Auto-Mode ist augmentedValue == effectiveValue == m.content.
          content:
            idx === arr.length - 1 && m.role === 'user'
              ? augmentedValue
              : m.content,
        }));

        // Phase MS (P1-2): resultEventId aus der Stream-Response.
        // Wenn vorhanden → assistantMsg.id = ULID (matched mit dem Live-
        // Event-Stream-Echo). Wenn nicht (Error-Pfad, alte Server-Versionen)
        // → Fallback auf nextId().
        //
        // B5-fix 2026-04-26: Ein Ref damit wir den eventId in ALLEN
        // outcome-Branches nutzen koennen (auch error/aborted). Vorher
        // wurde resultEventId nur im 'ok'-Pfad verwendet — Server hatte
        // das chat_message_completed-Event aber auch bei outcome=error,
        // also fluetet der Live-Stream ein ULID-Item rein WAEHREND
        // ChatShell das gleiche Item unter `nextId('assistant')` speichert
        // → Doppel-Render nach Reload.
        const resultEventIdRef = { current: null as string | null };

        // ---- 2-Stufen-Modell · 2026-06-03 (Owner-Direktive, N1 verbatim) ----
        // „workspace Chat … mit einer Art Codex Speed … schnell … wenn Dinge
        // erkannt werden, dann geht es in der Agent Ausführung mit Claude Code
        // … gesprächig … das fehlt." → Normal-Chat antwortet SCHNELL (Opus, kein
        // --effort, kein Thinking — Brainstorm/Smalltalk-Tempo). Erkennt der
        // deterministische N6-Pre-Screen (`shouldDecompose`, Schwelle 3) ein
        // echtes mehrstufiges Vorhaben — Verb PLUS Komplexitäts-Signal —
        // eskaliert NUR DIESER Turn auf tieferes Nachdenken (`--effort high`).
        // Additiv: deep=false → exakt das heutige schnelle Verhalten (kein
        // Regress). Slash/Flow/Bug-Swarm/Free-Text-Antwort sind oben bereits
        // abgezweigt (return) — hier landet nur „normaler" Chat.
        const deepThinking = shouldDecompose(value).decompose;
        if (deepThinking) {
          const tId = `sys-deep-think-${Date.now()}-${Math.random()
            .toString(36)
            .slice(2, 8)}`;
          const tItem: SystemItem = {
            id: tId,
            role: 'system',
            kind: 'deep-think-engaged',
            content:
              '<surface:toast>' +
              JSON.stringify({
                variant: 'default',
                title: 'Tieferes Nachdenken',
                body: 'Mehrstufige Absicht erkannt — dieser Turn denkt gründlicher (langsamer).',
                iconGlyph: '🧠',
              }) +
              '</surface:toast>',
            severity: 'info',
            ts: new Date().toISOString(),
          };
          setSystemMessages((prev) => {
            const next = [...prev, tItem];
            return next.length > 30 ? next.slice(-30) : next;
          });
        }

        const result = await sendAgent({
          messages,
          workspaceId: currentWorkspace.id,
          pendingPromptId: clientPendingId,
          // 2-Stufen-Modell: thinking nur bei erkanntem mehrstufigem Intent.
          // Reicht durch bis server/workspace-session.ts → `--effort high`.
          ...(deepThinking ? { thinking: true } : {}),
          onPendingId: (id) => {
            // Phase MS: dieser pendingPromptId stammt von UNS — wenn
            // das chat_message_sent-Event mit dieser ID ueber den Live-
            // Event-Stream zurueckkommt, ignorieren (Echo-Filter).
            ownPendingIdsRef.current.add(id);
            // Cap die Set-Groesse (sonst memory-leak ueber Stunden).
            if (ownPendingIdsRef.current.size > 200) {
              const first = ownPendingIdsRef.current.values().next().value;
              if (first) ownPendingIdsRef.current.delete(first);
            }
            // Bug C Fix 2026-04-26: pendingPromptId auf das soeben
            // gepushte lokale userMsg setzen (Match per Content+ts da
            // userMsg.id eine clientseitige nextId('user') ist). Beim
            // naechsten Reload greift mergeServerWithLocal:
            // serverItem.pendingPromptId === localItem.pendingPromptId
            // -> lokales Item wird durch ULID-Variante ersetzt statt
            // dazugehaengt. Vorher: User-Bubble erschien nach Reload
            // doppelt (lokal + ULID).
            setHistory((h) => {
              // Suche das jüngste user-Item OHNE pendingPromptId
              // (Optimistic-Insert ohne Server-Echo). Ein einziger
              // Match — wir tagen das letzte unzugewiesene.
              for (let i = h.length - 1; i >= 0; i -= 1) {
                const it = h[i];
                if (!it) continue;
                if (it.role !== 'user') continue;
                if (it.pendingPromptId) continue;
                const next = h.slice();
                next[i] = { ...it, pendingPromptId: id };
                writeHistoryFor(currentWorkspace.id, next);
                return next;
              }
              return h;
            });
          },
          onResultEventId: (eventId) => {
            resultEventIdRef.current = eventId;
          },
        });

        switch (result.outcome) {
          case 'ok': {
            // Phase RL.2: bei erfolgreichem Stream Retry-Counter fuer
            // diesen Prompt zuruecksetzen.
            lastRetryAttemptsRef.current.delete(value);
            const { turn } = result;
            const assistantMsg: HistoryItem = {
              id: resultEventIdRef.current ?? nextId('assistant'),
              role: 'assistant',
              content: turn.text.trim(),
              tools: turn.tools,
              durationMs: turn.durationMs,
              ts: new Date().toISOString(),
            };
            setHistory((h) => {
              const next = upsertHistoryItem(h, assistantMsg);
              writeHistoryFor(currentWorkspace.id, next);
              return next;
            });
            break;
          }
          case 'not_configured': {
            // Kein Mock, keine erfundene Antwort (N5/Owner-Direktive
            // 2026-06-03): wenn keine Engine verbunden ist, sagen wir das
            // ehrlich, statt eine Karte zu faken.
            const assistantMsg: HistoryItem = {
              // not_configured laeuft nie durch den Agent → kein
              // Server-Event, kein resultEventId. Lokale ID ist hier OK.
              id: nextId('assistant'),
              role: 'assistant',
              content:
                'Es ist noch keine Engine verbunden. Verbinde unter Einstellungen → Engines eine Engine (z. B. Claude oder Codex) — danach beantworte ich deinen Prompt direkt hier.',
              ts: new Date().toISOString(),
            };
            setHistory((h) => {
              const next = upsertHistoryItem(h, assistantMsg);
              writeHistoryFor(currentWorkspace.id, next);
              return next;
            });
            break;
          }
          case 'aborted': {
            // M1-Fix: aktuellen agentTurn aus Ref lesen (Closure-Capture
            // wäre der Turn-Zustand zum submit-Zeitpunkt, nicht der finale).
            const abortedTurn = agentTurnRef.current;
            if (abortedTurn.text.trim().length > 0 || abortedTurn.tools.length > 0) {
              const assistantMsg: HistoryItem = {
                // B5-fix: bei aborted hat der Server unter Umstaenden
                // ein chat_message_completed-Event mit outcome=aborted
                // emittiert (resultEventIdRef.current). Verwende es
                // damit Reload + Live-Stream nicht doppelt rendern.
                id: resultEventIdRef.current ?? nextId('assistant'),
                role: 'assistant',
                content: abortedTurn.text.trim() || '(Abgebrochen)',
                tools: abortedTurn.tools,
                ts: new Date().toISOString(),
              };
              setHistory((h) => {
              const next = upsertHistoryItem(h, assistantMsg);
              writeHistoryFor(currentWorkspace.id, next);
              return next;
            });
            }
            break;
          }
          case 'error':
          default: {
            // H1-Fix: Turn endet mit Fehler → agentStatus geht auf 'error',
            // NICHT auf 'idle'. Der Queue-Flush-Effect feuert nur bei 'idle',
            // also würden eingereihte Nachrichten ewig hängen (Stop-Button ist
            // bei error nicht sichtbar → kein manuelles Leeren möglich). Wir
            // verwerfen die Queue deterministisch und zeigen einen Hinweis,
            // wenn etwas eingereiht war.
            if (messageQueueRef.current.length > 0) {
              const dropped = messageQueueRef.current.length;
              messageQueueRef.current = [];
              setQueueLength(0);
              const hintId = `sys-queue-dropped-${Date.now()}-${Math.random()
                .toString(36)
                .slice(2, 8)}`;
              const hint: SystemItem = {
                id: hintId,
                role: 'system',
                kind: 'queue-dropped',
                content:
                  '<surface:toast>' +
                  JSON.stringify({
                    variant: 'err',
                    iconGlyph: '!',
                    title: 'Warteschlange verworfen',
                    body: `Der Turn endete mit einem Fehler — ${dropped} eingereihte Nachricht${dropped > 1 ? 'en wurden' : ' wurde'} nicht gesendet. Bitte erneut tippen.`,
                  }) +
                  '</surface:toast>',
                severity: 'warn',
                ts: new Date().toISOString(),
              };
              setSystemMessages((prev) => {
                const nextSys = [...prev, hint];
                return nextSys.length > 30 ? nextSys.slice(-30) : nextSys;
              });
            }

            // Bug-Fix 2026-04-25: vorher ging die Stream-Antwort komplett
            // verloren wenn outcome=error (z.B. SSE abrupt-close, late
            // upstream-Fehler nach den meisten Token). Symmetrisch zu
            // 'aborted': wenn schon Text/Tools angesammelt wurden, persistiere
            // sie als assistant-Message statt sie zu droppen.
            //
            // Phase RL 2026-04-28: Rate-Limit-Pattern im Content erkennen
            // und durch erklärenden Toast ersetzen (statt nackter Anthropic-
            // Error-Text). Pattern matched Anthropic-CLI-typische Strings.
            const rawText = agentTurnRef.current.text.trim();
            const isRateLimited =
              /temporarily limiting requests|rate.?limited|usage_limit|too many requests/i.test(
                rawText,
              );
            if (isRateLimited) {
              // Phase RL.2 (2026-04-28): Auto-Retry-Card mit 30s-Countdown.
              // Reichen `value` (= original User-Prompt) + attempt-counter
              // an die Card. Bei Klick auf "Jetzt erneut" oder bei
              // Countdown-End ruft die Card SurfaceAction.reply(prompt)
              // → der Provider in ChatShell triggert submit() auf die
              // Original-Frage. Max 2 Auto-Retries — dann manuell.
              const attempts = (lastRetryAttemptsRef.current.get(value) ?? 0) + 1;
              lastRetryAttemptsRef.current.set(value, attempts);
              const MAX_AUTO_RETRIES = 2;
              if (attempts > MAX_AUTO_RETRIES) {
                const toastPayload = JSON.stringify({
                  variant: 'err',
                  iconGlyph: '!',
                  title: 'Anhaltend gedrosselt',
                  body:
                    'Auch nach 2 Versuchen drosselt Anthropic. Bitte 5-10 Min warten oder die Frage anders formulieren.',
                });
                const toastMsg: HistoryItem = {
                  id: resultEventIdRef.current ?? nextId('assistant'),
                  role: 'assistant',
                  content: `<surface:toast>${toastPayload}</surface:toast>`,
                  ts: new Date().toISOString(),
                };
                setHistory((h) => {
                  const next = upsertHistoryItem(h, toastMsg);
                  writeHistoryFor(currentWorkspace.id, next);
                  return next;
                });
                break;
              }
              const retryPayload = JSON.stringify({
                prompt: value,
                attempt: attempts,
                maxAttempts: MAX_AUTO_RETRIES,
              });
              const retryCard: HistoryItem = {
                id: resultEventIdRef.current ?? nextId('assistant'),
                role: 'assistant',
                content: `<surface:rate-limit-retry>${retryPayload}</surface:rate-limit-retry>`,
                ts: new Date().toISOString(),
              };
              setHistory((h) => {
                const next = upsertHistoryItem(h, retryCard);
                writeHistoryFor(currentWorkspace.id, next);
                return next;
              });
              break;
            }
            if (rawText.length > 0 || agentTurnRef.current.tools.length > 0) {
              const assistantMsg: HistoryItem = {
                // B5-fix: gleicher Pfad wie 'ok' und 'aborted' — der
                // Server hat das Event mit outcome=error bereits unter
                // resultEventIdRef.current persistiert.
                id: resultEventIdRef.current ?? nextId('assistant'),
                role: 'assistant',
                content: rawText || '(Stream unterbrochen)',
                tools: agentTurnRef.current.tools,
                ts: new Date().toISOString(),
              };
              setHistory((h) => {
              const next = upsertHistoryItem(h, assistantMsg);
              writeHistoryFor(currentWorkspace.id, next);
              return next;
            });
            } else {
              // Bug 1 Fix (2026-05-30, Owner „der Chat verliert komplett den
              // Kontext"): wenn der Turn MIT Fehler endete, aber WEDER Text
              // NOCH Tools angesammelt hat (z.B. `done{is_error}` ohne ein
              // einziges Token — genau der „Eigenes Video"-Freitext-Fall),
              // landete bisher NICHTS in der History → der User sah nur die
              // rote globale Banner-Zeile und seine eigene Bubble ohne
              // Antwort, was sich wie „Kontext weg" anfühlt. Wir hängen jetzt
              // eine fail-soft Assistant-Karte mit der ECHTEN Ursache an
              // (agentError, nicht mehr generisch). Der Konversations-Faden
              // (History/Workspace/Flow) bleibt damit erhalten und sichtbar
              // beantwortbar — der User kann direkt weiterschreiben.
              const reason =
                agentErrorRef.current ??
                'Der Agent konnte diese Antwort nicht abschließen. Tipp einfach erneut — dein Kontext bleibt erhalten.';
              const failSoftMsg: HistoryItem = {
                id: resultEventIdRef.current ?? nextId('assistant'),
                role: 'assistant',
                content: `<surface:toast>${JSON.stringify({
                  variant: 'err',
                  iconGlyph: '!',
                  title: 'Antwort unterbrochen',
                  body: reason,
                })}</surface:toast>`,
                ts: new Date().toISOString(),
              };
              setHistory((h) => {
                const next = upsertHistoryItem(h, failSoftMsg);
                writeHistoryFor(currentWorkspace.id, next);
                return next;
              });
            }
            break;
          }
        }
       } finally {
         // C2-Fix: Inflight-Lock IMMER zurücksetzen — auch bei throw aus
         // sendAgent (sollte nicht passieren, send() fängt intern, aber
         // defensiv). Damit kann der Queue-Flush-Effect (oder ein neuer
         // direkter submit) sauber den nächsten Turn starten.
         submitInflightRef.current = false;
       }
      })();

      return undefined;
    },
    [
      // M1-Fix: history + agentTurn NICHT mehr in den deps — werden über
      // historyRef/agentTurnRef gelesen. Damit wird submit bei SSE-Burst
      // nicht ständig neu erzeugt (stabiler submitRef, kein Flush-Race).
      currentWorkspace.id,
      isMockPending,
      isStreaming,
      nextId,
      sendAgent,
      showHistory,
      // UX-1: Pill-Routing-Inputs (Antwort-Verzweigung im submit-Handler).
      pillExpanded,
      openQuestions,
      qIndex,
      resetPillState,
    ],
  );

  // submitRef für Queue-Flush-Effect — stable reference ohne circular deps.
  useEffect(() => {
    submitRef.current = submit;
  }, [submit]);

  // ---- Bug-2-Fix: Stop + Interrupt-Send · 2026-05-25 -------------------
  const handleStop = useCallback(() => {
    abortAgent();
    // Queue leeren beim expliziten Stop — User hat den Stream abgebrochen,
    // die wartenden Messages sind damit vermutlich veraltet / unerwünscht.
    // (User kann sie erneut eintippen wenn er sie doch noch will.)
    messageQueueRef.current = [];
    setQueueLength(0);
  }, [abortAgent]);

  const handleSendNow = useCallback(
    (raw: string) => {
      const value = raw.trim();
      if (value.length === 0) return;
      // C1-Fix: Queue ZUERST leeren, DANN abortAgent(). Sonst gibt es ein
      // Doppel-Send-Race: abortAgent() löst die Status-Transition auf 'idle'
      // aus → der Queue-Flush-Effect könnte eine noch-gefüllte Queue shiften
      // + senden, WÄHREND handleSendNow auch sendet. Reihenfolge:
      //   1) Queue leeren (Flush-Effect findet nichts mehr)
      //   2) abortAgent() (Status → idle, Flush-Effect ist jetzt no-op)
      //   3) den neuen Turn als setTimeout(0) einleiten
      messageQueueRef.current = [];
      setQueueLength(0);
      abortAgent();
      // Direkt senden: kurzes setTimeout(0) damit der AbortController
      // den Status auf 'idle' setzen kann bevor submit() prüft isStreaming.
      // queueMicrotask wäre auch korrekt — setTimeout(0) ist robuster
      // gegen iOS-Event-Loop-Quirks.
      window.setTimeout(() => {
        submitRef.current?.(value);
      }, 0);
    },
    [abortAgent],
  );

  // ---- Phase 1 Track AB · Befund B: Strukturiertes Answer-Envelope --------
  // 2026-05-29 (verbatim Handoff §7):
  //
  //   „Antworten auf Fragen werden zu einem Textblock 'Frage:.../Antwort:...'
  //    gebaut und als normaler Chat-Turn gesendet. Es ist unklar bzw.
  //    unwahrscheinlich, dass workstreamId, flowRunId, planId, questionSetId
  //    und questionId zuverlässig mitgesendet werden."
  //
  // Owner-Direktive (verbatim, additiv): „Die lesbare Chat-Nachricht darf
  // zusätzlich existieren. Die Ausführung darf aber nicht an dieser Chat-
  // Nachricht hängen."
  //
  // → Wir POSTen das strukturierte Envelope an `/api/chat/answer` PARALLEL
  // zum bestehenden Chat-Turn (buildQAReply via submitRef). Der Endpoint
  // persistiert in `question_answers` (Migration 0117), idempotent via
  // UNIQUE(content_hash) + UNIQUE(source_turn_id, question_id).
  //
  // Fire-and-forget, fail-soft: 401/Network/500 sind no-ops für den User-Flow.
  // sourceTurnId = ChatShell-internal HistoryItem.id (über nextId('user') erzeugt).
  //
  // Welche Fragen werden gepostet?
  //   ALLE OpenQuestions, für die `answers[q.id]` definiert ist (also: in der
  //   aktuellen Pill-Session beantwortet). Optionale Felder (flowRunId/planId/
  //   questionSetId/surfaceId) sind heute noch nicht im ChatShell-State
  //   verfügbar → fail-soft auf null (Endpoint akzeptiert null). Diese Felder
  //   werden vom OpenQuestions-Renderer/Producer befüllt, sobald sie im
  //   Payload landen — heute reisen sie noch nicht mit, der strukturierte
  //   Speicher ist trotzdem korrekt indiziert (workspaceId + questionId).
  const postStructuredAnswers = useCallback(
    (
      qs: ReadonlyArray<OpenQuestion>,
      answers: Record<string, string>,
      sourceTurnId: string,
    ) => {
      if (typeof window === 'undefined') return;
      const wsId = currentWorkspace.id;
      const wsForBind = agentTurn.workstreamId ?? null;
      for (const q of qs) {
        const a = answers[q.id];
        if (a === undefined) continue;
        const envelope = {
          workspaceId: wsId,
          workstreamId: wsForBind,
          // Optionals — heute noch nicht im ChatShell-State; werden befüllt,
          // sobald der Producer sie ins OpenQuestion-Payload aufnimmt.
          flowRunId: null,
          planId: null,
          questionSetId: null,
          questionId: q.id,
          answer: a, // VERBATIM (N1)
          sourceTurnId,
          surfaceId: null,
        };
        try {
          void fetch('/api/chat/answer', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify(envelope),
            // keepalive damit der POST nicht stirbt wenn der User direkt
            // nach dem Submit navigiert (analog dismiss-route).
            keepalive: true,
          }).catch(() => {
            /* fail-soft — strukturierter Speicher ist nicht user-facing */
          });
        } catch {
          /* fail-soft — niemals den UI-Flow blockieren */
        }
      }
    },
    [currentWorkspace.id, agentTurn.workstreamId],
  );

  // Stabiler Ref-Update (siehe Deklaration oben + Submit-Closure-Aufruf).
  useEffect(() => {
    postStructuredAnswersRef.current = postStructuredAnswers;
  }, [postStructuredAnswers]);

  // ---- UX-1: Pill-Action-Handler · 2026-05-26 -------------------------
  // Diese leben außerhalb des submit-Handlers, damit der Options-Klick exakt
  // dieselbe Antwort-Logik wie der Freitext-Enter nutzt (set → advance → wenn
  // alle beantwortet: ein finaler reply). Kein Doppel-Send: der finale reply
  // läuft über submitRef (der Streaming selbst erneut prüft).
  // Options-Klick in der Pill = Antwort auf die geklickte Frage (dieselbe
  // routePillAnswer-Logik wie der Freitext-Enter). Setzt Antwort, springt zur
  // nächsten offenen Frage, oder feuert den finalen reply wenn alle beantwortet.
  const handlePillSelectOption = useCallback(
    (qId: string, option: string) => {
      const qs = openQuestions;
      if (qs.length === 0) return;
      const route = routePillAnswer(qs, qAnswersRef.current, qIndex, qId, option);
      setQAnswers(route.nextAnswers);
      if (route.allAnswered) {
        const qaText = buildQAReply(qs, route.nextAnswers);
        // Phase 1 Track AB · Befund B: strukturiertes Envelope PARALLEL zum
        // Chat-Turn. sourceTurnId = der noch-nicht-existierende User-Turn,
        // der gleich via submitRef.current?.(qaText) entsteht — wir
        // generieren den ID vorab (gleiche Quelle: nextId('user')) und
        // posten sofort. Der echte HistoryItem wird im submit-Pfad mit
        // einem unabhängigen ID erstellt (kein Conflict — der User-Turn-ID
        // und der Antwort-Envelope-ID dürfen unterschiedlich sein, der
        // Envelope braucht nur EINEN stabilen Anker für Idempotenz).
        const turnAnchor = nextId('user');
        postStructuredAnswers(qs, route.nextAnswers, turnAnchor);
        resetPillState();
        queueMicrotask(() => {
          submitRef.current?.(qaText);
        });
        return;
      }
      setQIndex(route.nextIndex);
    },
    [openQuestions, qIndex, resetPillState, postStructuredAnswers, nextId],
  );

  // "Antworten absenden"-Button: finaler reply über alle beantworteten Fragen.
  const handlePillSubmitAll = useCallback(() => {
    const qs = openQuestions;
    if (qs.length === 0) return;
    const answersNow = qAnswersRef.current;
    const answeredCount = qs.filter((q) => answersNow[q.id] !== undefined).length;
    if (answeredCount === 0) return;
    const qaText = buildQAReply(qs, answersNow);
    // Phase 1 Track AB · Befund B: strukturiertes Envelope PARALLEL.
    const turnAnchor = nextId('user');
    postStructuredAnswers(qs, answersNow, turnAnchor);
    resetPillState();
    queueMicrotask(() => {
      submitRef.current?.(qaText);
    });
  }, [openQuestions, resetPillState, postStructuredAnswers, nextId]);

  const handlePillNavigate = useCallback((index: number) => {
    setQIndex(index);
  }, []);

  const handlePillToggleExpand = useCallback((next: boolean) => {
    setPillExpanded(next);
  }, []);

  // ---- W4 (2026-05-28): Pill-Dismiss-Handler ---------------------------
  // OWNER-SPEC D: „manueller Dismiss pro Frage". Klick auf das ×-Symbol einer
  // Pill-Karte → diese eine Frage aus dem Pill-State entfernen + fail-soft
  // einen `workstream_decisions`-Audit-Row schreiben (N8 — Trace ist Evidence,
  // nicht Telemetry). Der DB-Write läuft als „best-effort"-POST auf
  // `/api/chat/open-questions/dismiss`: 401/Network/500 sind no-ops für den
  // User-Flow — die UI-Removal passiert unabhängig.
  //
  // DECISION-KIND: `override` (siehe API-Route — Enum 0071 hat keinen
  // dedizierten `question-dismissed`-Wert).
  //
  // CONTEXT-RESOLUTION:
  //  - workstreamId: bevorzugt aus dem Live-`agentTurn.workstreamId`. Wenn der
  //    Live-Turn schon idle ist, fällt das Backend auf `no-workstream`
  //    (fail-soft, 200 mit ok=false) — die UI räumt trotzdem auf.
  const handlePillDismiss = useCallback(
    (qId: string) => {
      // Frage-Text festhalten BEVOR wir den State ändern — sonst kommt der
      // Text nicht mehr in den Audit-Rationale (N1, verbatim).
      const dismissed = openQuestions.find((q) => q.id === qId);
      const dismissedText = dismissed?.text;

      // UI-Update: id raus, Signatur an Rest anpassen (kein Re-Pop desselben
      // Sets — Population-Effect-Guard).
      setOpenQuestions((prev) => {
        const remaining = prev.filter((q) => q.id !== qId);
        if (remaining.length === prev.length) return prev;
        lastQSignatureRef.current =
          remaining.length === 0 ? null : remaining.map((q) => q.id).join('|');
        // Wenn die dismissed-Frage die aktuell sichtbare war, qIndex auf den
        // sicheren Bereich klemmen — die Pill clamped intern auch, aber so
        // bleibt der State konsistent fürs nächste Submit.
        if (qIndex >= remaining.length && remaining.length > 0) {
          setQIndex(remaining.length - 1);
        }
        return remaining;
      });

      // Audit-Write fire-and-forget. workstreamId ist optional — wenn der
      // Live-Turn idle ist (kein agentTurn.workstreamId), liefert der Server
      // `ok:false, reason:'no-workstream'` (kein Fehler-Toast). NICHT awaiten.
      const wsForAudit = agentTurn.workstreamId;
      if (typeof window !== 'undefined') {
        try {
          void fetch('/api/chat/open-questions/dismiss', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              workstreamId: wsForAudit ?? null,
              questionId: qId,
              questionText: dismissedText ?? null,
            }),
            // keepalive damit der Audit-POST auch nicht stirbt wenn der User
            // direkt danach navigiert.
            keepalive: true,
          }).catch(() => {
            /* fail-soft — Audit-Verlust ist nicht user-facing */
          });
        } catch {
          /* fail-soft — niemals den UI-Flow blockieren */
        }
      }
    },
    [openQuestions, qIndex, agentTurn.workstreamId],
  );

  // ---- Phase Reload-Recovery V2 · 2026-04-27 -------------------------
  // Aktionen fuer eine `aborted`-StreamingBubble.
  //
  // - regenerateFromSnapshot: legt den User-Prompt der vorherigen Bubble
  //   in das Eingabefeld zurueck (Edit-then-Send, siehe Recovery-Syn
  //   "Offene Fragen" → Tendenz: Edit). Plus discard, damit User nicht
  //   nach Erfolg eine zweite "abgebrochen"-Bubble stehen hat.
  //
  // - discardSnapshot: DELETE-Call an den Backend-Endpoint und das Item
  //   aus dem State entfernen.
  //
  // TODO(backend): DELETE `/api/chat/snapshot/[pendingPromptId]` muss
  // existieren. Bis dahin: optimistisch lokal entfernen + writeHistoryFor.
  const findUserPromptBefore = useCallback(
    (assistantItem: HistoryItem): string | null => {
      const idx = history.findIndex((m) => m.id === assistantItem.id);
      if (idx <= 0) return null;
      for (let i = idx - 1; i >= 0; i -= 1) {
        const candidate = history[i];
        if (candidate && candidate.role === 'user') {
          return candidate.content ?? null;
        }
      }
      return null;
    },
    [history],
  );

  const regenerateFromSnapshot = useCallback(
    (item: HistoryItem) => {
      const prompt = findUserPromptBefore(item);
      if (prompt) {
        setInput(prompt);
      }
      // Snapshot lokal entfernen — sobald User submit drueckt, kommt
      // ein frischer Stream + frisches completed-Event. Backend-DELETE
      // best-effort.
      void deleteSnapshotFromBackend(item, currentWorkspace.id);
      setHistory((h) => {
        const next = h.filter((m) => m.id !== item.id);
        writeHistoryFor(currentWorkspace.id, next);
        return next;
      });
    },
    [currentWorkspace.id, findUserPromptBefore],
  );

  const discardSnapshot = useCallback(
    (item: HistoryItem) => {
      void deleteSnapshotFromBackend(item, currentWorkspace.id);
      setHistory((h) => {
        const next = h.filter((m) => m.id !== item.id);
        writeHistoryFor(currentWorkspace.id, next);
        return next;
      });
    },
    [currentWorkspace.id],
  );

  // Codex-Parität (Goal 2026-06-02): „Neu generieren" auf einer fertigen
  // Assistant-Antwort. Findet den vorhergehenden User-Prompt und führt ihn
  // erneut aus (frischer Turn). Guard gegen Doppel-Submit während ein Stream
  // läuft — sonst konkurrieren zwei Turns um denselben Workspace.
  const regenerateAssistant = useCallback(
    (item: HistoryItem) => {
      if (isStreaming || serverStreamPending) return;
      const prompt = findUserPromptBefore(item);
      if (prompt && prompt.trim().length > 0) {
        submit(prompt);
      }
    },
    [isStreaming, serverStreamPending, findUserPromptBefore, submit],
  );

  // ---- Scroll-Position-Restore (Reload-Recovery V2) ------------------
  // Spec aus Punkt 6 der Synthesis:
  //   - aktiver Stream existiert → ans Ende springen
  //   - nur aborted → sessionStorage-Position wiederherstellen
  // Die Default-WhatsApp-Logik (siehe oben) springt schon ans Ende wenn
  // nearBottom; hier ergaenzen wir nur den Restore-Fall.
  const scrollRestoredRef = useRef(false);
  useEffect(() => {
    if (!hydrated) return;
    if (scrollRestoredRef.current) return;
    if (history.length === 0) return;
    scrollRestoredRef.current = true;

    const hasActiveStream = history.some((it) => it.streamState === 'streaming');
    const hasAbortedOnly =
      !hasActiveStream && history.some((it) => it.streamState === 'aborted');

    const el = streamRef.current;
    if (!el) return;

    if (hasActiveStream) {
      el.scrollTop = el.scrollHeight;
      return;
    }
    if (hasAbortedOnly) {
      try {
        const key = `lazyos.chat.scroll.${currentWorkspace.id}`;
        const raw = window.sessionStorage.getItem(key);
        if (raw) {
          const parsed = Number.parseInt(raw, 10);
          if (Number.isFinite(parsed)) {
            el.scrollTop = parsed;
          }
        }
      } catch {
        /* sessionStorage may be blocked */
      }
    }
  }, [hydrated, history, currentWorkspace.id]);

  // Persistiere Scroll-Position kontinuierlich, damit Restore sie hat.
  useEffect(() => {
    const el = streamRef.current;
    if (!el) return;
    let raf: number | null = null;
    const persist = (): void => {
      if (raf !== null) return;
      raf = window.requestAnimationFrame(() => {
        raf = null;
        try {
          window.sessionStorage.setItem(
            `lazyos.chat.scroll.${currentWorkspace.id}`,
            String(el.scrollTop),
          );
        } catch {
          /* ignore */
        }
      });
    };
    el.addEventListener('scroll', persist, { passive: true });
    return () => {
      el.removeEventListener('scroll', persist);
      if (raf !== null) window.cancelAnimationFrame(raf);
    };
  }, [currentWorkspace.id]);

  // P1 · One-Focal-Point (2026-06-02). Beobachtet im Stream-Container, ob die
  // proaktive SubchatPulse-Karte gerade eine Karte rendert (sie liefert sonst
  // `null`). Erkennung über ihr stabiles `aria-label`-Section — kein Kopplungs-
  // /Prop-Eingriff in SubchatPulse (nicht Teil dieser Slice). Nur aktiv im
  // Empty-State (sonst gibt es keinen Hero zu dämpfen). MutationObserver →
  // reagiert auf das spätere Eintreffen der Karte (15s-Poll/Live-Event), ohne
  // Re-Render-Schleife. Fail-soft: kein Container → Default (kein Effekt).
  const emptyStateActive =
    history.length === 0 && systemMessages.length === 0 && !isPending;
  useEffect(() => {
    if (!emptyStateActive) {
      setPulseCardPresent(false);
      return;
    }
    const el = streamRef.current;
    if (!el || typeof MutationObserver === 'undefined') return;
    const SELECTOR = 'section[aria-label="Neues aus deinen Kundenchats"]';
    const check = (): void => {
      setPulseCardPresent(el.querySelector(SELECTOR) !== null);
    };
    check();
    const obs = new MutationObserver(check);
    obs.observe(el, { childList: true, subtree: true });
    return () => obs.disconnect();
  }, [emptyStateActive]);

  const clearHistory = useCallback(() => {
    setHistory([]);
    try {
      window.localStorage.removeItem(historyKeyFor(currentWorkspace.id));
      // Auch live-snapshot wegwerfen — sonst kommt beim Re-Mount der
      // Mid-Stream-Recovery-Effect und "stellt" eine alte assistant-message
      // wieder her, was der User als "wieder da nach Verlauf leeren" sieht.
      clearLiveFor(currentWorkspace.id);
    } catch {
      // ignore
    }
    // Server-seitiger Clear-Marker (2026-06-02): macht „Verlauf leeren"
    // cross-device-persistent. Vorher war es rein client-lokal → die
    // Event-Log-History kam beim Reload / auf anderem Gerät zurück.
    // Append-only (löscht nichts, setzt einen Cutoff) + best-effort:
    // ein Fehler darf den lokalen Clear nicht rückgängig machen.
    try {
      void fetch(
        `/api/chat/history/${encodeURIComponent(currentWorkspace.id)}/clear`,
        { method: 'POST', headers: { accept: 'application/json' } },
      ).catch(() => undefined);
    } catch {
      // ignore
    }
    // Aktiven Stream abbrechen damit er nicht doch noch eine Message pushed.
    abortAgent();
  }, [currentWorkspace.id, abortAgent]);

  // ---- Auto-Projekt-Naht · Empfangsseite (2026-06-02) -----------------
  // Nach dem harten Wechsel in das frisch angelegte Projekt-Workspace liegt der
  // Build-Prompt im sessionStorage. Sobald die neue Seite hydriert ist und auf
  // einem ECHTEN (nicht-virtuellen) Workspace steht, senden wir ihn EINMAL ab →
  // der Agent baut dort (BAU-MODUS + echter Pfad + frische Session). Guard-Ref
  // verhindert Doppel-Submit; kurzer Delay, damit Composer/Session stehen.
  const pendingBuildFiredRef = useRef<string | null>(null);
  useEffect(() => {
    if (!hydrated) return;
    const wsId = currentWorkspace.id;
    if (!wsId || isVirtualWorkspaceId(wsId)) return;
    if (pendingBuildFiredRef.current === wsId) return;
    const pending = takePendingBuild(wsId);
    if (pending && pending.trim().length > 0) {
      pendingBuildFiredRef.current = wsId;
      const t = window.setTimeout(() => submit(pending), 700);
      return () => window.clearTimeout(t);
    }
    return undefined;
  }, [hydrated, currentWorkspace.id, submit]);

  const isConnectionLost = (() => {
    if (agentStatus !== 'error' || !agentError) return false;
    const m = agentError.toLowerCase();
    return (
      m.includes('load failed') ||
      m.includes('networkerror') ||
      m.includes('failed to fetch') ||
      m.includes('abort')
    );
  })();
  const showErrorBanner =
    agentStatus === 'error' && agentError !== null && !isConnectionLost;

  return (
    <SurfaceActionProvider
      reply={submit}
      pushAssistant={(content) => {
        const item: HistoryItem = {
          id: nextId('assistant'),
          role: 'assistant',
          content,
          ts: new Date().toISOString(),
        };
        setHistory((h) => {
          const next = [...h.slice(-(HISTORY_CAP - 1)), item];
          // Synchronous flush: setHistory ist async, useEffect-Persistenz
          // laeuft erst beim nächsten Render. Beim Tab-Switch + sofortigem
          // Re-Mount kann das Surface verloren gehen. Daher direkt schreiben.
          writeHistoryFor(currentWorkspace.id, next);
          return next;
        });
      }}
    >
    <PinnedDecisionRegistryProvider pinnedHeadline={pinnedDecisionSig}>
    <RunCockpitRegistryProvider>
    <main style={chatMainStyle}>
      <section style={sectionStyle}>
        <div ref={streamRef} style={streamStyle} aria-busy={isPending}>
          {/*
            2026-05-03 (User-Befund: "tab bar oben ist sinnfrei und nicht
            übersichtlich") — Sticky-Toolbar entfernt. Der Chat IST das
            Command-Center: Slash-Commands im Composer (`clear`, `compact`,
            `session-new`, `stop`) erreichen alle Aktionen direkt. Verlauf
            wird über einen dezenten Inline-Link ganz oben im Stream
            getoggled, nur sichtbar wenn archivierte Items existieren.
          */}
          {(() => {
            const archivedCount = history.reduce(
              (acc, it) => (it.archived ? acc + 1 : acc),
              0,
            );
            if (archivedCount === 0) return null;
            return (
              <button
                type="button"
                className="chat-archive-toggle"
                onClick={() => setShowHistory((v) => !v)}
                aria-pressed={showHistory}
                aria-label={
                  showHistory
                    ? `${archivedCount} ältere Nachrichten ausblenden`
                    : `${archivedCount} ältere Nachrichten zeigen`
                }
              >
                <span aria-hidden="true">
                  {showHistory ? (
                    <IconChevronDown size={12} />
                  ) : (
                    <IconChevronRight size={12} />
                  )}
                </span>
                <span>
                  {showHistory
                    ? `${archivedCount} alte ausblenden`
                    : `${archivedCount} alte zeigen`}
                </span>
              </button>
            );
          })()}
          {/* User-Wunsch 2026-05-01: "Push-Popup muss IMMER beim ersten
              PWA-Öffnen kommen". Inline-Surface-Card, KEIN Overlay
              (Sub-Plan-3-Konform). Self-gates: rendert nur wenn
              Permission='default' + nicht prompted + PWA/Desktop. */}
          <PushAutoPrompt
            vapidPublicKey={process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? ''}
          />
          {/* Gathering-Intelligence (2026-06-02): proaktive Sub-Chat-Karte.
              AGGREGIERT workspace-übergreifend (der Hauptchat sitzt auf dem
              Org-Root, Kundenchats hängen an realen Kunden-Workspaces) — taucht
              oben im Feed auf, sobald in IRGENDEINEM Kundenchat etwas Neues von
              extern ankommt. Rendert sich selbst weg, wenn nichts Neues da ist
              (kein Chrome im leeren Chat). Immer gemountet. */}
          <SubchatPulse onPickUp={handleSubchatPickUp} />
          {history.length === 0 && systemMessages.length === 0 && !isPending ? (
            // P1: liegt die proaktive Pickup-/INTERN-Karte vor, wird der Hero
            // zur ruhigen top-verankerten Intro herabgestuft (eine primäre
            // Fläche pro Screen — die Karte darüber führt).
            <EmptyState deEmphasized={pulseCardPresent} />
          ) : (
            <Chat>
              {/*
                Bug B Fix 2026-04-26: Chronologisches Interleaving statt
                "history-Block + systemMessages-Block". Vorher landeten
                Workstream-Toasts IMMER unten, egal wann sie zeitlich
                passierten. Jetzt: Eine sortierte Liste, jedes Item
                rendert nach seiner role.

                Sub-Plan B · 2026-04-29: Filter wendet showHistory an.
                Default (showHistory=false) blendet alle archivierten Items
                aus. SystemItems sind transient und nie archiviert — sie
                werden immer angezeigt.
              */}
              {(() => {
                type RenderItem = (HistoryItem & { _kind: 'history' }) | (SystemItem & { _kind: 'system' });
                // Sub-Plan A + B · 2026-04-29 — Render-Filter:
                //   chatItems = history.filter(item => showHistory || !item.archived)
                // showHistory kommt aus Sub-Plan B's State (Toggle-Pill).
                const visibleHistory = showHistory
                  ? history
                  : history.filter((it) => !it.archived);
                const merged: RenderItem[] = [
                  ...visibleHistory.map((m): RenderItem => ({ ...m, _kind: 'history' })),
                  ...systemMessages.map((s): RenderItem => ({ ...s, _kind: 'system' })),
                ];
                merged.sort((a, b) => {
                  const am = Date.parse(a.ts);
                  const bm = Date.parse(b.ts);
                  if (!Number.isFinite(am) || !Number.isFinite(bm)) return 0;
                  return am - bm;
                });
                return merged.map((it) => {
                  if (it._kind === 'system') {
                    return (
                      <MsgSystem
                        key={it.id}
                        kind={it.kind}
                        ts={formatEventTs(Date.parse(it.ts))}
                        severity={it.severity}
                        href={it.href}
                        onDismiss={() => dismissSystem(it.id)}
                      >
                        {/* SystemItems sind transient und werden nicht
                            ge-cached — Renderer fällt auf seinen eigenen
                            Regex-Pfad zurück (parsed=undefined). */}
                        <TextWithHighlights text={it.content} />
                      </MsgSystem>
                    );
                  }
                  // Sub-Plan B · 2026-04-29: Archivierte Items werden bei
                  // showHistory=true mit gedämpftem Look gerendert (opacity
                  // 0.6 + linker grauer Border). Keine Animation, keine
                  // Modal-Layer — nur visueller Hint "das ist alter Kontext".
                  const archivedWrapStyle: CSSProperties | undefined =
                    it.archived
                      ? {
                          opacity: 0.6,
                          borderLeft: '2px solid var(--line-2)',
                          paddingLeft: 8,
                          marginLeft: -10,
                        }
                      : undefined;
                  if (it.role !== 'user') {
                    // Phase Reload-Recovery V2 · 2026-04-27.
                    // Wenn das Item aus einem streaming_snapshot kommt
                    // (streamState gesetzt), rendere die spezielle
                    // StreamingBubble statt der normalen Assistant-Bubble.
                    if (it.streamState !== undefined) {
                      const bubble = (
                        <StreamingBubble
                          key={it.id}
                          state={it.streamState}
                          partialContent={it.partialContent ?? it.content ?? ''}
                          inCodeBlock={it.inCodeBlock === true}
                          toolState={it.toolState ?? null}
                          onRegenerate={() => regenerateFromSnapshot(it)}
                          onDiscard={() => discardSnapshot(it)}
                          // onCopy: Komponente macht das selbst via navigator.clipboard.
                        />
                      );
                      return archivedWrapStyle ? (
                        <div key={`wrap-${it.id}`} style={archivedWrapStyle}>
                          {bubble}
                        </div>
                      ) : (
                        bubble
                      );
                    }
                    const assistantNode = (
                      <AssistantItem
                        key={it.id}
                        message={it}
                        parsed={parsedItems.get(it.id)}
                        pinnedQuestionIds={pinnedQuestionIds}
                        onRegenerate={() => regenerateAssistant(it)}
                      />
                    );
                    return archivedWrapStyle ? (
                      <div key={`wrap-${it.id}`} style={archivedWrapStyle}>
                        {assistantNode}
                      </div>
                    ) : (
                      assistantNode
                    );
                  }
                  const senderLabel = userActorLabel(it.actor);
                  // Follow-up-Fix (2026-05-26): Die gesendete User-Bubble muss
                  // Surfaces RENDERN, nicht als Rohtext zeigen. Bei einem
                  // Attachment-Send enthält `it.content` ein
                  // `<surface:document>…</surface:document>` (+ Caption) — ohne
                  // Surface-Parsing bliebe das literaler Text und der Anhang
                  // wäre in der Bubble unsichtbar (kein Thumbnail/keine Karte).
                  // Wir routen daher über denselben surface-aware Renderer wie
                  // beim Assistant — aber NUR wenn das Item tatsächlich Surfaces
                  // hat, damit reine Text-Messages bit-genau wie bisher rendern
                  // (kein ungewolltes Markdown auf User-Eingaben).
                  const userParsed = parsedItems.get(it.id);
                  const userHasSurfaces =
                    (userParsed?.surfaces.length ?? 0) > 0;
                  const userNode = (
                    <MsgUser
                      key={it.id}
                      timestamp={it.ts}
                      senderLabel={senderLabel}
                    >
                      {userHasSurfaces ? (
                        <TextWithHighlights
                          text={it.content}
                          surfaces={userParsed?.surfaces}
                        />
                      ) : (
                        it.content
                      )}
                    </MsgUser>
                  );
                  return archivedWrapStyle ? (
                    <div key={`wrap-${it.id}`} style={archivedWrapStyle}>
                      {userNode}
                    </div>
                  ) : (
                    userNode
                  );
                });
              })()}
              {isStreaming ? (
                <StreamingAssistant
                  turn={agentTurn}
                  agentStatus={agentStatus}
                  isMockPending={isMockPending}
                  serverStreamPending={serverStreamPending}
                />
              ) : null}
              {/*
                Typing-Pill-Dedupe (2026-05-03): TypingIndicator NUR rendern
                wenn weder StreamingAssistant noch ein BugFixSwarmCard / SubAgentCard
                in der gleichen Konversation Phase-Text + Caret zeigt. Sonst
                sah der User parallel: TopNav-Pulse + StreamingAssistant-Caret
                + Phase-Dots + dieser eigene Indicator = 3-4× "schreibt gerade".
                Regel: passive Mock/Server-Pending UND kein aktives isStreaming.
              */}
              {!isStreaming && (isMockPending || serverStreamPending) ? <TypingIndicator /> : null}
              {/*
                Inline-Worker-Status (2026-05-03): zeigt ANDERE laufende
                Workstreams im selben Workspace direkt im Chat. Mobile-Boost
                weil TopNav-Pulse-Pill auf Phone schwer findbar war.
                Filtert den eigenen aktiven Workstream raus, sonst doppelt
                mit StreamingAssistant.
              */}
              <div style={{ display: 'flex', justifyContent: 'center' }}>
                <InlineWorkerStatus
                  workspaceId={currentWorkspace.id}
                  excludeWorkstreamIds={
                    agentTurn.workstreamId ? [agentTurn.workstreamId] : []
                  }
                />
              </div>
            </Chat>
          )}
          {/* Auto-Scroll-End-Marker (Sub-Plan 01 v3 2026-04-29).
              scrollIntoView auf diesem leeren div = WhatsApp-Standard. */}
          <div
            ref={streamEndRef}
            aria-hidden="true"
            style={{ height: 1, width: '100%' }}
          />
          {/*
            WhatsApp-Style Floating-Down-Button. Nur sichtbar wenn der User
            nach oben gescrollt hat UND eine neue Message reinkam.
          */}
          {showScrollDown ? (
            <button
              type="button"
              onClick={scrollToBottom}
              aria-label="Nach unten scrollen"
              style={scrollDownBtnStyle}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>
          ) : null}
        </div>

        <div style={composerWrapStyle}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
              gap: 8,
              flexWrap: 'nowrap',
              maxWidth: '100%',
              marginBottom: 10,
            }}
          >
            <ChatTopBar workspaceId={currentWorkspace.id} variant="compact" />
            {/* Vollzugriff/All-Access-Toggle direkt neben der Engine-Pill
                (Owner-Direktive 2026-05-26). Gleiche workspaceId. */}
            <AllAccessToggle workspaceId={currentWorkspace.id} />
            {/* Gathering-Intelligence (2026-06-02): Zugang zu den Kundenchats.
                Mobil (Owner-Befund „nicht mobiloptimiert"): kompaktes Icon-Only-
                Button statt Label-Pill → passt ohne Umbruch in eine Zeile neben
                Engine-Pill + Vollzugriff. Reale Workspaces → Sub-Chat-Liste; auf
                dem Org-Root → Workspace-Auswahl. */}
            <a
              href={
                subchatsEnabled
                  ? `/workspaces/${encodeURIComponent(currentWorkspace.id)}/subchats`
                  : '/workspaces'
              }
              className="press"
              aria-label="Kundenchats"
              title="Kundenchats"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
                width: 44,
                height: 44,
                background: 'var(--sheet-3, #141416)',
                border: '0.5px solid var(--line-2)',
                borderRadius: 999,
                color: 'var(--ink-2)',
                textDecoration: 'none',
              }}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
              </svg>
            </a>
          </div>

          {/* Slice 2 (2026-05-30, Apple-UX): ActionDeck — EINE gepinnte Region.
              Gate (DB-Projektion, Owner-Befund #1) ODER die bestehende Q/A-Pille
              (UX-1, Codex-Stil) — NIE beide gleichzeitig (Gate hat Vorrang).
              Gleiche DOM-Position/composerWrap wie zuvor → Flexbox-Pinning
              unberührt. Frage-Pfad = heutige Pille 1:1 (Nav/Optionen/Dismiss/
              ask-but-proceed alles erhalten). Gate-Aktion → ChatShell (single
              submit path), kein Doppel-Routing. */}
          <ActionDeck
            pinned={pinnedItem}
            onGateAction={handleGateAction}
            onResume={handleResume}
            actionMissKind={deckActionMiss}
            pillQuestions={openQuestions}
            pillProps={{
              answers: qAnswers,
              currentIndex: qIndex,
              expanded: pillExpanded,
              onSelectOption: handlePillSelectOption,
              onNavigate: handlePillNavigate,
              onToggleExpand: handlePillToggleExpand,
              onSubmitAll: handlePillSubmitAll,
              // Workstream 4b (2026-05-27): ask-but-proceed-Signal. Der Run gilt
              // als „läuft weiter", solange gestreamt wird ODER der Server-Stream
              // noch pending ist (parallele Arbeit nach der Frage).
              runActive: isStreaming || serverStreamPending,
              // W4 (2026-05-28): manueller Dismiss pro Frage. Rendert das ×-
              // Symbol in der Pill; Klick entfernt die Karte + schreibt fail-
              // soft einen workstream_decisions-Audit-Row (override).
              onDismiss: handlePillDismiss,
            }}
          />

          {/* STAGING (Owner-Hard-Requirement 2026-05-26): fixierte Anhang-
              Vorschau ÜBER dem Composer. Datei(en) bleiben hier sichtbar bis
              Absenden ODER ×; währenddessen kann der User Caption tippen. */}
          <StagedAttachmentsBar
            attachments={stagedAttachments}
            onRemove={handleRemoveStaged}
            uploadingName={cloudUpload.uploading ? cloudUpload.currentFilename : null}
          />

          {/* Composer bleibt während des Uploads BEDIENBAR — der User soll
              die Caption tippen können, während die Datei hochlädt (Staging-
              Modell). Nur der Paperclip-Button disabled sich selbst via
              `uploading`. Der Input ist nie hart gelockt. */}
          <ChatComposer
            value={input}
            onChange={setInput}
            onSubmit={submit}
            disabled={false}
            placeholder="Sag mir etwas …"
            sttSupported={sttSupported}
            sttListening={sttListening}
            sttInterim={sttInterim}
            onSttToggle={toggleStt}
            workspaceId={currentWorkspace.id}
            suggestions={effectiveSuggestions}
            activeSuggestIndex={activeSuggestIndex}
            onSuggestHover={setActiveSuggestIndex}
            onSuggestSelect={handleSuggestSelect}
            onSuggestNavigate={handleSuggestNavigate}
            onUploadFiles={handleUploadFiles}
            uploading={cloudUpload.uploading}
            isStreaming={isStreaming}
            onStop={handleStop}
            onSendNow={handleSendNow}
            queueLength={queueLength}
          />

          {/*
            Engine-Pill-Dedup (2026-05-23 · User-Feedback "Absolute Katastrophe").
            VORHER: zweite EnginePill UNTER dem composer (Selector mit
            Parallel/Claude/Codex/Ollama-Dropdown). PARALLEL existierte ÜBER
            dem composer bereits ChatTopBar (Display: Modell + CTX + Turns).
            NACHHER: ChatTopBar IST jetzt die einzige Pill und vereint
            Display + Selector in EINEM pill (siehe ChatTopBar.tsx). Diese
            Stelle bleibt absichtlich leer als Marker für die Dedup-Decision.
          */}

          {sttError ? (
            <div role="alert" style={sttErrorStyle}>
              {formatSttError(sttError)}
            </div>
          ) : null}

          {/*
            Welle 1 · 2026-05-03 · Sub-Plan dazzling-quilt
            ----------------------------------------------------------------
            stream-footer ENTFERNT — der Block hatte den Phase-Text + Dots
            dupliziert, die schon in der StreamingAssistant-Bubble stehen.
            User-Frust 2026-05-03: "auf app.laz.ing ist immer noch
            redundant". Single-Source-of-Truth jetzt: useTypingIndicator
            in StreamingAssistant. Der Stop-Button lebt jetzt als kleines
            floating Pill am rechten Rand der Live-Bubble (siehe
            `.bub-live__stop` / `srf-stop-pill` in app/components.css).
          */}

          {showErrorBanner ? (
            <div role="alert" style={errorBannerStyle}>
              Stream-Fehler: {agentError}
            </div>
          ) : null}

          {isConnectionLost ? (
            <div role="status" style={connectionLostStyle}>
              Verbindung zur Antwort verloren — der Agent läuft im Hintergrund weiter.
              Tipp einfach neu, oder lade die Seite.
              <button
                type="button"
                onClick={resetAgent}
                style={resetBtnStyle}
                aria-label="Schließen"
              >
                <IconClose size={16} />
              </button>
            </div>
          ) : null}

          {history.length > 0 ? (
            <div style={{ marginTop: 14, textAlign: 'right' }}>
              <button type="button" onClick={clearHistory} style={clearBtnStyle}>
                Verlauf leeren
              </button>
            </div>
          ) : null}

          {migrationFailed && !migrationDone ? (
            <div role="status" style={connectionLostStyle}>
              Sync pausiert — versuche neu zu verbinden …
              <button
                type="button"
                onClick={() => setMigrationRetryTick((n) => n + 1)}
                style={resetBtnStyle}
                aria-label="Sync jetzt erneut versuchen"
              >
                <IconRefresh size={16} />
              </button>
            </div>
          ) : null}
        </div>
      </section>
    </main>
    </RunCockpitRegistryProvider>
    </PinnedDecisionRegistryProvider>
    </SurfaceActionProvider>
  );
}

// ---------------------------------------------------------------------
// Inline-Icon (lokal, KEINE Cross-File-Änderung): Sync-Retry-Refresh.
// SVG, currentColor, 1.6 stroke, round caps — erbt resetBtnStyle.color.
// ---------------------------------------------------------------------
function IconRefresh({ size = 16 }: { size?: number }): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable={false}
    >
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 4v5h-5" />
    </svg>
  );
}

// Clock/Timer-Glyph für den Turn-Footer (ersetzt den vorigen Timer-Emoji).
// Gleiche 24×24-currentColor-1.6-Stroke-Familie wie die Nav-Icons.
function IconClock({ size = 12 }: { size?: number }): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable={false}
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

// ---------------------------------------------------------------------
// Assistant renderers (unverändert gegenüber vorher)
// ---------------------------------------------------------------------

function AssistantItem({
  message,
  parsed,
  pinnedQuestionIds,
  onRegenerate,
}: {
  message: HistoryItem;
  /**
   * Codex-Parität (2026-06-02) — „Neu generieren" für diese Antwort
   * (führt den vorhergehenden User-Prompt erneut aus). Weglassen blendet den
   * Regenerate-Button aus; Copy bleibt immer verfügbar.
   */
  onRegenerate?: () => void;
  /**
   * Sub-Plan E (2026-04-30) — Pre-geparste Surface-Liste. Wenn der
   * augmented-Content gleich dem Original ist, reichen wir das Cache-
   * Array an renderChatText durch. Bei Augmentation (synthesis-fallback)
   * fallen wir auf den Regex-Pfad zurück, weil der Cache zum Original
   * gehört, nicht zum augmented String.
   */
  parsed?: ParsedHistoryItem;
  /**
   * Bug-5-Fix (2026-05-30) — IDs der aktuell in der Pille gepinnten Fragen.
   * Der inline-Surface-/Markdown-Zwilling dieser Fragen wird aus der Bubble
   * gestript (Dedup; die Pille ist die kanonische interaktive Quelle).
   */
  pinnedQuestionIds?: ReadonlySet<string>;
}) {
  // Phase AC Fallback (2026-04-26): Wenn das HistoryItem eine Synthesis
  // ist (Pattern "## Konsolidierter Plan" / "## Sub-Tickets") aber KEINEN
  // <surface:consensus-action>-Tag enthaelt (alte Bubble vor v42), client-
  // side den Tag anhaengen damit der SurfaceRenderer die Card rendert.
  // Ohne dieses Augment muesste der User die alte Bubble nicht-actionable
  // anschauen + zum Master navigieren.
  const augmentedBase = augmentSynthesisIfNeeded(message);
  // Bug-5-Fix: gepinnte Frage-Surfaces aus der Bubble strippen. Wenn etwas
  // gestript wurde, ist der Cache (startIdx/endIdx) nicht mehr gültig → wir
  // erzwingen den Re-Scan-Pfad (cacheSurfaces=undefined).
  const stripped =
    pinnedQuestionIds && pinnedQuestionIds.size > 0
      ? stripPinnedQuestionSurfaces(augmentedBase, pinnedQuestionIds)
      : { content: augmentedBase, changed: false };
  const augmentedContent = stripped.content;
  // Cache nur nutzen wenn Content unverändert blieb (= kein Augment-Suffix
  // UND kein Strip). Sonst liegen Surface-Indizes daneben.
  const cacheSurfaces =
    parsed !== undefined &&
    augmentedContent === message.content &&
    !stripped.changed
      ? parsed.surfaces
      : undefined;

  // Codex-Parität (2026-06-02): Prosa-Text für die Copy-Aktion — Surface-Tags
  // (Toasts/Karten/Pläne) entfernen, damit „Kopieren" die lesbare Antwort
  // liefert, nicht `<surface:toast>{…}</surface:toast>`. Hat eine Antwort KEINE
  // Prosa (reine Karte), bleibt die Action-Row aus.
  const proseForCopy = augmentedContent
    .replace(/<surface:[^>]*>[\s\S]*?<\/surface:[^>]*>/g, '')
    .replace(/<surface:[^>]*\/>/g, '')
    .trim();
  const actions =
    proseForCopy.length > 0 ? (
      <MessageActions copyText={proseForCopy} onRegenerate={onRegenerate} />
    ) : null;

  if (message.tools && message.tools.length > 0) {
    return (
      <>
        <ToolPipeline tools={message.tools} />
        {augmentedContent.length > 0 ? (
          <MsgAssistant>
            <TextWithHighlights text={augmentedContent} surfaces={cacheSurfaces} />
            {message.durationMs !== undefined ? (
              <TurnFooter
                durationMs={message.durationMs}
                toolCount={message.tools.length}
              />
            ) : null}
            {actions}
          </MsgAssistant>
        ) : null}
      </>
    );
  }

  // Bug-5-Fix: Wenn das Strippen der gepinnten Frage-Surface die Bubble LEER
  // gelassen hat (sie bestand nur aus der Frage, die jetzt in der Pille lebt),
  // rendern wir KEINE leere Assistant-Karte. Nur relevant wenn tatsächlich
  // gestript wurde — sonst bleibt das alte Verhalten bit-genau erhalten.
  const showBubble = !(stripped.changed && augmentedContent.length === 0);

  return (
    <>
      {showBubble ? (
        <MsgAssistant>
          <TextWithHighlights text={augmentedContent} surfaces={cacheSurfaces} />
          {actions}
        </MsgAssistant>
      ) : null}
    </>
  );
}

// Phase AC Fallback (2026-04-26): Wenn message ein Synthesis-Output ist
// und keinen consensus-action-Tag hat, client-side den Tag basierend auf
// Konsens-Heuristik appenden. Side-effect-frei (gibt augmented String).
function augmentSynthesisIfNeeded(message: HistoryItem): string {
  if (message.role !== 'assistant') return message.content;
  const c = message.content;
  // Bereits augmented?
  if (c.includes('<surface:consensus-action>')) return c;
  // Synthesis-Pattern? Heuristik: enthaelt "## Konsolidierter Plan" oder
  // "## Sub-Tickets" oder "## Cluster-".
  const isSynth =
    /##\s+Konsolidierter\s+Plan/i.test(c) ||
    /##\s+Sub-Tickets/i.test(c) ||
    /##\s+Cluster-/i.test(c);
  if (!isSynth) return c;
  // Workstream-/Master-IDs aus dem Content extrahieren — wir haben sie
  // hier nicht direkt. Fallback: leerer workstreamId, Card rendert dann
  // nichts (Renderer requires workstreamId). Diese Augmentation hilft
  // also primaer fuer Live-Events wo der Tag schon im handleEvent-Pfad
  // gesetzt wurde — fuer alte Bubbles ohne Workstream-ID-Marker bleibt
  // die Card aus, der User sieht "nur" den Plan-Text. Nicht ideal, aber
  // robust: kein blinder Auto-Dispatch mit unbekannter Workstream-ID.
  return c;
}

/**
 * Live-Streaming-Assistant — token-by-token Display fuer native Chat-Feeling.
 *
 * 2026-05-01 (Welle Streaming-UX):
 *  - Inline-Styles raus, ueber `.bub-live` + `.bub-caret` aus components.css.
 *  - Sub-tile fade-in pro Token-Append via `.bub-live__token-fresh` (key wechselt
 *    bei Text-Length-Change, sodass nur das letzte Chunk re-animiert).
 *  - Phase-Footer mit Lese-Bewusstsein:
 *      - vor First-Token:        "Liest deine Frage …"
 *      - waehrend Token-Stream:  "Schreibt …"
 *      - waehrend Tool-Pipeline: "Sucht in Workspace-Daten …" / Tool-spezifisch
 *  - prefers-reduced-motion respected (CSS).
 */
function StreamingAssistant({
  turn,
  agentStatus,
  isMockPending,
  serverStreamPending,
}: {
  turn: AssistantTurn;
  agentStatus: 'idle' | 'connecting' | 'streaming' | 'error' | 'not_configured';
  isMockPending: boolean;
  serverStreamPending: boolean;
}) {
  const showText = turn.text.trim().length > 0;
  const hasTools = turn.tools.length > 0;

  // Welle 1 · 2026-05-03: Single-Source-of-Truth fuer Phase + Label.
  // Loest die alte lokale describePhase-Logik ab. Konsumenten der Bubble
  // bekommen jetzt EINEN deterministischen State statt drei parallel
  // gerechneten Strings.
  const indicator = useTypingIndicator({
    workstreamId: turn.workstreamId,
    isStreaming: true, // diese Bubble wird nur gerendert wenn isStreaming=true
    isMockPending,
    serverStreamPending,
    agentTurn: { text: turn.text, tools: turn.tools },
    agentStatus,
  });
  const phase: TypingPhase = indicator.phase ?? 'reading';
  const phaseLabel = indicator.label;

  // Subtle token-fade: sobald sich `text.length` aendert, wechselt der React-key
  // an einem unsichtbaren Wrapper um den letzten Char-Block. Wir reanimieren
  // nicht den ganzen Text — sonst flackert die Bubble bei jedem Token-Tick.
  // Trick: split an dem letzten Whitespace-Boundary; alles davor ist statisch,
  // der Tail-Slice (max 24 chars) bekommt die fade-in-Klasse.
  const tail = showText ? extractFreshTail(turn.text) : null;

  return (
    <>
      {hasTools ? <ToolPipeline tools={turn.tools} rail /> : null}
      <div
        className="bub-live msg-a"
        data-phase={phase}
        role="status"
        aria-live="polite"
        aria-label="Assistant schreibt"
      >
        {/*
          2026-05-04: Stop-Button RAUS aus der Bubble (User-Befund:
          "verbuggtes surface mit stop button drin, sieht katastrophal
          aus, kein steve jobs apple design"). iMessage-Pattern: clean
          Bubble, Stop wandert in den Composer (Send-Button morpht zu
          Stop-Square während Streaming). `onAbort` ist via Composer
          verdrahtet, hier ist nur visuell weg.
        */}
        <div className="txt">
          {showText && tail ? (
            <>
              <TextWithHighlights text={tail.head} />
              {tail.fresh.length > 0 ? (
                <span key={turn.text.length} className="bub-live__token-fresh">
                  {tail.fresh}
                </span>
              ) : null}
            </>
          ) : null}
          {/*
            Caret-Dedupe (2026-05-03): leading-Caret entfernt — wenn der Assistant
            noch keinen Text hat, sind die typing-dots + phase-text unten bereits
            der Aktivitäts-Indikator. Doppel-Anzeige (Caret + Dots + "Liest …")
            wirkte als "3-fach schreibt gerade". Trailing-Caret zeigt nur während
            echtem Token-Stream.
          */}
          {showText ? <span aria-hidden="true" className="bub-caret" /> : null}
        </div>
        <div
          className="bub-live__phase"
          data-tone={phase === 'connecting' ? 'idle' : 'active'}
        >
          {phase === 'writing' ? null : (
            <span className="typing-dots" aria-hidden="true">
              <span className="typing-dots__dot" />
              <span className="typing-dots__dot" />
              <span className="typing-dots__dot" />
            </span>
          )}
          <span>{phaseLabel}</span>
        </div>
      </div>
    </>
  );
}

// describePhase + toolPhaseLabel: 2026-05-03 nach lib/chat/useTypingIndicator.ts
// migriert. Single-Source-of-Truth fuer Phase-Label. Diese Datei haelt nur
// noch die JSX-Komponente.

/**
 * Token-Tail-Splitter: gibt den statischen `head` und den frischen `fresh`-Slice
 * zurueck, sodass nur das letzte Chunk re-animiert wird. Splitet am letzten
 * Whitespace innerhalb der letzten 24 Zeichen; Fallback: alles ist `head`.
 */
function extractFreshTail(text: string): { head: string; fresh: string } {
  const FRESH_MAX = 24;
  if (text.length <= FRESH_MAX) return { head: '', fresh: text };
  const tailRegion = text.slice(-FRESH_MAX);
  const wsIdx = tailRegion.search(/\s\S*$/);
  if (wsIdx === -1) {
    // Kein Whitespace im Tail-Bereich -> langes Wort, fade nicht
    return { head: text, fresh: '' };
  }
  const splitAt = text.length - FRESH_MAX + wsIdx + 1;
  return { head: text.slice(0, splitAt), fresh: text.slice(splitAt) };
}

/**
 * Rendert Assistant-Text mit inline Surface-Cards + **bold**-Highlights.
 *
 * Agent emittet `<surface:chart>{...}</surface:chart>` Tags in seinem
 * Output → wir zerlegen das hier in Text + Surface-Segmente.
 *
 * Sub-Plan E (2026-04-30): Optional `surfaces`-Prop ist eine bereits
 * pre-geparste Liste aus `parseHistoryItem` (Cache-Pfad). Wenn nicht
 * gesetzt, fällt `renderChatText` auf seinen internen Regex-Scan zurück.
 */
function TextWithHighlights({
  text,
  surfaces,
}: {
  text: string;
  surfaces?: readonly import('./replace-logic').ParsedSurface[];
}) {
  return <>{renderChatText(text, surfaces)}</>;
}

function TurnFooter({
  durationMs,
  toolCount,
}: {
  durationMs: number;
  toolCount: number;
}) {
  const seconds = durationMs / 1000;
  const dur = seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
  return (
    <div style={turnFooterStyle}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        <IconClock size={12} />
        {dur}
        {toolCount > 0 ? ` · ${toolCount} Tool${toolCount === 1 ? '' : 's'}` : null}
      </span>
    </div>
  );
}

function TypingIndicator() {
  // Welle 4 (2026-05-01): typing-dots auf .typing-dots CSS-Klasse mit
  // @keyframes typing-pulse umgestellt (siehe components.css B'').
  // Token-bind, prefers-reduced-motion respected.
  return (
    <div
      className="msg-a"
      role="status"
      aria-label="Assistant schreibt …"
      style={{ opacity: 0.65 }}
    >
      <div className="txt typing-dots">
        <span className="typing-dots__dot" aria-hidden="true" />
        <span className="typing-dots__dot" aria-hidden="true" />
        <span className="typing-dots__dot" aria-hidden="true" />
      </div>
    </div>
  );
}

/**
 * Empty-State — radikal minimal.
 * Ein Satz. Kein Kicker, kein Tipp, kein Chip.
 */
/**
 * P1 · One-Focal-Point (2026-06-02, UI/UX-a11y-Pass).
 *
 * Eine primäre Aufgabe pro Screen. Liegt eine proaktive Pickup-/INTERN-Karte
 * (SubchatPulse) über dem Empty-State, darf der zentrierte Hero nicht mit ihr
 * um den Fokus konkurrieren. `deEmphasized=true` verankert die Intro oben mit
 * großzügigem Abstand (kleiner, linksbündig, gedämpft) — die Karte darunter
 * liest als die EINE primäre Fläche. Ohne Karte bleibt der ruhige, zentrierte
 * Hero. Reiner Stil-Swap, kein Verhaltens-/Text-Verlust.
 */
function EmptyState({ deEmphasized = false }: { deEmphasized?: boolean }) {
  return (
    <div style={deEmphasized ? emptyDeEmphStyle : emptyStyle}>
      <h2
        className="t-h2"
        style={deEmphasized ? emptyHeadingDeEmphStyle : emptyHeadingStyle}
      >
        Sprich mit dem{' '}
        <em style={{ fontStyle: 'italic', fontWeight: 300, color: 'var(--ink-2)' }}>
          Betriebssystem
        </em>
        .
      </h2>
    </div>
  );
}

function formatSttError(code: string): string {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'Mikrofon-Zugriff wurde verweigert. Prüfe die Berechtigungen.';
    case 'no-speech':
      return 'Nichts gehört — versuch es noch einmal.';
    case 'audio-capture':
      return 'Kein Mikrofon gefunden.';
    case 'network':
      return 'Netzwerkfehler bei der Spracherkennung.';
    case 'not-supported':
      return 'Spracherkennung wird von diesem Browser nicht unterstützt. Tippe deinen Prompt.';
    case 'insecure-context':
      return 'Spracheingabe braucht HTTPS. Tippe deinen Prompt.';
    case 'pwa-standalone-unsupported':
      return 'Spracheingabe ist in der installierten App auf iOS nicht verfügbar. Öffne die Seite im Browser oder tippe deinen Prompt.';
    default:
      return `Spracheingabe fehlgeschlagen (${code}).`;
  }
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

/**
 * Phase Reload-Recovery V2 · 2026-04-27.
 * Best-effort DELETE des Streaming-Snapshots im Backend. Das Snapshot-
 * Item kommt im History-Endpoint als HistoryItem mit `streamState`-Feld;
 * pendingPromptId steht im Item-Feld. Wir feuern einen DELETE-Call ab
 * und ignorieren das Ergebnis (optimistisch im UI entfernt).
 *
 * TODO(backend): Implementiere `DELETE /api/chat/snapshot/[pendingPromptId]`
 * mit Auth-Gate (gleicher Cookie-Pattern wie /api/chat/history). Bis dahin
 * antwortet der Endpoint 404 und wir behandeln das wie ein noop.
 */
async function deleteSnapshotFromBackend(
  item: HistoryItem,
  workspaceId: string,
): Promise<void> {
  const pid = item.pendingPromptId;
  if (!pid) return;
  try {
    await fetch(`/api/chat/snapshot/${encodeURIComponent(pid)}`, {
      method: 'DELETE',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        'x-lazyos-workspace': workspaceId,
      },
    });
  } catch {
    /* offline / 404 — UI ist bereits optimistisch geupdated */
  }
}

function isHistoryItem(v: unknown): v is HistoryItem {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  const roleOk = o.role === 'user' || o.role === 'assistant';
  const toolsOk =
    o.tools === undefined ||
    (Array.isArray(o.tools) &&
      o.tools.every((s: unknown) => {
        if (!s || typeof s !== 'object') return false;
        const x = s as Record<string, unknown>;
        return (
          typeof x.id === 'string' &&
          typeof x.name === 'string' &&
          typeof x.status === 'string'
        );
      }));
  return (
    typeof o.id === 'string' &&
    roleOk &&
    typeof o.content === 'string' &&
    typeof o.ts === 'string' &&
    toolsOk
  );
}

// ---------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------

// Chat-Page belegt die volle Viewport-Höhe so dass der Stream-Container
// scrollt, NICHT die Page. Das löst den iOS-Bug "am Scroll-Top zieht
// die Bewegung den Body": wenn die Page selbst kein Scroll mehr hat,
// kann iOS auch nicht in sie hinein-bouncen. TopNav-Höhe wird via CSS-
// Variable kompensiert (gesetzt in TopNav-Mount; Fallback 64px).
// Robust-Layout: main fuellt Viewport zwischen TopNav und Bottom-Edge.
// KEIN .sheet-Klasse (deren Padding war Quelle vieler iOS-Glitches).
// containment isoliert das Layout vom restlichen DOM — kein Bleeding.
const chatMainStyle: CSSProperties = {
  height: 'calc(100dvh - var(--topnav-h, 64px))',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  contain: 'layout',
  paddingTop: 8,
  paddingBottom: 'env(safe-area-inset-bottom, 0px)',
};

const sectionStyle: CSSProperties = {
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  maxWidth: 860,
  width: '100%',
  margin: '0 auto',
  padding: '0 clamp(12px, 4vw, 32px)',
  minHeight: 0,
  // 2026-04-26 — relative damit der Floating-Down-Button darin
  // absolut positioniert werden kann.
  position: 'relative',
};

// WhatsApp-Style Floating-Down-Button. Unten links, ueber dem Composer,
// erscheint nur wenn der User nach oben gescrollt hat und neue Messages
// reinkommen.
const scrollDownBtnStyle: CSSProperties = {
  position: 'absolute',
  left: 'clamp(20px, 4vw, 40px)',
  bottom: 8,
  zIndex: 5,
  width: 36,
  height: 36,
  borderRadius: '50%',
  background: 'var(--sheet-2)',
  border: '0.5px solid var(--line-2)',
  color: 'var(--ink-2)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'pointer',
  boxShadow: '0 6px 16px rgba(0,0,0,0.35)',
  backdropFilter: 'blur(8px)',
  WebkitBackdropFilter: 'blur(8px)',
};

// Stream: nimmt verfuegbare Hoehe, scrollt als einzige Surface.
// contain:strict isoliert Layout/Paint - keine Scroll-Anker-Sprunge,
// keine Layout-Bleeds nach aussen.
const streamStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  overflowX: 'hidden',
  paddingRight: 4,
  overscrollBehavior: 'contain',
  WebkitOverflowScrolling: 'touch',
  touchAction: 'pan-y',
  overflowAnchor: 'none',
};

const composerWrapStyle: CSSProperties = {
  marginTop: 10,
  flexShrink: 0,
};

const emptyStyle: CSSProperties = {
  marginTop: 28,
  padding: 'clamp(32px, 6vw, 64px) clamp(20px, 4vw, 40px)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  minHeight: 240,
};

const emptyHeadingStyle: CSSProperties = {
  fontSize: 'clamp(24px, 3.4vw, 32px)',
  maxWidth: 560,
  letterSpacing: '-0.02em',
  textAlign: 'center',
  lineHeight: 1.2,
  color: 'var(--ink)',
  margin: 0,
};

// P1 · de-emphasized Empty-State: oben verankert, großzügiger Abstand, kein
// minHeight-Block — die proaktive Karte darunter ist die EINE primäre Fläche.
const emptyDeEmphStyle: CSSProperties = {
  marginTop: 8,
  padding: 'clamp(16px, 3vw, 28px) clamp(20px, 4vw, 40px) clamp(20px, 4vw, 32px)',
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'flex-start',
};

// Kleiner + gedämpft (ink-2) + linksbündig → liest als ruhige Intro, nicht als
// konkurrierender Hero. N1: identischer Text, nur visuelles Gewicht reduziert.
const emptyHeadingDeEmphStyle: CSSProperties = {
  fontSize: 'clamp(18px, 2.4vw, 22px)',
  maxWidth: 560,
  letterSpacing: '-0.015em',
  textAlign: 'left',
  lineHeight: 1.25,
  color: 'var(--ink-2)',
  margin: 0,
};

const clearBtnStyle: CSSProperties = {
  background: 'transparent',
  border: '0.5px solid var(--line-2)',
  color: 'var(--ink-3)',
  padding: '6px 12px',
  borderRadius: 999,
  fontSize: 12,
  letterSpacing: '-0.01em',
  cursor: 'pointer',
  fontFamily: 'inherit',
};

const errorBannerStyle: CSSProperties = {
  marginTop: 14,
  padding: '10px 14px',
  borderRadius: 10,
  border: '0.5px solid var(--a-danger)',
  background: 'color-mix(in oklab, var(--a-danger) 10%, transparent)',
  color: 'var(--ink)',
  fontSize: 13,
  lineHeight: 1.5,
};

const connectionLostStyle: CSSProperties = {
  marginTop: 10,
  padding: '8px 12px 8px 14px',
  borderRadius: 10,
  border: '0.5px solid var(--line-2)',
  // Opaque (war 70%/transparent) — Parent-Bleed-Fix (Sweep 2026-05-01)
  background: 'var(--sheet-2)',
  color: 'var(--ink-2)',
  fontSize: 12,
  lineHeight: 1.5,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  justifyContent: 'space-between',
};

const resetBtnStyle: CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: 'var(--ink-3)',
  cursor: 'pointer',
  padding: 4,
  fontSize: 14,
  fontFamily: 'inherit',
};

// streamFooterStyle / streamingDotStyle / streamingTextStyle / stopBtnStyle
// sind in `.stream-footer*` (components.css) gewandert
// (2026-05-01 Welle Streaming-UX).

const turnFooterStyle: CSSProperties = {
  marginTop: 8,
  fontSize: 11,
  color: 'var(--ink-3)',
  fontFamily: 'var(--font-mono)',
};

const sttErrorStyle: CSSProperties = {
  marginTop: 10,
  fontSize: 12,
  color: 'var(--a-danger)',
  textAlign: 'center',
  letterSpacing: '-0.005em',
};
