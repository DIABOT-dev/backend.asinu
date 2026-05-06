# Clinical KB Import — Hướng dẫn cho team y khoa

> Trả lời các câu hỏi từ team y khoa về việc khoá format Clinical KB và quy trình import từ Excel vào hệ thống Asinu (`triage_scripts` table).

---

## Bối cảnh

Backend Asinu hiện có **2 luồng triage song song**:

| Luồng | Source tri thức | Đối tượng |
|---|---|---|
| **Script-driven** | `triage_scripts` table — `script_data` JSONB column | Per-user scripts, R&D cycle generate, hoặc nạp thủ công |
| **KB-driven (V2)** | `src/services/checkin/clinical-mapping.js` (hardcoded) | Default cho mọi user, 14 chief complaints sẵn |

Team y khoa nạp KB qua Excel → `triage_scripts` là **đúng hướng** và bền vững lâu dài.

---

## 1. `script_data` JSON — có phải format chuẩn lâu dài?

✅ **Có.** Đây là format chuẩn, đã production-ready:
- Schema định nghĩa rõ ràng trong migration `db/migrations/051_script_checkin_system.sql:38-98`
- Validate runtime bởi `src/core/checkin/script-runner.js:validateScript()`
- Đang chạy production cho luồng script-driven check-in

Format này sẽ được **giữ nguyên backward-compatible** cho các đợt cập nhật sau. Team y khoa có thể an tâm khoá format và nạp dữ liệu hàng loạt.

---

## 2. Cấu trúc Excel — 5 sheet hay 7 sheet?

**5 sheet team đề xuất phù hợp về mặt mapping**, nhưng đề xuất tăng lên **7 sheet** để cover đầy đủ tính năng hiện có của backend:

| # | Sheet | Tương ứng JSON | Bắt buộc |
|---|---|---|---|
| 1 | `scripts` | metadata: `cluster_key`, `script_type`, `version`, `greeting` | ✅ |
| 2 | `questions` | `script_data.questions[]` + `followup_questions[]` + `fallback_questions[]` (thêm column `phase`: `initial` / `followup` / `fallback`) | ✅ |
| 3 | `options` | `questions[].options[]` (FK → `question_id`) | ✅ nếu type là `single_choice` / `multi_choice` |
| 4 | `scoring_rules` | `script_data.scoring_rules[]` (FK → `script_id`) | ✅ |
| 5 | `conclusion_templates` | `script_data.conclusion_templates.{low/medium/high}` (FK → `script_id`) | ✅ |
| **6** | **`condition_modifiers`** ⭐ thêm | `script_data.condition_modifiers[]` — bệnh nền bump severity (vd. tiểu đường + đau ≥5/10 → bump high) | Khuyến nghị có |
| **7** | **`red_flags`** ⭐ thêm | `script_data.red_flags[]` — keywords để engine bypass triage và alert family ngay (xem mục 4) | Khuyến nghị có |

### Mapping chi tiết

