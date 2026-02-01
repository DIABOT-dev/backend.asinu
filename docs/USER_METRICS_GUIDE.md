# Hướng dẫn hiểu các thông số trong ứng dụng Asinu

## 📊 Tổng quan

Ứng dụng Asinu theo dõi sức khỏe của bạn qua nhiều chỉ số khác nhau. Tài liệu này giải thích chi tiết cách tính toán và ý nghĩa của từng thông số.

---

## 🌳 Cây Sức Khỏe (Health Tree)

### Điểm Cây Sức Khỏe
**Công thức:** `Điểm = (Điểm Log × 50%) + (Điểm Nhiệm vụ × 50%)`

### Chi tiết tính điểm:

#### 1. Điểm Log (50%)
- **Tối đa:** 14 lần ghi log/tuần
- **Cách tính:** `Điểm Log = Số lần ghi log / 14`
- **Ví dụ:**
  - Ghi 7 lần/tuần = 7/14 = 0.5 (50%)
  - Ghi 14 lần/tuần = 14/14 = 1.0 (100%)

#### 2. Điểm Nhiệm vụ (50%)
- **Tối đa:** Số nhiệm vụ được giao
- **Cách tính:** `Điểm Nhiệm vụ = Số nhiệm vụ hoàn thành / Tổng số nhiệm vụ`
- **Ví dụ:**
  - Hoàn thành 2/3 nhiệm vụ = 2/3 = 0.67 (67%)
  - Hoàn thành 3/3 nhiệm vụ = 3/3 = 1.0 (100%)

### Ví dụ tổng hợp:
```
Số lần ghi log: 10/14 tuần = 0.71 (71%)
Nhiệm vụ: 2/3 = 0.67 (67%)

Điểm Cây = (0.71 × 50%) + (0.67 × 50%)
         = 0.355 + 0.335
         = 0.69 (69%)
```

### Đánh giá:
- **≥ 70%**: Tốt 🎉
- **40-69%**: Trung bình 👍
- **< 40%**: Cần cố gắng 💪

### Thời gian tính:
- Dữ liệu từ **7 ngày gần nhất**
- Cập nhật theo thời gian thực khi bạn ghi log hoặc hoàn thành nhiệm vụ

---

## 📈 Biểu đồ 7 ngày

### Cách tính điểm mỗi ngày:
**Công thức:** `Điểm ngày = min(Số lần ghi log × 25, 100)`

### Chi tiết:
- **Mỗi lần ghi log** = 25 điểm
- **Tối đa 100 điểm/ngày** (4 lần ghi)
- **Các loại log được tính:**
  - Đường huyết
  - Huyết áp
  - Cân nặng
  - Nước uống
  - Bữa ăn
  - Thuốc
  - Insulin

### Ví dụ:
| Số lần ghi | Điểm | Mô tả |
|------------|------|-------|
| 1 lần | 25 | Cần cố gắng thêm |
| 2 lần | 50 | Ổn, có thể tốt hơn |
| 3 lần | 75 | Rất tốt! |
| 4 lần | 100 | Xuất sắc! ⭐ |
| 5+ lần | 100 | Tối đa (không cộng thêm) |

### Biểu đồ hiển thị:
- **Trục ngang:** CN → T2 → T3 → T4 → T5 → T6 → T7 (7 ngày)
- **Trục dọc:** 0 → 100 điểm
- **Màu cột:** 
  - Xanh lá: ≥ 75 điểm
  - Vàng: 50-74 điểm
  - Đỏ: < 50 điểm

---

## ✅ Nhiệm vụ hàng ngày (Daily Missions)

### Cơ chế hoạt động:

#### 1. Reset hàng ngày
- **Thời gian:** Mỗi ngày lúc **00:00** (nửa đêm)
- **Reset gì:** Tiến trình (progress) về 0, trạng thái về "pending"
- **Không reset:** Lịch sử hoàn thành (được lưu vĩnh viễn)

#### 2. Các loại nhiệm vụ:
- **log_glucose:** Ghi đường huyết (mục tiêu: 1-3 lần/ngày)
- **log_blood_pressure:** Ghi huyết áp (mục tiêu: 1-2 lần/ngày)
- **log_weight:** Ghi cân nặng (mục tiêu: 1 lần/ngày)
- **log_water:** Uống đủ nước (mục tiêu: 2000ml/ngày)
- **log_meal:** Ghi bữa ăn (mục tiêu: 3 bữa/ngày)
- **complete_all_logs:** Hoàn thành tất cả ghi chép

#### 3. Tiến trình nhiệm vụ:
```
Hiển thị: 2/3 (đã hoàn thành 2 trên mục tiêu 3)
Thanh tiến trình: 67% (2/3 = 0.67)
```

#### 4. Lịch sử:
- Mỗi khi hoàn thành nhiệm vụ → **Tự động lưu vào bảng mission_history**
- Có thể xem lịch sử bao nhiêu ngày đã hoàn thành
- Dùng cho thống kê và thành tích

---

## 🔥 Chuỗi ngày tốt (Streak)

### Định nghĩa:
Số ngày liên tiếp bạn có hoạt động (ghi log HOẶC hoàn thành nhiệm vụ)

### Cách tính:
1. Lấy tất cả ngày có activity trong 30 ngày gần nhất
2. Sắp xếp theo thứ tự ngày
3. Đếm số ngày liên tiếp từ hôm nay trở về trước

