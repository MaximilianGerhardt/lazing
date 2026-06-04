// SOP Executor tests — SAR-2 · 2026-05-24.
//
// Tests cover:
//   1. expandSopToPlanNodes produces the correct PlanNode count and order.
//   2. Empty SOP → empty array.
//   3. N1 discipline: step_prompt_template is NOT truncated (full text preserved).
//   4. N10: hashSop is deterministic — same input always yields the same hash.
//   5. PlanNode shape: children empty, depth=0, step/plan wired correctly.
//   6. Role coercion: researcher/scribe map to undefined; coder/architect/tester/reviewer pass through.

import { describe, expect, it } from "vitest";

import { expandSopToPlanNodes } from "../executor";
import { hashSop } from "../registry";
import type { SopWithSteps } from "../registry";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let idCounter = 0;
function mintTestId(): string {
  idCounter += 1;
  return `TEST-${String(idCounter).padStart(4, "0")}`;
}

function makeStep(
  overrides: Partial<SopWithSteps["steps"][number]> & { stepIndex: number },
): SopWithSteps["steps"][number] {
  return {
    id: `step-${overrides.stepIndex}`,
    sopId: "SOP-TEST-001",
    stepIndex: overrides.stepIndex,
    title: overrides.title ?? `Step ${overrides.stepIndex} title`,
    stepPromptTemplate:
      overrides.stepPromptTemplate ??
      `Full prompt for step ${overrides.stepIndex}. {{goal_prompt}}`,
    subagentRole: overrides.subagentRole ?? null,
    requiredSkillsJson: overrides.requiredSkillsJson ?? null,
    mcpToolAllowlistJson: overrides.mcpToolAllowlistJson ?? null,
    optional: overrides.optional ?? false,
  };
}

