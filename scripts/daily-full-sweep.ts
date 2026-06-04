#!/usr/bin/env tsx
/**
 * daily-full-sweep.ts — Stale-File-Detection + Re-Index-Suggestions (P12).
 *
 * Default: DRY-RUN. Listet welche Files in:
 *   - <standards dir>/**\/*.md          (LAZYOS_STANDARDS_DIR, default ~/standards)
 *   - <repo root>/CLAUDE.md             (LAZYOS_REPO_ROOT, default cwd)
 *   - ~/.claude/skills/**\/SKILL.md     (optional, fail-soft wenn fehlt)
 * eine mtime > als der jüngste rag_chunks-Eintrag für diesen sourceId haben
 * → Re-Index empfohlen.
 *
 * Mit --apply wird tatsächlich indexSource() aufgerufen.
 *
 * Output: Markdown-Suggestions-Doc nach `data/daily-sweep-suggestions.md`.
 *
 * REGELN aus P12-Auftrag:
 *   - KEIN Auto-Apply ohne --apply
 *   - KEIN Schreiben in den Standards-Ordner — read-only
 *   - Audit < 5s (nur mtime-Stat + sql-aggregation, keine Embedding-Calls
 *     im DRY-Pfad)
 *   - Fail-soft bei fehlenden Verzeichnissen
 *
 * Run:
 *   pnpm tsx scripts/daily-full-sweep.ts             (DRY-RUN)
 *   pnpm tsx scripts/daily-full-sweep.ts --apply     (wirklich re-indexen)
 *   pnpm tsx scripts/daily-full-sweep.ts --json      (machine-readable)
 */

import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { getDb } from "@/db/client";

const REPO_ROOT = process.env.LAZYOS_REPO_ROOT ?? process.cwd();
const STANDARDS_DIR =
  process.env.LAZYOS_STANDARDS_DIR ?? path.join(os.homedir(), "standards");
const PROJECT_CLAUDE_MD = path.join(REPO_ROOT, "CLAUDE.md");
const SKILLS_DIR = path.join(os.homedir(), ".claude", "skills");
const OUTPUT_DOC = path.join(
  process.cwd(),
  "data",
  "daily-sweep-suggestions.md",
);

type SourceTypePseudo = "standard" | "memory" | "skill";

interface FileCandidate {
  sourceType: SourceTypePseudo;
  /** Stable virtual sourceId (path-based). */
  sourceId: string;
  absPath: string;
  mtimeMs: number;
}

interface StaleVerdict extends FileCandidate {
  lastIndexedTs: number | null;
  staleByMs: number | null;
  /** "fresh" (already up-to-date), "stale" (re-index empfohlen), "missing" (nie indexed). */
  verdict: "fresh" | "stale" | "missing";
}

function listMdFiles(rootDir: string): string[] {
  if (!existsSync(rootDir)) return [];
  const out: string[] = [];
  const stack: string[] = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (name.startsWith(".")) continue;
      if (name === "node_modules") continue;
      const p = path.join(dir, name);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(p);
      } else if (st.isFile() && name.endsWith(".md")) {
        out.push(p);
      }
    }
  }
  return out;
}

function listSkillFiles(rootDir: string): string[] {
  if (!existsSync(rootDir)) return [];
  const out: string[] = [];
  const stack: string[] = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (name.startsWith(".")) continue;
      const p = path.join(dir, name);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(p);
      } else if (st.isFile() && name === "SKILL.md") {
        out.push(p);
      }
    }
  }
  return out;
}

export function collectCandidates(): FileCandidate[] {
  const out: FileCandidate[] = [];

  // Standards
  for (const p of listMdFiles(STANDARDS_DIR)) {
    try {
      const st = statSync(p);
      out.push({
        sourceType: "standard",
        sourceId: path.relative(STANDARDS_DIR, p) || path.basename(p),
        absPath: p,
        mtimeMs: st.mtimeMs,
      });
    } catch {
      /* skip */
    }
  }

  // Project CLAUDE.md (memory/context)
  if (existsSync(PROJECT_CLAUDE_MD)) {
    try {
      const st = statSync(PROJECT_CLAUDE_MD);
      out.push({
        sourceType: "memory",
        sourceId: "CLAUDE.md",
        absPath: PROJECT_CLAUDE_MD,
        mtimeMs: st.mtimeMs,
      });
    } catch {
      /* skip */
    }
  }

  // Skills
  for (const p of listSkillFiles(SKILLS_DIR)) {
    try {
      const st = statSync(p);
      out.push({
        sourceType: "skill",
        sourceId: path.relative(SKILLS_DIR, p) || path.basename(p),
        absPath: p,
        mtimeMs: st.mtimeMs,
      });
    } catch {
      /* skip */
    }
  }

  return out;
}

interface ChunkLastIndex {
  source_type: string;
  source_id: string;
  max_ts: number;
}

export function classifyCandidates(
  candidates: FileCandidate[],
): StaleVerdict[] {
  const db = getDb();
  let indexed: ChunkLastIndex[] = [];
  try {
    const stmt = db.$raw.prepare(
      `SELECT source_type, source_id, MAX(indexed_at) as max_ts
       FROM rag_chunks
       WHERE source_type IN ('standard','memory','skill')
       GROUP BY source_type, source_id`,
    );
    indexed = stmt.all() as ChunkLastIndex[];
  } catch (err) {
    if (!(err instanceof Error && /no such table/i.test(err.message))) {
      throw err;
    }
  }
  const idxMap = new Map<string, number>();
  for (const i of indexed) {
    idxMap.set(`${i.source_type}::${i.source_id}`, i.max_ts);
  }

  const out: StaleVerdict[] = [];
  for (const c of candidates) {
    const key = `${c.sourceType}::${c.sourceId}`;
    const lastIndexedTs = idxMap.get(key) ?? null;
    if (lastIndexedTs === null) {
      out.push({
        ...c,
        lastIndexedTs: null,
        staleByMs: null,
        verdict: "missing",
      });
      continue;
    }
    const stale = c.mtimeMs - lastIndexedTs;
    out.push({
      ...c,
      lastIndexedTs,
      staleByMs: stale,
      verdict: stale > 0 ? "stale" : "fresh",
    });
  }
  return out;
}

