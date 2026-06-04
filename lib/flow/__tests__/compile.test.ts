// Flow → Plan-Steps Compiler tests — Flow Studio P1 · 2026-05-27.
//
// Pure-function tests (keine DB). Decken:
//   - linearer Flow → geordnete Plan-Steps (idx-Reihenfolge)
//   - DAG mit Verzweigung → topologisch korrekt + depends_on erhalten
//   - Zyklus → FlowCycleError (default) UND sequenzieller Fallback
//   - skill→role-Mapping (closed PlanSubagentRole enum)
//   - tool_kind / connector / config durchgereicht
//
// Run:
//   NODE_OPTIONS="--experimental-require-module" node_modules/.bin/vitest run \
//     lib/flow/__tests__/compile.test.ts

import { describe, expect, it } from "vitest";

import {
  FlowCycleError,
  compileFlowToPlanSteps,
  mapSkillToRole,
} from "@/lib/flow/compile";
import type { FlowStep, FlowTemplate } from "@/lib/flow/templates-repo";

const TEMPLATE: FlowTemplate = {
  id: "FLOW-test",
  workspaceId: "ws-1",
  orgId: null,
  name: "Test",
  description: null,
  sopId: null,
  graphJson: "{}",
  createdAt: 0,
  updatedAt: 0,
};

function step(partial: Partial<FlowStep> & { id: string }): FlowStep {
  return {
    flowId: "FLOW-test",
    idx: 0,
    label: null,
    skill: null,
    toolKind: null,
    connectorId: null,
    configJson: null,
    dependsOnJson: null,
    createdAt: 0,
    ...partial,
  };
}

describe("compileFlowToPlanSteps — linear", () => {
  it("orders a linear flow by idx", () => {
    const steps = [
      step({ id: "s3", idx: 3, label: "Publish" }),
      step({ id: "s1", idx: 1, label: "Draft" }),
      step({ id: "s2", idx: 2, label: "Edit" }),
    ];
    const out = compileFlowToPlanSteps(TEMPLATE, steps);
    expect(out.map((s) => s.title)).toEqual(["Draft", "Edit", "Publish"]);
    expect(out.map((s) => s.index)).toEqual([0, 1, 2]);
  });

  it("returns empty for empty step list", () => {
    expect(compileFlowToPlanSteps(TEMPLATE, [])).toEqual([]);
  });

  it("passes tool_kind / connector / config through verbatim", () => {
    const steps = [
      step({
        id: "s1",
        idx: 1,
        label: "Img",
        skill: "design",
        toolKind: "connector",
        connectorId: "imagegen2",
        configJson: '{"prompt":"a cat"}',
      }),
    ];
    const [c] = compileFlowToPlanSteps(TEMPLATE, steps);
    expect(c.toolKind).toBe("connector");
    expect(c.connectorId).toBe("imagegen2");
    expect(c.configJson).toBe('{"prompt":"a cat"}');
    expect(c.skill).toBe("design");
  });
});

