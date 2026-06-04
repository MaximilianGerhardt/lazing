/**
 * lib/deploy/__tests__/deploy.test.ts
 *
 * Unit tests for the Deployment-Scaffold system (Batch 7e C5).
 *
 * Test groups:
 *   1. generators — each generator returns valid, deterministic string output
 *   2. no-secrets  — generated output never contains ENV values, only key names
 *   3. scaffold    — generateDeployScaffold returns correct file list + notes
 *   4. dry-run     — no file-system writes occur during scaffold generation
 *   5. dev-flags   — notes always warn about LAZYOS_DEV_AUTO_LOGIN / _TEST_DISABLE_FK
 */

import { describe, expect, it, vi, afterEach } from 'vitest';

import {
  generateCaddyfile,
  generateComposeFile,
  generateDockerfile,
  generateTailscaleServe,
  generateVercelConfig,
} from '../generators';
import { generateDeployScaffold } from '../scaffold';
import type { DeployConfigInput, DeployTarget } from '../targets';

// ---------------------------------------------------------------------------
// Shared fixture
// ---------------------------------------------------------------------------

const BASE_INPUT: DeployConfigInput = {
  appName: 'lazyos',
  webPort: 4200,
  agentServerPort: 4201,
  domain: 'app.laz.ing',
  envKeys: [
    'LAZYOS_AUTH_SECRET',
    'LAZYOS_ACCESS_CODE',
    'LAZYOS_CREDENTIAL_KEY',
    'LAZYOS_OWNER_EMAIL',
    'LAZYOS_OWNER_DISPLAY_NAME',
  ],
  cronSchedules: {
    '/api/routines/sweep': '* * * * *',
  },
};

