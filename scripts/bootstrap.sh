#!/usr/bin/env bash
# laz.ing · One-command bootstrap
#
# The fastest path from a fresh clone to a running instance: it generates the
# required secrets, writes .env.local, installs dependencies, runs migrations and
# seeds the owner. After it finishes, `pnpm dev` and open http://localhost:4200.
#
# Usage:
#   bash scripts/bootstrap.sh [owner-email]
# Optional env:
#   LAZYOS_OWNER_EMAIL   owner login e-mail (default: owner@localhost)
#   LAZYOS_ACCESS_CODE   solo-self-host login code (default: generated, printed below)
#
# Idempotent for everything except .env.local: an existing .env.local is kept
# (never overwritten) so re-runs don't rotate your secrets.

set -euo pipefail
cd "$(dirname "$0")/.."

c() { printf "\033[%sm%s\033[0m\n" "$1" "$2"; }
info() { c "1;34" "▶ $*"; }
ok()   { c "1;32" "✓ $*"; }
warn() { c "1;33" "⚠ $*"; }
die()  { c "1;31" "✗ $*"; exit 1; }

# -- pre-checks --------------------------------------------------------
command -v node >/dev/null 2>&1 || die "Node.js is missing. Install Node >= 20 (nvm/asdf recommended)."
NODE_MAJOR="$(node -p 'parseInt(process.versions.node.split(".")[0],10)')"
[ "$NODE_MAJOR" -ge 20 ] || warn "Node $NODE_MAJOR detected — laz.ing recommends Node >= 20."
if ! command -v pnpm >/dev/null 2>&1; then
  warn "pnpm is missing — enabling it via corepack…"
  corepack enable >/dev/null 2>&1 || die "Could not enable pnpm. Run: corepack enable && corepack prepare pnpm@latest --activate"
fi

gen_secret() { openssl rand -hex 32 2>/dev/null || node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))'; }

# -- .env.local --------------------------------------------------------
if [ -f .env.local ]; then
  warn ".env.local already exists — keeping it (secrets are not rotated)."
else
  [ -f .env.example ] || die ".env.example not found — cannot scaffold .env.local."
  cp .env.example .env.local
  OWNER_EMAIL="${1:-${LAZYOS_OWNER_EMAIL:-owner@localhost}}"
  ACCESS_CODE="${LAZYOS_ACCESS_CODE:-$(gen_secret | cut -c1-24)}"
  AUTH_SECRET="$(gen_secret)"
  CRED_KEY="$(gen_secret)"
  # Fill the four required keys in place (portable: perl, not GNU/BSD sed).
  AUTH_SECRET="$AUTH_SECRET" CRED_KEY="$CRED_KEY" ACCESS_CODE="$ACCESS_CODE" OWNER_EMAIL="$OWNER_EMAIL" \
  perl -i -pe '
    s|^LAZYOS_AUTH_SECRET=.*|"LAZYOS_AUTH_SECRET=$ENV{AUTH_SECRET}"|e;
    s|^LAZYOS_CREDENTIAL_KEY=.*|"LAZYOS_CREDENTIAL_KEY=$ENV{CRED_KEY}"|e;
    s|^LAZYOS_ACCESS_CODE=.*|"LAZYOS_ACCESS_CODE=$ENV{ACCESS_CODE}"|e;
    s|^LAZYOS_OWNER_EMAIL=.*|"LAZYOS_OWNER_EMAIL=$ENV{OWNER_EMAIL}"|e;
  ' .env.local
  ok ".env.local created with generated secrets."
  c "1;36" ""
  c "0" "  Owner e-mail : $OWNER_EMAIL"
  c "0" "  Access code  : $ACCESS_CODE   (use the 'Solo self-host' tab on /login)"
  c "1;36" ""
fi

# -- install + migrate + seed -----------------------------------------
info "Installing dependencies…"
pnpm install --frozen-lockfile 2>/dev/null || pnpm install
ok "Dependencies installed."

info "Running migrations + seeding the default org/workspace/owner…"
pnpm tsx scripts/lazyos-setup.ts
ok "Setup complete."

c "1;36" ""
c "1;32" "laz.ing is ready."
c "0" "  pnpm dev                 # web app on http://localhost:4200"
c "0" "  (optional) cd server && pnpm install && pnpm start   # agent server on :4201"
c "1;36" ""
c "0" "Open http://localhost:4200 → log in with the access code → first-run onboarding starts."
