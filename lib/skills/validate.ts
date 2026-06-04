/**
 * lib/skills/validate.ts — SKILL.md validation (2026-06-03), dependency-free.
 *
 * Instead of shelling out to the fragile python `quick_validate.py` (needs
 * pyyaml + py3.8+), we validate SKILL.md in TypeScript — engine-agnostic, without
 * a toolchain. Checks the trigger/context-budget rules from the research
 * (docs/research/2026-06-03_skills-mcp-skillcreator-research.md §1.1/6):
 *   - SKILL.md present, frontmatter parseable.
 *   - name present + convention (lowercase, hyphens).
 *   - description present (= primary trigger).
 *   - description cap: Claude-Code listing ~1536 chars (name+desc+when_to_use)
 *     → warning from 1024 chars description.
 *   - keep the body concise (progressive disclosure) → warning > 5000 words.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { getSkillsDir, parseSkillMd } from './store';

export interface SkillValidation {
  id: string;
  ok: boolean;
  errors: string[];
  warnings: string[];
}

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const DESC_WARN_CHARS = 1024;
const BODY_WARN_WORDS = 5000;

/** Validates a skill in the store (or an absolute folder path). */
export function validateSkill(idOrDir: string): SkillValidation {
  const dir = idOrDir.includes('/') ? idOrDir : join(getSkillsDir(), idOrDir);
  const id = dir.split('/').filter(Boolean).pop() ?? idOrDir;
  const errors: string[] = [];
  const warnings: string[] = [];

  const skillMd = join(dir, 'SKILL.md');
  if (!existsSync(skillMd)) {
    return { id, ok: false, errors: ['Keine SKILL.md gefunden.'], warnings };
  }
  const meta = parseSkillMd(skillMd);
  if (!meta) {
    return { id, ok: false, errors: ['Frontmatter (--- … ---) fehlt oder nicht parsebar.'], warnings };
  }

  if (!meta.name) errors.push('Pflichtfeld `name` fehlt.');
  else if (!NAME_RE.test(meta.name)) {
    warnings.push(`name "${meta.name}" weicht von der Konvention ab (lowercase, Bindestriche).`);
  }

  if (!meta.description) {
    errors.push('Pflichtfeld `description` fehlt (= primärer Trigger).');
  } else if (meta.description.length > DESC_WARN_CHARS) {
    warnings.push(
      `description ist ${meta.description.length} Zeichen — Claude-Code-Listing cappt bei ~1536 (inkl. when_to_use). Kürzer triggert zuverlässiger.`,
    );
  }

  // Body (after the frontmatter) — word budget.
  try {
    const raw = readFileSync(skillMd, 'utf8');
    const body = raw.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '');
    const words = body.split(/\s+/).filter(Boolean).length;
    if (words > BODY_WARN_WORDS) {
      warnings.push(`Body hat ~${words} Wörter (>${BODY_WARN_WORDS}). Progressive disclosure: Details in references/ auslagern.`);
    }
  } catch {
    /* body read best-effort */
  }

  return { id, ok: errors.length === 0, errors, warnings };
}