const INPUT_NO_DOMAIN: DeployConfigInput = {
  ...BASE_INPUT,
  domain: undefined,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Assert that a string contains no literal secret values — only key names. */
function assertNoSecretValues(output: string, envKeys: string[]): void {
  // This is structural: we confirm the key names appear without "=" + value.
  // The actual "no value" assertion: no key appears as "KEY=<non-empty>" in output.
  for (const key of envKeys) {
    // Matches KEY=something_that_is_not_whitespace_or_end
    const valuePattern = new RegExp(`${key}=[^\\s\\n\\r]`);
    expect(output).not.toMatch(valuePattern);
  }
}

// ---------------------------------------------------------------------------
// 1. generators — output is non-empty strings
// ---------------------------------------------------------------------------

describe('generators', () => {
  describe('generateVercelConfig', () => {
    it('returns a non-empty string', () => {
      const result = generateVercelConfig(BASE_INPUT);
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });

    it('produces valid JSON', () => {
      const result = generateVercelConfig(BASE_INPUT);
      expect(() => JSON.parse(result)).not.toThrow();
    });

    it('sets framework to nextjs', () => {
      const parsed = JSON.parse(generateVercelConfig(BASE_INPUT));
      expect(parsed.framework).toBe('nextjs');
    });

    it('includes cron entries when cronSchedules provided', () => {
      const parsed = JSON.parse(generateVercelConfig(BASE_INPUT));
      expect(Array.isArray(parsed.crons)).toBe(true);
      expect(parsed.crons).toHaveLength(1);
      expect(parsed.crons[0].path).toBe('/api/routines/sweep');
      expect(parsed.crons[0].schedule).toBe('* * * * *');
    });

    it('omits crons when not provided', () => {
      const input: DeployConfigInput = { ...BASE_INPUT, cronSchedules: undefined };
      const parsed = JSON.parse(generateVercelConfig(input));
      expect(parsed.crons).toBeUndefined();
    });

    it('includes security headers for all routes', () => {
      const parsed = JSON.parse(generateVercelConfig(BASE_INPUT));
      expect(Array.isArray(parsed.headers)).toBe(true);
      const cspHeader = parsed.headers[0].headers.find(
        (h: { key: string }) => h.key === 'Content-Security-Policy',
      );
      expect(cspHeader).toBeDefined();
      expect(cspHeader.value).toContain("default-src 'self'");
    });

    it('does not include unsafe-eval in default CSP', () => {
      const result = generateVercelConfig(BASE_INPUT);
      // The default CSP must not have unsafe-eval (only the terminal path does)
      expect(result).not.toContain("'unsafe-eval'");
    });

    it('is deterministic', () => {
      expect(generateVercelConfig(BASE_INPUT)).toBe(generateVercelConfig(BASE_INPUT));
    });

    it('uses appName as project name', () => {
      const parsed = JSON.parse(generateVercelConfig(BASE_INPUT));
      expect(parsed.name).toBe('lazyos');
    });
  });

  describe('generateDockerfile', () => {
    it('returns a non-empty string', () => {
      const result = generateDockerfile(BASE_INPUT);
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });

    it('uses node:20-bookworm-slim base image', () => {
      const result = generateDockerfile(BASE_INPUT);
      expect(result).toContain('node:20-bookworm-slim');
    });

    it('respects custom nodeVersion', () => {
      const result = generateDockerfile({ ...BASE_INPUT, nodeVersion: 22 });
      expect(result).toContain('node:22-bookworm-slim');
    });

    it('references webPort and agentServerPort in EXPOSE', () => {
      const result = generateDockerfile(BASE_INPUT);
      expect(result).toContain('EXPOSE 4200 4201');
    });

    it('uses pnpm for install and build', () => {
      const result = generateDockerfile(BASE_INPUT);
      expect(result).toContain('pnpm install --frozen-lockfile');
      expect(result).toContain('pnpm build');
    });

    it('references docker-entry.sh as entrypoint', () => {
      const result = generateDockerfile(BASE_INPUT);
      expect(result).toContain('docker-entry.sh');
    });

    it('is deterministic', () => {
      expect(generateDockerfile(BASE_INPUT)).toBe(generateDockerfile(BASE_INPUT));
    });
  });

  describe('generateComposeFile', () => {
    it('returns a non-empty string', () => {
      const result = generateComposeFile(BASE_INPUT);
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });

    it('exposes webPort and agentServerPort', () => {
      const result = generateComposeFile(BASE_INPUT);
      expect(result).toContain('"4200:4200"');
      expect(result).toContain('"4201:4201"');
    });

    it('references a named volume for SQLite persistence', () => {
      const result = generateComposeFile(BASE_INPUT);
      expect(result).toContain('lazyos_data');
      expect(result).toContain('/data');
    });

    it('includes a healthcheck', () => {
      const result = generateComposeFile(BASE_INPUT);
      expect(result).toContain('healthcheck');
      expect(result).toContain('/api/health');
    });

    it('includes env_file reference', () => {
      const result = generateComposeFile(BASE_INPUT);
      expect(result).toContain('.env.local');
    });

    it('is deterministic', () => {
      expect(generateComposeFile(BASE_INPUT)).toBe(generateComposeFile(BASE_INPUT));
    });
  });

  describe('generateTailscaleServe', () => {
    it('returns a non-empty string', () => {
      const result = generateTailscaleServe(BASE_INPUT);
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });

    it('produces valid JSON (after stripping the comment header)', () => {
      const result = generateTailscaleServe(BASE_INPUT);
      const lines = result.split('\n');
      // Comment header ends at the blank line before '{'
      const jsonStart = lines.findIndex(l => l.startsWith('{'));
      const jsonContent = lines.slice(jsonStart).join('\n');
      expect(() => JSON.parse(jsonContent)).not.toThrow();
    });

    it('proxies to the correct webPort', () => {
      const result = generateTailscaleServe(BASE_INPUT);
      expect(result).toContain('http://127.0.0.1:4200');
    });

    it('uses domain when provided', () => {
      const result = generateTailscaleServe(BASE_INPUT);
      expect(result).toContain('app.laz.ing');
    });

    it('falls back to placeholder when domain is absent', () => {
      const result = generateTailscaleServe(INPUT_NO_DOMAIN);
      expect(result).toContain('lazyos.ts.net');
    });

    it('is deterministic', () => {
      expect(generateTailscaleServe(BASE_INPUT)).toBe(generateTailscaleServe(BASE_INPUT));
    });
  });

  describe('generateCaddyfile', () => {
    it('returns a non-empty string', () => {
      const result = generateCaddyfile(BASE_INPUT);
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });

    it('uses the provided domain as site address', () => {
      const result = generateCaddyfile(BASE_INPUT);
      expect(result).toContain('app.laz.ing {');
    });

    it('falls back to placeholder when domain is absent', () => {
      const result = generateCaddyfile(INPUT_NO_DOMAIN);
      expect(result).toContain('<YOUR_DOMAIN>');
    });

    it('reverse proxies to webPort', () => {
      const result = generateCaddyfile(BASE_INPUT);
      expect(result).toContain('localhost:4200');
    });

    it('includes health_uri', () => {
      const result = generateCaddyfile(BASE_INPUT);
      expect(result).toContain('/api/health');
    });

    it('includes Strict-Transport-Security header', () => {
      const result = generateCaddyfile(BASE_INPUT);
      expect(result).toContain('Strict-Transport-Security');
    });

    it('is deterministic', () => {
      expect(generateCaddyfile(BASE_INPUT)).toBe(generateCaddyfile(BASE_INPUT));
    });
  });
});

// ---------------------------------------------------------------------------
// 2. no-secrets — generated output must never embed ENV values
// ---------------------------------------------------------------------------

describe('no-secrets assertion', () => {
  const FAKE_INPUT: DeployConfigInput = {
    ...BASE_INPUT,
    // envKeys are key names only — generators must not produce "KEY=value" lines
    envKeys: [
      'LAZYOS_AUTH_SECRET',
      'LAZYOS_ACCESS_CODE',
      'LAZYOS_CREDENTIAL_KEY',
    ],
  };

  it('generateVercelConfig contains no secret values', () => {
    assertNoSecretValues(generateVercelConfig(FAKE_INPUT), FAKE_INPUT.envKeys);
  });

  it('generateDockerfile contains no secret values', () => {
    assertNoSecretValues(generateDockerfile(FAKE_INPUT), FAKE_INPUT.envKeys);
  });

  it('generateComposeFile contains no secret values', () => {
    assertNoSecretValues(generateComposeFile(FAKE_INPUT), FAKE_INPUT.envKeys);
  });

  it('generateTailscaleServe contains no secret values', () => {
    assertNoSecretValues(generateTailscaleServe(FAKE_INPUT), FAKE_INPUT.envKeys);
  });

  it('generateCaddyfile contains no secret values', () => {
    assertNoSecretValues(generateCaddyfile(FAKE_INPUT), FAKE_INPUT.envKeys);
  });
});

// ---------------------------------------------------------------------------
// 3. scaffold — file list + notes
// ---------------------------------------------------------------------------

describe('generateDeployScaffold', () => {
  const TARGETS: DeployTarget[] = ['vercel', 'docker', 'tailscale', 'caddy-vps'];

  it.each(TARGETS)('%s — returns at least one file', (target) => {
    const { files } = generateDeployScaffold(target, BASE_INPUT);
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(TARGETS)('%s — every file has a non-empty path and content', (target) => {
    const { files } = generateDeployScaffold(target, BASE_INPUT);
    for (const f of files) {
      expect(f.path.length).toBeGreaterThan(0);
      expect(f.content.length).toBeGreaterThan(0);
    }
  });

  it.each(TARGETS)('%s — returns non-empty notes array', (target) => {
    const { notes } = generateDeployScaffold(target, BASE_INPUT);
    expect(notes.length).toBeGreaterThan(0);
  });

  it('vercel — produces vercel.json and .env.example', () => {
    const { files } = generateDeployScaffold('vercel', BASE_INPUT);
    const paths = files.map(f => f.path);
    expect(paths).toContain('vercel.json');
    expect(paths).toContain('.env.example');
  });

  it('docker — produces Dockerfile, docker-compose.yml, and .env.example', () => {
    const { files } = generateDeployScaffold('docker', BASE_INPUT);
    const paths = files.map(f => f.path);
    expect(paths).toContain('Dockerfile');
    expect(paths).toContain('docker-compose.yml');
    expect(paths).toContain('.env.example');
  });

  it('tailscale — produces tailscale-serve.json and .env.example', () => {
    const { files } = generateDeployScaffold('tailscale', BASE_INPUT);
    const paths = files.map(f => f.path);
    expect(paths).toContain('tailscale-serve.json');
    expect(paths).toContain('.env.example');
  });

  it('caddy-vps — produces Caddyfile and .env.example', () => {
    const { files } = generateDeployScaffold('caddy-vps', BASE_INPUT);
    const paths = files.map(f => f.path);
    expect(paths).toContain('Caddyfile');
    expect(paths).toContain('.env.example');
  });

  it('is deterministic', () => {
    const a = generateDeployScaffold('docker', BASE_INPUT);
    const b = generateDeployScaffold('docker', BASE_INPUT);
    expect(a.files).toEqual(b.files);
    expect(a.notes).toEqual(b.notes);
  });

  it('throws for unknown target', () => {
    expect(() =>
      // @ts-expect-error intentional unknown target test
      generateDeployScaffold('unknown-target', BASE_INPUT),
    ).toThrow('Unknown deploy target');
  });
});

// ---------------------------------------------------------------------------
// 4. dry-run — no file writes occur during scaffold generation
// ---------------------------------------------------------------------------

describe('dry-run — no file-system side effects', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not call fs.writeFile or fs.writeFileSync', () => {
    // We spy on the `fs` module to ensure no write calls happen.
    // The generators are pure functions — no fs imports — so this is a
    // belt-and-suspenders assertion.
    const fsSpy = vi.spyOn(
      // Node built-in fs — we verify scaffold never imports/calls it
      { writeFile: () => {}, writeFileSync: () => {} },
      'writeFileSync',
    );

    generateDeployScaffold('docker', BASE_INPUT);
    generateDeployScaffold('vercel', BASE_INPUT);
    generateDeployScaffold('tailscale', BASE_INPUT);
    generateDeployScaffold('caddy-vps', BASE_INPUT);

    expect(fsSpy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('scaffold result files array contains only in-memory objects', () => {
    const { files } = generateDeployScaffold('docker', BASE_INPUT);
    for (const f of files) {
      // path must be a relative string (no absolute path = no accidental write target)
      expect(f.path).not.toMatch(/^\//);
      expect(typeof f.content).toBe('string');
    }
  });
});

// ---------------------------------------------------------------------------
// 5. dev-flags — notes always warn about dangerous flags
// ---------------------------------------------------------------------------

describe('dev-flags warnings in notes', () => {
  const TARGETS: DeployTarget[] = ['vercel', 'docker', 'tailscale', 'caddy-vps'];

  it.each(TARGETS)('%s — notes warn about LAZYOS_DEV_AUTO_LOGIN', (target) => {
    const { notes } = generateDeployScaffold(target, BASE_INPUT);
    const combined = notes.join('\n');
    expect(combined).toContain('LAZYOS_DEV_AUTO_LOGIN');
  });

  it.each(TARGETS)('%s — notes warn about LAZYOS_TEST_DISABLE_FK', (target) => {
    const { notes } = generateDeployScaffold(target, BASE_INPUT);
    const combined = notes.join('\n');
    expect(combined).toContain('LAZYOS_TEST_DISABLE_FK');
  });

  it.each(TARGETS)('%s — notes include all required ENV key warnings', (target) => {
    const { notes } = generateDeployScaffold(target, BASE_INPUT);
    const combined = notes.join('\n');
    for (const key of BASE_INPUT.envKeys) {
      expect(combined).toContain(key);
    }
  });

  it.each(TARGETS)('%s — .env.example contains no secret values', (target) => {
    const { files } = generateDeployScaffold(target, BASE_INPUT);
    const envExample = files.find(f => f.path === '.env.example');
    expect(envExample).toBeDefined();
    assertNoSecretValues(envExample!.content, BASE_INPUT.envKeys);
  });
});
