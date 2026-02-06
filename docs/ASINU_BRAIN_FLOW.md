# Asinu Brain - Luồng Hoạt Động Chi Tiết

## Tổng Quan

Asinu Brain là hệ thống **AI-Driven** theo dõi sức khỏe người dùng. **100% câu hỏi và quyết định được AI sinh ra động**, không fix cứng số lượng hay nội dung.

**AI tự quyết định:**
- Câu hỏi tiếp theo là gì (nội dung + lựa chọn)
- Hỏi bao nhiêu câu là đủ (linh hoạt 1-7 câu)
- Khi nào dừng hỏi và đánh giá
- Có gửi thông báo cho người thân không
- Nội dung phản hồi cho bệnh nhân

**Điều kiện hoạt động:**
- User đã đăng nhập (có token hợp lệ)
- Đang ở màn hình Home
- App ở chế độ foreground
- User idle (không tương tác) > 2 giây
- Đã qua thời gian cooldown (30 giây trong testing mode)

---

## 1. Luồng Tổng Quan

```
User mở app → Đăng nhập
         ↓
   Vào màn Home
         ↓
   Idle 2 giây
         ↓
Frontend poll API mỗi 30s: GET /api/asinu-brain/next
         ↓
Backend kiểm tra:
  - Đã đủ thời gian chưa? (30s trong testing, 2-7h trong production)
  - Session đang mở hay đóng?
         ↓
AI sinh câu hỏi đầu tiên
         ↓
┌──────────────────────────────────┐
│   VÒNG LẶP ĐỘNG - AI ĐIỀU KHIỂN  │
└──────────────────────────────────┘
         ↓
   Modal hiện câu hỏi
         ↓
   User chọn đáp án
         ↓
POST /api/asinu-brain/answer
         ↓
AI phân tích → Quyết định:
   ├─→ Cần hỏi thêm → Sinh câu tiếp theo → Lặp lại
   └─→ Đủ thông tin → Đánh giá và kết thúc
                ↓
         ┌──────┴──────┐
         ↓             ↓
    Risk LOW/MED    Risk HIGH
         ↓             ↓
   Không notify   GỬI THÔNG BÁO
                  cho người thân
         ↓
   Hiện kết quả assessment
         ↓
   Đóng session, set cooldown
         ↓
   Chờ 30s (testing) hoặc 2-7h (prod)
         ↓
   Lặp lại từ đầu
```

---

## 2. Luồng Câu Hỏi Động (Chi Tiết)

### Cách hoạt động:

```
AI sinh câu 1: "Hôm nay bác thấy trong người thế nào?"
   Options: [Khỏe] [Hơi mệt] [Không khỏe]
                    ↓
              User chọn: "Hơi mệt"
                    ↓
AI phân tích → cần hỏi thêm để hiểu rõ
                    ↓
AI sinh câu 2: "Bác mệt như thế nào, có đau đầu hay chóng mặt không?"
   Options: [Không có gì] [Đau đầu] [Chóng mặt] [Cả hai]
                    ↓
              User chọn: "Đau đầu"
                    ↓
AI phân tích → hỏi thêm về mức độ
                    ↓
AI sinh câu 3: "Đau đầu của bác nặng hay nhẹ?"
   Options: [Nhẹ, chịu được] [Khá nặng] [Rất nặng]
                    ↓
              User chọn: "Khá nặng"
                    ↓
AI phân tích → đủ thông tin → ĐÁNH GIÁ
                    ↓
   Risk: MEDIUM → Khuyên nghỉ ngơi, theo dõi
```

### Số lượng câu hỏi linh hoạt:

| Tình huống | Số câu | Lý do |
|------------|--------|-------|
| User nói "Khỏe" | 1-2 câu | Đủ thông tin, không cần hỏi thêm |
| User nói "Hơi mệt" | 2-4 câu | Cần tìm hiểu nguyên nhân |
| User nói "Không khỏe" | 3-5 câu | Cần đánh giá kỹ triệu chứng |
| Phát hiện triệu chứng nghiêm trọng | Dừng ngay | Đánh giá và notify ngay |
| Tối đa | 7 câu | Tránh làm phiền user |

---

## 3. AI Sinh Câu Hỏi Như Thế Nào?

### Input cho AI:

```
THÔNG TIN BỆNH NHÂN:
├── Profile (tuổi, bệnh nền)
├── Chỉ số sức khỏe gần nhất (nếu có)
├── Lịch sử tâm trạng 48h
└── Hội thoại hiện tại
    ├── Câu 1: "Hôm nay thấy sao?" → "Hơi mệt"
    ├── Câu 2: "Có triệu chứng gì?" → "Đau đầu"
    └── ...
```

### Output từ AI:

