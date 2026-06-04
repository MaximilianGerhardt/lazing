/**
 * lib/deploy/generators.ts
 *
 * Pure generator functions — each returns a config file *content* (string).
 * NONE of these functions write to disk, make network calls, or access
 * environment values. They are deterministic: same input → same output.
 *
 * CSP policy is mirrored from next.config.ts (Phase 6 hardening):
 *   - script-src includes 'unsafe-inline' + https://vercel.live (prod preview widget)
 *   - NO unsafe-eval in the default policy (ttyd /terminal/* is separate)
 *   - connect-src includes laz.ing + Cloudflare tunnel domains
 *
 * PHASE2_DEPLOY_WRITE boundary: the caller (scaffold.ts / gen-deploy.ts) decides
 * whether to write these strings to disk — not this module.
 */

import type { DeployConfigInput } from './targets';

// ---------------------------------------------------------------------------
// CSP helpers — mirrors next.config.ts CSP_POLICY for generated configs
// ---------------------------------------------------------------------------

const CSP_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://vercel.live",
  "style-src 'self' 'unsafe-inline' https://vercel.live",
  "img-src 'self' data: blob: https://vercel.live https://vercel.com",
  "font-src 'self' data: https://vercel.live https://assets.vercel.com",
  "connect-src 'self' https://vercel.live wss://ws-us3.pusher.com https://*.pusher.com https://example.com https://example.com https://app.laz.ing https://laz.ing",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "media-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-src 'self' https://vercel.live",
  "frame-ancestors 'none'",
  "upgrade-insecure-requests",
];

const CSP_VALUE = CSP_DIRECTIVES.join('; ');

