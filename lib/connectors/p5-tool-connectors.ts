/**
 * P5 — Flow Studio Tool-Connector Catalog (additive seed) · 2026-05-27.
 *
 * Public API:
 *   P5_TOOL_CONNECTORS        — readonly registry of the 3 built-in tool connectors.
 *   ensureP5ToolConnectors()  — idempotent seeder → connector_catalog.
 *   getP5ToolConnectorDef()   — registry lookup by provider slug (no DB).
 *
 * WHY code-side (not a DB migration):
 *   The connector catalog is populated programmatically via
 *   lib/connectors/catalog.ts::upsertConnectorProfile() — there is no static
 *   seed-array migration for built-in connectors. This module mirrors exactly
 *   lib/sop/seed.ts::ensureBuiltInSops() (idempotent, re-runnable, skips if the
 *   row already exists) and lib/appstore/registry.ts::mirrorToConnectorCatalog()
 *   (same upsert path). ADDITIVE: it touches no existing connectors, no schema,
 *   no live :4200 deploy.
 *
 * The 3 connectors (Flow Studio step-tools):
 *   1. imagegen2   — Bild-Generierung via Codex-Engine. capability: 'image.generate'.
 *                    authKind 'none' — engine-backed: reuses the existing
 *                    Codex/MAX auth (lib/llm/engines/codex.ts), NO separate key.
 *                    Marked engineBacked: true at the registry level.
 *   2. higgsfield  — Motion/Video-Graphics. capability: 'video.motion'.
 *                    authKind 'api_key' (oauth fallback noted in onboarding).
 *   3. heygen-avatar — Sprechender Avatar / Erklärfilm. capability: 'video.avatar'.
 *                    authKind 'api_key'.
 *
 * live_gated (R3 / ACL-5):
 *   Every connector here is live_gated. There is NO `live_gated` column in
 *   connector_catalog — the actual live gate is the GLOBAL master switch
 *   LAZYOS_CONNECTOR_LIVE, enforced fail-closed in lib/connectors/invoke.ts
 *   (isLiveEnabled()). Default off → Dry-Run, NO external network. This module
 *   records `liveGated: true` at the registry level for Flow Studio / Track-D
 *   to surface the gate in the UI; it does NOT and CANNOT enable any live call.
 *
 * Credentials:
 *   This module NEVER stores a secret (PII Hard-Guard in catalog.ts rejects any
 *   credential key). The owner enters keys via the existing credential vault /
 *   CredentialRequestCard surface (ACL-1, db/schema/api_credentials.ts). The
 *   `onboardingFields` here are only the SCHEMA of what the owner would enter —
 *   referenced, never invoked.
 *
 * Dependencies: lib/connectors/catalog.ts (upsertConnectorProfile, getConnectorProfile),
 *   lib/connectors/coverage.ts type only. No LLM, no external I/O.
 */

import type { ConnectorAuthKind } from "@/db/schema/connectors";
import {
  getConnectorProfile,
  upsertConnectorProfile,
  type CapabilityInput,
  type ConnectorProfileInput,
} from "./catalog";

// ---------------------------------------------------------------------------
// Onboarding field descriptor — the SCHEMA of what the owner would enter.
// This is NOT a credential value; it is the shape the existing credential
// vault / CredentialRequestCard would render. Referenced, never invoked.
// ---------------------------------------------------------------------------

export type OnboardingFieldKind = "api_key" | "oauth_token" | "none";

export type OnboardingFieldDef = {
  /** Field key (machine-readable), e.g. 'api_key'. */
  key: string;
  /** Human-readable label for the credential surface. */
  label: string;
  /** Which credential kind the vault should store this as. */
  kind: OnboardingFieldKind;
  /** Whether the owner MUST supply this before any (gated) live call. */
  required: boolean;
  /** Help text shown in the CredentialRequestCard. */
  help: string;
};

// ---------------------------------------------------------------------------
// P5 tool-connector definition (registry-level — richer than the catalog row)
// ---------------------------------------------------------------------------

export type P5ToolConnectorDef = {
  /** ConnectorProfileInput persisted to connector_catalog via upsert. */
  profile: ConnectorProfileInput;
  /**
   * R3 / ACL-5 marker. ALWAYS true for P5 tool connectors. NOT a catalog column —
   * the real gate is LAZYOS_CONNECTOR_LIVE (invoke.ts). Surfaced for Flow Studio.
   */
  liveGated: true;
  /**
   * true = no separate credential; auth is the existing engine auth
   * (Codex/MAX). Only imagegen2 is engine-backed.
   */
  engineBacked: boolean;
  /** Reference to the built-in onboarding SOP (Migration 0103). */
  onboardingSopRef: string;
  /** SCHEMA of fields the owner would enter in the credential vault. */
  onboardingFields: OnboardingFieldDef[];
};

