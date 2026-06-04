// Flow Studio — Compose-and-Run Spine tests (Track-D · 2026-05-27).
//
// Deckt die Kern-Funktion lib/flow/compose-and-run.ts::composeAndRun ab:
//   (a) kein missingTool (alle tool-Steps verbunden) → status 'running' +
//       dispatchFlow lief (workstreams/flow_runs/plan-steps angelegt) +
//       Execution-Trigger AUFGERUFEN (Spy).
//   (b) reiner Decompose ohne tool-Steps → status 'running' (kein Connector
//       nötig) + Trigger aufgerufen.
//   (c) mit missingTool (unverbundener tool-Step, kein autoRun) → status
//       'needs-coupling' + KEIN dispatch (kein workstreams-Run) + Trigger NICHT
//       aufgerufen.
//   (d) mit missingTool ABER autoRun:true → status 'running' (Owner-Override),
//       Trigger aufgerufen.
//   (e) resolvePlanId liest die echte planId aus den dispatchten root-Steps.
//   (f) runDispatchedFlow auf unbekannter flowId → FlowDispatchError.
//
// Strategy: in-memory better-sqlite3 DB aus den ECHTEN Migrationen (kein
// getDb()-Singleton, kein vi.mock — composeAndRun nimmt das rohe Handle). Der
// Execution-Trigger wird als Spy injiziert → KEIN echter Background-Run, kein
// LLM. decompose wird als Stub injiziert.
//
// Run:
//   NODE_OPTIONS="--experimental-require-module" node_modules/.bin/vitest run \
//     lib/flow/__tests__/compose-and-run.test.ts

import { readFileSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  composeAndRun,
  resolvePlanId,
  runDispatchedFlow,
  type TriggerFlowExecutionFn,
} from "@/lib/flow/compose-and-run";
import type { DecomposedStep } from "@/lib/flow/compose";
import { FlowDispatchError } from "@/lib/flow/execute";

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

const WS = "ws-car-1";

/** Stub-Decompose mit GENAU einem Foto-Tool-Step (Provider-Hint imagegen2). */
const photoDecompose = (): DecomposedStep[] => [
  { title: "Aufbau der Seitenstruktur", rationale: "IA + Routing" },
  { title: "Fotos für die Hero-Section", rationale: "Bilder generieren" },
];

/** Stub-Decompose OHNE jeden Tool-Step (rein textuell). */
const noToolDecompose = (): DecomposedStep[] => [
  { title: "Aufbau der Seitenstruktur", rationale: "IA + Routing" },
  { title: "Copy für die Startseite", rationale: "Headline + Body" },
];

/** Zählt die workstreams-Rows (Indikator: lief dispatchFlow?). */
function workstreamCount(raw: Database.Database): number {
  return (
    raw.prepare("SELECT COUNT(*) AS n FROM workstreams").get() as { n: number }
  ).n;
}

describe("composeAndRun — connected tool → running + trigger called", () => {
  let raw: Database.Database;
  let triggerCalls: Array<{ workstreamId: string; workspaceId: string }>;
  let trigger: TriggerFlowExecutionFn;

  beforeEach(() => {
    raw = freshDb();
    // imagegen2 voll verbunden (Profil + Capability image.generate + Credential).
    // Cap-Name = kanonischer P5-Key 'image.generate' (NICHT 'generate_image' —
    // validateCoverage matcht EXAKT; 'generate_image' liess den Connector
    // unerreichbar (pre-existing Drift) → die Wahl muss den echten Key tragen).
    seedConnectedConnector(raw, {
      provider: "imagegen2",
      capabilities: ["image.generate"],
      workspaceId: WS,
    });
    triggerCalls = [];
    trigger = (i) => triggerCalls.push(i);
  });

  it("dispatcht + triggert, wenn alle tool-Steps verbunden sind", async () => {
    const result = await composeAndRun(raw, {
      intent: "Erstelle eine Webseite mit Hero-Fotos",
      workspaceId: WS,
      decompose: photoDecompose,
      triggerExecution: trigger,
      // Stream B2: Foto-Step (idx 1) → KI-Stil (imagegen2) gewählt, damit der
      // Connector-Pfad (verbunden → running) statt needs-style-choice greift.
      styleChoices: { "1": "image-imagegen2" },
    });

    expect(result.status).toBe("running");
    if (result.status === "running") {
      expect(result.flowId).toMatch(/^FLOW-/);
      expect(result.runId).toMatch(/^FRUN-/);
      expect(result.workstreamId).toMatch(/^WS-/);
    }
    // dispatchFlow lief → genau ein workstreams-Run.
    expect(workstreamCount(raw)).toBe(1);
    // Execution-Trigger wurde GENAU EINMAL mit der workstreamId aufgerufen.
    expect(triggerCalls).toHaveLength(1);
    if (result.status === "running") {
      expect(triggerCalls[0].workstreamId).toBe(result.workstreamId);
      expect(triggerCalls[0].workspaceId).toBe(WS);
    }
  });
});

