/**
 * Welle 5b (2026-05-01) — Tests für die dynamische themeColor-Resolution.
 *
 * Run: `pnpm exec tsx --test app/__tests__/viewport.test.ts`
 *
 * Wir testen `resolveThemeColorFromOrg` direkt (statt das gesamte
 * `app/layout.tsx` zu importieren — das pulled `globals.css` und Tailwind
 * rein, was unter `node:test` bricht). Die `generateViewport`-Logik selbst
 * ist eine triviale Komposition (Cookie → resolveThemeColorFromOrg → Default-
 * Fallback) und damit über die Helper-Funktion abgedeckt.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, describe, it } from "node:test";

// DB-Path BEFORE any module touches getDb().
if (!process.env.LAZYOS_DB_PATH) {
  process.env.LAZYOS_DB_PATH = join(
    mkdtempSync(join(tmpdir(), "lazyos-viewport-")),
    "viewport-test.db",
  );
}
process.env.LAZYOS_TEST_DISABLE_FK = "1";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const themeMod = require("../_viewport-theme") as typeof import("../_viewport-theme");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const dbMod = require("@/db/client") as typeof import("@/db/client");

const { resolveThemeColorFromOrg, DEFAULT_THEME_COLOR } = themeMod;
const { getDb } = dbMod;

const ORG_WITH_ACCENT = "test-org-with-accent";
const ORG_NO_WS = "test-org-no-workspaces";
const ORG_BAD_HEX = "test-org-bad-hex";
const TEST_ACCENT = "#ff8800";

describe("resolveThemeColorFromOrg", () => {
  before(() => {
    const db = getDb();
    const now = Date.now();

    // Org mit accent-Workspace
    db.$raw
      .prepare(
        `INSERT OR REPLACE INTO workspaces
           (id, label, accent, path, sensitivity, archived,
            organization_id, workspace_type, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'low', 0, ?, 'product', ?, ?)`,
      )
      .run(
        "viewport-test-ws-1",
        "Viewport Test WS",
        TEST_ACCENT,
        "/tmp/viewport-test",
        ORG_WITH_ACCENT,
        now,
        now,
      );

    // Org mit Workspace-ohne-accent (leerer String)
    db.$raw
      .prepare(
        `INSERT OR REPLACE INTO workspaces
           (id, label, accent, path, sensitivity, archived,
            organization_id, workspace_type, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'low', 0, ?, 'product', ?, ?)`,
      )
      .run(
        "viewport-test-ws-empty",
        "Empty Accent",
        "",
        "/tmp/viewport-empty",
        ORG_NO_WS,
        now,
        now,
      );

    // Org mit schlechtem Hex (CSS-var oder rgb() — soll abgewiesen werden)
    db.$raw
      .prepare(
        `INSERT OR REPLACE INTO workspaces
           (id, label, accent, path, sensitivity, archived,
            organization_id, workspace_type, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'low', 0, ?, 'product', ?, ?)`,
      )
      .run(
        "viewport-test-ws-badhex",
        "Bad Hex",
        "var(--a-now)",
        "/tmp/viewport-badhex",
        ORG_BAD_HEX,
        now,
        now,
      );
  });

  it("ohne orgId → Default", () => {
    assert.equal(resolveThemeColorFromOrg(""), DEFAULT_THEME_COLOR);
  });

  it("mit Org die einen accent hat → workspace.accent", () => {
    const themeColor = resolveThemeColorFromOrg(ORG_WITH_ACCENT);
    assert.equal(themeColor, TEST_ACCENT);
  });

  it("Org ohne Workspaces → Default", () => {
    const themeColor = resolveThemeColorFromOrg("non-existent-org-id");
    assert.equal(themeColor, DEFAULT_THEME_COLOR);
  });

  it("Org mit nur leeren accents → Default", () => {
    const themeColor = resolveThemeColorFromOrg(ORG_NO_WS);
    assert.equal(themeColor, DEFAULT_THEME_COLOR);
  });

  it("Org mit nicht-Hex-accent (CSS-var) → Default (kein Leak in meta-Tag)", () => {
    const themeColor = resolveThemeColorFromOrg(ORG_BAD_HEX);
    assert.equal(themeColor, DEFAULT_THEME_COLOR);
  });

  it("DEFAULT_THEME_COLOR ist laz.ing-Schwarz", () => {
    assert.equal(DEFAULT_THEME_COLOR, "#070707");
  });
});
