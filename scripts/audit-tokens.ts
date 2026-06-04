/**
 * audit-tokens.ts
 *
 * Token-Lint — findet zwei Klassen von Inkonsistenzen:
 *
 *  1) Tote Tokens — in app/globals.css ODER app/components.css als
 *     `--name: ...` definiert, aber nirgends in lib/ + app/ via `var(--name)`
 *     verwendet (Code-Müll).
 *
 *  2) Geister-Tokens — irgendwo via `var(--name)` referenziert, aber NICHT
 *     in einer der zwei CSS-Dateien definiert. Geister sind Token-Lügen —
 *     der Browser rendert sie als invalid (transparent/Default), der Code
 *     suggeriert Theme-Awareness.
 *
 * Ausnahmen:
 *   - Tailwind-/Browser-Built-ins (--font-*, --color-*, --spacing-*) werden
 *     NICHT als Geister gemeldet, wenn sie in @theme / @theme inline auftauchen.
 *   - var(--xxx, fallback) wird nicht als Geist gewertet, wenn fallback
 *     gesetzt ist UND Definition fehlt (Hinweis statt Fehler).
 *
 * Output:
 *   Tabellarisch (markdown). Exit 1 bei Geistern (hart), Exit 0 bei nur
 *   toten Tokens (weich, informativ).
 *
 * Run:  tsx scripts/audit-tokens.ts
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');
// Primary token-Defs (semantischer Standard)
const PRIMARY_CSS_FILES = [
  resolve(ROOT, 'app/globals.css'),
  resolve(ROOT, 'app/components.css'),
];
// Sekundäre Defs (dynamisch generiert, z.B. organizations-palette.css)
const SCAN_ROOTS = [resolve(ROOT, 'lib'), resolve(ROOT, 'app')];

const DEFINE_RE = /^\s*--([a-zA-Z][\w-]*)\s*:/gm;
const USE_RE = /var\(\s*--([a-zA-Z][\w-]*)(?:\s*,\s*[^)]+)?\s*\)/g;
const USE_WITH_FALLBACK_RE = /var\(\s*--([a-zA-Z][\w-]*)\s*,\s*([^)]+)\)/g;

interface Defs {
  byName: Map<string, { file: string; line: number }>;
}

function collectDefsFromFile(file: string, byName: Map<string, { file: string; line: number }>): void {
  let txt: string;
  try {
    txt = readFileSync(file, 'utf8');
  } catch {
    return;
  }
  const lines = txt.split('\n');
  for (let i = 0; i < lines.length; i++) {
    // Match definition: "--name:" but skip "@property --name {" forms (still a def)
    const m = /^\s*--([a-zA-Z][\w-]*)\s*:/.exec(lines[i]);
    if (m && !byName.has(m[1])) {
      byName.set(m[1], { file, line: i + 1 });
    }
  }
}

function collectAllCssFiles(dir: string, out: string[]): void {
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
    if (st.isDirectory()) collectAllCssFiles(full, out);
    else if (entry.endsWith('.css')) out.push(full);
  }
}

function collectRuntimeDefsFromTs(file: string, byName: Map<string, { file: string; line: number }>): void {
  let txt: string;
  try {
    txt = readFileSync(file, 'utf8');
  } catch {
    return;
  }
  const lines = txt.split('\n');
  // Match: .style.setProperty('--xxx', ...)  or  setProperty("--xxx", ...)
  const re = /setProperty\s*\(\s*['"`]--([a-zA-Z][\w-]*)['"`]/g;
  for (let i = 0; i < lines.length; i++) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(lines[i])) !== null) {
      if (!byName.has(m[1])) byName.set(m[1], { file, line: i + 1 });
    }
  }
}

function collectAllTsFiles(dir: string, out: string[]): void {
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
    if (st.isDirectory()) collectAllTsFiles(full, out);
    else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) out.push(full);
  }
}

function collectDefs(): { primary: Defs; all: Defs } {
  const primary = new Map<string, { file: string; line: number }>();
  for (const f of PRIMARY_CSS_FILES) collectDefsFromFile(f, primary);

  const all = new Map<string, { file: string; line: number }>(primary);
  const cssFiles: string[] = [];
  for (const r of SCAN_ROOTS) collectAllCssFiles(r, cssFiles);
  for (const f of cssFiles) {
    if (PRIMARY_CSS_FILES.includes(f)) continue;
    collectDefsFromFile(f, all);
  }
  // Runtime-Defs (TopNav etc. setzen Tokens via document.documentElement.style.setProperty)
  const tsFiles: string[] = [];
  for (const r of SCAN_ROOTS) collectAllTsFiles(r, tsFiles);
  for (const f of tsFiles) collectRuntimeDefsFromTs(f, all);

  return { primary: { byName: primary }, all: { byName: all } };
}

interface Use {
  name: string;
  file: string;
  line: number;
  hasFallback: boolean;
}

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
    if (st.isDirectory()) {
      walk(full, out);
    } else if (
      entry.endsWith('.tsx') ||
      entry.endsWith('.ts') ||
      entry.endsWith('.css') ||
      entry.endsWith('.module.css')
    ) {
      out.push(full);
    }
  }
}

function collectUses(files: string[]): Use[] {
  const out: Use[] = [];
  const IGNORE = 'audit-tokens-ignore';
  for (const f of files) {
    const txt = readFileSync(f, 'utf8');
    const lines = txt.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const prev = i > 0 ? lines[i - 1] : '';
      if (prev.includes(IGNORE)) continue;
      USE_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = USE_RE.exec(line)) !== null) {
        const hasFb = /var\(\s*--[\w-]+\s*,/.test(line.slice(m.index));
        out.push({ name: m[1], file: f, line: i + 1, hasFallback: hasFb });
      }
    }
  }
  return out;
}

function main(): void {
  const { primary, all } = collectDefs();
  const files: string[] = [];
  for (const root of SCAN_ROOTS) walk(root, files);
  const uses = collectUses(files);

  const usedNames = new Set(uses.map((u) => u.name));
  const primaryDefined = new Set(primary.byName.keys());
  const allDefined = new Set(all.byName.keys());

  // Tote Tokens: defined in PRIMARY (globals.css/components.css) but not used.
  // Dynamisch generierte Palette-Defs zählen NICHT als "tot" — die werden
  // teils per Index-Lookup zur Laufzeit referenziert.
  const dead: string[] = [];
  for (const name of primaryDefined) {
    if (!usedNames.has(name)) dead.push(name);
  }
  // Tailwind @theme inline mappings (--color-*) zählen nicht als tot —
  // werden via Tailwind-Utilities (bg-sheet, text-ink) konsumiert.
  const deadFiltered = dead.filter((n) => !n.startsWith('color-'));
  deadFiltered.sort();

  // Geister-Tokens: used but NOT defined ANYWHERE (incl. dynamic CSS)
  const ghosts: { name: string; uses: Use[] }[] = [];
  const ghostsByName = new Map<string, Use[]>();
  for (const u of uses) {
    if (allDefined.has(u.name)) continue;
    if (!ghostsByName.has(u.name)) ghostsByName.set(u.name, []);
    ghostsByName.get(u.name)!.push(u);
  }
  for (const [name, list] of ghostsByName) {
    ghosts.push({ name, uses: list });
  }
  ghosts.sort((a, b) => a.name.localeCompare(b.name));

  // hart vs weich: hart = mind. 1 use ohne fallback
  const hardGhosts = ghosts.filter((g) => g.uses.some((u) => !u.hasFallback));
  const softGhosts = ghosts.filter((g) => !g.uses.some((u) => !u.hasFallback));

  console.log('# Token Audit');
  console.log(`# Defined (primary): ${primaryDefined.size}`);
  console.log(`# Defined (incl. dynamic CSS): ${allDefined.size}`);
  console.log(`# Used: ${usedNames.size}`);
  console.log(`# Dead (primary defined, not used, excl. --color-*): ${deadFiltered.length}`);
  console.log(`# Ghosts hard (used, not defined, no fallback): ${hardGhosts.length}`);
  console.log(`# Ghosts soft (used with fallback, not defined): ${softGhosts.length}`);
  console.log('');

  if (hardGhosts.length > 0) {
    console.log('## Hard Ghosts (FAIL — Token-Lügen ohne Fallback)');
    console.log('');
    console.log('| Token | Uses | First Location |');
    console.log('|-------|-----:|----------------|');
    for (const g of hardGhosts) {
      const first = g.uses[0];
      const loc = `${relative(ROOT, first.file)}:${first.line}`;
      console.log(`| --${g.name} | ${g.uses.length} | ${loc} |`);
    }
    console.log('');
  }

  if (softGhosts.length > 0) {
    console.log('## Soft Ghosts (WARN — fallback gesetzt, Definition fehlt)');
    console.log('');
    console.log('| Token | Uses | First Location |');
    console.log('|-------|-----:|----------------|');
    for (const g of softGhosts) {
      const first = g.uses[0];
      const loc = `${relative(ROOT, first.file)}:${first.line}`;
      console.log(`| --${g.name} | ${g.uses.length} | ${loc} |`);
    }
    console.log('');
  }

  if (deadFiltered.length > 0) {
    console.log('## Dead Tokens (INFO — defined but unused, Code-Müll)');
    console.log('');
    for (const name of deadFiltered) {
      const def = primary.byName.get(name)!;
      console.log(`- --${name}  (${relative(ROOT, def.file)}:${def.line})`);
    }
    console.log('');
  }

  if (hardGhosts.length === 0 && softGhosts.length === 0 && deadFiltered.length === 0) {
    console.log('OK — keine Token-Inkonsistenzen.');
    process.exit(0);
  }

  if (hardGhosts.length > 0) {
    console.error(`FAIL — ${hardGhosts.length} Hard-Ghost-Token(s) gefunden.`);
    process.exit(1);
  }

  console.log(`OK (mit Warnungen) — ${softGhosts.length} soft ghosts, ${deadFiltered.length} dead tokens.`);
  process.exit(0);
}

main();
