# Asinu — Danh sách Thông báo

Hệ thống gửi thông báo cá nhân hóa theo **tuổi + giới tính** của người dùng.

## Quy tắc xưng hô

| Tuổi | Nam | Nữ | Asinu xưng |
|------|-----|-----|-----------|
| >= 60 | Chú | Cô | Cháu |
| 40-59 | Anh | Chị | Em |
| 25-39 | Anh | Chị | Mình |
| < 25 | Bạn | Bạn | Mình |

**Ví dụ bên dưới dùng:** Chú Hùng, 66 tuổi, tiểu đường + cao huyết áp

---

## 1. Nhắc buổi sáng (reminder_morning_summary)
**Thời gian:** 7:00-8:00 sáng (theo cài đặt user)

**Title:** ☀️ Chú Hùng ơi, sáng rồi!

**Body — Intelligence Layer (tuỳ tình trạng):**

| Tình trạng | Nội dung |
|------------|----------|
| **Symptom xấu đi** | Mấy hôm nay chú hay bị đau đầu, cháu hơi lo. Hôm nay chú thấy thế nào rồi? Vào check-in để cháu theo dõi cùng chú nhé ⚠️ |
| **Symptom ổn định** | Hôm qua chú có bị đau đầu, hôm nay đỡ hơn chưa? Cháu vẫn đang theo dõi cùng chú nha 💬 |
| **Symptom đang đỡ** | Tình trạng đau đầu đang đỡ dần rồi, tốt quá! Hôm nay chú thấy sao? Giữ đà này nhé 💪 |
| **Mệt liên tiếp 3 ngày** | 3 ngày nay chú đều mệt, cháu lo cho chú lắm. Hôm nay thế nào rồi? Vào check-in để cháu biết tình hình nhé 😟 |
| **Streak 7 ngày khỏe** | 7 ngày liên tiếp chú đều khỏe, cháu mừng quá! Tiếp tục giữ vậy nhé, cháu luôn đồng hành cùng chú 🎉 |
| **Sau triệu chứng nặng** | Lần trước chú có triệu chứng nặng, cháu vẫn nhớ. Hôm nay chú thấy thế nào rồi? Cho cháu biết để theo dõi tiếp nhé 🩺 |
| **Mặc định** | Hôm nay chú thế nào? Vào check-in nhanh để cháu nắm tình hình nhé. Mỗi ngày một chút, cháu đồng hành cùng chú ☀️ |

**Body — Fallback (khi Intelligence Layer lỗi):**

| Tình trạng | Nội dung |
|------------|----------|
| **Có symptom hôm qua** | Hôm qua chú có bị đau đầu, cháu vẫn nhớ nha. Hôm nay chú nhớ đo đường huyết 🩸, đo huyết áp 💓, uống thuốc 💊 nhé, cháu theo dõi cùng chú 💙 |
| **Không có symptom** | Ngày mới rồi chú ơi! Hôm nay chú nhớ đo đường huyết 🩸, đo huyết áp 💓, uống thuốc 💊 nhé. Mỗi ngày một chút, cháu tin chú làm được 💪 |

---

## 2. Nhắc buổi chiều (reminder_afternoon)
**Thời gian:** 14:00-15:00 (theo cài đặt user)

**Title:** 🌤️ Chú Hùng ơi, chiều rồi!

**Body — Intelligence Layer:**

| Tình trạng | Nội dung |
|------------|----------|
| **Có symptom** | Chiều nay đau đầu thế nào rồi chú? Nghỉ tay chút, uống nước nhé. Cháu vẫn quan tâm chú đây 🌤️ |
| **Mặc định** | Chiều nay chú thế nào? Nghỉ tay chút, uống nước nhé. Cháu nhắc chú vì quan tâm thôi nha 💧 |

**Body — Fallback:**

| Bệnh nền | Nội dung |
|----------|----------|
| **Tiểu đường** | Chiều nay chú thấy thế nào? Nhớ uống đủ nước và đo đường huyết nếu chưa nhé. Cháu đang theo dõi cùng chú đây 😊 |
| **Cao huyết áp** | Chiều rồi chú ơi, nghỉ tay chút nhé — nghỉ ngơi cũng quan trọng như uống thuốc vậy. Hôm nay chú uống đủ nước chưa? 💧 |
| **Chung** | Chiều nay chú thế nào rồi? Vươn vai tí, uống ngụm nước nhé. Cháu nhắc chú vì quan tâm thôi nha 🌿 |

