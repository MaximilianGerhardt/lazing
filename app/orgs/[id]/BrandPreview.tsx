'use client';

/**
 * Live preview of brand-colors:
 *  - Mock TopBar (colors[0] BG, colors[1] accent pill)
 *  - Mock Button (colors[0] BG, colors[1] border)
 *  - Mock Surface-Card-Header (colors[0])
 * Sub-Plan D.
 */

import type { CSSProperties } from "react";

import { isValidHex, parseHex } from "@/lib/util/color";

interface BrandPreviewProps {
  colors: string[];
}

const FALLBACK_BG = "#070707";
const FALLBACK_ACCENT = "#3b82f6";

/** Decide whether to use light or dark ink against a hex BG (relative luminance). */
function inkOn(hex: string): string {
  const rgb = parseHex(hex);
  if (!rgb) return "#ffffff";
  // Rec. 709 luma
  const lum = (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255;
  return lum > 0.55 ? "#0a0a0a" : "#ffffff";
}

export function BrandPreview({ colors }: BrandPreviewProps): React.JSX.Element {
  const valid = colors.filter(isValidHex);
  const c0 = valid[0] ?? FALLBACK_BG;
  const c1 = valid[1] ?? c0;
  const ink0 = inkOn(c0);
  const ink1 = inkOn(c1);

  return (
    <div style={wrapStyle} aria-label="Brand-Vorschau">
      <div style={captionStyle}>Vorschau</div>

      {/* Mock TopBar */}
      <div style={{ ...topbarStyle, background: c0, color: ink0 }}>
        <span style={{ ...logoStyle, color: ink0 }}>lazyOS</span>
        <span
          style={{
            ...accentPillStyle,
            background: c1,
            color: ink1,
            borderColor: c1 === c0 ? "transparent" : c1,
          }}
        >
          beta
        </span>
      </div>

      {/* Mock Surface-Card */}
      <div style={cardWrapStyle}>
        <div style={{ ...cardHeaderStyle, background: c0, color: ink0 }}>
          Card-Header
        </div>
        <div style={cardBodyStyle}>
          <p style={cardBodyTextStyle}>
            So sehen Buttons und Akzente in deinen Surfaces aus.
          </p>
          <button
            type="button"
            style={{
              ...mockBtnStyle,
              background: c0,
              color: ink0,
              borderColor: c1 === c0 ? c0 : c1,
            }}
            disabled
          >
            Primary Action
          </button>
        </div>
      </div>

      {/* Swatch strip */}
      {valid.length > 0 ? (
        <div style={swatchStripStyle}>
          {valid.map((hex, i) => (
            <div
              key={i}
              title={hex}
              style={{
                ...swatchStyle,
                background: hex,
                color: inkOn(hex),
              }}
            >
              {i + 1}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

const wrapStyle: CSSProperties = {
  marginTop: 16,
  border: "0.5px solid var(--line-2)",
  borderRadius: 12,
  overflow: "hidden",
  background: "var(--sheet-1)",
};

const captionStyle: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--ink-3)",
  padding: "8px 12px",
  borderBottom: "0.5px solid var(--line-2)",
};

const topbarStyle: CSSProperties = {
  height: 56,
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "0 16px",
  transition: "background 120ms ease, color 120ms ease",
};

const logoStyle: CSSProperties = {
  fontFamily: "var(--font-mono, ui-monospace, monospace)",
  fontSize: 14,
  fontWeight: 600,
  letterSpacing: "0.02em",
};

const accentPillStyle: CSSProperties = {
  fontSize: 10,
  fontFamily: "var(--font-mono, ui-monospace, monospace)",
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  padding: "4px 10px",
  borderRadius: 999,
  border: "0.5px solid",
  transition: "background 120ms ease, color 120ms ease",
};

const cardWrapStyle: CSSProperties = {
  margin: 12,
  border: "0.5px solid var(--line-2)",
  borderRadius: 10,
  overflow: "hidden",
};

const cardHeaderStyle: CSSProperties = {
  padding: "10px 14px",
  fontFamily: "var(--font-mono, ui-monospace, monospace)",
  fontSize: 11,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  transition: "background 120ms ease, color 120ms ease",
};

const cardBodyStyle: CSSProperties = {
  padding: "12px 14px",
  background: "var(--sheet)",
  display: "flex",
  flexDirection: "column",
  gap: 10,
};

const cardBodyTextStyle: CSSProperties = {
  margin: 0,
  fontSize: 13,
  color: "var(--ink-2)",
};

const mockBtnStyle: CSSProperties = {
  alignSelf: "flex-start",
  padding: "8px 16px",
  borderRadius: 8,
  border: "1px solid",
  fontSize: 13,
  fontWeight: 500,
  cursor: "default",
  transition: "background 120ms ease, color 120ms ease, border-color 120ms ease",
};

const swatchStripStyle: CSSProperties = {
  display: "flex",
  gap: 4,
  padding: "0 12px 12px",
};

const swatchStyle: CSSProperties = {
  flex: 1,
  height: 28,
  borderRadius: 6,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 10,
  fontFamily: "var(--font-mono, ui-monospace, monospace)",
  border: "0.5px solid var(--line-2)",
};
