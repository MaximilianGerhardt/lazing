/**
 * /lab PII redaction (MVP, 2026-05-01).
 *
 * Strict defense-in-depth layer for the /lab showcase: before real
 * event payloads are rendered into the UI, every string runs through
 * redactPii(). Workspace labels are filtered against a whitelist
 * — anything not in the whitelist is pseudonymized to "Workspace #N".
 *
 * Note: this does NOT replace the sensitivity filter in the SQL query.
 * Workspaces with sensitivity='high' are already filtered out there.
 * redact runs as a second layer for workspaces with sensitivity!='high'
 * whose payload fields might still contain PII (emails in
 * free text, phone numbers in notes etc.).
 */

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
// Phone: + optional, then at least 8 digits/separators. Restrictive enough so
// that short IDs/years (1-5 digits) are not accidentally matched.
const PHONE_RE = /\+?\d[\d\s().\-]{7,}\d/g;
// IBAN: 2 Letters + 2 Check-Digits + 11-30 alphanumeric.
const IBAN_RE = /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g;
// VAT ID: 2 letters + 8-12 digits (DE123456789, ATU12345678 etc.).
// Does not overlap with IBAN, since IBAN has min. 13 chars after the country code.
const VAT_RE = /\b[A-Z]{2}\d{8,12}\b/g;

export const REDACTED_EMAIL = "[REDACTED-EMAIL]";
export const REDACTED_PHONE = "[REDACTED-PHONE]";
export const REDACTED_IBAN = "[REDACTED-IBAN]";
export const REDACTED_VAT = "[REDACTED-VAT]";

/**
 * Applies all PII regexes to a string. Order: IBAN before VAT
 * (because the IBAN pattern is longer and would otherwise be swallowed by VAT),
 * then email, then phone (the phone regex could otherwise eat parts of
 * IBANs).
 */
export function redactPii(text: string): string {
  if (typeof text !== "string" || text.length === 0) return text;
  return text
    .replace(IBAN_RE, REDACTED_IBAN)
    .replace(VAT_RE, REDACTED_VAT)
    .replace(EMAIL_RE, REDACTED_EMAIL)
    .replace(PHONE_RE, REDACTED_PHONE);
}

/**
 * Workspace-label whitelist. Only these three labels are passed
 * through 1:1; everything else is pseudonymized to "Workspace #N".
 */
export const WORKSPACE_LABEL_WHITELIST: ReadonlySet<string> = new Set([
  "Demo Fitness Fitness",
  "Demo PV",
  "lazyOS",
]);

export function redactWorkspaceLabel(label: string, fallbackIndex: number): string {
  if (WORKSPACE_LABEL_WHITELIST.has(label)) return label;
  return `Workspace #${fallbackIndex}`;
}

/** Truncate ticket title to max 80 characters + ellipsis marker. */
export function truncateTitle(title: string, maxLen = 80): string {
  if (title.length <= maxLen) return title;
  return title.slice(0, maxLen - 1) + "…";
}

/**
 * Redact recursively through an arbitrary JSON payload shape. Strings
 * are pushed through redactPii(), objects/arrays recursively,
 * numbers/booleans/null remain.
 *
 * Special rule: fields with a key in TITLE_LIKE_KEYS are additionally
 * truncated to 80 chars.
 */
const TITLE_LIKE_KEYS: ReadonlySet<string> = new Set([
  "title",
  "ticketTitle",
  "subject",
  "headline",
]);

export function redactPayload(payload: unknown): unknown {
  if (payload === null || payload === undefined) return payload;
  if (typeof payload === "string") return redactPii(payload);
  if (typeof payload === "number" || typeof payload === "boolean") return payload;
  if (Array.isArray(payload)) {
    return payload.map((item) => redactPayload(item));
  }
  if (typeof payload === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
      let v = redactPayload(value);
      if (typeof v === "string" && TITLE_LIKE_KEYS.has(key)) {
        v = truncateTitle(v);
      }
      result[key] = v;
    }
    return result;
  }
  return payload;
}
