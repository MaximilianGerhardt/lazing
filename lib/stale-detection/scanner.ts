/**
 * Stale-detection scanner — file-cleanup heuristic.
 *
 * NOTE on naming (2026-05-01):
 *   Was previously called "Unlearning Scanner". Renamed after user feedback —
 *   Anne (Legaly-AI) means by "to unlearn" a personal working attitude
 *   (discarding assumptions + experimenting), NOT file cleanup.
 *   The real unlearn pattern now lives in `lib/unlearning/`.
 *
 * Weekly re-evaluation of memory/docs/skills.
 * Provides archiving suggestions — NO actions.
 *
 * Critical:
 *  - STICKY items are parsed DYNAMICALLY from MEMORY.md (user-veto respect)
 *  - sticky=true → the suggestion is NOT included in the output
 *  - Fail-soft on missing paths (ENOENT → empty array)
 *  - READ only, never write/delete/move
 */

import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export interface UnlearnSuggestion {
  kind: "memory-archive" | "skill-stale" | "doc-stale";
  path: string;
  reason: string;
  lastSeenDays: number;
  /**
   * If true → the critic hook rejects. In this implementation
   * sticky=true is already excluded at the output filter; the field is kept
   * for later --apply auditing.
   */
  sticky: boolean;
}

const MEMORY_FILE = "/root/.claude/projects/-root/memory/MEMORY.md";
const MEMORY_DIR = "/root/.claude/projects/-root/memory";
const REPO = process.env.LAZYOS_REPO_ROOT ?? process.cwd();
const DOCS_DIR = path.join(REPO, "docs");
const SKILLS_DIR = "/root/.claude/skills";
const PROJECTS_JSONL_ROOT = "/root/.claude/projects";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Parses a section from MEMORY.md. Headers are `## NAME`.
 * Returns the body up to the next `## ` heading.
 */
function extractSection(md: string, header: string): string {
  const re = new RegExp(`^## ${header}\\s*$`, "m");
  const m = re.exec(md);
  if (!m) return "";
  const start = m.index + m[0].length;
  const rest = md.slice(start);
  const next = /\n## /.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

/**
 * Finds all `[label](file.md)` references in a markdown body.
 */
function extractMarkdownPaths(body: string): string[] {
  const out: string[] = [];
  const re = /\[[^\]]+\]\(([^)]+\.md)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    out.push(m[1]);
  }
  return out;
}

