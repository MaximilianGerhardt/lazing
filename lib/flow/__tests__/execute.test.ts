// Flow → Run Ausführungs-Brücke tests — Flow Studio P2 · 2026-05-27.
//
// Strategy: in-memory better-sqlite3 DB, Schema aus den ECHTEN Migrationen via
// readFileSync (kein getDb()-Singleton, kein vi.mock). dispatchFlow nimmt — wie
// die gesamte P1-Surface — ein rohes Database-Handle. Wir laden genau die
// Tabellen, in die dispatchFlow schreibt:
//   - 0009 workstreams (Basis)        + 0051 workstream_intent (intent-Spalte)
//   - 0094 workstream_plan_steps      + 0107 allowed_tools + 0110 deps_group
//   - 0112 flow_studio (flow_templates/steps/runs)
//
// Run:
//   NODE_OPTIONS="--experimental-require-module" node_modules/.bin/vitest run \
//     lib/flow/__tests__/execute.test.ts

import { readFileSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import { addFlowStep, createFlowTemplate } from "@/lib/flow/templates-repo";
import { dispatchFlow, FlowDispatchError } from "@/lib/flow/execute";
import { FlowCycleError } from "@/lib/flow/compile";

const MIG = (f: string) =>
  path.join(process.cwd(), "db", "migrations", f);

const MIGRATIONS = [
  "0009_workstreams.sql",
  "0051_workstream_intent.sql",
  "0094_recursive_plans.sql",
  "0107_plan_step_allowed_tools.sql",
  "0110_plan_step_deps_group.sql",
  "0112_flow_studio.sql",
];

function freshDb(): import("better-sqlite3").Database {
  const raw = new Database(":memory:");
  // FK off — wie der lazyos Test-Pfad (Orphan-Scope-Rows toleriert).
  raw.pragma("foreign_keys = OFF");
  for (const f of MIGRATIONS) {
    const sql = readFileSync(MIG(f), "utf8");
    try {
      raw.exec(sql);
    } catch (err) {
      // 0110 = ALTER TABLE ADD COLUMN (nicht idempotent) → per-statement,
      // duplicate-column geschluckt (analog db/client.ts).
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

function planSteps(
  raw: import("better-sqlite3").Database,
  workstreamId: string,
): Array<Record<string, unknown>> {
  return raw
    .prepare(
      `SELECT * FROM workstream_plan_steps WHERE workstream_id = ? ORDER BY step_index ASC`,
    )
    .all(workstreamId) as Array<Record<string, unknown>>;
}

describe("flow execute — dispatchFlow", () => {
  let raw: import("better-sqlite3").Database;
  beforeEach(() => {
    raw = freshDb();
  });

  it("linearer Flow → 1 workstreams-Row + 1 flow_runs-Row (verknüpft) + N plan-steps", () => {
    const t = createFlowTemplate(raw, {
      workspaceId: "ws-1",
      name: "Reel-Pipeline",
      description: "Bild → Motion → Avatar",
    });
    const a = addFlowStep(raw, { flowId: t.id, idx: 0, label: "Bild", skill: "design" });
    const b = addFlowStep(raw, {
      flowId: t.id,
      idx: 1,
      label: "Motion",
      skill: "build",
      dependsOn: [a.id],
    });
    const c = addFlowStep(raw, {
      flowId: t.id,
      idx: 2,
      label: "Avatar",
      skill: "design",
      dependsOn: [b.id],
    });

    const res = dispatchFlow(raw, { flowId: t.id, workspaceId: "ws-1" });

    expect(res.runId).toMatch(/^FRUN-/);
    expect(res.workstreamId).toMatch(/^WS-/);

    // genau 1 workstreams-Row
    const wsRows = raw
      .prepare("SELECT * FROM workstreams WHERE id = ?")
      .all(res.workstreamId) as Array<Record<string, unknown>>;
    expect(wsRows).toHaveLength(1);
    expect(wsRows[0].name).toBe("Reel-Pipeline"); // N1 verbatim
    expect(wsRows[0].description).toBe("Bild → Motion → Avatar");
    expect(wsRows[0].workspace_id).toBe("ws-1");
    expect(wsRows[0].status).toBe("active");
    expect(wsRows[0].intent).toBe("implementation");

    // genau 1 flow_runs-Row, verknüpft
    const runRows = raw
      .prepare("SELECT * FROM flow_runs WHERE id = ?")
      .all(res.runId) as Array<Record<string, unknown>>;
    expect(runRows).toHaveLength(1);
    expect(runRows[0].workstream_id).toBe(res.workstreamId);
    expect(runRows[0].flow_id).toBe(t.id);

    // N plan-steps in topologischer Ordnung
    const steps = planSteps(raw, res.workstreamId);
    expect(steps).toHaveLength(3);
    expect(steps.map((s) => s.title)).toEqual(["Bild", "Motion", "Avatar"]);
    expect(steps.map((s) => s.step_index)).toEqual([0, 1, 2]);
    // alle root-level depth=0, coord_key gesetzt (N9), content_hash gesetzt (N10)
    for (const s of steps) {
      expect(s.depth).toBe(0);
      expect(s.coord_key).toBe("ws:ws-1");
      expect(String(s.content_hash)).toMatch(/^[0-9a-f]{64}$/);
    }
    void c;
  });

  it("depends_on aus linearem Flow 1:1 in workstream_plan_steps.depends_on", () => {
    const t = createFlowTemplate(raw, { workspaceId: "ws-1", name: "Chain" });
    const a = addFlowStep(raw, { flowId: t.id, idx: 0, label: "A" });
    const b = addFlowStep(raw, { flowId: t.id, idx: 1, label: "B", dependsOn: [a.id] });

    const res = dispatchFlow(raw, { flowId: t.id, workspaceId: "ws-1" });
    const steps = planSteps(raw, res.workstreamId);

    const byTitle = new Map(steps.map((s) => [s.title, s]));
    // erster Step → keine offenen Abhängigkeiten → null (0110-Semantik)
    expect(byTitle.get("A")!.depends_on).toBeNull();
    // B hängt an A — die ID ist die STEP-präfixierte flow-step-id
    const expectedDep = JSON.stringify([`STEP-${a.id}`]);
    expect(byTitle.get("B")!.depends_on).toBe(expectedDep);
  });

  it("DAG-Flow (Diamond) → depends_on erhalten für alle Kanten", () => {
    // A → {B, C} → D  (B und C hängen beide an A; D hängt an B und C)
    const t = createFlowTemplate(raw, { workspaceId: "ws-1", name: "Diamond" });
    const a = addFlowStep(raw, { flowId: t.id, idx: 0, label: "A" });
    const b = addFlowStep(raw, { flowId: t.id, idx: 1, label: "B", dependsOn: [a.id] });
    const c = addFlowStep(raw, { flowId: t.id, idx: 2, label: "C", dependsOn: [a.id] });
    const d = addFlowStep(raw, {
      flowId: t.id,
      idx: 3,
      label: "D",
      dependsOn: [b.id, c.id],
    });

    const res = dispatchFlow(raw, { flowId: t.id, workspaceId: "ws-1" });
    const steps = planSteps(raw, res.workstreamId);
    expect(steps).toHaveLength(4);

    const byTitle = new Map(steps.map((s) => [s.title, s]));
    expect(byTitle.get("A")!.depends_on).toBeNull();
    expect(byTitle.get("B")!.depends_on).toBe(JSON.stringify([`STEP-${a.id}`]));
    expect(byTitle.get("C")!.depends_on).toBe(JSON.stringify([`STEP-${a.id}`]));
    // D hängt an B und C (Reihenfolge = depsById = Quellordnung idx)
    expect(byTitle.get("D")!.depends_on).toBe(
      JSON.stringify([`STEP-${b.id}`, `STEP-${c.id}`]),
    );
    // A muss VOR B/C/D liegen; D als letztes (topologisch)
    const order = steps.map((s) => s.title);
    expect(order.indexOf("A")).toBeLessThan(order.indexOf("B"));
    expect(order.indexOf("A")).toBeLessThan(order.indexOf("C"));
    expect(order.indexOf("D")).toBe(3);
    void d;
  });

  it("leerer Flow → definierter Fehler (FlowDispatchError empty_flow), KEIN verwaister Run", () => {
    const t = createFlowTemplate(raw, { workspaceId: "ws-1", name: "Leer" });
    expect(() => dispatchFlow(raw, { flowId: t.id, workspaceId: "ws-1" })).toThrow(
      FlowDispatchError,
    );
    try {
      dispatchFlow(raw, { flowId: t.id, workspaceId: "ws-1" });
    } catch (e) {
      expect((e as FlowDispatchError).code).toBe("empty_flow");
    }
    // KEIN workstreams/flow_runs-Write passiert (fail-fast vor jeder Transaktion)
    expect(
      (raw.prepare("SELECT COUNT(*) c FROM workstreams").get() as { c: number }).c,
    ).toBe(0);
    expect(
      (raw.prepare("SELECT COUNT(*) c FROM flow_runs").get() as { c: number }).c,
    ).toBe(0);
  });

  it("unbekannte flowId → FlowDispatchError flow_not_found", () => {
    expect(() => dispatchFlow(raw, { flowId: "FLOW-nope", workspaceId: "ws-1" })).toThrow(
      /flow_not_found|no flow_template/,
    );
  });

  it("Zyklus → FlowCycleError (default onCycle:'error'), kein Run persistiert", () => {
    const t = createFlowTemplate(raw, { workspaceId: "ws-1", name: "Cycle" });
    const a = addFlowStep(raw, { flowId: t.id, idx: 0, label: "A" });
    const b = addFlowStep(raw, { flowId: t.id, idx: 1, label: "B", dependsOn: [a.id] });
    // Zyklus: A hängt zurück an B
    raw
      .prepare("UPDATE flow_steps SET depends_on_json = ? WHERE id = ?")
      .run(JSON.stringify([b.id]), a.id);

    expect(() => dispatchFlow(raw, { flowId: t.id, workspaceId: "ws-1" })).toThrow(
      FlowCycleError,
    );
    expect(
      (raw.prepare("SELECT COUNT(*) c FROM workstreams").get() as { c: number }).c,
    ).toBe(0);
  });

  it("onCycle:'sequential' → linearer Fallback persistiert (kein Wurf)", () => {
    const t = createFlowTemplate(raw, { workspaceId: "ws-1", name: "CycleSeq" });
    const a = addFlowStep(raw, { flowId: t.id, idx: 0, label: "A" });
    const b = addFlowStep(raw, { flowId: t.id, idx: 1, label: "B", dependsOn: [a.id] });
    raw
      .prepare("UPDATE flow_steps SET depends_on_json = ? WHERE id = ?")
      .run(JSON.stringify([b.id]), a.id);

    const res = dispatchFlow(raw, {
      flowId: t.id,
      workspaceId: "ws-1",
      onCycle: "sequential",
    });
    const steps = planSteps(raw, res.workstreamId);
    expect(steps).toHaveLength(2);
    // sequenzieller Fallback: B hängt am direkten Vorgänger A
    const byTitle = new Map(steps.map((s) => [s.title, s]));
    expect(byTitle.get("A")!.depends_on).toBeNull();
    expect(byTitle.get("B")!.depends_on).toBe(JSON.stringify([`STEP-${a.id}`]));
  });

  it("parentTicketId wird als primary_ticket_id persistiert; tool/connector in rationale geparkt", () => {
    const t = createFlowTemplate(raw, { workspaceId: "ws-1", name: "Annotate" });
    addFlowStep(raw, {
      flowId: t.id,
      idx: 0,
      label: "Avatar",
      skill: "design",
      toolKind: "connector",
      connectorId: "heygen",
      configJson: JSON.stringify({ voice: "max" }),
    });

    const res = dispatchFlow(raw, {
      flowId: t.id,
      workspaceId: "ws-1",
      parentTicketId: "TKT-42",
    });

    const ws = raw
      .prepare("SELECT * FROM workstreams WHERE id = ?")
      .get(res.workstreamId) as Record<string, unknown>;
    expect(ws.primary_ticket_id).toBe("TKT-42");

    const steps = planSteps(raw, res.workstreamId);
    const rationale = String(steps[0].rationale);
    // Compiler-Felder ohne Ziel-Slot in der rationale-Annotation (verbatim)
    expect(rationale).toContain("heygen");
    expect(rationale).toContain("connector");
    expect(rationale).toContain("flow:");
    // Die parkende Annotation ist ein deterministisches JSON-Objekt nach "flow:".
    // configJson ist selbst ein JSON-String → escaped verbatim eingebettet,
    // und ist nach Parse wieder vollständig rekonstruierbar.
    const json = rationale.slice(rationale.indexOf("flow:") + "flow:".length);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(parsed.connectorId).toBe("heygen");
    expect(parsed.toolKind).toBe("connector");
    expect(parsed.skill).toBe("design");
    expect(JSON.parse(String(parsed.configJson))).toEqual({ voice: "max" });
  });
});
