/**
 * Unit tests for the usage-purpose → workspace-seed map (Track B, B5/B6).
 *
 * Pure-function tests: the map is total over UsagePurpose, agency gets a
 * higher sensitivity than personal, and the guards accept only valid ids.
 */

import { describe, expect, it } from "vitest";

import {
  PURPOSE_OPTIONS,
  USAGE_PURPOSES,
  isUsagePurpose,
  seedForPurpose,
} from "./purpose";

describe("usage purposes", () => {
  it("lists exactly agency / personal / contributor", () => {
    expect([...USAGE_PURPOSES]).toEqual(["agency", "personal", "contributor"]);
    expect(PURPOSE_OPTIONS.map((o) => o.id)).toEqual([
      "agency",
      "personal",
      "contributor",
    ]);
  });

  it("guards against unknown ids", () => {
    expect(isUsagePurpose("agency")).toBe(true);
    expect(isUsagePurpose("enterprise")).toBe(false);
    expect(isUsagePurpose("")).toBe(false);
  });
});

describe("seedForPurpose", () => {
  it("returns a complete seed for every purpose", () => {
    for (const purpose of USAGE_PURPOSES) {
      const seed = seedForPurpose(purpose);
      expect(seed.workspaceLabel.length).toBeGreaterThan(0);
      expect(["low", "normal", "high"]).toContain(seed.sensitivity);
      expect(seed.segmentsHint.length).toBeGreaterThan(0);
    }
  });

  it("gives agency a higher sensitivity than personal", () => {
    const rank = { low: 0, normal: 1, high: 2 } as const;
    const agency = seedForPurpose("agency").sensitivity;
    const personal = seedForPurpose("personal").sensitivity;
    expect(rank[agency]).toBeGreaterThan(rank[personal]);
  });

  it("maps each purpose to a distinct label", () => {
    const labels = USAGE_PURPOSES.map((p) => seedForPurpose(p).workspaceLabel);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
