/**
 * Stale-Detection Scanner — File-Cleanup-Heuristik.
 *
 * HINWEIS Naming (2026-05-01):
 *   Hieß früher "Unlearning Scanner". Umbenannt nach User-Feedback —
 *   Anne (Legaly-AI) meint mit "to unlearn" persönliche Arbeitshaltung
 *   (Annahmen verwerfen + experimentieren), NICHT File-Cleanup.
 *   Das echte Unlearn-Pattern liegt jetzt in `lib/unlearning/`.
 *
 * Wöchentliches Re-Evaluieren von Memory/Docs/Skills.
 * Liefert Vorschläge zur Archivierung — KEINE Aktionen.
 *
 * Kritisch:
 *  - STICKY-Items werden DYNAMISCH aus MEMORY.md geparst (User-Veto-respect)
 *  - sticky=true → Vorschlag wird NICHT in Output aufgenommen
 *  - Fail-soft bei fehlenden Pfaden (ENOENT → leeres Array)
 *  - Nur LESEN, nie schreiben/löschen/verschieben
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
   * Wenn true → Critic-Hook lehnt ab. In dieser Implementierung wird
   * sticky=true bereits am Output-Filter ausgeschlossen, das Feld bleibt
   * für späteres --apply-Auditing erhalten.
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
 * Parst eine Section aus MEMORY.md. Headers sind `## NAME`.
 * Liefert den Body bis zur nächsten `## ` Überschrift.
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
 * Findet alle `[label](file.md)` Referenzen in einem Markdown-Body.
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
 * Liest MEMORY.md, parst STICKY (für sticky-Set) + ARCHIVE.
 * Schlägt ARCHIVE-Items vor, wenn ihr Memory-File älter als 30 Tage ist
 * UND der Pfad nicht im sticky-Set liegt.
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
    if (isSticky) continue; // User-Veto: NIEMALS löschen ohne Erlaubnis

    const abs = path.isAbsolute(relPath) ? relPath : path.join(MEMORY_DIR, relPath);
    const mtime = safeStatMtime(abs);

    // Wenn Datei nicht gefunden: konservativ keinen Vorschlag (User-Veto-Risiko)
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
  // grep liefert exit=1 wenn nichts gefunden — das werfen wir als false zurück
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
 * docs/**\/*.md: mtime > 180 Tage UND keine Referenz im Code → Vorschlag.
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
 * Skills in /root/.claude/skills/ deren Name in keinem jsonl der letzten
 * 60 Tage referenziert ist → Vorschlag. Fail-safe bei fehlendem Skills-Dir.
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

  // Performance-Schutz: bei vielen jsonls per-Skill nur EINEN find+xargs grep
  // statt N×M execSync-Roundtrips. Wir bauen eine zentrale Find-Liste und
  // grep'pen pro Skill genau einmal mit -l und Early-Exit (-m1).
  const suggestions: UnlearnSuggestion[] = [];

  if (recentJsonls.length === 0) {
    // Keine recent jsonls → alle Skills sind "stale" per Definition
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

  // Performance: schreibe File-Liste einmal nach temp und nutze xargs pro Skill.
  // Vermeidet ARG_MAX-Limits bei 10k+ Files.
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
      // xargs liest File-Liste, grep -l -m1 -F = fast & early-exit
      const out = execSync(
        `xargs -a ${JSON.stringify(tmpListPath)} grep -F -l -m1 ${JSON.stringify(skillName)} 2>/dev/null || true`,
        { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
      );
      if (out.trim().length > 0) foundRecent = true;
    } catch {
      // grep liefert exit=1 wenn nix gefunden → durch "|| true" gefangen
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
