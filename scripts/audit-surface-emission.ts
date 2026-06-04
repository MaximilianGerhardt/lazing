/**
 * audit-surface-emission.ts
 *
 * Vergleicht die definierten SURFACE_KINDS gegen das, was der System-Prompt
 * tatsaechlich emittieren kann, und gegen das, was der Renderer tatsaechlich
 * rendert. Zeigt:
 *   - Kinds die definiert + im Prompt erwaehnt + Renderer haben (sauber)
 *   - Kinds ohne Prompt-Erwaehnung (vermutlich dead-code-Renderer)
 *   - Kinds ohne Renderer (Bug — wird als Text emittiert)
 *
 * Run: pnpm tsx scripts/audit-surface-emission.ts
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { SURFACE_KINDS } from '../lib/chat/surface-parser';

const ROOT = resolve(__dirname, '..');
const SYS_PROMPT_FILE = resolve(ROOT, 'server/workspace-session.ts');
const RENDERER_FILE = resolve(ROOT, 'lib/chat/SurfaceRenderer.tsx');
// Backend-Sourcen die Surface-Tags direkt emittieren (nicht via Prompt).
// Beispiel: synthesis emittet <surface:milestone>, SurfaceRenderer pushed
// <surface:live-swarm> als Folge-Assistant-Message nach Tier-Choice-Klick.
const BACKEND_EMITTERS = [
  'server/agents/tier-orchestrator.ts',
  'server/agents/synthesis.ts',
  'app/api/workstreams/[id]/spawn/route.ts',
  'lib/chat/SurfaceRenderer.tsx', // pushAssistant-Pfad bei Tier-Choice
];

interface Finding {
  kind: string;
  inPrompt: boolean;
  inBackend: boolean;
  hasRenderer: boolean;
  status: 'sauber' | 'backend-only' | 'unbenutzt' | 'fehlt-renderer';
}

function main(): void {
  const sysPrompt = readFileSync(SYS_PROMPT_FILE, 'utf8');
  const renderer = readFileSync(RENDERER_FILE, 'utf8');
  const backendBlobs = BACKEND_EMITTERS.map((rel) => {
    try {
      return readFileSync(resolve(ROOT, rel), 'utf8');
    } catch {
      return '';
    }
  }).join('\n');

  const findings: Finding[] = SURFACE_KINDS.map((kind) => {
    const tag = `surface:${kind}`;
    const inPrompt = sysPrompt.includes(tag);
    const inBackend = backendBlobs.includes(tag);
    const hasRenderer = renderer.includes(`case '${kind}'`);
    let status: Finding['status'];
    if (!hasRenderer) status = 'fehlt-renderer';
    else if (inPrompt) status = 'sauber';
    else if (inBackend) status = 'backend-only';
    else status = 'unbenutzt';
    return { kind, inPrompt, inBackend, hasRenderer, status };
  });

  const sauber = findings.filter((f) => f.status === 'sauber');
  const backendOnly = findings.filter((f) => f.status === 'backend-only');
  const unbenutzt = findings.filter((f) => f.status === 'unbenutzt');
  const fehlt = findings.filter((f) => f.status === 'fehlt-renderer');

  // ANSI-bold wenn TTY, sonst plain
  const bold = process.stdout.isTTY ? '\x1b[1m' : '';
  const dim = process.stdout.isTTY ? '\x1b[2m' : '';
  const green = process.stdout.isTTY ? '\x1b[32m' : '';
  const yellow = process.stdout.isTTY ? '\x1b[33m' : '';
  const red = process.stdout.isTTY ? '\x1b[31m' : '';
  const reset = process.stdout.isTTY ? '\x1b[0m' : '';

  console.log(`${bold}Surface-Kind-Audit${reset}`);
  console.log(`${dim}Total: ${SURFACE_KINDS.length} Kinds${reset}\n`);

  console.log(`${green}✓ Sauber (im Prompt + Renderer): ${sauber.length}${reset}`);
  for (const f of sauber) console.log(`  - ${f.kind}`);

  console.log(
    `\n${green}✓ Backend-only (vom Server emittiert + Renderer): ${backendOnly.length}${reset}`,
  );
  for (const f of backendOnly) console.log(`  - ${f.kind}`);

  console.log(
    `\n${yellow}⚠ Unbenutzt (Renderer da, niemand emittiert): ${unbenutzt.length}${reset}`,
  );
  for (const f of unbenutzt) console.log(`  - ${f.kind}`);

  if (fehlt.length > 0) {
    console.log(`\n${red}✗ Renderer fehlt: ${fehlt.length}${reset}`);
    for (const f of fehlt) console.log(`  - ${f.kind}`);
  }

  console.log('');
  console.log(`${dim}Empfehlung:${reset}`);
  console.log(
    `${dim}- Unbenutzte Kinds entweder im System-Prompt-Beispiel ergaenzen${reset}`,
  );
  console.log(
    `${dim}  oder mit \`// deprecated\` markieren und entfernen.${reset}`,
  );

  if (fehlt.length > 0) {
    process.exitCode = 1;
  }
}

main();
