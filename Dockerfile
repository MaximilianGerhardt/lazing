# lazyOS · production image
# Two-stage build:
#   1. builder — installs deps, runs `next build`, freezes node_modules
#   2. runtime — minimal: Node + .next + pnpm + tsx for setup-script
#
# Image works on amd64 + arm64. Boot via `scripts/docker-entry.sh` runs
# migrations + lazyos-setup.ts before exposing the web on 4200.

# ---- builder ---------------------------------------------------------------
FROM node:20-bookworm-slim AS builder

WORKDIR /app

# pnpm via corepack (matches local dev exactly).
RUN corepack enable && corepack prepare pnpm@latest --activate

# Cache deps
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile

# Source + build
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

# ---- runtime ---------------------------------------------------------------
FROM node:20-bookworm-slim AS runtime

WORKDIR /app

# Re-enable corepack so `pnpm` and `pnpm tsx` work in entrypoint.
RUN corepack enable && corepack prepare pnpm@latest --activate

# better-sqlite3 ships native bindings — copy from builder so we don't rebuild
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/pnpm-lock.yaml* ./

# Files needed at runtime (migrations, setup script, server-side code)
COPY --from=builder /app/db ./db
COPY --from=builder /app/lib ./lib
COPY --from=builder /app/server ./server
COPY --from=builder /app/scripts ./scripts

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=4200
# SQLite-Volume — mount this from host for persistence
ENV LAZYOS_DB_PATH=/data/lazyos.db

EXPOSE 4200 4201

# tini-style entrypoint: migrations + setup + parallel start
COPY --from=builder /app/scripts/docker-entry.sh /docker-entry.sh
RUN chmod +x /docker-entry.sh

ENTRYPOINT ["/docker-entry.sh"]
