'use client';

/**
 * Single-Color picker row: native <input type="color">, hex text input,
 * optional rgb(...) text input, optional remove-button. Sub-Plan D.
 *
 * - Bidirectional sync: color-wheel <-> hex <-> rgb()
 * - Mobile-first: touch-targets >= 44px, no autocapitalize on hex.
 * - On iOS PWA, native color-picker opens as a system sheet.
 */

import { useEffect, useState, type CSSProperties } from "react";

import {
  formatHex,
  formatRgb,
  isValidHex,
  parseHex,
  parseRgb,
} from "@/lib/util/color";

interface ColorPickerFieldProps {
  value: string;
  onChange: (hex: string) => void;
  onRemove?: () => void;
  disabled?: boolean;
  showRgb?: boolean;
}

export function ColorPickerField({
  value,
  onChange,
  onRemove,
  disabled,
  showRgb = true,
}: ColorPickerFieldProps): React.JSX.Element {
  const safeHex = isValidHex(value) ? value.toLowerCase() : "#070707";

  const [hexDraft, setHexDraft] = useState(safeHex);
  const [rgbDraft, setRgbDraft] = useState(() =>
    formatRgb(parseHex(safeHex) ?? { r: 7, g: 7, b: 7 }),
  );

  // Keep drafts in sync when the parent overwrites `value` (e.g. reorder/remove).
  useEffect(() => {
    if (isValidHex(value) && value.toLowerCase() !== hexDraft.toLowerCase()) {
      setHexDraft(value.toLowerCase());
      const rgb = parseHex(value);
      if (rgb) setRgbDraft(formatRgb(rgb));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const commit = (hex: string): void => {
    const lower = hex.toLowerCase();
    setHexDraft(lower);
    const rgb = parseHex(lower);
    if (rgb) setRgbDraft(formatRgb(rgb));
    onChange(lower);
  };

  const onWheel = (e: React.ChangeEvent<HTMLInputElement>): void => {
    commit(e.target.value);
  };

  const onHexInput = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const raw = e.target.value.trim();
    setHexDraft(raw);
    if (isValidHex(raw)) {
      commit(raw);
    }
  };

  const onHexBlur = (): void => {
    if (!isValidHex(hexDraft)) {
      // revert to last valid value
      setHexDraft(safeHex);
      const rgb = parseHex(safeHex);
      if (rgb) setRgbDraft(formatRgb(rgb));
    }
  };

  const onRgbInput = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const raw = e.target.value;
    setRgbDraft(raw);
    const rgb = parseRgb(raw);
    if (rgb) {
      const hex = formatHex(rgb);
      setHexDraft(hex);
      onChange(hex);
    }
  };

  const onRgbBlur = (): void => {
    const rgb = parseRgb(rgbDraft);
    if (!rgb) {
      const fallback = parseHex(hexDraft) ?? { r: 7, g: 7, b: 7 };
      setRgbDraft(formatRgb(fallback));
    }
  };

  return (
    <div style={rowStyle}>
      <input
        type="color"
        aria-label="Farbe wählen"
        value={isValidHex(hexDraft) ? hexDraft : safeHex}
        onChange={onWheel}
        disabled={disabled}
        style={wheelStyle}
      />
      <input
        type="text"
        inputMode="text"
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        spellCheck={false}
        aria-label="Hex-Wert"
        value={hexDraft}
        onChange={onHexInput}
        onBlur={onHexBlur}
        disabled={disabled}
        placeholder="#070707"
        pattern="^#[0-9a-fA-F]{6}$"
        style={{ ...textInputStyle, width: 110 }}
      />
      {showRgb ? (
        <input
          type="text"
          inputMode="text"
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          aria-label="RGB-Wert"
          value={rgbDraft}
          onChange={onRgbInput}
          onBlur={onRgbBlur}
          disabled={disabled}
          placeholder="rgb(7, 7, 7)"
          style={{ ...textInputStyle, flex: 1, minWidth: 0 }}
        />
      ) : null}
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          disabled={disabled}
          aria-label="Farbe entfernen"
          style={removeBtnStyle}
        >
          ×
        </button>
      ) : null}
    </div>
  );
}

const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  marginBottom: 8,
  flexWrap: "wrap",
};

const wheelStyle: CSSProperties = {
  width: 44,
  height: 44,
  minWidth: 44,
  minHeight: 44,
  padding: 0,
  border: "0.5px solid var(--line-2)",
  borderRadius: 8,
  background: "transparent",
  cursor: "pointer",
};

const textInputStyle: CSSProperties = {
  padding: "10px 12px",
  fontSize: 14,
  borderRadius: 8,
  border: "0.5px solid var(--line-2)",
  background: "var(--sheet-1)",
  color: "var(--ink)",
  fontFamily: "var(--font-mono, inherit)",
  boxSizing: "border-box",
  minHeight: 44,
};

const removeBtnStyle: CSSProperties = {
  width: 44,
  height: 44,
  minWidth: 44,
  minHeight: 44,
  borderRadius: 8,
  border: "0.5px solid var(--line-2)",
  background: "transparent",
  color: "var(--ink-2)",
  fontSize: 20,
  lineHeight: 1,
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};
