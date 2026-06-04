#!/usr/bin/env bash
#
# lazyos-services.sh — start the lazyOS web + agent servers together (Track B).
#
# Usage:
#   bash scripts/lazyos-services.sh            # start web (:4200) + agent (:4201)
#   bash scripts/lazyos-services.sh --agent    # start only the agent server
#   bash scripts/lazyos-services.sh --web      # start only the web server
#
# The onboarding "finalize" step boots the agent server in-process; this script
# is the manual equivalent for operators who skipped finalize or restarted the
# machine. Ports are configurable via LAZYOS_WEB_PORT / LAZYOS_AGENT_PORT.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

WEB_PORT="${LAZYOS_WEB_PORT:-4200}"
AGENT_PORT="${LAZYOS_AGENT_PORT:-4201}"

START_WEB=1
START_AGENT=1
case "${1:-}" in
  --agent) START_WEB=0 ;;
  --web)   START_AGENT=0 ;;
  "")      ;;
  *) echo "unknown flag: $1" >&2; exit 2 ;;
esac

# Load .env.local if present so both processes share secrets / DB path.
if [ -f .env.local ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env.local
  set +a
fi

pids=()

if [ "$START_AGENT" -eq 1 ]; then
  echo "Starting agent server on :$AGENT_PORT ..."
  ( cd server && pnpm start ) &
  pids+=("$!")
fi

if [ "$START_WEB" -eq 1 ]; then
  echo "Starting web server on :$WEB_PORT ..."
  pnpm start &
  pids+=("$!")
fi

# Forward SIGINT/SIGTERM to children and wait.
trap 'echo "Stopping..."; for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done' INT TERM
wait
