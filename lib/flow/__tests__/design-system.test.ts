// W2.1 — Verbindliches Website-Design-System Tests (2026-05-30, Opus 4.8).
//
// Deckt ab: Token-Spiegel aus globals.css (kein neuer Hex), Sektions-Katalog,
// Prompt-Rendering (verbindlicher Block), Akzent-Wahl-Parser.
//
// Run:
//   NODE_OPTIONS="--experimental-require-module" node_modules/.bin/vitest run \
//     lib/flow/__tests__/design-system.test.ts

import { describe, expect, it } from "vitest";

import {
  WEBSITE_DESIGN_SYSTEM,
  renderDesignSystemPrompt,
  parseChosenAccent,
} from "@/lib/flow/design-system";

describe("WEBSITE_DESIGN_SYSTEM — fixes Apple-grade Set", () => {
  it("hat die geforderte 4-basierte Spacing-Scale", () => {
    expect([...WEBSITE_DESIGN_SYSTEM.spacing]).toEqual([
      4, 8, 12, 16, 24, 32, 48, 64,
    ]);
  });

  it("spiegelt die Farb-Tokens 1:1 aus globals.css :root (kein neuer Hex)", () => {
    // Stichproben gegen die kanonischen globals.css-Werte.
    expect(WEBSITE_DESIGN_SYSTEM.colors.sheet).toBe("#070707");
    expect(WEBSITE_DESIGN_SYSTEM.colors.ink).toBe("#F5F5F7");
    expect(WEBSITE_DESIGN_SYSTEM.colors["ink-2"]).toBe("#A1A1A6");
    expect(WEBSITE_DESIGN_SYSTEM.accents.own).toBe("#BF5AF2");
    expect(WEBSITE_DESIGN_SYSTEM.accents.north).toBe("#FF9F0A");
  });

  it("Type-Scale nutzt SF Pro Display mit engem Tracking", () => {
    expect(WEBSITE_DESIGN_SYSTEM.fonts.display).toContain("SF Pro Display");
    expect(WEBSITE_DESIGN_SYSTEM.typeScale.display.letterSpacing).toBe("-0.02em");
    expect(WEBSITE_DESIGN_SYSTEM.typeScale.body.letterSpacing).toBe("-0.01em");
  });

  it("hat den fixen Sektions-Katalog hero/features/proof/cta/footer mit Layout-Contract", () => {
    const keys = WEBSITE_DESIGN_SYSTEM.sections.map((s) => s.key);
    expect(keys).toEqual(["hero", "features", "proof", "cta", "footer"]);
    for (const s of WEBSITE_DESIGN_SYSTEM.sections) {
      expect(s.layout.length).toBeGreaterThan(20); // jeder hat einen echten Contract
      expect(s.contentFields.length).toBeGreaterThan(0);
    }
  });

  it("ist frozen (kein Step kann das System mutieren)", () => {
    expect(Object.isFrozen(WEBSITE_DESIGN_SYSTEM)).toBe(true);
    expect(Object.isFrozen(WEBSITE_DESIGN_SYSTEM.colors)).toBe(true);
    expect(Object.isFrozen(WEBSITE_DESIGN_SYSTEM.sections)).toBe(true);
  });
});

describe("renderDesignSystemPrompt", () => {
  it("rendert einen verbindlichen Block mit Tokens, Type-Scale und Sektionen", () => {
    const out = renderDesignSystemPrompt();
    expect(out).toContain("VERBINDLICHES DESIGN-SYSTEM");
    expect(out).toContain("--ink: #F5F5F7");
    expect(out).toContain("Spacing-Scale (px, NUR diese): 4, 8, 12, 16, 24, 32, 48, 64");
    expect(out).toContain("[hero] Hero");
    expect(out).toContain("[footer] Footer");
  });

  it("markiert den gewählten Akzent (Default own)", () => {
    expect(renderDesignSystemPrompt("north")).toContain("← GEWÄHLT");
    const def = renderDesignSystemPrompt();
    // Default ist 'own' → dessen Hex ist der aktive Akzent.
    expect(def).toContain("Aktiver Akzent: --accent: #BF5AF2");
  });

  it("fällt bei unbekanntem Akzent auf own zurück", () => {
    const out = renderDesignSystemPrompt("does-not-exist");
    expect(out).toContain("Aktiver Akzent: --accent: #BF5AF2");
  });
});

describe("parseChosenAccent", () => {
  it("liest 'accent: own' aus dem design-Step-Output", () => {
    expect(parseChosenAccent("Ich nutze accent: own für die Marke")).toBe("own");
  });

  it("liest '--accent-north' / '/* accent: north */'", () => {
    expect(parseChosenAccent("/* accent: north */")).toBe("north");
    expect(parseChosenAccent("setze --accent-private überall")).toBe("private");
  });

  it("erkennt einen blank erwähnten Key", () => {
    expect(parseChosenAccent("Der clientb-Akzent passt am besten")).toBe("clientb");
  });

  it("Default 'own' bei leerem/unbekanntem Output", () => {
    expect(parseChosenAccent(undefined)).toBe("own");
    expect(parseChosenAccent("kein hinweis")).toBe("own");
  });
});
