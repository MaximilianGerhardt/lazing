#!/usr/bin/env bash
#
# audit-systemd-units.sh — Status-Check der lazyOS systemd-Units
# (V4 Critic-Fix 2026-05-01).
#
# Read-only. KEIN sudo erforderlich für die Reads. Listet pro Unit:
#   - Source-File vorhanden in systemd-units/?
#   - Installed in /etc/systemd/system/?
#   - Timer aktiv (systemctl is-active)?
#   - Last-Run / Next-Run (aus systemctl list-timers)
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="${SCRIPT_DIR}/../systemd-units"
DST="/etc/systemd/system"

UNITS=(
  "lazyos-drift-verify"
  "lazyos-audit-cleanup"
  "lazyos-daily-sweep"
  "lazyos-stale-detection"
  "lazyos-unlearning-retry"
  "lazyos-unlearning-reflection"
)

echo "lazyOS systemd-Units Audit ($(date -u +%Y-%m-%dT%H:%M:%SZ))"
echo "================================================================"
printf "%-32s %-10s %-10s %-10s %-25s %-25s\n" \
  "UNIT" "SOURCE" "INSTALLED" "ACTIVE" "LAST" "NEXT"
echo "----------------------------------------------------------------------------------------------------------------"

# Cache list-timers Output (nicht-sudo, single shell-out)
TIMERS_OUT="$(systemctl list-timers --all --no-pager 2>/dev/null || true)"

for u in "${UNITS[@]}"; do
  SRC_OK="-"
  if [[ -f "${SRC}/${u}.service" && -f "${SRC}/${u}.timer" ]]; then
    SRC_OK="yes"
  else
    SRC_OK="MISSING"
  fi

  INSTALLED="-"
  if [[ -f "${DST}/${u}.service" && -f "${DST}/${u}.timer" ]]; then
    INSTALLED="yes"
  else
    INSTALLED="no"
  fi

  ACTIVE="-"
  if [[ "${INSTALLED}" == "yes" ]]; then
    ACTIVE="$(systemctl is-active "${u}.timer" 2>/dev/null || echo "inactive")"
  fi

  LAST="-"
  NEXT="-"
  # Format: NEXT LEFT LAST PASSED UNIT ACTIVATES
  TIMER_LINE="$(echo "${TIMERS_OUT}" | grep -E "${u}\.timer" || true)"
  if [[ -n "${TIMER_LINE}" ]]; then
    # Erste 2 Token = NEXT (Datum Zeit), nächste 2 LEFT etc.
    # Pragmatisch: Datum-Tokens parsen
    NEXT="$(echo "${TIMER_LINE}" | awk '{print $1"_"$2}' | cut -c1-24)"
    # LAST ist das 5./6. Feld bei systemd >= 245
    LAST="$(echo "${TIMER_LINE}" | awk '{print $5"_"$6}' | cut -c1-24)"
  fi

  printf "%-32s %-10s %-10s %-10s %-25s %-25s\n" \
    "${u}" "${SRC_OK}" "${INSTALLED}" "${ACTIVE}" "${LAST}" "${NEXT}"
done

echo
echo "Hinweis:"
echo "  - SOURCE=MISSING → Unit-File fehlt in ${SRC} (Repo-Bug)"
echo "  - INSTALLED=no   → 'bash scripts/install-systemd-units.sh' ausführen"
echo "  - ACTIVE!=active → 'sudo systemctl status <unit>.timer' für Details"
