// W1.1 / W2.1 — Artefakt-Vertrag + Website-Intent-Erkennung Tests
// (2026-05-30, Opus 4.8 · Plan eager-orbiting-avalanche.md).
//
// Deckt die pure, deterministische Vertrag-Heuristik ab (Pfad pro Skill/Rolle)
// + die Website-Intent-Erkennung (Trigger der Vorwärts-Verkettung). Die
// Integration (Diff-Gate, Spawn-Prompt) läuft im Parallel-Exec-Test bzw. E2E.
//
// Run:
//   NODE_OPTIONS="--experimental-require-module" node_modules/.bin/vitest run \
//     lib/workstreams/__tests__/plan-executor-artifact-contract.test.ts

import { describe, expect, it } from "vitest";

import {
  describeArtifactContract,
  isWebsiteIntent,
} from "@/lib/workstreams/plan-executor";

describe("describeArtifactContract — verbindlicher Ziel-Pfad pro Skill", () => {
  it("design → design/tokens.css (CSS-Custom-Properties, KEINE .md)", () => {
    const c = describeArtifactContract("design", "Design des visuellen Stils");
    expect(c).toContain("design/tokens.css");
    expect(c).toContain("CSS-Custom-Properties");
    expect(c).not.toMatch(/\.md\b/);
  });

  it("copywriting → content/site.config.json", () => {
    const c = describeArtifactContract("copy", "Copy für die Startseite");
    expect(c).toContain("content/site.config.json");
    expect(c).toContain("JSON");
  });

  it("architecture/aufbau → index.html-Gerüst", () => {
    const c = describeArtifactContract("architect", "Aufbau der Seitenstruktur");
    expect(c).toContain("index.html");
    expect(c).toContain("Gerüst");
  });

  it("coder → konkrete Datei im Workspace-Root (keine Markdown-Notiz)", () => {
    const c = describeArtifactContract("coder", "Hero-Sektion bauen");
    expect(c).toContain("Workspace-Root");
    expect(c).toContain("Write");
  });

  it("assembly → index.html im Workspace-Root, liest alle Fragmente", () => {
    const c = describeArtifactContract("assembly", "Assembly zur Gesamtseite");
    expect(c).toContain("index.html");
    expect(c).toContain("design/tokens.css");
    expect(c).toContain("content/site.config.json");
  });

  it("reviewer/tester → kein erzwungenes Datei-Artefakt (null)", () => {
    expect(describeArtifactContract("reviewer", "Review der Seite")).toBeNull();
    expect(describeArtifactContract("tester", "Tests schreiben")).toBeNull();
  });

  it("Titel-Heuristik greift auch bei generischer Rolle", () => {
    // Rolle 'reviewer', aber der Titel ruft eindeutig nach einem design-Artefakt.
    const c = describeArtifactContract("reviewer", "Visuelles Theme + Farben");
    expect(c).toContain("design/tokens.css");
  });
});

describe("isWebsiteIntent — Trigger der Design-System-Verkettung", () => {
  it("erkennt website/webseite/landing/page/site", () => {
    for (const i of [
      "Erstelle eine Website für meine Agentur",
      "Bau mir eine Webseite",
      "Landing Page für das Produkt",
      "eine neue homepage bitte",
      "a simple site",
    ]) {
      expect(isWebsiteIntent(i)).toBe(true);
    }
  });

  it("ist false für nicht-website Intents", () => {
    expect(isWebsiteIntent("Schreibe ein Python-Skript")).toBe(false);
    expect(isWebsiteIntent("Analysiere die Verkaufszahlen")).toBe(false);
    expect(isWebsiteIntent("")).toBe(false);
  });
});
