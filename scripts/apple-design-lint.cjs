#!/usr/bin/env node
/**
 * apple-design-lint.cjs (2026-05-30) — Grep-Gate für die automatisierbaren
 * Regeln des laz.ing Apple-Design-Rubric (docs/plans/2026-05-30_apple-design-
 * rubric.md). INFORMATIV (exit 0) — listet Verstöße, damit neue/überarbeitete
 * Surfaces nicht gegen den Rubric regredieren. Kein Hard-Fail im CI (bewusst:
 * 10/14px-Spacing + einige Legacy-Captions sind tief verankert; der Sweep
 * arbeitet sie schrittweise ab, kein Big-Bang).
 *
 * Geprüfte Regeln (deterministisch, grep-fähig):
 *   A1  Fließtext ≥ 13px        — `font-size: <13px` in components.css
 *                                  (Whitelist: Mono-/Caption-/Eyebrow-Klassen).
 *   A3  kein 700-Weight in UI   — `font-weight: 700` in components.css.
 *   C7  kein --ink-3 als Body   — `color: var(--ink-3)` auf Body-Sub-Klassen
 *                                  (Whitelist: Eyebrow/Index/Mono/Legend/Meta).
 *
 * Usage:
 *   node scripts/apple-design-lint.cjs          # menschlich lesbarer Report
 *   node scripts/apple-design-lint.cjs --json    # JSON-Report
 *   node scripts/apple-design-lint.cjs --strict  # exit 1 bei Verstößen (opt-in)
 *
 * Scope: app/components.css (der Surface-CSS-Kanon). globals.css ist die
 * Token-Quelle (--fs-body etc.) und wird bewusst nicht geprüft.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TARGET = path.join(ROOT, 'app', 'components.css');

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const strict = args.includes('--strict');

/**
 * Selektoren/Kontexte, in denen sub-13px-Text bzw. --ink-3 ERLAUBT sind:
 * Caption / Eyebrow / Mono / Index / Legend / Meta / Badge / Kicker. Wir
 * matchen heuristisch auf den zuletzt gesehenen Selektor-Namen einer Regel.
 */
const CAPTION_OK_RE =
  /(eyebrow|kicker|caption|__meta|-meta|__legend|legend|__index|index|__badge|badge|mono|__k\b|__sb\b|__small|__hint|placeholder|__glyph|chevron|__dot|__sep|__no\b|stage-no|__count)/i;

function lastSelectorBefore(lines, idx) {
  for (let i = idx; i >= 0; i--) {
    const m = /^\s*([.#][A-Za-z0-9_.:>\-\s,&]*?)\s*\{/.exec(lines[i]);
    if (m) return m[1].trim();
    // Stop am Block-Ende davor (heuristisch: vorheriger Block).
  }
  return '(unknown)';
}

function lint() {
  if (!fs.existsSync(TARGET)) {
    return { ok: false, error: `not found: ${TARGET}`, findings: [] };
  }
  const src = fs.readFileSync(TARGET, 'utf8');
  const lines = src.split(/\r?\n/);
  const findings = [];

  lines.forEach((line, i) => {
    const lineNo = i + 1;

    // A3 — font-weight: 700 (kein Wert > 600 in Surface-UI).
    if (/font-weight:\s*(700|800|900)\b/.test(line)) {
      findings.push({
        rule: 'A3',
        line: lineNo,
        selector: lastSelectorBefore(lines, i),
        text: line.trim(),
        msg: 'Weight > 600 in Surface-UI (Apple max Semibold 600).',
      });
    }

    // A1 — Fließtext < 13px (außer Caption/Mono/Eyebrow-Whitelist).
    const fsMatch = /font-size:\s*(\d+(?:\.\d+)?)px/.exec(line);
    if (fsMatch) {
      const px = parseFloat(fsMatch[1]);
      const sel = lastSelectorBefore(lines, i);
      const isCaptionCtx = CAPTION_OK_RE.test(sel) || CAPTION_OK_RE.test(line);
      if (px < 13 && !isCaptionCtx) {
        findings.push({
          rule: 'A1',
          line: lineNo,
          selector: sel,
          text: line.trim(),
          msg: `Fließtext ${px}px < 13px (nur Caption/Mono/Eyebrow dürfen < 13px).`,
        });
      }
      // A2 — halbe px (Apple-Type-Scale kennt keine .5px).
      if (!Number.isInteger(px)) {
        findings.push({
          rule: 'A2',
          line: lineNo,
          selector: sel,
          text: line.trim(),
          msg: `Zwischen-px ${px}px — auf die nächste Skalen-Stufe runden.`,
        });
      }
    }

    // C7 — color: var(--ink-3) auf Body-Sub-Klassen (außer Whitelist).
    if (/color:\s*var\(--ink-3\)/.test(line)) {
      const sel = lastSelectorBefore(lines, i);
      const isCaptionCtx = CAPTION_OK_RE.test(sel) || CAPTION_OK_RE.test(line);
      // Nur „body-artige" Sub-Klassen flaggen (…__sub / …__body / …__text /
      // …__desc). Reine Eyebrow/Index/Meta-Klassen sind durch Whitelist raus.
      const isBodyish = /(__sub\b|__body\b|__text\b|__desc\b|__copy\b|__para\b)/.test(sel);
      if (isBodyish && !isCaptionCtx) {
        findings.push({
          rule: 'C7',
          line: lineNo,
          selector: sel,
          text: line.trim(),
          msg: '--ink-3 als Fließtext-Farbe (< AA). Body = --on-card / --ink-2.',
        });
      }
    }
  });

  return { ok: true, target: path.relative(ROOT, TARGET), findings };
}

const result = lint();

if (asJson) {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} else if (result.error) {
  process.stderr.write(`apple-design-lint: ${result.error}\n`);
} else {
  const byRule = {};
  for (const f of result.findings) (byRule[f.rule] ||= []).push(f);
  const total = result.findings.length;
  process.stdout.write(
    `\n  Apple-Design-Lint · ${result.target}\n` +
      `  ${total} Verstoß(e) (informativ — Sweep läuft schrittweise)\n\n`,
  );
  for (const rule of ['A1', 'A2', 'A3', 'C7']) {
    const fs2 = byRule[rule] || [];
    if (fs2.length === 0) continue;
    process.stdout.write(`  [${rule}] ${fs2.length}\n`);
    for (const f of fs2.slice(0, 40)) {
      process.stdout.write(
        `    ${result.target}:${f.line}  ${f.selector}\n      ${f.msg}\n`,
      );
    }
    if (fs2.length > 40) process.stdout.write(`    … +${fs2.length - 40} weitere\n`);
    process.stdout.write('\n');
  }
  if (total === 0) process.stdout.write('  ✓ keine Verstöße.\n\n');
}

// Informativ: exit 0 (default). Opt-in --strict für CI-Hard-Gate.
process.exit(strict && result.findings && result.findings.length > 0 ? 1 : 0);
