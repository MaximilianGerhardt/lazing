'use client';

import Link from 'next/link';
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
// Gathering-Intelligence (2026-06-02): pull sub-chats into the main chat —
// proactive card on new customer activity + a subtle entry point on the composer
// line. Only for real workspaces (org-root/virtual has no sub-chats).
import { SubchatPulse } from './SubchatPulse';
// UX-1 (2026-05-26): Q/A pill above the composer (bottom-action UX, Codex style).
import {
  ChatOpenQuestionsPill,
  routePillAnswer,
  dedupeQuestionIds,
} from './ChatOpenQuestionsPill';
import {
  splitOpenQuestionsSection,
  type PlanQuestion,
} from '../workstreams/parse-plan-questions';
// Slice 2 (2026-05-30, Apple-UX): ActionDeck — the ONE pinned bottom region.
// Wraps the pill; pins blocking gates (owner finding #1) via the DB
// projection (single submit path, gate action delegated to ChatShell).
import { ActionDeck, executeGateAction } from './ActionDeck';
import {
  useWorkspaceState,
  selectPinnedItem,
  pinnedDecisionSignature,
} from './useWorkspaceState';
import type { BlockingGateState } from '../projection/types';
// Workstream 4b (2026-05-27): open-questions lifecycle extracted into a
// pure, testable helper. Population from BOTH sources (surface tag +
// markdown section), over the ENTIRE history + the running turn — so a
// question emitted in ask-but-proceed mode stays pinned at the BOTTOM, instead of
// scrolling away with the stream.
import {
  collectOpenQuestionsFromHistory,
  detectResolvedAndStaleQuestions,
  extractOpenQuestionsFromContent,
  mergeQuestionEnrichmentsById,
  type OpenQuestion,
  type OpenQuestionsSourceItem,
} from './open-questions-lifecycle';
// The engine pill (selector) now lives fused into ChatTopBar — see pill-dedup
// 2026-05-23. The old EnginePill component stays in the repo as an orphan, because
// it could potentially be referenced on other surfaces (lab, onboarding);
// but it is no longer mounted in the chat surface.
// import { EnginePill, type EngineMode } from './EnginePill';
// 2026-05-03: ChatHeaderToolbar + SessionControls removed — the chat is the
// command center, slash commands in the composer suffice. Imports archived
// for a possible re-activation as pure modules without UI render.
// import { ChatHeaderToolbar } from './ChatHeaderToolbar';
// import { SessionControls } from './SessionControls';
import { ChatTopBar } from './ChatTopBar';
// All-Access-Toggle (2026-05-26): „Vollzugriff" pill NEXT TO the engine pill
// (ChatTopBar). Switches the workspace permission mode freerein↔ask; the
// live-chat spawn (server/workspace-session.ts) reads this mode.
import { AllAccessToggle } from './AllAccessToggle';
import { PushAutoPrompt } from '@/lib/pwa/PushAutoPrompt';
import { InlineWorkerStatus } from './InlineWorkerStatus';
// 2026-04-29: ActiveWorkstreamBanner / WorkflowProgressPanel /
// OpenQuestionsSurface were parallel overlays — user veto: must go into
// the existing surface library (lib/ui/cht, lib/chat/SurfaceRenderer).
// Imports + mounts removed below.
import { useChatSuggestions, type ChatSuggestion } from './useChatSuggestions';
import { SurfaceActionProvider } from './SurfaceActionContext';
// Owner-Fix Run-Cockpit (2026-05-28) — provider that coordinates the suppress
// logic for the 3 legacy surfaces (sub-workstreams, iterate-pipeline, iterate-
// version) as soon as a `<surface:run-cockpit>` card is active.
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
 * Chat — Apple-pure redesign (2026-04-24).
 *
 * Structure:
 *   [chat stream or empty state]            ← dominates the top
 *   [ChatComposer: input + mic + send]      ← large input field
 *   [stream-stop footer (optional)]
 *   [banners (subtle, below the composer)]
 *
 * Removed compared to the old shell:
 *   - ContextBand line
 *   - segment PillRow
 *   - chat assistant icon in the empty state
 *   - ChatWorkspaceInlineSwitcher (redundant with the header switcher)
 *   - MicButton as a separate button next to the input
 *   - bullet/kicker above the H2
 *
 * Stays:
 *   - per-workspace history (historyKeyFor / read / write + switch effect)
 *   - mock fallback on `not_configured`
 *   - agent stream via useAgentStream
 *   - STT (Web Speech API) — now inline in the composer
 *
 * Storage keys isolated per workspace: `lazyos.chat.history.<wsId>`.
 * The legacy key `lazyos.chat.history` is migrated into the
 * current workspace on the first hydrate.
 * `mock-mode` stays global (UI preference).
 */
const STORAGE_HISTORY_BASE = 'lazyos.chat.history';
const STORAGE_HISTORY_LEGACY = 'lazyos.chat.history';
const STORAGE_MOCK = 'lazyos.chat.mock-mode';
const STORAGE_LIVE_BASE = 'lazyos.chat.live';
const HISTORY_CAP = 60;

/**
 * Appends a HistoryItem OR merges it into an existing item with the same
 * id (P0 fix 2026-06-02, Codex goal — double React-key race).
 *
 * The stream-result branches (ok / aborted / error / rate-limit) append the
 * assistant message under the server ULID `resultEventIdRef.current`. In parallel
 * the live `/api/events/stream` inserts a `chat_message_completed` HistoryItem
 * under the SAME ULID. The live path already dedupes by id; without the
 * symmetric guard here the path that runs last creates a second item
 * with an identical `key={it.id}` → React warning + potentially swallowed/
 * duplicated messages. `upsertHistoryItem` makes both orders idempotent:
 * if the id already exists, it is merged (content/tools of the result branch
 * win), otherwise appended normally (HISTORY_CAP-bounded).
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
 * Phase AC fallback (2026-04-26): client-side consensus detection when the
 * server did not provide a consensus_level in the synthesis payload (old
 * workstreams). Identical heuristic to tier-orchestrator.detectConsensusLevel,
 * so old bubbles get the same card logic as new ones.
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
 * UX-1 (2026-05-26): build the Q&A reply text from answered questions.
 * Identical format to the inline stepper (ChatInlineOpenQuestions) — the
 * agent sees the answers as a compact „Frage: … / Antwort: …" list.
 * Unanswered questions are omitted (cleaner than a „—" placeholder).
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
// Bug-5-Fix · question-3×-in-DOM-dedup · 2026-05-30
// ---------------------------------------------------------------------------
// Live browser finding (verbatim): the same open question appears THREE TIMES —
//   (1) as a markdown section in the assistant bubble (`## Offene Fragen`),
//   (2) as an inline interactive surface (`<surface:open-questions>` /
//       `<surface:prompt variant=…>`),
//   (3) pinned in the pill above the composer.
// The pill is the CANONICAL interactive source (Apple-UX: one primary
// action, pinned at the bottom). Once a question is pinned there, its inline
// twin in the bubble is redundant.
//
// FIX (within the allowed files, without touching replace-logic/surface-text-render):
// we remove the surface/markdown spans belonging to the pinned questions
// from the assistant CONTENT string before it is rendered.
// The renderer re-scans the modified string (the cache is deliberately NOT
// passed, otherwise the `startIdx/endIdx` would leak the raw tag text). Only
// question-carrying surfaces whose question IDs are ALL pinned fall away —
// other surfaces (charts, tier-choice, etc.) stay untouched.
//
// Pure string operation, side-effect-free, idempotent.
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
 * Removes from `content` those question-carrying surface/markdown spans whose
 * questions lie entirely in `pinnedIds` (= currently in the pill). Returns the
 * (possibly modified) string + a `changed` flag. If nothing was stripped,
 * `content` is referentially identical.
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

  // (a) `<surface:open-questions>` — strip if all questions are pinned.
  out = out.replace(OQ_SURFACE_STRIP_RE, (full) => {
    const qs = extractOpenQuestionsFromContent(full);
    if (questionIdsCoveredByPin(qs, pinnedIds)) {
      changed = true;
      return '';
    }
    return full;
  });

  // (b) `<surface:prompt variant=open-questions|plan-questions>` — ditto. Only
  //     question-carrying prompt variants; quickchoice/credential/form stay.
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
    // Read questions directly from the prompt payload (extractOpenQuestionsFromContent
    // only matches `<surface:open-questions>`, not the prompt wrapper).
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

  // (c) markdown `## Offene Fragen` section — only strip if the parsed
  //     questions are all pinned. splitOpenQuestionsSection returns the before/after
  //     around it; we glue before+after back together.
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
// Bug-2-Fix · free-text-answer coupling · 2026-05-30
// ---------------------------------------------------------------------------
// Live browser finding: if the user FREELY types „Eigenes Video" instead of
// clicking an open choice, the text falls through classifyFlowIntent (min 3 words +
// imperative → otherwise 'unknown') into the normal chat stream → the agent throws
// a THIRD picker instead of understanding it as an answer.
//
// Predicate: free text is coupled to the open question when …
//   - no attachments are staged,
//   - the pill is NOT expanded (the pillExpanded path takes precedence),
//   - at least one question is open/pinned,
//   - the input is NOT a slash command,
//   - the input is NOT classified as a confident flow (a deliberately new
//     build like „erstelle eine Webseite" still starts a flow).
// Pure + side-effect-free → directly testable (no ChatShell mount needed).
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
 * 2026-05-28 (W1/W2 — open-questions wiring). Slim array-equality helper
 * for the re-render bail-out in the pill enrichment merge. Pure, inline-capable.
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
/** Live state >60min is discarded (presumably no longer relevant). */
const LIVE_TTL_MS = 60 * 60 * 1000;

function historyKeyFor(workspaceId: string): string {
  return `${STORAGE_HISTORY_BASE}.${workspaceId}`;
}

function liveKeyFor(workspaceId: string): string {
  return `${STORAGE_LIVE_BASE}.${workspaceId}`;
}

interface LiveSnapshot {
  /** ISO timestamp of when the stream started (for TTL). */
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
    // Sub-Plan A · 2026-04-29: hydrate migration. Old persisted items
    // have no workstreamId/surfaceKind field. If the content contains a
    // surface tag with a workstreamId, we backfill the coord.
    // Hint 1 (Sub-Plan A): uses the exported helper from storage.ts
    // — one and the same code path for single-read and server-merge.
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
 * Merge server systemItems with SystemItems that already arrived live.
 * Dedup by id (the server delivers `sys-<event-id>`, the live stream builds the
 * same id via `sys-${ev.id}`). Cap at 30 so unbounded growth
 * does not happen.
 */
/**
 * Phase Reload-Recovery V2 · 2026-04-27.
 * Creates a primitive fingerprint over all streaming-relevant
 * fields in the history array. Used in the polling update to avoid
 * re-renders when nothing streaming-specific changed
 * (a polling tick without a new token otherwise still lands as setHistory →
 * re-render of the whole list).
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
   * Phase MS · 2026-04-26 (B1-fix). Server item: the pendingPromptId from
   * the `chat_message_sent` event payload. Used by
   * `mergeServerWithLocal` to pair local user-echo items with their
   * server-ULID variant — otherwise Max sees two
   * user bubbles (local ID + ULID) instead of one after replay.
   */
  pendingPromptId?: string;
  /**
   * Who sent the message. Default fallback in the renderer:
   *   role=user      -> 'user:max'
   *   role=assistant -> 'agent:claude'
   *
   * If role=user AND actor does NOT start with 'user:' (e.g.
   * 'agent:terminal-claude', 'agent:api', 'system'), ChatShell renders
   * a special bubble with a pill header — otherwise a test/
   * API/script message looks like the user's own input.
   */
  actor?: string;

  // -------------------------------------------------------------------
  // Phase Reload-Recovery V2 · 2026-04-27
  // Fields that are only set for "half-finished" assistant items whose
  // source is a streaming_snapshots row in the backend (not a
  // chat_message_completed event). As long as `streamState` is set,
  // the client polls this endpoint every 2s. On `aborted` the
  // <StreamingBubble/> is rendered instead of a normal bubble.
  //
  // TODO(backend): the backend agent must deliver these fields from the
  // history endpoint once the streaming-snapshot table exists (see
  // /tmp/recovery-syn.txt points 1, 4).
  // -------------------------------------------------------------------

  /** When set: item comes from a snapshot, not from a completed event. */
  streamState?: 'streaming' | 'aborted';
  /** Streaming text so far (from snapshot.partial_content). */
  partialContent?: string;
  /** True when the snapshot is mid-```-code-block (snapshot.in_code_block). */
  inCodeBlock?: boolean;
  /** Pending tool at the snapshot (snapshot.tool_state). */
  toolState?: {
    name: string;
    status: 'pending' | 'done';
    id?: string;
  } | null;
  /** ISO timestamp of the last snapshot update (for the 10s heuristic client-side). */
  snapshotUpdatedAt?: string;

