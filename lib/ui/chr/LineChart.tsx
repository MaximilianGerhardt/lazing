'use client';

import { useId } from 'react';
import { ChartContainer, type ChartContainerProps } from './ChartContainer';

export interface LineChartProps extends Omit<ChartContainerProps, 'children'> {
  /** Data points, each 0-100. Rendered left-to-right, evenly spaced. */
  data: number[];
  /** Stroke / gradient color. Defaults to a CSS token (var(--a-clientb)). */
  color?: string;
  /** SVG viewBox height; width is fixed at 400 and the SVG stretches via CSS. */
  height?: number;
  /** Render pulsing end-dot at the last data point. Default true. */
  showEndDot?: boolean;
}

const VIEW_WIDTH = 400;

/**
 * Map a 0..100 value to a Y-coordinate in the viewBox, with a small top/bottom
 * margin so the stroke and end-dot do not get clipped by the SVG edge.
 */
function valueToY(v: number, height: number): number {
  const clamped = Math.max(0, Math.min(100, v));
  const margin = 6;
  const usable = height - margin * 2;
  // invert: value 100 -> top (margin), value 0 -> bottom (height - margin)
  return margin + (1 - clamped / 100) * usable;
}

/**
 * Build a smooth-ish line path and a closed fill-path (for the gradient area).
 * Uses straight segments — simple, crisp, no dependency on curve libs.
 */
function buildPaths(
  data: number[],
  height: number,
): { line: string; fill: string; last: { x: number; y: number } | null } {
  if (data.length === 0) {
    return { line: '', fill: '', last: null };
  }
  if (data.length === 1) {
    const x = VIEW_WIDTH;
    const y = valueToY(data[0]!, height);
    return {
      line: `M 0 ${y} L ${x} ${y}`,
      fill: `M 0 ${y} L ${x} ${y} L ${x} ${height} L 0 ${height} Z`,
      last: { x, y },
    };
  }

  const step = VIEW_WIDTH / (data.length - 1);
  const points = data.map((v, i) => ({
    x: i * step,
    y: valueToY(v, height),
  }));

  const line = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`)
    .join(' ');

  const first = points[0]!;
  const last = points[points.length - 1]!;
  const fill =
    `M ${first.x.toFixed(2)} ${height} ` +
    `L ${first.x.toFixed(2)} ${first.y.toFixed(2)} ` +
    points
      .slice(1)
      .map((p) => `L ${p.x.toFixed(2)} ${p.y.toFixed(2)}`)
      .join(' ') +
    ` L ${last.x.toFixed(2)} ${height} Z`;

  return { line, fill, last };
}

/**
 * CHR-01 — Line chart with fill-gradient. Pure SVG, no runtime chart lib.
 * Gradient ID is uniquified via React 19 `useId()` for SSR safety and
 * coexistence of multiple LineCharts on the same page.
 */
export function LineChart({
  data,
  color = 'var(--a-clientb)',
  height = 100,
  showEndDot = true,
  // Container passthrough:
  title,
  value,
  valueVariant,
  sub,
  axisLeft,
  axisCenter,
  axisRight,
}: LineChartProps) {
  const rawId = useId();
  // useId can return characters (":") that are invalid in SVG fragment refs
  // when interpolated into url(#...). Sanitize to a safe token.
  const gradId = `lc-${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`;

  const { line, fill, last } = buildPaths(data, height);

  return (
    <ChartContainer
      title={title}
      value={value}
      valueVariant={valueVariant}
      sub={sub}
      axisLeft={axisLeft}
      axisCenter={axisCenter}
      axisRight={axisRight}
    >
      <svg
        viewBox={`0 0 ${VIEW_WIDTH} ${height}`}
        preserveAspectRatio="none"
        style={{ height }}
        aria-hidden="true"
      >
        <title>{title}</title>
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.4} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        {fill && <path d={fill} fill={`url(#${gradId})`} />}
        {line && (
          <path
            d={line}
            stroke={color}
            strokeWidth={1.5}
            strokeLinejoin="round"
            strokeLinecap="round"
            fill="none"
            vectorEffect="non-scaling-stroke"
          />
        )}
        {showEndDot && last && (
          <circle
            cx={last.x}
            cy={last.y}
            r={3.5}
            fill={color}
            style={{ animation: 'pulse 1s infinite' }}
          />
        )}
      </svg>
    </ChartContainer>
  );
}
