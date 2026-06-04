'use client';

/**
 * Sync Surface-Text-Renderer
 * --------------------------
 * Parses an already-complete text (not a stream) for
 * `<surface:KIND>{json}</surface:KIND>` tags and renders them inline.
 *
 * Used by the chat UI to render agent answers: between text sections,
 * real lib/ui cards appear (BarChart, Decision, Ticket, Invoice,
 * Pipeline, ...).
 *
 * Difference from `parseSurfaceStream` (async generator):
 * - Works synchronously on a complete string → simpler for post-
 *   streaming render. During streaming the tags would still be
 *   partial; here the stream is finished.
 * - Tag syntax identical: identical `SURFACE_KINDS`, identical JSON
 *   format, identical tolerance (invalid tags → rendered as text).
 *
 * TextWithHighlights compat:
 *   Keeps the Markdown-like `**bold**` transformation in the text part.
 */

import type { ReactNode } from 'react';

import { splitOpenQuestionsSection } from '../workstreams/parse-plan-questions';
import { OpenQuestionsInlineRef } from './ChatInlineOpenQuestions';
import { renderMarkdown } from './markdown-mini';
import type { ParsedSurface } from './replace-logic';
import { SURFACE_KINDS, type SurfaceKind } from './surface-parser';
import { renderSurface, renderSurfaceOrHelper } from './SurfaceRenderer';
import { SurfaceSkeleton } from './SurfaceSkeleton';

const SURFACE_RE = /<surface:([a-z-]+)>([\s\S]*?)<\/surface:\1>/g;
const OPEN_TAG_RE = /<surface:([a-z-]+)>/i;

function isKind(s: string): s is SurfaceKind {
  return (SURFACE_KINDS as readonly string[]).includes(s);
}

// ---------------------------------------------------------------------------
// Intentionally-silent kinds (2026-05-30, Render-Critic CRITICAL).
// ---------------------------------------------------------------------------
// Some surface kinds are whitelisted in SURFACE_KINDS and parse fine, but the
// renderer is DESIGNED to emit nothing yet (e.g. `onboarding-progress`, whose
// dispatcher arm in SurfaceRenderer.tsx returns `null` with an explicit
// "TODO(Wave-3): render a real progress card; for now fall through to null").
//
// For those kinds, `renderSurface` returning null is EXPECTED, not a failure —
// so we must NOT show the alarming Magic-Wand fallback card ("Diese Ansicht
// could not be built"). Empirical evidence (e2e-render-check on the rich
// `website` + `example-website-project` workspaces) showed this single kind
// firing the fallback card on every load — the dominant real source of the
// critic's "surfaces tip into the fallback card" report. We render NOTHING for
// these kinds instead (the surrounding text + real surfaces render normally).
//
// This is deliberately a tiny, explicit allowlist — every other render-null is
// a genuine "payload too thin" case that SHOULD surface the helper affordance.
const SILENT_KINDS: ReadonlySet<string> = new Set<string>([
  'onboarding-progress',
]);

// ---------------------------------------------------------------------------
// Last-known-good Surface-Cache (2026-05-30, Apple-UX Slice 1)
// ---------------------------------------------------------------------------
// Owner pain: "SURFACE STREAMING stays up the whole time". As long as the agent
// re-streamed the same card (e.g. emitOrUpdateCard re-emit), the renderer
// flipped back to the skeleton — even though we had already rendered the card
// validly ONCE. Instead of a permanent skeleton we keep showing the PREVIOUS
// valid render version of the same coord until the new version is balanced.
//
// Coord key = `${wsScope}::${kind}::${identity}`. The `identity` is determined
// in this order: workstreamId → subKey → headline/title hash. The first present
// value wins. workstreamId/subKey appear early in the surface JSON and are also
// extractable via regex from a still-unbalanced tail fragment; `headline`/
// `title` likewise (the `headline` field sits in the milestone/decision/toast
// JSON immediately after workstreamId, so it is also reachable in the tail
// fragment).
//
// FIX 1 (Apple-UX Slice 1, 2026-05-30): Previously the cache keyed ONLY on
// workstreamId OR subKey. The plan-synthesis `milestone`
// (event-to-surface.ts:636 milestonePayload) carries NEITHER → cache never
// matched → exactly the most important card (owner pain "SURFACE STREAMING")
// fell back to the skeleton on every re-stream. The headline/title hash
// fallback closes this gap for milestone/decision/toast.
//
// N9 (identity unification via ManifestCoord): The key carries a
// workspace-scope slot as a prefix. ASSUMPTION (documented, since the renderer
// `renderChatText` today receives NO active-workspace context/prop — it is a
// pure String→ReactNode function with no React-context access): as long as no
// workspace is passed through, the scope is the constant sentinel
// `WS_SCOPE_UNSET`. As soon as `renderChatText` gets a workspace identifier
// (future additive prop), it is prepended here and prevents cross-workspace
// cache bleed. The slot exists in the key format from now on, so the
// extension is not a key-schema break.
const LAST_GOOD_CAP = 64;
const lastGoodSurface = new Map<string, ReactNode>();

