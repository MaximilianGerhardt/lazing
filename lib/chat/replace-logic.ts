/**
 * lib/chat/replace-logic.ts
 * --------------------------
 * Sub-Plan A · 2026-04-29. Pure helpers for the one-card-per-workstream
 * replace logic. Deliberately split out from ChatShell.tsx so the functions
 * (a) are testable in Vitest without a React bundle and
 * (b) can be referenced both by ChatShell.tsx and by storage.ts
 *     without a circular-import risk.
 *
 * No DOM/React/localStorage dependencies — pure data transformation.
 */

import type { HistoryItem } from './ChatShell';
// NOTE: TYPE import only — no runtime cycle, because tsc/SWC strips the import
// out. ChatShell imports functions from this file
// for the replace path.
import {
  SURFACE_KINDS,
  extractWorkstreamCoords,
  extractWorkstreamCoordsLoose,
  type SurfaceKind,
  type WorkstreamCoords,
} from './surface-parser';

// ---------------------------------------------------------------------------
// Sub-Plan 3 · Cluster-Mapping (2026-05-01)
// ---------------------------------------------------------------------------
// Lazy rewrite: old surface kinds from persisted history items are mapped
// to their new cluster kinds. The renderer aliases in
// SurfaceRenderer.tsx ensure old tags are still rendered correctly
// — but for the replace logic (one card per
// workstream) old and new kinds must be treated as the same slot,
// otherwise during a live migration two "living"
// cards (old iterate-pipeline + new workflow) coexist for the same workstream.
//
// `canonicalKind(kind)` returns the cluster kind. `surfaceSlot()` is the
// identity against which `archiveStalePeers` compares.
// ---------------------------------------------------------------------------

const CLUSTER_KIND_MAP: Record<string, SurfaceKind> = {
  // Cluster A
  'pipeline': 'workflow',
  'live-pipeline': 'workflow',
  'workflow-pipeline': 'workflow',
  'iterate-pipeline': 'workflow',
  // Cluster B
  'iterate-roast': 'workflow',
  'iterate-version': 'workflow',
  'user-correction': 'workflow',
  // Cluster C
  'form': 'prompt',
  'credential-prompt': 'prompt',
  'open-questions': 'prompt',
  'plan-open-questions': 'prompt',
  'quickchoice': 'prompt',
  'decision': 'prompt',
  // Cluster D
  'agent': 'agent-step',
  'swarm': 'agent-step',
  'live-swarm': 'agent-step',
  'bug-fix-swarm': 'agent-step',
  'loop-phase': 'agent-step',
  'tier-choice': 'agent-step',
};

export function canonicalKind(kind: SurfaceKind | undefined): SurfaceKind | undefined {
  if (!kind) return undefined;
  const mapped = CLUSTER_KIND_MAP[kind];
  return mapped ?? kind;
}

function slotsEqual(a: SurfaceKind | undefined, b: SurfaceKind | undefined): boolean {
  if (!a || !b) return false;
  return canonicalKind(a) === canonicalKind(b);
}

/**
 * Hydrate migration on a single HistoryItem.
 *
 * Reads workstreamId + surfaceKind from the persisted content
 * (regex-light), if the item comes from a pre-Sub-Plan-A build.
 *
 * Sub-Plan A Finding 5 (2026-04-29): marker skip — if `_coordsHydrated`
 * is already set, we return the item directly. This way the regex runs
 * per item only ONCE (on the first read) and not on every re-render.
 */
export function hydrateWorkstreamCoords(item: HistoryItem): HistoryItem {
  if (item._coordsHydrated) return item;
  if (item.workstreamId && item.surfaceKind) {
    return { ...item, _coordsHydrated: true };
  }
  if (typeof item.content !== 'string' || item.content.length === 0) {
    return { ...item, _coordsHydrated: true };
  }
  const coords = extractWorkstreamCoordsLoose(item.content);
  if (!coords) {
    return { ...item, _coordsHydrated: true };
  }
  return {
    ...item,
    workstreamId: item.workstreamId ?? coords.workstreamId,
    surfaceKind: item.surfaceKind ?? coords.surfaceKind,
    _coordsHydrated: true,
  };
}

/**
 * One-card-per-workstream replace.
 *
 * If `incoming` carries a surface bubble with a `(workstreamId, surfaceKind)`
 * match (either already in the fields or extractable from the content),
 * ALL previous, not-yet-archived items in the `prev` array with the same
 * coords are set to `archived=true`.
 * Then `incoming` itself is returned with filled coord fields
 * so the caller can append it as a "living" card.
 *
 * Pure + idempotent. Mutates nothing.
 */
