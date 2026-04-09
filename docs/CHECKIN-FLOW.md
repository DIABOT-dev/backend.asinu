# Hệ thống Check-in Sức khỏe Asinu

---

## 1. Tổng quan

### Mục đích
Asinu là hệ thống **theo dõi sức khỏe hàng ngày** dành cho người cao tuổi và người có bệnh nền. Mỗi ngày, hệ thống hỏi thăm sức khỏe người dùng, phát hiện vấn đề sớm, và đưa ra lời khuyên phù hợp.

### Nguyên tắc hoạt động

```
AI tạo kịch bản (1 lần) → App chạy kịch bản (mỗi ngày) → Backend tính toán → AI chỉ can thiệp khi cần
```

- **Kịch bản (Script):** Bộ câu hỏi + quy tắc chấm điểm được tạo sẵn. Không cần gọi AI mỗi lần check-in.
- **Tính toán (Scoring):** Điểm số và mức độ nghiêm trọng được tính bằng công thức có sẵn, KHÔNG gọi AI.
- **AI chỉ can thiệp ban đêm:** Xử lý triệu chứng mới, tối ưu kịch bản cho ngày mai.

### Lợi ích

| Lợi ích | Mô tả |
|---------|-------|
| Ổn định | Kịch bản có sẵn, không phụ thuộc AI real-time |
| Chi phí thấp | ~0 AI calls ban ngày, chỉ gọi AI ban đêm (batch) |
| Cá nhân hóa dần | Hệ thống học dần thói quen, triệu chứng của từng người |
| An toàn | Phát hiện cấp cứu tức thì, cảnh báo gia đình tự động |

---

## 2. Luồng hoạt động trong 1 ngày

```
  7:00 SÁNG                              TỐI                    2:00 ĐÊM
  ─────────                              ───                    ────────
  Push thông báo                     Follow-up tối          R&D Cycle (AI)
  "Hôm nay thế nào?"                "Giờ thấy sao?"        ├─ Phân tích data
       │                                  │                 ├─ Cập nhật cluster
       ▼                                  ▼                 ├─ Xử lý triệu chứng mới
  ┌──────────┐                     ┌──────────┐             └─ Tối ưu script
  │ User mở  │                     │ Đỡ hơn?  │
  │   app    │                     │ Vẫn vậy? │
  └────┬─────┘                     │ Nặng hơn?│
       │                          └────┬─────┘
       ▼                                │
  ┌─────────────────┐                   ▼
  │ Tôi ổn │ Hơi mệt │ Rất mệt │   Scoring lại
  └──┬──────┬─────────┬──────────┘   → quyết định tiếp
     │      │         │
     ▼      ▼         ▼
  Hẹn tối  Script    Script
  (0 AI)   3-5 câu   3-5 câu
            (0 AI)    (0 AI)
               │         │
               ▼         ▼
           Scoring    Scoring
           Engine     Engine
               │         │
               ▼         ▼
          ┌────────────────┐
          │  NHẸ → hẹn tối │
          │  TB  → hẹn 3h  │
          │  NẶNG → hẹn 1h │
          │        + bác sĩ │
          └────────────────┘
```

---

## 3. Các tình huống xử lý

### 3.1 User nói "Tôi ổn"

```
User: "Tôi ổn"
  → Không chạy script
  → Không gọi AI
  → Hẹn 21:00 tối hỏi lại
  → 21:00: "Vẫn ổn?" → Có → Kết thúc ngày
                       → Hơi mệt → Chạy script
```

**Ví dụ thực tế:**
> 7:00 — "Chào chú Hùng! Hôm nay chú thế nào?"
> Chú Hùng: "Tôi ổn" ✅
> → "Tốt quá! Hẹn tối nay nhé 💙"
> 21:00 — "Chú Hùng ơi, cả ngày chú ổn chứ?"
> Chú Hùng: "Vẫn ổn" → Kết thúc. Hẹn sáng mai.

### 3.2 User nói "Hơi mệt" → chọn triệu chứng có sẵn

```
User: "Hơi mệt"
  → App hiện danh sách triệu chứng có sẵn (từ DB)
  → User chọn: "Chóng mặt"
  → Chạy script chóng mặt (3-5 câu, 0 AI)
  → Scoring → kết luận + lời khuyên
  → Hẹn follow-up
```

