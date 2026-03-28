#!/bin/bash
# Test FULL DAY check-in flow: start → triage → follow-up → evening → resolved
# Usage: bash scripts/test-full-day-flow.sh [tired|very_tired|fine]

BASE="http://localhost:3000"
STATUS="${1:-tired}"
PHONE="09$(printf '%08d' $((RANDOM * RANDOM % 100000000)))"
EMAIL="fullday_$(date +%s)@asinu.vn"

echo "================================================================"
echo "  FULL DAY FLOW TEST — Status: $STATUS"
echo "================================================================"

# 1. Register + Onboard
TOKEN=$(curl -s -X POST "$BASE/api/auth/email/register" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"Asinu@2026\",\"phone_number\":\"$PHONE\",\"full_name\":\"Nguyễn Văn Test\"}" \
  | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))" 2>/dev/null)

curl -s -X POST "$BASE/api/mobile/onboarding/complete-v2" \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d '{
    "gender":"Nam","birth_year":"1960","height_cm":168,"weight_kg":72,
    "medical_conditions":["Tiểu đường type 2","Huyết áp cao"],
    "chronic_symptoms":["Đau đầu","Mệt mỏi"],
    "daily_medication":"Metformin, Amlodipine",
    "exercise_freq":"1-2 lần/tuần","sleep_duration":"5-6 tiếng"
  }' > /dev/null

echo "✅ User: $EMAIL (66 tuổi, tiểu đường + HA, thuốc Metformin)"
echo ""

# Helper function to call triage
call_triage() {
  local cid="$1"
  local answers="$2"
  curl -s -X POST "$BASE/api/mobile/checkin/triage" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $TOKEN" \
    -d "{\"checkin_id\":\"$cid\",\"previous_answers\":$answers}"
}

# Helper to run triage loop with custom answers
run_triage_loop() {
  local cid="$1"
  shift
  local answer_list=("$@")
  local answers="[]"
  local round=0

  for answer in "${answer_list[@]}"; do
    round=$((round + 1))

    RESULT=$(call_triage "$cid" "$answers")
    IS_DONE=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('isDone', False))" 2>/dev/null)

    if [ "$IS_DONE" = "True" ] || [ "$IS_DONE" = "true" ]; then
      echo "  ✅ KẾT LUẬN (sau $((round-1)) câu):"
      echo "$RESULT" | python3 -c "
import sys,json
d = json.load(sys.stdin)
print(f'     Severity: {d.get(\"severity\",\"\")}')
print(f'     Summary: {d.get(\"summary\",\"\")[:80]}')
print(f'     FollowUp: {d.get(\"followUpHours\",\"\")}h')
print(f'     NeedsDoctor: {d.get(\"needsDoctor\",\"\")}')
print(f'     FamilyAlert: {d.get(\"needsFamilyAlert\",\"\")}')
print(f'     RedFlag: {d.get(\"hasRedFlag\",\"\")}')
print(f'     Recommendation: {d.get(\"recommendation\",\"\")[:80]}')" 2>/dev/null
      return 0
    fi

    Q=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('question',''))" 2>/dev/null)
    OPTS=$(echo "$RESULT" | python3 -c "import sys,json; print(', '.join(json.load(sys.stdin).get('options',[])))" 2>/dev/null)
    echo "  Q$round: $Q"
    echo "       Options: [$OPTS]"
    echo "       → $answer"

    answers=$(python3 -c "
import json
existing = json.loads('''$answers''')
existing.append({'question': '''$Q''', 'answer': '''$answer'''})
print(json.dumps(existing, ensure_ascii=False))" 2>/dev/null)
  done

  # One more call to get conclusion
  round=$((round + 1))
  RESULT=$(call_triage "$cid" "$answers")
  IS_DONE=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('isDone', False))" 2>/dev/null)
  if [ "$IS_DONE" = "True" ] || [ "$IS_DONE" = "true" ]; then
    echo "  ✅ KẾT LUẬN (sau $round câu):"
    echo "$RESULT" | python3 -c "
import sys,json
d = json.load(sys.stdin)
print(f'     Severity: {d.get(\"severity\",\"\")}')
print(f'     Summary: {d.get(\"summary\",\"\")[:80]}')
print(f'     FollowUp: {d.get(\"followUpHours\",\"\")}h')
print(f'     Recommendation: {d.get(\"recommendation\",\"\")[:80]}')" 2>/dev/null
  else
    Q=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('question',''))" 2>/dev/null)
    echo "  Q$round: $Q (luồng tiếp tục...)"
  fi
}

# ================================================================
# PHASE 1: SÁNG — Check-in ban đầu
# ================================================================
echo "┌─────────────────────────────────────────┐"
echo "│  PHASE 1: CHECK-IN BUỔI SÁNG (7:00)    │"
echo "│  Status: $STATUS                         "
echo "└─────────────────────────────────────────┘"

