#!/bin/bash
# 50-test runner for triage-chat API
URL="http://localhost:3000/api/test/triage-chat"
TIMEOUT=30

PROFILE_A='{"birth_year":1958,"gender":"Nam","full_name":"Tran Van Hung","medical_conditions":["Tieu duong","Cao huyet ap","Tim mach"]}'
PROFILE_B='{"birth_year":1981,"gender":"Nu","full_name":"Le Thi Huong","medical_conditions":["Cao huyet ap"]}'
PROFILE_C='{"birth_year":2004,"gender":"Nam","full_name":"Nguyen Minh Tuan","medical_conditions":[]}'
PROFILE_D='{"birth_year":1965,"gender":"Nu","full_name":"Nguyen Thi Mai","medical_conditions":["Tieu duong","Cao huyet ap"]}'

RESULTS_DIR="/Users/ducytcg123456/Desktop/APP/backend.asinu/test_results"
mkdir -p "$RESULTS_DIR"

# Helper: send a message and get response
# Usage: send_msg "message" "history_json" "profile_json" [simulatedHour] [previousSessionSummary]
send_msg() {
  local msg="$1"
  local history="$2"
  local profile="$3"
  local simHour="$4"
  local prevSummary="$5"

  local payload="{\"message\":$(python3 -c "import json; print(json.dumps('$msg'))" 2>/dev/null || echo "\"$msg\""),\"conversation_history\":$history,\"patient_profile\":$profile"

  if [ -n "$simHour" ]; then
    payload="$payload,\"simulatedHour\":$simHour"
  fi
  if [ -n "$prevSummary" ]; then
    payload="$payload,\"previousSessionSummary\":$(python3 -c "import json; print(json.dumps('$prevSummary'))")"
  fi
  payload="$payload}"

  curl -s --max-time $TIMEOUT "$URL" -X POST -H "Content-Type: application/json" -d "$payload" 2>/dev/null
}

# Helper: build history entry
add_to_history() {
  local history="$1"
  local role="$2"
  local content="$3"
  # Use python3 for safe JSON manipulation
  python3 -c "
import json, sys
h = json.loads('$history' if '$history' != '' else '[]')
h.append({'role': '$role', 'content': $(python3 -c "import json; print(json.dumps('$content'))")})
print(json.dumps(h))
" 2>/dev/null
}

echo "Starting 50-test run at $(date)"
echo ""