// Workspace-scope prefix slot (N9). Sentinel until a real workspace
// is passed through — see the module comment above.
const WS_SCOPE_UNSET = 'ws:_';

const WS_ID_RE = /"workstreamId"\s*:\s*"([^"]+)"/;
const SUB_KEY_RE = /"subKey"\s*:\s*"([^"]+)"/;
const HEADLINE_RE = /"headline"\s*:\s*"((?:[^"\\]|\\.)*)"/;
const TITLE_RE = /"title"\s*:\s*"((?:[^"\\]|\\.)*)"/;

/**
 * djb2 (Bernstein) string hash → short base36 token. Deterministic,
 * collision-resistant enough for a last-known-good identity (no security
 * guarantee needed; on collision the cache shows another valid card of the
 * same kind instead of a skeleton — degrades cleanly).
 */
function djb2hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = (h * 33) ^ s.charCodeAt(i);
  }
  // >>> 0 → unsigned 32-bit, then base36 for compactness.
  return (h >>> 0).toString(36);
}

/** Identity suffix from the three fallback sources (or null). */
function identityFrom(
  wsId: string | null,
  subKey: string | null,
  headline: string | null,
  title: string | null,
): string | null {
  if (wsId) return `ws:${wsId}`;
  if (subKey) return `sub:${subKey}`;
  const h = headline ?? title;
  if (h && h.length > 0) return `h:${djb2hash(h)}`;
  return null;
}

/** Coord key from a (possibly partial) surface JSON fragment. */
function coordKeyFrom(kind: string, jsonFragment: string): string | null {
  const ws = WS_ID_RE.exec(jsonFragment);
  const sub = SUB_KEY_RE.exec(jsonFragment);
  const head = HEADLINE_RE.exec(jsonFragment);
  const title = TITLE_RE.exec(jsonFragment);
  const identity = identityFrom(
    ws?.[1] ?? null,
    sub?.[1] ?? null,
    head?.[1] ?? null,
    title?.[1] ?? null,
  );
  if (!identity) return null;
  return `${WS_SCOPE_UNSET}::${kind}::${identity}`;
}

/** Coord key from an already-parsed surface (data is an object). */
function coordKeyFromData(kind: string, data: unknown): string | null {
  if (data === null || typeof data !== 'object') return null;
  const obj = data as Record<string, unknown>;
  const wsId =
    typeof obj.workstreamId === 'string' && obj.workstreamId.length > 0
      ? obj.workstreamId
      : null;
  const subKey =
    typeof obj.subKey === 'string' && obj.subKey.length > 0 ? obj.subKey : null;
  const headline =
    typeof obj.headline === 'string' && obj.headline.length > 0
      ? obj.headline
      : null;
  const title =
    typeof obj.title === 'string' && obj.title.length > 0 ? obj.title : null;
  const identity = identityFrom(wsId, subKey, headline, title);
  if (!identity) return null;
  return `${WS_SCOPE_UNSET}::${kind}::${identity}`;
}

/** Remember a validly rendered surface under its coord as "last-known-good". */
function rememberGood(kind: string, data: unknown, node: ReactNode): void {
  const key = coordKeyFromData(kind, data);
  if (!key) return;
  // Map re-insert keeps insertion order = LRU approximation for the cap.
  if (lastGoodSurface.has(key)) lastGoodSurface.delete(key);
  lastGoodSurface.set(key, node);
  if (lastGoodSurface.size > LAST_GOOD_CAP) {
    const oldest = lastGoodSurface.keys().next().value;
    if (oldest !== undefined) lastGoodSurface.delete(oldest);
  }
}

/**
 * Tail renderer: prefers the last valid version of the same coord
 * (last-known-good) over the skeleton. Skeleton ONLY on the very first frame
 * of a never-seen coord (no permanent skeleton, no hard flip).
 * Cross-fade 180ms via `lazyos-surface-fade` (reduced-motion → instant via
 * the global prefers-reduced-motion catch-all).
 */
