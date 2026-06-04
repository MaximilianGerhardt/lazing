/**
 * Multi-Engine Smoke Test
 *
 * Probes every registered chat engine (claude-cli, codex-cli, ollama) for
 * availability + runs a small "say hello" prompt against the ones that
 * report `available: true`. Prints a markdown matrix to stdout.
 *
 * Usage:
 *   pnpm tsx scripts/smoke-multi-engine.ts
 *   pnpm tsx scripts/smoke-multi-engine.ts --only=ollama
 *   pnpm tsx scripts/smoke-multi-engine.ts --probe-only   (skip chat-test)
 */

import {
  detectEngines,
  getEngine,
  type EngineId,
} from '../lib/llm/engines';

const PROMPT = 'Reply with exactly the single word: OK';

interface SmokeResult {
  engine: EngineId;
  detect: { available: boolean; reason: string; probeMs: number };
  chat?: {
    ok: boolean;
    latencyMs?: number;
    text?: string;
    error?: string;
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const probeOnly = args.includes('--probe-only');
  const onlyArg = args.find((a) => a.startsWith('--only='));
  const only = onlyArg ? (onlyArg.split('=')[1] as EngineId) : null;

  console.log('# Multi-Engine Smoke Test');
  console.log(`Started at ${new Date().toISOString()}`);
  if (only) console.log(`Filter: --only=${only}`);
  if (probeOnly) console.log('Mode: probe-only (no chat test)');
  console.log('');

  const selection = await detectEngines({ forceProbe: true });
  console.log(`Preferred engine: **${selection.preferred ?? '(none available)'}**\n`);

  const results: SmokeResult[] = [];

  for (const probe of selection.available) {
    if (only && probe.engine !== only) continue;
    const result: SmokeResult = {
      engine: probe.engine,
      detect: {
        available: probe.available,
        reason: probe.reason,
        probeMs: probe.probeMs,
      },
    };
    if (!probeOnly && probe.available) {
      const engine = getEngine(probe.engine);
      try {
        const resp = await engine.chat({
          messages: [{ role: 'user', content: PROMPT }],
          maxTokens: 64,
          timeoutMs: 60_000,
        });
        result.chat = {
          ok: true,
          latencyMs: resp.latencyMs,
          text: resp.text.trim().slice(0, 120),
        };
      } catch (err) {
        result.chat = {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
    results.push(result);
  }

  console.log('## Availability Matrix\n');
  console.log('| Engine | Available | Probe ms | Reason |');
  console.log('|---|---|---|---|');
  for (const r of results) {
    console.log(
      `| ${r.engine} | ${r.detect.available ? 'yes' : 'no'} | ${r.detect.probeMs} | ${r.detect.reason} |`,
    );
  }

  if (!probeOnly) {
    console.log('\n## Chat Test Matrix\n');
    console.log('| Engine | OK | Latency ms | Response (truncated) | Error |');
    console.log('|---|---|---|---|---|');
    for (const r of results) {
      if (!r.chat) {
        console.log(`| ${r.engine} | skipped | - | - | (not-available) |`);
        continue;
      }
      const tx = r.chat.text?.replace(/\|/g, '\\|').replace(/\n/g, ' ') ?? '';
      const err = (r.chat.error ?? '').slice(0, 200).replace(/\|/g, '\\|');
      console.log(
        `| ${r.engine} | ${r.chat.ok ? 'yes' : 'no'} | ${r.chat.latencyMs ?? '-'} | ${tx} | ${err} |`,
      );
    }
  }

  console.log('\n## Raw JSON\n');
  console.log('```json');
  console.log(JSON.stringify({ selection, results }, null, 2));
  console.log('```');

  // Exit non-zero if NOTHING worked (helps CI). probe-only never fails.
  if (!probeOnly && results.every((r) => r.chat && !r.chat.ok)) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('SMOKE TEST CRASHED:', err);
  process.exit(2);
});