// ---------------------------------------------------------------------------
// Canonical capability keys (Flow Studio step-tool selectors)
// ---------------------------------------------------------------------------

// P5_CAPABILITY_KEYS lives in lib/connectors/p5-capability-keys.ts (pure
// constants, no imports) so client-side consumers (pricing.ts, media-styles.ts,
// SurfaceRenderer) can use it WITHOUT pulling the catalog/db/server chain
// transitively into the client bundle. Re-exported here for back-compat with
// every caller that imports from this module.
export { P5_CAPABILITY_KEYS, type P5CapabilityKey } from "./p5-capability-keys";
import { P5_CAPABILITY_KEYS } from "./p5-capability-keys";

// ---------------------------------------------------------------------------
// Built-in connector profile builders (verbatim capability descriptions, N1)
// ---------------------------------------------------------------------------

const imagegen2Capability: CapabilityInput = {
  name: P5_CAPABILITY_KEYS.imagegen2, // 'image.generate'
  description:
    "Generate an image from a text prompt (and optional reference image) using the engine-backed Codex image pipeline. Returns a generated image artifact reference. Engine-backed: no separate API key — reuses the existing Codex/MAX session auth.",
  inputSchemaJson: JSON.stringify({
    type: "object",
    properties: {
      prompt: { type: "string", description: "Text prompt describing the image." },
      size: {
        type: "string",
        enum: ["256x256", "512x512", "1024x1024"],
        description: "Output resolution.",
      },
      referenceImageUrl: {
        type: "string",
        description: "Optional reference/style image URL.",
      },
    },
    required: ["prompt"],
  }),
  outputSchemaJson: JSON.stringify({
    type: "object",
    properties: {
      imageUrl: { type: "string", description: "URL/reference of the generated image." },
      revisedPrompt: { type: "string" },
    },
  }),
  // Canonical MCP tool name 'mcp__<provider>__<tool>'. Required by the S4
  // hardening gate (invoke-policy.ts) so Flow Studio can select this as a
  // step-tool; without it the capability is REST-only and S4-blocked.
  mcpToolName: "mcp__imagegen2__image_generate",
  required: true,
};

const higgsfieldCapability: CapabilityInput = {
  name: P5_CAPABILITY_KEYS.higgsfield, // 'video.motion'
  description:
    "Produce motion/video-graphics (animated motion design) from a still image or prompt via Higgsfield. Returns a rendered motion clip artifact reference. Auth: api-key (oauth fallback documented in onboarding).",
  inputSchemaJson: JSON.stringify({
    type: "object",
    properties: {
      prompt: { type: "string", description: "Motion description / scene prompt." },
      sourceImageUrl: {
        type: "string",
        description: "Optional source still to animate.",
      },
      durationSeconds: { type: "number", description: "Clip length in seconds." },
    },
    required: ["prompt"],
  }),
  outputSchemaJson: JSON.stringify({
    type: "object",
    properties: {
      videoUrl: { type: "string", description: "URL/reference of the rendered motion clip." },
      jobId: { type: "string" },
    },
  }),
  mcpToolName: "mcp__higgsfield__video_motion",
  required: true,
};

const heygenAvatarCapability: CapabilityInput = {
  name: P5_CAPABILITY_KEYS.heygenAvatar, // 'video.avatar'
  description:
    "Render a talking-avatar / explainer video from a script (and selected avatar + voice) via HeyGen. Returns a rendered avatar video artifact reference. Auth: api-key.",
  inputSchemaJson: JSON.stringify({
    type: "object",
    properties: {
      script: { type: "string", description: "Spoken script for the avatar." },
      avatarId: { type: "string", description: "HeyGen avatar identifier." },
      voiceId: { type: "string", description: "Voice identifier." },
    },
    required: ["script"],
  }),
  outputSchemaJson: JSON.stringify({
    type: "object",
    properties: {
      videoUrl: { type: "string", description: "URL/reference of the rendered avatar video." },
      jobId: { type: "string" },
    },
  }),
  mcpToolName: "mcp__heygen-avatar__video_avatar",
  required: true,
};

// ---------------------------------------------------------------------------
// Registry — the 3 P5 tool connectors
// ---------------------------------------------------------------------------

const SOP_CONNECTOR_ONBOARD = "SOP-BUILTIN-CONNECTOR-ONBOARD-01";

