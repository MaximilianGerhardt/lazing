/**
 * Tier presets for iterate mode (sub-plan A · 2026-04-30).
 *
 * Previously `runIterate` completely ignored the user's choice in the
 * TierChoice picker — the roaster count was fixed at 2, the sniper loop fixed on. Now
 * presets control:
 *   - leadCount        number of lead spawns (always 1, future-proof).
 *   - roasterCount     number of parallel roasters (0 / 2 / 4).
 *   - sniperLoop       when `false`, stop after V2 (no V3-V5 loop).
 *   - stages           auto-dispatch pipeline stages per sub-ticket.
 *                      Schnell = senior-dev only, Standard = +reviewer,
 *                      Tief = +critic.
 *   - estMinutes       expected wallclock time for the UI pill.
 *
 * Backwards-compat: workstreams without `mode`/`iterate_config_json` (pre-0041)
 * are treated by the caller like `TIER_PRESETS.standard`.
 */

export type TierPresetId = 'schnell' | 'standard' | 'tief';

export type AutoDispatchStage = 'senior-dev' | 'code-reviewer' | 'critic';

export interface IterateConfig {
  presetId: TierPresetId;
  leadCount: number;
  roasterCount: number;
  sniperLoop: boolean;
  stages: ReadonlyArray<AutoDispatchStage>;
  estMinutes: number;
}

export const TIER_PRESETS: Record<TierPresetId, IterateConfig> = {
  schnell: {
    presetId: 'schnell',
    leadCount: 1,
    roasterCount: 0,
    sniperLoop: false,
    stages: ['senior-dev'],
    estMinutes: 3,
  },
  standard: {
    presetId: 'standard',
    leadCount: 1,
    roasterCount: 2,
    sniperLoop: false,
    stages: ['senior-dev', 'code-reviewer'],
    estMinutes: 8,
  },
  tief: {
    presetId: 'tief',
    leadCount: 1,
    roasterCount: 4,
    sniperLoop: true,
    stages: ['senior-dev', 'code-reviewer', 'critic'],
    estMinutes: 18,
  },
};

/**
 * Total agent count for the UI pill: lead + roasters + synthesis (1) +
 * (sniperLoop ? 2 additional versions : 0). Synthesis = the final
 * V2 lead spawn that integrates the roasts.
 *
 * Schnell: 1 (lead) + 0 (roast) + 0 (no synth, because no roasts) = 1
 *   Special case: with roasterCount=0 there is no V2 — the lead output IS
 *   the final plan. Hence no +1 synthesis surcharge.
 * Standard: 1 + 2 + 1 = 4
 * Tief: 1 + 4 + 1 + 2 (V3+V4 via the sniper loop, V5 optional) = 8 max,
 *   but we show an expected value of ~7 (the loop often stops earlier).
 */
export function totalAgents(c: IterateConfig): number {
  if (c.roasterCount === 0) {
    // Schnell path: lead only, no synthesis step needed.
    return c.leadCount + (c.sniperLoop ? 2 : 0);
  }
  return (
    c.leadCount + c.roasterCount + 1 + (c.sniperLoop ? 2 : 0)
  );
}

/**
 * Backwards-compat resolver: parses the `iterate_config_json` field of a
 * workstream. On NULL/malformed: TIER_PRESETS.standard.
 */
export function resolveIterateConfig(
  json: string | null | undefined,
): IterateConfig {
  if (!json) return TIER_PRESETS.standard;
  try {
    const parsed = JSON.parse(json) as Partial<IterateConfig>;
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof parsed.presetId === 'string' &&
      (parsed.presetId === 'schnell' ||
        parsed.presetId === 'standard' ||
        parsed.presetId === 'tief')
    ) {
      // We trust the preset lookup and don't overwrite with
      // possibly corrupt individual values — the preset key is
      // the source of truth, the JSON is just a cache.
      return TIER_PRESETS[parsed.presetId];
    }
  } catch {
    // fall through to default
  }
  return TIER_PRESETS.standard;
}

/**
 * UI helper: human-readable cost summary for TierChoiceCard.
 * Format: „Schnell · 1 Agent · ~3 min".
 */
export function presetSummary(p: IterateConfig): string {
  const total = totalAgents(p);
  const agentLabel = total === 1 ? '1 Agent' : `~${total} Agenten`;
  const labelByPreset: Record<TierPresetId, string> = {
    schnell: 'Schnell',
    standard: 'Standard',
    tief: 'Tief',
  };
  return `${labelByPreset[p.presetId]} · ${agentLabel} · ~${p.estMinutes} min`;
}
