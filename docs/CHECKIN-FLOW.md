# Asinu Check-in System — Tài liệu hoàn chỉnh

> Tài liệu duy nhất về toàn bộ luồng check-in của Asinu: kiến trúc 4 lớp triage, AI safety net, KB nạp tri thức, caregiver alert flow, và 12 tình huống đặc biệt.
>
> Bản hợp nhất từ `CHECKIN-FLOW.md` (UX flow) và `CHECKIN-AI-AGENT.md` (AI internals).

---

## Mục lục

1. [Tổng quan & triết lý](#1-tổng-quan--triết-lý)
2. [Kiến trúc 4 lớp triage](#2-kiến-trúc-4-lớp-triage)
3. [Luồng 1 ngày](#3-luồng-1-ngày)
4. [API contract](#4-api-contract)
5. [Tri thức — 4 nguồn](#5-tri-thức--4-nguồn)
6. [State machine — quyết định câu hỏi](#6-state-machine--quyết-định-câu-hỏi)
7. [Cách tạo OPTIONS](#7-cách-tạo-options)
8. [Conclusion & severity calculator](#8-conclusion--severity-calculator)
9. [Caregiver alert flow](#9-caregiver-alert-flow)
10. [Combo detection](#10-combo-detection)
11. [Follow-up & re-check](#11-follow-up--re-check)
12. [12 tình huống đặc biệt](#12-12-tình-huống-đặc-biệt)
13. [R&D cycle ban đêm](#13-rd-cycle-ban-đêm)
14. [Cách nạp tri thức mới](#14-cách-nạp-tri-thức-mới)
15. [Cost & performance](#15-cost--performance)
16. [File & DB reference](#16-file--db-reference)
17. [API endpoints](#17-api-endpoints)

---

## 1. Tổng quan & triết lý

### Mục đích
Asinu = **trợ lý sức khoẻ hàng ngày** cho người cao tuổi và người có bệnh nền. Mỗi ngày hệ thống hỏi thăm tình trạng, phát hiện sớm dấu hiệu nguy hiểm, đưa lời khuyên phù hợp và **tự cảnh báo người thân khi cần**.

### Triết lý kỹ thuật

> **"Không gọi AI mỗi lần check-in cho mọi user."**

| Lý do | Hệ quả |
|---|---|
| Chi phí | 10K user × 3 check-in/ngày = 30K req/ngày — nếu mọi req gọi GPT-4 = $4K/ngày → phá sản |
| Latency | GPT 2-5s → quá chậm cho UX (đặc biệt user cao tuổi) |
| Reproducibility | AI random → khó debug/audit |
| **An toàn lâm sàng** | AI hallucination về y tế = nguy hiểm. Cần safety-net deterministic |

### Giải pháp
**4 lớp xử lý** + **AI chỉ làm việc nó giỏi nhất** (text generation natural, classification long-tail symptoms):

```
Layer 1: Emergency keywords  →  zero AI, < 1ms, 11 emergency types
Layer 2: AI Safety Classifier →  1 GPT call, cache theo symptom, 4 severity tier
Layer 3: Triage Engine        →  state machine deterministic, KB-driven, 0 AI
Layer 4: AI Conclusion        →  1 GPT call ở cuối để text natural
```

### Lợi ích

| Lợi ích | Mô tả |
|---|---|
| **An toàn** | 4 lớp safety net, severity=high → luôn alert family bất kể AI judgment |
| **Ổn định** | KB + state machine deterministic, không phụ thuộc AI uptime |
| **Chi phí thấp** | ~1-2 GPT calls/check-in × $0.0001 = $0.0002 → 10K user 3x/day = ~$6/day |
| **Cá nhân hoá** | Options ưu tiên theo bệnh nền + xưng hô đúng tuổi/giới tính |
| **Học dần** | R&D cycle ban đêm tự cải tiến KB, không cần dev intervention |

---

## 2. Kiến trúc 4 lớp triage

```
┌──────────────────────────────────────────────────────────────┐
│  LAYER 1: emergency-detector.js  (zero AI, regex)            │
│  Bắt 11 emergency types trong < 1ms:                          │
│  STROKE, MI, PE, MENINGITIS, CAUDA_EQUINA,                   │
│  HEMORRHAGE, ANAPHYLAXIS, DENGUE, DKA, SEIZURE, TRAUMA       │
│  → match → severity=critical, needsFamilyAlert=true ngay     │
└────────────┬─────────────────────────────────────────────────┘
             │ không match
             ▼
┌──────────────────────────────────────────────────────────────┐
│  LAYER 2: AI Safety Classifier  (1 GPT call, có cache)        │
│  Phân loại symptom thành 4 mức:                               │
│   - emergency → bypass, alert family ngay                     │
│   - urgent → tiếp tục triage nhưng bump severity              │
│   - moderate / mild → triage bình thường                      │
│  Cover các "long tail" emergency: khó nuốt, ho ra máu,        │
│   không tiểu được, mất thị lực, chấn thương…                  │
│  Fail-safe: AI down → default 'urgent' (không silent miss)    │
└────────────┬─────────────────────────────────────────────────┘
             │ moderate / mild → tiếp tục triage
             ▼
┌──────────────────────────────────────────────────────────────┐
│  LAYER 3: triage-engine  (deterministic state machine)        │
│  Initial: 8 step (symptoms → associated → onset →            │
│   progression → red_flags → cause → action → conclude)        │
│  Follow-up: 3 step (followup_status → followup_detail →       │
│   conclude)                                                    │
│  Skip-logic động (vd. progression='better' → bỏ red_flags)   │
│  Options từ KB clinical-mapping + hardcoded + AI fallback     │
└────────────┬─────────────────────────────────────────────────┘
             │ engine action='conclude'
             ▼
┌──────────────────────────────────────────────────────────────┐
│  LAYER 4: triage-ai-layer.generateConclusion  (1 GPT call)    │
│  Tạo summary + recommendation + closeMessage cá nhân hoá       │
│  với xưng hô đúng tuổi/giới tính. Fallback template cứng.    │
└──────────────────────────────────────────────────────────────┘
```

**Trung bình:** ~1-2 GPT call/check-in (1 safety classify + 1 conclusion). Repeat symptom: 1 call (cache hit safety).

---

## 3. Luồng 1 ngày

```
  7:00 SÁNG                              TỐI                    2:00 ĐÊM
  ─────────                              ───                    ────────
  Push thông báo                     Follow-up tối          R&D Cycle (AI)
  "Hôm nay thế nào?"                "Giờ thấy sao?"        ├─ Phân tích data
       │                                  │                 ├─ Cập nhật KB
       ▼                                  ▼                 ├─ Xử lý unknown symptoms
  ┌──────────┐                     ┌──────────┐             └─ Tối ưu script
  │ User mở  │                     │ Đỡ hơn?  │
  │   app    │                     │ Vẫn vậy? │
  └────┬─────┘                     │ Nặng hơn?│
       │                          └────┬─────┘
       ▼                                │
  ┌─────────────────┐                   ▼
  │ Tôi ổn │ Hơi mệt │ Rất mệt │   Re-evaluate
  └──┬──────┬─────────┬──────────┘   → quyết định tiếp
     │      │         │
     ▼      ▼         ▼
  Hẹn tối  Triage    Triage 4 lớp
  (0 AI)   4 lớp      + flow_state=high_alert
            (~1-2 AI) (~1-2 AI)
               │         │
               ▼         ▼
          ┌────────────────┐
          │  LOW    → hẹn 6h         │
          │  MEDIUM → hẹn 3h         │
          │  HIGH   → hẹn 1h         │
          │           + bác sĩ        │
          │           + alertFamily   │
          └────────────────┘
```

---

## 4. API contract

**Entry point:** `getNextTriageQuestion(input)` ở `src/services/checkin/checkin.triage.v2.js`

**Input:**
```ts
{
  status: 'fine' | 'tired' | 'very_tired',
  phase: 'initial' | 'followup',
  lang: 'vi' | 'en',
  profile: { birth_year, gender, full_name, age?, medical_conditions? },
  healthContext: {
    medical_conditions: string[],
    recentGlucose: [{ value, unit, taken_at }],     // 7 ngày gần nhất
    recentBP: [{ systolic, diastolic, taken_at }],
    latestWeight: { weight_kg },
    previousCheckins: [...],
    symptomFrequencyContext: string,
    medicationAdherenceContext: string,
  },
  previousAnswers: [{ step, question, answer }],
  previousSessionSummary: string | null,
}
```

**Output (đang hỏi):**
```ts
{
  isDone: false,
  question: string,
  options?: string[],
  multiSelect?: boolean,
  allowFreeText?: boolean,
}
```

**Output (đã đủ thông tin):**
```ts
{
  isDone: true,
  summary: string,
  recommendation: string,
  closeMessage: string,
  severity: 'low' | 'medium' | 'high',
  needsDoctor: boolean,
  needsFamilyAlert: boolean,
  hasRedFlag: boolean,
  followUpHours: number,
  // chỉ có khi Layer 2 trigger
  _safetyClassifier?: { triggered: true, severity: string, reason: string },
}
```

---

## 5. Tri thức — 4 nguồn

### 5.1 Emergency keywords — `emergency-detector.js`

**11 emergency types với keyword regex** (zero AI, <1ms):

| Emergency | Trigger |
|---|---|
| **STROKE** | `yếu/tê/liệt nửa người` OR `nói ngọng` OR `méo miệng` OR `mất thị lực đột ngột` |
| **MI (NMCT)** | `đau/tức/nặng ngực` AND ≥1 (`khó thở`, `vã mồ hôi`, `đau lan tay/hàm`) |
| **PE (thuyên tắc phổi)** | `khó thở đột ngột` AND ≥1 (`đau ngực`, `ho ra máu`, `sưng chân`) |
| **MENINGITIS** | `sốt cao` AND `cứng cổ` |
| **CAUDA EQUINA** | `đau lưng dữ dội` AND ≥1 (`tê yên ngựa`, `bí tiểu/đại tiện`) |
| **HEMORRHAGE** | `nôn ra máu`, `đi ngoài ra máu`, `xuất huyết` |
| **ANAPHYLAXIS** | `khó thở` + `nổi mề đay/sưng môi/sưng mặt` |
| **DENGUE** | `sốt 3-7 ngày` AND `chấm đỏ/chảy máu` |
| **DKA** | `khát nhiều` + `tiểu nhiều` + `khó thở/buồn nôn` (đặc biệt diabetes) |
| **SEIZURE** | `co giật`, `mất ý thức kèm co cứng`, `động kinh` |
| **TRAUMA** ✨ | `gãy xương/chân/tay`, `biến dạng chi`, `tai nạn giao thông`, `ngã từ trên cao`, `chấn thương sọ não` |

**Negation detection:** `matchesAny()` bỏ match nếu trước keyword có "không/chưa/hết/bớt" trong 12 ký tự gần nhất → tránh false positive khi user nói *"không bị đau ngực"*.

Match → return ngay `{ severity: 'critical', needsFamilyAlert: true }` + dùng template từ `triage-ai-layer`.

### 5.2 AI Safety Classifier — `classifySymptomSeverity()` (Layer 2 mới)

**Mục đích:** safety net cho symptoms KHÔNG có trong emergency keywords (long tail).

**Cách hoạt động:**
- Sau khi user khai symptom (1 answer đầu) → gọi GPT classify
- Prompt: "Triệu chứng X, tuổi Y, bệnh nền Z → emergency/urgent/moderate/mild?"
- Quy tắc an toàn: khi nghi ngờ → chọn mức cao hơn; user ≥60 + bệnh nền → ngưỡng thấp hơn

**4 mức:**
| Severity | Action |
|---|---|
| `emergency` | Bypass triage → conclude với severity=high + needsFamilyAlert=true ngay |
| `urgent` | Tiếp tục triage nhưng bump severity ở conclusion |
| `moderate` | Triage bình thường |
| `mild` | Triage bình thường |

**Cache theo `symptom + age + conditions`** → lần 2 gặp symptom y hệt từ user cùng profile = 0 GPT call.

**Fail-safe:** AI fail/timeout → default `urgent` (bắt user đi khám) thay vì silent miss.

**Cost:** ~$0.0001/lần × 10K user × 3 check-in/ngày = ~$3/ngày.

### 5.3 Clinical KB — `clinical-mapping.js`

**Source:** Manchester Triage System (MTS), Canadian Triage and Acuity Scale (CTAS), WHO IMAI, OPQRST framework, dịch tễ Việt Nam (sốt xuất huyết, lao, ký sinh trùng).

**Cấu trúc per chief complaint:**
```js
'đau đầu': {
  associatedSymptoms: [
    { text: 'cứng cổ, khó cúi đầu', dangerLevel: 'danger' },
    { text: 'buồn nôn hoặc nôn',     dangerLevel: 'warning' },
    { text: 'chóng mặt',             dangerLevel: 'normal' },
    // ...
  ],
  redFlags: [
    'đau đầu dữ dội đột ngột (như sét đánh)',
    'yếu hoặc tê nửa người',
    'co giật',
    // ...
  ],
  causes: [
    'ngủ ít hoặc mất ngủ',
    'căng thẳng, lo âu',
    'quên uống thuốc huyết áp',
    // ...
  ],
}
```

**Hiện đã cover 14 chief complaints:** đau đầu, đau bụng, đau ngực, khó thở, sốt, chóng mặt, buồn nôn, mệt mỏi, đau lưng, ho, đau vai, tê tay chân, mất ngủ, đau họng, tiêu chảy.

**`dangerLevel: 'danger'`** ở associated → tự động set `hasRedFlag: true` (không cần bước red_flags riêng).

### 5.4 AI fallback — `generateMappingForSymptom()` (Layer 3 fallback)

Khi user khai symptom KHÔNG có trong KB:
1. Engine gọi `generateMappingForSymptom(symptom)` 
2. GPT trả về `{ associatedSymptoms, redFlags, causes }` cho symptom đó
3. **Cache vào memory** (`_mappingCache`) — lần sau cùng symptom = 0 GPT call

### 5.5 User context — cá nhân hoá

Mỗi triage call được nuôi bằng:
- **Profile:** tuổi (`birth_year`), giới tính, tên đầy đủ
- **Bệnh nền:** `medical_conditions[]` (vd. `["tiểu đường type 2", "cao huyết áp"]`)
- **Vital signs gần đây (7 ngày):** glucose, huyết áp, cân nặng
  - Auto-detect: glucose > 250 hoặc < 70, BP ≥ 180/110 → inject `vitalAlerts` → bump severity HIGH
- **Tần suất triệu chứng tích luỹ:** "đau đầu 5 lần/tuần qua"
- **Medication adherence:** "quên uống thuốc 3/7 ngày"
- **Lịch sử check-in:** summary 3-5 phiên gần nhất

### 5.6 Honorifics — xưng hô tiếng Việt

`getHonorifics(profile)` ở `lib/honorifics.js`:

| Tuổi | Giới | `honorific` (gọi user) | `selfRef` (Asinu xưng) |
|---|---|---|---|
| ≥ 60 | Nam | chú | cháu |
| ≥ 60 | Nữ | cô | cháu |
| 40-59 | Nam | anh | em |
| 40-59 | Nữ | chị | em |
| 25-39 | Nam | anh | mình |
| 25-39 | Nữ | chị | mình |
| < 25 | — | bạn | mình |

---

## 6. State machine — quyết định câu hỏi

### 6.1 Initial flow (8 step)

```
symptoms → associated → onset → progression → red_flags → cause → action → conclude
```

| Step | Mục tiêu | Source options |
|---|---|---|
| `symptoms` | Triệu chứng chính | 14 KB chief complaints (sort theo bệnh nền), `allowFreeText=true` cho gõ ngoài KB |
| `associated` | Triệu chứng đi kèm khoanh vùng chẩn đoán | `KB[primarySymptom].associatedSymptoms` |
| `onset` | Khi nào bắt đầu | Hardcoded: `vừa mới / vài giờ / từ sáng / từ hôm qua / vài ngày` |
| `progression` | Đỡ / vẫn / nặng hơn | Hardcoded: `đang đỡ dần / vẫn như cũ / có vẻ nặng hơn` |
| `red_flags` | Có dấu hiệu nguy hiểm? | `KB[primarySymptom].redFlags` (max 6) |
| `cause` | Nguyên nhân khả dĩ | `KB[primarySymptom].causes` |
| `action` | User đã làm gì rồi | Hardcoded: `nghỉ ngơi / uống thuốc / uống nước / chưa làm gì` |
| `conclude` | Tổng kết — KHÔNG hỏi user | `calculateConclusion()` |

### 6.2 Follow-up flow (3 step)

```
followup_status → followup_detail → conclude
```

- `followup_status`: `đỡ hơn nhiều / đỡ hơn một chút / vẫn như cũ / có vẻ nặng hơn`
- `followup_detail`: `không có triệu chứng mới / có thêm triệu chứng mới / triệu chứng cũ nặng hơn`

### 6.3 Skip-logic động

| Rule | Skip step |
|---|---|
| `status === 'very_tired'` | Bỏ `cause`, `action` (user mệt rồi, hỏi ít) |
| `progression === 'better'` | Bỏ `red_flags`, `cause` (đỡ rồi) |
| `previousSessionSummary` có triệu chứng tương tự | Bỏ `symptoms` (kế thừa) |
| Tuổi < 25 + không bệnh nền + không red flag | Bỏ `red_flags` |

`getNextStep()`:
1. `buildState(previousAnswers, profile, healthContext)` → tổng hợp state
2. `applySkipLogic()` → loại bỏ step không cần
3. Tìm step đầu tiên chưa làm
4. Nếu hết step hoặc reach `conclude` → `calculateConclusion()`
5. Còn step → `buildQuestion(step, state)` → return question + options

---

## 7. Cách tạo OPTIONS

### 7.1 Hardcoded
`onset`, `progression`, `action`, `followup_*` → arrays cứng trong `triage-engine.js`. Không bao giờ AI sinh.

### 7.2 KB-driven
`associated`, `red_flags`, `cause`:
```js
options = KB[primarySymptom].associatedSymptoms.map(s => s.text)
// Luôn append 'không có' / 'không rõ' ở cuối
```

### 7.3 AI fallback
Nếu `primarySymptom` không match KB → gọi `generateMappingForSymptom()` → inject vào engineResult.options.

### 7.4 Symptoms options — ưu tiên theo bệnh nền

Step `symptoms` show 14 chief complaints, **sort động** dựa `medical_conditions`:

| Bệnh nền user | Triệu chứng đẩy lên đầu |
|---|---|
| Tiểu đường / đái tháo đường | chóng mặt, mệt mỏi, buồn nôn, tê tay chân, khó thở |
| Cao huyết áp | đau đầu, chóng mặt, đau ngực, khó thở |
| Tim mạch | đau ngực, khó thở, mệt mỏi, chóng mặt |
| Hen suyễn / COPD / phổi | khó thở, ho, đau ngực |
| Thoái hoá khớp | đau vai, tê tay chân |
| Mất ngủ / lo âu / trầm cảm | mất ngủ, mệt mỏi, đau đầu |
| Dạ dày / tiêu hoá | đau bụng, buồn nôn, tiêu chảy |
| Gan / thận | đau bụng, buồn nôn, mệt mỏi |

User không có bệnh nền → giữ thứ tự default.

**KHÔNG có option "khác (mô tả thêm)"** — vì `allowFreeText: true` đã render input field bên dưới options. User gõ thẳng vào input nếu triệu chứng không có sẵn (placeholder: "Hoặc gõ triệu chứng khác (vd. tê môi, ngứa khắp người)...").

### 7.5 multiSelect / allowFreeText per step

| Step | multiSelect | allowFreeText |
|---|---|---|
| `symptoms` | false | **true** |
| `associated` | **true** | false |
| `onset` | false | false |
| `progression` | false | false |
| `red_flags` | **true** | false |
| `cause` | **true** | false |
| `action` | **true** | false |

---

## 8. Conclusion & severity calculator

`calculateConclusion(state, status)` — deterministic, không GPT:

```
severity = 'low' (default)

IF state.redFlagsFound.length > 0
  severity = 'high'

ELSE IF state.progression === 'worse'
  severity = (isElderly OR hasConditions) ? 'high' : 'medium'

ELSE IF state.progression === 'same' AND (isElderly OR hasConditions)
  severity = 'medium'

IF status === 'very_tired' AND severity === 'low'
  severity = 'medium'  // bump
```

**needsDoctor:**
- severity = 'high' → true
- elderly + có bệnh nền + severity ≠ low → true
- có red flag → true
- progression = 'worse' → true

**needsFamilyAlert:**
- severity = 'high' AND (isElderly OR hasConditions) → true
- có red flag → true

**followUpHours:**
- high → 1h
- medium → 3h
- low → 4h (elderly) / 6h (non-elderly)

### 🔒 Safety override quan trọng

Trong `checkin.service.js`, sau khi nhận conclusion:
```js
const shouldAlertFamilyNow = (result.needsFamilyAlert || result.severity === 'high')
  && !session.family_alerted;
```
**Nếu `severity === 'high'` → LUÔN gọi `alertFamily()` bất kể `needsFamilyAlert` của engine ra sao.** AI/engine có thể sai, nhưng safety > confidence.

### Modifier: bệnh nền & tuổi cao

| Điều kiện | Hiệu ứng |
|---|---|
| Tiểu đường + đau ≥ 5/10 | Bump → Nặng |
| Tim mạch + đau ≥ 3/10 | Bump → Nặng |
| Cao huyết áp + đau ≥ 5/10 | Bump → Nặng |
| Tuổi ≥ 60 + bệnh nền + bất kỳ triệu chứng | **Không bao giờ xếp Nhẹ** |

**Ví dụ so sánh:**
| Cùng đau 5/10 | Anh Minh (30t, khỏe) | Chú Hùng (68t, tiểu đường) |
|---|---|---|
| Mức độ | 🟡 Trung bình | 🔴 Nặng |
| Follow-up | 3 giờ | 1 giờ |
| Bác sĩ | Không | CÓ |

---

## 9. Caregiver alert flow

### 9.1 SOS button (quick path)

User nhấn "Báo người thân" trong app (icon medkit đỏ ở `asinu-brain-extension/ui/AsinuEmergencyFAB.tsx`):

```
POST /api/mobile/checkin/emergency
  ↓
triggerEmergency(userId, location)
  ↓
1. DEDUP GUARD 5 PHÚT
   SELECT 1 FROM caregiver_alert_confirmations
   WHERE patient_id=$1 AND alert_type='emergency'
     AND confirmed_at IS NULL
     AND sent_at >= NOW() - INTERVAL '5 minutes'
   → nếu có → return { deduped: true } (chống panic-tap spam)
   ↓
2. UPSERT health_checkins (emergency_triggered=true, flow_state='high_alert')
   ↓
3. SELECT caregivers (can_receive_alerts=true)
   ↓
4. For each caregiver:
   - INSERT caregiver_alert_confirmations (confirmed_at=NULL)
   - sendCheckinNotification → push "🚨 [Tên patient] cần giúp đỡ ngay"
   - Push notification có 3 action buttons (categoryIdentifier='health_alert'):
     [✓ Đã xem] [🚗 Đang đến gặp] [📞 Đã gọi điện]
```

### 9.2 Caregiver tap action button — closed loop

`POST /api/mobile/checkin/confirm-alert` với `action ∈ {seen, on_my_way, called}`:

| Caregiver bấm | Backend làm | Patient nhận |
|---|---|---|
| **Đã biết rồi** (seen) | UPDATE `confirmed_at`, `confirmed_action='seen'` | 📱 Push: "[Tên] đã xem thông báo 👀" |
| **Đang đến gặp** (on_my_way) | UPDATE `confirmed_at`, `confirmed_action='on_my_way'` | 📱 Push: "[Tên] đang trên đường đến 🚗" |
| **Đã gọi điện** (called) | UPDATE `confirmed_at`, `confirmed_action='called'` + iOS mở `tel:` | ❌ KHÔNG push (đã nói chuyện trực tiếp rồi) |

Sau khi confirm → `confirmed_at` được set → guard 5-min ở `triggerEmergency` không match nữa → patient có thể trigger SOS mới ngay (escalation).

### 9.3 Resend nếu caregiver không phản hồi

Cron `runAlertConfirmationFollowUps` (chạy mỗi 30 phút):
- Quét `caregiver_alert_confirmations WHERE confirmed_at IS NULL AND resent_count < 4 AND sent_at <= NOW() - 30 min`
- Resend với title "🚨 Nhắc lại: Khẩn cấp" + tăng `resent_count`
- Max 4 lần resend → tổng = **1 initial + 4 resend trong 2 giờ** → sau đó stop

### 9.4 Family alert từ triage (auto path)

Khi triage conclude với `severity === 'high'` (red flag detected), `checkin.service.js` tự động gọi `alertFamily(pool, session)`:

```js
const shouldAlertFamilyNow =
  (result.needsFamilyAlert || result.severity === 'high')
  && !session.family_alerted;

if (shouldAlertFamilyNow) {
  const caregiversAlerted = await alertFamily(pool, session);
  result.familyAlertResult = {
    attempted: true,
    caregiversNotified: caregiversAlerted || 0,
  };
  // Set family_alerted=true để không gửi lại trong cùng session
}
```

FE hiển thị banner trong result screen:
- ✅ Xanh "Đã thông báo X người trong vòng kết nối" (≥1 caregiver)
- ⚠️ Vàng "Tình trạng nghiêm trọng — chưa có người thân trong vòng kết nối, hãy mời ngay" (0 caregiver)
- ℹ️ Xanh lam "Người thân đã được thông báo từ trước, đang chờ phản hồi" (alreadyAlerted)

---

## 10. Combo detection

Hệ thống nhận diện **8 tổ hợp triệu chứng nguy hiểm** mà riêng lẻ có thể không đáng lo:

| Tổ hợp | Triệu chứng | Mức độ | Hành động |
|---|---|---|---|
| Nghi đột quỵ | Đau đầu + mờ mắt | 🔴 Nguy kịch | Gọi 115 ngay |
| Nghi viêm ruột thừa | Đau bụng dưới + sốt | 🔴 Nặng | Đi khám ngay |
| Mất nước nặng | Tiêu chảy + nôn + sốt | 🔴 Nặng | Uống oresol, đi khám |
| Cơn tăng huyết áp | Đau đầu + chóng mặt + buồn nôn | 🔴 Nặng | Đo huyết áp ngay |
| Biến chứng tiểu đường | Mệt + chóng mặt + khát nước | 🔴 Nặng | Đo đường huyết |
| Nhiễm trùng hô hấp | Ho + sốt + đau họng | 🟡 Trung bình | Nghỉ ngơi, theo dõi |
| Đau đầu + chóng mặt | 2 triệu chứng phổ biến | 🟡 Trung bình | Đo huyết áp |
| Mệt + sụt cân | Dấu hiệu bệnh mạn tính | 🟡 Trung bình | Xét nghiệm máu |

> **User có tiểu đường:** chỉ cần 2/3 triệu chứng (thay vì 3/3) để phát hiện "Biến chứng tiểu đường" — ngưỡng thấp hơn vì nguy cơ cao hơn.

File: `multi-symptom.service.js`.

---

## 11. Follow-up & re-check

Sau 1-6 giờ → push notification → user mở app → 2 câu hỏi:

```
Câu 1: "So với lúc trước, chú thấy thế nào?"
        → [Đỡ hơn nhiều] [Đỡ hơn một chút] [Vẫn như cũ] [Có vẻ nặng hơn]

Câu 2: "Có triệu chứng mới không?"
        → [Không có] [Có thêm triệu chứng mới] [Triệu chứng cũ nặng hơn]
```

| Trả lời | Hành động |
|---|---|
| Đỡ hơn nhiều + không mới | → Nhẹ → theo dõi → hẹn tối |
| Đỡ hơn một chút + không mới | → Theo dõi → hẹn 4h |
| Vẫn như cũ + không mới | → Giữ mức cũ → hẹn follow-up tiếp |
| Nặng hơn + có mới | → Nặng → khuyên bác sĩ → cảnh báo gia đình |
| Đỡ hơn + CÓ mới | → Nặng (vì có triệu chứng mới dù đỡ) |

---

## 12. 12 tình huống đặc biệt

### 12.1 User nói "Tôi ổn"
→ Không chạy script → không gọi AI → hẹn 21:00 tối hỏi lại.

### 12.2 User nhập triệu chứng MỚI (không có trong KB)
- `resolveComplaint(raw)` không match → `primarySymptom = raw`
- Layer 2 AI safety classifier chạy → phán quyết severity
- Engine continue với options từ AI fallback
- Log vào DB → R&D cycle 2:00 AM xử lý → ngày mai có script riêng

### 12.3 User nhấn nút SOS "Báo người thân"
- Bypass triage, đi vào `POST /api/mobile/checkin/emergency`
- Dedup 5 phút chống panic-tap
- Gửi push tới TẤT CẢ caregivers có `can_receive_alerts=true`

### 12.4 Vital signs nguy hiểm (glucose/BP)
- Glucose > 250 hoặc < 70, BP ≥ 180/110 → inject `vitalAlerts` vào health context
- AI prompt hiểu → ưu tiên hỏi triệu chứng liên quan + bump severity HIGH

### 12.5 User trả lời lạc đề / vô nghĩa ở `symptoms` step
- `resolveComplaint` cố match free-text về key (vd. "đầu đau ghê" → key `đau đầu`)
- Layer 2 safety classifier vẫn chạy → bắt được nếu emergency
- Nếu không match + AI fail → engine vẫn tiếp tục với options trống

### 12.6 User trả lời câu tương tự câu trước
Anti-loop: check overlap > 70% từ → force conclusion.

### 12.7 Hết câu hỏi tối đa
8 cho initial, 3 cho follow-up. Engine tự conclude. Không bao giờ hỏi quá max.

### 12.8 Triệu chứng trong câu trả lời rơi vào danger keyword
Sau bất kỳ answer nào, code re-scan toàn bộ symptom text qua `detectEmergency()`. Nếu trigger → conclude ngay với severity HIGH bất kể đang ở step nào.

### 12.9 Follow-up nhưng phiên gốc không có trong DB
`previousSessionSummary = null` → engine treat như initial nhưng dùng `FOLLOWUP_STEPS` rút gọn.

### 12.10 User không khai tuổi/giới tính
- Honorific = "bạn", selfRef = "mình" (neutral)
- `isElderly = false` → các rule "elderly + condition → bump severity" không apply

### 12.11 User chỉ chọn "không có" cho mọi triệu chứng đi kèm
- `redFlagsFound = []`, `progression` không set → severity = 'low'
- Conclusion: "tình trạng nhẹ, theo dõi 6h"
- Nếu status user khai = 'very_tired' → bump → 'medium'

### 12.12 Gãy chân / chấn thương / triệu chứng nguy hiểm "long tail"
**Trước fix:** Không có trong KB + không có trong emergency keywords → severity stay low → KHÔNG báo gia đình ❌

**Sau fix (2 lớp safety net):**
1. **Layer 1** đã thêm `TRAUMA_KW` → match "gãy chân" → severity=critical, alertFamily ngay
2. **Layer 2** AI safety classifier → catch các case còn sót (khó nuốt, ho ra máu, không tiểu được, mất thị lực, tim đập bất thường, ...) → emergency → bypass triage + alertFamily

→ Mọi triệu chứng nguy hiểm giờ đều có **2 cơ hội** để được phát hiện.

---

## 13. R&D cycle ban đêm

`rnd-cycle.service.js` chạy đêm 2:00 AM:

```
1. Đọc fallback logs (engine không match được KB)
2. Cluster các unknown symptoms (vd. "đau dạ dày" xuất hiện 50 lần)
3. Gọi GPT batch → generate KB cho symptoms phổ biến
4. Đề xuất bổ sung vào clinical-mapping.js (manual review hiện tại)
5. Tối ưu skip-logic dựa trên data thực tế
6. Cập nhật trends:
   - "Đau đầu 5 ngày liên tiếp" → trend = increasing
   - "Chóng mặt giảm" → trend = decreasing
7. Lưu patterns vào agent_checkin_memory
```

→ Hệ thống **tự học** mà không cần dev intervention thường xuyên.

---

## 14. Cách nạp tri thức mới

### Cấp 1: Thêm Emergency keyword (`emergency-detector.js`)
**Khi nào:** Triệu chứng đe doạ tính mạng cần báo gia đình NGAY.

```js
// 1. Define keyword array mới
const MY_NEW_EMERGENCY_KW = ['kw1', 'kw2', 'kw3 không dấu'];

// 2. Add rule trong detectEmergency()
if (matchesAny(text, MY_NEW_EMERGENCY_KW)) {
  return result(true, 'MY_TYPE', 'critical', true, true, 0);
}

// 3. Add vào EMERGENCY_TYPE_MAP ở triage.v2.js
const EMERGENCY_TYPE_MAP = {
  ...,
  MY_TYPE: 'my_type',
};

// 4. Add template trong triage-ai-layer.js EMERGENCY_CONCLUSIONS
my_type: {
  summary: (h) => `${h.Honorific} bị X cần can thiệp y tế ngay.`,
  recommendation: () => `🚨 Hành động cụ thể...`,
  closeMessage: (h) => `${h.selfRef} đã thông báo cho người thân.`,
},
```

### Cấp 2: Thêm chief complaint vào KB (`clinical-mapping.js`)
**Khi nào:** Triệu chứng cần triage nhiều bước.

```js
'tên triệu chứng': {
  associatedSymptoms: [
    { text: '...', dangerLevel: 'normal' | 'warning' | 'danger' },
    // 6-12 items
  ],
  redFlags: [
    // 5-10 chuỗi mô tả ngắn
  ],
  causes: [
    // 5-10 nguyên nhân thường gặp
  ],
}
```

Test: `npm run dev` → check-in → khai triệu chứng → kiểm tra options sinh ra đúng.

### Cấp 3: Để AI sinh KB động (đã sẵn)
Triệu chứng KHÔNG có trong KB → backend tự gọi `generateMappingForSymptom()` → cache. Không cần làm gì.

### Cấp 4: AI safety classifier cho long tail (đã sẵn)
Bất kỳ triệu chứng nào, kể cả không có trong cấp 1-3 → Layer 2 classify → catch emergency case. Không cần làm gì.

### Tinh chỉnh prompt AI
Edit `i18n/locales/vi.json` keys:
- `prompt.health_assessment` (general triage)
- `prompt.emergency_triage` (sau khi nhấn "Rất mệt")
- `prompt.risk_assessment` (risk scoring)

App restart sẽ load mới.

### Đề xuất workflow

| Trường hợp | Nên dùng |
|---|---|
| Triệu chứng đe doạ tính mạng (gãy xương, ngộ độc, đột quỵ) | Cấp 1 (emergency keywords) |
| Triệu chứng phổ biến cần triage (đau lưng, ho lâu, mất ngủ) | Cấp 2 (KB clinical-mapping) |
| Triệu chứng hiếm gặp / lần đầu thấy | Cấp 3+4 (AI tự sinh + safety net), sau đó review log → promote |

---

## 15. Cost & performance

| Metric | Value |
|---|---|
| Latency p50 | ~200ms (no GPT path) hoặc ~2s (với conclusion GPT) |
| Latency p99 | ~5s |
| GPT calls/check-in | 1-2 (1 safety classify + 1 conclusion) |
| Cost/check-in | ~$0.0002 (gpt-4o-mini) |
| Memory/session | ~50KB (state + KB lookup) |
| KB size | `clinical-mapping.js` ~30KB raw |

**10K user × 3 check-in/ngày × $0.0002 = $6/ngày** — bền vững.

### Tỷ lệ cache hit (sau warm-up)
- Safety classifier cache: ~60% hit (user lặp triệu chứng cũ)
- Mapping cache: ~80% hit
- Conclusion: 0% (luôn cá nhân hoá)

---

## 16. File & DB reference

### Files
| File | Vai trò |
|---|---|
| `services/checkin/checkin.triage.v2.js` | Entry point — orchestrate 4 lớp |
| `services/checkin/emergency-detector.js` | **Layer 1** — keyword regex 11 emergency types |
| `core/checkin/triage-ai-layer.js` | **Layer 2** classifySymptomSeverity, **Layer 4** generateConclusion + generateMappingForSymptom |
| `core/checkin/triage-engine.js` | **Layer 3** — state machine + conclusion calculator |
| `services/checkin/clinical-mapping.js` | KB triệu chứng (associated, redFlags, causes) — 14 chief complaints |
| `services/checkin/checkin.service.js` | Service layer — wrap triage, gọi alertFamily, save DB, SOS handler, dedup |
| `services/checkin/checkin.ai.service.js` | Legacy entry point (vẫn dùng cho 1 số path, full-AI prompt-based) |
| `services/checkin/multi-symptom.service.js` | Combo detection cho ≥2 triệu chứng |
| `services/checkin/script-session.service.js` | Quản lý session script-driven flow (UX layer) |
| `services/checkin/rnd-cycle.service.js` | R&D cycle ban đêm |
| `lib/honorifics.js` | Vietnamese honorifics rules |
| `lib/relation.js` | Reverse-map caregiver relationship → patient role |
| `i18n/locales/vi.json` (`prompt.*`) | Prompts cho AI |

### Database tables
| Bảng | Mục đích |
|---|---|
| `health_checkins` | Session check-in hàng ngày (status, severity, flow_state, family_alerted, emergency_triggered) |
| `caregiver_alert_confirmations` | Per-caregiver alert receipt (confirmed_at, confirmed_action, resent_count). UNIQUE (checkin_id, caregiver_id) |
| `problem_clusters` | Nhóm triệu chứng user hay gặp |
| `triage_scripts` | Kịch bản hỏi cached |
| `script_sessions` | Tracking mỗi lần user chạy script |
| `fallback_logs` | Triệu chứng lạ chờ R&D xử lý |
| `rnd_cycle_logs` | Log mỗi lần R&D cycle chạy |
| `agent_checkin_memory` | Agent nhớ patterns, preferences |
| `symptom_logs` | Log triệu chứng chi tiết |
| `symptom_frequency` | Tần suất triệu chứng (7d, 30d, trend) |
| `notifications` | In-app notifications (caregiver_alert, caregiver_confirmed, ...) |
| `user_connections` | Care circle (permissions: can_receive_alerts, can_ack_escalation, can_view_logs) |

### Cấu trúc `script_data` (JSON)

```json
{
  "greeting": "Chú Hùng ơi, cháu hỏi thăm chú nhé 💙",
  "questions": [
    {
      "id": "q1",
      "text": "Chóng mặt kiểu nào?",
      "type": "single_choice",
      "options": ["quay cuồng", "lâng lâng", "tối sầm mắt"]
    }
  ],
  "scoring_rules": [
    {
      "conditions": [{"field": "q1", "op": "eq", "value": "tối sầm mắt"}],
      "severity": "high",
      "needs_doctor": true,
      "follow_up_hours": 1
    }
  ],
  "conclusion_templates": {
    "low":    { "summary": "...", "recommendation": "...", "close_message": "..." },
    "medium": { "summary": "...", "recommendation": "...", "close_message": "..." },
    "high":   { "summary": "...", "recommendation": "...", "close_message": "..." }
  }
}
```

---

## 17. API endpoints

| Method | Path | Mô tả |
|---|---|---|
| POST | `/api/mobile/checkin/start` | Bắt đầu checkin (status: fine/tired/very_tired) |
| POST | `/api/mobile/checkin/followup` | Submit answer → next triage step hoặc conclusion |
| POST | `/api/mobile/checkin/triage` | Hoàn tất triage → return symptom mapping + recommendation |
| POST | `/api/mobile/checkin/emergency` | SOS button — alert family ngay (có dedup 5 phút) |
| GET  | `/api/mobile/checkin/today` | Get today checkin state (monitoring/follow_up/high_alert/resolved) |
| GET  | `/api/mobile/checkin/pending-alerts` | Caregiver lấy list alerts chờ xác nhận |
| POST | `/api/mobile/checkin/confirm-alert` | Caregiver: seen / on_my_way / called |
| GET  | `/api/mobile/checkin/report` | Health report: triage results, recommendations |
| GET  | `/api/mobile/checkin/script` | Lấy kịch bản cached cho user |
| POST | `/api/mobile/checkin/script/start` | Bắt đầu session script (status + cluster/symptom) |
| POST | `/api/mobile/checkin/script/answer` | Gửi câu trả lời, nhận câu tiếp hoặc kết quả |
| GET  | `/api/mobile/checkin/script/session` | Lấy session hiện tại |
| POST | `/api/mobile/checkin/script/clusters` | Tạo clusters từ onboarding |

---

## Bonus — Bảng so sánh AI calls

| Tình huống | Gọi AI? | Khi nào |
|---|---|---|
| Check-in "Tôi ổn" | KHÔNG | Chỉ hẹn tối |
| Check-in "Hơi mệt" → script có sẵn | KHÔNG | Script cached |
| Check-in symptom MỚI | **CÓ** | Layer 2 safety classify (1 call) + Layer 4 conclusion (1 call) |
| Check-in symptom đã gặp lại | **CÓ ít** | Cache hit Layer 2, chỉ Layer 4 (1 call) |
| Follow-up (đỡ/vậy/nặng) | KHÔNG | Scoring rules deterministic |
| Chọn options | KHÔNG | UI + scoring |
| Emergency match keyword | KHÔNG | Layer 1 keyword detection |
| Combo detection | KHÔNG | Rule-based |
| User muốn chat sâu | CÓ | Tab Chat AI riêng |
| Tạo script lần đầu | CÓ | 1 lần khi onboarding |
| R&D cycle hàng đêm | CÓ | Batch, 100-500 calls/đêm |

---

## Hệ thống thông minh dần

```
Tuần 1:  Script dựa trên onboarding → hỏi chung chung
Tuần 2:  R&D cập nhật → hỏi đúng triệu chứng hay gặp
Tuần 4:  Script tối ưu → hỏi ít hơn, đúng hơn
Tháng 2: Hệ thống biết pattern → dự đoán trước
Tháng 6: Cache hit rate ~80% → AI calls giảm mạnh → chi phí giảm
```

> **Càng dùng lâu → AI càng ít phải can thiệp → chi phí càng giảm → trải nghiệm càng tốt.**

---

> **Tài liệu này phản ánh state hệ thống Check-in Asinu tại commit gần nhất.**
> Khi sửa code (thêm emergency, thêm KB, đổi flow) → update lại các section tương ứng để doc không stale.
