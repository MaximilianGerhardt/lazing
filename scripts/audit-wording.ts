/**
 * audit-wording.ts
 *
 * Glossar-Lint — sucht inkonsistente Wordings in User-Facing TSX-Strings:
 *
 *   - "Uneinigung"             → Vorschlag "Modelle widersprechen"
 *   - "Drift" (Code-Strings)   → Vorschlag "Quellen-Abweichung"
 *                                (außerhalb audit-Bucket = Skript-Namen
 *                                + Kommentare bleiben unangetastet)
 *   - "Sniper" (User-facing)   → Vorschlag "Direkt-Eingriff"
 *
 * Heuristik:
 *   - Sucht in lib/ + app/ TSX-Files
 *   - String-Literale (single/double/template) + JSX-Text
 *   - Skip-Kommentare (// + /* ... *\/)
 *   - Skip Datei-Pfade in import-Strings
 *
 * Output: Liste mit Vorschlag.
 * Exit: 0, informativ.
 *
 * Run:  tsx scripts/audit-wording.ts
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');
const SCAN_ROOTS = [resolve(ROOT, 'lib'), resolve(ROOT, 'app')];

interface Rule {
  term: string;
  regex: RegExp;
  suggest: string;
  scope: 'all' | 'user-facing';
  // Wenn 'user-facing': nur JSX-Text/-Attribut + 'use'/`use`-Strings.
}

const RULES: Rule[] = [
  {
    term: 'Uneinigung',
    regex: /\bUneinigung\b/g,
    suggest: 'Modelle widersprechen',
    scope: 'all',
  },
  {
    term: 'Drift',
    regex: /\bDrift\b/g,
    suggest: 'Quellen-Abweichung',
    scope: 'user-facing',
  },
  {
    term: 'Sniper',
    regex: /\bSniper\b/g,
    suggest: 'Direkt-Eingriff',
    scope: 'user-facing',
  },
];

const IGNORE_MARKER = 'audit-wording-ignore';

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.startsWith('.') || entry === 'node_modules') continue;
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, out);
    else if (entry.endsWith('.tsx') || entry.endsWith('.ts')) out.push(full);
  }
}

interface Hit {
  file: string;
  line: number;
  term: string;
  suggest: string;
  text: string;
}

function isLineComment(line: string): boolean {
  return /^\s*\/\//.test(line);
}

function isImportLike(line: string): boolean {
  return /^\s*(import|export)\s/.test(line);
}

function scan(files: string[]): Hit[] {
  const out: Hit[] = [];
  for (const f of files) {
    const lines = readFileSync(f, 'utf8').split('\n');
    let inBlockComment = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const prev = i > 0 ? lines[i - 1] : '';

      // Block-Comment-Tracking (vereinfacht: keine Mid-Line-Toggles)
      if (inBlockComment) {
        if (line.includes('*/')) inBlockComment = false;
        continue;
      }
      if (/^\s*\/\*/.test(line) && !line.includes('*/')) {
        inBlockComment = true;
        continue;
      }

      if (isLineComment(line)) continue;
      if (isImportLike(line)) continue;
      if (prev.includes(IGNORE_MARKER)) continue;

      for (const rule of RULES) {
        rule.regex.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = rule.regex.exec(line)) !== null) {
          if (rule.scope === 'user-facing') {
            // Heuristik: muss in ' " ` stehen oder nach > vor < (JSX-Text)
            const before = line.slice(0, m.index);
            const after = line.slice(m.index + m[0].length);
            const inString =
              /['"`][^'"`]*$/.test(before) && /^[^'"`]*['"`]/.test(after);
            const inJSXText =
              /[>}]\s*$/.test(before.trim()) || /^\s*[<{]/.test(after.trim());
            if (!inString && !inJSXText) continue;
          }
          out.push({
            file: f,
            line: i + 1,
            term: rule.term,
            suggest: rule.suggest,
            text: line.trim().slice(0, 140),
          });
        }
      }
    }
  }
  return out;
}

function main(): void {
  const files: string[] = [];
  for (const r of SCAN_ROOTS) walk(r, files);
  files.sort();

  const hits = scan(files);

  console.log('# Wording Audit');
  console.log(`# Files scanned: ${files.length}`);
  console.log(`# Hits: ${hits.length}`);
  console.log('');

  if (hits.length === 0) {
    console.log('OK — keine Wording-Inkonsistenzen.');
    process.exit(0);
  }

  const byTerm = new Map<string, Hit[]>();
  for (const h of hits) {
    if (!byTerm.has(h.term)) byTerm.set(h.term, []);
    byTerm.get(h.term)!.push(h);
  }
  const sortedTerms = [...byTerm.keys()].sort();

  for (const t of sortedTerms) {
    const list = byTerm.get(t)!;
    console.log(`## ${t} → "${list[0].suggest}" (${list.length} Hits)`);
    console.log('');
    for (const h of list) {
      console.log(`  ${relative(ROOT, h.file)}:${h.line}  ${h.text}`);
    }
    console.log('');
  }

  console.log(`INFO — ${hits.length} Wording-Hits. Exit 0 (informativ).`);
  console.log(`Tipp: '// ${IGNORE_MARKER}' ueber der Zeile setzen, oder Wording anpassen.`);
  process.exit(0);
}

main();
