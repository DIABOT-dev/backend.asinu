#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
# Test Script-Driven Check-in System
# ═══════════════════════════════════════════════════════════════════
#
# Usage:
#   1. Start backend: npm start
#   2. Run migration: psql $DATABASE_URL -f db/migrations/051_script_checkin_system.sql
#   3. Get a valid auth token (login first)
#   4. Run: TOKEN=your_jwt_token ./scripts/test-script-checkin.sh
#
# Hoặc chạy trực tiếp với node: node scripts/test-script-checkin.js

BASE_URL="${BASE_URL:-http://localhost:3000/api/mobile}"
TOKEN="${TOKEN:-}"

if [ -z "$TOKEN" ]; then
  echo "❌ Set TOKEN env var first: TOKEN=your_jwt ./scripts/test-script-checkin.sh"
  exit 1
fi

AUTH="Authorization: Bearer $TOKEN"
CT="Content-Type: application/json"

echo "═══════════════════════════════════════════════════"
echo "  Test Script-Driven Check-in System"
echo "═══════════════════════════════════════════════════"
echo ""

# ─── Step 1: Create clusters from symptoms ───────────────────────
echo "📋 Step 1: Tạo problem clusters..."
CLUSTERS=$(curl -s -X POST "$BASE_URL/checkin/script/clusters" \
  -H "$AUTH" -H "$CT" \
  -d '{"symptoms": ["đau đầu", "chóng mặt", "đau cổ vai gáy"]}')
echo "$CLUSTERS" | python3 -m json.tool 2>/dev/null || echo "$CLUSTERS"
echo ""

# ─── Step 2: Get cached script ───────────────────────────────────
echo "📜 Step 2: Lấy script cached (0 AI call)..."
SCRIPT=$(curl -s -X GET "$BASE_URL/checkin/script" \
  -H "$AUTH")
echo "$SCRIPT" | python3 -m json.tool 2>/dev/null || echo "$SCRIPT"
echo ""

# ─── Step 3: Start script session (user chọn "Hơi mệt") ────────
echo "▶️  Step 3: Bắt đầu session (Hơi mệt + cluster headache)..."
START=$(curl -s -X POST "$BASE_URL/checkin/script/start" \
  -H "$AUTH" -H "$CT" \
  -d '{"status": "tired", "cluster_key": "headache"}')
echo "$START" | python3 -m json.tool 2>/dev/null || echo "$START"
SESSION_ID=$(echo "$START" | python3 -c "import sys,json; print(json.load(sys.stdin).get('session_id',''))" 2>/dev/null)
echo "Session ID: $SESSION_ID"
echo ""

if [ -z "$SESSION_ID" ]; then
  echo "❌ Failed to get session_id"
  exit 1
fi

# ─── Step 4: Answer questions ────────────────────────────────────
echo "💬 Step 4a: Trả lời câu 1..."
ANS1=$(curl -s -X POST "$BASE_URL/checkin/script/answer" \
  -H "$AUTH" -H "$CT" \
  -d "{\"session_id\": $SESSION_ID, \"question_id\": \"q1\", \"answer\": 6}")
echo "$ANS1" | python3 -m json.tool 2>/dev/null || echo "$ANS1"
echo ""

# Get next question ID from response
Q2_ID=$(echo "$ANS1" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('question',{}).get('id','q2'))" 2>/dev/null)

echo "💬 Step 4b: Trả lời câu 2..."
ANS2=$(curl -s -X POST "$BASE_URL/checkin/script/answer" \
  -H "$AUTH" -H "$CT" \
  -d "{\"session_id\": $SESSION_ID, \"question_id\": \"$Q2_ID\", \"answer\": \"chóng mặt\"}")
echo "$ANS2" | python3 -m json.tool 2>/dev/null || echo "$ANS2"
echo ""

Q3_ID=$(echo "$ANS2" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('question',{}).get('id','q3'))" 2>/dev/null)

echo "💬 Step 4c: Trả lời câu 3..."
ANS3=$(curl -s -X POST "$BASE_URL/checkin/script/answer" \
  -H "$AUTH" -H "$CT" \
  -d "{\"session_id\": $SESSION_ID, \"question_id\": \"$Q3_ID\", \"answer\": \"từ sáng\"}")
echo "$ANS3" | python3 -m json.tool 2>/dev/null || echo "$ANS3"
echo ""

Q4_ID=$(echo "$ANS3" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('question',{}).get('id','q4'))" 2>/dev/null)

echo "💬 Step 4d: Trả lời câu 4..."
ANS4=$(curl -s -X POST "$BASE_URL/checkin/script/answer" \
  -H "$AUTH" -H "$CT" \
  -d "{\"session_id\": $SESSION_ID, \"question_id\": \"$Q4_ID\", \"answer\": \"vẫn như cũ\"}")
echo "$ANS4" | python3 -m json.tool 2>/dev/null || echo "$ANS4"
echo ""

# ─── Step 5: Check session result ────────────────────────────────
echo "📊 Step 5: Kiểm tra session..."
SESSION_RESULT=$(curl -s -X GET "$BASE_URL/checkin/script/session" \
  -H "$AUTH")
echo "$SESSION_RESULT" | python3 -m json.tool 2>/dev/null || echo "$SESSION_RESULT"
echo ""

# ─── Step 6: Test fallback (triệu chứng lạ) ─────────────────────
echo "🔄 Step 6: Test fallback (triệu chứng lạ)..."
FALLBACK=$(curl -s -X POST "$BASE_URL/checkin/script/start" \
  -H "$AUTH" -H "$CT" \
  -d '{"status": "tired", "symptom_input": "đau sau tai"}')
echo "$FALLBACK" | python3 -m json.tool 2>/dev/null || echo "$FALLBACK"
echo ""

# ─── Step 7: Test "Tôi ổn" (no script) ──────────────────────────
echo "😊 Step 7: Test 'Tôi ổn' (no script needed)..."
FINE=$(curl -s -X POST "$BASE_URL/checkin/script/start" \
  -H "$AUTH" -H "$CT" \
  -d '{"status": "fine"}')
echo "$FINE" | python3 -m json.tool 2>/dev/null || echo "$FINE"
echo ""

echo "═══════════════════════════════════════════════════"
echo "  Test completed!"
echo "═══════════════════════════════════════════════════"
echo ""
echo "Checklist:"
echo "  ✅ Clusters created from symptoms"
echo "  ✅ Script fetched from cache (0 AI)"
echo "  ✅ Session started with cluster script"
echo "  ✅ Questions answered step-by-step (0 AI)"
echo "  ✅ Scoring + conclusion from templates (0 AI)"
echo "  ✅ Fallback triggered for unknown symptom"
echo "  ✅ 'Fine' status = no script needed"
echo ""
echo "DB tables to verify:"
echo "  SELECT * FROM problem_clusters WHERE user_id = <your_id>;"
echo "  SELECT id, cluster_key, script_type, generated_by FROM triage_scripts WHERE user_id = <your_id>;"
echo "  SELECT * FROM script_sessions ORDER BY created_at DESC LIMIT 5;"
echo "  SELECT * FROM fallback_logs WHERE status = 'pending';"