describe("compileFlowToPlanSteps — DAG", () => {
  it("topologically orders a branch + join and preserves depends_on", () => {
    //      a
    //     / \
    //    b   c
    //     \ /
    //      d
    const steps = [
      step({ id: "d", idx: 4, dependsOnJson: JSON.stringify(["b", "c"]) }),
      step({ id: "a", idx: 1 }),
      step({ id: "c", idx: 3, dependsOnJson: JSON.stringify(["a"]) }),
      step({ id: "b", idx: 2, dependsOnJson: JSON.stringify(["a"]) }),
    ];
    const out = compileFlowToPlanSteps(TEMPLATE, steps);
    const order = out.map((s) => s.id);

    // a before b,c ; b and c before d
    expect(order.indexOf("a")).toBeLessThan(order.indexOf("b"));
    expect(order.indexOf("a")).toBeLessThan(order.indexOf("c"));
    expect(order.indexOf("b")).toBeLessThan(order.indexOf("d"));
    expect(order.indexOf("c")).toBeLessThan(order.indexOf("d"));

    // deterministic tie-break by idx → b (idx2) before c (idx3)
    expect(order).toEqual(["a", "b", "c", "d"]);

    // depends_on preserved
    const d = out.find((s) => s.id === "d")!;
    expect([...d.dependsOn].sort()).toEqual(["b", "c"]);
    const a = out.find((s) => s.id === "a")!;
    expect(a.dependsOn).toEqual([]);
  });

  it("ignores dangling depends_on (edge to a non-existent step)", () => {
    const steps = [
      step({ id: "a", idx: 1, dependsOnJson: JSON.stringify(["ghost"]) }),
      step({ id: "b", idx: 2, dependsOnJson: JSON.stringify(["a"]) }),
    ];
    const out = compileFlowToPlanSteps(TEMPLATE, steps);
    expect(out.map((s) => s.id)).toEqual(["a", "b"]);
    // ghost edge filtered out
    expect(out.find((s) => s.id === "a")!.dependsOn).toEqual([]);
  });
});

describe("compileFlowToPlanSteps — cycle", () => {
  const cyclic = [
    step({ id: "x", idx: 1, dependsOnJson: JSON.stringify(["y"]) }),
    step({ id: "y", idx: 2, dependsOnJson: JSON.stringify(["x"]) }),
  ];

  it("throws FlowCycleError by default", () => {
    expect(() => compileFlowToPlanSteps(TEMPLATE, cyclic)).toThrow(
      FlowCycleError,
    );
    try {
      compileFlowToPlanSteps(TEMPLATE, cyclic);
    } catch (e) {
      expect(e).toBeInstanceOf(FlowCycleError);
      expect([...(e as FlowCycleError).cycleStepIds].sort()).toEqual([
        "x",
        "y",
      ]);
    }
  });

  it("falls back to a sequential chain with onCycle: 'sequential'", () => {
    const out = compileFlowToPlanSteps(TEMPLATE, cyclic, {
      onCycle: "sequential",
    });
    // linear by idx; cyclic edges discarded → each hangs off its idx-predecessor
    expect(out.map((s) => s.id)).toEqual(["x", "y"]);
    expect(out[0].dependsOn).toEqual([]);
    expect(out[1].dependsOn).toEqual(["x"]);
  });
});

describe("mapSkillToRole", () => {
  it("maps direct role-skill-map keys", () => {
    expect(mapSkillToRole("architect", null)).toBe("architect");
    expect(mapSkillToRole("coder", null)).toBe("coder");
    expect(mapSkillToRole("tester", null)).toBe("tester");
    expect(mapSkillToRole("reviewer", null)).toBe("reviewer");
  });

  it("maps fachliche Flow-Studio skills (Aufbau/Copy/Design)", () => {
    expect(mapSkillToRole("Aufbau", null)).toBe("architect");
    expect(mapSkillToRole("Copy", null)).toBe("coder");
    expect(mapSkillToRole("Design", null)).toBe("architect");
  });

  it("unknown but present skill → coder (generic worker)", () => {
    expect(mapSkillToRole("frobnicate", null)).toBe("coder");
  });

  it("empty / null skill → null (tool-only free-form)", () => {
    expect(mapSkillToRole(null, "connector")).toBeNull();
    expect(mapSkillToRole("  ", "mcp")).toBeNull();
  });

  it("compiler applies the mapping in the output", () => {
    const steps = [
      step({ id: "s1", idx: 1, skill: "tester", label: "Verify" }),
      step({ id: "s2", idx: 2, toolKind: "connector", connectorId: "x" }),
    ];
    const out = compileFlowToPlanSteps(TEMPLATE, steps);
    expect(out[0].subagentRole).toBe("tester");
    expect(out[1].subagentRole).toBeNull(); // no skill → free-form
  });
});
