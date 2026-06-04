import { ChartContainer, type ChartContainerProps } from './ChartContainer';

export type BarVariant = 'default' | 'median' | 'outlier';

export interface BarChartBar {
  /** Bar height as 0..100 (percent of chart area). */
  height: number;
  /** Visual variant — 'median' highlights, 'outlier' signals attention. */
  variant?: BarVariant;
}

export interface BarChartProps extends Omit<ChartContainerProps, 'children'> {
  bars: BarChartBar[];
}

/**
 * Map our variant names onto the existing `.bars-chart i` modifier classes
 * defined in `app/components.css`:
 *   default → (no extra class, primary with 55% opacity)
 *   median  → `.p`   (a-clientb, full opacity)
 *   outlier → `.o`   (a-now, pulse-ready)
 */
function barClass(variant: BarVariant | undefined): string {
  switch (variant) {
    case 'median':
      return 'p';
    case 'outlier':
      return 'o';
    default:
      return '';
  }
}

/**
 * CHR-02 — Flex-based bar chart. Each bar's `height` (0..100) is mapped to a
 * percentage of the container height. Median / outlier bars get modifier
 * classes so the CSS can recolor them consistently with the theme tokens.
 */
export function BarChart({
  bars,
  title,
  value,
  valueVariant,
  sub,
  axisLeft,
  axisCenter,
  axisRight,
}: BarChartProps) {
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
      <div className="bars-chart" aria-hidden="true">
        {bars.map((b, i) => {
          const h = Math.max(0, Math.min(100, b.height));
          const cls = barClass(b.variant);
          return (
            <i
              key={i}
              className={cls || undefined}
              style={{ height: `${h}%` }}
            />
          );
        })}
      </div>
    </ChartContainer>
  );
}
