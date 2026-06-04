/**
 * Cron-expression parser + next-run computation.
 *
 * Standard 5-field cron (minute hour day-of-month month day-of-week).
 * Supported expressions per field:
 *   - `*`                : any value
 *   - `N`                : exactly N (int)
 *   - `A,B,C`            : list
 *   - `A-B`              : range (inclusive)
 *   - `* /N` or `A-B/N`  : step (every N)
 *
 * Not supported:
 *   - `@hourly`, `@daily`, `@reboot` etc. (deliberately omitted — YAGNI)
 *   - weekday names (`MON`, `TUE` …)
 *
 * Timezone: internally UTC. The owner's brief routine runs `0 8 * * *` in UTC, which
 * corresponds to Berlin summer (UTC+2) = 10:00. Phase 6 can introduce a
 * per-routine TZ override; for the single-user MVP, UTC is enough.
 *
 * Reference: https://en.wikipedia.org/wiki/Cron#CRON_expression
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
  /** True when day-of-month AND day-of-week are each `*` — the standard case. */
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
 * Parses a cron field into a set of allowed values.
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
 * Validate-only helper — for the API layer so that 400s come back with a useful
 * message instead of a 500.
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
 * Computes the next match from `fromMs` (exclusive — never the same
 * moment). Returns ms-epoch or `null` if there is no match in the next 4 years
 * (= obviously wrong expression).
 *
 * Algorithm: fast-forward minute by minute until all fields match. The 4-year
 * ceiling prevents infinite loops (e.g. `0 0 31 2 *` — February 31st).
 */
export function nextRunAt(expr: string, fromMs: number): number | null {
  const parsed = parseCron(expr);
  const MAX_ITERATIONS = 60 * 24 * 366 * 4; // 4 years in minutes

  // Start at fromMs + 1 minute, snapped to the second on a minute boundary.
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
      // Jump to the next hour at minute 0.
      cursor = new Date(cursor.getTime() + (60 - min) * 60_000);
      continue;
    }
    if (!parsed.month.has(mon)) {
      // Jump to the next month, day 1 00:00.
      const next = new Date(
        Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1),
      );
      cursor = next;
      continue;
    }

    // Cron quirk: when BOTH dom and dow are set (not `*`),
    // EITHER dom OR dow matches (OR semantics). Otherwise AND.
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
      // Jump to the next day 00:00.
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
