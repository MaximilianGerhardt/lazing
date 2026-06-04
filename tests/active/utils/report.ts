/**
 * tests/active/utils/report.ts
 *
 * Minimal-Reporter für die aktiven Smokes. Sammelt {name, status, evidence}-
 * Records und schreibt ein JSON-Artefakt unter docs/audits/, das der
 * Markdown-Bericht referenziert.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export type SmokeStatus = 'pass' | 'fail' | 'skip' | 'warn';

export interface SmokeResult {
  name: string;
  status: SmokeStatus;
  /** Verbatim-Beobachtung — Status-Code, Body-Snippet, Console-Log, file:line. */
  evidence: string;
  /** Optional: ms it took. */
  durationMs?: number;
  /** Optional: hint at the backend-trigger we expected (`file:line`). */
  expectedBackend?: string;
}

const results: SmokeResult[] = [];

export function record(r: SmokeResult): void {
  results.push(r);
  const icon = r.status === 'pass' ? 'PASS' : r.status === 'fail' ? 'FAIL' : r.status === 'warn' ? 'WARN' : 'SKIP';
  // eslint-disable-next-line no-console
  console.log(`[${icon}] ${r.name}${r.durationMs != null ? ` (${r.durationMs}ms)` : ''}`);
  if (r.status !== 'pass') {
    // eslint-disable-next-line no-console
    console.log(`        ${r.evidence.split('\n').slice(0, 6).join('\n        ')}`);
  }
}

export function getResults(): SmokeResult[] {
  return results.slice();
}

export function writeJsonReport(outPath: string): void {
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        runAt: new Date().toISOString(),
        baseUrl: process.env.LAZYOS_SMOKE_BASE_URL ?? 'http://127.0.0.1:4200',
        counts: {
          total: results.length,
          pass: results.filter((r) => r.status === 'pass').length,
          fail: results.filter((r) => r.status === 'fail').length,
          warn: results.filter((r) => r.status === 'warn').length,
          skip: results.filter((r) => r.status === 'skip').length,
        },
        results,
      },
      null,
      2,
    ),
  );
}

export function exitCodeFromResults(): number {
  return results.some((r) => r.status === 'fail') ? 1 : 0;
}