**Ví dụ thực tế:**
> Chú Hùng: "Hơi mệt"
> App: Chú hay bị gì? → [Mệt mỏi] [Chóng mặt] [Tê tay chân]
> Chú Hùng: "Chóng mặt"
>
> Câu 1: "Chóng mặt kiểu nào?" → [Quay cuồng] [Lâng lâng] [Tối sầm mắt]
> Câu 2: "Xuất hiện khi nào?" → [Khi đứng dậy] [Liên tục] [Khi xoay đầu]
> Câu 3: "Có triệu chứng kèm?" → [Buồn nôn] [Ù tai] [Đau đầu] [Không có]
> Câu 4: "Có dùng thuốc huyết áp?" → [Có] [Không]
>
> 📊 Kết quả: Trung bình | Hẹn 3h | Lời khuyên: "Nằm nghỉ, đầu hơi cao..."

### 3.3 User nhập triệu chứng MỚI (không có trong DB)

```
User: "Đau dạ dày" (chưa có trong DB)
  → matchCluster() → KHÔNG TÌM THẤY
  → Chuyển sang Fallback: 3 câu cơ bản
     1. Đau mức nào? (0-10)
     2. Từ khi nào?
     3. Nặng hơn không?
  → Scoring → vẫn có kết quả
  → Log vào DB → chờ R&D cycle xử lý
  → 2:00 AM: AI gắn nhãn → tạo cluster + script mới
  → NGÀY MAI: "Đau dạ dày" đã có script riêng!
```

**Ví dụ thực tế — Ngày 1 vs Ngày 2:**

| | Ngày 1 (chưa có script) | Ngày 2 (đã có script) |
|---|---|---|
| Câu hỏi | 3 câu chung | 4 câu chuyên sâu |
| Nội dung | "Đau mức nào? Từ khi nào?" | "Đau ở vị trí nào? Kiểu đau? Liên quan ăn uống?" |
| AI calls | 0 | 0 |
| Chất lượng | Cơ bản | Chuyên sâu theo y khoa |

### 3.4 User nói "Rất mệt"

```
User: "Rất mệt"
  → flow_state = high_alert
  → Chạy script → scoring → thường ra HIGH
  → Follow-up sau 1 giờ
  → Nếu vẫn nặng → cảnh báo gia đình
```

### 3.5 User nhập NHIỀU triệu chứng

```
User: "Đau đầu, chóng mặt và buồn nôn"
  → parseSymptoms() tách ra: ["đau đầu", "chóng mặt", "buồn nôn"]
  → Kiểm tra emergency → không
  → Kiểm tra combo → ⚠️ "Cơn tăng huyết áp" (đau đầu + chóng mặt + buồn nôn)
  → Match clusters: đau đầu → headache, chóng mặt → dizziness, buồn nôn → nausea
  → Chạy từng script → tổng hợp severity
  → Kết quả cuối: MAX severity + MIN follow-up hours
```

### 3.6 Phát hiện tổ hợp nguy hiểm (Combo Detection)

Hệ thống nhận diện **8 tổ hợp triệu chứng nguy hiểm** mà riêng lẻ có thể không đáng lo, nhưng KẾT HỢP thì nguy hiểm:

| Tổ hợp | Triệu chứng | Mức độ | Hành động |
|--------|-------------|--------|-----------|
| Nghi đột quỵ | Đau đầu + mờ mắt | 🔴 Nguy kịch | Gọi 115 ngay |
| Nghi viêm ruột thừa | Đau bụng dưới + sốt | 🔴 Nặng | Đi khám ngay |
| Mất nước nặng | Tiêu chảy + nôn + sốt | 🔴 Nặng | Uống oresol, đi khám |
| Cơn tăng huyết áp | Đau đầu + chóng mặt + buồn nôn | 🔴 Nặng | Đo huyết áp ngay |
| Biến chứng tiểu đường | Mệt + chóng mặt + khát nước | 🔴 Nặng | Đo đường huyết |
| Nhiễm trùng hô hấp | Ho + sốt + đau họng | 🟡 Trung bình | Nghỉ ngơi, theo dõi |
| Đau đầu + chóng mặt | 2 triệu chứng phổ biến | 🟡 Trung bình | Đo huyết áp |
| Mệt + sụt cân | Dấu hiệu bệnh mạn tính | 🟡 Trung bình | Xét nghiệm máu |

> **Đặc biệt:** Người bệnh tiểu đường chỉ cần 2/3 triệu chứng (thay vì 3/3) để phát hiện "Biến chứng tiểu đường" — ngưỡng thấp hơn vì nguy cơ cao hơn.

### 3.7 Phát hiện cấp cứu (Emergency Detection)

