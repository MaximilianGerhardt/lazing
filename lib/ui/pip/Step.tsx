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
 * Backwards-Compat: der alte Step-Status war 3-wertig
 * (`'done'|'running'|'waiting'`). Welle-1 erweitert auf 5-wertig
 * (`'pending'|'running'|'done'|'failed'|'skipped'`). Beide Sets
 * werden hier akzeptiert; `'waiting'` wird intern auf `'pending'`
 * gehoben.
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
   * Welle-1: wenn nicht gesetzt, wird aus `etaBucket` ein
   * Default-Subtitle ("fast fertig", "läuft länger als üblich")
   * abgeleitet.
   */
  subtitle?: React.ReactNode;
  status: StepStatus;
  /**
   * Override for the short status label. Defaults werden aus
   * STEP_STATUS_LABEL gezogen ('ok' / 'run' / 'wait' / 'fail' / 'skip').
   */
  statusLabel?: string;
  /**
   * Welle-1: optionaler ETA-Bucket. Wenn gesetzt und kein expliziter
   * `subtitle`, generiert Step einen qualitativen Hinweis.
   */
  etaBucket?: EtaBucket;
  /**
   * Welle-1: 0..100 — rendert eine 1px Underline-Progress-Bar
   * unter der Step-Card. Nur sinnvoll bei `status='running'`.
   * Werte außerhalb [0,100] werden geklammert.
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
 *   pending → .step.w  (neutral, ehem. 'waiting')
 *   failed  → .step.f  (rot, NEU Welle-1)
 *   skipped → .step.k  (durchgestrichen-grau, NEU Welle-1)
 *
 * Status-Übergang wird per `var(--spring-bouncy)` animiert, getriggert
 * durch CSS-Transition auf `background-color` + `border-color`.
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

  // Inline custom property setzen — kein generelles Inline-Style.
  // Die CSS-Variable wird vom Stylesheet (`.step__progress-bar` width)
  // gelesen und ist die einzige semantisch korrekte Bridge zwischen
  // dynamischem Wert und CSS.
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
