# Trả lời Review Hệ thống Check-in Asinu

> 7 câu hỏi từ team outsource, trả lời dựa trên code thực tế trong repo `DIABOT-dev/backend.asinu` (commit gần nhất ở `main`).
> Ngày: 06/05/2026

---

## Câu 1 — AI Safety Classifier (Layer 2): Tên hàm & flow

**TL;DR:** Layer 2 ĐÃ implement đúng spec. Có **2 thành phần độc lập**, đừng nhầm:

| | **`classifySymptomSeverity`** | **`filterTriageResult`** |
|---|---|---|
| File | `src/core/checkin/triage-ai-layer.js:389` | `src/services/ai/ai-safety.service.js:49` |
| Vai trò | **Layer 2 đúng spec** — 1 GPT call phán quyết severity (emergency/urgent/moderate/mild) cho symptom long-tail | Post-processing filter — kiểm tra AI output có chứa banned phrases (chẩn đoán/kê thuốc) thì sanitize |
| Chỗ gọi | `checkin.triage.v2.js:162` (sau Layer 1 emergency-detector) | `checkin.ai.service.js:1574`, `triage-chat.js:734` (cho legacy AI flow) |

**Trả lời từng câu:**

1. **`filterTriageResult` không phải Layer 2.** Nó là safety filter cho AI output (banned phrases như "diagnose", "prescribe"). Layer 2 đúng spec là `classifySymptomSeverity`.

2. **Layer 2 được gọi ở `checkin.triage.v2.js:144-185`** — sau khi `detectEmergency()` không match, code check `normalizedAnswers.length === 1 && step === 'symptoms'` (vừa khai chief complaint) → gọi `classifySymptomSeverity(symptomText, profile)`. Nếu trả về `severity === 'emergency'` → bypass triage, conclude với `severity=high + needsFamilyAlert=true` ngay. Nếu `urgent` → set `_safetyHint` để conclusion bump severity sau.

3. **Hệ thống KHÔNG còn rơi thẳng vào Layer 3 cho long-tail symptoms.** Flow hiện tại: Layer 1 (regex) → **Layer 2 (AI classify)** → Layer 3 (state machine) → Layer 4 (AI conclusion). Layer 2 có cache theo `symptom + age + conditions` → lần 2 cùng symptom = 0 GPT call. Fail-safe: AI down → default `urgent` (bắt user đi khám) tránh silent miss.

**Evidence:**
- `triage-ai-layer.js:389-471` — implementation `classifySymptomSeverity`
- `triage-ai-layer.js:479` — exported in module.exports
- `checkin.triage.v2.js:17` — imported
- `checkin.triage.v2.js:162` — gọi trong flow

---

## Câu 2 — Caregiver Alert Resend cron

**TL;DR:** ĐÃ implement, nhưng tên function thực tế là **`runAlertConfirmationFollowUps`** (không phải `runAlertConfirmFollowups` như spec viết).

**Trả lời từng câu:**

1. **`runAlertConfirmationFollowUps()` ở `src/services/checkin/checkin.service.js:1217-1226`.** Logic:
   - SELECT `caregiver_alert_confirmations WHERE confirmed_at IS NULL AND resent_count < 4 AND COALESCE(resent_at, sent_at) <= NOW() - INTERVAL '30 minutes'`
   - For each row: gọi `sendCheckinNotification` với title "🚨 Nhắc lại: Khẩn cấp"
   - `UPDATE caregiver_alert_confirmations SET resent_count = $1, resent_at = NOW()`
   - Skip nếu user đã nhận `caregiver_alert` push trong vòng 30 phút (chống chồng chéo với `alertFamily`)

2. **Cron registration:** Không có cron riêng cho hàm này. Nó được gọi trong `runBasicNotifications()` (cron **mỗi phút** ở `server.js:142`). Cụ thể: `basic.notification.service.js:640, 661` gọi `runAlertConfirmationFollowUps(pool)` trong batch hàng giờ. → Effective resend: cứ mỗi 30 phút (do guard `>= NOW() - INTERVAL '30 minutes'`).

3. **`resent_count` update đúng:** `UPDATE caregiver_alert_confirmations SET resent_count = $1, resent_at = NOW() WHERE id = $2` — increment qua biến `resendNum = alert.resent_count + 1`. Khi `resent_count >= 4` → query SELECT không match → dừng (max 4 resend ≈ 2 giờ).

