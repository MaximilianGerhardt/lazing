/**
 * Pure Workspace-Label/Accent-Resolver
 * ------------------------------------
 * EINE Quelle der Wahrheit für „segmentId → Anzeigename + Pill-Farbe", die
 * sowohl in Server- als auch Client-Components läuft (kein DB-Import, kein
 * `getDb()`). Der Aufrufer reicht die echte Workspace-Liste (aus
 * `listWorkspaces()`) herein.
 *
 * Warum nötig (2026-06-03, UI/UX-Neuausrichtung Phase A):
 *   Vor diesem Helper hatten /decisions, /calendar (×2) und ChatShell je eine
 *   lokale, hartkodierte `SEGMENT_LABELS`-Map (`@north → Nord-Sparkasse`,
 *   `@clientb → clientb GmbH`). Seit der Event-Log-Migration tragen die Rows
 *   aber echte Workspace-IDs (`example-website-project`, `intern`, …) →
 *   die Map traf nie, lieferte `undefined` = leere Pills. Bei Alt-Rows zeigte
 *   sie umgekehrt Phantasie-Kunden, die es nie gab.
 *
 * Vertrag:
 *   - Legacy-`@…`-Segmente werden zuerst via `migrateSegmentToWorkspace`
 *     auf reale Workspace-IDs übersetzt.
 *   - Danach Lookup in der echten Liste → echter `label` / `accent`.
 *   - Nie `undefined`, nie ein erfundener Kundenname: unbekannte IDs fallen
 *     auf die (migrierte) ID bzw. den Accent-Fallback zurück.
 *
 * Vorbild war der Inline-Helper in `app/workstreams/page.tsx` — dieser
 * Helper konsolidiert ihn + ergänzt die Legacy-Migration.
 */

import type { PillVariant } from '@/lib/ui/pil';
import {
  migrateSegmentToWorkspace,
  workspaceAccentFallback,
} from '@/lib/events/types';

/** Minimal-Shape, das aus `listWorkspaces()` herausfällt und an Client-
 *  Components serialisierbar weitergereicht werden kann. */
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

/** Coerced auf das Pill-Variant-Union; alles Unbekannte (z.B. `palette-7`,
 *  `a-now`) → 'own', damit nie eine ungültige Variant ans `Pill` geht. */
function normalizeAccent(raw: string): PillVariant {
  return (PILL_VARIANTS as readonly string[]).includes(raw)
    ? (raw as PillVariant)
    : 'own';
}

/** Reduziert eine volle Workspace-Liste auf das serialisierbare Lite-Shape. */
export function toWorkspaceLite(
  list: ReadonlyArray<{ id: string; label: string; accent: string }>,
): WorkspaceLite[] {
  return list.map((w) => ({ id: w.id, label: w.label, accent: w.accent }));
}

/** Anzeigename für eine (ggf. legacy) segmentId/Workspace-ID. */
export function workspaceLabel(
  segmentId: string,
  list: readonly WorkspaceLite[],
): string {
  const wsId = migrateSegmentToWorkspace(segmentId);
  return list.find((w) => w.id === wsId)?.label ?? wsId;
}

/** Pill-Variant (Farbe) für eine (ggf. legacy) segmentId/Workspace-ID. */
export function workspaceAccentVariant(
  segmentId: string,
  list: readonly WorkspaceLite[],
): PillVariant {
  const wsId = migrateSegmentToWorkspace(segmentId);
  const found = list.find((w) => w.id === wsId)?.accent;
  return normalizeAccent(found ?? workspaceAccentFallback(wsId));
}
