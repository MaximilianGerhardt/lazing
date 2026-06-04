/**
 * lib/privacy/pii-detectors.ts — deterministic PII entity detectors (N6).
 *
 * Pure regex + validators, no I/O, no LLM. The deterministic floor of the local
 * PII vault: structured identifiers (email / IBAN / card / phone / IP) are caught
 * here before any text can reach an external LLM. Named entities (person / org /
 * location) that a regex cannot catch are an OPTIONAL local-LLM layer
 * (pii-ner-ollama.ts) — additive, never required.
 */

export type PiiType =
  | "EMAIL"
  | "IBAN"
  | "CARD"
  | "PHONE"
  | "IP"
  | "PERSON"
  | "ORG"
  | "LOCATION";

export interface PiiSpan {
  type: PiiType;
  /** inclusive start offset in the source text */
  start: number;
  /** exclusive end offset */
  end: number;
  value: string;
}

/** Luhn check — rejects random digit runs that aren't real card numbers. */
function luhnValid(raw: string): boolean {
  const d = raw.replace(/\D/g, "");
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = d.length - 1; i >= 0; i -= 1) {
    let n = d.charCodeAt(i) - 48;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

function ibanPlausible(v: string): boolean {
  const s = v.replace(/\s/g, "");
  return s.length >= 15 && s.length <= 34 && /^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(s);
}

/** Conservative phone check — needs a real separator/prefix to avoid eating plain numbers. */
function phonePlausible(v: string): boolean {
  const digits = v.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return false;
  return /[+()]/.test(v) || /\d[\s-]\d/.test(v);
}

interface Rule {
  type: PiiType;
  re: RegExp;
  valid?: (v: string) => boolean;
}

// Order matters only for tie-breaking in mergeSpans (earlier wins on equal start).
const RULES: Rule[] = [
  { type: "EMAIL", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { type: "IBAN", re: /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{2,4}){2,8}\b/g, valid: ibanPlausible },
  { type: "CARD", re: /\b(?:\d[ -]?){13,19}\b/g, valid: luhnValid },
  { type: "IP", re: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g },
  {
    type: "PHONE",
    re: /(?:\+\d{1,3}[\s-]?)?(?:\(\d{1,4}\)[\s-]?)?\d{2,4}(?:[\s-]\d{2,4}){1,5}/g,
    valid: phonePlausible,
  },
];

/** Run all deterministic detectors and return non-overlapping spans. */
export function detectDeterministic(text: string): PiiSpan[] {
  const spans: PiiSpan[] = [];
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.re.exec(text)) !== null) {
      const value = m[0];
      if (value.length === 0) {
        rule.re.lastIndex += 1;
        continue;
      }
      if (rule.valid && !rule.valid(value)) continue;
      spans.push({ type: rule.type, start: m.index, end: m.index + value.length, value });
    }
  }
  return mergeSpans(spans);
}

/**
 * Resolve overlaps deterministically: sort by start, then prefer the longer span;
 * keep only non-overlapping spans (drop anything that starts before the previous
 * span ended). Stable + order-independent.
 */
export function mergeSpans(spans: PiiSpan[]): PiiSpan[] {
  const sorted = [...spans].sort(
    (a, b) => a.start - b.start || b.end - b.start - (a.end - a.start),
  );
  const out: PiiSpan[] = [];
  let lastEnd = -1;
  for (const s of sorted) {
    if (s.start >= lastEnd) {
      out.push(s);
      lastEnd = s.end;
    }
  }
  return out;
}
