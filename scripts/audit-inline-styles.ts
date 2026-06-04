/**
 * audit-inline-styles.ts
 *
 * CLI-Linter — zaehlt verbotene Inline-Style-Properties in `lib/chat/*Card.tsx`
 * (und Subdirs). Teil des Surface-Refactors (Welle 1): Layout-/Spacing-/Radius-
 * Werte sollen aus den globalen Tokens kommen, nicht aus inline `style={...}`.
 *
 * Verbotene Properties (Default):
 *   - borderRadius
 *   - fontSize
 *   - padding (alle Varianten: padding, paddingTop, paddingLeft ...)
 *   - margin  (alle Varianten)
 *   - gap, rowGap, columnGap
 *   - width, minWidth, maxWidth
 *   - height, minHeight, maxHeight
 *
 * Bypass:
 *   Direkt UEBER der Inline-Style-Zeile ein Marker-Comment:
 *     // surface-lint-ignore
 *   Der Hit wird dann nicht gezaehlt.
 *
 * ENV-Override:
 *   LAZYOS_SURFACE_LINT_THRESHOLD=N  -> erlaubt bis zu N Hits gesamt (gradual
 *   migration). Default 0 = strikt.
 *
 * Threshold-Override-Schedule (gradual migration durch Welle):
 *   Welle 1 (2026-05-01)  : threshold = 200  (Geister-Tokens + Spacing-Scale)
 *   Welle 2 (2026-05-08)  : threshold = 100  (Card-Sweep + Composer)
 *   Welle 3 (2026-05-15)  : threshold = 50   (Lab + Routines)
 *   Welle 4 (2026-05-22)  : threshold = 0    (strikt — alle inline-styles ersetzt)
 *   Setze ENV LAZYOS_SURFACE_LINT_THRESHOLD pro CI-Run; Schedule ist Memo,
 *   keine harte Logik. Decay-Pflicht: jede Welle muss threshold <= prev/2.
 *
 * Run:
 *   tsx scripts/audit-inline-styles.ts
 *   LAZYOS_SURFACE_LINT_THRESHOLD=20 tsx scripts/audit-inline-styles.ts
 *
 * Exit-Code:
 *   0 — total-hits <= threshold
 *   1 — total-hits  > threshold
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');
const SCAN_ROOT = resolve(ROOT, 'lib/chat');

const FORBIDDEN_PATTERNS: { name: string; regex: RegExp }[] = [
  { name: 'borderRadius', regex: /\bborderRadius\s*:/g },
  { name: 'fontSize', regex: /\bfontSize\s*:/g },
  { name: 'padding', regex: /\bpadding(?:Top|Right|Bottom|Left|Inline|Block)?\s*:/g },
  { name: 'margin', regex: /\bmargin(?:Top|Right|Bottom|Left|Inline|Block)?\s*:/g },
  { name: 'gap', regex: /\b(?:gap|rowGap|columnGap)\s*:/g },
  { name: 'width', regex: /\b(?:width|minWidth|maxWidth)\s*:/g },
  { name: 'height', regex: /\b(?:height|minHeight|maxHeight)\s*:/g },
];

const IGNORE_MARKER = 'surface-lint-ignore';

interface FileHit {
  file: string;
  hits: { line: number; property: string; text: string }[];
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, out);
    } else if (entry.endsWith('Card.tsx')) {
      out.push(full);
    }
  }
}

function scanFile(file: string): FileHit | null {
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const hits: FileHit['hits'] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const { name, regex } of FORBIDDEN_PATTERNS) {
      regex.lastIndex = 0;
      if (!regex.test(line)) continue;
      // Bypass-Check: vorherige Zeile enthaelt Marker-Comment.
      const prev = i > 0 ? lines[i - 1] : '';
      if (prev.includes(IGNORE_MARKER)) continue;
      hits.push({
        line: i + 1,
        property: name,
        text: line.trim().slice(0, 120),
      });
    }
  }

  return hits.length === 0 ? null : { file, hits };
}

function main(): void {
  const threshold = Number.parseInt(
    process.env.LAZYOS_SURFACE_LINT_THRESHOLD ?? '0',
    10,
  );

  let files: string[] = [];
  try {
    walk(SCAN_ROOT, files);
  } catch (err) {
    console.error(`[surface-lint] Scan-Root nicht lesbar: ${SCAN_ROOT}`);
    console.error(err);
    process.exit(1);
  }
  files.sort();

  const results: FileHit[] = [];
  for (const f of files) {
    const r = scanFile(f);
    if (r) results.push(r);
  }

  const totalHits = results.reduce((sum, r) => sum + r.hits.length, 0);

  console.log('# Surface Inline-Style Audit');
  console.log(`# Scan-Root: ${relative(ROOT, SCAN_ROOT)}`);
  console.log(`# Files scanned: ${files.length}`);
  console.log(`# Threshold: ${threshold}`);
  console.log(`# Total hits: ${totalHits}`);
  console.log('');

  if (results.length === 0) {
    console.log('OK — keine Inline-Style-Verstoesse gefunden.');
    process.exit(0);
  }

  for (const r of results) {
    const rel = relative(ROOT, r.file);
    console.log(`${rel} — ${r.hits.length} Hit(s)`);
    for (const h of r.hits) {
      console.log(`  L${h.line.toString().padStart(4, ' ')}  ${h.property.padEnd(14)}  ${h.text}`);
    }
    console.log('');
  }

  if (totalHits > threshold) {
    console.error(
      `FAIL — ${totalHits} Inline-Style-Hits ueberschreiten Threshold ${threshold}.`,
    );
    console.error(
      `Tipp: ueber der Zeile '// ${IGNORE_MARKER}' setzen (gradual migration), oder LAZYOS_SURFACE_LINT_THRESHOLD anheben.`,
    );
    process.exit(1);
  }
  console.log(`OK — ${totalHits} Hits <= Threshold ${threshold}.`);
  process.exit(0);
}

main();
