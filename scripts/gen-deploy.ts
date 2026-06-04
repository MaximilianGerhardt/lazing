#!/usr/bin/env tsx
/**
 * scripts/gen-deploy.ts
 *
 * Dry-run CLI stub for the Deployment-Scaffold generator (Batch 7e C5).
 *
 * Usage:
 *   pnpm tsx scripts/gen-deploy.ts --target vercel
 *   pnpm tsx scripts/gen-deploy.ts --target docker
 *   pnpm tsx scripts/gen-deploy.ts --target tailscale
 *   pnpm tsx scripts/gen-deploy.ts --target caddy-vps
 *   pnpm tsx scripts/gen-deploy.ts --target docker --app myapp --domain app.example.com
 *
 * This script is a DRY-RUN by default:
 *   - It prints file paths + content to stdout.
 *   - It prints pre-deploy notes to stderr.
 *   - It does NOT write any files to disk.
 *
 * PHASE2_DEPLOY_WRITE:
 *   Actual file-writing is a gated (R3) action. This script intentionally
 *   does not implement --write to enforce the "generate first, review, then
 *   write" pattern. The PHASE2_DEPLOY_WRITE gate must be lifted by an
 *   explicit operator action in a future CI/CD step.
 *
 * No network calls. No secret values emitted. Safe to run at any time.
 */

import { generateDeployScaffold } from '../lib/deploy/scaffold';
import type { DeployConfigInput, DeployTarget } from '../lib/deploy/targets';

// ---------------------------------------------------------------------------
// Parse CLI args
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): {
  target: DeployTarget;
  appName: string;
  webPort: number;
  agentServerPort: number;
  domain: string | undefined;
} {
  const args = argv.slice(2);

  function flag(name: string): string | undefined {
    const idx = args.indexOf(name);
    return idx !== -1 ? args[idx + 1] : undefined;
  }

  const targetRaw = flag('--target');
  const validTargets: DeployTarget[] = ['vercel', 'docker', 'tailscale', 'caddy-vps'];

  if (!targetRaw || !validTargets.includes(targetRaw as DeployTarget)) {
    process.stderr.write(
      `Usage: tsx scripts/gen-deploy.ts --target <${validTargets.join('|')}> [--app <name>] [--domain <domain>]\n`,
    );
    process.exit(1);
  }

  return {
    target: targetRaw as DeployTarget,
    appName: flag('--app') ?? 'lazyos',
    webPort: Number(flag('--web-port') ?? '4200'),
    agentServerPort: Number(flag('--agent-port') ?? '4201'),
    domain: flag('--domain'),
  };
}

// ---------------------------------------------------------------------------
// laz.ing default ENV keys (from CLAUDE.md + docker-compose.yml)
// ---------------------------------------------------------------------------

const DEFAULT_ENV_KEYS = [
  'LAZYOS_AUTH_SECRET',
  'LAZYOS_ACCESS_CODE',
  'LAZYOS_CREDENTIAL_KEY',
  'LAZYOS_OWNER_EMAIL',
  'LAZYOS_OWNER_DISPLAY_NAME',
  'LAZYOS_CHAT_KEY',
];

const DEFAULT_CRON_SCHEDULES: Record<string, string> = {
  '/api/routines/sweep': '* * * * *',
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const { target, appName, webPort, agentServerPort, domain } = parseArgs(process.argv);

  const input: DeployConfigInput = {
    appName,
    webPort,
    agentServerPort,
    domain,
    envKeys: DEFAULT_ENV_KEYS,
    // Include cron schedules for Vercel target
    cronSchedules: target === 'vercel' ? DEFAULT_CRON_SCHEDULES : undefined,
    nodeVersion: 20,
  };

  const { files, notes } = generateDeployScaffold(target, input);

  // Print pre-deploy notes to stderr so they are visible but separable from stdout
  process.stderr.write('\n--- Pre-Deploy Notes ---\n');
  notes.forEach((note, i) => {
    process.stderr.write(`  ${i + 1}. ${note}\n`);
  });
  process.stderr.write('\n');

  // Print generated files to stdout (dry-run — no disk write)
  process.stdout.write(`--- Generated files for target: ${target} (DRY-RUN) ---\n\n`);
  for (const file of files) {
    process.stdout.write(`=== ${file.path} ===\n`);
    process.stdout.write(file.content);
    process.stdout.write('\n\n');
  }

  process.stderr.write(
    `[gen-deploy] Dry-run complete. ${files.length} file(s) would be written.\n`,
  );
  process.stderr.write(
    `[gen-deploy] PHASE2_DEPLOY_WRITE is gated — no files were written to disk.\n`,
  );
}

main();
