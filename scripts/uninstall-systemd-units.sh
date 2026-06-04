#!/usr/bin/env bash
#
# uninstall-systemd-units.sh — entfernt lazyOS systemd-Units
# (V4 Critic-Fix 2026-05-01).
#
# Interaktiv. Disabled Timer + entfernt Unit-Files aus /etc/systemd/system.
# KEIN auto-uninstall — User muss zustimmen.
#
set -euo pipefail

UNITS=(
  "lazyos-drift-verify"
  "lazyos-audit-cleanup"
  "lazyos-daily-sweep"
  "lazyos-stale-detection"
  "lazyos-unlearning-retry"
  "lazyos-unlearning-reflection"
)

DST="/etc/systemd/system"

echo "lazyOS systemd-Units Uninstaller"
echo "================================"
echo
echo "Folgende Units werden entfernt (disable + rm):"
for u in "${UNITS[@]}"; do
  echo "  - ${u}"
done
echo
echo "Es werden sudo-Calls für 'systemctl disable --now',"
echo "'rm', 'systemctl daemon-reload' ausgeführt."
echo

read -rp "Fortfahren? [y/N] " ack
case "${ack}" in
  y|Y|yes|YES) ;;
  *)
    echo "Abgebrochen."
    exit 1
    ;;
esac

echo
for u in "${UNITS[@]}"; do
  echo "→ disable --now ${u}.timer"
  sudo systemctl disable --now "${u}.timer" 2>/dev/null || true
  echo "→ stop ${u}.service"
  sudo systemctl stop "${u}.service" 2>/dev/null || true

  for f in "${u}.service" "${u}.timer"; do
    if [[ -f "${DST}/${f}" ]]; then
      echo "→ rm ${DST}/${f}"
      sudo rm -f "${DST}/${f}"
    fi
  done
done

echo
echo "→ systemctl daemon-reload"
sudo systemctl daemon-reload

echo
echo "================================"
echo "✓ Deinstalliert."
echo "================================"
sudo systemctl list-timers --all | grep lazyos || echo "(keine lazyos-Timer mehr aktiv)"