function safeStatMtime(filePath: string): number | null {
  try {
    return statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * scanMemoryArchive
 *
 * Reads MEMORY.md, parses STICKY (for the sticky set) + ARCHIVE.
 * Suggests ARCHIVE items if their memory file is older than 30 days
 * AND the path is not in the sticky set.
 */
export function scanMemoryArchive(now: number = Date.now()): UnlearnSuggestion[] {
  if (!existsSync(MEMORY_FILE)) return [];

  let md: string;
  try {
    md = readFileSync(MEMORY_FILE, "utf8");
  } catch {
    return [];
  }

  const stickyBody = extractSection(md, "STICKY");
  const archiveBody = extractSection(md, "ARCHIVE");

  const stickySet = new Set(extractMarkdownPaths(stickyBody));
  const archivePaths = extractMarkdownPaths(archiveBody);

  const suggestions: UnlearnSuggestion[] = [];
  const cutoff = now - 30 * DAY_MS;

  for (const relPath of archivePaths) {
    const isSticky = stickySet.has(relPath);
    if (isSticky) continue; // user veto: NEVER delete without permission

    const abs = path.isAbsolute(relPath) ? relPath : path.join(MEMORY_DIR, relPath);
    const mtime = safeStatMtime(abs);

    // If the file is not found: conservatively no suggestion (user-veto risk)
    if (mtime === null) continue;

    if (mtime < cutoff) {
      const days = Math.floor((now - mtime) / DAY_MS);
      suggestions.push({
        kind: "memory-archive",
        path: abs,
        reason: `In ARCHIVE-Section, mtime > 30 Tage`,
        lastSeenDays: days,
        sticky: false,
      });
    }
  }

  return suggestions;
}

function listMarkdownFilesRecursive(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  for (const name of entries) {
    const full = path.join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      out.push(...listMarkdownFilesRecursive(full));
    } else if (st.isFile() && name.toLowerCase().endsWith(".md")) {
      out.push(full);
    }
  }
  return out;
}

function hasReferencesInCode(basename: string): boolean {
  // grep returns exit=1 when nothing is found — we return that as false
  try {
    const out = execSync(
      `grep -rln --include='*.ts' --include='*.tsx' --include='*.mts' ${JSON.stringify(
        basename,
      )} lib app scripts 2>/dev/null || true`,
      { cwd: REPO, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
    );
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * scanStaleDocs
 *
 * docs/**\/*.md: mtime > 180 days AND no reference in the code → suggestion.
 */
export function scanStaleDocs(now: number = Date.now()): UnlearnSuggestion[] {
  if (!existsSync(DOCS_DIR)) return [];

  const cutoff = now - 180 * DAY_MS;
  const files = listMarkdownFilesRecursive(DOCS_DIR);
  const suggestions: UnlearnSuggestion[] = [];

  for (const file of files) {
    const mtime = safeStatMtime(file);
    if (mtime === null) continue;
    if (mtime >= cutoff) continue;

    const base = path.basename(file, ".md");
    if (hasReferencesInCode(base)) continue;

    const days = Math.floor((now - mtime) / DAY_MS);
    suggestions.push({
      kind: "doc-stale",
      path: file,
      reason: `mtime > 180d UND keine Code-Refs auf "${base}"`,
      lastSeenDays: days,
      sticky: false,
    });
  }

  return suggestions;
}

function listJsonlFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  for (const name of entries) {
    const full = path.join(root, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      out.push(...listJsonlFiles(full));
    } else if (st.isFile() && name.endsWith(".jsonl")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * scanStaleSkills
 *
 * Skills in /root/.claude/skills/ whose name is not referenced in any jsonl of the last
 * 60 days → suggestion. Fail-safe on a missing skills dir.
 */
export function scanStaleSkills(now: number = Date.now()): UnlearnSuggestion[] {
  if (!existsSync(SKILLS_DIR)) return [];

  let entries: string[];
  try {
    entries = readdirSync(SKILLS_DIR);
  } catch {
    return [];
  }

  const skills = entries.filter((name) => {
    const full = path.join(SKILLS_DIR, name);
    try {
      const st = statSync(full);
      return st.isDirectory() || (st.isFile() && name.endsWith(".md"));
    } catch {
      return false;
    }
  });

  if (skills.length === 0) return [];

  const cutoff = now - 60 * DAY_MS;
  const jsonls = listJsonlFiles(PROJECTS_JSONL_ROOT);
  const recentJsonls = jsonls.filter((f) => {
    const mtime = safeStatMtime(f);
    return mtime !== null && mtime >= cutoff;
  });

  // Performance protection: with many jsonls, only ONE find+xargs grep per skill
  // instead of N×M execSync round-trips. We build a central find list and
  // grep per skill exactly once with -l and early-exit (-m1).
  const suggestions: UnlearnSuggestion[] = [];

  if (recentJsonls.length === 0) {
    // No recent jsonls → all skills are "stale" by definition
    for (const skill of skills) {
      const skillPath = path.join(SKILLS_DIR, skill);
      const mtime = safeStatMtime(skillPath);
      const days = mtime === null ? 9999 : Math.floor((now - mtime) / DAY_MS);
      suggestions.push({
        kind: "skill-stale",
        path: skillPath,
        reason: `Keine Referenz in jsonl-Logs der letzten 60 Tage`,
        lastSeenDays: days,
        sticky: false,
      });
    }
    return suggestions;
  }

  // Performance: write the file list to temp once and use xargs per skill.
  // Avoids ARG_MAX limits with 10k+ files.
  const tmpListPath = path.join(
    require("node:os").tmpdir(),
    `stale-detection-jsonl-list-${process.pid}.txt`,
  );
  try {
    require("node:fs").writeFileSync(tmpListPath, recentJsonls.join("\n"), "utf8");
  } catch {
    return suggestions; // fail-soft
  }

  for (const skill of skills) {
    const skillName = skill.replace(/\.md$/, "");
    let foundRecent = false;
    try {
      // xargs reads the file list, grep -l -m1 -F = fast & early-exit
      const out = execSync(
        `xargs -a ${JSON.stringify(tmpListPath)} grep -F -l -m1 ${JSON.stringify(skillName)} 2>/dev/null || true`,
        { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
      );
      if (out.trim().length > 0) foundRecent = true;
    } catch {
      // grep returns exit=1 when nothing is found → caught by "|| true"
    }

    if (!foundRecent) {
      const skillPath = path.join(SKILLS_DIR, skill);
      const mtime = safeStatMtime(skillPath);
      const days = mtime === null ? 9999 : Math.floor((now - mtime) / DAY_MS);
      suggestions.push({
        kind: "skill-stale",
        path: skillPath,
        reason: `Keine Referenz in jsonl-Logs der letzten 60 Tage`,
        lastSeenDays: days,
        sticky: false,
      });
    }
  }

  try {
    require("node:fs").unlinkSync(tmpListPath);
  } catch {
    // ignore
  }

  return suggestions;
}