/** Security headers shared across all routes (production values). */
const SECURITY_HEADERS = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(self), geolocation=()' },
  { key: 'Content-Security-Policy', value: CSP_VALUE },
  { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains; preload' },
  { key: 'X-Permitted-Cross-Domain-Policies', value: 'none' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
];

// ---------------------------------------------------------------------------
// 1. Vercel config
// ---------------------------------------------------------------------------

/**
 * Generates the content of a `vercel.json` file.
 *
 * Produces:
 *   - framework: "nextjs"
 *   - security headers for all routes (CSP mirrored from next.config.ts)
 *   - cron entries when cronSchedules is provided
 *   - buildCommand / installCommand using pnpm
 *
 * The generated JSON is deterministic and contains NO secret values —
 * only ENV key-name references where needed.
 */
export function generateVercelConfig(input: DeployConfigInput): string {
  const { appName, cronSchedules } = input;

  const headers = [
    {
      source: '/(.*)',
      headers: SECURITY_HEADERS,
    },
  ];

  const crons = cronSchedules
    ? Object.entries(cronSchedules).map(([path, schedule]) => ({ path, schedule }))
    : undefined;

  const config: Record<string, unknown> = {
    $schema: 'https://openapi.vercel.sh/vercel.json',
    // Project name matches the Vercel project slug (lazyos — legacy code identifier).
    name: appName,
    framework: 'nextjs',
    // pnpm install with exact lockfile for reproducible builds.
    installCommand: 'pnpm install --frozen-lockfile',
    buildCommand: 'pnpm build',
    // next.config.ts serverExternalPackages handles native deps —
    // Vercel's bundler must NOT try to inline them.
    functions: {
      'app/**': {
        // 250 MB Lambda soft limit — native deps excluded via outputFileTracingExcludes.
        maxDuration: 30,
      },
    },
    headers,
    // ENV vars are set in Vercel dashboard / `vercel env` CLI.
    // NEVER set secret values in vercel.json — use the dashboard or:
    //   vercel env add LAZYOS_AUTH_SECRET production
    env: {},
  };

  if (crons) {
    config['crons'] = crons;
  }

  return JSON.stringify(config, null, 2);
}

// ---------------------------------------------------------------------------
// 2. Dockerfile (multi-stage)
// ---------------------------------------------------------------------------

/**
 * Generates a multi-stage Dockerfile for the laz.ing production image.
 *
 * Stages:
 *   - builder: installs all deps (incl. devDeps), runs `next build`
 *   - runtime: minimal Node + pnpm, copies only what is needed at runtime
 *
 * Ports: webPort (default 4200) + agentServerPort (default 4201).
 * SQLite volume: /data/lazyos.db — mount from host for persistence.
 *
 * Agent-server note: the agent-server sidecar is NOT launched by default
 * inside the image because it requires the `claude` CLI binary which is
 * not bundled. See scripts/docker-entry.sh for the conditional startup
 * pattern (LAZYOS_CHAT_KEY + `command -v claude` check).
 *
 * ENV values are NEVER embedded — only ENV key-name placeholders are shown.
 */
export function generateDockerfile(input: DeployConfigInput): string {
  const {
    appName,
    webPort,
    agentServerPort,
    nodeVersion = 20,
  } = input;

  return `# ${appName} — production image
# Generated by lib/deploy/generators.ts (Batch 7e C5)
#
# Two-stage build:
#   1. builder  — installs deps, runs \`next build\`, freezes node_modules
#   2. runtime  — minimal: Node + pnpm + tsx for entrypoint scripts
#
# Image works on amd64 + arm64.
# Boot via scripts/docker-entry.sh: runs migrations + lazyos-setup.ts before
# exposing the web on ${webPort}. Agent-server on ${agentServerPort} starts only if
# the \`claude\` CLI is present AND LAZYOS_CHAT_KEY is set.
#
# IMPORTANT — secrets/ENV values are NEVER set here.
# Set them in .env.local (docker-compose) or the platform's secrets manager.
#
# Required ENV keys at runtime (no defaults — MUST be set before first boot):
#   LAZYOS_AUTH_SECRET      — NextAuth session signing secret (>=32 random chars)
#   LAZYOS_ACCESS_CODE      — initial login passcode
#   LAZYOS_CREDENTIAL_KEY   — AES-256 key for credential encryption
#   LAZYOS_OWNER_EMAIL      — first-run owner bootstrap email
#   LAZYOS_OWNER_DISPLAY_NAME — first-run display name
#
# Dev-only ENV flags that MUST NOT be set in production:
#   LAZYOS_DEV_AUTO_LOGIN   — bypasses auth entirely (NEVER in prod)
#   LAZYOS_TEST_DISABLE_FK  — disables SQLite FK enforcement (NEVER in prod)

# ---- builder ---------------------------------------------------------------
FROM node:${nodeVersion}-bookworm-slim AS builder

WORKDIR /app

# pnpm via corepack (matches local dev exactly — packageManager field in package.json).
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

# Cache the dep layer separately from source for faster rebuilds.
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile

# Copy full source tree, then build.
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# Production build — NO unsafe-eval in CSP; next.config.ts handles headers.
RUN pnpm build

# ---- runtime ---------------------------------------------------------------
FROM node:${nodeVersion}-bookworm-slim AS runtime

WORKDIR /app

# Re-enable corepack so \`pnpm tsx\` works in entrypoint scripts.
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

# better-sqlite3 ships native bindings — copy from builder so we don't rebuild.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next          ./.next
COPY --from=builder /app/public         ./public
COPY --from=builder /app/package.json   ./package.json
COPY --from=builder /app/pnpm-lock.yaml* ./

# Files needed at runtime (migrations, setup scripts, server-side code).
COPY --from=builder /app/db      ./db
COPY --from=builder /app/lib     ./lib
COPY --from=builder /app/server  ./server
COPY --from=builder /app/scripts ./scripts

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=${webPort}
# SQLite volume — mount /data from host for persistence:
#   docker run -v $(pwd)/data:/data ...
ENV LAZYOS_DB_PATH=/data/lazyos.db

EXPOSE ${webPort} ${agentServerPort}

# Entrypoint runs migrations + optional lazyos-setup.ts + parallel start.
# See scripts/docker-entry.sh for the full conditional startup logic.
COPY --from=builder /app/scripts/docker-entry.sh /docker-entry.sh
RUN chmod +x /docker-entry.sh

ENTRYPOINT ["/docker-entry.sh"]
`;
}

// ---------------------------------------------------------------------------
// 3. docker-compose.yml
// ---------------------------------------------------------------------------

/**
 * Generates a docker-compose.yml for local or VPS self-hosting.
 *
 * Services:
 *   - web (${webPort}): the Next.js app + entrypoint
 *   - Volume lazyos_data mounted at /data for SQLite persistence
 *
 * Agent-server note: port 4201 is exposed by the same container; the
 * entrypoint script conditionally starts it. No separate compose service is
 * needed unless the agent-server is extracted to its own image.
 *
 * Cloudflare Tunnel: left as a commented-out optional service block.
 *
 * ENV values are NEVER embedded. Operator must supply .env.local.
 */
export function generateComposeFile(input: DeployConfigInput): string {
  const {
    appName,
    webPort,
    agentServerPort,
    envKeys,
  } = input;

  // Bare key NAMES only — never "KEY=value" or "KEY=${...}" form, so the
  // generated file carries no secret values and no value placeholders.
  const envKeyComment = envKeys
    .map(k => `#   ${k}`)
    .join('\n');

  // docker-compose `environment:` list with bare keys (no `=`): docker-compose
  // passes the matching host-ENV value through at runtime WITHOUT writing it
  // into this file. This is the idiomatic "no value in file" form.
  const environmentBlock = envKeys
    .map(k => `      - ${k}`)
    .join('\n');

  return `# ${appName} — docker-compose (Generated by lib/deploy/generators.ts)
#
# Quickstart:
#   1. cp .env.example .env.local
#   2. Fill in required secrets (see list below).
#   3. docker compose up --build
#
# After ~3 min: http://localhost:${webPort}/login
#
# Required ENV keys (set their VALUES in .env.local — NEVER commit values):
${envKeyComment}
#
# Dev-only flags — set ONLY for local dev, NEVER in production:
#   LAZYOS_DEV_AUTO_LOGIN   bypasses all auth (DANGER in prod)
#   LAZYOS_TEST_DISABLE_FK  disables FK enforcement (DANGER in prod)

services:
  ${appName}:
    build:
      context: .
      dockerfile: Dockerfile
    image: ${appName}:local
    container_name: ${appName}
    restart: unless-stopped
    ports:
      - "${webPort}:${webPort}"
      - "${agentServerPort}:${agentServerPort}"
    # Values come from .env.local — this file never contains secret values.
    env_file:
      - .env.local
    # Bare key NAMES only (no "=value"): docker-compose forwards the host-ENV /
    # env_file value at runtime. Listing them here documents the contract
    # without embedding any value.
    environment:
${environmentBlock}
    volumes:
      - ${appName}_data:/data
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:${webPort}/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 5
      start_period: 60s

  # Optional: Cloudflare Tunnel — expose ${appName} publicly without opening ports.
  # Uncomment and set CLOUDFLARE_TUNNEL_TOKEN in .env.local to activate.
  #
  # tunnel:
  #   image: cloudflare/cloudflared:latest
  #   container_name: ${appName}-tunnel
  #   restart: unless-stopped
  #   command: tunnel --no-autoupdate run --token \${CLOUDFLARE_TUNNEL_TOKEN}
  #   depends_on:
  #     ${appName}:
  #       condition: service_healthy
  #   env_file:
  #     - .env.local

volumes:
  ${appName}_data:
    driver: local
`;
}

// ---------------------------------------------------------------------------
// 4. Tailscale serve config
// ---------------------------------------------------------------------------

/**
 * Generates a Tailscale serve config JSON for VPS local reverse-proxy.
 *
 * This config exposes the laz.ing web app (port ${webPort}) via Tailscale
 * MagicDNS at https://<hostname>.ts.net with automatic TLS.
 *
 * Usage (after `tailscale up` on VPS):
 *   tailscale serve --set-json <(cat tailscale-serve.json)
 *
 * Agent-server port (4201) is intentionally NOT exposed via Tailscale serve
 * by default — the agent sidecar is accessed only from the web process
 * running on the same host (localhost-to-localhost).
 */
export function generateTailscaleServe(input: DeployConfigInput): string {
  const { appName, webPort, domain } = input;
  const hostname = domain ?? `${appName}.ts.net`;

  const config = {
    // Tailscale serve config v1
    // Doc: https://tailscale.com/kb/1312/serve-config-reference
    TCP: {
      443: {
        HTTPS: true,
      },
    },
    Web: {
      [`${hostname}:443`]: {
        Handlers: {
          '/': {
            Proxy: `http://127.0.0.1:${webPort}`,
          },
        },
      },
    },
    // AllowFunnel: omit by default — Funnel exposes to internet, not just Tailnet.
    // Set to true only if you want public internet access via Tailscale Funnel.
  };

  const header = [
    `# ${appName} — Tailscale serve config (Generated by lib/deploy/generators.ts)`,
    '#',
    `# Exposes web on :${webPort} via https://${hostname}`,
    '# Apply with: tailscale serve --set-json <(cat tailscale-serve.json)',
    '#',
    '# TLS is handled by Tailscale automatically (LetsEncrypt via ACME).',
    '# No secret values in this file.',
    '',
  ].join('\n');

  return header + JSON.stringify(config, null, 2);
}

// ---------------------------------------------------------------------------
// 5. Caddyfile
// ---------------------------------------------------------------------------

/**
 * Generates a Caddyfile for VPS reverse-proxy with automatic TLS.
 *
 * Handles:
 *   - HTTPS termination for the public domain
 *   - Reverse proxy to the Next.js app on localhost:${webPort}
 *   - Security headers (X-Frame-Options, CSP, HSTS) at the proxy layer
 *     as a defence-in-depth addition to Next.js headers
 *   - Terminal path (/terminal/*) passes through without CSP override
 *     (the Next.js layer applies the terminal-specific CSP)
 *
 * Agent-server (4201): not proxied publicly by default. Access it only
 * from the same host or behind Tailscale.
 *
 * No ENV values are embedded — TLS email must be supplied by the operator.
 */
export function generateCaddyfile(input: DeployConfigInput): string {
  const { appName, webPort, domain } = input;
  const publicDomain = domain ?? `<YOUR_DOMAIN>`;

  return `# ${appName} — Caddyfile (Generated by lib/deploy/generators.ts)
# Apply with: caddy reload --config Caddyfile
#
# Requirements:
#   - Caddy v2.7+ installed on VPS
#   - DNS A/AAAA record for ${publicDomain} pointing to this VPS IP
#   - Replace <ADMIN_EMAIL> with a real email for ACME TLS notifications
#
# IMPORTANT: No secret values are stored in this file.
# Configure secrets via systemd EnvironmentFile or docker env_file.

{
  # Global options block
  email <ADMIN_EMAIL>
  # Admin API (localhost only — never expose to internet)
  admin localhost:2019
}

${publicDomain} {
  # Automatic TLS via Let's Encrypt (Caddy handles ACME automatically)
  tls {
    protocols tls1.2 tls1.3
  }

  # Defence-in-depth security headers (Next.js also sets these via next.config.ts)
  header {
    Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
    X-Content-Type-Options "nosniff"
    X-Frame-Options "DENY"
    Referrer-Policy "strict-origin-when-cross-origin"
    # Note: CSP is set per-route by Next.js headers() — Caddy's header here
    # is a fallback for non-Next routes (static assets, health endpoint).
    Content-Security-Policy "default-src 'self'; frame-ancestors 'none'; upgrade-insecure-requests"
    X-Permitted-Cross-Domain-Policies "none"
    Cross-Origin-Opener-Policy "same-origin"
    Cross-Origin-Resource-Policy "same-origin"
    # Remove server identification
    -Server
  }

  # Terminal path: Next.js handles the ttyd proxy rewrite internally.
  # /terminal/* requests are passed to Next.js which rewrites to 127.0.0.1:4203.
  # No special Caddy handling needed — just proxy everything to Next.js.

  # Reverse proxy to Next.js on localhost:${webPort}
  reverse_proxy localhost:${webPort} {
    # Health probe: Caddy marks upstream healthy only when /api/health returns 2xx
    health_uri /api/health
    health_interval 30s
    health_timeout 5s
    # Pass real client IP to Next.js (used by rate limiting, audit logs)
    header_up X-Real-IP {remote_host}
    header_up X-Forwarded-For {remote_host}
    header_up X-Forwarded-Proto {scheme}
  }

  # Access log (optional — comment out if disk space is limited)
  log {
    output file /var/log/caddy/${appName}-access.log {
      roll_size 100mb
      roll_keep 5
    }
    format json
  }
}

# Agent-server (port ${input.agentServerPort}) is NOT exposed publicly.
# Access it only via localhost or Tailscale. Example local binding:
#
# localhost:${input.agentServerPort} {
#   bind 127.0.0.1
#   reverse_proxy localhost:${input.agentServerPort}
# }
`;
}
