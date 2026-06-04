/**
 * Pricing table (Phase A/E) — DISPLAY ONLY, no real cost flow.
 *
 * lazyOS runs on the MAX plan. This module computes, for information, what
 * the same tokens would have cost on the Anthropic API — for the
 * workstream header display "MAX-Plan, gespart: €X.YZ vs API".
 *
 * Values as of 2026-04. Update when Anthropic changes prices.
 */

export type TierModel = 'opus' | 'sonnet' | 'haiku';

interface ModelPricing {
  /** $/MTok input. */
  inputPerMTok: number;
  /** $/MTok output. */
  outputPerMTok: number;
  /** $/MTok cache-read. */
  cacheReadPerMTok: number;
}

export const PRICING: Record<TierModel, ModelPricing> = {
  opus: {
    inputPerMTok: 15,
    outputPerMTok: 75,
    cacheReadPerMTok: 1.5,
  },
  sonnet: {
    inputPerMTok: 3,
    outputPerMTok: 15,
    cacheReadPerMTok: 0.3,
  },
  haiku: {
    inputPerMTok: 0.8,
    outputPerMTok: 4,
    cacheReadPerMTok: 0.08,
  },
};

/**
 * Owner directive (2026-05-29, binding): EXCLUSIVELY Opus for EVERY
 * agentic task. On the MAX plan, cost is irrelevant — only
 * output quality counts. So ALL tiers (including 'sonnet'/'haiku') resolve to the
 * latest Opus. The TierModel labels remain only as an effort/timeout axis
 * (now also unified to the Opus level), so that no
 * missed call-site ever spawns a weaker model. Single source of
 * truth — flipping it here is enough to enforce Opus-only system-wide.
 */
const OPUS_MODEL = 'claude-opus-4-8';

export const MODEL_NAMES: Record<TierModel, string> = {
  opus: OPUS_MODEL,
  sonnet: OPUS_MODEL, // Opus-only (owner directive) — label only for effort/timeout
  haiku: OPUS_MODEL, // Opus-only (owner directive) — label only for effort/timeout
};

/**
 * Effort level per tier. Owner directive Opus-only ⇒ 'xhigh' everywhere (Opus
 * deserves maximum reasoning depth; quality above all). No tier runs
 * 'medium'/'low' anymore, because no tier runs a weaker model anymore.
 */
export const TIER_EFFORT: Record<TierModel, 'xhigh' | 'medium' | 'low'> = {
  opus: 'xhigh',
  sonnet: 'xhigh',
  haiku: 'xhigh',
};

/**
 * Computes the API-equivalent cost in cents for a tier run.
 * Input in absolute tokens, output in euro cents (≈ USD cents for
 * our display; we deliberately ignore the exchange rate).
 */
export function calcCostCents(
  tier: TierModel,
  tokens: { input: number; output: number; cacheRead: number },
): number {
  const p = PRICING[tier];
  const inputCost = (tokens.input * p.inputPerMTok) / 1_000_000;
  const outputCost = (tokens.output * p.outputPerMTok) / 1_000_000;
  const cacheCost = (tokens.cacheRead * p.cacheReadPerMTok) / 1_000_000;
  const totalUsd = inputCost + outputCost + cacheCost;
  return Math.round(totalUsd * 100);
}
