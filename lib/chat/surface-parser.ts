/**
 * Surface-Block-Parser
 * --------------------
 * Parses a chat text stream (async-iterable of text-chunks) into a
 * typed stream of `text` / `surface` chunks. Surfaces are declared
 * inline by the LLM using XML-ish tags:
 *
 *   <surface:chart>{"title":"...","value":"...","data":[1,2,3]}</surface:chart>
 *   <surface:decision>{"headline":"...","options":[...]}</surface:decision>
 *   <surface:ticket>{"id":"...","title":"...","status":"open"}</surface:ticket>
 *   <surface:invoice>{"number":"...","title":"...","totalAmount":"..."}</surface:invoice>
 *   <surface:pipeline>{"steps":[{"num":1,"title":"...","status":"done"}]}</surface:pipeline>
 *
 * Design notes
 * ------------
 * • Streaming — tokens arrive in arbitrary chunk boundaries (can split a
 *   single `<`, `</`, or mid-JSON). The parser buffers until a tag is
 *   complete or until it can safely emit partial text.
 * • Robust — if JSON inside a surface tag is invalid, the whole tag
 *   contents is emitted as plain text (no exceptions thrown).
 * • Nested tags are not supported (don't nest surface tags — the LLM is
 *   instructed accordingly). Nested occurrences are rendered as text.
 * • Tag whitelist — unknown `surface:*` kinds are yielded as text to keep
 *   the UI forward-compatible without breaking on hallucinated tags.
 *
 * The parser is type-safe and exhaustive: callers must handle every
 * `ParsedChunk.type` variant.
 */

