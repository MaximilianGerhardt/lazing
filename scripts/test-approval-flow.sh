#!/usr/bin/env bash
#
# Stream H — Approval-FSM End-to-End Smoke-Test.
#
# Was passiert:
#   1. Ticket anlegen via /api/tickets
#   2. request_approval via /api/tickets/{id}/workflow → state=review
#   3. approve → state=approved
#   4. execute → state=executed
#   5. close → state=closed
#   6. Prüfe dass in events-Tabelle alle 5 FSM-Events existieren
#
# Voraussetzungen:
#   - Dev-Server läuft auf http://127.0.0.1:4200 (systemd lazyos.service)
#   - LAZYOS_ACCESS_CODE gesetzt, cookie_jar via /api/auth/login
#   - better-sqlite3 DB erreichbar unter $LAZYOS_DB_PATH oder default
#
# Exit: 0 = pass, !=0 = fail
#
# Usage:
#   bash scripts/test-approval-flow.sh
#
set -euo pipefail

BASE_URL="${LAZYOS_BASE_URL:-http://127.0.0.1:4200}"
ACCESS_CODE="${LAZYOS_ACCESS_CODE:-}"
DB_PATH="${LAZYOS_DB_PATH:-$HOME/.lazyos/lazyos.db}"
COOKIE_JAR="$(mktemp /tmp/lazyos-cookie-XXXXXX)"
trap 'rm -f "$COOKIE_JAR"' EXIT

if [[ -z "$ACCESS_CODE" ]]; then
  echo "LAZYOS_ACCESS_CODE must be set to run this test."
  exit 2
fi

step() { echo -e "\n→ $*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
ok()   { echo "  ✓ $*"; }

# 1) Login
step "Login"
HTTP=$(curl -s -o /tmp/lazyos-login.json -w "%{http_code}" \
  -c "$COOKIE_JAR" \
  -H "Content-Type: application/json" \
  -d "{\"accessCode\":\"$ACCESS_CODE\"}" \
  "$BASE_URL/api/auth/login")
[[ "$HTTP" == "200" ]] || fail "login HTTP=$HTTP $(cat /tmp/lazyos-login.json)"
ok "logged in"

# 2) Ticket anlegen
step "Ticket anlegen"
RESP=$(curl -s -b "$COOKIE_JAR" \
  -H "Content-Type: application/json" \
  -d '{"workspaceId":"lazyos","title":"FSM Smoke","prio":"P2"}' \
  "$BASE_URL/api/tickets")
TICKET_ID=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['ticket']['id'])")
[[ -n "$TICKET_ID" ]] || fail "no ticket id in $RESP"
ok "ticket $TICKET_ID"

# 3) request_approval
step "request_approval (draft → review)"
RESP=$(curl -s -b "$COOKIE_JAR" \
  -H "Content-Type: application/json" \
  -d '{"transition":"request_approval"}' \
  "$BASE_URL/api/tickets/$TICKET_ID/workflow")
STATE=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('workflowState',''))")
[[ "$STATE" == "review" ]] || fail "expected review, got '$STATE' ($RESP)"
ok "state=review"

# 4) approve
step "approve (review → approved)"
RESP=$(curl -s -b "$COOKIE_JAR" \
  -H "Content-Type: application/json" \
  -d '{"transition":"approve","comment":"looks good"}' \
  "$BASE_URL/api/tickets/$TICKET_ID/workflow")
STATE=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('workflowState',''))")
[[ "$STATE" == "approved" ]] || fail "expected approved, got '$STATE' ($RESP)"
ok "state=approved"

# 5) execute
step "execute (approved → executed)"
RESP=$(curl -s -b "$COOKIE_JAR" \
  -H "Content-Type: application/json" \
  -d '{"transition":"execute"}' \
  "$BASE_URL/api/tickets/$TICKET_ID/workflow")
STATE=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('workflowState',''))")
[[ "$STATE" == "executed" ]] || fail "expected executed, got '$STATE' ($RESP)"
ok "state=executed"

# 6) close
step "close (executed → closed)"
RESP=$(curl -s -b "$COOKIE_JAR" \
  -H "Content-Type: application/json" \
  -d '{"transition":"close"}' \
  "$BASE_URL/api/tickets/$TICKET_ID/workflow")
STATE=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('workflowState',''))")
[[ "$STATE" == "closed" ]] || fail "expected closed, got '$STATE' ($RESP)"
ok "state=closed"

# 7) Invalid transition (should return 409)
step "Invalid: close → reopen (closed is terminal)"
HTTP=$(curl -s -o /tmp/lazyos-bad.json -w "%{http_code}" -b "$COOKIE_JAR" \
  -H "Content-Type: application/json" \
  -d '{"transition":"reopen"}' \
  "$BASE_URL/api/tickets/$TICKET_ID/workflow")
[[ "$HTTP" == "409" ]] || fail "expected 409, got $HTTP ($(cat /tmp/lazyos-bad.json))"
ok "got 409 invalid_transition"

# 8) DB check: 5 FSM-events in der events-Tabelle?
step "DB: check FSM-events"
if command -v sqlite3 >/dev/null 2>&1 && [[ -f "$DB_PATH" ]]; then
  COUNT=$(sqlite3 "$DB_PATH" \
    "SELECT COUNT(*) FROM events WHERE entity_id='$TICKET_ID' AND event_type IN ('approval_requested','approved','executed','closed');")
  [[ "$COUNT" == "4" ]] || fail "expected 4 FSM-events, got $COUNT"
  ok "$COUNT FSM-events found"

  # Push-audit check: approval-requested rule should have logged at least one entry
  AUDIT=$(sqlite3 "$DB_PATH" \
    "SELECT COUNT(*) FROM push_audit WHERE rule_id='approval-requested' AND created_at > $(( $(date +%s) - 60 ))000;" 2>/dev/null || echo "0")
  if [[ "$AUDIT" -gt 0 ]]; then
    ok "push_audit logged approval-requested ($AUDIT entry/ies)"
  else
    echo "  ~ no push_audit entry yet (dedup or skipped — non-fatal)"
  fi
else
  echo "  ~ sqlite3 CLI or DB not available, skipping DB check"
fi

echo -e "\n✔ ALL CHECKS PASSED"
