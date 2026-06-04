/**
 * OSS onboarding state — the first-run setup machine for a freshly cloned
 * lazyOS server (Track B, Robust-v1).
 *
 * This is a dedicated state machine, separate from the legacy `onboarding_state`
 * (see ./state.ts). It models the *OSS setup journey* of a freshly cloned
 * lazyOS server: from a blank machine to a booted, engine-connected,
 * workspace-seeded runtime. It is pausable, resumable, and individual steps
 * can be skipped.
 *
 * Persisted in `users.oss_onboarding_state` (migration 0054) as a JSON blob.
 * Kept separate from `onboarding_state` on purpose — the org/workspace/data-model
 * journey stays orthogonal to OSS server setup (self-healing, install, engine,
 * full-access, finalize).
 *
 * Steps (one primary action per screen — Jobs/Rams lens):
 *   1  welcome      — "lazyOS is a local-first AI runtime, here is your setup"
 *   2  fullaccess   — Guided + detected OS permissions (NOT a hard gate)
 *   3  systemcheck  — Live preflight probe + safe one-click self-healing
 *   4  install      — Consented, streamed one-click install of missing tools
 *   5  engine       — Live availability probe (claude-cli / codex / ollama)
 *   6  connect      — Robust per-engine connect (terminal OAuth + paste key/JSON)
 *   7  purpose      — Usage purpose pick → pre-seeds the workspace step
 *   8  workspace    — Local-folder picker + quick defaults (name, sensitivity)
 *   9  github       — Optional GitHub connect (OAuth primary, PAT fallback)
 *  10  finalize     — Boot the agent server, verify ports, mark completion
 *   done            — Sentinel state, signals "wizard complete"
 */

export const OSS_ONBOARDING_STEPS = [
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
] as const;
export type OssOnboardingStep = (typeof OSS_ONBOARDING_STEPS)[number];

/** Number of *visible* steps in the wizard (everything except the `done` sentinel). */
export const OSS_STEP_COUNT = OSS_ONBOARDING_STEPS.length - 1;

/** Auto-detection candidates for the engine step. */
export type EngineKind = "claude-cli" | "codex" | "ollama" | "none";

export interface DetectedEngine {
  kind: EngineKind;
  /** CLI binary path or endpoint URL (for ollama). */
  location: string | null;
  /** Output of `--version` / health check, kept short (<120 chars). */
  versionHint: string | null;
  /** true = auto-detected, false = manually entered by the user. */
  autoDetected: boolean;
}

/** Usage purpose pick (B5) — maps to a pre-seeded workspace profile. */
export type UsagePurpose = "agency" | "personal" | "contributor";

/** Per-engine connect status recorded by the `connect` step (B3). */
export type EngineConnectStatus =
  | "connected"
  | "pending"
  | "skipped"
  | "unavailable"
  | null;

export interface ConnectState {
  claude?: EngineConnectStatus;
  codex?: EngineConnectStatus;
  ollama?: EngineConnectStatus;
}

export interface OssOnboardingState {
  currentStep: OssOnboardingStep;
  completedSteps: OssOnboardingStep[];
  /** Per-step skip markers — relevant for resume logic + audit trail. */
  skippedSteps: OssOnboardingStep[];
  /** ISO string of the last mutation — for the "Resume since …" UX hint. */
  lastActivityAt: string | null;
  /** ISO string, set as soon as `done` is reached. */
  completedAt: string | null;
  data?: {
    engine?: DetectedEngine | null;
    /**
     * From the `systemcheck` step: overall status of the last health probe.
     * "passed" = all checks ok/skipped · "degraded" = at least 1 degraded ·
     * "failed" = at least 1 error · "skipped" = the user skipped the step.
     */
    systemcheckStatus?: "passed" | "degraded" | "failed" | "skipped" | null;
    /** From the `fullaccess` step (B4): a coarse permission posture. */
    fullAccessStatus?: "granted" | "partial" | "skipped" | "not-required" | null;
    /** From the `install` step (B2): a short human-readable summary line. */
    installSummary?: string | null;
    /** From the `connect` step (B3): per-engine connect status. */
    connect?: ConnectState;
    /** From the `purpose` step (B5): the picked usage purpose. */
    usagePurpose?: UsagePurpose | null;
    /** From the `workspace` step: path and label. */
    workspaceRoot?: string | null;
    workspaceLabel?: string | null;
    workspaceSensitivity?: "low" | "normal" | "high";
    /** From the `github` step: connected | skipped. */
    githubStatus?: "connected" | "skipped" | null;
    githubAccount?: string | null;
    /** From the `finalize` step (B5): boot + port-verification verdict. */
    finalizeStatus?: "ready" | "degraded" | "skipped" | null;
    /** Legacy fields kept for backward compatibility with older blobs. */
    pushStatus?: "granted" | "denied" | "skipped" | null;
    notificationsEnabled?: boolean;
    /** Custom seed consumed by GET /api/user-settings/engine. */
    preferredEngine?: string;
  };
}

export function isOssOnboardingStep(s: string): s is OssOnboardingStep {
  return (OSS_ONBOARDING_STEPS as readonly string[]).includes(s);
}

export function nextOssStep(current: OssOnboardingStep): OssOnboardingStep | null {
  const idx = OSS_ONBOARDING_STEPS.indexOf(current);
  if (idx < 0 || idx >= OSS_ONBOARDING_STEPS.length - 1) return null;
  return OSS_ONBOARDING_STEPS[idx + 1];
}

export function defaultOssState(): OssOnboardingState {
  return {
    currentStep: "welcome",
    completedSteps: [],
    skippedSteps: [],
    lastActivityAt: null,
    completedAt: null,
    data: {},
  };
}

export function parseOssState(raw: string | null): OssOnboardingState | null {
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
    const parsed = obj as OssOnboardingState;
    if (!isOssOnboardingStep(parsed.currentStep)) {
      parsed.currentStep = "welcome";
    }
    if (!Array.isArray(parsed.completedSteps)) parsed.completedSteps = [];
    if (!Array.isArray(parsed.skippedSteps)) parsed.skippedSteps = [];
    if (!parsed.data) parsed.data = {};
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Helper for the progress indicator (1/10, 2/10, …). `done` does not count.
 * The total is derived from the tuple so adding/removing a step needs no
 * second edit here.
 */
export function stepProgress(step: OssOnboardingStep): { current: number; total: number } {
  const total = OSS_STEP_COUNT;
  const idx = OSS_ONBOARDING_STEPS.indexOf(step);
  const current = idx < 0 ? 1 : Math.min(idx + 1, total);
  return { current, total };
}
