#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
TOKEN="${TOKEN:-}"
TOKEN_NO_ACK="${TOKEN_NO_ACK:-}"
ESCALATION_ID="${ESCALATION_ID:-}"

status() {
  local method="$1" url="$2" body="$3" token="$4"
  if [[ -n "$body" ]]; then
    if [[ -n "$token" ]]; then
      curl -s -o /dev/null -w "%{http_code}" -X "$method" "$url" \
        -H "Authorization: Bearer $token" \
        -H "Content-Type: application/json" \
        -d "$body"
    else
      curl -s -o /dev/null -w "%{http_code}" -X "$method" "$url" \
        -H "Content-Type: application/json" \
        -d "$body"
    fi
  else
    if [[ -n "$token" ]]; then
      curl -s -o /dev/null -w "%{http_code}" -X "$method" "$url" \
        -H "Authorization: Bearer $token"
    else
      curl -s -o /dev/null -w "%{http_code}" -X "$method" "$url"
    fi
  fi
}

check() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    echo "PASS: $name (expected=$expected got=$actual)"
  else
    echo "FAIL: $name (expected=$expected got=$actual)"
  fi
}

echo "BASE_URL=$BASE_URL"
[[ -z "$TOKEN" ]] && echo "WARN: TOKEN is empty; export TOKEN=..."
[[ -z "$TOKEN_NO_ACK" ]] && echo "WARN: TOKEN_NO_ACK is empty; export TOKEN_NO_ACK=..."
[[ -z "$ESCALATION_ID" ]] && echo "WARN: ESCALATION_ID is empty; export ESCALATION_ID=..."

code=$(status GET "$BASE_URL/api/care-pulse/state" "" "")
check "401 missing token" 401 "$code"

code=$(status GET "$BASE_URL/api/care-pulse/state" "" "$TOKEN")
check "200 with token" 200 "$code"

body='{"event_type":"CHECK_IN","event_id":"not-a-uuid","client_ts":123,"client_tz":"Asia/Bangkok","ui_session_id":"u1","source":"manual","self_report":"NORMAL"}'
code=$(status POST "$BASE_URL/api/care-pulse/events" "$body" "$TOKEN")
check "400 invalid UUID" 400 "$code"

body='{"addressee_id":"abc"}'
code=$(status POST "$BASE_URL/api/care-circle/invitations" "$body" "$TOKEN")
check "400 invalid type" 400 "$code"

if [[ -n "$TOKEN_NO_ACK" && -n "$ESCALATION_ID" ]]; then
  body='{"escalation_id":"'"$ESCALATION_ID"'"}'
  code=$(status POST "$BASE_URL/api/care-pulse/escalations/ack" "$body" "$TOKEN_NO_ACK")
  check "403 ack missing permission" 403 "$code"
else
  echo "SKIP: 403 ack missing permission (TOKEN_NO_ACK or ESCALATION_ID not set)"
fi

if [[ -n "$TOKEN" && -n "$ESCALATION_ID" ]]; then
  body='{"escalation_id":"'"$ESCALATION_ID"'"}'
  code=$(status POST "$BASE_URL/api/care-pulse/escalations/ack" "$body" "$TOKEN")
  check "200 ack with permission" 200 "$code"
else
  echo "SKIP: 200 ack with permission (TOKEN or ESCALATION_ID not set)"
fi