CID=$(curl -s -X POST "$BASE/api/mobile/checkin/start" \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d "{\"status\":\"$STATUS\"}" | python3 -c "import sys,json; print(json.load(sys.stdin).get('session',{}).get('id',''))" 2>/dev/null)
echo "Session ID: $CID"

if [ "$STATUS" = "fine" ]; then
  echo "  → User chọn 'Tôi ổn'"
  echo "  → Flow: monitoring, check lại lúc 21:00 tối"
  echo ""

  # ================================================================
  # PHASE 2: TỐI — Follow-up cho "Tôi ổn"
  # ================================================================
  echo "┌─────────────────────────────────────────┐"
  echo "│  PHASE 2: FOLLOW-UP TỐI (21:00)        │"
  echo "│  Hệ thống hỏi lại: Hôm nay thế nào?   │"
  echo "└─────────────────────────────────────────┘"

  # Simulate follow-up by calling triage (which runs in followup phase since triage_completed_at is null but flow is monitoring)
  # For "fine", the frontend shows evening question directly
  echo "  → Câu hỏi tối: 'Hôm nay bạn thấy thế nào?'"
  echo "  → User trả lời: 'Vẫn ổn'"

  # Call followup API
  FOLLOWUP=$(curl -s -X POST "$BASE/api/mobile/checkin/followup" \
    -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
    -d "{\"checkin_id\":\"$CID\",\"status\":\"fine\"}")
  FLOW=$(echo "$FOLLOWUP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('session',{}).get('flow_state',''))" 2>/dev/null)
  RESOLVED=$(echo "$FOLLOWUP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('session',{}).get('resolved_at','None'))" 2>/dev/null)
  echo "  Flow state: $FLOW"
  echo "  Resolved: $RESOLVED"
  echo ""
  echo "  ✅ NGÀY KẾT THÚC — User ổn cả ngày → resolved"

elif [ "$STATUS" = "tired" ]; then
  echo ""
  echo "  📋 TRIAGE — Hỏi đáp y khoa buổi sáng:"
  run_triage_loop "$CID" \
    "mệt mỏi, đau đầu" \
    "từ sáng" \
    "vẫn như cũ" \
    "ngủ ít, căng thẳng" \
    "uống nước" \
    "trung bình" \
    "thỉnh thoảng" \
    "đã uống"

  echo ""

  # ================================================================
  # PHASE 2: TRƯA — Follow-up lần 1 (sau 3-4h)
  # ================================================================
  echo "┌─────────────────────────────────────────┐"
  echo "│  PHASE 2: FOLLOW-UP TRƯA (11:00)       │"
  echo "│  3h sau lần check-in sáng               │"
  echo "└─────────────────────────────────────────┘"

  # Record follow-up status
  FOLLOWUP=$(curl -s -X POST "$BASE/api/mobile/checkin/followup" \
    -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
    -d "{\"checkin_id\":\"$CID\",\"status\":\"tired\"}")
  FLOW=$(echo "$FOLLOWUP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('session',{}).get('flow_state',''))" 2>/dev/null)
  echo "  Flow state: $FLOW"

  echo "  📋 FOLLOW-UP TRIAGE (nhanh 2-3 câu):"
  run_triage_loop "$CID" \
    "vẫn như cũ" \
    "không có gì thêm" \
    "đã nghỉ ngơi, đã ăn uống"

  echo ""

  # ================================================================
  # PHASE 3: CHIỀU — Follow-up lần 2 (sau 4h)
  # ================================================================
  echo "┌─────────────────────────────────────────┐"
  echo "│  PHASE 3: FOLLOW-UP CHIỀU (15:00)      │"
  echo "│  4h sau lần follow-up trưa              │"
  echo "└─────────────────────────────────────────┘"

  FOLLOWUP2=$(curl -s -X POST "$BASE/api/mobile/checkin/followup" \
    -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
    -d "{\"checkin_id\":\"$CID\",\"status\":\"fine\"}")
  FLOW2=$(echo "$FOLLOWUP2" | python3 -c "import sys,json; print(json.load(sys.stdin).get('session',{}).get('flow_state',''))" 2>/dev/null)
  echo "  → User: 'Đã đỡ hơn rồi'"
  echo "  Flow state: $FLOW2"

  echo "  📋 FOLLOW-UP TRIAGE (xác nhận đã đỡ):"
  run_triage_loop "$CID" \
    "đã đỡ nhiều" \
    "không có gì thêm" \
    "đã nghỉ ngơi, đã ăn uống, đã uống thuốc"

  echo ""

  # ================================================================
  # PHASE 4: TỐI — Check cuối ngày
  # ================================================================
  echo "┌─────────────────────────────────────────┐"
  echo "│  PHASE 4: CHECK CUỐI NGÀY (21:00)      │"
  echo "│  Xác nhận kết thúc theo dõi             │"
  echo "└─────────────────────────────────────────┘"

  FOLLOWUP3=$(curl -s -X POST "$BASE/api/mobile/checkin/followup" \
    -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
    -d "{\"checkin_id\":\"$CID\",\"status\":\"fine\"}")
  RESOLVED=$(echo "$FOLLOWUP3" | python3 -c "import sys,json; s=json.load(sys.stdin).get('session',{}); print(f'flow={s.get(\"flow_state\",\"\")}, resolved={s.get(\"resolved_at\",\"None\")}')" 2>/dev/null)
  echo "  → User: 'Tối rồi, tôi ổn'"
  echo "  $RESOLVED"
  echo ""
  echo "  ✅ NGÀY KẾT THÚC — User đã hồi phục"

