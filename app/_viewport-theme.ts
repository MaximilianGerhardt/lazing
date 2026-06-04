/**
 * Wave 5b (2026-05-01): dynamic themeColor resolution for app/layout.tsx.
 *
 * Split out separately so the function can be imported in tests
 * without `app/layout.tsx` (and with it `globals.css` + Tailwind) having to
 * be loaded. CSS imports throw under `node:test` / `tsx`.
 */

import { getDb } from "@/db/client";

/**
 * Default theme color — laz.ing identity black. Used when:
 *  - no lazyos.org cookie is set
 *  - the org has no workspaces with an accent
 *  - the DB lookup fails
 *  - the accent found is not a valid hex format
 */
export const DEFAULT_THEME_COLOR = "#070707";

/**
 * Reads the accent color of the active org. Falls back to the first workspace
 * with an accent set in the org. Fail-soft: any DB error or
 * missing column falls back to the default. No throw — the server
 * should render the page even with a broken SQLite.
 */
export function resolveThemeColorFromOrg(orgId: string): string {
  if (!orgId || typeof orgId !== "string") return DEFAULT_THEME_COLOR;
  try {
    const db = getDb();
    const row = db.$raw
      .prepare(
        `SELECT accent FROM workspaces
         WHERE organization_id = ?
           AND accent IS NOT NULL
           AND accent != ''
         ORDER BY archived ASC, created_at ASC
         LIMIT 1`,
      )
      .get(orgId) as { accent?: string } | undefined;
    const accent = row?.accent?.trim();
    if (!accent) return DEFAULT_THEME_COLOR;
    // Hex validation (#rgb / #rrggbb) — we only want to let theme colors
    // through into the meta tag (CSS vars like var(--a-now)
    // do not belong here).
    if (!/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(accent)) return DEFAULT_THEME_COLOR;
    return accent;
  } catch {
    return DEFAULT_THEME_COLOR;
  }
}
