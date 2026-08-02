# Asinu - Danh sách notification hiện tại

Tài liệu này mô tả các notification đang được backend tạo trong bảng
`notifications` và/hoặc gửi qua push notification.

## 1. Quy tắc chung

- Múi giờ scheduler: `Asia/Ho_Chi_Minh`.
- Notification nhắc sức khỏe chỉ áp dụng cho tài khoản đã hoàn thành onboarding,
  đã bật reminders và có push token.
- Một số loại chỉ lưu trong app để hiển thị ở màn Thông báo, không gửi push.
- Reminder cùng người dùng được cách nhau tối thiểu 5 phút.
- Cùng một loại notification không gửi lặp trong 5 phút.
- Khung giờ yên tĩnh: `22:00-05:00`. Trong khung giờ này chỉ xử lý follow-up
  check-in và cảnh báo đang cần phản hồi.
- Scheduler chạy mỗi phút; notification chỉ được gửi khi đúng giờ cấu hình của
  từng người dùng.

## 2. Notification định kỳ hằng ngày

| Type | Thời gian mặc định | Khi nào gửi | Kênh |
|---|---:|---|---|
| `morning_checkin` | `07:00` | Người dùng chưa check-in trong ngày | Push + trong app |
| `reminder_morning_summary` | `08:00` | Còn thiếu log sức khỏe, đường huyết, huyết áp hoặc thuốc trong ngày | Push + trong app |
| `reminder_afternoon` | `14:00` | Nhắc uống nước, vận động hoặc đo chỉ số theo bệnh nền | Push + trong app |
| `reminder_evening_summary` | `21:00` | Còn thiếu log buổi tối hoặc chưa ghi nhận thuốc | Push + trong app |
| `reengagement` | `09:00` | Người dùng đã từng check-in nhưng không quay lại trong vài ngày | Chỉ trong app |

### 2.1 `morning_checkin`

Nội dung chính: mời người dùng bắt đầu check-in sức khỏe trong ngày. Không gửi
nếu người dùng đã có check-in trong ngày hoặc đã nhận notification này trong ngày.

### 2.2 `reminder_morning_summary`

Backend gộp các việc còn thiếu thành một notification, gồm:

- Đo đường huyết nếu hồ sơ có tiểu đường.
- Đo huyết áp nếu hồ sơ có cao huyết áp.
- Uống thuốc nếu người dùng có bệnh nền.
- Ghi chỉ số sức khỏe nếu chưa có log nào trong ngày.

Nếu người dùng đã hoàn tất tất cả việc cần làm thì không gửi notification này.
Giờ gửi có thể thay đổi theo `morning_time` hoặc cấu hình tương ứng của user.

### 2.3 `reminder_afternoon`

Nhắc nghỉ ngơi, uống nước, vận động hoặc đo chỉ số. Giờ mặc định là `14:00`,
có thể thay đổi theo `afternoon_time`.

### 2.4 `reminder_evening_summary`

Nhắc ghi log sức khỏe buổi tối và uống thuốc tối. Giờ mặc định là `21:00`,
có thể thay đổi theo `evening_time`.

### 2.5 `reengagement`

Đây là notification nhắc người dùng quay lại app sau khi không hoạt động.

Điều kiện hiện tại:

- Người dùng phải có ít nhất một `health_checkin` thực tế.
- Lifecycle phải thuộc nhóm `semi_active`, `inactive` hoặc `churned`.
- Tối đa một notification mỗi ngày.
- Chỉ lưu trong app, không gửi push để tránh làm phiền.

Người chưa từng check-in được xem là người dùng mới, không phải người dùng đã
không hoạt động. Vì vậy hệ thống không còn dùng giá trị giả `999 ngày` cho nhóm
này.

## 3. Notification thành tích và tổng kết

| Type | Thời gian | Điều kiện | Kênh |
|---|---|---|---|
| `streak_7` | Theo giờ buổi sáng | Đạt chuỗi ghi log 7 ngày | Push + trong app |
| `streak_14` | Theo giờ buổi sáng | Đạt chuỗi ghi log 14 ngày | Push + trong app |
| `streak_30` | Theo giờ buổi sáng | Đạt chuỗi ghi log 30 ngày | Push + trong app |
| `weekly_recap` | Chủ nhật `20:00` | Tổng kết số ngày có log trong 7 ngày gần nhất | Push + trong app |
| `weekly_wellness_summary` | Chủ nhật `07:00` | Có ít nhất một log trong 7 ngày gần nhất | Chỉ trong app |

