/**
 * schedule-humanize.ts
 *
 * Konvertiert Routine-Trigger in lesbaren Deutsch-Text. Wird ueberall
 * im UI verwendet, damit der User nie direkt Cron-Syntax oder JSON-Shapes
 * sieht. Raw-Syntax ist nur im Advanced-Toggle sichtbar.
 *
 * Strategie:
 *   1. Bekannte Muster mappen (`0 8 * * *` -> "Jeden Tag um 08:00 UTC").
 *   2. Generische Fallbacks fuer `*\/N`, Ranges, Listen.
 *   3. Bei Exoten: Cron-Expression unveraendert zurueckgeben, aber mit
 *      einer kurzen Einleitung ("Benutzerdefinierter Zeitplan — …").
 *
 * Alle Schedules werden UTC-interpretiert (`lib/routines/scheduler.ts`).
 */

const DOW_NAMES = [
  "Sonntag",
  "Montag",
  "Dienstag",
  "Mittwoch",
  "Donnerstag",
  "Freitag",
  "Samstag",
];

export interface HumanSchedule {
  /** Symbol fuer den Trigger-Typ, als Unicode-Glyph (keine externen Icons). */
  icon: string;
  /** Lesbarer Satz — wird direkt in der Card gerendert. */
  label: string;
  /** Ist dies ein Cron-, Event- oder Manual-Trigger? */
  kind: "cron" | "event" | "manual";
}

// ---------------------------------------------------------------------------
// Cron
// ---------------------------------------------------------------------------

interface CronField {
  raw: string;
  isStar: boolean;
  isStep: boolean;
  step?: number;
  single?: number;
  all: number[];
}

function parseField(raw: string, min: number, max: number): CronField {
  const field: CronField = {
    raw,
    isStar: raw === "*",
    isStep: false,
    all: [],
  };
  if (field.isStar) {
    for (let i = min; i <= max; i++) field.all.push(i);
    return field;
  }
  const stepMatch = raw.match(/^(\*|\d+(?:-\d+)?)\/(\d+)$/);
  if (stepMatch) {
    field.isStep = true;
    field.step = Number(stepMatch[2]);
    return field;
  }
  if (/^\d+$/.test(raw)) {
    field.single = Number(raw);
    field.all.push(field.single);
    return field;
  }
  // Range / list — nicht kritisch fuer human-readable, wir fallen zurueck.
  return field;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * Parst Standard-5-Feld-Cron in HumanSchedule. Gibt null zurueck wenn
 * die Expression nicht geparst werden konnte.
 */
export function humanizeCron(expr: string | null | undefined): HumanSchedule {
  if (!expr || !expr.trim()) {
    return { icon: "·", label: "Kein Zeitplan gesetzt", kind: "cron" };
  }
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    return { icon: "◷", label: `Cron: ${expr}`, kind: "cron" };
  }
  const [minRaw, hourRaw, domRaw, monthRaw, dowRaw] = parts;
  const minute = parseField(minRaw, 0, 59);
  const hour = parseField(hourRaw, 0, 23);
  const dom = parseField(domRaw, 1, 31);
  const month = parseField(monthRaw, 1, 12);
  const dow = parseField(dowRaw, 0, 6);

  // --- Fall 1: taeglich zu fester Uhrzeit: `MM HH * * *`
  if (
    minute.single !== undefined &&
    hour.single !== undefined &&
    dom.isStar &&
    month.isStar &&
    dow.isStar
  ) {
    return {
      icon: "◷",
      label: `Jeden Tag um ${pad(hour.single)}:${pad(minute.single)} UTC`,
      kind: "cron",
    };
  }

  // --- Fall 2: wochentags zu fester Uhrzeit: `MM HH * * D`
  if (
    minute.single !== undefined &&
    hour.single !== undefined &&
    dom.isStar &&
    month.isStar &&
    dow.single !== undefined
  ) {
    return {
      icon: "◷",
      label: `Jeden ${DOW_NAMES[dow.single]} um ${pad(hour.single)}:${pad(minute.single)} UTC`,
      kind: "cron",
    };
  }

  // --- Fall 3: alle N Minuten: `*\/N * * * *`
  if (
    minute.isStep &&
    minute.step !== undefined &&
    hour.isStar &&
    dom.isStar &&
    month.isStar &&
    dow.isStar
  ) {
    const n = minute.step;
    if (n === 1) return { icon: "◷", label: "Jede Minute", kind: "cron" };
    return { icon: "◷", label: `Alle ${n} Minuten`, kind: "cron" };
  }

  // --- Fall 4: alle N Stunden zur Minute M: `M *\/N * * *`
  if (
    minute.single !== undefined &&
    hour.isStep &&
    hour.step !== undefined &&
    dom.isStar &&
    month.isStar &&
    dow.isStar
  ) {
    const n = hour.step;
    if (n === 1) {
      return {
        icon: "◷",
        label: `Stuendlich zur Minute :${pad(minute.single)} UTC`,
        kind: "cron",
      };
    }
    return {
      icon: "◷",
      label: `Alle ${n} Stunden um :${pad(minute.single)} UTC`,
      kind: "cron",
    };
  }

  // --- Fall 5: zur vollen Stunde (`0 * * * *`)
  if (
    minute.single === 0 &&
    hour.isStar &&
    dom.isStar &&
    month.isStar &&
    dow.isStar
  ) {
    return { icon: "◷", label: "Stuendlich (zur vollen Stunde) UTC", kind: "cron" };
  }

  // Fallback — wir zeigen die raw Expression mit Hinweis.
  return {
    icon: "◷",
    label: `Benutzerdefinierter Zeitplan: ${expr}`,
    kind: "cron",
  };
}

