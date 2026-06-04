/**
 * format-duration.ts — shared duration util for chat indicators.
 *
 * The only source for `formatDur`; imported by:
 *  - ActiveWorkstreamBanner
 *  - InlineWorkerStatus
 *
 * No framework import, no side effect — pure module.
 */

/**
 * Returns a human-readable duration since `lastTickMs`.
 *
 * @param lastTickMs  Unix milliseconds of the last tick (e.g. updatedAt).
 *                    Null/0 → leerer String (kein NaN-Suffix).
 * @param now         Referenz-Zeitstempel (Date.now()).
 * @returns           z.B. `"3m 12s"`, `"1h 4m"`, `"45s"`, oder `""`.
 */
export function formatDur(lastTickMs: number | null, now: number): string {
  if (!lastTickMs) return '';
  const diffSec = Math.max(0, Math.floor((now - lastTickMs) / 1000));
  if (diffSec < 60) return `${diffSec}s`;
  const min = Math.floor(diffSec / 60);
  const sec = diffSec % 60;
  if (min < 60) return `${min}m ${sec}s`;
  const h = Math.floor(min / 60);
  return `${h}h ${min % 60}m`;
}
