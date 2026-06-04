/**
 * Pure workspace label/accent resolver
 * ------------------------------------
 * ONE source of truth for "segmentId → display name + pill color" that
 * runs in both server and client components (no DB import, no
 * `getDb()`). The caller passes in the real workspace list (from
 * `listWorkspaces()`).
 *
 * Why needed (2026-06-03, UI/UX realignment phase A):
 *   Before this helper, /decisions, /calendar (×2) and ChatShell each had a
 *   local, hard-coded `SEGMENT_LABELS` map (`@north → Nord-Sparkasse`,
 *   `@clientb → clientb GmbH`). Since the event-log migration, the rows
 *   carry real workspace IDs (`example-website-project`, `intern`, …) →
 *   the map never matched, returning `undefined` = empty pills. For old rows
 *   it conversely showed fantasy customers that never existed.
 *
 * Contract:
 *   - Legacy `@…` segments are first translated to real workspace IDs via
 *     `migrateSegmentToWorkspace`.
 *   - Then a lookup in the real list → real `label` / `accent`.
 *   - Never `undefined`, never an invented customer name: unknown IDs fall
 *     back to the (migrated) ID or the accent fallback.
 *
 * The model was the inline helper in `app/workstreams/page.tsx` — this
 * helper consolidates it + adds the legacy migration.
 */

import type { PillVariant } from '@/lib/ui/pil';
import {
  migrateSegmentToWorkspace,
  workspaceAccentFallback,
} from '@/lib/events/types';

/** Minimal shape that falls out of `listWorkspaces()` and can be passed
 *  serializably to client components. */
export interface WorkspaceLite {
  id: string;
  label: string;
  accent: string;
}

const PILL_VARIANTS: readonly PillVariant[] = [
  'north',
  'clientb',
  'own',
  'private',
  'claude',
  'codex',
  'error',
];

/** Coerced to the pill-variant union; anything unknown (e.g. `palette-7`,
 *  `a-now`) → 'own', so an invalid variant never reaches `Pill`. */
function normalizeAccent(raw: string): PillVariant {
  return (PILL_VARIANTS as readonly string[]).includes(raw)
    ? (raw as PillVariant)
    : 'own';
}

/** Reduces a full workspace list to the serializable lite shape. */
export function toWorkspaceLite(
  list: ReadonlyArray<{ id: string; label: string; accent: string }>,
): WorkspaceLite[] {
  return list.map((w) => ({ id: w.id, label: w.label, accent: w.accent }));
}

/** Display name for a (possibly legacy) segmentId/workspace ID. */
export function workspaceLabel(
  segmentId: string,
  list: readonly WorkspaceLite[],
): string {
  const wsId = migrateSegmentToWorkspace(segmentId);
  return list.find((w) => w.id === wsId)?.label ?? wsId;
}

/** Pill variant (color) for a (possibly legacy) segmentId/workspace ID. */
export function workspaceAccentVariant(
  segmentId: string,
  list: readonly WorkspaceLite[],
): PillVariant {
  const wsId = migrateSegmentToWorkspace(segmentId);
  const found = list.find((w) => w.id === wsId)?.accent;
  return normalizeAccent(found ?? workspaceAccentFallback(wsId));
}
