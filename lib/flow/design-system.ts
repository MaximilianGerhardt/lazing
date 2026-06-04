/**
 * lib/flow/design-system.ts
 * --------------------------
 * W2.1 — binding Apple-grade design system for the website flow
 * (2026-05-30, Opus 4.8 · plan eager-orbiting-avalanche.md).
 *
 * WHY (Jobs/Rams · "constraint = quality"):
 *   Until now EVERY coder step invented its own design → incoherent fragments,
 *   never a cohesive Apple-grade page. Instead of free design there is
 *   now ONE fixed, binding token+section set. The design step only chooses
 *   the accent/voice WITHIN this system; every following coder/copy step
 *   builds AGAINST this system (forward-chained via stepOutputs → buildStepPrompt).
 *
 * SINGLE SOURCE (no new hex):
 *   The color tokens are mirrored 1:1 from `app/globals.css :root` — the laz.ing
 *   design-manifest canon (pitch-black canvas, SF Pro, accent family). NO
 *   new hex values are introduced here (CLAUDE.md: globals.css is the only
 *   place for hex). If globals.css changes, this mirror MUST be updated
 *   (deliberately mirrored manually, because the website is a standalone static
 *   artefact without Tailwind/build).
 *
 * N1: no .slice/.substring on any field. N6: purely deterministic,
 *   no I/O, no LLM.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A named section with its binding layout contract. */
export interface SectionContract {
  /** Stable section key (order = vertical arrangement). */
  readonly key: "hero" | "features" | "proof" | "cta" | "footer";
  /** Human-readable name (for the prompt). */
  readonly name: string;
  /** Binding layout contract — HOW the section MUST be built. */
  readonly layout: string;
  /** The content fields the copy step MUST fill in site.config.json. */
  readonly contentFields: readonly string[];
}

/** The complete, binding website design system. */
export interface WebsiteDesignSystem {
  /** Spacing scale in px (4-based) — the ONLY allowed spacings. */
  readonly spacing: readonly number[];
  /** Type scale: role name → {px, weight, letterSpacing, lineHeight}. */
  readonly typeScale: Readonly<
    Record<string, { px: number; weight: number; letterSpacing: string; lineHeight: number }>
  >;
  /** Font stacks (SF Pro Display/Text/Mono — from globals.css). */
  readonly fonts: { display: string; sans: string; mono: string };
  /** Color tokens (mirrored from globals.css :root — NO new hex). */
  readonly colors: Readonly<Record<string, string>>;
  /** Accent family (segment accents from globals.css) — the design step chooses ONE. */
  readonly accents: Readonly<Record<string, string>>;
  /** Radius scale in px. */
  readonly radius: Readonly<Record<string, number>>;
  /** Shadow tokens (binding, no free box-shadow). */
  readonly shadows: Readonly<Record<string, string>>;
  /** Fixed section catalog with layout contracts (order = arrangement). */
  readonly sections: readonly SectionContract[];
}

// ---------------------------------------------------------------------------
// The binding system (constant)
// ---------------------------------------------------------------------------

/**
 * WEBSITE_DESIGN_SYSTEM — the one fixed, binding set.
 *
 * Spacing 4/8/12/16/24/32/48/64 · type scale SF Pro Display (-0.01em) ·
 * color tokens 1:1 from globals.css :root · radius/shadow · 5 sections with
 * a layout contract. Frozen (Object.freeze at every level) so no step can
 * mutate the system.
 */
