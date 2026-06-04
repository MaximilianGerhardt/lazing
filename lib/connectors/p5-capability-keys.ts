/**
 * P5 Connector Capability Keys — pure constants, NO imports, NO side-effects.
 *
 * Extracted 2026-05-28 to break a client-bundle transitive chain:
 *   SurfaceRenderer (client) → pricing.ts → p5-tool-connectors.ts → catalog.ts
 *     → db/client.ts → routines/runner → plan-executor → server/agents/tmux-spawn
 *   (tmux-spawn uses node:child_process and cannot be bundled for the client.)
 *
 * `p5-tool-connectors.ts` holds the full connector PROFILES (catalog-bound,
 * server-side). Pure consumers (pricing, media-styles, future client renderers)
 * import THIS file instead and stay client-safe.
 *
 * Single source of truth: this file. `p5-tool-connectors.ts` re-uses these.
 */

/** The capability `name` a Flow Studio step must request for each connector. */
export const P5_CAPABILITY_KEYS = {
  imagegen2: "image.generate",
  higgsfield: "video.motion",
  heygenAvatar: "video.avatar",
} as const;

export type P5CapabilityKey =
  (typeof P5_CAPABILITY_KEYS)[keyof typeof P5_CAPABILITY_KEYS];
