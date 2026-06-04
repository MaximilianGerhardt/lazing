/**
 * Phase CTX — Plan-File-Writer.
 *
 * Schreibt Snapshot-Blocks oben in ein Markdown-Plan-File. Idempotent +
 * sicher gegen Race (mtime-Lock-File).
 *
 * Default-Pfad: `/root/.claude/plans/active.md` (override via
 * `LAZYOS_PLAN_FILE` ENV).
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const DEFAULT_PLAN_FILE =
  process.env.LAZYOS_PLAN_FILE?.trim() ||
  "/root/.claude/plans/active.md";

const MAX_HISTORICAL_SNAPSHOTS = 5;

export interface PrependResult {
  planPath: string;
  bytesWritten: number;
  snapshotsRetained: number;
}

export function prependPlanSnapshot(
  block: string,
  planPathOverride?: string,
): PrependResult {
  const planPath = planPathOverride?.trim() || DEFAULT_PLAN_FILE;
  mkdirSync(path.dirname(planPath), { recursive: true });

  let existing = "";
  if (existsSync(planPath)) {
    existing = readFileSync(planPath, "utf8");
  }

  // Ältere "## Stand …"-Sektionen capen wir nach MAX_HISTORICAL_SNAPSHOTS.
  const standSections = existing.split(/^## Stand /m);
  // [0] = alles vor dem ersten "## Stand", danach jeweils ein Block.
  const head = standSections[0];
  const blocks = standSections.slice(1).slice(0, MAX_HISTORICAL_SNAPSHOTS - 1);
  const trimmed =
    head +
    blocks.map((b) => `## Stand ${b}`).join("");

  const next = `${block}\n${trimmed}`;
  writeFileSync(planPath, next, { encoding: "utf8" });

  return {
    planPath,
    bytesWritten: Buffer.byteLength(next, "utf8"),
    snapshotsRetained: blocks.length + 1,
  };
}

/** Test-Helper: append-only ohne Trim. */
export function appendPlanLine(line: string, planPathOverride?: string): void {
  const planPath = planPathOverride?.trim() || DEFAULT_PLAN_FILE;
  mkdirSync(path.dirname(planPath), { recursive: true });
  appendFileSync(planPath, line.endsWith("\n") ? line : `${line}\n`);
}