export const WEBSITE_DESIGN_SYSTEM: WebsiteDesignSystem = Object.freeze({
  spacing: Object.freeze([4, 8, 12, 16, 24, 32, 48, 64]),

  typeScale: Object.freeze({
    // SF Pro Display, optically tight tracking (-0.01em) — Apple-grade.
    // Apple pass (2026-05-30): display/h1 on semibold (600) — Apple uses
    // semibold display, not bold (700) even in the marketing context (A3).
    display: { px: 56, weight: 600, letterSpacing: "-0.02em", lineHeight: 1.05 },
    h1: { px: 40, weight: 600, letterSpacing: "-0.02em", lineHeight: 1.1 },
    h2: { px: 28, weight: 600, letterSpacing: "-0.01em", lineHeight: 1.2 },
    h3: { px: 20, weight: 600, letterSpacing: "-0.01em", lineHeight: 1.3 },
    body: { px: 17, weight: 400, letterSpacing: "-0.01em", lineHeight: 1.55 },
    caption: { px: 13, weight: 500, letterSpacing: "0.02em", lineHeight: 1.4 },
    eyebrow: { px: 12, weight: 600, letterSpacing: "0.12em", lineHeight: 1.4 },
  }),

  // From globals.css :82-84 (verbatim).
  fonts: Object.freeze({
    display:
      '-apple-system, BlinkMacSystemFont, "SF Pro Display", system-ui, sans-serif',
    sans: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif',
    mono: '"SF Mono", ui-monospace, Menlo, Consolas, monospace',
  }),

  // Mirrored from globals.css :root (:15-49). NO new hex.
  colors: Object.freeze({
    sheet: "#070707",
    "sheet-1": "#0A0A0B",
    "sheet-2": "#0E0E0F",
    "sheet-3": "#141416",
    ink: "#F5F5F7",
    "ink-2": "#A1A1A6",
    "ink-3": "#636366",
    "ink-4": "#3A3A3C",
    line: "rgba(255, 255, 255, 0.06)",
    "line-2": "rgba(255, 255, 255, 0.12)",
    primary: "#FAFAFA",
    danger: "#FF453A",
    warn: "#FFD60A",
  }),

  // Segment accents from globals.css (:42-45). The design step chooses EXACTLY ONE.
  accents: Object.freeze({
    north: "#FF9F0A",
    clientb: "#30D158",
    own: "#BF5AF2",
    private: "#64D2FF",
  }),

  radius: Object.freeze({ sm: 8, md: 12, lg: 16, xl: 24, pill: 999 }),

  shadows: Object.freeze({
    // Depth shadows on pitch-black — subtle, no "Material" drop.
    card: "0 1px 0 rgba(255,255,255,0.04) inset, 0 8px 32px rgba(0,0,0,0.5)",
    glow: "0 0 0 1px rgba(255,255,255,0.06), 0 24px 64px rgba(0,0,0,0.6)",
  }),

  sections: Object.freeze<readonly SectionContract[]>([
    {
      key: "hero",
      name: "Hero",
      layout:
        "Vollbreite, vertikal zentriert. Höhe inhaltsgetrieben: min-height " +
        "clamp(520px, 72vh, 760px) (NICHT 88vh/100vh — sonst klafft auf großen " +
        "Viewports ein totes Loch zwischen Hero und erster Sektion), padding-block " +
        "min 64. Eyebrow (uppercase, letter-spacing 0.12em, accent-Farbe) → " +
        "display-Headline (max 2 Zeilen) → body-Subline (max 60ch, ink-2) → EIN " +
        "primärer CTA-Button (accent-Hintergrund, sheet-Text, radius pill, padding " +
        "16/32). Hintergrund: sheet mit EINEM radialen accent-Glow (radial-gradient, " +
        "12% Opazität) oben-mitte. Kein Stock-Foto — Platzhalter = CSS-Gradient.",
      contentFields: ["eyebrow", "headline", "subline", "ctaLabel", "ctaHref"],
    },
    {
      key: "features",
      name: "Features",
      layout:
        "3-Spalten-Grid (auf <768px 1-spaltig), gap 24. Pro Karte: sheet-1-Hintergrund, " +
        "radius lg, padding 32, border 0.5px line-2. Karte = h3-Titel + body-Text (ink-2). " +
        "Sektion oben: eyebrow + h2-Sektionstitel, margin-bottom 48.",
      contentFields: ["sectionTitle", "features[]"],
    },
    {
      key: "proof",
      name: "Proof / Social Proof",
      layout:
        "Zentriertes Zitat: h2-großes Statement (max 40ch) + caption-Attribution " +
        "(ink-3). Hintergrund sheet-2, padding-block 64. Kein Logo-Salat — EIN starkes " +
        "Statement.",
      contentFields: ["quote", "attribution"],
    },
    {
      key: "cta",
      name: "Call-to-Action",
      layout:
        "Vollbreiter, zentrierter Schluss-Block. h1-Headline + body-Subline + EIN " +
        "primärer accent-Button (identisch zur Hero-CTA). Hintergrund: sheet mit dezentem " +
        "accent-Glow. padding-block 64.",
      contentFields: ["headline", "subline", "ctaLabel", "ctaHref"],
    },
    {
      key: "footer",
      name: "Footer",
      layout:
        "Schlichte Zeile: ink-3-Text, caption-Größe, zentriert. Brand-Name + © Jahr. " +
        "border-top 0.5px line. padding-block 32.",
      contentFields: ["brand", "year"],
    },
  ]),
});

