# How to Reproduce V1.2 Runtime Tests (VPS)

## Prereqs
- Access to VPS or environment where asinubackend is running.
- DATABASE_URL configured to Postgres.
- JWT token for an existing user.

## Steps
1) Apply migration:
   - `node scripts/migrate.js` (from `F:\MPV\asinubackend` on VPS)
   - or run `db/migrations/005_chat_and_missions.sql` manually.

2) Start/confirm server:
   - `npm start` (or restart service)
   - Verify `/api/healthz`

3) Run runtime tests:
   - Chat 401/400/200 (see chat_tests.md)
   - Missions 401/200 and DAILY_CHECKIN increment (see missions_tests.md)

4) Capture DB snapshot:
   - Run queries in db_snapshot_v1_2.sql

## Variables
- BASE_URL=https://<vps-domain>
- TOKEN=<jwt>
- USER_ID=<id>
