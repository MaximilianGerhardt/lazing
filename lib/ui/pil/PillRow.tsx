import type { CSSProperties, ReactNode } from 'react';

export interface PillRowProps {
  children: ReactNode;
  /**
   * Horizontal + vertical gap between pills, in pixels. Defaults to 10,
   * matching the baseline `.pill-row` gap defined in components.css.
   * A different value overrides the CSS default via inline style — the
   * root class is still applied so flex-wrap/alignment stay consistent.
   */
  gap?: number;
  className?: string;
}

function classNames(
  ...parts: Array<string | false | null | undefined>
): string {
  return parts.filter(Boolean).join(' ');
}

/**
 * PIL-01 Pill Row — horizontal, wrap-friendly group for one or more
 * <Pill> elements. Server-Component-safe (no client hooks).
 */
export function PillRow({
  children,
  gap,
  className,
}: PillRowProps): React.JSX.Element {
  const style: CSSProperties | undefined =
    typeof gap === 'number' ? { gap: `${gap}px` } : undefined;

  return (
    <div className={classNames('pill-row', className)} style={style}>
      {children}
    </div>
  );
}

export default PillRow;