export const SURFACE_KINDS = [
  'chart',
  'decision',
  'ticket',
  'invoice',
  'pipeline',
  'toast',
  'quickchoice',
  'approval',
  'terminal',
  'heartbeat',
  'workspace',
  'routine',
  'agent',
  'swarm',
  'tier-choice',
  'live-swarm',
  'milestone',
  'workflow-pipeline',
  'credential-prompt',
  'consensus-action',
  'live-pipeline',
  // Sub-Plan 04 Wave 2 (2026-04-29):
  'iterate-pipeline',
  // Sprint C (2026-04-29) — sub-workstreams as a first-class entity:
  'sub-workstreams',
  // Workspace-Cloud (2026-04-27):
  'document',
  'folder',
  'cloud-browser',
  // Preview/deployment link (2026-05-27) — completion surface with a
  // tappable (Tailscale) URL so builds are testable directly on the phone.
  'preview',
  // Phase RL.2 (2026-04-28):
  'rate-limit-retry',
  // Sub-Plan C (2026-04-29) — generic structured-input form
  // (org data, briefing, any patch-API call that ships a schema).
  // Endpoint whitelist: /api/* with PATCH|POST.
  'form',
  // Sub-Plan D (2026-04-30) — open-questions card with QuickChoice buttons
  // directly in the chat (instead of only stream polling). Optional `options[]`
  // array per question → click buttons; otherwise free-text fallback.
  'open-questions',
  // Sprint H (2026-04-30) — bug-fix swarm: 3 parallel diagnosis spawns
  // (senior-dev + code-reviewer + critic) with build-mode tool use,
  // consensus synthesis, fix spawn, root-cause section. User complaint
  // 2026-04-30 (verbatim): „Bug rein, der labert da rum, statt selber zu fixen".
  'bug-fix-swarm',
  // Wave 2 (Sub-Plan Auto-Swarm Bug-Fix · 2026-05-03) — separate surface
  // for the 3-tier roaster pipeline (plan + critic + fix). Its own card
  // because phase granularity (8 phases) and multi-spawn avatars differ
  // from `bug-fix-swarm` (3 parallel diagnosis spawns Sprint H).
  // The renderer reuses BugFixSwarmCard with phase=pipeline data.
  'bug-fix-pipeline',
  // Wave 7 (2026-05-01) — loop-phase coverage. Demo Fitness / coding-loop
  // events (auto-dispatch-stage, tier-output, sniper-pause-start,
  // auto-dispatch-overview/-pause, auto-dispatch-stage-retry) so far had
  // NO surface — only a toast substitute or null. User finding 2026-05-01
  // (verbatim): „Demo Fitness-Chat ist nicht konsistent mit Surfaces gearbeitet UND
  // nicht persistent." Generic LoopPhaseCard parameterizes kind+phase.
  'loop-phase',
  // Iterate-roast multi-view: 4-5 roaster roles with avatars, one per
  // payload.roasterIdx.
  'iterate-roast',
  // V1→V2→V3 version diff: compact card with headline + diff snippet per V_n.
  'iterate-version',
  // User-correction inject: compact display of a user inject during
  // a sniper pause (instead of spamming stream toasts).
  'user-correction',
  // Plan-open-questions as a card with QuickChoice buttons (complements
  // OpenQuestionsSurface — the server emits both redundantly; we
  // want the card variant as a persistent anchor).
  'plan-open-questions',
  // ---------------------------------------------------------------------
  // Sub-Plan 3 · cluster merges (2026-05-01) — 35→17 surface kinds.
  // Backwards-compat: old kinds stay in the whitelist as
  // deprecated aliases, the new cluster kinds are the canonical
  // server emission from this wave on.
  // ---------------------------------------------------------------------
  // Cluster A — pipeline-family merge. Phase-state discriminator:
  // intake|plan|dispatch|execute|iterate|review|done. Replaces pipeline,
  // live-pipeline, workflow-pipeline, iterate-pipeline. The iterate family
  // (iterate-roast/iterate-version/user-correction) is integrated into
  // workflow.phase=iterate as a sub-state (Cluster B).
  'workflow',
  // Cluster C — prompt-family merge with a `variant` discriminator:
  // form|credential|open-questions|plan-questions|quickchoice|decision.
  // Replaces form, credential-prompt, open-questions, plan-open-questions,
  // quickchoice, decision.
  'prompt',
  // Cluster D — tool/step merge with a `mode` discriminator:
  // agent|swarm|live-swarm|bug-fix-swarm|loop-phase|tier-choice.
  'agent-step',
  // BACKPORT-03 (2026-05-23) — Plan-First V2 surfaces.
  // `subplan` renders a ProposedPlan card with approve/edit/decline actions
  // and collapse-to-pill at depth >= 2 (SubplanCard.tsx).
  'subplan',
  // BACKPORT-02 (2026-05-23) — subagent-fleet view.
  // `subagent-fleet` renders up to 5 parallel subagent panes with status
  // pills, abort and diff buttons (SubagentFleetCard.tsx + .types.ts).
  'subagent-fleet',
  // ACL5-B (2026-05-24) — credential-request surface (out-of-chat).
  // Secret entry type=password; the secret goes EXCLUSIVELY via POST to
  // /api/connectors/[provider]/credential — NEVER into chat/SSE/ledger.
  // The surface payload carries only: provider, scopeKind, scopeId, why (no secret).
  'credential-request',
  // ACL5-E (2026-05-24) — connector-call-preview surface.
  // S5 preview with an approve action → POST /api/connectors/invoke.
  // Payload: provider, capability, endpoint, payloadSummary (keys+types, no values),
  // credentialPreview (masked, NEVER plaintext), dryRun label if LIVE off.
  // SECURITY: no secret field in the surface payload.
  'connector-call-preview',
  // P1-#5 (2026-05-25) — connector-onboarding-progress surface (ACL5-E write path).
  // Shows the progress of the SOP→plan-dispatch onboarding run:
  // workstreamId, planId, sopId, sopName, stepCount, goalPrompt, status.
  // SECURITY: no secret field. Only metadata of the triggered plan.
  'onboarding-progress',
  // A1 (2026-05-25) — permission-setup surface.
  // One-time selection of the agent mode (freerein|lane|ask) for a workspace.
  // Appears when an agent run needs tools but no mode is set.
  // Payload: { workspaceId: string, currentMode?: string | null }.
  // SECURITY: no secret field; PATCH /api/permission/[workspaceId]/mode is auth-gated.
  'permission-setup',
  // Flow Studio P3 (2026-05-27) — visual flow-graph surface (n8n/make style,
  // custom SVG + HTML nodes, NO new dependency; rationale in the plan
  // docs/plans/2026-05-27_flow-studio-architecture.md §3). Renders a DAG
  // of skill/tool nodes with a topological layer layout + SVG edges + status
  // dots. Mobile-capable (narrow → vertical stacking of the layers).
  // Payload: { title?, runStatus?, nodes:[{id,label,skill?,tool?,status?}], edges:[{from,to}] }.
  // P3 = pure rendering; the live wiring (feeding from flow_steps/plan-step
  // status) deliberately follows in a later wiring pass.
  'flow-graph',
  // Self-learning workflow recording (2026-06-03, Slice 1). Nudge after a
  // run finishes, when the repetition detector (lib/flow/repetition-detect.ts)
  // recognizes that this flow has structurally run ≥3× already: "you ran this
  // N-step flow X× — save it as a reusable workflow?".
  // Save → POST /api/flow/from-workstream (C3 path, owner-gated, no
  // auto-save). Payload: { workstreamId, workspaceId, title?, seenCount,
  // stepCount, summary }. SECURITY: no secret in the payload.
  'flow-recurrence',
  // Image generation (2026-06-03) — self-driving, animated loading surface.
  // Appears immediately on `/image <prompt>`; starts the async image job, polls
  // /api/imagegen/status, shows a shimmer → image (like Codex). Payload:
  // { prompt, workspace, token }. On done → lazyos:image-gen-done → ChatShell
  // replaces it with <surface:document>. SECURITY: no secret in the payload.
  'image-gen',
  // Flow Studio P-now (2026-05-27) — tool-coupling surface. Appears when a
  // flow contains steps whose required tools/connectors are not yet
  // coupled (missing credential / missing profile / unknown tool).
  // Per missing tool a "Koppeln" button that opens the EXISTING credential
  // entry (CredentialRequestCard → POST /api/connectors/[provider]/credential;
  // secret NEVER in chat/SSE/ledger). When all coupled (or "Trotzdem starten")
  // → a "Flow starten" button → POST /api/flow/[flowId]/run {workspaceId}.
  // SECURITY: the surface payload carries NO secret field — only flow/step/provider
  // metadata. Reuse of the secret path from ACL5-B (no new entry point).
  // Payload: { flowId, workspaceId, missingTools:[{stepId, stepTitle, provider,
  // neededCapabilities?, reason}] }; reason ∈ credential|profile|unknown|…
  'flow-coupling',
  // Stream X1 (2026-05-28) — one-shot LIVE-mode warn surface.
  // Appears ONCE per workspace on the first attempt of a real LIVE call
  // (LAZYOS_CONNECTOR_LIVE=on active AND not yet acknowledged). The owner can
  // explicitly click "OK weiter" or "Nein, ich prüfe erst". The acknowledgement
  // is persisted idempotently in workspace_beliefs (topic='live-warn-acked'),
  // so the surface does NOT appear again. NO secret in the payload.
  // Payload: { workspaceId: string }.
  'live-warn',
  // E4 — Devil's Advocate / counter-evidence (P13, 2026-05-27).
  // Anti-confirmation-bias: after a synthesis (gated on consensus
  // 'strong' OR WHY feed-in) a falsification pass actively searches for
  // data that CONTRADICTS the thesis. The result lands as its OWN
  // card — NOT mixed into the synthesis stream (the user should read synthesis
  // and counter-evidence separately). Red flag if unfalsifiable.
  // Payload: { text (Markdown), verdict: falsifiable|unfalsifiable|
  // weak-evidence, counterEvidenceCount, unfalsifiable:boolean, costCents?,
  // durationMs?, workstreamId?, synthesisHash? }.
  // SECURITY: no secret field — only falsification metadata + DA output.
  'counter-evidence',
  // Owner fix run-cockpit (2026-05-28) — ONE master surface that aggregates
  // today's 3 simultaneous emit sites (sub-workstreams + iterate-pipeline + iterate-
  // version) into a SINGLE, trackable card. Owner finding
  // 2026-05-28 (verbatim): „Bei mir sind nach meiner ersten Chatnachricht ploetzlich
  // extremst viele Surfaces aufgetaucht … folgt keinem Flow den man verfolgen
  // kann." In the example-website-2 run, three cards appeared at T+29s..30s at once
  // (lib/plan-first/plan-dispatch.ts:223+:270, tier-orchestrator.ts:250+:1243+
  // :1521) — the cockpit card bundles them as a phase stepper + collapsed sub-
  // WS list + next-phase hint + token/cost counter. Render suppression
  // in the SurfaceRenderer pre-pass holds the 3 old cards back as "suppressed by
  // run-cockpit" as soon as a run-cockpit surface for the same
  // (workspaceId, workstreamId) is already active (back-compat for voice/
  // API consumers that still expect the old cards).
  // Payload: {
  //   workspaceId, workstreamId,
  //   phase: 'decompose'|'tier-spawn'|'lead'|'roaster'|'consensus'|'done',
  //   phaseIndex (1-based), phaseTotal,
  //   subWorkstreams?: [{ id?, role, status?, tokensOut?, model? }],
  //   maxVersion?, workstreamName?,
  //   tokensTotal?, costCents?,
  //   nextStepHint? (one line, what appears next),
  // }.
  // SECURITY: no secret field — pure status/phase metadata.
  'run-cockpit',
  // Slice C (2026-05-29) — discovery phase BEFORE plan decompose. Owner finding
  // (example-website-3, verbatim): „Ich sehe niemanden der die Website recherchiert
  // oder sich ansieht, da müsste doch eine Art Browser Bash erstmal kommen usw
  // oder nicht?! Analyse, Recherche…". plan-dispatch detects URLs/domains/
  // doc mentions in the owner prompt, fetches the URLs fail-soft and emits
  // a discovery card BEFORE the tier choice (subKey='discovery', idempotent
  // pre-emit "running" + post-emit "done"). Payload:
  //   { workspaceId, workstreamId, status:'running'|'done'|'failed',
  //     urls:[{url,status:'ok'|'failed'|'timeout',title?,summary?}],
  //     pendingDocRequests?:string[] }.
  // SECURITY: no secret field. WebFetch only targets public URLs explicitly
  // named by the owner (N2: no cross-workspace reads, no audit row).
  'discovery',
  // A4 (2026-05-29) — merge-offer surface (clickable operator merge gate).
  // Closes the accumulation loop: the assembled work of all
  // successful steps lies in the run branch `lazing/run/prun-…`; this card
  // is the ONLY owner-visible path that brings it into the live
  // checkout with a click (R3 human gate). "Diff ansehen" → POST
  // /api/workstreams/[id]/merge-run {preview:true} (read-only file list);
  // "In Live mergen" → POST /api/workstreams/[id]/merge-run {} (the ONLY
  // write action). On success → resolved state. "Verwerfen" is purely
  // local (no write call). Payload:
  //   { workstreamId, runBranch?, fileCount?, files?:string[],
  //     workspaceId?, workstreamName? }.
  // SECURITY: no secret field — only run/file metadata.
  'merge-offer',
  // A3/R7 (2026-05-29) — project-truth surface (long-lived read anchor).
  // ONE card per workspace (idempotent via subKey='project-truth') that bundles
  // the secured project truth ACROSS runs: vision, decisions,
  // beliefs, open-unknowns and contradictions. NON-interactive (read anchor),
  // collapsible ("expand more details"). Biggest gap per the surface
  // manifestation strategy §7.2. Payload:
  //   { workspaceId?, workstreamId?, vision?, decisions?:[{text,...}],
  //     beliefs?:[{text,confidence?}], openUnknowns?:string[],
  //     contradictions?:[{text,...}], updatedAt? }.
  // SECURITY: no secret field — only curated project knowledge.
  'project-truth',
] as const;

