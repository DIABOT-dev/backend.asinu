# APS V1.1 Core (Care Pulse)

## Formula
APS(t) = sigmoid(b + wA*A + wH*H + wE*E + wS*S + wR*R)

- sigmoid(x) = 1 / (1 + e^(-x))
- Default weights (configurable in code):
  - b = -1.2
  - wA = 0.3
  - wH = 0.9
  - wE = 1.2
  - wS = 1.0
  - wR = 1.3

## Signal Definitions
- A (App-open cooldown signal):
  - A = 1 if APP_OPENED event within last 4 hours, else 0.
  - Cooldown rule: if A=1, then R=0 (risk suppressed).
- H (Self-report health):
  - NORMAL = 0.2
  - TIRED = 0.6
  - EMERGENCY = 1.0
- E (Emergency armed):
  - E = 1 if emergency_armed == true, else 0.
- S (Silence severity):
  - S = clamp(silence_minutes / escalation_delay_minutes, 0..1)
- R (Risk from baseline z-score):
  - z = (silence_minutes - mu_silence_minutes) / sigma_silence_minutes
  - R = clamp((z + 3) / 6, 0..1)

## Tier Thresholds
- Tier 0: APS < 0.25
- Tier 1: 0.25 <= APS < 0.50
- Tier 2: 0.50 <= APS < 0.75
- Tier 3: APS >= 0.75

## Escalation Gate (Episode Idempotency)
Escalation is created only when:
- tier == 3
- emergency_armed == true
- silence_count >= baseline.escalation_silence_count
- now - last_ask_at >= baseline.escalation_delay_minutes

Idempotency:
- Each EMERGENCY episode has a unique episode_id.
- Only 1 escalation record is created per episode_id.

## Event Contract (POST /api/care-pulse/events)
Required payload:
- event_type: CHECK_IN | POPUP_SHOWN | POPUP_DISMISSED | APP_OPENED
- event_id: UUID (mobile generated)
- client_ts: epoch ms
- client_tz: IANA TZ string (example: Asia/Bangkok)
- ui_session_id: string
- source: scheduler | manual | push | system
- self_report: NORMAL | TIRED | EMERGENCY (only for CHECK_IN)

Responses (events/state) include:
- aps, tier, state, reasons[]

## DB Tables Overview
- user_connections: P2P Care Circle connections with JSONB permissions
- user_baselines: per-user baseline and schedule fields
- care_pulse_events: idempotent event log (unique event_id)
- care_pulse_engine_state: backend source-of-truth for state
- care_pulse_escalations: escalation records (one per episode)

## Reasons Example
reasons[] sample:
- ["R.z=2.10", "R=0.72", "cooldown=1", "S=0.80", "E=0.30", "H=1.00", "A=1"]

## API: POST /api/mobile/chat
Auth: Bearer JWT required.

Request:
```
{
  "message": "string (1..2000)",
  "client_ts": 1737950000000,
  "context": { "lang": "vi" }
}
```

Response:
```
{
  "ok": true,
  "reply": "string",
  "chat_id": "uuid",
  "provider": "gemini|mock",
  "created_at": "ISO"
}
```

Validation:
- message is required (1..2000 chars)
- client_ts is required (number)
- context is optional object

Mock provider:
- If GEMINI_API_KEY is missing, backend returns a mock reply and provider="mock".

## API: GET /api/mobile/missions
Auth: Bearer JWT required.

Response:
```
{
  "ok": true,
  "missions": [
    {
      "mission_key": "DAILY_CHECKIN",
      "status": "active|completed",
      "progress": 0,
      "goal": 1,
      "updated_at": "ISO"
    }
  ]
}
```

Notes:
- DAILY_CHECKIN is incremented on Care Pulse CHECK_IN (daily idempotent).
- If no missions exist yet, backend returns an empty list.