Các mốc streak được chống lặp trong 25 ngày. Tổng kết tuần được chống lặp
trong khoảng 6 ngày.

## 4. Notification vòng đời tài khoản

| Type | Thời gian quét | Điều kiện | Kênh |
|---|---:|---|---|
| `subscription_expiring_soon` | Hằng ngày `07:00` | Gói Premium còn tối đa 3 ngày | Push + trong app |
| `subscription_expired` | Hằng ngày `07:00` | Gói vừa hết hạn trong 24 giờ | Push + trong app |
| `profile_incomplete` | Hằng ngày `07:00` | Sau 3 ngày đăng ký nhưng còn thiếu hồ sơ/onboarding | Chỉ trong app |

Các notification vòng đời có cơ chế chống gửi lặp theo thời gian hoặc theo tài
khoản. `profile_incomplete` chỉ gửi một lần cho mỗi tài khoản.

## 5. Notification phát sinh khi check-in

| Type | Khi nào phát sinh | Người nhận | Kênh |
|---|---|---|---|
| `checkin_followup` | Người dùng không phản hồi phiên check-in lần đầu | Người dùng | Push + trong app |
| `checkin_followup_urgent` | Người dùng tiếp tục không phản hồi | Người dùng | Push + trong app |
| `health_alert` | Phát hiện chỉ số/triệu chứng bất thường hoặc xu hướng xấu | Người dùng | Push + trong app |
| `caregiver_alert` | Check-in mức cao cần báo người thân | Người thân và/hoặc người dùng | Push + trong app |
| `emergency` | Check-in có mức khẩn cấp | Người thân | Push + trong app |

### Follow-up không phản hồi

- Lần bỏ lỡ đầu tiên tạo `checkin_followup`.
- Các lần tiếp theo tạo `checkin_followup_urgent`.
- Nếu người dùng tiếp tục không phản hồi, hệ thống có thể báo Care Circle.
- Phiên được dừng sau ngưỡng retry để tránh gửi vô hạn.

### Cảnh báo người thân

Khi người dùng chưa xác nhận hoặc người thân chưa phản hồi, hệ thống có thể gửi
lại `caregiver_alert` hoặc `emergency` sau mỗi 30 phút, tối đa 4 lần retry.

## 6. Notification Care Circle và tài khoản

Các loại sau phát sinh theo thao tác kết nối, không phải notification hằng ngày:

- `care_circle_invitation`: có người mời tham gia Care Circle.
- `care_circle_accepted`: lời mời đã được chấp nhận.
- `care_circle_rejected`: lời mời bị từ chối.
- `care_circle_removed`: thành viên bị xóa khỏi nhóm.
- `care_circle_permission_changed`: quyền của thành viên thay đổi; chỉ trong app.
- `caregiver_confirmed`: người thân đã xác nhận cảnh báo.

## 7. Notification thanh toán và Premium

Các loại sau phát sinh theo giao dịch, không chạy cố định mỗi ngày:

- `subscription_activated`: kích hoạt Premium.
- `subscription_expiring_soon`: Premium sắp hết hạn.
- `subscription_expired`: Premium đã hết hạn.
- `payment_failed`: thanh toán thất bại.
- `wallet_topup_success`: nạp tiền thành công; chỉ trong app.
- `wallet_low_balance`: số dư ví thấp; chỉ trong app.

## 8. Kiểm tra notification trong app

Frontend lấy danh sách từ API notifications và hiển thị `title`, `message`,
`created_at`, `is_read` từ backend. Vì vậy các notification cũ vẫn có thể xuất
hiện trong lịch sử dù rule hiện tại đã được sửa.

Đặc biệt, các bản ghi `reengagement` cũ với nội dung `999 ngày` là dữ liệu lịch
sử do rule cũ tạo ra. Code hiện tại không tạo thêm bản ghi kiểu này cho người
chưa từng check-in; khi người dùng check-in, các bản ghi `reengagement` chưa đọc
được đánh dấu đã đọc.

## 9. Nguồn code chính

- Scheduler: `src/scheduler/index.js`
- Reminder định kỳ: `src/services/notification/basic.notification.service.js`
- Notification vòng đời: `src/services/notification/lifecycle.notification.service.js`
- Re-engagement: `src/services/notification/reengagement.service.js`
- Check-in và cảnh báo: `src/services/checkin/checkin.service.js`
- Điều phối notification: `src/core/notification/notification.orchestrator.js`