export type SurfaceKind = (typeof SURFACE_KINDS)[number];

export type ParsedChunk =
  | { type: 'text'; content: string }
  | { type: 'surface'; kind: SurfaceKind; data: unknown; raw: string };

function isSurfaceKind(s: string): s is SurfaceKind {
  return (SURFACE_KINDS as readonly string[]).includes(s);
}

/**
 * Parse a stream of text chunks into a stream of ParsedChunk. The
 * function is a single-pass state machine:
 *
 *   TEXT         → scanning free text. `<` hands off to MAYBE_OPEN.
 *   MAYBE_OPEN   → saw `<`. Trying to recognize `<surface:KIND>`. If
 *                  the pattern fails, flushes the buffered `<…` as text
 *                  and returns to TEXT.
 *   IN_SURFACE   → inside the body of a recognized surface tag. Buffers
 *                  content until a `</surface:KIND>` close tag.
 *
 * Partial inputs are handled by *not* yielding until enough bytes have
 * arrived to disambiguate.
 */
export async function* parseSurfaceStream(
  source: AsyncIterable<string>,
): AsyncGenerator<ParsedChunk, void, void> {
  let buf = '';

  // Consume all input, keeping a rolling buffer.
  // We only emit when we can commit a chunk without regretting it.
  for await (const piece of source) {
    buf += piece;
    const out = drain(buf, false);
    for (const c of out.chunks) yield c;
    buf = out.rest;
  }

  // Flush remainder at EOF — emit whatever's left as text.
  const final = drain(buf, true);
  yield* final.chunks;
  // final.rest is guaranteed empty in eof mode (see drain).
}

