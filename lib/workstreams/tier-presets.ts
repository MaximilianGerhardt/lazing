/**
 * Tier-Presets für den Iterate-Modus (Sub-Plan A · 2026-04-30).
 *
 * Vorher hat `runIterate` die User-Wahl im TierChoice-Picker komplett
 * ignoriert — Roaster-Count war fix 2, Sniper-Loop fix on. Jetzt steuern
 * Presets:
 *   - leadCount        Anzahl Lead-Spawns (immer 1, future-proof).
 *   - roasterCount     Anzahl paralleler Roaster (0 / 2 / 4).
 *   - sniperLoop       Wenn `false`, breche nach V2 ab (kein V3-V5-Loop).
 *   - stages           Auto-Dispatch-Pipeline-Stages pro Sub-Ticket.
 *                      Schnell = nur senior-dev, Standard = +reviewer,
 *                      Tief = +critic.
 *   - estMinutes       Erwartete Wallclock-Zeit für die UI-Pill.
 *
 * Backwards-Compat: Workstreams ohne `mode`/`iterate_config_json` (Pre-0041)
 * werden vom Caller wie `TIER_PRESETS.standard` behandelt.
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
 * Total-Agent-Count für UI-Pill: Lead + Roasters + Synthesis (1) +
 * (sniperLoop ? 2 zusätzliche Versionen : 0). Synthesis = der finale
 * V2-Lead-Spawn der Roasts integriert.
 *
 * Schnell: 1 (lead) + 0 (roast) + 0 (kein synth, weil keine roasts) = 1
 *   Sonderfall: bei roasterCount=0 gibt's keinen V2 — der Lead-Output IST
 *   der finale Plan. Daher kein +1 Synthesis-Aufschlag.
 * Standard: 1 + 2 + 1 = 4
 * Tief: 1 + 4 + 1 + 2 (V3+V4 via Sniper-Loop, V5 optional) = 8 max,
 *   aber wir zeigen erwartungswert ~7 (Loop bricht oft früher).
 */
export function totalAgents(c: IterateConfig): number {
  if (c.roasterCount === 0) {
    // Schnell-Pfad: nur Lead, kein Synthesis-Schritt nötig.
    return c.leadCount + (c.sniperLoop ? 2 : 0);
  }
  return (
    c.leadCount + c.roasterCount + 1 + (c.sniperLoop ? 2 : 0)
  );
}

/**
 * Backwards-Compat-Resolver: parse das `iterate_config_json`-Feld eines
 * Workstreams. Bei NULL/fehlerhaft: TIER_PRESETS.standard.
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
      // Wir vertrauen dem Preset-Lookup und überschreiben nicht mit
      // möglicherweise korrupten Einzelwerten — der Preset-Schlüssel ist
      // die Source of Truth, das JSON ist nur ein Cache.
      return TIER_PRESETS[parsed.presetId];
    }
  } catch {
    // fallthrough zu Default
  }
  return TIER_PRESETS.standard;
}

/**
 * UI-Helper: human-readable Cost-Summary für TierChoiceCard.
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
