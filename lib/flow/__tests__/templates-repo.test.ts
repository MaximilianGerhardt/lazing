// Flow-Templates-Repo tests — Flow Studio P1 · 2026-05-27.
//
// Strategy: in-memory better-sqlite3 DB, schema aus der ECHTEN Migration
// db/migrations/0112_flow_studio.sql via readFileSync geladen (beweist
// nebenbei, dass die Migration-SQL gültig ist + idempotent re-applyt). Das
// Repo nimmt ein rohes DB-Handle entgegen — kein getDb()-Singleton, kein
// vi.mock nötig.
//
// Run:
//   NODE_OPTIONS="--experimental-require-module" node_modules/.bin/vitest run \
//     lib/flow/__tests__/templates-repo.test.ts

import { readFileSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import {
  addFlowStep,
  createFlowRun,
  createFlowTemplate,
  getFlowTemplate,
  listFlowSteps,
  listFlowTemplates,
} from "@/lib/flow/templates-repo";

const MIGRATION = path.join(
  process.cwd(),
  "db",
  "migrations",
  "0112_flow_studio.sql",
);

function freshDb(): import("better-sqlite3").Database {
  const raw = new Database(":memory:");
  const sql = readFileSync(MIGRATION, "utf8");
  raw.exec(sql);
  // Re-apply once → confirm IF NOT EXISTS idempotency.
  raw.exec(sql);
  return raw;
}

describe("flow templates-repo", () => {
  let raw: import("better-sqlite3").Database;
  beforeEach(() => {
    raw = freshDb();
  });

  it("create / get template roundtrip", () => {
    const t = createFlowTemplate(raw, {
      workspaceId: "ws-1",
      name: "Reel-Pipeline",
      description: "Bild → Motion → Avatar",
      graphJson: JSON.stringify({ nodes: [], edges: [] }),
    });
    expect(t.id).toMatch(/^FLOW-/);
    expect(t.workspaceId).toBe("ws-1");
    expect(t.sopId).toBeNull();

    const got = getFlowTemplate(raw, t.id);
    expect(got).not.toBeNull();
    expect(got!.name).toBe("Reel-Pipeline");
    expect(got!.description).toBe("Bild → Motion → Avatar");
    expect(got!.graphJson).toBe(JSON.stringify({ nodes: [], edges: [] }));
  });

  it("getFlowTemplate returns null for unknown id", () => {
    expect(getFlowTemplate(raw, "FLOW-nope")).toBeNull();
  });

  it("sopId soft-FK roundtrips (Flow KANN eine SOP sein)", () => {
    const t = createFlowTemplate(raw, {
      name: "SOP-Flow",
      sopId: "SOP-abc",
    });
    expect(getFlowTemplate(raw, t.id)!.sopId).toBe("SOP-abc");
  });

  it("listFlowTemplates is workspace-scoped (and global for null)", () => {
    createFlowTemplate(raw, { workspaceId: "ws-1", name: "A" });
    createFlowTemplate(raw, { workspaceId: "ws-2", name: "B" });
    createFlowTemplate(raw, { workspaceId: null, name: "Global" });

    const ws1 = listFlowTemplates(raw, "ws-1");
    expect(ws1.map((t) => t.name)).toEqual(["A"]);

    const globals = listFlowTemplates(raw, null);
    expect(globals.map((t) => t.name)).toEqual(["Global"]);
  });

  it("addStep / listSteps roundtrip, ordered by idx", () => {
    const t = createFlowTemplate(raw, { name: "Steps" });
    const s2 = addFlowStep(raw, {
      flowId: t.id,
      idx: 2,
      label: "Avatar",
      skill: "design",
      toolKind: "connector",
      connectorId: "heygen",
    });
    const s1 = addFlowStep(raw, {
      flowId: t.id,
      idx: 1,
      label: "Bild",
      skill: "design",
      toolKind: "connector",
      connectorId: "imagegen2",
    });

    expect(s1.id).toMatch(/^FSTEP-/);
    const steps = listFlowSteps(raw, t.id);
    expect(steps.map((s) => s.label)).toEqual(["Bild", "Avatar"]);
    expect(steps[1].id).toBe(s2.id);
    expect(steps[0].connectorId).toBe("imagegen2");
  });

  it("addStep serializes dependsOn array to JSON", () => {
    const t = createFlowTemplate(raw, { name: "Deps" });
    const a = addFlowStep(raw, { flowId: t.id, idx: 0, label: "A" });
    const b = addFlowStep(raw, {
      flowId: t.id,
      idx: 1,
      label: "B",
      dependsOn: [a.id],
    });
    expect(b.dependsOnJson).toBe(JSON.stringify([a.id]));
    // empty array → null
    const c = addFlowStep(raw, { flowId: t.id, idx: 2, dependsOn: [] });
    expect(c.dependsOnJson).toBeNull();
  });

  it("listFlowSteps is scoped to one flow", () => {
    const t1 = createFlowTemplate(raw, { name: "T1" });
    const t2 = createFlowTemplate(raw, { name: "T2" });
    addFlowStep(raw, { flowId: t1.id, idx: 0, label: "x" });
    addFlowStep(raw, { flowId: t2.id, idx: 0, label: "y" });
    expect(listFlowSteps(raw, t1.id)).toHaveLength(1);
    expect(listFlowSteps(raw, t1.id)[0].label).toBe("x");
  });

  it("createFlowRun persists + bridges to a workstream", () => {
    const t = createFlowTemplate(raw, { name: "Run me" });
    const run = createFlowRun(raw, {
      flowId: t.id,
      workspaceId: "ws-1",
      workstreamId: "WS-123",
      status: "running",
    });
    expect(run.id).toMatch(/^FRUN-/);
    expect(run.status).toBe("running");
    expect(run.workstreamId).toBe("WS-123");

    const persisted = raw
      .prepare("SELECT * FROM flow_runs WHERE id = ?")
      .get(run.id) as Record<string, unknown>;
    expect(persisted.workstream_id).toBe("WS-123");
    expect(persisted.flow_id).toBe(t.id);
  });

  it("createFlowRun defaults status to pending + nullable bridge", () => {
    const run = createFlowRun(raw, { flowId: "FLOW-x" });
    expect(run.status).toBe("pending");
    expect(run.workstreamId).toBeNull();
  });

  it("createFlowTemplate throws on empty name", () => {
    expect(() => createFlowTemplate(raw, { name: "" })).toThrow(/name required/);
  });
});