interface DrainResult {
  chunks: ParsedChunk[];
  /** Unprocessed tail that must stay buffered for the next iteration. */
  rest: string;
}

/**
 * Pure parser: given a buffer and an EOF flag, returns as many chunks
 * as can be safely committed plus the leftover tail. Split out from the
 * async generator so it can be exhaustively unit-tested.
 */
function drain(buffer: string, eof: boolean): DrainResult {
  const out: ParsedChunk[] = [];
  let rest = buffer;

  // Iterate until we can't make further progress.
  // Each iteration commits at least one chunk or decides to keep buffering.
  for (;;) {
    const next = step(rest, eof);
    if (next.chunk) out.push(next.chunk);
    if (next.rest === rest && !next.done) {
      // No progress without a commit — buffer and wait for more input.
      break;
    }
    rest = next.rest;
    if (next.done) break;
  }

  return { chunks: out, rest };
}

interface StepResult {
  chunk: ParsedChunk | null;
  rest: string;
  /** True if the buffer is fully consumed. */
  done: boolean;
}

/** Single state-transition over the buffer. */
function step(buffer: string, eof: boolean): StepResult {
  if (buffer.length === 0) {
    return { chunk: null, rest: buffer, done: true };
  }

  const ltIdx = buffer.indexOf('<');

  // No `<` at all — entire buffer is text.
  if (ltIdx === -1) {
    return {
      chunk: { type: 'text', content: buffer },
      rest: '',
      done: true,
    };
  }

  // `<` is not at position 0 — flush the text prefix first.
  if (ltIdx > 0) {
    return {
      chunk: { type: 'text', content: buffer.slice(0, ltIdx) },
      rest: buffer.slice(ltIdx),
      done: false,
    };
  }

  // ltIdx === 0: buffer starts with `<`. Decide if it's a surface tag.
  // We need at least `<surface:X>` to commit. Accept short buffer by waiting.
  const PREFIX = '<surface:';

  // Fast-path: NOT a surface tag.
  if (!startsWithOrIsPrefixOf(buffer, PREFIX)) {
    // Definitely not a surface tag — emit the `<` as text, move on.
    return {
      chunk: { type: 'text', content: '<' },
      rest: buffer.slice(1),
      done: false,
    };
  }

  // Could still be the growing prefix — hold unless we have full `<surface:`.
  if (buffer.length < PREFIX.length) {
    if (eof) {
      // Never completed — flush as text.
      return {
        chunk: { type: 'text', content: buffer },
        rest: '',
        done: true,
      };
    }
    return { chunk: null, rest: buffer, done: true };
  }

  // Find end of opening tag: `>`.
  const gtIdx = buffer.indexOf('>');
  if (gtIdx === -1) {
    if (eof) {
      return {
        chunk: { type: 'text', content: buffer },
        rest: '',
        done: true,
      };
    }
    // Wait for more input.
    return { chunk: null, rest: buffer, done: true };
  }

  // Extract kind between `<surface:` and `>`.
  const kindStr = buffer.slice(PREFIX.length, gtIdx);
  if (!/^[a-z][a-z0-9_-]*$/i.test(kindStr)) {
    // Malformed — treat `<` as text, resume scanning after it.
    return {
      chunk: { type: 'text', content: '<' },
      rest: buffer.slice(1),
      done: false,
    };
  }

  const closeTag = `</surface:${kindStr}>`;
  const closeIdx = buffer.indexOf(closeTag, gtIdx + 1);
  if (closeIdx === -1) {
    if (eof) {
      // Unterminated — emit everything as text.
      return {
        chunk: { type: 'text', content: buffer },
        rest: '',
        done: true,
      };
    }
    // Wait for more input.
    return { chunk: null, rest: buffer, done: true };
  }

  const body = buffer.slice(gtIdx + 1, closeIdx);
  const tail = buffer.slice(closeIdx + closeTag.length);
  const raw = buffer.slice(0, closeIdx + closeTag.length);

  if (!isSurfaceKind(kindStr)) {
    // Unknown surface kind — emit the whole tag verbatim as text.
    return {
      chunk: { type: 'text', content: raw },
      rest: tail,
      done: false,
    };
  }

  // Try to parse JSON.
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    // Invalid JSON — fall back to text so UI doesn't crash.
    return {
      chunk: { type: 'text', content: raw },
      rest: tail,
      done: false,
    };
  }

  return {
    chunk: { type: 'surface', kind: kindStr, data, raw },
    rest: tail,
    done: false,
  };
}