### Ví dụ:
```
Hôm nay: 31/1/2026 ✅
30/1/2026 ✅
29/1/2026 ✅
28/1/2026 ❌ (không có hoạt động)
27/1/2026 ✅

→ Streak = 3 ngày (31/1, 30/1, 29/1)
```

### Mẹo:
- Cố gắng duy trì streak mỗi ngày
- Chỉ cần 1 lần ghi log hoặc 1 nhiệm vụ là giữ được streak
- Streak càng dài = thói quen càng tốt

---

## 📱 Chỉ số nhanh trên màn hình chính

### 1. Đường huyết (Glucose)
- **Đơn vị:** mg/dL
- **Hiển thị:** Giá trị gần nhất
- **Cập nhật:** Khi bạn ghi log mới
- **Chú thích:** Thời gian ghi (ví dụ: "Ghi trước bữa sáng")

### 2. Huyết áp (Blood Pressure)
- **Đơn vị:** mmHg
- **Hiển thị:** Tâm thu/Tâm trương (ví dụ: 120/80)
- **Cập nhật:** Khi bạn ghi log mới
- **Chú thích:** Thời gian ghi (ví dụ: "Theo dõi sáng nay")

### 3. Cân nặng (Weight)
- **Đơn vị:** kg
- **Hiển thị:** Giá trị gần nhất
- **Cập nhật:** Khi bạn ghi log mới

### 4. Nước uống (Water)
- **Đơn vị:** ml
- **Hiển thị:** Tổng lượng nước hôm nay
- **Reset:** Mỗi ngày lúc 00:00
- **Mục tiêu:** 2000ml/ngày

---

## 🎯 Wellness Score (Điểm Sức khỏe Tổng hợp)

### Công thức:
```
Wellness = (Consistency × 25%) + (Mood × 30%) + (Engagement × 20%) + (Health Data × 25%)
```

### Chi tiết các yếu tố:

#### 1. Consistency (25%) - Tính nhất quán
- Ghi log đều đặn không bỏ ngày
- Tính theo 7 ngày gần nhất
- Công thức: `Số ngày có log / 7`

#### 2. Mood (30%) - Tâm trạng
- Điểm trung bình từ ghi chú mood
- Thang điểm: 1-5 (1 = tệ, 5 = tuyệt vời)
- Ảnh hưởng lớn nhất đến điểm tổng

#### 3. Engagement (20%) - Mức độ tham gia
- Số lượng tương tác với app
- Ghi log, hoàn thành nhiệm vụ, chat AI
- Tính theo mức độ active

#### 4. Health Data (25%) - Dữ liệu sức khỏe
- Chất lượng các chỉ số sức khỏe
- Đường huyết, huyết áp trong ngưỡng tốt
- Cân nặng ổn định

---

## 📊 Bảng tổng hợp nhanh

| Thông số | Thời gian | Cách tính | Mục tiêu |
|----------|-----------|-----------|----------|
| Điểm Cây | 7 ngày | 50% log + 50% nhiệm vụ | ≥ 70% |
| Biểu đồ ngày | Mỗi ngày | Số log × 25 (max 100) | 100 điểm |
| Nhiệm vụ | Hàng ngày | Progress/Goal | Hoàn thành 100% |
| Streak | Liên tục | Ngày liên tiếp có activity | Càng dài càng tốt |
| Nước uống | Hàng ngày | Tổng ml trong ngày | 2000ml |

---

## 💡 Mẹo sử dụng hiệu quả

### 1. Ghi log đều đặn
- Ít nhất 2 lần/ngày để đạt 50% điểm biểu đồ
- Mục tiêu 4 lần/ngày để đạt 100%

### 2. Hoàn thành nhiệm vụ
- Tập trung vào top 3 nhiệm vụ quan trọng nhất
- Nhiệm vụ reset hàng ngày, cơ hội mới mỗi ngày

### 3. Duy trì streak
- Ghi ít nhất 1 log mỗi ngày
- Streak dài = thói quen tốt = sức khỏe tốt hơn

### 4. Theo dõi xu hướng
- Xem biểu đồ 7 ngày để nhận biết pattern
- Ngày nào điểm thấp → Cải thiện ngày tiếp theo

### 5. Sử dụng AI Chat
- Hỏi về sức khỏe, dinh dưỡng, lời khuyên
- AI giúp giải thích các chỉ số

---

## ❓ Câu hỏi thường gặp

### Q: Tại sao điểm cây sức khỏe của tôi thấp?
**A:** Kiểm tra:
- Bạn ghi log bao nhiêu lần/tuần? (Cần ít nhất 7/14)
- Hoàn thành bao nhiêu nhiệm vụ? (Cần ít nhất 50%)

### Q: Biểu đồ tính theo tuần hay theo ngày?
**A:** Biểu đồ hiển thị 7 ngày gần nhất, mỗi cột = 1 ngày. Điểm cây tính tổng hợp cả 7 ngày.

### Q: Nhiệm vụ reset lúc nào?
**A:** Reset lúc 00:00 mỗi ngày. Lịch sử vẫn được lưu.

### Q: Làm sao để đạt 100 điểm/ngày?
**A:** Ghi log 4 lần trong ngày (mỗi lần = 25 điểm)

### Q: Streak bị mất khi nào?
**A:** Khi bạn bỏ 1 ngày không ghi log và không hoàn thành nhiệm vụ nào.

---

## 📞 Hỗ trợ

Nếu có thắc mắc về cách tính toán hoặc hiển thị thông số, vui lòng liên hệ team phát triển hoặc sử dụng tính năng AI Chat trong app.

**Cập nhật lần cuối:** 31/1/2026
