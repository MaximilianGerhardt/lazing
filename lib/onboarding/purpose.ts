/**
 * Usage-purpose → workspace-seed map (Track B, B5).
 *
 * A pure function (no I/O) that turns the user's picked UsagePurpose into a
 * pre-seed for the workspace step: a default label, a sensitivity level, and a
 * short hint about how the workspace will be segmented. The wizard pre-fills
 * the workspace form from this; the user can still edit every field.
 */

import type { UsagePurpose } from "./oss-state";

export interface WorkspaceSeed {
  /** Default workspace label, pre-filled into the name field. */
  workspaceLabel: string;
  /** Default sensitivity for the workspace. */
  sensitivity: "low" | "normal" | "high";
  /** One-line hint about segmentation/organization, shown under the field. */
  segmentsHint: string;
}

export const PURPOSE_OPTIONS: ReadonlyArray<{
  id: UsagePurpose;
  title: string;
  blurb: string;
}> = Object.freeze([
  {
    id: "agency",
    title: "Agency / client work",
    blurb: "Multiple client workspaces, each isolated. Higher default sensitivity.",
  },
  {
    id: "personal",
    title: "Personal projects",
    blurb: "Your own projects and experiments. Relaxed defaults.",
  },
  {
    id: "contributor",
    title: "Contributing to lazyOS",
    blurb: "Hack on lazyOS itself. A dev workspace pointing at this checkout.",
  },
]);

const SEED_MAP: Readonly<Record<UsagePurpose, WorkspaceSeed>> = Object.freeze({
  agency: {
    workspaceLabel: "Client Work",
    sensitivity: "normal",
    segmentsHint:
      "Create one workspace per client; each stays scope-isolated (files, chats, decisions).",
  },
  personal: {
    workspaceLabel: "My Workspace",
    sensitivity: "low",
    segmentsHint: "A single workspace for your own projects — add more any time.",
  },
  contributor: {
    workspaceLabel: "lazyOS Dev",
    sensitivity: "low",
    segmentsHint: "A development workspace pointed at your lazyOS checkout.",
  },
});

/** Pure map: UsagePurpose -> WorkspaceSeed. */
export function seedForPurpose(purpose: UsagePurpose): WorkspaceSeed {
  return SEED_MAP[purpose];
}

/** All valid purpose ids (for route validation). */
export const USAGE_PURPOSES: readonly UsagePurpose[] = Object.freeze([
  "agency",
  "personal",
  "contributor",
]);

export function isUsagePurpose(s: string): s is UsagePurpose {
  return (USAGE_PURPOSES as readonly string[]).includes(s);
}