4. **Khi caregiver không phản hồi:** chuỗi push 1 initial + 4 resend trong 2 giờ → sau đó stop. Không có fallback voice call/SMS hiện tại.

**Evidence:**
- `checkin.service.js:1217-1226` — function definition + module.exports
- `basic.notification.service.js:12` — import
- `basic.notification.service.js:640, 661` — invocation trong batch cron
- `server.js:142` — cron mỗi phút

---

## Câu 3 — Bệnh nền Modifier

**TL;DR:** ĐÃ implement nhưng **không phải bảng cứng** như spec viết (3 dòng table). Logic thực tế là **rule-based bump severity** trong `calculateConclusion()`.

**Trả lời từng câu:**

1. **Implement trong `triage-engine.js:calculateConclusion()` (line 473+).** Rules:
   ```js
   if (state.progression === 'worse')
     severity = (state.isElderly OR state.hasConditions) ? 'high' : 'medium';
   if (state.progression === 'same' && (state.isElderly OR state.hasConditions))
     severity = 'medium';
   if (status === 'very_tired' && severity === 'low')
     severity = 'medium';
   ```
   Rule 4 (line 336-): `isElderly && hasConditions && allSymptoms.length > 0` → MUST include red_flags step (không skip). Engine cũng có rule trong build state ở line 327-331.

2. **`medical_conditions` lấy từ `healthContext.medical_conditions` (DB)** — pass qua `getNextStep(input)` từ `services/checkin/checkin.triage.v2.js`. Source DB: bảng `user_onboarding_profiles.medical_conditions JSONB` (lưu từ onboarding wizard). KHÔNG từ session check-in.

3. **Profile rỗng → modifier bị bypass:** `state.hasConditions = conditions.length > 0`. Nếu user chưa khai → `hasConditions = false` → các rule có `OR state.hasConditions` không trigger → severity tính như user trẻ khoẻ. **Đề xuất:** nên prompt user hoàn thiện onboarding (đã có `profile_incomplete` notification cron), hoặc default `hasConditions = true` cho user > 60 tuổi (chưa làm).

**Lưu ý quan trọng cho team y khoa:**
Spec mô tả "bảng modifier" 3 dòng cứng (diabetes/heart/HTN) chưa đúng với code hiện tại. Code dùng generic `hasConditions` (any chronic disease) thay vì map theo từng bệnh cụ thể. Nếu cần granular per-disease (vd. diabetes + thirst → high) → cần thêm logic ở `condition_modifiers[]` trong `script_data` JSON (xem doc `CLINICAL-KB-IMPORT.md`).

**Evidence:**
- `triage-engine.js:279-281` — buildState extract conditions
- `triage-engine.js:327-340` — Rule 1, Rule 4 dùng isElderly + hasConditions
- `triage-engine.js:482-508` — calculateConclusion severity rules
- `triage.v2.js:120-122` — normalize healthContext.medical_conditions

---

## Câu 4 — SOS Deduplication 5 phút

**TL;DR:** ĐÃ implement bằng **DB timestamp check** (không phải Redis), window hardcode 5 phút.

**Trả lời từng câu:**

1. **`triggerEmergency()` ở `checkin.service.js:751`.** Dedup logic ở line 754-771:
   ```sql
   SELECT 1 FROM caregiver_alert_confirmations
   WHERE patient_id = $1 AND alert_type = 'emergency'
     AND confirmed_at IS NULL
     AND sent_at >= NOW() - INTERVAL '5 minutes'
   LIMIT 1
   ```
   Nếu match → return `{ ok: true, deduped: true, message: t('checkin.emergency_already_sent') }` mà không gửi push.
   
   **Loại lưu trữ:** PostgreSQL DB timestamp (table `caregiver_alert_confirmations`), không dùng Redis. Lý do: alert đã có persistent record sẵn (cần track để `runAlertConfirmationFollowUps` resend) → dùng cùng table để dedup hợp lý.

2. **Window hardcode 5 phút (`INTERVAL '5 minutes'`)** — chưa expose qua env variable. Nếu cần config → dễ refactor 1 line. Đề xuất giữ hardcode vì 5 phút là balance OK giữa "chống panic-tap" (vài giây) và "cho phép re-trigger thật" (>5 phút).

