import type { ReactNode } from 'react';

export interface StatItem {
  /** The full value string, e.g. "38/50" or "σ 0.14". */
  value: string;
  /** Small uppercase label below the value, e.g. "DURCH". */
  label: string;
  /**
   * If present, the first occurrence of `emphasis` inside `value` is wrapped
   * in <em> so the CSS rule `.stat .v em` can accent-color that substring
   * (var(--a-now)). Falls back to the plain value when not found.
   */
  emphasis?: string;
}

export interface StatsRowProps {
  stats: StatItem[];
  /** Optional className passthrough (e.g. to override grid columns). */
  className?: string;
}

/**
 * Render a value with optional emphasized substring. Keeps the rendering
 * predictable: only the first occurrence is wrapped, and non-matching
 * inputs render as plain text (no surprise DOM changes).
 */
function renderValue(value: string, emphasis?: string): ReactNode {
  if (!emphasis) return value;
  const idx = value.indexOf(emphasis);
  if (idx < 0) return value;
  const before = value.slice(0, idx);
  const match = value.slice(idx, idx + emphasis.length);
  const after = value.slice(idx + emphasis.length);
  return (
    <>
      {before}
      <em>{match}</em>
      {after}
    </>
  );
}

/**
 * CHR-03 — 3-up stats row. Uses the existing `.stats` / `.stat` CSS.
 * Not wrapped in ChartContainer because the stats grid has its own layout
 * semantics (no title, no axis).
 */
export function StatsRow({ stats, className }: StatsRowProps) {
  return (
    <div
      className={className ? `stats ${className}` : 'stats'}
      role="group"
      aria-label="Statistics"
    >
      {stats.map((s, i) => (
        <div key={i} className="stat">
          <div className="v">{renderValue(s.value, s.emphasis)}</div>
          <div className="l">{s.label}</div>
        </div>
      ))}
    </div>
  );
}
