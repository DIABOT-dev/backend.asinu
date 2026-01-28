# Postman Smoke Tests (ASINU Core V1.1)

## Files
- API_COLLECTION.json
- API_ENV.local.json

## Setup
1) Start backend with DATABASE_URL configured.
2) Run migrations: `node scripts/migrate.js`.
3) In Postman, import collection + environment.
4) Fill `base_url`, `email`, `password` in environment.

## Smoke Test 1: Emergency silence escalation
Steps:
1) Run **Auth - Email Login**.
2) Run **Care Pulse - Event CHECK_IN (EMERGENCY)**.
3) Set `ui_session_id` in env to a new GUID.
4) Run **Care Pulse - Event POPUP_SHOWN**.
5) Run **Care Pulse - Event POPUP_DISMISSED** twice (expect silence_count to increment in state).
6) Wait >= baseline.escalation_delay_minutes (default 20 minutes) or temporarily set lower in DB for test.
7) Run **Care Pulse - Get State** and verify:
   - tier/aps updated
   - escalation record created (query DB: `care_pulse_escalations`)

Expected:
- silence_count increments after dismiss.
- tier becomes 3 when APS >= 0.75.
- escalation created only once per episode_id.

## Smoke Test 2: Permissions enforcement
1) Create two connections:
   - Connection A: can_receive_alerts = false
   - Connection B: can_receive_alerts = true, can_ack_escalation = true
2) Trigger escalation (same as Test 1).
3) Verify:
   - escalation row has sent_to_connection_id = Connection B
   - ack endpoint works only for Connection B

Notes:
- cooldown 4h: if APP_OPENED within last 4 hours, R is forced to 0.
- Idempotency: repeated event_id must not change silence_count or create duplicate escalation.