function makeSop(steps: SopWithSteps["steps"]): SopWithSteps {
  return {
    id: "SOP-TEST-001",
    name: "Test SOP",
    description: "A test SOP for unit testing",
    workspaceId: null,
    version: 1,
    builtIn: false,
    archivedAt: null,
    contentHash: "test-hash",
    createdAt: 1_700_000_000_000,
    steps,
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("expandSopToPlanNodes", () => {
  it("returns empty array for empty SOP (0 steps)", () => {
    idCounter = 0;
    const sop = makeSop([]);
    const nodes = expandSopToPlanNodes(sop, { mintId: mintTestId });
    expect(nodes).toHaveLength(0);
    expect(nodes).toEqual([]);
  });

  it("returns exactly N nodes for N steps", () => {
    idCounter = 0;
    const sop = makeSop([
      makeStep({ stepIndex: 0 }),
      makeStep({ stepIndex: 1 }),
      makeStep({ stepIndex: 2 }),
    ]);
    const nodes = expandSopToPlanNodes(sop, { mintId: mintTestId });
    expect(nodes).toHaveLength(3);
  });

  it("preserves step ordering (step_index ascending)", () => {
    idCounter = 0;
    // Supply steps out of order — executor must sort them.
    const sop = makeSop([
      makeStep({ stepIndex: 2, title: "Third" }),
      makeStep({ stepIndex: 0, title: "First" }),
      makeStep({ stepIndex: 1, title: "Second" }),
    ]);
    const nodes = expandSopToPlanNodes(sop, { mintId: mintTestId });
    expect(nodes[0]?.step?.title).toBe("First");
    expect(nodes[1]?.step?.title).toBe("Second");
    expect(nodes[2]?.step?.title).toBe("Third");
  });

  it("N1: step_prompt_template is preserved VERBATIM in rationale (no truncation)", () => {
    idCounter = 0;
    // 2000-char template to prove no slice/substring happens
    const longTemplate = "A".repeat(500) + " {{goal_prompt}} " + "B".repeat(500);
    const sop = makeSop([
      makeStep({ stepIndex: 0, stepPromptTemplate: longTemplate }),
    ]);
    const nodes = expandSopToPlanNodes(sop, { mintId: mintTestId });
    // rationale must equal the full template verbatim
    expect(nodes[0]?.step?.rationale).toBe(longTemplate);
    // And via plan.steps[0].rationale
    expect(nodes[0]?.plan.steps[0]?.rationale).toBe(longTemplate);
  });

  it("N1: title is preserved VERBATIM", () => {
    idCounter = 0;
    const verbatimTitle = "Research: Collect sources and evidence (verbatim from SOP)";
    const sop = makeSop([makeStep({ stepIndex: 0, title: verbatimTitle })]);
    const nodes = expandSopToPlanNodes(sop, { mintId: mintTestId });
    expect(nodes[0]?.step?.title).toBe(verbatimTitle);
    expect(nodes[0]?.plan.steps[0]?.title).toBe(verbatimTitle);
  });

  it("each node has depth=0, awaitingApproval=false, cascadeMode=per-level", () => {
    idCounter = 0;
    const sop = makeSop([makeStep({ stepIndex: 0 }), makeStep({ stepIndex: 1 })]);
    const nodes = expandSopToPlanNodes(sop, { mintId: mintTestId });
    for (const node of nodes) {
      expect(node.depth).toBe(0);
      expect(node.awaitingApproval).toBe(false);
      expect(node.cascadeMode).toBe("per-level");
      expect(node.children).toBeInstanceOf(Map);
      expect(node.children.size).toBe(0);
    }
  });

  it("each node's plan contains exactly 1 step", () => {
    idCounter = 0;
    const sop = makeSop([
      makeStep({ stepIndex: 0 }),
      makeStep({ stepIndex: 1 }),
      makeStep({ stepIndex: 2 }),
    ]);
    const nodes = expandSopToPlanNodes(sop, { mintId: mintTestId });
    for (const node of nodes) {
      expect(node.plan.steps).toHaveLength(1);
    }
  });

  it("plan.originalIntent equals sop.name", () => {
    idCounter = 0;
    const sop: SopWithSteps = { ...makeSop([makeStep({ stepIndex: 0 })]), name: "My Custom SOP" };
    const nodes = expandSopToPlanNodes(sop, { mintId: mintTestId });
    expect(nodes[0]?.plan.originalIntent).toBe("My Custom SOP");
  });

  it("PlanStep.index is 1-based (stepIndex 0 → index 1)", () => {
    idCounter = 0;
    const sop = makeSop([makeStep({ stepIndex: 0 }), makeStep({ stepIndex: 1 })]);
    const nodes = expandSopToPlanNodes(sop, { mintId: mintTestId });
    expect(nodes[0]?.plan.steps[0]?.index).toBe(1);
    expect(nodes[1]?.plan.steps[0]?.index).toBe(2);
  });

  it("role coercion: valid PlanSubagentRole passes through", () => {
    idCounter = 0;
    const sop = makeSop([
      makeStep({ stepIndex: 0, subagentRole: "coder" }),
      makeStep({ stepIndex: 1, subagentRole: "architect" }),
      makeStep({ stepIndex: 2, subagentRole: "tester" }),
      makeStep({ stepIndex: 3, subagentRole: "reviewer" }),
    ]);
    const nodes = expandSopToPlanNodes(sop, { mintId: mintTestId });
    expect(nodes[0]?.step?.subagentRole).toBe("coder");
    expect(nodes[1]?.step?.subagentRole).toBe("architect");
    expect(nodes[2]?.step?.subagentRole).toBe("tester");
    expect(nodes[3]?.step?.subagentRole).toBe("reviewer");
  });

  it("role coercion: researcher and scribe map to undefined (not in PlanSubagentRole)", () => {
    idCounter = 0;
    const sop = makeSop([
      makeStep({ stepIndex: 0, subagentRole: "researcher" }),
      makeStep({ stepIndex: 1, subagentRole: "scribe" }),
    ]);
    const nodes = expandSopToPlanNodes(sop, { mintId: mintTestId });
    expect(nodes[0]?.step?.subagentRole).toBeUndefined();
    expect(nodes[1]?.step?.subagentRole).toBeUndefined();
  });

  it("role coercion: null role maps to undefined", () => {
    idCounter = 0;
    const sop = makeSop([makeStep({ stepIndex: 0, subagentRole: null })]);
    const nodes = expandSopToPlanNodes(sop, { mintId: mintTestId });
    expect(nodes[0]?.step?.subagentRole).toBeUndefined();
  });

  it("mintId is used for all IDs (deterministic when injected)", () => {
    idCounter = 0;
    const sop = makeSop([makeStep({ stepIndex: 0 }), makeStep({ stepIndex: 1 })]);
    // Each node consumes 3 minted IDs: planStep.id, plan.id, node.id
    const nodes = expandSopToPlanNodes(sop, { mintId: mintTestId });
    expect(nodes[0]?.step?.id).toBe("TEST-0001");
    expect(nodes[0]?.plan.id).toBe("TEST-0002");
    expect(nodes[0]?.id).toBe("TEST-0003");
    expect(nodes[1]?.step?.id).toBe("TEST-0004");
    expect(nodes[1]?.plan.id).toBe("TEST-0005");
    expect(nodes[1]?.id).toBe("TEST-0006");
  });

  it("node.step matches node.plan.steps[0] (same reference / equal data)", () => {
    idCounter = 0;
    const sop = makeSop([makeStep({ stepIndex: 0 })]);
    const nodes = expandSopToPlanNodes(sop, { mintId: mintTestId });
    const node = nodes[0];
    expect(node).toBeDefined();
    expect(node!.step).toBe(node!.plan.steps[0]); // same object reference
  });
});

// ---------------------------------------------------------------------------
// N10: hashSop determinism
// ---------------------------------------------------------------------------

describe("hashSop — N10 determinism", () => {
  const baseInput = {
    id: "SOP-BUILTIN-TEST-01",
    name: "Test SOP Name",
    description: "A description",
    workspaceId: null,
    version: 1,
    builtIn: false,
    createdAt: 1_700_000_000_000,
  };

  it("same input always yields the same 64-char hex hash", () => {
    const a = hashSop(baseInput);
    const b = hashSop(baseInput);
    expect(a).toBe(b);
    expect(a).toHaveLength(64); // sha256 hex
    expect(/^[0-9a-f]{64}$/.test(a)).toBe(true);
  });

  it("different name yields different hash", () => {
    const a = hashSop(baseInput);
    const b = hashSop({ ...baseInput, name: "Different Name" });
    expect(a).not.toBe(b);
  });

  it("different id yields different hash", () => {
    const a = hashSop(baseInput);
    const b = hashSop({ ...baseInput, id: "SOP-BUILTIN-OTHER-01" });
    expect(a).not.toBe(b);
  });

  it("different version yields different hash", () => {
    const a = hashSop(baseInput);
    const b = hashSop({ ...baseInput, version: 2 });
    expect(a).not.toBe(b);
  });

  it("different workspace_id yields different hash", () => {
    const a = hashSop(baseInput);
    const b = hashSop({ ...baseInput, workspaceId: "ws-123" });
    expect(a).not.toBe(b);
  });

  it("builtIn flag is included in hash (true vs false differ)", () => {
    const a = hashSop(baseInput);
    const b = hashSop({ ...baseInput, builtIn: true });
    expect(a).not.toBe(b);
  });
});
