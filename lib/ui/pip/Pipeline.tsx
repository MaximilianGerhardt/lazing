import * as React from 'react';

import { Step, type PipelineStepProps } from './Step';

export interface PipelineProps {
  steps: PipelineStepProps[];
  className?: string;
  /** Optional accessible label for the ordered list. */
  ariaLabel?: string;
}

function classNames(
  ...parts: Array<string | false | null | undefined>
): string {
  return parts.filter(Boolean).join(' ');
}

/**
 * PIP-01 Pipeline.
 *
 * Vertical stack of <Step> rows. We render an <ol> so the numbering is
 * semantically an ordered sequence — the visual `.n` circle is aria-hidden
 * since it duplicates the intrinsic list order.
 *
 * Stable keys: we use the `num` prop as key. If callers ever pass duplicate
 * nums we fall back to `num-index`.
 */
export function Pipeline({
  steps,
  className,
  ariaLabel,
}: PipelineProps): React.JSX.Element {
  const seen = new Set<string>();

  // Inline list reset: `.pip` is not styled in components.css (steps carry
  // their own look). We neutralise the default <ol> padding/markers so the
  // stack is visually identical to the HTML-reference snippet (plain divs).
  const listReset: React.CSSProperties = {
    listStyle: 'none',
    margin: 0,
    padding: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  };

  return (
    <ol
      className={classNames('pip', className)}
      style={listReset}
      aria-label={ariaLabel}
    >
      {steps.map((step, index) => {
        const baseKey = String(step.num);
        const key = seen.has(baseKey) ? `${baseKey}-${index}` : baseKey;
        seen.add(baseKey);
        return <Step key={key} {...step} />;
      })}
    </ol>
  );
}

export default Pipeline;