elif [ "$STATUS" = "very_tired" ]; then
  echo ""
  echo "  📋 TRIAGE — Hỏi đáp y khoa (mức cao):"
  run_triage_loop "$CID" \
    "mệt mỏi, chóng mặt, đau đầu" \
    "không có" \
    "từ hôm qua" \
    "có vẻ nặng hơn" \
    "khá nặng" \
    "quên uống thuốc" \
    "chưa làm gì" \
    "gần đây bị nhiều hơn"

  echo ""

  # ================================================================
  # PHASE 2: 1-2h SAU — Follow-up gấp
  # ================================================================
  echo "┌─────────────────────────────────────────┐"
  echo "│  PHASE 2: FOLLOW-UP GẤP (1-2h sau)     │"
  echo "│  High alert — theo dõi sát              │"
  echo "└─────────────────────────────────────────┘"

  FOLLOWUP=$(curl -s -X POST "$BASE/api/mobile/checkin/followup" \
    -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
    -d "{\"checkin_id\":\"$CID\",\"status\":\"very_tired\"}")
  FLOW=$(echo "$FOLLOWUP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('session',{}).get('flow_state',''))" 2>/dev/null)
  echo "  → User: 'Vẫn rất mệt'"
  echo "  Flow state: $FLOW"

  echo "  📋 FOLLOW-UP TRIAGE:"
  run_triage_loop "$CID" \
    "mệt hơn trước" \
    "buồn nôn" \
    "chưa làm gì"

  echo ""

  # ================================================================
  # PHASE 3: 2h SAU — Follow-up lần 2, bắt đầu đỡ
  # ================================================================
  echo "┌─────────────────────────────────────────┐"
  echo "│  PHASE 3: FOLLOW-UP LẦN 2 (2h sau)     │"
  echo "│  User bắt đầu đỡ hơn                   │"
  echo "└─────────────────────────────────────────┘"

  FOLLOWUP2=$(curl -s -X POST "$BASE/api/mobile/checkin/followup" \
    -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
    -d "{\"checkin_id\":\"$CID\",\"status\":\"tired\"}")
  FLOW2=$(echo "$FOLLOWUP2" | python3 -c "import sys,json; print(json.load(sys.stdin).get('session',{}).get('flow_state',''))" 2>/dev/null)
  echo "  → User: 'Hơi mệt thôi, đỡ hơn rồi'"
  echo "  Flow state: $FLOW2"

  echo "  📋 FOLLOW-UP TRIAGE:"
  run_triage_loop "$CID" \
    "đã đỡ nhiều" \
    "không có gì thêm" \
    "đã nghỉ ngơi, đã uống thuốc"

  echo ""

  # ================================================================
  # PHASE 4: TỐI — Kết thúc
  # ================================================================
  echo "┌─────────────────────────────────────────┐"
  echo "│  PHASE 4: CHECK CUỐI NGÀY (21:00)      │"
  echo "└─────────────────────────────────────────┘"

  FOLLOWUP3=$(curl -s -X POST "$BASE/api/mobile/checkin/followup" \
    -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
    -d "{\"checkin_id\":\"$CID\",\"status\":\"fine\"}")
  RESOLVED=$(echo "$FOLLOWUP3" | python3 -c "import sys,json; s=json.load(sys.stdin).get('session',{}); print(f'flow={s.get(\"flow_state\",\"\")}, resolved={s.get(\"resolved_at\",\"None\")}')" 2>/dev/null)
  echo "  → User: 'Tối rồi, đã ổn'"
  echo "  $RESOLVED"
  echo ""
  echo "  ✅ NGÀY KẾT THÚC — User hồi phục từ high_alert → resolved"
fi

echo ""
echo "================================================================"
echo "  TEST HOÀN TẤT"
echo "================================================================"