function renderStreamingTail(
  kind: SurfaceKind,
  tailFragment: string,
  key: string,
): ReactNode {
  const coordKey = coordKeyFrom(kind, tailFragment);
  if (coordKey) {
    const prev = lastGoodSurface.get(coordKey);
    if (prev !== undefined) {
      return (
        <div
          key={key}
          data-test="surface-last-known-good"
          data-surface-coord={coordKey}
          style={{
            marginTop: 12,
            marginBottom: 12,
            animation: 'lazyos-surface-fade 180ms ease-out',
          }}
        >
          {prev}
        </div>
      );
    }
  }
  return (
    <div key={key} style={{ marginTop: 12, marginBottom: 12 }}>
      <SurfaceSkeleton kind={kind} />
    </div>
  );
}

// Render a Markdown subset in the text segment. Surface tags are processed
// separately — when a tag sits in the text, the piece BEFORE it is sent
// through this renderer.
function renderTextSegment(text: string, keyBase: string): ReactNode {
  if (text.trim().length === 0) return null;

  // 2026-05-23 — detect the `## Offene Fragen` section.
  // UX-1 (2026-05-26): The PRIMARY answer flow is now the Q/A pill ABOVE
  // the composer (ChatOpenQuestionsPill in ChatShell). The inline stepper in
  // the stream would open a second, competing reply() path
  // (double-send risk). Therefore the section is reduced here to a COMPACT,
  // non-interactive reference that points to the pill below.
  const split = splitOpenQuestionsSection(text);
  if (split) {
    return (
      <>
        {split.before.trim().length > 0
          ? renderMarkdown(split.before, `${keyBase}-pre`)
          : null}
        <OpenQuestionsInlineRef count={split.questions.length} />
        {split.after.trim().length > 0
          ? renderMarkdown(split.after, `${keyBase}-post`)
          : null}
      </>
    );
  }

  return renderMarkdown(text, keyBase);
}

export function renderChatText(
  text: string,
  parsedSurfaces?: readonly ParsedSurface[],
): ReactNode[] {
  // Sub-Plan E (2026-04-30) — cache path. If the caller already has a
  // pre-parsed surface list (via parseHistoryItem in replace-logic), we
  // use it instead of running the global regex again. This saves an
  // O(content.length × surface-count) regex run per render pass.
  if (parsedSurfaces !== undefined) {
    return renderChatTextFromCache(text, parsedSurfaces);
  }

  const out: ReactNode[] = [];
  let lastIndex = 0;
  let segmentIndex = 0;

  // Reset regex state between calls (global flag)
  SURFACE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SURFACE_RE.exec(text)) !== null) {
    const [full, kind, jsonRaw] = match;
    const start = match.index;

    // Emit preceding text
    if (start > lastIndex) {
      const chunk = text.slice(lastIndex, start);
      const rendered = renderTextSegment(chunk, `seg-${segmentIndex}`);
      if (rendered) {
        out.push(
          <div key={`seg-${segmentIndex++}`}>{rendered}</div>,
        );
      }
    }

    // Parse + render surface. `data === null` signals a parse error to the
    // manifestation-layer helper (vs. unknown-kind / render-null). On a valid
    // render, last-known-good is remembered.
    let rendered: ReactNode = null;
    let parsedData: unknown = null;
    let parseFailed = false;
    if (isKind(kind)) {
      try {
        parsedData = JSON.parse(jsonRaw) as unknown;
      } catch {
        parseFailed = true;
        parsedData = null;
      }
      if (!parseFailed) {
        try {
          rendered = renderSurface(kind, parsedData);
        } catch {
          rendered = null;
        }
        if (rendered != null) rememberGood(kind, parsedData, rendered);
      }
    } else {
      // unknown kind — the parser did not whitelist it.
      parsedData = null;
    }
    if (rendered != null) {
      out.push(
        <div
          key={`surface-${segmentIndex++}`}
          style={{ marginTop: 12, marginBottom: 12 }}
        >
          {rendered}
        </div>,
      );
    } else if (!parseFailed && SILENT_KINDS.has(kind)) {
      // Intentionally-silent kind (e.g. onboarding-progress) — render nothing,
      // NOT the alarming fallback card. The kind parsed fine; the renderer is
      // designed to emit nothing yet. Skip without advancing the visible feed.
    } else {
      // Non-render point — show the Magic-Wand affordance instead of the bare
      // tag text (owner request 2026-05-30). data=null on parse error,
      // otherwise renderSurfaceOrHelper decides render-null vs unknown-kind.
      out.push(
        <div
          key={`surface-helper-${segmentIndex++}`}
          style={{ marginTop: 12, marginBottom: 12 }}
        >
          {renderSurfaceOrHelper(kind, parseFailed ? null : parsedData, full)}
        </div>,
      );
    }

    lastIndex = start + full.length;
  }

  // Trailing text — if an open `<surface:KIND>` without close is present,
  // the agent is currently streaming a card. Instead of the unfinished JSON
  // garbage we render a skeleton block that prevents the layout jump.
  if (lastIndex < text.length) {
    const tail = text.slice(lastIndex);
    const openMatch = OPEN_TAG_RE.exec(tail);
    if (openMatch && isKind(openMatch[1])) {
      const beforeTag = tail.slice(0, openMatch.index);
      if (beforeTag.length > 0) {
        const rendered = renderTextSegment(beforeTag, `seg-${segmentIndex}`);
        if (rendered) {
          out.push(<div key={`seg-${segmentIndex++}`}>{rendered}</div>);
        }
      }
      const tailFragment = tail.slice(openMatch.index);
      out.push(
        renderStreamingTail(
          openMatch[1] as SurfaceKind,
          tailFragment,
          `skel-${segmentIndex++}`,
        ),
      );
    } else {
      const rendered = renderTextSegment(tail, `seg-${segmentIndex}`);
      if (rendered) {
        out.push(<div key={`seg-${segmentIndex++}`}>{rendered}</div>);
      }
    }
  }

  return out;
}