/**
 * True iff `buf` starts with `prefix` OR `buf` is itself a strict
 * prefix of `prefix`. Used to decide whether a short buffer might
 * still grow into a surface-tag opener.
 */
function startsWithOrIsPrefixOf(buf: string, prefix: string): boolean {
  if (buf.length >= prefix.length) return buf.startsWith(prefix);
  return prefix.startsWith(buf);
}

/**
 * Helper: collect a full ParsedChunk[] from an async iterable. For tests
 * and one-shot parsing of already-complete strings.
 */
export async function collectParsedChunks(
  source: AsyncIterable<string>,
): Promise<ParsedChunk[]> {
  const chunks: ParsedChunk[] = [];
  for await (const c of parseSurfaceStream(source)) chunks.push(c);
  return chunks;
}

/** Wrap a plain string in an async-iterable that yields once. */
export async function* stringToAsyncIterable(
  s: string,
): AsyncIterable<string> {
  yield s;
}

// ---------------------------------------------------------------------------
// Sub-Plan A · 2026-04-29 — extract workstream coords from content
// ---------------------------------------------------------------------------
// Searches the FIRST surface block in the content and tries to read a
// `workstreamId` property from the JSON payload. Used for:
//   - one-card-per-workstream replace (ChatShell.tsx setHistory path)
//   - hydrate migration from old persisted history items
//     (storage.ts: readHistoryFor / mergeServerWithLocal)
//
// Tolerant of garbled JSON: invalid tags are ignored,
// the function returns null when no workstreamId is found.
// Pure function, no React, no DOM — safe in any runtime.
// ---------------------------------------------------------------------------

