#!/usr/bin/env bash
# Docker-Entrypoint für lazyOS-Image (Phase OSS.2).
# Läuft Migrations, optional lazyos-setup.ts (wenn LAZYOS_OWNER_EMAIL),
# startet web (port 4200) parallel mit agent-server (port 4201).

set -euo pipefail

cd /app

mkdir -p /data
export LAZYOS_DB_PATH="${LAZYOS_DB_PATH:-/data/lazyos.db}"

echo "[entry] LAZYOS_DB_PATH=$LAZYOS_DB_PATH"

# Setup-Skript ist idempotent; läuft Migrations + Default-Org + Owner-User.
if [ -n "${LAZYOS_OWNER_EMAIL:-}" ]; then
  echo "[entry] running lazyos-setup with owner $LAZYOS_OWNER_EMAIL"
  pnpm tsx scripts/lazyos-setup.ts || {
    echo "[entry] WARN: lazyos-setup failed (non-fatal — continuing)"
  }
else
  echo "[entry] LAZYOS_OWNER_EMAIL not set — skip setup, expect operator-bootstrap via /login"
fi

# Trap signals for graceful shutdown
shutdown() {
  echo "[entry] shutting down..."
  if [ -n "${WEB_PID:-}" ]; then kill -TERM "$WEB_PID" 2>/dev/null || true; fi
  if [ -n "${AGENT_PID:-}" ]; then kill -TERM "$AGENT_PID" 2>/dev/null || true; fi
  wait
  exit 0
}
trap shutdown SIGTERM SIGINT

# Web on 4200
echo "[entry] starting web on port 4200..."
pnpm start &
WEB_PID=$!

# Agent-server on 4201 (only if Bearer key set — otherwise tmux-spawn won't work
# without claude-code CLI installed in container, which we don't ship by default)
if [ -n "${LAZYOS_CHAT_KEY:-}" ]; then
  if command -v claude >/dev/null 2>&1; then
    echo "[entry] starting agent-server on port 4201..."
    pnpm tsx server/agent-server.ts &
    AGENT_PID=$!
  else
    echo "[entry] WARN: claude-code CLI not installed in image — agent-server skipped."
    echo "[entry]   To enable spawns, mount claude-code or install in custom image."
  fi
fi

# Wait for web to exit
wait "$WEB_PID"
EXIT=$?
echo "[entry] web process exited with code $EXIT"
exit $EXIT
