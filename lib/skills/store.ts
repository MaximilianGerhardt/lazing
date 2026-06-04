/**
 * lib/skills/store.ts — cross-engine skill store (2026-06-03).
 *
 * Owner directive: "Skills must work cross-engine … and
 * as OSS it must be able to do this and also install."
 *
 * laz.ing keeps ONE neutral skill store (SKILL.md folders, open standard
 * agentskills.io). From there skills are synced into the native engine directories
 * (claude → ~/.claude/skills, codex → ~/.codex/skills — both load
 * SKILL.md natively), or injected via a prompt block for engines without a skill
 * system (ollama). This way ONE skill works in EVERY engine.
 *
 * This module: store path, SKILL.md frontmatter parsing, listing. Pure
 * Node FS, deterministic, testable (LAZYOS_SKILLS_DIR override).
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface InstalledSkill {
  /** Folder name (= skill ID). */
  id: string;
  /** From the SKILL.md frontmatter (`name:`); fallback = id. */
  name: string;
  /** From the frontmatter (`description:`); for trigger + listing. */
  description: string;
  /** Absolute folder path. */
  dir: string;
  /** Optional origin (from .lazyos-source, if installed). */
  source?: string;
}

/** The laz.ing skill store. Override for tests/deployment via LAZYOS_SKILLS_DIR. */
export function getSkillsDir(): string {
  return process.env.LAZYOS_SKILLS_DIR ?? join(homedir(), '.lazyos', 'skills');
}

export function ensureSkillsDir(): string {
  const dir = getSkillsDir();
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Parses name + description from the YAML frontmatter of a SKILL.md.
 * Tolerant: simple `key: value` lines (with/without quotes), first --- … --- block.
 */
export function parseSkillMd(skillMdPath: string): { name: string; description: string } | null {
  let raw: string;
  try {
    raw = readFileSync(skillMdPath, 'utf8');
  } catch {
    return null;
  }
  const fm = raw.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!fm) return null;
  const block = fm[1];
  const grab = (key: string): string => {
    const m = block.match(new RegExp(`^${key}\\s*:\\s*(.+)$`, 'm'));
    if (!m) return '';
    let v = m[1].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    return v;
  };
  const name = grab('name');
  const description = grab('description');
  if (!name && !description) return null;
  return { name, description };
}

/** A single skill folder → InstalledSkill (or null if no SKILL.md). */
export function readSkillDir(dir: string): InstalledSkill | null {
  const skillMd = join(dir, 'SKILL.md');
  if (!existsSync(skillMd)) return null;
  const id = dir.split('/').filter(Boolean).pop() ?? 'skill';
  const meta = parseSkillMd(skillMd) ?? { name: id, description: '' };
  let source: string | undefined;
  try {
    source = readFileSync(join(dir, '.lazyos-source'), 'utf8').trim() || undefined;
  } catch {
    /* not installed / no source marker */
  }
  return { id, name: meta.name || id, description: meta.description, dir, source };
}

/** List all skills in the store. */
export function listInstalledSkills(): InstalledSkill[] {
  const dir = getSkillsDir();
  if (!existsSync(dir)) return [];
  const out: InstalledSkill[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.')) continue;
    const full = join(dir, entry);
    try {
      if (!statSync(full).isDirectory()) continue;
    } catch {
      continue;
    }
    const skill = readSkillDir(full);
    if (skill) out.push(skill);
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}