Phát hiện bằng **keyword matching** — không cần AI, phản hồi tức thì:

| Loại | Triệu chứng nhận diện | Hành động |
|------|----------------------|-----------|
| Nhồi máu cơ tim | Đau ngực + khó thở | 🚨 GỌI 115 NGAY |
| Đột quỵ | Yếu nửa người / nói ngọng / méo miệng | 🚨 GỌI 115 NGAY |
| Co giật | Co giật / động kinh | 🚨 GỌI 115 |
| Viêm màng não | Sốt cao + cứng cổ | 🚨 ĐẾN BỆNH VIỆN |
| Xuất huyết | Nôn ra máu | 🚨 ĐẾN BỆNH VIỆN |
| Phản vệ | Khó thở + sưng mặt | 🚨 GỌI 115 |
| Sốt xuất huyết | Sốt + chấm đỏ + đau bụng | 🚨 ĐẾN BỆNH VIỆN |
| Nhiễm toan ceton | Tiểu đường + khát nhiều + buồn nôn | 🚨 ĐẾN BỆNH VIỆN |

> **Xử lý phủ định:** "Không đau ngực", "Hết khó thở rồi" → hệ thống hiểu đây KHÔNG phải cấp cứu.

### 3.8 Follow-up: Hỏi lại sau X giờ

```
Sau 1-6 giờ → Push notification → User mở app → 2 câu hỏi:

  Câu 1: "So với lúc trước, chú thấy thế nào?"
          → [Đỡ hơn] [Vẫn vậy] [Nặng hơn]

  Câu 2: "Có triệu chứng mới không?"
          → [Không] [Có]
```

| Trả lời | Hành động |
|---------|-----------|
| Đỡ hơn + không mới | → Nhẹ → theo dõi → hẹn tối |
| Vẫn vậy + không mới | → Giữ mức cũ → hẹn follow-up tiếp |
| Nặng hơn + có mới | → Nặng → khuyên bác sĩ → cảnh báo gia đình |
| Đỡ hơn + CÓ mới | → Nặng (vì có triệu chứng mới dù đỡ) |

---

## 4. Hệ thống chấm điểm

### 4.1 Mức độ nghiêm trọng

| Mức | Ý nghĩa | Follow-up | Bác sĩ | Gia đình |
|-----|---------|-----------|--------|----------|
| 🟢 Nhẹ | Không đáng lo | Hẹn tối (6h) | Không | Không |
| 🟡 Trung bình | Cần theo dõi | Hẹn 3h | Không | Không |
| 🔴 Nặng | Cần bác sĩ | Hẹn 1h | **CÓ** | **CÓ** |
| 🚨 Nguy kịch | Cấp cứu | 30 phút | **CÓ** | **CÓ** |

### 4.2 Modifier: Bệnh nền & tuổi cao

Hệ thống tự động **tăng mức độ** khi user có bệnh nền hoặc cao tuổi:

| Điều kiện | Hiệu ứng |
|-----------|----------|
| Tiểu đường + đau ≥ 5/10 | Tăng lên Nặng |
| Tim mạch + đau ≥ 3/10 | Tăng lên Nặng |
| Cao huyết áp + đau ≥ 5/10 | Tăng lên Nặng |
| Tuổi ≥ 60 + bệnh nền + bất kỳ triệu chứng | **Không bao giờ xếp Nhẹ** |

**Ví dụ so sánh:**

| Cùng đau 5/10 | Anh Minh (30t, khỏe) | Chú Hùng (68t, tiểu đường) |
|---|---|---|
| Mức độ | 🟡 Trung bình | 🔴 Nặng |
| Follow-up | 3 giờ | 1 giờ |
| Bác sĩ | Không | CÓ |

### 4.3 Lời khuyên cá nhân hóa theo triệu chứng

Mỗi triệu chứng có lời khuyên riêng (không chung chung):

| Triệu chứng | Lời khuyên mức Nhẹ |
|---|---|
| Đau đầu | Nghỉ ngơi, tránh nhìn màn hình lâu, uống đủ nước |
| Đau bụng | Ăn nhẹ, tránh đồ cay nóng dầu mỡ, uống nước ấm |
| Chóng mặt | Tránh đứng dậy nhanh, kiểm tra huyết áp |
| Sốt | Uống paracetamol nếu > 38.5°C, theo dõi nhiệt độ 4h |
| Ho | Nước ấm mật ong, súc miệng nước muối |
| Mệt mỏi | Ăn uống điều độ, uống đủ 2 lít nước/ngày |

