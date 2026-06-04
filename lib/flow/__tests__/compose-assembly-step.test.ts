// W1.2 — Assembly-Step-Append Tests (2026-05-30, Opus 4.8).
//
// Deckt ab: bei website-artigem Intent hängt composeFlowFromIntent IMMER einen
// finalen `assembly`-Step an (dependsOn = letzter Step); bei nicht-website-Intent
// NICHT; idempotent (kein zweiter Assembly, wenn der Decompose schon einen lieferte);
// compile.ts mappt 'assembly' → coder.
//
// In-memory better-sqlite3 wie compose.test.ts (echte Migrationen, Stub-Decompose).
//
// Run:
//   NODE_OPTIONS="--experimental-require-module" node_modules/.bin/vitest run \
//     lib/flow/__tests__/compose-assembly-step.test.ts

import { readFileSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import {
  composeFlowFromIntent,
  isWebsiteLikeIntent,
  assignSkill,
  type DecomposedStep,
} from "@/lib/flow/compose";
import { listFlowSteps, type FlowStep } from "@/lib/flow/templates-repo";
import { compileFlowToPlanSteps, mapSkillToRole } from "@/lib/flow/compile";

const MIG = (f: string) => path.join(process.cwd(), "db", "migrations", f);
const MIGRATIONS = [
  "0112_flow_studio.sql",
  "0101_connector_catalog.sql",
  "0100_api_credentials.sql",
];

function freshDb(): import("better-sqlite3").Database {
  const raw = new Database(":memory:");
  raw.pragma("foreign_keys = OFF");
  for (const f of MIGRATIONS) {
    const sql = readFileSync(MIG(f), "utf8");
    try {
      raw.exec(sql);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/duplicate column name/i.test(msg)) throw err;
      for (const stmt of sql.split(/;\s*$/m).map((s) => s.trim())) {
        if (!stmt || stmt.startsWith("--")) continue;
        try {
          raw.exec(stmt);
        } catch (e) {
          const m = e instanceof Error ? e.message : String(e);
          if (!/duplicate column name/i.test(m)) throw e;
        }
      }
    }
  }
  return raw;
}

const websiteDecompose = (): DecomposedStep[] => [
  { title: "Aufbau der Seitenstruktur", rationale: "IA + Routing" },
  { title: "Copy für die Startseite", rationale: "Texte" },
  { title: "Design des visuellen Stils", rationale: "Farben/Typo" },
];

const scriptDecompose = (): DecomposedStep[] => [
  { title: "Daten einlesen", rationale: "CSV laden" },
  { title: "Analyse rechnen", rationale: "Aggregation" },
];

const WS = "ws-assembly-1";

describe("isWebsiteLikeIntent", () => {
  it("erkennt website/webseite/landing/page/site/seite", () => {
    expect(isWebsiteLikeIntent("Erstelle eine Website")).toBe(true);
    expect(isWebsiteLikeIntent("Bau eine Landing Page")).toBe(true);
    expect(isWebsiteLikeIntent("neue seite bitte")).toBe(true);
  });
  it("false für nicht-website", () => {
    expect(isWebsiteLikeIntent("Schreibe ein Skript")).toBe(false);
  });
});

describe("assignSkill — assembly-Regel", () => {
  it("Zusammenbau/Assembly/index.html → assembly", () => {
    expect(assignSkill("Assembly der Gesamtseite").skill).toBe("assembly");
    expect(assignSkill("Zusammenbau zu index.html").skill).toBe("assembly");
  });
});

describe("composeFlowFromIntent — Assembly-Step-Append (W1.2)", () => {
  let raw: import("better-sqlite3").Database;
  beforeEach(() => {
    raw = freshDb();
  });

  it("hängt bei website-Intent einen finalen assembly-Step an (dependsOn=letzter Step)", async () => {
    const res = await composeFlowFromIntent(raw, {
      intent: "Erstelle eine Website für meine Agentur",
      workspaceId: WS,
      decompose: websiteDecompose,
    });
    const steps = listFlowSteps(raw, res.template.id);
    // 3 Decompose-Steps + 1 Assembly.
    expect(steps.length).toBe(4);
    const last = steps[steps.length - 1];
    expect(last.skill).toBe("assembly");
    expect(last.label).toContain("index.html");
    // dependsOn = der vorletzte (Design-)Step.
    const deps = JSON.parse(last.dependsOnJson ?? "[]") as string[];
    expect(deps).toEqual([steps[steps.length - 2].id]);
  });

  it("hängt bei NICHT-website-Intent KEINEN assembly-Step an", async () => {
    const res = await composeFlowFromIntent(raw, {
      intent: "Schreibe ein Analyse-Skript",
      workspaceId: WS,
      decompose: scriptDecompose,
    });
    const steps = listFlowSteps(raw, res.template.id);
    expect(steps.length).toBe(2);
    expect(steps.some((s) => s.skill === "assembly")).toBe(false);
  });

  it("ist idempotent: kein zweiter Assembly, wenn der Decompose schon einen lieferte", async () => {
    const withAssembly = (): DecomposedStep[] => [
      { title: "Aufbau der Seite", rationale: "IA" },
      { title: "Assembly zur Gesamtseite", rationale: "Zusammenbau" },
    ];
    const res = await composeFlowFromIntent(raw, {
      intent: "Erstelle eine Website",
      workspaceId: WS,
      decompose: withAssembly,
    });
    const steps = listFlowSteps(raw, res.template.id);
    expect(steps.filter((s) => s.skill === "assembly").length).toBe(1);
    expect(steps.length).toBe(2);
  });

  it("compile.ts mappt den assembly-Step auf die coder-Rolle", () => {
    expect(mapSkillToRole("assembly", null)).toBe("coder");
  });

  it("der angehängte Assembly-Step kompiliert als letzter Plan-Step (coder)", async () => {
    const res = await composeFlowFromIntent(raw, {
      intent: "Landing Page",
      workspaceId: WS,
      decompose: websiteDecompose,
    });
    const steps: FlowStep[] = listFlowSteps(raw, res.template.id);
    const compiled = compileFlowToPlanSteps(res.template, steps);
    const lastCompiled = compiled[compiled.length - 1];
    expect(lastCompiled.skill).toBe("assembly");
    expect(lastCompiled.subagentRole).toBe("coder");
    // Topologisch zuletzt (hängt am Design-Step).
    expect(lastCompiled.index).toBe(compiled.length - 1);
  });
});
