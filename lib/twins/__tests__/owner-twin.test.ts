/**
 * Pattern 2 Digital-Twin MVP — Tests.
 *
 * Deckt:
 *   - Schema-Validation: gültiges YAML → success
 *   - Schema-Validation: ungültiger Wert → safeParse fail
 *   - Cache: zweiter getOwnerTwin-Call returniert dieselbe Reference
 *   - Token-Budget: formatTwinsForPrompt mit voller owner_twin.yaml + leerem
 *     Domain-Twin liefert ≤ 500 Tokens (rough Estimate text.length/4)
 *
 * Run: `npx tsx --test lib/twins/__tests__/owner twin.test.ts`
 */

import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

// Skip DB-Init in domain-twin.ts — wir testen den User-Twin-Flow.
process.env.LAZYOS_TWIN_SKIP_DB = "1";

import { clearOwnerTwinCache, getOwnerTwin } from "../owner-twin";
import { estimateTokens, formatTwinsForPrompt } from "../format-for-prompt";
import { MaxTwinSchema } from "../types";

describe("MaxTwinSchema", () => {
  it("validates a valid twin object", () => {
    const valid = {
      version: 1,
      updated_at: "2026-05-01",
      stil: {
        sprache: "de",
        ton: "direkt-knapp",
        format_pref: "surface-first",
        max_woerter_default: 600,
        duzen: true,
        emojis: false,
      },
      veto_regeln: [{ id: "no-overlays", rule: "Keine Modals" }],
      projekte_aktiv: [{ id: "lazyos", rolle: "greenfield" }],
      sensitive_themen: ["finanzen"],
      exit_ziel: {
        horizon: "12-24-monate",
        beschreibung: "Raus aus GmbH",
        done_signal: "laz.ing produktiv",
      },
    };
    const result = MaxTwinSchema.safeParse(valid);
    assert.equal(result.success, true);
  });

  it("rejects invalid ton value", () => {
    const invalid = {
      version: 1,
      updated_at: "2026-05-01",
      stil: {
        sprache: "de",
        ton: "schreiend", // not in enum
        format_pref: "surface-first",
        max_woerter_default: 600,
        duzen: true,
        emojis: false,
      },
      veto_regeln: [],
      projekte_aktiv: [],
      sensitive_themen: [],
      exit_ziel: {
        horizon: "12-24-monate",
        beschreibung: "x",
        done_signal: "y",
      },
    };
    const result = MaxTwinSchema.safeParse(invalid);
    assert.equal(result.success, false);
  });

  it("rejects invalid date format", () => {
    const invalid = {
      version: 1,
      updated_at: "01.05.2026",
      stil: {
        sprache: "de",
        ton: "direkt-knapp",
        format_pref: "surface-first",
        max_woerter_default: 600,
        duzen: true,
        emojis: false,
      },
      veto_regeln: [],
      projekte_aktiv: [],
      sensitive_themen: [],
      exit_ziel: {
        horizon: "x",
        beschreibung: "x",
        done_signal: "y",
      },
    };
    const result = MaxTwinSchema.safeParse(invalid);
    assert.equal(result.success, false);
  });
});

describe("getOwnerTwin caching", () => {
  before(() => {
    clearOwnerTwinCache();
  });

  it("loads the actual data/owner_twin.yaml", async () => {
    const t = await getOwnerTwin();
    assert.ok(t, "twin should load from data/owner_twin.yaml");
    assert.equal(t!.version, 1);
    assert.equal(t!.stil.duzen, true);
    assert.ok(t!.veto_regeln.length >= 3);
  });

  it("returns the same cached reference on second call", async () => {
    const a = await getOwnerTwin();
    const b = await getOwnerTwin();
    assert.strictEqual(a, b, "same reference on repeated call");
  });
});

describe("formatTwinsForPrompt token budget", () => {
  it("stays under 500 tokens for full owner_twin + null domain", async () => {
    // workspaceId existiert vermutlich nicht in der lokalen DB → DomainTwin
    // wird null, wir testen den User-Twin-Block in Volumen.
    const block = await formatTwinsForPrompt("__nonexistent_ws__");
    const tokens = estimateTokens(block);
    // Soft-Cap 500. Aktueller Twin landet typischerweise <300.
    assert.ok(
      tokens <= 500,
      `expected <=500 tokens, got ${tokens} (chars=${block.length})`,
    );
    // Mindestens der User-Block muss da sein.
    assert.match(block, /<TWIN_USER>/);
    assert.match(block, /<\/TWIN_USER>/);
  });

  it("contains all 5 veto-IDs in compact form", async () => {
    const block = await formatTwinsForPrompt("__nonexistent_ws__");
    assert.match(block, /no-overlays/);
    assert.match(block, /critic-mandatory/);
    assert.match(block, /no-fast-mode/);
    assert.match(block, /no-delete-without-permission/);
    assert.match(block, /chat-mirror-loop-guard/);
  });
});
