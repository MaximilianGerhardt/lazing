#!/usr/bin/env bash
# lazyOS · One-Shot Setup
# Installs deps, runs migrations, seeds default org + workspace + owner-user.
# Idempotent — re-run is safe.

set -euo pipefail

cd "$(dirname "$0")/.."

REPO_ROOT="$(pwd)"

color() { printf "\033[%sm%s\033[0m\n" "$1" "$2"; }
info()  { color "1;34" "▶ $*"; }
ok()    { color "1;32" "✓ $*"; }
warn()  { color "1;33" "⚠ $*"; }
die()   { color "1;31" "✗ $*"; exit 1; }

# -------- pre-checks --------------------------------------------------

if ! command -v node >/dev/null 2>&1; then
  die "Node.js is missing. Install Node ≥ 20 (nvm/asdf recommended)."
fi

NODE_MAJOR="$(node -p 'parseInt(process.versions.node.split(".")[0], 10)')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  warn "Node $NODE_MAJOR detected — lazyOS recommends Node ≥ 20."
fi

if ! command -v pnpm >/dev/null 2>&1; then
  warn "pnpm is missing — install it with:  corepack enable && corepack prepare pnpm@latest --activate"
  die "Setup stopped. Install pnpm and try again."
fi

if [ ! -f .env.local ]; then
  if [ -f .env.example ]; then
    cp .env.example .env.local
    warn ".env.local did not exist — copied from .env.example."
    warn "OPEN .env.local and set at least: LAZYOS_AUTH_SECRET, LAZYOS_ACCESS_CODE,"
    warn "LAZYOS_CREDENTIAL_KEY, LAZYOS_OWNER_EMAIL — then run setup.sh again."
    exit 1
  else
    die ".env.local is missing and there is no .env.example to copy from."
  fi
fi

# Check required ENVs
missing=()
for var in LAZYOS_AUTH_SECRET LAZYOS_ACCESS_CODE LAZYOS_CREDENTIAL_KEY LAZYOS_OWNER_EMAIL; do
  val="$(grep -E "^${var}=" .env.local | head -1 | cut -d= -f2- || true)"
  if [ -z "$val" ] || [ "$val" = '""' ] || [ "$val" = "''" ]; then
    missing+=("$var")
  fi
done
if [ ${#missing[@]} -gt 0 ]; then
  warn "These ENV variables are missing or empty in .env.local:"
  for m in "${missing[@]}"; do
    color "1;31" "  - $m"
  done
  die "Fill them in and run setup.sh again."
fi

# -------- install -----------------------------------------------------

info "pnpm install …"
pnpm install --frozen-lockfile 2>/dev/null || pnpm install
ok "Dependencies installiert."

# -------- setup script ------------------------------------------------

info "DB-Migrations + Default-Org/Workspace/Owner …"
pnpm tsx scripts/lazyos-setup.ts
ok "Setup-Script done."

# -------- final hint --------------------------------------------------

color "1;36" ""
color "1;36" "lazyOS is ready. Start it with:"
color "0"    "  pnpm dev               # web on http://localhost:4200"
color "0"    "  pnpm dev:agent         # agent server (separate terminal)"
color "1;36" ""
color "0"    "Login: http://localhost:4200/login with your LAZYOS_OWNER_EMAIL"
color "0"    "Solo self-host without mail: open the 'Solo self-host' tab and enter LAZYOS_ACCESS_CODE."
