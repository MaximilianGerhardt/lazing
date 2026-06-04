/**
 * audit-hex-in-tsx.ts
 *
 * Findet `#RGB`/`#RRGGBB`/`#RRGGBBAA`-Hex-Farben in *.tsx-Dateien
 * (lib/ + app/). Hex-Farben in Components sind Token-Lügen — sie
 * umgehen das Theme-System.
 *
 * Allowlist:
 *   - // audit-hex-ignore   (auf der Zeile darüber)
 *   - SVG/Path-Color-Attribute in inline JSX werden mitgezählt; wer das
 *     nicht will, setzt den Marker.
 *
 * Output: Liste + count.
 * Exit: 0 (informativ, NICHT blocking).
 *
 * Run:  tsx scripts/audit-hex-in-tsx.ts
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');
const SCAN_ROOTS = [resolve(ROOT, 'lib'), resolve(ROOT, 'app')];

const HEX_RE = /#[0-9a-fA-F]{3,8}\b/g;
const IGNORE_MARKER = 'audit-hex-ignore';

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
    else if (entry.endsWith('.tsx')) out.push(full);
  }
}

interface Hit {
  file: string;
  line: number;
  text: string;
  color: string;
}

function scan(files: string[]): Hit[] {
  const out: Hit[] = [];
  for (const f of files) {
    const lines = readFileSync(f, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const prev = i > 0 ? lines[i - 1] : '';
      if (prev.includes(IGNORE_MARKER)) continue;

      HEX_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = HEX_RE.exec(line)) !== null) {
        // Filter: tatsächliche Hex-Farbe (3, 4, 6, 8 chars hinter #)
        const hex = m[0];
        const len = hex.length - 1;
        if (![3, 4, 6, 8].includes(len)) continue;
        out.push({
          file: f,
          line: i + 1,
          text: line.trim().slice(0, 140),
          color: hex,
        });
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

  console.log('# Hex-in-TSX Audit');
  console.log(`# Files scanned: ${files.length}`);
  console.log(`# Hits: ${hits.length}`);
  console.log('');

  if (hits.length === 0) {
    console.log('OK — keine Hex-Farben in TSX gefunden.');
    process.exit(0);
  }

  // Group by file
  const byFile = new Map<string, Hit[]>();
  for (const h of hits) {
    if (!byFile.has(h.file)) byFile.set(h.file, []);
    byFile.get(h.file)!.push(h);
  }
  const sortedFiles = [...byFile.keys()].sort();

  for (const f of sortedFiles) {
    const list = byFile.get(f)!;
    console.log(`${relative(ROOT, f)} — ${list.length} Hit(s)`);
    for (const h of list) {
      console.log(`  L${h.line.toString().padStart(4, ' ')}  ${h.color.padEnd(10)}  ${h.text}`);
    }
    console.log('');
  }

  console.log(`INFO — ${hits.length} Hex-Hits in TSX. Exit 0 (informativ).`);
  console.log(`Tipp: '// ${IGNORE_MARKER}' ueber der Zeile setzen, oder durch var(--token) ersetzen.`);
  process.exit(0);
}

main();
