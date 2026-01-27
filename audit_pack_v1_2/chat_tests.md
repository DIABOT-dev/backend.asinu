# Chat Runtime Tests (V1.2)

Status: NOT RUN (blocked)
Reason: No VPS access / DATABASE_URL / SSH credentials available in this environment.

Required evidence (to be captured on VPS):
1) 401 when missing token:
   - curl -i $BASE_URL/api/mobile/chat
2) 400 when message empty:
   - curl -i -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{"message":"","client_ts":123,"context":{"lang":"vi"}}' \
     $BASE_URL/api/mobile/chat
3) 200 when valid:
   - curl -i -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{"message":"Xin chào","client_ts":123,"context":{"lang":"vi"}}' \
     $BASE_URL/api/mobile/chat
4) DB verification (2 rows inserted per chat):
   - SELECT * FROM chat_histories WHERE user_id=<USER_ID> ORDER BY created_at DESC LIMIT 2;

Expected:
- 401/400/200 as above.
- chat_histories inserts 1 user row + 1 assistant row.
