/**
 * Connector Cost-Estimation Hint Layer — Stream X1 · 2026-05-28.
 *
 * Public API:
 *   estimateCost(provider, capability, args?) → CostEstimate
 *   listPricingTable()                        → readonly PricingEntry[]
 *
 * Owner-Direktive #2 (verbatim, N1):
 *   'Budgets lassen sich in den jeweiligen API Einstellungen einstellen — das
 *    könnte man als Absicherung sagen. Kosten vorher schätzen, transparent
 *    ausweisen, ABER weniger als Cap, eher als Hinweis."
 *
 * Therefore:
 *   - estimateCost NEVER blocks, NEVER throws, NEVER returns 0 by accident.
 *   - Unknown provider/capability → { eurMin: null, eurMax: null,
 *     basis: 'unknown', note: '…' } — explicit unknown-marker, NOT a silent 0.
 *   - The UI uses the result purely as a hint line above the coupling card
 *     (renderFlowCoupling) — provider-side budgets (set in the provider
 *     console, see lib/connectors/onboarding-sop.ts) remain the only real cap.
 *
 * Design principles:
 *   N1 (Detail preservation): notes are verbatim per provider — no truncation.
 *   N6 (Deterministic):       pure function, no LLM, no network, no I/O.
 *   N4 (Recovery before reinvent): provider slugs MUST match
 *                                  lib/connectors/p5-tool-connectors.ts.
 *
 * Pricing data sources (collected 2026-05-28, conservatively upper-bounded;
 *   provider pricing changes — these are HINTS, not contracts):
 *
 *   - imagegen2 (image.generate) — engine-backed via Codex/MAX. No separate
 *     direct charge; cost is absorbed in the active Codex/MAX session quota.
 *     Modeled as { eurMin: 0, eurMax: 0.05, basis: 'engine-backed', note: '…' }
 *     so the owner sees a value but knows it's free at the connector level.
 *
 *   - higgsfield (video.motion) — public price ranges seen in marketing: in the
 *     order of a few US cents per second of generated motion clip. Conservative
 *     upper-bound used here. Default args: 5s clip.
 *
 *   - heygen-avatar (video.avatar) — HeyGen meters per credit (~ 1 credit ~ 1
 *     minute of avatar video in Pro tier; credit cost varies by plan). Modeled
 *     per minute of script. Conservative upper-bound used here.
 *
 * Dependencies: NONE (pure).
 */

// Import from the pure-constants file (NOT p5-tool-connectors) so this module
// stays client-safe — p5-tool-connectors pulls catalog/db/routines/tmux-spawn
// (node:child_process) transitively and would break the client bundle.
import { P5_CAPABILITY_KEYS } from "@/lib/connectors/p5-capability-keys";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * One pricing-table entry: per provider × capability.
 *
 * eurMin / eurMax are nullable to signal "unknown" explicitly. The basis
 * string is a verbatim short label shown in the UI hint ("pro Sekunde",
 * "pro Minute", "pro Bild", "unbekannt"). The note is a longer
 * verbatim (N1) explanation that may be revealed in a tooltip / expand row.
 */
export interface PricingEntry {
  readonly provider: string;
  readonly capability: string;
  /** Lower bound estimate in EUR. null = unknown. */
  readonly eurMin: number | null;
  /** Upper bound estimate in EUR. null = unknown. */
  readonly eurMax: number | null;
  /** Verbatim basis label (e.g. "pro Sekunde", "pro Minute", "pro Bild"). */
  readonly basis: string;
  /** Verbatim explanation note (N1). */
  readonly note: string;
  /**
   * Pure scaling function: given the raw args from a flow step, returns
   * a multiplier on (eurMin, eurMax). For higgsfield: durationSeconds.
   * Default = 1 (per-unit). NEVER throws.
   */
  readonly scale?: (args: Record<string, unknown> | undefined) => number;
  /** Default scale multiplier if args don't override (e.g. assumed clip length). */
  readonly defaultScale: number;
}

/**
 * Result of an estimateCost() call. eurMin/eurMax are null when unknown —
 * the UI MUST surface "unbekannt" (not 0) in that case (Owner-Direktive #2).
 */
export interface CostEstimate {
  readonly provider: string;
  readonly capability: string;
  /** Estimated lower bound in EUR. null = unknown. */
  readonly eurMin: number | null;
  /** Estimated upper bound in EUR. null = unknown. */
  readonly eurMax: number | null;
  /** Verbatim basis label (e.g. "pro Schritt (5s Clip)"). */
  readonly basis: string;
  /** Verbatim explanatory note (N1). */
  readonly note: string;
  /** true when this is an unknown-marker (eurMin/eurMax both null). */
  readonly unknown: boolean;
}

// ---------------------------------------------------------------------------
// Pricing registry — verified public prices (conservative upper-bounds).
// ---------------------------------------------------------------------------

