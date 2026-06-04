/**
 * Diversity roles for the tier spawn (Phase A → Phase S adapter).
 *
 * Phase S made skills first-class entities. This file is now
 * an adapter that maps the old API (DIVERSITY_ROLES + pickRoleForIndex) onto
 * the new skill service. Existing code (server/agents/tier-
 * orchestrator.ts) does not need to be changed — the adapter delivers the
 * same shape but fetches dynamically from the DB.
 */

import {
  pickActiveSkillForIndex,
  listSkills,
  type Skill,
} from './skills/service';

export interface DiversityRole {
  name: string;
  focus: string;
}

function skillToRole(s: Skill): DiversityRole {
  return { name: s.name, focus: s.focusPrompt };
}

export function pickRoleForIndex(idx: number): DiversityRole {
  return skillToRole(pickActiveSkillForIndex(idx));
}

/**
 * Snapshot of the active skills as a diversity-role list. Used by tests +
 * diagnostics; on the hot path there is `pickRoleForIndex` (1 skill, no
 * full scan).
 */
export function getDiversityRoles(): DiversityRole[] {
  return listSkills({ includeArchived: false }).map(skillToRole);
}

// Backward compat: the constant still exists, but is lazily loaded from the
// DB so the adapter works at runtime. Since the list is empty
// today (before boot), there is a getter — not all callers
// expect an array, hence a proxy.
export const DIVERSITY_ROLES: ReadonlyArray<DiversityRole> = new Proxy(
  [] as DiversityRole[],
  {
    get(_target, prop) {
      const list = getDiversityRoles();
      // @ts-expect-error string-prop access on array
      return list[prop];
    },
    has(_target, prop) {
      const list = getDiversityRoles();
      return prop in list;
    },
  },
) as ReadonlyArray<DiversityRole>;
