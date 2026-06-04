#!/usr/bin/env tsx
/**
 * Stale-Detection Sniper — file-cleanup heuristic (dry-run only).
 *
 * NAMING NOTE (2026-05-01):
 *   This function used to be called "Unlearning". Corrected after user feedback —
 *   Anne (Legaly-AI) means by "to unlearn" a PERSONAL WORK ATTITUDE
 *   (discard assumptions, experiment more). The real unlearn pattern
 *   now lives in `lib/unlearning/` (experiment-tracker + retry-sniper +
 *   reflection-sniper). This file still does file cleanup, which is
 *   sensible, but was misnamed.
 *
 * IMPORTANT:
 *   The default mode is DRY-RUN. The --apply path is DELIBERATELY not implemented.
 *   4 weeks of observing the suggestions is a prerequisite before a
 *   live mode may create sub-tickets. Rationale: the user veto
 *   "NEVER delete without permission" + the risk that the heuristic
 *   overlooks sticky items.
 *
 * Usage:
 *   pnpm tsx scripts/stale-detection-sniper.ts            # dry-run, writes .stale-detection-suggestions.md
 *   pnpm tsx scripts/stale-detection-sniper.ts --apply    # error — deliberately locked
 *
 * Trigger:
 *   systemd timer Sunday 22:00 + 15min random.
 */

import path from "node:path";

import {
  scanMemoryArchive,
  scanStaleDocs,
  scanStaleSkills,
} from "../lib/stale-detection/scanner";
import { writeSuggestionsMarkdown } from "../lib/stale-detection/report";

const REPO_ROOT = process.env.LAZYOS_REPO_ROOT ?? process.cwd();
const OUT_PATH = path.join(REPO_ROOT, ".stale-detection-suggestions.md");

function main(): void {
  const dryRun = !process.argv.includes("--apply");
  const all = [
    ...scanMemoryArchive(),
    ...scanStaleDocs(),
    ...scanStaleSkills(),
  ];

  if (dryRun) {
    writeSuggestionsMarkdown(all, OUT_PATH);
    console.log(`[stale-detection] dry-run: ${all.length} Vorschläge → ${OUT_PATH}`);
    process.exit(0);
  }

  console.error(
    "Live-Mode noch nicht implementiert — bewusst (4 Wochen Dry-Run-Beobachtung).",
  );
  process.exit(1);
}

main();
