/**
 * /lab PII-Redaction (MVP, 2026-05-01).
 *
 * Strikte Defense-in-Depth-Schicht für /lab-Showcase: bevor echte
 * Event-Payloads ins UI gerendert werden, läuft jeder String durch
 * redactPii(). Workspace-Labels werden gegen eine Whitelist gefiltert
 * — alles was nicht in der Whitelist steht wird zu „Workspace #N"
 * pseudonymisiert.
 *
 * Hinweis: das ersetzt NICHT den Sensitivity-Filter im SQL-Query.
 * Workspaces mit sensitivity='high' werden bereits dort ausgefiltert.
 * redact läuft als zweite Schicht für Workspaces mit sensitivity!='high'
 * deren Payload-Felder trotzdem PII enthalten könnten (E-Mails in
 * Free-Text, Telefonnummern in Notes etc.).
 */

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
// Phone: + optional, dann mind. 8 Digits/Trenner. Restriktiv genug damit
// kurze IDs/Years (1-5 Digits) nicht versehentlich getroffen werden.
const PHONE_RE = /\+?\d[\d\s().\-]{7,}\d/g;
// IBAN: 2 Letters + 2 Check-Digits + 11-30 alphanumeric.
const IBAN_RE = /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g;
// USt-ID: 2 Letters + 8-12 Digits (DE123456789, ATU12345678 etc.).
// Kommt VOR IBAN nicht greifen, da IBAN min. 13 chars nach Country-Code hat.
const VAT_RE = /\b[A-Z]{2}\d{8,12}\b/g;

export const REDACTED_EMAIL = "[REDACTED-EMAIL]";
export const REDACTED_PHONE = "[REDACTED-PHONE]";
export const REDACTED_IBAN = "[REDACTED-IBAN]";
export const REDACTED_VAT = "[REDACTED-VAT]";

/**
 * Wendet alle PII-Regex auf einen String an. Reihenfolge: IBAN vor VAT
 * (weil IBAN-Pattern länger ist und sonst von VAT geschluckt würde),
 * dann E-Mail, dann Phone (Phone-Regex könnte sonst Teile von IBANs
 * fressen).
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
 * Workspace-Label-Whitelist. Nur diese drei Labels werden 1:1
 * durchgelassen; alles andere wird auf „Workspace #N" pseudonymisiert.
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

/** Truncate Ticket-Title auf max 80 Zeichen + Ellipsis-Marker. */
export function truncateTitle(title: string, maxLen = 80): string {
  if (title.length <= maxLen) return title;
  return title.slice(0, maxLen - 1) + "…";
}

/**
 * Redact recursively durch ein beliebiges JSON-payload-shape. Strings
 * werden durch redactPii() geschoben, Objects/Arrays rekursiv,
 * Numbers/Booleans/null bleiben.
 *
 * Spezialregel: Felder mit Key in TITLE_LIKE_KEYS werden zusätzlich
 * auf 80 chars truncated.
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
