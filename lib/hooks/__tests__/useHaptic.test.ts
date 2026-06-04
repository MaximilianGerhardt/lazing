/**
 * useHaptic — Surface-Refactor Welle 1
 *
 * Tests cover the pure `triggerHaptic` core (the React hook is a thin
 * useCallback wrapper). We mock `window` and `navigator` to assert
 * vibrate-pattern + reduced-motion bail + fail-silent guarantees.
 *
 * Run:
 *   npx tsx --test --test-force-exit lib/hooks/__tests__/useHaptic.test.ts
 */

import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";

import { triggerHaptic } from "../useHaptic";

type VibrateArg = number | number[];

interface MockState {
  vibrateCalls: VibrateArg[];
  reducedMotion: boolean;
  vibrateThrows: boolean;
  vibrateMissing: boolean;
}

const state: MockState = {
  vibrateCalls: [],
  reducedMotion: false,
  vibrateThrows: false,
  vibrateMissing: false,
};

function installBrowserGlobals() {
  const win = {
    matchMedia: (query: string) => ({
      matches:
        query.includes("prefers-reduced-motion") && state.reducedMotion,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  };
  const nav: { vibrate?: (arg: VibrateArg) => boolean } = {};
  if (!state.vibrateMissing) {
    nav.vibrate = (arg: VibrateArg) => {
      if (state.vibrateThrows) throw new Error("vibrate-blocked");
      state.vibrateCalls.push(arg);
      return true;
    };
  }
  // @ts-expect-error — assign to node global as if browser
  globalThis.window = win;
  // @ts-expect-error — assign to node global as if browser
  globalThis.navigator = nav;
}

function uninstallBrowserGlobals() {
  // @ts-expect-error — clean up
  delete globalThis.window;
  // @ts-expect-error — clean up
  delete globalThis.navigator;
}

describe("triggerHaptic", () => {
  beforeEach(() => {
    state.vibrateCalls = [];
    state.reducedMotion = false;
    state.vibrateThrows = false;
    state.vibrateMissing = false;
    installBrowserGlobals();
  });

  afterEach(() => {
    uninstallBrowserGlobals();
  });

  it("light -> vibrate(8)", () => {
    triggerHaptic("light");
    assert.deepEqual(state.vibrateCalls, [8]);
  });

  it("success -> vibrate([8,40,8])", () => {
    triggerHaptic("success");
    assert.deepEqual(state.vibrateCalls, [[8, 40, 8]]);
  });

  it("reduced-motion -> no vibrate", () => {
    state.reducedMotion = true;
    triggerHaptic("medium");
    assert.deepEqual(state.vibrateCalls, []);
  });

  it("missing navigator.vibrate -> fail-silent", () => {
    state.vibrateMissing = true;
    uninstallBrowserGlobals();
    installBrowserGlobals();
    assert.doesNotThrow(() => triggerHaptic("heavy"));
    assert.deepEqual(state.vibrateCalls, []);
  });

  it("vibrate throws -> fail-silent (no rethrow)", () => {
    state.vibrateThrows = true;
    assert.doesNotThrow(() => triggerHaptic("warning"));
  });
});
