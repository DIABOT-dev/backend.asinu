#!/bin/bash
# Test escalation flows: user gets WORSE over time → eventually triggers family alert
# Tests: tired→worse→worse→alert AND very_tired→worse→alert

BASE="http://localhost:3000"

create_user() {
  local PHONE="09$(printf '%08d' $((RANDOM * RANDOM % 100000000)))"
  local EMAIL="esc_$(date +%s)_${RANDOM}@asinu.vn"
  local TOKEN=$(curl -s -X POST "$BASE/api/auth/email/register" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$EMAIL\",\"password\":\"Asinu@2026\",\"phone_number\":\"$PHONE\",\"full_name\":\"Test Escalation\"}" \
    | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))" 2>/dev/null)
  curl -s -X POST "$BASE/api/mobile/onboarding/complete-v2" \
    -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
    -d '{
      "gender":"Nam","birth_year":"1958","height_cm":168,"weight_kg":72,
      "medical_conditions":["Tiểu đường type 2","Huyết áp cao"],
      "chronic_symptoms":["Đau đầu","Mệt mỏi"],
      "daily_medication":"Metformin, Amlodipine"
    }' > /dev/null
  echo "$TOKEN"
}

call_triage() {
  local token="$1" cid="$2" answers="$3"
  curl -s -X POST "$BASE/api/mobile/checkin/triage" \
    -H "Content-Type: application/json" -H "Authorization: Bearer $token" \
    -d "{\"checkin_id\":\"$cid\",\"previous_answers\":$answers}"
}

run_triage() {
  local token="$1" cid="$2"
  shift 2
  local answer_list=("$@")
  local answers="[]"

  for answer in "${answer_list[@]}"; do
    RESULT=$(call_triage "$token" "$cid" "$answers")
    IS_DONE=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('isDone', False))" 2>/dev/null)

    if [ "$IS_DONE" = "True" ] || [ "$IS_DONE" = "true" ]; then
      echo "$RESULT" | python3 -c "
import sys,json; d=json.load(sys.stdin)
sev=d.get('severity','')
doc=d.get('needsDoctor',False)
fam=d.get('needsFamilyAlert',False)
red=d.get('hasRedFlag',False)
fu=d.get('followUpHours','')
print(f'  ✅ KẾT LUẬN: severity={sev}, doctor={doc}, familyAlert={fam}, redFlag={red}, followUp={fu}h')
print(f'     {d.get(\"summary\",\"\")[:100]}')" 2>/dev/null
      return
    fi

    Q=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('question',''))" 2>/dev/null)
    echo "  Q: $Q → $answer"

    answers=$(python3 -c "
import json
e = json.loads('''$answers''')
e.append({'question':'''$Q''','answer':'''$answer'''})
print(json.dumps(e, ensure_ascii=False))" 2>/dev/null)
  done

  # Final call
  RESULT=$(call_triage "$token" "$cid" "$answers")
  echo "$RESULT" | python3 -c "
import sys,json; d=json.load(sys.stdin)
if d.get('isDone'):
  print(f'  ✅ KẾT LUẬN: severity={d.get(\"severity\")}, doctor={d.get(\"needsDoctor\")}, familyAlert={d.get(\"needsFamilyAlert\")}, redFlag={d.get(\"hasRedFlag\")}, followUp={d.get(\"followUpHours\")}h')
else:
  print(f'  → Tiếp tục: {d.get(\"question\",\"\")[:60]}')" 2>/dev/null
}

followup() {
  local token="$1" cid="$2" status="$3"
  RESULT=$(curl -s -X POST "$BASE/api/mobile/checkin/followup" \
    -H "Content-Type: application/json" -H "Authorization: Bearer $token" \
    -d "{\"checkin_id\":\"$cid\",\"status\":\"$status\"}")
  echo "$RESULT" | python3 -c "
import sys,json; s=json.load(sys.stdin).get('session',{})
print(f'  flow={s.get(\"flow_state\",\"\")}, familyAlerted={s.get(\"family_alerted\",False)}, resolved={s.get(\"resolved_at\",\"None\")[:19] if s.get(\"resolved_at\") else \"None\"}')" 2>/dev/null
}

# ================================================================
echo "================================================================"
echo "  TEST A: HƠI MỆT → VẪN MỆT → NẶNG HƠN → RED FLAG → ALERT"
echo "================================================================"
TOKEN=$(create_user)
CID=$(curl -s -X POST "$BASE/api/mobile/checkin/start" \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d '{"status":"tired"}' | python3 -c "import sys,json; print(json.load(sys.stdin).get('session',{}).get('id',''))" 2>/dev/null)

echo ""
echo "── SÁNG 7:00: Check-in ban đầu (hơi mệt) ──"
run_triage "$TOKEN" "$CID" \
  "mệt mỏi, đau đầu" \
  "từ sáng" \
  "vẫn như cũ" \
  "ngủ ít" \
  "uống nước" \
  "trung bình"

echo ""
echo "── TRƯA 11:00: Follow-up — VẪN MỆT ──"
followup "$TOKEN" "$CID" "tired"
run_triage "$TOKEN" "$CID" \
  "vẫn như cũ" \
  "không có gì thêm" \
  "đã nghỉ ngơi"

echo ""
echo "── CHIỀU 15:00: Follow-up — NẶNG HƠN ──"
followup "$TOKEN" "$CID" "very_tired"
run_triage "$TOKEN" "$CID" \
  "mệt hơn trước" \
  "chóng mặt, hoa mắt" \
  "chưa làm gì"

