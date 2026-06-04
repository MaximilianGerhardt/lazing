/**
 * Unit tests for the OSS onboarding 10-step state machine (Track B, B0/B6).
 *
 * These are pure-function tests: no DB, no network. They assert the tuple
 * order, the derived step count, step-transition logic, progress math, and
 * the tolerant JSON parser.
 */

import { describe, expect, it } from "vitest";

import {
  OSS_ONBOARDING_STEPS,
  OSS_STEP_COUNT,
  defaultOssState,
  isOssOnboardingStep,
  nextOssStep,
  parseOssState,
  stepProgress,
  type OssOnboardingStep,
} from "./oss-state";

describe("OSS onboarding step tuple", () => {
  it("has the canonical 10-step order plus the done sentinel", () => {
    expect(OSS_ONBOARDING_STEPS).toEqual([
      "welcome",
      "fullaccess",
      "systemcheck",
      "install",
      "engine",
      "connect",
      "purpose",
      "workspace",
      "github",
      "finalize",
      "done",
    ]);
  });

  it("derives OSS_STEP_COUNT as tuple length minus the done sentinel", () => {
    expect(OSS_STEP_COUNT).toBe(OSS_ONBOARDING_STEPS.length - 1);
    expect(OSS_STEP_COUNT).toBe(10);
  });
});

describe("isOssOnboardingStep", () => {
  it("accepts every real step", () => {
    for (const step of OSS_ONBOARDING_STEPS) {
      expect(isOssOnboardingStep(step)).toBe(true);
    }
  });

  it("rejects unknown strings", () => {
    expect(isOssOnboardingStep("nope")).toBe(false);
    expect(isOssOnboardingStep("")).toBe(false);
    expect(isOssOnboardingStep("push")).toBe(false); // removed legacy step
  });
});

describe("nextOssStep", () => {
  it("walks the whole chain in order and terminates at done", () => {
    const visited: OssOnboardingStep[] = ["welcome"];
    let cur: OssOnboardingStep | null = "welcome";
    // Guard against infinite loops with a generous cap.
    for (let i = 0; i < 20 && cur; i++) {
      const nxt = nextOssStep(cur);
      if (!nxt) break;
      visited.push(nxt);
      cur = nxt;
    }
    expect(visited).toEqual([...OSS_ONBOARDING_STEPS]);
    expect(nextOssStep("done")).toBeNull();
  });

  it("advances finalize to done", () => {
    expect(nextOssStep("finalize")).toBe("done");
  });
});

describe("stepProgress", () => {
  it("reports 1/10 at welcome and 10/10 at finalize", () => {
    expect(stepProgress("welcome")).toEqual({ current: 1, total: 10 });
    expect(stepProgress("finalize")).toEqual({ current: 10, total: 10 });
  });

  it("clamps the done sentinel to the last visible step", () => {
    expect(stepProgress("done")).toEqual({ current: 10, total: 10 });
  });

  it("uses the derived total, not a hardcoded number", () => {
    for (const step of OSS_ONBOARDING_STEPS) {
      expect(stepProgress(step).total).toBe(OSS_STEP_COUNT);
    }
  });
});

describe("parseOssState", () => {
  it("returns null for empty / malformed input", () => {
    expect(parseOssState(null)).toBeNull();
    expect(parseOssState("")).toBeNull();
    expect(parseOssState("{not json")).toBeNull();
    expect(parseOssState("[]")).toBeNull();
    expect(parseOssState("123")).toBeNull();
  });

  it("repairs an unknown currentStep back to welcome", () => {
    const parsed = parseOssState(JSON.stringify({ currentStep: "bogus" }));
    expect(parsed?.currentStep).toBe("welcome");
  });

  it("normalizes missing arrays and data", () => {
    const parsed = parseOssState(JSON.stringify({ currentStep: "engine" }));
    expect(parsed?.currentStep).toBe("engine");
    expect(parsed?.completedSteps).toEqual([]);
    expect(parsed?.skippedSteps).toEqual([]);
    expect(parsed?.data).toEqual({});
  });

  it("round-trips a default state", () => {
    const def = defaultOssState();
    const round = parseOssState(JSON.stringify(def));
    expect(round).toEqual(def);
  });
});
