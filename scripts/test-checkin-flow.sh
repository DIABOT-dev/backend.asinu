#!/bin/bash
# Test checkin flow end-to-end
# Usage: bash scripts/test-checkin-flow.sh [status]
# status: tired (default), very_tired, specific_concern

BASE="http://localhost:3000"
STATUS="${1:-tired}"
EMAIL="test_checkin_$(date +%s)@test.com"
PASSWORD="Test123456!"

echo "=========================================="
echo "  ASINU CHECKIN FLOW TEST"
echo "  Status: $STATUS"
echo "  User: $EMAIL"
echo "=========================================="

# 1. Register
echo ""
echo ">>> Step 1: Register"
PHONE="09$(printf '%08d' $((RANDOM * RANDOM % 100000000)))"
REG=$(curl -s -X POST "$BASE/api/auth/email/register" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\",\"phone_number\":\"$PHONE\",\"full_name\":\"Test User\"}")
echo "$REG" | python3 -m json.tool 2>/dev/null || echo "$REG"

TOKEN=$(echo "$REG" | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))" 2>/dev/null)
if [ -z "$TOKEN" ]; then
  echo "❌ Register failed, trying login..."
  LOGIN=$(curl -s -X POST "$BASE/api/auth/email/login" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}")
  TOKEN=$(echo "$LOGIN" | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))" 2>/dev/null)
fi

if [ -z "$TOKEN" ]; then
  echo "❌ Cannot get token. Exiting."
  exit 1
fi
echo "✅ Token: ${TOKEN:0:30}..."

# 2. Complete onboarding (with medical conditions for richer triage)
echo ""
echo ">>> Step 2: Complete onboarding"
ONBOARD=$(curl -s -X POST "$BASE/api/mobile/onboarding/complete-v2" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "gender": "Nam",
    "birth_year": "1960",
    "height_cm": 165,
    "weight_kg": 70,
    "medical_conditions": ["Tiểu đường type 2", "Huyết áp cao"],
    "chronic_symptoms": ["Đau đầu", "Mệt mỏi"],
    "goal": "Theo dõi sức khỏe hàng ngày",
    "body_type": "Trung bình",
    "exercise_freq": "2-3 lần/tuần",
    "sleep_duration": "6-7 tiếng",
    "water_intake": "1-1.5 lít",
    "walking_habit": "Ít đi bộ"
  }')
echo "$ONBOARD" | python3 -m json.tool 2>/dev/null || echo "$ONBOARD"

# 3. Check today's checkin status
echo ""
echo ">>> Step 3: Check today's checkin status"
TODAY=$(curl -s "$BASE/api/mobile/checkin/today" \
  -H "Authorization: Bearer $TOKEN")
echo "$TODAY" | python3 -m json.tool 2>/dev/null || echo "$TODAY"

# 4. Start checkin with selected status
echo ""
echo ">>> Step 4: Start checkin — status=$STATUS"
START=$(curl -s -X POST "$BASE/api/mobile/checkin/start" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{\"status\":\"$STATUS\"}")
echo "$START" | python3 -m json.tool 2>/dev/null || echo "$START"

CHECKIN_ID=$(echo "$START" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('session',{}).get('id','') if d.get('session') else d.get('checkinId',''))" 2>/dev/null)
if [ -z "$CHECKIN_ID" ]; then
  echo "❌ No checkin ID. Exiting."
  exit 1
fi
echo "✅ Checkin ID: $CHECKIN_ID"

# 5. Triage loop — send answers and get next question
echo ""
echo "=========================================="
echo "  TRIAGE Q&A LOOP"
echo "=========================================="

ANSWERS="[]"
MAX_ROUNDS=8

for i in $(seq 1 $MAX_ROUNDS); do
  echo ""
  echo "--- Round $i ---"

  TRIAGE=$(curl -s -X POST "$BASE/api/mobile/checkin/triage" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $TOKEN" \
    -d "{\"checkin_id\":\"$CHECKIN_ID\",\"previous_answers\":$ANSWERS}")

  # Pretty print the response
  echo "$TRIAGE" | python3 -m json.tool 2>/dev/null || echo "$TRIAGE"

  # Check if done
  IS_DONE=$(echo "$TRIAGE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('isDone', False))" 2>/dev/null)

  if [ "$IS_DONE" = "True" ] || [ "$IS_DONE" = "true" ]; then
    echo ""
    echo "=========================================="
    echo "  ✅ TRIAGE COMPLETE"
    echo "=========================================="
    SUMMARY=$(echo "$TRIAGE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f\"Summary: {d.get('summary','')}\nSeverity: {d.get('severity','')}\nNeedsDoctor: {d.get('needsDoctor','')}\nNeedsFamilyAlert: {d.get('needsFamilyAlert','')}\nHasRedFlag: {d.get('hasRedFlag','')}\nFollowUpHours: {d.get('followUpHours','')}\nRecommendation: {d.get('recommendation','')}\nCloseMessage: {d.get('closeMessage','')}\")" 2>/dev/null)
    echo "$SUMMARY"
    break
  fi

  # Extract question and options
  QUESTION=$(echo "$TRIAGE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('question',''))" 2>/dev/null)
  OPTIONS=$(echo "$TRIAGE" | python3 -c "import sys,json; opts=json.load(sys.stdin).get('options',[]); [print(f'  [{i+1}] {o}') for i,o in enumerate(opts)]" 2>/dev/null)
  MULTI=$(echo "$TRIAGE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('multiSelect', False))" 2>/dev/null)
  FREE=$(echo "$TRIAGE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('allowFreeText', False))" 2>/dev/null)

  echo ""
  echo "Q: $QUESTION"
  echo "$OPTIONS"
  echo "(multiSelect=$MULTI, allowFreeText=$FREE)"

  # Auto-answer: pick first option (or first 2 for multiSelect)
  if [ "$MULTI" = "True" ] || [ "$MULTI" = "true" ]; then
    ANSWER=$(echo "$TRIAGE" | python3 -c "import sys,json; opts=json.load(sys.stdin).get('options',[]); print(', '.join(opts[:2]) if len(opts)>=2 else opts[0] if opts else 'không rõ')" 2>/dev/null)
  else
    ANSWER=$(echo "$TRIAGE" | python3 -c "import sys,json; opts=json.load(sys.stdin).get('options',[]); print(opts[0] if opts else 'không rõ')" 2>/dev/null)
  fi

  echo "→ Auto-answer: $ANSWER"

  # Build updated answers array
  ANSWERS=$(echo "$TRIAGE" | python3 -c "
import sys, json
d = json.load(sys.stdin)
q = d.get('question','')
# Read existing answers from env
import os
existing = json.loads('$ANSWERS')
existing.append({'question': q, 'answer': '''$ANSWER'''})
print(json.dumps(existing, ensure_ascii=False))
" 2>/dev/null)

  if [ -z "$ANSWERS" ] || [ "$ANSWERS" = "null" ]; then
    echo "❌ Failed to build answers. Exiting."
    exit 1
  fi
done

echo ""
echo "=========================================="
echo "  Final answers sent:"
echo "$ANSWERS" | python3 -m json.tool 2>/dev/null
echo "=========================================="