export function archiveStalePeers(
  prev: HistoryItem[],
  incoming: HistoryItem,
): { prev: HistoryItem[]; incoming: HistoryItem } {
  let workstreamId = incoming.workstreamId;
  let surfaceKind = incoming.surfaceKind;
  if (!workstreamId || !surfaceKind) {
    const fromContent = extractWorkstreamCoords(incoming.content);
    if (fromContent) {
      workstreamId = workstreamId ?? fromContent.workstreamId;
      surfaceKind = surfaceKind ?? fromContent.surfaceKind;
    }
  }
  if (!workstreamId || !surfaceKind) {
    return { prev, incoming };
  }
  const filledIncoming: HistoryItem = {
    ...incoming,
    workstreamId,
    surfaceKind,
  };
  let mutated = false;
  const nextPrev = prev.map((it) => {
    if (it.archived) return it;
    if (it.id === incoming.id) return it;
    if (it.workstreamId !== workstreamId) return it;
    // Sub-Plan 3 (2026-05-01): cluster merge — old kind tags and new
    // cluster kinds count as the same slot. This way an old
    // `iterate-pipeline` card is replaced by a new `workflow` card of the same
    // workstream (instead of coexisting side by side).
    if (!slotsEqual(it.surfaceKind, surfaceKind)) return it;
    mutated = true;
    return { ...it, archived: true };
  });
  return { prev: mutated ? nextPrev : prev, incoming: filledIncoming };
}

// ---------------------------------------------------------------------------
// Sub-Plan 3 · Max-3-Active-Cards-Enforcement (2026-05-01)
// ---------------------------------------------------------------------------
// Limits the number of simultaneously visible (= not archived)
// surface items per workspace to `cap`. Counts only HistoryItems with
// `surfaceKind` (= real cards), plain-text assistant messages are
// ignored. Archives the oldest above (cap-1) BEFORE `incoming`
// is appended — so after the append at most `cap` cards are live.
//
// Idempotent + pure. Mutates nothing. If `incoming` itself is not a
// surface card, `prev` is returned unchanged.
//
// Sort order: oldest first (TS ascending, tiebreak via id).
//
// 2026-05-03 (Bug 1, user complaint "card disappears while the worker
// is still running"): live cards (surface payload with `status` OR `state`
// OR `phase` that is NOT in TERMINAL_STATES) are EXEMPTED from the cap.
// Trim affects only finalized cards — otherwise the cap kills a running
// pipeline mid-stream and Max suddenly sees no live status anymore even
// though the backend worker is still working.
// ---------------------------------------------------------------------------

const TERMINAL_STATES: ReadonlySet<string> = new Set([
  'done',
  'closed',
  'failed',
  'aborted',
  'cancelled',
  'canceled',
  'rejected',
  'executed',
  'completed',
  'error',
  'denied',
]);

// Extract the first surface-tag payload from the content. We search exactly
// the tag whose kind == item.surfaceKind (or the first, if none
// matches — robust against cluster aliases).
const SURFACE_TAG_RE_CAP = /<surface:([a-z][a-z0-9_-]*)>([\s\S]*?)<\/surface:\1>/g;

function extractStatusFields(item: HistoryItem): {
  status: string | null;
  state: string | null;
  phase: string | null;
} {
  const result = { status: null as string | null, state: null as string | null, phase: null as string | null };
  if (typeof item.content !== 'string' || item.content.length === 0) return result;
  SURFACE_TAG_RE_CAP.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SURFACE_TAG_RE_CAP.exec(item.content)) !== null) {
    const [, kindRaw, jsonRaw] = match;
    let data: unknown = null;
    try {
      data = JSON.parse(jsonRaw);
    } catch {
      data = null;
    }
    if (!data || typeof data !== 'object') continue;
    const obj = data as Record<string, unknown>;
    // Prefer the tag whose kind matches item.surfaceKind.
    const isPreferred = item.surfaceKind === undefined || kindRaw === item.surfaceKind;
    if (typeof obj.status === 'string' && (result.status === null || isPreferred)) {
      result.status = obj.status;
    }
    if (typeof obj.state === 'string' && (result.state === null || isPreferred)) {
      result.state = obj.state;
    }
    if (typeof obj.phase === 'string' && (result.phase === null || isPreferred)) {
      result.phase = obj.phase;
    }
    if (isPreferred && (result.status || result.state || result.phase)) break;
  }
  return result;
}

