/**
 * Opus-only-Garantie (Owner-Direktive 2026-05-29/30, verbindlich):
 * ALLE Agent-Spawns / LLM-Calls laufen ausschließlich auf Opus 4.8
 * (`claude-opus-4-8`). MAX-Plan ⇒ Kosten irrelevant, nur Output-Qualität.
 *
 * Diese Suite ist der deterministische Wächter dafür, dass KEIN Tier-Label
 * (auch nicht 'sonnet'/'haiku', die nur noch als Effort-/Slot-Achse existieren)
 * jemals ein Nicht-Opus-Modell auflöst. MODEL_NAMES ist die single source of
 * truth; jeder Spawn-Pfad zieht sein `--model` daraus (bzw. aus dem expliziten
 * MODEL_NAMES.opus). Wenn jemand den Alias je auf ein schwächeres Modell
 * zurückdreht, schlägt dieser Test SOFORT fehl.
 *
 * Run: `npx vitest run lib/agents/__tests__/pricing-opus-only.test.ts`
 */

import { describe, it, expect } from 'vitest';
import { MODEL_NAMES, TIER_EFFORT, type TierModel } from '@/lib/agents/pricing';

const OPUS = 'claude-opus-4-8';
const ALL_TIERS: ReadonlyArray<TierModel> = ['opus', 'sonnet', 'haiku'];

describe('Opus-only model resolution (Owner-Direktive)', () => {
  it('JEDES Tier resolved auf claude-opus-4-8 — kein Nicht-Opus-Modell', () => {
    for (const tier of ALL_TIERS) {
      expect(MODEL_NAMES[tier]).toBe(OPUS);
    }
  });

  it('kein Tier resolved auf ein sonnet/haiku/claude-3/4-5/4-6/4-7-Modell', () => {
    const forbidden = /sonnet|haiku|claude-3|4-5|4-6|4-7/i;
    for (const tier of ALL_TIERS) {
      expect(MODEL_NAMES[tier]).not.toMatch(forbidden);
    }
  });

  it('alle MODEL_NAMES-Werte sind identisch (ein einziges Modell systemweit)', () => {
    const distinct = new Set(Object.values(MODEL_NAMES));
    expect(distinct.size).toBe(1);
    expect([...distinct][0]).toBe(OPUS);
  });

  it('jedes Tier fährt xhigh-Effort (Opus verdient maximale Reasoning-Tiefe)', () => {
    for (const tier of ALL_TIERS) {
      expect(TIER_EFFORT[tier]).toBe('xhigh');
    }
  });
});