// ---------------------------------------------------------------------------
// Event-Match
// ---------------------------------------------------------------------------

export interface EventMatchShape {
  eventType: string;
  entityType?: string;
  payloadMatch?: Record<string, unknown>;
}

export function humanizeEvent(
  match: EventMatchShape | string | null | undefined,
): HumanSchedule {
  if (!match) {
    return {
      icon: "·",
      label: "Event-Trigger nicht konfiguriert",
      kind: "event",
    };
  }
  let parsed: EventMatchShape | null = null;
  if (typeof match === "string") {
    try {
      parsed = JSON.parse(match) as EventMatchShape;
    } catch {
      return {
        icon: "·",
        label: `Event-Trigger: ${match.slice(0, 60)}`,
        kind: "event",
      };
    }
  } else {
    parsed = match;
  }
  if (!parsed || !parsed.eventType) {
    return {
      icon: "·",
      label: "Event-Trigger ohne Event-Typ",
      kind: "event",
    };
  }
  let label = `Bei Event: ${parsed.eventType}`;
  if (parsed.entityType) label += ` · ${parsed.entityType}`;
  return { icon: "·", label, kind: "event" };
}

// ---------------------------------------------------------------------------
// Manual
// ---------------------------------------------------------------------------

export function humanizeManual(): HumanSchedule {
  return {
    icon: "▶",
    label: "Nur manuell",
    kind: "manual",
  };
}

// ---------------------------------------------------------------------------
// Uebergeordneter Helper
// ---------------------------------------------------------------------------

export function humanizeTrigger(input: {
  triggerMode: "cron" | "event" | "manual";
  cronExpr: string | null;
  eventMatch: string | EventMatchShape | null;
}): HumanSchedule {
  switch (input.triggerMode) {
    case "cron":
      return humanizeCron(input.cronExpr);
    case "event":
      return humanizeEvent(input.eventMatch);
    case "manual":
    default:
      return humanizeManual();
  }
}

// ---------------------------------------------------------------------------
// Relative-Time — in Routines-UI konsistent formatieren.
// ---------------------------------------------------------------------------

export function formatRelativeGerman(ts: number | null): string {
  if (ts === null) return "—";
  const diffMs = Date.now() - ts;
  const future = diffMs < 0;
  const abs = Math.abs(diffMs);
  const minutes = Math.round(abs / 60_000);
  const hours = Math.round(minutes / 60);
  const days = Math.round(hours / 24);

  if (minutes < 1) return future ? "gleich" : "gerade eben";
  if (minutes < 60) {
    return future ? `in ${minutes} Min` : `vor ${minutes} Min`;
  }
  if (hours < 48) {
    return future ? `in ${hours} Std` : `vor ${hours} Std`;
  }
  return future ? `in ${days} Tagen` : `vor ${days} Tagen`;
}

// ---------------------------------------------------------------------------
// Wizard-Schedule-Builder — baut cron expression aus Wizard-Input.
// ---------------------------------------------------------------------------

export interface WizardDailySpec {
  kind: "daily";
  hour: number;
  minute: number;
}

export interface WizardIntervalMinutesSpec {
  kind: "interval-minutes";
  every: number;
}

export interface WizardIntervalHoursSpec {
  kind: "interval-hours";
  every: number;
  atMinute: number;
}

export interface WizardWeeklySpec {
  kind: "weekly";
  dayOfWeek: number; // 0 = Sun ... 6 = Sat
  hour: number;
  minute: number;
}

export type WizardCronSpec =
  | WizardDailySpec
  | WizardIntervalMinutesSpec
  | WizardIntervalHoursSpec
  | WizardWeeklySpec;

export function cronFromSpec(spec: WizardCronSpec): string {
  switch (spec.kind) {
    case "daily":
      return `${spec.minute} ${spec.hour} * * *`;
    case "interval-minutes":
      return `*/${spec.every} * * * *`;
    case "interval-hours":
      return `${spec.atMinute} */${spec.every} * * *`;
    case "weekly":
      return `${spec.minute} ${spec.hour} * * ${spec.dayOfWeek}`;
  }
}