export const P5_TOOL_CONNECTORS: readonly P5ToolConnectorDef[] = [
  // ── 1. imagegen2 — engine-backed image generation (Codex) ─────────────────
  {
    profile: {
      provider: "imagegen2",
      displayName: "ImageGen2 (Codex-backed Image Generation)",
      description:
        "Engine-backed image generation. Uses the existing Codex/MAX session auth (lib/llm/engines/codex.ts) — no separate API key required. Live calls are gated by LAZYOS_CONNECTOR_LIVE (default off → Dry-Run).",
      // 'none' = engine-backed: no separate credential. (auth_kind enum is
      // api_key|oauth|pat|none|custom — there is no 'engine-backed' kind, so
      // 'none' is the correct closed-enum value; engineBacked:true marks it.)
      authKind: "none" satisfies ConnectorAuthKind,
      baseUrl: null,
      apiVersion: "v1",
      docsUrl: null,
      source: "manual",
      validatedAt: null,
      capabilities: [imagegen2Capability],
    },
    liveGated: true,
    engineBacked: true,
    onboardingSopRef: SOP_CONNECTOR_ONBOARD,
    // Engine-backed: nothing for the owner to enter — auth comes from the engine.
    onboardingFields: [
      {
        key: "none",
        label: "No credential required (engine-backed via Codex/MAX)",
        kind: "none",
        required: false,
        help: "ImageGen2 reuses the existing Codex/MAX session. No API key to enter. Live calls still require LAZYOS_CONNECTOR_LIVE=on.",
      },
    ],
  },

  // ── 2. higgsfield — motion / video-graphics ───────────────────────────────
  {
    profile: {
      provider: "higgsfield",
      displayName: "Higgsfield (Motion / Video Graphics)",
      description:
        "Motion and video-graphics generation. Auth: API key (OAuth fallback). Live calls are gated by LAZYOS_CONNECTOR_LIVE (default off → Dry-Run).",
      authKind: "api_key" satisfies ConnectorAuthKind,
      baseUrl: null,
      apiVersion: "v1",
      docsUrl: null,
      source: "manual",
      validatedAt: null,
      capabilities: [higgsfieldCapability],
    },
    liveGated: true,
    engineBacked: false,
    onboardingSopRef: SOP_CONNECTOR_ONBOARD,
    onboardingFields: [
      {
        key: "api_key",
        label: "Higgsfield API Key",
        kind: "api_key",
        required: true,
        help: "Paste your Higgsfield API key. Stored encrypted in the credential vault (api_credentials). Never written to the connector catalog.",
      },
    ],
  },

  // ── 3. heygen-avatar — talking avatar / explainer video ───────────────────
  {
    profile: {
      provider: "heygen-avatar",
      displayName: "HeyGen (Talking Avatar / Explainer Video)",
      description:
        "Talking-avatar and explainer-video rendering. Auth: API key. Live calls are gated by LAZYOS_CONNECTOR_LIVE (default off → Dry-Run).",
      authKind: "api_key" satisfies ConnectorAuthKind,
      baseUrl: null,
      apiVersion: "v2",
      docsUrl: null,
      source: "manual",
      validatedAt: null,
      capabilities: [heygenAvatarCapability],
    },
    liveGated: true,
    engineBacked: false,
    onboardingSopRef: SOP_CONNECTOR_ONBOARD,
    onboardingFields: [
      {
        key: "api_key",
        label: "HeyGen API Key",
        kind: "api_key",
        required: true,
        help: "Paste your HeyGen API key. Stored encrypted in the credential vault (api_credentials). Never written to the connector catalog.",
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// getP5ToolConnectorDef — registry lookup by provider slug (no DB).
// ---------------------------------------------------------------------------

export function getP5ToolConnectorDef(provider: string): P5ToolConnectorDef | null {
  return P5_TOOL_CONNECTORS.find((c) => c.profile.provider === provider) ?? null;
}

// ---------------------------------------------------------------------------
// ensureP5ToolConnectors — idempotent seeder into connector_catalog.
//
// Mirrors lib/sop/seed.ts::ensureBuiltInSops(): skip if the provider row already
// exists, otherwise upsert. Re-runnable; never touches existing connectors.
// upsertConnectorProfile runs the PII Hard-Guard first — a credential value in
// any field would throw before any DB write.
// ---------------------------------------------------------------------------

export function ensureP5ToolConnectors(ctx: { actor?: string } = {}): void {
  const actor = ctx.actor ?? "p5-tool-connector-seed";
  for (const def of P5_TOOL_CONNECTORS) {
    const existing = getConnectorProfile(def.profile.provider);
    if (existing) continue; // Already seeded — skip (idempotent).
    upsertConnectorProfile(def.profile, { actor });
  }
}
