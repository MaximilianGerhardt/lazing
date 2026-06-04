/**
 * Color helpers for Brand-Picker (Sub-Plan D).
 * Pure functions — no DOM, no React. Easy to unit-test.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

const HEX6_RE = /^#[0-9a-fA-F]{6}$/;
const HEX3_RE = /^#[0-9a-fA-F]{3}$/;

export function isValidHex(s: string): boolean {
  return HEX6_RE.test(s.trim());
}

function clamp255(n: number): number {
  if (Number.isNaN(n)) return 0;
  if (n < 0) return 0;
  if (n > 255) return 255;
  return Math.round(n);
}

export function parseHex(s: string): Rgb | null {
  const v = s.trim();
  if (HEX6_RE.test(v)) {
    return {
      r: parseInt(v.slice(1, 3), 16),
      g: parseInt(v.slice(3, 5), 16),
      b: parseInt(v.slice(5, 7), 16),
    };
  }
  if (HEX3_RE.test(v)) {
    return {
      r: parseInt(v[1] + v[1], 16),
      g: parseInt(v[2] + v[2], 16),
      b: parseInt(v[3] + v[3], 16),
    };
  }
  return null;
}

export function formatHex(rgb: Rgb): string {
  const r = clamp255(rgb.r).toString(16).padStart(2, "0");
  const g = clamp255(rgb.g).toString(16).padStart(2, "0");
  const b = clamp255(rgb.b).toString(16).padStart(2, "0");
  return `#${r}${g}${b}`;
}

const RGB_FN_RE =
  /^rgba?\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})(?:\s*[,/ ]\s*[\d.]+%?)?\s*\)$/i;

export function parseRgb(s: string): Rgb | null {
  const v = s.trim();
  const m = RGB_FN_RE.exec(v);
  if (!m) return null;
  const r = clamp255(parseInt(m[1], 10));
  const g = clamp255(parseInt(m[2], 10));
  const b = clamp255(parseInt(m[3], 10));
  return { r, g, b };
}

/** Convenience: format Rgb as `rgb(r, g, b)`. */
export function formatRgb(rgb: Rgb): string {
  return `rgb(${clamp255(rgb.r)}, ${clamp255(rgb.g)}, ${clamp255(rgb.b)})`;
}

/** Normalize any incoming string to lowercase #rrggbb if possible, otherwise null. */
export function normalizeColor(s: string): string | null {
  const rgb = parseHex(s) ?? parseRgb(s);
  return rgb ? formatHex(rgb) : null;
}