// Hint 2 (Sub-Plan A · 2026-04-29): the regex is aligned with the SURFACE_KINDS
// whitelist — `[a-z][a-z0-9_-]*` matches the same character class that
// `isSurfaceKind` below checks anyway. Previously `_` and
// digits were silently swallowed, which relied on the isSurfaceKind filter.
// Now the regex wins enough to never later falsely interpret something
// as a "non-surface tag".
const SURFACE_TAG_RE = /<surface:([a-z][a-z0-9_-]*)>([\s\S]*?)<\/surface:\1>/g;

export interface WorkstreamCoords {
  workstreamId: string;
  surfaceKind: SurfaceKind;
}

/**
 * Strict: parse the surface-tag JSON, return the coord only if both
 * are clean (kind whitelisted, workstreamId a non-empty string).
 */
export function extractWorkstreamCoords(content: string): WorkstreamCoords | null {
  if (typeof content !== 'string' || content.length === 0) return null;
  // Reset regex state (global flag) — important when the function
  // is called repeatedly in the same tick.
  SURFACE_TAG_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SURFACE_TAG_RE.exec(content)) !== null) {
    const [, kindRaw, jsonRaw] = match;
    if (!isSurfaceKind(kindRaw)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonRaw);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;
    const obj = parsed as Record<string, unknown>;
    const wsId =
      typeof obj.workstreamId === 'string' && obj.workstreamId.length > 0
        ? obj.workstreamId
        : undefined;
    if (!wsId) continue;
    return { workstreamId: wsId, surfaceKind: kindRaw };
  }
  return null;
}

/**
 * Migration variant: regex-light fallback when the JSON parse fails
 * (e.g. due to a truncated persistence format from old builds).
 * Used by `storage.ts` to extract workstreamId from *old* localStorage
 * entries without strict JSON correctness being mandatory.
 * Format detection:  "workstreamId":"xxx"  (with optional spaces).
 */
const WS_ID_FALLBACK_RE = /"workstreamId"\s*:\s*"([^"\\]+)"/;

export function extractWorkstreamCoordsLoose(
  content: string,
): WorkstreamCoords | null {
  const strict = extractWorkstreamCoords(content);
  if (strict) return strict;
  if (typeof content !== 'string' || content.length === 0) return null;
  // Fallback: find any <surface:kind> tag and a workstreamId key
  // in the same body (even if the JSON parse failed before).
  SURFACE_TAG_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SURFACE_TAG_RE.exec(content)) !== null) {
    const [, kindRaw, body] = match;
    if (!isSurfaceKind(kindRaw)) continue;
    const wsMatch = WS_ID_FALLBACK_RE.exec(body);
    if (!wsMatch) continue;
    const wsId = wsMatch[1];
    if (!wsId || wsId.length === 0) continue;
    return { workstreamId: wsId, surfaceKind: kindRaw };
  }
  return null;
}
