#!/usr/bin/env bash
# laz.ing · Self-update
#
# Pulls the latest code, reinstalls, migrates (forward-only + idempotent),
# rebuilds into a staging dir and atomically swaps it in, then restarts.
# Designed to be safe to re-run and to never leave :4200 down on a failed build.
#
# Usage:  bash scripts/lazyos-update.sh [git-ref]
#   git-ref  optional branch/tag to update to (default: current branch's upstream)
#
# Restart is best-effort: it tries systemd (lazyos.service) then launchd, and
# otherwise prints what to restart manually.

set -euo pipefail
cd "$(dirname "$0")/.."

c() { printf "\033[%sm%s\033[0m\n" "$1" "$2"; }
info() { c "1;34" "▶ $*"; }
ok()   { c "1;32" "✓ $*"; }
warn() { c "1;33" "⚠ $*"; }
die()  { c "1;31" "✗ $*"; exit 1; }

REF="${1:-}"
DB_PATH="${LAZYOS_DB_PATH:-$HOME/.lazyos/lazyos.db}"

# -- 1. back up the database before doing anything ---------------------
if [ -f "$DB_PATH" ]; then
  BK="${DB_PATH}.bak-$(date +%Y%m%d-%H%M%S)"
  cp "$DB_PATH" "$BK" && ok "DB backed up → $BK"
else
  warn "No DB at $DB_PATH yet — skipping backup."
fi

# -- 2. pull latest ----------------------------------------------------
info "Fetching latest…"
git fetch --all --tags --prune
if [ -n "$REF" ]; then
  git checkout "$REF"
  git pull --ff-only origin "$REF" 2>/dev/null || true
else
  git pull --ff-only
fi
ok "Code updated to $(git rev-parse --short HEAD)."

# -- 3. deps + migrations (idempotent) --------------------------------
info "Installing dependencies…"
pnpm install --frozen-lockfile 2>/dev/null || pnpm install
info "Applying migrations + reseeding defaults (idempotent)…"
pnpm tsx scripts/lazyos-setup.ts
ok "Schema up to date."

# -- 4. build into staging, then guarded atomic swap ------------------
info "Building (staging dir .next.predeploy)…"
LAZYOS_DIST_DIR=.next.predeploy pnpm build
info "Swapping the new build in (guarded)…"
[ -d .next.bak ] && rm -rf .next.bak
[ -d .next ] && mv .next .next.bak
mv .next.predeploy .next
ok "Build swapped in (previous build kept in .next.bak for rollback)."

# -- 5. restart (best-effort) -----------------------------------------
restarted=0
if command -v systemctl >/dev/null 2>&1 && systemctl is-enabled lazyos.service >/dev/null 2>&1; then
  sudo systemctl restart lazyos.service && restarted=1 && ok "Restarted systemd lazyos.service."
elif command -v launchctl >/dev/null 2>&1 && launchctl list 2>/dev/null | grep -q lazyos; then
  launchctl kickstart -k "gui/$(id -u)/com.lazyos" 2>/dev/null && restarted=1 && ok "Restarted launchd com.lazyos."
fi
if [ "$restarted" = "0" ]; then
  warn "Could not auto-restart. Restart manually:"
  c "0" "  pnpm start         # web :4200"
  c "0" "  (and the agent server if you run it)"
fi

ok "Update complete. Rollback if needed:  mv .next .next.broken && mv .next.bak .next"
