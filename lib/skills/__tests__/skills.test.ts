/**
 * lib/skills/__tests__/skills.test.ts — Engine-übergreifende Skills.
 *
 * Temp-Dirs via LAZYOS_SKILLS_DIR / LAZYOS_CLAUDE_SKILLS_DIR /
 * LAZYOS_CODEX_SKILLS_DIR. Verifiziert: install → Store → Sync (Symlinks) in
 * claude+codex, Ollama-Prompt-Block, kein Clobbern fremder Skills.
 */

import { existsSync, lstatSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { getSkillsDir, listInstalledSkills } from '../store';
import { installSkill } from '../install';
import { buildOllamaSkillBlock, syncSkillsToEngines } from '../sync';

let base: string;
let claudeDir: string;
let codexDir: string;
let srcSkill: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'skilltest-'));
  claudeDir = join(base, 'claude-skills');
  codexDir = join(base, 'codex-skills');
  process.env.LAZYOS_SKILLS_DIR = join(base, 'store');
  process.env.LAZYOS_CLAUDE_SKILLS_DIR = claudeDir;
  process.env.LAZYOS_CODEX_SKILLS_DIR = codexDir;
  srcSkill = join(base, 'src', 'my-skill');
  mkdirSync(srcSkill, { recursive: true });
  writeFileSync(
    join(srcSkill, 'SKILL.md'),
    `---\nname: my-skill\ndescription: Test-Skill für Deliverables\n---\n# Body\nMach X.\n`,
  );
});

describe('Engine-übergreifende Skills', () => {
  it('installiert in den Store + synct (Symlink) in claude UND codex', async () => {
    const res = await installSkill(srcSkill);
    expect(res.installed).toContain('my-skill');

    // Im Store gelistet (mit Frontmatter-Name + Source-Marker).
    const listed = listInstalledSkills();
    expect(listed.map((s) => s.id)).toContain('my-skill');
    expect(listed.find((s) => s.id === 'my-skill')?.name).toBe('my-skill');
    expect(listed.find((s) => s.id === 'my-skill')?.source).toBe(srcSkill);

    // Native Engine-Verzeichnisse: Symlink mit erreichbarer SKILL.md.
    for (const dir of [claudeDir, codexDir]) {
      expect(lstatSync(join(dir, 'my-skill')).isSymbolicLink()).toBe(true);
      expect(existsSync(join(dir, 'my-skill', 'SKILL.md'))).toBe(true);
    }
    expect(getSkillsDir()).toBe(join(base, 'store'));
  });

  it('Ollama-Prompt-Block listet die installierten Skills', async () => {
    await installSkill(srcSkill);
    const block = buildOllamaSkillBlock();
    expect(block).toBeTruthy();
    expect(block).toContain('my-skill');
    expect(block).toContain('Test-Skill für Deliverables');
  });

  it('überschreibt KEINEN fremden gleichnamigen Skill (foreign-exists)', async () => {
    await installSkill(srcSkill);
    // Fremden „my-skill" (echter Ordner, kein laz.ing-Symlink) in claudeDir anlegen.
    const foreign = join(claudeDir, 'my-skill');
    // erst den Symlink entfernen, dann echten Ordner — simuliert Fremdbesitz.
    const { rmSync } = await import('node:fs');
    rmSync(foreign, { recursive: true, force: true });
    mkdirSync(foreign, { recursive: true });
    writeFileSync(join(foreign, 'SKILL.md'), '---\nname: foreign\n---\n');
    const sync = syncSkillsToEngines(['claude-cli']);
    const claude = sync.find((s) => s.engine === 'claude-cli')!;
    expect(claude.skipped.some((sk) => sk.id === 'my-skill' && sk.reason === 'foreign-exists')).toBe(true);
    expect(lstatSync(foreign).isSymbolicLink()).toBe(false); // bleibt der fremde Ordner
  });
});
