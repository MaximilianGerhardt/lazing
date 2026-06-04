/**
 * Skill service (Phase S — skill-first-class).
 *
 * CRUD + built-in seed. Runs automatically on first boot — if
 * the `skills` table is empty, the 16 built-ins from `built-in.ts`
 * are seeded. Idempotent.
 *
 * The tier orchestrator uses `pickActiveSkillForIndex` as a drop-in for the
 * old `pickRoleForIndex` function.
 */

import { and, asc, eq, isNull } from 'drizzle-orm';

import { getDb } from '../../../db/client';
import { skills, type SkillRow } from '../../../db/schema/skills';
import { BUILT_IN_SKILLS } from './built-in';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Tier = 'opus' | 'sonnet' | 'haiku';
export type Effort = 'xhigh' | 'high' | 'medium' | 'low';

export interface Skill {
  id: string;
  name: string;
  focusPrompt: string;
  preferTier: Tier;
  defaultEffort: Effort;
  defaultCount: number;
  description: string | null;
  builtIn: boolean;
  archived: boolean;
}

export interface CreateSkillInput {
  name: string;
  focusPrompt: string;
  preferTier?: Tier;
  defaultEffort?: Effort;
  defaultCount?: number;
  description?: string;
}

export interface UpdateSkillInput {
  focusPrompt?: string;
  preferTier?: Tier;
  defaultEffort?: Effort;
  defaultCount?: number;
  description?: string | null;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let seedDone = false;

export function ensureSkillsSeeded(): void {
  if (seedDone) return;
  const db = getDb();
  const now = Date.now();
  const existing = db.select({ id: skills.id }).from(skills).all();
  const existingIds = new Set(existing.map((r) => r.id));
  for (const s of BUILT_IN_SKILLS) {
    if (existingIds.has(s.id)) continue;
    db.insert(skills)
      .values({
        id: s.id,
        name: s.name,
        focusPrompt: s.focusPrompt,
        preferTier: s.preferTier,
        defaultEffort: s.defaultEffort,
        defaultCount: s.defaultCount,
        description: s.description,
        builtIn: true,
        archivedAt: null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }
  seedDone = true;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export function listSkills(opts: { includeArchived?: boolean } = {}): Skill[] {
  ensureSkillsSeeded();
  const db = getDb();
  const where = opts.includeArchived ? undefined : isNull(skills.archivedAt);
  const rows = db.select().from(skills).where(where).orderBy(asc(skills.name)).all();
  return rows.map(rowToSkill);
}

export function getSkill(id: string): Skill | null {
  ensureSkillsSeeded();
  const db = getDb();
  const row = db.select().from(skills).where(eq(skills.id, id)).get();
  return row ? rowToSkill(row) : null;
}

export function getSkillByName(name: string): Skill | null {
  ensureSkillsSeeded();
  const db = getDb();
  const row = db.select().from(skills).where(eq(skills.name, name)).get();
  return row ? rowToSkill(row) : null;
}

/**
 * Drop-in replacement for the old `pickRoleForIndex` from diversity-roles.ts.
 * Returns the `idx % len`-th active skill (alphabetical by name).
 */
export function pickActiveSkillForIndex(idx: number): Skill {
  const active = listSkills({ includeArchived: false });
  if (active.length === 0) {
    // Should never happen — built-ins are always there. Fallback hard-coded.
    return {
      id: 'skill-fallback',
      name: 'General',
      focusPrompt:
        'Allgemeine Analyse — was sticht heraus, was lohnt zu prüfen.',
      preferTier: 'sonnet',
      defaultEffort: 'medium',
      defaultCount: 1,
      description: null,
      builtIn: true,
      archived: false,
    };
  }
  return active[idx % active.length];
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export function createSkill(input: CreateSkillInput): Skill {
  ensureSkillsSeeded();
  const db = getDb();
  const now = Date.now();
  const id = `skill-user-${slugify(input.name)}-${now}`;
  db.insert(skills)
    .values({
      id,
      name: input.name,
      focusPrompt: input.focusPrompt,
      preferTier: input.preferTier ?? 'sonnet',
      defaultEffort: input.defaultEffort ?? 'medium',
      defaultCount: input.defaultCount ?? 1,
      description: input.description ?? null,
      builtIn: false,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  const row = db.select().from(skills).where(eq(skills.id, id)).get();
  if (!row) throw new Error('skill_create_failed');
  return rowToSkill(row);
}

export function updateSkill(id: string, patch: UpdateSkillInput): Skill | null {
  ensureSkillsSeeded();
  const db = getDb();
  const existing = db.select().from(skills).where(eq(skills.id, id)).get();
  if (!existing) return null;
  if (existing.builtIn && (patch.focusPrompt || patch.preferTier || patch.defaultEffort || patch.defaultCount)) {
    // Built-in: only description editable — the rest stays stable
    const desc = patch.description === undefined ? existing.description : patch.description;
    db.update(skills)
      .set({ description: desc, updatedAt: Date.now() })
      .where(eq(skills.id, id))
      .run();
  } else {
    db.update(skills)
      .set({
        focusPrompt: patch.focusPrompt ?? existing.focusPrompt,
        preferTier: patch.preferTier ?? existing.preferTier,
        defaultEffort: patch.defaultEffort ?? existing.defaultEffort,
        defaultCount: patch.defaultCount ?? existing.defaultCount,
        description:
          patch.description === undefined ? existing.description : patch.description,
        updatedAt: Date.now(),
      })
      .where(eq(skills.id, id))
      .run();
  }
  const row = db.select().from(skills).where(eq(skills.id, id)).get();
  return row ? rowToSkill(row) : null;
}

export function archiveSkill(id: string): boolean {
  ensureSkillsSeeded();
  const db = getDb();
  const existing = db.select().from(skills).where(eq(skills.id, id)).get();
  if (!existing) return false;
  if (existing.builtIn) return false;
  if (existing.archivedAt) return false;
  db.update(skills)
    .set({ archivedAt: Date.now(), updatedAt: Date.now() })
    .where(and(eq(skills.id, id), isNull(skills.archivedAt)))
    .run();
  return true;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToSkill(row: SkillRow): Skill {
  return {
    id: row.id,
    name: row.name,
    focusPrompt: row.focusPrompt,
    preferTier: row.preferTier as Tier,
    defaultEffort: row.defaultEffort as Effort,
    defaultCount: row.defaultCount,
    description: row.description ?? null,
    builtIn: Boolean(row.builtIn),
    archived: row.archivedAt !== null,
  };
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}
