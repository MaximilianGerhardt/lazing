/**
 * Onboarding state (Phase AU.3 — 5-step wizard).
 *
 * Persisted in `users.onboarding_state` as a JSON blob. Each step is a
 * state machine; the client always shows the current step. On refresh
 * you land at the same point.
 *
 * Steps:
 *   1 welcome          — 3-box diagram User → Org → Workspaces, explanatory text
 *   2 profile          — display name + locale
 *   3 organization     — solo / create own org / wait via invite
 *   4 first-workspace  — name + sensitivity + org selection (skippable)
 *   5 claude-max       — shared (system token) OR own (own credentials)
 *   6 done             — confirmation + auto-redirect
 *
 * State fields are passed between steps so that the wizard knows at the end
 * which workspace to send the user to.
 */

export const ONBOARDING_STEPS = [
  "welcome",
  "profile",
  "organization",
  "first-workspace",
  "claude-max",
  "done",
] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export interface OnboardingState {
  currentStep: OnboardingStep;
  completedSteps: OnboardingStep[];
  variant: "new" | "max-firstrun";
  /** ISO string or null. */
  completedAt: string | null;
  /**
   * Step outputs that following steps need or that the done step uses for
   * redirection.
   */
  data?: {
    /** From step `organization`: ID of the chosen/created org (null = solo). */
    chosenOrgId?: string | null;
    /** From step `first-workspace`: ID of the created workspace. */
    workspaceId?: string | null;
    /** From step `claude-max`: shared|own — display helper. */
    claudeMaxStatus?: "shared" | "own";
  };
}

export function isOnboardingStep(s: string): s is OnboardingStep {
  return (ONBOARDING_STEPS as readonly string[]).includes(s);
}

export function nextStep(current: OnboardingStep): OnboardingStep | null {
  const idx = ONBOARDING_STEPS.indexOf(current);
  if (idx < 0 || idx >= ONBOARDING_STEPS.length - 1) return null;
  return ONBOARDING_STEPS[idx + 1];
}

export function defaultState(variant: OnboardingState["variant"]): OnboardingState {
  return {
    currentStep: "welcome",
    completedSteps: [],
    variant,
    completedAt: null,
    data: {},
  };
}

export function parseState(raw: string | null): OnboardingState | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw) as unknown;
    if (
      typeof obj !== "object" ||
      obj === null ||
      typeof (obj as Record<string, unknown>).currentStep !== "string"
    ) {
      return null;
    }
    const parsed = obj as OnboardingState;
    // Migration: old 3-step states use "confirm-name" → we map it to "profile".
    if ((parsed.currentStep as string) === "confirm-name") {
      parsed.currentStep = "profile";
    }
    if (!isOnboardingStep(parsed.currentStep)) {
      parsed.currentStep = "welcome";
    }
    if (!parsed.data) parsed.data = {};
    return parsed;
  } catch {
    return null;
  }
}