3. **Response khi dedup trigger:** trả về JSON với `{ ok: true, caregiversAlerted: 0, deduped: true, message: "Lời cầu cứu đã được gửi đi vừa xong, hệ thống đang chờ người thân phản hồi." }` (i18n key `checkin.emergency_already_sent` ở vi.json + en.json). FE có thể show toast mềm để user biết là OK rồi.

**Khi nào dedup nhả ra:**
- Caregiver bấm seen/on_my_way/called → `confirmed_at` được set → guard không match → user re-trigger được ngay
- Sau 5 phút mà chưa confirm → window hết → re-trigger được (escalation)

**Evidence:**
- `checkin.service.js:751-771` — function header + dedup guard
- `i18n/locales/vi.json:443` — `checkin.emergency_already_sent` key

---

## Câu 5 — Emergency Type thứ 11

**TL;DR:** Thực tế detector đang detect **11 emergency types có template + 1 sub-critical (CHEST_PAIN)**. KHÔNG có loại nào bị thiếu template.

**Trả lời từng câu:**

1. **`emergency-detector.js` đang detect 12 type code khác nhau** (return ở line 395-475):
   ```
   1. STROKE          (line 395)
   2. MI              (line 408)
   3. MENINGITIS      (line 413)
   4. PE              (line 418)
   5. CAUDA_EQUINA    (line 423)
   6. INTERNAL_HEMORRHAGE (line 430, 433) 
   7. ANAPHYLAXIS     (line 438)
   8. DENGUE_HEMORRHAGIC (line 443)
   9. DKA             (line 451)
   10. SEIZURE         (line 457)
   11. TRAUMA          (line 462) ← vừa thêm
   ─── sub-critical ───
   12. CHEST_PAIN_HIGH_RISK / CHEST_PAIN (line 464, 468) — severity='high'/'medium', không phải critical
   ```
   
   `EMERGENCY_TYPE_MAP` ở `triage.v2.js:24-36` map UPPERCASE → lowercase template key:
   ```
   STROKE → stroke
   MI → mi
   MENINGITIS → meningitis
   PE → pe
   CAUDA_EQUINA → cauda_equina
   INTERNAL_HEMORRHAGE → hemorrhage
   ANAPHYLAXIS → anaphylaxis
   DENGUE_HEMORRHAGIC → dengue
   DKA → dka
   SEIZURE → seizure
   TRAUMA → trauma  ← vừa add
   ```

2. **`EMERGENCY_CONCLUSIONS` ở `triage-ai-layer.js:108-178` có đúng 11 templates:**
   ```
   stroke, mi, meningitis, pe, cauda_equina, hemorrhage, dengue, dka, seizure, anaphylaxis, trauma
   ```
   
   → KHÔNG có loại nào miss template (đã sync). `CHEST_PAIN` sub-critical không có template riêng vì nó không đi qua `formatEmergencyResult()` — fall qua engine bình thường, conclusion AI generate.

3. **Kế hoạch:** Đã đầy đủ cho 11 emergency types đe doạ tính mạng. Nếu thêm loại mới (vd. ngộ độc thực phẩm cấp, sốc nhiệt) → cần update 3 chỗ:
   - `emergency-detector.js`: add keyword array + rule
   - `triage.v2.js EMERGENCY_TYPE_MAP`: add mapping
   - `triage-ai-layer.js EMERGENCY_CONCLUSIONS`: add template

**Lưu ý cho team:** Spec viết "10 types" là cũ. Trauma vừa được thêm trong session này (sau bug "gãy chân không alert" của khách).

**Evidence:**
- `emergency-detector.js:395-475` — 12 return paths
- `triage.v2.js:24-36` — type map
- `triage-ai-layer.js:108-178` — 11 templates

---

## Câu 6 — R&D Cycle 6 nhiệm vụ

**TL;DR:** File `rnd-cycle.service.js:43-167` implement **`runNightlyCycle()`** cover **5/6 nhiệm vụ trong spec**. Task 5 (seasonal pattern) chưa làm.

**Trả lời từng câu:**

1. **Coverage thực tế:**

