# Canonical Mobile Logging Spec (v1)

## Endpoint
- POST `/api/mobile/logs`

## Payload (all log types)
```json
{
  "log_type": "glucose|bp|weight|water|meal|insulin|medication|care_pulse",
  "occurred_at": "2026-01-22T10:30:00+07:00",
  "source": "manual|import|device|ai",
  "note": "optional free text",
  "metadata": { "tags": ["morning"], "client": { "platform": "android", "version": "1.0.0" } },
  "data": {}
}
```

### Rules
- `occurred_at` is the actual time of measurement/entry.
- `source` defaults to `manual` if missing.
- `metadata` is optional JSON (stored as JSONB).
- `data` is required; contents depend on `log_type`.

## Defaults
- glucose: `unit = "mg/dL"`
- bp: `unit = "mmHg"`
- insulin: `unit = "U"`

## Response
```json
{ "ok": true, "log_id": "uuid", "log_type": "glucose" }
```

## Data Contracts

### glucose
```json
{
  "value": 123.4,
  "unit": "mg/dL",
  "context": "fasting|pre_meal|post_meal|before_sleep|random",
  "meal_tag": "breakfast|lunch|dinner|snack"
}
```
Required: `value`

### bp
```json
{
  "systolic": 120,
  "diastolic": 80,
  "pulse": 72,
  "unit": "mmHg"
}
```
Required: `systolic`, `diastolic`

### weight
```json
{
  "weight_kg": 67.2,
  "body_fat_percent": 18.5,
  "muscle_percent": 36.0
}
```
Required: `weight_kg`

### water
```json
{
  "volume_ml": 250
}
```
Required: `volume_ml`

### meal
```json
{
  "calories_kcal": 520,
  "macros": { "carbs_g": 55, "protein_g": 30, "fat_g": 18 },
  "meal_text": "Cơm gạo lứt + ức gà + rau luộc",
  "photo_url": "https://..."
}
```
Optional: all (recommended `meal_text` or `calories_kcal`)

### insulin
```json
{
  "insulin_type": "Novorapid",
  "dose_units": 6,
  "unit": "U",
  "timing": "pre_meal|post_meal|bedtime|correction",
  "injection_site": "bụng trái"
}
```
Required: `dose_units`

### medication
```json
{
  "med_name": "Metformin",
  "dose_text": "500mg",
  "dose_value": 500,
  "dose_unit": "mg",
  "frequency_text": "2 lần/ngày"
}
```
Required: `med_name`, `dose_text`

### care_pulse
```json
{
  "status": "NORMAL|TIRED|EMERGENCY",
  "sub_status": "Thiếu năng lượng",
  "trigger_source": "POPUP|HOME_WIDGET|EMERGENCY_BUTTON"
}
```
Required: `status`, `trigger_source`
