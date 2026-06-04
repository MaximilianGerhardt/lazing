#!/usr/bin/env bash
#
# scripts/routines-tick.sh — launchd-Backstop für /api/routines/tick (macOS).
#
# Warum (UI/UX-Neuausrichtung 2026-06-03, Phase D2): die Routinen werden zwar
# vom In-Process-setInterval (instrumentation.ts) getickt, aber es gibt auf
# macOS keinen externen Timer als Redundanz. Das Linux-Pendant lebt unter
# server/systemd/lazyos-routines.timer (VPS). Dieses Script ist der macOS-
# launchd-Backstop: es liest LAZYOS_CRON_KEY aus .env.local und ruft den
# lokalen Tick-Endpoint mit Bearer auf. Secret bleibt in .env.local, NICHT im
# Plist dupliziert.
#
# Wird von ~/Library/LaunchAgents/com.lazyos.routines-tick.plist alle 60s
# aufgerufen. Schlägt der Call fehl (Server unten), beendet sich das Script
# still mit 0 — kein launchd-Fehler-Spam.

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# .env.local laden (LAZYOS_CRON_KEY). Best-effort.
set -a
# shellcheck disable=SC1091
[ -f "$REPO/.env.local" ] && . "$REPO/.env.local"
set +a

# Lokaler Loopback ist immer :4200 (Prod-Port), unabhängig von einer
# öffentlichen Tunnel-URL in LAZYOS_BASE_URL.
curl -fsS -m 20 -X POST \
  -H "Authorization: Bearer ${LAZYOS_CRON_KEY:-}" \
  "http://127.0.0.1:4200/api/routines/tick" >/dev/null 2>&1 || true
