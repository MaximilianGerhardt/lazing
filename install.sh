#!/usr/bin/env bash
# laz.ing — one-line installer.
#
#   curl -fsSL https://raw.githubusercontent.com/MaximilianGerhardt/lazing/main/install.sh | bash
#
# Clones (or updates) laz.ing, then launches it: ./start does setup
# (auto-generated secrets, DB migrations, owner) and boots the app + opens your
# browser on the first-run setup ("Get started" — one click, no code).
#
# Override the install location with:  LAZYOS_DIR=~/apps/lazing  (default ~/lazing)

set -euo pipefail

REPO_URL="${LAZYOS_REPO_URL:-https://github.com/MaximilianGerhardt/lazing.git}"
DIR="${LAZYOS_DIR:-$HOME/lazing}"

c() { printf "\033[%sm%s\033[0m\n" "$1" "$2"; }
info() { c "1;34" "▶ $*"; }
ok()   { c "1;32" "✓ $*"; }
die()  { c "1;31" "✗ $*"; exit 1; }

# --- prerequisites --------------------------------------------------------
command -v git >/dev/null 2>&1 || die "git is required. Install it (macOS: 'brew install git' or Xcode CLT) and re-run."

if ! command -v node >/dev/null 2>&1; then
  c "1;33" "Node.js (≥20) is required and was not found."
  c "0" "  macOS:  brew install node      (or download the LTS from https://nodejs.org)"
  c "0" "  then re-run this one-liner."
  exit 1
fi
NODE_MAJOR="$(node -p 'parseInt(process.versions.node.split(".")[0],10)')"
[ "$NODE_MAJOR" -ge 20 ] || c "1;33" "⚠ Node $NODE_MAJOR found — laz.ing recommends Node ≥ 20."

if ! command -v pnpm >/dev/null 2>&1; then
  info "Enabling pnpm via corepack …"
  corepack enable >/dev/null 2>&1 || true
  corepack prepare pnpm@latest --activate >/dev/null 2>&1 || true
fi
command -v pnpm >/dev/null 2>&1 || die "pnpm could not be enabled. Run 'corepack enable && corepack prepare pnpm@latest --activate' and re-run."

# --- clone or update ------------------------------------------------------
if [ -d "$DIR/.git" ]; then
  info "Updating existing checkout at $DIR …"
  git -C "$DIR" pull --ff-only || c "1;33" "⚠ Could not fast-forward — keeping the local version."
else
  info "Cloning laz.ing into $DIR …"
  git clone --depth 1 "$REPO_URL" "$DIR"
fi
ok "laz.ing is at $DIR"

# --- launch ---------------------------------------------------------------
cd "$DIR"
info "Launching (./start) — this opens your browser on the first-run setup."
exec ./start