| # | Nhiệm vụ spec | Status | Ghi chú |
|---|---|---|---|
| 1 | Phân tích feedback/skip-rate câu hỏi | ⚠️ Partial | Có track `count_7d/count_30d/trend` ở `symptom_frequency`, nhưng skip-rate per-question chưa track |
| 2 | Cluster triệu chứng lạ (fallback logs) | ✅ | `processFallbackLogs()` line 224-289 |
| 3 | GPT batch generate KB cho symptom mới | ✅ | `labelSymptom()` line 291-352 — gọi GPT label cluster, save vào `problem_clusters` table |
| 4 | Tỉ lệ bỏ câu hỏi theo step | ❌ | Chưa làm — KB schema chưa có column tracking |
| 5 | Seasonal pattern (mùa cúm, sốt xuất huyết) | ❌ | Chưa làm |
| 6 | Lưu kết quả vào `agent_checkin_memory` | ✅ | Qua `optimizeScripts` + cluster frequency update |

   Plus thêm: `processSemiActiveWithTimeout` (line 169-222), `updateAllClusterFrequencies` (line 353-434), `optimizeScripts` (line 436-484) — các tasks bổ sung không có trong spec.

2. **Task 3 — output GPT batch save vào đâu?**
   - `problem_clusters` table (column `cluster_key`, `display_name`, `description`, `keywords[]`)
   - Bác sĩ review qua DB query trực tiếp (chưa có UI admin)
   - Đề xuất: build admin UI ở `/api/admin/clusters/draft` để bác sĩ approve trước khi `is_active=true`

3. **Retry/alert khi fail:**
   - Try-catch quanh `runNightlyCycle()` → nếu fail, log vào `rnd_cycle_logs` với `error_message`
   - KHÔNG có retry tự động — phụ thuộc cron chạy lại đêm sau
   - KHÔNG có alert (Slack/email) khi fail — đề xuất add Sentry hook

4. **Format `rnd_cycle_logs`:**
   - Columns: `id, started_at, completed_at, stats JSONB, error_message TEXT, created_at`
   - `stats` JSON chứa: `usersProcessed, fallbacksProcessed, clustersCreated, clustersUpdated, scriptsRegenerated, aiCallsMade, elapsedMs`

**Evidence:**
- `rnd-cycle.service.js:43-484` — toàn bộ implementation
- `server.js:177-193` — `scheduleRndCycle` cron 2:00 AM VN

---

## Câu 7 — 12 API endpoints

**TL;DR:** TẤT CẢ 12 endpoints spec liệt kê đã mount + work. Có thêm 2 endpoint debug (reset-today, simulate-time) cho dev.

**Trả lời từng câu:**

1. **Status từng endpoint:**

| Method | Endpoint | File handler | Status |
|---|---|---|---|
| POST | `/api/mobile/checkin/start` | `checkin.controller.js startCheckinHandler` | ✅ |
| POST | `/api/mobile/checkin/followup` | `checkin.controller.js followUpHandler` | ✅ |
| POST | `/api/mobile/checkin/triage` | `checkin.controller.js triageHandler` | ✅ |
| POST | `/api/mobile/checkin/emergency` | `checkin.controller.js emergencyHandler` | ✅ (có dedup 5 phút, vừa add) |
| GET | `/api/mobile/checkin/today` | `checkin.controller.js todayCheckinHandler` | ✅ |
| GET | `/api/mobile/checkin/pending-alerts` | `checkin.controller.js pendingAlertsHandler` | ✅ |
| POST | `/api/mobile/checkin/confirm-alert` | `checkin.controller.js confirmAlertHandler` | ✅ |
| GET | `/api/mobile/checkin/report` | `checkin.controller.js healthReportHandler` | ✅ |
| GET | `/api/mobile/checkin/script` | `script-checkin.controller.js getScriptHandler` | ✅ |
| POST | `/api/mobile/checkin/script/start` | `script-checkin.controller.js startScriptHandler` | ✅ |
| POST | `/api/mobile/checkin/script/answer` | `script-checkin.controller.js answerScriptHandler` | ✅ |
| GET | `/api/mobile/checkin/script/session` | `script-checkin.controller.js getSessionHandler` | ✅ |
| POST | `/api/mobile/checkin/script/clusters` | `script-checkin.controller.js createClustersHandler` | ✅ |

