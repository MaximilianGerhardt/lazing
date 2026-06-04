/**
 * Welle 5b (2026-05-01): dynamische themeColor-Auflösung für app/layout.tsx.
 *
 * Separat ausgelagert, damit die Funktion in Tests importiert werden kann
 * ohne dass `app/layout.tsx` (und mit ihm `globals.css` + Tailwind) geladen
 * werden muss. CSS-Imports werfen unter `node:test` / `tsx`.
 */

import { getDb } from "@/db/client";

/**
 * Default-Theme-Color — laz.ing-Identity-Schwarz. Wird verwendet wenn:
 *  - kein lazyos.org-Cookie gesetzt ist
 *  - die Org keine Workspaces mit accent hat
 *  - DB-Lookup fehlschlägt
 *  - der gefundene accent kein gültiges Hex-Format ist
 */
export const DEFAULT_THEME_COLOR = "#070707";

/**
 * Liest die Akzent-Farbe der aktiven Org. Greift auf den ersten Workspace
 * mit gesetztem accent in der Org zurück. Fail-soft: jeder DB-Fehler oder
 * fehlende Spalte fällt auf den Default zurück. Kein Throw — der Server
 * soll auch bei kaputter SQLite die Page rendern.
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
    // Hex-Validation (#rgb / #rrggbb) — wir wollen nichts anderes als
    // Theme-Color in den meta-Tag rauslassen (CSS-vars wie var(--a-now)
    // gehören hier nicht hin).
    if (!/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(accent)) return DEFAULT_THEME_COLOR;
    return accent;
  } catch {
    return DEFAULT_THEME_COLOR;
  }
}