const PRICING_TABLE: readonly PricingEntry[] = [
  // ── imagegen2 — engine-backed (Codex/MAX) ───────────────────────────────────
  {
    provider: "imagegen2",
    capability: P5_CAPABILITY_KEYS.imagegen2, // 'image.generate'
    eurMin: 0,
    eurMax: 0.05,
    basis: "pro Bild (engine-backed)",
    note:
      "imagegen2 nutzt deine bestehende Codex/MAX-Session — es gibt KEINE separate Connector-Rechnung. Die hier ausgewiesene Spanne (0,00–0,05 €) ist nur ein Hinweis auf das anteilige Codex/MAX-Kontingent. Echte Kosten siehst du in deinem Codex/MAX-Account.",
    defaultScale: 1,
  },

  // ── higgsfield — Motion / Video Graphics ────────────────────────────────────
  {
    provider: "higgsfield",
    capability: P5_CAPABILITY_KEYS.higgsfield, // 'video.motion'
    // ~ 1.5–4 US-Cent pro Sekunde gesehen → ~ 0,013–0,037 € → konservativ.
    eurMin: 0.01,
    eurMax: 0.04,
    basis: "pro Sekunde Clip",
    note:
      "Higgsfield rechnet pro generierter Clip-Sekunde ab. Die Spanne ist eine Schätzung (Stand 2026-05) — die echte Höhe steht in deiner Higgsfield-Billing-Konsole. Setze dort ein Pre-paid-Guthaben oder eine harte Monats-Grenze als Cap — laz.ing zeigt nur einen Hinweis.",
    scale: (args) => {
      const dur = args?.durationSeconds;
      if (typeof dur === "number" && Number.isFinite(dur) && dur > 0) {
        return dur;
      }
      return 5; // Default: 5s Clip wenn nichts übergeben.
    },
    defaultScale: 5,
  },

  // ── heygen-avatar — Talking Avatar / Explainer Video ────────────────────────
  {
    provider: "heygen-avatar",
    capability: P5_CAPABILITY_KEYS.heygenAvatar, // 'video.avatar'
    // HeyGen rechnet pro Credit (~1 Credit/Min in Pro); Credit ~ 0,30–1,00 €
    // je Plan-Stufe. Konservative Spanne pro Minute Script.
    eurMin: 0.3,
    eurMax: 1.0,
    basis: "pro Minute Skript",
    note:
      "HeyGen verbraucht Credits pro generiertem Avatar-Video. Die Spanne (0,30–1,00 € / Minute) ist eine Schätzung über die gängigen Plan-Stufen — die echten Credit-Kosten siehst du in deinem HeyGen-Subscription-Tab. Setze dort eine niedrigere Plan-Stufe oder einen Spending-Alert.",
    scale: (args) => {
      // Versuche eine sinnvolle Minutenzahl aus typischen Feldern abzuleiten.
      const explicit = args?.durationMinutes;
      if (typeof explicit === "number" && Number.isFinite(explicit) && explicit > 0) {
        return explicit;
      }
      const script = args?.script;
      if (typeof script === "string" && script.length > 0) {
        // Very rough rule of thumb: ~ 150 words per minute reading speed.
        const words = script.trim().split(/\s+/).filter((w) => w.length > 0).length;
        if (words > 0) {
          return Math.max(0.5, words / 150);
        }
      }
      return 1; // Default: 1 Minute.
    },
    defaultScale: 1,
  },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Estimate the cost of a single connector capability call.
 *
 * NEVER throws. NEVER returns 0 for unknown — returns
 * { eurMin: null, eurMax: null, unknown: true } so the UI shows "unbekannt"
 * instead of "kostenlos". Owner-Direktive #2: this is a HINT, never a cap.
 *
 * @param provider    Provider slug (must match connector_catalog).
 * @param capability  Capability name (e.g. 'video.motion').
 * @param args        Optional raw args from the flow step — used to scale the
 *                    per-unit price (e.g. durationSeconds for higgsfield).
 */
export function estimateCost(
  provider: string,
  capability: string,
  args?: Record<string, unknown>,
): CostEstimate {
  const entry = PRICING_TABLE.find(
    (e) => e.provider === provider && e.capability === capability,
  );
  if (!entry) {
    return {
      provider,
      capability,
      eurMin: null,
      eurMax: null,
      basis: "unbekannt",
      note:
        "Für diese Kombination aus Provider und Capability liegt keine hinterlegte Preis-Schätzung vor. Echte Kosten siehst du nach dem ersten LIVE-Call in der Konsole des Providers. Setze dort einen Spending-Cap.",
      unknown: true,
    };
  }

  const scale = entry.scale ? safeScale(entry.scale, args) : 1;
  const unit = scale > 0 ? scale : entry.defaultScale;

  const eurMin = entry.eurMin === null ? null : round4(entry.eurMin * unit);
  const eurMax = entry.eurMax === null ? null : round4(entry.eurMax * unit);

  const basisSuffix = entry.scale
    ? ` × ${formatScale(unit, entry.basis)}`
    : "";

  return {
    provider,
    capability,
    eurMin,
    eurMax,
    basis: `${entry.basis}${basisSuffix}`,
    note: entry.note,
    unknown: false,
  };
}

/** Read-only view of the pricing registry — useful for tests / debug. */
export function listPricingTable(): readonly PricingEntry[] {
  return PRICING_TABLE;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function safeScale(
  fn: (args: Record<string, unknown> | undefined) => number,
  args: Record<string, unknown> | undefined,
): number {
  try {
    const v = fn(args);
    return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
  } catch {
    return 0;
  }
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function formatScale(unit: number, basis: string): string {
  // Heuristik: bei Sekunden/Minuten-Basis runde auf eine Nachkommastelle;
  // bei Bild-Anzahlen auf ganze Zahl.
  if (basis.toLowerCase().includes("sekunde")) {
    return `${unit.toFixed(0)} s`;
  }
  if (basis.toLowerCase().includes("minute")) {
    const rounded = Math.round(unit * 10) / 10;
    return `${rounded} min`;
  }
  return `${Math.round(unit)} ×`;
}
