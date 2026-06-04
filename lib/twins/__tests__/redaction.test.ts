/**
 * Privacy-Sprint V1 (2026-05-01) — Tests für Workspace-aware Twin-Redaction.
 *
 * Critic-VETO V1: Sub-Agents in low-sensitivity-Kunden-Workspaces durften
 * the owner's private twin (legal cases, personal finances, disputes).
 * Diese Tests sichern die Redaction.
 *
 * Run:
 *   npx tsx --test --test-force-exit lib/twins/__tests__/redaction.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

// Skip DB-Init in domain-twin.ts — wir testen Pure-Functions.
process.env.LAZYOS_TWIN_SKIP_DB = "1";

import { redactOwnerTwinForWorkspace } from "../redaction";
import { estimateTokens, formatTwinsForPrompt } from "../format-for-prompt";
import type { DomainTwin, OwnerTwin } from "../types";

const FIXTURE_TWIN: OwnerTwin = {
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
  veto_regeln: [
    { id: "no-overlays", rule: "Keine Modals" },
    { id: "critic-mandatory", rule: "Critic Pflicht" },
  ],
  projekte_aktiv: [
    { id: "lazyos", rolle: "greenfield" },
    { id: "demo-fitness", rolle: "kunde" },
    { id: "private-case", rolle: "persoenlich-rechtlich", sensitivity: "high" },
  ],
  sensitive_themen: [
    "private-finance",
    "legal-case",
    "kunden-credentials",
    "api-keys",
    "personal-finance",
  ],
  exit_ziel: {
    horizon: "12-24-monate",
    beschreibung: "Raus aus GmbH",
    done_signal: "laz.ing produktiv",
  },
};

const HIGH_DOMAIN: DomainTwin = {
  workspaceId: "ws_user_private",
  workspaceLabel: "Privates",
  workspaceType: "personal",
  sensitivity: "high",
  accent: null,
  activeWorkstreams: 1,
  recentDecisions: [],
  openTicketsP0P1: 0,
};

const LOW_DOMAIN: DomainTwin = {
  workspaceId: "ws_demo_fitness",
  workspaceLabel: "Demo Fitness Fitness",
  workspaceType: "client",
  sensitivity: "low",
  accent: "client",
  activeWorkstreams: 2,
  recentDecisions: [],
  openTicketsP0P1: 1,
};

describe("redactOwnerTwinForWorkspace", () => {
  it("liefert vollen Twin für high-sensitivity-Workspace", () => {
    const out = redactOwnerTwinForWorkspace(FIXTURE_TWIN, HIGH_DOMAIN);
    assert.equal(out.projekte_aktiv.length, 3, "alle 3 Projekte da");
    assert.equal(out.sensitive_themen.length, 5, "alle 5 Themen da");
    assert.ok(
      out.sensitive_themen.includes("legal-case"),
      "high-Workspace: legal-case erlaubt",
    );
    assert.ok(
      out.projekte_aktiv.some((p) => p.id === "private-case"),
      "high-Workspace: private-case erlaubt",
    );
  });

  it("redigiert sensitive_themen + projekte für low-sensitivity-Workspace", () => {
    const out = redactOwnerTwinForWorkspace(FIXTURE_TWIN, LOW_DOMAIN);
    // sensitive_themen: nur safe-labels
    assert.deepEqual(
      [...out.sensitive_themen].sort(),
      ["api-keys", "kunden-credentials"].sort(),
      "low-Workspace: nur safe-Themen erlaubt",
    );
    assert.ok(
      !out.sensitive_themen.includes("legal-case"),
      "low-Workspace: legal-case entfernt",
    );
    assert.ok(
      !out.sensitive_themen.includes("personal-finance"),
      "low-Workspace: personal-finance entfernt",
    );
    assert.ok(
      !out.sensitive_themen.includes("private-finance"),
      "low-Workspace: private-finance entfernt",
    );
    // projekte_aktiv: keine sensitivity:high mehr
    assert.ok(
      !out.projekte_aktiv.some((p) => p.id === "private-case"),
      "low-Workspace: private-case-Projekt entfernt",
    );
    assert.equal(
      out.projekte_aktiv.length,
      2,
      "nur lazyos+demo-fitness übrig",
    );
  });

  it("redigiert auch wenn DomainTwin null ist (fail-safe default)", () => {
    const out = redactOwnerTwinForWorkspace(FIXTURE_TWIN, null);
    assert.deepEqual(
      [...out.sensitive_themen].sort(),
      ["api-keys", "kunden-credentials"].sort(),
      "null-domain → wie low-Workspace",
    );
    assert.ok(
      !out.projekte_aktiv.some((p) => p.sensitivity === "high"),
    );
  });

  it("mutiert den Input-Twin nicht", () => {
    const before = JSON.stringify(FIXTURE_TWIN);
    redactOwnerTwinForWorkspace(FIXTURE_TWIN, LOW_DOMAIN);
    const after = JSON.stringify(FIXTURE_TWIN);
    assert.equal(before, after, "Input-Twin unverändert");
  });
});

describe("formatTwinsForPrompt — Redaction-Integration", () => {
  it("low-Workspace: Twin-Output enthält keine sensitiven Strings", async () => {
    // Wir benutzen einen ws-id der in der DB nicht existiert (LAZYOS_TWIN_SKIP_DB=1).
    // → DomainTwin ist null → Redaction ist aktiv (Default-Path).
    const block = await formatTwinsForPrompt("__nonexistent_low_ws__");
    assert.ok(
      block.length > 0,
      "TWIN-Block wird trotz redaction emittiert",
    );
    // Diese Strings stammen aus dem privaten Teil des owner_twin.yaml und dürfen
    // niemals in einem nicht-high-Workspace im Prompt landen.
    assert.ok(
      !block.includes("legal-case"),
      "legal-case NICHT im Output",
    );
    assert.ok(
      !block.includes("private-case"),
      "private-case NICHT im Output",
    );
    assert.ok(
      !block.includes("private-finance"),
      "private-finance NICHT im Output",
    );
    assert.ok(
      !block.includes("personal-finance"),
      "personal-finance NICHT im Output",
    );
  });

  it("Token-Budget bleibt < 500 auch nach Redaction", async () => {
    const block = await formatTwinsForPrompt("__nonexistent_low_ws__");
    const tokens = estimateTokens(block);
    assert.ok(
      tokens <= 500,
      `expected <=500 tokens, got ${tokens} (chars=${block.length})`,
    );
  });
});