```
Sheet "scripts" — 1 row = 1 script
├── id (PK)
├── cluster_key       'headache' | 'neck_pain' | 'general_fallback' | ...
├── script_type       'initial' | 'followup' | 'fallback'
├── version           1, 2, 3...
├── greeting          'Chào chú Hùng!'
├── condition_group   'diabetes,elderly' (CSV, optional)
├── target_user_group JSON: {"age_min":60,"required_conditions":["tiểu đường"]}
└── note              Ghi chú nội bộ (optional, không lưu vào DB)

Sheet "questions" (FK: script_id, q_id)
├── script_id
├── phase             'initial' / 'followup' / 'fallback'
├── id                'q1', 'q2', ...
├── text              'Đau đầu mức nào?'
├── type              'slider' | 'single_choice' | 'multi_choice' | 'free_text'
├── min               (chỉ cho slider) — vd. 0
├── max               (chỉ cho slider) — vd. 10
├── cluster           Optional grouping
└── skip_if           JSON conditional skip rule (optional)

Sheet "options" (FK: question_id) — chỉ cho choice type
├── question_id
├── value             'mức 7' (lưu DB)
├── label             'Đau dữ dội' (hiển thị user)
└── order             Thứ tự hiển thị

Sheet "scoring_rules" (FK: script_id, rule_id)
├── script_id
├── rule_id
├── conditions        JSON [{"field":"q1","op":"gte","value":7}]
├── combine           'and' | 'or'
├── severity          'low' | 'medium' | 'high'
├── follow_up_hours   1 | 3 | 6
├── needs_doctor      TRUE | FALSE
└── needs_family_alert TRUE | FALSE

Sheet "conclusion_templates" (FK: script_id, severity)
├── script_id
├── severity          'low' / 'medium' / 'high'
├── summary           'Bị đau đầu nhẹ.'
├── recommendation    'Nghỉ ngơi, uống đủ nước.'
└── close_message     'Cháu sẽ hỏi lại sau 6h nhé 💙'

Sheet "condition_modifiers" (FK: script_id) — optional
├── script_id
├── user_condition    'tiểu đường' | 'cao huyết áp' | 'tim mạch'
├── extra_conditions  JSON [{"field":"q1","op":"gte","value":5}]
├── action            'bump_severity' | 'add_doctor' | 'force_alert'
└── to                'high' (target severity nếu bump)

Sheet "red_flags" (FK: script_id) — optional
├── script_id
├── keyword           'mất ý thức' | 'co giật' | 'ho ra máu'
└── note              Mô tả ý nghĩa lâm sàng
```

---

## 3. Field bắt buộc tối thiểu

Theo logic validate ở `script-runner.js:validateScript()`:

| Field | Bắt buộc | Note |
|---|---|---|
| `questions[]` | ✅ | Mảng câu hỏi không rỗng |
| `questions[].id` | ✅ | Unique trong script |
| `questions[].text` | ✅ | Câu hỏi tiếng Việt có dấu |
| `questions[].type` | ✅ | `slider` / `single_choice` / `multi_choice` / `free_text` |
| `questions[].options[]` | ⚠️ Có điều kiện | Bắt buộc nếu type = `single_choice` hoặc `multi_choice` |
| `questions[].min`, `.max` | ⚠️ Có điều kiện | Bắt buộc nếu type = `slider` |
| `scoring_rules[]` | ✅ | Tối thiểu 1 rule |
| `conclusion_templates` | ✅ | Object có ít nhất 1 trong 3 key: `low` / `medium` / `high` |

### Ví dụ script tối thiểu chạy được

```json
{
  "greeting": "Chào!",
  "questions": [
    { "id": "q1", "text": "Đau đầu mức nào?", "type": "slider", "min": 0, "max": 10 }
  ],
  "scoring_rules": [
    { "conditions": [{"field":"q1","op":"gte","value":7}], "severity":"high" },
    { "conditions": [{"field":"q1","op":"gte","value":4}], "severity":"medium" },
    { "conditions": [{"field":"q1","op":"lt","value":4}],  "severity":"low" }
  ],
  "conclusion_templates": {
    "low":    { "summary":"Nhẹ", "recommendation":"Nghỉ ngơi", "close_message":"Hẹn tối nhé" },
    "medium": { "summary":"Vừa", "recommendation":"Theo dõi", "close_message":"Hẹn 3h nhé" },
    "high":   { "summary":"Nặng","recommendation":"Khám bác sĩ","close_message":"Hẹn 1h nhé" }
  }
}
```

### Field nên có (không bắt buộc nhưng recommended)
- `greeting` — câu chào
- `condition_modifiers[]` — bump severity theo bệnh nền (cho user elderly, tiểu đường, tim mạch)
- `followup_questions[]` — câu hỏi cho phase follow-up
- `fallback_questions[]` — câu hỏi cho symptom lạ

