# Security Validation Pack (ASINU Core v1.1)
## Known Preconditions
1) Valid JWT:
   - Obtain via `/api/auth/email/login` (or sign a test JWT with `JWT_SECRET` as shown below).
2) Permission seed for ack tests:
   - Two connections A/B are required.
   - Connection A: `can_receive_alerts=false`, `can_ack_escalation=false`.
   - Connection B: `can_receive_alerts=true`, `can_ack_escalation=true`.
3) Baseline defaults:
   - If no baseline exists, backend seeds `mu=10`, `sigma=5` with floor `sigma>=5` automatically.
4) Escalation ID for ack tests:
   - Trigger an escalation via Care Pulse flow (Tier 3 + gate), or query latest from DB:
     `SELECT id FROM care_pulse_escalations ORDER BY created_at DESC LIMIT 1;`
5) Common false-negative causes:
   - Wrong `BASE_URL`, missing `Bearer` prefix, server not started, or timezone mismatch (client_tz).

## Scope
- Enforced JWT auth on all protected routes (care-pulse, care-circle, mobile logs, /api/auth/me).
- Added Zod validation for care-pulse events, care-circle invites, and mobile logs payloads.
- Reject mismatched user_id in payloads.

## How to reproduce (5 min)
### A. Prereqs
- Node version: v20.18.0
- NPM version: 10.8.2
- JWT_SECRET (example):
  - Windows PowerShell: `$env:JWT_SECRET="dev_only_change_me"`
  - Linux/macOS: `export JWT_SECRET="dev_only_change_me"`
- Start server (from `F:\MPV\asinubackend`):
  - `npm start`

### B. Generate token (1 line)
```
node -e "const jwt=require('jsonwebtoken'); console.log('TOKEN='+jwt.sign({id:1,email:'audit@example.com'}, process.env.JWT_SECRET||'dev_only_change_me', {expiresIn:'1h'}))"
```
Sample output:
```
TOKEN=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

### C. 6 curl commands (copy & run)
Set variables first:
```
BASE_URL=http://localhost:3000
TOKEN=eyJ...
TOKEN_NO_ACK=eyJ...  # token without can_ack_escalation
ESCALATION_ID=00000000-0000-0000-0000-000000000000
```

1) 401 when missing token:
```
curl -i $BASE_URL/api/care-pulse/state
```

2) 200 when token is valid:
```
curl -i -H "Authorization: Bearer $TOKEN" $BASE_URL/api/care-pulse/state
```

3) 400 when payload has invalid UUID:
```
curl -i -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"event_type":"CHECK_IN","event_id":"not-a-uuid","client_ts":123,"client_tz":"Asia/Bangkok","ui_session_id":"u1","source":"manual","self_report":"NORMAL"}' \
  $BASE_URL/api/care-pulse/events
```

4) 400 when payload has wrong type:
```
curl -i -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"addressee_id":"abc"}' \
  $BASE_URL/api/care-circle/invitations
```

5) 403 when ack permission is missing:
```
curl -i -H "Authorization: Bearer $TOKEN_NO_ACK" -H "Content-Type: application/json" \
  -d "{\"escalation_id\":\"$ESCALATION_ID\"}" \
  $BASE_URL/api/care-pulse/escalations/ack
```

6) 200 when ack permission is granted:
```
curl -i -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"escalation_id\":\"$ESCALATION_ID\"}" \
  $BASE_URL/api/care-pulse/escalations/ack
```

## Evidence: Unauthorized is rejected (401)
Request:
```
curl.exe -i http://localhost:3000/api/care-pulse/state
```
Response (captured):
```
HTTP/1.1 401 Unauthorized
Content-Type: application/json; charset=utf-8

{"ok":false,"error":"Missing token"}
```

## Evidence: Invalid payload returns 400 (care-pulse event)
Request:
```
Invoke-WebRequest -Uri http://localhost:3000/api/care-pulse/events \
  -Method Post \
  -Headers @{ Authorization = "Bearer <token>" } \
  -Body '{"event_type":"CHECK_IN","event_id":"not-a-uuid","client_ts":123,"client_tz":"Asia/Bangkok","ui_session_id":"u1","source":"manual","self_report":"NORMAL"}' \
  -ContentType 'application/json'
```
Response (captured):
```
{"ok":false,"error":"Invalid payload","details":[{"validation":"uuid","code":"invalid_string","message":"Invalid uuid","path":["event_id"]}]}
```

## Evidence: Invalid payload returns 400 (care-circle invite)
Request:
```
Invoke-WebRequest -Uri http://localhost:3000/api/care-circle/invitations \
  -Method Post \
  -Headers @{ Authorization = "Bearer <token>" } \
  -Body '{"addressee_id":"abc"}' \
  -ContentType 'application/json'
```
Response (captured):
```
{"ok":false,"error":"Invalid payload","details":[{"code":"invalid_type","expected":"number","received":"string","path":["addressee_id"],"message":"Expected number, received string"}]}
```

## Notes
- All protected endpoints now require JWT Bearer token.
- Zod validation runs before DB access for these endpoints.
- user_id mismatches in payloads are rejected with 403.