---

## 3. Nhắc buổi tối (reminder_evening_summary)
**Thời gian:** 20:00-21:00 (theo cài đặt user)

**Title:** 🌙 Chú Hùng ơi, tối rồi!

**Body — Intelligence Layer:**

| Tình trạng | Nội dung |
|------------|----------|
| **Có symptom** | Hôm nay đau đầu thế nào rồi chú? Trước khi ngủ chú nhớ uống thuốc tối 💊 nhé. Cháu vẫn đang theo dõi cùng chú nha 🌙 |
| **Symptom đang đỡ** | Hôm nay chú đỡ hơn hôm qua rồi, tốt quá! Trước khi ngủ nhớ uống thuốc tối 💊 nhé. Giữ đà này chú nhé 🌟 |
| **Mặc định** | Trước khi ngủ chú nhớ uống thuốc tối 💊 nhé. Hôm nay chú đã cố gắng rồi, nghỉ ngơi cho ngày mai tiếp tục nha. Cháu chúc chú ngủ ngon 🌙 |

**Body — Fallback:**

| Tình trạng | Nội dung |
|------------|----------|
| **Có symptom** | Trước khi ngủ chú nhớ uống thuốc tối 💊, ghi chỉ số sức khỏe 📋 nhé. Cháu vẫn nhớ chú bị đau đầu, hy vọng đỡ hơn rồi. Chú ngủ ngon nha 💙 |
| **Không symptom** | Trước khi ngủ chú nhớ uống thuốc tối 💊, ghi chỉ số sức khỏe 📋 nhé. Hôm nay chú đã cố gắng rồi, nghỉ ngơi cho ngày mai tiếp tục nha 🌟 |

---

## 4. Streak Milestone (streak_7 / streak_14 / streak_30)
**Thời gian:** Sáng (cùng morning), khi user đạt mốc

**Title:** 🔥 Chuỗi 7 ngày, Chú Hùng!

**Body:**
> Tuyệt vời! Chú đã ghi log 7 ngày liên tục rồi. Cháu tự hào về chú lắm — tiếp tục phát huy nhé!

---

## 5. Tổng kết tuần (weekly_recap)
**Thời gian:** Chủ nhật 20:00

**Title:** 📊 Tổng kết tuần, Chú Hùng!

| Số ngày | Nội dung |
|---------|----------|
| **7/7** | Tuần hoàn hảo! Chú đã ghi log đủ 7/7 ngày. Cháu tự hào về chú lắm — tuyệt vời! |
| **5-6/7** | Tuần tốt! Chú ghi log 5/7 ngày, gần hoàn hảo rồi! Cháu tin tuần sau chú làm được 7/7 💪 |
| **3-4/7** | Chú ghi log 3/7 ngày tuần này. Không tệ đâu! Tuần sau chú cố thêm chút nhé, cháu đồng hành cùng chú 💙 |
| **0-2/7** | Mới 1/7 ngày ghi log tuần này. Sức khỏe chú quan trọng lắm — tuần sau cháu mong chú ghi log thường xuyên hơn nhé 💙 |

---

## 6. Cảnh báo sức khỏe (health_alert)
**Thời gian:** Bất cứ khi nào phát hiện bất thường (max 1 lần/12h)

**Title:** Chú ơi, cần chú ý

| Loại | Nội dung |
|------|----------|
| **Severity cao** | 🚨 Chú Hùng ơi, triệu chứng đau đầu của chú khá nặng. Chú nên đi khám bác sĩ nhé |
| **Trend xấu đi** | 📈 Chú Hùng ơi, đau đầu mấy hôm nay có vẻ nặng hơn. Cháu muốn chú theo dõi kỹ nhé |

---

## 7. Follow-up check-in (checkin_followup)
**Thời gian:** 1-4 giờ sau check-in (tuỳ mức độ: high_alert = 1h, follow_up = 3h)

**Title:** 💙 Cháu vẫn ở đây — chú khoẻ hơn chưa?

**Body:** 🌿 Cháu vẫn nhớ lúc nãy chú hơi mệt. Giờ đỡ hơn chưa? Cho cháu biết nhé.

**Urgent (mệt nặng):**

**Title:** 💙 Cháu vẫn đang ở đây nè

