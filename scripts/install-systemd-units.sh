#!/usr/bin/env bash
#
# install-systemd-units.sh — installiert lazyOS systemd-Units
# (V4 Critic-Fix 2026-05-01).
#
# Interaktiv. Verlangt explizites User-OK bevor sudo-Calls passieren.
# KEIN auto-install — User muss zustimmen.
#
# Units (.service + .timer Pärchen):
#   - lazyos-drift-verify        (TOTP-Drift-Check)
#   - lazyos-audit-cleanup       (push_audit + reasoning_audit GC)
#   - lazyos-daily-sweep         (Tages-Aggregat)
#   - lazyos-stale-detection     (Workspace-Stale-Detector)
#   - lazyos-unlearning-retry    (P14 Re-Try-Sniper)
#   - lazyos-unlearning-reflection (P14 Reflexion)
#
# Verifikation nach Install:
#   systemctl list-timers | grep lazyos
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

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="${SCRIPT_DIR}/../systemd-units"
DST="/etc/systemd/system"

if [[ ! -d "${SRC}" ]]; then
  echo "FEHLER: systemd-units-Verzeichnis nicht gefunden: ${SRC}" >&2
  exit 2
fi

echo "lazyOS systemd-Units Installer"
echo "==============================="
echo
echo "Quelle: ${SRC}"
echo "Ziel:   ${DST}"
echo
echo "Folgende Units werden installiert (.service + .timer):"
for u in "${UNITS[@]}"; do
  if [[ -f "${SRC}/${u}.service" && -f "${SRC}/${u}.timer" ]]; then
    echo "  ✓ ${u}"
  else
    echo "  ✗ ${u}  (FEHLT in ${SRC} — Abbruch)"
    exit 3
  fi
done
echo
echo "Es werden sudo-Calls für 'cp', 'systemctl daemon-reload',"
echo "'systemctl enable --now' ausgeführt."
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
  echo "→ ${u}.service + ${u}.timer"
  sudo cp "${SRC}/${u}.service" "${DST}/"
  sudo cp "${SRC}/${u}.timer" "${DST}/"
done

echo
echo "→ systemctl daemon-reload"
sudo systemctl daemon-reload

echo
for u in "${UNITS[@]}"; do
  echo "→ systemctl enable --now ${u}.timer"
  sudo systemctl enable --now "${u}.timer"
done

echo
echo "==============================="
echo "✓ Installiert. Status:"
echo "==============================="
sudo systemctl list-timers --all | grep lazyos || echo "(keine lazyos-Timer gefunden — ungewöhnlich, prüfe systemctl status)"
echo
echo "Detailstatus pro Unit:"
for u in "${UNITS[@]}"; do
  echo "--- ${u}.timer ---"
  sudo systemctl status "${u}.timer" --no-pager --lines=0 || true
done
