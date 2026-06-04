#!/usr/bin/env bash
# lazyos-watchdog.sh — Health-Check + Auto-Recovery + Push-Eskalation
#
# Wird vom systemd-Timer alle 60s ausgeführt. Prüft drei Probes:
#   1. lazyos-web    /api/health (Port 4200)
#   2. lazyos-agent  /health     (Port 4201)
#   3. cloudflared-tunnel        (extern via example.com)
#
# Bei Down:
#   - Notiert Failure-Counter in /tmp/lazyos-watchdog-state
#   - Versucht systemctl restart (max 1× pro 60s-Tick)
#   - Schickt Push an Max via lazyos-cli push send
#   - Bei 3 Failures in 10min: Eskalations-Push "manueller Eingriff nötig"
#
# Stop bedingungen: keine — restartet still im Hintergrund.

set -uo pipefail

STATE_DIR="/tmp/lazyos-watchdog"
mkdir -p "$STATE_DIR"

NOW=$(date +%s)
NOW_ISO=$(date -u +%FT%TZ)

# --- Probe-Ergebnisse sammeln -------------------------------------------------
WEB_OK=0
AGENT_OK=0
TUNNEL_OK=0
FAILURES=()

if curl -sf -m 5 -o /dev/null "http://127.0.0.1:4200/api/health"; then
  WEB_OK=1
else
  FAILURES+=("web:4200")
fi

if curl -sf -m 5 -o /dev/null "http://127.0.0.1:4201/health"; then
  AGENT_OK=1
else
  FAILURES+=("agent:4201")
fi

# Tunnel-Check ist optional (Cloudflare-Outage soll nicht panicen)
if curl -sf -m 8 -o /dev/null "https://example.com/api/health"; then
  TUNNEL_OK=1
else
  FAILURES+=("tunnel:cloudflare")
fi

# --- Alles OK → counter-reset + raus ------------------------------------------
if [[ ${#FAILURES[@]} -eq 0 ]]; then
  rm -f "$STATE_DIR/failures.log"
  exit 0
fi

# --- Failure-Path -------------------------------------------------------------
FAILURE_LIST=$(IFS=,; echo "${FAILURES[*]}")
echo "$NOW $FAILURE_LIST" >> "$STATE_DIR/failures.log"

# Letzten Restart-Stamp lesen, max 1× pro 60s
LAST_RESTART_FILE="$STATE_DIR/last-restart"
LAST_RESTART=$(cat "$LAST_RESTART_FILE" 2>/dev/null || echo 0)
RESTART_DELTA=$((NOW - LAST_RESTART))

# Bei web-down: web restart
if [[ $WEB_OK -eq 0 ]] && [[ $RESTART_DELTA -gt 50 ]]; then
  systemctl restart lazyos-web 2>/dev/null
  echo "$NOW" > "$LAST_RESTART_FILE"
  RESTART_ACTION="restart-web"
fi

# Bei agent-down: agent restart
if [[ $AGENT_OK -eq 0 ]] && [[ $RESTART_DELTA -gt 50 ]]; then
  systemctl restart lazyos-agent 2>/dev/null
  echo "$NOW" > "$LAST_RESTART_FILE"
  RESTART_ACTION="${RESTART_ACTION:+$RESTART_ACTION,}restart-agent"
fi

# Counter aufräumen: nur Failures der letzten 10min behalten
TEN_MIN_AGO=$((NOW - 600))
TMP=$(mktemp)
awk -v cutoff="$TEN_MIN_AGO" '$1 >= cutoff' "$STATE_DIR/failures.log" > "$TMP" && mv "$TMP" "$STATE_DIR/failures.log"
RECENT_FAILURES=$(wc -l < "$STATE_DIR/failures.log")

# --- Push schicken via lazyos-cli ----------------------------------------------
LAZYOS_REPO_ROOT="${LAZYOS_REPO_ROOT:-$HOME/lazyos}"
PUSH_BIN="/usr/local/bin/lazyos-cli"
[[ -x "$PUSH_BIN" ]] || PUSH_BIN="$(command -v lazyos-cli || echo "$LAZYOS_REPO_ROOT/scripts/lazyos-cli.ts")"

# Dedup: gleicher Failure-Set innerhalb 5 min schickt nur 1× Push
DEDUP_FILE="$STATE_DIR/last-push-$(echo "$FAILURE_LIST" | tr ',:/' '___')"
LAST_PUSH=$(cat "$DEDUP_FILE" 2>/dev/null || echo 0)
PUSH_DELTA=$((NOW - LAST_PUSH))

# Eskalation: ab 3 Failures in 10min mit lautem Banner
if [[ $RECENT_FAILURES -ge 3 ]]; then
  TITLE="lazyOS down — manueller Eingriff"
  BODY="$RECENT_FAILURES Failures in 10min. Auto-Restart half nicht. journalctl -u lazyos-web -u lazyos-agent --since '15 min ago'"
  PUSH_INTERVAL=120
elif [[ -n "${RESTART_ACTION:-}" ]]; then
  TITLE="lazyOS Auto-Recovery"
  BODY="$FAILURE_LIST → $RESTART_ACTION ($NOW_ISO)"
  PUSH_INTERVAL=300
else
  TITLE="lazyOS Health-Warnung"
  BODY="$FAILURE_LIST nicht erreichbar (passive Beobachtung)"
  PUSH_INTERVAL=300
fi

if [[ $PUSH_DELTA -gt $PUSH_INTERVAL ]]; then
  if [[ -x "$PUSH_BIN" ]] || [[ "$PUSH_BIN" =~ \.ts$ ]]; then
    cd "$LAZYOS_REPO_ROOT" 2>/dev/null
    if [[ "$PUSH_BIN" =~ \.ts$ ]]; then
      pnpm tsx "$PUSH_BIN" push send "$TITLE" "$BODY" --url=/diagnostics 2>/dev/null || true
    else
      "$PUSH_BIN" push send "$TITLE" "$BODY" --url=/diagnostics 2>/dev/null || true
    fi
    echo "$NOW" > "$DEDUP_FILE"
  fi
fi

# Log to journal so journalctl -u lazyos-watchdog zeigt was passiert ist.
echo "[$NOW_ISO] $FAILURE_LIST recent=$RECENT_FAILURES restart=${RESTART_ACTION:-none}"

exit 0
