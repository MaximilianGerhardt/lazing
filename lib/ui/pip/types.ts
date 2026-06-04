/**
 * lib/ui/pip — stepper domain types (sub-plan 5 wave 1, 2026-05-01).
 *
 * StageDescriptor is the adapter output shape: every wave-2 adapter
 * (workflows, iterate, rag, drift, sniper) delivers a
 * `StageDescriptor[]` to the pipeline renderer.
 *
 * `StepStatus` here is 5-valued (pending|running|done|failed|skipped).
 * Step.tsx maps it to CSS classes `w|r|d|f|k`. The existing
 * 3-valued `StepStatus` export from Step.tsx (`'done'|'running'|'waiting'`)
 * stays functional for backwards-compat reasons; internally it is promoted
 * to the new type.
 */

export type StepStatus =
  | 'pending'
  | 'running'
  | 'done'
  | 'failed'
  | 'skipped';

/**
 * Qualitative ETA buckets — we make no hard time promises,
 * just hints like "fast fertig" / "läuft länger als üblich".
 *
 * The renderer decides how this is shown (subtitle string or
 * pill color); the adapter only determines the bucket.
 */
export type EtaBucket = 'fast' | 'normal' | 'slow' | 'overdue';

export interface StageDescriptor {
  /** Stable ID for React keys + a11y. Unique per adapter. */
  id: string;
  /** Readable label, e.g. "Roast V2" or "Embedding". */
  label: string;
  status: StepStatus;
  /**
   * Optional ETA bucket — qualitative time hint. The renderer can
   * generate a subtitle like "fast fertig" or "läuft länger als üblich"
   * from it, or visualize the bucket via a color token.
   */
  etaBucket?: EtaBucket;
  /**
   * Free-text subtitle, e.g. "ca. 2 Wellen noch", "47/120 Chunks".
   * Takes precedence over a subtitle derived automatically from etaBucket.
   */
  subtitle?: string;
  /**
   * 0..100 — when set, Step renders a 1px underline bar.
   * Values outside [0,100] are clamped.
   */
  progressPct?: number;
  /**
   * GitHub-Actions-style collapsible sub-steps. Optional; one level
   * deep is enough for the current use cases (workflow sub-states,
   * sub-plan sniper tickets).
   */
  sub?: StageDescriptor[];
}

/**
 * Mapping from 5-valued StepStatus to a CSS modifier.
 *
 *   pending  → 'w'  (waiting/neutral, old: identical)
 *   running  → 'r'  (amber, old: identical)
 *   done     → 'd'  (green, old: identical)
 *   failed   → 'f'  (red, NEW)
 *   skipped  → 'k'  (struck-through grey, NEW)
 */
export const STEP_STATUS_CLASS: Record<StepStatus, 'w' | 'r' | 'd' | 'f' | 'k'> = {
  pending: 'w',
  running: 'r',
  done: 'd',
  failed: 'f',
  skipped: 'k',
};

/**
 * Default short labels (visual shorthand only — a11y takes the full form).
 */
export const STEP_STATUS_LABEL: Record<StepStatus, string> = {
  pending: 'wait',
  running: 'run',
  done: 'ok',
  failed: 'fail',
  skipped: 'skip',
};

/**
 * a11y full form for the `aria-label` on the status pill.
 */
export const STEP_STATUS_ARIA: Record<StepStatus, string> = {
  pending: 'Wartet',
  running: 'Läuft',
  done: 'Abgeschlossen',
  failed: 'Fehlgeschlagen',
  skipped: 'Übersprungen',
};

/**
 * Helper for a subtitle from EtaBucket — only when the adapter hasn't
 * set its own subtitle.
 */
export function defaultSubtitleForEta(bucket: EtaBucket): string {
  switch (bucket) {
    case 'fast':
      return 'fast fertig';
    case 'normal':
      return 'läuft';
    case 'slow':
      return 'läuft länger als üblich';
    case 'overdue':
      return 'sollte längst fertig sein';
  }
}

/**
 * Clamps progressPct to [0,100]. Non-numbers → undefined.
 */
export function clampProgressPct(pct: number | undefined): number | undefined {
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return undefined;
  if (pct < 0) return 0;
  if (pct > 100) return 100;
  return pct;
}
