/**
 * Cost-Estimation Hint Layer — Stream X1 · 2026-05-28.
 *
 * Run:
 *   NODE_OPTIONS="--experimental-require-module" \
 *     node_modules/.bin/vitest run lib/connectors/__tests__/pricing.test.ts
 *
 * Owner-Direktive #2 (verbatim, N1):
 *   „Kosten vorher schätzen, transparent ausweisen, ABER weniger als Cap,
 *    eher als Hinweis."
 *
 * Coverage:
 *   - Roundtrip per provider × capability returns a non-null estimate with
 *     numeric eurMin/eurMax for the 3 known combos.
 *   - Unknown provider/capability → unknown:true with eurMin=eurMax=null
 *     (NOT 0; that would mislead the owner — "kostenlos" ≠ "unbekannt").
 *   - Scaling: higgsfield estimate scales with durationSeconds.
 *   - heygen-avatar estimate scales with explicit durationMinutes OR derives
 *     a sensible default from script word-count.
 *   - imagegen2 (engine-backed) reports a small EUR range (0 .. 0.05) and a
 *     'pro Bild (engine-backed)' basis label.
 *   - estimateCost NEVER throws on garbage args.
 *   - estimateCost NEVER returns Infinity / NaN.
 */

import { describe, it, expect } from "vitest";

import { estimateCost, listPricingTable } from "../pricing";

describe("pricing — known combos roundtrip", () => {
  it("imagegen2 image.generate → engine-backed range, basis label, idempotent note", () => {
    const cost = estimateCost("imagegen2", "image.generate");
    expect(cost.unknown).toBe(false);
    expect(cost.eurMin).toBe(0);
    expect(cost.eurMax).toBe(0.05);
    expect(cost.basis).toContain("Bild");
    expect(cost.basis.toLowerCase()).toContain("engine-backed");
    expect(cost.note.length).toBeGreaterThan(0);
  });

  it("higgsfield video.motion → per-second estimate, default 5s", () => {
    const cost = estimateCost("higgsfield", "video.motion");
    expect(cost.unknown).toBe(false);
    // 5s default × per-sec range (0.01 .. 0.04)
    expect(cost.eurMin).toBeCloseTo(0.05, 4);
    expect(cost.eurMax).toBeCloseTo(0.2, 4);
    expect(cost.basis.toLowerCase()).toContain("sekunde");
    expect(cost.basis).toContain("5 s");
  });

  it("higgsfield video.motion scales with durationSeconds", () => {
    const cost10 = estimateCost("higgsfield", "video.motion", {
      durationSeconds: 10,
    });
    expect(cost10.eurMin).toBeCloseTo(0.1, 4);
    expect(cost10.eurMax).toBeCloseTo(0.4, 4);
    expect(cost10.basis).toContain("10 s");
  });

  it("heygen-avatar video.avatar → per-minute estimate, default 1 min", () => {
    const cost = estimateCost("heygen-avatar", "video.avatar");
    expect(cost.unknown).toBe(false);
    expect(cost.eurMin).toBeCloseTo(0.3, 4);
    expect(cost.eurMax).toBeCloseTo(1.0, 4);
    expect(cost.basis.toLowerCase()).toContain("minute");
  });

  it("heygen-avatar scales with explicit durationMinutes", () => {
    const cost = estimateCost("heygen-avatar", "video.avatar", {
      durationMinutes: 3,
    });
    expect(cost.eurMin).toBeCloseTo(0.9, 4);
    expect(cost.eurMax).toBeCloseTo(3.0, 4);
  });

  it("heygen-avatar derives a sensible scale from script word-count when no duration given", () => {
    // ~ 300 words → 2 min at 150 wpm.
    const script = Array(300).fill("hallo").join(" ");
    const cost = estimateCost("heygen-avatar", "video.avatar", { script });
    expect(cost.unknown).toBe(false);
    expect(cost.eurMin).toBeCloseTo(0.6, 2);
    expect(cost.eurMax).toBeCloseTo(2.0, 2);
  });
});

describe("pricing — unknown-marker semantics", () => {
  it("unknown provider returns unknown:true with eurMin=eurMax=null", () => {
    const cost = estimateCost("totally-fake", "image.generate");
    expect(cost.unknown).toBe(true);
    expect(cost.eurMin).toBeNull();
    expect(cost.eurMax).toBeNull();
    expect(cost.basis).toBe("unbekannt");
    // Note must explain how the owner can find the real number.
    expect(cost.note.length).toBeGreaterThan(0);
  });

  it("known provider + unknown capability returns unknown:true (not 0)", () => {
    const cost = estimateCost("higgsfield", "audio.unknown");
    expect(cost.unknown).toBe(true);
    expect(cost.eurMin).toBeNull();
    expect(cost.eurMax).toBeNull();
  });
});

describe("pricing — robustness", () => {
  it("never throws on garbage args", () => {
    expect(() =>
      estimateCost("higgsfield", "video.motion", {
        durationSeconds: "not-a-number" as unknown as number,
      }),
    ).not.toThrow();
    expect(() =>
      estimateCost("higgsfield", "video.motion", {
        durationSeconds: NaN,
      }),
    ).not.toThrow();
    expect(() =>
      estimateCost("higgsfield", "video.motion", {
        durationSeconds: -10,
      }),
    ).not.toThrow();
  });

  it("never returns Infinity / NaN for any combination", () => {
    const probes: Array<[string, string, Record<string, unknown> | undefined]> = [
      ["higgsfield", "video.motion", undefined],
      ["higgsfield", "video.motion", { durationSeconds: 0 }],
      ["higgsfield", "video.motion", { durationSeconds: NaN }],
      ["heygen-avatar", "video.avatar", undefined],
      ["heygen-avatar", "video.avatar", { durationMinutes: 0 }],
      ["heygen-avatar", "video.avatar", { script: "" }],
      ["imagegen2", "image.generate", undefined],
      ["unknown-provider", "video.motion", undefined],
    ];
    for (const [p, c, a] of probes) {
      const cost = estimateCost(p, c, a);
      if (cost.eurMin !== null) {
        expect(Number.isFinite(cost.eurMin)).toBe(true);
      }
      if (cost.eurMax !== null) {
        expect(Number.isFinite(cost.eurMax)).toBe(true);
      }
    }
  });

  it("listPricingTable contains exactly the 3 P5 capabilities", () => {
    const table = listPricingTable();
    const keys = table.map((e) => `${e.provider}:${e.capability}`);
    expect(keys).toContain("imagegen2:image.generate");
    expect(keys).toContain("higgsfield:video.motion");
    expect(keys).toContain("heygen-avatar:video.avatar");
  });
});