  // -------------------------------------------------------------------
  // Sub-Plan A · 2026-04-29 — one-card-per-workstream-replace
  // -------------------------------------------------------------------
  // When a surface block (e.g. <surface:consensus-action>) carries a
  // workstreamId in its payload, this value + the
  // surface kind are stored here. When appending a NEW bubble
  // with the same (workstreamId, surfaceKind) pair, all previous
  // items with the same coord are marked `archived=true`. This keeps
  // exactly one "living" card per workstream + kind visible in the chat,
  // without deleting old history bubbles (Sub-Plan B
  // brings a history toggle that shows archived items again).
  /** SurfaceKind of the dominant surface block in the content (if one exists). */
  surfaceKind?: import('./surface-parser').SurfaceKind;
  /** workstreamId from the surface payload (if present). */
  workstreamId?: string;
  /** Soft-archive marker: superseded by a newer card with the same (workstreamId, surfaceKind). */
  archived?: boolean;
  /**
   * Sub-Plan A Finding 5 (2026-04-29). Marker that the hydrate migration
   * (backfilling coords from the content) has already run. Prevents
   * every read from running the same regex again.
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
 * Maps an actor string (from chat_message_sent.payload.actor) to a
 * UI-suitable sender label for the user bubble. Returns undefined
 * when the bubble should be rendered normally (without a pill) — i.e. for
 * cookie-auth user prompts and also for old events without an actor field.
 *
 * Non-`user:*` actors lead to a special bubble:
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
  // Current history without a stale closure (for the auto-project seam: the
  // brainstorm context must be carried into the new project workspace).
  const historyForHandoffRef = useRef<HistoryItem[]>([]);
  useEffect(() => {
    historyForHandoffRef.current = history;
  }, [history]);
  const [systemMessages, setSystemMessages] = useState<SystemItem[]>([]);
  // Sub-Plan E (2026-04-30) — single-pass coord cache. Exactly ONE
  // surface scan per item.id. Passed below to `renderChatText(text, surfaces)` as
  // a cache argument so the renderer does not scan again
  // itself. Map<id, ParsedHistoryItem> — a new history → completely
  // re-mapped, but per item the work is deterministically single-pass.
  const parsedItems = useMemo<Map<string, ParsedHistoryItem>>(() => {
    const map = new Map<string, ParsedHistoryItem>();
    for (const item of history) {
      map.set(item.id, parseHistoryItem(item));
    }
    return map;
  }, [history]);
  // Sub-Plan B · 2026-04-29 — history toggle ("focus only" vs. "history on").
  // Default false (focus). Hydrate from localStorage on mount,
  // reset to false on workspace switch, auto-reset on submit.
  const [showHistory, setShowHistory] = useState<boolean>(false);
  // Inert since 2026-06-03 (mock subsystem removed): stays `false`, because
  // `useTypingIndicator` still reads the flag in the live-signal path.
  const isMockPending = false;
  // Phase RL.3 (2026-04-28): server-side stream still running — set when
  // mount/refresh detected that the last chat_message_sent
  // stands without a corresponding _completed (stream not finished).
  // Polls every 5s until an assistant item comes in.
  const [serverStreamPending, setServerStreamPending] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  // Phase MS (P1-3): SSE subscription only AFTER the one-time
  // localStorage→DB migration is done (or it was established that there is nothing
  // to migrate). Otherwise the replay burst from /api/events/
  // stream comes in WHILE the cache IDs are still in the state — the
  // ULID echoes don't match and the user message is rendered twice.
  const [migrationDone, setMigrationDone] = useState(false);
  // B3-fix 2026-04-26: if the migration fails (server 500, offline),
  // useEventStream keeps blocking (migrationDone stays false). This flag
  // signals to the user that something is wrong + allows a manual retry
  // or auto-retry after 30s.
  const [migrationFailed, setMigrationFailed] = useState(false);
  // Auto-retry counter: each increment triggers the migration effect
  // again (even without a workspace switch).
  const [migrationRetryTick, setMigrationRetryTick] = useState(0);

  const currentWorkspace = useCurrentWorkspace();

  // Gathering-Intelligence (2026-06-02): „Im Hauptchat aufgreifen" from the
  // proactive sub-chat card seeds the composer with a ready-made prompt
  // (AI-suggestion style) and focuses the input field — the operator sends
  // with one tap and the main chat works out the matter with RAG knowledge.
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

  // P1 · One-Focal-Point (2026-06-02): whether the proactive SubchatPulse card
  // is REALLY rendering a card right now (it otherwise returns `null`). SubchatPulse
  // does not belong to this slice — instead of coupling it, we observe DOM-
  // side its `<section aria-label="Neues aus deinen Kundenchats">` in the stream
  // container. If present, the centered empty-state hero is downgraded to a quiet
  // top-anchored intro (one primary surface per screen).
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

  // Bug 1 Fix (2026-05-30): stable ref on the most recent agentError, so the
  // async submit handler can write the REAL cause (instead of a
  // stale-closure value) into the fail-soft assistant card in the error branch.
  const agentErrorRef = useRef<string | null>(agentError);
  useEffect(() => {
    agentErrorRef.current = agentError;
  }, [agentError]);

  // ---- Phase MS · 2026-04-26: pendingPromptId set ---------------------
  // IDs that WE just fired ourselves. When the chat_message_sent
  // event comes back over the live event stream with one of these IDs
  // in the payload, we ignore it — otherwise we see our own user
  // message twice.
  const ownPendingIdsRef = useRef<Set<string>>(new Set());

  // Phase RL.2 (2026-04-28): Map<prompt → attempts> for rate-limit auto-retry.
  // The entry is cleared after a successful stream outcome 'ok'.
  const lastRetryAttemptsRef = useRef<Map<string, number>>(new Map());

  // ---- Bug-2-Fix: message queue + interrupt · 2026-05-25 ---------------
  // FIFO queue for messages typed while streaming.
  // Cleared as soon as agentStatus switches to 'idle'.
  // No React state (would trigger the flush effect) — only a ref.
  const messageQueueRef = useRef<string[]>([]);
  // Number of queued messages as React state for the UI (queue chip).
  const [queueLength, setQueueLength] = useState(0);

  // ---- UX-1: Q/A pill state (above the composer) · 2026-05-26 -----------
  // Source: an assistant turn with a `## Offene Fragen` section → we pull
  // the questions up here and mount them as a pill ABOVE the composer (instead of
  // rendering them only inline in the stream as a stepper). The chat input becomes
  // the answer when the pill is expanded (routing in the submit handler).
  // 2026-05-28 (W1/W2): type loosened to `OpenQuestion` (PlanQuestion +
  // optional enrichment fields context/pros/cons/recommendation/evidence).
  // Backward-compat: a PlanQuestion without extras IS a valid OpenQuestion.
  // Used so `enriched` updates can put the extra fields into the state
  // without the pill card switching its identity.
  const [openQuestions, setOpenQuestions] = useState<OpenQuestion[]>([]);
  const [qAnswers, setQAnswers] = useState<Record<string, string>>({});
  const [qIndex, setQIndex] = useState(0);
  const [pillExpanded, setPillExpanded] = useState(false);
  // Signature of the question set last loaded into the pill — prevents
  // a re-load (and thus answer reset) on every re-render of the same turn.
  const lastQSignatureRef = useRef<string | null>(null);
  // Stable ref on qAnswers for the submit handler (no closure stale).
  const qAnswersRef = useRef(qAnswers);
  useEffect(() => {
    qAnswersRef.current = qAnswers;
  }, [qAnswers]);

  // Bug-5-Fix (2026-05-30): IDs of the questions currently pinned in the pill.
  // Passed to AssistantItem so the inline surface/markdown twin
  // of the same question in the bubble is suppressed (the question otherwise appears 3×:
  // bubble markdown + inline surface + pill). Stable per Set, new only when
  // the question IDs change.
  const pinnedQuestionIds = useMemo(
    () => new Set(openQuestions.map((q) => q.id)),
    [openQuestions],
  );

  // Reset the pill state cleanly (after a final submit or hard reset).
  // lastQSignatureRef keeps the last loaded signature so the same
  // turn does not immediately pop up again after closing.
  const resetPillState = useCallback(() => {
    setOpenQuestions([]);
    setQAnswers({});
    setQIndex(0);
    setPillExpanded(false);
  }, []);

  // Phase RL.3 (2026-04-28): polling fallback in case SSE misses the
  // completed event (e.g. a PWA tab switch interrupted the SSE subscription).
  // Refetch /api/chat/history every 10s while serverStreamPending=true.
  // Stop after a maximum of 10min (otherwise endless polling on a stuck stream).
  // Defined inline outside the useEffect because of the cleanup pattern.

  // ---- STT ------------------------------------------------------------
  // inputRef holds the current input value so the onFinal callback
  // decides replace-vs-append correctly, without breaking the stability of
  // the hook.
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

  // STT dual path: Web Speech API (Safari tab, Chrome) when available,
  // otherwise MediaRecorder + server Whisper (iOS PWA, Firefox, fallback).
  const ws = useSpeechRecognition({ lang: 'de-DE', onFinal: handleSttFinal });
  const mr = useMediaRecorderStt({ lang: 'de', onFinal: handleSttFinal });

  const useWebSpeech = ws.isSupported;
  const sttSupported = useWebSpeech ? ws.isSupported : mr.isSupported;
  const sttListening = useWebSpeech ? ws.isListening : mr.isListening;
  const sttInterim: string = useWebSpeech ? ws.interimText : mr.interimText;
  const sttError = useWebSpeech ? ws.error : mr.error;

  const toggleStt = useCallback(() => {
    // Important: do NOT early-return when unsupported — the user clicked,
    // they deserve a visible reaction (the error state in the hook triggers a banner).
    // Web Speech path: if usable, take it. Otherwise always try the MediaRecorder path
    // — MR works practically everywhere getUserMedia works (including iOS PWA).
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

  // ---- Track-D · Stream-B2 · Flow-Studio style-choice wiring -------------
  // `/flow <intent>` → the compose-and-run route replies for media steps
  // (hero video etc.) with status 'needs-style-choice' + 1 quickchoice prompt per
  // step. Here: (1) emit the quickchoice surface(s) as assistant messages
  // (run through the surface-aware renderer → renderQuickChoice),
  // (2) listen for the owner click (window event 'lazyos:quickchoice' { id }),
  // (3) assign the id to its open question (bundled: all questions are
  //     shown at once, each choice collected), (4) once ALL questions
  //     are answered → RE-POST `/api/flow/compose-and-run` WITH styleChoices
  //     (keyed on String(step.idx)) → translate the follow-up status (running / needs-coupling /
  //     needs-style-choice again) again through handleFlowComposeResult.
  //
  // Correlation id→question: the quickchoice renderer fires ONLY { id } (no
  // step context). We take the FIRST still-open prompt whose optionIds
  // contain the clicked id — deterministic in display order. With
  // identical option sets (e.g. two video steps) the owner assigns them in
  // order (fail-soft, no hard uniqueness constraint).
  const flowStyleSessionsRef = useRef<FlowStyleSession[]>([]);

  // Re-POST with the collected style choices, translate the follow-up status again.
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
        // If FURTHER media steps are open after the choice (e.g. the
        // re-compose only now recognized them): start a new session.
        onStyleChoice: (req) => startFlowStyleSessionRef.current?.(req),
        onError: (detail) => pushToast('Flow fehlgeschlagen', detail, 'err'),
      });
    },
    [nextId, setHistory],
  );

  // Stable ref on the session starter (avoids a definition-order
  // cycle between repost ↔ startFlowStyleSession).
  const startFlowStyleSessionRef = useRef<
    ((req: FlowStyleChoiceRequest) => void) | null
  >(null);

  const handleFlowStyleChoice = useCallback(
    (req: FlowStyleChoiceRequest) => {
      if (req.prompts.length === 0) return;
      // 1. Register a session (open prompts + empty choices).
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

      // 2. Per prompt emit a quickchoice surface as an assistant message
      //    (surface-aware renderer → renderQuickChoice; click fires reply +
      //    lazyos:quickchoice). The surface carries the exact payload format from
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

  // 3. Global listener: assigns a clicked option id to its open question,
  //    collects the choice, RE-POSTs as soon as a session is complete.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onQuickChoice = (ev: Event) => {
      const id = (ev as CustomEvent<{ id?: string }>).detail?.id;
      if (typeof id !== 'string' || id.length === 0) return;
      const sessions = flowStyleSessionsRef.current;
      // Pure correlation (id → open question; mutates the matched session).
      const { completedSession, sessionIndex } = correlateQuickChoice(
        sessions,
        id,
      );
      // Session complete → re-post + remove from the active list.
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

  // ---- Image generation: persist the finished image (2026-06-03) ----------
  // The ImageGenCard (surface) dispatches `lazyos:image-gen-done` on success
  // {token, surfaceMarkup}. We replace the <surface:image-gen> loading card
  // (matched via the unique token in the content) with the final
  // <surface:document> image bubble → on reload the history shows the real
  // image (no re-gen). Persisted via writeHistoryFor.
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

  // ---- Inline file upload from the composer ---------------------------
  // STAGING MODEL (owner hard requirement 2026-05-26):
  // A selected file is uploaded, BUT NOT sent immediately.
  // It lands in `stagedAttachments` and is shown as a fixed preview ABOVE
  // the composer (WhatsApp/Telegram style). The user can additionally
  // type text; on send (submit), file(s) + text go out TOGETHER
  // as ONE message (the bubble + agent prompt contain both).
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
      // Successful uploads → into staging (do NOT send).
      if (result.ok.length > 0) {
        setStagedAttachments((prev) => [
          ...prev,
          ...result.ok.map((a) => ({ ...a, workspaceLabel: currentWorkspace.label })),
        ]);
      }
      // Failed uploads → toast in the history (no staging).
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
  // On the first mount:
  //  1) migrate the legacy key (without workspace suffix) into the current
  //     workspace — only if no per-workspace key exists yet.
  //  2) load the history for currentWorkspace.id (instant from localStorage).
  //  3) load the mock mode globally.
  //  4) Phase MS: fetch server history in parallel — the server wins.
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
      // Mock mode is deprecated — proactively delete the old value so
      // existing PWAs get out of mock mode, even if the
      // agent briefly returned 503 (e.g. during a deploy).
      window.localStorage.removeItem(STORAGE_MOCK);
    } catch {
      // ignore corrupt storage
    }
    queueMicrotask(() => {
      if (storedHistory) {
        setHistory(storedHistory);
        idCounter.current = storedHistory.length;
      }
      // 2026-05-03: showHistory is ALWAYS collapsed on mount/workspace-switch
      // (user wish "history collapsed by default"). The persisted
      // value is ignored — the user can expand it per session via the pill,
      // but after a reload/switch it is closed again.
      setShowHistory(false);
      setHydrated(true);
    });

    // Phase MS · server-first refresh. Cached history already hangs in the
    // state (instant), but we want the truth from the DB. On
    // success: the server wins, local in-flight items stay in.
    // On error/offline: cached stays, no user-facing error.
    const ctl = new AbortController();
    void loadHistoryServerFirst(wsId, { limit: 60, signal: ctl.signal })
      .then((res) => {
        const localItems = readHistoryFor(wsId) ?? [];

        // Bug-Fix 2026-05-29 (owner live test): workspace-ID reuse via a
        // label-slug collision could restore old localStorage history for a
        // NEW workspace with the same slug. When the server
        // returns an EMPTY result for this wsId (fresh workspace
        // without chat history in the DB), but localStorage has content →
        // the localStorage stems from an earlier workspace instance with
        // the same slug → must purge + reset state so the
        // owner sees a really empty chat. (The F2 collision protection
        // in the POST route prevents this from 12a73d8 for NEW workspaces,
        // but this mount guard also cleans up existing stale caches.)
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

        // Phase RL.3 (2026-04-28): stream-pending detect. If the LAST
        // history item is a user message AND <10 min old → the server stream
        // is presumably still running. Show the pending indicator, start polling.
        const last = merged[merged.length - 1];
        if (
          last?.role === 'user' &&
          Date.now() - Date.parse(last.ts) < 10 * 60_000
        ) {
          setServerStreamPending(true);
        } else {
          setServerStreamPending(false);
        }

        // 2026-04-26: feed workstream activity from the server (auto_dispatch,
        // stage-comments, pipeline_complete, synthesis) in as SystemItems.
        // This way, after a reload, the user sees the live toasts of the
        // last N events historically in the history, not only live in the SSE.
        if (res.systemItems.length > 0) {
          setSystemMessages((prev) => mergeSystemItems(prev, res.systemItems));
        }
      })
      .catch(() => {
        /* offline / 401 / etc — cached stays in */
      });
    return () => ctl.abort();
    // Only on the first mount; workspace switch runs in the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- workspace switch — isolate history ------------------------------
  // See the previous docs. Core: persist the old history, load the new one,
  // abort the stream, clear the input. `previousWorkspaceIdRef` prevents
  // the persist effect on switch from overwriting the freshly loaded target
  // history with the old one.
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
    // Sub-Plan B · 2026-04-29: on a workspace switch ALWAYS back to
    // focus mode. The persisted value stays in localStorage
    // (the next reload of the same workspace respects it again),
    // but the currently active switch starts in the default.
    setShowHistory(false);
    writeShowHistoryFor(nextId, false);

    queueMicrotask(() => {
      const el = streamRef.current;
      if (el) el.scrollTop = 0;
    });

    const nextHistory = readHistoryFor(nextId);
    setHistory(nextHistory ?? []);
    idCounter.current = nextHistory?.length ?? 0;

    // Bug-3-Fix: snapshot resume on workspace switch · 2026-05-25.
    // If a running LiveSnapshot lies in localStorage for the target workspace
    // (= the stream was active when the user switched away), show the partial
    // state immediately as an in-progress indicator. So no visual
    // tear is visible — the user sees "working" + the text so far at once.
    // No real reconnect of the stream — the stream fetch keeps running in the
    // background (it is bound to the agent-turn fetch, not to workspaceId).
    // serverStreamPending triggers the 10s polling fallback as a safety net.
    const resumeLive = readLiveFor(nextId);
    if (resumeLive) {
      const age = Date.now() - new Date(resumeLive.startedAt).getTime();
      if (age < LIVE_TTL_MS) {
        setServerStreamPending(true);
      } else {
        clearLiveFor(nextId);
      }
    }

    // Phase MS · server refresh after a workspace switch — analogous to the mount
    // effect. Cached renders instantly, the server wins once the answer
    // is there. AbortController prevents race conditions when the user
    // switches again quickly.
    const ctl = new AbortController();
    void loadHistoryServerFirst(nextId, { limit: 60, signal: ctl.signal })
      .then((res) => {
        // Guard: back from the fast switch path; only apply
        // if the user is still on nextId.
        if (previousWorkspaceIdRef.current !== nextId) return;
        const localItems = readHistoryFor(nextId) ?? [];
        const merged = mergeServerWithLocal(res.items, localItems, res.cutoffMs);
        setHistory(merged);
        idCounter.current = merged.length;
        writeHistoryFor(nextId, merged);

        // 2026-04-26: feed workstream system items from the server in for the new
        // workspace. SystemMessages were cleared above.
        if (res.systemItems.length > 0) {
          setSystemMessages(res.systemItems);
        }
      })
      .catch(() => {
        /* offline — cached stays */
      });

    // previousWorkspaceIdRef is deliberately synchronized only by the persist
    // effect — see the docs there.
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


  // Sub-Plan B · 2026-04-29: persist showHistory per workspace.
  // Triggers on every toggle or auto-reset (submit).
  useEffect(() => {
    if (!hydrated) return;
    writeShowHistoryFor(currentWorkspace.id, showHistory);
  }, [showHistory, hydrated, currentWorkspace.id]);

  const isStreaming =
    agentStatus === 'connecting' || agentStatus === 'streaming';

  // ── Slice 2 (2026-05-30, Apple-UX): ActionDeck data source ────────────────
  // DB projection (blockingGates/openQuestions/activeFlowRun) via a member-auth-
  // gated route. Poll 5s + invalidation as soon as the stream ends (isStreaming
  // OR serverStreamPending falls to false → fresh state right after the
  // answer, instead of waiting until the poll tick). A monotonically increasing
  // counter is the invalidation signal: it changes exactly when the
  // run-active state switches.
  const runActiveForDeck = isStreaming || serverStreamPending;
  // refreshSignal MUST increase monotonically (hook doc contract: „monotonically increasing
  // invalidation counter"). Previously binary 0/1 → a second run-active switch
  // in the same direction triggered no re-fetch (docs/code drift). We count
  // every edge (runActive ↔ idle) up — every stream-end transition thus
  // reliably triggers exactly one fresh projection fetch.
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
  // F18 (2026-05-30): the headline of the pinned decision → the
  // PinnedDecisionRegistryProvider stills the same-named feed card
  // (no two loud copies). Null when no decision gate is pinned.
  const pinnedDecisionSig = pinnedDecisionSignature(pinnedItem);

  // BLOCKER 1 (2026-05-30): visible feedback when the deck action does not
  // (yet) find its stream card in the DOM — instead of a silent no-op. Carries the
  // gate.kind briefly as a data attribute on the deck region (CSS pulse).
  const [deckActionMiss, setDeckActionMiss] = useState<string | null>(null);

  // Gate action → SINGLE SUBMIT PATH (Critic point 3). The deck delegates
  // here — as the pill delegates its submit to ChatShell — so there is
  // EXACTLY ONE POST path: the real button of the stream-gate card. The
  // deck NEVER builds a second fetch; it finds the card and clicks its
  // primary action programmatically (or focuses it when a secret is needed).
  // N8: the card stays in the history as a record.
  //
  // BLOCKER 1 (Critic, 2026-05-30): the old map `surface-${gate.kind}` only hit
  // live-warn. For human-decision (card=surface-decision-brief),
  // credential-request (had no data-test) + connector-call-preview (no
  // data-test on the body) it was a silent no-op — the owner clicks „Entscheiden"/
  // „Zugang eingeben" and NOTHING happens. Here mapped correctly + visible
  // feedback instead of a silent no-op when the scroll target is missing.
  const handleGateAction = useCallback((gate: BlockingGateState): void => {
    try {
      // executeGateAction (ActionDeck.tsx) is the ONE shared action path:
      //   non-secret approve → clicks the real button of the stream card
      //                        (exactly ONE POST; no second fetch in the deck).
      //   credential (secret) → only focuses the isolated card input
      //                        (Vault rule; the secret NEVER lands in the deck).
      //   counter-evidence    → scrolls the evidence card into view.
      //   card missing in DOM  → 'missing' → visible pulse feedback instead of
      //                          a silent no-op (BLOCKER 1).
      const outcome = executeGateAction(gate);
      if (outcome === 'missing') {
        setDeckActionMiss(gate.kind);
        window.setTimeout(() => setDeckActionMiss(null), 1600);
      }
    } catch {
      /* fail-soft: DOM not available (SSR) → no-op. */
    }
  }, []);

  // Resume action → continue an interrupted/paused workstream (owner
  // scenario „Connector-Onboarding heygen unterbrochen", Bug 1 context loss).
  // Instead of a generic clarification menu, „Fortsetzen" sends an EXPLICIT,
  // context-carrying instruction over the ONE submit path (submitRef → the
  // normal agent turn with full history/workspace context). The server/
  // connector stack (lib/connectors/auto-connect.ts) recognizes the resume from it
  // and, if needed, triggers the auth/onboarding surface path.
  //
  // SERVER SEAM (reported to the coordinator): the ACTUAL onboarding resume +
  // the auth surface lie deeper in the connector/server stack. This handler
  // only holds the context and delivers the right trigger text; the
  // server-side disambiguation/clarify path must consider `activeWorkstreams`/
  // `blockingGates` from state-projector before it clarifies
  // generically.
  const handleResume = useCallback(
    (workstreamId: string): void => {
      const item =
        Array.isArray(workspaceState?.activeWorkstreams)
          ? workspaceState!.activeWorkstreams.find(
              (w) => w.workstreamId === workstreamId,
            )
          : undefined;
      const name = item?.name ?? 'den unterbrochenen Vorgang';
      // Explicit, unambiguous instruction — NO short „?"/„weiter" anymore that
      // would be clarified generically server-side. Carries the workstream name +
      // the ID as context anchors.
      const resumeText = `Setze den unterbrochenen Workstream „${name}" (Workstream-ID: ${workstreamId}) fort. Wenn dafür ein Onboarding-/Auth-Schritt offen ist, starte den Verbindungs-/Auth-Prozess.`;
      submitRef.current?.(resumeText);
    },
    [workspaceState],
  );

  // 2026-04-28 Hotfix: serverStreamPending must NOT disable the input.
  // It is a passive indicator "the server keeps working in the background",
  // NOT a submit block. Otherwise the user cannot type when e.g. claude
  // crashed without a completed event (serverStreamPending stays true for 10min).
  const isPending = isMockPending || isStreaming;

  // ---- Bug-2-Fix: queue-flush effect · 2026-05-25 ----------------------
  // When agentStatus switches to 'idle' AND the queue is not empty →
  // automatically send the next message from the queue ("flows into the gap").
  // submitRef holds a stable callback ref to avoid circular deps.
  const submitRef = useRef<((raw: string) => void) | null>(null);

  // Phase 1 Track AB · finding B (2026-05-29): stable ref on the
  // structured-answer POST (postStructuredAnswers), because it is defined below
  // in the file (after `submit`) and must still be reachable
  // in the submit closure. Updated via useEffect as soon as
  // postStructuredAnswers materializes.
  const postStructuredAnswersRef = useRef<
    | ((
        qs: ReadonlyArray<OpenQuestion>,
        answers: Record<string, string>,
        sourceTurnId: string,
      ) => void)
    | null
  >(null);

  // C2-Fix: inflight lock. SurfaceAction callers (RateLimitRetry auto-retry,
  // cards via `reply`) call submit() without isStreaming knowledge → competing
  // sendAgent calls. This ref serializes the agent path: as long as a turn
  // is running, a second direct submit() (non-enqueue path) is discarded.
  const submitInflightRef = useRef(false);

  // M1-Fix: read history/agentTurn from refs instead of from the submit closure. On
  // an SSE burst (frequent re-renders), submit is otherwise constantly recreated and
  // the submitRef update effect races against the flush microtask. Refs are
  // always current and take history/agentTurn out of the submit deps.
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
    // A small microtask delay so the state is fully settled after the stream
    // ends before we initiate the next turn.
    queueMicrotask(() => {
      submitRef.current?.(next);
    });
  }, [agentStatus]);

  // ---- UX-1: open-questions detection · 2026-05-26 ---------------------
  // ---- Workstream 4b: ask-but-proceed pinning · 2026-05-27 ------------
  // When ANY assistant turn emits open questions, we pull them into
  // the pinned pill ABOVE the composer and expand it. The signature
  // (question IDs joined) prevents the same turn from being loaded again
  // on every re-render (which would reset the answers already given).
  //
  // FIX (owner symptom „Frage scrollt weg"):
  //  1. Source = BOTH: the `<surface:open-questions>` tag AND `## Offene Fragen`
  //     markdown (previously ONLY markdown → surface questions never pinned).
  //  2. Scan over the WHOLE history (the newest question set wins) PLUS the
  //     running `agentTurn.text` — so a question emitted mid ask-but-proceed-run
  //     appears at the bottom IMMEDIATELY, instead of only after the stream ends.
  //  3. Runs ALSO during `isStreaming` (no more early-return) — work happens
  //     in parallel ⇒ the question stays pinned + answerable nonetheless.
  // Clearing does NOT happen here (no step/wave clear) — only in the answer path
  // (resetPillState) resp. on workstream terminal (its own effect below).
  useEffect(() => {
    // History items (the newest assistant item with questions wins).
    // `collectOpenQuestionsFromHistory` internally already calls
    // `mergeQuestionEnrichmentsById` — double emissions of the same
    // assistant item with the same ID already land here as ONE card.
    let collected: OpenQuestion[] = collectOpenQuestionsFromHistory(history);
    // … and the still-running turn (not in history yet during streaming).
    // The live turn is „younger" than every history item → takes precedence.
    if (typeof agentTurn.text === 'string' && agentTurn.text.length > 0) {
      const liveQs = extractOpenQuestionsFromContent(agentTurn.text);
      if (liveQs.length > 0) {
        // W1 (2026-05-28): EXPLICITLY through the merger — `extract` itself does
        // not do that (two `<surface:open-questions>` tags in the SAME live turn with
        // the same ID would otherwise create two entries, instead of laying the second
        // emission as enrichment onto the first — owner finding
        // „Empfehlung … etwas doppelt und ggf. redundant").
        collected = mergeQuestionEnrichmentsById(liveQs);
      }
    }
    if (collected.length === 0) return;

    // MAJOR 3a (2026-05-26): duplicate question texts → colliding hash IDs.
    // Markdown questions carry `id = hashString(text)`; two text-identical open
    // questions thus get the same ID. The consequences would be: `allAnswered` wrongly
    // true after ONE answer, a duplicated answer in the reply, and the option click
    // always jumping back to the first bubble (navigation stuck). Surface
    // questions usually have stable own IDs; dedupeQuestionIds is idempotent.
    const uniqueQuestions = dedupeQuestionIds(collected) as OpenQuestion[];

    // MINOR 4a (2026-05-26): signature ONLY from the (deduped) question IDs —
    // stable across re-hydrate (a PWA tab switch changes item IDs, not question IDs).
    const signature = uniqueQuestions.map((q) => q.id).join('|');
    if (signature === lastQSignatureRef.current) {
      // W2 (2026-05-28): same signature — NO full re-load (would reset the
      // given answers and disturb the pill-expand state). BUT: when
      // a later emission supplies the same set WITH enrichment fields
      // (context/pros/cons/recommendation/evidence/askedAt), we want to enrich
      // the existing cards IN PLACE — that is exactly the owner spec
      // „statt zweiter Surface die EINE bestehende Karte ergänzen".
      // Merges the current state with the new fields; if nothing changed,
      // `merged` is referentially identical (no re-render).
      setOpenQuestions((prev) => {
        if (prev.length === 0) return prev;
        const merged = mergeQuestionEnrichmentsById([...prev, ...uniqueQuestions]);
        // Cheap compare: ID order AND enrichment fields. If nothing is new,
        // we return `prev` (React bail-out, no re-renders).
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

  // ---- W3 (2026-05-28): periodic stale/resolve scan -----------------
  // OWNER SYMPTOM (verbatim, 2026-05-28): „Im PA Chat ist immer noch Offene
  // Fragen, obwohl die schon unfassbar alt sind und schon lange beantwortet."
  //
  // We scan the currently pinned questions against the history with the pure
  // `detectResolvedAndStaleQuestions` helper (lexical match of a USER reply +
  // 24h age decay + ≥20 turns afterwards). When it returns IDs, we pull
  // them out of the pill state and adjust the signature to the remaining list.
  //
  // Trigger: every history update (deps: history.length). When the user answers
  // an old question, the answer is there as a history item on the next tick
  // → the scan kicks in and clears the question away. No polling timer (cost-
  // /battery-free).
  //
  // Persistence note: this scan is PURE UI — we change no events rows.
  // On reload the population effect re-derives the pill from the unchanged
  // assistant message; afterwards THIS scan clears it away again. That is the
  // honest path until a worker runs the `markStaleOpenQuestionsResolved` maintenance
  // server-side (its own slice).
  useEffect(() => {
    if (openQuestions.length === 0) return;
    // History → minimal shape (OpenQuestionsSourceItem) for the pure helper.
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
      // The signature must be adjusted to the shortened list so the
      // existing signature guard in the population effect does not block the re-load of
      // the REAL current question.
      lastQSignatureRef.current =
        remaining.length === 0 ? null : remaining.map((q) => q.id).join('|');
      return remaining;
    });
  }, [history, openQuestions]);

  // ---- Workstream 4b: terminal clear (NOT step-done clear) · 2026-05-27 --
  // The pinned question is cleared away ONLY when the WHOLE run is terminal —
  // i.e.: no longer streaming (`!isStreaming`), no server stream pending anymore
  // (`!serverStreamPending`) AND the question appears NOWHERE in the
  // conversation anymore (neither as a surface tag nor as a markdown section). That is
  // the case „run completed + finished, without the question still being
  // relevant" (done/failed/cancelled, question obsolete).
  //
  // DISTINCTION from the bug: a single step/wave end does NOT clear — because in
  // ask-but-proceed mode the run stays active (`isStreaming`/`serverStreamPending`
  // true) OR the question stays in the newest content (collected.length>0). Both
  // keep the guard here closed → the question stays pinned + answerable.
  //
  // Once the user has already started an answer (qAnswers not empty), we do
  // NOT clear — the answer flow (resetPillState) handles that.
  useEffect(() => {
    if (openQuestions.length === 0) return;
    if (isStreaming || serverStreamPending) return; // Run still active → hold.
    if (Object.keys(qAnswers).length > 0) return; // user is answering right now.
    // Is the question still somewhere? Then it is NOT obsolete → hold.
    const stillPresent = collectOpenQuestionsFromHistory(history);
    if (stillPresent.length > 0) return;
    // Run terminal + question nowhere → gone. Release the signature ref so
    // a new run with (coincidentally) the same signature can pin again.
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

  // ---- Phase 1 Track AB · finding B (2026-05-29): structured-answer hydration
  //
  // Owner acceptance: „Re-Render nach Reload zeigt beantwortete Frage korrekt."
  //
  // When the pill loads an open question for a workspace, we check
  // in parallel `/api/chat/answer?wsId=&qid=` whether this question was already
  // answered in a structured way (migration 0117 `question_answers`). If so → we clear
  // it out of the pill state because it is de facto „answered".
  //
  // Fail-soft: every error (network/401/500) is a no-op (the question
  // stays open, the user can answer it a second time — idempotent
  // in the structured store via UNIQUE content_hash).
  //
  // NO polling, NO permanent listener: a one-time pass per
  // question-set signature (lastQSignatureRef), abortable on re-render.
  const lastHydrationSigRef = useRef<string | null>(null);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (openQuestions.length === 0) return;
    const sig = openQuestions.map((q) => q.id).join('|');
    // Check only ONCE per set signature (otherwise it fires again on every history
    // tick). The reset happens automatically when the set changes.
    if (lastHydrationSigRef.current === sig) return;
    lastHydrationSigRef.current = sig;

    const wsId = currentWorkspace.id;
    const controller = new AbortController();
    const answered: string[] = [];
    (async () => {
      // One GET per question — in parallel via Promise.all. For a large pill
      // (4-5 questions typical) this is a negligible round-trip cost.
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

  // Phase RL.3: polling fallback. While serverStreamPending=true,
  // reload the history every 10s — in case the SSE subscription
  // was interrupted (PWA tab background, etc.) and a
  // chat_message_completed event was therefore missed.
  useEffect(() => {
    if (!serverStreamPending) return;
    if (!hydrated) return;
    const wsId = currentWorkspace.id;
    let cancelled = false;
    const startedAt = Date.now();
    const tick = async (): Promise<void> => {
      if (cancelled) return;
      // Hard stop after 10min of polling.
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
        // If an assistant message is now the last item,
        // the stream is through.
        if (last?.role === 'assistant') {
          setHistory(merged);
          writeHistoryFor(wsId, merged);
          setServerStreamPending(false);
          return;
        }
      } catch {
        /* offline / 401 — the next tick tries again */
      }
      window.setTimeout(() => void tick(), 10_000);
    };
    const t = window.setTimeout(() => void tick(), 10_000);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [serverStreamPending, hydrated, currentWorkspace.id]);

  // ---- auto-scroll · conservative 2026-04-27 ----------------------------
  // User complaint: "Cards springen sodass ich nicht klicken kann".
  // 30px threshold + 5s cooldown after click/hover + never when an element
  // in the stream has focus. Instead of a jump: an arrow button.
  const nearBottomRef = useRef(true);
  const lastInteractionRef = useRef(0);
  const [showScrollDown, setShowScrollDown] = useState(false);

  // Sub-Plan 01 (2026-04-29 v3): multi-strategy auto-scroll-to-bottom.
  // Previous attempts (scrollTop = scrollHeight in useLayoutEffect)
  // did not reliably take effect — presumably because the DOM had no real
  // height on the first paint.
  //
  // Now: scrollIntoView on an end marker + 4 triggers:
  //   1. on-mount + workspace-switch (useLayoutEffect)
  //   2. after every history update (useEffect with history deps)
  //   3. setTimeout(0) after mount for the „post-paint" scroll
  //   4. setTimeout(150) after mount for the „after-images-loaded" scroll
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
    // Double safety belt: after layout + after image load
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

  // 2026-05-03 (Bug 2): only scroll when REALLY new items were appended at the
  // end — NOT when an existing surface card gets a
  // new status payload (same id, new JSON content).
  // Previously the effect fired on every surface-card update and tore the
  // scroll container away mid-read. We now track a
  // signature (length + lastId) and only scroll when it changes.
  const lastScrollSigRef = useRef<{ len: number; lastId: string | null }>({
    len: 0,
    lastId: null,
  });

  useEffect(() => {
    const el = streamRef.current;
    if (!el) return;
    // Sub-Plan 01 (2026-04-29 reinforced): double rAF so the DOM
    // has guaranteed rendered the new messages before we read scrollHeight.
    // Otherwise race: a history update triggers the effect before new items
    // are mounted, scrollTop is set to the old scrollHeight.
    //
    // Bug 2 Fix (2026-05-03): compute a signature over ALL items
    // visible in the stream (history non-archived + systemMessages). If the
    // signature is identical to the last one → do NOT scroll, because that
    // means: only an existing card was re-rendered (status update,
    // new payload). Only on a real append (length grew OR the last ID
    // changed) do we follow along.
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
    // Streaming token stream: agentTurn.text grows continuously, without
    // a new HistoryItem bubble being created. So the live feed
    // follows smoothly, we also scroll when isStreaming AND pinned.
    const isLiveStreamGrowth = isPending || agentTurn.text.length > 0;
    if (!isNewAppend && !isLiveStreamGrowth) return;

    const apply = (): void => {
      const focused = typeof document !== 'undefined' ? document.activeElement : null;
      const focusInStream = focused && el.contains(focused);
      // Looser condition: if near-bottom AND not stream-focused,
      // scroll. Idle check removed — the user rarely clicks directly into the
      // stream anyway.
      if (nearBottomRef.current && !focusInStream) {
        el.scrollTop = el.scrollHeight;
        setShowScrollDown(false);
      } else if (!nearBottomRef.current && isNewAppend) {
        // Only show the „new item — please scroll" arrow on a real
        // append, not on every token tick.
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

  // ---- Persist the live state while the stream runs -----------------
  // When Max closes the PWA mid-stream, the whole tool-
  // call history + partial answer used to be gone. We snapshot it every ~600ms
  // to localStorage and rehydrate it on mount as a final message in
  // the history (the stream itself is naturally dead after close).
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

  // When the stream ends cleanly → throw away the live state (the history has it)
  useEffect(() => {
    if (!hydrated) return;
    if (agentStatus === 'idle' && !isStreaming) {
      liveStartRef.current = null;
      clearLiveFor(currentWorkspace.id);
    }
  }, [agentStatus, isStreaming, hydrated, currentWorkspace.id]);

  // Wave 1 · 2026-05-03 · active-workstream-broadcast
  // ----------------------------------------------------------------------
  // BackgroundActivityIndicator should not count its own active stream —
  // otherwise the user sees the pulse pill in the TopNav and
  // here in the bubble the phase text → 2× "läuft". We broadcast via
  // a custom event, the TopNav indicator listens in + filters via a query param.
  // On isStreaming start: workstreamId (or null for the root chat).
  // On isStreaming end: null → re-include everything.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const detail = {
      workstreamId: isStreaming ? agentTurn.workstreamId ?? null : null,
    };
    window.dispatchEvent(
      new CustomEvent('lazyos:active-workstream-changed', { detail }),
    );
  }, [isStreaming, agentTurn.workstreamId]);

  // ---- Live-state recovery on mount -----------------------------------
  // On the first hydrate (together with the history load): if a live state
  // lies in localStorage that is no longer active (PWA was closed),
  // push it as a final assistant message into the history.
  useEffect(() => {
    if (!hydrated) return;
    const live = readLiveFor(currentWorkspace.id);
    if (!live) return;
    // If the user prompt that triggered the stream is already the
    // last history item and no assistant reply exists, we append
    // the live state as an assistant reply. Otherwise (e.g. live state
    // older than the last assistant reply) ignore.
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
    // Trigger only once per workspace hydrate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, currentWorkspace.id]);

  // ---- Visibility reset: PWA visible again → clear connection errors ---
  // When Max closes the app while the stream runs, the fetch breaks
  // with "Load failed"/NetworkError/AbortError. On re-open he sees the
  // error banner. We clear the status automatically when it was obviously
  // a connection error (browser disconnect, not a bug).
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
    // Also check once on mount — in case the page remounts directly in the
    // error state (cached by the SW).
    onVisible();
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [agentStatus, agentError, resetAgent]);

  // ---- Phase MS · visibility heartbeat -------------------------------
  // Pings /api/chat/visibility every 15s and on every visibilitychange.
  // The server then decides whether a push goes out on chat_message_completed
  // (push only when NO client is visible).
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

    // Immediately ping with the current status. The first 15s tick
    // otherwise comes late — the user would be "unknown" for push until then.
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
      // On unmount: explicitly tell the server "I am gone".
      // Otherwise our last visible ping still counts up to the TTL.
      ping(false);
    };
  }, [hydrated, currentWorkspace.id]);

  // ---- Phase MS · MS.6 migration --------------------------------------
  // One-shot per workspace: import the localStorage history as chat_message
  // events into the DB, set a marker, done. Idempotent (the server
  // skips known legacyIds).
  //
  // P1-3: sets `migrationDone` to true when the migration is through
  // (or there is nothing to migrate). useEventStream waits for it — otherwise
  // the replay burst comes in while cache IDs ≠ ULID IDs.
  useEffect(() => {
    if (!hydrated) return;
    // Workspace switch: reset, re-check.
    setMigrationDone(false);
    setMigrationFailed(false);
    const wsId = currentWorkspace.id;
    const markerKey = `lazyos.chat.history.migrated.${wsId}`;
    let markerSet = false;
    try {
      markerSet = window.localStorage.getItem(markerKey) === '1';
    } catch {
      markerSet = true; // on storage failure do NOT migrate
    }
    if (markerSet) {
      setMigrationDone(true);
      return;
    }

    const items = readHistoryFor(wsId) ?? [];
    // Even with items.length === 0 we send the POST: the server
    // sets the chat_history_migrated event and replies 200, we
    // set the marker. Otherwise we ping the server on every empty workspace
    // switch (the pre-check is O(1) via indexed lookup).
    // But we can also get by without a round trip — the server event
    // is created on the first real import. Optimization: if
    // 0 items, set the local marker but skip the server.
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
        // B2-fix: the server signals via `alreadyMigrated: true` that
        // a chat_history_migrated event exists. Behavior identical
        // to a fresh import — set the marker, done.
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
        // alreadyMigrated is only used here for telemetry/debug;
        // the effect behaves identically to a fresh import.
        void alreadyMigrated;
      })
      .catch(() => {
        if (cancelled) return;
        // B3-fix 2026-04-26: on server-fail/offline we do NOT set
        // migrationDone to true. Otherwise useEventStream fires
        // the replay burst in WHILE local items still stand under
        // their client-id (not ULID) in the state — the user message
        // is rendered twice. Instead: migrationFailed=true,
        // the UI shows a subtle hint, auto-retry after 30s.
        setMigrationFailed(true);
        // Auto-retry: the tick counter triggers the effect again.
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

  // No more viewport hack — with interactiveWidget=resizes-content in the
  // viewport meta (app/layout.tsx), iOS Safari shrinks the layout viewport
  // automatically on keyboard open. Our flex layout (main as
  // position:fixed with dvh) reacts directly to it.

  // ---- live event stream ----------------------------------------------
  // Events from /api/events/stream land as system messages in the chat.
  // Not persisted (transient, come back in on mount via replay).
  const handleEvent = useCallback((ev: LazyEventLike) => {
    // Phase MS · realtime sync: chat_message_* events are merged into
    // HistoryItems instead of system toasts.
    if (isChatMessageEvent(ev.type)) {
      // Phase RL.3 (2026-04-28): on chat_message_completed → pending
      // indicator off. On a chat_message_sent coming back, a running
      // stream may also build up → pending indicator ON.
      if (ev.type === 'chat_message_completed') {
        setServerStreamPending(false);
      } else if (ev.type === 'chat_message_sent') {
        const role = (ev.payload?.role as string) ?? '';
        if (role === 'user') setServerStreamPending(true);
      }
      // Echo filter: when our own chat_message_sent comes back,
      // do not render it twice (the local history already has it).
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
        // Our own echo — swallow. Do NOT delete the pending marker,
        // because the server may come again on replay.
        return;
      }

      // event.id (ULID) -> stable HistoryItem.id
      // Loop guard: no own echo events; dedup against the existing
      // history (by id) — if already in, skip.
      // ev was normalized as LazyEventLike in useEventStream; we
      // need the full LazyEvent. The wire value already has all fields,
      // we assemble it defensively for safety.
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
      // Sub-Plan A · 2026-04-29 — backfill coords from the content so
      // server-emitted cards (e.g. iterate-pipeline from tier-orchestrator)
      // can supersede their previous waves.
      const item = hydrateWorkstreamCoords(itemRaw);

      setHistory((prev) => {
        // Dedup by HistoryItem.id (= event.id)
        if (prev.some((m) => m.id === item.id)) return prev;
        // Insert chronologically — events mostly come at the end, but
        // on replay/ooo they can also land in the middle.
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
        // Replace logic only makes sense when the new item comes at the end
        // (insertIdx === prev.length). On a mid-insert (replay-ooo) the
        // surface card would be chronologically older than existing cards —
        // then it must not archive any later ones.
        let workingPrev = prev;
        let workingItem = item;
        if (insertIdx === prev.length) {
          const replaced = archiveStalePeers(prev, item);
          // Sub-Plan 3 (2026-05-01): max-3-active-cards cap.
          // Limits the number of simultaneously visible surface cards
          // per workspace. The oldest are archived BEFORE the append.
          workingPrev = enforceActiveCap(replaced.prev, replaced.incoming, 3);
          workingItem = replaced.incoming;
        } else if (item.workstreamId && item.surfaceKind) {
          // Sub-Plan A Finding 4 (2026-04-29): mid-insert-replay protection.
          // If the incoming entry chronologically belongs behind an already
          // existing, living item of the same (workstreamId,
          // surfaceKind) coord, it would without action appear as a
          // "living" card and show the user two current cards.
          // We then immediately mark the incoming one as archived.
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

    // PHASE I (user wish 2026-04-26): synthesis cards as a proper
    // assistant message in the chat history, NOT only as a subtle
    // system toast. This is the completion card for a
    // workstream — should be prominent + persistent.
    const isSynthesis =
      ev.type === 'commented' &&
      typeof ev.payload?.kind === 'string' &&
      ev.payload.kind === 'synthesis';
    if (isSynthesis) {
      // Phase IT (2026-04-27): if the synthesis output comes from iterate
      // mode, prepend a diff-score header so the user sees the
      // improvement V1->V2 immediately. Plus a token-budget display.
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

      // Phase AC.3 (2026-04-26): derive the consensus level from the synthesis
      // payload and attach a consensus-action surface AT THE END of the bubble.
      // So the user sees a 30s countdown on strong consensus
      // instead of having to click master-approve.
      let consensusLevelRaw =
        typeof ev.payload?.consensus_level === 'string'
          ? ev.payload.consensus_level
          : undefined;

      // AC fallback (2026-04-26): if the server payload has no consensus_level
      // (old workstreams pre-AC), derive it client-side from mapped.text.
      // Local mapping with the same heuristic as tier-orchestrator.ts.
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
        // Attach the surface tag at the end — surface-parser.parseChunks
        // finds it and SurfaceRenderer renders the ConsensusActionCard.
        augmentedContent = augmentedContent + `\n\n${consensusTag}`;
      }

      const item: HistoryItem = {
        id: nextId('assistant'),
        role: 'assistant',
        content: augmentedContent,
        ts: new Date().toISOString(),
        // Sub-Plan A · 2026-04-29 — set coords explicitly so the
        // replace pass finds the match, even when the surface tag in the
        // content is syntactically incomplete (the synthesis branch
        // does not close <surface:consensus-action> — surface-text-render
        // tolerates that via a skeleton fallback).
        ...(validConsensus && wsIdFromPayload
          ? { workstreamId: wsIdFromPayload, surfaceKind: 'consensus-action' as const }
          : {}),
      };
      setHistory((h) => {
        // De-dupe in case the event arrives twice (replay + live).
        // Match on mapped.text (original without surface suffix), otherwise
        // 2 synthesis bubbles would arise if only one has the
        // consensus_level marker.
        const lastFew = h.slice(-3);
        if (lastFew.some((m) => m.content.startsWith(mapped.text))) return h;
        // Sub-Plan A — set all previous cards with the same (workstreamId,
        // surfaceKind) coord to archived=true.
        const replaced = archiveStalePeers(h, item);
        // Sub-Plan 3 (2026-05-01): honor the max-3-active-cards cap.
        const capped = enforceActiveCap(replaced.prev, replaced.incoming, 3);
        const next = [
          ...capped.slice(-(HISTORY_CAP - 1)),
          replaced.incoming,
        ];
        writeHistoryFor(currentWorkspace.id, next);
        return next;
      });
      // Push notification (best-effort, only when a push subscription exists)
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

    // Phase WSC.1 (2026-04-26): render auto-dispatch-overview as a prominent
    // assistant message (not as a subtle system toast). The user
    // sees the live pipeline directly in the chat history, not hidden
    // in a toast stack.
    const isAutoDispatchOverview =
      ev.type === 'commented' &&
      typeof ev.payload?.kind === 'string' &&
      ev.payload.kind === 'auto-dispatch-overview';
    if (isAutoDispatchOverview) {
      // Sub-Plan E (2026-04-30) — double scan eliminated. Previously
      // `extractWorkstreamCoords(mapped.text)` ran here AND later again
      // the renderer regex over the same content. Now:
      //   1. archiveStalePeers (in replace-logic.ts) internally does the
      //      fallback scan via extractWorkstreamCoords WHEN the item carries no
      //      coords — i.e. exactly once per new bubble.
      //   2. The useMemo<parsedItems> pass covers the render path; the
      //      cache contains coords from parseHistoryItem (single-pass).
      // Coords are therefore no longer pre-computed here.
      const item: HistoryItem = {
        id: ev.id ? `auto-dispatch-overview-${ev.id}` : nextId('assistant'),
        role: 'assistant',
        content: mapped.text,
        ts: new Date().toISOString(),
      };
      setHistory((h) => {
        if (h.some((m) => m.id === item.id)) return h;
        const replaced = archiveStalePeers(h, item);
        // Sub-Plan 3 (2026-05-01): honor the max-3-active-cards cap.
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
      // Bug B Fix 2026-04-26: ISO timestamp so ChatShell can interleave
      // history+systemMessages chronologically. The HH:MM format happens at render.
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
    // P1-3: only after the one-time history migration is through.
    // Otherwise a replay-burst double because cached cache-IDs ≠ ULID-IDs.
    enabled: hydrated && migrationDone,
  });

  // ---- Phase Reload-Recovery V2 · 2026-04-27 -------------------------
  // Polling for streaming_snapshots: as long as a HistoryItem with
  // streamState='streaming' stands in the state, refresh `/api/chat/history`
  // every 2s so the user sees how the answer continues. Stops
  // automatically as soon as no one is streaming anymore (the completed event
  // has replaced the snapshot item, or the heuristic tips it to 'aborted').
  //
  // Echo filter: ownPendingIdsRef contains the IDs we are currently
  // streaming live ourselves — polling items for these IDs are
  // discarded (the live SSE in useAgentStream takes precedence).
  useStreamingPoll({
    workspaceId: currentWorkspace.id,
    history,
    enabled: hydrated && migrationDone,
    ownPendingIdsRef,
    onUpdate: (merged, systemItems) => {
      setHistory((prev) => {
        // Conservative apply: only adopt when something on the
        // streaming path has changed. Otherwise we do not needlessly
        // trample local surface cards / mock items / etc.
        const prevStreamSig = streamSignature(prev);
        const nextStreamSig = streamSignature(merged);
        if (prevStreamSig === nextStreamSig && prev.length === merged.length) {
          // No streaming delta → polling has nothing new, skip.
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
  // removed — were only needed by SessionControls. Slash commands
  // in the composer have their own ctx helper (slashCtx). Cleanup for
  // the unused linter — no dangling code.

  // ---- inline auto-suggest (point 1 handoff) -------------------------
  const suggestions = useChatSuggestions(input, {
    enabled: !sttListening,
    minLength: 2,
    // Sub-Plan B (2026-04-29) — slash-command suggestions write the
    // command name into the input field instead of triggering an action. The user
    // then sends with Enter.
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
      // Slash-command suggestions write the command name back into the
      // composer field via opts.setInput — do not clear.
      // Otherwise (nav/act/ws): clear the composer, because onSelect navigates/switches.
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

  // ---- Auto-project seam (2026-06-02) ----------------------------------
  // Build intent in the virtual workspace (org-root/__root__/__org_root__:*) →
  // create a real project workspace, switch in org-aware, carry the build prompt
  // along (stash) + auto-submit on the new page. This turns „bau
  // mir das" in the default chat seamlessly into an app, instead of hanging in
  // the virtual root (where the agent cannot write files). Best-effort.
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
        // Carry the brainstorm context from the conversation so far — otherwise
        // the fresh session in the new project doesn't know WHAT to build on
        // „bau das / leg los". Strip surface tags, last ~8 messages.
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
        // Stash the build prompt for the new page + switch org-aware, then
        // hard-navigate into the new workspace (canonical ?ws landing path).
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

      // STAGING (owner hard requirement 2026-05-26): read the staged attachments
      // at submit start. As long as some are present, an EMPTY text is
      // allowed (pure attachment send, WhatsApp behavior). File(s) + text
      // go out TOGETHER — see userMsg.content (bubble) and
      // agentText (agent prompt) further below.
      const pendingAttachments = stagedAttachmentsRef.current;
      const hasStaged = pendingAttachments.length > 0;
      if (!canSendWithAttachments(pendingAttachments, value)) return;

      // Bug-2-Fix: while streaming → enqueue instead of discarding.
      // The queue-flush effect sends the message automatically as soon as
      // agentStatus switches to 'idle'.
      //
      // C2-Fix: submitInflightRef closes the window between submit start
      // and the agentStatus transition to 'connecting' (during which isStreaming
      // is still false). A competing direct submit() (e.g.
      // SurfaceAction.reply / RateLimitRetry auto-retry) is thus also
      // enqueued instead of starting a second sendAgent(). Important: this
      // guard stands BEFORE any history mutation so no double user bubble
      // arises (re-enqueue does not mutate the history).
      // Attachments bypass the text queue: the queue only stores strings,
      // an enqueued text would orphan the staged file. On
      // real inflight, submitInflightRef further below protects against
      // a double send. Pure text is enqueued as before.
      if (!hasStaged && (isStreaming || submitInflightRef.current)) {
        messageQueueRef.current.push(value);
        setQueueLength(messageQueueRef.current.length);
        setInput('');
        clearDraftFor(currentWorkspace.id);
        return;
      }

      // ---- Auto-project seam (2026-06-02) ------------------------------
      // In the virtual workspace (org-root etc.) the agent cannot build
      // (no project path). On a clear build order we therefore create a
      // real project, switch in and build THERE — instead of hanging here.
      // Conservative detection (looksLikeBuildIntent) + not during an
      // open pill question. Pure text only (no staged attachments).
      // ---- Image generation from natural language · 2026-06-03 ----------
      // Owner finding: „erstelle ein Bild von X" (without /image) went to the
      // agent, which faked it via HTML/Bash — without real generation + without
      // a preview. Fix: detect BEFORE build/flow routing (detectImageIntent) and
      // emit the real <surface:image-gen> loading surface (ImageGen2 +
      // animated preview in the chat). No agent roundtrip. Conservative
      // (generation verb + image noun; retrieval phrases excluded).
      if (!hasStaged && !(pillExpanded && openQuestions.length > 0)) {
        const imgIntent = detectImageIntent(value);
        if (imgIntent.isImage) {
          setInput('');
          clearDraftFor(currentWorkspace.id);
          const token = `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          const userMsg: HistoryItem = {
            id: nextId('user'),
            role: 'user',
            content: value, // N1: verbatim wish as the user bubble
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

      // ---- UX-1: Q/A pill answer routing · 2026-05-26 -----------------
      // ORDER: (1) streaming → queue (above, unchanged);
      // (2) otherwise, if the pill is expanded AND has open questions →
      //     set the input as a FREE-TEXT answer to the current question,
      //     then jump to the next unanswered question. If afterwards
      //     ALL questions are answered → ONE final reply(<Q&A>) (over the
      //     normal send path further below), reset the pill state cleanly.
      // (3) otherwise a normal send (code below).
      //
      // Important: only when NOT streaming (the guard above takes effect first). This
      // keeps the claude-cli happy path + the queue/interrupt logic intact.
      if (!hasStaged && pillExpanded && openQuestions.length > 0) {
        const qs = openQuestions;
        const idx = Math.min(Math.max(qIndex, 0), qs.length - 1);
        const currentQ = qs[idx]!;

        // routePillAnswer = identical logic to the option click (one path):
        // set the answer → check completeness → next open question.
        const route = routePillAnswer(qs, qAnswersRef.current, idx, currentQ.id, value);
        setQAnswers(route.nextAnswers);
        setInput('');
        clearDraftFor(currentWorkspace.id);

        if (route.allAnswered) {
          const qaText = buildQAReply(qs, route.nextAnswers);
          // Phase 1 Track AB · finding B: structured envelope IN PARALLEL
          // to the existing chat turn — a fail-soft fire-and-forget POST to
          // /api/chat/answer. sourceTurnId = pre-created user-turn anchor
          // (idempotency key via UNIQUE(source_turn_id, question_id)).
          // Via a ref because postStructuredAnswers is defined FURTHER below in the
          // file (after submit) — analogous to the submitRef pattern above.
          const turnAnchor = nextId('user');
          postStructuredAnswersRef.current?.(qs, route.nextAnswers, turnAnchor);
          // Reset the pill state BEFORE the final send so the reply()
          // (= submit on qaText) does NOT fall into pill routing again.
          resetPillState();
          // Over the normal send path: submitRef is stable + checks
          // isStreaming again itself (no double send). Microtask so the
          // state reset settles before the final turn starts.
          queueMicrotask(() => {
            submitRef.current?.(qaText);
          });
          return;
        }

        // Otherwise: to the next still-unanswered question — no new turn.
        setQIndex(route.nextIndex);
        return;
      }

      // ---- Bug-2-Fix · free-text-answer coupling · 2026-05-30 ----------
      // Live browser finding (verbatim): if the user FREELY types „Eigenes Video"
      // instead of clicking an open tier-choice/quickchoice card, the
      // text falls through `classifyFlowIntent` (min 3 words + imperative verb → otherwise
      // 'unknown') into the normal chat stream. The agent does NOT understand it
      // as an answer to the open question, but throws a THIRD
      // depth/choice picker → context loss.
      //
      // FIX: when open questions are active (openQuestions.length > 0) — whether
      // the pill is collapsed or expanded — free text is routed as an answer to the
      // currently visible question, NOT as a new plan. This is exactly
      // the same routePillAnswer logic as option click / pill Enter
      // (one code path) incl. the structured envelope (finding 4 / N8/N9).
      //
      // Distinction (no hijack of real new orders):
      //   - slash command (`/…`) → do NOT intercept (explicit command).
      //   - confident flow intent (classifyFlowIntent === 'flow', e.g.
      //     „erstelle eine Webseite") → do NOT intercept; the user deliberately
      //     starts something new. Only „unknown" input (= the typical short
      //     answer) is coupled to the question.
      //   - the pillExpanded path above already takes precedence (kicks in first).
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
          // Structured envelope IN PARALLEL (finding 4) — execution hangs on the
          // object, not on the readable chat bubble.
          const turnAnchor = nextId('user');
          postStructuredAnswersRef.current?.(qs, route.nextAnswers, turnAnchor);
          resetPillState();
          queueMicrotask(() => {
            submitRef.current?.(qaText);
          });
          return;
        }

        // Still open questions → jump to the next, no new turn.
        setQIndex(route.nextIndex);
        return;
      }

      // The old mock-pending guard stays (the mock path is synchronous,
      // no interrupt possible).
      if (isMockPending) return;

      // Owner directive 2026-05-28 (N1 verbatim): „Flow müsste doch aus
      // dem Context und Intent erkannt werden und ausgeführt. Das wäre ja
      // das Kernkonzept von dem lazing system."
      //
      // → Before the slash parser we classify the user input
      // deterministically (lib/chat/intent-flow-classifier.ts). On
      // kind === 'flow' we synthesize `"/flow " + value` and pass
      // it into the existing slash path — the same handler as an
      // explicit `/flow`, one code path, no duplication.
      //
      // Guards (additive, fail-soft):
      //   - hasStaged: when attachments are staged, the user explicitly wants
      //     a file send → do not classify (the bug-swarm path also
      //     deliberately leaves it out).
      //   - already a `/` prefix: the classifier itself returns 'unknown',
      //     here additionally defensive.
      //   - the backend fallback for voice/agent-API is its own slice
      //     (see lib/chat/intent-flow-classifier.ts header comment).
      let effectiveSubmitValue = value;
      let autoFlowDetected = false;
      if (!hasStaged && !value.startsWith('/')) {
        const flowResult = classifyFlowIntent(value);
        if (flowResult.kind === 'flow') {
          effectiveSubmitValue = buildSyntheticFlowCommand(value);
          autoFlowDetected = true;
          // Optional subtle hint (≤14px, token-only) as a system toast.
          // Helps the owner understand why a flow surface appears
          // instead of an LLM answer. Opt-out implicit: on `?` or read
          // orders, classifyFlowIntent does not even fire.
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
      // Silent lint assumption: autoFlowDetected is not needed further below
      // (slash path) — the flag serves as a debug/test hook (cf. tests
      // in __tests__/chat-shell-flow-auto-detect.test.ts). The React compiler
      // strips it in prod.
      void autoFlowDetected;

      // Sub-Plan B · 2026-04-29: slash-command interception.
      // BEFORE every LLM roundtrip we check whether `/clear`, `/compact`, `/help`
      // (or another registered command) stands at the start. If so:
      // run the handler, clear the composer input, NO server roundtrip.
      // Pass-through commands (currently none) would be treated further below
      // like a normal message.
      // Owner directive 2026-05-28: effectiveSubmitValue may contain the
      // synthesized `/flow <intent>` string from the auto-detection above.
      const slashCmd = hasStaged ? null : parseSlashCommand(effectiveSubmitValue);
      if (slashCmd) {
        const slashCtx: SlashContext = {
          workspaceId: currentWorkspace.id,
          // M1-Fix: current history from a ref (submit is now stable, the
          // closure capture would otherwise be stale).
          history: historyRef.current,
          setHistory,
          pushSystemToast: (item: SlashSystemItem) => {
            // SlashSystemItem is structurally identical to the internal SystemItem.
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
          // Track-D · 2026-05-27 (Flow Studio): tail args after the command
          // name (verbatim, only outer-trimmed). `/flow` uses this as the intent.
          // Owner directive 2026-05-28: on auto-flow-detect,
          // effectiveSubmitValue contains the synthesized slash prefix → the tail
          // is the original user text (N1 verbatim).
          args: extractSlashArgs(effectiveSubmitValue),
          // Track-D · 2026-05-27 (Flow Studio): post an assistant bubble into the
          // history. Only assistant items run through the surface-aware renderer,
          // i.e. `<surface:flow-coupling>` markup becomes a card here. System
          // toasts (pushSystemToast) show raw text instead.
          postAssistantMessage: (content: string) => {
            const item: HistoryItem = {
              id: nextId('assistant'),
              role: 'assistant',
              content,
              ts: new Date().toISOString(),
            };
            setHistory((h) => [...h, item]);
          },
          // Track-D · Stream-B2: `/flow` delegates needs-style-choice here —
          // ChatShell emits the quickchoice surface(s) + wires the
          // owner choice → re-POST (see handleFlowStyleChoice above).
          onFlowStyleChoice: handleFlowStyleChoice,
        };
        // Result type currently constant 'consumed' — async fire-and-forget
        // with a defensive catch. Clear the composer here immediately + drop the draft.
        setInput('');
        clearDraftFor(currentWorkspace.id);
        void slashCmd.handler(slashCtx).catch((err) => {
          // Very robust: if the handler crashes, at least show a
          // toast instead of swallowing silently.
          // eslint-disable-next-line no-console
          console.error('[slash-command]', slashCmd.name, err);
        });
        return;
      }

      // ---- Sprint H · 2026-04-30: bug-fix-swarm detection -----------------
      // User complaint 2026-04-30: „Bug rein, der labert da rum, statt
      // selber zu fixen". We detect error/bug posts heuristically and
      // start 3 parallel diagnosis spawns + consensus + fix.
      // Bypass via `/no-swarm <text>` possible.
      // With a staged attachment NEVER trigger the bug swarm — the user wants
      // to explicitly give a file + caption to the agent, not start a bug
      // diagnosis pipeline.
      const bugDetect = hasStaged
        ? { isBug: false, bypassedByUser: false, cleanedMessage: value }
        : detectBugReport(value);
      let effectiveValue = value;
      if (bugDetect.bypassedByUser) {
        // The user explicitly wanted NO swarm — remove the marker, continue normally.
        effectiveValue = bugDetect.cleanedMessage.trim() || value;
      } else if (bugDetect.isBug) {
        // Bug detected → start the swarm, post the current user message as a
        // history item + system toast → NO normal LLM roundtrip.
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

      // Sub-Plan B · 2026-04-29: auto-reset on every new user message.
      // User wish: the history collapses again automatically after submit,
      // so the focus is on the fresh answer and not lost in the
      // historical context. A subtle system toast
      // hints at how to open it again.
      //
      // No toast when showHistory was already false OR when no
      // archived items are present (= no visible change
      // for the user, would be a ghost toast). B-3 review finding 2026-04-29.
      const hasArchived = historyRef.current.some((it) => it.archived === true);
      if (showHistory && hasArchived) {
        setShowHistory(false);
        // Own ID source for transient system toasts (not via nextId,
        // which is HistoryItem-only). Random + timestamp suffices for dedup.
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

      // Auto-mode: a marker in the prompt so the agent recognizes "a big plan
      // is wanted". The UI shows only the actual text (the marker as a
      // subtle suffix).
      // Sprint H · 2026-04-30: `effectiveValue` is the user input with
      // the `/no-swarm` bypass prefix possibly removed. On the normal path
      // identical to `value`.
      const autoOn = isAutoModeOn();

      // STAGING: separate bubble vs. agent text.
      //  - bubbleContent: what the user BUBBLE shows — attachment card(s) on top,
      //    caption below (`<surface:document>…\n\ncaption`). Persisted
      //    in the history → the attachment stays visible after a reload.
      //  - agentBaseText: what the AGENT receives — file-path references
      //    (`[Angehängt: …]`) + caption, so it sees BOTH in ONE turn.
      // Without attachments both are identical to the plain user text.
      const bubbleContent = hasStaged
        ? buildBubbleContent(pendingAttachments, effectiveValue)
        : effectiveValue;
      const agentBaseText = hasStaged
        ? buildAgentPrompt(pendingAttachments, effectiveValue)
        : effectiveValue;
      const augmentedValue = autoOn
        ? `${agentBaseText}\n\n[Auto-Mode aktiv]`
        : agentBaseText;

      // Bug-C-RACE Fix 2026-04-26: create the pendingPromptId client-side
      // BEFORE the POST goes off. So `ownPendingIdsRef` is already filled before
      // the first chat_message_sent event and the echo filter
      // takes effect even on a slow header roundtrip.
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
        // The bubble shows attachment card(s) + caption (WhatsApp/Telegram style).
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
      // Clear staging — the file(s) are now part of the sent message.
      if (hasStaged) setStagedAttachments([]);
      // Phase Reload-Recovery V2 · 2026-04-27: delete the draft once
      // successfully sent (chat_message_sent is "the local
      // push" here — if the server roundtrip fails, the user
      // regenerates the prompt manually anyway, and then types again).
      clearDraftFor(currentWorkspace.id);

      // ---- real-agent path ----------------------------------------------
      // C2-Fix: set the inflight lock BEFORE the async path starts. The
      // try/finally below guarantees the reset in EVERY outcome
      // (ok/error/aborted/throw) — no hanging lock.
      submitInflightRef.current = true;
      (async () => {
       try {
        // Instant feedback 2026-04-30: the typing indicator should appear right at
        // submit, not only after the server roundtrip. User
        // complaint: long wait times without a visual.
        setServerStreamPending(true);

        const baseHistory = [...historyRef.current, userMsg].slice(-CONTEXT_WINDOW);
        const messages = baseHistory.map((m, idx, arr) => ({
          role: m.role,
          // Last user message → `augmentedValue` ALWAYS goes to the agent
          // (= agentBaseText + possibly the auto-mode marker), NOT the bubble
          // content. With attachments, agentBaseText contains the file-path
          // references (`[Angehängt: …]`) + caption — otherwise the agent would
          // see raw `<surface:document>` markup. With pure text without
          // auto-mode, augmentedValue == effectiveValue == m.content.
          content:
            idx === arr.length - 1 && m.role === 'user'
              ? augmentedValue
              : m.content,
        }));

        // Phase MS (P1-2): resultEventId from the stream response.
        // If present → assistantMsg.id = ULID (matches the live
        // event-stream echo). If not (error path, old server versions)
        // → fallback to nextId().
        //
        // B5-fix 2026-04-26: a ref so we can use the eventId in ALL
        // outcome branches (also error/aborted). Previously
        // resultEventId was only used in the 'ok' path — but the server emitted
        // the chat_message_completed event also on outcome=error,
        // so the live stream floods a ULID item in WHILE
        // ChatShell stores the same item under `nextId('assistant')`
        // → double render after reload.
        const resultEventIdRef = { current: null as string | null };

        // ---- 2-stage model · 2026-06-03 (owner directive, N1 verbatim) ----
        // „workspace Chat … mit einer Art Codex Speed … schnell … wenn Dinge
        // erkannt werden, dann geht es in der Agent Ausführung mit Claude Code
        // … gesprächig … das fehlt." → Normal chat answers FAST (Opus, no
        // --effort, no thinking — brainstorm/smalltalk pace). When the
        // deterministic N6 pre-screen (`shouldDecompose`, threshold 3) detects
        // a real multi-step undertaking — verb PLUS complexity signal —
        // ONLY THIS turn escalates to deeper thinking (`--effort high`).
        // Additive: deep=false → exactly today's fast behavior (no
        // regression). Slash/flow/bug-swarm/free-text answer are already
        // branched off above (return) — only „normal" chat lands here.
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
          // 2-stage model: thinking only on a detected multi-step intent.
          // Passes through to server/workspace-session.ts → `--effort high`.
          ...(deepThinking ? { thinking: true } : {}),
          onPendingId: (id) => {
            // Phase MS: this pendingPromptId stems from US — when
            // the chat_message_sent event with this ID comes back over the live
            // event stream, ignore (echo filter).
            ownPendingIdsRef.current.add(id);
            // Cap the set size (otherwise a memory leak over hours).
            if (ownPendingIdsRef.current.size > 200) {
              const first = ownPendingIdsRef.current.values().next().value;
              if (first) ownPendingIdsRef.current.delete(first);
            }
            // Bug C Fix 2026-04-26: set pendingPromptId on the just-
            // pushed local userMsg (match by content+ts since
            // userMsg.id is a client-side nextId('user')). On the
            // next reload mergeServerWithLocal kicks in:
            // serverItem.pendingPromptId === localItem.pendingPromptId
            // -> the local item is replaced by the ULID variant instead of
            // appended. Previously: the user bubble appeared after reload
            // twice (local + ULID).
            setHistory((h) => {
              // Find the newest user item WITHOUT a pendingPromptId
              // (optimistic insert without server echo). A single
              // match — we tag the last unassigned one.
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
            // Phase RL.2: on a successful stream, reset the retry counter for
            // this prompt.
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
            // No mock, no invented answer (N5/owner directive
            // 2026-06-03): when no engine is connected, we say it
            // honestly instead of faking a card.
            const assistantMsg: HistoryItem = {
              // not_configured never runs through the agent → no
              // server event, no resultEventId. A local ID is OK here.
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
            // M1-Fix: read the current agentTurn from a ref (the closure capture
            // would be the turn state at submit time, not the final one).
            const abortedTurn = agentTurnRef.current;
            if (abortedTurn.text.trim().length > 0 || abortedTurn.tools.length > 0) {
              const assistantMsg: HistoryItem = {
                // B5-fix: on aborted the server may have
                // emitted a chat_message_completed event with outcome=aborted
                // (resultEventIdRef.current). Use it
                // so reload + live stream don't render twice.
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
            // H1-Fix: turn ends with an error → agentStatus goes to 'error',
            // NOT 'idle'. The queue-flush effect only fires on 'idle',
            // so enqueued messages would hang forever (the stop button is
            // not visible on error → no manual clearing possible). We
            // discard the queue deterministically and show a hint
            // if something was enqueued.
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

            // Bug-Fix 2026-04-25: previously the stream answer was completely
            // lost on outcome=error (e.g. SSE abrupt close, late
            // upstream error after most tokens). Symmetric to
            // 'aborted': if text/tools were already accumulated, persist
            // them as an assistant message instead of dropping them.
            //
            // Phase RL 2026-04-28: detect a rate-limit pattern in the content
            // and replace it with an explanatory toast (instead of bare Anthropic
            // error text). The pattern matches Anthropic-CLI-typical strings.
            const rawText = agentTurnRef.current.text.trim();
            const isRateLimited =
              /temporarily limiting requests|rate.?limited|usage_limit|too many requests/i.test(
                rawText,
              );
            if (isRateLimited) {
              // Phase RL.2 (2026-04-28): auto-retry card with a 30s countdown.
              // Pass `value` (= original user prompt) + attempt counter
              // to the card. On a click on "Jetzt erneut" or at
              // countdown end, the card calls SurfaceAction.reply(prompt)
              // → the provider in ChatShell triggers submit() on the
              // original question. Max 2 auto-retries — then manual.
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
                // B5-fix: same path as 'ok' and 'aborted' — the
                // server already persisted the event with outcome=error under
                // resultEventIdRef.current.
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
              // Bug 1 Fix (2026-05-30, owner „der Chat verliert komplett den
              // Kontext"): when the turn ended WITH an error, but accumulated NEITHER
              // text NOR tools (e.g. `done{is_error}` without a
              // single token — exactly the „Eigenes Video" free-text case),
              // NOTHING used to land in the history → the user saw only the
              // red global banner line and his own bubble without an
              // answer, which feels like „context gone". We now append
              // a fail-soft assistant card with the REAL cause
              // (agentError, no longer generic). The conversation thread
              // (history/workspace/flow) is thus preserved and visibly
              // answerable — the user can write on directly.
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
         // C2-Fix: ALWAYS reset the inflight lock — also on a throw from
         // sendAgent (should not happen, send() catches internally, but
         // defensive). This lets the queue-flush effect (or a new
         // direct submit) cleanly start the next turn.
         submitInflightRef.current = false;
       }
      })();

      return undefined;
    },
    [
      // M1-Fix: history + agentTurn no longer in the deps — read via
      // historyRef/agentTurnRef. This keeps submit from being constantly
      // recreated on an SSE burst (stable submitRef, no flush race).
      currentWorkspace.id,
      isMockPending,
      isStreaming,
      nextId,
      sendAgent,
      showHistory,
      // UX-1: pill-routing inputs (answer branching in the submit handler).
      pillExpanded,
      openQuestions,
      qIndex,
      resetPillState,
    ],
  );

  // submitRef for the queue-flush effect — stable reference without circular deps.
  useEffect(() => {
    submitRef.current = submit;
  }, [submit]);

  // ---- Bug-2-Fix: stop + interrupt-send · 2026-05-25 -------------------
  const handleStop = useCallback(() => {
    abortAgent();
    // Clear the queue on an explicit stop — the user aborted the stream,
    // the waiting messages are thus presumably stale / unwanted.
    // (The user can re-type them if they still want them.)
    messageQueueRef.current = [];
    setQueueLength(0);
  }, [abortAgent]);

  const handleSendNow = useCallback(
    (raw: string) => {
      const value = raw.trim();
      if (value.length === 0) return;
      // C1-Fix: clear the queue FIRST, THEN abortAgent(). Otherwise there is a
      // double-send race: abortAgent() triggers the status transition to 'idle'
      // → the queue-flush effect could shift a still-filled queue
      // + send WHILE handleSendNow also sends. Order:
      //   1) clear the queue (the flush effect finds nothing anymore)
      //   2) abortAgent() (status → idle, the flush effect is now a no-op)
      //   3) initiate the new turn as a setTimeout(0)
      messageQueueRef.current = [];
      setQueueLength(0);
      abortAgent();
      // Send directly: a short setTimeout(0) so the AbortController
      // can set the status to 'idle' before submit() checks isStreaming.
      // queueMicrotask would also be correct — setTimeout(0) is more robust
      // against iOS event-loop quirks.
      window.setTimeout(() => {
        submitRef.current?.(value);
      }, 0);
    },
    [abortAgent],
  );

  // ---- Phase 1 Track AB · finding B: structured answer envelope --------
  // 2026-05-29 (verbatim handoff §7):
  //
  //   „Antworten auf Fragen werden zu einem Textblock 'Frage:.../Antwort:...'
  //    gebaut und als normaler Chat-Turn gesendet. Es ist unklar bzw.
  //    unwahrscheinlich, dass workstreamId, flowRunId, planId, questionSetId
  //    und questionId zuverlässig mitgesendet werden."
  //
  // Owner directive (verbatim, additive): „Die lesbare Chat-Nachricht darf
  // zusätzlich existieren. Die Ausführung darf aber nicht an dieser Chat-
  // Nachricht hängen."
  //
  // → We POST the structured envelope to `/api/chat/answer` IN PARALLEL
  // to the existing chat turn (buildQAReply via submitRef). The endpoint
  // persists into `question_answers` (migration 0117), idempotent via
  // UNIQUE(content_hash) + UNIQUE(source_turn_id, question_id).
  //
  // Fire-and-forget, fail-soft: 401/network/500 are no-ops for the user flow.
  // sourceTurnId = ChatShell-internal HistoryItem.id (created via nextId('user')).
  //
  // Which questions are posted?
  //   ALL OpenQuestions for which `answers[q.id]` is defined (i.e. answered in the
  //   current pill session). Optional fields (flowRunId/planId/
  //   questionSetId/surfaceId) are not yet available in the ChatShell state
  //   today → fail-soft to null (the endpoint accepts null). These fields
  //   are filled by the OpenQuestions renderer/producer once they land in the
  //   payload — they do not travel along today, the structured
  //   store is still correctly indexed (workspaceId + questionId).
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
          // Optionals — not yet in the ChatShell state today; filled
          // once the producer includes them in the OpenQuestion payload.
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
            // keepalive so the POST does not die when the user navigates right
            // after submit (analogous to the dismiss route).
            keepalive: true,
          }).catch(() => {
            /* fail-soft — the structured store is not user-facing */
          });
        } catch {
          /* fail-soft — never block the UI flow */
        }
      }
    },
    [currentWorkspace.id, agentTurn.workstreamId],
  );

  // Stable ref update (see the declaration above + the submit-closure call).
  useEffect(() => {
    postStructuredAnswersRef.current = postStructuredAnswers;
  }, [postStructuredAnswers]);

  // ---- UX-1: pill action handlers · 2026-05-26 -------------------------
  // These live outside the submit handler so the option click uses exactly
  // the same answer logic as the free-text Enter (set → advance → when
  // all answered: one final reply). No double send: the final reply
  // runs via submitRef (which checks streaming again itself).
  // Option click in the pill = answer to the clicked question (the same
  // routePillAnswer logic as the free-text Enter). Sets the answer, jumps to the
  // next open question, or fires the final reply when all are answered.
  const handlePillSelectOption = useCallback(
    (qId: string, option: string) => {
      const qs = openQuestions;
      if (qs.length === 0) return;
      const route = routePillAnswer(qs, qAnswersRef.current, qIndex, qId, option);
      setQAnswers(route.nextAnswers);
      if (route.allAnswered) {
        const qaText = buildQAReply(qs, route.nextAnswers);
        // Phase 1 Track AB · finding B: structured envelope IN PARALLEL to the
        // chat turn. sourceTurnId = the not-yet-existing user turn,
        // which is created shortly via submitRef.current?.(qaText) — we
        // generate the ID in advance (same source: nextId('user')) and
        // post immediately. The real HistoryItem is created in the submit path with
        // an independent ID (no conflict — the user-turn ID
        // and the answer-envelope ID may differ, the
        // envelope only needs ONE stable anchor for idempotency).
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

  // "Antworten absenden" button: final reply over all answered questions.
  const handlePillSubmitAll = useCallback(() => {
    const qs = openQuestions;
    if (qs.length === 0) return;
    const answersNow = qAnswersRef.current;
    const answeredCount = qs.filter((q) => answersNow[q.id] !== undefined).length;
    if (answeredCount === 0) return;
    const qaText = buildQAReply(qs, answersNow);
    // Phase 1 Track AB · finding B: structured envelope IN PARALLEL.
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

  // ---- W4 (2026-05-28): pill dismiss handler ---------------------------
  // OWNER SPEC D: „manueller Dismiss pro Frage". A click on the × symbol of a
  // pill card → remove this one question from the pill state + fail-soft
  // write a `workstream_decisions` audit row (N8 — trace is evidence,
  // not telemetry). The DB write runs as a „best-effort" POST to
  // `/api/chat/open-questions/dismiss`: 401/network/500 are no-ops for the
  // user flow — the UI removal happens independently.
  //
  // DECISION KIND: `override` (see the API route — enum 0071 has no
  // dedicated `question-dismissed` value).
  //
  // CONTEXT RESOLUTION:
  //  - workstreamId: preferably from the live `agentTurn.workstreamId`. If the
  //    live turn is already idle, the backend falls back to `no-workstream`
  //    (fail-soft, 200 with ok=false) — the UI cleans up anyway.
  const handlePillDismiss = useCallback(
    (qId: string) => {
      // Capture the question text BEFORE we change the state — otherwise the
      // text no longer reaches the audit rationale (N1, verbatim).
      const dismissed = openQuestions.find((q) => q.id === qId);
      const dismissedText = dismissed?.text;

      // UI update: id out, adjust the signature to the rest (no re-pop of the same
      // set — population-effect guard).
      setOpenQuestions((prev) => {
        const remaining = prev.filter((q) => q.id !== qId);
        if (remaining.length === prev.length) return prev;
        lastQSignatureRef.current =
          remaining.length === 0 ? null : remaining.map((q) => q.id).join('|');
        // If the dismissed question was the currently visible one, clamp qIndex
        // to the safe range — the pill also clamps internally, but this
        // keeps the state consistent for the next submit.
        if (qIndex >= remaining.length && remaining.length > 0) {
          setQIndex(remaining.length - 1);
        }
        return remaining;
      });

      // Audit write fire-and-forget. workstreamId is optional — if the
      // live turn is idle (no agentTurn.workstreamId), the server returns
      // `ok:false, reason:'no-workstream'` (no error toast). Do NOT await.
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
            // keepalive so the audit POST also does not die when the user
            // navigates right after.
            keepalive: true,
          }).catch(() => {
            /* fail-soft — audit loss is not user-facing */
          });
        } catch {
          /* fail-soft — never block the UI flow */
        }
      }
    },
    [openQuestions, qIndex, agentTurn.workstreamId],
  );

  // ---- Phase Reload-Recovery V2 · 2026-04-27 -------------------------
  // Actions for an `aborted` StreamingBubble.
  //
  // - regenerateFromSnapshot: puts the user prompt of the previous bubble
  //   back into the input field (edit-then-send, see recovery-syn
  //   "open questions" → tendency: edit). Plus discard, so the user does not
  //   have a second "aborted" bubble standing after success.
  //
  // - discardSnapshot: DELETE call to the backend endpoint and remove the item
  //   from the state.
  //
  // TODO(backend): DELETE `/api/chat/snapshot/[pendingPromptId]` must
  // exist. Until then: remove optimistically locally + writeHistoryFor.
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
      // Remove the snapshot locally — as soon as the user presses submit,
      // a fresh stream + fresh completed event comes. Backend DELETE
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

  // Codex parity (goal 2026-06-02): „Neu generieren" on a finished
  // assistant answer. Finds the preceding user prompt and runs it
  // again (fresh turn). Guard against a double submit while a stream
  // is running — otherwise two turns compete for the same workspace.
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

  // ---- Scroll-position restore (Reload-Recovery V2) ------------------
  // Spec from point 6 of the synthesis:
  //   - an active stream exists → jump to the end
  //   - only aborted → restore the sessionStorage position
  // The default WhatsApp logic (see above) already jumps to the end when
  // nearBottom; here we only add the restore case.
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

  // Persist the scroll position continuously so restore has it.
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

  // P1 · One-Focal-Point (2026-06-02). Observes in the stream container whether the
  // proactive SubchatPulse card is currently rendering a card (it otherwise returns
  // `null`). Detection via its stable `aria-label` section — no coupling/
  // prop intrusion into SubchatPulse (not part of this slice). Only active in the
  // empty state (otherwise there is no hero to dampen). MutationObserver →
  // reacts to the later arrival of the card (15s poll/live event), without
  // a re-render loop. Fail-soft: no container → default (no effect).
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
      // Throw away the live snapshot too — otherwise on re-mount the
      // mid-stream recovery effect comes and "restores" an old assistant message,
      // which the user sees as "back after clearing the history".
      clearLiveFor(currentWorkspace.id);
    } catch {
      // ignore
    }
    // Server-side clear marker (2026-06-02): makes „Verlauf leeren"
    // cross-device persistent. Previously it was purely client-local → the
    // event-log history came back on reload / on another device.
    // Append-only (deletes nothing, sets a cutoff) + best-effort:
    // an error must not undo the local clear.
    try {
      void fetch(
        `/api/chat/history/${encodeURIComponent(currentWorkspace.id)}/clear`,
        { method: 'POST', headers: { accept: 'application/json' } },
      ).catch(() => undefined);
    } catch {
      // ignore
    }
    // Abort the active stream so it does not push a message after all.
    abortAgent();
  }, [currentWorkspace.id, abortAgent]);

  // ---- Auto-project seam · receiving side (2026-06-02) -----------------
  // After the hard switch into the freshly created project workspace, the
  // build prompt lies in sessionStorage. Once the new page is hydrated and stands
  // on a REAL (non-virtual) workspace, we send it ONCE →
  // the agent builds there (build mode + real path + fresh session). A guard ref
  // prevents a double submit; a short delay so composer/session are ready.
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
          // Synchronous flush: setHistory is async, the useEffect persistence
          // only runs on the next render. On a tab switch + immediate
          // re-mount the surface can be lost. Therefore write directly.
          writeHistoryFor(currentWorkspace.id, next);
          return next;
        });
      }}
    >
    <PinnedDecisionRegistryProvider pinnedHeadline={pinnedDecisionSig}>
    <RunCockpitRegistryProvider>
    <main style={chatMainStyle}>
      {/* Mobile conversation header (mobile-IA realign 2026-06-06). The chat is
          a conversation, so it gets the standard messenger top row: BACK to the
          /chats overview + the active workspace title. Mobile-only (hidden
          ≥768px via .chat-conversation-header CSS) — desktop keeps the
          TopNav + persistent switcher. The engine pill stays inline in the
          composer area (not duplicated here). */}
      <Link
        href="/chats"
        className="chat-conversation-header"
        aria-label="Zurück zur Chat-Übersicht"
      >
        <span className="chat-conversation-header__back" aria-hidden="true">
          <svg
            width={22}
            height={22}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.7}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M15 5l-7 7 7 7" />
          </svg>
        </span>
        <span className="chat-conversation-header__title">
          {currentWorkspace.label || 'Chat'}
        </span>
      </Link>
      <section style={sectionStyle}>
        <div ref={streamRef} style={streamStyle} aria-busy={isPending}>
          {/*
            2026-05-03 (user finding: "tab bar oben ist sinnfrei und nicht
            übersichtlich") — sticky toolbar removed. The chat IS the
            command center: slash commands in the composer (`clear`, `compact`,
            `session-new`, `stop`) reach all actions directly. The history
            is toggled via a subtle inline link at the very top of the stream,
            only visible when archived items exist.
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
          {/* User wish 2026-05-01: "the push popup must ALWAYS come on the first
              PWA open". An inline surface card, NO overlay
              (Sub-Plan-3-compliant). Self-gates: renders only when
              permission='default' + not prompted + PWA/desktop. */}
          <PushAutoPrompt
            vapidPublicKey={process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? ''}
          />
          {/* Gathering-Intelligence (2026-06-02): proactive sub-chat card.
              AGGREGATES across workspaces (the main chat sits on the
              org-root, customer chats hang on real customer workspaces) — appears
              at the top of the feed as soon as something new arrives externally
              in ANY customer chat. Renders itself away when nothing new is there
              (no chrome in the empty chat). Always mounted. */}
          <SubchatPulse onPickUp={handleSubchatPickUp} />
          {history.length === 0 && systemMessages.length === 0 && !isPending ? (
            // P1: if the proactive pickup/INTERNAL card is present, the hero
            // is downgraded to a quiet top-anchored intro (one primary
            // surface per screen — the card above leads).
            <EmptyState deEmphasized={pulseCardPresent} />
          ) : (
            <Chat>
              {/*
                Bug B Fix 2026-04-26: chronological interleaving instead of
                "history block + systemMessages block". Previously
                workstream toasts ALWAYS landed at the bottom, regardless of when
                they happened in time. Now: one sorted list, every item
                renders according to its role.

                Sub-Plan B · 2026-04-29: the filter applies showHistory.
                Default (showHistory=false) hides all archived items.
                SystemItems are transient and never archived — they
                are always shown.
              */}
              {(() => {
                type RenderItem = (HistoryItem & { _kind: 'history' }) | (SystemItem & { _kind: 'system' });
                // Sub-Plan A + B · 2026-04-29 — render filter:
                //   chatItems = history.filter(item => showHistory || !item.archived)
                // showHistory comes from Sub-Plan B's state (toggle pill).
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
                        {/* SystemItems are transient and not
                            cached — the renderer falls back to its own
                            regex path (parsed=undefined). */}
                        <TextWithHighlights text={it.content} />
                      </MsgSystem>
                    );
                  }
                  // Sub-Plan B · 2026-04-29: archived items are rendered with a
                  // dimmed look when showHistory=true (opacity
                  // 0.6 + left gray border). No animation, no
                  // modal layer — just a visual hint "this is old context".
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
                    // If the item comes from a streaming_snapshot
                    // (streamState set), render the special
                    // StreamingBubble instead of the normal assistant bubble.
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
                          // onCopy: the component does that itself via navigator.clipboard.
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
                  // Follow-up fix (2026-05-26): the sent user bubble must
                  // RENDER surfaces, not show them as raw text. On an
                  // attachment send, `it.content` contains a
                  // `<surface:document>…</surface:document>` (+ caption) — without
                  // surface parsing this would stay literal text and the attachment
                  // would be invisible in the bubble (no thumbnail/no card).
                  // We therefore route through the same surface-aware renderer as
                  // for the assistant — but ONLY when the item actually has surfaces,
                  // so pure text messages render bit-exact as before
                  // (no unwanted markdown on user input).
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
                Typing-pill dedupe (2026-05-03): render the TypingIndicator ONLY
                when neither StreamingAssistant nor a BugFixSwarmCard / SubAgentCard
                shows phase text + caret in the same conversation. Otherwise
                the user saw in parallel: TopNav pulse + StreamingAssistant caret
                + phase dots + this own indicator = 3-4× "typing now".
                Rule: passive mock/server-pending AND no active isStreaming.
              */}
              {!isStreaming && (isMockPending || serverStreamPending) ? <TypingIndicator /> : null}
              {/*
                Inline worker status (2026-05-03): shows OTHER running
                workstreams in the same workspace directly in the chat. A mobile boost
                because the TopNav pulse pill was hard to find on phone.
                Filters out the own active workstream, otherwise a duplicate
                with StreamingAssistant.
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
          {/* Auto-scroll end marker (Sub-Plan 01 v3 2026-04-29).
              scrollIntoView on this empty div = WhatsApp standard. */}
          <div
            ref={streamEndRef}
            aria-hidden="true"
            style={{ height: 1, width: '100%' }}
          />
          {/*
            WhatsApp-style floating-down button. Only visible when the user
            scrolled up AND a new message came in.
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
            {/* Full-access/All-Access toggle directly next to the engine pill
                (owner directive 2026-05-26). Same workspaceId. */}
            <AllAccessToggle workspaceId={currentWorkspace.id} />
            {/* Gathering-Intelligence (2026-06-02): access to the customer chats.
                Mobile (owner finding „nicht mobiloptimiert"): a compact icon-only
                button instead of a label pill → fits without wrapping in one line next to
                the engine pill + full access. Real workspaces → sub-chat list; on
                the org-root → workspace selection. */}
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

          {/* Slice 2 (2026-05-30, Apple-UX): ActionDeck — ONE pinned region.
              Gate (DB projection, owner finding #1) OR the existing Q/A pill
              (UX-1, Codex style) — NEVER both at the same time (the gate takes precedence).
              Same DOM position/composerWrap as before → flexbox pinning
              untouched. Question path = today's pill 1:1 (nav/options/dismiss/
              ask-but-proceed all preserved). Gate action → ChatShell (single
              submit path), no double routing. */}
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
              // Workstream 4b (2026-05-27): ask-but-proceed signal. The run counts
              // as „läuft weiter" as long as it is streaming OR the server stream
              // is still pending (parallel work after the question).
              runActive: isStreaming || serverStreamPending,
              // W4 (2026-05-28): manual dismiss per question. Renders the ×
              // symbol in the pill; a click removes the card + writes fail-
              // soft a workstream_decisions audit row (override).
              onDismiss: handlePillDismiss,
            }}
          />

          {/* STAGING (owner hard requirement 2026-05-26): fixed attachment
              preview ABOVE the composer. File(s) stay visible here until
              send OR ×; meanwhile the user can type a caption. */}
          <StagedAttachmentsBar
            attachments={stagedAttachments}
            onRemove={handleRemoveStaged}
            uploadingName={cloudUpload.uploading ? cloudUpload.currentFilename : null}
          />

          {/* The composer stays OPERABLE during the upload — the user should be
              able to type the caption while the file uploads (staging
              model). Only the paperclip button disables itself via
              `uploading`. The input is never hard-locked. */}
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
            Engine-pill dedup (2026-05-23 · user feedback "Absolute Katastrophe").
            BEFORE: a second EnginePill BELOW the composer (selector with
            Parallel/Claude/Codex/Ollama dropdown). IN PARALLEL, ChatTopBar already
            existed ABOVE the composer (display: model + CTX + turns).
            AFTER: ChatTopBar IS now the only pill and unites
            display + selector in ONE pill (see ChatTopBar.tsx). This
            spot is deliberately left empty as a marker for the dedup decision.
          */}

          {sttError ? (
            <div role="alert" style={sttErrorStyle}>
              {formatSttError(sttError)}
            </div>
          ) : null}

          {/*
            Wave 1 · 2026-05-03 · Sub-Plan dazzling-quilt
            ----------------------------------------------------------------
            stream-footer REMOVED — the block had duplicated the phase text + dots
            that already stand in the StreamingAssistant bubble.
            User frustration 2026-05-03: "auf app.laz.ing ist immer noch
            redundant". Single source of truth now: useTypingIndicator
            in StreamingAssistant. The stop button now lives as a small
            floating pill on the right edge of the live bubble (see
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
// Inline icon (local, NO cross-file change): sync-retry refresh.
// SVG, currentColor, 1.6 stroke, round caps — inherits resetBtnStyle.color.
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

// Clock/timer glyph for the turn footer (replaces the previous timer emoji).
// Same 24×24-currentColor-1.6-stroke family as the nav icons.
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
// Assistant renderers (unchanged from before)
// ---------------------------------------------------------------------

function AssistantItem({
  message,
  parsed,
  pinnedQuestionIds,
  onRegenerate,
}: {
  message: HistoryItem;
  /**
   * Codex parity (2026-06-02) — „Neu generieren" for this answer
   * (runs the preceding user prompt again). Omitting hides the
   * regenerate button; copy is always available.
   */
  onRegenerate?: () => void;
  /**
   * Sub-Plan E (2026-04-30) — pre-parsed surface list. When the
   * augmented content equals the original, we pass the cache
   * array through to renderChatText. On augmentation (synthesis fallback)
   * we fall back to the regex path, because the cache belongs to the original,
   * not to the augmented string.
   */
  parsed?: ParsedHistoryItem;
  /**
   * Bug-5-Fix (2026-05-30) — IDs of the questions currently pinned in the pill.
   * The inline surface/markdown twin of these questions is stripped from the
   * bubble (dedup; the pill is the canonical interactive source).
   */
  pinnedQuestionIds?: ReadonlySet<string>;
}) {
  // Phase AC fallback (2026-04-26): if the HistoryItem is a synthesis
  // (pattern "## Konsolidierter Plan" / "## Sub-Tickets") but contains NO
  // <surface:consensus-action> tag (an old bubble before v42), append the
  // tag client-side so the SurfaceRenderer renders the card.
  // Without this augment the user would have to look at the old bubble
  // non-actionably + navigate to the master.
  const augmentedBase = augmentSynthesisIfNeeded(message);
  // Bug-5-Fix: strip pinned question surfaces from the bubble. If something
  // was stripped, the cache (startIdx/endIdx) is no longer valid → we
  // force the re-scan path (cacheSurfaces=undefined).
  const stripped =
    pinnedQuestionIds && pinnedQuestionIds.size > 0
      ? stripPinnedQuestionSurfaces(augmentedBase, pinnedQuestionIds)
      : { content: augmentedBase, changed: false };
  const augmentedContent = stripped.content;
  // Only use the cache when the content stayed unchanged (= no augment suffix
  // AND no strip). Otherwise the surface indices are off.
  const cacheSurfaces =
    parsed !== undefined &&
    augmentedContent === message.content &&
    !stripped.changed
      ? parsed.surfaces
      : undefined;

  // Codex parity (2026-06-02): prose text for the copy action — strip surface tags
  // (toasts/cards/plans) so „Kopieren" delivers the readable answer,
  // not `<surface:toast>{…}</surface:toast>`. If an answer has NO
  // prose (pure card), the action row stays off.
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

  // Bug-5-Fix: if stripping the pinned question surface left the bubble EMPTY
  // (it consisted only of the question, which now lives in the pill),
  // we render NO empty assistant card. Only relevant when something was
  // actually stripped — otherwise the old behavior stays bit-exact.
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

// Phase AC fallback (2026-04-26): if message is a synthesis output
// and has no consensus-action tag, append the tag client-side based on a
// consensus heuristic. Side-effect-free (returns the augmented string).
function augmentSynthesisIfNeeded(message: HistoryItem): string {
  if (message.role !== 'assistant') return message.content;
  const c = message.content;
  // Already augmented?
  if (c.includes('<surface:consensus-action>')) return c;
  // Synthesis pattern? Heuristic: contains "## Konsolidierter Plan" or
  // "## Sub-Tickets" or "## Cluster-".
  const isSynth =
    /##\s+Konsolidierter\s+Plan/i.test(c) ||
    /##\s+Sub-Tickets/i.test(c) ||
    /##\s+Cluster-/i.test(c);
  if (!isSynth) return c;
  // Extract workstream/master IDs from the content — we do not have them
  // directly here. Fallback: empty workstreamId, the card then renders
  // nothing (the renderer requires workstreamId). This augmentation thus
  // primarily helps for live events where the tag was already set in the
  // handleEvent path — for old bubbles without a workstream-ID marker
  // the card stays off, the user sees "only" the plan text. Not ideal, but
  // robust: no blind auto-dispatch with an unknown workstream ID.
  return c;
}

/**
 * Live streaming assistant — token-by-token display for a native chat feel.
 *
 * 2026-05-01 (streaming-UX wave):
 *  - inline styles out, via `.bub-live` + `.bub-caret` from components.css.
 *  - subtle fade-in per token append via `.bub-live__token-fresh` (key changes
 *    on a text-length change, so only the last chunk re-animates).
 *  - phase footer with reading awareness:
 *      - before the first token:  "Liest deine Frage …"
 *      - during the token stream:  "Schreibt …"
 *      - during the tool pipeline: "Sucht in Workspace-Daten …" / tool-specific
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

  // Wave 1 · 2026-05-03: single source of truth for phase + label.
  // Replaces the old local describePhase logic. Consumers of the bubble
  // now get ONE deterministic state instead of three strings computed
  // in parallel.
  const indicator = useTypingIndicator({
    workstreamId: turn.workstreamId,
    isStreaming: true, // this bubble is only rendered when isStreaming=true
    isMockPending,
    serverStreamPending,
    agentTurn: { text: turn.text, tools: turn.tools },
    agentStatus,
  });
  const phase: TypingPhase = indicator.phase ?? 'reading';
  const phaseLabel = indicator.label;

  // Subtle token fade: as soon as `text.length` changes, the React key changes
  // on an invisible wrapper around the last char block. We do not re-animate
  // the whole text — otherwise the bubble flickers on every token tick.
  // Trick: split at the last whitespace boundary; everything before is static,
  // the tail slice (max 24 chars) gets the fade-in class.
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
          2026-05-04: stop button OUT of the bubble (user finding:
          "verbuggtes surface mit stop button drin, sieht katastrophal
          aus, kein steve jobs apple design"). iMessage pattern: a clean
          bubble, stop moves into the composer (the send button morphs to a
          stop square during streaming). `onAbort` is wired via the composer,
          here it is only visually gone.
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
            Caret dedupe (2026-05-03): leading caret removed — when the assistant
            has no text yet, the typing dots + phase text below are already
            the activity indicator. The double display (caret + dots + "Liest …")
            acted as "3× typing now". The trailing caret only shows during
            a real token stream.
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

// describePhase + toolPhaseLabel: migrated 2026-05-03 to lib/chat/useTypingIndicator.ts.
// Single source of truth for the phase label. This file only holds
// the JSX component anymore.

/**
 * Token-tail splitter: returns the static `head` and the fresh `fresh` slice
 * so that only the last chunk re-animates. Splits at the last
 * whitespace within the last 24 characters; fallback: everything is `head`.
 */
function extractFreshTail(text: string): { head: string; fresh: string } {
  const FRESH_MAX = 24;
  if (text.length <= FRESH_MAX) return { head: '', fresh: text };
  const tailRegion = text.slice(-FRESH_MAX);
  const wsIdx = tailRegion.search(/\s\S*$/);
  if (wsIdx === -1) {
    // No whitespace in the tail region -> long word, do not fade
    return { head: text, fresh: '' };
  }
  const splitAt = text.length - FRESH_MAX + wsIdx + 1;
  return { head: text.slice(0, splitAt), fresh: text.slice(splitAt) };
}

/**
 * Renders assistant text with inline surface cards + **bold** highlights.
 *
 * The agent emits `<surface:chart>{...}</surface:chart>` tags in its
 * output → we split that here into text + surface segments.
 *
 * Sub-Plan E (2026-04-30): the optional `surfaces` prop is an already
 * pre-parsed list from `parseHistoryItem` (cache path). When not
 * set, `renderChatText` falls back to its internal regex scan.
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
  // Wave 4 (2026-05-01): typing dots switched to the .typing-dots CSS class with
  // @keyframes typing-pulse (see components.css B'').
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
 * Empty state — radically minimal.
 * One sentence. No kicker, no tip, no chip.
 */
/**
 * P1 · One-Focal-Point (2026-06-02, UI/UX a11y pass).
 *
 * One primary task per screen. If a proactive pickup/INTERNAL card
 * (SubchatPulse) is above the empty state, the centered hero must not compete
 * with it for focus. `deEmphasized=true` anchors the intro at the top with
 * generous spacing (smaller, left-aligned, dimmed) — the card below
 * reads as the ONE primary surface. Without the card the quiet, centered
 * hero stays. A pure style swap, no behavior/text loss.
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
 * Best-effort DELETE of the streaming snapshot in the backend. The snapshot
 * item comes from the history endpoint as a HistoryItem with a `streamState` field;
 * pendingPromptId is in the item field. We fire a DELETE call
 * and ignore the result (removed optimistically in the UI).
 *
 * TODO(backend): implement `DELETE /api/chat/snapshot/[pendingPromptId]`
 * with an auth gate (same cookie pattern as /api/chat/history). Until then
 * the endpoint answers 404 and we treat that as a no-op.
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
    /* offline / 404 — the UI is already optimistically updated */
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

// The chat page occupies the full viewport height so the stream container
// scrolls, NOT the page. This solves the iOS bug "at scroll-top the
// movement drags the body": when the page itself has no scroll anymore,
// iOS cannot bounce into it either. The TopNav height is compensated via a CSS
// variable (set on TopNav mount; fallback 64px).
// Robust layout: main fills the viewport between TopNav and the bottom edge.
// NO .sheet class (whose padding was the source of many iOS glitches).
// Containment isolates the layout from the rest of the DOM — no bleeding.
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
  // 2026-04-26 — relative so the floating-down button can be
  // positioned absolutely within it.
  position: 'relative',
};

// WhatsApp-style floating-down button. Bottom left, above the composer,
// appears only when the user has scrolled up and new messages
// come in.
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

// Stream: takes the available height, scrolls as the only surface.
// contain:strict isolates layout/paint - no scroll-anchor jumps,
// no layout bleeds to the outside.
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

// P1 · de-emphasized empty state: top-anchored, generous spacing, no
// minHeight block — the proactive card below is the ONE primary surface.
const emptyDeEmphStyle: CSSProperties = {
  marginTop: 8,
  padding: 'clamp(16px, 3vw, 28px) clamp(20px, 4vw, 40px) clamp(20px, 4vw, 32px)',
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'flex-start',
};

// Smaller + dimmed (ink-2) + left-aligned → reads as a quiet intro, not as a
// competing hero. N1: identical text, only the visual weight reduced.
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
// have moved into `.stream-footer*` (components.css)
// (2026-05-01 streaming-UX wave).

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
