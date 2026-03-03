#!/bin/bash
# Test script: AI Chat Logic & Personalization

BASE="http://localhost:3000"
TOKEN="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6NTYsImVtYWlsIjoiZHVjeXRjZzEyMzQ1NkBnbWFpbC5jb20iLCJpYXQiOjE3NzI0Mjg5NTYsImV4cCI6MTc3NTAyMDk1Nn0.9xHUYrmtn00t_Xk-dEpheFRwegQkCznRebg1ORGsElw"

send() {
  local label="$1"
  local msg="$2"
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "▶ $label"
  echo "   USER: $msg"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  local ts=$(date +%s)000
  local raw=$(curl -s -X POST "$BASE/api/mobile/chat" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $TOKEN" \
    -d "{\"message\":\"$msg\",\"client_ts\":$ts,\"context\":{\"lang\":\"vi\"}}")
  echo "$raw" | python3 -c "
import sys, json
d = json.load(sys.stdin)
if d.get('ok'):
    print('   AI [' + d.get('provider','?') + ']:', d['reply'][:500])
else:
    print('   ERROR:', d.get('error'))
"
  sleep 2
}

echo ""
echo "████████████████████████████████████████"
echo "  TEST: AI CHAT LOGIC & CÁ NHÂN HÓA"
echo "████████████████████████████████████████"

# ---- NHÓM 1: CÁ NHÂN HÓA ----
echo ""
echo "【NHÓM 1】CÁ NHÂN HÓA — AI có dùng thông tin profile không?"

send "T1 - Chào hỏi chung" \
  "Xin chào, tôi cần tư vấn sức khỏe"

send "T2 - Hỏi về bệnh mãn tính" \
  "Bệnh cao huyết áp của tôi cần kiêng ăn gì?"

send "T3 - Cung cấp số liệu mới, AI có dùng không?" \
  "Hôm nay huyết áp tôi đo được 145/95"

# ---- NHÓM 2: ĐIỂM DỪNG & KHÔNG LẶP CÂU HỎI ----
echo ""
echo "【NHÓM 2】ĐIỂM DỪNG — AI có lặp câu hỏi hoặc hỏi máy móc không?"

send "T4 - Trả lời ngắn, AI có ép hỏi tiếp không?" \
  "Tôi uống thuốc huyết áp rồi"

send "T5 - Câu hỏi đóng, AI có biết dừng không?" \
  "Cảm ơn tôi hiểu rồi, không cần hỏi thêm"

send "T6 - Chủ đề hoàn toàn khác, AI có linh hoạt không?" \
  "Thôi chuyển sang hỏi về giấc ngủ, tôi ngủ kém lắm"

# ---- NHÓM 3: LINH HOẠT THOÁT RULE CỨNG ----
echo ""
echo "【NHÓM 3】LINH HOẠT — AI có thoát khỏi rule cứng không?"

send "T7 - Câu hỏi cảm xúc, không phải y tế" \
  "Tôi cảm thấy mệt mỏi và lo lắng về sức khỏe"

send "T8 - Yêu cầu tóm tắt, không hỏi thêm" \
  "Tóm tắt cho tôi những điểm cần chú ý từ cuộc trò chuyện hôm nay"

echo ""
echo "████████████████████████████████████████"
echo "  TEST HOÀN THÀNH"
echo "████████████████████████████████████████"
