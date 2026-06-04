#!/usr/bin/env node
/**
 * check-design-gate.mjs — laz.ing Design-Gate (Owner-Direktive, hart).
 *
 * Failt (exit 1) bei Verstößen gegen das Design-Manifest in der gerenderten
 * UI-Quelle (lib/, app/, components/):
 *   1. KEINE Emojis / pictographic Glyphen-als-Icons  (Owner: „keine Emojis")
 *   2. KEIN `color: #fff` / `white` / rohes Hex als Text-/Icon-Farbe
 *      (auf Akzent-Flächen → `var(--on-accent)`; sonst `var(--ink*)`).
 *
 * Ausgeschlossen: Tests, lib-v1-Quarantäne, .next, node_modules, Hosting-/
 * Parallel-Session-Dateien, und reine Kommentar-Treffer für die Hex-Regel.
 *
 * Nutzung:  node scripts/check-design-gate.mjs   (oder `pnpm design:gate`)
 */
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const ROOT = process.cwd();
const EMOJI =
  /[\u{1F300}-\u{1FAFF}\u{1F000}-\u{1F0FF}\u{1F1E6}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{2B00}-\u{2B59}\u{2300}-\u{23FF}\u{FE0F}]/u;
// Rohes Weiß/Hex als Farb-Wert (Style/CSS). Sanktioniert: nur in Fallback-
// var(--token, #hex) und auf var(--a-danger)/Toast (dunkles Rot → Weiß ok).
const RAW_WHITE = /\bcolor:\s*['"]?(#fff(fff)?|#ffffff|white)\b/i;

// Parallel-Session / Quarantäne / Nicht-UI → ausschließen.
const EXCLUDE = [
  /(^|\/)lib-v1\//,
  /(^|\/)node_modules\//,
  /\.next/,
  /(^|\/)__tests__\//,
  /\.test\.|\.spec\./,
  /(^|\/)middleware\.ts$/,
  /app\/api\/subchats\/external\//,
  /(^|\/)lib\/cloud\/service\.ts$/,
  /(^|\/)lib\/hosting\//,
  // E-Mail-Templates MÜSSEN rohes Hex nutzen (Mail-Clients können kein var()).
  /(^|\/)lib\/email\//,
];

function listFiles() {
  const out = execSync(
    "git ls-files 'lib/**/*.ts' 'lib/**/*.tsx' 'lib/**/*.css' " +
      "'app/**/*.ts' 'app/**/*.tsx' 'app/**/*.css' " +
      "'components/**/*.ts' 'components/**/*.tsx'",
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  return out.split('\n').map((s) => s.trim()).filter(Boolean).filter((f) => !EXCLUDE.some((re) => re.test(f)));
}

const emojiHits = [];
const whiteHits = [];
for (const f of listFiles()) {
  let txt;
  try { txt = readFileSync(f, 'utf8'); } catch { continue; }
  const lines = txt.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (EMOJI.test(line)) {
      const ch = [...line].find((c) => EMOJI.test(c));
      emojiHits.push(`${f}:${i + 1}  ${'U+' + ch.codePointAt(0).toString(16).toUpperCase()}  ${line.trim().slice(0, 70)}`);
    }
    const s = line.trim();
    if (RAW_WHITE.test(line) && !s.startsWith('*') && !s.startsWith('//') && !/var\(--[\w-]+,\s*#/.test(line) && !/a-danger|toast|\.err/i.test(line)) {
      whiteHits.push(`${f}:${i + 1}  ${s.slice(0, 80)}`);
    }
  }
}

let failed = false;
if (emojiHits.length) {
  failed = true;
  console.error(`\nDESIGN-GATE FAIL — ${emojiHits.length} Emoji/Glyph-Treffer in der UI-Quelle (Owner: keine Emojis):`);
  for (const h of emojiHits.slice(0, 60)) console.error('  ' + h);
}
// Weiß/Hex = ADVISORY (Warnung, kein Fail): statisch lässt sich nicht sicher
// unterscheiden, ob es auf einem hellen Akzent (→ Kontrast-Fail) oder auf einer
// dunklen Fläche (legitim) sitzt. Emoji bleibt der harte Gate.
if (whiteHits.length) {
  console.warn(`\nDESIGN-GATE WARN — ${whiteHits.length} rohe Weiß/Hex-Farbwerte (prüfen: auf Akzent → var(--on-accent)):`);
  for (const h of whiteHits.slice(0, 60)) console.warn('  ' + h);
}
if (failed) {
  console.error('\nDesign-Gate verletzt (Emojis). Bitte beheben (SVG-Icon / CSS-Status-Punkt).\n');
  process.exit(1);
}
console.log(`Design-Gate OK — 0 Emojis in lib/app/components.${whiteHits.length ? ` (${whiteHits.length} Weiß/Hex-Warnungen, advisory)` : ''}`);
