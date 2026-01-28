# Schema Snapshot (ASINU Core v1.1)

Source: `asinubackend/src/validation/schemas.js` (Zod)

## Care Pulse Event Schema
Required:
- event_type: CHECK_IN | POPUP_SHOWN | POPUP_DISMISSED | APP_OPENED
- event_id: UUID
- client_ts: number
- client_tz: string
- ui_session_id: string
- source: scheduler | manual | push | system
- self_report: NORMAL | TIRED | EMERGENCY (required when event_type = CHECK_IN)

## Care Circle Invitation Schema
Required:
- addressee_id: integer > 0
Optional:
- relationship_type: string
- role: string
- permissions: { can_view_logs?: boolean, can_receive_alerts?: boolean, can_ack_escalation?: boolean }

## Mobile Logs Base Schema
Required:
- log_type: glucose | bp | weight | water | meal | insulin | medication | care_pulse
- occurred_at: string
- data: object
Optional:
- source: string
- note: string | null
- metadata: object

### Log Data (per type)
- glucose:
  - value: number (10..1000)
  - unit?: string
  - context?: fasting | pre_meal | post_meal | before_sleep | random
  - meal_tag?: string
- bp:
  - systolic: number (50..250)
  - diastolic: number (30..150)
  - pulse?: number (30..220)
  - unit?: string
- weight:
  - weight_kg: number (10..400)
  - body_fat_percent?: number (1..80)
  - muscle_percent?: number (1..80)
- water:
  - volume_ml: number (10..5000)
- meal:
  - calories_kcal?: number (0..5000)
  - carbs_g?: number (0..1000)
  - protein_g?: number (0..1000)
  - fat_g?: number (0..1000)
  - meal_text?: string | null
  - photo_url?: string | null
- insulin:
  - insulin_type?: string
  - dose_units: number (0.1..200)
  - unit?: string
  - timing?: pre_meal | post_meal | bedtime | correction
  - injection_site?: string
- medication:
  - med_name: string
  - dose_text: string
  - dose_value?: number (0..10000)
  - dose_unit?: string
  - frequency_text?: string
- care_pulse:
  - status: NORMAL | TIRED | EMERGENCY
  - sub_status?: string
  - trigger_source: POPUP | HOME_WIDGET | EMERGENCY_BUTTON
  - escalation_sent?: boolean
  - silence_count?: number (0..100)
