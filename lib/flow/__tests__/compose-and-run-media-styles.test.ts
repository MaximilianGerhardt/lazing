// Flow Studio — composeAndRun × Medien-Stil-Wahl (Stream B2 · 2026-05-27).
//
// Deckt die additive Stil-Wahl-Verzweigung in lib/flow/compose-and-run.ts ab:
//   (a) Medien-Step (Hero-Video) OHNE styleChoices → status 'needs-style-choice'
//       + quickchoice-Payload mit Optionen (KEIN dispatch, kein workstreams-Run).
//   (b) styleChoice = video-procedural → KEIN Connector-Bedarf → dispatch +
//       status 'running' (auch ohne irgendeinen Connector im Katalog).
//   (c) styleChoice = video-higgsfield, Connector UNVERBUNDEN → needs-coupling
//       mit provider 'higgsfield' (NICHT eigenmächtig heygen — PA-Chat-Befund).
//   (d) styleChoice = video-higgsfield, Connector VERBUNDEN → status 'running'.
//   (e) applyStyleChoice (per-Schritt): procedural ⇒ needsConnector=false;
//       higgsfield ⇒ needsConnector=true + provider higgsfield.
//
// Strategy: in-memory better-sqlite3 aus den echten Migrationen (wie
// compose-and-run.test.ts). Trigger als Spy injiziert, decompose als Stub.
//
// Run:
//   NODE_OPTIONS="--experimental-require-module" node_modules/.bin/vitest run \
//     lib/flow/__tests__/compose-and-run-media-styles.test.ts

import { readFileSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import {
  applyStyleChoice,
  composeAndRun,
  type TriggerFlowExecutionFn,
} from "@/lib/flow/compose-and-run";
import type { DecomposedStep, MediaStep } from "@/lib/flow/compose";

const MIG = (f: string) => path.join(process.cwd(), "db", "migrations", f);

const MIGRATIONS = [
  "0112_flow_studio.sql",
  "0101_connector_catalog.sql",
  "0100_api_credentials.sql",
  "0009_workstreams.sql",
  "0051_workstream_intent.sql",
  "0094_recursive_plans.sql",
  "0107_plan_step_allowed_tools.sql",
  "0110_plan_step_deps_group.sql",
];

function freshDb(): Database.Database {
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

/** Seedet einen voll-verbundenen Connector (Profil + Capability + Credential). */
function seedConnectedConnector(
  raw: Database.Database,
  opts: { provider: string; capabilities: string[]; workspaceId: string },
): void {
  const connId = `CONN-${opts.provider}`;
  raw
    .prepare(
      `INSERT INTO connector_catalog
         (id, provider, display_name, description, auth_kind, base_url,
          api_version, docs_url, source, validated_at, content_hash,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, 'api_key', ?, 'v1', NULL, 'manual', NULL, '', ?, ?)`,
    )
    .run(
      connId,
      opts.provider,
      `${opts.provider} API`,
      `${opts.provider} test connector`,
      `https://api.${opts.provider}.test`,
      Date.now(),
      Date.now(),
    );
  for (const cap of opts.capabilities) {
    raw
      .prepare(
        `INSERT INTO connector_capabilities
           (id, connector_id, name, description, required)
         VALUES (?, ?, ?, NULL, 1)`,
      )
      .run(`CAP-${opts.provider}-${cap}`, connId, cap);
  }
  raw
    .prepare(
      `INSERT INTO api_credentials
         (id, scope_kind, scope_id, provider, credential_kind, encrypted_secret,
          config_json, last_validated_at, content_hash, created_at, updated_at)
       VALUES (?, 'workspace', ?, ?, 'api_key', 'iv:ct:tag', NULL, NULL, '', ?, ?)`,
    )
    .run(
      `CRED-${opts.provider}`,
      opts.workspaceId,
      opts.provider,
      Date.now(),
      Date.now(),
    );
}

const WS = "ws-b2-1";

/** Stub-Decompose mit GENAU einem Video-Tool-Step (assignSkill → tool:video). */
const heroVideoDecompose = (): DecomposedStep[] => [
  { title: "Aufbau der Seitenstruktur", rationale: "IA + Routing" },
  { title: "Hero-Video für die Startseite", rationale: "Bewegtbild oben" },
];

function workstreamCount(raw: Database.Database): number {
  return (
    raw.prepare("SELECT COUNT(*) AS n FROM workstreams").get() as { n: number }
  ).n;
}

describe("composeAndRun — Medien-Step ohne Stil-Wahl → needs-style-choice", () => {
  let raw: Database.Database;
  beforeEach(() => {
    raw = freshDb();
  });

  it("pausiert mit Stil-Optionen, dispatcht NICHT, nimmt KEINEN Provider an", async () => {
    const calls: unknown[] = [];
    const result = await composeAndRun(raw, {
      intent: "Erstelle eine Landingpage mit Hero-Video",
      workspaceId: WS,
      decompose: heroVideoDecompose,
      triggerExecution: (i) => calls.push(i),
    });

    expect(result.status).toBe("needs-style-choice");
    if (result.status === "needs-style-choice") {
      expect(result.flowId).toMatch(/^FLOW-/);
      expect(result.styleChoices).toHaveLength(1);
      const prompt = result.styleChoices[0];
      expect(prompt.step.kind).toBe("video");
      expect(prompt.step.stepTitle).toBe("Hero-Video für die Startseite");
      // Higgsfield ERREICHBAR als Option (Owner-Wunsch), heygen NICHT
      // eigenmächtig vorausgewählt.
      const ids = prompt.payload.options.map((o) => o.id);
      expect(ids).toContain("video-higgsfield");
      expect(ids).toContain("video-procedural");
      expect(ids).toContain("video-scroll-animation");
      expect(prompt.payload.variant).toBe("quickchoice");
    }
    // KEIN dispatch (kein workstreams-Run), Trigger NICHT aufgerufen.
    expect(workstreamCount(raw)).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("auch mit autoRun bleibt die Stil-Wahl eine bewusste Owner-Entscheidung", async () => {
    const result = await composeAndRun(raw, {
      intent: "Erstelle eine Landingpage mit Hero-Video",
      workspaceId: WS,
      autoRun: true, // überspringt needs-coupling, NICHT needs-style-choice
      decompose: heroVideoDecompose,
      triggerExecution: () => {},
    });
    expect(result.status).toBe("needs-style-choice");
    expect(workstreamCount(raw)).toBe(0);
  });
});

describe("composeAndRun — Stil-Wahl procedural → kein Connector → running", () => {
  it("video-procedural dispatcht ohne jeden Connector im Katalog", async () => {
    const raw = freshDb(); // KEIN Connector geseedet.
    const calls: Array<{ workstreamId: string; workspaceId: string }> = [];
    const trigger: TriggerFlowExecutionFn = (i) => calls.push(i);

    // 1. Lauf → needs-style-choice, um die echte stepId zu bekommen.
    const first = await composeAndRun(raw, {
      intent: "Erstelle eine Landingpage mit Hero-Video",
      workspaceId: WS,
      decompose: heroVideoDecompose,
      triggerExecution: trigger,
    });
    expect(first.status).toBe("needs-style-choice");
    if (first.status !== "needs-style-choice") return;
    // Re-Compose-Pfad: über den STABILEN idx schlüsseln (die ULID-stepId wäre
    // beim zweiten Compose neu). idx ist deterministisch (Hero-Video = idx 1).
    const idx = first.styleChoices[0].step.idx;

    // 2. Lauf MIT Stil-Wahl procedural → kein Connector-Bedarf → running.
    const second = await composeAndRun(raw, {
      intent: "Erstelle eine Landingpage mit Hero-Video",
      workspaceId: WS,
      decompose: heroVideoDecompose,
      triggerExecution: trigger,
      styleChoices: { [String(idx)]: "video-procedural" },
    });
    expect(second.status).toBe("running");
    if (second.status === "running") {
      expect(second.workstreamId).toMatch(/^WS-/);
    }
    expect(calls).toHaveLength(1);
  });
});

describe("composeAndRun — Stil-Wahl higgsfield → needs-coupling provider higgsfield", () => {
  it("verlangt die higgsfield-Kopplung (NICHT eigenmächtig heygen)", async () => {
    const raw = freshDb(); // higgsfield UNVERBUNDEN.
    const first = await composeAndRun(raw, {
      intent: "Erstelle eine Landingpage mit Hero-Video",
      workspaceId: WS,
      decompose: heroVideoDecompose,
      triggerExecution: () => {},
    });
    if (first.status !== "needs-style-choice") throw new Error("expected style-choice");
    const idx = first.styleChoices[0].step.idx;

    const result = await composeAndRun(raw, {
      intent: "Erstelle eine Landingpage mit Hero-Video",
      workspaceId: WS,
      decompose: heroVideoDecompose,
      triggerExecution: () => {},
      styleChoices: { [String(idx)]: "video-higgsfield" },
    });
    expect(result.status).toBe("needs-coupling");
    if (result.status === "needs-coupling") {
      expect(result.missingTools).toHaveLength(1);
      expect(result.missingTools[0].provider).toBe("higgsfield");
      expect(result.missingTools[0].neededCapabilities).toEqual(["video.motion"]);
    }
    expect(workstreamCount(raw)).toBe(0);
  });

  it("higgsfield VERBUNDEN → running (Kopplung erfüllt)", async () => {
    const raw = freshDb();
    seedConnectedConnector(raw, {
      provider: "higgsfield",
      capabilities: ["video.motion"],
      workspaceId: WS,
    });
    const first = await composeAndRun(raw, {
      intent: "Erstelle eine Landingpage mit Hero-Video",
      workspaceId: WS,
      decompose: heroVideoDecompose,
      triggerExecution: () => {},
    });
    if (first.status !== "needs-style-choice") throw new Error("expected style-choice");
    const idx = first.styleChoices[0].step.idx;

    const result = await composeAndRun(raw, {
      intent: "Erstelle eine Landingpage mit Hero-Video",
      workspaceId: WS,
      decompose: heroVideoDecompose,
      triggerExecution: () => {},
      styleChoices: { [String(idx)]: "video-higgsfield" },
    });
    expect(result.status).toBe("running");
    expect(workstreamCount(raw)).toBe(1);
  });
});

describe("applyStyleChoice — per-Schritt Auflösung", () => {
  const videoStep: MediaStep = {
    stepId: "FSTEP-x",
    idx: 1,
    stepTitle: "Hero-Video",
    skill: "tool:video",
    kind: "video",
  };

  it("procedural ⇒ needsConnector=false", () => {
    const r = applyStyleChoice(videoStep, "video-procedural");
    expect(r.needsConnector).toBe(false);
    expect(r.provider).toBeNull();
  });

  it("higgsfield ⇒ needsConnector=true + provider higgsfield + video.motion", () => {
    const r = applyStyleChoice(videoStep, "video-higgsfield");
    expect(r.needsConnector).toBe(true);
    expect(r.provider).toBe("higgsfield");
    expect(r.neededCapabilities).toEqual(["video.motion"]);
  });
});
