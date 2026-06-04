#!/usr/bin/env tsx
/**
 * Stale-Detection Sniper — File-Cleanup-Heuristik (Dry-Run-only).
 *
 * HINWEIS Naming (2026-05-01):
 *   Diese Funktion hieß früher "Unlearning". Korrektur nach User-Feedback —
 *   Anne (Legaly-AI) meint mit "to unlearn" eine PERSÖNLICHE ARBEITSHALTUNG
 *   (Annahmen verwerfen, mehr experimentieren). Das echte Unlearn-Pattern
 *   liegt jetzt in `lib/unlearning/` (experiment-tracker + retry-sniper +
 *   reflection-sniper). Diese Datei macht weiterhin File-Cleanup, das ist
 *   sinnvoll, war aber falsch benannt.
 *
 * WICHTIG:
 *   Default-Mode ist DRY-RUN. Der --apply-Pfad ist BEWUSST nicht implementiert.
 *   4 Wochen Beobachtung der Vorschläge sind Voraussetzung, bevor ein
 *   Live-Mode Sub-Tickets erzeugen darf. Begründung: User-Veto
 *   "NIEMALS löschen ohne Erlaubnis" + Risiko, dass die Heuristik
 *   sticky-Items übersieht.
 *
 * Nutzung:
 *   pnpm tsx scripts/stale-detection-sniper.ts            # Dry-Run, schreibt .stale-detection-suggestions.md
 *   pnpm tsx scripts/stale-detection-sniper.ts --apply    # Fehler — bewusst gesperrt
 *
 * Trigger:
 *   systemd-Timer Sonntag 22:00 + 15min Random.
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