export function renderSuggestions(verdicts: StaleVerdict[]): string {
  const missing = verdicts.filter((v) => v.verdict === "missing");
  const stale = verdicts.filter((v) => v.verdict === "stale");
  const fresh = verdicts.filter((v) => v.verdict === "fresh");

  const lines: string[] = [];
  lines.push("# Daily Full-Sweep — RAG Re-Index Suggestions");
  lines.push("");
  lines.push(`Stand: ${new Date().toISOString()}`);
  lines.push("");
  lines.push(
    `**Summary**: ${missing.length} missing · ${stale.length} stale · ${fresh.length} fresh`,
  );
  lines.push("");

  if (missing.length > 0) {
    lines.push("## Missing — nie indexed");
    lines.push("");
    lines.push("| Source-Type | Source-ID | Path | mtime |");
    lines.push("|-------------|-----------|------|-------|");
    for (const v of missing) {
      const m = new Date(v.mtimeMs).toISOString().slice(0, 16).replace("T", " ");
      lines.push(
        `| \`${v.sourceType}\` | \`${v.sourceId}\` | \`${v.absPath}\` | ${m} |`,
      );
    }
    lines.push("");
  }

  if (stale.length > 0) {
    lines.push("## Stale — Re-Index empfohlen");
    lines.push("");
    lines.push(
      "| Source-Type | Source-ID | Path | mtime | last-indexed | stale-by (h) |",
    );
    lines.push(
      "|-------------|-----------|------|-------|--------------|-------------:|",
    );
    for (const v of stale) {
      const m = new Date(v.mtimeMs).toISOString().slice(0, 16).replace("T", " ");
      const li = v.lastIndexedTs
        ? new Date(v.lastIndexedTs).toISOString().slice(0, 16).replace("T", " ")
        : "—";
      const staleH =
        v.staleByMs !== null ? Math.round(v.staleByMs / 3_600_000) : "—";
      lines.push(
        `| \`${v.sourceType}\` | \`${v.sourceId}\` | \`${v.absPath}\` | ${m} | ${li} | ${staleH} |`,
      );
    }
    lines.push("");
  }

  lines.push("## Recommended Actions");
  lines.push("");
  if (missing.length === 0 && stale.length === 0) {
    lines.push("- ✓ Alles aktuell — kein Re-Index nötig.");
  } else {
    lines.push(
      `- Run \`pnpm tsx scripts/daily-full-sweep.ts --apply\` um ${missing.length + stale.length} Files zu re-indexen.`,
    );
    lines.push(
      "- WARNUNG: Pseudo-Types `standard`/`memory`/`skill` werden derzeit NICHT vom existing rag-indexer.ts gepflegt.",
    );
    lines.push(
      "  Diese Sweep-Logik ist Vorbereitung für Welle 2 — `--apply` ist heute ein No-Op-Logger.",
    );
  }
  return lines.join("\n");
}

async function applyReindex(verdicts: StaleVerdict[]): Promise<void> {
  // P12 Welle 1: --apply ist intentional ein No-Op-Logger. Echtes Re-Indexen
  // für Pseudo-Types braucht eine Indexer-Erweiterung in lib/rag/indexer.ts
  // (sourceType-Whitelist um 'standard'/'memory'/'skill' erweitern, Reader
  // pro Pseudo-Type). Das ist Welle 2.
  const todoCount = verdicts.filter(
    (v) => v.verdict === "missing" || v.verdict === "stale",
  ).length;
  console.warn(
    `[daily-full-sweep] --apply: Pseudo-Type-Indexer noch nicht implementiert (Welle 2). ` +
      `${todoCount} Files wären re-indexiert worden. ` +
      `Suggestions wurden in data/daily-sweep-suggestions.md geschrieben.`,
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const json = args.includes("--json");

  const t0 = Date.now();
  const candidates = collectCandidates();
  const verdicts = classifyCandidates(candidates);
  const tStat = Date.now() - t0;

  // Output-Dir sicherstellen
  const outDir = path.dirname(OUTPUT_DOC);
  if (!existsSync(outDir)) {
    mkdirSync(outDir, { recursive: true });
  }
  const md = renderSuggestions(verdicts);
  writeFileSync(OUTPUT_DOC, md, "utf8");

  if (apply) {
    await applyReindex(verdicts);
  }

  if (json) {
    process.stdout.write(
      JSON.stringify(
        {
          candidatesCount: candidates.length,
          verdictsCount: verdicts.length,
          missing: verdicts.filter((v) => v.verdict === "missing").length,
          stale: verdicts.filter((v) => v.verdict === "stale").length,
          fresh: verdicts.filter((v) => v.verdict === "fresh").length,
          outputPath: OUTPUT_DOC,
          tookMs: tStat,
          applied: apply,
        },
        null,
        2,
      ) + "\n",
    );
  } else {
    process.stdout.write(md + "\n");
    process.stdout.write(
      `\n[daily-sweep] geschrieben nach ${OUTPUT_DOC} · ${tStat}ms\n`,
    );
  }
}

if (
  typeof process !== "undefined" &&
  process.argv[1] &&
  /daily-full-sweep\.ts$/.test(process.argv[1])
) {
  void main().catch((err: unknown) => {
    console.error("[daily-full-sweep] fatal:", err);
    process.exit(1);
  });
}