---

## 4. Bổ sung 5 field mới — phân tích từng cái

| Field | Trạng thái hiện tại | Đề xuất |
|---|---|---|
| **`needsFamilyAlert`** | ✅ Đã có trong `scoring_rules[].needs_family_alert` (boolean per rule) | **Không cần thêm root level**. Nếu muốn override toàn script → có thể thêm `script_data.always_alert_family: true` cho 1 vài script đặc biệt |
| **`redFlags`** | ❌ Chưa có ở format `script_data` (KB clinical-mapping có) | **NÊN THÊM** ở root: `red_flags: ["mất ý thức", "co giật", "ho ra máu"]`. Engine sẽ scan answer free_text → match → bypass triage + alert family ngay |
| **`followUpHours`** | ✅ Đã có trong `scoring_rules[].follow_up_hours` (per rule, theo severity) | **Không cần thêm root** |
| **`conditionGroup`** | ❌ Chưa có | **NÊN THÊM** ở root metadata: `condition_group: ["diabetes", "cardio"]` để filter scripts phù hợp với bệnh nền user. Engine pick script khớp profile |
| **`targetUserGroup`** | ❌ Chưa có | **NÊN THÊM** ở root metadata: `target_user_group: { age_min: 60, age_max: null, required_conditions: ["tiểu đường"] }`. Engine pick script khớp profile user |

### Format `script_data` mở rộng đề xuất

```json
{
  "greeting": "Chú Hùng ơi, cháu hỏi thăm chú nhé 💙",
  "questions": [...],
  "scoring_rules": [...],
  "condition_modifiers": [...],
  "conclusion_templates": {...},
  "followup_questions": [...],
  "fallback_questions": [...],

  // ── 3 field mới đề xuất ──
  "red_flags": [
    "mất ý thức",
    "co giật",
    "khó thở dữ dội",
    "đau ngực dữ dội",
    "ho ra máu"
  ],
  "condition_group": ["diabetes", "elderly"],
  "target_user_group": {
    "age_min": 60,
    "age_max": null,
    "required_conditions": ["tiểu đường"],
    "exclude_conditions": []
  }
}
```

**Tóm lại:** thêm 3 field root (`red_flags`, `condition_group`, `target_user_group`). Giữ `needs_family_alert` và `follow_up_hours` ở `scoring_rules` per-rule (đã có sẵn).

---

## 5. Quy trình import Excel → JSON → triage_scripts

✅ **Hoàn toàn được.** Chỉ cần JSON output đúng schema. Quy trình đề xuất:

### Pipeline tổng quan

```
Excel (7 sheet)
       │  Python/Node script export
       ▼
JSON file (array of scripts)
       │  POST /api/admin/scripts/bulk-import
       ▼
Backend validateScript() check
       │
       ▼
INSERT INTO triage_scripts (ON CONFLICT DO UPDATE)
```

### Endpoint cần build (~30 phút backend dev)

```
POST /api/admin/scripts/bulk-import
Authorization: Bearer <admin_token>

Body:
{
  "scripts": [
    {
      "cluster_key": "headache",
      "script_type": "initial",
      "version": 1,
      "script_data": { greeting, questions, scoring_rules, ... },
      "generated_by": "manual_import"
    },
    ...
  ]
}

Response:
{
  "imported": 14,
  "failed": [
    { "cluster_key": "...", "errors": ["missing scoring_rules"] }
  ]
}
```

**Logic backend:**
```js
for (const script of req.body.scripts) {
  const validation = validateScript(script.script_data);
  if (!validation.valid) {
    errors.push({ cluster_key: script.cluster_key, errors: validation.errors });
    continue;
  }
  await pool.query(
    `INSERT INTO triage_scripts (user_id, cluster_key, script_type, version, script_data, generated_by, is_active)
     VALUES (NULL, $1, $2, $3, $4, $5, TRUE)
     ON CONFLICT (user_id, cluster_key, script_type) WHERE is_active = TRUE
       DO UPDATE SET
         script_data = EXCLUDED.script_data,
         version = triage_scripts.version + 1,
         updated_at = NOW()`,
    [script.cluster_key, script.script_type, script.version, script.script_data, script.generated_by]
  );
}
```

