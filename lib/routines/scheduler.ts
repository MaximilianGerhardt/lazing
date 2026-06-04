/**
 * Cron-Expression-Parser + next-run Berechnung.
 *
 * Standard 5-Feld-Cron (minute hour day-of-month month day-of-week).
 * Unterstützte Ausdrücke pro Feld:
 *   - `*`                : jeder Wert
 *   - `N`                : exakt N (int)
 *   - `A,B,C`            : Liste
 *   - `A-B`              : Range (inklusive)
 *   - `* /N` oder `A-B/N`: Step (every N)
 *
 * Nicht unterstützt:
 *   - `@hourly`, `@daily`, `@reboot` etc. (bewusst weggelassen — YAGNI)
 *   - Weekday-Names (`MON`, `TUE` …)
 *
 * Zeitzone: intern UTC. the owner's Brief-Routine läuft `0 8 * * *` in UTC, was
 * Berlin-Sommer (UTC+2) = 10:00 entspricht. Phase 6 kann pro Routine eine
 * TZ-Override einführen; für Single-User-MVP reicht UTC.
 *
 * Referenz: https://en.wikipedia.org/wiki/Cron#CRON_expression
 */

interface FieldSpec {
  min: number;
  max: number;
}

const FIELDS: readonly FieldSpec[] = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day-of-month
  { min: 1, max: 12 }, // month
  { min: 0, max: 6 }, // day-of-week (0=Sun)
];

export interface ParsedCron {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  /** True wenn day-of-month UND day-of-week jeweils `*` — Standard-Fall. */
  domStar: boolean;
  dowStar: boolean;
}

export class CronParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CronParseError";
  }
}

/**
 * Parst ein Cron-Feld in ein Set zulässiger Werte.
 */
function parseField(input: string, spec: FieldSpec): Set<number> {
  const result = new Set<number>();
  const parts = input.split(",");
  for (const part of parts) {
    const stepMatch = part.match(/^(.*)\/(\d+)$/);
    let range = part;
    let step = 1;
    if (stepMatch) {
      range = stepMatch[1];
      step = parseInt(stepMatch[2], 10);
      if (!Number.isInteger(step) || step <= 0) {
        throw new CronParseError(`invalid step in "${part}"`);
      }
    }

    let start: number;
    let end: number;
    if (range === "*") {
      start = spec.min;
      end = spec.max;
    } else if (range.includes("-")) {
      const [a, b] = range.split("-");
      start = parseInt(a, 10);
      end = parseInt(b, 10);
      if (!Number.isInteger(start) || !Number.isInteger(end)) {
        throw new CronParseError(`invalid range "${range}"`);
      }
    } else {
      const n = parseInt(range, 10);
      if (!Number.isInteger(n)) {
        throw new CronParseError(`invalid value "${range}"`);
      }
      start = end = n;
    }

    if (start < spec.min || end > spec.max || start > end) {
      throw new CronParseError(
        `out-of-range "${part}" (allowed ${spec.min}-${spec.max})`,
      );
    }
    for (let v = start; v <= end; v += step) {
      result.add(v);
    }
  }
  return result;
}

export function parseCron(expr: string): ParsedCron {
  const trimmed = expr.trim();
  const tokens = trimmed.split(/\s+/);
  if (tokens.length !== 5) {
    throw new CronParseError(
      `cron expression must have 5 fields, got ${tokens.length} ("${expr}")`,
    );
  }

  return {
    minute: parseField(tokens[0], FIELDS[0]),
    hour: parseField(tokens[1], FIELDS[1]),
    dom: parseField(tokens[2], FIELDS[2]),
    month: parseField(tokens[3], FIELDS[3]),
    dow: parseField(tokens[4], FIELDS[4]),
    domStar: tokens[2] === "*",
    dowStar: tokens[4] === "*",
  };
}

/**
 * Validate-only helper — für API-Layer damit 400er mit nützlicher Message
 * zurück kommen statt 500.
 */
export function isValidCron(expr: string): { ok: true } | { ok: false; error: string } {
  try {
    parseCron(expr);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Berechnet den nächsten Match ab `fromMs` (exklusive — nie derselbe
 * Moment). Gibt ms-Epoch zurück oder `null` falls in den nächsten 4 Jahren
 * kein Match (= offensichtlich falscher Ausdruck).
 *
 * Algorithmus: minute-weise vorspulen bis alle Felder passen. 4-Jahres-
 * Ceiling verhindert Endlosschleifen (z.B. `0 0 31 2 *` — 31. Februar).
 */
export function nextRunAt(expr: string, fromMs: number): number | null {
  const parsed = parseCron(expr);
  const MAX_ITERATIONS = 60 * 24 * 366 * 4; // 4 Jahre in Minuten

  // Starte bei fromMs + 1 Minute, sekundengenau auf Minuten-Boundary.
  let cursor = new Date(fromMs);
  cursor.setUTCSeconds(0, 0);
  cursor = new Date(cursor.getTime() + 60_000);

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const min = cursor.getUTCMinutes();
    const hr = cursor.getUTCHours();
    const dom = cursor.getUTCDate();
    const mon = cursor.getUTCMonth() + 1; // 1-12
    const dow = cursor.getUTCDay(); // 0-6

    if (!parsed.minute.has(min)) {
      cursor = new Date(cursor.getTime() + 60_000);
      continue;
    }
    if (!parsed.hour.has(hr)) {
      // Springe auf nächste Stunde bei Minute 0.
      cursor = new Date(cursor.getTime() + (60 - min) * 60_000);
      continue;
    }
    if (!parsed.month.has(mon)) {
      // Springe auf nächsten Monat, Tag 1 00:00.
      const next = new Date(
        Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1),
      );
      cursor = next;
      continue;
    }

    // Cron-Quirk: wenn BEIDE dom und dow gesetzt sind (nicht `*`),
    // matcht ENTWEDER dom ODER dow (OR-Semantik). Sonst AND.
    const domMatch = parsed.dom.has(dom);
    const dowMatch = parsed.dow.has(dow);
    let dayOk: boolean;
    if (parsed.domStar && parsed.dowStar) {
      dayOk = true;
    } else if (parsed.domStar) {
      dayOk = dowMatch;
    } else if (parsed.dowStar) {
      dayOk = domMatch;
    } else {
      dayOk = domMatch || dowMatch;
    }

    if (!dayOk) {
      // Springe auf nächsten Tag 00:00.
      const nextDay = new Date(
        Date.UTC(
          cursor.getUTCFullYear(),
          cursor.getUTCMonth(),
          cursor.getUTCDate() + 1,
        ),
      );
      cursor = nextDay;
      continue;
    }

    return cursor.getTime();
  }

  return null;
}