/**
 * Cache-aware variant: renders from the `ParsedSurface[]` already found in
 * `parseHistoryItem`. Saves the regex scan on the `text` string.
 *
 * Assumption: `parsedSurfaces` comes from EXACTLY this `text`. If not,
 * the `startIdx/endIdx` slice operations fall apart; in that case the caller
 * is better off passing no cache argument and taking the original path.
 *
 * Keeps the "open-tag-without-close" skeleton logic of the original path by
 * searching once more for `<surface:KIND>` in the tail after the last cached
 * surface.
 */
function renderChatTextFromCache(
  text: string,
  parsedSurfaces: readonly ParsedSurface[],
): ReactNode[] {
  const out: ReactNode[] = [];
  let lastIndex = 0;
  let segmentIndex = 0;

  for (const ps of parsedSurfaces) {
    // Defensive: skip surfaces whose range lies outside the string
    // (e.g. cache snapshot of an earlier streaming state).
    if (ps.startIdx < lastIndex || ps.endIdx > text.length) {
      continue;
    }

    if (ps.startIdx > lastIndex) {
      const chunk = text.slice(lastIndex, ps.startIdx);
      const rendered = renderTextSegment(chunk, `seg-${segmentIndex}`);
      if (rendered) {
        out.push(<div key={`seg-${segmentIndex++}`}>{rendered}</div>);
      }
    }

    let rendered: ReactNode = null;
    if (ps.data !== null) {
      try {
        rendered = renderSurface(ps.kind, ps.data);
        if (rendered != null) rememberGood(ps.kind, ps.data, rendered);
      } catch {
        rendered = null;
      }
    }

    if (rendered != null) {
      out.push(
        <div
          key={`surface-${segmentIndex++}`}
          style={{ marginTop: 12, marginBottom: 12 }}
        >
          {rendered}
        </div>,
      );
    } else if (ps.data !== null && SILENT_KINDS.has(ps.kind)) {
      // Intentionally-silent kind (cache path) — render nothing, not the
      // fallback card. Mirrors the regex-path guard above. ps.data !== null
      // ⇒ parsed fine; the renderer is designed to emit nothing yet.
    } else {
      // Non-render point (cache path) — Magic-Wand affordance instead of raw
      // tag text. ps.kind is always whitelisted here (unknown kinds are
      // carried as plain text upstream); ps.data === null ⇒ parse error.
      out.push(
        <div
          key={`surface-helper-${segmentIndex++}`}
          style={{ marginTop: 12, marginBottom: 12 }}
        >
          {renderSurfaceOrHelper(ps.kind, ps.data, ps.raw)}
        </div>,
      );
    }

    lastIndex = ps.endIdx;
  }

  // Trailing tail: skeleton if an open `<surface:KIND>` without close
  // exists (like the original path).
  if (lastIndex < text.length) {
    const tail = text.slice(lastIndex);
    const openMatch = OPEN_TAG_RE.exec(tail);
    if (openMatch && isKind(openMatch[1])) {
      const beforeTag = tail.slice(0, openMatch.index);
      if (beforeTag.length > 0) {
        const rendered = renderTextSegment(beforeTag, `seg-${segmentIndex}`);
        if (rendered) {
          out.push(<div key={`seg-${segmentIndex++}`}>{rendered}</div>);
        }
      }
      const tailFragment = tail.slice(openMatch.index);
      out.push(
        renderStreamingTail(
          openMatch[1] as SurfaceKind,
          tailFragment,
          `skel-${segmentIndex++}`,
        ),
      );
    } else {
      const rendered = renderTextSegment(tail, `seg-${segmentIndex}`);
      if (rendered) {
        out.push(<div key={`seg-${segmentIndex++}`}>{rendered}</div>);
      }
    }
  }

  return out;
}