---

## 5. AI Agent — Hệ thống thông minh dần

### 5.1 Agent Context: Thu thập dữ liệu

Trước mỗi lần check-in, Agent thu thập **8 nguồn dữ liệu** về user:

```
┌────────────────────────────────────────────┐
│            AGENT CONTEXT                    │
│                                            │
│  1. Hồ sơ: tuổi, giới, bệnh nền, thuốc   │
│  2. Triệu chứng gần đây: gì, bao nhiêu lần│
│  3. Lịch sử check-in: 7 ngày qua          │
│  4. Clusters: nhóm triệu chứng hay gặp    │
│  5. Sessions: user trả lời gì gần đây     │
│  6. Memories: AI nhớ gì về user            │
│  7. Thời gian: sáng/chiều/tối, thứ mấy    │
│  8. Engagement: user hay trả lời không     │
└────────────────────────────────────────────┘
```

### 5.2 Agent Decision: Quyết định thông minh

Agent đưa ra **6 loại quyết định** dựa trên context:

| Quyết định | Ví dụ |
|-----------|-------|
| **Lời chào** | "Hôm qua chú chóng mặt nặng, hôm nay thế nào?" (thay vì chào chung) |
| **Ưu tiên cluster** | Hỏi chóng mặt trước vì hôm qua HIGH |
| **Thêm/bớt câu hỏi** | Thêm "đo huyết áp chưa?" vì user có cao huyết áp |
| **Đánh giá cuối** | Bump từ TB → Nặng vì hôm qua cũng nặng |
| **Kế hoạch follow-up** | Đẩy 1h → 2h vì user hay trả lời chậm |
| **Giải thích** | "Hỏi huyết áp vì 3 ngày liên tiếp chóng mặt" |

### 5.3 Agent Memory: Nhớ xuyên session

Agent lưu 4 loại "ký ức":

| Loại | Ví dụ |
|------|-------|
| Pattern | "Chú Hùng hay đau đầu thứ 2" |
| Preference | "Chú thích check-in ngắn gọn" |
| Insight | "Chóng mặt liên quan đến quên thuốc huyết áp" |
| Warning | "3 ngày liên tiếp severity HIGH" |

### 5.4 Pattern Detector: Phát hiện xu hướng

Phân tích dữ liệu 30 ngày, phát hiện **6 loại pattern**:

1. **Triệu chứng lặp theo ngày:** "Đau đầu 3 thứ 2 liên tiếp"
2. **Theo thời điểm:** "Chóng mặt thường buổi sáng"
3. **Xu hướng severity:** "Severity tăng dần 5 ngày"
4. **Triệu chứng đi cùng:** "Đau đầu thường kèm chóng mặt"
5. **Phản hồi follow-up:** "User luôn đỡ hơn sau 3h"
6. **Liên quan thuốc:** "Quên thuốc → chóng mặt ngày hôm sau"

### 5.5 R&D Cycle: AI xử lý ban đêm

Mỗi đêm 2:00 AM, hệ thống chạy batch:

```
1. Gom data check-in trong ngày
   ├─ Triệu chứng nào xuất hiện nhiều?
   ├─ Severity trung bình thay đổi?
   └─ Có triệu chứng mới (fallback)?

2. Cập nhật clusters
   ├─ "Đau đầu 5 ngày liên tiếp" → trend = increasing
   ├─ "Chóng mặt giảm" → trend = decreasing
   └─ "Đau dạ dày" mới → tạo cluster mới

3. Tối ưu script
   ├─ Cluster tăng → thêm câu hỏi chi tiết hơn
   ├─ Cluster giảm → giảm câu hỏi (không hỏi thừa)
   └─ Cluster mới → AI tạo câu hỏi phù hợp

4. Lưu patterns vào memory
```

---

## 6. Bảng so sánh AI calls

| Tình huống | Gọi AI? | Khi nào |
|-----------|---------|---------|
| Check-in "Tôi ổn" | **KHÔNG** | Chỉ hẹn tối |
| Check-in "Hơi mệt" → script | **KHÔNG** | Script cached |
| Follow-up (đỡ/vậy/nặng) | **KHÔNG** | Scoring rules |
| Chọn options | **KHÔNG** | UI + scoring |
| Triệu chứng mới (fallback) | **KHÔNG ngay** | Fallback 3 câu, AI xử lý đêm |
| Emergency | **KHÔNG** | Keyword detection |
| Combo detection | **KHÔNG** | Rule-based |
| User muốn chat sâu | **CÓ** | Tab Chat AI (giữ nguyên) |
| Tạo script lần đầu | **CÓ** | 1 lần khi onboarding |
| R&D cycle hàng đêm | **CÓ** | Batch, 100-500 calls/đêm |

