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

# Ensure .env.local exists and the REQUIRED secrets are filled. Missing secrets
# are auto-generated locally (crypto.randomBytes); the owner e-mail defaults to
# owner@localhost (override via LAZYOS_OWNER_EMAIL). Idempotent — real values are
# never overwritten. This is what makes a fresh-machine setup a single command.
info "Ensuring .env.local + required secrets …"
node scripts/ensure-env.mjs

# Re-check (defensive): the required vars must now be non-placeholder.
missing=()
for var in LAZYOS_AUTH_SECRET LAZYOS_ACCESS_CODE LAZYOS_CREDENTIAL_KEY LAZYOS_OWNER_EMAIL; do
  val="$(grep -E "^${var}=" .env.local | head -1 | cut -d= -f2- || true)"
  if [ -z "$val" ] || [ "$val" = '""' ] || [ "$val" = "''" ] || \
     case "$val" in replace-with*|you@example.com) true ;; *) false ;; esac; then
    missing+=("$var")
  fi
done
if [ ${#missing[@]} -gt 0 ]; then
  warn "These required ENV variables are still unset in .env.local:"
  for m in "${missing[@]}"; do
    color "1;31" "  - $m"
  done
  die "Auto-fill failed — set them manually and run setup.sh again."
fi

# -------- install -----------------------------------------------------

info "pnpm install …"
pnpm install --frozen-lockfile 2>/dev/null || pnpm install
ok "Dependencies installed."

# -------- setup script ------------------------------------------------

# Load .env.local into the environment so the bootstrap script (which reads
# process.env, not .env.local — there is no dotenv dependency) sees the same
# LAZYOS_DB_PATH the app will use and the LAZYOS_OWNER_EMAIL to seed the owner.
# Parsed line-by-line (NOT `source`d) so arbitrary values can't execute.
info "Loading .env.local into the environment …"
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in ''|\#*) continue ;; esac
  key="${line%%=*}"
  val="${line#*=}"
  case "$key" in ''|*[!A-Za-z0-9_]*) continue ;; esac   # skip non KEY= lines
  # strip one layer of surrounding single/double quotes
  val="${val%\"}"; val="${val#\"}"
  val="${val%\'}"; val="${val#\'}"
  export "$key=$val"
done < .env.local

info "DB migrations + default org/workspace/owner …"
pnpm tsx scripts/lazyos-setup.ts
ok "Setup script done."

# -------- final hint --------------------------------------------------

ACCESS_CODE="$(grep -E '^LAZYOS_ACCESS_CODE=' .env.local | head -1 | cut -d= -f2- | tr -d '"'"'"'"')"

color "1;36" ""
color "1;36" "laz.ing is ready. Start it with:"
color "0"    "  pnpm dev               # web on http://localhost:4200"
color "0"    "  pnpm dev:agent         # agent server (separate terminal, optional)"
color "1;36" ""
color "0"    "Then open  http://localhost:4200  → the first-run onboarding wizard"
color "0"    "starts automatically (system check · install engines · connect Claude/Codex)."
color "1;36" ""
color "0"    "Login (solo self-host, no e-mail needed): on /login pick 'Solo self-host'"
color "0"    "and paste this code (also stored in .env.local as LAZYOS_ACCESS_CODE):"
color "1;32" "    ${ACCESS_CODE}"