**Nếu cần hỏi thêm:**
```json
{
  "action": "ask",
  "question": {
    "text": "Câu hỏi tự nhiên, thân thiện",
    "options": [
      {"value": "opt1", "label": "Lựa chọn 1"},
      {"value": "opt2", "label": "Lựa chọn 2"}
    ]
  },
  "reasoning": "Tại sao cần hỏi thêm"
}
```

**Nếu đủ thông tin:**
```json
{
  "action": "assess",
  "assessment": {
    "risk_tier": "MEDIUM",
    "risk_score": 45,
    "notify_caregiver": false,
    "outcome_text": "Bác nghỉ ngơi nhé...",
    "recommended_action": "..."
  }
}
```

---

## 4. Quy Tắc AI Tuân Theo

### Về câu hỏi:
- **TỰ NHIÊN**: Như nói chuyện với người lớn tuổi
- **KHÔNG** đề cập chỉ số cụ thể ("đường huyết 120...")
- **KHÔNG** dùng từ ngữ y khoa khó hiểu
- Lựa chọn phải **DỄ HIỂU**, **NGẮN GỌN**

### Về đánh giá:

| Dấu hiệu | AI quyết định |
|----------|---------------|
| User ổn, không triệu chứng | LOW - kết thúc nhanh |
| User mệt nhẹ | MEDIUM - khuyên nghỉ ngơi |
| User mệt + đau đầu/chóng mặt | MEDIUM/HIGH - xem xét notify |
| Đau ngực / Khó thở | HIGH - notify ngay |
| 2+ lần không ổn trong 48h | HIGH - notify |

---

## 5. Ví Dụ Thực Tế

### Kịch bản 1: User khỏe mạnh

```
AI: "Hôm nay bác thấy trong người thế nào?"
User: "Khỏe, bình thường"

AI phân tích: User ổn → hỏi thêm 1 câu để chắc chắn

AI: "Tốt quá! Bác có ngủ ngon không?"
User: "Ngủ ngon"

AI phân tích: Đủ thông tin → Đánh giá LOW
→ "Tốt lắm bác! Bác giữ gìn sức khỏe nhé."
```

### Kịch bản 2: User mệt mỏi

```
AI: "Hôm nay bác thấy trong người thế nào?"
User: "Hơi mệt"

AI: "Bác mệt như thế nào, có kèm theo gì không?"
User: "Chóng mặt"

AI: "Chóng mặt nhiều không bác?"
User: "Hơi nhiều"

AI: "Bác có uống đủ nước và ăn uống bình thường không?"
User: "Có ăn uống bình thường"

AI phân tích: Mệt + chóng mặt nhưng ăn uống OK
→ MEDIUM, không notify
→ "Bác nghỉ ngơi và uống thêm nước nhé. Nếu không đỡ thì báo người thân."
```

### Kịch bản 3: Triệu chứng nghiêm trọng

```
AI: "Hôm nay bác thấy trong người thế nào?"
User: "Không được khỏe"

AI: "Bác thấy khó chịu ở đâu?"
User: "Tức ngực, khó thở"

AI phân tích: TRIỆU CHỨNG NGHIÊM TRỌNG → Dừng ngay
→ HIGH, notify_caregiver = true
→ "Bác ơi, triệu chứng này cần được kiểm tra. Asinu sẽ báo cho người thân để hỗ trợ bác."
→ GỬI THÔNG BÁO cho người thân NGAY
```

---

## 6. Khi Nào Gửi Thông Báo Cho Người Thân?

### AI quyết định notify khi:

1. **Triệu chứng nguy hiểm:**
   - Đau ngực / Tức ngực
   - Khó thở
   - Chóng mặt nặng

2. **Lịch sử xấu:**
   - 2+ lần "không ổn" trong 48h
   - Liên tục mệt + có triệu chứng

3. **Risk score cao:**
   - Score ≥ 60 → notify

### Nội dung thông báo (theo mối quan hệ):

**Ví dụ:**
- Nếu user đặt caregiver là "Bố" → Caregiver nhận: `[CẢNH BÁO] Con của bạn - Cần kiểm tra`
- Nếu user đặt caregiver là "Mẹ" → Caregiver nhận: `[CẢNH BÁO] Con của bạn - Cần kiểm tra`
- Message: `Con của bạn cho biết đang tức ngực và khó thở. Vui lòng liên hệ để kiểm tra.`

**Logic:**
- Backend lấy tên bệnh nhân từ database
- Đưa vào title/message: `[CẢNH BÁO] {Tên bệnh nhân} - Sức khỏe`
- Function `notifyCaregivers()` tự động replace `{Tên bệnh nhân}` bằng mối quan hệ
- Mỗi người thân nhận message cá nhân hóa theo relationship của họ

---

#