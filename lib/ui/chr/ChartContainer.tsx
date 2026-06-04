import type { ReactNode } from 'react';

export type ChartValueVariant = 'default' | 'warn' | 'err';

export interface ChartContainerProps {
  /** Header title, also used as aria-label for the role="img" wrapper */
  title: string;
  /** Right-aligned big number in the header (mono) */
  value?: string;
  /** Color variant for the header value */
  valueVariant?: ChartValueVariant;
  /** Mono caption rendered under the header */
  sub?: string;
  /** Optional axis labels rendered under the chart body */
  axisLeft?: string;
  axisCenter?: string;
  axisRight?: string;
  /** Chart body (SVG, bar grid, heatmap, ...) */
  children: ReactNode;
  /** Optional className passthrough for outer wrapper */
  className?: string;
}

/**
 * CHR shared wrapper — header (title + optional value), sub-caption,
 * chart body, and optional 3-slot axis label row. A11y: role="img".
 */
export function ChartContainer({
  title,
  value,
  valueVariant = 'default',
  sub,
  axisLeft,
  axisCenter,
  axisRight,
  children,
  className,
}: ChartContainerProps) {
  const hasAxis =
    axisLeft !== undefined || axisCenter !== undefined || axisRight !== undefined;

  const valClass =
    valueVariant === 'warn'
      ? 'val warn'
      : valueVariant === 'err'
        ? 'val err'
        : 'val';

  return (
    <div
      className={className ? `chart ${className}` : 'chart'}
      role="img"
      aria-label={title}
    >
      <div className="h">
        <div className="t">{title}</div>
        {value !== undefined && <div className={valClass}>{value}</div>}
      </div>
      {sub && <div className="sub">{sub}</div>}
      {children}
      {hasAxis && (
        <div className="axis" aria-hidden="true">
          <span>{axisLeft ?? ''}</span>
          <span>{axisCenter ?? ''}</span>
          <span>{axisRight ?? ''}</span>
        </div>
      )}
    </div>
  );
}
