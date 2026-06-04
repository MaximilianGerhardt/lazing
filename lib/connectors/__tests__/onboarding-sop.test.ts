/**
 * Auto-Onboarding-SOP Engine — Stream X1 · 2026-05-28.
 *
 * Run:
 *   NODE_OPTIONS="--experimental-require-module" \
 *     node_modules/.bin/vitest run lib/connectors/__tests__/onboarding-sop.test.ts
 *
 * Coverage:
 *   - getOnboardingSop returns a non-null SOP for every P5 provider:
 *     higgsfield, heygen-avatar, imagegen2.
 *   - Unknown provider → null (caller stays backwards-compatible).
 *   - null / empty providerId → null (defensive).
 *   - imagegen2 marked engineBacked → step list contains NO 'credential' kind.
 *   - higgsfield / heygen-avatar carry a final 'credential' step AND a 'budget'
 *     step (Owner-Direktive #2: provider-side budget reminder).
 *   - buildOnboardingSopForMissingTool: provider=null → null; matched provider
 *     → same SOP as getOnboardingSop.
 *   - SECURITY: no field anywhere in any SOP entry contains a credential value
 *     (only the schema of what the owner would enter).
 *   - N1: every step body is non-empty and not visibly truncated (.slice/…/…),
 *     and verbatim across calls (idempotent).
 */

import { describe, it, expect } from "vitest";

import {
  buildOnboardingSopForMissingTool,
  getOnboardingSop,
  listOnboardingSops,
} from "../onboarding-sop";

describe("onboarding-sop registry", () => {
  it("provides an SOP for each P5 provider (higgsfield, heygen-avatar, imagegen2)", () => {
    const hf = getOnboardingSop("higgsfield");
    const hg = getOnboardingSop("heygen-avatar");
    const ig = getOnboardingSop("imagegen2");

    expect(hf).not.toBeNull();
    expect(hg).not.toBeNull();
    expect(ig).not.toBeNull();

    expect(hf!.providerId).toBe("higgsfield");
    expect(hg!.providerId).toBe("heygen-avatar");
    expect(ig!.providerId).toBe("imagegen2");

    expect(hf!.engineBacked).toBe(false);
    expect(hg!.engineBacked).toBe(false);
    expect(ig!.engineBacked).toBe(true);
  });

  it("returns null for unknown provider", () => {
    expect(getOnboardingSop("totally-unknown-provider")).toBeNull();
  });

  it("returns null for null / empty providerId", () => {
    expect(getOnboardingSop(null)).toBeNull();
    expect(getOnboardingSop(undefined)).toBeNull();
    expect(getOnboardingSop("")).toBeNull();
  });

  it("higgsfield SOP carries signup + key + budget + credential steps with public signup URL", () => {
    const sop = getOnboardingSop("higgsfield")!;
    expect(sop.accountSignupUrl).toBe("https://higgsfield.ai");
    const kinds = sop.keyAcquisitionSteps.map((s) => s.kind);
    expect(kinds).toContain("signup");
    expect(kinds).toContain("key");
    expect(kinds).toContain("budget");
    expect(kinds).toContain("credential");
    // Step numbers are sequential 1..n.
    sop.keyAcquisitionSteps.forEach((s, i) => expect(s.num).toBe(i + 1));
  });

  it("heygen-avatar SOP carries signup + key + budget + credential steps with HeyGen login URL", () => {
    const sop = getOnboardingSop("heygen-avatar")!;
    expect(sop.accountSignupUrl).toBe("https://app.heygen.com/login");
    const kinds = sop.keyAcquisitionSteps.map((s) => s.kind);
    expect(kinds).toContain("signup");
    expect(kinds).toContain("key");
    expect(kinds).toContain("budget");
    expect(kinds).toContain("credential");
  });

  it("imagegen2 SOP is engine-backed: NO 'credential' step, but a 'budget' step still present", () => {
    const sop = getOnboardingSop("imagegen2")!;
    expect(sop.engineBacked).toBe(true);
    expect(sop.accountSignupUrl).toBeNull();
    const kinds = sop.keyAcquisitionSteps.map((s) => s.kind);
    expect(kinds).not.toContain("credential");
    expect(kinds).toContain("info");
    expect(kinds).toContain("budget");
  });

  it("SECURITY: no SOP entry contains a credential value field (only the field schema/hint)", () => {
    for (const sop of listOnboardingSops()) {
      const serialized = JSON.stringify(sop).toLowerCase();
      // Verify no obvious secret keys are baked in.
      expect(serialized).not.toMatch(/"api[_-]?key"\s*:\s*"[a-z0-9]{16,}"/);
      expect(serialized).not.toMatch(/"secret"\s*:\s*"[a-z0-9]{8,}"/);
      expect(serialized).not.toMatch(/"token"\s*:\s*"[a-z0-9]{12,}"/);
      expect(serialized).not.toMatch(/sk_live_/);
      expect(serialized).not.toMatch(/sk_test_/);
      // credentialFieldHint may MENTION the word "API Key" — that's just a hint,
      // not a value. Check the structural shape: there is no top-level
      // 'credential' or 'value' field with a string longer than the hint.
      const obj = sop as unknown as Record<string, unknown>;
      expect(Object.keys(obj)).not.toContain("credential");
      expect(Object.keys(obj)).not.toContain("value");
    }
  });

  it("N1: step bodies are verbatim and idempotent across calls (same reference text)", () => {
    const a = getOnboardingSop("higgsfield")!;
    const b = getOnboardingSop("higgsfield")!;
    // Same registry object across calls.
    expect(a).toBe(b);
    for (const step of a.keyAcquisitionSteps) {
      expect(step.title.length).toBeGreaterThan(0);
      expect(step.body.length).toBeGreaterThan(0);
      // N1: no telltale truncation markers.
      expect(step.body).not.toMatch(/…$/);
      expect(step.body).not.toMatch(/\.\.\.$/);
    }
  });
});

describe("buildOnboardingSopForMissingTool", () => {
  it("provider=null → null (caller renders generic 'choose tool' hint)", () => {
    expect(
      buildOnboardingSopForMissingTool({ provider: null, reason: "unknown" }),
    ).toBeNull();
  });

  it("matched provider → returns the same SOP as getOnboardingSop", () => {
    const direct = getOnboardingSop("heygen-avatar");
    const via = buildOnboardingSopForMissingTool({
      provider: "heygen-avatar",
      reason: "credential",
    });
    expect(via).toBe(direct);
  });

  it("unknown provider → null (no SOP wrapper, caller stays backwards-compatible)", () => {
    expect(
      buildOnboardingSopForMissingTool({
        provider: "made-up-thing",
        reason: "profile",
      }),
    ).toBeNull();
  });
});