(Spec đếm 12 nhưng list thực tế là 13 — `/script` GET không nằm trong bảng spec)

   Bonus dev-only endpoints (đăng ký có điều kiện ở line 96-99):
   - `POST /api/mobile/checkin/reset-today` (chỉ NODE_ENV=development)
   - `POST /api/mobile/checkin/simulate-time` (chỉ NODE_ENV=development)

2. **Test end-to-end script flow (`/script/*`):**
   - Đã có flow test thủ công qua Postman
   - **CHƯA có** automated end-to-end test (Jest integration) — đề xuất thêm trong sprint sau
   - Khi test thủ công: `script/clusters` (1 lần khi onboarding) → `script/start` (chọn cluster) → `script/answer` (loop) → conclusion → save vào `script_sessions`

3. **`/confirm-alert` — sau khi caregiver confirm:**
   - `confirmCaregiverAlert()` ở `checkin.service.js:1132+` UPDATE `confirmed_at = NOW(), confirmed_action = $action` 
   - Cron `runAlertConfirmationFollowUps` filter `WHERE confirmed_at IS NULL` → row đã confirm sẽ KHÔNG còn match → tự động dừng resend ✅
   - Bonus: `action='called'` → KHÔNG gửi push "caregiver_confirmed" cho patient (vì đã nói chuyện điện thoại trực tiếp)
   - `action='seen' / 'on_my_way'` → push tới patient với template tương ứng

4. **API documentation:**
   - **CHƯA có** Postman collection chính thức commit vào repo
   - **CHƯA có** Swagger/OpenAPI auto-generated
   - Source of truth hiện tại: `mobile.routes.js` (đọc trực tiếp routes) + `services/*` JSDoc
   - **Đề xuất:** add `swagger-jsdoc` package + sinh OpenAPI spec → host ở `/api/docs` (~2-3 giờ dev)

**Evidence:**
- `mobile.routes.js:87-107` — toàn bộ checkin routes
- `controllers/checkin.controller.js`, `controllers/script-checkin.controller.js` — handlers

---

## Tổng kết — bảng status nhanh

| # | Câu hỏi | Status | Mức độ confidence |
|---|---|---|---|
| 1 | AI Safety Classifier (Layer 2) | ✅ Implement đúng spec, có cache + fail-safe | Cao — code verify được |
| 2 | Caregiver Alert Resend cron | ✅ `runAlertConfirmationFollowUps` chạy qua basic cron 30 phút | Cao |
| 3 | Bệnh nền modifier | ⚠️ Implement nhưng generic (any condition), chưa per-disease | Cao — chưa match 100% spec |
| 4 | SOS dedup 5 phút | ✅ DB timestamp, hardcode 5 phút | Cao |
| 5 | Emergency type thứ 11 | ✅ Đã có template `trauma` (vừa add) — đủ 11 | Cao |
| 6 | R&D cycle 6 nhiệm vụ | ⚠️ Cover 4/6 task chính (1, 2, 3, 6), thiếu task 4 (skip-rate) + 5 (seasonal) | Cao |
| 7 | 12 API endpoints | ✅ Tất cả mount + work; chưa có Swagger; chưa có integration test | Cao |

## Action items đề xuất sau review

| # | Việc | Effort | Priority |
|---|---|---|---|
| 1 | Bệnh nền modifier per-disease (diabetes/heart/HTN) qua `condition_modifiers[]` JSON | 2h | Medium |
| 2 | Add task 4 (skip-rate per question) + task 5 (seasonal pattern) vào R&D cycle | 4h | Low |
| 3 | Build admin UI `/api/admin/clusters/draft` cho bác sĩ review GPT-generated KB | 1 ngày | Medium |
| 4 | Add Sentry alert khi R&D cycle fail | 1h | Medium |
| 5 | Sinh Swagger/OpenAPI spec ở `/api/docs` | 3h | Medium |
| 6 | Integration test cho script-driven flow | 1 ngày | Low |
| 7 | Expose dedup window 5 phút qua env variable | 30 phút | Low |

---

> **Tham chiếu code:** Mọi line:file số trong file này verify được tại commit gần nhất ở branch `main`. Nếu cần demo live, mở `npm run dev` rồi hit endpoint `/api/healthz`.