---

## 7. Hệ thống thông minh dần theo thời gian

```
Tuần 1:  Script dựa trên onboarding → hỏi chung chung
Tuần 2:  R&D cập nhật → hỏi đúng triệu chứng hay gặp
Tuần 4:  Script tối ưu → hỏi ít hơn, đúng hơn
Tháng 2: Hệ thống biết pattern → dự đoán trước
Tháng 6: Gần như không cần AI → tự chạy hoàn toàn
```

> **Càng dùng lâu → AI càng ít phải can thiệp → chi phí càng giảm → trải nghiệm càng tốt.**

---

## 8. Kiến trúc kỹ thuật (cho team dev)

```
src/
├── core/                         ← Logic thuần, 0 DB queries
│   ├── agent/                    ← AI Agent brain
│   │   ├── agent-context.js      ← Thu thập 8 nguồn data
│   │   ├── agent-decision.js     ← 6 loại quyết định
│   │   ├── agent-memory.js       ← Nhớ xuyên session
│   │   └── pattern-detector.js   ← 6 loại pattern
│   ├── checkin/                  ← Check-in engines
│   │   ├── scoring-engine.js     ← Chấm điểm severity
│   │   ├── script-runner.js      ← Chạy script step-by-step
│   │   ├── combo-detector.js     ← 8 tổ hợp nguy hiểm
│   │   ├── triage-engine.js      ← State machine (luồng cũ)
│   │   └── triage-ai-layer.js    ← Template tiếng Việt
│   └── notification/
│       └── notification.orchestrator.js
│
├── services/                     ← Business logic + DB
│   └── checkin/
│       ├── agent.service.js      ← Agent orchestrator
│       ├── script.service.js     ← CRUD clusters + scripts
│       ├── script-session.service.js ← Session management
│       ├── multi-symptom.service.js  ← Nhiều triệu chứng
│       ├── fallback.service.js   ← Triệu chứng lạ
│       ├── rnd-cycle.service.js  ← R&D ban đêm
│       └── emergency-detector.js ← Cấp cứu keyword
│
├── controllers/                  ← API handlers
│   └── script-checkin.controller.js
├── routes/                       ← Endpoints
│   └── mobile.routes.js
└── middleware/
```

---

## 9. API Endpoints

| Method | Path | Mô tả |
|--------|------|-------|
| GET | `/api/mobile/checkin/script` | Lấy kịch bản cached cho user |
| POST | `/api/mobile/checkin/script/start` | Bắt đầu session (status + cluster/symptom) |
| POST | `/api/mobile/checkin/script/answer` | Gửi câu trả lời, nhận câu tiếp hoặc kết quả |
| GET | `/api/mobile/checkin/script/session` | Lấy session hiện tại |
| POST | `/api/mobile/checkin/script/clusters` | Tạo clusters từ onboarding |

---

## 10. Database Tables

| Bảng | Mục đích |
|------|---------|
| `problem_clusters` | Nhóm triệu chứng user hay gặp (headache, dizziness...) |
| `triage_scripts` | Kịch bản hỏi cached (questions, scoring rules, templates) |
| `script_sessions` | Tracking mỗi lần user chạy script |
| `fallback_logs` | Triệu chứng lạ chờ R&D xử lý |
| `rnd_cycle_logs` | Log mỗi lần R&D cycle chạy |
| `agent_checkin_memory` | Agent nhớ patterns, preferences |
| `health_checkins` | Session check-in hàng ngày (status, severity, follow-up) |
| `symptom_logs` | Log triệu chứng chi tiết |
| `symptom_frequency` | Tần suất triệu chứng (7d, 30d, trend) |

### Cấu trúc script_data (JSON)

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
    "low": { "summary": "...", "recommendation": "...", "close_message": "..." },
    "medium": { "summary": "...", "recommendation": "...", "close_message": "..." },
    "high": { "summary": "...", "recommendation": "...", "close_message": "..." }
  }
}
```

---

> **Tài liệu này mô tả hệ thống Check-in Asinu tại thời điểm hiện tại.**
> Khi tích hợp MedGemma, các phần đánh dấu "AI" sẽ được nâng cấp mà không cần thay đổi kiến trúc.
