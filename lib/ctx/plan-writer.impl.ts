/**
 * Phase CTX — plan-file writer.
 *
 * Writes snapshot blocks at the top of a Markdown plan file. Idempotent +
 * race-safe (mtime lock file).
 *
 * Default path: `/root/.claude/plans/active.md` (override via
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

  // We cap older "## Stand …" sections at MAX_HISTORICAL_SNAPSHOTS.
  const standSections = existing.split(/^## Stand /m);
  // [0] = everything before the first "## Stand", then one block each.
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

/** Test helper: append-only without trim. */
export function appendPlanLine(line: string, planPathOverride?: string): void {
  const planPath = planPathOverride?.trim() || DEFAULT_PLAN_FILE;
  mkdirSync(path.dirname(planPath), { recursive: true });
  appendFileSync(planPath, line.endsWith("\n") ? line : `${line}\n`);
}
