/**
 * lib/skills/install.ts — install skills (owner: "also install!").
 *
 * Sources:
 *   - Local path: a SKILL.md folder OR a folder full of skill subfolders.
 *   - Git: `owner/repo`, `owner/repo/sub/path`, or a full https git URL.
 *     (e.g. `anthropics/skills/skills/pdf`, `openai/skills`.) Shallow clone.
 *
 * Copies the SKILL.md folders into the laz.ing store (lib/skills/store) + writes
 * a `.lazyos-source` marker, then syncs into all engine directories
 * (claude + codex). This makes the skill usable cross-engine IMMEDIATELY.
 *
 * Pure Node (fs + git via spawnSync). Best-effort with clear errors.
 */

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ensureSkillsDir, getSkillsDir } from './store';
import { syncSkillsToEngines, type SyncResult } from './sync';

export class SkillInstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillInstallError';
  }
}

export interface InstallResult {
  installed: string[];
  sync: SyncResult[];
}

function hasSkillMd(dir: string): boolean {
  return existsSync(join(dir, 'SKILL.md'));
}

/** Finds all skill folders under `root` (root itself OR direct subfolders). */
function findSkillFolders(root: string): string[] {
  if (hasSkillMd(root)) return [root];
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.startsWith('.')) continue;
    const full = join(root, e);
    try {
      if (statSync(full).isDirectory() && hasSkillMd(full)) out.push(full);
    } catch {
      /* skip */
    }
  }
  return out;
}

/** Is `source` a git spec (owner/repo[/subpath] or https/git URL)? */
function isGitSource(source: string): boolean {
  if (/^https?:\/\//.test(source) || source.startsWith('git@')) return true;
  // owner/repo[/...] — but NOT an existing local path.
  return /^[\w.-]+\/[\w.-]+(\/.*)?$/.test(source) && !existsSync(source);
}

function resolveGit(source: string): { url: string; subpath: string } {
  if (/^https?:\/\//.test(source) || source.startsWith('git@')) {
    return { url: source, subpath: '' };
  }
  const parts = source.split('/');
  const owner = parts[0];
  const repo = parts[1];
  const subpath = parts.slice(2).join('/');
  return { url: `https://github.com/${owner}/${repo}.git`, subpath };
}

function copySkillToStore(folder: string, source: string): string {
  const id = folder.split('/').filter(Boolean).pop() ?? 'skill';
  const dest = join(ensureSkillsDir(), id);
  // Overwriting allowed (re-install/update); first remove the old folder.
  try {
    rmSync(dest, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  cpSync(folder, dest, { recursive: true });
  try {
    writeFileSync(join(dest, '.lazyos-source'), source, 'utf8');
  } catch {
    /* marker best-effort */
  }
  return id;
}

/**
 * Installs skill(s) from `source` into the store + syncs them into all engines.
 */
export async function installSkill(source: string): Promise<InstallResult> {
  const src = (source ?? '').trim();
  if (!src) throw new SkillInstallError('Keine Quelle angegeben.');
  getSkillsDir();

  let roots: string[] = [];
  let cleanup: (() => void) | null = null;

  if (isGitSource(src)) {
    const { url, subpath } = resolveGit(src);
    const tmp = mkdtempSync(join(tmpdir(), 'lazyos-skill-'));
    cleanup = () => {
      try {
        rmSync(tmp, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    };
    const clone = spawnSync('git', ['clone', '--depth', '1', url, tmp], {
      encoding: 'utf8',
      timeout: 120_000,
    });
    if (clone.status !== 0) {
      cleanup();
      throw new SkillInstallError(`git clone fehlgeschlagen: ${(clone.stderr || '').slice(0, 300)}`);
    }
    const base = subpath ? join(tmp, subpath) : tmp;
    if (!existsSync(base)) {
      cleanup();
      throw new SkillInstallError(`Unterpfad nicht gefunden: ${subpath}`);
    }
    roots = findSkillFolders(base);
  } else {
    if (!existsSync(src)) throw new SkillInstallError(`Pfad nicht gefunden: ${src}`);
    roots = findSkillFolders(src);
  }

  try {
    if (roots.length === 0) {
      throw new SkillInstallError('Keine SKILL.md gefunden (weder im Pfad noch in den Unterordnern).');
    }
    const installed = roots.map((r) => copySkillToStore(r, src));
    const sync = syncSkillsToEngines();
    return { installed, sync };
  } finally {
    if (cleanup) cleanup();
  }
}