**Body:** Chú ơi, cháu lo quá. Cho cháu biết chú thế nào nhé — cháu đang theo dõi cùng chú 💙

---

## 8. Cảnh báo khẩn cấp (emergency)
**Gửi cho:** Người thân trong Care Circle

**Title:** 🚨 Khẩn cấp — Cần giúp đỡ ngay!

**Body:** 🚨 Người thân của bạn đang cần hỗ trợ khẩn cấp. Kiểm tra ngay!

---

## 9. Care Circle

### Lời mời kết nối
**Title:** 🤝 Lời mời Care Circle

**Body:** Có người muốn kết nối với bạn trong Care Circle — cùng chăm sóc nhau nhé!

### Chấp nhận lời mời
**Title:** ✅ Lời mời được chấp nhận

**Body:** 🎉 Thành viên mới đã tham gia nhóm chăm sóc của bạn!

### Người thân xác nhận
**Title:** ✅ Người thân đã phản hồi

**Body:** 💙 Người thân đã nhận thông báo và đang hỗ trợ bạn rồi.

---

## 10. Re-engagement (user không mở app)
**Thời gian:** 9:00 sáng, khi user inactive 3+ ngày
**Nội dung:** AI sinh tự động dựa trên context (symptom, streak, lifecycle)

**Title:** 💙 Chú Hùng ơi, lâu rồi không thấy chú!

**Body:** *(Ví dụ AI sinh)* Mấy hôm nay không thấy chú vào check-in, cháu hơi lo. Chú có khỏe không? Vào app nhanh để cháu biết tình hình nhé 💙

---

## Ví dụ cho user khác

### Chị Mai, 46 tuổi, nữ (chị/em)

| Loại | Title | Body |
|------|-------|------|
| Sáng | ☀️ Chị Mai ơi, sáng rồi! | Ngày mới rồi chị ơi! Hôm nay chị nhớ đo đường huyết 🩸, uống thuốc 💊 nhé. Mỗi ngày một chút, em tin chị làm được 💪 |
| Chiều | 🌤️ Chị Mai ơi, chiều rồi! | Chiều nay chị thế nào? Nghỉ tay chút, uống nước nhé. Em nhắc chị vì quan tâm thôi nha 💧 |
| Tối | 🌙 Chị Mai ơi, tối rồi! | Trước khi ngủ chị nhớ uống thuốc tối 💊 nhé. Hôm nay chị đã cố gắng rồi, nghỉ ngơi cho ngày mai tiếp tục nha. Em chúc chị ngủ ngon 🌙 |
| Streak | 🔥 Chuỗi 7 ngày, Chị Mai! | Tuyệt vời! Chị đã ghi log 7 ngày liên tục rồi. Em tự hào về chị lắm — tiếp tục phát huy nhé! |

### Bạn Đức, 26 tuổi, nam (anh/mình)

| Loại | Title | Body |
|------|-------|------|
| Sáng | ☀️ Anh Đức ơi, sáng rồi! | Ngày mới rồi anh ơi! Hôm nay anh nhớ đo đường huyết 🩸 nhé. Mỗi ngày một chút, mình tin anh làm được 💪 |
| Chiều | 🌤️ Anh Đức ơi, chiều rồi! | Chiều nay anh thế nào? Nghỉ tay chút, uống nước nhé. Mình nhắc anh vì quan tâm thôi nha 💧 |
| Tối | 🌙 Anh Đức ơi, tối rồi! | Trước khi ngủ anh nhớ uống thuốc tối 💊 nhé. Hôm nay anh đã cố gắng rồi, nghỉ ngơi cho ngày mai tiếp tục nha 🌟 |

---

## Logic gửi thông báo

| Quy tắc | Chi tiết |
|---------|----------|
| **Quiet hours** | 22:00 - 05:00 không gửi reminder (chỉ gửi follow-up khẩn cấp) |
| **Cross-type gap** | Cùng user không nhận 2 reminder trong 5 phút |
| **Same-type dedup** | Cùng loại không gửi lại trong 5 phút |
| **Reminders enabled** | Chỉ gửi khi user bật thông báo trong cài đặt |
| **Onboarding required** | Chỉ gửi khi user đã hoàn thành onboarding |
| **Push token required** | Chỉ gửi khi user có push token |
| **Time matching** | Gửi theo giờ user cài đặt (morning_time, afternoon_time, evening_time) |
