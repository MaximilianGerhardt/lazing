/**
 * Flow Studio — media style options (Stream B2) · 2026-05-27.
 *
 * Source: docs/plans/2026-05-27_flow-studio-architecture.md (media steps) +
 * PA-Chat finding: for "Hero-Video" the system chose a provider UNILATERALLY
 * (heygen — wrong type → stuck), instead of offering the owner STYLE OPTIONS.
 *
 * Owner requirement (verbatim, N1): „unterschiedliche Stilrichtungen — eigenes Video /
 * Stockfootage / Scroll-Down-Animation / via Higgsfield manuell-oder-automatisch /
 * prozedural". Concretely for the hero video he would have wanted Higgsfield.
 *
 * ── What this file models ───────────────────────────────────────────────────
 *   Per media-step type (image|video|avatar) an ordered list of
 *   STYLE OPTIONS. Each option describes WHICH APPROACH is behind it:
 *     - 'connector'  → a real P5 tool connector (higgsfield/heygen-avatar/
 *                      imagegen2) with provider + neededCapabilities. Only this
 *                      choice triggers (if applicable) the existing needs-coupling path.
 *     - 'procedural' → engine/ffmpeg-generated (NO external connector,
 *                      no credential coupling).
 *     - 'css'        → pure CSS/scroll animation (NO connector).
 *     - 'placeholder'→ placeholder asset (NO connector).
 *
 *   This is PURELY DATA. The presentation happens via the EXISTING
 *   `<surface:prompt variant=quickchoice>` surface (lib/chat/surface-parser.ts +
 *   SurfaceRenderer.tsx) — this file only produces the payload/markup, the
 *   renderer is NOT touched (SurfaceRenderer territory of the parallel agent).
 *
 * ── Why NOT unilaterally ONE provider? ─────────────────────────────────────
 *   compose.ts::assignSkill TODAY assigns a single provider hint to a
 *   media title (video→higgsfield, avatar→heygen-avatar, image→imagegen2).
 *   That is a PRE-SELECTION default, not an owner decision. Stream B2 inserts
 *   between "assignSkill recognized a tool:* step" and "needs-coupling /
 *   unilateral provider" an OWNER CHOICE: only after the style choice is
 *   the concrete approach/provider determined.
 *
 * Discipline:
 *   - N1: label/hint verbatim (no .slice/.substring). Owner wording preserved.
 *   - N2 (fail-closed): only 'connector' options can create a connector need
 *         (needs-coupling); 'procedural'/'css'/'placeholder' carry
 *         provider=undefined and neededCapabilities=[] → NEVER a silent
 *         connector need. An unknown style id is NOT silently waved through.
 *   - N6: deterministic — pure table, no LLM, no net I/O.
 *   - Provider slugs + capability names are EXACTLY the canonical P5 values
 *     (lib/connectors/p5-tool-connectors.ts::P5_CAPABILITY_KEYS): higgsfield=
 *     video.motion, heygen-avatar=video.avatar, imagegen2=image.generate. Otherwise
 *     validateCoverage would ALWAYS be ok:false (Higgsfield 0×-reachable finding).
 *
 * NO net I/O, NO real connector call (that is P5 + LAZYOS_CONNECTOR_LIVE).
 */

// Pure-constants file (not p5-tool-connectors) — avoids the
// client-bundle break via the catalog/db/tmux-spawn chain. See
// lib/connectors/p5-capability-keys.ts.
import { P5_CAPABILITY_KEYS } from "@/lib/connectors/p5-capability-keys";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The type of a media step. Derived from the assignSkill skill key
 * ('tool:image'|'tool:video'|'tool:avatar') via mediaStepKindFromSkill().
 */
export type MediaStepKind = "image" | "video" | "avatar";

/**
 * How a style option is implemented:
 *   'connector'   — real P5 tool connector (provider + neededCapabilities set).
 *   'procedural'  — engine/ffmpeg-side (no external connector).
 *   'css'         — pure CSS/scroll animation (no connector).
 *   'placeholder' — placeholder asset (no connector).
 */
export type MediaStyleApproach = "connector" | "procedural" | "css" | "placeholder";

