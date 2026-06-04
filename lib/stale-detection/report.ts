/**
 * Stale-Detection Report — Markdown output for dry-run observation.
 *
 * NOTE on naming (2026-05-01): was previously called "Unlearning Report".
 * See the header in `scanner.ts`.
 *
 * Writes structured suggestions as Markdown.
 * After 4 weeks of dry-run observation, an --apply path can
 * generate sub-tickets from this report.
 */

import { writeFileSync } from "node:fs";

import type { UnlearnSuggestion } from "./scanner";

function group(suggestions: UnlearnSuggestion[]): {
  memoryArchive: UnlearnSuggestion[];
  staleDocs: UnlearnSuggestion[];
  staleSkills: UnlearnSuggestion[];
} {
  return {
    memoryArchive: suggestions.filter((s) => s.kind === "memory-archive"),
    staleDocs: suggestions.filter((s) => s.kind === "doc-stale"),
    staleSkills: suggestions.filter((s) => s.kind === "skill-stale"),
  };
}

function renderGroup(title: string, items: UnlearnSuggestion[]): string {
  const lines: string[] = [];
  lines.push(`## ${title} (${items.length} items)`);
  if (items.length === 0) {
    lines.push("");
    lines.push("_Keine Vorschläge._");
    lines.push("");
    return lines.join("\n");
  }
  lines.push("");
  for (const item of items) {
    lines.push(`- \`${item.path}\` — ${item.reason} — ${item.lastSeenDays}d alt`);
  }
  lines.push("");
  return lines.join("\n");
}

export function renderSuggestionsMarkdown(
  suggestions: UnlearnSuggestion[],
  date: Date = new Date(),
): string {
  const grouped = group(suggestions);
  const iso = date.toISOString().slice(0, 10);

  const out: string[] = [];
  out.push(`# Unlearning Suggestions — ${iso}`);
  out.push("");
  out.push(
    "_Pattern 9 (Anne-Transkript): Wöchentliches Re-Evaluieren von Memory/Docs/Skills._",
  );
  out.push("");
  out.push(renderGroup("Memory Archive", grouped.memoryArchive));
  out.push(renderGroup("Stale Docs", grouped.staleDocs));
  out.push(renderGroup("Stale Skills", grouped.staleSkills));
  out.push("");
  out.push(
    "> **Dry-Run** — keine Aktionen ausgeführt. Sub-Tickets werden erst ab KW+4 erzeugt.",
  );
  out.push("");
  return out.join("\n");
}

export function writeSuggestionsMarkdown(
  suggestions: UnlearnSuggestion[],
  outPath: string,
): void {
  const content = renderSuggestionsMarkdown(suggestions);
  writeFileSync(outPath, content, "utf8");
}