// ---------------------------------------------------------------------------
// Prompt rendering — the system as a binding prompt block
// ---------------------------------------------------------------------------

/**
 * Renders the binding design system as a compact, binding
 * prompt block. Prepended in `buildStepPrompt` (W2.1 forward chaining) to EVERY
 * design/copy/coder/assembly step: "You build against THIS
 * binding system."
 *
 * @param chosenAccent optional: the accent key chosen by the design step
 *                     (e.g. 'own'). Without a choice the whole accent family
 *                     is named + 'own' marked as the default.
 */
export function renderDesignSystemPrompt(chosenAccent?: string): string {
  const ds = WEBSITE_DESIGN_SYSTEM;
  const accentKey =
    chosenAccent && Object.prototype.hasOwnProperty.call(ds.accents, chosenAccent)
      ? chosenAccent
      : "own";
  const accentHex = ds.accents[accentKey];

  const colorLines = Object.entries(ds.colors)
    .map(([k, v]) => `    --${k}: ${v};`)
    .join("\n");
  const typeLines = Object.entries(ds.typeScale)
    .map(
      ([role, t]) =>
        `    ${role}: ${t.px}px / weight ${t.weight} / tracking ${t.letterSpacing} / line-height ${t.lineHeight}`,
    )
    .join("\n");
  const sectionLines = ds.sections
    .map(
      (s, i) =>
        `  ${i + 1}. [${s.key}] ${s.name}\n     Layout-Contract: ${s.layout}\n     Inhalts-Felder: ${s.contentFields.join(", ")}`,
    )
    .join("\n");

  return [
    `── VERBINDLICHES DESIGN-SYSTEM (Apple-grade · laz.ing Manifest) ──`,
    `Du baust GEGEN dieses verbindliche System. Nutze AUSSCHLIESSLICH diese`,
    `Tokens, diese Type-Scale, diese Spacing-Werte und diese Sektions-Contracts.`,
    `Erfinde KEINE eigenen Farben, Abstände oder Sektionen.`,
    ``,
    `Spacing-Scale (px, NUR diese): ${ds.spacing.join(", ")}`,
    ``,
    `Font-Stacks:`,
    `    --font-display: ${ds.fonts.display};`,
    `    --font-sans: ${ds.fonts.sans};`,
    `    --font-mono: ${ds.fonts.mono};`,
    ``,
    `Type-Scale (SF Pro Display, enges Tracking):`,
    typeLines,
    ``,
    `Farb-Tokens (CSS-Custom-Properties — NUR diese, kein neuer Hex):`,
    colorLines,
    ``,
    `Akzent-Familie (genau EINER gilt für diese Seite):`,
    Object.entries(ds.accents)
      .map(([k, v]) => `    --accent-${k}: ${v}${k === accentKey ? "   ← GEWÄHLT" : ""}`)
      .join("\n"),
    `Aktiver Akzent: --accent: ${accentHex}  (Schlüssel: ${accentKey})`,
    ``,
    `Radius (px): ${Object.entries(ds.radius).map(([k, v]) => `${k}=${v}`).join(", ")}`,
    `Shadows:`,
    Object.entries(ds.shadows).map(([k, v]) => `    --shadow-${k}: ${v};`).join("\n"),
    ``,
    `Verbindlicher Sektions-Katalog (in dieser Reihenfolge, vertikal gestapelt):`,
    sectionLines,
    `── ENDE DESIGN-SYSTEM ──`,
  ].join("\n");
}

/**
 * Extracts the accent key chosen by the design step from its
 * output text. The design step is instructed to name its choice as
 * `accent: <key>` OR `--accent: <key>`. Fallback: 'own' (laz.ing
 * default accent). Purely deterministic (N6), no I/O.
 */
export function parseChosenAccent(designStepOutput: string | undefined): string {
  if (typeof designStepOutput !== "string" || designStepOutput.length === 0) {
    return "own";
  }
  const keys = Object.keys(WEBSITE_DESIGN_SYSTEM.accents);
  // Search for 'accent: <key>' or '--accent-<key>' or simply the key.
  const m = designStepOutput
    .toLowerCase()
    .match(/accent[-:\s]+["']?([a-z]+)["']?/);
  if (m && keys.includes(m[1])) return m[1];
  // Secondary: a bare mentioned key (e.g. "nutze own als Akzent").
  for (const k of keys) {
    if (new RegExp(`\\b${k}\\b`, "i").test(designStepOutput)) return k;
  }
  return "own";
}