### Lưu ý kỹ thuật

| Vấn đề | Giải pháp |
|---|---|
| `triage_scripts.user_id` đang là `NOT NULL` | Cần migration cho phép `NULL` để chứa template global (không thuộc user nào). Hoặc tạo "system user" `id = 0` chứa template, sau đó cron clone sang per-user khi user signup |
| `UNIQUE INDEX (user_id, cluster_key, script_type) WHERE is_active = TRUE` | OK — import lại sẽ `ON CONFLICT DO UPDATE` (tăng version, replace script_data) |
| Validate trước khi insert | Bắt buộc — chạy `validateScript()` từng script, skip nếu fail và return errors trong response |
| Backup trước bulk import | Backend nên dump bảng `triage_scripts` trước import lần đầu (rollback nếu sai) |

### Validation checklist trước khi import

1. Mọi script có `cluster_key` unique trong cùng `script_type`
2. `validateScript()` pass (questions / scoring_rules / conclusion_templates đầy đủ)
3. Mọi `scoring_rules[].conditions[].field` đều reference đến `questions[].id` tồn tại trong cùng script
4. `conclusion_templates` cover được mọi `severity` mà rules có thể trả về (low / medium / high)
5. Nếu có `condition_modifiers[]` → `user_condition` phải khớp với 1 trong các bệnh nền hệ thống nhận diện (tiểu đường, cao huyết áp, tim mạch, hen, COPD, ...)
6. `red_flags[]` (nếu có) — mỗi keyword tiếng Việt có dấu đầy đủ, lowercase

---

## Tóm tắt — Trả lời nhanh 6 câu hỏi

| # | Câu hỏi | Trả lời ngắn |
|---|---|---|
| 1 | `script_data` chuẩn lâu dài? | ✅ Có. Production-ready, backward-compatible |
| 2 | Excel 5 sheet OK? | ✅ Phù hợp, **nên tăng lên 7 sheet** (thêm `condition_modifiers`, `red_flags`) |
| 3 | Field bắt buộc tối thiểu | `questions[]` + `scoring_rules[]` + `conclusion_templates` (chi tiết bảng trên) |
| 4 | 5 field mới | **3 nên thêm vào root**: `red_flags`, `condition_group`, `target_user_group`. **2 đã có sẵn** ở `scoring_rules[]` per-rule (`needs_family_alert`, `follow_up_hours`) |
| 5 | Import Excel → JSON → DB | ✅ Được. Cần build endpoint admin `POST /api/admin/scripts/bulk-import` (~30 phút dev) |

---

## Đề xuất sequencing triển khai

1. **Khách hàng confirm** chọn 7 sheet + 3 field mới ở mục 4 → khoá format
2. **Team backend** build:
   - Endpoint `POST /api/admin/scripts/bulk-import`
   - Validation logic
   - Migration cho phép `triage_scripts.user_id NULL` (cho template global)
   - Script template Excel mẫu cho team y khoa
3. **Khách export 1 script test** (vd. "đau đầu") → import thử → review output trên app
4. **Sau khi pass** → khách nhập batch toàn bộ KB (14+ chief complaints) → 1 lần import tất cả

---

## Tham khảo

- `db/migrations/051_script_checkin_system.sql` — schema gốc của `triage_scripts`
- `src/core/checkin/script-runner.js:validateScript()` — logic validate
- `src/services/checkin/script.service.js` — CRUD scripts
- `src/services/checkin/clinical-mapping.js` — KB hardcoded hiện tại (14 chief complaints)
- `docs/CHECKIN-FLOW.md` — luồng check-in tổng quan + AI agent
