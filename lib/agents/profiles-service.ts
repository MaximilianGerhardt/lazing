/**
 * lib/agents/profiles-service.ts — "employee" profiles, slice 1.
 *
 * Research: docs/research/2026-06-03_skills-mcp-skillcreator-research.md §4.
 *
 * CRUD + validation + spawn resolution for named agent profiles. A profile
 * bundles role + skills + MCP + SOPs + APIs + scope into a reusable
 * "employee" that is spawned ad-hoc (no persistent agent user, CLAUDE.md).
 *
 * Discipline: N1 (name/description verbatim), N6 (deterministic validation
 * against the 12-role taxonomy + ROLE_SKILL_MAP, no LLM), N9 (workspace/org
 * scope), least-privilege (resolveProfileAllowlist).
 */

import { and, desc, eq, isNull, or } from 'drizzle-orm';

import { getDb } from '@/db/client';
import { agentProfiles, type AgentProfileRow } from '@/db/schema/agent_profiles';
import { ulid } from '@/lib/ulid';
import { SUBAGENT_ROLES, type SubagentRole } from './spawner-types';
import { skillsForRole } from './role-skill-map';

export interface AgentProfile {
  id: string;
  name: string;
  description: string | null;
  role: SubagentRole;
  skills: string[];
  mcpServers: string[];
  sops: string[];
  apis: string[];
  workspaceId: string | null;
  orgId: string | null;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}

export class AgentProfileError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'AgentProfileError';
    this.code = code;
  }
}

export interface CreateAgentProfileInput {
  name: string;
  description?: string | null;
  role: string;
  skills?: string[];
  mcpServers?: string[];
  sops?: string[];
  apis?: string[];
  workspaceId?: string | null;
  orgId?: string | null;
  createdBy?: string | null;
}

function isSubagentRole(r: string): r is SubagentRole {
  return (SUBAGENT_ROLES as readonly string[]).includes(r);
}

function cleanList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === 'string')
    .map((x) => x.trim())
    .filter((x) => x.length > 0)
    .slice(0, 64);
}

function parseJsonList(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return cleanList(v);
  } catch {
    return [];
  }
}

/** Row → typed Profile. */
export function toAgentProfile(row: AgentProfileRow): AgentProfile {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    role: (isSubagentRole(row.role) ? row.role : 'researcher') as SubagentRole,
    skills: parseJsonList(row.skillsJson),
    mcpServers: parseJsonList(row.mcpServersJson),
    sops: parseJsonList(row.sopsJson),
    apis: parseJsonList(row.apisJson),
    workspaceId: row.workspaceId,
    orgId: row.orgId,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    archivedAt: row.archivedAt,
  };
}

/**
 * Creates a profile. Validates the role (N6) against the 12-role taxonomy and
 * requires a non-empty name (N1). Skills/MCP/SOPs/APIs are cleaned.
 *
 * @throws {AgentProfileError} on invalid name/invalid role.
 */
export function createAgentProfile(input: CreateAgentProfileInput): AgentProfile {
  const name = (input.name ?? '').trim();
  if (name.length === 0) {
    throw new AgentProfileError('invalid_name', 'Profil-Name darf nicht leer sein.');
  }
  if (name.length > 120) {
    throw new AgentProfileError('invalid_name', 'Profil-Name zu lang (max 120).');
  }
  if (!isSubagentRole(input.role)) {
    throw new AgentProfileError(
      'invalid_role',
      `Unbekannte Rolle "${input.role}". Erlaubt: ${SUBAGENT_ROLES.join(', ')}.`,
    );
  }
  const db = getDb();
  const now = Date.now();
  const id = `AGP-${ulid(now)}`;
  db.insert(agentProfiles)
    .values({
      id,
      name, // N1 verbatim
      description: input.description?.trim() || null,
      role: input.role,
      skillsJson: JSON.stringify(cleanList(input.skills)),
      mcpServersJson: JSON.stringify(cleanList(input.mcpServers)),
      sopsJson: JSON.stringify(cleanList(input.sops)),
      apisJson: JSON.stringify(cleanList(input.apis)),
      workspaceId: input.workspaceId ?? null,
      orgId: input.orgId ?? null,
      createdBy: input.createdBy ?? null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    })
    .run();
  return getAgentProfile(id)!;
}

export function getAgentProfile(id: string): AgentProfile | null {
  const row = getDb()
    .select()
    .from(agentProfiles)
    .where(eq(agentProfiles.id, id))
    .limit(1)
    .all()[0];
  return row ? toAgentProfile(row) : null;
}

/**
 * Lists active profiles in a scope. A workspace scope covers its
 * own profiles PLUS the personal/global ones visible (workspace_id IS NULL).
 */
export function listAgentProfiles(opts: {
  workspaceId?: string | null;
  includeArchived?: boolean;
} = {}): AgentProfile[] {
  const db = getDb();
  const conds = [] as ReturnType<typeof eq>[];
  if (!opts.includeArchived) conds.push(isNull(agentProfiles.archivedAt));
  const scopeCond =
    opts.workspaceId != null
      ? or(eq(agentProfiles.workspaceId, opts.workspaceId), isNull(agentProfiles.workspaceId))
      : undefined;
  const where =
    scopeCond && conds.length > 0
      ? and(scopeCond, ...conds)
      : scopeCond
        ? scopeCond
        : conds.length > 0
          ? and(...conds)
          : undefined;
  const rows = (where ? db.select().from(agentProfiles).where(where) : db.select().from(agentProfiles))
    .orderBy(desc(agentProfiles.updatedAt))
    .all();
  return rows.map(toAgentProfile);
}

export function archiveAgentProfile(id: string): boolean {
  const db = getDb();
  const existing = getAgentProfile(id);
  if (!existing || existing.archivedAt) return false;
  db.update(agentProfiles)
    .set({ archivedAt: Date.now(), updatedAt: Date.now() })
    .where(eq(agentProfiles.id, id))
    .run();
  return true;
}

/**
 * Effective skill allowlist for a profile spawn (least-privilege).
 *
 * The profile is the source of truth: its `skills` ARE the allowlist.
 * If no skills are set, it falls back to the role defaults (ROLE_SKILL_MAP)
 * — so a "bare" profile is still sensibly scoped. This list
 * overrides the ROLE_SKILL_MAP entry at spawn time (research §4.2-B).
 */
export function resolveProfileAllowlist(profile: AgentProfile): readonly string[] {
  if (profile.skills.length > 0) return profile.skills;
  return skillsForRole(profile.role);
}

/**
 * Bridge profile → spawn input. The existing spawner (`lib/agents/spawner.ts`)
 * already accepts `skillsAllowed` as an override of the role default allowlist
 * (`spawner.ts:432`: `input.skillsAllowed ?? skillsForRole(input.role)`). An
 * "employee" spawn is thus possible WITHOUT a spawner change:
 *
 *   const p = getAgentProfile(id)!;
 *   await spawnSubagent({ ...agentProfileToSpawnInput(p), task, signal });
 *
 * The profile's MCP/SOP/API bundles are additionally passed by the caller to the
 * respective gates (MCP config filter, lazing-policy-checker) — research §4.2-B.
 */
export function agentProfileToSpawnInput(profile: AgentProfile): {
  role: SubagentRole;
  skillsAllowed: readonly string[];
} {
  return { role: profile.role, skillsAllowed: resolveProfileAllowlist(profile) };
}