describe("composeAndRun — no tool steps → running", () => {
  it("läuft ohne jeden Connector (reiner Text-Flow)", async () => {
    const raw = freshDb();
    const calls: string[] = [];
    const result = await composeAndRun(raw, {
      intent: "Plane meine Woche",
      workspaceId: WS,
      decompose: noToolDecompose,
      triggerExecution: (i) => calls.push(i.workstreamId),
    });
    expect(result.status).toBe("running");
    expect(workstreamCount(raw)).toBe(1);
    expect(calls).toHaveLength(1);
  });
});

describe("composeAndRun — missing tool, no autoRun → needs-coupling, NO dispatch", () => {
  it("pausiert für die Kopplung, dispatcht NICHT, triggert NICHT", async () => {
    const raw = freshDb(); // KEIN Connector geseedet → imagegen2 unverbunden.
    const calls: unknown[] = [];
    const result = await composeAndRun(raw, {
      intent: "Erstelle eine Webseite mit Hero-Fotos",
      workspaceId: WS,
      decompose: photoDecompose,
      triggerExecution: (i) => calls.push(i),
      // Stream B2: KI-Stil (imagegen2) gewählt → connector-Bedarf bleibt; der
      // Connector ist NICHT geseedet → needs-coupling (wie zuvor).
      styleChoices: { "1": "image-imagegen2" },
    });

    expect(result.status).toBe("needs-coupling");
    if (result.status === "needs-coupling") {
      expect(result.flowId).toMatch(/^FLOW-/);
      expect(result.missingTools.length).toBeGreaterThan(0);
      expect(result.missingTools[0].provider).toBe("imagegen2");
    }
    // KEIN dispatch → kein workstreams-Run.
    expect(workstreamCount(raw)).toBe(0);
    // Trigger NICHT aufgerufen.
    expect(calls).toHaveLength(0);
  });
});

describe("composeAndRun — missing tool BUT autoRun → running (owner override)", () => {
  it("dispatcht + triggert trotz missingTool, wenn autoRun gesetzt ist", async () => {
    const raw = freshDb(); // unverbunden.
    const calls: unknown[] = [];
    const result = await composeAndRun(raw, {
      intent: "Erstelle eine Webseite mit Hero-Fotos",
      workspaceId: WS,
      autoRun: true,
      decompose: photoDecompose,
      triggerExecution: (i) => calls.push(i),
      // Stream B2: KI-Stil gewählt → connector-Bedarf; autoRun überspringt die
      // needs-coupling-Pause (Owner-Override) → running (wie zuvor).
      styleChoices: { "1": "image-imagegen2" },
    });
    expect(result.status).toBe("running");
    expect(workstreamCount(raw)).toBe(1);
    expect(calls).toHaveLength(1);
  });
});

describe("resolvePlanId + runDispatchedFlow", () => {
  it("resolvePlanId liefert die echte planId der dispatchten root-Steps", async () => {
    const raw = freshDb();
    let captured: string | null = null;
    const trigger: TriggerFlowExecutionFn = ({ workstreamId }) => {
      captured = resolvePlanId(raw, workstreamId);
    };
    const result = await composeAndRun(raw, {
      intent: "Plane meine Woche",
      workspaceId: WS,
      decompose: noToolDecompose,
      triggerExecution: trigger,
    });
    expect(result.status).toBe("running");
    expect(captured).toMatch(/^PLAN-/);
  });

  it("runDispatchedFlow auf unbekannter flowId wirft FlowDispatchError", () => {
    const raw = freshDb();
    expect(() =>
      runDispatchedFlow(raw, {
        flowId: "FLOW-does-not-exist",
        workspaceId: WS,
        trigger: () => {},
      }),
    ).toThrow(FlowDispatchError);
  });
});

describe("composeAndRun — default trigger does not crash (lazy import path)", () => {
  it("makeDefaultTrigger-Pfad wirft nicht synchron (Background-Run ist best-effort)", async () => {
    const raw = freshDb();
    // KEIN triggerExecution → makeDefaultTrigger(db). Der echte executePlan läuft
    // im Hintergrund (lazy import, void). Der synchrone Rückgabewert MUSS sofort
    // 'running' sein, ohne dass der Hintergrund-Lauf die Antwort blockiert/killt.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await composeAndRun(raw, {
      intent: "Plane meine Woche",
      workspaceId: WS,
      decompose: noToolDecompose,
    });
    expect(result.status).toBe("running");
    errSpy.mockRestore();
  });
});
