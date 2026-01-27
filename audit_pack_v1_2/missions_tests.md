# Missions Runtime Tests (V1.2)

Status: NOT RUN (blocked)
Reason: No VPS access / DATABASE_URL / SSH credentials available in this environment.

Required evidence (to be captured on VPS):
1) 401 when missing token:
   - curl -i $BASE_URL/api/mobile/missions
2) 200 when valid:
   - curl -i -H "Authorization: Bearer $TOKEN" $BASE_URL/api/mobile/missions
3) Progress increments on CHECK_IN:
   - Trigger Care Pulse CHECK_IN (EMERGENCY/NORMAL):
     POST /api/care-pulse/events
   - Verify user_missions DAILY_CHECKIN progress increments (and idempotent per day):
     SELECT * FROM user_missions WHERE user_id=<USER_ID> AND mission_key='DAILY_CHECKIN';
4) Daily idempotency proof:
   - Repeat CHECK_IN on same day; progress should not increase.

Expected:
- 401/200 as above.
- DAILY_CHECKIN increments once per day.
