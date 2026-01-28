# Onboarding Security Evidence (v1.2 hardening)

> Token masked as `***` in all examples.

## Test 1: user_id mismatch returns 403
```bash
curl -s -X POST http://127.0.0.1:3000/api/mobile/onboarding \
  -H "Authorization: Bearer ***" \
  -H "Content-Type: application/json" \
  -d '{"user_id":2,"profile":{...}}'
```
```json
{"ok":false,"error":"user_id_mismatch"}
HTTP_STATUS:403
```

## Test 2: upsert without user_id (normalize arrays)
```bash
curl -s -X POST http://127.0.0.1:3000/api/mobile/onboarding \
  -H "Authorization: Bearer ***" \
  -H "Content-Type: application/json" \
  -d '{"profile":{"medical_conditions":["Thoái hóa khớp","thoái hóa khớp","  "],"chronic_symptoms":["Đau gối","đau gối",""],"joint_issues":[{"key":"knee","label":"Đầu gối"},{"key":"KNEE","label":"đầu gối"},{"key":"other","label":"Khác","other_text":" Đau cổ tay "}],...}}'
```
```json
{"ok":true,"profile":{"user_id":1,"medical_conditions":["Thoái hóa khớp"],"chronic_symptoms":["Đau gối"],"joint_issues":[{"key":"knee","label":"Đầu gối"},{"key":"other","label":"Khác","other_text":"Đau cổ tay"}],"updated_at":"2026-01-28T05:48:26.044Z"}}
HTTP_STATUS:200
```

## Test 3: updated_at changes on update
```text
FIRST_UPDATED_AT_EPOCH=1769579356.997161
SECOND_UPDATED_AT_EPOCH=1769579357.093381
UPDATED_AT_INCREASED=true
```

## Test 4: chat context (Dia Brain)
```bash
curl -s -X POST http://127.0.0.1:3000/api/mobile/chat \
  -H "Authorization: Bearer ***" \
  -H "Content-Type: application/json" \
  -d '{"message":"Đầu gối của tôi vẫn đau","client_ts":1738000000000}'
```
```json
{"ok":true,"reply":"... Mục tiêu của bạn là Giảm đau, triệu chứng chính là Đau gối.","provider":"diabrain"}
HTTP_STATUS:200
```

## Health check
```json
{"status":"ok","uptime":106.515327307,"timestamp":"2026-01-28T05:49:39.475Z"}
HTTP_STATUS:200
```

## docker ps
```text
asinu-backend    Up About a minute (healthy)   0.0.0.0:3000->3000/tcp
 dia-brain        Up About an hour              8000/tcp
```

## Logs (tail 30)
```text
asinu-backend:
Server running on port 3000

dia-brain:
... "path": "/v1/chat", "status_code": 200, "model": "gpt-4o-mini" ...
```
