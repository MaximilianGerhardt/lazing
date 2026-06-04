import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

/**
 * N1 — Detail-Preservation Lint Guard
 *
 * Blockiert .slice() / .substring() / .substr() auf benannte Ledger-Content-
 * Felder. Die Felder sind kanonisch:
 *
 *   contentFull   — chat_ledger.content_full (Drizzle camelCase)
 *   content_full  — raw SQL / Drizzle snake_case fallback
 *   detailBody    — workstream_detail_ledger (geplant, Slice B)
 *   detail_body   — snake_case variant
 *   ledgerContent — generischer Ledger-Feld-Name für neue Tabellen
 *
 * Selektor-Erklärung (esquery / AST):
 *
 *   CallExpression
 *     [callee.type="MemberExpression"]
 *       — stellt sicher, dass es ein Methoden-Aufruf auf einem Objekt ist
 *         (nicht z.B. ein direkt importierter slice-Funktion-Aufruf)
 *     [callee.property.name=/^(slice|substring|substr)$/]
 *       — die aufgerufene Methode ist eine der drei Kürzungs-Methoden
 *     [callee.object.type="MemberExpression"]
 *       — das Objekt des Methodenaufrufs ist selbst ein Member-Zugriff
 *         (d.h. foo.contentFull.slice(...), nicht messages.slice(-12))
 *         messages.slice(-12) schlägt hier fehl, weil callee.object.type
 *         = "Identifier", nicht "MemberExpression" — kein False-Positive.
 *     [callee.object.property.name=/^(contentFull|content_full|detailBody|detail_body|ledgerContent)$/]
 *       — der Member-Name des inneren Zugriffs ist ein bekanntes Ledger-Feld.
 *
 * Abdeckung und Grenzen:
 *   TRIFFT:  row.contentFull.slice(0, 200)
 *            this.contentFull.substring(0, 100)
 *            entry.detail_body.substr(5)
 *            ledger.ledgerContent.slice(1, -1)
 *   TRIFFT NICHT (False-Positive-frei):
 *            messages.slice(-12)          — callee.object ist Identifier
 *            firstLine.slice(0, 79)       — callee.object ist Identifier
 *            userId.slice(0, 8)           — callee.object ist Identifier
 *            arr.filter(x).slice(0, 3)    — callee.object ist CallExpression
 *            "Bearer ".slice(0, 6)        — callee.object ist Literal
 *
 * Grenze: Trifft keine computed member expressions wie obj["contentFull"].slice(...)
 * (callee.object.computed=true, property ist Literal statt Identifier). Das ist
 * akzeptabel — computed access auf Ledger-Felder wäre ohnehin ein Code-Smell.
 */
const N1_LEDGER_SLICE_SELECTOR = [
  'CallExpression',
  '[callee.type="MemberExpression"]',
  '[callee.property.name=/^(slice|substring|substr)$/]',
  '[callee.object.type="MemberExpression"]',
  '[callee.object.property.name=/^(contentFull|content_full|detailBody|detail_body|ledgerContent)$/]',
].join('');

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  {
    // N1 — Detail-Preservation Guard (operating constraint, non-negotiable)
    // Durchgesetzt für alle TS/TSX-Dateien im Projekt.
    // @see lib/types/ledger-string.ts — LedgerString Brand-Typ
    // @see docs/plans/swarm-runtime-v1.1/ — N1 operating constraint definition
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: N1_LEDGER_SLICE_SELECTOR,
          message:
            "N1: Ledger-Content darf nicht gekürzt werden (kein slice/substring/substr auf contentFull/content_full/detailBody/detail_body/ledgerContent). Verwende den vollständigen Wert oder LedgerString. Truncation nur in der UI-Render-Schicht via CSS.",
        },
      ],
    },
  },
]);

export default eslintConfig;