/**
 * Returns true if the surface card is currently live — i.e. a
 * backend worker is still working in the background. Heuristic:
 *
 *   - `status` OR `state` OR `phase` set in the surface JSON AND
 *     the value is NOT contained in TERMINAL_STATES.
 *   - If none of the three fields exists: NOT live (default = trimmable).
 *     This is conservative — live cards SHOULD set a status field,
 *     cards without a status are safe trim candidates.
 *
 * Examples live=true:
 *   - `<surface:agent>{"status":"läuft"}</surface:agent>`
 *   - `<surface:workflow-pipeline>{"state":"executing"}</surface:workflow-pipeline>`
 *   - `<surface:workflow>{"phase":"running"}</surface:workflow>`
 *
 * Examples live=false (= trimmable):
 *   - `<surface:agent>{"status":"done"}</surface:agent>`
 *   - `<surface:workflow>{"phase":"closed"}</surface:workflow>`
 *   - card without status/state/phase in the payload.
 */
export function isLiveActiveCard(item: HistoryItem): boolean {
  if (!item.surfaceKind) return false;
  const { status, state, phase } = extractStatusFields(item);
  const candidates = [status, state, phase].filter(
    (s): s is string => typeof s === 'string' && s.length > 0,
  );
  if (candidates.length === 0) return false;
  // Live = at least ONE set status that is NOT terminal.
  // If all set values are terminal → finalized → trimmable.
  return candidates.some((s) => !TERMINAL_STATES.has(s.toLowerCase()));
}

