/**
 * /lab kinds catalog (MVP, 2026-05-01).
 *
 * Metadata list of the MVP showcase surfaces. Read by both the landing
 * (`app/lab/page.tsx`) and the detail page (`app/lab/[kind]/page.tsx`)
 * to keep routing, sidebar and pattern-archetype cards consistent.
 *
 * Strictly typed — no dynamic lookup on string keys; all consumers
 * iterate MVP_KINDS or use findKindById().
 */

export type Archetype = "coding" | "planning" | "bug-fix";

export interface KindMeta {
  /** Stable ID, identical to the `kind` value in event payloads. */
  id: string;
  /** Human-readable label for sidebar/cards. */
  label: string;
  /** Pattern archetype for the landing grouping. */
  archetype: Archetype;
  /** Workspace ID in which this pattern is primarily used. */
  primaryWorkspace: string;
  /** Path to the card component (relative to repo root). */
  componentPath: string;
  /** Short description for the card subline. */
  description: string;
}

export const MVP_KINDS: ReadonlyArray<KindMeta> = [
  {
    id: "auto-dispatch-stage",
    label: "Auto-Dispatch (3-Tier-Loop)",
    archetype: "coding",
    primaryWorkspace: "demo-fitness",
    componentPath: "lib/chat/LoopPhaseCard.tsx",
    description: "Senior-Dev → Code-Reviewer → Critic Loop (LoopPhaseCard)",
  },
  {
    id: "iterate-roast",
    label: "Iterate Roast",
    archetype: "coding",
    primaryWorkspace: "demo-fitness",
    componentPath: "lib/chat/IterateRoastCard.tsx",
    description:
      "4-5 Roaster-Perspektiven (Performance, Hacker, Pragmatist, User-Anwalt)",
  },
  {
    id: "sub-workstream",
    label: "Sub-Workstream",
    archetype: "planning",
    primaryWorkspace: "demo-client",
    componentPath: "lib/chat/SubWorkstreamsCard.tsx",
    description: "Sniper-Mode Sub-Plan-Delegation",
  },
  {
    id: "bug-fix-swarm",
    label: "Bug-Fix-Swarm",
    archetype: "bug-fix",
    primaryWorkspace: "lazyos",
    componentPath: "lib/chat/BugFixSwarmCard.tsx",
    description: "3 parallele Diagnose-Spawns",
  },
  {
    id: "synthesis",
    label: "Synthesis",
    archetype: "coding",
    primaryWorkspace: "lazyos",
    componentPath: "lib/chat/MilestoneCard.tsx",
    description: "Lead-Synthesizer Multi-Tier-Konsolidierung",
  },
  // Wave 7 (2026-05-01) — loop-phase coverage. 5 new kinds, one card each.
  {
    id: "iterate-version",
    label: "Iterate Version",
    archetype: "coding",
    primaryWorkspace: "demo-fitness",
    componentPath: "lib/chat/IterateVersionCard.tsx",
    description: "V1→V2→V3 Version-Anker pro Iterate-Welle",
  },
  {
    id: "sniper-pause-start",
    label: "Sniper-Pause",
    archetype: "coding",
    primaryWorkspace: "demo-fitness",
    componentPath: "lib/chat/LoopPhaseCard.tsx",
    description: "Pause vor V_n+1 für User-Inject (LoopPhaseCard)",
  },
  {
    id: "plan-open-questions",
    label: "Plan-Fragen (Card)",
    archetype: "planning",
    primaryWorkspace: "lazyos",
    componentPath: "lib/chat/PlanOpenQuestionsCard.tsx",
    description: "Offene Plan-Fragen mit QuickChoice-Buttons",
  },
  // Wave 1 · 2026-05-03 · sub-plan dazzling-quilt
  // Single-source-of-truth showcase for the "agent is working" indicator.
  {
    id: "streaming-bubble",
    label: "Streaming-Bubble",
    archetype: "coding",
    primaryWorkspace: "lazyos",
    componentPath: "lib/chat/ChatShell.tsx",
    description:
      "Live-Streaming-Indikator (Bubble + Phase-Text + Floating-Stop)",
  },
] as const;

export function findKindById(id: string): KindMeta | null {
  return MVP_KINDS.find((k) => k.id === id) ?? null;
}

export interface ArchetypeMeta {
  id: Archetype;
  label: string;
  primaryWorkspace: string;
  primaryWorkspaceLabel: string;
  primaryKindId: string;
  description: string;
}

export const ARCHETYPES: ReadonlyArray<ArchetypeMeta> = [
  {
    id: "coding",
    label: "Coding",
    primaryWorkspace: "demo-fitness",
    primaryWorkspaceLabel: "Demo Fitness Fitness",
    primaryKindId: "auto-dispatch-stage",
    description: "Auto-Dispatch 3-Tier-Loop für Code-Surfaces",
  },
  {
    id: "planning",
    label: "Planning",
    primaryWorkspace: "demo-client",
    primaryWorkspaceLabel: "Demo PV",
    primaryKindId: "sub-workstream",
    description: "Sniper-Mode Sub-Workstream-Delegation",
  },
  {
    id: "bug-fix",
    label: "Bug-Fix",
    primaryWorkspace: "lazyos",
    primaryWorkspaceLabel: "lazyOS",
    primaryKindId: "bug-fix-swarm",
    description: "3 parallele Diagnose-Spawns",
  },
] as const;

/** Kind IDs grouped by archetype (for counts on the landing page). */
export function kindsByArchetype(archetype: Archetype): ReadonlyArray<KindMeta> {
  return MVP_KINDS.filter((k) => k.archetype === archetype);
}
