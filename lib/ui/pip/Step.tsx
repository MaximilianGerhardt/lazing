import * as React from 'react';

import {
  STEP_STATUS_ARIA,
  STEP_STATUS_CLASS,
  STEP_STATUS_LABEL,
  clampProgressPct,
  defaultSubtitleForEta,
  type EtaBucket,
  type StepStatus as StepStatusV2,
} from './types';

/**
 * Backwards-compat: the old step status was 3-valued
 * (`'done'|'running'|'waiting'`). Wave 1 extends it to 5-valued
 * (`'pending'|'running'|'done'|'failed'|'skipped'`). Both sets
 * are accepted here; `'waiting'` is promoted internally to `'pending'`.
 */
export type StepStatus =
  | 'done'
  | 'running'
  | 'waiting'
  | 'pending'
  | 'failed'
  | 'skipped';

function normaliseStatus(s: StepStatus): StepStatusV2 {
  if (s === 'waiting') return 'pending';
  return s;
}

export interface PipelineStepProps {
  /** Step number / marker (rendered in the circle). */
  num: number | string;
  /** Step title, e.g. "YouTube-Transkript ziehen". */
  title: string;
  /**
   * Optional subtitle — accepts ReactNode so callers can inline <b>
   * highlights without a markup mini-language:
   *   subtitle={<>yt-dlp · <b>24:18</b> · 3 842 Wörter</>}
   *
   * Wave 1: when not set, a default subtitle ("fast fertig",
   * "läuft länger als üblich") is derived from `etaBucket`.
   */
  subtitle?: React.ReactNode;
  status: StepStatus;
  /**
   * Override for the short status label. Defaults are pulled from
   * STEP_STATUS_LABEL ('ok' / 'run' / 'wait' / 'fail' / 'skip').
   */
  statusLabel?: string;
  /**
   * Wave 1: optional ETA bucket. When set and no explicit
   * `subtitle`, Step generates a qualitative hint.
   */
  etaBucket?: EtaBucket;
  /**
   * Wave 1: 0..100 — renders a 1px underline progress bar
   * below the step card. Only meaningful when `status='running'`.
   * Values outside [0,100] are clamped.
   */
  progressPct?: number;
  className?: string;
}

function classNames(
  ...parts: Array<string | false | null | undefined>
): string {
  return parts.filter(Boolean).join(' ');
}

/**
 * PIP-01 Pipeline Step.
 *
 * Renders a single row in a pipeline. Status maps to CSS:
 *   done    → .step.d  (green tint)
 *   running → .step.r  (amber tint)
 *   pending → .step.w  (neutral, formerly 'waiting')
 *   failed  → .step.f  (red, NEW in Wave 1)
 *   skipped → .step.k  (struck-through grey, NEW in Wave 1)
 *
 * Status transition is animated via `var(--spring-bouncy)`, triggered
 * by a CSS transition on `background-color` + `border-color`.
 *
 * Accessibility:
 *  - Each step is a <li> (see <Pipeline>, which wraps steps in <ol>).
 *  - aria-current="step" is set on the running step so assistive tech
 *    can announce where work is happening.
 *  - The short status badge has aria-label with a full-word equivalent
 *    ("Abgeschlossen" / "Läuft" / "Wartet" / "Fehlgeschlagen" /
 *    "Übersprungen") since "ok" / "run" / "wait" / "fail" / "skip"
 *    are visual shorthand only.
 *  - Progress-Bar bekommt `role="progressbar"` mit aria-valuenow.
 */
export function Step({
  num,
  title,
  subtitle,
  status,
  statusLabel,
  etaBucket,
  progressPct,
  className,
}: PipelineStepProps): React.JSX.Element {
  const v2Status = normaliseStatus(status);
  const statusClass = STEP_STATUS_CLASS[v2Status];
  const label = statusLabel ?? STEP_STATUS_LABEL[v2Status];

  const resolvedSubtitle: React.ReactNode =
    subtitle ?? (etaBucket ? defaultSubtitleForEta(etaBucket) : null);

  const clampedPct = clampProgressPct(progressPct);

  // Set an inline custom property — not a general inline style.
  // The CSS variable is read by the stylesheet (`.step__progress-bar` width)
  // and is the only semantically correct bridge between a
  // dynamic value and CSS.
  const progressStyle: React.CSSProperties | undefined =
    clampedPct !== undefined
      ? ({ ['--progress' as never]: `${clampedPct}` } as React.CSSProperties)
      : undefined;

  return (
    <li
      className={classNames('step', statusClass, className)}
      aria-current={v2Status === 'running' ? 'step' : undefined}
      style={progressStyle}
    >
      <div className="n" aria-hidden="true">
        {num}
      </div>
      <div className="b">
        <div className="nm">{title}</div>
        {resolvedSubtitle ? (
          <div className="sb">{resolvedSubtitle}</div>
        ) : null}
      </div>
      <div className="s" aria-label={STEP_STATUS_ARIA[v2Status]}>
        {label}
      </div>
      {clampedPct !== undefined ? (
        <div
          className="step__progress-bar"
          role="progressbar"
          aria-valuenow={clampedPct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${title} – ${Math.round(clampedPct)}% fertig`}
        />
      ) : null}
    </li>
  );
}

export default Step;
