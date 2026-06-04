/**
 * lib/skills/sync.ts — make skills available cross-engine (2026-06-03).
 *
 * Three distribution paths (one skill, every engine):
 *   - claude-cli: symlink store skill → ~/.claude/skills/<id> (claude loads SKILL.md natively).
 *   - codex-cli:  symlink store skill → ~/.codex/skills/<id>  (codex loads SKILL.md natively).
 *   - ollama / no skill system: buildOllamaSkillBlock() → prompt injection of the
 *     skill metadata (name + description), so that even a bare model knows
 *     which playbooks exist + can follow them.
 *
 * SECURITY: NEVER overwrite a foreign (non-laz.ing) skill of the same name
 * — we only create when the target is missing OR is already a
 * laz.ing symlink. Reversible (remove the symlink).
 */

import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { getSkillsDir, listInstalledSkills } from './store';

export type SkillEngine = 'claude-cli' | 'codex-cli';

/** Native skill directories of the engines (open SKILL.md standard). */
export function engineSkillDir(engine: SkillEngine): string {
  const home = process.env.HOME ?? homedir();
  if (engine === 'claude-cli') {
    return process.env.LAZYOS_CLAUDE_SKILLS_DIR ?? join(home, '.claude', 'skills');
  }
  return process.env.LAZYOS_CODEX_SKILLS_DIR ?? join(home, '.codex', 'skills');
}

export interface SyncResult {
  engine: SkillEngine;
  dir: string;
  linked: string[];
  skipped: { id: string; reason: string }[];
}

/** Is `target` a laz.ing-managed symlink into the store? */
function isLazyosLink(target: string, storeDir: string): boolean {
  try {
    if (!lstatSync(target).isSymbolicLink()) return false;
    return readlinkSync(target).startsWith(storeDir);
  } catch {
    return false;
  }
}

/**
 * Syncs all store skills into the native directory of an engine (symlinks).
 * Creates the engine directory if needed. Foreign skills of the same name stay
 * untouched (skipped: 'foreign-exists').
 */
export function syncSkillsToEngine(engine: SkillEngine): SyncResult {
  const storeDir = getSkillsDir();
  const dir = engineSkillDir(engine);
  const result: SyncResult = { engine, dir, linked: [], skipped: [] };
  const skills = listInstalledSkills();
  if (skills.length === 0) return result;
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    result.skipped.push({ id: '*', reason: `mkdir failed: ${(err as Error).message}` });
    return result;
  }
  for (const s of skills) {
    const target = join(dir, s.id);
    if (existsSync(target) || (() => { try { return lstatSync(target) != null; } catch { return false; } })()) {
      // Already a laz.ing link → reset idempotently; otherwise foreign → skip.
      if (isLazyosLink(target, storeDir)) {
        try {
          rmSync(target, { force: true });
        } catch {
          result.skipped.push({ id: s.id, reason: 'relink-failed' });
          continue;
        }
      } else {
        result.skipped.push({ id: s.id, reason: 'foreign-exists' });
        continue;
      }
    }
    try {
      symlinkSync(s.dir, target, 'dir');
      result.linked.push(s.id);
    } catch (err) {
      result.skipped.push({ id: s.id, reason: (err as Error).message });
    }
  }
  return result;
}

/** Syncs into ALL existing engine directories (claude + codex). */
export function syncSkillsToEngines(engines: SkillEngine[] = ['claude-cli', 'codex-cli']): SyncResult[] {
  return engines.map((e) => syncSkillsToEngine(e));
}

/**
 * Prompt injection for engines WITHOUT a native skill system (ollama et al.). Lists
 * the name + description of all installed skills so the model knows which
 * playbooks exist. (The full SKILL.md body is NOT injected — context
 * budget; a skill can be referenced explicitly if needed.)
 */
export function buildOllamaSkillBlock(): string | null {
  const skills = listInstalledSkills();
  if (skills.length === 0) return null;
  const lines = skills.map(
    (s) => `- ${s.name}: ${s.description.slice(0, 240)}`,
  );
  return [
    '## Verfügbare Skills (Playbooks)',
    'Du hast Zugriff auf folgende prozedurale Skills. Wenn eine Aufgabe zu einem',
    'Skill passt, folge seinem Vorgehen:',
    ...lines,
  ].join('\n');
}
