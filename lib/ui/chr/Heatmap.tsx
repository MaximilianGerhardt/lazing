import { ChartContainer, type ChartContainerProps } from './ChartContainer';

export type HeatmapCellVariant =
  | 'empty'
  | 'consensus'
  | 'median'
  | 'outlier'
  | 'running';

export interface HeatmapCell {
  variant?: HeatmapCellVariant;
}

export interface HeatmapProps extends Omit<ChartContainerProps, 'children'> {
  /** Up to 50 cells (10 cols × 5 rows). Missing cells render as empty. */
  cells: HeatmapCell[];
}

const TOTAL_CELLS = 50;

/**
 * Map our variant names onto the existing `.heat i` modifier classes
 * defined in `app/components.css`:
 *   empty     → (no class, neutral card-2)
 *   consensus → `.k`
 *   median    → `.m`
 *   outlier   → `.o`
 *   running   → `.r` (pulses)
 */
function cellClass(variant: HeatmapCellVariant | undefined): string {
  switch (variant) {
    case 'consensus':
      return 'k';
    case 'median':
      return 'm';
    case 'outlier':
      return 'o';
    case 'running':
      return 'r';
    default:
      return '';
  }
}

/**
 * CHR-04 — 10×5 swarm heatmap. Always renders exactly 50 cells. If fewer
 * are provided, the rest are padded as empty; extras are ignored so the
 * grid geometry is stable.
 */
export function Heatmap({
  cells,
  title,
  value,
  valueVariant,
  sub,
  axisLeft,
  axisCenter,
  axisRight,
}: HeatmapProps) {
  const normalized: HeatmapCell[] = [];
  for (let i = 0; i < TOTAL_CELLS; i++) {
    normalized.push(cells[i] ?? { variant: 'empty' });
  }

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
      <div className="heat" aria-hidden="true">
        {normalized.map((c, i) => {
          const cls = cellClass(c.variant);
          return <i key={i} className={cls || undefined} />;
        })}
      </div>
    </ChartContainer>
  );
}