export function enforceActiveCap(
  prev: HistoryItem[],
  incoming: HistoryItem,
  cap: number = 3,
): HistoryItem[] {
  if (cap < 1) return prev;
  if (!incoming.surfaceKind) return prev;
  // 2026-05-02 fix: cap PER workstreamId, NOT global. Otherwise the
  // cap chokes off streams from several workstreams running in parallel —
  // user finding "no more feedback in the Demo Fitness chat" due to
  // disappearing live tier-output and iterate cards.
  const incomingWsId =
    typeof incoming.workstreamId === 'string' ? incoming.workstreamId : null;
  if (!incomingWsId) return prev;
  // Collect all active cards of the SAME workstream (incl. those that
  // archiveStalePeers just archived — but without `incoming`
  // itself, which is not yet in `prev`).
  const active: HistoryItem[] = prev.filter(
    (it) =>
      !it.archived &&
      typeof it.surfaceKind === 'string' &&
      it.workstreamId === incomingWsId &&
      it.id !== incoming.id,
  );
  // 2026-05-03 (Bug 1): live cards are off-limits. The cap affects only
  // finalized (or status-less) cards.
  const trimmable = active.filter((it) => !isLiveActiveCard(it));
  // Limit: after appending `incoming` that would be active.length+1 living
  // cards. Allowed is cap. We CANNOT archive live cards —
  // so we archive as many trimmable ones as needed (or possible).
  // If not enough are trimmable (= too many live cards): the cap is
  // exceeded, but no live worker is lost.
  const overflow = active.length + 1 - cap;
  if (overflow <= 0) return prev;
  // We can archive at most trimmable.length cards. If that does not
  // suffice to cover the overflow (= too many live cards), archive
  // as many as possible — the user then sees > cap cards, but
  // NO live worker disappears.
  const toArchiveCount = Math.min(overflow, trimmable.length);
  if (toArchiveCount <= 0) {
    // Everything active is live — hands off.
    return prev;
  }
  // Oldest first — TS ascending, tiebreak via id (deterministic).
  const sorted = [...trimmable].sort((a, b) => {
    const aTs = Date.parse(a.ts);
    const bTs = Date.parse(b.ts);
    if (Number.isFinite(aTs) && Number.isFinite(bTs) && aTs !== bTs) {
      return aTs - bTs;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const toArchive = new Set(sorted.slice(0, toArchiveCount).map((it) => it.id));
  if (toArchive.size === 0) return prev;
  return prev.map((it) =>
    toArchive.has(it.id) ? { ...it, archived: true } : it,
  );
}

// ---------------------------------------------------------------------------
// Sub-Plan E · 2026-04-30 — Single-Pass-Coord-Cache
// ---------------------------------------------------------------------------
// Goal: today both `extractWorkstreamCoords` (ChatShell setHistory
// path) and `renderChatText` (surface-text-render.tsx, per render pass)
// scan the same surface markup with their own regex. With long histories and
// frequent renders this explodes into O(N items × M renders × K regex-runs).
//
// `parseHistoryItem` pulls the scan ONCE per item.id and returns:
//   - workstreamId/surfaceKind (for the replace logic)
//   - the complete surface list (for renderChatText cache-aware)
//   - plain text with surface tags removed
//
// ChatShell builds a useMemo<Map<id, ParsedHistoryItem>> from the history and
// passes the surfaces as a prop into the render path. surface-text-render.tsx
// accepts the array instead of running its own scan.
// ---------------------------------------------------------------------------

/**
 * A single surface tag as it appears in the content. The order is
 * stable (appearance order in the content), `startIdx` / `endIdx` are
 * byte positions in the *original* `content` string — the renderer needs
 * them to filter out the text gaps between the tags.
 *
 * `data` is `unknown` because the incoming JSON is unvalidated; the
 * `SurfaceRenderer` does the type narrowing per kind.
 */
export interface ParsedSurface {
  kind: SurfaceKind;
  data: unknown;
  raw: string;
  startIdx: number;
  endIdx: number;
}

export interface ParsedHistoryItem {
  itemId: string;
  /** Coords of the dominant surface block (first valid tag with workstreamId). */
  coords: WorkstreamCoords | null;
  /** All recognized surface tags in appearance order. */
  surfaces: ParsedSurface[];
  /** Content with all surface-tag spans removed (for pure text search/highlights). */
  plainText: string;
}

// Reuse the same pattern as surface-parser.ts. Deliberately local, so a
// change there does not silently flip the cache semantics (compile-time check
// via the SurfaceKind whitelist just below).
const SURFACE_TAG_RE_E = /<surface:([a-z][a-z0-9_-]*)>([\s\S]*?)<\/surface:\1>/g;

function isParseSurfaceKind(s: string): s is SurfaceKind {
  return (SURFACE_KINDS as readonly string[]).includes(s);
}

/**
 * Single-pass scan over `item.content`. Returns all surface tags + coords
 * + plain text. Invalid JSON bodies are still recorded as a `surfaces`
 * entry without valid `data` (`data === null`), so the
 * renderer takes the same fallback path as today.
 *
 * Pure — no DOM, no React, no localStorage.
 */
export function parseHistoryItem(item: HistoryItem): ParsedHistoryItem {
  const itemId = item.id;
  const content = typeof item.content === 'string' ? item.content : '';
  if (content.length === 0) {
    return { itemId, coords: null, surfaces: [], plainText: '' };
  }

  const surfaces: ParsedSurface[] = [];
  let coords: WorkstreamCoords | null = null;
  let plainParts: string[] = [];
  let lastIndex = 0;

  SURFACE_TAG_RE_E.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SURFACE_TAG_RE_E.exec(content)) !== null) {
    const [full, kindRaw, jsonRaw] = match;
    const start = match.index;
    const end = start + full.length;

    // take the plain-text segment before this tag (even if the kind
    // is unknown — the tag itself is listed as a `surface` anyway
    // or rendered via the renderer fallback).
    if (start > lastIndex) {
      plainParts.push(content.slice(lastIndex, start));
    }
    lastIndex = end;

    if (!isParseSurfaceKind(kindRaw)) {
      // Unknown kind: no ParsedSurface; the existing renderer
      // falls back to "raw text" in the fallback path anyway. We handle that
      // symmetrically here by addressing the raw tag like plain text.
      plainParts.push(full);
      continue;
    }

    let data: unknown = null;
    try {
      data = JSON.parse(jsonRaw);
    } catch {
      data = null;
    }

    surfaces.push({
      kind: kindRaw,
      data,
      raw: full,
      startIdx: start,
      endIdx: end,
    });

    if (
      coords === null &&
      data !== null &&
      typeof data === 'object'
    ) {
      const obj = data as Record<string, unknown>;
      const wsId =
        typeof obj.workstreamId === 'string' && obj.workstreamId.length > 0
          ? obj.workstreamId
          : null;
      if (wsId) {
        coords = { workstreamId: wsId, surfaceKind: kindRaw };
      }
    }
  }

  if (lastIndex < content.length) {
    plainParts.push(content.slice(lastIndex));
  }

  return {
    itemId,
    coords,
    surfaces,
    plainText: plainParts.join(''),
  };
}