/**
 * A single style option for a media step.
 *
 * Invariant (N2 fail-closed):
 *   approach === 'connector'  ⇒  provider set + neededCapabilities not empty.
 *   approach !== 'connector'  ⇒  provider undefined + neededCapabilities empty.
 */
export interface MediaStyleOption {
  /** Stable, machine-readable id (quickchoice option id + applyStyleChoice key). */
  readonly id: string;
  /** Human-readable label (N1 verbatim — owner wording). */
  readonly label: string;
  /** Short explanation for the quickchoice sublabel (N1 verbatim). */
  readonly hint: string;
  /** Implementation approach (see MediaStyleApproach). */
  readonly approach: MediaStyleApproach;
  /** P5 provider slug — ONLY when approach==='connector'. */
  readonly provider?: string;
  /** Needed capability names (canonical P5 keys) — ONLY when approach==='connector'. */
  readonly neededCapabilities?: readonly string[];
}

// ---------------------------------------------------------------------------
// Skill → MediaStepKind
// ---------------------------------------------------------------------------

/**
 * Maps an assignSkill skill key to a MediaStepKind. Returns null if
 * the skill is NOT a media tool skill (e.g. 'architecture'/'copywriting'/'coder').
 * Deterministic, no I/O.
 */
export function mediaStepKindFromSkill(
  skill: string | null | undefined,
): MediaStepKind | null {
  switch (skill) {
    case "tool:image":
      return "image";
    case "tool:video":
      return "video";
    case "tool:avatar":
      return "avatar";
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Style options per media-step type (canonical table)
//
// Order = presentation order in the quickchoice surface. The first
// connector entry is the former unilateral default — now just ONE
// option among several that the owner actively chooses.
// ---------------------------------------------------------------------------

const VIDEO_STYLES: readonly MediaStyleOption[] = [
  // Owner wish for the hero video: own video via Higgsfield. REACHABLE as
  // the first video option (finding: Higgsfield was 0× reachable — fixed here).
  {
    id: "video-higgsfield",
    label: "Eigenes Video (Higgsfield)",
    hint: "Motion-/Video-Graphics via Higgsfield aus Prompt oder Still — manuell oder automatisch.",
    approach: "connector",
    provider: "higgsfield",
    neededCapabilities: [P5_CAPABILITY_KEYS.higgsfield], // 'video.motion'
  },
  {
    id: "video-stockfootage",
    label: "Stockfootage",
    hint: "Fertiges Footage aus einer Stock-Bibliothek (Connector folgt — heute Platzhalter-Hinweis).",
    // No real stock connector in the P5 catalog yet → placeholder, NO
    // unilateral connector need (N2). Becomes 'connector' once a
    // stock provider exists in p5-tool-connectors.ts.
    approach: "placeholder",
  },
  {
    id: "video-scroll-animation",
    label: "Scroll-Down-Animation",
    hint: "Reine CSS-/Scroll-Animation im Frontend — kein externes Tool, kein Credential.",
    approach: "css",
  },
  {
    id: "video-procedural",
    label: "Prozedural generiert",
    hint: "Engine-/ffmpeg-seitig generiertes Video — kein externer Connector.",
    approach: "procedural",
  },
];

const IMAGE_STYLES: readonly MediaStyleOption[] = [
  {
    id: "image-imagegen2",
    label: "KI-generiert (ImageGen2)",
    hint: "Bild aus Text-Prompt via engine-backed ImageGen2 (Codex/MAX — kein separater Key).",
    approach: "connector",
    provider: "imagegen2",
    neededCapabilities: [P5_CAPABILITY_KEYS.imagegen2], // 'image.generate'
  },
  {
    id: "image-stockphoto",
    label: "Stockfoto",
    hint: "Fertiges Foto aus einer Stock-Bibliothek (Connector folgt — heute Platzhalter-Hinweis).",
    approach: "placeholder",
  },
  {
    id: "image-placeholder",
    label: "Platzhalter",
    hint: "Generischer Platzhalter — kein externes Tool, später ersetzbar.",
    approach: "placeholder",
  },
];

const AVATAR_STYLES: readonly MediaStyleOption[] = [
  {
    id: "avatar-heygen",
    label: "Sprecher-Avatar (HeyGen)",
    hint: "Sprechender Avatar / Erklärfilm aus Skript via HeyGen.",
    approach: "connector",
    provider: "heygen-avatar",
    neededCapabilities: [P5_CAPABILITY_KEYS.heygenAvatar], // 'video.avatar'
  },
  {
    id: "avatar-none",
    label: "Kein Avatar",
    hint: "Diesen Schritt ohne Avatar umsetzen — kein externes Tool.",
    approach: "placeholder",
  },
];

const STYLES_BY_KIND: Readonly<Record<MediaStepKind, readonly MediaStyleOption[]>> = {
  image: IMAGE_STYLES,
  video: VIDEO_STYLES,
  avatar: AVATAR_STYLES,
};

/**
 * Returns the ordered style options for a media-step type.
 * Deterministic, no DB access.
 */
export function mediaStyleOptions(
  kind: MediaStepKind,
): readonly MediaStyleOption[] {
  return STYLES_BY_KIND[kind];
}

/**
 * Finds a style option by id within a media-step type. Returns
 * null if the id does NOT belong to this type (N2: no silent acceptance of a
 * foreign/unknown id).
 */
export function findMediaStyleOption(
  kind: MediaStepKind,
  optionId: string,
): MediaStyleOption | null {
  return STYLES_BY_KIND[kind].find((o) => o.id === optionId) ?? null;
}

// ---------------------------------------------------------------------------
// Resolution: style choice → concrete approach/provider need
// ---------------------------------------------------------------------------

/**
 * The resolved result of a style choice for a single media step.
 *
 * `needsConnector` is the ONLY switch that triggers the existing
 * needs-coupling path (credential coupling):
 *   approach === 'connector'  ⇒  needsConnector === true (provider/capabilities set).
 *   otherwise                  ⇒  needsConnector === false (no external need).
 */
export interface ResolvedMediaStyle {
  /** The chosen step type. */
  readonly kind: MediaStepKind;
  /** The chosen option (complete, for UI/audit). */
  readonly option: MediaStyleOption;
  /** Does this choice need a (possibly to-be-coupled) connector? */
  readonly needsConnector: boolean;
  /** Provider slug — only when needsConnector. */
  readonly provider: string | null;
  /** Needed capabilities — only when needsConnector. */
  readonly neededCapabilities: readonly string[];
}

/**
 * Resolves a style choice (kind + optionId) to its concrete approach/provider.
 *
 * @throws MediaStyleError('unknown_option')  — optionId does not belong to kind (N2).
 */
export function resolveMediaStyle(
  kind: MediaStepKind,
  optionId: string,
): ResolvedMediaStyle {
  const option = findMediaStyleOption(kind, optionId);
  if (option == null) {
    throw new MediaStyleError(
      "unknown_option",
      `resolveMediaStyle: option "${optionId}" is not a valid style for media kind "${kind}"`,
    );
  }
  const needsConnector = option.approach === "connector";
  return {
    kind,
    option,
    needsConnector,
    provider: needsConnector ? (option.provider ?? null) : null,
    neededCapabilities: needsConnector ? (option.neededCapabilities ?? []) : [],
  };
}

export class MediaStyleError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "MediaStyleError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// quickchoice surface payload (REUSE of the existing prompt surface)
//
// Produces the payload + markup for `<surface:prompt variant=quickchoice>`.
// The renderer (SurfaceRenderer.tsx::renderQuickChoice) expects:
//   data.options: [{ id, label, sublabel?, primary? }]
// On click: reply(label) + CustomEvent('lazyos:quickchoice', { id }).
//
// IMPORTANT: These functions DO NOT TOUCH THE RENDERER — they only produce the
// JSON payload or the `<surface:…>` string that the flow front door (/flow)
// writes into the chat stream. The step assignment (which flow_step?) travels in the
// payload (stepId/stepKind) so the answer route can feed applyStyleChoice.
// ---------------------------------------------------------------------------

/** A quickchoice option in exactly the format the renderer expects. */
export interface QuickChoiceOptionPayload {
  readonly id: string;
  readonly label: string;
  readonly sublabel: string;
  readonly primary?: boolean;
}

/**
 * The payload for a `<surface:prompt variant=quickchoice>` surface that offers the
 * style choice of a SINGLE media step. `stepId`/`stepKind` are
 * Flow-Studio metadata (ignored by the renderer, read by the answer route
 * to feed applyStyleChoice).
 */
export interface MediaStyleChoicePayload {
  readonly variant: "quickchoice";
  /** flow_steps.id of the media step (for the answer route). */
  readonly stepId: string;
  /**
   * Robustness fix (2026-05-29): the CANONICAL, re-compose-stable key
   * `media:<kind>:<n>` of this media step. The quickchoice click handler
   * MUST re-POST the owner choice under THIS key to /api/flow/compose-and-run
   * (instead of String(stepId/idx)) — otherwise the non-deterministic
   * re-compose often doesn't match (3–4 attempts needed, finding 2026-05-29). Optional for
   * backwards-compat: older payloads without this field still match via the
   * stepId/idx fallbacks in lookupStyleChoice.
   */
  readonly styleChoiceKey?: string;
  /** Step title (N1 verbatim) — context for the owner. */
  readonly stepTitle: string;
  /** The media-step type. */
  readonly stepKind: MediaStepKind;
  /** Flow context (for the answer route → applyStyleChoice). */
  readonly flowId: string;
  /** The selectable style options in renderer format. */
  readonly options: readonly QuickChoiceOptionPayload[];
  /**
   * Quickchoice click behavior (Phase 1 Track AB · finding A, 2026-05-29):
   *
   *   For flow-style choices the click MUST fire ONLY the `lazyos:quickchoice` event
   *   and emit NO reply(label). Otherwise we trigger two actions
   *   simultaneously:
   *     1. ChatShell listener → re-post `/api/flow/compose-and-run` with
   *        styleChoices (desired).
   *     2. reply(label) → an additional chat turn to `/api/chat/stream` with
   *        only the button label (destroys context/routing).
   *
   *   Acceptance (verbatim handoff): „Klick auf Flow-Style-Quickchoice
   *   erzeugt genau einen Request an /api/flow/compose-and-run. Der Klick
   *   erzeugt keinen zusätzlichen /api/chat/stream."
   *
   * Backward-compat: SurfaceRenderer treats a missing `behavior` as
   * 'reply-and-event' (default), only an explicit 'event-only' suppresses
   * reply(label).
   */
  readonly behavior: "event-only";
}

/**
 * Builds the quickchoice payload for the style choice of a media step. The
 * first option is marked `primary` (visual default anchor — NOT
 * pre-selected; the owner must click).
 */
export function buildMediaStyleChoicePayload(args: {
  readonly flowId: string;
  readonly stepId: string;
  readonly stepTitle: string;
  readonly stepKind: MediaStepKind;
  /**
   * Robustness fix (2026-05-29): re-compose-stable key `media:<kind>:<n>`,
   * under which the owner choice should be re-POSTed. Optional (backwards-compat).
   */
  readonly styleChoiceKey?: string;
}): MediaStyleChoicePayload {
  const opts = mediaStyleOptions(args.stepKind);
  const options: QuickChoiceOptionPayload[] = opts.map((o, idx) => ({
    id: o.id,
    label: o.label, // N1: verbatim
    sublabel: o.hint, // N1: verbatim
    ...(idx === 0 ? { primary: true } : {}),
  }));
  return {
    variant: "quickchoice",
    stepId: args.stepId,
    ...(args.styleChoiceKey ? { styleChoiceKey: args.styleChoiceKey } : {}),
    stepTitle: args.stepTitle, // N1: verbatim
    stepKind: args.stepKind,
    flowId: args.flowId,
    options,
    // Phase 1 Track AB · finding A: flow-style choice → ONLY a window event,
    // NO reply(label) (otherwise double routing; see the type comment above).
    behavior: "event-only",
  };
}

/**
 * Serializes a MediaStyleChoicePayload as a `<surface:prompt>` markup string,
 * exactly in the format that lib/chat/surface-parser.ts recognizes
 * (`<surface:prompt>{json}</surface:prompt>`). The renderer is NOT touched.
 *
 * Written by the /flow front door into the chat stream when a flow
 * contains a media step without a style choice (status 'needs-style-choice').
 */
export function renderMediaStyleChoiceSurface(
  payload: MediaStyleChoicePayload,
): string {
  return `<surface:prompt>${JSON.stringify(payload)}</surface:prompt>`;
}