echo ""
echo "── 17:00: Follow-up — CÓ RED FLAG ──"
followup "$TOKEN" "$CID" "very_tired"
run_triage "$TOKEN" "$CID" \
  "mệt hơn trước" \
  "khó thở, đau ngực" \
  "chưa làm gì"

echo ""
echo "── Check trạng thái cuối ──"
curl -s "$BASE/api/mobile/checkin/today" -H "Authorization: Bearer $TOKEN" | python3 -c "
import sys,json; s=json.load(sys.stdin).get('session',{})
print(f'  flow={s.get(\"flow_state\")}, severity={s.get(\"triage_severity\")}, familyAlerted={s.get(\"family_alerted\")}, resolved={s.get(\"resolved_at\",\"None\")[:19] if s.get(\"resolved_at\") else \"None\"}')" 2>/dev/null

# ================================================================
echo ""
echo ""
echo "================================================================"
echo "  TEST B: RẤT MỆT → VẪN RẤT MỆT → NẶNG HƠN → ALERT"
echo "================================================================"
TOKEN2=$(create_user)
CID2=$(curl -s -X POST "$BASE/api/mobile/checkin/start" \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN2" \
  -d '{"status":"very_tired"}' | python3 -c "import sys,json; print(json.load(sys.stdin).get('session',{}).get('id',''))" 2>/dev/null)

echo ""
echo "── SÁNG 7:00: Check-in ban đầu (rất mệt, KHÔNG red flag) ──"
run_triage "$TOKEN2" "$CID2" \
  "mệt mỏi, chóng mặt, đau đầu" \
  "không có" \
  "khá nặng" \
  "từ hôm qua" \
  "có vẻ nặng hơn" \
  "quên uống thuốc" \
  "chưa làm gì"

echo ""
echo "── 9:00: Follow-up 1 — VẪN RẤT MỆT ──"
followup "$TOKEN2" "$CID2" "very_tired"
run_triage "$TOKEN2" "$CID2" \
  "mệt hơn trước" \
  "buồn nôn" \
  "chưa làm gì"

echo ""
echo "── 11:00: Follow-up 2 — NẶNG HƠN + RED FLAG ──"
followup "$TOKEN2" "$CID2" "very_tired"
run_triage "$TOKEN2" "$CID2" \
  "mệt hơn trước" \
  "khó thở, tức ngực" \
  "chưa làm gì"

echo ""
echo "── Check trạng thái cuối ──"
curl -s "$BASE/api/mobile/checkin/today" -H "Authorization: Bearer $TOKEN2" | python3 -c "
import sys,json; s=json.load(sys.stdin).get('session',{})
print(f'  flow={s.get(\"flow_state\")}, severity={s.get(\"triage_severity\")}, familyAlerted={s.get(\"family_alerted\")}, resolved={s.get(\"resolved_at\",\"None\")[:19] if s.get(\"resolved_at\") else \"None\"}')" 2>/dev/null

# ================================================================
echo ""
echo ""
echo "================================================================"
echo "  TEST C: HƠI MỆT → VẪN MỆT → VẪN MỆT → VẪN MỆT (không đỡ cả ngày)"
echo "================================================================"
TOKEN3=$(create_user)
CID3=$(curl -s -X POST "$BASE/api/mobile/checkin/start" \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN3" \
  -d '{"status":"tired"}' | python3 -c "import sys,json; print(json.load(sys.stdin).get('session',{}).get('id',''))" 2>/dev/null)

echo ""
echo "── SÁNG 7:00: Check-in (hơi mệt) ──"
run_triage "$TOKEN3" "$CID3" \
  "mệt mỏi" \
  "từ sáng" \
  "vẫn như cũ" \
  "ngủ ít" \
  "chưa làm gì"

echo ""
echo "── 11:00: Follow-up 1 — VẪN MỆT ──"
followup "$TOKEN3" "$CID3" "tired"
run_triage "$TOKEN3" "$CID3" \
  "vẫn như cũ" \
  "không có gì thêm" \
  "nghỉ ngơi"

echo ""
echo "── 15:00: Follow-up 2 — VẪN MỆT ──"
followup "$TOKEN3" "$CID3" "tired"
run_triage "$TOKEN3" "$CID3" \
  "vẫn như cũ" \
  "không có gì thêm" \
  "đã ăn uống"

echo ""
echo "── 19:00: Follow-up 3 — VẪN MỆT ──"
followup "$TOKEN3" "$CID3" "tired"
run_triage "$TOKEN3" "$CID3" \
  "vẫn như cũ" \
  "không có gì thêm" \
  "đã uống thuốc"

echo ""
echo "── 21:00: Tối — VẪN MỆT (không đỡ cả ngày) ──"
followup "$TOKEN3" "$CID3" "tired"
run_triage "$TOKEN3" "$CID3" \
  "vẫn như cũ" \
  "không có gì thêm" \
  "đã nghỉ ngơi"

echo ""
echo "── Check trạng thái cuối ──"
curl -s "$BASE/api/mobile/checkin/today" -H "Authorization: Bearer $TOKEN3" | python3 -c "
import sys,json; s=json.load(sys.stdin).get('session',{})
print(f'  flow={s.get(\"flow_state\")}, severity={s.get(\"triage_severity\")}, familyAlerted={s.get(\"family_alerted\")}, missCount={s.get(\"no_response_count\")}')" 2>/dev/null

echo ""
echo "================================================================"
echo "  ALL TESTS COMPLETE"
echo "================================================================"
