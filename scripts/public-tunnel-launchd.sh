#!/usr/bin/env bash
#
# public-tunnel-launchd.sh — den öffentlichen Tunnel als macOS launchd-Agent
# dauerhaft laufen lassen (auto-start beim Login, auto-respawn).
#
# Nutzt den supervidierten Tunnel-Manager `scripts/lazyos-tunnel.mjs up`
# (Quick-Tunnel by default, oder `--named --hostname …` für eine eigene Domain).
# Für `--tailscale` ist KEIN launchd nötig — der Funnel persistiert via tailscaled.
#
#   ./scripts/public-tunnel-launchd.sh                 # Quick-Tunnel (Default)
#   ./scripts/public-tunnel-launchd.sh --named --hostname chat.deine-domain.tld
#
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.lazing.public-tunnel"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
NODE="$(command -v node || true)"
LOG="/tmp/lazyos-public-tunnel.log"
EXTRA_ARGS=("$@")

[ -n "$NODE" ] || { echo "node nicht gefunden." >&2; exit 1; }
mkdir -p "$HOME/Library/LaunchAgents"

# ProgramArguments-Array (node + Script + 'up' + optionale Args) bauen.
ARGS_XML="    <string>${NODE}</string>
    <string>${REPO}/scripts/lazyos-tunnel.mjs</string>
    <string>up</string>"
for a in "${EXTRA_ARGS[@]:-}"; do
  [ -n "$a" ] && ARGS_XML="${ARGS_XML}
    <string>${a}</string>"
done

cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${ARGS_XML}
  </array>
  <key>WorkingDirectory</key>
  <string>${REPO}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${LOG}</string>
  <key>StandardErrorPath</key>
  <string>${LOG}</string>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
PLISTEOF

echo "Plist geschrieben: $PLIST"
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "launchd-Agent geladen: $LABEL"
echo "Status: launchctl list | grep ${LABEL}   ·   Logs: tail -f $LOG   ·   Stop: launchctl unload $PLIST"
