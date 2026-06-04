/**
 * lib/skills/__tests__/validate.test.ts — SKILL.md-Validierung.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { validateSkill } from '../validate';

let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'skillval-'));
  process.env.LAZYOS_SKILLS_DIR = base;
});

function mkSkill(id: string, frontmatter: string, body = '# Body\nMach X.'): void {
  const dir = join(base, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n${body}\n`);
}

describe('validateSkill', () => {
  it('ok bei korrektem name + description', () => {
    mkSkill('good', 'name: good\ndescription: Ein klarer Skill für PDFs.');
    const r = validateSkill('good');
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('Fehler bei fehlendem name/description', () => {
    mkSkill('bad', 'name: bad');
    const r = validateSkill('bad');
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => /description/.test(e))).toBe(true);
  });

  it('Fehler wenn keine SKILL.md', () => {
    mkdirSync(join(base, 'empty'), { recursive: true });
    const r = validateSkill('empty');
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/SKILL\.md/);
  });

  it('Warnung bei zu langer description', () => {
    mkSkill('long', `name: long\ndescription: ${'x'.repeat(1100)}`);
    const r = validateSkill('long');
    expect(r.ok).toBe(true); // Warnung, kein Fehler
    expect(r.warnings.some((w) => /description ist/.test(w))).toBe(true);
  });

  it('Warnung bei Namens-Konvention', () => {
    mkSkill('Weird_Name', 'name: Weird_Name\ndescription: test');
    const r = validateSkill('Weird_Name');
    expect(r.warnings.some((w) => /Konvention/.test(w))).toBe(true);
  });
});
