#!/usr/bin/env bash
# lazyos-deploy-vps.sh — Build + Service-Restart + Healthcheck
#
# Verhindert den "Build neu, Service alt"-Drift den wir 2026-04-25
# gesehen haben. Triggert in dieser Reihenfolge:
#   1. tsc --noEmit       (Schnelltest, vorbeugend)
#   2. next build         (Produktions-Bundle)
#   3. systemctl restart  (Service nimmt neuen Build)
#   4. curl /api/health   (smoke-test)
#
# Usage: ./scripts/lazyos-deploy-vps.sh
#        ./scripts/lazyos-deploy-vps.sh --skip-tsc   # nur build+restart
#        ./scripts/lazyos-deploy-vps.sh --no-restart # nur build, kein restart
#
# Erfordert root-Rechte fuer systemctl, sonst bricht ab.

set -euo pipefail

SKIP_TSC=0
NO_RESTART=0
for arg in "$@"; do
  case "$arg" in
    --skip-tsc) SKIP_TSC=1 ;;
    --no-restart) NO_RESTART=1 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "→ lazyOS Deploy"
echo "  cwd: $ROOT"
echo "  date: $(date -u +%FT%TZ)"
echo

if [[ "$SKIP_TSC" -eq 0 ]]; then
  echo "→ tsc --noEmit"
  npx tsc --noEmit
  echo "  ✓ types ok"
  echo
fi

echo "→ next build"
NEXT_TELEMETRY_DISABLED=1 npx next build
echo "  ✓ build ok"
echo

if [[ "$NO_RESTART" -eq 0 ]]; then
  if [[ "$EUID" -ne 0 ]]; then
    echo "  ! systemctl restart braucht root — re-run als root oder --no-restart" >&2
    exit 3
  fi
  echo "→ systemctl restart lazyos-web.service"
  systemctl restart lazyos-web.service
  # 2026-04-27: Auch agent restarten — er laeuft als tsx-runtime und nimmt
  # server/* Aenderungen (workspace-session, streaming-snapshots etc.) erst
  # nach Restart auf. Bug: 21h alter agent ohne neue Snapshot-Schreiber.
  echo "→ systemctl restart lazyos-agent.service"
  systemctl restart lazyos-agent.service
  sleep 3

  echo "→ Healthcheck (curl localhost:4200/api/health)"
  for i in 1 2 3 4 5; do
    if curl -sf -o /dev/null -m 5 "http://localhost:4200/api/health"; then
      echo "  ✓ healthz ok"
      break
    fi
    if [[ "$i" -eq 5 ]]; then
      echo "  ✗ healthz failed nach 5 Versuchen" >&2
      exit 4
    fi
    echo "  … retry $i/5 in 2s"
    sleep 2
  done
fi

echo
echo "✓ Deploy fertig."
